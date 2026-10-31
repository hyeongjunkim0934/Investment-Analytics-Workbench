/* Conditional cumulative bond/FX returns at four horizons. The hedge choices
   are held fixed; these intervals are not confidence bands for hedge ratios. */
"use strict";

const SUMMARY_HEDGE_HORIZONS = Object.freeze([3, 6, 9, 12]);
const SUMMARY_HEDGE_Z975 = 1.959963984540054;

function summaryHedgeDate(asof, months) {
  if (typeof asof !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asof)
      || !Number.isInteger(months) || months < 0) return null;
  const anchor = new Date(`${asof}T00:00:00.000Z`);
  if (!Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== asof) return null;
  const target = new Date(anchor);
  const day = anchor.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(anchor.getUTCMonth() + months);
  const last = new Date(target);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(day, last.getUTCDate()));
  return Number.isFinite(target.getTime()) ? target.toISOString().slice(0, 10) : null;
}

function summaryHedgeModels(payload, optionsByMarket = {}, market = "UST", nowDate = new Date()) {
  const specs = [
    { key: "modelA", label: "환헤지모형 A", basis: "100% 헤지 기준",
      description: "기존 CIP 비교와 구분되는 100% 헤지 참고안입니다. 현재 HP 캐리를 고정하며 CIP로 미래 헤지비용을 예측하지 않습니다." },
    { key: "modelB", label: "환헤지모형 B", basis: "비용·위험 최적화",
      description: "환헤지모형 B에서 적용한 위험회피·예상 FX 변화·헤지 제약을 사용한 비용·위험 최적화안입니다." },
    { key: "modelC", label: "환헤지모형 C", basis: "최소분산 기준 · 신규",
      description: "같은 공분산과 헤지 제약에서 분산을 최소화하는 신규 비교 기준입니다. 별도 학습한 전망모형은 아닙니다." },
  ];
  const outlook = payload?.bond_analytics?.[market]?.outlook;
  const anchorDate = summaryHedgeDate(outlook?.asof, 0);
  const now = new Date(nowDate);
  const todayParts = Number.isFinite(now.getTime()) ? new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now) : [];
  const todayFields = Object.fromEntries(todayParts.map(({ type, value }) => [type, value]));
  const today = todayParts.length ? `${todayFields.year}-${todayFields.month}-${todayFields.day}` : null;
  const options = optionsByMarket && typeof optionsByMarket === "object" && !Array.isArray(optionsByMarket)
    ? (Object.hasOwn(optionsByMarket, market) ? optionsByMarket[market] : {}) : null;
  const compute = typeof hedgeModelBCompute === "function" ? hedgeModelBCompute
    : typeof module !== "undefined" && module.exports ? require("./hedge-optimizer.js").hedgeModelBCompute : null;
  const model = compute ? compute(outlook, options) : { active: false, reason: "환헤지 계산 모듈을 불러오지 못했습니다." };
  const reason = !model.active ? model.reason : !anchorDate ? "유효한 추정기준일이 필요합니다."
    : !today ? "유효한 조회기준일이 필요합니다." : null;
  const notes = [
    "예상치와 구간은 기준일 이후 누적 채권·FX 수익률(%)입니다. 헤지 프리미엄 전망이나 헤지비율의 신뢰구간이 아닙니다.",
    "현재 금리·HP 캐리·예상 FX 변화·공분산·헤지비율을 고정한 조건부 정규근사입니다. 평균은 기간에, 변동성은 기간의 제곱근에 비례합니다.",
    "시계열 자기상관·추정오차·미래 헤지비용 변화·거래비용은 구간에 반영하지 않습니다. 미래 포함률을 보장하지 않습니다.",
    "VaR 97.5%는 초기 원화 투자금 대비 누적손실의 단측 분위수이며 0을 하한으로 표시합니다. 손실의 최대치는 아닙니다.",
  ];
  return specs.map((spec) => {
    const selection = !reason ? spec.key === "modelA" ? model.fullHedge
      : spec.key === "modelB" ? model.optimal : model.minVariance : null;
    const identified = !selection ? false : spec.key === "modelA" ? true
      : spec.key === "modelB" ? model.meta.optimalIdentified : model.meta.minVarianceIdentified;
    // A flat FX variance identifies no minimum-variance ratio. When carry and
    // expected FX differ, the tied ratios imply different means: do not publish
    // the optimizer's arbitrary endpoint as a unique forecast.
    const tiedMean = selection && !identified && model.input.carryPct !== model.input.fxPct;
    const forecastReason = reason || (tiedMean ? "최소분산 헤지비율이 동률이며 기대수익도 달라 단일 전망을 산출하지 않습니다." : null);
    const rows = SUMMARY_HEDGE_HORIZONS.map((horizonMonths) => {
      const targetDate = anchorDate ? summaryHedgeDate(anchorDate, horizonMonths) : null;
      const rowReason = forecastReason || (targetDate && targetDate <= today ? "목표일 경과 · 새 전망 필요" : null);
      const years = horizonMonths / 12;
      const meanPct = !rowReason ? selection.meanPct * years : null;
      const volPct = !rowReason ? selection.volPct * Math.sqrt(years) : null;
      const lower95 = meanPct === null ? null : meanPct - SUMMARY_HEDGE_Z975 * volPct;
      const upper95 = meanPct === null ? null : meanPct + SUMMARY_HEDGE_Z975 * volPct;
      const finite = meanPct !== null && [meanPct, volPct, lower95, upper95].every(Number.isFinite);
      return { horizonMonths, targetDate, active: finite,
        hedgePct: finite && identified ? selection.hedgePct : null,
        point: finite ? meanPct : null, meanPct: finite ? meanPct : null, volPct: finite ? volPct : null,
        lower: finite ? lower95 : null, upper: finite ? upper95 : null,
        lower95: finite ? lower95 : null, upper95: finite ? upper95 : null,
        var975Pct: finite ? Math.max(0, -lower95) : null,
        carryPct: finite ? selection.carryPct * years : null,
        sampleCount: model.active ? model.sample.n_months : 0,
        intervalLabel: "정규근사 95%",
        intervalReason: finite ? null : rowReason || "분기 수익률 계산 범위를 확인할 수 없습니다.",
        varReason: finite ? null : rowReason || "분기 수익률 계산 범위를 확인할 수 없습니다.",
        reason: rowReason || (!finite ? "분기 수익률 계산 범위를 확인할 수 없습니다." : null) };
    });
    const active = rows.some((row) => row.active);
    return { ...spec, market, anchorDate, active,
      reason: forecastReason || (!active ? rows[0].reason : null), rows, identified: active && identified,
      hedgePct: active && identified ? selection.hedgePct : null,
      feasible: selection ? selection.feasible : null,
      constraintLabel: selection && !selection.feasible ? "설정한 헤지 제약 밖의 비교 기준" : null,
      uncertaintyKind: "정규근사 95%", intervalLabel: "정규근사 95%", returnUnit: "cumulative_pct", varConfidence: .975,
      annualCarryPct: active ? selection.carryPct : null,
      annualPremiumPct: active ? model.input.carryPct : null,
      annualMeanPct: active ? selection.meanPct : null,
      annualVolPct: active ? selection.volPct : null,
      assumptions: !reason ? { ...model.options } : null,
      notes: [...notes, ...(!identified && selection ? ["헤지비율의 고유해가 없어 비율을 표시하지 않습니다."] : [])],
    };
  });
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { SUMMARY_HEDGE_HORIZONS, SUMMARY_HEDGE_Z975, summaryHedgeDate, summaryHedgeModels };
