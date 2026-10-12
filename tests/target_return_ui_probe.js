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
const near=(a,b,tol=1e-7)=>assert(Math.abs(a-b)<tol,a+' != '+b);
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const inspect=expr=>vm.runInContext(expr,sandbox);
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const A=SEVEN_ASSET_FIXTURE, portfolio=A.port;
P.DATA.alloc=A; P.renderPortPanel(A);
const byId=id=>DOC.getElementById(id);
const tab=key=>byId('port-result-tab-'+key);
const cards=()=>Array.from(byId('port-result-target').querySelectorAll('.port-target-card'));
const targets=()=>cards().map(n=>Number(n.getAttribute('data-target')));
const signature=()=>cards().map(n=>n.querySelector('.port-target-metrics').textContent+(n.querySelector('.port-target-weights')?.textContent||n.querySelector('.port-target-error')?.textContent)).join('|');
const editCenter=v=>{const n=byId('port-target-center');n.value=String(v);n.dispatchEvent({type:'input'});};
const apply=()=>byId('port-target-apply').click();
const engine=()=>P.portEngine(portfolio,inspect('portPanelDraft.applied'));
const rows=()=>inspect('portTargetReturnResults')(portfolio,engine(),inspect('portPanelDraft.targetReturn.center'));
const inputs=()=>byId('alloc-port-panel').querySelectorAll('input');
const edit=(label,v)=>{const n=Array.from(inputs()).find(n=>n.getAttribute('aria-label')===label);assert(n,label);n.value=String(v);n.dispatchEvent({type:'input'});};
const checkRows=()=>{
  const E=engine();
  rows().forEach((row,i)=>{
    const node=cards()[i];
    if(row.error){assert(node.querySelector('.port-target-error'));assert(!node.querySelector('.port-target-weights'));return;}
    const w=row.point.w;
    near(w.reduce((a,b)=>a+b,0),1);
    assert(E.constraints.contains(w));
    const mu=w.reduce((s,x,j)=>s+x*E.mu[j],0);
    const variance=w.reduce((s,x,j)=>s+x*E.risk.C[j].reduce((t,c,k)=>t+c*w[k],0),0);
    near(mu,row.target);near(row.metrics.mu,mu);near(row.metrics.sig,Math.sqrt(Math.max(0,variance)));
    assert.equal(node.querySelectorAll('.port-target-weight').length,portfolio.assets.length);
  });
};
same(targets(),[3,3.5,4,4.5,5]);checkRows();
assert(byId('port-result-target').hidden);tab('target').click();
assert(!byId('port-result-target').hidden&&byId('port-result-frontier').hidden&&byId('port-result-benchmark').hidden);
const store=shim.localStorage.getItem(P.PORT_LS_KEY), applied=JSON.stringify(inspect('portPanelDraft.applied')), before=signature();
editCenter(4.25);same(targets(),[3,3.5,4,4.5,5]);assert.equal(signature(),before);
P.renderPortPanel(A,{preserveDraft:true});assert.equal(byId('port-target-center').value,'4.25');assert.equal(signature(),before);
apply();same(targets(),[3.25,3.75,4.25,4.75,5.25]);checkRows();assert.notEqual(signature(),before);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),store);assert.equal(JSON.stringify(inspect('portPanelDraft.applied')),applied);
const valid=signature();
for(const bad of ['', 'abc', 'Infinity', '4.123', '1e100']){
  editCenter(bad);apply();assert.equal(signature(),valid);assert.equal(byId('port-target-center').getAttribute('aria-invalid'),'true');
}
P.renderPortPanel(A,{preserveDraft:true});assert.equal(byId('port-target-center').value,'1e100');assert.equal(byId('port-target-center').getAttribute('aria-invalid'),'true');
editCenter(5);byId('port-target-center').dispatchEvent({type:'keydown',key:'Enter',preventDefault(){}});
same(targets(),[4,4.5,5,5.5,6]);checkRows();
// Target Apply must not commit any TAA/SAA input draft.
const oldRows=JSON.stringify(rows()), oldApplied=JSON.stringify(inspect('portPanelDraft.applied'));
edit('국내시가 기대수익',8.3);editCenter(5);apply();assert.equal(JSON.stringify(rows()),oldRows);assert.equal(JSON.stringify(inspect('portPanelDraft.applied')),oldApplied);
byId('port-update-btn').click();assert.notEqual(JSON.stringify(rows()),oldRows);checkRows();
assert.equal(tab('target').getAttribute('aria-selected'),'true');same(targets(),[4,4.5,5,5.5,6]);
// Constrained feasible range 3.5..4.5: only the middle three cards may show weights.
portfolio.assets.forEach((asset,i)=>edit(asset+' 기대수익',3.5+i/(portfolio.assets.length-1)));
byId('port-update-btn').click();editCenter(4);apply();
same(rows().map(r=>!!r.error),[true,false,false,false,true]);checkRows();
assert(!cards()[0].querySelector('.port-target-weights')&&!cards()[4].querySelector('.port-target-weights'));
editCenter(100);apply();assert(rows().every(r=>r.error));assert(cards().every(n=>!n.querySelector('.port-target-weights')));
editCenter(4);apply();checkRows();
// Real applied SAA constraints narrow the range further; draft alone does not.
const constrainedBefore=signature();edit('주식 최소제약 %',60);edit('주식 최대제약 %',70);
apply();assert.equal(signature(),constrainedBefore);byId('port-update-btn').click();checkRows();
// Applied CMA changes invalidate the model cache, while center edits stay independent.
const cmaBefore=JSON.stringify(rows());
inspect('cmaAssetAssumption = () => ({mu: 4, sig: 2})');
P.renderPortPanel(A,{preserveDraft:true});assert.notEqual(JSON.stringify(rows()),cmaBefore);
same(rows().map(r=>!!r.error),[true,true,false,true,true]);checkRows();
inspect('cmaAssetAssumption = () => null');P.renderPortPanel(A,{preserveDraft:true});checkRows();
tab('target').dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});assert.equal(DOC.activeElement,tab('frontier'));
tab('frontier').dispatchEvent({type:'keydown',key:'ArrowLeft',preventDefault(){}});assert.equal(DOC.activeElement,tab('target'));
tab('target').dispatchEvent({type:'keydown',key:'ArrowLeft',preventDefault(){}});assert.equal(DOC.activeElement,tab('benchmark'));
const E=engine(), solve=inspect('portTargetReturnResults');
const badC={...E,risk:{...E.risk,C:E.risk.C.map(row=>row.slice())}};badC.risk.C[0][0]=-1;
assert(solve(portfolio,badC,4).every(row=>row.error));
assert(solve(portfolio,{...E,risk:{...E.risk,valid:false,error:'bad hedge'}},4).every(row=>row.error==='bad hedge'));
P.renderPortPanel(A);same(targets(),[3,3.5,4,4.5,5]);
console.log(JSON.stringify({fiveTargets:true,manualApply:true,draftPreserved:true,invalidInputAtomic:true,rawWeightMoments:true,
  appliedInputsOnly:true,partialInfeasibility:true,cacheInvalidation:true,invalidCovariance:true,keyboardTabs:true,reset:true}));
`;
const filename=path.join(repo,'tests/target_return_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sevenFixture+'\n'+code,filename);
