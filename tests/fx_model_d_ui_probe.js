/* Exercise D with actual DOM events, CSV, chart lifecycle, and malformed contracts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert=require('node:assert/strict');
const stamp=date=>Date.parse(date+'T00:00:00Z')/1000;
const iso=t=>new Date(t*1000).toISOString().slice(0,10);
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,a+' != '+b);
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const anchor={t:stamp('2028-12-31'),v:1375.125};
const steps=Array.from({length:253},(_,i)=>i);
const times=steps.map(i=>anchor.t+i*86400);
const s={engine:'garch_symmetric_fhs',path_count:10000,seed:20261103,t:times,steps,
 mean:steps.map(i=>anchor.v*Math.exp(i*.00001)),median:steps.map(()=>anchor.v),
 lower68:steps.map(i=>anchor.v*Math.exp(-.005*Math.sqrt(i))),upper68:steps.map(i=>anchor.v*Math.exp(.005*Math.sqrt(i))),
 lower95:steps.map(i=>anchor.v*Math.exp(-.010*Math.sqrt(i))),upper95:steps.map(i=>anchor.v*Math.exp(.010*Math.sqrt(i))),
 vol_pct:steps.map(i=>10-i*.01)};
const rows=Array.from({length:12},(_,i)=>({origin_t:stamp('2027-01-01')+i*30*86400,target_t:stamp('2027-01-01')+(i*30+21)*86400,
 base:1300+i*.125,actual:1305+i*.375,realized_variance:(2+i*.1)*1e-5,model_variance:(2+i*.05)*1e-5,
 constant_variance:3e-5,ewma_variance:2.5e-5,lower95:1250+i,upper95:1380+i}));
const fixture={active:true,reason:null,schema:'fx_model_d_v1',pair:'USDKRW',unit:'KRW/USD',source:'bb:달러원',asof:'2028-12-31',anchor,
 sample:{n_returns:1200},model:{mean_log_return:0,direction_forecast:false,annualization:252,steps_per_month:21,orthogonality_verified:false},
 fit:{omega:1e-6,alpha:.05,beta:.9,persistence:.95,long_run_var:2e-5,next_var:3e-5,objective:-7.25,grid_boundary:false},forecast:s,
 horizons:[1,3,6,9,12].map(h=>({horizon_months:h,steps:h*21,target_t:times[h*21],target_date:iso(times[h*21]),
 ...Object.fromEntries(['mean','median','lower68','upper68','lower95','upper95','vol_pct'].map(k=>[k,s[k][h*21]])),var95_pct:2.125*h,es95_pct:3.25*h})),
 backtest:{horizon_steps:21,rows,metrics:{n:12,qlike_d:-7.125,qlike_constant:-7.25,qlike_ewma:-7.5,mse_d:1e-10,mse_constant:2e-10,mse_ewma:3e-10,coverage95:11/12}}};
const history={t:[stamp('2027-12-31'),anchor.t,stamp('2029-01-08')],v:[1320,anchor.v,1400]};
const byId=id=>DOC.getElementById(id),host=()=>byId('fx-model-d-content'),tab=id=>byId('fx-outlook-tab-'+id);
const emit=(node,type,props={})=>node.dispatchEvent({type,...props,preventDefault(){}});
const observers=[];
sandbox.ResizeObserver=class {constructor(fn){this.fn=fn;this.disconnectCalls=0;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnectCalls++;}};
shim.UPlotStub.prototype.destroy=function(){this.destroyCalls=(this.destroyCalls||0)+1;};
shim.UPlotStub.prototype.setSize=function(size){this.lastSize=size;this.resizeCalls=(this.resizeCalls||0)+1;};
const live=()=>vm.runInContext('uplots.length',sandbox);
const copy=()=>JSON.parse(JSON.stringify(fixture));
const render=(model=fixture)=>{
 const before=shim.UPlotStub.made.length;
 P.DATA.fx={outlook:{active:false,source:'bb:달러원',history},model_d:model};P.RENDERERS.fxoutlook();
 const made=shim.UPlotStub.made.slice(before);made.forEach(u=>u.series=u.opts.series.map(s=>({...s})));
 return {made,forecast:made.find(u=>u.opts.series[2]?.label==='D 평균'),vol:made.find(u=>u.opts.series[1]?.label==='D 연율 변동성'),
 backtest:made.find(u=>u.opts.series[1]?.label==='D 예측')};
};
const action=(cls,label)=>Array.from(host().querySelector(cls).querySelectorAll('button')).find(n=>n.textContent===label);
let {made,forecast,vol,backtest}=render();assert.equal(made.length,4);assert.equal(live(),4);assert(forecast&&vol&&backtest);
assert.equal(tab('modelD').textContent,'환율모형D');assert.equal(host().querySelectorAll('.fx-d-forecast').length,5);
assert(host().querySelector('.fx-d-meta').textContent.includes('기준일 2028-12-31'));assert(host().querySelector('.fx-d-meta').textContent.includes('Bloomberg'));
assert(host().querySelector('.fx-d-status').textContent.includes('직교성 미검증'));
assert(!host().querySelector('.fx-d-method').hasAttribute('open'));
host().querySelector('.fx-d-method').querySelector('summary').click();assert(host().querySelector('.fx-d-method').hasAttribute('open'));
assert(host().querySelector('.fx-d-method').textContent.includes('95% 중앙 예측구간 하단(2.5%)'));
assert.equal(byId('fx-d-target-vol').value,'');assert(host().querySelector('.fx-d-exposure-status').textContent.includes('미입력'));
const a=forecast.data[0].indexOf(anchor.t);forecast.data.slice(1).forEach(arr=>near(arr[a],anchor.v));
assert.equal(forecast.data[1][forecast.data[0].indexOf(stamp('2029-01-08'))],null,'future actual quote must not leak past anchor');
same(vol.data,[s.t,s.vol_pct]);same(backtest.data[1],rows.map(r=>Math.sqrt(r.model_variance*252)*100));
assert(forecast.opts.series.slice(1).every(s=>s.points.show===false));same(forecast.opts.bands.map(b=>b.series),[[5,4]]);
fixture.horizons.forEach(r=>near(forecast.data[4][forecast.data[0].indexOf(r.target_t)],r.lower95));
const count=shim.UPlotStub.made.length,oldResize=forecast.resizeCalls||0;tab('modelD').click();assert(!byId('fxoutlook-model-d').hidden);
assert(forecast.resizeCalls>oldResize);assert.equal(shim.UPlotStub.made.length,count);
emit(tab('modelD'),'keydown',{key:'F2'});byId('fx-outlook-name-input').value='환 변동성';emit(byId('fx-outlook-name-input'),'input');emit(byId('fx-outlook-name-editor'),'submit');
assert.equal(tab('modelD').textContent,'환 변동성');assert.equal(JSON.parse(shim.localStorage.getItem('iaw-fx-outlook-workspaces-v1')).modelD,'환 변동성');
const original=JSON.stringify(fixture);byId('fx-d-interval').value='68';emit(byId('fx-d-interval'),'change');
fixture.horizons.forEach(r=>near(forecast.data[4][forecast.data[0].indexOf(r.target_t)],r.lower68));
assert(host().querySelectorAll('.fx-d-bounds').every(n=>n.textContent.includes('68%')));
byId('fx-d-target-vol').value='5';emit(byId('fx-d-target-vol'),'input');
let tr=host().querySelector('.fx-d-exposure-table').querySelectorAll('tbody tr');assert.equal(tr.length,5);assert(tr[0].textContent.includes((500/fixture.horizons[0].vol_pct).toFixed(2)));
byId('fx-d-target-vol').value='30';emit(byId('fx-d-target-vol'),'input');assert(host().querySelector('.fx-d-exposure-table').textContent.includes('100.00'));
for(const value of ['0','-2','NaN']){byId('fx-d-target-vol').value=value;emit(byId('fx-d-target-vol'),'input');assert.equal(byId('fx-d-target-vol').getAttribute('aria-invalid'),'true');assert(!host().querySelector('.fx-d-exposure-table').textContent.includes('100.00'));}
byId('fx-d-target-vol').value='5';emit(byId('fx-d-target-vol'),'input');
action('.fx-d-forecast-chart','표').click();action('.fx-d-forecast-chart','CSV').click();
let csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));
assert.equal(csv.length,6);assert.equal(csv[1][0],fixture.asof);near(Number(csv[1][4]),fixture.horizons[0].mean);near(Number(csv[1][12]),fixture.horizons[0].es95_pct);
assert.equal(host().querySelector('.fx-d-forecast-chart').querySelector('.chart-table').querySelectorAll('tbody tr').length,5);
action('.fx-d-backtest-chart','CSV').click();csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));
assert.equal(csv.length,13);assert.equal(csv[1][0],iso(rows.at(-1).origin_t));near(Number(csv[1][4]),Math.sqrt(rows.at(-1).model_variance*252)*100);
assert.equal(host().querySelector('.fx-d-metrics').querySelectorAll('tbody tr').length,3);assert(host().querySelector('.fx-d-metrics').textContent.includes('-7.1250'));
forecast.cursor={idx:forecast.data[0].indexOf(fixture.horizons[0].target_t),left:80,top:30};forecast.opts.hooks.setCursor.forEach(fn=>fn(forecast));
assert(host().querySelector('.fx-d-forecast-chart').querySelector('.time-chart-tooltip').textContent.includes('68% 하단'));
assert.equal(JSON.stringify(fixture),original);const oldForecast=forecast,oldObs=observers.slice();({forecast}=render());
assert.equal(oldForecast.destroyCalls,1);assert(oldObs.every(o=>o.disconnectCalls===1));assert.equal(live(),4);
assert.equal(byId('fx-d-target-vol').value,'5');assert.equal(byId('fx-d-interval').value,'68');assert(host().querySelector('.fx-d-method').hasAttribute('open'));
assert.equal(tab('modelD').textContent,'환 변동성');
const reject=[p=>p.fit.omega=0,p=>p.fit.long_run_var=0,p=>p.fit.next_var=0,
 p=>p.backtest.rows[0].model_variance=0,p=>p.backtest.rows[0].constant_variance=0,p=>p.backtest.rows[0].ewma_variance=0,
 p=>p.model.mean_log_return=.1,p=>p.model.annualization=12,p=>p.schema='unknown',p=>p.anchor.t=1e15,p=>p.asof='2020-01-01',p=>p.forecast.mean[2]=NaN,
 p=>p.forecast.lower95[3]=p.forecast.upper95[3]+1,p=>p.forecast.steps[1]=2,p=>p.forecast.t[1]=p.forecast.t[0],
 p=>p.forecast.mean[0]++,p=>p.forecast.vol_pct[1]=-1,p=>p.horizons.reverse(),p=>p.horizons[0].vol_pct++,
 p=>p.horizons[0].median++,p=>p.horizons[0].target_date='2029-01-01',p=>p.horizons[0].es95_pct=-100,
 p=>p.horizons[0]=null,p=>p.fit.persistence=1,p=>p.fit.beta=.7,p=>p.backtest.rows[0].target_t=p.anchor.t+1,
 p=>p.backtest.rows[1].origin_t=p.backtest.rows[0].origin_t,p=>p.backtest.rows[0]=null,p=>p.backtest.metrics.n--,
 p=>p.backtest.metrics.coverage95=1.1,p=>p.backtest.rows[0].realized_variance=-1];
for(const mutate of reject){const broken=copy();mutate(broken);assert(!render(broken).forecast);assert.equal(live(),1);assert(host().textContent.includes('확인할 수 없어'));}
render({active:false,reason:'최신 연속구간 자료 부족'});assert(host().textContent.includes('최신 연속구간 자료 부족'));assert(!host().querySelector('.fx-d-value'));
const noErrors=copy();noErrors.backtest.rows=[];Object.keys(noErrors.backtest.metrics).forEach(k=>noErrors.backtest.metrics[k]=k==='n'?0:null);
assert(render(noErrors).forecast);assert.equal(live(),3);assert(host().textContent.includes('평가 가능한 실현 구간이 없습니다.'));
near(vm.runInContext('fxModelDExposure(5,10)',sandbox),50);near(vm.runInContext('fxModelDExposure(5,0)',sandbox),100);
assert.equal(vm.runInContext('fxModelDExposure(0,10)',sandbox),null);
if(process.env.FX_MODEL_D_FIXTURE){
 const engine=JSON.parse(fs.readFileSync(process.env.FX_MODEL_D_FIXTURE,'utf8')),r=render(engine);assert(r.forecast&&r.vol,'actual engine payload must render');
 engine.horizons.forEach(h=>near(r.forecast.data[2][r.forecast.data[0].indexOf(h.target_t)],h.mean));
 const expired=engine.horizons.filter(h=>h.target_t<=vm.runInContext('fxOutlookToday(new Date())',sandbox));
 assert.equal(host().querySelectorAll('.fx-d-expired').length,expired.length);
 if(expired.length) assert(host().querySelector('.fx-d-exposure-table').textContent.includes('목표일 경과'));
}
console.log(JSON.stringify({fiveTabsAndNamePersistence:true,conditionalIntervalsAndRiskCards:true,noDirectionalSignalClaim:true,
 exposureBoundariesAndNoDefaultTarget:true,sameSampleVolatilityComparison:true,rawCsvPrecision:true,malformedAndInactiveRejected:true,
 chartLifecycleAndKeyboard:true,collapsedMethodState:true}));
`;
const filename=path.join(repo,'tests/fx_model_d_ui_runtime.js');
const runtime=new Module(filename,module);runtime.filename=filename;runtime.paths=Module._nodeModulePaths(path.dirname(filename));runtime._compile(bootstrap+'\n'+code,filename);
