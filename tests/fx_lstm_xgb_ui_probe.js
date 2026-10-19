/* Execute the model-B (LSTM/XGBoost walk-forward) renderer against explicit artifact fixtures.
   Metrics are recomputed here by hand so the screen is checked against an independent oracle. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const near=(a,b,tol=1e-9)=>assert(Math.abs(a-b)<=tol,a+' != '+b);
const stamp=date=>Date.parse(date+'T00:00:00Z')/1000;
const iso=t=>new Date(t*1000).toISOString().slice(0,10);
const numeric=text=>Number(String(text).replace(/[^0-9.\-]/g,''));
const monthEnd=(y,m)=>Date.UTC(y,m+1,0)/1000;
// Synthetic combo: 30 monthly rows, the last "lag" rows pending (target date still ahead).
const makeCombo=(lag,window,n=30)=>{
  const t_base=[],t_target=[],base=[],actual=[],xgb=[],lstm=[];
  for(let i=0;i<n;i++){
    t_base.push(monthEnd(2023+Math.floor(i/12),i%12));
    t_target.push(monthEnd(2023+Math.floor((i+lag)/12),(i+lag)%12));
    base.push(1300+10*Math.sin(i/2)+i);
    actual.push(i+lag<n?1300+10*Math.sin((i+lag)/2)+i+lag:null);
    xgb.push(base[i]+5*Math.cos(i));lstm.push(base[i]-3*Math.sin(i)+lag);
  }
  const ensemble=xgb.map((v,i)=>(v+lstm[i])/2);
  return {key:'l'+lag+'_w'+window,lag,window,n,n_realized:n-lag,t_base,t_target,base,actual,pred:{xgb,lstm,ensemble},summary:null};
};
const fixture=()=>({active:true,artifact:'fx_lstm_xgb.json',path:'models/fx_lstm_xgb/fx_lstm_xgb.json',schema:'fx_lstm_xgb/1',reason:null,
  generated_at:'2026-10-19T01:02:03Z',runner:{version:'1',seed:20261019,replicate_notebook:false,label_alignment:'realized_by_base_date'},
  model:{name:'lstm_xgb_walk_forward',features:['spot','ns_level'],ns:{lambda:0.7308,maturities_years:[0.25,1,3,10],fill:'ffill'},
    arma:{order:[1,1,1],window_months:36},bop_lag_months:2,lstm:{hidden_size:32,num_layers:1,seq_len:6,epochs:100,lr:0.001},
    xgb:{},ensemble:'mean(xgb, lstm)',benchmark:'random_walk_base_level'},
  data:{feature_start:'2003-12-31',feature_end:'2026-05-29',n_feature_rows:270},
  grid:{lags:[1,3],windows:[24,36]},regime_defaults:{low_below:1100,high_above:1300},
  combos:[makeCombo(1,24),makeCombo(3,24),makeCombo(1,36),makeCombo(3,36)]});
const history={t:[stamp('2023-01-31'),stamp('2026-05-29')],v:[1250,1360]};
const observers=[];
sandbox.ResizeObserver=class{constructor(fn){this.fn=fn;this.disconnectCalls=0;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnectCalls++;}};
shim.UPlotStub.prototype.destroy=function(){this.destroyCalls=(this.destroyCalls||0)+1;};
shim.UPlotStub.prototype.setSize=function(size){this.lastSize=size;this.resizeCalls=(this.resizeCalls||0)+1;};
shim.UPlotStub.prototype.setScale=function(key,bounds){(this.scales??={})[key]={...bounds};};
const STORAGE='iaw-fx-lstm-xgb-v1';
const host=()=>DOC.getElementById('fx-lstm-xgb-content');
const tab=id=>DOC.getElementById('fx-outlook-tab-'+id);
const byId=id=>DOC.getElementById(id);
const live=()=>vm.runInContext('uplots.length',sandbox);
const resetView=()=>vm.runInContext('fxLxView=null',sandbox);
const render=(model)=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.fx={outlook:{active:false,source:'bb:달러원',history},lstm_xgb:model};
  P.RENDERERS.fxoutlook();
  const made=shim.UPlotStub.made.slice(before);
  return {made,main:made.find(c=>c.opts.series[1]?.label==='실제 환율'),err:made.find(c=>c.opts.series[1]?.label==='모형 오차')};
};
const metricRows=()=>Array.from(host().querySelector('.fx-lx-metrics').querySelectorAll('tbody tr'));
const regimeRows=()=>Array.from(host().querySelector('.fx-lx-regimes').querySelectorAll('tbody tr'));
shim.localStorage.removeItem(STORAGE);resetView();

// 1. Inactive or missing payloads explain themselves and never plot.
let r=render({active:false,reason:'fx_lstm_xgb.json 없음 — 테스트 사유'});
assert(host().textContent.includes('fx_lstm_xgb.json 없음 — 테스트 사유'));assert(!r.main&&!r.err);
assert(!DOC.getElementById('fxoutlook-model-b').textContent.includes('등록된 모형이 없습니다'));
assert.equal(live(),1);
render(null);assert(host().textContent.includes('불러오지 못했습니다'));assert.equal(live(),1);
render({active:true,combos:[]});assert(host().textContent.includes('형식을 확인할 수 없어'));

// 2. Default view = lag 3 · window 24 · ensemble · 전체; chart data is the published combo on the target-date axis.
resetView();r=render(fixture());assert(r.main&&r.err);assert.equal(live(),3);
assert.equal(byId('fx-lx-lag').value,'3');assert.equal(byId('fx-lx-window').value,'24');assert.equal(byId('fx-lx-model').value,'ensemble');
assert.equal(byId('fx-lx-range-all').getAttribute('aria-pressed'),'true');
const combo=fixture().combos.find(c=>c.key==='l3_w24');
let u=r.main;
assert.equal(u.data[0].length,30);same(u.data[0],combo.t_target);same(u.data[1],combo.actual);
same(u.data[2],combo.pred.ensemble);same(u.data[3],combo.base);
assert.equal(r.err.data[0].length,27);near(r.err.data[1][0],combo.pred.ensemble[0]-combo.actual[0]);near(r.err.data[2][0],combo.base[0]-combo.actual[0]);
same(u.opts.series[3].dash,[4,4]);assert.equal(u.opts.series[1].spanGaps,false);
assert.equal(u.opts.series[2].value(u,1430.625),'1,431원');assert.equal(u.opts.series[2].value(u,null),'–');
assert(byId('fx-lx-tile-base').textContent.includes(Math.round(combo.base[29]).toLocaleString('en-US')+'원'));
assert(byId('fx-lx-tile-base').textContent.includes(iso(combo.t_base[29])));
['xgb','lstm','ensemble'].forEach(m=>assert(byId('fx-lx-tile-'+m).textContent.includes(Math.round(combo.pred[m][29]).toLocaleString('en-US')+'원')));
assert(byId('fx-lx-tile-ensemble').textContent.includes(iso(combo.t_target[29]))&&byId('fx-lx-tile-ensemble').textContent.includes('3개월 후'));
assert(host().querySelector('.fx-lx-chart-note').textContent.includes('미실현 예측 3행'));
assert(host().querySelector('.fx-lx-method').textContent.includes('공표 지연 2개월'));
assert(host().querySelector('.fx-lx-method').textContent.includes('시드 20261019'));
assert(host().querySelector('.fx-lx-method').textContent.includes('참고 표시 전용'));

// 3. Metrics equal an independent oracle; random walk has no direction call.
const realized=combo.t_base.map((_,i)=>i).filter(i=>combo.actual[i]!==null);
const oracle=(pred,rows=realized)=>{
  const e=rows.map(i=>pred[i]-combo.actual[i]),rw=rows.map(i=>combo.base[i]-combo.actual[i]);
  const mean=xs=>xs.reduce((s,v)=>s+v,0)/xs.length,rmse=Math.sqrt(mean(e.map(v=>v*v))),rmseRw=Math.sqrt(mean(rw.map(v=>v*v)));
  const judged=rows.filter(i=>combo.actual[i]!==combo.base[i]);
  const hits=judged.filter(i=>Math.sign(pred[i]-combo.base[i])===Math.sign(combo.actual[i]-combo.base[i])).length;
  return {n:rows.length,rmse,mae:mean(e.map(Math.abs)),bias:mean(e),u:rmse/rmseRw,hit:hits/judged.length,nDir:judged.length};
};
const metricsFn=vm.runInContext('fxLxMetrics',sandbox),rowsFn=vm.runInContext('fxLxRows',sandbox);
['xgb','lstm','ensemble'].forEach(m=>{const got=metricsFn(rowsFn(combo,m),m),want=oracle(combo.pred[m]);
  ['n','rmse','mae','bias','u','hit','nDir'].forEach(k=>near(got[k],want[k]));});
const rwm=metricsFn(rowsFn(combo,'ensemble'),'rw');near(rwm.u,1);assert.equal(rwm.hit,null);assert.equal(rwm.nDir,0);
assert.equal(metricsFn([],'xgb'),null);
let rows=metricRows();assert.equal(rows.length,4);
const ensRow=rows.find(tr=>tr.children[0].textContent==='앙상블');assert(ensRow.classList.contains('is-selected'));
const want=oracle(combo.pred.ensemble);
assert.equal(ensRow.children[1].textContent,String(want.n));
near(numeric(ensRow.children[2].textContent),want.rmse,0.06);near(numeric(ensRow.children[3].textContent),want.mae,0.06);
near(numeric(ensRow.children[5].textContent),want.u,0.0006);
assert.equal(ensRow.children[6].textContent,Math.round(want.hit*100)+'% ('+want.nDir+')');
assert.equal(rows[3].children[0].textContent,'랜덤워크');assert.equal(rows[3].children[6].textContent,'–');
assert(byId('fx-lx-metrics-sub').textContent.includes('실현 27행'));

// 4. Regime split by base-date level with validated, persisted thresholds.
const regimeOf=(v,lo,hi)=>v<lo?0:v>hi?2:1;
const counts=(lo,hi)=>{const c=[0,0,0];realized.forEach(i=>c[regimeOf(combo.base[i],lo,hi)]++);return c;};
assert.equal(regimeRows().length,3);regimeRows().forEach((tr,i)=>assert.equal(tr.children[1].textContent,String(counts(1100,1300)[i])));
assert(byId('fx-lx-regime-sub').textContent.includes('1,100')&&byId('fx-lx-regime-sub').textContent.includes('1,300'));
byId('fx-lx-regime-low').value='1400';byId('fx-lx-regime-high').value='1300';byId('fx-lx-regime-apply').click();
assert(!byId('fx-lx-regime-status').hidden);assert(byId('fx-lx-regime-sub').textContent.includes('1,100'));
byId('fx-lx-regime-low').value='1310';byId('fx-lx-regime-high').value='1320';
byId('fx-lx-regime-high').dispatchEvent({type:'keydown',key:'Enter',preventDefault(){}});
assert(byId('fx-lx-regime-status').hidden);
regimeRows().forEach((tr,i)=>assert.equal(tr.children[1].textContent,String(counts(1310,1320)[i])));
assert.equal(regimeRows().reduce((s,tr)=>s+Number(tr.children[1].textContent),0),27);
assert.equal(JSON.parse(shim.localStorage.getItem(STORAGE)).low,1310);

// 5. Combo, model and evaluation-period switches re-read the published rows without new charts.
byId('fx-lx-lag').value='1';byId('fx-lx-lag').dispatchEvent({type:'change'});
const c1=fixture().combos.find(c=>c.key==='l1_w24');
same(u.data[0],c1.t_target);same(u.data[2],c1.pred.ensemble);assert.equal(r.err.data[0].length,29);
byId('fx-lx-model').value='xgb';byId('fx-lx-model').dispatchEvent({type:'change'});
same(u.data[2],c1.pred.xgb);assert.equal(host().querySelector('.fx-lx-metrics tr.is-selected').children[0].textContent,'XGBoost');
byId('fx-lx-range-1').click();
assert.equal(byId('fx-lx-range-1').getAttribute('aria-pressed'),'true');assert.equal(byId('fx-lx-range-all').getAttribute('aria-pressed'),'false');
const cut=new Date(c1.t_target[c1.n-2]*1000);cut.setUTCFullYear(cut.getUTCFullYear()-1);
const expected=c1.t_target.filter(t=>t>=cut.getTime()/1000);same(u.data[0],expected);
assert.equal(Number(metricRows()[1].children[1].textContent),expected.length-1);
same(JSON.parse(shim.localStorage.getItem(STORAGE)),{lag:1,window:24,model:'xgb',range:'1',low:1310,high:1320});
assert.equal(live(),3);

// 6. Table and raw CSV come from the same shown rows, newest first, pending actual blank.
const chartCard=host().querySelector('.fx-lx-chart-card');
const button=label=>Array.from(chartCard.querySelectorAll('button')).find(b=>b.textContent===label);
button('표').click();button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).replace(/^﻿/,'').trim().split('\n').map(row=>row.split(','));
const headers=csv.shift();assert.equal(headers.length,10);assert.equal(csv.length,expected.length);
assert.equal(csv[0][1],iso(c1.t_target[c1.n-1]));assert.equal(csv[0][3],'');
near(Number(csv[1][4]),c1.pred.xgb[c1.n-2]);near(Number(csv[1][8]),c1.pred.xgb[c1.n-2]-c1.actual[c1.n-2]);
const tableRows=chartCard.querySelector('.chart-table').querySelectorAll('tbody tr');
assert.equal(tableRows.length,expected.length);assert.equal(tableRows[0].querySelectorAll('td')[3].textContent,'–');

// 7. Hover tooltip reads the plotted series; leaving hides it.
u.cursor={idx:u.data[0].length-2,left:100,top:40};u.opts.hooks.setCursor.forEach(fn=>fn(u));
const tip=host().querySelector('.fx-lx-chart').querySelector('.time-chart-tooltip');
assert(!tip.hidden&&tip.textContent.includes(iso(u.data[0][u.data[0].length-2]))&&tip.textContent.includes('XGBoost 예측')&&tip.textContent.includes('원'));
host().querySelector('.fx-lx-chart').dispatchEvent({type:'mouseleave'});assert(tip.hidden);

// 8. Rerender restores the saved view, cleans up both charts once; a stale saved combo falls back.
const oldMain=r.main,oldErr=r.err;
resetView();r=render(fixture());u=r.main;
assert.equal(oldMain.destroyCalls,1);assert.equal(oldErr.destroyCalls,1);assert.equal(live(),3);
assert.equal(byId('fx-lx-lag').value,'1');assert.equal(byId('fx-lx-model').value,'xgb');assert.equal(byId('fx-lx-range-1').getAttribute('aria-pressed'),'true');
shim.localStorage.setItem(STORAGE,JSON.stringify({lag:99,window:24,model:'lstm',range:'all',low:1310,high:1320}));
resetView();r=render(fixture());u=r.main;assert.equal(byId('fx-lx-lag').value,'3');assert.equal(byId('fx-lx-model').value,'lstm');
const themed=u;vm.runInContext('destroyAllCharts()',sandbox);assert.equal(themed.destroyCalls,1);assert.equal(live(),0);
r=render(fixture());u=r.main;assert.equal(themed.destroyCalls,1);assert.equal(live(),3);

// 9. Showing the B tab resizes existing plots instead of rebuilding; name editing and consensus survive.
const before=shim.UPlotStub.made.length,prevResize=u.resizeCalls||0;
const consensus=DOC.getElementById('fxoutlook-content'),input=consensus.querySelector('input');
input.value='1425';input.dispatchEvent({type:'input'});const saved=shim.localStorage.getItem('iaw-fx-outlook-v2');
tab('modelB').click();assert(!byId('fxoutlook-model-b').hidden);assert(u.resizeCalls>prevResize);
assert.equal(shim.UPlotStub.made.length,before);
tab('modelB').dispatchEvent({type:'keydown',key:'F2',preventDefault(){}});
const nameInput=byId('fx-outlook-name-input');nameInput.value='LSTM 모형';nameInput.dispatchEvent({type:'input'});
byId('fx-outlook-name-editor').dispatchEvent({type:'submit',preventDefault(){}});
assert.equal(byId('fx-outlook-title-modelB').textContent,'LSTM 모형');assert.equal(tab('modelB').textContent,'LSTM 모형');
tab('consensus').click();assert.equal(input.value,'1425');assert.equal(shim.localStorage.getItem('iaw-fx-outlook-v2'),saved);

// 10. Malformed active artifacts never plot a plausible partial backtest.
const malformed=[p=>p.combos[0].actual.pop(),p=>p.combos[0].t_base.reverse(),p=>p.combos[0].pred.lstm[0]=-1,
  p=>p.grid.lags=[1],p=>p.combos[1].actual[29]=1400,p=>p.combos[0].base[0]=NaN,p=>p.combos[0].t_target[0]=p.combos[0].t_base[0],
  p=>delete p.combos[0].pred.xgb,p=>p.combos[0].window=1];
for(const mutate of malformed){const broken=fixture();mutate(broken);const res=render(broken);assert(!res.main&&!res.err);
  assert(host().textContent.includes('확인할 수 없어')||host().textContent.includes('맞지 않아'));assert.equal(live(),1);}
console.log(JSON.stringify({inactiveAndMissingGraceful:true,defaultViewAndChartData:true,metricsMatchOracle:true,
  regimeThresholdsValidatedAndPersisted:true,comboModelRangeSwitches:true,rawCsvAndTable:true,hoverTooltip:true,
  viewPersistenceAndCleanup:true,tabResizeNameEditingConsensus:true,malformedGraceful:true}));
`;
const filename=path.join(repo,'tests/fx_lstm_xgb_ui_runtime.js');
const runtime=new Module(filename,module);runtime.filename=filename;
runtime.paths=Module._nodeModulePaths(path.dirname(filename));
runtime._compile(bootstrap+'\n'+code,filename);
