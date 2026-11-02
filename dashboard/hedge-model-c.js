/* One-month historical tail-risk policy. The optimizer publishes aggregates only. */
"use strict";

const HEDGE_C_MARKETS = [
  { code: "UST", label: "UST · USDKRW" }, { code: "JPY", label: "JPY · JPY/KRW" },
  { code: "AUD", label: "AUD · AUDKRW" }, { code: "GER", label: "GER · EURKRW" },
];
const HEDGE_C_STORAGE = "iaw-hedge-model-c-v1";
const HEDGE_C_FIELDS = [
  ["currentHedgePct", "현재 헤지비율 (%)", 0, 100, 1],
  ["minHedgePct", "최소 헤지비율 (%)", 0, 100, 1],
  ["maxHedgePct", "최대 헤지비율 (%)", 0, 100, 1],
  ["maxTurnoverPp", "최대 조정폭 (%p)", 0, 100, 1],
  ["tradeCostBps", "조정비용 (bp / 전액)", 0, 500, 1],
  ["carryStressPp", "캐리 악화 (연 %p)", 0, 20, .1],
];
let hedgeModelCState = null, hedgeModelCPayload = null, hedgeModelCCharts = [];
let hedgeModelCBSignature = null;

function hedgeModelCLoadState() {
  if (hedgeModelCState) return hedgeModelCState;
  hedgeModelCState = { version: 1, market: "UST", markets: Object.fromEntries(
    HEDGE_C_MARKETS.map(({ code }) => [code, { ...hedgeModelCDefaults }])) };
  try {
    const stored = JSON.parse(localStorage.getItem(HEDGE_C_STORAGE));
    if (stored?.version !== 1) return hedgeModelCState;
    if (HEDGE_C_MARKETS.some(({ code }) => code === stored.market)) hedgeModelCState.market = stored.market;
    HEDGE_C_MARKETS.forEach(({ code }) => {
      const values = stored.markets?.[code];
      if (values && HEDGE_C_FIELDS.every(([key]) => Object.hasOwn(values, key)) && hedgeModelCValidateOptions(values).valid)
        hedgeModelCState.markets[code] = Object.fromEntries(HEDGE_C_FIELDS.map(([key]) => [key, values[key]]));
    });
  } catch (_) { /* Corrupt/private storage leaves default settings. */ }
  return hedgeModelCState;
}
function hedgeModelCSaveState() {
  try { localStorage.setItem(HEDGE_C_STORAGE, JSON.stringify(hedgeModelCState)); } catch (_) { /* Keep session state. */ }
}
function hedgeModelCDispose() {
  hedgeModelCCharts.forEach(({ entry }) => { if (uplots.includes(entry)) destroyChart(entry); });
  hedgeModelCCharts = [];
}
function hedgeModelCResize() {
  hedgeModelCCharts.forEach(({ entry, box, height }) => {
    if (uplots.includes(entry) && box.clientWidth > 0) entry.u.setSize({ width: Math.max(240, box.clientWidth), height });
  });
}
function hedgeModelCCompareSignature() {
  const code = hedgeModelCLoadState().market;
  return typeof hedgeModelBLoadState === "function" ? JSON.stringify(hedgeModelBLoadState().markets[code]) : null;
}
function hedgeModelCRefreshBComparison() {
  const panel = document.getElementById("hedge-model-c");
  if (!panel || hedgeModelCBSignature === null || hedgeModelCBSignature === hedgeModelCCompareSignature()) return;
  // A newly applied B assumption affects only the comparison. Retain C drafts.
  const drafts = Object.fromEntries(HEDGE_C_FIELDS.map(([key]) => [key, document.getElementById(`hedge-c-${key}`)?.value]));
  const status = document.getElementById("hedge-c-status");
  const message = status && !status.hidden ? status.textContent : null;
  renderHedgeModelC(hedgeModelCPayload);
  HEDGE_C_FIELDS.forEach(([key]) => {
    const input = document.getElementById(`hedge-c-${key}`);
    if (input && drafts[key] !== undefined) input.value = drafts[key];
  });
  const nextStatus = document.getElementById("hedge-c-status");
  if (nextStatus && message) { nextStatus.textContent = message; nextStatus.hidden = false; }
}
function hedgeModelCNumber(value) { return Number.isFinite(value) ? fmtNum(value, 2) : "—"; }
function hedgeModelCMetric(label, value, id) {
  return el("span", { class: "hedge-c-metric" }, el("span", {}, label),
    el("b", { ...(id ? { id } : {}) }, hedgeModelCNumber(value)));
}
function hedgeModelCRefreshSummary() {
  if (typeof renderSummaryForecasts === "function") renderSummaryForecasts();
}
function hedgeModelCTable(rows, code, outlook, options, raw = false) {
  const n = (v) => raw ? v : hedgeModelCNumber(v);
  return { headers: ["구분", "헤지비율 (%)", "전체 ES95 (%)", "최근 ES95 (%)", "강건 ES95 (%)", "조정비용 (%)",
    "손실기준 합계 (%)", "조정폭 (%p)", "제약 충족", "시장", "기준일", "현재 헤지 (%)", "최소 헤지 (%)", "최대 헤지 (%)",
    "최대 조정폭 (%p)", "조정비용 (bp / 전액)", "캐리 악화 (연 %p)", "위험 기간", "전체 표본", "최근 표본"],
  rows: rows.map(([label, r]) => [label, n(r.hedgePct), n(r.fullEsPct), n(r.recentEsPct), n(r.robustEsPct), n(r.tradeCostPct),
    n(r.objectivePct), n(r.turnoverPp), r.feasible ? "충족" : "제약 밖", code, outlook.asof || "", options.currentHedgePct,
    options.minHedgePct, options.maxHedgePct, options.maxTurnoverPp, options.tradeCostBps, options.carryStressPp,
    "1개월 역사적 시나리오", outlook.tail_risk?.full?.n_months ?? "", outlook.tail_risk?.recent?.n_months ?? ""]) };
}
function hedgeModelCChart(box, model) {
  const pal = palette(), gold = currentTheme() === "dark" ? "#edbd63" : "#8a5c00", height = 285;
  const axes = baseAxes(pal, (v) => fmtNum(v, 2), (v, extra) => fmtNum(v, 2 + extra));
  axes[0] = { ...axes[0], label: "헤지비율 (%)", labelSize: 24,
    values: (u, values) => values.map((v) => fmtNum(v, 0)), incrs: [10, 20, 25, 50] };
  const guide = (plot) => {
    if (!plot.ctx || !plot.bbox) return;
    const ctx = plot.ctx, dpr = devicePixelRatio || 1;
    ctx.save();
    [[model.current.hedgePct, pal.ink3, [4, 4]], [model.optimal.hedgePct, gold, []]].forEach(([h, color, dash]) => {
      const x = plot.valToPos(h, "x", true);
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = dpr; ctx.setLineDash(dash.map((v) => v * dpr));
      ctx.moveTo(x, plot.bbox.top); ctx.lineTo(x, plot.bbox.top + plot.bbox.height); ctx.stroke();
    });
    ctx.restore();
  };
  const rows = [["fullEsPct", "전체 ES95", pal.series[0]], ["recentEsPct", "최근 ES95", pal.series[1]],
    ["objectivePct", "손실기준 합계", gold]];
  const u = new uPlot({ width: Math.max(240, box.clientWidth), height,
    scales: { x: { time: false, range: [0, 100] } }, axes,
    series: [{ label: "헤지비율", value: (u, v) => hedgeModelCNumber(v) + "%" }, ...rows.map(([key, label, stroke]) => ({
      label, stroke, width: key === "objectivePct" ? 2 : 1, points: { show: false }, value: (u, v) => hedgeModelCNumber(v) + "%" }))],
    cursor: { points: { show: false }, y: false, drag: { setScale: false } }, legend: { live: true }, hooks: { draw: [guide] },
  }, [model.grid.map((r) => r.hedgePct), ...rows.map(([key]) => model.grid.map((r) => r[key]))], box);
  const ro = new ResizeObserver(() => { if (box.clientWidth > 0) u.setSize({ width: Math.max(240, box.clientWidth), height }); });
  ro.observe(box); hedgeModelCCharts.push({ entry: trackChart(u, ro), box, height });
}
function renderHedgeModelC(payload) {
  const panel = document.getElementById("hedge-model-c");
  if (!panel) return;
  hedgeModelCPayload = payload;
  const state = hedgeModelCLoadState(), code = state.market, options = state.markets[code];
  hedgeModelCBSignature = hedgeModelCCompareSignature();
  hedgeModelCDispose(); panel.textContent = "";
  panel.append(el("div", { class: "hedge-c-heading" }, el("span", { class: "card-title" }, "환헤지모델C · 꼬리손실과 조정비용"),
    el("span", { class: "hedge-c-caption" }, "1개월 · ES95")));
  const models = Object.fromEntries(HEDGE_C_MARKETS.map(({ code: m }) => [m, hedgeModelCCompute(payload?.bond_analytics?.[m]?.outlook, state.markets[m])]));
  const markets = el("div", { class: "hedge-c-markets", "aria-label": "환헤지 시장 선택" });
  HEDGE_C_MARKETS.forEach((market, index) => {
    const result = models[market.code], outlook = payload?.bond_analytics?.[market.code]?.outlook;
    const button = el("button", { type: "button", id: `hedge-c-market-${market.code}`, class: "card hedge-c-market",
      "aria-pressed": String(code === market.code), "aria-controls": "hedge-c-detail", onclick: () => {
        state.market = market.code; hedgeModelCSaveState(); renderHedgeModelC(hedgeModelCPayload);
        document.getElementById(`hedge-c-market-${market.code}`)?.focus();
      } }, el("span", { class: "hedge-c-market-title" }, market.label),
      hedgeModelCMetric("선택 헤지비율 (%)", result.active ? result.optimal.hedgePct : null),
      hedgeModelCMetric("손실기준 합계 (%)", result.active ? result.optimal.objectivePct : null),
      el("span", { class: "hedge-c-meta" }, result.active ? `${outlook.asof} · 월간 N ${outlook.tail_risk.full.n_months}` : result.reason || "공통 관측 없음"));
    button.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const next = event.key === "ArrowRight" ? (index + 1) % HEDGE_C_MARKETS.length
        : event.key === "ArrowLeft" ? (index + HEDGE_C_MARKETS.length - 1) % HEDGE_C_MARKETS.length
        : event.key === "Home" ? 0 : event.key === "End" ? HEDGE_C_MARKETS.length - 1 : null;
      if (next !== null) { event.preventDefault(); document.getElementById(`hedge-c-market-${HEDGE_C_MARKETS[next].code}`)?.click(); }
    });
    markets.append(button);
  });
  panel.append(markets);
  const detail = el("div", { id: "hedge-c-detail", class: "hedge-c-detail" }); panel.append(detail);
  const controls = el("div", { class: "card hedge-c-controls" }), fields = {};
  const status = el("div", { id: "hedge-c-status", class: "hedge-c-status", role: "status", "aria-live": "polite" }); status.hidden = true;
  HEDGE_C_FIELDS.forEach(([key, title, min, max, step]) => {
    const input = el("input", { id: `hedge-c-${key}`, type: "number", value: options[key], min, max, step, "aria-describedby": status.id });
    fields[key] = input; controls.append(el("label", { for: input.id }, title, input));
  });
  const apply = () => {
    const next = Object.fromEntries(HEDGE_C_FIELDS.map(([key]) => [key, fields[key].value.trim() === "" ? NaN : Number(fields[key].value)]));
    const checked = hedgeModelCValidateOptions(next);
    if (!checked.valid) { status.textContent = checked.reason; status.hidden = false; return; }
    state.markets[code] = next; hedgeModelCSaveState(); renderHedgeModelC(hedgeModelCPayload); hedgeModelCRefreshSummary();
    document.getElementById("hedge-c-apply")?.focus();
  };
  Object.values(fields).forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); apply(); }
  }));
  controls.append(el("div", { class: "hedge-c-actions" },
    el("button", { type: "button", id: "hedge-c-apply", class: "btn-ghost", onclick: apply }, "적용"),
    el("button", { type: "button", id: "hedge-c-reset", class: "btn-ghost", onclick: () => {
      state.markets[code] = { ...hedgeModelCDefaults }; hedgeModelCSaveState(); renderHedgeModelC(hedgeModelCPayload); hedgeModelCRefreshSummary();
      document.getElementById("hedge-c-reset")?.focus();
    } }, "초기화")), status); detail.append(controls);
  detail.append(el("p", { class: "hedge-c-caption" }, "목적함수 차별화 · 통계적 직교성 미검증"));
  const model = models[code], outlook = payload?.bond_analytics?.[code]?.outlook;
  if (!model.active) detail.append(el("div", { class: "card hedge-c-empty", role: "status" }, model.reason || "유효한 공통 관측이 없습니다."));
  else {
    const full = outlook.tail_risk.full, recent = outlook.tail_risk.recent;
    detail.append(el("div", { class: "hedge-c-sample" },
      el("span", {}, `전체 ${full.start} ~ ${full.end} · N ${full.n_months}`),
      el("span", {}, `최근 ${recent.start} ~ ${recent.end} · N ${recent.n_months}`)));
    const bOptions = typeof hedgeModelBLoadState === "function" ? hedgeModelBLoadState().markets[code] : {};
    const bModel = typeof hedgeModelBCompute === "function" ? hedgeModelBCompute(outlook, bOptions) : null;
    const bRow = bModel?.active && bModel.meta.optimalIdentified ? model.grid[Math.max(0, Math.min(100, Math.round(bModel.optimal.hedgePct)))] : null;
    const rows = [["현재 입력", model.current], ["모델 C", model.optimal], ...(bRow ? [["모델 B · 1%p 반올림", bRow]] : []),
      ["무헤지", model.unhedged], ["50% 헤지", model.halfHedge], ["100% 헤지", model.fullHedge]];
    const cards = el("div", { class: "hedge-c-scenarios" });
    rows.forEach(([label, row], index) => {
      const card = el("div", { class: `card hedge-c-scenario${index === 1 ? " hedge-c-optimal" : ""}`, id: `hedge-c-scenario-${index}` },
        el("div", { class: "card-head" }, el("span", { class: "card-title" }, label), !row.feasible ? el("span", { class: "hedge-c-warning" }, "제약 밖") : null),
        hedgeModelCMetric("헤지비율 (%)", row.hedgePct), hedgeModelCMetric("강건 ES95 (%)", row.robustEsPct),
        hedgeModelCMetric("조정비용 (%)", row.tradeCostPct), hedgeModelCMetric("손실기준 합계 (%)", row.objectivePct));
      if (index === 1) card.append(el("span", { class: "hedge-c-meta" }, model.identified ? "격자 내 최소값" : "동률 · 현재 비율에 가까운 해"));
      cards.append(card);
    }); detail.append(cards);
    const chart = el("div", { class: "card hedge-c-chart", id: "hedge-c-chart" });
    const box = cardScaffold(chart, { title: "헤지비율별 꼬리손실", sub: "1개월 손실 (%)",
      csvName: `${code}-hedge-model-c-grid.csv`, tableFn: (cap, raw) => hedgeModelCTable(model.grid.map((r) => ["격자", r]), code, outlook, options, raw) });
    detail.append(chart); hedgeModelCChart(box, model);
    const comparison = el("div", { class: "card hedge-c-comparison", id: "hedge-c-comparison" });
    const table = (cap, raw) => hedgeModelCTable(rows, code, outlook, options, raw);
    const compareBox = cardScaffold(comparison, { title: "헤지안 비교", csvName: `${code}-hedge-model-c-comparison.csv`, tableFn: table });
    renderTable(compareBox, table()); detail.append(comparison);
    if (!bRow) detail.append(el("p", { class: "hedge-c-caption" }, "모델 B 비교: 유효한 고유해가 없어 표시하지 않습니다."));
  }
  detail.append(explainBox("hedge-model-c-method", { label: "모델 C · 기준과 한계" },
    el("p", {}, "전체 이력과 최근 120개 완료 월간 관측의 중심화된 채권·FX 공동 충격에서 ES95를 각각 계산하고, 더 큰 손실값에 일회성 조정비용을 더해 최소화합니다. ES95는 최악 5% 시나리오의 평균 손실이며 미래 손실 전망이나 최대손실이 아닙니다. 음수 ES는 해당 시나리오에서 이익임을 뜻합니다."),
    el("p", {}, "각 창의 채권·환율 충격 평균을 제거하고 현재 채권금리·수정듀레이션·HP 3M·6M·12M 평균 캐리를 고정합니다. 캐리 양수는 수취입니다. 캐리 악화 입력은 연 %p를 12로 나누어 1개월 헤지분의 손실에 가산합니다. 조정비용은 전액 변경 기준 bp에 실제 비율 변경폭을 곱한 초기 투자금 대비 비용입니다."),
    el("p", {}, "현재 비율과 헤지제약은 1%p 격자로 입력합니다. 현재·0·50·100%와 B는 제약 밖이어도 비교값을 표시합니다. 동률이면 현재 비율에 가까운 해, 다시 동률이면 낮은 비율을 선택합니다. 최근 120개 관측은 결측 월이 있을 때 정확한 10년과 다릅니다. 각 창 최소 120개 관측, 유효 꼬리표본 6개가 필요합니다."),
    el("p", {}, "A의 CIP 괴리, B의 평균·분산과 의사결정 기준을 달리하지만 원자료·듀레이션 근사·현재 캐리를 공유합니다. 통계적 직교성·표본외 성과·예측 우월성은 검증하지 않았습니다. B 비교는 B의 적용 가정을 사용한 비율을 1%p로 반올림해 C의 손실 기준으로 평가합니다."),
    el("p", {}, "볼록성·롤다운·환전 교차항·변동하는 헤지비용·증거금·스왑 MTM은 반영하지 않습니다. 입력 조정비용은 실측 거래비용이 아닌 시나리오입니다. 현재 관측일과 위험표본 신선도는 기존 B 입력의 검사를 따르며 유효하지 않은 자료는 비활성화합니다. 설정은 브라우저에만 저장되며 자산배분을 자동 변경하지 않습니다."),
    outlook ? el("p", {}, `원천: 채권 ${outlook.sources?.bond || "—"} · FX ${outlook.sources?.fx || "—"} · 기준일 ${outlook.asof || "—"}.`) : null));
}
