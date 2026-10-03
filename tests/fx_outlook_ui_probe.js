/* Execute actual FX outlook input/chart callbacks; no production JSON needed. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const near = (a,b,tol=1e-9) => assert(Math.abs(a-b)<tol,a+' != '+b);
const stamp = date => Date.parse(date+'T00:00:00Z')/1000;
const iso = t => new Date(t*1000).toISOString().slice(0,10);
const numeric = text => Number(text.replaceAll(',',''));
vm.runInContext([
  "globalThis.__RealDate=Date;",
  "globalThis.__clock=Date.parse('2026-10-03T01:00:00Z');",
  "Date=class extends __RealDate {",
  "constructor(...args){super(...(args.length?args:[__clock]));}",
  "static now(){return __clock;}",
  "};",
  "globalThis.__fx={today:fxOutlookToday,quarters:fxOutlookQuarters};",
  "fxForecastValues=null;",
  "Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);",
  "fxOutlookYears=3;",
].join('\n'), sandbox);
const FX=sandbox.__fx, storageKey='iaw-fx-outlook-v1';
shim.localStorage.removeItem(storageKey);
const clock=instant=>sandbox.__clock=Date.parse(instant);
const keys=rows=>Array.from(rows,q=>q.key);
const first=(anchor,today)=>FX.quarters(stamp(anchor),stamp(today))[0];
same(keys(FX.quarters(stamp('2024-01-01'),stamp('2026-10-03'))),
  ['2026-Q4','2027-Q1','2027-Q2','2027-Q3','2027-Q4','2028-Q1']);
assert.equal(first('2024-02-29','2024-02-29').t,stamp('2024-03-31'));
assert.equal(first('2023-12-31','2023-12-31').key,'2024-Q1');
assert.equal(first('2027-12-31','2026-10-03').key,'2028-Q1');
clock('2026-03-30T14:59:59Z');
assert.equal(FX.today(),stamp('2026-03-30'));
assert.equal(FX.quarters(stamp('2025-01-01'))[0].key,'2026-Q1');
clock('2026-03-30T15:00:00Z');
assert.equal(FX.today(),stamp('2026-03-31'));
assert.equal(FX.quarters(stamp('2025-01-01'))[0].key,'2026-Q2');
clock('2026-12-30T15:00:00Z');
assert.equal(FX.quarters(stamp('2026-09-30'))[0].key,'2027-Q1');
clock('2026-10-03T01:00:00Z');

const historyDates=['2000-01-03','2010-01-04','2022-09-30','2023-09-30','2024-09-30','2025-09-30','2026-09-29','2026-09-30'];
const historyValues=[1100,1190,1450,1330,1320,1400,1360,1350];
// Explicit monthly dates serve as an oracle for the joined chart, rather than
// borrowing the production month/quarter helpers for expectations.
const rangeDates=['2026-09-30','2026-10-30','2026-11-30','2026-12-30','2027-01-30','2027-02-28',
  '2027-03-30','2027-04-30','2027-05-30','2027-06-30','2027-07-30','2027-08-30','2027-09-30'];
const fixture={active:true,source:'bb:달러원',asof:'2026-09-30',
  history:{t:historyDates.map(stamp),v:historyValues},
  anchor:{t:stamp('2026-09-30'),v:1350},
  sample:{start:'2000-01-03',end:'2026-09-30',n_levels:7000,n_returns:6999,
    vol_pct:9.0,n_excluded_spikes:0,excluded_long_gaps:0},
  range:{t:rangeDates.map(stamp),center:Array(13).fill(1350),
    lower:[1350,1315,1300,1290,1280,1270,1260,1250,1240,1230,1220,1210,1200],
    upper:[1350,1385,1400,1410,1420,1430,1440,1450,1460,1470,1480,1490,1500]}};
shim.UPlotStub.prototype.setScale=function(key,bounds){(this.scales??={})[key]={...bounds};};
shim.UPlotStub.prototype.setSeries=function(index,state){Object.assign(this.series[index],state);};
shim.UPlotStub.prototype.destroy=function(){this.destroyCalls=(this.destroyCalls||0)+1;};
const observers=[];
sandbox.ResizeObserver=class {
  constructor(){this.disconnectCalls=0;observers.push(this);}
  observe(node){this.observed=node;}
  disconnect(){this.disconnectCalls++;}
};
const host=()=>DOC.getElementById('fxoutlook-content');
const render=(payload=fixture)=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.fx=payload===undefined?{}:{outlook:payload};
  P.RENDERERS.fxoutlook();
  const made=shim.UPlotStub.made.slice(before);
  assert.equal(made.length,1,'one FX chart per render');
  const u=made[0];u.series=u.opts.series.map(s=>({...s}));return u;
};
const renderMissing=expectedCharts=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.fx={};P.RENDERERS.fxoutlook();
  const made=shim.UPlotStub.made.slice(before);
  assert.equal(made.length,expectedCharts,'missing-source creates only charts with real plot data');
  if(!made.length)return null;
  const u=made[0];u.series=u.opts.series.map(s=>({...s}));return u;
};
const liveCharts=()=>vm.runInContext('uplots.length',sandbox);
const fields=()=>Array.from(host().querySelectorAll('input'));
const field=key=>DOC.getElementById('fx-forecast-'+key);
const edit=(key,value)=>{const input=field(key);assert(input,key+' input missing');input.value=value;input.dispatchEvent({type:'input'});};
const button=label=>Array.from(host().querySelectorAll('button')).find(n=>n.textContent===label);
const rows=()=>Array.from(host().querySelectorAll('tbody tr')).map(row=>Array.from(row.querySelectorAll('td')).map(cell=>cell.textContent));
const saved=()=>JSON.parse(shim.localStorage.getItem(storageKey)).forecasts;
const valueAt=(u,col,date)=>u.data[col][u.data[0].indexOf(stamp(date))];
const rangeSnapshot=u=>u.data[0].flatMap((t,i)=>u.data[2][i]==null?[]:[[t,...u.data.slice(2,5).map(row=>row[i])]]);
let u=render();
const quarterKeys=['2026-Q4','2027-Q1','2027-Q2','2027-Q3','2027-Q4','2028-Q1'];
const quarterDates=['2026-12-31','2027-03-31','2027-06-30','2027-09-30','2027-12-31','2028-03-31'];
same(fields().map(input=>input.id),quarterKeys.map(key=>'fx-forecast-'+key));
same(fields().map(input=>input.getAttribute('aria-label')),
  ['2026 Q4 원달러 전망','2027 Q1 원달러 전망','2027 Q2 원달러 전망',
    '2027 Q3 원달러 전망','2027 Q4 원달러 전망','2028 Q1 원달러 전망']);
assert.equal(u.opts.legend.show,false);
assert.equal(u.opts.series[5].points.show,true);
assert.equal(u.opts.series[5].spanGaps,true,'manual quarterly line joins sparse knots');
same(u.opts.bands.map(b=>b.series),[[4,3]]);
const box=host().querySelector('.fx-outlook-chart'),legend=box.querySelector('.hedge-chart-legend'),plotHost=box.querySelector('.hedge-plot-host');
assert(box.children.indexOf(legend)<box.children.indexOf(plotHost));
const baseline=rangeSnapshot(u);
assert.equal(baseline.length,13);
same(baseline.map(row=>iso(row[0])),rangeDates);
const atAnchor=u.data[0].indexOf(stamp('2026-09-30'));
u.data.slice(1,5).forEach(row=>assert.equal(row[atAnchor],1350));
assert(u.data[5].every(v=>v==null),'no fabricated manual forecasts');
assert.equal(u.data[0].at(-1),stamp('2027-09-30'));
assert.equal(u.scales.x.max,stamp('2027-09-30'));
const allocationInputs=Object.keys(P.DATA); // Manual FX edits must not initiate network/data reloads.
const fetchCount=FETCH_CALLS.length;
const values=[1430.125,1390,1380,1360,1340,1320];
quarterKeys.forEach((key,i)=>edit(key,String(values[i])));
same(rangeSnapshot(u),baseline);
assert.equal(valueAt(u,5,'2026-09-30'),1350,'manual line begins at last real quote');
quarterDates.forEach((date,i)=>assert.equal(valueAt(u,5,date),values[i]));
assert.equal(u.data[0].at(-1),stamp('2028-03-31'));
assert.equal(u.scales.x.max,stamp('2028-03-31'));
u.data[0].forEach((t,i)=>{if(t>stamp('2027-09-30'))u.data.slice(2,5).forEach(row=>assert.equal(row[i],null));});
same(saved(),Object.fromEntries(quarterKeys.map((key,i)=>[key,values[i]])));
assert.equal(FETCH_CALLS.length,fetchCount);same(Object.keys(P.DATA),allocationInputs);

// Inputs change immediately, invalid drafts retain the last valid plotted value,
// and clearing an input removes its point instead of interpreting it as zero.
const persisted=shim.localStorage.getItem(storageKey);
for(const invalid of ['0','-1','text','Infinity','1e3']){
  edit('2026-Q4',invalid);
  assert.equal(field('2026-Q4').getAttribute('aria-invalid'),'true');
  assert(DOC.getElementById('fx-forecast-2026-Q4-error').textContent);
  assert.equal(valueAt(u,5,'2026-12-31'),values[0]);
  assert.equal(shim.localStorage.getItem(storageKey),persisted);
}
u=render();
assert.equal(field('2026-Q4').value,'1e3');
assert.equal(field('2026-Q4').getAttribute('aria-invalid'),'true');
assert.equal(valueAt(u,5,'2026-12-31'),values[0]);
edit('2026-Q4','');
assert.equal(field('2026-Q4').getAttribute('aria-invalid'),'false');
assert(!('2026-Q4' in saved()));
assert(!u.data[0].includes(stamp('2026-12-31')));
edit('2026-Q4',String(values[0]));

// Draw callbacks use quarter names and the actual entered number. Coordinate
// stubs merely spread six points apart; canvas does not generate expectations.
const labels=[];
u.bbox={left:0,top:0,width:900,height:400};
u.valToPos=(v,scale)=>scale==='x'?60+quarterDates.indexOf(iso(v))*150:220;
u.ctx={save(){},restore(){},measureText(text){return{width:String(text).length*6};},
  fillText(text){labels.push(String(text));}};
u.opts.hooks.draw.forEach(fn=>fn(u));
assert.equal(labels.length,12);
same(labels.filter((_,i)=>i%2===0),['26Q4','27Q1','27Q2','27Q3','27Q4','28Q1']);
labels.filter((_,i)=>i%2===1).forEach((text,i)=>near(numeric(text),values[i],.0051));

// A full-history window compresses six quarters into adjacent right-edge
// pixels. Every point still needs BOTH its quarter and value, within the
// chart, even when preferred placements compete for the same vertical space.
const denseLabels=[];
const assertDenseLabels=(records,expected)=>{
  assert.equal(records.length,12,'dense cluster must label all six quarters and values');
  same(records.filter((_,i)=>i%2===0).map(label=>label.text),['26Q4','27Q1','27Q2','27Q3','27Q4','28Q1']);
  records.filter((_,i)=>i%2===1).forEach((label,i)=>near(numeric(label.text),expected[i],.0051));
  const boxes=records.map(label=>({left:label.x-label.text.length*3,right:label.x+label.text.length*3,
    top:label.y,bottom:label.y+10}));
  boxes.forEach(rect=>assert(rect.left>=0&&rect.right<=280&&rect.top>=0&&rect.bottom<=250));
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const a=boxes[i],b=boxes[j];
    assert(!(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top),'dense label texts overlap');
  }
};
u.bbox={left:0,top:0,width:280,height:250};
u.valToPos=(v,scale)=>scale==='x'?246+quarterDates.indexOf(iso(v)):30;
u.ctx={save(){},restore(){},measureText(text){return{width:String(text).length*6};},
  fillText(text,x,y){denseLabels.push({text:String(text),x,y});}};
u.opts.hooks.draw.forEach(fn=>fn(u));
assertDenseLabels(denseLabels,values);

// Different y positions can fragment the vertical space even when a flat
// cluster fits. This descending path requires repacking earlier placements
// to avoid dropping the sixth label; all input values remain distinct dates.
const variedValues=[1400,1300,1200,1100,1097.7272727273,1097.7272727273],variedLabels=[];
quarterKeys.forEach((key,i)=>edit(key,String(variedValues[i])));
u.valToPos=(v,scale)=>scale==='x'?246+quarterDates.indexOf(iso(v)):54+(1400-v)*.44;
u.ctx={save(){},restore(){},measureText(text){return{width:String(text).length*6};},
  fillText(text,x,y){variedLabels.push({text:String(text),x,y});}};
u.opts.hooks.draw.forEach(fn=>fn(u));
assertDenseLabels(variedLabels,variedValues);
quarterKeys.forEach((key,i)=>edit(key,String(values[i])));
same(rangeSnapshot(u),baseline);

// Display windows trim only history; the full-sample range stays byte-for-byte.
const period=host().querySelector('select'),summary=host().querySelector('.hedge-outlook-summary').textContent;
period.value='1';period.dispatchEvent({type:'change'});
assert.equal(u.data[0][0],stamp('2025-09-30'));
same(rangeSnapshot(u),baseline);
assert.equal(host().querySelector('.hedge-outlook-summary').textContent,summary);
period.value='0';period.dispatchEvent({type:'change'});
assert.equal(u.data[0][0],stamp('2000-01-03'));same(rangeSnapshot(u),baseline);
assert(host().querySelector('.hedge-outlook-method').textContent.includes('7,000'));

// Table, CSV and hover show exactly the chart's joined historical/range/manual
// values, including the farthest quarter outside the statistical 1Y horizon.
button('표').click();button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));
const headers=csv.shift(),table=rows();
assert.equal(headers.length,6);assert.equal(new Set(headers).size,6);
assert(headers.slice(1).every(text=>text.includes('원/달러')));
assert.equal(csv.length,u.data[0].length);assert.equal(table.length,csv.length);
csv.forEach((row,i)=>{
  const j=u.data[0].length-1-i;assert.equal(row[0],iso(u.data[0][j]));assert.equal(table[i][0],row[0]);
  row.slice(1).forEach((text,col)=>{
    const value=u.data[col+1][j];
    if(value==null){assert.equal(text,'');assert.equal(table[i][col+1],'–');}
    else{near(Number(text),value);near(numeric(table[i][col+1]),value,.0051);}
  });
});
edit('2028-Q1','1315');
assert.equal(numeric(rows()[0][5]),1315,'open table updates with inputs');
u.cursor={idx:u.data[0].indexOf(stamp('2028-03-31')),left:100,top:40};
u.opts.hooks.setCursor.forEach(fn=>fn(u));
const tip=host().querySelector('.time-chart-tooltip');
assert(!tip.hidden&&tip.textContent.includes('2028-03-31')&&tip.textContent.includes('2028 Q1 전망')&&tip.textContent.replaceAll(',','').includes('1315.00원'),tip.textContent);
assert(!tip.textContent.includes('상단 1σ'));

// Browsers can deny local storage. The edited point still appears and the
// user receives a visible save status; a later successful edit recovers.
const storageSet=shim.localStorage.setItem;
shim.localStorage.setItem=()=>{throw new Error('storage disabled');};
edit('2028-Q1','1305');
assert.equal(valueAt(u,5,'2028-03-31'),1305);
assert(!host().querySelector('.fx-forecast-status').hidden);
assert(host().querySelector('.fx-forecast-status').textContent.includes('저장할 수 없어'));
shim.localStorage.setItem=storageSet;
edit('2028-Q1','1315');
assert(host().querySelector('.fx-forecast-status').hidden);
assert.equal(saved()['2028-Q1'],1315);

// Simulate a new page session by discarding both the value cache and drafts.
// Quarter-keyed storage keeps values attached to dates after a quarter rolls.
vm.runInContext('fxForecastValues=null;Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);',sandbox);
u=render();assert.equal(field('2026-Q4').value,'1430.125');assert.equal(field('2028-Q1').value,'1315');
clock('2026-12-30T15:00:00Z');u=render();
same(fields().map(input=>input.id),['fx-forecast-2027-Q1','fx-forecast-2027-Q2','fx-forecast-2027-Q3',
  'fx-forecast-2027-Q4','fx-forecast-2028-Q1','fx-forecast-2028-Q2']);
assert.equal(field('2027-Q1').value,'1390');assert.equal(field('2028-Q1').value,'1315');
assert.equal(field('2028-Q2').value,'');assert.equal(valueAt(u,5,'2027-03-31'),1390);
assert(!u.data[0].includes(stamp('2026-12-31')),'past quarter does not shift onto a new quarter');
assert.equal(saved()['2026-Q4'],values[0],'older keyed forecast remains available in storage');
clock('2026-10-03T01:00:00Z');

// Missing analytics, short histories and malformed bands preserve manual
// inputs. A zero-volatility band is valid, as opposed to absent statistics.
u=renderMissing(1);
assert.equal(fields().length,6);assert.equal(field('2027-Q1').value,'1390');
assert(u.data[1].every(v=>v==null));assert(u.data.slice(2,5).flat().every(v=>v==null));
assert.equal(valueAt(u,5,'2027-03-31'),1390);
assert(host().textContent.includes('과거 시계열이 없습니다'));
const short={active:false,reason:'로그수익률 표본 부족',source:'bb:달러원',
  history:{t:[stamp('2026-09-29'),stamp('2026-09-30')],v:[1360,1350]},anchor:fixture.anchor,range:null};
u=render(short);assert.equal(valueAt(u,5,'2026-09-30'),1350);
assert(u.data.slice(2,5).flat().every(v=>v==null));assert(host().textContent.includes('표본 부족'));
for(const malformed of ['missing','mismatched-anchor','bad-origin']){
  const broken=JSON.parse(JSON.stringify(fixture));
  if(malformed==='missing')broken.range.lower.pop();
  if(malformed==='mismatched-anchor')broken.anchor.v=1349;
  if(malformed==='bad-origin')broken.range.upper[0]=1351;
  u=render(broken);assert(u.data.slice(2,5).flat().every(v=>v==null));
  assert.equal(valueAt(u,5,'2027-03-31'),1390);
}
const zero=JSON.parse(JSON.stringify(fixture));zero.sample.vol_pct=0;
['center','lower','upper'].forEach(key=>zero.range[key]=Array(13).fill(1350));
u=render(zero);assert.equal(rangeSnapshot(u).length,13);
assert(rangeSnapshot(u).every(row=>row.slice(1).every(v=>v===1350)));
assert(Number.isFinite(u.scales.y.min)&&Number.isFinite(u.scales.y.max)&&u.scales.y.min<u.scales.y.max);
assert(host().querySelector('.hedge-outlook-summary').textContent.includes('σ 0.00%'));
shim.localStorage.removeItem(storageKey);
vm.runInContext('fxForecastValues=null;Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);',sandbox);
u=render(zero);
assert(u.data[5].every(v=>v==null));
assert(u.scales.y.min<1350&&u.scales.y.max>1350,'constant history/band keeps a finite usable y axis');

// With neither prices nor saved/manual points, inputs remain usable without
// registering an empty chart. The first valid input must create a NEW chart,
// and subsequent edits update that chart rather than an old destroyed object.
const zeroChart=u,zeroObserver=observers.at(-1);
assert.equal(liveCharts(),1);
assert.equal(renderMissing(0),null);
assert.equal(zeroChart.destroyCalls,1);assert.equal(zeroObserver.disconnectCalls,1);
assert.equal(liveCharts(),0);
assert(!host().contains(zeroChart.root));assert.equal(fields().length,6);
assert(host().textContent.includes('분기 전망은 입력할 수 있습니다'));
const emptyChartCount=shim.UPlotStub.made.length;
edit('2026-Q4','0');assert.equal(shim.UPlotStub.made.length,emptyChartCount);
assert.equal(liveCharts(),0);
edit('2026-Q4','1410');
assert.equal(shim.UPlotStub.made.length,emptyChartCount+1);
u=shim.UPlotStub.made[emptyChartCount];u.series=u.opts.series.map(s=>({...s}));
assert(u!==zeroChart&&host().contains(u.root));assert.equal(liveCharts(),1);
same(u.data[0],[stamp('2026-12-31')]);same(u.data[5],[1410]);
assert(u.data.slice(1,5).flat().every(v=>v==null),'manual-only chart does not invent market data');
edit('2027-Q1','1390');assert.equal(shim.UPlotStub.made.length,emptyChartCount+1);
assert.equal(valueAt(u,5,'2027-03-31'),1390);
edit('2026-Q4','');edit('2027-Q1','');assert.equal(u.data[0].length,0);
assert.equal(renderMissing(0),null);assert.equal(liveCharts(),0);

// Section/theme rerenders replace their previous chart and disconnect its
// resize observer, leaving one live instance and preserving input/range data.
u=render();edit('2027-Q1','1395');
const rerenderData=JSON.stringify(u.data);
for(const theme of ['light','dark','light','dark']){
  const previous=u,observer=observers.at(-1),before=shim.UPlotStub.made.length;
  DOC.documentElement.setAttribute('data-theme',theme);
  u=render();
  assert.equal(shim.UPlotStub.made.length,before+1);
  assert.equal(previous.destroyCalls,1);assert.equal(observer.disconnectCalls,1);
  assert(!host().contains(previous.root)&&host().contains(u.root));
  assert.equal(liveCharts(),1,'rerenders do not accumulate tracked charts');
  assert.equal(observers.filter(ro=>ro.disconnectCalls===0).length,1,'one live resize observer');
  assert.equal(JSON.stringify(u.data),rerenderData);assert.equal(field('2027-Q1').value,'1395');
}

// Real app routing recognizes the module, shows its section, and suppresses
// the global period controls because this chart owns its display window.
const link=P.el('a',{href:'#fxoutlook'},'환율전망');nav.append(link);
shim.location.hash='#fxoutlook';P.routeView();
assert.equal(secNodes.fxoutlook.hidden,false);assert.equal(secNodes.hedge.hidden,true);
assert.equal(link.getAttribute('aria-current'),'page');assert.equal(filterRow.hidden,true);
assert.equal(P.SECTION_LABELS.fxoutlook,'환율전망');
console.log(JSON.stringify({kstQuarterBoundaries:true,leapAndStaleAnchor:true,sixAccessibleInputs:true,
  immediateForecastPoints:true,invalidDraftPreservesValue:true,emptyRemovesPoint:true,
  anchoredIndependentOneYearBand:true,allSixQuarterHorizon:true,quarterAndValueCanvasLabels:true,
  denseClusterAllLabelsAndNoOverlap:true,variedDensePathAllLabelsAndNoOverlap:true,
  fullSampleIndependentDisplayWindow:true,plotTableCsvAgreement:true,forecastHover:true,
  keyedStorageReloadAndRollover:true,missingShortMalformedFallback:true,zeroVolatility:true,
  storageFailureRecovery:true,lazyEmptyAndFirstInputChart:true,rerenderAndThemeLifecycle:true,
  sectionRouting:true}));
`;
const filename=path.join(repo,'tests/fx_outlook_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
