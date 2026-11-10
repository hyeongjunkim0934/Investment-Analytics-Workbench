/* Shared display-time lifecycle. Forecasts stay frozen; only exact target
   observations may turn a historical forecast into a realized evaluation. */
"use strict";

function fxForecastToday(now = new Date()) {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value).map(({ type, value: part }) => [type, part]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 1000;
}

function fxForecastStatus(target, point, history, lower = null, upper = null,
    today = fxForecastToday(), publishedActual = null) {
  const validTime = Number.isFinite(target) && Number.isFinite(today);
  const expired = validTime && Math.floor(target / 86400) * 86400 <= today;
  let actual = null;
  if (expired) {
    // Published B actuals belong to their exact target-month label by contract.
    if (Number.isFinite(publishedActual) && publishedActual > 0) actual = publishedActual;
    else if (Array.isArray(history?.t) && Array.isArray(history?.v)) {
      const i = history.t.indexOf(target);
      if (i >= 0 && Number.isFinite(history.v[i]) && history.v[i] > 0) actual = history.v[i];
    }
  }
  const error = actual !== null && Number.isFinite(point) ? point - actual : null;
  const covered = actual !== null && Number.isFinite(lower) && Number.isFinite(upper) && lower <= upper
    ? actual >= lower && actual <= upper : null;
  const state = !validTime ? "invalid" : !expired ? "future" : actual === null ? "expired_pending" : "realized";
  const label = state === "invalid" ? "목표일 확인 필요" : state === "future" ? "예측"
    : actual === null ? "목표일 경과 · 당시 전망 · 실현 대기" : "목표일 경과 · 당시 전망 · 실현 평가";
  return { state, label, expired, actual, error, covered, target };
}

function fxForecastEvaluationText(status, number) {
  if (status.actual === null) return "";
  return `실현 ${number(status.actual)}원 · 오차 ${status.error >= 0 ? "+" : ""}${number(status.error)}원`
    + (status.covered === null ? "" : ` · 95% 구간 ${status.covered ? "내" : "밖"}`);
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { fxForecastToday, fxForecastStatus, fxForecastEvaluationText };
