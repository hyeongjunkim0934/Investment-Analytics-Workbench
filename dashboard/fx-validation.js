/* Common historical origins/targets, never current forecast ranking or fitted weights. */
"use strict";

let fxValidationHorizon = 3;
let fxValidationOpen = false;
const FX_VALIDATION_NAMES = Object.freeze({ a: "A · 중앙값", c: "C · 로그 중심", d: "D · 방향 중립",
  rw: "랜덤워크", equal_ac_rw: "A/C/RW 동일가중", shrink_ac_rw: "A/C 25%씩 · RW 50%",
  constant: "상수분산", ewma: "EWMA" });

function fxValidationTable(horizon, kind) {
  const number = (v, digits = 2) => Number.isFinite(v) ? fmtNum(v, digits) : "—";
  const metrics = horizon?.metrics || {};
  if (kind === "point") return {
    headers: ["점예측", "N", "RMSE (원)", "MAE (원)", "RW 대비 RMSE"],
    rows: Object.entries(metrics.point || {}).map(([key, m]) =>
      [FX_VALIDATION_NAMES[key] || key, m.n, number(m.rmse), number(m.mae), number(m.theil_u_rw, 3)]),
  };
  if (kind === "interval") return {
    headers: ["95% 구간", "N", "실제 포함률 (%)", "구간점수 (원)"],
    rows: Object.entries(metrics.interval?.["95"]?.models || {}).map(([key, m]) =>
      [FX_VALIDATION_NAMES[key] || key, m.n, Number.isFinite(m.coverage) ? number(m.coverage * 100) : "—", number(m.interval_score)]),
  };
  return { headers: ["분산", "N", "QLIKE"], rows: Object.entries(metrics.variance || {}).map(([key, m]) =>
    [FX_VALIDATION_NAMES[key] || key, m.n, number(m.qlike, 4)]) };
}

function fxValidationCsv(horizon) {
  const pointKeys = ["a", "c", "d", "rw", "equal_ac_rw", "shrink_ac_rw"];
  const intervalKeys = ["a", "c", "d", "constant", "ewma"];
  return { headers: ["지평 (개월)", "기준일", "목표일", "기준 환율", "실제 환율", "모형 관측수",
      ...pointKeys.map((k) => FX_VALIDATION_NAMES[k]),
      ...intervalKeys.flatMap((k) => [`${k} 95% 하단`, `${k} 95% 상단`]), "D 분산", "상수분산", "EWMA 분산", "로그변화 제곱"],
    rows: (horizon?.rows || []).map((r) => [horizon.horizon_months, r.origin_date, r.target_date, r.base, r.actual, r.model_steps,
      ...pointKeys.map((k) => r.points?.[k] ?? null),
      ...intervalKeys.flatMap((k) => [r.intervals?.[k]?.lower95 ?? null, r.intervals?.[k]?.upper95 ?? null]),
      r.variance?.d, r.variance?.constant, r.variance?.ewma, r.variance?.realized]) };
}

function renderFxValidation(host) {
  if (!host) return;
  host.textContent = "";
  const payload = DATA.fx?.validation;
  const card = el("details", { class: "card fx-validation" }, el("summary", { class: "card-title" }, "공통 표본외 검증"));
  card.open = fxValidationOpen;
  card.addEventListener("toggle", () => { fxValidationOpen = card.open; });
  host.append(card);
  if (payload?.schema !== "fx_validation_v1" || !payload.active || !Array.isArray(payload.horizons)) {
    card.append(el("p", { class: "card-sub", role: "status" }, payload?.reason || "공통 검증 결과가 없습니다."));
    return;
  }
  const horizons = payload.horizons;
  if (!horizons.some((h) => h.horizon_months === fxValidationHorizon)) fxValidationHorizon = horizons[0]?.horizon_months;
  const select = el("select", { id: "fx-validation-horizon", "aria-label": "공통 검증 지평" });
  horizons.forEach((h) => select.append(el("option", { value: String(h.horizon_months) }, `${h.horizon_months}개월`)));
  select.value = String(fxValidationHorizon);
  const body = el("div", { class: "fx-validation-body" });
  const current = () => horizons.find((h) => h.horizon_months === fxValidationHorizon);
  const csv = el("button", { type: "button", class: "btn-ghost", onclick: () => {
    const data = fxValidationCsv(current());
    downloadCSV(`IAW-FX-common-validation-${fxValidationHorizon}M.csv`, data.headers, data.rows);
  } }, "CSV");
  card.append(el("div", { class: "fx-validation-controls" }, el("label", {}, "지평 ", select), csv), body);
  const draw = () => {
    body.textContent = "";
    const h = current(), s = h?.metrics?.sample || {}, si = h?.metrics?.interval?.["95"]?.sample || {};
    body.append(el("p", { class: "card-sub", role: "status" },
      `선택 ${h?.n_selected ?? "—"}개 → 공통 ${h?.n_common || 0}개 · 제외 ${Number.isInteger(h?.n_selected) ? h.n_selected - h.n_common : "—"}개 · 기준일 ${s.origin_start || "—"} ~ ${s.origin_end || "—"} · 목표일 ${s.target_start || "—"} ~ ${s.target_end || "—"}`));
    if (!h?.n_common) body.append(el("p", { class: "card-sub" }, "이 지평의 공통 평가표본이 부족합니다."));
    for (const kind of ["point", "interval", "variance"]) {
      const wrap = el("div", { class: "table-wrap fx-validation-table" });
      body.append(wrap); renderTable(wrap, fxValidationTable(h, kind));
    }
    body.append(el("p", { class: "card-sub" }, `구간 비교 공통 ${si.n || 0}개 · 목표일 ${si.target_start || "—"} ~ ${si.target_end || "—"}`));
  };
  select.addEventListener("change", () => { fxValidationHorizon = Number(select.value); draw(); });
  draw();
  const method = el("details", { class: "fx-validation-method" }, el("summary", {}, "평가 기준"));
  method.append(el("p", {}, `현재 자료에서 과거 기준일까지만 잘라 재추정한 검증입니다. 성과와 무관하게 최근 기준일 최대 ${payload.config?.max_origins ?? "—"}개를 먼저 선택하고, A/D는 ${payload.config?.path_count ?? "—"}개 경로를 사용합니다. 같은 기준일·목표일·기준환율의 공통 행만 비교합니다. B는 별도 월간 입력·학습 경로로 이 공통 비교에 포함하지 않습니다.`),
    el("p", {}, "RW 대비 RMSE는 1 미만일수록 표본 오차가 작습니다. 구간점수는 폭과 구간 밖 오차를 함께 평가하며 작을수록 좋습니다. QLIKE는 만기 로그변화의 제곱을 분산 대용치로 사용하며 작을수록 좋습니다. 95%는 명목 구간이고 실제 포함률을 보장하지 않습니다."),
    el("p", {}, "달력 목표일까지 예정된 평일 수로 A/D를 재계산하므로 상세 전망의 월당 21관측과 시간축이 다릅니다. D의 중심은 방향 중립 기준환율이며 산술평균 상승을 방향 신호로 사용하지 않습니다. 가중치는 사전 고정하고 표본오차로 다시 선택하지 않습니다. C 자체에도 RW 축소가 들어 있습니다."),
    el("p", {}, "다개월 평가기간은 겹칩니다. 표본 수는 독립 표본 수가 아니며 당시 자료 빈티지·모수 불확실성·실제 거래비용은 복원하지 않았습니다. 이 표만으로 통계적 우월성이나 실시간 운용성과를 확정하지 않습니다."));
  card.append(method);
}

if (typeof module !== "undefined" && module.exports) module.exports = { fxValidationTable, fxValidationCsv };
