/* Execute the real CMA/model/UI paths using synthetic market data only. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const boundary = source.indexOf("const EXPORTS = [");
assert(boundary > 0, "shared DOM bootstrap boundary");
const fixture = source.slice(source.indexOf("const ALLOC_FIXTURE = (() => {"), source.indexOf('\nsafe("hedgeXe"'));
const sevenFixture = `
const SEVEN_ASSET_FIXTURE = (() => {
  const old = ALLOC_FIXTURE.port, indexes = [0, 6, 1, null, 2, 3, 4];
  const assets = ["국내시가", "국내장부", "해외시가", "해외장부", "국내주식", "해외주식", "대체투자"];
  const rename = a => ({국내채권:"국내시가", 해외채권:"해외시가", 원화유동성:"국내장부"}[a] || a);
  const remap = value => Object.fromEntries(Object.entries(value || {}).filter(([a]) => a !== "달러유동성")
    .map(([a,v]) => [rename(a),v]));
  return {...ALLOC_FIXTURE, port:{...old, assets, proxies:{...remap(old.proxies), 해외장부:"bm:synthetic-book"},
    asset_notes:{해외장부:"원화 장부가 BM · 원천 환노출·헤지 상태 미확인 — 추가 환헤지 미적용"},
    usd_assets:old.usd_assets.map(rename), bench_w:remap(old.bench_w),
    defaults:{...old.defaults, liq_default:0,
      groups:{주식:["국내주식","해외주식"],채권:assets.slice(0,4),대체:["대체투자"]}},
    coverage:indexes.map((i,j) => i === null ? {asset:assets[j],key:"bm:synthetic-book",currency:"KRW",n_months:42}
      : {...old.coverage[i],asset:assets[j]}),
    ref10y:{...old.ref10y,per_asset:{...remap(old.ref10y.per_asset),해외장부:null}},
    cma_input:{...old.cma_input,mu_pct:{...remap(old.cma_input.mu_pct),해외장부:3.2}},
    windows:old.windows.map(w => ({...w,
      mean_pct:indexes.map(i => i === null ? 3.2 : w.mean_pct[i]),
      vol_pct:indexes.map(i => i === null ? 2 : w.vol_pct[i]),
      mdd_pct:indexes.map(i => i === null ? 3 : w.mdd_pct[i]),
      cov:indexes.map(i => indexes.map(j => i === null || j === null ? (i === j ? .0004 : 0) : w.cov[i][j])),
      corr:indexes.map(i => indexes.map(j => i === null || j === null ? +(i === j) : w.corr[i][j])),
    }))}};
})();`;
const load = new Function("require", "__dirname", source.slice(0, boundary) + `
const saved = new Map(JSON.parse(process.env.IAW_TEST_CMA_STORAGE || "[]"));
const writes = [];
// Implement one browser DOM API absent from the small shared shim, locally only.
Object.getPrototypeOf(DOC.createElement("div")).replaceChildren = function(...nodes) {
  this.textContent = ""; this.append(...nodes);
};
sandbox.localStorage = {
  getItem: key => saved.has(key) ? saved.get(key) : null,
  setItem: (key, value) => { writes.push([key, String(value)]); saved.set(key, String(value)); },
  removeItem: key => { writes.push([key, null]); saved.delete(key); }
};
vm.runInContext(fs.readFileSync(path.join(ROOT, "dashboard/cma.js"), "utf8"), sandbox, {filename: "cma.js"});
const noBoot = APP.replace(/\\nboot\\(\\);\\s*$/, "\\n");
if (noBoot === APP) throw new Error("app boot boundary");
vm.runInContext(noBoot + "\\n;globalThis.__cmaProbe = {DATA, SECTION_IDS, SECTION_LABELS, RENDERERS, routeView, renderSection, renderPortPanel, portState, portDefaults, portSaveState, portModelInputs, portRiskInputs, portHedgeInputs, portRiskAllocationEngine, portCorrKey, PORT_LS_KEY};", sandbox);
` + fixture + "\n" + sevenFixture + `
return {P:sandbox.__cmaProbe, DOC, shim, sandbox, saved, writes, FETCH_CALLS, main, nav, elem, fixture:SEVEN_ASSET_FIXTURE,
  inspect: expression => vm.runInContext(expression, sandbox)};
`);
const {P, DOC, sandbox, saved, writes, FETCH_CALLS, main, nav, elem, fixture: allocation, inspect} = load(require, __dirname);
const copy = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const near = (actual, expected, tolerance = 1e-9) => assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const fire = (node, type, detail = {}) => {
  assert(node, `event target missing: ${type}`);
  const event = {type, ...detail, preventDefault() { this.defaultPrevented = true; }};
  node.dispatchEvent(event); return event;
};
for (const id of ["cma", "pseudo"]) {
  const section = elem("section", id, "section");
  section.append(elem("div", `${id}-content`)); main.append(section);
}
const html = fs.readFileSync(path.join(root, "dashboard/index.html"), "utf8");
const navHTML = html.match(/<nav\b[^>]*\bid="nav"[^>]*>([\s\S]*?)<\/nav>/);
assert(navHTML, "actual navigation markup");
for (const match of navHTML[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
  const anchor = elem("a"); anchor.setAttribute("href", match[1]); anchor.textContent = match[2]; nav.append(anchor);
}
const portfolio = allocation.port;
P.DATA.alloc = allocation;
const asset = "해외시가", assetIndex = portfolio.assets.indexOf(asset);
assert(assetIndex >= 0);
const cmaBox = () => DOC.getElementById("cma-content");
const portBox = () => DOC.getElementById("alloc-port-panel");
const input = (box, label) => [...box.querySelectorAll("input")].find(node => node.getAttribute("aria-label") === label);
const portInput = label => input(portBox(), label);
const result = {};

const C = inspect("({cmaMoments,cmaStore,cmaEnsureAsset,cmaAssetAssumption,cmaApplyAsset,cmaSetEnabled,CMA_LS_KEY})");
if (process.argv.includes("--reload")) {
  P.renderSection("cma");
  const model = P.portModelInputs(portfolio, P.portState(portfolio));
  console.log(JSON.stringify({mu: model.baseMu[assetIndex], sig: model.risk.sig[assetIndex],
    source: model.src[assetIndex], active: !!C.cmaAssetAssumption(asset),
    noRenderError: !DOC.getElementById("cma").querySelector(".render-error"),
    warning: cmaBox().textContent.includes("저장된 CMA를 읽지 못했습니다"), writes: writes.length,
    cmaAssets: C.cmaStore().assets}));
  process.exit(0);
}
const reload = (state = [...saved]) => {
  const child = spawnSync(process.execPath, [__filename, "--reload"], {encoding: "utf8", timeout: 20000,
    env: {...process.env, IAW_TEST_CMA_STORAGE: JSON.stringify(state)}});
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
};
const rows = [
  {id:"optimistic", p:25, mu:10, sig:8},
  {id:"neutral", p:50, mu:4, sig:5},
  {id:"pessimistic", p:25, mu:-2, sig:12},
];
result.moments = C.cmaMoments(rows); assert(result.moments.valid);
const changed = (index, values) => rows.map((row, i) => ({...row, ...(i === index ? values : {})}));
const deterministic = C.cmaMoments(rows.map((row, i) => ({...row, p:i === 1 ? 100 : 0, sig:i === 1 ? 0 : 12})));
const identical = C.cmaMoments(rows.map(row => ({...row, mu:3, sig:7})));
const single = C.cmaMoments(rows.map((row, i) => ({...row, p:i === 1 ? 100 : 0})));
const decimalWeights = C.cmaMoments(rows.map((row,i)=>({...row,p:[.1,.2,99.7][i],mu:1e12,sig:7})));
result.boundaries = {
  identicalScenarios: identical.valid && identical.mu === 3 && identical.sig === 7,
  degenerateOneScenario: single.valid && single.mu === 4 && single.sig === 5,
  zeroVariance: deterministic.valid && deterministic.mu === 4 && deterministic.sig === 0,
  blankProbability: !C.cmaMoments(changed(0,{p:""})).valid,
  blankReturn: !C.cmaMoments(changed(0,{mu:" "})).valid,
  blankVolatility: !C.cmaMoments(changed(0,{sig:""})).valid,
  negativeProbability: !C.cmaMoments(changed(0,{p:-1})).valid,
  over100Probability: !C.cmaMoments(changed(0,{p:101})).valid,
  allZero: !C.cmaMoments(rows.map(row=>({...row,p:0}))).valid,
  wrongSum: !C.cmaMoments(changed(0,{p:24})).valid,
  negativeVolatility: !C.cmaMoments(changed(0,{sig:-1})).valid,
  nonnumeric: !C.cmaMoments(changed(0,{mu:"not-a-number"})).valid,
  nullIsNotZero: !C.cmaMoments(changed(0,{p:null})).valid,
  finiteVarianceRequired: !C.cmaMoments(changed(0,{sig:1e308})).valid,
  finiteSpreadRequired: !C.cmaMoments(changed(0,{mu:1e308})).valid,
  numericStrings: C.cmaMoments(rows.map(row=>({...row,p:String(row.p),mu:String(row.mu),sig:String(row.sig)}))).valid,
  substantiveNear100Rejected: !C.cmaMoments(rows.map((row,i)=>({...row,p:i===0?25.0000001:row.p,mu:1e12,sig:7}))).valid,
  decimalRoundoffAccepted: decimalWeights.valid && decimalWeights.mu===1e12 && Math.abs(decimalWeights.sig-7)<1e-12,
};
assert(Object.values(result.boundaries).every(Boolean), JSON.stringify(result.boundaries));

// Upgrade old saved names only when the loaded portfolio uses their replacements.
// Loading before market data, or retaining an old payload, must not hide its CMA.
const legacyEntry = {enabled:true,applied:copy(rows),draft:copy(changed(0,{p:""})),
  baseline:{mu:4.5,sig:9,source:"자산배분 키인",window:"all"}};
const currentEntry = {enabled:false,applied:copy(changed(0,{mu:12})),draft:copy(changed(0,{mu:14})),
  baseline:{mu:5.5,sig:10,source:"CMA 파일",window:"all"}};
const legacyAssets = {국내채권:copy(legacyEntry),해외채권:copy(legacyEntry),해외시가:copy(currentEntry),
  원화유동성:{...copy(legacyEntry),enabled:false}};
const migrationData = {alloc:null}, migrationWrites = [];
const migrationStorage = new Map([[C.CMA_LS_KEY,JSON.stringify({version:1,assets:legacyAssets})]]);
const migrationContext = vm.createContext({DATA:migrationData,document:{getElementById:()=>null},localStorage:{
  getItem:key=>migrationStorage.get(key)??null,
  setItem:(key,value)=>{migrationWrites.push([key,value]);migrationStorage.set(key,value);},
}});
vm.runInContext(fs.readFileSync(path.join(root,"dashboard/cma.js"),"utf8"),migrationContext);
const migrationApi = vm.runInContext("({cmaStore,cmaSave,cmaAssetAssumption})",migrationContext);
same(migrationApi.cmaStore().assets,legacyAssets);
migrationData.alloc = {port:{assets:["국내채권","해외채권","원화유동성"]}};
assert.equal(migrationApi.cmaAssetAssumption("해외채권").mu,4);
same(migrationApi.cmaStore().assets,legacyAssets);
const oldPayloadKeptOldNames = Object.hasOwn(migrationApi.cmaStore().assets,"해외채권")
  && migrationApi.cmaAssetAssumption("해외채권").mu === 4;
migrationData.alloc.port.assets = portfolio.assets;
const migratedAssets = migrationApi.cmaStore().assets;
same(migratedAssets.국내시가,legacyEntry);
same(migratedAssets.해외시가,currentEntry);
same(migratedAssets.국내장부,legacyAssets.원화유동성);
const noWritesDuringMigration = migrationWrites.length === 0;
migrationApi.cmaSave();
const persistedMigration = JSON.parse(migrationStorage.get(C.CMA_LS_KEY));
const migratedReload = reload([[C.CMA_LS_KEY,JSON.stringify({version:1,assets:{해외채권:legacyEntry}})]]);
result.assetMigration = {
  delayedDataMigratesCachedState: !!migratedAssets.국내시가 && !migratedAssets.국내채권,
  oldPayloadKeepsOldNames: oldPayloadKeptOldNames,
  newNameWins: JSON.stringify(migratedAssets.해외시가) === JSON.stringify(currentEntry),
  appliedAndUnfinishedDraftPreserved: JSON.stringify(migratedAssets.국내시가) === JSON.stringify(legacyEntry),
  disabledStatePreserved: migratedAssets.국내장부.enabled === false,
  newBookNeverInheritsLegacy: !Object.hasOwn(migratedAssets,"해외장부"),
  oldKeysRemoved: !["국내채권","해외채권","원화유동성"].some(a=>Object.hasOwn(migratedAssets,a)),
  readDoesNotWrite: noWritesDuringMigration,
  explicitSavePersists: JSON.stringify(persistedMigration.assets) === JSON.stringify(migratedAssets),
  reloadUsesMigratedApplied: migratedReload.active && migratedReload.mu === 4 && migratedReload.noRenderError,
  reloadPreservesUnfinishedDraft: migratedReload.cmaAssets.해외시가.draft[0].p === "",
};
assert(Object.values(result.assetMigration).every(Boolean),JSON.stringify(result.assetMigration));

// Existing manual inputs remain recoverable when the independent CMA layer is disabled.
const state = P.portDefaults(portfolio);
state.mu[asset] = -1.2; state.sig[asset] = 6.5;
P.portSaveState(state); const storedPortfolio = saved.get(P.PORT_LS_KEY);
P.renderPortPanel(allocation);
portInput("국내시가 비중1").value = "42"; fire(portInput("국내시가 비중1"), "input");
portInput("해외장부 비중2").value = "7"; fire(portInput("해외장부 비중2"), "input");
P.renderSection("cma");
assert(!DOC.getElementById("cma").querySelector(".render-error"));
const card = () => [...cmaBox().querySelectorAll("article")].find(node => node.getAttribute("aria-label") === `${asset} CMA`);
const cmaInput = (scenario, label) => input(card(), `${asset} ${scenario} ${label} %`);
const set = (scenario, label, value) => {const node=cmaInput(scenario,label); node.value=String(value);fire(node,"input");};
const apply = () => card().querySelector(".cma-apply").click();
const toggle = enabled => {const node=input(card(), `${asset} CMA 적용`);node.checked=enabled;fire(node,"change");};
const labels = ["낙관","중립","비관"];
rows.forEach((row,i)=>[["확률",row.p],["기대수익",row.mu],["변동성",row.sig]].forEach(([label,value])=>set(labels[i],label,value)));
const draftModel = P.portModelInputs(portfolio, P.portState(portfolio));
const dataBefore = JSON.stringify(P.DATA.alloc);
apply();
const liveState = () => inspect("portPanelDraft.st");
const activeModel = P.portModelInputs(portfolio, liveState());
const current = C.cmaAssetAssumption(asset);
near(current.mu,4);near(current.sig,Math.sqrt(82.5));
result.application = {
  unappliedDraftDoesNotChangeModel: draftModel.baseMu[assetIndex] === -1.2 && draftModel.risk.sig[assetIndex] === 6.5,
  appliedMean: activeModel.baseMu[assetIndex] === 4,
  appliedSource: activeModel.src[assetIndex] === "CMA 시나리오",
  meanFieldReflectsModel: Number(portInput(`${asset} 기대수익`).value) === 4,
  sigmaFieldReflectsModel: Math.abs(Number(portInput(`${asset} 변동성`).value) - Math.sqrt(82.5)) < 0.0051,
  readOnlyDerivedInputs: portInput(`${asset} 기대수익`).hasAttribute("readonly") && portInput(`${asset} 변동성`).hasAttribute("readonly"),
  underlyingManualInputsPreserved: saved.get(P.PORT_LS_KEY) === storedPortfolio && liveState().mu[asset] === -1.2 && liveState().sig[asset] === 6.5,
  unsavedWeightPreserved: Number(portInput("국내시가 비중1").value) === 42,
  secondWeightPreserved: Number(portInput("해외장부 비중2").value) === 7,
  sevenCmaCards: cmaBox().querySelectorAll("article").length === 7,
  newBookAssetEditable: !!input(cmaBox(), "해외장부 낙관 기대수익 %"),
  marketPayloadUnchanged: JSON.stringify(P.DATA.alloc) === dataBefore,
};
assert(Object.values(result.application).every(Boolean), JSON.stringify(result.application));
const enabledReload = reload();
toggle(false);
const disabledModel = P.portModelInputs(portfolio, liveState()), disabledReload = reload();
result.persistence = {
  enabledReload: enabledReload.active && enabledReload.mu === 4 && Math.abs(enabledReload.sig-Math.sqrt(82.5)) < 1e-9,
  enabledSourceReload: enabledReload.source === "CMA 시나리오" && enabledReload.noRenderError,
  disabledManualRestored: !C.cmaAssetAssumption(asset) && disabledModel.baseMu[assetIndex] === -1.2 && disabledModel.risk.sig[assetIndex] === 6.5,
  disabledFieldsEditable: !portInput(`${asset} 기대수익`).hasAttribute("readonly") && !portInput(`${asset} 변동성`).hasAttribute("readonly"),
  disabledReload: !disabledReload.active && disabledReload.mu === -1.2 && disabledReload.sig === 6.5 && disabledReload.source === "키인",
};
toggle(true);

// Invalid/unfinished editing must retain the applied state through tab rerenders/reloads.
set("낙관","확률",""); apply();
const invalidReload = reload();
P.renderSection("cma");
result.invalidDraft = {
  invalidApplyDisabled: card().querySelector(".cma-apply").disabled,
  invalidFieldFlagged: cmaInput("낙관","확률").getAttribute("aria-invalid") === "true",
  retainedApplied: C.cmaAssetAssumption(asset).mu === 4 && P.portModelInputs(portfolio,liveState()).baseMu[assetIndex] === 4,
  retainedAfterReload: invalidReload.active && invalidReload.mu === 4,
  draftSurvivesRerender: cmaInput("낙관","확률").value === "",
  explicitStatus: card().querySelector(".cma-status").textContent.includes("기존 적용값은 유지"),
};
set("낙관","확률",25);

// Hover reports applied scenarios, with focus/keyboard access and Escape dismissal.
const assetTrigger = () => [...portBox().querySelectorAll("button")].find(node=>node.getAttribute("aria-label") === `${asset} 시나리오 보기`);
let trigger = assetTrigger(); fire(trigger,"mouseenter");
// Real browser focus() emits focus synchronously; otherwise an Escape re-open
// regression is invisible in the shared minimal DOM shim.
Object.getPrototypeOf(trigger).focus = function() {
  const previous=DOC.activeElement;DOC.activeElement=this;if(previous!==this)fire(this,"focus");
};
let popup = DOC.querySelector(".cma-popup"); assert(popup);
const values = [...popup.querySelectorAll("tbody tr")].map(row=>[...row.querySelectorAll("td")].map(cell=>Number(cell.textContent)));
same(values,[[25,10,8],[50,4,5],[25,-2,12]]);
const hoverOpened = trigger.getAttribute("aria-expanded") === "true";
for (const handler of DOC.listeners.keydown || []) handler({key:"Escape",preventDefault(){}});
const escapeClosed = !DOC.querySelector(".cma-popup") && DOC.activeElement === trigger;
fire(trigger,"focus"); popup=DOC.querySelector(".cma-popup");
const focusedOpen = !!popup;
const down = fire(trigger,"keydown",{key:"ArrowDown"});
const link = popup.querySelector("a");
const editLinkFocused=DOC.activeElement===link;
for (const handler of [...(DOC.listeners.keydown || [])]) handler({key:"Escape",preventDefault(){}});
const keyboardEscapeStaysClosed=!DOC.querySelector(".cma-popup") && DOC.activeElement===trigger;
fire(trigger,"mouseenter");fire(trigger,"keydown",{key:"ArrowDown"});
DOC.querySelector(".cma-popup-close").click();
const closeButtonStaysClosed=!DOC.querySelector(".cma-popup") && DOC.activeElement===trigger;
fire(trigger,"mouseenter");
result.hover = {hoverOpened, allThreeExact: values.length === 3,
  unhedgedBasis: popup.textContent.includes("추가 환헤지 전"), escapeClosed, focusedOpen,
  keyboardEditLink: down.defaultPrevented && editLinkFocused && link.getAttribute("href") === "#cma",
  keyboardEscapeStaysClosed,closeButtonStaysClosed};

// Published correlation and its manually edited alternative survive CMA sigma scaling.
const noHedge = P.portModelInputs(portfolio,liveState());
const correlationKey = P.portCorrKey("국내시가",asset);
const custom = {...liveState(),corr:{[correlationKey]:0.2}};
const customModel = P.portModelInputs(portfolio,custom);
const window = portfolio.windows.find(w=>w.key===liveState().win) || portfolio.windows.at(-1);
window.fx={active:true,var:0.01,cov_asset:portfolio.assets.map((_,i)=>i===0?0.0007:i===assetIndex?0.0045:0)};
portfolio.hedge_cost={USD:{active:true,mean_pct:-2.4}};
liveState().hedge[asset]={enabled:true,ratio:50};
const hedged=P.portModelInputs(portfolio,liveState());
const linked=P.portRiskAllocationEngine(allocation);
const appliedModel=P.portModelInputs(portfolio,inspect("portPanelDraft.applied"));
result.modelValues={covariance:noHedge.C[0][assetIndex],hedgedMean:hedged.mu[assetIndex],
  hedgedVariance:hedged.C[assetIndex][assetIndex],hedgedCovariance:hedged.C[0][assetIndex]};
result.model={validHedge:hedged.risk.valid,
  publishedCorrelationPreserved:Math.abs(noHedge.risk.corr[0][assetIndex]-.3)<1e-12,
  editedCorrelationPreserved:Math.abs(customModel.C[0][assetIndex]-.2*3.5*Math.sqrt(82.5))<1e-9,
  untouchedVariance:Math.abs(noHedge.C[0][0]-12.25)<1e-9,
  hedgeAppliedExactlyOnce:hedged.baseMu[assetIndex]===4 && Math.abs(hedged.mu[assetIndex]-2.8)<1e-9,
  linkedMeanSame:JSON.stringify(linked.V.mu)===JSON.stringify(appliedModel.mu),
  linkedCovarianceSame:JSON.stringify(linked.V.C)===JSON.stringify(appliedModel.C)};
assert(Object.values(result.model).every(Boolean),JSON.stringify(result.model));

// The seventh asset has its own editable assumptions and no assumed extra FX hedge.
const bookEntry = C.cmaEnsureAsset("해외장부",{mu:3.2,sig:2});
bookEntry.draft = rows.map(row=>({...row,mu:3.7,sig:2.8}));
assert(C.cmaApplyAsset("해외장부").valid);
const bookModel = P.portModelInputs(portfolio,liveState());
const bookTrigger = [...portBox().querySelectorAll("button")]
  .find(node=>node.getAttribute("aria-label") === "해외장부 시나리오 보기");
fire(bookTrigger,"mouseenter");
result.sevenAssetIntegration = {
  sevenAssets: portfolio.assets.length === 7 && bookModel.mu.length === 7 && bookModel.C.length === 7,
  bookAssumptionApplied: bookModel.mu[3] === 3.7 && bookModel.risk.sig[3] === 2.8,
  bookVariance: Math.abs(bookModel.C[3][3]-2.8**2)<1e-9,
  bookHover: DOC.querySelector(".cma-popup").textContent.includes("해외장부"),
  bookSourceBasis: cmaBox().querySelector(".cma-source-note").textContent === portfolio.asset_notes.해외장부,
  noUnknownBookHedge: !portInput("해외장부 환헤지"),
  bothDraftWeightsRetained: Number(portInput("국내시가 비중1").value) === 42
    && Number(portInput("해외장부 비중2").value) === 7,
};
assert(Object.values(result.sevenAssetIntegration).every(Boolean),JSON.stringify(result.sevenAssetIntegration));

const links=[...nav.querySelectorAll("a")],hashes=links.map(node=>node.getAttribute("href"));
sandbox.location.hash="#cma";P.routeView();
result.navigation={ordered:hashes[hashes.indexOf("#hedge")+1]==="#cma" && hashes[hashes.indexOf("#cma")+1]==="#pseudo",
  registered:P.SECTION_IDS.includes("cma") && typeof P.RENDERERS.cma==="function" && P.SECTION_LABELS.cma==="CMA",
  visible:!DOC.getElementById("cma").hidden && DOC.getElementById("alloc").hidden,
  active:links.find(node=>node.getAttribute("href")==="#cma").getAttribute("aria-current")==="page",
  routeClosesPopup:!DOC.querySelector(".cma-popup"),
  noUnrelatedPeriod: DOC.querySelector(".filter-row").hidden};
P.DATA.alloc=null;P.renderSection("cma");
const missingMessage=cmaBox().textContent;
P.DATA.alloc=allocation;
const invalidState=[...saved].map(([key,value])=>[key,key===C.CMA_LS_KEY?"not JSON":value]);
const badJson=reload(invalidState);
const invalidApplied=copy([...saved]);
const cmaSaved=JSON.parse(invalidApplied.find(([key])=>key===C.CMA_LS_KEY)[1]);
cmaSaved.assets[asset].enabled=true;cmaSaved.assets[asset].applied[0].p=-10;
invalidApplied.find(([key])=>key===C.CMA_LS_KEY)[1]=JSON.stringify(cmaSaved);
const badApplied=reload(invalidApplied);
const malformedChecks=[[],{}].map(applied=>{
  const stored=copy(cmaSaved);stored.assets[asset].applied=applied;
  const snapshot=[...saved].map(([key,value])=>[key,key===C.CMA_LS_KEY?JSON.stringify(stored):value]);
  const response=reload(snapshot);return !response.active && response.mu===-1.2 && response.noRenderError;
});
result.storageSafety={badJsonIgnored:!badJson.active && badJson.mu===-1.2 && badJson.noRenderError && badJson.warning,
  invalidAppliedIgnored:!badApplied.active && badApplied.mu===-1.2 && badApplied.noRenderError,
  malformedAppliedIgnored:malformedChecks.every(Boolean),
  readDoesNotOverwriteCorruption:badJson.writes===0 && badApplied.writes===0,
  missingMarketIsExplicit:missingMessage.includes("포트폴리오 데이터가 없습니다")};
result.noNetwork=FETCH_CALLS.length===0;
console.log(JSON.stringify(result));
