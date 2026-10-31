/* Model C displays fixed-rule pipeline forecasts and genuinely prior-error intervals. */
"use strict";

let fxModelCCharts = [];
let fxModelCResize = null;
let fxModelCHorizon = 3;
let fxModelCInterval = 68;

function fxModelCPositive(value) { return Number.isFinite(value) && value > 0; }
function fxModelCTimestamp(value) { return Number.isInteger(value) && Number.isFinite(new Date(value * 1000).getTime()); }
function fxModelCBounds(row) {
  const values = [row.lower95, row.lower68, row.upper68, row.upper95];
  return values.every((v) => v === null) || (values.every(fxModelCPositive)
    && values.every((v, i) => !i || v >= values[i - 1]));
}
function fxModelCValid(p) {
  if (p?.active !== true || p.schema !== "fx_model_c_v1" || p.pair !== "USDKRW" || p.unit !== "KRW/USD"
      || !fxModelCTimestamp(p.anchor?.t) || !fxModelCTimestamp(p.anchor?.quote_t)
      || p.anchor.quote_t !== p.anchor.t || !fxModelCPositive(p.anchor.v)
      || p.asof !== tsToDate(p.anchor.quote_t) || p.model_date !== tsToDate(p.anchor.t)
      || !Array.isArray(p.horizons) || ![4, 5].includes(p.horizons.length)
      || p.model?.shrinkage !== .5 || p.model?.ridge_lambda !== 1) return false;
  // Retain the previous four-horizon payload while refreshed pipeline data arrives.
  const horizons = p.horizons.length === 4 ? [1, 3, 6, 12] : [1, 3, 6, 9, 12];
  return horizons.every((h, i) => {
    const row = p.horizons[i];
    if (!row || row.horizon_months !== h || typeof row.active !== "boolean") return false;
    if (!fxModelCTimestamp(row.target_t) || row.target_t <= p.anchor.t
        || row.target_date !== tsToDate(row.target_t)) return false;
    if (!row.active) return typeof row.reason === "string";
    const metrics = row.metrics;
    if (![row.point, row.ridge_point, row.rw].every(fxModelCPositive) || row.rw !== p.anchor.v
        || !Number.isFinite(row.change_pct) || !fxModelCBounds(row)
        || !Number.isInteger(row.n_train) || row.n_train < 60 || row.n_train > 120
        || !Number.isInteger(row.n_calibration) || row.n_calibration < 0
        || ((row.n_calibration < 24) !== (row.lower68 === null))
        || !Array.isArray(row.contributions) || row.contributions.length !== 4
        || !row.contributions.every((c, j) => c && c.key === ["intercept", "rate_spread", "momentum_1m", "momentum_3m"][j]
          && typeof c.label === "string" && Number.isFinite(c.log_pct))
        || !Array.isArray(row.backtest) || !metrics || metrics.n !== row.backtest.length) return false;
    if (!Number.isInteger(metrics.n_interval) || metrics.n_interval < 0 || metrics.n_interval > metrics.n
        || !["rmse", "mae", "rw_rmse", "ridge_rmse", "theil_u"].every((key) =>
          metrics[key] === null || (Number.isFinite(metrics[key]) && metrics[key] >= 0))
        || !["coverage68", "coverage95"].every((key) => metrics[key] === null
          || (Number.isFinite(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 1))) return false;
    const sum = row.contributions.reduce((a, c) => a + c.log_pct, 0);
    if (Math.abs(sum - Math.log(row.point / p.anchor.v) * 100) > 1e-7) return false;
    return row.backtest.every((r, j) => r && fxModelCTimestamp(r.origin_t) && fxModelCTimestamp(r.target_t)
      && r.origin_t < r.target_t && r.target_t <= p.anchor.t
      && (!j || r.origin_t > row.backtest[j - 1].origin_t)
      && r.origin_date === tsToDate(r.origin_t) && r.target_date === tsToDate(r.target_t)
      && [r.base, r.actual, r.model_c, r.ridge, r.rw].every(fxModelCPositive)
      && r.base === r.rw && fxModelCBounds(r)
      && Number.isInteger(r.n_train) && r.n_train >= 60 && r.n_train <= 120
      && Number.isInteger(r.n_calibration) && r.n_calibration >= 0
      && ((r.n_calibration < 24) === (r.lower68 === null)));
  }) && p.horizons.some((r) => r.active);
}

function fxModelCNumber(value, digits = 2) { return Number.isFinite(value) ? fmtNum(value, digits) : "–"; }
function fxModelCForecastTable(payload, raw = false) {
  const number = (v) => raw ? v : fxModelCNumber(v);
  return { headers: ["모형 기준일", "호가 기준일", "지평 (개월)", "목표일", "C 로그 중심 (원/달러)",
    "Ridge 로그 중심 (원/달러)", "RW (원/달러)", "변화율 (%)", "68% 하단", "68% 상단", "95% 하단", "95% 상단", "학습 N", "구간 보정 N"],
    rows: payload.horizons.map((r) => [payload.model_date, payload.asof, r.horizon_months, r.target_date,
      ...(r.active ? [r.point, r.ridge_point, r.rw, r.change_pct, r.lower68, r.upper68, r.lower95, r.upper95] : Array(8).fill(null)).map(number),
      r.active ? r.n_train : 0, r.active ? r.n_calibration : 0]) };
}
function fxModelCBacktestTable(row, raw = false) {
  const number = (v) => raw ? v : fxModelCNumber(v);
  return { headers: ["예측 기준일", "목표일", "기준 호가일", "실현 호가일", "기준 환율", "실제 환율", "C", "Ridge", "RW",
    "C 오차 (예측−실제)", "RW 오차", "68% 하단", "68% 상단", "95% 하단", "95% 상단", "과거 보정 N"],
    rows: [...row.backtest].reverse().map((r) => [r.origin_date, r.target_date, r.origin_quote_date, r.target_quote_date,
      ...[r.base, r.actual, r.model_c, r.ridge, r.rw, r.model_c - r.actual, r.rw - r.actual,
        r.lower68, r.upper68, r.lower95, r.upper95].map(number), r.n_calibration]) };
}

function renderFxModelC(host) {
  fxModelCCharts.forEach((entry) => { if (uplots.includes(entry)) destroyChart(entry); });
  fxModelCCharts = []; fxModelCResize = null;
  if (!host) return;
  host.textContent = "";
  const payload = DATA.fx?.model_c;
  if (!fxModelCValid(payload)) {
    host.append(el("div", { class: "card fx-c-empty", role: "status" },
      el("span", { class: "card-title" }, "USDKRW · 축소추정 · 금리차·모멘텀"),
      el("p", { class: "card-sub" }, payload?.active
        ? "모형 데이터의 시점·형식을 확인할 수 없어 전망을 표시하지 않습니다."
        : payload?.reason || "환율모형C 분석 데이터를 불러오지 못했습니다.")));
    return;
  }
  const active = payload.horizons.filter((r) => r.active);
  if (!active.some((r) => r.horizon_months === fxModelCHorizon)) fxModelCHorizon = active[0].horizon_months;
  const pal = palette(), gold = "#d4ad58", blue = "#438fde", teal = "#64c5bb";
  const getRow = () => active.find((r) => r.horizon_months === fxModelCHorizon);
  const meta = el("div", { class: "fx-c-meta" },
    el("b", {}, "USDKRW · 축소추정 · 금리차·모멘텀"),
    el("span", {}, `모형 기준일 ${payload.model_date}`),
    el("span", {}, `호가 ${payload.asof} · ${fxModelCNumber(payload.anchor.v)} 원/달러`));
  host.append(meta);
  const grid = el("div", { class: "fx-c-grid" }); host.append(grid);
  const cardBounds = [];
  payload.horizons.forEach((r) => {
    const bounds = el("span", { class: "fx-c-bounds" });
    const tile = el("div", { class: "card fx-c-forecast", "data-month": String(r.horizon_months) },
      el("span", { class: "card-sub" }, `${r.horizon_months}개월 · ${r.target_date || "–"}`),
      el("span", { class: "fx-c-center-label" }, "로그 중심 · 원/달러"),
      el("b", { class: "fx-c-value" }, r.active ? fxModelCNumber(r.point) : "–"),
      el("span", { class: "fx-c-change" }, r.active ? `${r.change_pct >= 0 ? "+" : ""}${fxModelCNumber(r.change_pct)}%` : r.reason), bounds);
    cardBounds.push([r, bounds]); grid.append(tile);
  });
  const interval = el("select", { id: "fx-c-interval", "aria-label": "과거오차 구간" });
  [68, 95].forEach((v) => interval.append(el("option", { value: String(v) }, `${v}%`)));
  interval.value = String(fxModelCInterval);
  const forecastCard = el("div", { class: "card fx-c-forecast-chart" }); host.append(forecastCard);
  const forecastBox = cardScaffold(forecastCard, { title: "환율 경로", sub: "원/달러",
    controls: el("label", { class: "fx-c-control" }, "과거오차 구간 ", interval),
    csvName: "USDKRW-ModelC-Forecasts.csv", tableFn: (_cap, raw) => fxModelCForecastTable(payload, raw) });
  const forecastLegend = hedgeChartLegend(forecastBox, [["원달러", blue], ["C 로그 중심", gold], ["RW", pal.ink3], [`${fxModelCInterval}% 구간`, gold, true]]);
  const forecastData = () => {
    const rows = new Map(), history = fxOutlookHistory(DATA.fx?.outlook);
    const lo = new Date(payload.anchor.t * 1000); lo.setUTCFullYear(lo.getUTCFullYear() - 3);
    history.t.forEach((t, i) => { if (t >= lo.getTime() / 1000 && t <= payload.anchor.quote_t) rows.set(t, [history.v[i], null, null, null, null]); });
    rows.set(payload.anchor.t, [payload.anchor.v, payload.anchor.v, payload.anchor.v, payload.anchor.v, payload.anchor.v]);
    payload.horizons.forEach((r) => {
      if (Number.isInteger(r.target_t)) rows.set(r.target_t,
        [null, r.active ? r.point : null, payload.anchor.v, r.active ? r[`lower${fxModelCInterval}`] : null, r.active ? r[`upper${fxModelCInterval}`] : null]);
    });
    const t = [...rows.keys()].sort((a, b) => a - b);
    return [t, ...Array.from({ length: 5 }, (_, i) => t.map((time) => rows.get(time)[i]))];
  };
  const charts = [];
  const plot = (box, labels, colors, data, bands = [], height = 300) => {
    box.classList.add("time-chart-hover", "fx-c-chart");
    const plotHost = el("div", { class: "hedge-plot-host" }); box.append(plotHost);
    const tip = el("div", { class: "time-chart-tooltip", role: "status" }); tip.hidden = true; box.append(tip);
    const options = { width: Math.max(280, box.clientWidth), height,
      tzDate: (t) => uPlot.tzDate(new Date(t * 1000), "Etc/UTC"), axes: baseAxes(pal, (v) => fmtNum(v, 2)),
      legend: { show: false }, cursor: { y: false, points: { show: false }, drag: { setScale: false } },
      series: [{ label: "일자" }, ...labels.map((label, i) => ({ label, stroke: colors[i], width: label.includes("하단") || label.includes("상단") ? 0 : 1.8,
        dash: label === "RW" ? [5, 4] : [], points: { show: false }, spanGaps: false,
        value: (_u, v) => fxModelCNumber(v) }))], bands,
      hooks: { setCursor: [(u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0 || top < 0 || !Number.isFinite(u.data[0]?.[idx])) { tip.hidden = true; return; }
        tip.textContent = ""; tip.append(el("strong", {}, tsToDate(u.data[0][idx])));
        labels.forEach((label, i) => { const value = u.data[i + 1][idx];
          if (Number.isFinite(value)) tip.append(el("div", {}, el("span", {}, label), el("b", {}, fxModelCNumber(value)))); });
        tip.hidden = false; tip.style.left = left > box.clientWidth / 2 ? "12px" : "auto";
        tip.style.right = left > box.clientWidth / 2 ? "auto" : "12px";
      }], setData: [() => { tip.hidden = true; }] } };
    const u = new uPlot(options, data, plotHost);
    const resize = () => u.setSize({ width: Math.max(280, box.clientWidth), height });
    const ro = new ResizeObserver(resize); ro.observe(box);
    fxModelCCharts.push(trackChart(u, ro)); charts.push(resize);
    box.addEventListener("mouseleave", () => { tip.hidden = true; });
    return u;
  };
  const forecastLabels = ["원달러", "C 로그 중심", "RW", `${fxModelCInterval}% 하단`, `${fxModelCInterval}% 상단`];
  const forecastPlot = plot(forecastBox, forecastLabels, [blue, gold, pal.ink3, gold, gold], forecastData(),
    [{ series: [5, 4], fill: hexA(gold, .15) }], 330);
  const comparisonCard = el("div", { class: "card fx-c-comparison" }); host.append(comparisonCard);
  comparisonCard.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "의사 표본 외 · 동일 표본 비교"),
    el("span", { class: "card-sub" }, "오차: 원/달러 · U: C / RW")));
  const metricsTable = el("div", { class: "table-wrap fx-c-metrics" }); comparisonCard.append(metricsTable);
  renderTable(metricsTable, { headers: ["지평", "평가 N", "C RMSE", "Ridge RMSE", "RW RMSE", "C MAE", "Theil U", "68% 포함률", "95% 포함률", "구간 평가 N"],
    rows: payload.horizons.map((r) => { const m = r.active ? r.metrics : {};
      return [`${r.horizon_months}개월`, m.n ?? 0, ...[m.rmse, m.ridge_rmse, m.rw_rmse, m.mae, m.theil_u].map((v) => fxModelCNumber(v)),
        ...[m.coverage68, m.coverage95].map((v) => Number.isFinite(v) ? `${fxModelCNumber(v * 100)}%` : "–"), m.n_interval ?? 0]; }) });
  const horizon = el("select", { id: "fx-c-horizon", "aria-label": "상세 예측 지평" });
  active.forEach((r) => horizon.append(el("option", { value: String(r.horizon_months) }, `${r.horizon_months}개월`)));
  horizon.value = String(fxModelCHorizon);
  const detailHead = el("div", { class: "fx-c-meta" }, el("b", {}, "지평별 상세"), el("label", { class: "fx-c-control" }, "지평 ", horizon));
  host.append(detailHead);
  const detailGrid = el("div", { class: "fx-c-detail-grid" }); host.append(detailGrid);
  const contributionCard = el("div", { class: "card fx-c-contributions" });
  contributionCard.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "현재 전망 기여도"),
    el("span", { class: "card-sub" }, "누적 로그 변화 · %")));
  const contributionTable = el("div", { class: "table-wrap" }); contributionCard.append(contributionTable);
  const contributionMeta = el("div", { class: "fx-c-detail-meta" }); contributionCard.append(contributionMeta);
  const errorCard = el("div", { class: "card fx-c-errors" });
  detailGrid.append(contributionCard, errorCard);
  const errorBox = cardScaffold(errorCard, { title: "과거 예측오차", sub: "예측−실제 · 원/달러",
    csvName: "USDKRW-ModelC-Backtest.csv", tableFn: (_cap, raw) => fxModelCBacktestTable(getRow(), raw) });
  hedgeChartLegend(errorBox, [["C", gold], ["Ridge", teal], ["RW", pal.ink3]]);
  const errorData = () => { const rows = getRow().backtest;
    if (!rows.length) return [[payload.anchor.t], [null], [null], [null]];
    return [rows.map((r) => r.target_t), ...["model_c", "ridge", "rw"].map((key) => rows.map((r) => r[key] - r.actual))]; };
  const errorPlot = plot(errorBox, ["C", "Ridge", "RW"], [gold, teal, pal.ink3], errorData(), [], 250);
  const noEvaluation = el("p", { class: "card-sub fx-c-no-evaluation", role: "status" }, "평가 가능한 실현 예측이 없습니다.");
  errorCard.append(noEvaluation);
  const method = el("details", { class: "hedge-outlook-method fx-c-method" }, el("summary", {}, "모형 · 표본 · 검증 범위"));
  method.append(el("p", { class: "fx-c-source" },
    `${marketSourceLabel(payload.source)} · 한국/미국 1년 금리 · 월별 표본 ${payload.sample?.start || "–"} ~ ${payload.sample?.end || "–"} · ${payload.sample?.n_months ?? 0}개월 · 최신 공통 호가 ${payload.sample?.latest_common_date || "–"}`),
    el("p", {}, "공통 관측일의 금리차와 1·3개월 환율 모멘텀으로 지평별 로그 변화를 추정합니다. 학습 표준화와 Ridge λ=1, 최근 최대 120개·최소 60개 실현 라벨을 사용하고, 예측 로그 변화를 50%로 축소합니다. 나머지 50%는 환율 불변 랜덤워크입니다. 성과에 따라 가중치나 λ를 선택하지 않습니다."),
    el("p", {}, "로그 중심은 조건부 로그 예측을 지수변환한 값이며 환율 수준의 산술평균이나 보장된 중앙값이 아닙니다. 기여도는 통계적 예측의 분해이며 금리차의 인과효과나 식별된 위험프리미엄이 아닙니다. 월말 마지막 평일에 환율과 한미 금리가 모두 관측된 달만 사용하며 결측 달·미완료 월은 제외합니다. 휴일 달력은 따로 보정하지 않습니다."),
    el("p", {}, "과거오차 구간은 해당 예측 시점까지 실현된 C의 로그 오차가 24개 이상일 때만 구성합니다. 68%·95%는 경험 분위수의 명목 비율이며 미래 포함률 보장이 아닙니다. 구간의 비대칭 때문에 로그 중심이 구간 안에 있을 필요는 없습니다. 연결선과 음영은 게시된 지평별 전망점 사이의 표시용 보간입니다."),
    el("p", {}, "의사 표본 외 평가는 현재 보유한 역사자료를 과거 순서로 재추정한 결과이며 당시 데이터 빈티지를 복원한 실시간 검증은 아닙니다. 서로 겹치는 지평의 오차는 독립 표본이 아닙니다. Theil U는 C의 RMSE를 같은 표본의 RW RMSE로 나눈 값이며 1 미만이어도 통계적 우월성을 뜻하지 않습니다. 미래 예측력·거래비용 반영 성과·구조모형 재현은 미검증입니다."));
  host.append(method);
  const refreshTable = (card, tableFn) => { const table = card.querySelector(".chart-table");
    if (table && !table.classList.contains("hidden")) renderTable(table, tableFn()); };
  const updateDetail = () => {
    const r = getRow();
    renderTable(contributionTable, { headers: ["항목", "로그 기여도 (%)"], rows: [
      ...r.contributions.map((c) => [c.label, fxModelCNumber(c.log_pct)]),
      ["합계", fxModelCNumber(r.contributions.reduce((s, c) => s + c.log_pct, 0))]] });
    contributionMeta.textContent = `학습 ${r.n_train}개 · 과거오차 보정 ${r.n_calibration}개`;
    errorBox.hidden = r.backtest.length === 0; noEvaluation.hidden = r.backtest.length > 0;
    errorPlot.setData(errorData()); refreshTable(errorCard, () => fxModelCBacktestTable(r));
    fxModelCResize?.();
  };
  const updateInterval = () => {
    forecastLabels[3] = `${fxModelCInterval}% 하단`; forecastLabels[4] = `${fxModelCInterval}% 상단`;
    if (forecastPlot.series) forecastLabels.forEach((label, i) => { forecastPlot.series[i + 1].label = label; });
    const item = forecastLegend.children[3]; item.textContent = "";
    item.append(el("i", { class: "is-band", style: `--legend-color:${gold}` }), `${fxModelCInterval}% 구간`);
    cardBounds.forEach(([r, node]) => { node.textContent = r.active && fxModelCPositive(r[`lower${fxModelCInterval}`])
      ? `${fxModelCInterval}% · ${fxModelCNumber(r[`lower${fxModelCInterval}`])} ~ ${fxModelCNumber(r[`upper${fxModelCInterval}`])}`
      : r.active ? "과거오차 구간 · 표본 부족" : ""; });
    forecastPlot.setData(forecastData());
  };
  horizon.addEventListener("change", () => { const value = Number(horizon.value);
    if (active.some((r) => r.horizon_months === value)) { fxModelCHorizon = value; updateDetail(); } });
  interval.addEventListener("change", () => { const value = Number(interval.value);
    if ([68, 95].includes(value)) { fxModelCInterval = value; updateInterval(); } });
  fxModelCResize = () => charts.forEach((resize) => resize());
  updateDetail(); updateInterval();
}
