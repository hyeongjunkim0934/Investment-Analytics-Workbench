/* Render the pipeline's 3-state Markov return model; never refit in the browser. */
"use strict";

let fxMarkovYears = 3;
let fxMarkovChartEntry = null;
let fxMarkovResize = null;

function fxMarkovProbabilities(values) {
  return Array.isArray(values) && values.length === 3
    && values.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) < 1e-6;
}

function fxMarkovValid(payload, outlook) {
  const p = payload, a = p?.anchor, r = p?.range;
  const history = fxOutlookHistory(outlook);
  if (p?.active !== true || !Number.isFinite(a?.t) || !Number.isFinite(a?.v) || a.v <= 0
      || history.t.at(-1) !== a.t || history.v.at(-1) !== a.v
      || !r || !Array.isArray(r.t) || r.t.length !== 13 || r.t[0] !== a.t) return false;
  const close = (x, y) => Math.abs(x - y) <= Math.max(1, Math.abs(y)) * 1e-7;
  if (![r.center, r.lower, r.upper, r.log_mean, r.log_sd, r.state_probabilities]
      .every((xs) => Array.isArray(xs) && xs.length === 13)) return false;
  if (!r.t.every((t, i) => Number.isFinite(t) && (i === 0 || t > r.t[i - 1])
      && [r.center[i], r.lower[i], r.upper[i]].every((v) => Number.isFinite(v) && v > 0)
      && r.lower[i] <= r.center[i] && r.center[i] <= r.upper[i]
      && Number.isFinite(r.log_mean[i]) && Number.isFinite(r.log_sd[i]) && r.log_sd[i] >= 0
      && close(r.center[i], a.v * Math.exp(r.log_mean[i]))
      && close(r.lower[i], a.v * Math.exp(r.log_mean[i] - r.log_sd[i]))
      && close(r.upper[i], a.v * Math.exp(r.log_mean[i] + r.log_sd[i]))
      && fxMarkovProbabilities(r.state_probabilities[i]))) return false;
  if (![r.center[0], r.lower[0], r.upper[0]].every((v) => v === a.v) || r.log_sd[0] !== 0 || r.log_mean[0] !== 0) return false;
  if (!Array.isArray(p.regimes) || p.regimes.length !== 3
      || !p.regimes.every((s, i) => s?.id === i
        && [s.mu_daily, s.sigma_daily, s.mu_annual_pct, s.sigma_annual_pct, s.expected_duration_days]
          .every(Number.isFinite)
        && s.sigma_daily > 0 && s.sigma_annual_pct > 0 && s.expected_duration_days >= 1
        && (i === 0 || s.sigma_daily >= p.regimes[i - 1].sigma_daily))) return false;
  if (!Array.isArray(p.transition) || p.transition.length !== 3
      || !p.transition.every(fxMarkovProbabilities)) return false;
  return fxMarkovProbabilities(p.current?.probabilities)
    && Number.isInteger(p.current.regime) && p.current.regime >= 0 && p.current.regime < 3
    && Number.isFinite(p.current.sigma_next_annual_pct) && p.current.sigma_next_annual_pct > 0
    && p.current.probabilities.every((v, i) => close(v, r.state_probabilities[0][i]));
}

function fxMarkovSelection(payload, outlook, years = fxMarkovYears) {
  const history = fxOutlookHistory(outlook), a = payload.anchor;
  const start = new Date(a.t * 1000);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const lo = years ? start.getTime() / 1000 : history.t[0];
  const rows = new Map();
  const row = (t) => { if (!rows.has(t)) rows.set(t, [null, null, null, null]); return rows.get(t); };
  history.t.forEach((t, i) => { if (t >= lo) row(t)[0] = history.v[i]; });
  payload.range.t.forEach((t, i) => {
    const item = row(t);
    item[1] = payload.range.center[i]; item[2] = payload.range.lower[i]; item[3] = payload.range.upper[i];
  });
  const t = [...rows.keys()].sort((x, y) => x - y);
  return { data: [t, ...Array.from({ length: 4 }, (_, i) => t.map((time) => rows.get(time)[i]))],
    min: Math.min(lo, t[0]), max: payload.range.t.at(-1) };
}

function renderFxMarkov(host) {
  if (fxMarkovChartEntry && uplots.includes(fxMarkovChartEntry)) destroyChart(fxMarkovChartEntry);
  fxMarkovChartEntry = null; fxMarkovResize = null;
  if (!host) return;
  host.textContent = "";
  const payload = DATA.fx?.markov, outlook = DATA.fx?.outlook;
  if (!fxMarkovValid(payload, outlook)) {
    host.append(el("div", { class: "card fx-markov-empty", role: "status" },
      el("span", { class: "card-title" }, "USDKRW · Markov 3 Regime"),
      el("p", { class: "card-sub" }, payload?.active
        ? "모형 데이터 또는 최근 관측의 일치 여부를 확인할 수 없어 전망을 표시하지 않습니다."
        : payload?.reason || "마코브 모형 분석 데이터를 불러오지 못했습니다.")));
    return;
  }
  const labels = ["원달러", "로그평균 경로", "로그 1σ 하단", "로그 1σ 상단"];
  const sample = payload.sample || {};
  const names = payload.regimes.map((regime, i) => regime.label || ["저변동", "중변동", "고변동"][i]);
  const pal = palette(), historyColor = "#438fde", forecastColor = "#d4ad58";
  const card = el("div", { class: "card fx-outlook-card fx-markov-chart-card" }); host.append(card);
  const period = el("select", { id: "fx-markov-period", "aria-label": "마코브 모형 원달러 표시기간" });
  [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [0, "전체"]].forEach(([value, label]) =>
    period.append(el("option", { value: String(value) }, label)));
  period.value = String(fxMarkovYears);
  const controls = el("div", { class: "fx-outlook-period" }, el("label", {}, "기간 ", period));
  let selected = fxMarkovSelection(payload, outlook);
  const tableFn = (cap, raw) => tsTableFn(labels.map((s) => `${s} (원/달러)`), selected.data, 0)(cap, raw);
  const box = cardScaffold(card, { title: "USDKRW · Markov 3 Regime", sub: "원/달러", controls,
    csvName: "USDKRW-Markov-3Regime.csv", tableFn });
  box.classList.add("time-chart-hover", "fx-outlook-chart", "fx-markov-chart");
  hedgeChartLegend(box, [["원달러", historyColor], ["로그평균 경로", forecastColor],
    ["국면전환 불확실성 · 로그 ±1σ", forecastColor, true]]);
  const plotHost = el("div", { class: "hedge-plot-host" }); box.append(plotHost);
  const tip = el("div", { class: "time-chart-tooltip", role: "status" }); tip.hidden = true; box.append(tip);
  const summary = el("div", { class: "hedge-outlook-summary fx-markov-current" },
    el("b", {}, `최근 ${fmtNum(payload.anchor.v, 0)}`),
    el("span", {}, tsToDate(payload.anchor.t)),
    el("span", {}, `현재 ${names[payload.current.regime]}`),
    el("span", {}, `다음 거래일 σ(연환산) ${fmtNum(payload.current.sigma_next_annual_pct, 2)}%`));
  card.append(summary);
  const sourceNote = el("p", { class: "card-sub fx-markov-source" },
    `${marketSourceLabel(payload.source)} · 추정 ${sample.start || "–"} ~ ${sample.end || "–"} · 일별 로그수익률 ${Number.isInteger(sample.n_returns) ? sample.n_returns.toLocaleString("ko-KR") : "–"}개`);
  if (payload.source_selection?.fallback_used) sourceNote.append(el("span", {},
    ` · 주 원자료 유효 관측 부재로 ${marketSourceLabel(payload.source)} 대체`));
  card.append(sourceNote);
  card.append(el("p", { class: "card-sub fx-markov-range-note" },
    "로그환율 평균을 원화로 환산한 경로 · 로그 ±1σ 범위. 68% 예측구간이 아니며 모수 추정 불확실성은 제외합니다."));
  const warnings = [];
  if (payload.diagnostics?.weak_volatility_separation) warnings.push("국면 간 변동성 구분이 약합니다.");
  if (payload.diagnostics?.converged === false) warnings.push("모형 추정이 수렴하지 않았습니다.");
  if (warnings.length) card.append(el("p", { class: "fx-markov-warning", role: "status" }, warnings.join(" ")));


  const forecastGrid = el("div", { class: "fx-markov-grid fx-markov-forecasts" }); host.append(forecastGrid);
  [3, 6, 12].forEach((month) => {
    const range = payload.range;
    forecastGrid.append(el("div", { class: "card fx-markov-forecast", "data-month": String(month) },
      el("span", { class: "card-sub" }, `${month}개월 · ${tsToDate(range.t[month])}`),
      el("b", { class: "fx-markov-forecast-value" }, `${fmtNum(range.center[month], 0)}원`),
      el("span", { class: "fx-markov-bounds" }, `${fmtNum(range.lower[month], 0)} ~ ${fmtNum(range.upper[month], 0)}원`),
      el("span", { class: "card-sub" }, `누적 로그 σ ${fmtNum(100 * range.log_sd[month], 2)}%`)));
  });
  const regimeGrid = el("div", { class: "fx-markov-grid fx-markov-regimes" }); host.append(regimeGrid);
  payload.regimes.forEach((regime, i) => {
    const tile = el("div", { class: "card fx-markov-regime", "data-regime": String(i) });
    tile.classList.toggle("is-current", payload.current.regime === i);
    tile.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, names[i]),
      el("span", { class: "card-sub" }, payload.current.regime === i ? "현재 최빈 국면" : "")),
      el("b", { class: "fx-markov-probability" }, `${fmtNum(payload.current.probabilities[i] * 100, 2)}%`),
      el("dl", { class: "fx-markov-metrics" },
        el("dt", {}, "연 변동성"), el("dd", {}, `${fmtNum(regime.sigma_annual_pct, 2)}%`),
        el("dt", {}, "연 로그 드리프트"), el("dd", {}, `${fmtNum(regime.mu_annual_pct, 2)}%`),
        el("dt", {}, "기대 체류기간"), el("dd", {}, `${fmtNum(regime.expected_duration_days, 2)}거래일`)));
    regimeGrid.append(tile);
  });
  const method = el("details", { class: "hedge-outlook-method fx-markov-method" },
    el("summary", {}, "추정 표본 · 전이확률"));
  method.append(el("p", {}, `${sample.start || "–"} ~ ${sample.end || "–"} · 일별 로그수익률 ${Number.isInteger(sample.n_returns) ? sample.n_returns.toLocaleString("ko-KR") : "–"}개. `
    + "일별 수익률의 평균·분산이 3개 잠재 국면에 따라 전환됩니다. 현재 필터링 확률에서 향후 국면을 전파하고, 국면 내 충격과 국면 간 평균 차이를 누적 불확실성에 반영합니다. "
    + "국면은 변동성 순으로 구분하며 상승·하락 방향을 뜻하지 않습니다. 연환산은 252거래일 기준이며 월별 표시는 21모형 거래일을 달력 1개월에 대응합니다."));
  const transition = el("div", { class: "table-wrap fx-markov-transition" });
  renderTable(transition, { headers: ["현재 → 다음 거래일", ...names],
    rows: payload.transition.map((row, i) => [names[i], ...row.map((p) => `${fmtNum(p * 100, 2)}%`)]) });
  method.append(transition); host.append(method);

  const height = 340;
  const bounds = () => {
    const values = selected.data.slice(1).flat().filter(Number.isFinite);
    const min = Math.min(...values), max = Math.max(...values), pad = Math.max(5, (max - min) * .14);
    return [Math.max(0, min - pad), max + pad];
  };
  const options = { width: Math.max(280, box.clientWidth), height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC"), axes: baseAxes(pal, (v) => fmtNum(v, 0)),
    legend: { show: false }, scales: { y: { range: bounds } },
    series: [{ label: "일자" }, ...labels.map((label, i) => ({ label,
      stroke: i === 0 ? historyColor : forecastColor, width: i === 0 ? 1.6 : i === 1 ? 1.4 : 0,
      dash: i === 1 ? [4, 4] : [], spanGaps: i > 0, points: { show: false },
      value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` }))],
    bands: [{ series: [4, 3], fill: hexA(forecastColor, .15) }],
    cursor: { y: false, points: { size: 5 }, drag: { setScale: false } },
    hooks: {
      drawClear: [(u) => {
        const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
        const x = u.valToPos(payload.anchor.t, "x", true);
        ctx.save(); ctx.strokeStyle = pal.ink3; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke(); ctx.restore();
      }],
      setCursor: [(u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0 || top < 0 || !Number.isFinite(u.data[0]?.[idx])) { tip.hidden = true; return; }
        tip.textContent = ""; tip.append(el("strong", {}, tsToDate(u.data[0][idx])));
        labels.forEach((label, i) => {
          const value = u.data[i + 1][idx];
          if (Number.isFinite(value)) tip.append(el("div", {}, el("span", {}, label), el("b", {}, `${fmtNum(value, 0)}원`)));
        });
        const knot = payload.range.t.indexOf(u.data[0][idx]);
        if (knot >= 0) payload.range.state_probabilities[knot].forEach((p, i) => {
          tip.append(el("div", {}, el("span", {}, `${names[i]} 확률`), el("b", {}, `${fmtNum(p * 100, 2)}%`)));
        });
        tip.hidden = false; tip.style.left = left > box.clientWidth / 2 ? "12px" : "auto";
        tip.style.right = left > box.clientWidth / 2 ? "auto" : "12px";
      }], setData: [() => { tip.hidden = true; }],
    },
  };
  const u = new uPlot(options, selected.data, plotHost);
  fxMarkovResize = () => u.setSize({ width: Math.max(280, box.clientWidth), height });
  const ro = new ResizeObserver(() => { if (fxMarkovChartEntry?.u === u) fxMarkovResize?.(); });
  ro.observe(box); fxMarkovChartEntry = trackChart(u, ro);
  box.addEventListener("mouseleave", () => { tip.hidden = true; });
  const update = () => {
    selected = fxMarkovSelection(payload, outlook);
    u.setData(selected.data, false); u.setScale("x", { min: selected.min, max: selected.max });
    const [min, max] = bounds(); u.setScale("y", { min, max });
    const table = card.querySelector(".chart-table");
    if (table && !table.classList.contains("hidden")) renderTable(table, tableFn());
  };
  period.addEventListener("change", () => {
    const years = Number(period.value);
    if (![0, 1, 3, 5, 10].includes(years)) return;
    fxMarkovYears = years; update();
  });
  update();
}
