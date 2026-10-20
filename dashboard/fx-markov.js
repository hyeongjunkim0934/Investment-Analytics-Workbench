/* Render versioned Monte Carlo summaries; never refit or resimulate in the browser. */
"use strict";

let fxMarkovYears = 3;
let fxMarkovInterval = 68;
let fxMarkovShowPaths = true;
let fxMarkovChartEntry = null;
let fxMarkovResize = null;

function fxMarkovProbabilities(values) {
  return Array.isArray(values) && values.length === 3
    && values.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) < 1e-6;
}

function fxMarkovValid(payload, outlook) {
  const p = payload, a = p?.anchor, s = p?.simulation;
  const history = fxOutlookHistory(outlook);
  if (p?.active !== true || !Number.isFinite(a?.t) || !Number.isFinite(a?.v) || a.v <= 0
      || history.t.at(-1) !== a.t || history.v.at(-1) !== a.v
      || s?.schema_version !== 1 || s.engine !== "gaussian_markov_log_returns"
      || !Number.isInteger(s.path_count) || s.path_count < 2
      || !Number.isInteger(s.seed) || s.seed < 0 || s.parameter_uncertainty_included !== false
      || !Array.isArray(s.t) || s.t.length !== 253 || s.t[0] !== a.t) return false;
  const n = s.t.length, vectors = [s.mean, s.median, s.lower68, s.upper68, s.lower95, s.upper95];
  if (![...vectors, s.steps, s.mean_mc_se, s.state_probabilities]
      .every((xs) => Array.isArray(xs) && xs.length === n)) return false;
  if (!s.t.every((t, i) => Number.isFinite(t) && (i === 0 || t > s.t[i - 1])
      && s.steps[i] === i && vectors.every((v) => Number.isFinite(v[i]) && v[i] > 0)
      && s.lower95[i] <= s.lower68[i] && s.lower68[i] <= s.median[i]
      && s.median[i] <= s.upper68[i] && s.upper68[i] <= s.upper95[i]
      && Number.isFinite(s.mean_mc_se[i]) && s.mean_mc_se[i] >= 0
      && fxMarkovProbabilities(s.state_probabilities[i]))) return false;
  // A skewed distribution's arithmetic mean need not lie inside a central interval.
  if (!vectors.every((v) => v[0] === a.v) || s.mean_mc_se[0] !== 0) return false;
  if (!Array.isArray(s.sample_paths) || s.sample_paths.length > Math.min(s.path_count, 24)
      || !s.sample_paths.every((path) => Array.isArray(path) && path.length === n
        && path[0] === a.v && path.every((v) => Number.isFinite(v) && v > 0))) return false;
  if (!Array.isArray(p.regimes) || p.regimes.length !== 3
      || !p.regimes.every((r, i) => r?.id === i
        && [r.mu_daily, r.sigma_daily, r.mu_annual_pct, r.sigma_annual_pct, r.expected_duration_days]
          .every(Number.isFinite)
        && r.sigma_daily > 0 && r.sigma_annual_pct > 0 && r.expected_duration_days >= 1
        && (i === 0 || r.sigma_daily >= p.regimes[i - 1].sigma_daily))) return false;
  if (!Array.isArray(p.transition) || p.transition.length !== 3
      || !p.transition.every(fxMarkovProbabilities)) return false;
  return fxMarkovProbabilities(p.current?.probabilities)
    && Number.isInteger(p.current.regime) && p.current.regime >= 0 && p.current.regime < 3
    && Number.isFinite(p.current.sigma_next_annual_pct) && p.current.sigma_next_annual_pct > 0;
}

function fxMarkovSelection(payload, outlook, years = fxMarkovYears) {
  const history = fxOutlookHistory(outlook), a = payload.anchor, s = payload.simulation;
  const start = new Date(a.t * 1000);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const lo = years ? start.getTime() / 1000 : history.t[0];
  const rows = new Map(), count = 5 + s.sample_paths.length;
  const row = (t) => { if (!rows.has(t)) rows.set(t, Array(count).fill(null)); return rows.get(t); };
  history.t.forEach((t, i) => { if (t >= lo) row(t)[0] = history.v[i]; });
  s.t.forEach((t, i) => {
    const item = row(t);
    item[1] = s.mean[i]; item[2] = s.median[i];
    item[3] = s[`lower${fxMarkovInterval}`][i]; item[4] = s[`upper${fxMarkovInterval}`][i];
    if (fxMarkovShowPaths) s.sample_paths.forEach((path, j) => { item[5 + j] = path[i]; });
  });
  const t = [...rows.keys()].sort((x, y) => x - y);
  return { data: [t, ...Array.from({ length: count }, (_, i) => t.map((time) => rows.get(time)[i]))],
    min: Math.min(lo, t[0]), max: s.t.at(-1) };
}

function renderFxMarkov(host) {
  if (fxMarkovChartEntry && uplots.includes(fxMarkovChartEntry)) destroyChart(fxMarkovChartEntry);
  fxMarkovChartEntry = null; fxMarkovResize = null;
  if (!host) return;
  host.textContent = "";
  const payload = DATA.fx?.markov, outlook = DATA.fx?.outlook;
  if (!fxMarkovValid(payload, outlook)) {
    host.append(el("div", { class: "card fx-markov-empty", role: "status" },
      el("span", { class: "card-title" }, "USDKRW · Markov Monte Carlo"),
      el("p", { class: "card-sub" }, payload?.active
        ? "모형 데이터 또는 최근 관측의 일치 여부를 확인할 수 없어 전망을 표시하지 않습니다."
        : payload?.reason || "마코브 모형 분석 데이터를 불러오지 못했습니다.")));
    return;
  }
  const simulation = payload.simulation, sample = payload.sample || {};
  const labels = ["원달러", "시뮬레이션 평균", "시뮬레이션 중앙값", "", ""];
  const setLabels = () => {
    labels[3] = `${fxMarkovInterval}% 하단`; labels[4] = `${fxMarkovInterval}% 상단`;
  };
  setLabels();
  const names = payload.regimes.map((regime, i) => regime.label || ["저변동", "중변동", "고변동"][i]);
  const pal = palette(), historyColor = "#438fde", forecastColor = "#d4ad58", medianColor = "#64c5bb";
  const card = el("div", { class: "card fx-outlook-card fx-markov-chart-card" }); host.append(card);
  const period = el("select", { id: "fx-markov-period", "aria-label": "마코브 모형 원달러 표시기간" });
  [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [0, "전체"]].forEach(([value, label]) =>
    period.append(el("option", { value: String(value) }, label)));
  period.value = String(fxMarkovYears);
  const interval = el("select", { id: "fx-markov-interval", "aria-label": "몬테카를로 불확실성 구간" });
  [68, 95].forEach((value) => interval.append(el("option", { value: String(value) }, `${value}%`)));
  interval.value = String(fxMarkovInterval);
  const paths = el("input", { id: "fx-markov-paths", type: "checkbox" }); paths.checked = fxMarkovShowPaths;
  const controls = el("div", { class: "fx-outlook-period fx-markov-controls" },
    el("label", {}, "기간 ", period), el("label", {}, "구간 ", interval), el("label", {}, paths, "표본 경로"));
  let selected = fxMarkovSelection(payload, outlook);
  const tableFn = (cap, raw) => tsTableFn(labels.map((s) => `${s} (원/달러)`), selected.data.slice(0, 6), 0)(cap, raw);
  const box = cardScaffold(card, { title: "USDKRW · Markov Monte Carlo", sub: "원/달러", controls,
    csvName: "USDKRW-Markov-MonteCarlo.csv", tableFn });
  box.classList.add("time-chart-hover", "fx-outlook-chart", "fx-markov-chart");
  const legend = hedgeChartLegend(box, [["원달러", historyColor], ["평균", forecastColor], ["중앙값", medianColor],
    [`${fxMarkovInterval}% 구간`, forecastColor, true]]);
  const plotHost = el("div", { class: "hedge-plot-host" }); box.append(plotHost);
  const tip = el("div", { class: "time-chart-tooltip", role: "status" }); tip.hidden = true; box.append(tip);
  card.append(el("div", { class: "hedge-outlook-summary fx-markov-current" },
    el("b", {}, `최근 ${fmtNum(payload.anchor.v, 0)}`),
    el("span", {}, tsToDate(payload.anchor.t)),
    el("span", {}, `현재 ${names[payload.current.regime]}`),
    el("span", {}, `${simulation.path_count.toLocaleString("ko-KR")}회 · 252단계`)));
  const warnings = [];
  if (payload.diagnostics?.weak_volatility_separation) warnings.push("국면 간 변동성 구분이 약합니다.");
  if (payload.diagnostics?.converged === false) warnings.push("모형 추정이 수렴하지 않았습니다.");
  if (warnings.length) card.append(el("p", { class: "fx-markov-warning", role: "status" }, warnings.join(" ")));

  const forecastGrid = el("div", { class: "fx-markov-grid fx-markov-forecasts" }); host.append(forecastGrid);
  const forecastBounds = [];
  [3, 6, 12].forEach((month) => {
    const i = month * 21;
    const bounds = el("span", { class: "fx-markov-bounds" }); forecastBounds.push([i, bounds]);
    forecastGrid.append(el("div", { class: "card fx-markov-forecast", "data-month": String(month) },
      el("span", { class: "card-sub" }, `${month}개월 · ${tsToDate(simulation.t[i])}`),
      el("div", { class: "fx-markov-center-row" }, el("span", {}, "평균"),
        el("b", { class: "fx-markov-forecast-value" }, `${fmtNum(simulation.mean[i], 0)}원`)),
      el("div", { class: "fx-markov-center-row" }, el("span", {}, "중앙값"),
        el("b", { class: "fx-markov-forecast-value fx-markov-median-value" }, `${fmtNum(simulation.median[i], 0)}원`)), bounds));
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
    el("summary", {}, "모형 · 시뮬레이션"));
  const sourceNote = el("p", { class: "card-sub fx-markov-source" },
    `${marketSourceLabel(payload.source)} · 추정 ${sample.start || "–"} ~ ${sample.end || "–"} · 일별 로그수익률 ${Number.isInteger(sample.n_returns) ? sample.n_returns.toLocaleString("ko-KR") : "–"}개`);
  if (payload.source_selection?.fallback_used) card.append(el("p", { class: "card-sub fx-markov-fallback" },
    `주 원자료 유효 관측 부재로 ${marketSourceLabel(payload.source)} 대체`));
  method.append(sourceNote, el("p", {},
    `경로 ${simulation.path_count.toLocaleString("ko-KR")}개 · 시드 ${simulation.seed} · 표본 경로 ${simulation.sample_paths.length}개 · 스키마 ${simulation.schema_version}. `
    + "각 경로에서 현재 필터링 확률로 국면을 뽑고 전이확률과 국면별 정규 로그수익률 충격을 순차 모의합니다. 평균은 환율 수준의 산술평균, 중앙값과 68%·95% 구간은 각 시점의 경로 분포 분위수입니다. "
    + "구간은 시점별 조건부 예측구간이며 전체 경로의 동시포함 확률이 아닙니다. 모수 추정 불확실성은 제외하며 실현 커버리지와 표본 외 예측력은 미검증입니다. "
    + "표본 경로는 생성 순서 앞부분을 표시하며 대표 분위수 경로가 아닙니다. 평균·중앙값은 많은 경로를 집계하므로 개별 경로보다 매끄러울 수 있습니다. "
    + "국면은 변동성 순서이며 상승·하락 방향을 뜻하지 않습니다. 21모형 거래일을 달력 1개월에 대응하고 중간 단계는 달력 축에 등간격 배치합니다. 실제 거래일 달력은 아닙니다."));
  const diagnostics = el("div", { class: "table-wrap fx-markov-mc-diagnostics" });
  renderTable(diagnostics, { headers: ["기간", "평균 MC 표준오차 (원/달러)"],
    rows: [3, 6, 12].map((month) => [`${month}개월`, fmtNum(simulation.mean_mc_se[month * 21], 2)]) });
  const transition = el("div", { class: "table-wrap fx-markov-transition" });
  renderTable(transition, { headers: ["현재 → 다음 거래일", ...names],
    rows: payload.transition.map((row, i) => [names[i], ...row.map((p) => `${fmtNum(p * 100, 2)}%`)]) });
  method.append(diagnostics, transition); host.append(method);

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
      stroke: i === 0 ? historyColor : i === 2 ? medianColor : forecastColor,
      width: i === 0 ? 1.6 : i < 3 ? 2 : 0, dash: i === 2 ? [6, 3] : [],
      spanGaps: i > 0, points: { show: false },
      value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` })),
      ...simulation.sample_paths.map((_, i) => ({ label: `표본 ${i + 1}`, stroke: hexA(forecastColor, .15),
        width: .8, spanGaps: true, points: { show: false } }))],
    bands: [{ series: [5, 4], fill: hexA(forecastColor, .15) }],
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
        const step = simulation.t.indexOf(u.data[0][idx]);
        if (step > 0) simulation.state_probabilities[step].forEach((p, i) => {
          tip.append(el("div", {}, el("span", {}, `${names[i]} 모의 비중`), el("b", {}, `${fmtNum(p * 100, 2)}%`)));
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
    setLabels(); selected = fxMarkovSelection(payload, outlook);
    if (u.series) labels.forEach((label, i) => { u.series[i + 1].label = label; });
    const item = legend.children[3];
    item.textContent = ""; item.append(el("i", { style: `--legend-color:${forecastColor}`, class: "is-band" }), `${fxMarkovInterval}% 구간`);
    forecastBounds.forEach(([i, node]) => { node.textContent = `${fxMarkovInterval}% · ${fmtNum(simulation[`lower${fxMarkovInterval}`][i], 0)} ~ ${fmtNum(simulation[`upper${fxMarkovInterval}`][i], 0)}원`; });
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
  interval.addEventListener("change", () => {
    const value = Number(interval.value);
    if (![68, 95].includes(value)) return;
    fxMarkovInterval = value; update();
  });
  paths.addEventListener("change", () => { fxMarkovShowPaths = paths.checked; update(); });
  update();
}
