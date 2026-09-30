/* Independently recompute hedged return observations; exercise real input/state/UI paths. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const robust = fs.readFileSync(path.join(repo, 'tests/robust_frontier_ui_probe.js'), 'utf8');
const sixFixture = robust.slice(robust.indexOf('const SIX_ASSET_FIXTURE = (() => {'), robust.indexOf('\n`;\nconst reloadCode'));
const code = String.raw`
const assert = require('node:assert/strict');
const {portModelInputs,portRiskInputs,portHedgeInputs,portCorrKey} = vm.runInContext('({portModelInputs,portRiskInputs,portHedgeInputs,portCorrKey})',sandbox);
const near=(a,b,tol=1e-8)=>assert(Math.abs(a-b)<tol,a+' != '+b);
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const fixture=JSON.parse(JSON.stringify(SIX_ASSET_FIXTURE)),p=fixture.port,assets=p.assets;
p.usd_assets=['해외채권','해외주식','대체투자'];
p.hedge_cost={USD:{active:true,mean_pct:-2.4}};
const sign=(r,c)=>{let v=r&c,b=0;while(v){b^=v&1;v>>=1;}return b?-1:1;};
const fx=Array.from({length:16},(_,r)=>.1*sign(r,1)/Math.sqrt(12));
const local=[.04,.01,.06,.18,.16,.15],beta=[-.2,0,1,.2,1,1];
const observations=fx.map((f,r)=>local.map((s,i)=>s*sign(r,i+2)/Math.sqrt(12)+beta[i]*f));
const cov=(x,y)=>{const a=x.reduce((s,v)=>s+v,0)/x.length,b=y.reduce((s,v)=>s+v,0)/y.length;return x.reduce((s,v,i)=>s+(v-a)*(y[i]-b),0)/(x.length-1)*12;};
const columns=assets.map((_,i)=>observations.map(r=>r[i]));
const C=columns.map(x=>columns.map(y=>cov(x,y))),sig=C.map((r,i)=>Math.sqrt(r[i])*100);
const means=[4,3,6,8,9,7];
const w={...p.windows.at(-1),key:'all',n_months:16,cov:C,mean_pct:means,vol_pct:sig,
  corr:C.map((r,i)=>r.map((v,j)=>v*1e4/(sig[i]*sig[j]))),
  fx:{active:true,var:cov(fx,fx),cov_asset:columns.map(x=>cov(x,fx))}};
p.windows=[w];p.cma_input=null;
const state=P.portDefaults(p);state.hedge={해외채권:{enabled:true,ratio:50},해외주식:{enabled:true,ratio:100},대체투자:{enabled:true,ratio:0}};
const model=portModelInputs(p,state);assert(model.risk.valid);
const hs=[0,0,.5,0,1,0];
const hedged=observations.map((r,t)=>r.map((v,i)=>v-hs[i]*fx[t]));
const hc=assets.map((_,i)=>hedged.map(r=>r[i]));
assets.forEach((_,i)=>{
 near(model.mu[i],means[i]-hs[i]*2.4);
 near(model.risk.sig[i],Math.sqrt(cov(hc[i],hc[i]))*100);
 assets.forEach((_,j)=>near(model.C[i][j],cov(hc[i],hc[j])*1e4));
});
// Joint cross terms must change, including domestic-vs-overseas covariances.
assert.notEqual(model.C[0][2],C[0][2]*1e4);
assert.notEqual(model.risk.sig[2],sig[2]-.5*Math.sqrt(cov(fx,fx))*100);
const zeroState={...state,hedge:{해외채권:{enabled:true,ratio:0}}};
same(portModelInputs(p,zeroState).C,C.map(r=>r.map(v=>v*1e4)));
same(portModelInputs(p,zeroState).mu,means);
const positive={...p,hedge_cost:{USD:{active:true,mean_pct:1.2}}};near(portModelInputs(positive,state).mu[2],6.6);
const manual={...state,sig:Object.fromEntries(assets.map((a,i)=>[a,sig[i]*2]))};
const manualModel=portModelInputs(p,manual);assert(manualModel.risk.valid);
const manualHedged=observations.map((r,t)=>r.map((v,i)=>v*2-hs[i]*fx[t]));
assets.forEach((_,i)=>assets.forEach((_,j)=>near(manualModel.C[i][j],cov(manualHedged.map(r=>r[i]),manualHedged.map(r=>r[j]))*1e4)));
// Marginal asset correlation is PSD, but cannot coexist with two 0.9 FX correlations.
const two={assets:['A','B'],usd_assets:['A','B'],hedge_cost:p.hedge_cost};
const tw={cov:[[.01,.0081],[.0081,.01]],fx:{active:true,var:.01,cov_asset:[.009,.009]}};
const ts={sig:{},corr:{[portCorrKey('A','B')]:0},hedge:{A:{enabled:true,ratio:100}}};
assert(portRiskInputs(two,tw,ts).valid);
assert(!portHedgeInputs(two,tw,ts,portRiskInputs(two,tw,ts)).valid);
const sole={assets:['A'],usd_assets:['A'],hedge_cost:p.hedge_cost};
const sw={cov:[[.01]],fx:{active:true,var:.01,cov_asset:[.01]}};
const ss={sig:{},corr:{},hedge:{A:{enabled:true,ratio:100}}};
near(portHedgeInputs(sole,sw,ss,portRiskInputs(sole,sw,ss)).sig[0],0);
assert(!portModelInputs({...p,hedge_cost:{}},state).risk.valid);
assert(!portModelInputs({...p,windows:[{...w,fx:null}]},state).risk.valid);
// Real DOM wiring: each edit persists base inputs, reload is stable, export stays unhedged.
shim.localStorage.removeItem(P.PORT_LS_KEY);P.DATA.alloc=fixture;
P.renderPortPanel(fixture);
const panel=DOC.getElementById('alloc-port-panel');
const input=(label)=>Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
const fire=(node,type)=>node.dispatchEvent({type});
const chart=()=>shim.UPlotStub.made.filter(c=>c.opts.series.some(series=>series.label==='경계선')).at(-1);
const baseChart=chart(),baseData=JSON.parse(JSON.stringify(baseChart.data));
const baseSeries=baseChart.opts.series.map(series=>series.label);
const verifyBaseline=(actual)=>{
  baseSeries.slice(1).forEach((label,k)=>{
    const series=actual.opts.series.findIndex(item=>item.label===label);assert(series>0);
    baseData[0].forEach((x,i)=>{
      const at=actual.data[0].findIndex(v=>Math.abs(v-x)<1e-7);assert(at>=0,'baseline x preserved');
      if(baseData[k+1][i]===null)assert.equal(actual.data[series][at],null);
      else near(actual.data[series][at],baseData[k+1][i],1e-6);
    });
  });
};
let check=input('해외채권 환헤지'),ratio=input('해외채권 헤지비중 %');
assert(check&&!check.checked&&ratio.disabled);
assert(!input('국내채권 환헤지'));
assert.equal(panel.querySelectorAll('.port-table th').at(-1).textContent,'환헤지 / 비중 %');
check.checked=true;fire(check,'change');assert(!ratio.disabled);
ratio.value='50';fire(ratio,'input');
let saved=P.portState(p),once=portModelInputs(p,saved);near(once.mu[2],4.8);
assert.equal(saved.hedge.해외채권.ratio,50);
near(JSON.parse(panel.querySelector('.port-export').value).mu_pct.해외채권,6);
assert(panel.querySelectorAll('.port-hedge-applied')[0].textContent.includes('μ 4.80'));
const compared=chart(),uiModel=P.portEngine(p,saved),baseModel=P.portEngine(p,{...saved,hedge:{}});
verifyBaseline(compared);
const hedgedSeries=compared.opts.series.findIndex(series=>series.label==='환헤지 경계선');assert(hedgedSeries>0);
uiModel.front.forEach(point=>{
  const at=compared.data[0].findIndex(x=>Math.abs(x-point.sig)<1e-7);assert(at>=0);
  near(compared.data[hedgedSeries][at],point.mu,1e-6);
});
// Tracking error is measured against one fixed UNHEDGED benchmark, using raw returns.
const current=assets.map(a=>saved.mix[a]/100),wb=baseModel.wb,uiH=uiModel.risk.hedge.h;
const actualReturns=observations.map((row,t)=>row.reduce((sum,v,i)=>sum+current[i]*(v-uiH[i]*fx[t]),0));
const benchReturns=observations.map(row=>row.reduce((sum,v,i)=>sum+wb[i]*v,0));
const activeReturns=actualReturns.map((value,i)=>value-benchReturns[i]);
const expectedTe=Math.sqrt(cov(activeReturns,activeReturns))*100;
const expectedMu=current.reduce((sum,v,i)=>sum+v*(means[i]-uiH[i]*2.4),0);
const expectedAct=expectedMu-wb.reduce((sum,v,i)=>sum+v*means[i],0);
const benchmarkRows=Array.from(panel.querySelectorAll('.port-benchmark tbody tr'));
const hedgeRow=benchmarkRows.find(row=>row.querySelector('td').textContent==='현재 배분 · 환헤지');assert(hedgeRow);
const cells=Array.from(hedgeRow.querySelectorAll('td')).map(cell=>cell.textContent);
near(Number(cells[1]),expectedMu,.0051);near(Number(cells[4]),expectedAct,.0051);
near(Number(cells[5]),expectedTe,.0051);near(Number(cells[6]),expectedAct/expectedTe,.0051);
assert(!benchmarkRows.some(row=>row.textContent.includes('벤치마크 60/40 · 환헤지')));
// Exercise the real added current-hedge point's hover, including its own mean vector.
const pointSigma=uiModel.sig(current),pointMu=uiModel.muOf(current);
const hoverPlot={bbox:{left:0,top:0,width:100000,height:100000},valToPos:value=>value*1000,
  cursor:{left:pointSigma*1000,top:pointMu*1000}};
compared.opts.hooks.draw.at(-1)(hoverPlot);compared.opts.hooks.setCursor.at(-1)(hoverPlot);
const tip=panel.querySelector('.port-portfolio-tooltip');assert(!tip.hidden);
assert(tip.querySelector('.port-tooltip-title').textContent.includes('현재 · 환헤지'));
const riskTerms=current.map((v,i)=>v*uiModel.risk.C[i].reduce((sum,c,j)=>sum+c*current[j],0));
const portfolioVariance=riskTerms.reduce((sum,v)=>sum+v,0);
Array.from(tip.querySelectorAll('.port-tooltip-return')).forEach((cell,i)=>
 near(parseFloat(cell.textContent),current[i]*(means[i]-uiH[i]*2.4)/expectedMu*100,.0051));
Array.from(tip.querySelectorAll('.port-tooltip-risk')).forEach((cell,i)=>
 near(parseFloat(cell.textContent),riskTerms[i]/portfolioVariance*100,.0051));
// CSV retains both scenarios and exact frontier values.
Array.from(panel.querySelector('.port-result-tools').querySelectorAll('button')).find(button=>button.textContent==='CSV').click();
assert(CSV_DOWNLOADS.at(-1).includes('환헤지 경계선'));
const hedgeCsv=CSV_DOWNLOADS.at(-1).split('\n').map(line=>line.split(',')).find(row=>row[0]==='환헤지 경계선');
near(Number(hedgeCsv[2]),uiModel.front[0].sig);near(Number(hedgeCsv[3]),uiModel.front[0].mu);
// Checking a zero hedge preserves exactly one unchanged frontier scenario.
ratio.value='0';fire(ratio,'input');same(chart().data,baseData);
assert(!chart().opts.series.some(series=>series.label==='환헤지 경계선'));
ratio.value='50';fire(ratio,'input');

P.renderPortPanel(fixture);same(portModelInputs(p,P.portState(p)).mu,once.mu);
ratio=input('해외채권 헤지비중 %');ratio.value='101';fire(ratio,'input');
assert.equal(ratio.getAttribute('aria-invalid'),'true');assert.equal(P.portState(p).hedge.해외채권.ratio,50);
check=input('해외채권 환헤지');check.checked=false;fire(check,'change');
near(portModelInputs(p,P.portState(p)).mu[2],6);same(portModelInputs(p,P.portState(p)).C,C.map(r=>r.map(v=>v*1e4)));
check.checked=true;fire(check,'change');near(portModelInputs(p,P.portState(p)).mu[2],4.8);
// Unavailable hedge inputs leave the baseline plot intact with an explicit error.
const oldCost=p.hedge_cost;p.hedge_cost={};P.renderPortPanel(fixture);
same(chart().data,baseData);assert(panel.querySelector('.port-frontier').textContent.includes('환헤지 계산 불가'));
const failedReview=panel.querySelector('.port-benchmark').parentElement;assert(failedReview.textContent.includes('환헤지 계산 불가'));
assert(!chart().opts.series.some(series=>series.label==='환헤지 경계선'));
p.hedge_cost=oldCost;P.renderPortPanel(fixture);
// Theme rerender preserves the current weight draft and matching risk-layer model.
input('국내채권 비중').value='42';fire(input('국내채권 비중'),'input');
P.renderPortPanel(fixture,{preserveDraft:true});assert.equal(input('국내채권 비중').value,'42');
const linked=P.portRiskAllocationEngine(fixture);assert(!linked.error);
same(linked.V.mu,portModelInputs(p,P.portState(p)).mu);
same(linked.V.C,portModelInputs(p,P.portState(p)).C);
console.log(JSON.stringify({pass:true,independentReturnMoments:true,manualJointPsdGuard:true,zeroAndFullHedge:true,persistence:true,noDoubleCarry:true,exportUnhedged:true,linkedModel:true,baselinePreserved:true,hedgeOverlay:true,hedgeHoverContributions:true,fixedBenchmarkTrackingError:true,missingHedgeKeepsBaseline:true,zeroHedgeNoDuplicate:true}));
`;
const filename=path.join(repo,'tests/port_hedge_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sixFixture+'\n'+code,filename);
