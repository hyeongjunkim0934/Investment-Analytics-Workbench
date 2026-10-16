/* USD CIP reference comparison. All statistics use the chart's pairwise sample;
   this is a maturity/product-mismatched comparison, not an arbitrage basis. */
"use strict";

const HEDGE_CIP_TENORS = ["PR", "3M", "1Y", "2Y", "3Y"];
let hedgeCipRange = null;
let hedgeCipCharts = [];

function hedgeCipSelection(row, range = null) {
  const from = range?.start ? Date.parse(`${range.start}T00:00:00Z`) / 1000 : -Infinity;
  const to = range?.end ? Date.parse(`${range.end}T00:00:00Z`) / 1000 + 86400 : Infinity;
  const pairs = new Map();
  if (row?.active !== false) (Array.isArray(row?.t) ? row.t : []).forEach((t, i) => {
    const spread = row.spread?.[i], premium = row.premium?.[i];
    if (Number.isFinite(t) && Number.isFinite(spread) && Number.isFinite(premium)
        && t >= from && t < to) pairs.set(t, { spread, premium });
  });
  const t = [...pairs.keys()].sort((a, b) => a - b);
  const spread = t.map((time) => pairs.get(time).spread);
  const premium = t.map((time) => pairs.get(time).premium);
  return { t, spread, premium, gap: premium.map((p, i) => p - spread[i]) };
}

function hedgeCipStats(row, range = null) {
  const selected = hedgeCipSelection(row, range), n = selected.t.length;
  const date = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  if (!n) return { correlation: null, gap_bp: null, rmse_bp: null, asof: null,
    n: 0, start: null, end: null };
  const mean = (xs) => xs.reduce((sum, v) => sum + v / n, 0);
  const mx = mean(selected.spread), my = mean(selected.premium);
  let xx = 0, yy = 0, xy = 0;
  selected.spread.forEach((x, i) => {
    const dx = x - mx, dy = selected.premium[i] - my;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  });
  // Rate subtraction can leave machine-scale variation in a constant spread.
  // Do not turn floating-point residue into a seemingly meaningful correlation.
  const variable = (xs) => {
    let lo = Infinity, hi = -Infinity, magnitude = 1;
    xs.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); magnitude = Math.max(magnitude, Math.abs(v)); });
    return hi - lo > 1e-12 * magnitude;
  };
  const correlation = n >= 2 && variable(selected.spread) && variable(selected.premium) && xx > 0 && yy > 0
    ? Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))) : null;
  return { correlation, gap_bp: selected.gap.at(-1) * 100,
    rmse_bp: Math.sqrt(mean(selected.gap.map((v) => v * v))) * 100,
    asof: date(selected.t.at(-1)), n, start: date(selected.t[0]), end: date(selected.t.at(-1)) };
}

function hedgeCipDispose() {
  hedgeCipCharts.forEach((entry) => {
    if (uplots.includes(entry)) destroyChart(entry);
    for (let i = registry.length - 1; i >= 0; i--)
      if (registry[i].u === entry.u) registry.splice(i, 1);
  });
  hedgeCipCharts = [];
}

function renderHedgeCip(payload) {
  const panel = document.getElementById("hedge-model-a");
  if (!panel) return;
  hedgeCipDispose();
  panel.textContent = "";
  const supplied = Array.isArray(payload?.tenors) ? payload.tenors : [];
  const rows = HEDGE_CIP_TENORS.map((tenor) => supplied.find((row) => row.tenor === tenor)
    || { tenor, active: false, reason: "금리·헤지 프리미엄 공통 관측이 없습니다." });
  const fullTimes = rows.flatMap((row) => hedgeCipSelection(row).t);
  const full = fullTimes.length ? { start: tsToDate(fullTimes.reduce((lo, t) => Math.min(lo, t), Infinity)),
    end: tsToDate(fullTimes.reduce((hi, t) => Math.max(hi, t), -Infinity)) } : { start: "", end: "" };
  const range = hedgeCipRange?.full === false ? { ...hedgeCipRange } : { ...full, full: true };
  hedgeCipRange = range;

  const head = el("div", { class: "hedge-cip-head" },
    el("span", { class: "card-title" }, "USD · CIP 비교"),
    el("span", { class: "hedge-cip-definition" }, "한국−미국 금리차 · 평균 헤지 프리미엄"));
  panel.append(head);
  const summary = el("div", { class: "hedge-cip-summary", "aria-label": "만기별 금리차와 헤지 프리미엄 통계" });
  panel.append(summary);
  const status = el("span", { id: "hedge-cip-status", class: "alloc-period-status d-up", role: "status" });
  status.hidden = true;
  const start = el("input", { type: "date", id: "hedge-cip-start", value: range.start,
    "aria-label": "CIP 시작기간", "aria-describedby": "hedge-cip-status" });
  const end = el("input", { type: "date", id: "hedge-cip-end", value: range.end,
    "aria-label": "CIP 종료기간", "aria-describedby": "hedge-cip-status" });
  const controls = el("div", { class: "alloc-period hedge-cip-period" },
    el("label", { for: start.id }, "시작기간", start), el("label", { for: end.id }, "종료기간", end));
  panel.append(controls);
  panel.append(el("p", { class: "hedge-cip-definition" },
    "괴리 = 헤지 프리미엄 − (한국−미국 금리차) · 만기·상품이 다른 비교로, 엄밀한 CIP basis와 다릅니다."));

  const modules = el("div", { class: "hedge-cip-modules" });
  panel.append(modules);
  const refreshers = [];
  const pal = palette(), premiumColor = currentTheme() === "dark" ? "#edbd63" : "#8a5c00";
  const signed = (v) => Number.isFinite(v) ? `${v > 0 ? "+" : ""}${fmtNum(v, 2)}` : "—";
  rows.forEach((row) => {
    const tenor = row.tenor, sourceData = hedgeCipSelection(row);
    const stat = el("div", { class: "card hedge-cip-stat", "data-tenor": tenor });
    const metric = (key, label, unit = "") => {
      const value = el("b", { id: `hedge-cip-${tenor}-${key}`, class: "hedge-cip-value" });
      stat.append(el("div", { class: "hedge-cip-metric" }, el("span", {}, label),
        el("span", {}, value, unit ? el("small", {}, unit) : null)));
      return value;
    };
    stat.append(el("div", { class: "card-title" }, tenor));
    const correlation = metric("correlation", "상관계수");
    const gap = metric("gap", "현재 괴리", "bp");
    const rmse = metric("rmse", "RMSE", "bp");
    const sample = el("div", { class: "hedge-cip-sample", id: `hedge-cip-${tenor}-sample` });
    const unavailable = el("p", { class: "hedge-cip-unavailable", role: "status" });
    stat.append(sample, unavailable); summary.append(stat);

    const card = el("div", { class: "card hedge-cip-chart", "data-tenor": tenor,
      id: `hedge-cip-chart-${tenor}` });
    modules.append(card);
    const tableFn = (cap, raw) => {
      const chosen = hedgeCipSelection(row, range);
      return tsTableFn(["한국−미국 금리차 (%p)", "평균 헤지 프리미엄 (연 %)", "괴리 (bp)"],
        [chosen.t, chosen.spread, chosen.premium, chosen.gap.map((v) => v * 100)], 2)(cap, raw);
    };
    const box = cardScaffold(card, { title: tenor === "PR" ? "PR · 기준금리" : tenor,
      sub: "금리차 %p · 프리미엄 연 %", csvName: `USD-CIP-${tenor}.csv`, tableFn });
    const observation = el("div", { class: "hedge-cip-chart-sample" });
    card.append(observation);
    const empty = el("p", { class: "card-sub", role: "status" },
      row.reason || "해당 기간의 공통 관측이 없습니다.");
    box.append(empty);
    let chartRange = null;
    if (sourceData.t.length) {
      const chart = makeTimeChart(box, { labels: ["한국−미국 금리차", "헤지 프리미엄 평균"],
        colors: [pal.series[0], premiumColor], units: ["%p", "%"],
        data: [sourceData.t, sourceData.spread, sourceData.premium], range,
        emptyState: empty, dec: 2, height: 255, hoverTooltip: true });
      hedgeCipCharts.push(chart);
      chartRange = registry.find((entry) => entry.u === chart.u);
    }
    refreshers.push(() => {
      const s = hedgeCipStats(row, range);
      correlation.textContent = s.correlation === null ? "—" : fmtNum(s.correlation, 2);
      gap.textContent = signed(s.gap_bp);
      rmse.textContent = s.rmse_bp === null ? "—" : fmtNum(s.rmse_bp, 2);
      sample.textContent = s.n ? `N ${s.n.toLocaleString("ko-KR")} · ${s.asof}` : "N 0";
      observation.textContent = s.n ? `${s.start} ~ ${s.end} · 공통 관측 ${s.n.toLocaleString("ko-KR")}개` : "공통 관측 0개";
      unavailable.textContent = !s.n ? row.reason || "선택기간 공통 관측 없음"
        : s.correlation === null ? "상관계수: 표본 부족 또는 상수 계열" : "";
      unavailable.hidden = !unavailable.textContent;
      empty.hidden = s.n > 0;
      if (chartRange) applyRange(chartRange);
      const table = card.querySelector(".chart-table");
      if (!table.classList.contains("hidden")) renderTable(table, tableFn());
    });
  });
  const refresh = () => refreshers.forEach((fn) => fn());
  const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const apply = () => {
    if (!validDate(start.value) || !validDate(end.value)) {
      status.textContent = "시작기간과 종료기간을 입력하십시오.";
    } else if (start.value > end.value) {
      status.textContent = "시작기간은 종료기간보다 늦을 수 없습니다.";
    } else {
      range.start = start.value; range.end = end.value; range.full = false;
      status.hidden = true; refresh(); return;
    }
    status.hidden = false;
  };
  [start, end].forEach((field) => {
    field.addEventListener("input", () => { status.hidden = true; });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); apply(); }
    });
  });
  const applyButton = el("button", { type: "button", id: "hedge-cip-apply", class: "btn-ghost", onclick: apply }, "기간 적용");
  const allButton = el("button", { type: "button", id: "hedge-cip-all", class: "btn-ghost", onclick: () => {
    start.value = full.start; end.value = full.end;
    range.start = full.start; range.end = full.end; range.full = true;
    status.hidden = true; refresh();
  } }, "전체");
  if (!fullTimes.length) [start, end, applyButton, allButton].forEach((node) => { node.disabled = true; });
  controls.append(applyButton, allButton, status);
  const method = payload?.premium_method;
  const methodLabel = typeof method === "string" ? method : typeof method?.label === "string" ? method.label : "";
  panel.append(explainBox("hedge-cip-method", { label: "CIP 비교 · 산식과 표본" },
    el("p", {}, "금리차는 한국 금리 − 미국 금리입니다. 원/달러 환헤지 프리미엄은 음수일 때 비용, 양수일 때 수취입니다. " +
      "동일 만기·동일 자금조달 조건의 선물환 프리미엄이 금리차와 연결되는 CIP를 비교 기준으로 사용합니다. " +
      "PR과 국채금리, 3M·6M·12M의 평균 프리미엄은 만기와 상품이 일치하지 않으므로 괴리를 차익거래 수익이나 순수 CIP basis로 해석할 수 없습니다."),
    el("p", {}, "평균 헤지 프리미엄은 각 USD HP 3M·6M·12M 시계열의 해당일 포함 과거 5개 관측 중앙값을 소수점 두 자리로 반올림한 뒤, " +
      "세 만기 값을 산술평균합니다. 세 HP 만기가 모두 관측된 날짜와 각 한국·미국 금리의 공통 날짜만 사용하며 결측값을 보간하거나 이월하지 않습니다. " +
      "모니터링 현재값은 만기별 마지막 유효일이 달라도 평균할 수 있어 이 비교의 최신 공통일 값과 다를 수 있습니다."),
    el("p", {}, "상관계수는 선택기간 금리차와 프리미엄 수준의 Pearson 상관입니다. 관측이 2개 미만이거나 어느 한 계열이 상수이면 계산하지 않습니다. " +
      "현재 괴리는 선택기간의 최신 공통일 프리미엄 − 금리차를 bp로 환산합니다. RMSE는 같은 기간 괴리 제곱의 평균에 제곱근을 취한 값으로 예측오차가 아닙니다. " +
      "1%p = 100bp이며, 만기별 공통 표본의 기간과 관측 수가 다를 수 있습니다. 상관관계는 인과관계를 뜻하지 않습니다."),
    methodLabel ? el("p", {}, `게시 방법: ${methodLabel}`) : null));
  refresh();
}
