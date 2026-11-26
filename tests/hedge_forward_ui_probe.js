/* Execute the real forward-path renderer; every expected number is hand-computable. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const stamp = d => Date.parse(d+'T00:00:00Z')/1000;
const byId = id => DOC.getElementById(id);
if (!byId('hedge-model-a')) { const host = DOC.createElement('div'); host.id = 'hedge-model-a'; DOC.body.append(host); }
// premium -1.00, 1Y differential -0.80 -> gap -0.20 (-20 bp); implied = differential + gap.
const seg = (a,b,kr,us) => ({years:[a,b],kr,us,diff:kr-us,implied_premium:kr-us-0.2,change_vs_now:kr-us+0.8});
const fixture = () => ({schema:'hedge_forward_v1',active:true,reason:null,currency:'USD',asof:'2030-06-28',
  method:{forecast_skill_claimed:false},
  current:{premium:-1,spread_1y:-0.8,gap:-0.2,gap_bp:-20,t:stamp('2030-06-28')},
  segments:[seg(0,1,3.2,4.0),seg(1,2,3.5,4.0),seg(2,3,3.75,4.0),seg(3,5,4.0,4.0),seg(5,10,4.5,4.0)],
  history:{t:['2030-06-14','2030-06-21','2030-06-28'].map(stamp),
    segments:[{years:[0,1],diff:[-1,-0.9,-0.8]},{years:[1,2],diff:[-0.7,-0.6,-0.5]},{years:[2,3],diff:[-0.4,-0.3,-0.25]},
      {years:[3,5],diff:[0,0,0]},{years:[5,10],diff:[0.5,0.5,0.5]}]},
  backtest:[{horizon_months:12,segment_years:[1,2],active:true,reason:null,n:120,first_origin:'2019-01',last_origin:'2029-06',
      rmse:0.9,rw_rmse:0.75,theil_u:1.2,bias:0.3,hit_rate:0.7,hit_n:118},
    {horizon_months:24,segment_years:[2,3],active:false,reason:'실현된 평가 표본 10개 — 최소 24개 필요',n:10,first_origin:null,last_origin:null,
      rmse:null,rw_rmse:null,theil_u:null,bias:null,hit_rate:null,hit_n:0}]});
const copy = () => JSON.parse(JSON.stringify(fixture()));
const host = () => byId('hedge-forward');
const live = () => shim.UPlotStub.made.filter(u => !u.dead).length;
shim.UPlotStub.prototype.destroy = function(){ this.dead = true; };

// The CIP renderer owns the panel; the forward section is appended after it and survives.
P.renderHedgeCip(null);
const before = live();
P.renderHedgeForward(copy());
assert(host(), 'section missing');
assert.equal(byId('hedge-model-a').lastElementChild ?? byId('hedge-model-a').children.at(-1), host());
const text = () => host().textContent;
const rows = cls => host().querySelector('.' + cls).querySelectorAll('tbody tr').map(tr => tr.querySelectorAll('td').map(td => td.textContent));

// Tiles: signed premium convention, bp gap, date.
assert(text().includes('−1.00') || text().includes('-1.00'));
assert(text().includes('2030-06-28'));
const path0 = rows('hedge-forward-path');
assert.equal(path0.length, 5);
assert.deepEqual(path0.map(r => r[0]), ['현재~1년','1~2년 뒤','2~3년 뒤','3~5년 뒤','5~10년 뒤']);
const num = s => Number(String(s).replace('−','-').replace('+',''));
// First segment equals the current premium exactly; later ones add the same -0.20 gap.
assert.equal(num(path0[0][5]), -1);    assert.equal(num(path0[0][4]), 0);
assert.equal(num(path0[1][3]), -0.5);  assert.equal(num(path0[1][5]), -0.7);  assert.equal(num(path0[1][4]), 0.3);
assert.equal(num(path0[3][3]), 0);     assert.equal(num(path0[3][5]), -0.2);
assert.equal(num(path0[4][3]), 0.5);   assert.equal(num(path0[4][5]), 0.3);
assert(path0[4][5].startsWith('+'), 'a received premium must carry its sign');

// History chart: only the segments ending within three years, one chart, destroyed on re-render.
assert.equal(live(), before + 1);
const chart = shim.UPlotStub.made.filter(u => !u.dead).at(-1);
assert.equal(chart.data.length, 4);
assert.deepEqual(Array.from(chart.data[2]), [-0.7,-0.6,-0.5]);
const emptyNote = () => host().querySelectorAll('p').find(n => n.textContent.includes('표시할 이력이 없습니다'));
assert(emptyNote() && emptyNote().hidden, 'the empty-history note must be hidden while a chart is shown');
const noHistory = copy(); noHistory.history = {t:[],segments:[]}; P.renderHedgeForward(noHistory);
assert(emptyNote() && !emptyNote().hidden); assert.equal(live(), before); P.renderHedgeForward(copy());

// Track record: active row shows the ratio; inactive row shows its reason, never a made-up number.
const bt = rows('hedge-forward-backtest');
assert.equal(bt.length, 2);
assert.equal(bt[0][1], '120'); assert.equal(num(bt[0][2]), 0.9); assert.equal(num(bt[0][3]), 0.75); assert.equal(num(bt[0][4]), 1.2);
assert(bt[0][6].includes('70%') && bt[0][6].includes('118'));
assert(bt[1][7].includes('최소 24개') && bt[1].slice(2,7).every(c => c === '—'));

// The reading instruction is visible (not inside a folded explanation) and follows the evidence.
const verdict = () => host().querySelector('.hedge-forward-verdict').textContent;
assert(verdict().includes('현 수준 유지') && verdict().includes('컸습니다'));
assert(!host().querySelector('details').contains(host().querySelector('.hedge-forward-verdict')));
const better = copy(); better.backtest[0].rmse = 0.6; better.backtest[0].theil_u = 0.8;
P.renderHedgeForward(better);
assert(verdict().includes('작았으나') && verdict().includes('검증된 것은 아닙니다'));
const mixed = copy(); mixed.backtest[1] = {...mixed.backtest[0], horizon_months:24, rmse:0.6, theil_u:0.8};
P.renderHedgeForward(mixed);
assert(verdict().includes('섞여'));
const none = copy(); none.backtest = [none.backtest[1]];
P.renderHedgeForward(none);
assert(verdict().includes('표본이 부족'));
assert.equal(live(), before + 1, 're-render must not leak charts');
assert.equal(DOC.querySelectorAll('#hedge-forward').length, 1);

// Inactive and corrupted payloads show the reason or a refusal, and no numbers or charts.
P.renderHedgeForward({schema:'hedge_forward_v1',active:false,reason:'금리 곡선과 HP의 동일 날짜 공통 관측 없음',currency:'USD'});
assert(text().includes('동일 날짜 공통 관측 없음')); assert(!host().querySelector('table')); assert.equal(live(), before);
for (const mutate of [p => p.schema = 'other', p => p.currency = 'JPY', p => p.current.premium = NaN, p => p.segments = [],
    p => p.segments[1].years = [2,3], p => p.segments[1].diff += 0.01, p => p.segments[2].implied_premium += 0.01,
    p => p.segments[0].implied_premium = -0.9, p => p.segments[3].us = null, p => { delete p.asof; },
    // Each identity on its own: differential = KR - US, and the first segment is today's premium.
    p => { p.segments[1].diff += 0.01; p.segments[1].implied_premium += 0.01; },
    p => { p.current.gap = -0.3; p.segments.forEach(s => { s.implied_premium = s.diff - 0.3; }); }]) {
  const broken = copy(); mutate(broken); P.renderHedgeForward(broken);
  assert(text().includes('확인할 수 없어'), 'corrupted payload must not render numbers');
  assert(!host().querySelector('table')); assert.equal(live(), before);
}
P.renderHedgeForward(undefined);
assert(text().includes('확인할 수 없어'));

// Re-rendering the CIP panel clears the section; the page render puts it back.
P.renderHedgeForward(copy()); P.renderHedgeCip(null); assert(!host());
console.log(JSON.stringify({pass:true,identities:true,segments:true,history:true,trackRecord:true,verdictVisible:true,lifecycle:true,invalidRejected:true}));
`;
const filename = path.join(repo, 'tests/hedge_forward_ui_regression.js');
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap + '\n' + code, filename);
