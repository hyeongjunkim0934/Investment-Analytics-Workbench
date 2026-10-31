"use strict";
const assert = require("node:assert/strict");
const { summaryHedgeDate, summaryHedgeModels } = require("../dashboard/summary-hedge.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const modelsAt = (payload, options = {}, market = "UST", nowDate = new Date("2026-11-01T00:00:00Z")) =>
  summaryHedgeModels(payload, options, market, nowDate);
const payload = { bond_analytics: { UST: { outlook: {
  active: true, asof: "2026-10-31", yield_pct: 4,
  cost: { mean_pct: -1, source: "HP", sign: "positive_received", unit: "pct_pa" },
  sample: { n_months: 120 },
  risk: { cov_unit: "decimal_return_squared", labels: ["bond", "fx"],
    cov_annual: [[.0064, -.003], [-.003, .01]] },
} } } };
const options = { UST: { riskAversion: 5, fxPct: 0, currentHedgePct: 50,
  minHedgePct: 0, maxHedgePct: 80 } };
const before = JSON.stringify([payload, options]);
const models = modelsAt(payload, options);
assert.equal(JSON.stringify([payload, options]), before, "pure adapter must not mutate inputs");
assert.deepEqual(models.map((model) => model.key), ["modelA", "modelB", "modelC"]);
assert(models.every((model) => model.rows.length === 4 && model.active));
assert.deepEqual(models[0].rows.map((row) => row.targetDate),
  ["2027-01-31", "2027-04-30", "2027-07-31", "2027-10-31"]);
assert.equal(models[0].hedgePct, 100);
assert.equal(models[0].feasible, false);
assert(models[0].constraintLabel.includes("제약 밖"));
assert(Math.abs(models[1].hedgePct - 50) < 1e-10);
assert.equal(models[2].hedgePct, 70);
assert(models[0].description.includes("미래 헤지비용을 예측하지 않습니다"));
assert(models[2].description.includes("신규 비교 기준"));
assert(models.every((model) => model.notes.some((note) => note.includes("헤지비율의 신뢰구간이 아닙니다"))));
assert(models.every((model) => model.intervalLabel === "정규근사 95%"
  && model.rows.every((row) => row.intervalLabel === "정규근사 95%")));
assert.equal(summaryHedgeDate("2024-02-29", 12), "2025-02-28");
assert.equal(summaryHedgeDate("2026-12-31", 3), "2027-03-31");
assert.equal(summaryHedgeDate("2026-01-31", 1), "2026-02-28");
assert.equal(summaryHedgeDate("2026-02-30", 3), null);
assert.equal(summaryHedgeDate("2026-1-01", 3), null);
assert.equal(summaryHedgeDate("2026-10-31", -3), null);

const unavailable = (rows) => rows.every((model) => !model.active && model.reason
  && model.hedgePct === null && model.rows.every((row) => !row.active
    && row.meanPct === null && row.lower95 === null && row.upper95 === null && row.var975Pct === null));
assert(unavailable(modelsAt(null)));
assert(unavailable(modelsAt(payload, options, "unknown")));
assert(unavailable(modelsAt(payload, { UST: null })));
for (const mutate of [
  (p) => { p.bond_analytics.UST.outlook.asof = "not-a-date"; },
  (p) => { p.bond_analytics.UST.outlook.asof = "2026-02-30"; },
  (p) => { p.bond_analytics.UST.outlook.cost.mean_pct = null; },
  (p) => { p.bond_analytics.UST.outlook.cost.sign = "positive_paid"; },
  (p) => { p.bond_analytics.UST.outlook.risk.cov_annual = [[1, 2], [2, 1]]; },
  (p) => { p.bond_analytics.UST.outlook.sample.n_months = 35; },
]) {
  const bad = clone(payload); mutate(bad);
  assert(unavailable(modelsAt(bad, options)));
}

// A covariance tie does not identify the optimizer's endpoint as a unique ratio.
const flat = clone(payload);
flat.bond_analytics.UST.outlook.risk.cov_annual = [[.0064, 0], [0, 0]];
const tied = modelsAt(flat, options);
assert.equal(tied[2].identified, false);
assert.equal(tied[2].hedgePct, null);
assert.equal(tied[2].active, false, "different tied means must not become an arbitrary forecast");
assert(tied[2].rows.every((row) => row.meanPct === null));
flat.bond_analytics.UST.outlook.cost.mean_pct = 0;
const invariant = modelsAt(flat, options);
assert(invariant.slice(1).every((model) => model.active && !model.identified && model.hedgePct === null));
assert(invariant.slice(1).every((model) => model.rows.every((row) => row.meanPct === row.horizonMonths / 3)));

// Zero variance is deterministic; positive expected returns imply zero loss VaR.
flat.bond_analytics.UST.outlook.risk.cov_annual = [[0, 0], [0, 0]];
const zero = modelsAt(flat, { UST: { minHedgePct: 30, maxHedgePct: 30 } });
assert(zero.every((model) => model.rows.every((row) => row.lower95 === row.meanPct
  && row.upper95 === row.meanPct && row.var975Pct === 0)));
assert(zero.slice(1).every((model) => model.hedgePct === 30 && model.identified));
// At Seoul midnight the expired target disappears, while later targets remain.
const beforeDeadline = modelsAt(payload, options, "UST", new Date("2027-01-30T14:59:59Z"));
assert(beforeDeadline.every((model) => model.rows[0].active));
const atDeadline = modelsAt(payload, options, "UST", new Date("2027-01-30T15:00:00Z"));
assert(atDeadline.every((model) => model.active && !model.rows[0].active
  && model.rows[0].reason === "목표일 경과 · 새 전망 필요"
  && model.rows[0].hedgePct === null && model.rows[0].point === null
  && model.rows[0].lower95 === null && model.rows[0].upper95 === null && model.rows[0].var975Pct === null
  && model.rows.slice(1).every((row) => row.active)));
const expired = modelsAt(payload, options, "UST", new Date("2027-10-30T15:00:00Z"));
assert(unavailable(expired));
assert(expired.every((model) => model.reason === "목표일 경과 · 새 전망 필요"
  && model.annualCarryPct === null && model.annualPremiumPct === null
  && model.annualMeanPct === null && model.annualVolPct === null));
assert(unavailable(modelsAt(payload, options, "UST", new Date("invalid"))));
console.log(JSON.stringify({ pass: true, dates: true, units: true, missing: true,
  invalid: true, pure: true, constraints: true, ties: true, zeroVariance: true, stale: true, seoulMidnight: true }));
