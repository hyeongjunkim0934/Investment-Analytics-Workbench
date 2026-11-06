/* Reference allocations use historical data_bb moments, independently of SAA/TAA/CMA. */
"use strict";
const REFERENCE_PRESETS = [
  { key: "domestic", label: "국내 60/40", weights: [40, 0, 60, 0, 0] },
  { key: "us", label: "미국 60/40", weights: [0, 40, 0, 60, 0] },
  { key: "global", label: "한미 60/40", weights: [20, 20, 20, 40, 0] },
  { key: "diversified", label: "분산 50/40/10", weights: [20, 20, 15, 35, 10] },
];
const REFERENCE_KEYS = ["kr_bond", "us_bond", "kr_equity", "us_equity", "commodity"];
const REFERENCE_COLORS = ["#64b5a0", "#8195bc", "#b3a5e8", "#4c6c9e", "#d8b55c"];
let referenceState = null;
const referenceNumber = v => Number.isFinite(v) ? fmtNum(v, 2) : "—";

function referenceWeightsValid(weights) {
  return Array.isArray(weights) && weights.length === 5
    && weights.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100)
    && Math.abs(weights.reduce((a, b) => a + b, 0) - 100) < 1e-8;
}

function referenceLoadState() {
  if (referenceState) return referenceState;
  referenceState = { version: 1, window: "y10", selected: "us", weights: [0, 40, 0, 60, 0] };
  try {
    const saved = JSON.parse(localStorage.getItem("iaw-reference-portfolio-v1"));
    if (saved?.version === 1 && referenceWeightsValid(saved.weights)) {
      referenceState.weights = saved.weights.slice();
      referenceState.selected = REFERENCE_PRESETS.some(p => p.key === saved.selected) ? saved.selected : "custom";
      if (["y1", "y3", "y5", "y10"].includes(saved.window)) referenceState.window = saved.window;
    }
  } catch (_) { /* Corrupt or unavailable storage keeps the defaults. */ }
  return referenceState;
}

function referenceSaveState() {
  try {
    const { version, window, selected, weights } = referenceState;
    localStorage.setItem("iaw-reference-portfolio-v1", JSON.stringify({ version, window, selected, weights }));
  } catch (_) { /* Session remains usable. */ }
}

function referenceMoments(window, weights) {
  if (!referenceWeightsValid(weights) || !window || window.mean_pct?.length !== 5
      || window.cov?.length !== 5) return null;
  const w = weights.map(v => v / 100), used = w.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  if (used.some(i => !Number.isFinite(window.mean_pct[i])
      || used.some(j => !Number.isFinite(window.cov[i]?.[j])))) return null;
  const cw = w.map((_, i) => used.every(j => Number.isFinite(window.cov[i]?.[j]))
    ? used.reduce((sum, j) => sum + window.cov[i][j] * w[j], 0) : null);
  const variance = used.reduce((sum, i) => sum + w[i] * cw[i], 0);
  if (!Number.isFinite(variance) || variance < -1e-12) return null;
  const mean = used.reduce((sum, i) => sum + w[i] * window.mean_pct[i], 0);
  const vol = Math.sqrt(Math.max(0, variance)) * 100;
  return { mean, vol,
    sharpe: vol > 1e-10 && Number.isFinite(window.rf_mean_pct) ? (mean - window.rf_mean_pct) / vol : null,
    risk: variance > 1e-14 ? w.map((v, i) => v === 0 ? 0 : 100 * v * cw[i] / variance) : w.map(() => null) };
}

function referenceSvg(tag, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  if (text != null) node.textContent = text;
  return node;
}

function referenceScatter(rows) {
  const svg = referenceSvg("svg", { viewBox: "0 0 650 320", role: "img",
    "aria-label": "레퍼런스 포트폴리오의 연 변동성과 과거 연평균 수익률 비교", class: "reference-scatter" });
  const values = rows.map((r, index) => ({ ...r, index })).filter(r => r.metrics);
  const xMax = Math.max(1, ...values.map(r => r.metrics?.vol)) * 1.22;
  const yMin = Math.min(0, ...values.map(r => r.metrics?.mean)) - 1;
  const yMax = Math.max(1, ...values.map(r => r.metrics?.mean)) + 2;
  const px = x => 62 + x / xMax * 550, py = y => 267 - (y - yMin) / (yMax - yMin) * 232;
  for (let i = 0; i <= 4; i++) {
    const x = xMax * i / 4, y = yMin + (yMax - yMin) * i / 4;
    svg.append(referenceSvg("line", { x1: px(x), x2: px(x), y1: 35, y2: 267, class: "reference-grid" }),
      referenceSvg("line", { x1: 62, x2: 612, y1: py(y), y2: py(y), class: "reference-grid" }),
      referenceSvg("text", { x: px(x), y: 288, "text-anchor": "middle" }, referenceNumber(x)),
      referenceSvg("text", { x: 52, y: py(y) + 4, "text-anchor": "end" }, referenceNumber(y)));
  }
  svg.append(referenceSvg("text", { x: 62, y: 19 }, "과거 연평균 수익률 (%)"),
    referenceSvg("text", { x: 612, y: 312, "text-anchor": "end" }, "연 변동성 (%)"));
  const groups = [];
  values.forEach(row => {
    const same = groups.find(g => Math.hypot(px(g[0].metrics.vol) - px(row.metrics.vol),
      py(g[0].metrics.mean) - py(row.metrics.mean)) < 10);
    if (same) same.push(row); else groups.push([row]);
  });
  groups.forEach(group => {
    const row = group.find(r => r.key === "custom") || group[0];
    const x = px(row.metrics.vol), y = py(row.metrics.mean), custom = row.key === "custom", index = row.index;
    const dot = referenceSvg("circle", { cx: x, cy: y, r: custom ? 7 : 5,
      fill: custom ? "var(--reference-gold)" : REFERENCE_COLORS[index], stroke: "var(--surface)", "stroke-width": 1.5 });
    dot.append(referenceSvg("title", {}, group.map(r => `${r.label}: 수익률 ${referenceNumber(r.metrics.mean)}%, 변동성 ${referenceNumber(r.metrics.vol)}%`).join(" / ")));
    const label = group.map(r => r.key === "custom" ? "직접 입력" : String(r.index + 1)).join(" · ");
    const right = x > 500;
    svg.append(dot, referenceSvg("text", { x: x + (right ? -10 : 10), y: y + (index % 2 ? 17 : -10),
      "text-anchor": right ? "end" : "start",
      class: custom ? "reference-selected-label" : "" }, label));
  });
  return svg;
}

function renderReferencePortfolio() {
  const host = $("#alloc-reference-panel");
  if (!host) return;
  host.textContent = "";
  const data = DATA.alloc?.reference;
  const valid = data?.active && data.version === 1
    && data.assets?.map(a => a.key).join() === REFERENCE_KEYS.join() && data.windows?.length;
  if (!valid) {
    host.append(el("div", { class: "card", role: "status" }, data?.reason || "레퍼런스 포트폴리오 데이터가 없습니다. 데이터 갱신 후 확인할 수 있습니다."));
    return;
  }
  const st = referenceLoadState();
  const win = data.windows.find(w => w.key === st.window) || data.windows[data.windows.length - 1];
  st.window = win.key;
  const rows = REFERENCE_PRESETS.map(p => ({ ...p, metrics: referenceMoments(win, p.weights) }));
  rows.push({ key: "custom", label: "직접 입력", weights: st.weights.slice(), metrics: referenceMoments(win, st.weights) });
  const exportCsv = () => downloadCSV("reference_portfolio.csv",
    ["포트폴리오", "기간", "표본시작", "표본종료", "개월수", "통화", "환헤지", "리밸런싱", "과거 산술 연평균 수익률 (%)", "연 변동성 (%)", "샤프 (CD 대비)", "CD 연평균 (%)", "계산상태", ...data.assets.map(a => `${a.label} 비중 (%)`), ...data.assets.map(a => `${a.label} 위험기여 (%)`), "원천 관측일", "원천"],
    rows.map(r => [r.label, win.label, win.start, win.end, win.n_months, "KRW", "미적용", "월간 고정비중", r.metrics?.mean, r.metrics?.vol, r.metrics?.sharpe, win.rf_mean_pct, r.metrics ? "계산 가능" : "필요 자산 원천 미확인", ...r.weights, ...(r.metrics?.risk || Array(5).fill(null)), data.data_asof, data.source_snapshot?.name || "data_bb"]));
  const period = el("select", { id: "reference-window", "aria-label": "레퍼런스 표본 기간",
    onchange: e => { st.window = e.target.value; referenceSaveState(); renderReferencePortfolio(); } });
  data.windows.forEach(w => period.append(el("option", { value: w.key }, w.label)));
  period.value = win.key;
  host.append(el("div", { class: "reference-toolbar" }, el("label", {}, "표본 기간 ", period),
    el("span", { class: "reference-sample" }, `${win.start} ~ ${win.end} · ${win.n_months}개월 · 원화 · 환노출`),
    el("button", { type: "button", class: "btn-ghost", id: "reference-csv", onclick: exportCsv }, "CSV")));
  const unavailable = data.assets.filter(a => a.available === false);
  if (unavailable.length) host.append(el("div", { class: "reference-source-warning", role: "status" },
    unavailable.map(a => el("div", {}, `${a.label}: ${a.reason}`))));
  const cards = el("div", { class: "reference-cards" });
  rows.slice(0, 4).forEach((row, i) => {
    const button = el("button", { type: "button", id: `reference-preset-${row.key}`,
      class: "reference-card", "aria-pressed": String(st.selected === row.key), onclick: () => {
        st.weights = row.weights.slice(); st.selected = row.key; st.draft = null;
        referenceSaveState(); renderReferencePortfolio();
      } }, el("span", { class: "reference-card-title" }, `${i + 1}  ${row.label}`));
    [["과거 연평균 (%)", row.metrics?.mean], ["연 변동성 (%)", row.metrics?.vol], ["샤프 · CD 대비", row.metrics?.sharpe]]
      .forEach(([label, value]) => button.append(el("span", { class: "reference-metric" }, el("span", {}, label), el("b", {}, referenceNumber(value)))));
    button.disabled = !row.metrics;
    if (!row.metrics) button.append(el("span", { class: "reference-unavailable" }, "필요 자산 원천 미확인"));
    const bar = el("span", { class: "reference-weight-bar", "aria-hidden": "true" });
    row.weights.forEach((w, j) => { if (w > 0) bar.append(el("span", { style: `width:${w}%;background:${REFERENCE_COLORS[j]}` })); });
    button.append(bar);
    cards.append(button);
  });
  host.append(cards);
  const body = el("div", { class: "reference-main" });
  const chart = el("div", { class: "card reference-chart" }, el("h3", {}, "수익·위험 비교"), referenceScatter(rows));
  const editor = el("div", { class: "card reference-editor" }, el("h3", {}, "비중 직접 입력"));
  const draft = st.draft || st.weights.map(String);
  const form = el("form", { id: "reference-form", novalidate: "" });
  const inputs = data.assets.map((asset, i) => {
    const input = el("input", { type: "number", min: 0, max: 100, step: "any", value: draft[i],
      id: `reference-weight-${asset.key}`, "aria-label": `${asset.label} 레퍼런스 비중 (%)`,
      oninput: () => { st.draft = inputs.map(n => n.value); updateTotal(); } });
    form.append(el("label", { class: "reference-weight-input" }, el("span", {},
      el("i", { style: `background:${REFERENCE_COLORS[i]}`, "aria-hidden": "true" }), `${asset.label}${asset.available === false ? " · 사용불가" : ""} (%)`), input));
    return input;
  });
  const total = el("b", { id: "reference-total" });
  function updateTotal() {
    const numbers = inputs.map(n => String(n.value).trim() === "" ? NaN : Number(n.value));
    total.textContent = `${referenceNumber(numbers.reduce((a, b) => a + b, 0))}%`;
  }
  updateTotal();
  const error = el("div", { id: "reference-error", role: "alert", class: "reference-error" });
  error.hidden = true;
  form.append(el("div", { class: "reference-total" }, "합계", total),
    el("button", { type: "submit", class: "btn", id: "reference-apply" }, "적용"), error);
  const applyWeights = event => {
    event.preventDefault();
    const values = inputs.map(n => String(n.value).trim() === "" ? NaN : Number(n.value));
    if (!referenceWeightsValid(values) || data.assets.some((a, i) => a.available === false && values[i] > 0)) {
      error.textContent = "계산 가능한 자산에 0~100의 숫자를 입력하고 합계를 100%로 맞추십시오. 원천 미확인 자산은 0%여야 합니다.";
      error.hidden = false;
      return;
    }
    st.weights = values; st.selected = "custom"; st.draft = null;
    referenceSaveState(); renderReferencePortfolio();
  };
  form.addEventListener("submit", applyWeights);
  form.querySelector("button").addEventListener("click", applyWeights);
  editor.append(form);
  const metrics = rows[4].metrics;
  if (!metrics) editor.append(el("div", { role: "status", class: "reference-source-warning" }, "저장된 비중에 원천 미확인 자산이 포함되어 있습니다. 계산 가능한 자산으로 비중을 변경하십시오."));
  const current = el("div", { class: "reference-current", id: "reference-current" });
  [["과거 연평균 (%)", metrics?.mean], ["연 변동성 (%)", metrics?.vol], ["샤프 · CD 대비", metrics?.sharpe]].forEach(([label, value]) =>
    current.append(el("span", { class: "reference-metric" }, el("span", {}, label), el("b", {}, referenceNumber(value)))));
  editor.append(current);
  body.append(chart, editor);
  host.append(body);
  const table = el("table", { id: "reference-comparison-table" });
  table.append(el("thead", {}, el("tr", {}, ["구성 비중 (%)", ...rows.map(r => r.label), "직접 입력 위험기여 (%)"].map(t => el("th", { scope: "col" }, t)))));
  const tbody = el("tbody");
  data.assets.forEach((a, i) => tbody.append(el("tr", {}, el("th", { scope: "row" }, a.label),
    rows.map(r => el("td", {}, referenceNumber(r.weights[i]))), el("td", {}, referenceNumber(metrics?.risk[i])))));
  table.append(tbody);
  host.append(el("div", { class: "card reference-table" }, el("h3", {}, "구성 비중·위험기여"), el("div", { class: "table-wrap" }, table)));
  const details = el("details", { class: "method reference-method" }, el("summary", {}, "데이터·계산 기준"),
    el("p", {}, `${data.source_snapshot?.name || "data_bb"} · 원천 관측일 ${data.data_asof || "—"} · 완료월 ${data.asof || "—"}`),
    el("p", {}, "네 레퍼런스는 비교용 예시입니다. 60/40은 주식/채권, 50/40/10은 주식/채권/원자재 비중입니다. 매월 고정비중으로 리밸런싱한 과거 산술평균과 표본 공분산을 연환산합니다. 거래비용·세금은 반영하지 않습니다. 전망·CAGR·최적 포트폴리오를 뜻하지 않습니다."),
    el("p", {}, "USD 자산은 같은 날짜의 달러원 환율로 한 번 환산합니다. 원자재는 GSCI TR이며 전체 대체투자나 금을 대변하지 않습니다. 모든 자산에 공통인 완료월만 사용하며 결측 월을 건너 수익률을 연결하지 않습니다."),
    el("p", {}, "샤프는 같은 표본의 CD 3개월 대용금리를 차감한 연평균 수익률을 포트폴리오 연 변동성으로 나눈 근사치입니다. 시변 CD 초과수익률의 변동성을 분모로 사용하지 않습니다. 위험기여는 포트폴리오 분산 기여 비중이며 음수는 분산효과입니다. 비중은 이 탭에만 저장됩니다."),
    data.assets.map(a => el("p", {}, `${a.label} · ${a.source} · ${a.currency}`)));
  host.append(details);
  if (win.rf_mean_pct == null) host.append(el("div", { role: "status", class: "reference-sample" }, win.rf_reason || "CD 비교 표본이 없어 샤프는 표시하지 않습니다."));
}
