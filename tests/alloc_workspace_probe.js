/* 자산배분 체계 전환 회귀. 기존 합성 데이터·DOM 부팅만 재사용하고 전체
   dashboard_probe의 고비용 최적화 반복은 실행하지 않는다. 외부 요청/의존성 0. */
"use strict";
const fs = require("fs");
const path = require("path");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const fixture = (name) => {
  const start = source.indexOf(`const ${name} = (() => {`);
  const end = source.indexOf("\n})();", start);
  if (start < 0 || end < 0) throw new Error(`missing synthetic fixture: ${name}`);
  return source.slice(start, end + 6);
};
const bootEnd = source.indexOf("const out = {};");
if (bootEnd < 0) throw new Error("missing DOM boot boundary");
const load = new Function("require", "__dirname",
  source.slice(0, bootEnd) + fixture("ALLOC_FIXTURE") + fixture("CMA_ALLOC") +
  "\nreturn { P, DOC, shim, sandbox, ALLOC_FIXTURE, CMA_ALLOC };\n");
const { P, DOC, shim, ALLOC_FIXTURE, CMA_ALLOC } = load(require, __dirname);
const r = {};
const byId = (id) => DOC.getElementById(id);
const info = () => byId("alloc-workspace-info").textContent;
const choose = (key) => byId(`alloc-workspace-${key}`).click();
const input = (root, label) => [...byId(root).querySelectorAll("input")]
  .find((n) => n.getAttribute("aria-label") === label);
const change = (n, value, event = "input") => {
  if (!n) throw new Error("missing input");
  n.value = String(value);
  n.dispatchEvent({ type: event, target: n });
};
const snapshot = () => JSON.stringify([shim.localStorage.getItem("iaw-port"),
  shim.localStorage.getItem("iaw-alloc")]);
const engineValues = () => {
  const E = P.allocEngine(CMA_ALLOC, P.allocState(CMA_ALLOC));
  const ep = P.portEngine(CMA_ALLOC.port, P.portState(CMA_ALLOC.port));
  return JSON.stringify({ institution: { mu: E.V.mu, cov: E.V.C, w: E.w0 },
    port: { mu: ep.mu, cov: ep.W.cov, frontier: ep.front, bench: ep.bench } });
};
shim.location.hash = "#alloc";
P.DATA.alloc = CMA_ALLOC;
const originalNumbers = engineValues();
P.renderSection("alloc");
r.noRenderErrors = byId("alloc").querySelectorAll(".render-error").length === 0;
r.defaultPort = !byId("alloc-port-panel").hidden && byId("alloc-sim-panel").hidden;
r.portContext = /2027-01-31~2030-06-30/.test(info()) && /42개월/.test(info()) && /기본값/.test(info());
r.workspaceExplanationRemoved = !/대체 통합|달러\/원화 유동성|체계별 입력 별도 저장/.test(
  byId("alloc-workspace").textContent);
r.portTocRemoved = byId("alloc-toc") === null;
const beforeSelect = snapshot();
choose("institution");
r.institutionContext = /기관 BM/.test(info())
  && /2026-01-31~2030-06-30/.test(info()) && /54개월/.test(info());
const institutionPanels = ["alloc-sim-panel", "alloc-headline", "alloc-summary", "alloc-controls",
  "alloc-cards", "alloc-levers", "alloc-risk-proc"];
r.onlyInstitutionVisible = byId("alloc-port-panel").hidden
  && institutionPanels.every((id) => !byId(id).hidden);
const activeButton = byId("alloc-workspace-institution");
r.pressedState = activeButton.getAttribute("aria-pressed") === "true"
  && byId("alloc-workspace-port").getAttribute("aria-pressed") === "false";
r.institutionTocRemoved = byId("alloc-toc") === null;
r.workspaceLabels = [...byId("alloc-workspace").querySelectorAll("button")]
  .map((b) => b.textContent);
choose("port");
r.switchDoesNotSave = snapshot() === beforeSelect;
r.switchDoesNotRecalculateNumbers = engineValues() === originalNumbers;
r.hashUntouched = shim.location.hash === "#alloc";

/* 저장 전 초안은 전환만으로 버려지거나 다른 체계로 섞이지 않아야 한다. */
const portWeight = input("alloc-port-panel", "국내채권 비중");
change(portWeight, 31.2);
r.portDirty = /미저장 조정/.test(info()) && shim.localStorage.getItem("iaw-port") === null;
choose("institution");
const instWeight = byId("sim-mix-국내채권");
const instOriginal = +instWeight.value;
change(instWeight, instOriginal + 1);
r.institutionDirty = /미저장 조정/.test(info()) && shim.localStorage.getItem("iaw-alloc") === null;
choose("port");
r.portDraftPreserved = input("alloc-port-panel", "국내채권 비중") === portWeight && +portWeight.value === 31.2;
choose("institution");
r.institutionDraftPreserved = byId("sim-mix-국내채권") === instWeight && +instWeight.value === instOriginal + 1;
P.renderSection("alloc");
r.selectionSurvivesRerender = byId("alloc-port-panel").hidden && !byId("alloc-sim-panel").hidden
  && byId("alloc-workspace-institution").getAttribute("aria-pressed") === "true";
r.portDraftSurvivesRerender = +input("alloc-port-panel", "국내채권 비중").value === 31.2;

/* 기존 저장 규약 그대로: λ·μ 변경이 현재 입력을 함께 저장함을 표시한다. */
change(byId("alloc-lambda"), 2.3, "change");
r.institutionSaved = JSON.parse(shim.localStorage.getItem("iaw-alloc")).mvo_lambda === 2.3
  && /브라우저 저장값/.test(info());
r.portDraftSurvivesInstitutionSave = +input("alloc-port-panel", "국내채권 비중").value === 31.2
  && shim.localStorage.getItem("iaw-port") === null;
const savedInstitution = shim.localStorage.getItem("iaw-alloc");
const institutionalDraftInput = byId("sim-mix-국내채권");
change(institutionalDraftInput, 47.2);
choose("port");
change(input("alloc-port-panel", "국내채권 비중"), 29.1);
change(input("alloc-port-panel", "국내채권 기대수익"), 4.1);
const portSaved = JSON.parse(shim.localStorage.getItem("iaw-port"));
r.portSaveSemantics = portSaved.mix.국내채권 === 29.1 && portSaved.mu.국내채권 === 4.1
  && /브라우저 저장값/.test(info());
r.separateStorage = shim.localStorage.getItem("iaw-alloc") === savedInstitution;
r.institutionDraftSurvivesPortSave = byId("sim-mix-국내채권") === institutionalDraftInput
  && +institutionalDraftInput.value === 47.2;
change(input("alloc-port-panel", "국내채권 비중"), 27.9);
DOC.documentElement.setAttribute("data-theme", "light");
P.renderAll();
r.portDraftSurvivesThemeRerender = +input("alloc-port-panel", "국내채권 비중").value === 27.9;
const revert = [...byId("alloc-port-panel").querySelectorAll("button")]
  .find((b) => b.textContent === "저장값 복원");
revert.click();
r.portExplicitRevertWorks = +input("alloc-port-panel", "국내채권 비중").value === 29.1;
change(input("alloc-port-panel", "국내채권 비중"), 26.8);
P.DATA.alloc = { ...CMA_ALLOC, port: JSON.parse(JSON.stringify(CMA_ALLOC.port)) };
P.renderSection("alloc");
r.newDatasetStartsFromSaved = +input("alloc-port-panel", "국내채권 비중").value === 29.1;

/* 비활성/대체 이유를 상단에서도 보이며, 한 체계의 누락이 다른 체계를 막지 않는다. */
P.DATA.alloc = ALLOC_FIXTURE;
P.renderSection("alloc");
choose("institution");
r.fallbackShown = /벤더 프록시/.test(info()) && /벤치마크 CMA 없음/.test(info());
P.DATA.alloc = { ...CMA_ALLOC, sets: [] };
P.renderSection("alloc");
r.institutionMissingShown = /기관\s?배분·헤지 데이터를 불러오지 못했습니다/.test(info());
choose("port");
r.portWorksWithoutInstitution = !byId("alloc-port-panel").hidden
  && !!input("alloc-port-panel", "국내채권 비중") && /42개월/.test(info());
P.DATA.alloc = { ...CMA_ALLOC, port: { active: false, reason: "합성 데이터 없음" } };
P.renderSection("alloc");
r.portMissingShown = /합성 데이터 없음/.test(info());
choose("institution");
r.institutionWorksWithoutPort = !byId("alloc-sim-panel").hidden && !!byId("alloc-lambda");
choose("port");
P.openAllocDetail("sim");
r.detailSelectsInstitution = byId("alloc-port-panel").hidden && !byId("alloc-sim-panel").hidden;
P.hideDetail();
r.finalNoRenderErrors = byId("alloc").querySelectorAll(".render-error").length === 0;

/* 버튼 대신 선택 입력을 써도 원천·기간·매핑 값이 저장되고 실제 엔진에 전달된다. */
P.DATA.alloc = CMA_ALLOC;
shim.localStorage.removeItem("iaw-alloc");
P.renderSection("alloc");
choose("institution");
const selectValue = (id, value) => {
  const n = byId(id);
  if (!n || n.tagName !== "SELECT") throw new Error(`missing select: ${id}`);
  change(n, value, "change");
};
r.modelControlsAreSelects = ["alloc-source", "alloc-window", "alloc-alt-map"]
  .every((id) => byId(id)?.tagName === "SELECT");
selectValue("alloc-window", "1");
r.windowSelectUpdatesEngine = P.allocState(CMA_ALLOC).cma_win === "1"
  && P.allocEngine(CMA_ALLOC, P.allocState(CMA_ALLOC)).sample.n_months === 12
  && /2029-07-31~2030-06-30/.test(info());
selectValue("alloc-alt-map", "bm");
r.mappingSelectUpdatesEngine = P.allocState(CMA_ALLOC).alt_map.mode === "bm"
  && P.allocEngine(CMA_ALLOC, P.allocState(CMA_ALLOC)).altInfo.mode === "bm";
selectValue("alloc-source", "proxy");
r.sourceSelectUpdatesEngine = P.allocState(CMA_ALLOC).src === "proxy"
  && P.allocEngine(CMA_ALLOC, P.allocState(CMA_ALLOC)).layer === "proxy"
  && byId("alloc-window") === null && byId("alloc-alt-map") === null;
selectValue("alloc-source", "cma");
r.modelSelectionsSurviveSourceSwitch = byId("alloc-window").value === "1"
  && byId("alloc-alt-map").value === "bm";
P.DATA.alloc = ALLOC_FIXTURE;
P.renderSection("alloc");
r.missingCmaOptionDisabled = [...byId("alloc-source").querySelectorAll("option")]
  .some((n) => n.value === "cma" && n.disabled);
process.stdout.write(JSON.stringify(r));
