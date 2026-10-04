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
  "globalThis.__fx={today:fxOutlookToday,quarters:fxOutlookQuarters,moments:fxOutlookMoments,state:fxOutlookState};",
  "fxForecastState=null;",
  "Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);",
  "fxOutlookYears=3;",
].join('\n'), sandbox);
const FX=sandbox.__fx, storageKey='iaw-fx-outlook-v2', legacyKey='iaw-fx-outlook-v1';
shim.localStorage.removeItem(storageKey);
shim.localStorage.removeItem(legacyKey);
const resetState=()=>vm.runInContext("fxForecastState=null;Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);",sandbox);
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

// Population dispersion is checked against fixed answers and the independent
// pairwise-distance identity, not another copy of the production variance loop.
same(FX.moments([]),{n:0,mean:null,sigma:null});
same(FX.moments([null,null]),{n:0,mean:null,sigma:null});
same(FX.moments([1300]),{n:1,mean:1300,sigma:null});
same(FX.moments([1300,1300]),{n:2,mean:1300,sigma:0});
const pair=FX.moments([1200,1400]);assert.equal(pair.n,2);near(pair.mean,1300);near(pair.sigma,100);
const tri=FX.moments([1100,null,1300,1500]);
assert.equal(tri.n,3);assert.equal(tri.mean,1300);near(tri.sigma,Math.sqrt(80000/3));
const pairwiseSigma=xs=>Math.sqrt(xs.reduce((sum,x,i)=>sum+xs.slice(i+1).reduce((a,y)=>a+(x-y)**2,0),0))/xs.length;
const irregular=[1234.125,1499.875,1601.75,1390.625];
near(FX.moments(irregular).sigma,pairwiseSigma(irregular));
near(FX.moments(irregular.map(x=>x+100)).sigma,pairwiseSigma(irregular));
near(FX.moments(irregular.map(x=>x*2)).sigma,2*pairwiseSigma(irregular));
assert.equal(FX.quarters(stamp('2026-09-30'),stamp('2026-10-03'),1).length,1);
const twelve=FX.quarters(stamp('2026-09-30'),stamp('2026-10-03'),12);
assert.equal(twelve.length,12);assert.equal(twelve.at(-1).key,'2029-Q3');

// Old keyed inputs become one contributor without manufacturing dispersion.
shim.localStorage.setItem(legacyKey,JSON.stringify({forecasts:{'2026-Q4':1430.125,'2027-Q1':1390,'bad':1500,'2027-Q2':-10}}));
resetState();
assert.equal(FX.state().quarterCount,6);
same(FX.state().consensus,{'2026-Q4':[1430.125],'2027-Q1':[1390]});
const preferred={quarterCount:3,consensus:{'2026-Q4':[1300,1500]}};
shim.localStorage.setItem(storageKey,JSON.stringify(preferred));resetState();
same(FX.state(),preferred);
shim.localStorage.removeItem(storageKey);shim.localStorage.removeItem(legacyKey);resetState();

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
const field=(key,no=1)=>DOC.getElementById('fx-forecast-'+key+(no===1?'':'-'+no));
const edit=(key,value,no=1)=>{const input=field(key,no);assert(input,key+' input missing');input.value=value;input.dispatchEvent({type:'input'});};
const button=label=>Array.from(host().querySelectorAll('button')).find(n=>n.textContent===label);
const rows=()=>Array.from(host().querySelectorAll('tbody tr')).map(row=>Array.from(row.querySelectorAll('td')).map(cell=>cell.textContent));
const savedState=()=>JSON.parse(shim.localStorage.getItem(storageKey));
const saved=()=>savedState().consensus;
const details=key=>DOC.getElementById('fx-quarter-'+key);
const add=key=>DOC.getElementById('fx-consensus-add-'+key).click();
const remove=(key,no)=>DOC.getElementById('fx-consensus-remove-'+key+'-'+no).click();
const latest=()=>{const chart=shim.UPlotStub.made.at(-1);chart.series=chart.opts.series.map(s=>({...s}));return chart;};
const count=n=>{const select=DOC.getElementById('fx-forecast-count');select.value=String(n);select.dispatchEvent({type:'change'});return latest();};
const valueAt=(u,col,date)=>u.data[col][u.data[0].indexOf(stamp(date))];
const rangeSnapshot=u=>u.data[0].flatMap((t,i)=>u.data[2][i]==null?[]:[[t,...u.data.slice(2,5).map(row=>row[i])]]);
let u=render();
const quarterKeys=['2026-Q4','2027-Q1','2027-Q2','2027-Q3','2027-Q4','2028-Q1'];
const quarterDates=['2026-12-31','2027-03-31','2027-06-30','2027-09-30','2027-12-31','2028-03-31'];
same(fields().map(input=>input.id),quarterKeys.map(key=>'fx-forecast-'+key));
fields().forEach((input,i)=>{assert(input.getAttribute('aria-label').includes(quarterKeys[i].replace('-',' ')));assert(input.getAttribute('aria-label').includes('1'));});
quarterKeys.forEach(key=>{assert.equal(details(key).tagName,'DETAILS');assert(details(key).querySelector('summary'));assert(details(key).querySelector('.fx-consensus-mean'));assert(details(key).querySelector('.fx-consensus-spread'));});
const countSelect=DOC.getElementById('fx-forecast-count');
assert.equal(countSelect.value,'6');
same(Array.from(countSelect.querySelectorAll('option'),o=>Number(o.value)),Array.from({length:12},(_,i)=>i+1));
assert.equal(u.opts.legend.show,false);
assert.equal(u.opts.series[5].points.show,true);
assert.equal(u.opts.series[5].spanGaps,true,'manual quarterly line joins sparse knots');
same(u.opts.bands.map(b=>b.series),[[4,3],[7,6]]);
assert(u.data[6].every(v=>v==null)&&u.data[7].every(v=>v==null),'red band needs at least two estimates');
assert.notEqual(u.opts.bands[0].fill,u.opts.bands[1].fill);
const rgb=hex=>hex.match(/[\da-f]{2}/gi).slice(0,3).map(part=>parseInt(part,16));
const blue=rgb(u.opts.series[3].stroke),red=rgb(u.opts.series[6].stroke);
assert(blue[2]>blue[0]&&red[0]>red[2],'historical and consensus bands retain blue/red families');
u.opts.series.slice(1).forEach(series=>assert.equal(series.value(u,1430.625),'1,431원'));
assert.equal(u.opts.series[6].spanGaps,false);assert.equal(u.opts.series[7].spanGaps,false);
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
same(saved(),Object.fromEntries(quarterKeys.map((key,i)=>[key,[values[i]]])));
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
assert(!saved()['2026-Q4']||saved()['2026-Q4'].every(v=>v==null));
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
labels.filter((_,i)=>i%2===1).forEach((text,i)=>assert.equal(numeric(text),Math.round(values[i])));

// A full-history window compresses six quarters into adjacent right-edge
// pixels. Every point still needs BOTH its quarter and value, within the
// chart, even when preferred placements compete for the same vertical space.
const denseLabels=[];
const assertDenseLabels=(records,expected,shortLabels=['26Q4','27Q1','27Q2','27Q3','27Q4','28Q1'])=>{
  assert.equal(records.length,expected.length*2,'dense cluster must label all quarters and values');
  same(records.filter((_,i)=>i%2===0).map(label=>label.text),shortLabels);
  records.filter((_,i)=>i%2===1).forEach((label,i)=>assert.equal(numeric(label.text),Math.round(expected[i])));
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
assert.equal(headers.length,8);assert.equal(new Set(headers).size,8);
assert(headers.slice(1).every(text=>text.includes('원/달러')));
assert.equal(csv.length,u.data[0].length);assert.equal(table.length,csv.length);
csv.forEach((row,i)=>{
  const j=u.data[0].length-1-i;assert.equal(row[0],iso(u.data[0][j]));assert.equal(table[i][0],row[0]);
  row.slice(1).forEach((text,col)=>{
    const value=u.data[col+1][j];
    if(value==null){assert.equal(text,'');assert.equal(table[i][col+1],'–');}
    else{near(Number(text),value);assert.equal(numeric(table[i][col+1]),Math.round(value));}
  });
});
edit('2028-Q1','1315');
assert.equal(numeric(rows()[0][5]),1315,'open table updates with inputs');
u.cursor={idx:u.data[0].indexOf(stamp('2028-03-31')),left:100,top:40};
u.opts.hooks.setCursor.forEach(fn=>fn(u));
const tip=host().querySelector('.time-chart-tooltip');
assert(!tip.hidden&&tip.textContent.includes('2028-03-31')&&tip.textContent.includes('2028 Q1')&&tip.textContent.replaceAll(',','').includes('1315원'),tip.textContent);
assert(!tip.textContent.includes('상단 1σ'));

// Each collapsible quarter owns sequential numbered contributors. Blank
// additions do not create forecasts; deleting an entry reindexes the survivors.
const beforeConsensus=shim.localStorage.getItem(storageKey);
assert.equal(details('2026-Q4').open,false);details('2026-Q4').open=true;
add('2026-Q4');u=latest();assert.equal(details('2026-Q4').open,true);
assert(field('2026-Q4',2));assert.equal(field('2026-Q4',2).value,'');
assert.equal(valueAt(u,5,'2026-12-31'),1430.125);
assert(u.data[6].every(v=>v==null));
edit('2026-Q4','1469.875',2);
assert.equal(valueAt(u,5,'2026-12-31'),1450);
near(valueAt(u,6,'2026-12-31'),1430.125);near(valueAt(u,7,'2026-12-31'),1469.875);
assert.equal(numeric(details('2026-Q4').querySelector('.fx-consensus-mean').textContent.replace(/[^\d,.-]/g,'')),1450);
assert(details('2026-Q4').querySelector('.fx-consensus-spread').textContent.includes('20'));
add('2026-Q4');u=latest();edit('2026-Q4','1500',3);
const contributors=[1430.125,1469.875,1500],mean=contributors.reduce((a,b)=>a+b,0)/3;
near(valueAt(u,5,'2026-12-31'),mean);
near(valueAt(u,7,'2026-12-31')-mean,pairwiseSigma(contributors));
const validConsensus=JSON.stringify(u.data);
edit('2026-Q4','invalid',2);
assert.equal(field('2026-Q4',2).getAttribute('aria-invalid'),'true');
assert.equal(JSON.stringify(u.data),validConsensus);
remove('2026-Q4',2);u=latest();
assert.equal(field('2026-Q4',2).value,'1500');assert.equal(field('2026-Q4',3),null);
same(saved()['2026-Q4'],[1430.125,1500]);
near(valueAt(u,5,'2026-12-31'),1465.0625);near(valueAt(u,7,'2026-12-31'),1500);
remove('2026-Q4',1);u=latest();
assert.equal(field('2026-Q4').value,'1500');assert.equal(field('2026-Q4',2),null);
assert(u.data[6].every(v=>v==null));
remove('2026-Q4',1);u=latest();
assert.equal(field('2026-Q4').value,'');
assert(!saved()['2026-Q4']||saved()['2026-Q4'].every(v=>v==null));

// A narrower horizon hides later inputs and points while preserving their
// date-keyed contributors. The selected horizon survives a new page session.
u=count(12);assert.equal(host().querySelectorAll('.fx-forecast-grid details').length,12);
assert(field('2029-Q3'));edit('2029-Q3','1550');
u=count(1);assert.equal(savedState().quarterCount,1);
assert.equal(field('2029-Q3'),null);same(saved()['2029-Q3'],[1550]);
assert(!u.data[0].includes(stamp('2029-09-30')));
u=count(12);assert.equal(field('2029-Q3').value,'1550');
assert.equal(valueAt(u,5,'2029-09-30'),1550);
resetState();u=render();assert.equal(DOC.getElementById('fx-forecast-count').value,'12');
assert.equal(field('2029-Q3').value,'1550');
const twelveKeys=['2026-Q4','2027-Q1','2027-Q2','2027-Q3','2027-Q4','2028-Q1',
  '2028-Q2','2028-Q3','2028-Q4','2029-Q1','2029-Q2','2029-Q3'];
const twelveDates=['2026-12-31','2027-03-31','2027-06-30','2027-09-30','2027-12-31','2028-03-31',
  '2028-06-30','2028-09-30','2028-12-31','2029-03-31','2029-06-30','2029-09-30'];
const twelveValues=twelveKeys.map((key,i)=>1440+i*10),twelveLabels=[];
twelveKeys.forEach((key,i)=>edit(key,String(twelveValues[i])));
u.bbox={left:0,top:0,width:280,height:250};
u.valToPos=(v,scale)=>scale==='x'?246+twelveDates.indexOf(iso(v)):30;
u.ctx={save(){},restore(){},measureText(text){return{width:String(text).length*6};},
  fillText(text,x,y){twelveLabels.push({text:String(text),x,y});}};
u.opts.hooks.draw.forEach(fn=>fn(u));
assertDenseLabels(twelveLabels,twelveValues,['26Q4','27Q1','27Q2','27Q3','27Q4','28Q1',
  '28Q2','28Q3','28Q4','29Q1','29Q2','29Q3']);

// Red bounds interpolate only between adjacent quarters with at least two
// estimates, with the observed quote as a zero-width initial knot. A singleton
// or absent quarter breaks the red region even if a later quarter has samples.
shim.localStorage.setItem(storageKey,JSON.stringify({quarterCount:6,consensus:{
  '2026-Q4':[1300,1500],'2027-Q1':[1400,1600],'2027-Q2':[1500],
  '2027-Q3':[1300,1700],'2028-Q1':[1400,1800]}}));resetState();u=render();
same(rangeSnapshot(u),baseline);
near(valueAt(u,6,'2026-09-30'),1350);near(valueAt(u,7,'2026-09-30'),1350);
near(valueAt(u,6,'2026-12-31'),1300);near(valueAt(u,7,'2026-12-31'),1500);
near(valueAt(u,6,'2027-03-31'),1400);near(valueAt(u,7,'2027-03-31'),1600);
near(valueAt(u,6,'2026-11-30'),1350+(1300-1350)*61/92);
near(valueAt(u,7,'2026-11-30'),1350+(1500-1350)*61/92);
near(valueAt(u,6,'2027-01-30'),1300+(1400-1300)*30/90);
near(valueAt(u,7,'2027-01-30'),1500+(1600-1500)*30/90);
for(const date of ['2027-04-30','2027-06-30','2027-07-30','2027-12-31']){
  assert(u.data[0].includes(stamp(date)),'gap needs an explicit null boundary: '+date);
  assert.equal(valueAt(u,6,date),null);assert.equal(valueAt(u,7,date),null);
}
near(valueAt(u,6,'2027-09-30'),1300);near(valueAt(u,7,'2027-09-30'),1700);
near(valueAt(u,6,'2028-03-31'),1400);near(valueAt(u,7,'2028-03-31'),1800);
assert.equal(u.opts.series[6].spanGaps,false);assert.equal(u.opts.series[7].spanGaps,false);
button('표').click();button('CSV').click();
const spreadCsv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));
const spreadRow=spreadCsv.find(row=>row[0]==='2026-12-31');
near(Number(spreadRow[5]),1400);near(Number(spreadRow[6]),1300);near(Number(spreadRow[7]),1500);
const spreadTableRow=rows().find(row=>row[0]==='2026-12-31');
same(spreadTableRow.slice(5).map(numeric),[1400,1300,1500]);
u.cursor={idx:u.data[0].indexOf(stamp('2026-12-31')),left:100,top:40};
u.opts.hooks.setCursor.forEach(fn=>fn(u));
const spreadTip=host().querySelector('.time-chart-tooltip').textContent;
assert(spreadTip.includes('평균 (2개)')&&spreadTip.includes('컨센서스 하단 1σ')&&spreadTip.includes('컨센서스 상단 1σ'));
assert(!spreadTip.includes('.00원'));
// An isolated populated quarter cannot form a filled area. It still needs a
// visible red whisker at its actual bounds without bridging earlier missing data.
shim.localStorage.setItem(storageKey,JSON.stringify({quarterCount:6,consensus:{
  '2026-Q4':[1400],'2027-Q3':[1300,1700]}}));resetState();u=render();
assert.equal(valueAt(u,6,'2026-09-30'),null);
assert.equal(valueAt(u,6,'2027-06-30'),null);
const strokes=[],segments=[];let pen=null;
u.bbox={left:0,top:0,width:900,height:400};
u.valToPos=(v,scale)=>scale==='x'?(iso(v)==='2027-09-30'?500:200):500-v/5;
u.ctx={save(){},restore(){},setLineDash(){},beginPath(){segments.length=0;},
  moveTo(x,y){pen=[x,y];},lineTo(x,y){segments.push([pen,[x,y]]);pen=[x,y];},
  stroke(){strokes.push(segments.map(segment=>segment.map(p=>p.slice())));},
  measureText(text){return{width:String(text).length*6};},fillText(){}};
u.opts.hooks.draw.forEach(fn=>fn(u));
assert.equal(strokes.length,1);assert.equal(strokes[0].length,3);
const stem=strokes[0][0];near(stem[0][0],500);near(stem[1][0],500);
near(stem[0][1],240);near(stem[1][1],160);
strokes[0].slice(1).forEach((cap,i)=>{near(cap[0][1],i===0?240:160);near(cap[1][1],cap[0][1]);assert(cap[0][0]<500&&cap[1][0]>500);});
u.series[6].show=false;strokes.length=0;u.opts.hooks.draw.forEach(fn=>fn(u));assert.equal(strokes.length,0);
shim.localStorage.setItem(storageKey,beforeConsensus);resetState();u=render();
same(rangeSnapshot(u),baseline);
assert(u.data[6].every(v=>v==null));

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
same(saved()['2028-Q1'],[1315]);

// Simulate a new page session by discarding both the value cache and drafts.
// Quarter-keyed storage keeps values attached to dates after a quarter rolls.
vm.runInContext('fxForecastState=null;Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);',sandbox);
u=render();assert.equal(field('2026-Q4').value,'1430.125');assert.equal(field('2028-Q1').value,'1315');
clock('2026-12-30T15:00:00Z');u=render();
same(fields().map(input=>input.id),['fx-forecast-2027-Q1','fx-forecast-2027-Q2','fx-forecast-2027-Q3',
  'fx-forecast-2027-Q4','fx-forecast-2028-Q1','fx-forecast-2028-Q2']);
assert.equal(field('2027-Q1').value,'1390');assert.equal(field('2028-Q1').value,'1315');
assert.equal(field('2028-Q2').value,'');assert.equal(valueAt(u,5,'2027-03-31'),1390);
assert(!u.data[0].includes(stamp('2026-12-31')),'past quarter does not shift onto a new quarter');
assert.equal(saved()['2026-Q4'][0],values[0],'older keyed forecast remains available in storage');
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
vm.runInContext('fxForecastState=null;Object.keys(fxForecastDrafts).forEach(key=>delete fxForecastDrafts[key]);',sandbox);
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
  independentPopulationDispersion:true,legacyMigrationAndV2Precedence:true,numberedContributorAddRemove:true,
  selectablePersistedQuarterCount:true,twelveQuarterDenseLabels:true,isolatedConsensusWhisker:true,consensusBandInterpolationAndGapSeparation:true,integerDisplayRawCsvPrecision:true,
  denseClusterAllLabelsAndNoOverlap:true,variedDensePathAllLabelsAndNoOverlap:true,
  fullSampleIndependentDisplayWindow:true,plotTableCsvAgreement:true,forecastHover:true,
  keyedStorageReloadAndRollover:true,missingShortMalformedFallback:true,zeroVolatility:true,
  storageFailureRecovery:true,lazyEmptyAndFirstInputChart:true,rerenderAndThemeLifecycle:true,
  sectionRouting:true}));
`;
const filename=path.join(repo,'tests/fx_outlook_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
