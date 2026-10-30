/* Single-market currency hedge allocation. Inputs are the already-published
   bond/FX annual covariance and current signed HP carry; no return forecast is
   fitted here. Percent display inputs are converted to decimal returns once. */
"use strict";

const hedgeModelBDefaults = Object.freeze({
  riskAversion: 5, fxPct: 0, currentHedgePct: 50, minHedgePct: 0, maxHedgePct: 100,
});

function hedgeModelBValidateOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    return { valid: false, reason: "모형 입력 형식을 확인하십시오." };
  const value = { ...hedgeModelBDefaults, ...options };
  if (!Object.keys(hedgeModelBDefaults).every((key) => Number.isFinite(value[key])))
    return { valid: false, reason: "모든 모형 입력에 유효한 숫자가 필요합니다." };
  if (!(value.riskAversion > 0 && value.riskAversion <= 100))
    return { valid: false, reason: "위험회피계수는 0 초과 100 이하로 입력하십시오." };
  if (Math.abs(value.fxPct) > 50)
    return { valid: false, reason: "예상 환율변화는 −50% ~ 50% 범위로 입력하십시오." };
  if (value.currentHedgePct < 0 || value.currentHedgePct > 100)
    return { valid: false, reason: "현재 헤지비율은 0% ~ 100% 범위로 입력하십시오." };
  if (value.minHedgePct < 0 || value.maxHedgePct > 100 || value.minHedgePct > value.maxHedgePct)
    return { valid: false, reason: "헤지비율 제약은 0% ≤ 하한 ≤ 상한 ≤ 100%여야 합니다." };
  return { valid: true, value };
}

function hedgeModelBCompute(outlook, options = {}) {
  const inactive = (reason) => ({ active: false, reason });
  const validated = hedgeModelBValidateOptions(options);
  if (!validated.valid) return inactive(validated.reason);
  const settings = validated.value;
  if (!outlook || outlook.active !== true)
    return inactive(outlook?.reason || "유효한 채권·환율 공분산과 현재 HP 헤지비용이 필요합니다.");
  if (!Number.isFinite(outlook.yield_pct) || !Number.isFinite(outlook.cost?.mean_pct))
    return inactive("현재 채권금리·헤지비용의 유효한 숫자가 필요합니다.");
  if (outlook.cost.source !== "HP" || outlook.cost.sign !== "positive_received" || outlook.cost.unit !== "pct_pa")
    return inactive("헤지비용의 HP 원천·연율·수취/지불 부호를 확인할 수 없습니다.");
  if (!Number.isInteger(outlook.sample?.n_months) || outlook.sample.n_months < 36)
    return inactive("공통 월간 위험표본 최소 36개가 필요합니다.");
  const risk = outlook.risk;
  if (!risk || risk.cov_unit !== "decimal_return_squared" ||
      !Array.isArray(risk.labels) || risk.labels.length !== 2 || risk.labels[0] !== "bond" || risk.labels[1] !== "fx")
    return inactive("채권·환율 공분산의 순서와 단위를 확인할 수 없습니다.");
  const C = risk.cov_annual;
  if (!Array.isArray(C) || C.length !== 2 ||
      !C.every((row) => Array.isArray(row) && row.length === 2 && row.every(Number.isFinite)))
    return inactive("유효한 2×2 연율 공분산이 필요합니다.");
  const scale = Math.max(...C.flat().map(Math.abs));
  const tolerance = scale * 1e-12;
  if (C[0][0] < -tolerance || C[1][1] < -tolerance || Math.abs(C[0][1] - C[1][0]) > tolerance)
    return inactive("공분산의 비음수 분산·대칭 조건이 충족되지 않습니다.");
  const bb = Math.max(0, C[0][0]), ff = Math.max(0, C[1][1]);
  let bf = C[0][1] / 2 + C[1][0] / 2;
  const bound = Math.sqrt(bb) * Math.sqrt(ff);
  if (Math.abs(bf) > bound + tolerance)
    return inactive("공분산의 양의 준정부호 조건이 충족되지 않습니다.");
  // Only project machine-scale Cauchy-bound violations, never repair a materially
  // indefinite estimate. This also enforces zero covariance if either variance is zero.
  bf = Math.max(-bound, Math.min(bound, bf));
  const y = outlook.yield_pct / 100, carry = outlook.cost.mean_pct / 100;
  const fx = settings.fxPct / 100, lambda = settings.riskAversion;
  const lo = settings.minHedgePct / 100, hi = settings.maxHedgePct / 100;
  const clamp = (h) => Math.max(lo, Math.min(hi, h));
  const variance = (h) => {
    const w = 1 - h;
    const raw = bb + 2 * w * bf + w * w * ff;
    return raw < 0 && raw >= -4 * tolerance ? 0 : raw;
  };
  const unhedgedVariance = variance(0);
  if (!Number.isFinite(unhedgedVariance) || unhedgedVariance < 0)
    return inactive("공분산으로 계산한 위험이 유효하지 않습니다.");
  const unhedgedVol = Math.sqrt(unhedgedVariance) * 100;
  const evaluate = (h, fxScenario = fx) => {
    const v = variance(h), mean = y + (1 - h) * fxScenario + h * carry;
    const vol = Math.sqrt(v) * 100;
    return { hedgePct: h * 100, meanPct: mean * 100, volPct: vol,
      carryPct: h * carry * 100, cePct: (mean - lambda * v / 2) * 100,
      riskReductionPp: unhedgedVol - vol,
      feasible: h >= lo - 1e-12 && h <= hi + 1e-12,
      boundary: Math.abs(h - lo) < 1e-12 && Math.abs(h - hi) < 1e-12 ? "fixed"
        : Math.abs(h - lo) < 1e-12 ? "lower" : Math.abs(h - hi) < 1e-12 ? "upper" : null };
  };
  const minUnconstrained = ff > 0 ? 1 + bf / ff : null;
  const minH = ff > 0 ? clamp(minUnconstrained) : lo;
  const optUnconstrained = ff > 0 ? 1 + bf / ff + (carry - fx) / (lambda * ff) : null;
  const optimalH = (fxScenario) => ff > 0
    ? clamp(1 + bf / ff + (carry - fxScenario) / (lambda * ff))
    : carry > fxScenario ? hi : lo;
  const current = evaluate(settings.currentHedgePct / 100);
  const minVariance = evaluate(minH), optimal = evaluate(optimalH(fx));
  const grid = Array.from({ length: 101 }, (_, i) => evaluate(i / 100));
  const sensitivity = [-2, -1, 0, 1, 2].map((delta) => {
    const scenario = (settings.fxPct + delta) / 100;
    return { fxPct: settings.fxPct + delta, ...evaluate(optimalH(scenario), scenario),
      optimalIdentified: ff > 0 || lo === hi || carry !== scenario };
  });
  const allResults = [current, minVariance, optimal, ...grid, ...sensitivity];
  if (!allResults.every((r) => [r.hedgePct, r.meanPct, r.volPct, r.carryPct, r.cePct, r.riskReductionPp].every(Number.isFinite)))
    return inactive("입력의 크기가 수치 계산 범위를 초과합니다.");
  return { active: true, options: { ...settings },
    input: { yieldPct: outlook.yield_pct, carryPct: outlook.cost.mean_pct, fxPct: settings.fxPct,
      covAnnual: [[bb, bf], [bf, ff]], correlation: bound > 0 ? bf / bound : null },
    sample: { ...outlook.sample },
    meta: { asof: outlook.asof || null, yieldAsOf: outlook.yield_asof || null,
      costAsOf: outlook.cost.asof || null, durationYears: outlook.duration_years ?? null,
      sources: outlook.sources || {}, flatFxRisk: ff === 0,
      minVarianceIdentified: ff > 0 || lo === hi,
      optimalIdentified: ff > 0 || lo === hi || carry !== fx },
    current, minVariance, optimal, unhedged: grid[0], fullHedge: grid[100], grid, sensitivity,
    unconstrained: { minVariancePct: minUnconstrained !== null && Number.isFinite(minUnconstrained * 100) ? minUnconstrained * 100 : null,
      optimalPct: optUnconstrained !== null && Number.isFinite(optUnconstrained * 100) ? optUnconstrained * 100 : null } };
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { hedgeModelBDefaults, hedgeModelBValidateOptions, hedgeModelBCompute };
