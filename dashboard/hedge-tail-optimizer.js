/* Monthly empirical ES policy. Percent losses, annual carry stress in %p,
   one-off trading charge in basis points of changed hedge notional. */
"use strict";

const hedgeModelCDefaults = Object.freeze({ currentHedgePct: 50, minHedgePct: 0,
  maxHedgePct: 100, maxTurnoverPp: 100, tradeCostBps: 10, carryStressPp: 0 });

function hedgeModelCValidateOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    return { valid: false, reason: "모형 C 입력 형식을 확인하십시오." };
  const value = { ...hedgeModelCDefaults, ...options };
  if (!Object.keys(hedgeModelCDefaults).every((key) => Number.isFinite(value[key])))
    return { valid: false, reason: "모든 모형 C 입력에 유효한 숫자가 필요합니다." };
  for (const key of ["currentHedgePct", "minHedgePct", "maxHedgePct", "maxTurnoverPp"])
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100)
      return { valid: false, reason: "헤지비율·조정 한도는 0~100의 정수(1%p 격자)로 입력하십시오." };
  if (value.minHedgePct > value.maxHedgePct)
    return { valid: false, reason: "최소 헤지비율은 최대 헤지비율 이하여야 합니다." };
  if (value.tradeCostBps < 0 || value.tradeCostBps > 500 || value.carryStressPp < 0 || value.carryStressPp > 20)
    return { valid: false, reason: "조정비용은 0~500bp, 캐리 악화는 연 0~20%p로 입력하십시오." };
  if (Math.max(value.minHedgePct, value.currentHedgePct - value.maxTurnoverPp) >
      Math.min(value.maxHedgePct, value.currentHedgePct + value.maxTurnoverPp))
    return { valid: false, reason: "헤지비율 제약과 조정 한도를 동시에 충족하는 비율이 없습니다." };
  return { valid: true, value };
}

function hedgeModelCCompute(outlook, options = {}) {
  const inactive = (reason) => ({ active: false, reason });
  const checked = hedgeModelCValidateOptions(options);
  if (!checked.valid) return inactive(checked.reason);
  const settings = checked.value;
  if (!outlook || outlook.active !== true) return inactive(outlook?.reason || "현재 채권·환율 자료가 필요합니다.");
  if (!Number.isFinite(outlook.yield_pct) || !Number.isFinite(outlook.cost?.mean_pct) ||
      outlook.cost.source !== "HP" || outlook.cost.unit !== "pct_pa" || outlook.cost.sign !== "positive_received")
    return inactive("현재 금리·HP 캐리의 단위와 수취 부호를 확인할 수 없습니다.");
  const tail = outlook.tail_risk;
  if (!tail || tail.active !== true)
    return inactive(tail?.reason || "모형 C 꼬리위험 산출물 필요 · 데이터 갱신 후 이용할 수 있습니다.");
  if (tail.version !== 1 || tail.horizon_months !== 1 || tail.confidence !== .95 ||
      tail.unit !== "monthly_loss_pct" || tail.grid_step_pct !== 1 ||
      tail.method !== "centered_historical_joint_shocks" || tail.asof !== outlook.asof)
    return inactive("모형 C 기준일·월간 ES95 산출 계약을 확인할 수 없습니다.");
  const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  if (!validDate(tail.asof) || ![tail.full, tail.recent].every((sample) => sample &&
      Number.isInteger(sample.n_months) && sample.n_months >= 120 &&
      Number.isFinite(sample.tail_mass) && Math.abs(sample.tail_mass - sample.n_months * .05) < 1e-8 &&
      validDate(sample.start) && validDate(sample.end) && sample.start <= sample.end && sample.end < tail.asof) ||
      tail.recent.n_months !== 120 || tail.recent.end !== tail.full.end || tail.recent.start < tail.full.start)
    return inactive("ES95의 최소 120개 월간 표본과 표본기간을 확인할 수 없습니다.");
  if (!Array.isArray(tail.grid) || tail.grid.length !== 101 || !tail.grid.every((row, i) =>
      row && row.hedge_pct === i && [row.full_es_pct, row.recent_es_pct, row.robust_es_pct].every(Number.isFinite) &&
      Math.abs(row.robust_es_pct - Math.max(row.full_es_pct, row.recent_es_pct)) <= 1e-9 * Math.max(1, Math.abs(row.robust_es_pct))))
    return inactive("모형 C 꼬리손실 격자의 누락·단위·최악창 집계를 확인하십시오.");
  const grid = tail.grid.map((row) => {
    const h = row.hedge_pct / 100, turnoverPp = Math.abs(row.hedge_pct - settings.currentHedgePct);
    const stressPct = h * settings.carryStressPp / 12;
    const fullEsPct = row.full_es_pct + stressPct, recentEsPct = row.recent_es_pct + stressPct;
    const robustEsPct = Math.max(fullEsPct, recentEsPct);
    const tradeCostPct = settings.tradeCostBps / 100 * turnoverPp / 100;
    return { hedgePct: row.hedge_pct, fullEsPct, recentEsPct, robustEsPct, tradeCostPct,
      objectivePct: robustEsPct + tradeCostPct, turnoverPp,
      feasible: row.hedge_pct >= settings.minHedgePct && row.hedge_pct <= settings.maxHedgePct &&
        turnoverPp <= settings.maxTurnoverPp };
  });
  const feasible = grid.filter((row) => row.feasible);
  if (!feasible.length) return inactive("실행 가능한 헤지비율이 없습니다.");
  const minimum = Math.min(...feasible.map((row) => row.objectivePct));
  const tolerance = 1e-10 * Math.max(1, Math.abs(minimum));
  const ties = feasible.filter((row) => row.objectivePct <= minimum + tolerance)
    .sort((a, b) => a.turnoverPp - b.turnoverPp || a.hedgePct - b.hedgePct);
  return { active: true, options: { ...settings }, grid, optimal: ties[0],
    current: grid[settings.currentHedgePct], unhedged: grid[0], halfHedge: grid[50], fullHedge: grid[100],
    identified: ties.length === 1, tieCount: ties.length,
    meta: { asof: tail.asof, confidence: tail.confidence, horizonMonths: 1, gridStepPct: 1,
      full: { ...tail.full }, recent: { ...tail.recent }, statisticalOrthogonality: "unverified",
      costTiming: "one_off_at_rebalance", carryStressPp: settings.carryStressPp } };
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { hedgeModelCDefaults, hedgeModelCValidateOptions, hedgeModelCCompute };
