/* Run real controls; compare financial output with scalar two-asset identities. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
vm.runInContext('globalThis.__reference = { referenceMoments, referenceWeightsValid, referenceLoadState, renderReferencePortfolio, renderAllocWorkspace, selectAllocWorkspace };', sandbox);
const R = sandbox.__reference;
const clone = v => JSON.parse(JSON.stringify(v));
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const near = (a,b,tol=1e-9) => assert(Math.abs(a-b)<=tol,a+' != '+b);
const keys = ['kr_bond','us_bond','kr_equity','us_equity','commodity'];
const labels = ['국내채권','미국채권','국내주식','미국주식','원자재'];
const sources = ['bb:한국종합','bb:미국종합','bb:한국_KOSPI_TR','bb:미국_S&P500_TR','bb:S&P GSCI TR CME'];
const cov = [
  [.0001,-.0004,0,0,0],[-.0004,.01,0,0,0],
  [0,0,.04,0,0],[0,0,0,.0225,0],[0,0,0,0,.0625],
];
const w10 = {key:'y10',label:'10년',n_months:120,start:'2016-11-30',end:'2026-10-31',
  mean_pct:[2,4,6,8,5],cov,vol_pct:[1,10,20,15,25],rf_mean_pct:1.25,rf_reason:''};
const w1 = {...clone(w10),key:'y1',label:'1년',n_months:12,start:'2025-11-30',
  mean_pct:[3,5,7,9,6],cov:cov.map(row=>row.map(v=>v*4)),vol_pct:[2,20,40,30,50]};
const payload = {version:1,active:true,reason:'',assets:keys.map((key,i)=>({key,label:labels[i],source:sources[i],
  currency:[0,2].includes(i)?'KRW':'USD→KRW',available:true,reason:''})),windows:[w1,w10],
  defaults:{window:'y10'},asof:'2026-10-31',data_asof:'2026-11-05',rf_source:'bb:한국_크레딧_CD_AAA_3m'};
const byId = id => DOC.getElementById(id);
const panel = byId('alloc-reference-panel');
const input = key => byId('reference-weight-'+key);
const metrics = () => byId('reference-current').querySelectorAll('b').map(n=>n.textContent);
const saved = () => JSON.parse(shim.localStorage.getItem('iaw-reference-portfolio-v1'));
const submit = values => {
  values.forEach((value,i)=>{input(keys[i]).value=value; input(keys[i]).dispatchEvent({type:'input'});});
  byId('reference-form').dispatchEvent({type:'submit',preventDefault(){this.defaultPrevented=true;}});
};
const windowSelect = key => {const select=byId('reference-window');select.value=key;select.dispatchEvent({type:'change'});};
const snapshot = () => ['iaw-port','iaw-alloc','iaw-cma'].map(k=>shim.localStorage.getItem(k));
shim.localStorage.setItem('iaw-port','{"user":"saa-taa-input"}');
shim.localStorage.setItem('iaw-alloc','{"user":"risk-input"}');
shim.localStorage.setItem('iaw-cma','{"user":"cma-input"}');
const unrelated=snapshot(), networkBefore=FETCH_CALLS.length;
P.DATA.alloc={reference:payload};
R.renderAllocWorkspace();R.selectAllocWorkspace('reference');
assert(!panel.hidden);
assert(byId('alloc-port-panel').hidden);assert(byId('alloc-risk-proc').hidden);
assert.equal(byId('alloc-workspace-reference').getAttribute('aria-pressed'),'true');
assert.equal(panel.querySelectorAll('.reference-card').length,4);
assert.equal(byId('reference-window').value,'y10');
assert(panel.textContent.includes('2016-11-30 ~ 2026-10-31'));

// Closed-form identity uses only the two nonzero weights. Negative risk contribution is valid.
const result=R.referenceMoments(w10,[50,50,0,0,0]);
const variance=(.0001+.01+2*(-.0004))/4;
near(result.mean,3);near(result.vol,Math.sqrt(variance)*100);
near(result.sharpe,(3-1.25)/(Math.sqrt(variance)*100));
near(result.risk[0],100*(.0001-.0004)/4/variance);
assert(result.risk[0]<0);near(result.risk.reduce((a,b)=>a+b,0),100);
assert.equal(R.referenceMoments(w10,[50,49,0,0,0]),null);
assert.equal(R.referenceMoments(w10,[101,-1,0,0,0]),null);
const flat=clone(w10);flat.cov=flat.cov.map(row=>row.map(()=>0));
const flatResult=R.referenceMoments(flat,[50,50,0,0,0]);
assert.equal(flatResult.vol,0);assert.equal(flatResult.sharpe,null);assert(flatResult.risk.every(v=>v===null));

submit([50,50,0,0,0]);
same(saved().weights,[50,50,0,0,0]);assert.equal(saved().selected,'custom');
same(metrics(),['3.00',result.vol.toFixed(2),result.sharpe.toFixed(2)]);
assert(byId('reference-error').hidden);
input('kr_bond').value='25';input('us_bond').value='75';
byId('reference-apply').click();same(saved().weights,[25,75,0,0,0]);
submit([50,50,0,0,0]);
const appliedText=byId('reference-current').textContent;
const appliedStorage=shim.localStorage.getItem('iaw-reference-portfolio-v1');
for(const values of [['',50,0,0,0],['  ',50,0,0,0],[50,49,0,0,0],[101,-1,0,0,0],['Infinity',0,0,0,0]]) {
  submit(values);assert(!byId('reference-error').hidden);
  assert.equal(byId('reference-current').textContent,appliedText);
  assert.equal(shim.localStorage.getItem('iaw-reference-portfolio-v1'),appliedStorage);
}
submit([50,50,0,0,0]);
// An unsubmitted draft survives tab re-entry and an ordinary rerender.
input('kr_bond').value='47.125';input('kr_bond').dispatchEvent({type:'input'});
R.selectAllocWorkspace('port');R.selectAllocWorkspace('reference');
assert.equal(input('kr_bond').value,'47.125');same(metrics(),['3.00',result.vol.toFixed(2),result.sharpe.toFixed(2)]);
windowSelect('y1');
assert.equal(saved().window,'y1');assert.equal(input('kr_bond').value,'47.125');
near(Number(metrics()[0]),4);near(Number(metrics()[1]),Number((result.vol*2).toFixed(2)));
assert(panel.textContent.includes('2025-11-30 ~ 2026-10-31'));
// Persistence retains the last applied weights, not the unsubmitted draft.
vm.runInContext('referenceState = null;',sandbox);R.renderReferencePortfolio();
assert.equal(byId('reference-window').value,'y1');same(saved().weights,[50,50,0,0,0]);
assert.equal(input('kr_bond').value,'50');
windowSelect('y10');byId('reference-preset-us').click();same(saved().weights,[0,40,0,60,0]);
near(Number(metrics()[0]),6.4);

// Partial source loss never treats null as a zero-valued observation.
const partial=clone(payload);
for(const i of [0,4]) {
  partial.assets[i].available=false;partial.assets[i].reason=i===0?'국내채권 원천 중복':'총수익 원천 없음';
  partial.windows.forEach(window=>{
    window.mean_pct[i]=null;window.vol_pct[i]=null;
    window.cov[i]=Array(5).fill(null);window.cov.forEach(row=>{row[i]=null;});
  });
}
P.DATA.alloc={reference:partial};R.renderReferencePortfolio();
assert(byId('reference-preset-domestic').disabled);
assert(byId('reference-preset-global').disabled);
assert(byId('reference-preset-diversified').disabled);
assert(!byId('reference-preset-us').disabled);
assert(panel.textContent.includes('국내채권 원천 중복'));
near(Number(metrics()[0]),6.4);
// The surviving card keeps its original number, and a coincident custom point is grouped.
const partialSvg=panel.querySelector('svg');
assert.equal(partialSvg.querySelectorAll('circle').length,1);
assert(partialSvg.querySelectorAll('text').some(n=>n.textContent==='2 · 직접 입력'));
assert(R.referenceMoments(partial.windows[1],[0,40,0,60,0]));
assert.equal(R.referenceMoments(partial.windows[1],[1,39,0,60,0]),null);
submit([1,39,0,60,0]);assert(!byId('reference-error').hidden);same(saved().weights,[0,40,0,60,0]);
submit([0,25,25,50,0]);near(Number(metrics()[0]),6.5);same(saved().weights,[0,25,25,50,0]);
const partialMetrics=R.referenceMoments(partial.windows[1],[0,25,25,50,0]);
near(partialMetrics.risk.reduce((a,b)=>a+b,0),100);
assert.equal(partialMetrics.risk[0],0);assert.equal(partialMetrics.risk[4],0);

byId('reference-csv').click();
const csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').split('\n').map(row=>row.split(','));
const headers=csv[0], get=(row,label)=>row[headers.indexOf(label)];
assert.equal(csv.length,6);assert(headers.includes('계산상태'));
csv.slice(1).forEach(row=>{
  assert.equal(get(row,'표본시작'),'2016-11-30');assert.equal(get(row,'표본종료'),'2026-10-31');
  assert.equal(get(row,'통화'),'KRW');assert.equal(get(row,'환헤지'),'미적용');assert.equal(get(row,'리밸런싱'),'월간 고정비중');
});
assert.equal(get(csv[1],'과거 산술 연평균 수익률 (%)'),'');
assert.equal(get(csv[1],'계산상태'),'필요 자산 원천 미확인');
near(Number(get(csv[2],'과거 산술 연평균 수익률 (%)')),6.4);
near(Number(get(csv[5],'연 변동성 (%)')),partialMetrics.vol);
near(Number(get(csv[5],'CD 연평균 (%)')),1.25);

// Removal clears old charts/numbers; recovery preserves only the applied allocation.
P.DATA.alloc={reference:{active:false,reason:'시험용 완료월 부족'}};R.renderReferencePortfolio();
assert(panel.textContent.includes('시험용 완료월 부족'));
assert.equal(panel.querySelectorAll('.reference-card').length,0);
assert.equal(panel.querySelectorAll('svg').length,0);assert.equal(byId('reference-current'),null);
P.DATA.alloc={reference:partial};R.renderReferencePortfolio();
near(Number(metrics()[0]),6.5);
const missingRf=clone(partial);missingRf.windows.forEach(w=>{w.rf_mean_pct=null;w.rf_reason='CD 동일 표본 부족';});
P.DATA.alloc={reference:missingRf};R.renderReferencePortfolio();
assert.equal(metrics()[2],'—');assert(panel.textContent.includes('CD 동일 표본 부족'));
same(snapshot(),unrelated);assert.equal(FETCH_CALLS.length,networkBefore);
console.log(JSON.stringify({workspace:true,scalarMoments:true,negativeRiskContribution:true,
  invalidDraftPreservesApplied:true,periodAndPersistence:true,separateStorage:true,
  partialSourceHandling:true,csvMetadata:true,missingDataRecovery:true,privateInputsStayLocal:true}));
`;
const filename = path.join(repo, 'tests/reference_portfolio_ui_runtime.js');
const m = new Module(filename, module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
