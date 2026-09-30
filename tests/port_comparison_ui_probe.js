/* Exercise migration, two comparison portfolios, and constraints through actual DOM events. */
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
const button=text=>Array.from(panel.querySelectorAll('button')).find(n=>n.textContent===text);
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='경계선')).at(-1);
const state=()=>P.portState(p);
const rows=()=>Array.from(panel.querySelectorAll('.port-benchmark tbody tr'));
const row=name=>rows().find(n=>n.querySelector('td').textContent===name);
const cells=name=>Array.from(row(name).querySelectorAll('td')).map(n=>n.textContent);
const headers=Array.from(panel.querySelectorAll('.port-table th')).map(n=>n.textContent);
assert(headers.includes('비중1')&&headers.includes('비중2')&&!headers.includes('현재비중'));
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
const oneBefore=cells('비중1'),mix2={국내시가:15,국내장부:15,해외시가:25,해외장부:10,국내주식:10,해외주식:15,대체투자:10};
assets.forEach(a=>edit(a+' 비중2',mix2[a]));
// Weight edits remain a draft until the existing explicit save action is used.
same(state().mix2,migrated.mix2);button('기본값으로 저장').click();
same(state().mix,migrated.mix);same(state().mix2,mix2);same(cells('비중1'),oneBefore);
const expected1=moments(migrated.mix),expected2=moments(mix2);
near(Number(cells('비중1')[1]),expected1.mu,.0051);near(Number(cells('비중1')[2]),expected1.sig,.0051);
near(Number(cells('비중2')[1]),expected2.mu,.0051);near(Number(cells('비중2')[2]),expected2.sig,.0051);
assert.notEqual(cells('비중1')[1],cells('비중2')[1]);
const markerLabels=Array.from(panel.querySelectorAll('.port-marker-key')).map(n=>n.textContent);
assert(markerLabels.some(t=>t.endsWith('비중1'))&&markerLabels.some(t=>t.endsWith('비중2')));
for(const [name,m] of [['비중1',expected1],['비중2',expected2]]){
 const hoverPlot={bbox:{left:0,top:0,width:100000,height:100000},valToPos:value=>value*1000,
   cursor:{left:m.sig*1000,top:m.mu*1000}};
 chart().opts.hooks.draw.at(-1)(hoverPlot);chart().opts.hooks.setCursor.at(-1)(hoverPlot);
 const tip=panel.querySelector('.port-portfolio-tooltip');assert(!tip.hidden);
 assert.equal(tip.querySelector('.port-tooltip-title').textContent,name+' · 배분');
}
button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).split('\n').map(line=>line.split(','));
for(const [name,m] of [['비중1',expected1],['비중2',expected2]]){
 const r=csv.find(v=>v[0]===name);assert(r,name+' CSV missing');near(Number(r[2]),m.sig);near(Number(r[3]),m.mu);
}
const saved=JSON.parse(shim.localStorage.getItem(P.PORT_LS_KEY));same(saved.mix,migrated.mix);same(saved.mix2,mix2);
P.renderPortPanel(alloc);assets.forEach(a=>{assert.equal(input(a+' 비중1').value,String(migrated.mix[a]));assert.equal(input(a+' 비중2').value,String(mix2[a]));});
// Invalid totals suppress only that portfolio and never normalize its user's values.
edit('국내시가 비중2',14);assert(row('비중1')&&!row('비중2'));assert.equal(input('국내시가 비중2').value,'14');
edit('국내시가 비중2',15);assert(row('비중2'));

// Contradictory draft bounds must not mutate the saved feasible model or plot.
const prior=JSON.stringify(state().constraints),priorData=JSON.stringify(chart().data);
edit('주식 최대제약 %',20);edit('주식 최소제약 %',50);button('제약 적용').click();
assert.equal(JSON.stringify(state().constraints),prior);assert.equal(JSON.stringify(chart().data),priorData);
assert(byId('port-constraint-status').textContent.length>0);
edit('주식 최대제약 %',40);edit('주식 최소제약 %',20);
edit('채권 최대제약 %',70);edit('채권 최소제약 %',30);edit('대체 최대제약 %',30);edit('대체 최소제약 %',5);
const select=Array.from(panel.querySelectorAll('select')).find(n=>n.getAttribute('aria-label')==='최소제약 자산 선택');assert(select);
select.value='해외장부';select.dispatchEvent({type:'change'});edit('개별자산 최소제약 %',15);button('개별자산 추가').click();
assert(input('해외장부 최소제약 %'));button('제약 적용').click();
const constrained=state();assert.equal(constrained.constraints.assetMin.해외장부,15);
assert.equal(constrained.constraints.groupMin.주식,20);assert.equal(constrained.constraints.groupMax.주식,40);
same(constrained.mix,migrated.mix);same(constrained.mix2,mix2);
const E=P.portEngine(p,constrained);assert(E.front.length>0);
for(const point of [...E.front,...E.robust,...E.optimistic]){
 near(point.w.reduce((a,b)=>a+b,0),1,1e-6);assert(point.w.every(v=>v>=-1e-7));assert(point.w[3]>=.15-1e-6);
 for(const [indexes,lo,hi] of [[[4,5],.2,.4],[[0,1,2,3],.3,.7],[[6],.05,.3]]){
  const value=indexes.reduce((sum,i)=>sum+point.w[i],0);assert(value>=lo-1e-6&&value<=hi+1e-6);
 }
}
P.renderPortPanel(alloc);assert.equal(input('해외장부 최소제약 %').value,'15');assert.equal(input('주식 최대제약 %').value,'40');
const removal=Array.from(panel.querySelectorAll('button')).find(n=>n.getAttribute('aria-label')==='해외장부 최소제약 삭제');assert(removal);removal.click();button('제약 적용').click();
assert(!Object.prototype.hasOwnProperty.call(state().constraints.assetMin,'해외장부'));
console.log(JSON.stringify({pass:true,legacyIdentityMigration:true,separateWeightPersistence:true,independentDisplayedMoments:true,
 comparisonMarkersAndCsv:true,invalidTotalIsolation:true,liquidityConstraintRemoved:true,infeasibleDraftBlocked:true,
 boundsAppliedToAllFrontiers:true,individualMinimumLifecycle:true}));
`;
const filename=path.join(repo,'tests/port_comparison_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+code,filename);
