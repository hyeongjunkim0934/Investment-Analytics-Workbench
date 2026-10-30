/* Exercise actual model-B events and exported values against scalar identities. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const near = (a,b,tol=1e-9) => assert(Math.abs(a-b)<tol,a+' != '+b);
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const clone = v => JSON.parse(JSON.stringify(v));
const outlook = {
  active:true, asof:'2026-10-28', yield_asof:'2026-10-28',
  yield_pct:4.123456789, duration_years:8.23456789,
  cost:{mean_pct:-0.73123456789,source:'HP',sign:'positive_received',unit:'pct_pa',
    asof:'2026-10-28',dates:{'3M':'2026-10-28','6M':'2026-10-28','12M':'2026-10-28'}},
  sample:{n_months:120,start:'2016-10-31',end:'2026-09-30'},
  risk:{labels:['bond','fx'],cov_unit:'decimal_return_squared',
    cov_annual:[[.0025,-.0015],[-.0015,.01]]},
  sources:{bond:'info:UST10y',fx:'bb:달러원',cost:{'3M':'info:USDKRW_HP_3M'}},
};
const analytics = Object.fromEntries(['UST','JPY','AUD','GER'].map((market,index) => [market,
  {currency:['USD','JPY','AUD','EUR'][index],outlook:clone(outlook)}]));
analytics.JPY.outlook.yield_pct=1.987654321;
analytics.JPY.outlook.cost.mean_pct=.6789012345;
// Independent evaluation: no optimizer or renderer helper supplies expected values.
const scalar = (o,settings,h) => {
  const C=o.risk.cov_annual,w=1-h;
  const variance=C[0][0]+2*w*C[0][1]+w*w*C[1][1];
  const mean=o.yield_pct+w*settings.fxPct+h*o.cost.mean_pct;
  return {hedgePct:h*100,meanPct:mean,volPct:Math.sqrt(variance)*100,
    carryPct:h*o.cost.mean_pct,cePct:mean-50*settings.riskAversion*variance};
};
const destroyed=new Set();
const sizes=new Map();
shim.UPlotStub.prototype.destroy=function(){destroyed.add(this);};
shim.UPlotStub.prototype.setSize=function(size){sizes.set(this,{...size});};
shim.UPlotStub.prototype.setScale=function(k,v){(this.scales??={})[k]={...v};};
const panel=DOC.getElementById('hedge-model-b');
const liveCharts=()=>shim.UPlotStub.made.filter(u=>panel.contains(u.root)&&!destroyed.has(u));
const networkBefore=FETCH_CALLS.length;
const payload={matrix:[],bond_analytics:analytics};
const input=key=>DOC.getElementById('hedge-b-'+key);
const metric=key=>DOC.getElementById('hedge-b-current-'+key).textContent;
const card=index=>DOC.getElementById('hedge-b-scenario-'+index);
const vals=index=>card(index).querySelectorAll('.hedge-b-metric b').map(node=>node.textContent);
const storage=()=>JSON.parse(shim.localStorage.getItem('iaw-hedge-model-b-v1'));
const apply=settings=>{
  Object.entries(settings).forEach(([key,value])=>{input(key).value=value;});
  input('apply').click();
};
const select=market=>DOC.getElementById('hedge-b-market-'+market).click();
const readCsv=host=>{
  const button=host.querySelectorAll('button').find(node=>node.textContent==='CSV');
  assert(button,'CSV action is available');button.click();
  return CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));
};
const table=host=>{
  const button=host.querySelectorAll('button').find(node=>node.textContent==='표');
  assert(button,'table action is available');button.click();
  return host.querySelectorAll('tbody tr');
};
const chartFor=key=>liveCharts().find(u=>DOC.getElementById('hedge-b-chart-'+key).contains(u.root));
P.DATA.hedge=payload;P.renderHedge();
assert.equal(panel.querySelectorAll('.hedge-b-market').length,4);
assert.equal(panel.querySelectorAll('.hedge-b-scenario').length,5);
assert.equal(liveCharts().length,2);
Object.entries(P.hedgeModelBDefaults).forEach(([key,value])=>near(Number(input(key).value),value));
assert.equal(DOC.getElementById('hedge-b-market-UST').getAttribute('aria-pressed'),'true');
assert.equal(metric('ratio'),'50.00');
near(Number(metric('return')),Number(scalar(outlook,P.hedgeModelBDefaults,.5).meanPct.toFixed(2)));
assert.equal(vals(3)[0],'85.00');
near(Number(vals(4)[0]),Number((85+outlook.cost.mean_pct/(5*.01)).toFixed(2)));
// Current input is a draft until Apply, and a valid fractional input keeps raw precision.
input('currentHedgePct').value='37.125';
assert.equal(metric('ratio'),'50.00');
const settings={riskAversion:7.25,fxPct:1.23456789,currentHedgePct:37.125,minHedgePct:20,maxHedgePct:80};
apply(settings);
assert.equal(metric('ratio'),'37.13');
const expected=scalar(outlook,settings,.37125);
near(Number(metric('return')),Number(expected.meanPct.toFixed(2)));
near(Number(metric('vol')),Number(expected.volPct.toFixed(2)));
assert.equal(vals(3)[0],'80.00');
assert(card(3).textContent.includes('제약 경계'));
assert(card(0).textContent.includes('제약 밖'));assert(card(2).textContent.includes('제약 밖'));
same(storage().markets.UST,settings);
// Invalid edits preserve the prior applied cards, storage and live chart instances.
const preserved=panel.querySelector('.hedge-b-current').textContent;
const appliedCharts=liveCharts().slice(), appliedStorage=shim.localStorage.getItem('iaw-hedge-model-b-v1');
for(const invalid of [
  {...settings,fxPct:''}, {...settings,fxPct:'   '}, {...settings,riskAversion:0},
  {...settings,minHedgePct:90,maxHedgePct:10}, {...settings,fxPct:'Infinity'},
]) {
  apply(invalid);assert.equal(input('status').hidden,false);
  assert.equal(panel.querySelector('.hedge-b-current').textContent,preserved);
  assert.equal(shim.localStorage.getItem('iaw-hedge-model-b-v1'),appliedStorage);
  assert(liveCharts().every((u,i)=>u===appliedCharts[i]));
}
apply(settings);
assert.equal(input('status').hidden,true);
// Each market retains its own applied settings; switching discards invalid drafts.
select('JPY');assert.equal(input('fxPct').value,'0');
const jpySettings={riskAversion:3.5,fxPct:-.75,currentHedgePct:63.5,minHedgePct:10,maxHedgePct:90};
apply(jpySettings);same(storage().markets.JPY,jpySettings);
select('UST');Object.entries(settings).forEach(([k,v])=>near(Number(input(k).value),v));
same(storage().markets.JPY,jpySettings);
// Simulate a new renderer session to verify persisted selection and settings are read.
vm.runInContext('hedgeModelBState = null;',sandbox);
P.renderHedgeModelB(payload);
Object.entries(settings).forEach(([k,v])=>near(Number(input(k).value),v));
assert.equal(DOC.getElementById('hedge-b-market-UST').getAttribute('aria-pressed'),'true');

// A single model drives cards, formatted tables, raw CSV and chart arrays.
const comparison=DOC.getElementById('hedge-b-comparison');
const rows=table(comparison), csv=readCsv(comparison);
assert.equal(rows.length,6);assert.equal(csv.length,7);
assert(csv[0][2].includes('연 %'));assert(csv[0][6].includes('%p'));
csv.slice(1).forEach((row,index)=>{
  const h=Number(row[1])/100, e=scalar(outlook,settings,h);
  near(Number(row[2]),e.meanPct);near(Number(row[3]),e.volPct);
  near(Number(row[4]),e.carryPct);near(Number(row[5]),e.cePct);
  const cells=rows[index].querySelectorAll('td');
  [1,2,3,4,5,6].forEach(col=>near(Number(cells[col].textContent),Number(Number(row[col]).toFixed(2))));
  assert.equal(row[csv[0].indexOf('시장')],'UST');
  near(Number(row[csv[0].indexOf('예상 FX (연 %)')]),settings.fxPct);
  assert.equal(row[csv[0].indexOf('추정기준일')],outlook.asof);
  assert.equal(row[csv[0].indexOf('월간 표본')],'120');
});
near(Number(csv[1][1]),37.125);
assert.notEqual(Number(csv[1][2]),Number(Number(csv[1][2]).toFixed(2)));
for(const key of ['volPct','meanPct']) {
  const u=chartFor(key), grid=readCsv(DOC.getElementById('hedge-b-chart-'+key));
  assert.equal(u.data[0].length,101);assert.equal(grid.length,102);
  assert.equal(u.opts.scales.x.time,false);assert.equal(u.opts.series[1].points.show,false);
  for(let i=0;i<=100;i++) {
    near(u.data[0][i],i);near(u.data[1][i],scalar(outlook,settings,i/100)[key]);
    near(Number(grid[i+1][key==='volPct'?3:2]),u.data[1][i]);
  }
}
const sensitivity=readCsv(DOC.getElementById('hedge-b-sensitivity'));
assert.equal(sensitivity.length,6);
sensitivity.slice(1).forEach((row,index)=>{
  near(Number(row[0]),settings.fxPct+index-2);
  const e=scalar(outlook,{...settings,fxPct:Number(row[0])},Number(row[1])/100);
  near(Number(row[2]),e.meanPct);near(Number(row[3]),e.volPct);near(Number(row[4]),e.cePct);
});

// Tab transitions preserve chart objects, selected market and unapplied drafts.
P.selectHedgeWorkspace('modelB');assert.equal(panel.hidden,false);
assert.equal(DOC.getElementById('hedge-tab-modelB').getAttribute('aria-selected'),'true');
const beforeTabs=liveCharts().slice();input('fxPct').value='2.75';
P.selectHedgeWorkspace('monitoring');assert.equal(panel.hidden,true);
P.selectHedgeWorkspace('modelB');assert.equal(panel.hidden,false);
assert.equal(input('fxPct').value,'2.75');
assert(liveCharts().every((u,i)=>u===beforeTabs[i]));
assert.equal(metric('return'),Number(expected.meanPct.toFixed(2)).toFixed(2));
P.hedgeModelBResize();assert(beforeTabs.every(u=>sizes.get(u)?.width>=240));
for(let i=0;i<4;i++) {
  const previous=liveCharts().slice();P.renderHedgeModelB(payload);
  assert.equal(liveCharts().length,2);previous.forEach(u=>assert(destroyed.has(u)));
}
assert.equal(input('fxPct').value,String(settings.fxPct));

// Equal bounds are a unique constraint, even when the FX variance is zero.
const flat=clone(payload);flat.bond_analytics.UST.outlook.risk.cov_annual=[[.0025,0],[0,0]];
P.renderHedgeModelB(flat);
apply({...settings,fxPct:outlook.cost.mean_pct,minHedgePct:25,maxHedgePct:75});
assert(card(3).textContent.includes('동률'));
assert(card(4).textContent.includes('동률'));
assert(DOC.getElementById('hedge-b-market-UST').textContent.includes('동률'));
const tiedCsv=readCsv(DOC.getElementById('hedge-b-comparison'));
const identifiedColumn=tiedCsv[0].indexOf('해 구분');assert(identifiedColumn>=0);
assert.equal(tiedCsv[5][identifiedColumn],'동률 대표값');
assert.equal(tiedCsv[6][identifiedColumn],'동률 대표값');
const tiedSensitivity=readCsv(DOC.getElementById('hedge-b-sensitivity'));
const tiedSensitivityColumn=tiedSensitivity[0].indexOf('해 구분');
assert.equal(tiedSensitivity[3][tiedSensitivityColumn],'동률 대표값');
assert.equal(tiedSensitivity[2][tiedSensitivityColumn],'고유해');
assert.equal(tiedSensitivity[3][tiedSensitivity[0].indexOf('시장')],'UST');
near(Number(tiedCsv[5][1]),25);near(Number(tiedCsv[6][1]),25);
apply({...settings,minHedgePct:40,maxHedgePct:40});
assert.equal(vals(3)[0],'40.00');assert.equal(vals(4)[0],'40.00');
assert(!card(3).textContent.includes('동률'));assert(!card(4).textContent.includes('동률'));
assert(card(3).textContent.includes('제약 경계'));assert(card(4).textContent.includes('제약 경계'));
assert(panel.querySelector('.hedge-b-current').textContent.includes('제약 밖'));
// Reset affects only the selected market and is persisted.
input('reset').click();
same(storage().markets.UST,P.hedgeModelBDefaults);same(storage().markets.JPY,jpySettings);
// Natural hedging is allowed to make full hedging riskier than no hedge.
const cushion=clone(payload);cushion.bond_analytics.UST.outlook.risk.cov_annual=[[.01,-.009],[-.009,.01]];
P.renderHedgeModelB(cushion);
assert.equal(vals(3)[0],'10.00');assert(Number(vals(2)[4])<0);
// Inactive or absent data cannot leave prior numbers/charts visible.
const inactive=clone(payload);inactive.bond_analytics.UST.outlook={active:false,reason:'시험용 공통 관측 부족'};
const beforeMissing=liveCharts().slice();P.renderHedgeModelB(inactive);
assert.equal(liveCharts().length,0);beforeMissing.forEach(u=>assert(destroyed.has(u)));
assert(panel.textContent.includes('시험용 공통 관측 부족'));
assert.equal(panel.querySelectorAll('.hedge-b-scenario').length,0);
P.renderHedgeModelB(payload);assert.equal(liveCharts().length,2);
P.DATA.hedge=null;P.renderHedge();
assert.equal(liveCharts().length,0);assert.equal(panel.querySelectorAll('.hedge-b-scenario').length,0);
assert.equal(panel.querySelectorAll('.hedge-b-market').length,4);
assert.equal(DOC.getElementById('hedge-tab-modelB').getAttribute('aria-selected'),'true');
assert.equal(FETCH_CALLS.length,networkBefore);
console.log(JSON.stringify({initialRender:true,applyAndInvalidPreservation:true,
  perMarketStorage:true,tableChartCsvAgreement:true,tabPreservation:true,
  chartLifecycle:true,missingPayload:true,boundsAndTies:true,naturalHedgeCounterexample:true,
  rawPrecision:true,sensitivityAgreement:true,noNetworkForPrivateInputs:true}));
`;
const filename=path.join(repo,'tests/hedge_model_b_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
