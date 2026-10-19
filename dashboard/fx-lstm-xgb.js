/* Render the offline LSTM·XGBoost walk-forward artifact (fx.json.lstm_xgb); never refit in the browser.
   The pipeline publishes only base dates, target dates, base/actual spot and model forecasts. Everything
   else on screen — random-walk benchmark, errors, RMSE/MAE/bias/Theil U/hit rate, regime split, period
   filter — is recomputed here from those rows so the evaluation knobs stay live without any training. */
"use strict";

const FX_LX_STORAGE = "iaw-fx-lstm-xgb-v1";
const FX_LX_MODELS = [["ensemble", "앙상블"], ["xgb", "XGBoost"], ["lstm", "LSTM"]];
const FX_LX_RANGES = [["1", "1Y"], ["3", "3Y"], ["5", "5Y"], ["all", "전체"]];
const FX_LX_REGIMES = ["저환율", "중립", "고환율"];
let fxLxView = null;
let fxLxCharts = [];
let fxLstmXgbResize = null;

function fxLxPositive(v) { return Number.isFinite(v) && v > 0; }

function fxLxComboValid(c) {
  if (!c || typeof c.key !== "string" || !Number.isInteger(c.lag) || c.lag < 1
      || !Number.isInteger(c.window) || c.window < 2) return false;
  const arrays = [c.t_base, c.t_target, c.base, c.actual];
  if (!c.pred || !["xgb", "lstm", "ensemble"].every((m) => Array.isArray(c.pred[m]))) return false;
  if (!arrays.every(Array.isArray)) return false;
  const n = c.t_base.length;
  if (n < 1 || arrays.some((a) => a.length !== n) || ["xgb", "lstm", "ensemble"].some((m) => c.pred[m].length !== n)) return false;
  for (let i = 0; i < n; i++) {
    if (!Number.isInteger(c.t_base[i]) || !Number.isInteger(c.t_target[i]) || c.t_target[i] <= c.t_base[i]) return false;
    if (i && c.t_base[i] <= c.t_base[i - 1]) return false;
    if (!fxLxPositive(c.base[i]) || (c.actual[i] !== null && !fxLxPositive(c.actual[i]))) return false;
    if (i && c.actual[i] !== null && c.actual[i - 1] === null) return false;
    if (["xgb", "lstm", "ensemble"].some((m) => !fxLxPositive(c.pred[m][i]))) return false;
  }
  return true;
}

function fxLxValid(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "환율모형B 분석 데이터를 불러오지 못했습니다." };
  if (payload.active !== true) return { ok: false, reason: payload.reason || "모형 산출물이 없습니다." };
  if (!Array.isArray(payload.combos) || !payload.combos.length || !payload.combos.every(fxLxComboValid))
    return { ok: false, reason: "모형 산출물의 형식을 확인할 수 없어 표시하지 않습니다." };
  const lags = [...new Set(payload.combos.map((c) => c.lag))].sort((a, b) => a - b);
  const windows = [...new Set(payload.combos.map((c) => c.window))].sort((a, b) => a - b);
  const grid = payload.grid || {};
  if (!Array.isArray(grid.lags) || !Array.isArray(grid.windows)
      || JSON.stringify([...grid.lags].sort((a, b) => a - b)) !== JSON.stringify(lags)
      || JSON.stringify([...grid.windows].sort((a, b) => a - b)) !== JSON.stringify(windows))
    return { ok: false, reason: "모형 산출물의 그리드가 조합과 맞지 않아 표시하지 않습니다." };
  return { ok: true, reason: null, lags, windows };
}

function fxLxDefaultView(payload, valid) {
  const regime = payload.regime_defaults || {};
  const low = fxLxPositive(regime.low_below) ? regime.low_below : null;
  const high = fxLxPositive(regime.high_above) ? regime.high_above : null;
  return { lag: valid.lags.includes(3) ? 3 : valid.lags[0], window: valid.windows.includes(24) ? 24 : valid.windows[0],
    model: "ensemble", range: "all", low: low !== null && high !== null && low < high ? low : null,
    high: low !== null && high !== null && low < high ? high : null };
}

function fxLxViewState(payload, valid) {
  const dflt = fxLxDefaultView(payload, valid);
  if (!fxLxView) {
    fxLxView = { ...dflt };
    try {
      const saved = JSON.parse(localStorage.getItem(FX_LX_STORAGE) || "{}");
      if (Number.isInteger(saved.lag)) fxLxView.lag = saved.lag;
      if (Number.isInteger(saved.window)) fxLxView.window = saved.window;
      if (FX_LX_MODELS.some(([key]) => key === saved.model)) fxLxView.model = saved.model;
      if (FX_LX_RANGES.some(([key]) => key === saved.range)) fxLxView.range = saved.range;
      if (fxLxPositive(saved.low) && fxLxPositive(saved.high) && saved.low < saved.high) {
        fxLxView.low = saved.low; fxLxView.high = saved.high;
      }
    } catch { /* Unreadable storage keeps the artifact defaults. */ }
  }
  // A saved combo that the current artifact no longer carries falls back visibly to the default.
  if (!valid.lags.includes(fxLxView.lag)) fxLxView.lag = dflt.lag;
  if (!valid.windows.includes(fxLxView.window)) fxLxView.window = dflt.window;
  if (fxLxView.low === null || fxLxView.high === null) { fxLxView.low = dflt.low; fxLxView.high = dflt.high; }
  return fxLxView;
}

function fxLxSave(view, status) {
  try { localStorage.setItem(FX_LX_STORAGE, JSON.stringify(view)); if (status) status.hidden = true; }
  catch { if (status) { status.textContent = "설정을 저장할 수 없어 현재 화면에만 반영합니다."; status.hidden = false; } }
}

function fxLxCombo(payload, lag, window) {
  return payload.combos.find((c) => c.lag === lag && c.window === window) || null;
}

/* Row view of one combo: random walk = the base-date spot carried forward. */
function fxLxRows(combo, model) {
  return combo.t_base.map((tb, i) => ({ tb, tt: combo.t_target[i], base: combo.base[i], actual: combo.actual[i],
    pred: combo.pred[model][i], xgb: combo.pred.xgb[i], lstm: combo.pred.lstm[i], ensemble: combo.pred.ensemble[i],
    rw: combo.base[i] }));
}

function fxLxCutoff(rows, range) {
  if (range === "all") return -Infinity;
  const realized = rows.filter((r) => r.actual !== null);
  if (!realized.length) return -Infinity;
  const last = new Date(realized.at(-1).tt * 1000);
  last.setUTCFullYear(last.getUTCFullYear() - Number(range));
  return last.getTime() / 1000;
}

/* Evaluation on realized rows only. Direction is judged against the base-date level; a random walk
   never calls a direction, so its hit rate is undefined rather than 0. */
function fxLxMetrics(rows, field) {
  const realized = rows.filter((r) => r.actual !== null);
  if (!realized.length) return null;
  const err = realized.map((r) => r[field] - r.actual);
  const rwErr = realized.map((r) => r.rw - r.actual);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const rmse = Math.sqrt(mean(err.map((e) => e * e))), rmseRw = Math.sqrt(mean(rwErr.map((e) => e * e)));
  const judged = realized.filter((r) => r.actual !== r.base);
  const hits = judged.filter((r) => Math.sign(r[field] - r.base) === Math.sign(r.actual - r.base)).length;
  return { n: realized.length, rmse, mae: mean(err.map(Math.abs)), bias: mean(err),
    u: rmseRw > 0 ? rmse / rmseRw : null,
    hit: field !== "rw" && judged.length ? hits / judged.length : null, nDir: field === "rw" ? 0 : judged.length };
}

function fxLxRegime(level, low, high) {
  if (!fxLxPositive(low) || !fxLxPositive(high)) return null;
  return level < low ? 0 : level > high ? 2 : 1;
}

function renderFxLstmXgb(host) {
  fxLxCharts.forEach((entry) => { if (uplots.includes(entry)) destroyChart(entry); });
  fxLxCharts = []; fxLstmXgbResize = null;
  if (!host) return;
  host.textContent = "";
  const payload = DATA.fx?.lstm_xgb;
  const valid = fxLxValid(payload);
  if (!valid.ok) {
    host.append(el("div", { class: "card fx-lx-empty", role: "status" },
      el("span", { class: "card-title" }, "USDKRW · LSTM / XGBoost walk-forward"),
      el("p", { class: "card-sub" }, valid.reason),
      el("p", { class: "card-sub" }, "오프라인 러너(pipeline/research/fx_lstm_xgb_runner.py)의 산출물 fx_lstm_xgb.json 을 "
        + "Data 저장소에 커밋하면 다음 빌드부터 표시됩니다.")));
    return;
  }
  const view = fxLxViewState(payload, valid);
  const pal = palette(), actualColor = "#438fde", modelColor = "#4fc3ad", rwColor = pal.ink3;
  const modelLabel = () => FX_LX_MODELS.find(([key]) => key === view.model)[1];
  const status = el("p", { class: "fx-forecast-status", role: "status" }); status.hidden = true;

  /* ---- controls: which published combo to read, and the live evaluation knobs ---- */
  const controls = el("div", { class: "fx-lx-controls" });
  const select = (id, label, options, value, onChange) => {
    const node = el("select", { id, "aria-label": label });
    options.forEach(([v, text]) => node.append(el("option", { value: String(v) }, text)));
    node.value = String(value);
    node.addEventListener("change", () => onChange(node.value));
    controls.append(el("label", {}, `${label} `, node));
    return node;
  };
  select("fx-lx-lag", "예측 지평", valid.lags.map((l) => [l, `${l}개월`]), view.lag,
    (v) => { view.lag = Number(v); fxLxSave(view, status); update(); });
  select("fx-lx-window", "학습창", valid.windows.map((w) => [w, `${w}개월`]), view.window,
    (v) => { view.window = Number(v); fxLxSave(view, status); update(); });
  select("fx-lx-model", "모형", FX_LX_MODELS, view.model,
    (v) => { view.model = v; fxLxSave(view, status); update(); });
  const rangeGroup = el("div", { class: "rp-ranges", role: "group", "aria-label": "평가기간" }, el("span", { class: "card-sub" }, "평가기간"));
  const rangeButtons = {};
  FX_LX_RANGES.forEach(([key, text]) => {
    const button = el("button", { id: `fx-lx-range-${key}`, type: "button", class: "btn-ghost",
      "aria-pressed": String(view.range === key), onclick: () => { view.range = key; fxLxSave(view, status); update(); } }, text);
    rangeButtons[key] = button; rangeGroup.append(button);
  });
  controls.append(rangeGroup);
  const lowInput = el("input", { id: "fx-lx-regime-low", type: "number", step: "any", min: "0",
    value: view.low === null ? "" : String(view.low), "aria-label": "저환율 상한 (원/달러)" });
  const highInput = el("input", { id: "fx-lx-regime-high", type: "number", step: "any", min: "0",
    value: view.high === null ? "" : String(view.high), "aria-label": "고환율 하한 (원/달러)" });
  const regimeStatus = el("span", { id: "fx-lx-regime-status", class: "alloc-period-status d-up", role: "status" });
  regimeStatus.hidden = true;
  const applyRegime = () => {
    const low = Number(lowInput.value), high = Number(highInput.value);
    if (lowInput.value.trim() === "" || highInput.value.trim() === "" || !fxLxPositive(low) || !fxLxPositive(high) || low >= high) {
      regimeStatus.textContent = "국면 경계는 0보다 큰 숫자이고 저환율 상한 < 고환율 하한이어야 합니다. 이전 경계를 유지합니다.";
      regimeStatus.hidden = false; return;
    }
    view.low = low; view.high = high; regimeStatus.hidden = true; fxLxSave(view, status); update();
  };
  [lowInput, highInput].forEach((node) => node.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); applyRegime(); }
  }));
  controls.append(el("label", {}, "국면 경계 저환율 <", lowInput),
    el("label", {}, "고환율 >", highInput),
    el("button", { id: "fx-lx-regime-apply", type: "button", class: "btn-ghost", onclick: applyRegime }, "경계 적용"),
    regimeStatus);

  /* ---- latest forecast tiles ---- */
  const tiles = el("div", { class: "hedge-merit-tiles fx-lx-tiles" });
  const tile = (title, number, sub, id) => el("div", { id, class: "card hedge-merit-tile" },
    el("div", { class: "card-title" }, title), el("div", { class: "hedge-merit-value" }, number),
    el("div", { class: "card-sub" }, sub));

  /* ---- chart card: actual vs forecast vs random walk on the target date axis ---- */
  const chartCard = el("div", { class: "card fx-outlook-card fx-lx-chart-card" });
  let rows = [], shown = [], cutoff = -Infinity;
  const labels = () => ["실제 환율", `${modelLabel()} 예측`, "랜덤워크(기준 환율 유지)"];
  const chartData = () => {
    const t = shown.map((r) => r.tt);
    return [t, shown.map((r) => r.actual), shown.map((r) => r.pred), shown.map((r) => r.rw)];
  };
  const tableFn = (cap = Infinity, raw = false) => {
    const num = (v) => v === null || v === undefined ? (raw ? "" : "–") : raw ? v : fmtNum(v, 0);
    const take = shown.slice().reverse().slice(0, cap);
    return {
      headers: ["기준일", "예측시점", "기준 환율", "실제 환율", "XGBoost", "LSTM", "앙상블", "랜덤워크",
        `${modelLabel()} 오차`, "랜덤워크 오차"],
      rows: take.map((r) => [tsToDate(r.tb), tsToDate(r.tt), num(r.base), num(r.actual), num(r.xgb), num(r.lstm),
        num(r.ensemble), num(r.rw), num(r.actual === null ? null : r.pred - r.actual),
        num(r.actual === null ? null : r.rw - r.actual)]),
    };
  };
  const box = cardScaffold(chartCard, { title: "USDKRW · LSTM / XGBoost walk-forward", sub: "원/달러 · 예측시점 기준",
    csvName: "USDKRW-LSTM-XGB-backtest.csv", tableFn });
  box.classList.add("time-chart-hover", "fx-outlook-chart", "fx-lx-chart");
  hedgeChartLegend(box, [["실제 환율", actualColor], ["모형 예측", modelColor], ["랜덤워크", rwColor, true]]);
  const plotHost = el("div", { class: "hedge-plot-host" }); box.append(plotHost);
  const tip = el("div", { class: "time-chart-tooltip", role: "status" }); tip.hidden = true; box.append(tip);
  box.addEventListener("mouseleave", () => { tip.hidden = true; });
  const chartNote = el("p", { class: "card-sub fx-lx-chart-note", role: "status" }); chartCard.append(chartNote);

  /* ---- error card ---- */
  const errorCard = el("div", { class: "card fx-outlook-card fx-lx-error-card" });
  const errorBox = cardScaffold(errorCard, { title: "실제 − 전망 차이", sub: "원 · 예측 − 실제 (양수 = 과대 예측)" });
  errorBox.classList.add("time-chart-hover", "fx-outlook-chart", "fx-lx-error-chart");
  hedgeChartLegend(errorBox, [["모형 오차", modelColor], ["랜덤워크 오차", rwColor, true]]);
  const errorHost = el("div", { class: "hedge-plot-host" }); errorBox.append(errorHost);
  const errorTip = el("div", { class: "time-chart-tooltip", role: "status" }); errorTip.hidden = true; errorBox.append(errorTip);
  errorBox.addEventListener("mouseleave", () => { errorTip.hidden = true; });
  const errorData = () => {
    const realized = shown.filter((r) => r.actual !== null);
    return [realized.map((r) => r.tt), realized.map((r) => r.pred - r.actual), realized.map((r) => r.rw - r.actual)];
  };

  /* ---- metrics ---- */
  const metricsCard = el("div", { class: "card fx-lx-metrics-card" });
  const metricsHead = el("div", { class: "card-head" }, el("span", { class: "card-title" }, "백테스트 지표"),
    el("span", { class: "card-sub", id: "fx-lx-metrics-sub" }));
  const metricsWrap = el("div", { class: "table-wrap fx-lx-metrics" });
  const regimeWrap = el("div", { class: "table-wrap fx-lx-regimes" });
  const regimeHead = el("p", { class: "card-sub", id: "fx-lx-regime-sub" });
  metricsCard.append(metricsHead, metricsWrap, regimeHead, regimeWrap);

  /* ---- method ---- */
  const model = payload.model || {}, runner = payload.runner || {}, data = payload.data || {};
  const method = el("details", { class: "hedge-outlook-method fx-lx-method" }, el("summary", {}, "모형 설정 · 가정"));
  const lstm = model.lstm || {}, ns = model.ns || {}, arma = model.arma || {};
  method.append(el("p", {}, `피처 ${Array.isArray(model.features) ? model.features.length : "–"}개: ${(model.features || []).join(" · ") || "–"}. `
    + `Nelson–Siegel λ ${ns.lambda ?? "–"} (만기 ${(ns.maturities_years || []).join("/") || "–"}년, 결측 ${ns.fill || "–"}), `
    + `ARIMA(${(arma.order || []).join(",") || "–"}) 롤링 ${arma.window_months ?? "–"}개월, 국제수지 공표 지연 ${model.bop_lag_months ?? "–"}개월.`));
  method.append(el("p", {}, `기준일마다 직전 학습창(선택 ${view.window}개월, 실현된 라벨만 — ${runner.label_alignment || "–"})으로 다시 학습해 `
    + `${view.lag}개월 뒤 수준을 예측합니다. LSTM hidden ${lstm.hidden_size ?? "–"} · ${lstm.num_layers ?? "–"}층 · seq ${lstm.seq_len ?? "–"} · `
    + `${lstm.epochs ?? "–"} epoch · lr ${lstm.lr ?? "–"} · 표준화, XGBoost 기본 파라미터, 앙상블 = 두 모형 단순평균. 시드 ${runner.seed ?? "–"}.`));
  method.append(el("p", {}, `산출 ${payload.generated_at || "–"} · 피처 ${data.feature_start || "–"} ~ ${data.feature_end || "–"} (${data.n_feature_rows ?? "–"}개월) · `
    + `${payload.path || payload.artifact}. 모형은 브라우저에서 다시 추정하지 않습니다. 랜덤워크·오차·지표·국면 구분은 게시된 행에서 화면이 계산합니다. `
    + "참고 표시 전용이며 등급·경보·자산배분에 연결되지 않습니다. 표본 외 우월성은 아래 지표로만 판단합니다."));

  host.append(controls, status, tiles, chartCard, errorCard, metricsCard, method);

  /* ---- uPlot ---- */
  const height = 320, errorHeight = 200;
  const bounds = (data, pad0) => {
    const values = data.slice(1).flat().filter(Number.isFinite);
    if (!values.length) return [0, 1];
    const min = Math.min(...values), max = Math.max(...values), pad = Math.max(pad0, (max - min) * .12);
    return [min - pad, max + pad];
  };
  const tooltip = (u, tipNode, boxNode, names, unit) => {
    const { idx, left, top } = u.cursor;
    if (idx == null || left < 0 || top < 0 || !Number.isFinite(u.data[0]?.[idx])) { tipNode.hidden = true; return; }
    tipNode.textContent = ""; tipNode.append(el("strong", {}, tsToDate(u.data[0][idx])));
    names.forEach((label, i) => {
      const value = u.data[i + 1][idx];
      if (Number.isFinite(value)) tipNode.append(el("div", {}, el("span", {}, label), el("b", {}, `${fmtNum(value, 0)}${unit}`)));
    });
    tipNode.hidden = false; tipNode.style.left = left > boxNode.clientWidth / 2 ? "12px" : "auto";
    tipNode.style.right = left > boxNode.clientWidth / 2 ? "auto" : "12px";
  };
  let lastRealizedT = null;
  const mainOptions = { width: Math.max(280, box.clientWidth), height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC"), axes: baseAxes(pal, (v) => fmtNum(v, 0)),
    legend: { show: false }, scales: { y: { range: (u, lo, hi) => bounds(u.data, 5) } },
    series: [{ label: "예측시점" },
      { label: "실제 환율", stroke: actualColor, width: 1.6, spanGaps: false, points: { show: false }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` },
      { label: "모형 예측", stroke: modelColor, width: 1.4, spanGaps: true, points: { show: false }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` },
      { label: "랜덤워크", stroke: rwColor, width: 1, dash: [4, 4], spanGaps: true, points: { show: false }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` }],
    cursor: { y: false, points: { size: 5 }, drag: { setScale: false } },
    hooks: {
      drawClear: [(u) => {
        if (!Number.isFinite(lastRealizedT)) return;
        const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
        const x = u.valToPos(lastRealizedT, "x", true);
        ctx.save(); ctx.strokeStyle = pal.ink3; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke(); ctx.restore();
      }],
      setCursor: [(u) => tooltip(u, tip, box, labels(), "원")], setData: [() => { tip.hidden = true; }],
    } };
  const errorOptions = { width: Math.max(280, errorBox.clientWidth), height: errorHeight,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC"), axes: baseAxes(pal, (v) => fmtNum(v, 0)),
    legend: { show: false }, scales: { y: { range: (u, lo, hi) => bounds(u.data, 5) } },
    series: [{ label: "예측시점" },
      { label: "모형 오차", stroke: modelColor, width: 1.4, spanGaps: true, points: { show: false }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` },
      { label: "랜덤워크 오차", stroke: rwColor, width: 1, dash: [4, 4], spanGaps: true, points: { show: false }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 0)}원` }],
    cursor: { y: false, points: { size: 5 }, drag: { setScale: false } },
    hooks: {
      drawClear: [(u) => {
        const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
        const y = u.valToPos(0, "y", true);
        if (!Number.isFinite(y)) return;
        ctx.save(); ctx.strokeStyle = pal.baseline || pal.ink3; ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke(); ctx.restore();
      }],
      setCursor: [(u) => tooltip(u, errorTip, errorBox, [`${modelLabel()} 오차`, "랜덤워크 오차"], "원")],
      setData: [() => { errorTip.hidden = true; }],
    } };
  let mainPlot = null, errorPlot = null;
  const mount = () => {
    const data = chartData(), err = errorData();
    if (!mainPlot && data[0].length) {
      mainPlot = new uPlot(mainOptions, data, plotHost);
      const ro = new ResizeObserver(() => fxLstmXgbResize?.());
      ro.observe(box); fxLxCharts.push(trackChart(mainPlot, ro));
    }
    if (!errorPlot && err[0].length) {
      errorPlot = new uPlot(errorOptions, err, errorHost);
      const ro = new ResizeObserver(() => fxLstmXgbResize?.());
      ro.observe(errorBox); fxLxCharts.push(trackChart(errorPlot, ro));
    }
    fxLstmXgbResize = () => {
      mainPlot?.setSize({ width: Math.max(280, box.clientWidth), height });
      errorPlot?.setSize({ width: Math.max(280, errorBox.clientWidth), height: errorHeight });
    };
  };

  const metricRow = (name, m) => [name, m ? String(m.n) : "0", m ? fmtNum(m.rmse, 1) : "–", m ? fmtNum(m.mae, 1) : "–",
    m ? fmtNum(m.bias, 1) : "–", m && m.u !== null ? fmtNum(m.u, 3) : "–",
    m && m.hit !== null ? `${fmtNum(m.hit * 100, 0)}% (${m.nDir})` : "–"];
  function update() {
    const combo = fxLxCombo(payload, view.lag, view.window);
    if (!combo) { status.textContent = `선택한 조합(${view.lag}개월 · ${view.window}개월)의 산출물이 없습니다.`; status.hidden = false; return; }
    rows = fxLxRows(combo, view.model);
    cutoff = fxLxCutoff(rows, view.range);
    shown = rows.filter((r) => r.tt >= cutoff);
    const realized = rows.filter((r) => r.actual !== null);
    lastRealizedT = realized.length ? realized.at(-1).tt : null;
    Object.entries(rangeButtons).forEach(([key, button]) => button.setAttribute("aria-pressed", String(view.range === key)));
    // Latest forecast = the last published row (pending when its target date is still ahead).
    const last = rows.at(-1);
    tiles.textContent = "";
    const delta = (v) => `${v >= last.base ? "+" : ""}${fmtNum((v / last.base - 1) * 100, 2)}%`;
    tiles.append(tile("기준 환율", `${fmtNum(last.base, 0)}원`, `기준일 ${tsToDate(last.tb)}`, "fx-lx-tile-base"));
    FX_LX_MODELS.forEach(([key, name]) => tiles.append(tile(`${name} · ${view.lag}개월 후`, `${fmtNum(last[key], 0)}원`,
      `${tsToDate(last.tt)} · 기준 대비 ${delta(last[key])}${last.actual === null ? "" : ` · 실제 ${fmtNum(last.actual, 0)}원`}`,
      `fx-lx-tile-${key}`)));
    mount();
    if (mainPlot) {
      const data = chartData();
      mainPlot.setData(data, false);
      if (data[0].length) {
        mainPlot.setScale("x", { min: data[0][0], max: data[0].at(-1) });
        const [min, max] = bounds(data, 5); mainPlot.setScale("y", { min, max });
      }
    }
    if (errorPlot) {
      const err = errorData();
      if (err[0].length) {
        errorPlot.setData(err, false);
        errorPlot.setScale("x", { min: err[0][0], max: err[0].at(-1) });
        const [min, max] = bounds(err, 5); errorPlot.setScale("y", { min, max });
      }
    }
    const pending = shown.filter((r) => r.actual === null).length;
    chartNote.textContent = `${modelLabel()} · 지평 ${view.lag}개월 · 학습창 ${view.window}개월 · 표시 ${shown.length}행`
      + (pending ? ` (미실현 예측 ${pending}행 — 점선 오른쪽)` : "") + (combo.n_realized ? "" : " · 실현된 예측이 아직 없습니다.");
    const table = chartCard.querySelector(".chart-table");
    if (table && !table.classList.contains("hidden")) renderTable(table, tableFn());
    // Metrics: every model on the same realized rows, selected one in bold.
    const evalRows = shown;
    const metrics = Object.fromEntries([...FX_LX_MODELS.map(([key]) => key), "rw"].map((key) => [key, fxLxMetrics(evalRows, key)]));
    const realizedShown = evalRows.filter((r) => r.actual !== null);
    document.getElementById("fx-lx-metrics-sub").textContent = realizedShown.length
      ? `실현 ${realizedShown.length}행 · ${tsToDate(realizedShown[0].tt)} ~ ${tsToDate(realizedShown.at(-1).tt)} · Theil U = RMSE ÷ 랜덤워크 RMSE (1 미만이면 우월)`
      : "실현된 예측이 없어 지표를 계산하지 않습니다.";
    renderTable(metricsWrap, { headers: ["모형", "N", "RMSE(원)", "MAE(원)", "편향(원)", "Theil U", "방향 적중률"],
      rows: [...FX_LX_MODELS.map(([key, name]) => metricRow(name, metrics[key])), metricRow("랜덤워크", metrics.rw)] });
    [...metricsWrap.querySelectorAll("tr")].forEach((tr) => {
      const name = tr.children?.[0]?.textContent;
      tr.classList.toggle("is-selected", name === modelLabel());
    });
    regimeHead.textContent = view.low === null
      ? "국면 경계가 없어 국면별 지표를 표시하지 않습니다."
      : `${modelLabel()} · 기준일 환율 기준 국면 — 저환율 < ${fmtNum(view.low, 0)} · 고환율 > ${fmtNum(view.high, 0)} (원/달러)`;
    const regimeRows = FX_LX_REGIMES.map((name, i) => {
      const subset = evalRows.filter((r) => fxLxRegime(r.base, view.low, view.high) === i);
      const m = fxLxMetrics(subset, view.model);
      return [name, m ? String(m.n) : "0", m ? fmtNum(m.rmse, 1) : "–", m ? fmtNum(m.bias, 1) : "–",
        m && m.u !== null ? fmtNum(m.u, 3) : "–", m && m.hit !== null ? `${fmtNum(m.hit * 100, 0)}% (${m.nDir})` : "–"];
    });
    renderTable(regimeWrap, { headers: ["국면", "N", "RMSE(원)", "편향(원)", "Theil U", "방향 적중률"],
      rows: view.low === null ? [] : regimeRows });
    status.hidden = true;
  }
  update();
}
