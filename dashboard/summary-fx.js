/* Read published forecasts without refitting, interpolation, or shared model assumptions. */
"use strict";

const SUMMARY_FX_HORIZONS = Object.freeze([3, 6, 9, 12]);

function summaryFxDate(t) {
  return Number.isFinite(t) && Number.isFinite(new Date(t * 1000).getTime())
    ? new Date(t * 1000).toISOString().slice(0, 10) : null;
}

function summaryFxVaR975(lower, anchor) {
  if (!(Number.isFinite(lower) && lower > 0 && Number.isFinite(anchor) && anchor > 0)) return null;
  const loss = (1 - lower / anchor) * 100;
  return Number.isFinite(loss) ? Math.max(0, loss) : null;
}

function summaryFxQuantile(values, p) {
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)
      || !Number.isFinite(p) || p < 0 || p > 1) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  const lo = Math.floor(index), fraction = index - lo;
  return sorted[lo] * (1 - fraction) + sorted[Math.ceil(index)] * fraction;
}

function summaryFxEmptyRow(horizonMonths, reason, extra = {}) {
  return { horizonMonths, targetDate: null, anchorDate: null, anchorValue: null,
    point: null, lower: null, upper: null, lower95: null, upper95: null, var975Pct: null,
    sampleCount: null, reason, intervalReason: reason, varReason: reason, ...extra };
}

function summaryFxPointRow(horizonMonths, anchor, target, point, lower, upper, today, extra = {}) {
  const dates = { anchorDate: summaryFxDate(anchor?.t), anchorValue: anchor?.v ?? null,
    targetDate: summaryFxDate(target) };
  if (!dates.targetDate || !(target > anchor?.t) || !(Number.isFinite(point) && point > 0))
    return summaryFxEmptyRow(horizonMonths, "전망 시점·값 확인 필요", { ...dates, ...extra });
  if (target <= today)
    return summaryFxEmptyRow(horizonMonths, "목표일 경과 · 새 전망 필요", { ...dates, ...extra });
  const hasBounds = Number.isFinite(lower) && lower > 0 && Number.isFinite(upper) && upper >= lower;
  return { ...summaryFxEmptyRow(horizonMonths, null), ...dates, ...extra, point,
    lower: hasBounds ? lower : null, upper: hasBounds ? upper : null,
    lower95: hasBounds ? lower : null, upper95: hasBounds ? upper : null,
    var975Pct: hasBounds ? summaryFxVaR975(lower, anchor?.v) : null,
    intervalReason: hasBounds ? null : extra.intervalReason || "구간 보정 표본 부족",
    varReason: hasBounds ? null : "예측구간 미산출" };
}

function summaryFxModelA(fx, today) {
  const p = fx?.markov;
  const model = { key: "modelA", label: "환율모형 A", pointLabel: "평균", unit: "원/달러",
    anchorDate: summaryFxDate(p?.anchor?.t), anchorValue: p?.anchor?.v ?? null,
    basis: "Markov Monte Carlo", intervalLabel: "예측 95%", details: [
      "3·6·9·12개월은 63·126·189·252 모형 거래일입니다. 실제 목표일을 함께 표시합니다.",
      "구간은 시점별 조건부 분위수이며 모수 추정 불확실성과 경로 전체의 동시 포함확률은 반영하지 않습니다.",
      "VaR 97.5%는 기준일에 보유한 달러의 원화가치 손실률입니다. 환율 하단 2.5% 분위수를 사용하고 이익만 예상되면 0%로 표시합니다.",
    ] };
  if (typeof fxMarkovValid !== "function" || !fxMarkovValid(p, fx?.outlook)) {
    const reason = p?.active ? "모형 데이터·최근 관측 불일치" : p?.reason || "모형 산출물 없음";
    return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => summaryFxEmptyRow(h, reason)) };
  }
  const s = p.simulation;
  return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => {
    const i = h * 21;
    return summaryFxPointRow(h, p.anchor, s.t[i], s.mean[i], s.lower95[i], s.upper95[i], today,
      { sampleCount: s.path_count, median: s.median[i] });
  }) };
}

function summaryFxModelB(fx, view, today) {
  const p = fx?.lstm_xgb;
  const model = { key: "modelB", label: "환율모형 B", pointLabel: "예상치", unit: "원/달러",
    anchorDate: null, anchorValue: null, basis: "LSTM · XGBoost", intervalLabel: "과거오차 95%", details: [
      "게시된 동일 학습창·선택 모형의 3·6·9·12개월 직접 전망만 사용합니다. 없는 지평은 보간하지 않습니다.",
      "선택 학습창의 최신 기준일로 맞춥니다. 최신 기준일 전망이 없는 지평과 목표일이 지난 전망은 표시하지 않습니다.",
      "구간은 전망 기준일까지 실현된 동일 지평의 로그 오차 log(실제/예측)의 2.5·97.5% 분위수로 보정합니다. 최소 24개가 필요하며 미래 포함률을 보장하지 않습니다.",
      "VaR 97.5%는 모형 기준 환율 대비 달러 보유자의 원화 환손실률입니다. 과거오차의 시계열 의존성과 모수 불확실성은 별도로 추정하지 않습니다.",
    ] };
  const valid = typeof fxLxValid === "function" ? fxLxValid(p) : { ok: false, reason: "모형 모듈 없음" };
  const unavailable = (reason) => ({ ...model,
    rows: SUMMARY_FX_HORIZONS.map((h) => summaryFxEmptyRow(h, reason)) });
  if (!valid.ok) return unavailable(valid.reason);
  const chosen = view || (typeof fxLxDefaultView === "function" ? fxLxDefaultView(p, valid) : null);
  if (!chosen || !valid.windows.includes(chosen.window) || !["ensemble", "lstm", "xgb"].includes(chosen.model))
    return unavailable("선택된 학습창·모형 산출물 없음");
  const combos = p.combos.filter((c) => c.window === chosen.window && SUMMARY_FX_HORIZONS.includes(c.lag));
  if (!combos.length) return unavailable("선택 학습창의 분기 전망 없음");
  const origin = Math.max(...combos.map((c) => c.t_base.at(-1)));
  const newest = combos.find((c) => c.t_base.at(-1) === origin);
  const anchor = { t: origin, v: newest.base.at(-1) };
  const name = { ensemble: "앙상블", lstm: "LSTM", xgb: "XGBoost" }[chosen.model];
  model.anchorDate = summaryFxDate(origin); model.anchorValue = anchor.v;
  model.basis = `${name} · 학습창 ${chosen.window}개월`;
  return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => {
    const c = combos.find((item) => item.lag === h);
    const dates = { anchorDate: model.anchorDate, anchorValue: anchor.v };
    if (!c) return summaryFxEmptyRow(h, `${h}개월 산출물 없음`, dates);
    const i = c.t_base.indexOf(origin);
    if (i < 0 || c.base[i] !== anchor.v)
      return summaryFxEmptyRow(h, "최신 공통 기준일 전망 없음", dates);
    if (c.actual[i] !== null)
      return summaryFxEmptyRow(h, "이미 실현된 전망", { ...dates, targetDate: summaryFxDate(c.t_target[i]) });
    const errors = c.t_base.flatMap((baseTime, j) => baseTime < origin && c.t_target[j] <= origin
      && c.actual[j] !== null ? [Math.log(c.actual[j]) - Math.log(c.pred[chosen.model][j])] : []);
    const enough = errors.length >= 24 && errors.every(Number.isFinite);
    const point = c.pred[chosen.model][i];
    const low = enough ? Math.exp(Math.log(point) + summaryFxQuantile(errors, .025)) : null;
    const high = enough ? Math.exp(Math.log(point) + summaryFxQuantile(errors, .975)) : null;
    return summaryFxPointRow(h, anchor, c.t_target[i], point, low, high, today,
      { sampleCount: errors.length, intervalReason: enough ? "구간 수치 범위 초과" : "과거 실현오차 24개 미만" });
  }) };
}

function summaryFxModelC(fx, today) {
  const p = fx?.model_c;
  const model = { key: "modelC", label: "환율모형 C", pointLabel: "로그 중심", unit: "원/달러",
    anchorDate: summaryFxDate(p?.anchor?.t), anchorValue: p?.anchor?.v ?? null,
    basis: "금리차 · 모멘텀 · 축소추정", intervalLabel: "과거오차 95%", details: [
      "3·6·9·12개월별 직접 추정치를 사용합니다. 로그 중심은 환율 수준의 산술평균이나 보장된 중앙값이 아닙니다.",
      "구간은 기준일까지 실현된 과거 예측오차로 보정한 경험 분위수입니다. 예측력과 미래 포함률을 보장하지 않습니다.",
      "VaR 97.5%는 모형 기준 환율 대비 달러 보유자의 원화 환손실률이며 하단 2.5% 분위수를 사용합니다.",
    ] };
  if (typeof fxModelCValid !== "function" || !fxModelCValid(p)) {
    const reason = p?.active ? "모형 데이터·시점 확인 필요" : p?.reason || "모형 산출물 없음";
    return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => summaryFxEmptyRow(h, reason)) };
  }
  return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => {
    const row = p.horizons.find((r) => r.horizon_months === h);
    const dates = { anchorDate: model.anchorDate, anchorValue: model.anchorValue,
      targetDate: summaryFxDate(row?.target_t) };
    if (!row?.active) return summaryFxEmptyRow(h, row?.reason || `${h}개월 산출물 없음`, dates);
    return summaryFxPointRow(h, p.anchor, row.target_t, row.point, row.lower95, row.upper95, today,
      { sampleCount: row.n_calibration });
  }) };
}

function summaryFxConsensus(fx, state, today) {
  const history = typeof fxOutlookHistory === "function" ? fxOutlookHistory(fx?.outlook) : { t: [], v: [] };
  const anchor = { t: history.t.at(-1), v: history.v.at(-1) };
  const model = { key: "consensus", label: "컨센서스", pointLabel: "응답 평균", unit: "원/달러",
    anchorDate: summaryFxDate(anchor.t), anchorValue: anchor.v ?? null,
    basis: "다음 4개 분기말", intervalLabel: "응답 ±1σ", details: [
      "컨센서스는 서울 기준 오늘 이후 4개 달력 분기말의 저장된 응답 평균입니다. 모형의 기준일 이후 3·6·9·12개월 목표일과 다를 수 있습니다.",
      "범위는 응답 간 모집단 표준편차 ±1σ이며 미래 환율의 예측구간이 아닙니다. 단일 응답에는 범위를 산출하지 않습니다.",
      "응답 분산만으로 환손실 확률을 추정할 수 없어 컨센서스 VaR는 산출하지 않습니다.",
    ] };
  if (typeof fxOutlookQuarters !== "function" || typeof fxOutlookMoments !== "function")
    return { ...model, rows: SUMMARY_FX_HORIZONS.map((h) => summaryFxEmptyRow(h, "컨센서스 모듈 없음")) };
  const quarters = fxOutlookQuarters(anchor.t, today, 4);
  return { ...model, rows: quarters.map((q, i) => {
    const response = state?.consensus?.[q.key];
    const moments = fxOutlookMoments(Array.isArray(response) ? response : []);
    const point = Number.isFinite(moments.mean) ? moments.mean : null;
    const hasBounds = point !== null && Number.isFinite(moments.sigma)
      && Number.isFinite(point - moments.sigma) && Number.isFinite(point + moments.sigma);
    const reason = point === null ? "컨센서스 미입력" : null;
    return { ...summaryFxEmptyRow(SUMMARY_FX_HORIZONS[i], reason),
      targetDate: summaryFxDate(q.t), quarterKey: q.key, quarterLabel: q.label,
      anchorDate: model.anchorDate, anchorValue: model.anchorValue, point,
      lower: hasBounds ? point - moments.sigma : null, upper: hasBounds ? point + moments.sigma : null,
      sampleCount: moments.n, intervalReason: hasBounds ? null : reason || "응답 2개 이상 필요",
      varReason: "응답 분산만으로 VaR 산출 불가" };
  }) };
}

function summaryFxModels(fxPayload, consensusState, viewB, nowDate = new Date()) {
  const today = typeof fxOutlookToday === "function" ? fxOutlookToday(nowDate)
    : Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()) / 1000;
  return [summaryFxModelA(fxPayload, today), summaryFxModelB(fxPayload, viewB, today),
    summaryFxModelC(fxPayload, today), summaryFxConsensus(fxPayload, consensusState, today)];
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { summaryFxModels, summaryFxQuantile, summaryFxVaR975 };
