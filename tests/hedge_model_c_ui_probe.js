/* Actual renderer/events: C state isolation, invalid edits, CSV and chart lifecycle. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const clone = x => JSON.parse(JSON.stringify(x));
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,a+' != '+b);
const outlook={active:true,asof:'2026-10-28',yield_asof:'2026-10-28',yield_pct:4,duration_years:8,
 cost:{mean_pct:-1,source:'HP',sign:'positive_received',unit:'pct_pa',asof:'2026-10-28'},
 sample:{n_months:240,start:'2006-10-31',end:'2026-09-30'},
 risk:{labels:['bond','fx'],cov_unit:'decimal_return_squared',cov_annual:[[.0025,-.0015],[-.0015,.01]]},
 sources:{bond:'info:UST10y',fx:'bb:달러원'},
 tail_risk:{active:true,version:1,asof:'2026-10-28',horizon_months:1,confidence:.95,
  unit:'monthly_loss_pct',grid_step_pct:1,method:'centered_historical_joint_shocks',
  full:{n_months:240,start:'2006-10-31',end:'2026-09-30',tail_mass:12},
  recent:{n_months:120,start:'2016-10-31',end:'2026-09-30',tail_mass:6},
  grid:Array.from({length:101},(_,i)=>({hedge_pct:i,full_es_pct:2+Math.abs(i-25)*.03,
    recent_es_pct:1.5+Math.abs(i-75)*.025,robust_es_pct:Math.max(2+Math.abs(i-25)*.03,1.5+Math.abs(i-75)*.025)}))}};
const analytics=Object.fromEntries(['UST','JPY','AUD','GER'].map(code=>[code,{outlook:clone(outlook)}]));
const payload={matrix:[],bond_analytics:analytics};
const panel=DOC.getElementById('hedge-model-c');
const input=k=>DOC.getElementById('hedge-c-'+k);
const stored=()=>JSON.parse(shim.localStorage.getItem('iaw-hedge-model-c-v1'));
const apply=values=>{Object.entries(values).forEach(([k,v])=>{input(k).value=v;});input('apply').click();};
const destroyed=new Set(), sizes=new Map();
shim.UPlotStub.prototype.destroy=function(){destroyed.add(this);};
shim.UPlotStub.prototype.setSize=function(size){sizes.set(this,size);};
const live=()=>shim.UPlotStub.made.filter(u=>panel.contains(u.root)&&!destroyed.has(u));
const networkBefore=FETCH_CALLS.length;
P.DATA.hedge=payload;P.renderHedge();
assert.equal(panel.querySelectorAll('.hedge-c-market').length,4);
assert.equal(panel.querySelectorAll('.hedge-c-scenario').length,6);
assert.equal(live().length,1);
assert(panel.textContent.includes('통계적 직교성 미검증'));
Object.entries(P.hedgeModelCDefaults).forEach(([k,v])=>near(Number(input(k).value),v));
P.selectHedgeWorkspace('modelC');assert.equal(panel.hidden,false);
assert.equal(DOC.getElementById('hedge-tab-modelC').getAttribute('aria-selected'),'true');
const initial=live()[0];input('tradeCostBps').value='35';
P.selectHedgeWorkspace('modelA');P.selectHedgeWorkspace('modelC');
assert.equal(input('tradeCostBps').value,'35');assert.equal(live()[0],initial);assert(sizes.get(initial));
// Re-entering C after a B Apply refreshes the comparison without losing C drafts.
P.selectHedgeWorkspace('modelB');
DOC.getElementById('hedge-b-fxPct').value='10';DOC.getElementById('hedge-b-apply').click();
P.selectHedgeWorkspace('modelC');
assert.equal(DOC.getElementById('hedge-c-scenario-2').querySelector('b').textContent,'0.00');
assert.equal(input('tradeCostBps').value,'35');
P.selectHedgeWorkspace('modelB');DOC.getElementById('hedge-b-reset').click();P.selectHedgeWorkspace('modelC');
const afterB=shim.localStorage.getItem('iaw-hedge-model-b-v1');
const settings={currentHedgePct:40,minHedgePct:20,maxHedgePct:90,maxTurnoverPp:30,tradeCostBps:12.5,carryStressPp:.7};
apply(settings);
assert.equal(JSON.stringify(stored().markets.UST),JSON.stringify(settings));
const preserved=panel.textContent, prior=live()[0], priorStorage=shim.localStorage.getItem('iaw-hedge-model-c-v1');
for(const invalid of [{...settings,currentHedgePct:40.5},{...settings,tradeCostBps:''},
 {...settings,minHedgePct:80,maxTurnoverPp:10},{...settings,carryStressPp:-1}]){
 apply(invalid);assert.equal(input('status').hidden,false);assert.equal(live()[0],prior);
 assert.equal(shim.localStorage.getItem('iaw-hedge-model-c-v1'),priorStorage);
}
apply(settings);assert.equal(input('status').hidden,true);
// Settings are independent of B and independent by market.
assert.equal(shim.localStorage.getItem('iaw-hedge-model-b-v1'),afterB);
DOC.getElementById('hedge-c-market-JPY').click();assert.equal(input('currentHedgePct').value,'50');
apply({...P.hedgeModelCDefaults,currentHedgePct:77});
DOC.getElementById('hedge-c-market-UST').click();assert.equal(input('currentHedgePct').value,'40');
vm.runInContext('hedgeModelCState=null;',sandbox);P.renderHedgeModelC(payload);
assert.equal(input('currentHedgePct').value,'40');assert.equal(stored().markets.JPY.currentHedgePct,77);
const readCsv=host=>{host.querySelectorAll('button').find(n=>n.textContent==='CSV').click();
 return CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(row=>row.split(','));};
const csv=readCsv(DOC.getElementById('hedge-c-comparison'));
assert.equal(csv.length,7);assert.equal(csv[0][2],'전체 ES95 (%)');
const objCol=csv[0].indexOf('손실기준 합계 (%)'), costCol=csv[0].indexOf('조정비용 (%)');
const evaluated=i=>{
 const b=outlook.tail_risk.grid[i],stress=(i/100)*settings.carryStressPp/12,
 cost=settings.tradeCostBps/100*Math.abs(i-settings.currentHedgePct)/100;
 return {full:b.full_es_pct+stress,recent:b.recent_es_pct+stress,cost,obj:Math.max(b.full_es_pct,b.recent_es_pct)+stress+cost};};
csv.slice(1).forEach(r=>{const v=evaluated(Number(r[1]));near(Number(r[2]),v.full);near(Number(r[3]),v.recent);
 near(Number(r[costCol]),v.cost);near(Number(r[objCol]),v.obj);});
const chart=live()[0], gridCsv=readCsv(DOC.getElementById('hedge-c-chart'));
assert.equal(gridCsv.length,102);assert.equal(chart.data[0].length,101);
assert(chart.opts.series.slice(1).every(s=>s.points.show===false));
for(let i=0;i<=100;i++){const v=evaluated(i);near(chart.data[1][i],v.full);near(chart.data[2][i],v.recent);near(chart.data[3][i],v.obj);}
for(let i=0;i<3;i++){const old=live()[0];P.renderHedgeModelC(payload);assert(destroyed.has(old));assert.equal(live().length,1);}
input('reset').click();assert.equal(stored().markets.UST.currentHedgePct,50);assert.equal(stored().markets.JPY.currentHedgePct,77);
const missing=clone(payload);delete missing.bond_analytics.UST.outlook.tail_risk;
P.renderHedgeModelC(missing);assert.equal(live().length,0);assert.equal(panel.querySelectorAll('.hedge-c-scenario').length,0);
assert(panel.textContent.includes('꼬리위험 산출물'));
const flat=clone(payload);flat.bond_analytics.UST.outlook.tail_risk.grid.forEach(r=>{
 r.full_es_pct=1;r.recent_es_pct=1;r.robust_es_pct=1;});
P.renderHedgeModelC(flat);apply({...P.hedgeModelCDefaults,tradeCostBps:0,currentHedgePct:37});
assert(DOC.getElementById('hedge-c-scenario-1').textContent.includes('동률'));
assert.equal(DOC.getElementById('hedge-c-scenario-1').querySelector('b').textContent,'37.00');
P.DATA.hedge=null;P.renderHedge();assert.equal(live().length,0);
assert.equal(panel.querySelectorAll('.hedge-c-market').length,4);assert.equal(FETCH_CALLS.length,networkBefore);
console.log(JSON.stringify({actualRender:true,applyAndValidation:true,marketAndBIsolation:true,
 tabPreservation:true,bComparisonRefresh:true,chartLifecycle:true,csvChartAgreement:true,missingAndTies:true,noNetwork:true}));
`;
const filename=path.join(repo,'tests/hedge_model_c_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
