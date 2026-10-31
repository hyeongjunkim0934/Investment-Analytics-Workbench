/* Execute the real model adapters, summary renderer, market controls and CSV. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const repo = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repo, "tests/dashboard_probe.js"), "utf8");
const bootstrap = source.slice(0, source.indexOf("/* ============ P1."))
  .replace("const EXPORTS = [", `for (const file of ["summary-fx.js", "summary-hedge.js", "summary-forecasts.js"])
    vm.runInContext(fs.readFileSync(path.join(ROOT, "dashboard", file), "utf8"), sandbox);
const EXPORTS = [`);
const code = String.raw`
const assert = require('node:assert/strict');
const inspect = expr => vm.runInContext(expr, sandbox);
const adapterProbe = fs.readFileSync(path.join(ROOT, 'tests/summary_fx_probe.js'), 'utf8');
const helpers = adapterProbe.slice(adapterProbe.indexOf('const stamp ='), adapterProbe.indexOf('const context ='));
const fixtureCode = adapterProbe.slice(adapterProbe.indexOf('const now ='), adapterProbe.indexOf('const view ='));
const fx = vm.runInNewContext(helpers + fixtureCode + '; fixture()', {Date, Intl});
// Freeze Seoul today to keep forecast expiry and calendar-quarter tests deterministic.
sandbox.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-01T00:00:00Z'])); } };
vm.runInContext('fxOutlookToday = () => Date.UTC(2026,9,1)/1000;', sandbox);
const host = elem('div', 'summary-forecasts'); secNodes.summary.append(host);
const outlook = {active:true,asof:'2026-09-30',yield_pct:4.25,
  cost:{mean_pct:-1.2,source:'HP',sign:'positive_received',unit:'pct_pa'},
  sample:{n_months:120},risk:{labels:['bond','fx'],cov_unit:'decimal_return_squared',cov_annual:[[.0025,-.0015],[-.0015,.01]]}};
P.DATA.fx = fx;
P.DATA.hedge = {bond_analytics:{UST:{outlook},JPY:{outlook:{...outlook,yield_pct:1.6}},
  AUD:{outlook},GER:{outlook}}};
inspect('fxForecastState = {quarterCount: 1,consensus:{"2026-Q4":[1300,1400],"2027-Q1":[1375]}}');
const render = inspect('renderSummaryForecasts');
const sections = () => host.querySelectorAll('.summary-forecast-section');
const cards = kind => host.querySelector('.summary-forecast-grid-'+kind).querySelectorAll('.summary-forecast-card');
const metric = (quarter,label) => quarter.querySelectorAll('.summary-forecast-metric')
  .find(n=>n.querySelector('span').textContent===label).querySelector('b').textContent;
render();
assert.equal(sections().length,2);
assert.equal(sections()[0].querySelector('h2').textContent,'환율전망');
assert.equal(sections()[1].querySelector('h2').textContent,'환헤지');
assert.equal(cards('fx').length,4);assert.equal(cards('hedge').length,3);
for(const kind of ['fx','hedge']) cards(kind).forEach(card=>assert.equal(card.querySelectorAll('.summary-forecast-quarter').length,4));
assert.equal(host.querySelectorAll('.summary-forecast-quarter').length,28);
const first=cards('fx')[0].querySelector('.summary-forecast-quarter');
assert.equal(metric(first,'평균'),'1,363');
assert.equal(metric(first,'VaR 97.5%'),'5.88%');
assert.equal(first.querySelector('time').getAttribute('datetime'),'2026-12-30');
const consensus=cards('fx')[3].querySelectorAll('.summary-forecast-quarter');
assert.equal(metric(consensus[0],'응답 평균'),'1,350');
assert.equal(metric(consensus[0],'응답 ±1σ'),'1,300 ~ 1,400');
assert.equal(metric(consensus[0],'VaR 97.5%'),'—');
assert.equal(metric(consensus[1],'응답 ±1σ'),'—');
assert(consensus[1].textContent.includes('응답 2개 이상'));
assert(consensus[2].textContent.includes('미입력'));
const hedgeQuarter=cards('hedge')[0].querySelector('.summary-forecast-quarter');
assert.equal(metric(hedgeQuarter,'헤지비율 (%)'),'100.00%');
assert.equal(metric(hedgeQuarter,'기대수익률 (%)'),'0.76%');
assert(hedgeQuarter.textContent.includes('정규근사 95%'));
assert(cards('hedge')[2].textContent.includes('최소분산'));
assert(cards('hedge')[2].textContent.includes('신뢰구간이 아닙니다'));

// CSV uses the same unrounded model values and does not call calendar quarters exact 3-month horizons.
sections()[0].querySelector('button').click();
let csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(line=>line.split(','));
assert.equal(csv.length,17);assert.equal(Number(csv[1][9]),1362.6);
assert.equal(Number(csv[1][16]),(1-(1350-10*Math.sqrt(63))/1350)*100);
assert.equal(csv[13][5],'');assert.equal(csv[13][6],'2026 Q4');assert.equal(csv[13][16],'');
sections()[1].querySelector('button').click();
csv=CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').trim().split('\n').map(line=>line.split(','));
assert.equal(csv.length,13);assert(csv.slice(1).every(row=>row[12]==='정규근사 95%'));
assert(Math.abs(Number(csv[1][9])-.7625)<1e-12);

// Market change and valid applied settings update the summary; unrelated portfolios remain intact.
const method=cards('hedge')[2].querySelector('details');method.setAttribute('open','');
const select=DOC.getElementById('summary-hedge-market');select.value='JPY';select.dispatchEvent({type:'change'});
assert.equal(DOC.getElementById('summary-hedge-market').value,'JPY');
assert.equal(metric(cards('hedge')[0].querySelector('.summary-forecast-quarter'),'기대수익률 (%)'),'0.10%');
assert(cards('hedge')[2].querySelector('details').hasAttribute('open'));
inspect('hedgeModelBLoadState().markets.JPY.maxHedgePct = 50'); render();
assert(cards('hedge')[0].textContent.includes('제약 밖'));
assert.equal(metric(cards('hedge')[1].querySelector('.summary-forecast-quarter'),'헤지비율 (%)'),'50.00%');
inspect('fxForecastState.consensus["2026-Q4"]=[1400,1500]');render();
assert.equal(metric(cards('fx')[3].querySelector('.summary-forecast-quarter'),'응답 평균'),'1,450');
P.renderSummaryCards({port:{active:false,reason:'자료 없음'}});
assert.equal(cards('fx').length,4,'forecast cards survive unavailable portfolio inputs');
assert.equal(host.querySelectorAll('.summary-forecast-quarter').length,28,'rerender does not duplicate cards');
const children=secNodes.summary.children;
assert(children.indexOf(DOC.getElementById('summary-cards'))<children.indexOf(host));
P.DATA.fx=null;P.DATA.hedge=null;render();
assert.equal(cards('fx').length,4);assert.equal(cards('hedge').length,3);
assert(cards('hedge').every(card=>card.querySelectorAll('.summary-forecast-point b').every(n=>n.textContent==='—')));
assert(cards('fx')[1].textContent.includes('불러오지 못했습니다'));
assert(!host.textContent.includes('NaN'));assert(!host.textContent.includes('undefined'));
console.log(JSON.stringify({placement:true,twentyEightQuarters:true,modelLabels:true,numericDisplay:true,
  uncertaintyTypes:true,var975:true,consensusNoVar:true,unroundedCsv:true,calendarCsv:true,
  marketChange:true,appliedState:true,disclosurePreserved:true,missingInputs:true,portfolioIsolation:true}));
`;
const filename = path.join(repo, "tests/summary_forecasts_ui_runtime.js");
const m = new Module(filename, module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap + '\n' + code, filename);
