/* Exercise migration, current portfolio and three optimized portfolios, and constraints through actual DOM events. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const code = String.raw`
const assert = require('node:assert/strict');
const near=(a,b,tol=1e-8)=>assert(Math.abs(a-b)<tol,a+' != '+b);
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const {portCorrKey}=vm.runInContext('({portCorrKey})',sandbox);
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const old=ALLOC_FIXTURE.port,order=[0,6,1,5,2,3,4];
const assets=['국내시가','국내장부','해외시가','해외장부','국내주식','해외주식','대체투자'];
const rename=a=>({'국내채권':'국내시가','원화유동성':'국내장부','해외채권':'해외시가','달러유동성':'해외장부'}[a]||a);
const remap=m=>Object.fromEntries(Object.entries(m||{}).map(([a,v])=>[rename(a),v]));
const p={...old,assets,proxies:remap(old.proxies),bench_w:remap(old.bench_w),
  usd_assets:['해외시가','해외장부','해외주식','대체투자'],
  defaults:{...old.defaults,groups:{주식:['국내주식','해외주식'],채권:['국내시가','국내장부','해외시가','해외장부'],대체:['대체투자']},
    mix:{국내시가:30,국내장부:10,해외시가:20,해외장부:0,국내주식:15,해외주식:15,대체투자:10},
    constraints:{groupMin:{주식:0,채권:0,대체:0},groupMax:{주식:100,채권:100,대체:100},assetMin:{}}},
  coverage:order.map(i=>({...old.coverage[i],asset:rename(old.coverage[i].asset)})),
  ref10y:{...old.ref10y,per_asset:remap(old.ref10y.per_asset)},
  cma_input:{...old.cma_input,mu_pct:remap(old.cma_input.mu_pct)},
  windows:old.windows.map(w=>({...w,mean_pct:order.map(i=>w.mean_pct[i]),vol_pct:order.map(i=>w.vol_pct[i]),
    mdd_pct:order.map(i=>w.mdd_pct[i]),cov:order.map(i=>order.map(j=>w.cov[i][j])),corr:order.map(i=>order.map(j=>w.corr[i][j]))}))};
p.hedge_cost={USD:{active:true,mean_pct:-1.2}};
p.windows=p.windows.map(w=>({...w,fx:{active:true,var:.0025,cov_asset:assets.map(()=>0)}}));
const alloc={...ALLOC_FIXTURE,port:p};
// Removed liquidity caps do not survive as invisible constraints. Asset inputs keep identity.
const legacy={grp:{주식:50,채권:30,대체:20},liq:10,
  mix:{국내채권:30,국내장부:10,해외채권:20,국내주식:15,해외주식:15,대체투자:10},
  mu:{국내채권:4.2,해외채권:5.1},sig:{해외채권:9.1},
  corr:{[portCorrKey('국내채권','해외채권')]:.23},hedge:{해외채권:{enabled:false,ratio:70}}};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(legacy));
P.DATA.alloc=alloc;P.renderPortPanel(alloc);
const panel=DOC.getElementById('alloc-port-panel'),byId=id=>DOC.getElementById(id);
const input=label=>Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
const edit=(label,value)=>{const n=input(label);assert(n,label+' missing');n.value=String(value);n.dispatchEvent({type:'input'});};
const update=()=>byId('port-update-btn').click();
const applyConstraints=()=>byId('port-constraint-apply').click();
const button=text=>Array.from(panel.querySelectorAll('button')).find(n=>n.textContent===text);
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='경계선')).at(-1);
const state=()=>P.portState(p);
const rows=()=>Array.from(panel.querySelectorAll('.port-benchmark tbody tr'));
const row=name=>rows().find(n=>n.querySelector('td').textContent===name);
const cells=name=>Array.from(row(name).querySelectorAll('td')).map(n=>n.textContent);
const headers=Array.from(panel.querySelectorAll('.port-table th')).map(n=>n.textContent);
same(headers.slice(0,5),['자산군','현재','Max Sharpe','Target Return','Min. Vol']);
assert(!input('국내시가 Max Sharpe')&&!input('국내시가 비중2'));
const optimized=label=>Array.from(panel.querySelectorAll('.port-opt-weight')).filter(n=>n.getAttribute('data-portfolio')===label);
const displayed=label=>optimized(label).map(n=>n.textContent);
const allWeights=()=>['Max Sharpe','Target Return','Min. Vol'].map(displayed);
same(Array.from(panel.querySelectorAll('.port-table tbody tr')).map(n=>n.querySelector('td').textContent),assets);
const migrated=state();
same(migrated.mix,{국내시가:30,국내장부:10,해외시가:20,해외장부:0,국내주식:15,해외주식:15,대체투자:10});
same(migrated.mix2,migrated.mix);
assert.equal(migrated.mu.국내시가,4.2);assert.equal(migrated.mu.해외시가,5.1);
assert.equal(migrated.sig.해외시가,9.1);assert.equal(migrated.corr[portCorrKey('국내시가','해외시가')],.23);
assert.equal(migrated.hedge.해외시가.ratio,70);
assert(!Array.from(panel.querySelectorAll('input')).some(n=>/유동성/.test(n.getAttribute('aria-label')||'')));
assert(input('해외장부 기대수익')&&input('해외장부 변동성')&&input('해외장부 환헤지'));
for(const field of ['mix','mix2','mu','sig','corr','hedge'])assert(!/국내채권|해외채권|원화유동성|달러유동성/.test(JSON.stringify(migrated[field])));

// Independent moments from the displayed assumptions and covariance definition.
const moments=mix=>{
 const w=assets.map(a=>mix[a]/100),base=p.windows.at(-1),s=assets.map((a,i)=>migrated.sig[a]??base.vol_pct[i]);
 const mu=assets.map(a=>migrated.mu[a]??p.cma_input.mu_pct[a]);
 const C=assets.map((a,i)=>assets.map((b,j)=>s[i]*s[j]*(i===j?1:(migrated.corr[portCorrKey(a,b)]??base.corr[i][j]))));
 return {mu:w.reduce((v,x,i)=>v+x*mu[i],0),sig:Math.sqrt(w.reduce((v,x,i)=>v+x*C[i].reduce((r,c,j)=>r+c*w[j],0),0))};
};
const expected=moments(migrated.mix);
near(Number(cells('현재')[1]),expected.mu,.0051);near(Number(cells('현재')[2]),expected.sig,.0051);
const verifyColumns=E=>{
 for(const [label,point] of [['Max Sharpe',E.maxSharpe],['Target Return',E.targetReturn.point],['Min. Vol',E.minVar]]){
   assert(point,label+' point missing');
   const weights=displayed(label).map(Number);assert.equal(weights.length,assets.length);
   weights.forEach((v,i)=>near(v,point.w[i]*100,.0051));near(weights.reduce((a,b)=>a+b,0),100,.036);
 }
};
const initial=P.portEngine(p,migrated);verifyColumns(initial);
near(initial.targetReturn.target,expected.mu);assert(initial.targetReturn.point.mu>=expected.mu-1e-8);
assert(initial.targetReturn.point.sig<=expected.sig+1e-7);
const target=initial.minVar.mu+(initial.front.at(-1).mu-initial.minVar.mu)*.55;
const initialWeights=allWeights(),initialRows=panel.querySelector('.port-benchmark').textContent;
edit('목표수익률 %',target);same(allWeights(),initialWeights);assert.equal(panel.querySelector('.port-benchmark').textContent,initialRows);
assert.equal(state().target_return,null);
P.renderPortPanel(alloc,{preserveDraft:true});same(allWeights(),initialWeights);near(Number(input('목표수익률 %').value),target);
update();near(state().target_return,target);verifyColumns(P.portEngine(p,state()));
assert.notDeepEqual(displayed('Target Return'),initialWeights[1]);
const markerLabels=Array.from(panel.querySelectorAll('.port-marker-key')).map(n=>n.textContent);
for(const name of ['현재','Max Sharpe','Target Return','Min. Vol'])assert(markerLabels.some(t=>t.endsWith(name)),name+' marker missing');
button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).split('\n').map(line=>line.split(','));
for(const [name,point] of [['현재',{mu:expected.mu,sig:expected.sig}],['Max Sharpe',initial.maxSharpe],
 ['Target Return',P.portEngine(p,state()).targetReturn.point],['Min. Vol',initial.minVar]]){
 const r=csv.find(v=>v[0]===name);assert(r,name+' CSV missing');near(Number(r[2]),point.sig);near(Number(r[3]),point.mu);
}
// Current input remains user-owned, while optimizer weights never overwrite legacy comparison data.
const saved=JSON.parse(shim.localStorage.getItem(P.PORT_LS_KEY));same(saved.mix,migrated.mix);same(saved.mix2,migrated.mix2);
P.renderPortPanel(alloc);assets.forEach(a=>assert.equal(input(a+' 현재').value,String(migrated.mix[a])));
near(Number(input('목표수익률 %').value),target);verifyColumns(P.portEngine(p,state()));
// Invalid current totals reject the full update and never normalize the draft.
const validRows=panel.querySelector('.port-benchmark').textContent,validStore=shim.localStorage.getItem(P.PORT_LS_KEY);
edit('국내시가 현재',29);update();assert(row('현재'));assert.equal(input('국내시가 현재').value,'29');
assert.equal(panel.querySelector('.port-benchmark').textContent,validRows);assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),validStore);
edit('국내시가 현재',30);update();
// Finite infeasible targets show no solution, without faking or clipping a target portfolio.
edit('목표수익률 %',1000);update();assert(displayed('Target Return').every(v=>v==='–'));
assert(panel.querySelector('.port-target-status').textContent.length>0);assert(!row('Target Return'));
assert(row('Max Sharpe')&&row('Min. Vol'));button('CSV').click();
assert(!CSV_DOWNLOADS.at(-1).split('\n').some(line=>line.startsWith('Target Return,')));
edit('목표수익률 %','');update();assert.equal(state().target_return,null);verifyColumns(P.portEngine(p,state()));
// Invalid numeric targets reject the atomic update, including after rerender.
const beforeBad=shim.localStorage.getItem(P.PORT_LS_KEY),beforeBadWeights=allWeights();
edit('목표수익률 %','bad');update();same(allWeights(),beforeBadWeights);assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),beforeBad);
P.renderPortPanel(alloc,{preserveDraft:true});update();same(allWeights(),beforeBadWeights);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),beforeBad);edit('목표수익률 %','');update();

// Contradictory draft bounds must not mutate the saved feasible model or plot.
const prior=JSON.stringify(state().constraints),priorData=JSON.stringify(chart().data);
edit('주식 최대제약 %',20);edit('주식 최소제약 %',50);applyConstraints();
assert.equal(JSON.stringify(state().constraints),prior);assert.equal(JSON.stringify(chart().data),priorData);
assert(byId('port-constraint-status').textContent.length>0);
edit('주식 최대제약 %',40);edit('주식 최소제약 %',20);
edit('채권 최대제약 %',70);edit('채권 최소제약 %',30);edit('대체 최대제약 %',30);edit('대체 최소제약 %',5);
const select=Array.from(panel.querySelectorAll('select')).find(n=>n.getAttribute('aria-label')==='최소제약 자산 선택');assert(select);
select.value='해외장부';select.dispatchEvent({type:'change'});edit('개별자산 최소제약 %',15);button('개별자산 추가').click();
assert(input('해외장부 최소제약 %'));applyConstraints();
assert.equal(JSON.stringify(chart().data),priorData);update();
const constrained=state();assert.equal(constrained.constraints.assetMin.해외장부,15);
assert.equal(constrained.constraints.groupMin.주식,20);assert.equal(constrained.constraints.groupMax.주식,40);
same(constrained.mix,migrated.mix);same(constrained.mix2,migrated.mix2);
const E=P.portEngine(p,constrained);assert(E.front.length>0);
verifyColumns(E);
for(const point of [...E.front,...E.robust,...E.optimistic,E.maxSharpe,E.targetReturn.point,E.minVar]){
 near(point.w.reduce((a,b)=>a+b,0),1,1e-6);assert(point.w.every(v=>v>=-1e-7));assert(point.w[3]>=.15-1e-6);
 for(const [indexes,lo,hi] of [[[4,5],.2,.4],[[0,1,2,3],.3,.7],[[6],.05,.3]]){
  const value=indexes.reduce((sum,i)=>sum+point.w[i],0);assert(value>=lo-1e-6&&value<=hi+1e-6);
 }
}
P.renderPortPanel(alloc);assert.equal(input('해외장부 최소제약 %').value,'15');assert.equal(input('주식 최대제약 %').value,'40');
const removal=Array.from(panel.querySelectorAll('button')).find(n=>n.getAttribute('aria-label')==='해외장부 최소제약 삭제');assert(removal);removal.click();applyConstraints();update();
assert(!Object.prototype.hasOwnProperty.call(state().constraints.assetMin,'해외장부'));
// Selected hedge changes all three columns consistently only after Update.
const beforeHedge=allWeights(),check=input('해외시가 환헤지');check.checked=true;check.dispatchEvent({type:'change'});
same(allWeights(),beforeHedge);update();const hedged=P.portEngine(p,state());assert(hedged.risk.hedge.active);verifyColumns(hedged);
assert(panel.querySelector('.port-objective-basis').textContent.includes('환헤지'));
button('CSV').click();const hedgeCsv=CSV_DOWNLOADS.at(-1).split('\n').map(line=>line.split(','));
for(const [label,point] of [['Max Sharpe',hedged.maxSharpe],['Target Return',hedged.targetReturn.point],['Min. Vol',hedged.minVar]]){
 const r=hedgeCsv.find(v=>v[0]===label+' · 환헤지');assert(r);near(Number(r[2]),point.sig);near(Number(r[3]),point.mu);
 point.w.forEach((w,i)=>near(Number(r[i+6]),w*100));
 assert(row(label+' · 환헤지'));
 if(label==='Target Return'&&row(label)){
   const baseline=P.portEngine(p,{...state(),hedge:{},target_return:hedged.targetReturn.target});
   near(Number(cells(label)[1]),baseline.targetReturn.point.mu,.0051);
 }
}
console.log(JSON.stringify({pass:true,legacyIdentityMigration:true,currentWeightPersistence:true,independentDisplayedMoments:true,
 optimizedColumnsAndCsv:true,targetReturnLifecycle:true,selectedHedgeBasis:true,invalidTotalIsolation:true,
 liquidityConstraintRemoved:true,infeasibleDraftBlocked:true,boundsAppliedToAllFrontiers:true,individualMinimumLifecycle:true}));
`;
const filename=path.join(repo,'tests/port_comparison_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+code,filename);
