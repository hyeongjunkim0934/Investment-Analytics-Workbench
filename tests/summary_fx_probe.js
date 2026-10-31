/* Forecast adapters against full published validators and independent numeric oracles. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const stamp = (date) => Date.parse(date + "T00:00:00Z") / 1000;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const end = (year, month) => Date.UTC(year, month + 1, 0) / 1000;
const near = (a, b, tol = 1e-9) => assert(Math.abs(a - b) < tol, `${a} != ${b}`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const context = vm.createContext({ Date, Intl, console, tsToDate: iso });
for (const file of ["fx-outlook.js", "fx-markov.js", "fx-lstm-xgb.js", "fx-model-c.js", "summary-fx.js"])
  vm.runInContext(fs.readFileSync(path.join(root, "dashboard", file), "utf8"), context, { filename: file });
const run = vm.runInContext("summaryFxModels", context);
const now = new Date("2026-10-01T00:00:00Z"), anchor = { t: stamp("2026-09-30"), v: 1350 };
const markov = () => {
  const simulation = { schema_version: 1, engine: "gaussian_markov_log_returns", path_count: 20000,
    seed: 123, parameter_uncertainty_included: false, sample_paths: [], t: [], steps: [], mean: [], median: [],
    lower68: [], upper68: [], lower95: [], upper95: [], mean_mc_se: [], state_probabilities: [] };
  for (let i = 0; i <= 252; i++) {
    simulation.t.push(anchor.t + Math.round(i * 365 / 252) * 86400); simulation.steps.push(i);
    simulation.mean.push(anchor.v + i * .2); simulation.median.push(anchor.v + i * .1);
    simulation.lower68.push(anchor.v - Math.sqrt(i) * 5); simulation.upper68.push(anchor.v + Math.sqrt(i) * 5);
    simulation.lower95.push(anchor.v - Math.sqrt(i) * 10); simulation.upper95.push(anchor.v + Math.sqrt(i) * 10);
    simulation.mean_mc_se.push(i * .001); simulation.state_probabilities.push([.4, .3, .3]);
  }
  return { active: true, anchor: { ...anchor }, simulation,
    regimes: [0, 1, 2].map((i) => ({ id: i, mu_daily: 0, sigma_daily: (i + 1) * .001,
      mu_annual_pct: 0, sigma_annual_pct: i + 1, expected_duration_days: 10 })),
    transition: [[.8, .1, .1], [.1, .8, .1], [.1, .1, .8]],
    current: { regime: 0, probabilities: [.4, .3, .3], sigma_next_annual_pct: 5 } };
};
const modelC = () => ({ active: true, schema: "fx_model_c_v1", pair: "USDKRW", unit: "KRW/USD",
  asof: iso(anchor.t), model_date: iso(anchor.t), anchor: { ...anchor, quote_t: anchor.t },
  model: { shrinkage: .5, ridge_lambda: 1 }, horizons: [1, 3, 6, 9, 12].map((h) => {
    const log = .001 * h, point = anchor.v * Math.exp(log), target = end(2026, 8 + h);
    return { horizon_months: h, active: true, target_t: target, target_date: iso(target),
      point, ridge_point: anchor.v * Math.exp(log * 2), rw: anchor.v, change_pct: Math.expm1(log) * 100,
      lower95: point - 80, lower68: point - 40, upper68: point + 40, upper95: point + 80,
      n_train: 120, n_calibration: 30, contributions: ["intercept", "rate_spread", "momentum_1m", "momentum_3m"]
        .map((key) => ({ key, label: key, log_pct: log * 25 })), backtest: [],
      metrics: { n: 0, n_interval: 0, rmse: null, mae: null, rw_rmse: null, ridge_rmse: null,
        theil_u: null, coverage68: null, coverage95: null } };
  }) });
const modelB = () => ({ active: true, grid: { lags: [3, 6, 9, 12], windows: [24, 36] }, combos:
  [24, 36].flatMap((window) => [3, 6, 9, 12].map((lag) => {
    const c = { key: `l${lag}_w${window}`, lag, window, t_base: [], t_target: [], base: [], actual: [],
      pred: { xgb: [], lstm: [], ensemble: [] } };
    for (let i = 0; i < 57; i++) {
      c.t_base.push(end(2022, i)); c.t_target.push(end(2022, i + lag)); c.base.push(1294 + i);
      const pred = 1300 + i + lag;
      c.pred.ensemble.push(pred); c.pred.xgb.push(pred + 5); c.pred.lstm.push(pred - 5);
      c.actual.push(i + lag <= 56 ? pred * Math.exp(-.2 + i * .005 + (window - 24) / 100) : null);
    }
    return c;
  })) });
const fixture = () => ({ outlook: { history: { t: [anchor.t], v: [anchor.v] } },
  markov: markov(), lstm_xgb: modelB(), model_c: modelC() });
const view = { window: 24, model: "ensemble" };
const get = (fx = fixture(), state = {}, selection = view, date = now) => run(fx, state, selection, date);
const values = get();
assert.deepEqual(Array.from(values, (m) => m.key), ["modelA", "modelB", "modelC", "consensus"]);
values.forEach((m) => assert.deepEqual(Array.from(m.rows, (r) => r.horizonMonths), [3, 6, 9, 12]));
assert.equal(values[0].anchorDate, "2026-09-30");
values[0].rows.forEach((r, i) => {
  const step = [63, 126, 189, 252][i];
  near(r.point, 1350 + .2 * step); near(r.lower95, 1350 - 10 * Math.sqrt(step));
  near(r.var975Pct, 1000 * Math.sqrt(step) / 1350);
  assert.equal(r.targetDate, iso(anchor.t + Math.round(step * 365 / 252) * 86400));
});
// Lower 2.5% quantile maps to one-sided 97.5% loss, and positive-only returns have zero loss VaR.
near(vm.runInContext("summaryFxVaR975", context)(1200, 1500), 20);
assert.equal(vm.runInContext("summaryFxVaR975", context)(1510, 1500), 0);
assert.equal(vm.runInContext("summaryFxVaR975", context)(null, 1500), null);
const badAnchor = fixture(); badAnchor.outlook.history.v[0]++;
assert(get(badAnchor)[0].rows.every((r) => r.point === null && r.reason.includes("불일치")));
const expired = get(fixture(), {}, view, new Date("2028-01-01T00:00:00Z"));
assert(expired.slice(0, 3).every((m) => m.rows.every((r) => r.point === null && r.reason.includes("경과"))));

// Numeric oracle: equally spaced log errors have a linearly interpolated quantile in closed form.
values[1].rows.forEach((r) => {
  const lastErrorIndex = 56 - r.horizonMonths, predicted = 1356 + r.horizonMonths;
  near(r.point, predicted); assert.equal(r.sampleCount, lastErrorIndex + 1);
  near(r.lower95, predicted * Math.exp(-.2 + lastErrorIndex * .005 * .025));
  near(r.upper95, predicted * Math.exp(-.2 + lastErrorIndex * .005 * .975));
  near(r.var975Pct, Math.max(0, (1 - r.lower95 / 1350) * 100));
});
const futureLeak = fixture();
futureLeak.lstm_xgb.combos.forEach((c) => {
  const firstPending = c.actual.indexOf(null);
  assert(c.t_target[firstPending] > anchor.t);
  c.actual[firstPending] = 999999; // Corrupt future realized value still passes the legacy shape validator.
});
get(futureLeak)[1].rows.forEach((r, i) => {
  near(r.lower95, values[1].rows[i].lower95); assert.equal(r.sampleCount, values[1].rows[i].sampleCount);
});
const alternate = get(fixture(), {}, { window: 36, model: "xgb" })[1];
assert.notEqual(alternate.rows[0].point, values[1].rows[0].point);
assert.notEqual(alternate.rows[0].lower95, values[1].rows[0].lower95);
assert.equal(alternate.basis, "XGBoost · 학습창 36개월");
assert(get(fixture(), {}, { window: 72, model: "ensemble" })[1].rows.every((r) => r.point === null));
const noLag = fixture(); noLag.lstm_xgb.combos = noLag.lstm_xgb.combos.filter((c) => c.lag !== 9);
noLag.lstm_xgb.grid.lags = [3, 6, 12];
assert.equal(get(noLag)[1].rows[2].point, null); assert.equal(get(noLag)[1].rows[1].point, values[1].rows[1].point);
const oldOrigin = fixture(), oldCombo = oldOrigin.lstm_xgb.combos.find((c) => c.lag === 6 && c.window === 24);
for (const field of ["t_base", "t_target", "base", "actual"]) oldCombo[field].pop();
for (const field of ["xgb", "lstm", "ensemble"]) oldCombo.pred[field].pop();
assert.equal(get(oldOrigin)[1].rows[1].point, null);
assert(get(oldOrigin)[1].rows[1].reason.includes("공통 기준일"));
const noErrors = fixture();
noErrors.lstm_xgb.combos.forEach((c) => {
  for (const field of ["t_base", "t_target", "base", "actual"]) c[field] = c[field].slice(-25);
  for (const field of ["xgb", "lstm", "ensemble"]) c.pred[field] = c.pred[field].slice(-25);
});
assert(get(noErrors)[1].rows.every((r) => r.point !== null && r.lower95 === null && r.var975Pct === null));

values[2].rows.forEach((r) => {
  near(r.point, anchor.v * Math.exp(.001 * r.horizonMonths)); near(r.lower95, r.point - 80);
});
const offCenter = fixture(); offCenter.model_c.horizons.forEach((r) => {
  r.lower95 = r.point + 1; r.lower68 = r.point + 2; r.upper68 = r.point + 3; r.upper95 = r.point + 4;
});
assert(get(offCenter)[2].rows.every((r) => r.point !== null && r.lower95 > r.point && r.var975Pct === 0));
const legacy = fixture(); legacy.model_c.horizons = legacy.model_c.horizons.filter((r) => r.horizon_months !== 9);
assert.equal(get(legacy)[2].rows[2].point, null); assert(get(legacy)[2].rows[0].point !== null);
const noCInterval = fixture(); noCInterval.model_c.horizons.forEach((r) => {
  r.n_calibration = 23; for (const key of ["lower68", "upper68", "lower95", "upper95"]) r[key] = null;
});
assert(get(noCInterval)[2].rows.every((r) => r.point !== null && r.lower95 === null && r.var975Pct === null));

const state = { consensus: { "2026-Q4": [null, -1], "2027-Q1": [1400], "2027-Q2": [1300, 1500], "2027-Q3": [1450, 1450] } };
const con = get(fixture(), state)[3];
assert.deepEqual(Array.from(con.rows, (r) => r.quarterKey), ["2026-Q4", "2027-Q1", "2027-Q2", "2027-Q3"]);
assert.equal(con.rows[0].point, null); assert.equal(con.rows[1].point, 1400); assert.equal(con.rows[1].lower, null);
near(con.rows[2].point, 1400); near(con.rows[2].lower, 1300); near(con.rows[2].upper, 1500);
near(con.rows[3].lower, 1450); near(con.rows[3].upper, 1450);
assert(con.rows.every((r) => r.var975Pct === null && r.lower95 === null && r.varReason.includes("응답 분산")));
const rollover = get(fixture(), state, view, new Date("2026-12-31T16:00:00Z"))[3];
assert.equal(rollover.rows[0].quarterKey, "2027-Q1");
const before = JSON.stringify(fixture()), stable = fixture(), stableState = clone(state), stableView = { ...view };
get(stable, stableState, stableView);
assert.equal(JSON.stringify(stable), before); assert.deepEqual(stableState, state); assert.deepEqual(stableView, view);
assert(get({})[0].rows.every((r) => r.point === null));
if (process.env.SUMMARY_FX_PUBLISHED) {
  const actual = JSON.parse(fs.readFileSync(process.env.SUMMARY_FX_PUBLISHED, "utf8"));
  const result = get(actual, {}, view, new Date("2026-10-31T00:00:00Z"));
  assert(result[0].rows.every((r) => r.point !== null));
  assert(result[1].rows.every((r) => r.point === null));
  assert(result[2].rows.filter((r) => r.horizonMonths !== 9).every((r) => r.point !== null));
}
console.log(JSON.stringify({ markovAnchorsAndVaR: true, actualDatesAndExpiredTargets: true,
  sameHorizonErrorQuantiles: true, noFutureLeakage: true, noWindowOrHorizonSubstitution: true,
  minCalibrationAndStaleOrigin: true, cDirectHorizonsAndLegacy: true, offCenterIntervals: true,
  consensusSpreadNotVaR: true, seoulQuarterRollover: true, noMutation: true }));
