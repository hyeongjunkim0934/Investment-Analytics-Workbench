/* Conditional variance and symmetric filtered-historical FX risk; no direction signal. */
"use strict";

let fxModelDCharts = [];
let fxModelDResize = null;
let fxModelDInterval = 95;
let fxModelDTarget = "";
const FX_MODEL_D_HORIZONS = Object.freeze([1, 3, 6, 9, 12]);
const FX_MODEL_D_LEVELS = Object.freeze(["mean", "median", "lower68", "upper68", "lower95", "upper95"]);

function fxModelDPositive(v) { return Number.isFinite(v) && v > 0; }
function fxModelDNonnegative(v) { return Number.isFinite(v) && v >= 0; }
function fxModelDTime(v) { return Number.isInteger(v) && Number.isFinite(new Date(v * 1000).getTime()); }
function fxModelDOrdered(r) {
  return FX_MODEL_D_LEVELS.every((k) => fxModelDPositive(r?.[k]))
    && r.lower95 <= r.lower68 && r.lower68 <= r.median && r.median <= r.upper68 && r.upper68 <= r.upper95;
}
function fxModelDValid(p) {
  if (p?.active !== true || p.schema !== "fx_model_d_v1" || p.pair !== "USDKRW" || p.unit !== "KRW/USD"
      || !fxModelDTime(p.anchor?.t) || !fxModelDPositive(p.anchor?.v) || p.asof !== tsToDate(p.anchor.t)
      || p.model?.mean_log_return !== 0 || p.model?.direction_forecast !== false
      || p.model?.annualization !== 252 || p.model?.steps_per_month !== 21 || p.model?.orthogonality_verified !== false
      || !p.fit || !["alpha", "beta", "persistence"].every((k) => fxModelDNonnegative(p.fit[k]))
      || !["omega", "long_run_var", "next_var"].every((k) => fxModelDPositive(p.fit[k]))
      || p.fit.persistence >= 1 || Math.abs(p.fit.alpha + p.fit.beta - p.fit.persistence) > 1e-9
      || !Array.isArray(p.horizons) || p.horizons.length !== 5) return false;
  const s = p.forecast, b = p.backtest, m = b?.metrics;
  if (!s || !Number.isInteger(s.path_count) || s.path_count < 1 || !Number.isInteger(s.seed)
      || !["t", "steps", ...FX_MODEL_D_LEVELS, "vol_pct"].every((k) => Array.isArray(s[k]) && s[k].length === 253)
      || !s.t.every((t, i) => fxModelDTime(t) && (!i || t > s.t[i - 1]))
      || !s.steps.every((step, i) => step === i) || s.t[0] !== p.anchor.t
      || !s.vol_pct.every(fxModelDNonnegative)
      || !s.steps.every((_, i) => fxModelDOrdered(Object.fromEntries(FX_MODEL_D_LEVELS.map((k) => [k, s[k][i]]))))
      || !FX_MODEL_D_LEVELS.every((k) => Math.abs(s[k][0] / p.anchor.v - 1) < 1e-10)
      || !b || b.horizon_steps !== 21 || !Array.isArray(b.rows) || !m || m.n !== b.rows.length) return false;
  if (!FX_MODEL_D_HORIZONS.every((h, i) => {
    const r = p.horizons[i], j = h * 21;
    return r?.horizon_months === h && r.steps === j && r.target_t === s.t[j]
      && r.target_date === tsToDate(r.target_t) && fxModelDOrdered(r)
      && fxModelDNonnegative(r.vol_pct) && r.vol_pct === s.vol_pct[j]
      && [r.var95_pct, r.es95_pct].every(Number.isFinite) && r.es95_pct + 1e-9 >= r.var95_pct
      && FX_MODEL_D_LEVELS.every((k) => r[k] === s[k][j]);
  })) return false;
  if (!["qlike_d", "qlike_constant", "qlike_ewma"].every((k) => m.n ? Number.isFinite(m[k]) : m[k] === null)
      || !["mse_d", "mse_constant", "mse_ewma"].every((k) => m.n ? fxModelDNonnegative(m[k]) : m[k] === null)
      || !(m.n ? Number.isFinite(m.coverage95) && m.coverage95 >= 0 && m.coverage95 <= 1 : m.coverage95 === null)) return false;
  return b.rows.every((r, i) => r && fxModelDTime(r.origin_t) && fxModelDTime(r.target_t)
    && r.origin_t < r.target_t && r.target_t <= p.anchor.t && (!i || r.origin_t >= b.rows[i - 1].target_t)
    && [r.base, r.actual, r.lower95, r.upper95].every(fxModelDPositive) && r.lower95 <= r.upper95
    && fxModelDNonnegative(r.realized_variance)
    && [r.model_variance, r.constant_variance, r.ewma_variance].every(fxModelDPositive));
}

function fxModelDNumber(v, digits = 2) { return Number.isFinite(v) ? fmtNum(v, digits) : "–"; }
function fxModelDExposure(target, vol) {
  if (!Number.isFinite(target) || target <= 0 || !fxModelDNonnegative(vol)) return null;
  return vol === 0 ? 100 : Math.min(100, target / vol * 100);
}
function fxModelDForecastTable(p, raw = false) {
  const n = (v, digits = 2) => raw ? v : fxModelDNumber(v, digits);
  return { headers: ["기준일", "지평 (개월)", "모형 관측일", "목표일", "평균 (원/달러)", "중앙값 (원/달러)",
    "68% 하단", "68% 상단", "95% 하단", "95% 상단", "연율 변동성 (%)", "환손실 VaR95 (%)", "환손실 ES95 (%)", "상태", "실현 환율", "오차 (중앙값−실제)", "95% 구간 포함"],
  rows: p.horizons.map((r) => {
    const status = fxForecastStatus(r.target_t, r.median, DATA.fx?.outlook?.history, r.lower95, r.upper95);
    return [p.asof, r.horizon_months, r.steps, r.target_date,
      ...FX_MODEL_D_LEVELS.map((k) => n(r[k], 0)), n(r.vol_pct), n(r.var95_pct), n(r.es95_pct),
      status.label, n(status.actual, 0), n(status.error, 0), status.covered];
  }) };
}
function fxModelDBacktestTable(p, raw = false) {
  const n = (v, digits = 2) => raw ? v : fxModelDNumber(v, digits);
  const vol = (v) => Math.sqrt(v * 252) * 100;
  return { headers: ["예측 기준일", "실현 목표일", "기준 환율", "실현 환율", "D 연율 변동성 (%)", "실현 연율 변동성 (%)",
    "고정분산 연율 변동성 (%)", "EWMA 연율 변동성 (%)", "D 95% 하단", "D 95% 상단"],
  rows: [...p.backtest.rows].reverse().map((r) => [tsToDate(r.origin_t), tsToDate(r.target_t), n(r.base, 0), n(r.actual, 0),
    ...[r.model_variance, r.realized_variance, r.constant_variance, r.ewma_variance].map((v) => n(vol(v))), n(r.lower95, 0), n(r.upper95, 0)]) };
}

function renderFxModelD(host) {
  fxModelDCharts.forEach((entry) => { if (uplots.includes(entry)) destroyChart(entry); });
  fxModelDCharts = []; fxModelDResize = null;
  if (!host) return;
  host.textContent = "";
  const p = DATA.fx?.model_d;
  if (!fxModelDValid(p)) {
    host.append(el("div", { class: "card fx-d-empty", role: "status" },
      el("span", { class: "card-title" }, "USDKRW · 조건부 변동성"),
      el("p", { class: "card-sub" }, p?.active ? "모형 데이터의 시점·형식을 확인할 수 없어 전망을 표시하지 않습니다."
        : p?.reason || "환율모형D 분석 데이터를 불러오지 못했습니다.")));
    return;
  }
  const statusOf = (r) => fxForecastStatus(r.target_t, r.median, DATA.fx?.outlook?.history, r.lower95, r.upper95);
  const expired = (r) => statusOf(r).expired;
  const pal = palette(), gold = currentTheme() === "light" ? "#8a5c00" : "#edbd63";
  const blue = currentTheme() === "light" ? "#233c66" : "#73a4df", teal = currentTheme() === "light" ? "#16776d" : "#64c5bb";
  host.append(el("div", { class: "fx-d-meta" }, el("b", {}, "USDKRW · 조건부 변동성"),
    el("span", {}, `기준일 ${p.asof} · ${fxModelDNumber(p.anchor.v, 0)} 원/달러`)));
  const notices = [];
  if (p.model.fallback_used) notices.push("유효 호가 부재로 Infomax 대체");
  if (p.fit.grid_boundary) notices.push("분산 추정 격자 경계 선택");
  if (notices.length) host.append(el("p", { class: "fx-d-status", role: "status" }, notices.join(" · ")));
  const grid = el("div", { class: "fx-d-grid" }); host.append(grid);
  const cardBounds = [];
  p.horizons.forEach((r) => {
    const status = statusOf(r);
    const bounds = el("div", { class: "fx-d-bounds" }); cardBounds.push([r, bounds]);
    grid.append(el("div", { class: "card fx-d-forecast", "data-month": String(r.horizon_months) },
      el("span", { class: "card-sub" }, `${r.horizon_months}개월 · ${r.target_date}`),
      ...(status.expired ? [el("span", { class: "fx-d-expired", role: "status" }, status.label)] : []),
      el("span", { class: "fx-d-value-label" }, "연율 변동성 (%)"),
      el("b", { class: "fx-d-value" }, fxModelDNumber(r.vol_pct)), bounds,
      el("div", { class: "fx-d-risk" }, el("span", {}, "환손실 VaR95 / ES95 (%)"),
        el("b", {}, `${fxModelDNumber(r.var95_pct)} / ${fxModelDNumber(r.es95_pct)}`)),
      ...(status.actual !== null ? [el("span", { class: "card-sub fx-d-realized" },
        fxForecastEvaluationText(status, (v) => fmtNum(v, 0)))] : [])));
  });
  const interval = el("select", { id: "fx-d-interval", "aria-label": "D 조건부 예측구간" });
  [68, 95].forEach((v) => interval.append(el("option", { value: String(v) }, `${v}%`))); interval.value = String(fxModelDInterval);
  const forecastCard = el("div", { class: "card fx-d-forecast-chart" }); host.append(forecastCard);
  const forecastBox = cardScaffold(forecastCard, { title: "환율 조건부 분포", sub: "원/달러",
    controls: el("label", { class: "fx-d-control" }, "예측구간 ", interval),
    csvName: "USDKRW-ModelD-Forecasts.csv", tableFn: (_cap, raw) => fxModelDForecastTable(p, raw) });
  const forecastLegend = hedgeChartLegend(forecastBox, [["원달러", blue], ["D 평균", teal], ["D 중앙값", gold], [`${fxModelDInterval}% 구간`, gold, true]]);
  const forecastData = () => {
    const rows = new Map(), history = fxOutlookHistory(DATA.fx?.outlook), start = new Date(p.anchor.t * 1000);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const today = fxForecastToday();
    history.t.forEach((t, i) => { if (t >= start.getTime() / 1000 && (t < p.anchor.t || t <= today)) rows.set(t, [history.v[i], null, null, null, null]); });
    p.forecast.t.forEach((t, i) => rows.set(t, [i === 0 ? p.anchor.v : rows.get(t)?.[0] ?? null, p.forecast.mean[i], p.forecast.median[i],
      p.forecast[`lower${fxModelDInterval}`][i], p.forecast[`upper${fxModelDInterval}`][i]]));
    const t = [...rows.keys()].sort((a, b) => a - b);
    return [t, ...Array.from({ length: 5 }, (_, i) => t.map((time) => rows.get(time)[i]))];
  };
  const resizers = [];
  const plot = (box, labels, colors, data, digits, bands = [], height = 290) => {
    box.classList.add("time-chart-hover", "fx-d-chart");
    const plotHost = el("div", { class: "hedge-plot-host" }), tip = el("div", { class: "time-chart-tooltip", role: "status" });
    tip.hidden = true; box.append(plotHost, tip);
    const options = { width: Math.max(280, box.clientWidth), height,
      tzDate: (t) => uPlot.tzDate(new Date(t * 1000), "Etc/UTC"), axes: baseAxes(pal, (v) => fmtNum(v, digits)),
      legend: { show: false }, cursor: { y: false, points: { show: false }, drag: { setScale: false } },
      series: [{ label: "일자" }, ...labels.map((label, i) => ({ label, stroke: colors[i], width: /하단|상단/.test(label) ? 0 : 1.5,
        points: { show: false }, spanGaps: false, value: (_u, v) => fxModelDNumber(v, digits) }))], bands,
      hooks: { setCursor: [(u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0 || top < 0 || !Number.isFinite(u.data[0]?.[idx])) { tip.hidden = true; return; }
        tip.textContent = ""; tip.append(el("strong", {}, tsToDate(u.data[0][idx])));
        labels.forEach((label, i) => { const v = u.data[i + 1][idx]; if (Number.isFinite(v))
          tip.append(el("div", {}, el("span", {}, label), el("b", {}, fxModelDNumber(v, digits)))); });
        tip.hidden = false; tip.style.left = left > box.clientWidth / 2 ? "12px" : "auto";
        tip.style.right = left > box.clientWidth / 2 ? "auto" : "12px";
      }], setData: [() => { tip.hidden = true; }] } };
    const u = new uPlot(options, data, plotHost), resize = () => u.setSize({ width: Math.max(280, box.clientWidth), height });
    const ro = new ResizeObserver(resize); ro.observe(box); fxModelDCharts.push(trackChart(u, ro)); resizers.push(resize);
    box.addEventListener("mouseleave", () => { tip.hidden = true; }); return u;
  };
  const forecastLabels = ["원달러", "D 평균", "D 중앙값", `${fxModelDInterval}% 하단`, `${fxModelDInterval}% 상단`];
  const forecastPlot = plot(forecastBox, forecastLabels, [blue, teal, gold, gold, gold], forecastData(), 0,
    [{ series: [5, 4], fill: hexA(gold, .15) }], 320);
  const lowerGrid = el("div", { class: "fx-d-detail-grid" }); host.append(lowerGrid);
  const volCard = el("div", { class: "card fx-d-vol-chart" }), exposureCard = el("div", { class: "card fx-d-exposure" }); lowerGrid.append(volCard, exposureCard);
  const volBox = cardScaffold(volCard, { title: "지평별 예상 변동성", sub: "누적분산의 연율 환산 · %",
    csvName: "USDKRW-ModelD-Volatility.csv", tableFn: (_cap, raw) => ({ headers: ["목표일", "모형 관측일", "연율 변동성 (%)"],
      rows: p.forecast.t.map((t, i) => [tsToDate(t), p.forecast.steps[i], raw ? p.forecast.vol_pct[i] : fxModelDNumber(p.forecast.vol_pct[i])]) }) });
  plot(volBox, ["D 연율 변동성"], [gold], [p.forecast.t, p.forecast.vol_pct], 2, [], 230);
  exposureCard.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "변동성 목표 → 환노출")));
  const target = el("input", { id: "fx-d-target-vol", type: "number", min: "0", step: "0.01", placeholder: "직접 입력", "aria-label": "목표 연율 환변동성 (%)" });
  target.value = fxModelDTarget;
  const exposureStatus = el("span", { class: "fx-d-exposure-status", role: "status" });
  exposureCard.append(el("label", { class: "fx-d-control" }, "목표 연율 변동성 (%) ", target), exposureStatus);
  const exposureTable = el("div", { class: "table-wrap fx-d-exposure-table" }); exposureCard.append(exposureTable);
  const updateExposure = () => {
    const text = target.value.trim(), value = text === "" ? null : Number(text), valid = value === null || Number.isFinite(value) && value > 0;
    target.setAttribute("aria-invalid", String(!valid)); fxModelDTarget = text;
    exposureStatus.textContent = !valid ? "양의 목표 변동성을 입력하십시오." : value === null ? "목표 미입력" : "환노출 상한 100%";
    renderTable(exposureTable, { headers: ["지평", "환노출 (%)"], rows: p.horizons.map((r) =>
      [`${r.horizon_months}개월`, expired(r) ? "목표일 경과" : fxModelDNumber(valid && value !== null ? fxModelDExposure(value, r.vol_pct) : null)]) });
  };
  target.addEventListener("input", updateExposure); updateExposure();
  exposureCard.append(explainBox("fx-model-d-exposure", { label: "노출비율 산식·범위" },
    el("p", {}, "환노출 비율은 min(100%, 목표 변동성 / 해당 지평 예상 변동성)입니다. 방향·수익률 전망 없이 USD 환위험만 조절하는 참고 규칙입니다. 환헤지 최적비율이 아니며 헤지비용·채권과 환율의 공분산·거래비용·레버리지는 반영하지 않습니다. 목표는 사용자 가정이며 기본 권고값은 없습니다.")));
  const comparisonCard = el("div", { class: "card fx-d-comparison" }); host.append(comparisonCard);
  const m = p.backtest.metrics;
  comparisonCard.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "21관측일 의사 표본 외 · 동일 표본"),
    el("span", { class: "card-sub" }, `평가 ${m.n}개 · D 95% 포함률 ${m.coverage95 === null ? "–" : fxModelDNumber(m.coverage95 * 100) + "%"}`)));
  const metricTable = el("div", { class: "table-wrap fx-d-metrics" }); comparisonCard.append(metricTable);
  renderTable(metricTable, { headers: ["모형", "QLIKE", "분산 MSE ×10⁸"], rows:
    [["D · GARCH", "d"], ["고정분산", "constant"], ["EWMA · 0.94", "ewma"]].map(([label, key]) =>
      [label, fxModelDNumber(m[`qlike_${key}`], 4), fxModelDNumber(m[`mse_${key}`] === null ? null : m[`mse_${key}`] * 1e8, 4)]) });
  const backtestCard = el("div", { class: "card fx-d-backtest-chart" }); host.append(backtestCard);
  const backtestBox = cardScaffold(backtestCard, { title: "예측·실현 변동성", sub: "같은 21관측일 구간 · 연율 %",
    csvName: "USDKRW-ModelD-Backtest.csv", tableFn: (_cap, raw) => fxModelDBacktestTable(p, raw) });
  hedgeChartLegend(backtestBox, [["D 예측", gold], ["실현", blue], ["고정분산", pal.ink3], ["EWMA", teal]]);
  if (p.backtest.rows.length) {
    plot(backtestBox, ["D 예측", "실현", "고정분산", "EWMA"], [gold, blue, pal.ink3, teal],
      [p.backtest.rows.map((r) => r.target_t), ...["model_variance", "realized_variance", "constant_variance", "ewma_variance"]
        .map((k) => p.backtest.rows.map((r) => Math.sqrt(r[k] * 252) * 100))], 2, [], 250);
  } else backtestBox.append(el("p", { class: "card-sub", role: "status" }, "평가 가능한 실현 구간이 없습니다."));
  const method = explainBox("fx-model-d-method", { label: "모형 · 표본 · 검증 범위" },
    el("p", {}, `추정 표본 ${p.sample?.train_start || p.sample?.start || "–"} ~ ${p.sample?.end || p.asof} · ${p.sample?.n_train ?? "–"}개 일간수익률. 최소 504개·최대 2,520개이며 7달력일 초과 공백 뒤 최신 연속구간만 사용합니다. 유효 급등락은 보존합니다.`),
    el("p", {}, "D는 로그수익률의 조건부 평균을 0으로 두고, 최근 충격 제곱과 직전 조건부분산으로 다음 분산을 갱신하는 variance-targeted GARCH(1,1)입니다. 학습창에서 추정한 표준화 잔차의 부호를 대칭화해 재표본하며, 변동성 군집과 경험적 충격 크기를 조건부 분포에 반영합니다."),
    el("p", {}, `지속성 ${fxModelDNumber(p.fit.persistence, 3)} · α ${fxModelDNumber(p.fit.alpha, 3)} · β ${fxModelDNumber(p.fit.beta, 3)} · ${p.forecast.path_count.toLocaleString()}개 경로. 21모형 관측일을 1달력개월에 대응시킨 표시이며 실제 거래소 휴일 달력은 아닙니다.`),
    el("p", {}, "연율 변동성은 해당 지평까지 예상 누적 로그분산을 지평으로 나눠 252일 기준으로 환산합니다. 평균과 중앙값은 같은 모의분포에서 계산합니다. 로그 평균이 0이어도 수준의 산술평균은 볼록성 때문에 상승할 수 있으며 달러 강세 신호가 아닙니다."),
    el("p", {}, "VaR95·ES95는 원화 투자자의 미헤지 USD 보유분에 대한 누적 환손실률입니다. 손실=1−미래환율/기준환율이며 95% 손실 분위수와 최악 5% 평균을 표시합니다. 95% 중앙 예측구간 하단(2.5%)과 단측 VaR95(5%)는 다릅니다. 모수 불확실성·외삽된 미관측 꼬리위험·미래 커버리지 보장은 포함하지 않습니다."),
    el("p", {}, "A도 국면별 변동성을 추정합니다. D의 차이는 방향모형을 사용하지 않는 연속 분산 갱신과 변동성 목표입니다. 동일 USDKRW 자료를 공유하므로 A/C와 통계적 직교성·예측오차 독립성은 미검증입니다. 실제 방향 전망과 기계적으로 합산하지 않습니다."),
    el("p", {}, "평가는 당시 기준일까지의 자료로 재추정한 비중첩 21관측일 의사 표본 외 결과입니다. QLIKE·분산 MSE는 작을수록 좋으며 D·고정분산·EWMA에 동일 실현구간을 사용합니다. 일별 제곱수익률 평균은 잠재 분산의 잡음 많은 대용치입니다. 당시 데이터 빈티지·거래비용 반영 성과·별도 미사용 최종 표본의 우월성은 미검증입니다."));
  method.classList.add("fx-d-method"); host.append(method);
  const updateInterval = () => {
    forecastLabels[3] = `${fxModelDInterval}% 하단`; forecastLabels[4] = `${fxModelDInterval}% 상단`;
    if (forecastPlot.series) forecastLabels.forEach((label, i) => { forecastPlot.series[i + 1].label = label; });
    const item = forecastLegend.children[3]; item.textContent = "";
    item.append(el("i", { class: "is-band", style: `--legend-color:${gold}` }), `${fxModelDInterval}% 구간`);
    cardBounds.forEach(([r, node]) => { node.textContent = `${fxModelDInterval}% · ${fxModelDNumber(r[`lower${fxModelDInterval}`], 0)} ~ ${fxModelDNumber(r[`upper${fxModelDInterval}`], 0)} 원/달러`; });
    forecastPlot.setData(forecastData());
  };
  interval.addEventListener("change", () => { const value = Number(interval.value); if ([68, 95].includes(value)) { fxModelDInterval = value; updateInterval(); } });
  fxModelDResize = () => resizers.forEach((resize) => resize()); updateInterval();
}
