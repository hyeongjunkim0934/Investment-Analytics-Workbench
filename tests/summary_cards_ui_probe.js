/* Execute summary DOM and applied/draft boundaries using the actual portfolio UI. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'))
  .replace('const EXPORTS = [', 'vm.runInContext(fs.readFileSync(path.join(ROOT, "dashboard/cma.js"), "utf8"), sandbox);\nconst EXPORTS = [');
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const cma = fs.readFileSync(path.join(repo, 'tests/cma_ui_probe.js'), 'utf8');
const sevenFixture = cma.slice(cma.indexOf('const SEVEN_ASSET_FIXTURE = (() => {'), cma.indexOf('`;\nconst load'));
const code = String.raw`
const assert = require('node:assert/strict');
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const near = (a,b,tol=1e-8) => assert(Math.abs(a-b)<tol, a+' != '+b);
const inspect = expr => vm.runInContext(expr,sandbox);
// The shared shim supports tag/class selectors; add the one attribute selector here.
const proto=Object.getPrototypeOf(DOC.createElement('div')), queryAll=proto.querySelectorAll;
proto.querySelectorAll=function(sel){return sel==='details[open]'
  ? queryAll.call(this,'details').filter(n=>n.hasAttribute('open')) : queryAll.call(this,sel);};
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const A=SEVEN_ASSET_FIXTURE, portfolio=A.port;
P.DATA.alloc=A;
const byId=id=>DOC.getElementById(id), box=()=>byId('summary-cards');
const panel=()=>byId('alloc-port-panel'), cards=()=>Array.from(box().querySelectorAll('.summary-card'));
const card=key=>cards().find(n=>n.getAttribute('data-plan')===key);
const signature=()=>box().textContent;
const input=label=>Array.from(panel().querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
const edit=(label,value)=>{const n=input(label);assert(n,label);n.value=String(value);n.dispatchEvent({type:'input'});};
const update=()=>byId('port-update-btn').click();
const engine=()=>P.portEngine(portfolio,inspect('portPanelDraft.applied'));
const assertRows=()=>{
  const E=engine(), rows=P.portSummaryResults(portfolio,E);
  same(rows.map(row=>row.key),['min','target','sharpe']);
  assert(rows.every(row=>!row.error),'all three fixture proposals feasible');
  same(rows[0].point.w,E.minVar.w);same(rows[2].point.w,E.maxSharpe.w);
  near(rows[1].metrics.mu,4);
  cards().forEach((node,i)=>{
    assert.equal(node.tagName,'DETAILS');
    const summary=node.querySelector('summary');assert(summary);
    assert(!summary.querySelector('a, button, input'),'native disclosure summary has no nested controls');
    assert.equal(summary.getAttribute('aria-label'),rows[i].label+' 상세');
    const weightRows=Array.from(summary.querySelectorAll('.summary-weight')).filter(n=>!n.classList.contains('summary-total'));
    same(weightRows.map(n=>n.querySelector('span').textContent),portfolio.assets);
    const weights=weightRows.map(n=>n.querySelector('b').textContent);
    assert(weights.every(v=>/^\d+%$/.test(v)),'integer weight labels');
    assert.equal(weights.reduce((s,v)=>s+parseInt(v,10),0),100);
    same(weights.map(v=>parseInt(v,10)),Array.from(rows[i].weights));
    const metrics=Array.from(summary.querySelectorAll('strong')).map(n=>n.textContent);
    same(metrics,[rows[i].metrics.mu.toFixed(2)+'%',rows[i].metrics.sig.toFixed(2)+'%']);
    assert(node.querySelector('.summary-detail').querySelector('a').getAttribute('href')==='#alloc');
  });
  return rows;
};

const html=fs.readFileSync(path.join(ROOT,'dashboard/index.html'),'utf8');
const navHTML=html.match(/<nav\b[^>]*\bid="nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
const hashes=Array.from(navHTML.matchAll(/href="([^"]+)"/g),m=>m[1]);
assert.equal(hashes[hashes.indexOf('#risk')-1],'#summary');
assert(P.SECTION_IDS.includes('summary'));assert.equal(P.SECTION_LABELS.summary,'요약카드');
assert.equal(P.RENDERERS.summary,P.renderSummaryCards);
P.renderPortPanel(A);
assertRows();
same(cards().map(n=>n.querySelector('.summary-title').textContent),['Min volatility','Target Return 4.0%','Max Sharpe Ratio']);
assert.equal(card('target').querySelector('strong').textContent,'4.00%');
card('target').setAttribute('open','');
const before=signature(), stored=shim.localStorage.getItem(P.PORT_LS_KEY);
edit('국내시가 기대수익',10);
assert.equal(signature(),before);
P.renderSummaryCards(A);
assert.equal(signature(),before);assert(card('target').hasAttribute('open'));
P.renderPortPanel(A,{preserveDraft:true});
assert.equal(signature(),before);assert.equal(input('국내시가 기대수익').value,'10');
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),stored);
update();assert.notEqual(signature(),before);assertRows();
assert(card('target').hasAttribute('open'));
const applied=signature(), appliedStore=shim.localStorage.getItem(P.PORT_LS_KEY);
edit('국내시가 기대수익',5);edit('국내시가 변동성',-1);
update();assert.equal(signature(),applied);
P.renderSummaryCards(A);assert.equal(signature(),applied);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),appliedStore);
assert.equal(input('국내시가 변동성').getAttribute('aria-invalid'),'true');

// Applying a CMA scenario is itself a published update; its uncommitted draft is not.
const C=inspect('({cmaStore,cmaApplyAsset,cmaAssetAssumption})');
const asset='해외시가', j=portfolio.assets.indexOf(asset);
const entry={enabled:false,applied:[],draft:[
  {id:'optimistic',p:25,mu:7,sig:1},{id:'neutral',p:50,mu:6,sig:.5},{id:'pessimistic',p:25,mu:5,sig:1}],baseline:{}};
C.cmaStore().assets[asset]=entry;
P.renderSummaryCards(A);assert.equal(signature(),applied);
assert(C.cmaApplyAsset(asset).valid);
const cmaRows=assertRows(), cmaEngine=engine();
near(cmaEngine.baseMu[j],6);assert.equal(cmaEngine.src[j],'CMA 시나리오');
assert.notEqual(signature(),applied);
assert.equal(input('국내시가 변동성').value,'-1','CMA update keeps unrelated draft');
const published=signature();entry.draft[0].mu=20;
P.renderSummaryCards(A);assert.equal(signature(),published);

// Select a valid FX overlay through its actual checkbox/percentage inputs.
edit('국내시가 변동성','');
const W=portfolio.windows.find(w=>w.key===inspect('portPanelDraft.applied.win'))||portfolio.windows.at(-1);
W.fx={active:true,var:.0001,cov_asset:portfolio.assets.map(()=>0)};
portfolio.hedge_cost={USD:{active:true,mean_pct:-2.4}};
const checkbox=input(asset+' 환헤지');assert(checkbox,'FX checkbox');
checkbox.checked=true;checkbox.dispatchEvent({type:'change'});
edit(asset+' 헤지비중 %',50);
update();
const hedgeEngine=engine();assert(hedgeEngine.risk.valid);assert(hedgeEngine.risk.hedge.active);
near(hedgeEngine.mu[j],4.8);assertRows();
assert(card('target').querySelector('.summary-detail').textContent.includes('선택한 환헤지 반영'));

// Target infeasibility is local to the target card, and never shows stale weights.
const narrow={...A,port:{...portfolio,cma_input:{mu_pct:Object.fromEntries(portfolio.assets.map(a=>[a,2]))},
  windows:portfolio.windows.map(w=>({...w,mean_pct:portfolio.assets.map(()=>2)}))}};
shim.localStorage.removeItem(P.PORT_LS_KEY);C.cmaStore().assets={};
P.DATA.alloc=narrow;P.renderPortPanel(narrow);
assert(card('target').textContent.includes('달성할 수 없습니다'));
assert(!card('target').querySelector('.summary-weights'));
assert(card('min').querySelector('.summary-weights'));assert(card('sharpe').querySelector('.summary-weights'));
assert(Array.from(card('target').querySelectorAll('strong')).every(n=>n.textContent==='—'));
P.renderSummaryCards({port:{active:false,reason:'자료 없음'}});
assert.equal(cards().length,3);
assert(cards().every(n=>n.textContent.includes('자료 없음')&&!n.querySelector('.summary-weights')));
const invalid=JSON.parse(JSON.stringify(narrow));invalid.port.windows.forEach(w=>{w.cov[0][0]=-1;});
P.renderSummaryCards(invalid);
assert(cards().every(n=>n.querySelector('.summary-unavailable')&&!n.querySelector('.summary-weights')));
console.log(JSON.stringify({pass:true,navigation:true,proposalOrder:true,allSevenAssets:true,integerTotal100:true,
  exactTargetReturn:true,portfolioResultsMatch:true,draftIsolation:true,rejectedUpdateRetained:true,
  disclosureStateRetained:true,cmaAppliedOnly:true,hedgeApplied:true,infeasibleTarget:true,invalidData:true}));
`;
const filename=path.join(repo,'tests/summary_cards_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sevenFixture+'\n'+code,filename);
