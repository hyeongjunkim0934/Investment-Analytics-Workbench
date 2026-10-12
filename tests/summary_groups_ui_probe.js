/* Six-card scenario identity and durable owner snapshots through production DOM events. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'))
  .replace('const EXPORTS = [', `
for (const [key,value] of JSON.parse(process.env.IAW_SUMMARY_STORAGE || '[]')) shim.localStorage.setItem(key,value);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'dashboard/cma.js'), 'utf8'), sandbox);
const EXPORTS = [`);
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const cma = fs.readFileSync(path.join(repo, 'tests/cma_ui_probe.js'), 'utf8');
const sevenFixture = cma.slice(cma.indexOf('const SEVEN_ASSET_FIXTURE = (() => {'), cma.indexOf('`;\nconst load'));
const code = String.raw`
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const inspect=expr=>vm.runInContext(expr,sandbox),copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const near=(a,b,tol=1e-9)=>assert(Math.abs(a-b)<tol,a+' != '+b);
const proto=Object.getPrototypeOf(DOC.createElement('div')),queryAll=proto.querySelectorAll;
proto.querySelectorAll=function(sel){return sel==='details[open]'
  ?queryAll.call(this,'details').filter(n=>n.hasAttribute('open')):queryAll.call(this,sel);};
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const A=SEVEN_ASSET_FIXTURE,p=A.port,assets=p.assets,byId=id=>DOC.getElementById(id);
const key='iaw-summary-groups-v1',store=()=>JSON.parse(shim.localStorage.getItem(key));
const cards=()=>Array.from(byId('summary-cards').querySelectorAll('.summary-card'));
const card=key=>cards().find(n=>n.getAttribute('data-plan')===key);
const cardView=()=>cards().map(n=>({key:n.getAttribute('data-plan'),text:n.querySelector('summary').textContent}));
const click=id=>{const n=byId(id);assert(n,id+' missing');assert(!n.disabled,id+' unexpectedly disabled');n.click();};
const edit=(label,value)=>{const n=Array.from(byId('alloc-port-panel').querySelectorAll('input'))
  .find(n=>n.getAttribute('aria-label')===label);assert(n,label+' missing');n.value=String(value);n.dispatchEvent({type:'input'});};
const applied=()=>inspect('portPanelDraft.applied');
const bundle=()=>inspect('portSummaryBundle')(p,applied(),P.portEngine(p,applied()));
const corrKey=inspect('portCorrKey');
const win=p.windows.at(-1);
p.windows.forEach(w=>{w.fx={active:true,var:.0001,cov_asset:assets.map(()=>0)};});
p.hedge_cost={USD:{active:true,mean_pct:-2.4}};
P.DATA.alloc=A;
if(process.env.IAW_SUMMARY_RELOAD){
  P.renderPortPanel(A);
  console.log(JSON.stringify({store:store(),view:cardView(),ownerNames:store().owners.map(o=>o.name)}));
  process.exit(0);
}

// Deliberately different weights and complete assumptions in every committed slot.
// Each slot's second column and the active TAA 2 differ from the named current slot.
const weights=[[10,20,10,15,15,20,10],[25,10,15,5,10,20,15],[5,10,30,10,15,20,10]];
const rhos=[.1,.2,-.1],hedges=[0,.5,.25];
const slots=Object.fromEntries(['current','taa1','taa2'].map((name,k)=>{
  const corr={};assets.forEach((a,i)=>assets.slice(i+1).forEach(b=>{corr[corrKey(a,b)]=rhos[k];}));
  return [name,{mix:Object.fromEntries(assets.map((a,i)=>[a,weights[k][i]])),
    mix2:Object.fromEntries(assets.map((a,i)=>[a,i===0?100:0])),
    mu:Object.fromEntries(assets.map((a,i)=>[a,3+i+k])),
    sig:Object.fromEntries(assets.map((a,i)=>[a,2+i+k/2])),corr,
    hedge:{해외시가:{enabled:hedges[k]>0,ratio:hedges[k]*100}}}];
}));
const empty={groupMin:{},groupMax:{},assetMin:{}};
const seed={...slots.taa2,win:win.key,taaTab:'taa2',saaTab:'current',constraints:empty,
  scenarios:{taa:slots,saa:{current:empty,saa1:empty,saa2:empty}}};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(seed));
P.renderPortPanel(A);
assert.equal(applied().taaTab,'taa2');
const first=bundle();
same(first.rows.map(r=>r.key),['current','taa1','taa2','min','target','sharpe']);
same(cards().map(n=>n.getAttribute('data-plan')),first.rows.map(r=>r.key));
same(first.assets,assets);
const quantiles=[.994457883209753,1.6448536269514722,1.959963984540054,2.5758293035489004];
first.rows.slice(0,3).forEach((row,k)=>{
  assert(!row.error,row.error);
  const w=weights[k].map(v=>v/100),mu=assets.map((_,i)=>3+i+k-(i===2?2.4*hedges[k]:0));
  const sig=assets.map((_,i)=>2+i+k/2);
  // Independent scalar loops: percentage-point covariance + known FX overlay variance.
  let expectedMu=0,variance=0;
  for(let i=0;i<assets.length;i++){
    expectedMu+=w[i]*mu[i];
    for(let j=0;j<assets.length;j++)variance+=w[i]*w[j]*(sig[i]*sig[j]*(i===j?1:rhos[k])
      +(i===2&&j===2?hedges[k]*hedges[k]:0));
  }
  near(row.metrics.mu,expectedMu);near(row.metrics.sig,Math.sqrt(variance));
  same(row.point.w,w);same(row.weights,weights[k]);
  same(row.ranges.map(r=>r.probability),[68,90,95,99]);
  row.ranges.forEach((range,i)=>{near(range.lower,expectedMu-quantiles[i]*Math.sqrt(variance));
    near(range.upper,expectedMu+quantiles[i]*Math.sqrt(variance));});
  const shown=Array.from(card(row.key).querySelectorAll('strong')).map(n=>n.textContent);
  same(shown,[expectedMu.toFixed(2)+'%',Math.sqrt(variance).toFixed(2)+'%']);
  assert(card(row.key).querySelector('.summary-detail').textContent.includes(
    k===0?'추가 환헤지 미적용':'선택한 환헤지 반영'));
});
assert.notEqual(first.rows[0].metrics.mu,first.rows[2].metrics.mu);

// Known covariance boundaries: determinants give an independent PSD oracle in 2D.
// Singular and zero matrices are valid and must not receive a reporting ridge.
const covarianceValid=inspect('portSummaryCovarianceValid');
for(const [C,valid] of [
  [[[4,1],[1,9]],true],[[[4,6],[6,9]],true],[[[0,0],[0,0]],true],
  [[[-1,0],[0,1]],false],[[[1,.8],[.2,1]],false],[[[1,2],[2,1]],false],
  [[[1,NaN],[NaN,1]],false],[[[1,0],[0,Infinity]],false],
]){
  const before=copy(C);assert.equal(covarianceValid(C,2),valid,JSON.stringify(C));same(C,before);
}
const degenerate=copy(applied());
for(const slot of Object.values(degenerate.scenarios.taa)){
  slot.sig=Object.fromEntries(assets.map(a=>[a,0]));slot.hedge={};
}
const zeroRows=inspect('portSummaryBundle')(p,degenerate,P.portEngine(p,degenerate)).rows.slice(0,3);
assert(zeroRows.every(r=>!r.error&&r.metrics.sig===0&&r.ranges.every(b=>b.lower===r.metrics.mu&&b.upper===r.metrics.mu)));

// Direct portfolios remain measurable even when the optimizer's SAA is impossible.
const impossible=copy(applied());impossible.constraints={groupMin:{주식:90},groupMax:{주식:10},assetMin:{}};
const infeasible=inspect('portSummaryBundle')(p,impossible,P.portEngine(p,impossible));
assert(infeasible.rows.slice(0,3).every(r=>!r.error));
assert(infeasible.rows.slice(3).every(r=>r.error));
same(infeasible.rows.slice(0,3).map(r=>r.metrics),first.rows.slice(0,3).map(r=>r.metrics));

// Changing tabs and uncommitted values never changes any live card.
const firstView=cardView();
edit('국내시가 기대수익',33);P.renderSummaryCards(A);same(cardView(),firstView);
click('port-taa-tab-current');edit('국내시가 기대수익',4.75);P.renderSummaryCards(A);same(cardView(),firstView);
click('port-update-btn');
const currentApplied=bundle(),liveInitial=cardView();
near(currentApplied.rows[0].metrics.mu,first.rows[0].metrics.mu+.1*1.75);
same(currentApplied.rows.slice(1,3).map(r=>r.metrics),first.rows.slice(1,3).map(r=>r.metrics));

// Owners start independently; a set captures all six rows, including a local target error.
for(const id of ['live','owner-A','owner-B','owner-C'])assert(byId('summary-owner-'+id),id+' owner tab');
click('summary-owner-owner-A');
click('summary-save-new');
const a1=copy(store().owners.find(o=>o.id==='owner-A').bundles[0]);
assert(a1.id&&a1.name&&a1.savedAt);same(a1.assets,assets);same(a1.rows,currentApplied.rows);
same(cardView(),liveInitial);
assert.equal(store().version,1);assert.equal(store().selectedOwner,'owner-A');
const ownerName=byId('summary-owner-name');assert(ownerName);ownerName.value='ALM 담당자';
click('summary-owner-rename');assert.equal(store().owners.find(o=>o.id==='owner-A').name,'ALM 담당자');
assert(byId('summary-owner-owner-A').textContent.includes('ALM 담당자'));

// Portfolio updates and CMA application leave an owner's saved set untouched.
edit('국내시가 기대수익',6.5);click('port-update-btn');same(cardView(),liveInitial);
same(store().owners.find(o=>o.id==='owner-A').bundles[0],a1);
const C=inspect('({cmaStore,cmaApplyAsset})');
C.cmaStore().assets.해외시가={enabled:false,applied:[],draft:[
  {id:'optimistic',p:25,mu:11,sig:4},{id:'neutral',p:50,mu:9,sig:3},{id:'pessimistic',p:25,mu:7,sig:4}],baseline:{}};
assert(C.cmaApplyAsset('해외시가').valid);same(cardView(),liveInitial);
same(store().owners.find(o=>o.id==='owner-A').bundles[0],a1);
const later=bundle();assert.notEqual(later.rows[0].metrics.mu,a1.rows[0].metrics.mu);
click('summary-save-new');
const a=store().owners.find(o=>o.id==='owner-A');assert.equal(a.bundles.length,2);
const a2=copy(a.bundles[1]);assert.notEqual(a1.id,a2.id);same(a2.rows,later.rows);
same(a.bundles[0],a1);assert.equal(a.selectedBundle,a2.id);
const selectBundle=id=>{const n=byId('summary-bundle-select');assert(n);n.value=id;n.dispatchEvent({type:'change'});};
selectBundle(a1.id);same(cardView(),liveInitial);
assert.equal(store().owners.find(o=>o.id==='owner-A').selectedBundle,a1.id);
click('summary-save-replace');
const replaced=store().owners.find(o=>o.id==='owner-A');assert.equal(replaced.bundles.length,2);
assert.equal(replaced.bundles[0].id,a1.id);same(replaced.bundles[0].rows,later.rows);same(replaced.bundles[1],a2);

click('summary-owner-owner-B');click('summary-save-new');
const b1=copy(store().owners.find(o=>o.id==='owner-B').bundles[0]);same(b1.rows,later.rows);
assert.equal(store().owners.find(o=>o.id==='owner-C').bundles.length,0);
const count=store().owners.length;click('summary-owner-add');assert.equal(store().owners.length,count+1);
const added=store().owners.at(-1);assert(added.id&&added.name);assert.equal(added.bundles.length,0);
assert.equal(new Set(store().owners.map(o=>o.id)).size,count+1);
click('summary-owner-owner-A');selectBundle(a1.id);

// Failed persistence preserves the previous selection, snapshots and visible content.
edit('국내시가 기대수익',8.25);click('port-update-btn');
const durable=shim.localStorage.getItem(key),savedView=cardView(),setItem=shim.localStorage.setItem;
shim.localStorage.setItem=function(k,v){if(k===key)throw new Error('probe quota exhausted');return setItem.call(this,k,v);};
click('summary-save-replace');assert.equal(shim.localStorage.getItem(key),durable);same(cardView(),savedView);
assert(byId('summary-status').textContent.includes('저장'));
click('summary-save-new');assert.equal(shim.localStorage.getItem(key),durable);same(cardView(),savedView);
shim.localStorage.setItem=setItem;
same(store().owners.find(o=>o.id==='owner-B').bundles[0],b1);

// A fresh JavaScript context reconstructs the same owner, selected set, and immutable cards.
const storage=[key,P.PORT_LS_KEY,inspect('CMA_LS_KEY')].map(k=>[k,shim.localStorage.getItem(k)]).filter(([,v])=>v!=null);
const reload=spawnSync(process.execPath,[path.join(ROOT,'tests/summary_groups_ui_probe.js')],{
  cwd:ROOT,encoding:'utf8',timeout:30000,env:{...process.env,IAW_SUMMARY_STORAGE:JSON.stringify(storage),IAW_SUMMARY_RELOAD:'1'}});
assert.equal(reload.status,0,reload.stderr);const afterReload=JSON.parse(reload.stdout);
same(afterReload.store,store());same(afterReload.view,savedView);assert(afterReload.ownerNames.includes('ALM 담당자'));

// A target-only error is saveable, but an entirely unavailable live bundle is not.
click('summary-owner-live');
const low=copy(A);low.port.cma_input.mu_pct=Object.fromEntries(assets.map(a=>[a,2]));
low.port.windows.forEach(w=>{w.mean_pct=assets.map(()=>2);});
C.cmaStore().assets={};shim.localStorage.removeItem(P.PORT_LS_KEY);P.DATA.alloc=low;P.renderPortPanel(low);
assert(card('target').querySelector('.summary-unavailable'));
click('summary-owner-owner-C');assert(!byId('summary-save-new').disabled);click('summary-save-new');
const c1=store().owners.find(o=>o.id==='owner-C').bundles[0];
assert(c1.rows.find(r=>r.key==='target').error);assert(!c1.rows.find(r=>r.key==='current').error);
const archivedView=cardView();
P.renderSummaryCards({port:{active:false,reason:'자료 없음'}});
assert(byId('summary-save-new').disabled);assert(byId('summary-save-replace').disabled);
same(cardView(),archivedView);
P.renderSummaryCards({});same(cardView(),archivedView);
assert(byId('summary-save-new').disabled);assert(byId('summary-save-replace').disabled);
const changedUniverse=copy(low);
changedUniverse.port.assets=assets.map(a=>'신규 '+a);
changedUniverse.port.usd_assets=[];
changedUniverse.port.defaults.groups=Object.fromEntries(Object.entries(low.port.defaults.groups)
  .map(([group,names])=>[group,names.map(a=>'신규 '+a)]));
P.renderSummaryCards(changedUniverse);same(cardView(),archivedView);
same(Array.from(card('current').querySelectorAll('.summary-weight')).filter(n=>!n.classList.contains('summary-total'))
  .map(n=>n.querySelector('span').textContent),assets);
same(store().owners.find(o=>o.id==='owner-C').bundles[0],c1);

// Corrupt persisted content is never replaced with an empty/default owner state.
// Both invalid JSON and a parseable snapshot with invalid row structure are guarded.
const recoverableStorage=shim.localStorage.getItem(key),invalidSnapshot=JSON.parse(recoverableStorage);
invalidSnapshot.owners.find(o=>o.id==='owner-C').bundles[0].rows[0].weights.pop();
for(const raw of ['{invalid JSON',JSON.stringify(invalidSnapshot)]){
  shim.localStorage.setItem(key,raw);P.renderSummaryCards(low);
  assert(byId('summary-status').textContent.includes('읽을 수 없습니다'));
  assert.equal(shim.localStorage.getItem(key),raw);
  // Failed owner selection cannot expose save or rename actions on a fallback state.
  click('summary-owner-owner-A');assert.equal(shim.localStorage.getItem(key),raw);
  click('summary-owner-owner-C');assert.equal(shim.localStorage.getItem(key),raw);
  for(const id of ['summary-save-new','summary-save-replace','summary-owner-rename']){
    const control=byId(id);assert(!control||control.disabled,id+' must be inaccessible on corrupt storage');
  }
  click('summary-owner-add');assert.equal(shim.localStorage.getItem(key),raw);
  P.renderSummaryCards(low);assert.equal(shim.localStorage.getItem(key),raw);
  assert(byId('summary-status').textContent.includes('기존 저장값을 보존'));
}
shim.localStorage.setItem(key,recoverableStorage);P.renderSummaryCards(low);
same(cardView(),archivedView);same(store(),JSON.parse(recoverableStorage));
assert.equal(byId('summary-status').textContent,'');
assert(!byId('summary-save-new').disabled);assert(!byId('summary-save-replace').disabled);
assert(byId('summary-owner-name')&&byId('summary-owner-rename'));
console.log(JSON.stringify({pass:true,sixCardOrder:true,namedScenarioIdentity:true,independentMatrixMoments:true,
  perScenarioHedge:true,normalRanges:true,covarianceBoundaries:true,zeroRiskNoRidge:true,
  optimizerConstraintIsolation:true,draftIsolation:true,
  threeDefaultOwners:true,ownerRename:true,ownerAdd:true,multipleSets:true,setSelection:true,
  explicitReplacement:true,portfolioSnapshotIsolation:true,cmaSnapshotIsolation:true,ownerIsolation:true,
  atomicStorageFailure:true,freshContextReload:true,targetErrorSaveable:true,unavailableSaveDisabled:true,
  missingSourceArchive:true,changedAssetUniverseArchive:true,corruptJSONPreserved:true,
  corruptSnapshotPreserved:true,corruptStorageWritesBlocked:true,validStorageRecovery:true}));
`;
const filename=path.join(repo,'tests/summary_groups_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sevenFixture+'\n'+code,filename);
