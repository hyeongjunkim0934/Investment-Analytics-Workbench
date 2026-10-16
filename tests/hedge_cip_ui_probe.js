/* Execute the real renderer and controls; expected statistics are hand-computable. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const near = (a,b,tol=1e-9) => assert(Math.abs(a-b)<tol,a+' != '+b);
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const stamp = d => Date.parse(d+'T00:00:00Z')/1000;
const dates = ['2026-09-01','2026-09-02','2026-09-03','2026-09-04'];
const base = {active:true,t:dates.map(stamp),kr:[2,3,4,5],us:[4,4,4,4],
 spread:[-2,-1,0,1],premium:[-1,0,2,1]};
const s=P.hedgeCipStats(base);
near(s.correlation,.8);near(s.gap_bp,0);near(s.rmse_bp,Math.sqrt(1.5)*100);
// Gaps [1,1,2,0]: mean 1, sample variance 2/3; latest gap 0.
near(s.gap_zscore,-Math.sqrt(1.5));
same([s.kr,s.us,s.spread,s.premium],[5,4,1,1]);
assert.equal(s.n,4);assert.equal(s.asof,dates[3]);
const filtered=P.hedgeCipStats(base,{start:dates[1],end:dates[2]});
near(filtered.correlation,1);near(filtered.gap_bp,200);near(filtered.rmse_bp,Math.sqrt(2.5)*100);
near(filtered.gap_zscore,1/Math.sqrt(2));same([filtered.kr,filtered.us,filtered.spread,filtered.premium],[4,4,0,2]);
const perfect={...base,premium:base.spread.slice()};
near(P.hedgeCipStats(perfect).rmse_bp,0);near(P.hedgeCipStats(perfect).correlation,1);
assert.equal(P.hedgeCipStats(perfect).gap_zscore,null);
const constantGap={...base,premium:base.spread.map(v=>v+.1)};
assert.equal(P.hedgeCipStats(constantGap).gap_zscore,null);
near(P.hedgeCipStats({...base,premium:base.premium.map(v=>v+9)}).gap_zscore,s.gap_zscore);
near(P.hedgeCipStats({...base,spread:base.spread.map(v=>v*100),premium:base.premium.map(v=>v*100)}).gap_zscore,s.gap_zscore);
assert.equal(P.hedgeCipStats({...base,premium:[0.1,0.1,0.1,0.1]}).correlation,null);
assert.equal(P.hedgeCipStats({...base,spread:[0,0,0,0]}).correlation,null);
const constantDifference=[1.1,2.1,3.1,4.1].map((r,i)=>r-[1,2,3,4][i]);
assert.equal(P.hedgeCipStats({...base,spread:constantDifference}).correlation,null);
near(P.hedgeCipStats({...base,spread:[0,.00000001,.00000002,.00000003],premium:[0,1,2,3]}).correlation,1);
const one=P.hedgeCipStats({...base,t:base.t.slice(0,1)});
assert.equal(one.correlation,null);near(one.rmse_bp,100);near(one.gap_bp,100);
assert.equal(one.gap_zscore,null);
assert.equal(P.hedgeCipStats({...base,active:false}).n,0);
const malformed={t:[base.t[2],base.t[0],base.t[0],base.t[1],base.t[3],Infinity],
 spread:[0,-2,-1,null,1,1],premium:[2,-1,0,0,NaN,1]};
same(P.hedgeCipSelection(malformed),{t:[base.t[0],base.t[2]],kr:[null,null],us:[null,null],spread:[-1,0],premium:[0,2],gap:[1,2]});
const scrambled={...malformed,kr:[2,1,3,null,NaN,9],us:[2,3,4,4,5,6]};
same(P.hedgeCipSelection(scrambled).kr,[3,2]);same(P.hedgeCipSelection(scrambled).us,[4,2]);
const tenors=['PR','3M','1Y','2Y','3Y'];
const payload={currency:'USD',tenors:tenors.map((tenor,i)=>({...base,tenor,
 premium:base.premium.map(v=>v+i*.1)}))};
shim.UPlotStub.prototype.setScale=function(k,v){(this.scales??={})[k]={...v};};
const render=()=>{P.DATA.hedge={matrix:[],cip:payload};P.renderHedge();};
render();
const panel=DOC.getElementById('hedge-model-a');
assert.equal(panel.querySelectorAll('.hedge-cip-stat').length,5);
assert.equal(panel.querySelectorAll('.hedge-cip-chart').length,5);
assert.equal(panel.querySelectorAll('.explain').length,1);
const charts=()=>P.registry.filter(e=>panel.contains(e.u.root));
assert.equal(charts().length,5);
const metric=(tenor,key)=>DOC.getElementById('hedge-cip-'+tenor+'-'+key).textContent;
assert.equal(metric('PR','correlation'),'0.80');assert.equal(metric('PR','gap'),'0.00');
assert.equal(metric('PR','kr'),'5.00');assert.equal(metric('PR','us'),'4.00');
assert.equal(metric('PR','spread'),'+1.00');assert.equal(metric('PR','premium'),'+1.00');
assert.equal(metric('PR','zscore'),'-1.22');
const cardLabels=Array.from(panel.querySelectorAll('.hedge-cip-stat')[0].querySelectorAll('.hedge-cip-metric')).map(e=>e.children[0].textContent);
same(cardLabels,['한국 PR (%)','미국 PR (%)','금리차 (%p)','헤지비용(평균) (%)','상관계수','현재 괴리 (bp)','Z Score','RMSE (bp)']);
assert.equal(metric('3Y','gap'),'+40.00');
const input=key=>DOC.getElementById('hedge-cip-'+key);
const apply=(a,b)=>{input('start').value=a;input('end').value=b;input('apply').click();};
apply(dates[1],dates[2]);
assert.equal(metric('PR','gap'),'+200.00');assert.equal(metric('PR','correlation'),'1.00');
assert.equal(metric('PR','kr'),'4.00');assert.equal(metric('PR','spread'),'0.00');
assert.equal(metric('PR','premium'),'+2.00');assert.equal(metric('PR','zscore'),'+0.71');
charts().forEach(e=>{same(e.u.data[0],base.t.slice(1,3));assert.equal(e.range.end,dates[2]);});
// A reversed date interval must preserve the prior applied values and chart data.
apply(dates[3],dates[0]);
assert.equal(input('status').hidden,false);assert.equal(metric('PR','gap'),'+200.00');
apply('2025-01-01','2025-01-02');
assert.equal(metric('PR','gap'),'—');assert.equal(metric('PR','rmse'),'—');
['kr','us','spread','premium','zscore'].forEach(key=>assert.equal(metric('PR',key),'—'));
charts().forEach(e=>assert.equal(e.u.data[0].length,0));
input('all').click();
assert.equal(metric('PR','correlation'),'0.80');charts().forEach(e=>same(e.u.data[0],base.t));
// The selected period also governs the visible table and raw CSV.
const first=panel.querySelectorAll('.hedge-cip-chart')[0];
const button=label=>Array.from(first.querySelectorAll('button')).find(b=>b.textContent===label);
button('표').click();
apply(dates[1],dates[2]);button('CSV').click();
const csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(r=>r.split(','));
assert.equal(csv.length,3);assert(csv[0][3].includes('bp'));
const exported=new Map(csv.slice(1).map(row=>[row[0],Number(row[3])]));
near(exported.get(dates[1]),100);near(exported.get(dates[2]),200);
assert(csv[0][4].includes('한국 PR'));assert(csv[0][5].includes('미국 PR'));
csv.slice(1).forEach(r=>near(Number(r[4])-Number(r[5]),Number(r[1])));
assert.equal(first.querySelectorAll('tbody tr').length,2);
const before=charts().map(e=>e.u);
P.selectHedgeWorkspace('modelA');assert.equal(panel.hidden,false);
P.selectHedgeWorkspace('monitoring');P.selectHedgeWorkspace('modelA');
same(charts().map(e=>e.u.data),before.map(u=>u.data));assert.equal(input('start').value,dates[1]);
// Direct re-render destroys old model charts and preserves the applied range.
P.renderHedgeCip(payload);assert.equal(charts().length,5);
before.forEach(u=>assert(!charts().some(e=>e.u===u)));
assert.equal(input('start').value,dates[1]);assert.equal(metric('PR','gap'),'+200.00');
// Old cached payloads can still show spread/premium, but never invent individual rates.
P.renderHedgeCip({tenors:[{...base,kr:undefined,us:undefined,tenor:'PR'}]});
assert.equal(metric('PR','kr'),'—');assert.equal(metric('PR','us'),'—');
assert.equal(metric('PR','premium'),'+2.00');
// Inactive rows and absent payload cannot retain old results.
P.renderHedgeCip({tenors:[{tenor:'PR',active:false,reason:'금리 없음'}]});
assert.equal(charts().length,0);assert.equal(metric('PR','gap'),'—');assert(input('apply').disabled);
assert(panel.textContent.includes('금리 없음'));assert.equal(panel.querySelectorAll('.hedge-cip-stat').length,5);
P.DATA.hedge=null;P.renderHedge();assert.equal(charts().length,0);
assert.equal(DOC.getElementById('hedge-tab-modelA').getAttribute('aria-selected'),'true');
console.log(JSON.stringify({manualStatistics:true,signAndUnits:true,constantAndMissing:true,
 sourceInputs:true,zScoreAndInvariance:true,cardOrder:true,legacyMissingRates:true,
 fiveModules:true,periodSynchronization:true,invalidAndEmptyPeriod:true,
 tableCsvAgreement:true,tabState:true,chartCleanup:true,missingPayload:true}));
`;
const filename=path.join(repo,'tests/hedge_cip_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
