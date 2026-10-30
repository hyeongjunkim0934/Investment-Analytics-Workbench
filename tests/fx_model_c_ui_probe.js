/* Execute the model-C screen against deterministic published-contract fixtures. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert=require('node:assert/strict');
const stamp=date=>Date.parse(date+'T00:00:00Z')/1000;
const iso=t=>new Date(t*1000).toISOString().slice(0,10);
const end=(y,m)=>Date.UTC(y,m+1,0)/1000;
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,a+' != '+b);
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const fixture={active:true,schema:'fx_model_c_v1',pair:'USDKRW',unit:'KRW/USD',source:'bb:달러원',asof:'2025-12-31',model_date:'2025-12-31',
  anchor:{t:stamp('2025-12-31'),quote_t:stamp('2025-12-31'),v:1375.125},
  sample:{start:'2010-01-29',end:'2025-12-31',n_months:192,latest_common_date:'2026-01-08'},
  model:{ridge_lambda:1,shrinkage:.5,min_train:60,max_train:120,min_calibration:24},horizons:[]};
for(const h of [1,3,6,12]){
  const log=.003*h, point=fixture.anchor.v*Math.exp(log), target=end(2025,11+h);
  const backtest=Array.from({length:30},(_,i)=>{
    const origin=end(2020+Math.floor(i/12),i%12), target=end(2020+Math.floor((i+h)/12),(i+h)%12), base=1200+i*.53125;
    const actual=base+Math.sin(i/3)*20, c=base+3.125*h;
    return {origin_t:origin,target_t:target,origin_date:iso(origin),target_date:iso(target),origin_quote_date:iso(origin),target_quote_date:iso(target),
      base,actual,model_c:c,ridge:base+6.25*h,rw:base,n_train:60+i,n_calibration:i,
      lower68:i>=24?c-25:null,upper68:i>=24?c+23:null,lower95:i>=24?c-48:null,upper95:i>=24?c+41:null};
  });
  fixture.horizons.push({horizon_months:h,active:true,reason:null,target_date:iso(target),target_t:target,point,ridge_point:fixture.anchor.v*Math.exp(log*2),rw:fixture.anchor.v,
    change_pct:Math.expm1(log)*100,lower68:point-20,upper68:point+25,lower95:point-40,upper95:point+55,n_train:120,n_calibration:30,
    metrics:{n:30,rmse:15.12345*h,mae:12.125*h,rw_rmse:16.625*h,ridge_rmse:17.875*h,theil_u:15.12345/16.625,coverage68:.6666667,coverage95:1,n_interval:6},
    contributions:[{key:'intercept',label:'절편',log_pct:log*25},{key:'rate_spread',label:'한미 1년 금리차',log_pct:log*50},
      {key:'momentum_1m',label:'1개월 모멘텀',log_pct:-log*25},{key:'momentum_3m',label:'3개월 모멘텀',log_pct:log*50}],backtest});
}
const history={t:['2021-12-31','2022-12-31','2023-12-29','2024-12-31','2025-12-31','2026-01-08'].map(stamp),v:[1190,1250,1300,1450,1375.125,1380]};
const byId=id=>DOC.getElementById(id),host=()=>byId('fx-model-c-content'),tab=id=>byId('fx-outlook-tab-'+id);
const emit=(node,type,props={})=>node.dispatchEvent({type,...props,preventDefault(){}});
const observers=[];
sandbox.ResizeObserver=class {constructor(fn){this.fn=fn;this.disconnectCalls=0;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnectCalls++;}};
shim.UPlotStub.prototype.destroy=function(){this.destroyCalls=(this.destroyCalls||0)+1;};
shim.UPlotStub.prototype.setSize=function(size){this.lastSize=size;this.resizeCalls=(this.resizeCalls||0)+1;};
const render=(model=fixture)=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.fx={outlook:{active:false,source:'bb:달러원',history},model_c:model};P.RENDERERS.fxoutlook();
  const made=shim.UPlotStub.made.slice(before),forecast=made.find(u=>u.opts.series[2]?.label==='C 로그 중심'),errors=made.find(u=>u.opts.series[1]?.label==='C');
  made.forEach(u=>u.series=u.opts.series.map(s=>({...s})));
  return {made,forecast,errors};
};
const action=(cls,label)=>Array.from(host().querySelector(cls).querySelectorAll('button')).find(n=>n.textContent===label);
const live=()=>vm.runInContext('uplots.length',sandbox);
const copy=()=>JSON.parse(JSON.stringify(fixture));
let {made,forecast,errors}=render();assert.equal(made.length,3);assert.equal(live(),3);assert(forecast&&errors);
assert.equal(tab('modelC').textContent,'환율모형C');
assert.equal(host().querySelectorAll('.fx-c-forecast').length,4);
assert(host().querySelector('.fx-c-meta').textContent.includes('모형 기준일 2025-12-31'));
assert(host().querySelector('.fx-c-meta').textContent.includes('호가 2025-12-31'));
assert(!host().querySelector('.fx-c-method').open);
assert(host().querySelector('.fx-c-method').textContent.includes('당시 데이터 빈티지를 복원한 실시간 검증은 아닙니다'));
assert(host().querySelector('.fx-c-source').textContent.includes('Bloomberg'));
assert(!forecast.data[0].includes(stamp('2026-01-08')),'future quote after model anchor is not included in historical line');
const anchor=forecast.data[0].indexOf(fixture.anchor.t);forecast.data.slice(1).forEach(row=>near(row[anchor],fixture.anchor.v));
fixture.horizons.forEach(r=>{const i=forecast.data[0].indexOf(r.target_t);near(forecast.data[2][i],r.point);near(forecast.data[4][i],r.lower68);});
assert(forecast.opts.series.slice(1).every(s=>s.points.show===false));same(forecast.opts.bands.map(b=>b.series),[[5,4]]);
const before=shim.UPlotStub.made.length,oldResize=forecast.resizeCalls||0;tab('modelC').click();assert(!byId('fxoutlook-model-c').hidden);assert(forecast.resizeCalls>oldResize);assert.equal(shim.UPlotStub.made.length,before);
const consensus=byId('fxoutlook-content'),input=consensus.querySelector('input');input.value='1418';emit(input,'input');
const saved=shim.localStorage.getItem('iaw-fx-outlook-v2');['modelA','modelB','consensus','modelC'].forEach(k=>tab(k).click());
assert.strictEqual(consensus.querySelector('input'),input);assert.equal(shim.localStorage.getItem('iaw-fx-outlook-v2'),saved);
// Editable C names use the existing independent model-name store.
emit(tab('modelC'),'keydown',{key:'F2'});const name=byId('fx-outlook-name-input');name.value='금리차·모멘텀';emit(name,'input');emit(byId('fx-outlook-name-editor'),'submit');
assert.equal(tab('modelC').textContent,'금리차·모멘텀');assert.equal(JSON.parse(shim.localStorage.getItem('iaw-fx-outlook-workspaces-v1')).modelC,'금리차·모멘텀');
const original=JSON.stringify(fixture);byId('fx-c-interval').value='95';emit(byId('fx-c-interval'),'change');
fixture.horizons.forEach(r=>near(forecast.data[4][forecast.data[0].indexOf(r.target_t)],r.lower95));
assert(host().querySelectorAll('.fx-c-bounds').every(n=>n.textContent.includes('95%')));assert.equal(shim.UPlotStub.made.length,before);
action('.fx-c-forecast-chart','표').click();action('.fx-c-forecast-chart','CSV').click();
let csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));
assert.equal(csv.length,5);assert.equal(csv[1][0],fixture.model_date);assert.equal(csv[1][1],fixture.asof);near(Number(csv[1][4]),fixture.horizons[0].point);
assert.equal(host().querySelector('.fx-c-forecast-chart').querySelector('.chart-table').querySelectorAll('tbody tr').length,4);
const selected=fixture.horizons[1];same(errors.data[0],selected.backtest.map(r=>r.target_t));same(errors.data[1],selected.backtest.map(r=>r.model_c-r.actual));
action('.fx-c-errors','표').click();action('.fx-c-errors','CSV').click();
csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));assert.equal(csv.length,31);assert.equal(csv[1][0],selected.backtest.at(-1).origin_date);assert.equal(csv[1][1],selected.backtest.at(-1).target_date);near(Number(csv[1][6]),selected.backtest.at(-1).model_c);
byId('fx-c-horizon').value='12';emit(byId('fx-c-horizon'),'change');same(errors.data[1],fixture.horizons[3].backtest.map(r=>r.model_c-r.actual));
assert(host().querySelector('.fx-c-contributions').textContent.includes('3.60'));
assert.equal(host().querySelector('.fx-c-errors').querySelector('.chart-table').querySelectorAll('tbody tr').length,30);
assert.equal(JSON.stringify(fixture),original);
const metricsRows=host().querySelector('.fx-c-metrics').querySelectorAll('tbody tr');assert.equal(metricsRows.length,4);assert(metricsRows[0].textContent.includes('15.12'));
forecast.cursor={idx:forecast.data[0].indexOf(fixture.horizons[3].target_t),left:80,top:30};forecast.opts.hooks.setCursor.forEach(fn=>fn(forecast));
assert(host().querySelector('.fx-c-forecast-chart').querySelector('.time-chart-tooltip').textContent.includes('95% 하단'));
const oldForecast=forecast,oldErrors=errors,oldObs=observers.slice();({forecast,errors}=render());assert.equal(oldForecast.destroyCalls,1);assert.equal(oldErrors.destroyCalls,1);assert(oldObs.every(o=>o.disconnectCalls===1));assert.equal(live(),3);
assert.equal(byId('fx-c-horizon').value,'12');assert.equal(byId('fx-c-interval').value,'95');assert.equal(tab('modelC').textContent,'금리차·모멘텀');
for(const mutate of [p=>p.anchor.t=p.anchor.quote_t=1e15,p=>p.horizons[0].target_t=1e15,p=>p.horizons[0].backtest[0].origin_t=-1e15,
  p=>{for(const key of ['lower68','upper68','lower95','upper95'])p.horizons[0][key]=null;},
  p=>{for(const key of ['lower68','upper68','lower95','upper95'])p.horizons[0].backtest[29][key]=null;},
  p=>p.schema='future',p=>p.anchor.quote_t=p.anchor.t+1,p=>p.asof='2020-01-01',p=>p.model.shrinkage=.7,
  p=>p.horizons[0].point=NaN,p=>p.horizons[0].rw++,p=>p.horizons[0].lower95=p.horizons[0].upper95+1,
  p=>p.horizons[0].backtest[0].target_t=p.anchor.t+1,p=>p.horizons[0].backtest[0].rw++,
  p=>p.horizons[0].contributions[0].log_pct++,p=>p.horizons[0].contributions[0]=null,p=>p.horizons[0].backtest[0]=null,p=>p.horizons[0].metrics.n--,p=>p.horizons[0].metrics.theil_u=-1,
  p=>p.horizons[0].metrics.coverage68=1.1,p=>p.horizons[0].n_calibration=2,p=>p.horizons.reverse()]){
  const broken=copy();mutate(broken);const result=render(broken);assert(!result.forecast&&!result.errors);assert.equal(live(),1);assert(host().textContent.includes('확인할 수 없어'));
}
render({active:false,reason:'같은 날짜 금리자료가 부족합니다.'});assert(host().textContent.includes('같은 날짜 금리자료가 부족합니다.'));assert(!host().querySelector('.fx-c-value'));
const noBounds=copy();noBounds.horizons.forEach(r=>{r.n_calibration=23;for(const k of ['lower68','upper68','lower95','upper95'])r[k]=null;});assert(render(noBounds).forecast);assert(host().querySelectorAll('.fx-c-bounds').every(n=>n.textContent.includes('표본 부족')));
const oneInactive=copy();Object.assign(oneInactive.horizons[3],{active:false,reason:'학습 표본 부족'});assert(render(oneInactive).forecast);assert.equal(byId('fx-c-horizon').value,'1');assert(host().querySelectorAll('.fx-c-forecast')[3].textContent.includes('학습 표본 부족'));
action('.fx-c-forecast-chart','CSV').click();const inactiveCsv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));assert(inactiveCsv[4].slice(4,12).every(v=>v===''));
assert(!host().querySelector('.fx-c-metrics').querySelectorAll('tbody tr')[3].textContent.includes('181.48'));
const noErrors=copy();noErrors.horizons.forEach(r=>{r.backtest=[];r.metrics={n:0,rmse:null,mae:null,rw_rmse:null,ridge_rmse:null,theil_u:null,coverage68:null,coverage95:null,n_interval:0};});assert(render(noErrors).forecast);assert(!host().querySelector('.fx-c-no-evaluation').hidden);
const offCenter=copy();offCenter.horizons.forEach(r=>{r.lower95=r.point+1;r.lower68=r.point+2;r.upper68=r.point+3;r.upper95=r.point+4;});assert(render(offCenter).forecast,'empirical error interval need not contain point');
if(process.env.FX_MODEL_C_FIXTURE){
  const enginePayload=JSON.parse(fs.readFileSync(process.env.FX_MODEL_C_FIXTURE,'utf8'));
  const result=render(enginePayload);assert(result.forecast&&result.errors,'real engine payload must render');
  enginePayload.horizons.filter(r=>r.active).forEach(r=>near(result.forecast.data[2][result.forecast.data[0].indexOf(r.target_t)],r.point));
}
console.log(JSON.stringify({fourTabsAndNamePersistence:true,commonMonthEndDateContract:true,chartIntervalsAndNoMarkers:true,
  sameSampleMetricsAndContributions:true,forecastAndBacktestCsvPrecision:true,controlsAndConsensusPreserved:true,
  chartLifecycle:true,malformedInactiveAndMissingIntervals:true}));
`;
const filename=path.join(repo,'tests/fx_model_c_ui_runtime.js');
const runtime=new Module(filename,module);runtime.filename=filename;runtime.paths=Module._nodeModulePaths(path.dirname(filename));runtime._compile(bootstrap+'\n'+code,filename);
