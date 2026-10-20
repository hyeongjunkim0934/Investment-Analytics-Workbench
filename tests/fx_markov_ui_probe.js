/* Execute the Markov renderer against explicit forecast and malformed fixtures. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,a+' != '+b);
const stamp=date=>Date.parse(date+'T00:00:00Z')/1000;
const iso=t=>new Date(t*1000).toISOString().slice(0,10);
const numeric=text=>Number(text.replaceAll(',',''));
const dates=['2026-09-30','2026-10-30','2026-11-30','2026-12-30','2027-01-30','2027-02-28',
  '2027-03-30','2027-04-30','2027-05-30','2027-06-30','2027-07-30','2027-08-30','2027-09-30'];
const history={t:['2010-01-04','2022-09-30','2023-09-30','2024-09-30','2025-09-30','2026-09-29','2026-09-30'].map(stamp),
  v:[1190,1450,1330,1320,1400,1360,1350]};
const transition=[[.97,.02,.01],[.03,.94,.03],[.02,.08,.90]];
const current={probabilities:[.6,.3,.1],regime:0,sigma_next_annual_pct:8.25};
const simulation={schema_version:1,engine:'gaussian_markov_log_returns',seed:20261020,path_count:20000,
  parameter_uncertainty_included:false,sample_path_selection:'first_paths',
  t:[],steps:[],mean:[],median:[],lower68:[],upper68:[],lower95:[],upper95:[],mean_mc_se:[],
  state_probabilities:[],sample_paths:[[],[]]};
for(let step=0;step<=252;step++){
  const month=Math.min(11,Math.floor(step/21)),offset=step-month*21;
  simulation.t.push(Math.round(stamp(dates[month])+(stamp(dates[month+1])-stamp(dates[month]))*offset/21));
  simulation.steps.push(step);
  simulation.mean.push(1350+step*.15+Math.sin(step/15)*2);
  simulation.median.push(1350+step*.12+Math.sin(step/18));
  simulation.lower68.push(1350+step*.12-Math.sqrt(step)*5);
  simulation.upper68.push(1350+step*.12+Math.sqrt(step)*5);
  simulation.lower95.push(1350+step*.12-Math.sqrt(step)*10);
  simulation.upper95.push(1350+step*.12+Math.sqrt(step)*10);
  simulation.mean_mc_se.push(Math.sqrt(step)*.025);
  simulation.state_probabilities.push(step?[.4,.35,.25]:[.6,.3,.1]);
  simulation.sample_paths[0].push(1350+step*.1+Math.sin(step/5)*9);
  simulation.sample_paths[1].push(1350-step*.2+Math.sin(step/7)*11);
}
const fixture={active:true,pair:'USDKRW',unit:'KRW/USD',source:'bb:달러원',asof:'2026-09-30',
  anchor:{t:stamp('2026-09-30'),v:1350},sample:{n_returns:2520,start:'2016-09-30',end:'2026-09-30'},
  current,transition,simulation,regimes:[
    {id:0,label:'저변동',mu_daily:.0001,sigma_daily:.003,mu_annual_pct:2.52,sigma_annual_pct:4.76,probability:.6,expected_duration_days:100/3},
    {id:1,label:'중변동',mu_daily:0,sigma_daily:.006,mu_annual_pct:0,sigma_annual_pct:9.52,probability:.3,expected_duration_days:100/6},
    {id:2,label:'고변동',mu_daily:-.0001,sigma_daily:.012,mu_annual_pct:-2.52,sigma_annual_pct:19.05,probability:.1,expected_duration_days:10}]};
const observers=[];
sandbox.ResizeObserver=class {
  constructor(fn){this.fn=fn;this.disconnectCalls=0;observers.push(this);}
  observe(node){this.node=node;}
  disconnect(){this.disconnectCalls++;}
};
shim.UPlotStub.prototype.destroy=function(){this.destroyCalls=(this.destroyCalls||0)+1;};
shim.UPlotStub.prototype.setSize=function(size){this.lastSize=size;this.resizeCalls=(this.resizeCalls||0)+1;};
shim.UPlotStub.prototype.setScale=function(key,bounds){(this.scales??={})[key]={...bounds};};
const host=()=>DOC.getElementById('fx-markov-content');
const tab=id=>DOC.getElementById('fx-outlook-tab-'+id);
const render=(model=fixture)=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.fx={outlook:{active:false,source:'bb:달러원',history},markov:model};
  P.RENDERERS.fxoutlook();
  const made=shim.UPlotStub.made.slice(before);
  const u=made.find(chart=>chart.opts.series[2]?.label==='시뮬레이션 평균');
  if(u)u.series=u.opts.series.map(s=>({...s}));
  return {u,made};
};
const live=()=>vm.runInContext('uplots.length',sandbox);
const button=label=>Array.from(host().querySelector('.fx-markov-chart-card').querySelectorAll('button')).find(node=>node.textContent===label);
let {u,made}=render();
assert.equal(made.length,2);assert.equal(live(),2);assert(u);
const beforeSwitch=shim.UPlotStub.made.length,previousResize=u.resizeCalls||0;
tab('modelA').click();assert(!DOC.getElementById('fxoutlook-model-a').hidden);
assert(u.resizeCalls>previousResize,'showing hidden panel resizes existing plot');
assert.equal(shim.UPlotStub.made.length,beforeSwitch);
const anchor=u.data[0].indexOf(fixture.anchor.t);
u.data.slice(1).forEach(row=>assert.equal(row[anchor],1350,'history/path/bounds share the observed anchor'));
assert.equal(u.data[0][0],stamp('2023-09-30'));assert.equal(u.scales.x.max,stamp('2027-09-30'));
same(u.opts.bands.map(b=>b.series),[[5,4]]);same(u.opts.series[3].dash,[6,3]);
assert.notEqual(u.opts.series[2].stroke,u.opts.series[3].stroke);
assert.notEqual(u.opts.series[1].stroke,u.opts.series[2].stroke);
assert.equal(u.opts.series[2].value(u,1430.625),'1,431원');
assert.equal(u.opts.series[2].value(u,null),'–');
const rows=u.data[0].flatMap((t,i)=>u.data[2][i]==null?[]:[[t,...u.data.slice(2,6).map(row=>row[i])]]);
same(rows,simulation.t.map((t,i)=>[t,simulation.mean[i],simulation.median[i],simulation.lower68[i],simulation.upper68[i]]));
assert.equal(rows.length,253);
assert(u.data.slice(6).some(row=>row.some(Number.isFinite)));
const box=host().querySelector('.fx-markov-chart'),legend=box.querySelector('.hedge-chart-legend'),plot=box.querySelector('.hedge-plot-host');
assert(box.children.indexOf(legend)<box.children.indexOf(plot));
assert(!host().querySelector('.fx-markov-range-note'));
assert(host().querySelector('.fx-markov-method').textContent.includes('모수 추정 불확실성은 제외'));
assert(host().querySelector('.fx-markov-method').textContent.includes('동시포함 확률이 아닙니다'));
assert(host().querySelector('.fx-markov-method').textContent.includes('시드 20261020'));
assert(host().querySelector('.fx-markov-current').textContent.includes('20,000회'));
assert(!host().querySelector('.fx-markov-method').open);
assert(host().querySelector('.fx-markov-source').textContent.includes('Bloomberg'));
assert(host().querySelector('.fx-markov-source').textContent.includes('2016-09-30 ~ 2026-09-30'));
assert(host().querySelector('.fx-markov-source').textContent.includes('2,520'));
assert(host().querySelector('.fx-markov-method').textContent.includes('21모형 거래일'));
const forecastCards=host().querySelectorAll('.fx-markov-forecast');assert.equal(forecastCards.length,3);
forecastCards.forEach((card,i)=>{
  const month=[3,6,12][i];assert(card.textContent.includes(month+'개월'));
  assert.equal(card.querySelector('.fx-markov-forecast-value').textContent,Math.round(simulation.mean[month*21]).toLocaleString('en-US')+'원');
  assert.equal(card.querySelector('.fx-markov-median-value').textContent,Math.round(simulation.median[month*21]).toLocaleString('en-US')+'원');
});
const regimeCards=host().querySelectorAll('.fx-markov-regime');assert.equal(regimeCards.length,3);
same(Array.from(regimeCards,card=>card.querySelector('.fx-markov-probability').textContent),['60.00%','30.00%','10.00%']);
assert(regimeCards[0].classList.contains('is-current'));assert(host().querySelector('.fx-markov-method').textContent.includes('2,520'));
assert.equal(host().querySelector('.fx-markov-transition').querySelectorAll('tbody tr').length,3);

// Model windows cannot refit or alter the supplied forward forecast. Consensus
// edits, DOM identity and local storage also survive any subtab switches.
const consensus=DOC.getElementById('fxoutlook-content'),input=consensus.querySelector('input');
input.value='1425';input.dispatchEvent({type:'input'});
const saved=shim.localStorage.getItem('iaw-fx-outlook-v2'),consensusNodes=consensus.children.slice();
const period=DOC.getElementById('fx-markov-period');
period.value='0';period.dispatchEvent({type:'change'});assert.equal(u.data[0][0],stamp('2010-01-04'));
same(u.data[0].flatMap((t,i)=>u.data[2][i]==null?[]:[[t,...u.data.slice(2,6).map(row=>row[i])]]),rows);
['modelB','consensus','modelA'].forEach(key=>tab(key).click());
assert.equal(shim.UPlotStub.made.length,beforeSwitch);assert.strictEqual(consensus.querySelector('input'),input);
assert.deepEqual(consensus.children,consensusNodes);assert.equal(input.value,'1425');
assert.equal(shim.localStorage.getItem('iaw-fx-outlook-v2'),saved);

// Raw CSV precision, integer table values and hover all come from the plotted
// data. Future state probabilities are displayed only at model forecast knots.
button('표').click();button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));
const headers=csv.shift(),table=host().querySelector('.chart-table').querySelectorAll('tbody tr');
assert.equal(headers.length,6);assert.equal(table.length,u.data[0].length);
assert(headers.slice(1).every(label=>label.includes('원/달러')));
csv.forEach((row,i)=>{
  const j=u.data[0].length-1-i,cells=table[i].querySelectorAll('td');assert.equal(row[0],iso(u.data[0][j]));
  row.slice(1).forEach((text,col)=>{
    const value=u.data[col+1][j];
    if(value==null){assert.equal(text,'');assert.equal(cells[col+1].textContent,'–');}
    else{near(Number(text),value);assert.equal(numeric(cells[col+1].textContent),Math.round(value));}
  });
});
period.value='1';period.dispatchEvent({type:'change'});
assert.equal(host().querySelector('.chart-table').querySelectorAll('tbody tr').length,u.data[0].length);
u.cursor={idx:u.data[0].indexOf(stamp('2027-09-30')),left:100,top:40};
u.opts.hooks.setCursor.forEach(fn=>fn(u));
const tip=host().querySelector('.time-chart-tooltip');
assert(!tip.hidden&&tip.textContent.includes('2027-09-30')&&tip.textContent.includes('저변동 모의 비중')&&tip.textContent.includes('40.00%'));
box.dispatchEvent({type:'mouseleave'});assert(tip.hidden);
u.cursor={idx:null,left:-1,top:-1};u.opts.hooks.setCursor.forEach(fn=>fn(u));assert(tip.hidden);

// Interval/sample toggles update the same chart, cards, hover and export without
// modifying any Monte Carlo summaries or consensus inputs.
const snapshot=JSON.stringify(fixture),interval=DOC.getElementById('fx-markov-interval'),paths=DOC.getElementById('fx-markov-paths');
interval.value='95';interval.dispatchEvent({type:'change'});
assert.equal(shim.UPlotStub.made.length,beforeSwitch);
same(u.data[0].flatMap((t,i)=>u.data[2][i]==null?[]:[[t,...u.data.slice(2,6).map(row=>row[i])]]),
  simulation.t.map((t,i)=>[t,simulation.mean[i],simulation.median[i],simulation.lower95[i],simulation.upper95[i]]));
assert(legend.textContent.includes('95% 구간'));
assert(host().querySelectorAll('.fx-markov-bounds').every(node=>node.textContent.includes('95%')));
paths.checked=false;paths.dispatchEvent({type:'change'});
assert(u.data.slice(6).every(row=>row.every(v=>v===null)));
button('CSV').click();
const csv95=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));
assert(csv95[0][4].includes('95% 하단'));assert(csv95[0][5].includes('95% 상단'));
near(Number(csv95[1][4]),simulation.lower95.at(-1));near(Number(csv95[1][5]),simulation.upper95.at(-1));
assert.equal(JSON.stringify(fixture),snapshot);
interval.value='50';interval.dispatchEvent({type:'change'});assert(legend.textContent.includes('95% 구간'));
paths.checked=true;paths.dispatchEvent({type:'change'});
assert(u.data.slice(6).every(row=>row.some(Number.isFinite)));

// The model header retains F2/double-click editing and safe text labels.
tab('modelA').dispatchEvent({type:'keydown',key:'F2',preventDefault(){}});
const nameInput=DOC.getElementById('fx-outlook-name-input');nameInput.value='마코브 환율';
nameInput.dispatchEvent({type:'input'});DOC.getElementById('fx-outlook-name-editor').dispatchEvent({type:'submit',preventDefault(){}});
assert.equal(DOC.getElementById('fx-outlook-title-modelA').textContent,'마코브 환율');
assert.equal(tab('modelA').textContent,'마코브 환율');

// Full rerenders clean up both chart/observer resources once, preserve the
// selected model/period, and can follow global theme teardown without double destroy.
const old=u,oldObserver=observers.find(observer=>observer.node===box);
({u}=render());assert.equal(old.destroyCalls,1);assert.equal(oldObserver.disconnectCalls,1);assert.equal(live(),2);
assert(!DOC.getElementById('fxoutlook-model-a').hidden);assert.equal(DOC.getElementById('fx-markov-period').value,'1');
assert.equal(DOC.getElementById('fx-markov-interval').value,'95');
assert.equal(DOC.getElementById('fx-markov-paths').checked,true);
const themed=u;vm.runInContext('destroyAllCharts()',sandbox);assert.equal(themed.destroyCalls,1);assert.equal(live(),0);
({u}=render());assert.equal(themed.destroyCalls,1);assert.equal(live(),2);

// A malformed active payload must never plot a plausible partial prediction.
const copy=()=>JSON.parse(JSON.stringify(fixture));
const fallback=copy();fallback.source='info:USDKRW';fallback.source_selection={fallback_used:true};
render(fallback);assert(host().querySelector('.fx-markov-fallback').textContent.includes('주 원자료 유효 관측 부재로 Infomax 대체'));
const warning=copy();warning.diagnostics={weak_volatility_separation:true,converged:false};
render(warning);assert(host().querySelector('.fx-markov-warning').textContent.includes('변동성 구분이 약합니다'));
assert(host().querySelector('.fx-markov-warning').textContent.includes('수렴하지 않았습니다'));
const malformed=[
  p=>p.anchor.v++, p=>p.simulation.t.reverse(), p=>p.simulation.upper68.pop(),
  p=>p.simulation.lower68[3]=p.simulation.upper68[3]+1,
  p=>p.simulation.lower95[3]=p.simulation.lower68[3]+1,
  p=>p.simulation.median[2]=NaN, p=>p.simulation.mean[2]=Infinity,
  p=>p.simulation.state_probabilities[1]=[.1,.1,.1], p=>p.simulation.mean_mc_se[2]=-1,
  p=>p.simulation.mean[0]++, p=>p.simulation.median[0]++, p=>p.simulation.mean_mc_se[0]=1,
  p=>p.simulation.sample_paths[0][0]++, p=>p.simulation.sample_paths[0].pop(),
  p=>p.simulation.sample_paths[0][3]=-1, p=>p.simulation.steps[2]++,
  p=>p.simulation.schema_version=2, p=>p.simulation.engine='unknown', p=>p.simulation.path_count=1,
  p=>p.simulation.seed=-1, p=>p.simulation.parameter_uncertainty_included=true,
  p=>p.simulation=null, p=>p.transition[0]=[.2,.2,.2], p=>p.transition[0]=[1.1,-.1,0],
  p=>p.regimes.reverse(), p=>p.current.probabilities=[1,0],
  p=>p.current.regime=4, p=>p.regimes[0]=null,
];
for(const mutate of malformed){const broken=copy();mutate(broken);const result=render(broken);assert(!result.u);assert.equal(result.made.length,1);assert.equal(live(),1);assert(host().textContent.includes('확인할 수 없어'));}
const inactive=render({active:false,reason:'유효 표본이 부족합니다.'});
assert(!inactive.u);assert(host().textContent.includes('유효 표본이 부족합니다.'));assert.equal(live(),1);
assert(!host().querySelector('.fx-markov-forecast'));
render(null);assert(host().textContent.includes('분석 데이터를 불러오지 못했습니다.'));
// An extreme positive tail can put the arithmetic mean above the central interval.
const skewed=copy();skewed.simulation.mean[252]=skewed.simulation.upper95[252]*2;assert(render(skewed).u);
console.log(JSON.stringify({monteCarloDailyMeanMedianAndControls:true,anchorAndForecastBands:true,threeRegimesAndForecastCards:true,
  integerDisplayRawCsvHover:true,periodLeavesForecastUnchanged:true,consensusStatePreserved:true,
  modelNameEditingPreserved:true,chartResizeAndCleanup:true,malformedAndInactiveGraceful:true}));
`;
const filename=path.join(repo,'tests/fx_markov_ui_runtime.js');
const runtime=new Module(filename,module);runtime.filename=filename;
runtime.paths=Module._nodeModulePaths(path.dirname(filename));
runtime._compile(bootstrap+'\n'+code,filename);
