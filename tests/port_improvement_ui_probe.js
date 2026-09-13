/* Exercise the real improvement panel and independently reconstruct displayed moments. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const robust = fs.readFileSync(path.join(repo, 'tests/robust_frontier_ui_probe.js'), 'utf8');
const sixFixture = robust.slice(robust.indexOf('const SIX_ASSET_FIXTURE = (() => {'), robust.indexOf('\n`;\nconst reloadCode'));
const code = String.raw`
const assert = require('node:assert/strict');
const extra = vm.runInContext('({portCorrKey, portImprovementSettings})', sandbox);
// Capture only real input data. None of the expected values use helper outputs.
vm.runInContext('const originalConditions = portImprovementConditions;' +
  'portImprovementConditions = (C,mu,references,options) => {' +
  'globalThis.improvementInputs = JSON.stringify({C,mu,references,options});' +
  'return originalConditions(C,mu,references,options);};', sandbox);
shim.UPlotStub.prototype.destroy = function(){this.dead=true;};
const panel = DOC.getElementById('alloc-port-panel');
const byId = (id)=>DOC.getElementById(id);
const card = ()=>byId('port-improvement-panel');
const chart = ()=>shim.UPlotStub.made.filter(c=>!c.dead&&c.opts.series.some(s=>s.label==='경계선')).pop();
const assets = SIX_ASSET_FIXTURE.port.assets;
const mu = [4.6,3.9,6,21,16,15], sig = [4,3,9,23,19,18], corr = {};
assets.forEach((a,i)=>assets.slice(i+1).forEach(b=>{corr[extra.portCorrKey(a,b)]=.4;}));
const state = {...P.portDefaults(SIX_ASSET_FIXTURE.port),
  mu:Object.fromEntries(assets.map((a,i)=>[a,mu[i]])),
  sig:Object.fromEntries(assets.map((a,i)=>[a,sig[i]])),corr};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(state));
shim.localStorage.removeItem('iaw-port-improvement');
shim.localStorage.removeItem('iaw-port-range-sigma');
P.DATA.alloc=SIX_ASSET_FIXTURE;P.renderPortPanel(SIX_ASSET_FIXTURE);
const savedFinancial = shim.localStorage.getItem(P.PORT_LS_KEY);
const financial = ()=>JSON.stringify({state:P.portState(SIX_ASSET_FIXTURE.port),front:chart().data,
  cma:panel.querySelector('.port-export').value,
  covariance:P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port)).risk.C});
const initialFinancial = financial();
function assertFinancial(){
  assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),savedFinancial);
  assert.equal(financial(),initialFinancial);
}
const near = (a,b,tol=1e-8)=>assert(Math.abs(a-b)<=tol,a+' != '+b);
const dot = (a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const quadratic = (C,w)=>dot(w,C.map(r=>dot(r,w)));
const getRows = ()=>Array.from(card().querySelectorAll('.port-improvement-table tbody tr'));
const rawRows = ()=>JSON.stringify(getRows().map(r=>['base-risk','base-return','new-risk','new-return','correlation','mix-risk','risk-reduction','improves']
  .map(k=>r.getAttribute('data-'+k))));
let verifiedRows = 0;
function verifyRows(expected){
  const actual = JSON.parse(sandbox.improvementInputs), rows = getRows();
  assert.deepEqual(actual.options,expected);
  assert(rows.length>0&&rows.length<=3);
  assert.equal(rows.length,actual.references.length);
  const engine = P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port));
  assert.deepEqual(actual.C,JSON.parse(JSON.stringify(engine.risk.C)));
  assert.deepEqual(actual.mu,mu);
  const correlations = Array.from(card().querySelectorAll('.port-improvement-correlations tbody tr'));
  assert.equal(correlations.length,rows.length);
  rows.forEach((row,i)=>{
    const ref = actual.references[i], w=ref.w, q=expected.weight, f=expected.sigmaFactor, rho=expected.correlation;
    assert(engine.front.some(p=>p.w.every((v,j)=>Math.abs(v-w[j])<1e-9)), 'reference must be a nominal frontier allocation');
    const baseReturn=dot(mu,w), baseVariance=quadratic(actual.C,w), baseRisk=Math.sqrt(baseVariance);
    const newRisk=baseRisk*f, newReturn=baseReturn;
    const mixRisk=Math.sqrt(Math.max(0,(1-q)**2*baseVariance+q*q*newRisk**2+2*q*(1-q)*rho*baseRisk*newRisk));
    const reduction=baseRisk-mixRisk;
    for(const [key,value] of Object.entries({'base-risk':baseRisk,'base-return':baseReturn,
      'new-risk':newRisk,'new-return':newReturn,'mix-risk':mixRisk,'risk-reduction':reduction})){
      const attr=row.getAttribute('data-'+key);assert.notEqual(attr,null,key);near(Number(attr),value);
    }
    if(newRisk===0)assert.equal(row.getAttribute('data-correlation'),null);
    else near(Number(row.getAttribute('data-correlation')),rho);
    const improves=reduction>1e-8;
    assert.equal(row.getAttribute('data-improves'),String(improves));
    const cells=Array.from(row.querySelectorAll('td'),n=>n.textContent);
    near(parseFloat(cells[0]),baseRisk,.00501);near(parseFloat(cells[1]),baseReturn,.00501);
    assert(cells[2].startsWith('≥ '));
    const returnLower=Number(cells[2].slice(2));
    assert(returnLower>=newReturn-1e-12&&returnLower<newReturn+.010001,'rounded sufficient return must not understate the threshold');
    near(parseFloat(cells[3]),newRisk,.00501);
    if(newRisk===0)assert.equal(cells[4],'–');else near(parseFloat(cells[4]),rho,.00501);
    near(parseFloat(cells[5]),mixRisk,.00501);near(parseFloat(cells[6]),reduction,.00501);
    assert.equal(cells[6].includes('미충족'),!improves);
    const corrCells=Array.from(correlations[i].querySelectorAll('td'),n=>n.textContent);
    assert.equal(corrCells.length,assets.length+1);
    assets.forEach((a,j)=>{
      if(newRisk===0)assert.equal(corrCells[j+1],'–');
      else near(parseFloat(corrCells[j+1]),rho*dot(actual.C[j],w)/baseRisk/sig[j],.00501);
    });
    verifiedRows++;
  });
  assertFinancial();
}
assert(card()&&card().classList.contains('port-improvement'));
assert.equal(card().querySelector('.card-title').textContent,'개선여지');
const benchmark=panel.querySelector('.port-benchmark').parentElement;
const siblings=benchmark.parentElement.children;
assert.equal(siblings[siblings.indexOf(benchmark)+1],card(),'improvement belongs immediately below benchmark');
assert.equal(byId('port-improvement-weight').value,'10');
assert.equal(byId('port-improvement-sigma-factor').value,'1');
assert.equal(byId('port-improvement-correlation').value,'0');
assert.equal(byId('port-range-sigma').value,'0.25');
assert(!panel.textContent.includes('자산 공백'));
assert(card().textContent.includes('가상')&&card().textContent.includes('기대수익 유지'));
assert(card().textContent.includes('기존 비중 비례축소'));
verifyRows({weight:.1,sigmaFactor:1,correlation:0});
const initialRows=rawRows();
const setInput=(key,value)=>{const node=byId('port-improvement-'+key);node.value=String(value);node.dispatchEvent({type:'input'});};
const apply=(settings,enter=false)=>{
  setInput('weight',settings.weight*100);setInput('sigma-factor',settings.sigmaFactor);setInput('correlation',settings.correlation);
  if(enter)byId('port-improvement-correlation').dispatchEvent({type:'keydown',key:'Enter',preventDefault(){}});
  else byId('port-improvement-apply').click();
};
// Drafts survive a redraw without becoming active conditions or changing any asset.
setInput('weight',20);
assert.equal(rawRows(),initialRows);assert.equal(shim.localStorage.getItem('iaw-port-improvement'),null);
const range=byId('port-range-sigma');range.value='1';range.dispatchEvent({type:'change'});
assert.equal(byId('port-improvement-weight').value,'20');
assert.equal(rawRows(),initialRows);assertFinancial();
const diversified={weight:.2,sigmaFactor:1.5,correlation:.3};
apply(diversified,true);verifyRows(diversified);
assert.deepEqual(JSON.parse(shim.localStorage.getItem('iaw-port-improvement')),diversified);
assert.notEqual(rawRows(),initialRows);
P.renderPortPanel(SIX_ASSET_FIXTURE);
assert.equal(byId('port-improvement-weight').value,'20');
assert.equal(byId('port-improvement-sigma-factor').value,'1.5');
assert.equal(byId('port-improvement-correlation').value,'0.3');
verifyRows(diversified);
const validRows=rawRows(),savedSettings=shim.localStorage.getItem('iaw-port-improvement');
for(const [key,bad] of [['weight',0],['weight',100],['weight',''],['sigma-factor',-1],['sigma-factor','Infinity'],['correlation',-1.01],['correlation',1.01],['correlation','oops']]){
  apply(diversified);
  setInput(key,bad);byId('port-improvement-apply').click();
  assert.equal(shim.localStorage.getItem('iaw-port-improvement'),savedSettings);
  assert.equal(rawRows(),validRows);assertFinancial();
  assert(card().querySelector('.port-improvement-status').textContent.includes('미적용'));
}
for(const boundary of [{weight:.1,sigmaFactor:1,correlation:1},{weight:.1,sigmaFactor:20,correlation:1},{weight:.1,sigmaFactor:0,correlation:.7}]){
  apply(boundary);verifyRows(boundary);
}
apply(diversified);verifyRows(diversified);
// The new CSV is bound to the new panel's exact scenario, not the frontier table.
const csv=Array.from(card().querySelectorAll('button')).find(n=>n.textContent==='CSV');assert(csv);csv.click();
const exported=CSV_DOWNLOADS.at(-1);
assert(exported.includes('신규 기대수익 하한%')&&exported.includes('신규 비중%'));
assert(exported.includes(assets[0]+' 상관'));
getRows().forEach(r=>assert(exported.includes(r.getAttribute('data-new-return'))));
assertFinancial();assert.equal(shim.UPlotStub.made.filter(c=>!c.dead).length,1);
console.log(JSON.stringify({pass:true,verifiedRows,independentMoments:true,benchmarkOrder:true,
  unchangedFinancialInputs:true,persistence:true,invalidRejected:true,zeroRiskHandled:true,csv:true}));
`;
const filename=path.join(repo,'tests/port_improvement_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sixFixture+'\n'+code,filename);
