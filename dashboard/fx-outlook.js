/* USDKRW history and conditional 1Y range from the full raw daily sample.
   Quarter-end forecasts are user inputs, separate from the statistical range. */
"use strict";

const FX_OUTLOOK_STORAGE = "iaw-fx-outlook-v1";
let fxForecastValues = null;
const fxForecastDrafts = {};
let fxOutlookYears = 3;
let fxOutlookChartEntry = null;

function fxOutlookToday(now = new Date()) {
  // Calendar quarters follow Korea even if the browser's local timezone differs.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (key) => Number(parts.find((p) => p.type === key).value);
  return Date.UTC(get("year"), get("month") - 1, get("day")) / 1000;
}

function fxOutlookQuarters(anchor, today = fxOutlookToday()) {
  const reference = Math.max(Number.isFinite(anchor) ? anchor : today, today);
  const date = new Date(reference * 1000);
  let year = date.getUTCFullYear(), quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const end = () => Date.UTC(year, quarter * 3, 0) / 1000;
  if (end() <= reference) { quarter++; if (quarter > 4) { quarter = 1; year++; } }
  return Array.from({ length: 6 }, () => {
    const row = { key: `${year}-Q${quarter}`, label: `${year} Q${quarter}`,
      short: `${String(year).slice(-2)}Q${quarter}`, t: end() };
    quarter++; if (quarter > 4) { quarter = 1; year++; }
    return row;
  });
}

function fxOutlookForecasts() {
  if (fxForecastValues) return fxForecastValues;
  fxForecastValues = {};
  try {
    const saved = JSON.parse(localStorage.getItem(FX_OUTLOOK_STORAGE) || "{}");
    Object.entries(saved.forecasts || {}).forEach(([key, value]) => {
      if (/^\d{4}-Q[1-4]$/.test(key) && typeof value === "number" && Number.isFinite(value) && value > 0)
        fxForecastValues[key] = value;
    });
  } catch { /* Unreadable storage starts empty; never invent forecasts. */ }
  return fxForecastValues;
}

function fxOutlookHistory(payload) {
  const history = payload?.history || {};
  const rows = new Map();
  (Array.isArray(history.t) ? history.t : []).forEach((t, i) => {
    const v = history.v?.[i];
    if (Number.isFinite(t) && Number.isFinite(v) && v > 0) rows.set(t, v);
  });
  const t = [...rows.keys()].sort((a, b) => a - b);
  return { t, v: t.map((time) => rows.get(time)) };
}

function fxOutlookRangeValid(payload) {
  const r = payload?.range, a = payload?.anchor;
  if (!payload?.active || !Number.isFinite(a?.t) || !Number.isFinite(a?.v) || a.v <= 0
      || !r || !Array.isArray(r.t) || r.t.length !== 13 || r.t[0] !== a.t) return false;
  if (![r.center, r.lower, r.upper].every((xs) => Array.isArray(xs) && xs.length === 13)) return false;
  return r.t.every((t, i) => Number.isFinite(t) && (i === 0 || t > r.t[i - 1])
    && [r.center[i], r.lower[i], r.upper[i]].every((v) => Number.isFinite(v) && v > 0)
    && r.lower[i] <= r.center[i] && r.center[i] <= r.upper[i])
    && [r.center[0], r.lower[0], r.upper[0]].every((v) => v === a.v);
}

function fxOutlookSelection(payload, quarters, years = fxOutlookYears) {
  const history = fxOutlookHistory(payload), anchor = history.t.length
    ? { t: history.t.at(-1), v: history.v.at(-1) } : null;
  const origin = anchor?.t ?? fxOutlookToday(), start = new Date(origin * 1000);
  start.setUTCFullYear(start.getUTCFullYear() - (years || 0));
  const lo = years ? start.getTime() / 1000 : history.t[0] ?? origin;
  const values = fxOutlookForecasts();
  const points = quarters.filter((q) => Number.isFinite(values[q.key]) && values[q.key] > 0)
    .map((q) => ({ ...q, v: values[q.key] }));
  const rows = new Map();
  const row = (t) => { if (!rows.has(t)) rows.set(t, Array(5).fill(null)); return rows.get(t); };
  history.t.forEach((t, i) => { if (t >= lo) row(t)[0] = history.v[i]; });
  const rangeValid = fxOutlookRangeValid(payload) && anchor
    && payload.anchor.t === anchor.t && payload.anchor.v === anchor.v;
  if (rangeValid) payload.range.t.forEach((t, i) => {
    const r = row(t); r[1] = payload.range.center[i]; r[2] = payload.range.lower[i]; r[3] = payload.range.upper[i];
  });
  if (points.length && anchor) row(anchor.t)[4] = anchor.v;
  points.forEach((p) => { row(p.t)[4] = p.v; });
  const t = [...rows.keys()].sort((a, b) => a - b);
  const lastRange = rangeValid ? payload.range.t.at(-1) : origin;
  return { data: [t, ...Array.from({ length: 5 }, (_, i) => t.map((time) => rows.get(time)[i]))],
    points, anchor, rangeValid, min: Math.min(lo, t[0] ?? lo),
    max: Math.max(lastRange, points.at(-1)?.t ?? origin, origin + 86400) };
}

function fxOutlookDrawLabels(u, points, color) {
  if (u.series[5].show === false) return;
  const { ctx, bbox } = u, dpr = devicePixelRatio || 1, occupied = [];
  ctx.save(); ctx.font = `${10 * dpr}px sans-serif`; ctx.fillStyle = color;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const items = points.map((point) => {
    const px = u.valToPos(point.t, "x", true), py = u.valToPos(point.v, "y", true);
    const value = fmtNum(point.v, 2), width = Math.min(bbox.width - 6 * dpr,
      Math.max(ctx.measureText(value).width, ctx.measureText(point.short).width) + 6 * dpr);
    const height = 25 * dpr, x = Math.max(bbox.left + width / 2,
      Math.min(bbox.left + bbox.width - width / 2, px));
    return { point, value, width, height, x, py, rect: null };
  });
  for (const item of items) {
    const { width, height, x, py } = item;
    let rect;
    for (const offset of [-31, 12, -61, 42, -91, 72, -121, 102]) {
      const y = Math.max(bbox.top + 3 * dpr, Math.min(bbox.top + bbox.height - height - 3 * dpr, py + offset * dpr));
      const candidate = { left: x - width / 2, right: x + width / 2, top: y, bottom: y + height };
      if (!occupied.some((r) => candidate.left < r.right && candidate.right > r.left
          && candidate.top < r.bottom && candidate.bottom > r.top)) { rect = candidate; break; }
    }
    // Full 25Y history compresses all future quarters into a narrow right edge.
    // Search the remaining vertical lanes rather than silently losing a label.
    if (!rect) for (let y = bbox.top + 3 * dpr; y + height <= bbox.top + bbox.height - 3 * dpr; y += height + 3 * dpr) {
      const candidate = { left: x - width / 2, right: x + width / 2, top: y, bottom: y + height };
      if (!occupied.some((r) => candidate.left < r.right && candidate.right > r.left
          && candidate.top < r.bottom && candidate.bottom > r.top)) { rect = candidate; break; }
    }
    if (!rect) break;
    occupied.push(rect);
    item.rect = rect;
  }
  if (items.some((item) => !item.rect)) {
    // Greedy placements can fragment the vertical space. Repack every label,
    // not only the failed one, so all six quarters remain visible on mobile.
    const step = items.length > 1 ? (bbox.height - 6 * dpr - 25 * dpr) / (items.length - 1) : 0;
    items.forEach((item, index) => { item.rect = { top: bbox.top + 3 * dpr + index * step }; });
  }
  items.forEach(({ point, value, x, width, rect }) => {
    ctx.fillText(point.short, x, rect.top, width); ctx.fillText(value, x, rect.top + 12 * dpr, width);
  });
  ctx.restore();
}

function renderFxOutlook() {
  const host = document.getElementById("fxoutlook-content");
  if (!host) return;
  if (fxOutlookChartEntry && uplots.includes(fxOutlookChartEntry)) destroyChart(fxOutlookChartEntry);
  fxOutlookChartEntry = null;
  host.textContent = "";
  let payload = DATA.fx?.outlook;
  if (!payload) {
    const legacy = DATA.fx?.ts?.find((s) => s.key === "info:USDKRW");
    payload = { history: legacy || {}, active: false, source: legacy?.key,
      reason: "전체 표본 분석 데이터를 불러오지 못했습니다." };
  }
  const history = fxOutlookHistory(payload), quarters = fxOutlookQuarters(history.t.at(-1));
  const values = fxOutlookForecasts(), pal = palette(), forecastColor = pal.series[1];
  const card = el("div", { class: "card fx-outlook-card" }); host.append(card);
  const period = el("select", { "aria-label": "원달러 표시기간" });
  [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [0, "전체"]].forEach(([value, label]) =>
    period.append(el("option", { value: String(value) }, label)));
  period.value = String(fxOutlookYears);
  const controls = el("div", { class: "fx-outlook-period" }, el("label", {}, "기간 ", period));
  let selected = fxOutlookSelection(payload, quarters);
  const labels = ["원달러", "기준 경로", "하단 1σ", "상단 1σ", "분기 전망"];
  const tableFn = (cap, raw) => tsTableFn(labels.map((s) => `${s} (원/달러)`), selected.data, 2)(cap, raw);
  const box = cardScaffold(card, { title: "USDKRW", sub: "원/달러", controls,
    csvName: "USDKRW-환율전망.csv", tableFn });
  box.classList.add("time-chart-hover", "fx-outlook-chart");
  hedgeChartLegend(box, [["원달러", pal.series[0]], ["최근 관측 이후 1년 ±1σ", pal.series[0], true],
    ["분기 전망", forecastColor]]);
  const plotHost = el("div", { class: "hedge-plot-host" }); box.append(plotHost);
  const tip = el("div", { class: "time-chart-tooltip", role: "status" }); tip.hidden = true; box.append(tip);
  const empty = el("p", { class: "card-sub", role: "status" }); card.append(empty);
  const summary = el("div", { class: "hedge-outlook-summary" }); card.append(summary);
  if (history.t.length) summary.append(el("b", {}, `최근 ${fmtNum(history.v.at(-1), 2)}`),
    el("span", {}, tsToDate(history.t.at(-1))), el("span", {}, marketSourceLabel(payload.source)));
  if (payload.sample?.vol_pct != null) summary.append(el("span", {}, `전체 표본 연 σ ${fmtNum(payload.sample.vol_pct, 2)}%`));
  const sample = payload.sample;
  const method = el("details", { class: "hedge-outlook-method" }, el("summary", {}, "전체 표본 · 조건부 범위"));
  method.append(el("p", {}, sample?.n_levels
    ? `${sample.start} ~ ${sample.end}, 일별 ${sample.n_levels.toLocaleString("ko-KR")}개 · 로그수익률 ${sample.n_returns.toLocaleString("ko-KR")}개. `
      + `표시기간을 바꿔도 전체 표본 변동성은 유지합니다. 연환산 √252, 로그 추세 0·변동성 고정, 월별 √시간 확대 가정입니다. `
      + `기준 경로는 최근 환율을 유지하는 중앙값이며 확률 보장 구간은 아닙니다. `
      + `주말·비양수를 제외하고 급등락을 포함한 유효 관측은 모두 보존합니다. 7일 초과 공백 수익률 ${sample.excluded_long_gaps}개 제외. `
      + `분기 입력은 사용자 전망이며 통계 범위를 다시 추정하지 않습니다.`
    : "전체 표본 변동성이 없어 통계 범위를 표시하지 않습니다. 분기 전망치는 직접 입력할 수 있습니다."));
  card.append(method);

  const inputCard = el("div", { class: "card fx-forecast-card" }); host.append(inputCard);
  inputCard.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "분기 전망"),
    el("span", { class: "card-sub" }, "분기말 · 원/달러")));
  const grid = el("div", { class: "fx-forecast-grid" }); inputCard.append(grid);
  const storageStatus = el("p", { class: "fx-forecast-status", role: "status" }); storageStatus.hidden = true;
  inputCard.append(storageStatus);
  const height = 340;
  const bounds = () => {
    const finite = selected.data.slice(1).flat().filter(Number.isFinite);
    if (!finite.length) return [0, 1];
    const min = Math.min(...finite), max = Math.max(...finite), pad = Math.max(5, (max - min) * .14);
    return [Math.max(0, min - pad), max + pad];
  };
  const axes = baseAxes(pal, (v) => fmtNum(v, 0));
  const options = { width: Math.max(280, box.clientWidth), height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC"), axes,
    legend: { show: false }, scales: { y: { range: bounds } },
    series: [{ label: "일자" }, ...labels.map((label, i) => ({ label,
      stroke: i === 4 ? forecastColor : pal.series[0], width: i === 0 ? 1.6 : i === 1 ? 1 : i === 4 ? 1.2 : 0,
      dash: [1, 4].includes(i) ? [4, 4] : [], spanGaps: i > 0,
      points: { show: i === 4, size: 5 }, value: (u, v) => v == null ? "–" : `${fmtNum(v, 2)}원` }))],
    bands: [{ series: [4, 3], fill: hexA(pal.series[0], .15) }],
    cursor: { y: false, points: { size: 5 }, drag: { setScale: false } },
    hooks: {
      drawClear: [(u) => {
        if (!selected.anchor) return;
        const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
        const x = u.valToPos(selected.anchor.t, "x", true);
        ctx.save(); ctx.strokeStyle = pal.ink3; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke(); ctx.restore();
      }],
      draw: [(u) => fxOutlookDrawLabels(u, selected.points, forecastColor)],
      setCursor: [(u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0 || top < 0 || !Number.isFinite(u.data[0]?.[idx])) { tip.hidden = true; return; }
        tip.textContent = ""; tip.append(el("strong", {}, tsToDate(u.data[0][idx])));
        labels.forEach((label, i) => {
          const value = u.data[i + 1][idx];
          const quarter = i === 4 ? selected.points.find((p) => p.t === u.data[0][idx]) : null;
          if (i === 4 && !quarter) return; // The joining quote is observed, not a user forecast.
          if (Number.isFinite(value)) tip.append(el("div", {}, el("span", {}, quarter ? `${quarter.label} 전망` : label),
            el("b", {}, `${fmtNum(value, 2)}원`)));
        });
        tip.hidden = false; tip.style.left = left > box.clientWidth / 2 ? "12px" : "auto";
        tip.style.right = left > box.clientWidth / 2 ? "auto" : "12px";
      }], setData: [() => { tip.hidden = true; }],
    },
  };
  let u = null;
  box.addEventListener("mouseleave", () => { tip.hidden = true; });
  const update = () => {
    selected = fxOutlookSelection(payload, quarters);
    if (!u && selected.data[0].length) {
      u = new uPlot(options, selected.data, plotHost);
      const ro = new ResizeObserver(() => u.setSize({ width: Math.max(280, box.clientWidth), height }));
      ro.observe(box); fxOutlookChartEntry = trackChart(u, ro);
    }
    if (u) {
      u.setData(selected.data, false); u.setScale("x", { min: selected.min, max: selected.max });
      const [min, max] = bounds(); u.setScale("y", { min, max });
    }
    empty.textContent = !history.t.length ? "원달러 과거 시계열이 없습니다. 분기 전망은 입력할 수 있습니다."
      : !selected.rangeValid ? `1년 범위: ${payload.reason || "분석 데이터 확인 필요"}` : "";
    empty.hidden = !empty.textContent;
    const table = card.querySelector(".chart-table");
    if (table && !table.classList.contains("hidden")) renderTable(table, tableFn());
  };
  period.addEventListener("change", () => { fxOutlookYears = Number(period.value); update(); });
  quarters.forEach((quarter) => {
    const id = `fx-forecast-${quarter.key}`, errorId = `${id}-error`;
    const field = el("input", { id, type: "text", inputmode: "decimal", autocomplete: "off",
      "aria-label": `${quarter.label} 원달러 전망`, "aria-describedby": errorId, placeholder: "입력" });
    field.value = fxForecastDrafts[quarter.key] ?? String(values[quarter.key] ?? "");
    const error = el("span", { id: errorId, class: "fx-forecast-error", role: "status" });
    const check = () => {
      const raw = field.value.trim(), value = Number(raw);
      const valid = raw === "" || (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(value) && value > 0);
      field.setAttribute("aria-invalid", String(!valid));
      error.textContent = valid ? "" : "0보다 큰 숫자 입력";
      return { valid, raw, value };
    };
    check();
    field.addEventListener("input", () => {
      fxForecastDrafts[quarter.key] = field.value;
      const result = check(); if (!result.valid) return;
      if (result.raw === "") delete values[quarter.key]; else values[quarter.key] = result.value;
      try {
        localStorage.setItem(FX_OUTLOOK_STORAGE, JSON.stringify({ forecasts: values }));
        storageStatus.hidden = true;
      } catch { storageStatus.textContent = "저장할 수 없어 현재 화면에만 반영합니다."; storageStatus.hidden = false; }
      update();
    });
    grid.append(el("label", { class: "fx-forecast-input", for: id }, el("span", {}, quarter.label), field, error));
  });
  update();
}
