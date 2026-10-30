/* Conditional single-market hedge allocation. Uses only published covariance moments. */
"use strict";

const HEDGE_B_MARKETS = [
  { code: "UST", currency: "USD", label: "UST · USDKRW" },
  { code: "JPY", currency: "JPY", label: "JPY · JPY/KRW" },
  { code: "AUD", currency: "AUD", label: "AUD · AUDKRW" },
  { code: "GER", currency: "EUR", label: "GER · EURKRW" },
];
const HEDGE_B_STORAGE = "iaw-hedge-model-b-v1";
const HEDGE_B_FIELDS = [
  ["riskAversion", "위험회피 λ", 0, 100, 0.1],
  ["fxPct", "예상 FX 변화 (연 %)", -50, 50, 0.25],
  ["currentHedgePct", "현재 헤지비율 (%)", 0, 100, 1],
  ["minHedgePct", "최소 헤지비율 (%)", 0, 100, 1],
  ["maxHedgePct", "최대 헤지비율 (%)", 0, 100, 1],
];
let hedgeModelBState = null;
let hedgeModelBPayload = null;
let hedgeModelBCharts = [];

function hedgeModelBOptionsValid(values) {
  return values && HEDGE_B_FIELDS.every(([key, , lo, hi]) =>
    typeof values[key] === "number" && Number.isFinite(values[key])
      && (key === "riskAversion" ? values[key] > 0 : values[key] >= lo)
      && values[key] <= hi) && values.minHedgePct <= values.maxHedgePct;
}

function hedgeModelBLoadState() {
  if (hedgeModelBState) return hedgeModelBState;
  const defaults = () => ({ ...hedgeModelBDefaults });
  hedgeModelBState = { version: 1, market: "UST", markets: Object.fromEntries(
    HEDGE_B_MARKETS.map(({ code }) => [code, defaults()])) };
  try {
    const stored = JSON.parse(localStorage.getItem(HEDGE_B_STORAGE));
    if (stored?.version !== 1) return hedgeModelBState;
    if (HEDGE_B_MARKETS.some(({ code }) => code === stored.market)) hedgeModelBState.market = stored.market;
    HEDGE_B_MARKETS.forEach(({ code }) => {
      const values = stored.markets?.[code];
      if (hedgeModelBOptionsValid(values)) hedgeModelBState.markets[code] = Object.fromEntries(
        HEDGE_B_FIELDS.map(([key]) => [key, values[key]]));
    });
  } catch (_) { /* Private-mode/corrupt storage leaves deterministic defaults. */ }
  return hedgeModelBState;
}

function hedgeModelBSaveState() {
  try { localStorage.setItem(HEDGE_B_STORAGE, JSON.stringify(hedgeModelBState)); } catch (_) { /* Keep session state. */ }
}

function hedgeModelBDispose() {
  hedgeModelBCharts.forEach(({ entry }) => {
    if (uplots.includes(entry)) destroyChart(entry);
  });
  hedgeModelBCharts = [];
}

function hedgeModelBResize() {
  hedgeModelBCharts.forEach(({ entry, box, height }) => {
    if (uplots.includes(entry) && box.clientWidth > 0)
      entry.u.setSize({ width: Math.max(240, box.clientWidth), height });
  });
}

function hedgeModelBNumber(value, signed = false) {
  return Number.isFinite(value) ? `${signed && value > 0 ? "+" : ""}${fmtNum(value, 2)}` : "—";
}

function hedgeModelBMetric(label, value, id, signed = false) {
  return el("span", { class: "hedge-b-metric" }, el("span", {}, label),
    el("b", { ...(id ? { id } : {}) }, hedgeModelBNumber(value, signed)));
}

function hedgeModelBTie(model, values) {
  return !!model?.meta?.flatFxRisk && values.minHedgePct !== values.maxHedgePct;
}

function hedgeModelBChart(box, model, options, key, label) {
  const pal = palette(), gold = currentTheme() === "dark" ? "#edbd63" : "#8a5c00";
  const height = 270;
  const axes = baseAxes(pal, (v) => fmtNum(v, 2), (v, extra) => fmtNum(v, 2 + extra));
  axes[0] = { ...axes[0], label: "헤지비율 (%)", labelSize: 24,
    values: (u, values) => values.map((v) => fmtNum(v, 0)), incrs: [10, 20, 25, 50] };
  const guide = (plot) => {
    if (!plot.ctx || !plot.bbox) return;
    const ctx = plot.ctx, dpr = devicePixelRatio || 1;
    ctx.save();
    const lo = plot.valToPos(options.minHedgePct, "x", true);
    const hi = plot.valToPos(options.maxHedgePct, "x", true);
    ctx.fillStyle = currentTheme() === "dark" ? "rgba(237,189,99,.06)" : "rgba(138,92,0,.06)";
    ctx.fillRect(lo, plot.bbox.top, Math.max(0, hi - lo), plot.bbox.height);
    [[model.current.hedgePct, pal.ink3, [4, 4]],
      [model.meta.minVarianceIdentified ? model.minVariance.hedgePct : null, pal.series[0], [2, 3]],
      [model.meta.optimalIdentified ? model.optimal.hedgePct : null, gold, []]].forEach(([h, color, dash]) => {
      if (h === null) return;
      const x = plot.valToPos(h, "x", true);
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = dpr;
      ctx.setLineDash(dash.map((v) => v * dpr));
      ctx.moveTo(x, plot.bbox.top); ctx.lineTo(x, plot.bbox.top + plot.bbox.height); ctx.stroke();
    });
    ctx.restore();
  };
  const u = new uPlot({
    width: Math.max(240, box.clientWidth), height,
    scales: { x: { time: false, range: [0, 100] } }, axes,
    series: [{ label: "헤지비율", value: (u, v) => hedgeModelBNumber(v) + "%" },
      { label, stroke: gold, width: 2, points: { show: false },
        value: (u, v) => hedgeModelBNumber(v) + "%" }],
    cursor: { points: { show: false }, y: false, drag: { setScale: false } },
    legend: { live: true }, hooks: { draw: [guide] },
  }, [model.grid.map((r) => r.hedgePct), model.grid.map((r) => r[key])], box);
  const ro = new ResizeObserver(() => {
    if (box.clientWidth > 0) u.setSize({ width: Math.max(240, box.clientWidth), height });
  });
  ro.observe(box);
  const entry = trackChart(u, ro);
  hedgeModelBCharts.push({ entry, box, height });
}

function hedgeModelBTable(rows, market, outlook, options, raw = false) {
  const n = (v) => raw ? v : hedgeModelBNumber(v);
  return {
    headers: ["구분", "헤지비율 (%)", "기대수익 (연 %)", "변동성 (연 %)", "헤지 캐리 (연 %)",
      "위험조정수익 CE (연 %)", "위험 감소 (%p)", "제약 충족", "해 구분", "시장", "예상 FX (연 %)",
      "위험회피 λ", "최소 헤지 (%)", "최대 헤지 (%)", "추정기준일", "표본 시작", "표본 종료", "월간 표본"],
    rows: rows.map(([title, row, identified]) => [title, n(row.hedgePct), n(row.meanPct), n(row.volPct), n(row.carryPct),
      n(row.cePct), n(row.riskReductionPp), row.feasible ? "충족" : "제약 밖", identified === false ? "동률 대표값" : identified === true ? "고유해" : "비교값", market,
      n(options.fxPct), n(options.riskAversion), n(options.minHedgePct), n(options.maxHedgePct),
      outlook.asof || "", outlook.sample?.start || "", outlook.sample?.end || "", outlook.sample?.n_months ?? ""]),
  };
}

function renderHedgeModelB(payload) {
  const panel = document.getElementById("hedge-model-b");
  if (!panel) return;
  hedgeModelBPayload = payload;
  const stored = hedgeModelBLoadState(), code = stored.market, options = stored.markets[code];
  hedgeModelBDispose();
  panel.textContent = "";
  panel.append(el("div", { class: "hedge-b-heading" },
    el("span", { class: "card-title" }, "환헤지모델B · 비용과 위험"),
    el("span", { class: "hedge-b-caption" }, "단일시장 · 연 기준")));
  const models = Object.fromEntries(HEDGE_B_MARKETS.map(({ code: market }) => [market,
    hedgeModelBCompute(payload?.bond_analytics?.[market]?.outlook, stored.markets[market])]));
  const marketGrid = el("div", { class: "hedge-b-markets", "aria-label": "환헤지 시장 선택" });
  HEDGE_B_MARKETS.forEach((market, index) => {
    const result = models[market.code], values = stored.markets[market.code];
    const outlook = payload?.bond_analytics?.[market.code]?.outlook;
    const button = el("button", { type: "button", class: "card hedge-b-market",
      id: `hedge-b-market-${market.code}`, "aria-pressed": String(code === market.code),
      "aria-controls": "hedge-b-detail", onclick: () => {
        stored.market = market.code; hedgeModelBSaveState(); renderHedgeModelB(hedgeModelBPayload);
        document.getElementById(`hedge-b-market-${market.code}`)?.focus();
      } }, el("span", { class: "hedge-b-market-title" }, market.label));
    const mv = hedgeModelBMetric("최소분산 (%)", result.active ? result.minVariance.hedgePct : null);
    if (result.active && hedgeModelBTie(result, values)) mv.querySelector("b").textContent = "동률";
    const optimal = hedgeModelBMetric("비용반영 (%)", result.active ? result.optimal.hedgePct : null);
    if (result.active && result.meta.optimalIdentified === false) optimal.querySelector("b").textContent = "동률";
    button.append(mv, optimal,
      el("span", { class: "hedge-b-meta" }, `λ ${hedgeModelBNumber(values.riskAversion)} · FX ${hedgeModelBNumber(values.fxPct, true)}% · ${hedgeModelBNumber(values.minHedgePct)}~${hedgeModelBNumber(values.maxHedgePct)}%`),
      el("span", { class: "hedge-b-meta" }, result.active
        ? `${outlook.asof} · N ${outlook.sample.n_months}` : result.reason || "공통 관측 없음"));
    button.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const next = event.key === "ArrowRight" ? (index + 1) % HEDGE_B_MARKETS.length
        : event.key === "ArrowLeft" ? (index + HEDGE_B_MARKETS.length - 1) % HEDGE_B_MARKETS.length
        : event.key === "Home" ? 0 : event.key === "End" ? HEDGE_B_MARKETS.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); document.getElementById(`hedge-b-market-${HEDGE_B_MARKETS[next].code}`)?.click();
    });
    marketGrid.append(button);
  });
  panel.append(marketGrid);

  const detail = el("div", { id: "hedge-b-detail", class: "hedge-b-detail" });
  panel.append(detail);
  const controls = el("div", { class: "card hedge-b-controls" });
  const fields = {};
  const status = el("div", { id: "hedge-b-status", class: "hedge-b-status", role: "status", "aria-live": "polite" });
  status.hidden = true;
  HEDGE_B_FIELDS.forEach(([key, title, min, max, step]) => {
    const input = el("input", { id: `hedge-b-${key}`, type: "number", value: options[key],
      min, max, step, "aria-describedby": status.id });
    fields[key] = input;
    controls.append(el("label", { for: input.id }, title, input));
  });
  const apply = () => {
    const next = Object.fromEntries(HEDGE_B_FIELDS.map(([key]) => [key,
      fields[key].value.trim() === "" ? NaN : Number(fields[key].value)]));
    if (!hedgeModelBOptionsValid(next)) {
      status.textContent = "입력 범위와 최소·최대 헤지비율을 확인하십시오. 위험회피 λ는 0보다 커야 합니다.";
      status.hidden = false; return;
    }
    stored.markets[code] = next; hedgeModelBSaveState(); renderHedgeModelB(hedgeModelBPayload);
    document.getElementById("hedge-b-apply")?.focus();
  };
  Object.values(fields).forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); apply(); }
  }));
  controls.append(el("div", { class: "hedge-b-actions" },
    el("button", { type: "button", id: "hedge-b-apply", class: "btn-ghost", onclick: apply }, "적용"),
    el("button", { type: "button", id: "hedge-b-reset", class: "btn-ghost", onclick: () => {
      stored.markets[code] = { ...hedgeModelBDefaults };
      hedgeModelBSaveState(); renderHedgeModelB(hedgeModelBPayload);
      document.getElementById("hedge-b-reset")?.focus();
    } }, "초기화")), status);
  detail.append(controls);
  const model = models[code], outlook = payload?.bond_analytics?.[code]?.outlook;
  if (!model.active) {
    detail.append(el("div", { class: "card hedge-b-empty", role: "status" }, model.reason || "유효한 공통 관측이 없습니다."));
  } else {
    detail.append(el("div", { class: "hedge-b-sample" },
      `${code} · ${outlook.sample.start} ~ ${outlook.sample.end} · 월간 N ${outlook.sample.n_months}`,
      el("span", {}, `HP 평균 ${hedgeModelBNumber(outlook.cost.mean_pct, true)}% · 듀레이션 ${hedgeModelBNumber(outlook.duration_years)}년 · 채권–FX 상관 ${hedgeModelBNumber(model.input.correlation)}`)));
    const current = el("div", { class: "card hedge-b-current" }, el("strong", {}, "현재 입력"),
      hedgeModelBMetric("헤지비율 (%)", model.current.hedgePct, "hedge-b-current-ratio"),
      hedgeModelBMetric("기대수익 (연 %)", model.current.meanPct, "hedge-b-current-return"),
      hedgeModelBMetric("변동성 (연 %)", model.current.volPct, "hedge-b-current-vol"),
      hedgeModelBMetric("헤지 캐리 (연 %)", model.current.carryPct, "hedge-b-current-carry", true));
    if (!model.current.feasible) current.append(el("span", { class: "hedge-b-warning" }, "현재 입력: 제약 밖"));
    detail.append(current);
    const scenarios = [["무헤지", model.grid[0]], ["50% 헤지", model.grid[50]], ["100% 헤지", model.grid[100]],
      ["최소분산", model.minVariance, model.meta.minVarianceIdentified],
      ["비용반영", model.optimal, model.meta.optimalIdentified]];
    const scenarioGrid = el("div", { class: "hedge-b-scenarios" });
    scenarios.forEach(([label, row, identified], index) => {
      const card = el("div", { class: `card hedge-b-scenario${index === 4 ? " hedge-b-optimal" : ""}`,
        id: `hedge-b-scenario-${index}` }, el("div", { class: "card-head" },
          el("span", { class: "card-title" }, label),
          !row.feasible ? el("span", { class: "hedge-b-warning" }, "제약 밖") : null));
      const ratio = hedgeModelBMetric("헤지비율 (%)", row.hedgePct);
      if (identified === false) ratio.querySelector("b").textContent = "동률";
      card.append(ratio, hedgeModelBMetric("기대수익 (연 %)", row.meanPct),
        hedgeModelBMetric("변동성 (연 %)", row.volPct),
        hedgeModelBMetric("위험조정수익 CE (연 %)", row.cePct),
        hedgeModelBMetric("무헤지 대비 위험 감소 (%p)", row.riskReductionPp, null, true));
      if (index >= 3 && row.boundary) card.append(el("div", { class: "hedge-b-boundary" }, identified === false ? "동률 대표값" : "제약 경계"));
      scenarioGrid.append(card);
    });
    detail.append(scenarioGrid);
    const comparison = el("div", { class: "card hedge-b-comparison", id: "hedge-b-comparison" });
    const comparisons = [["현재 입력", model.current], ...scenarios];
    const compareBox = cardScaffold(comparison, { title: "헤지안 비교", csvName: `${code}-hedge-model-b-comparison.csv`,
      tableFn: (cap, raw) => hedgeModelBTable(comparisons, code, outlook, options, raw) });
    compareBox.classList.add("hedge-b-key");
    compareBox.append(el("span", { class: "hedge-b-key-current" }, "현재 입력"),
      el("span", { class: "hedge-b-key-mv" }, model.meta.minVarianceIdentified ? "최소분산" : "최소분산 동률"),
      el("span", { class: "hedge-b-key-opt" }, model.meta.optimalIdentified ? "비용반영" : "비용반영 동률"),
      el("span", {}, `허용구간 ${hedgeModelBNumber(options.minHedgePct)} ~ ${hedgeModelBNumber(options.maxHedgePct)}%`));
    detail.append(comparison);
    const charts = el("div", { class: "hedge-b-charts" });
    [["volPct", "위험", "변동성"], ["meanPct", "기대수익", "기대수익"]].forEach(([key, title, label]) => {
      const card = el("div", { class: "card hedge-b-chart", id: `hedge-b-chart-${key}` });
      const box = cardScaffold(card, { title: `헤지비율별 ${title}`, sub: "연 %",
        csvName: `${code}-hedge-model-b-grid.csv`, tableFn: (cap, raw) => hedgeModelBTable(
          model.grid.map((row) => ["헤지비율 격자", row]), code, outlook, options, raw) });
      charts.append(card); hedgeModelBChart(box, model, options, key, label);
    });
    detail.append(charts);
    const sensitivity = el("div", { class: "card hedge-b-sensitivity", id: "hedge-b-sensitivity" });
    const sensitivityTable = (cap, raw) => ({
      headers: ["예상 FX 변화 (연 %)", "비용반영 헤지비율 (%)", "기대수익 (연 %)", "변동성 (연 %)", "위험조정수익 CE (연 %)", "해 구분",
        ...(raw ? ["시장", "위험회피 λ", "최소 헤지 (%)", "최대 헤지 (%)", "추정기준일", "표본 시작", "표본 종료", "월간 표본"] : [])],
      rows: model.sensitivity.map((row) => [...[row.fxPct, row.hedgePct, row.meanPct, row.volPct, row.cePct]
        .map((v) => raw ? v : hedgeModelBNumber(v)), row.optimalIdentified ? "고유해" : "동률 대표값",
        ...(raw ? [code, options.riskAversion, options.minHedgePct, options.maxHedgePct,
          outlook.asof, outlook.sample.start, outlook.sample.end, outlook.sample.n_months] : [])]),
    });
    const sensitivityBox = cardScaffold(sensitivity, { title: "예상 FX 변화 민감도", sub: "입력값 ±2.00%p",
      csvName: `${code}-hedge-model-b-fx-sensitivity.csv`, tableFn: sensitivityTable });
    renderTable(sensitivityBox, sensitivityTable());
    detail.append(sensitivity);
  }
  detail.append(explainBox("hedge-model-b-method", { label: "환헤지모델B · 가정과 입력자료" },
    el("p", {}, "각 시장의 10년 국채와 원화 표시 외화 수익률 공분산을 사용한 단일시장 조건부 시나리오입니다. " +
      "시장의 공통 월간 표본은 서로 다르며, 네 시장을 합친 포트폴리오 최적화 결과가 아닙니다. " +
      "채권 수익은 현재 수정듀레이션과 금리 변화의 1차 근사, FX는 로그수익률로 계산합니다. 금리 변화 기대는 0입니다."),
    el("p", {}, "예상 FX 변화가 양수이면 외화가 원화 대비 강세인 시나리오입니다. 기본값 0은 전망치가 아닌 가정입니다. " +
      "헤지 캐리는 현재 HP 3M·6M·12M 평균을 고정하며 양수는 수취, 음수는 지불입니다. " +
      "최소분산 비율은 헤지비용과 독립적이고 비용반영 비율은 기대수익에서 위험회피 λ×분산/2를 차감한 CE를 최대화합니다. " +
      "λ 기본값 5는 추정한 선호가 아닌 조정 가능한 시나리오입니다. CE는 보장수익률이 아닙니다."),
    el("p", {}, "최소·최대 헤지비율은 최소분산 및 비용반영 해에 적용합니다. 무헤지·50%·100%·현재 입력은 제약 밖에서도 비교 기준으로 표시합니다. " +
      "FX 분산이 0이면 최소분산 해는 동률이며 최소 제약 비율을 대표값으로 사용합니다. 이때 캐리와 예상 FX 변화도 같으면 비용반영 해 역시 동률입니다. " +
      "동률의 비교 수치와 CSV에는 하한 대표값을 기록하며 최적비율 가이드는 생략합니다. 자연헤지 효과가 있으면 헤지가 총위험을 늘릴 수 있습니다."),
    el("p", {}, "동일 관측일의 완료 월간 표본을 사용하며 최소 36개월이 필요합니다. 현재 조건부 공분산을 유지하므로 " +
      "표본외 백테스트나 실제 운용성과가 아닙니다. 볼록성·롤다운·환전 교차항·거래비용·스왑 MTM과 모수 불확실성은 반영하지 않습니다. " +
      "모든 설정은 이 브라우저에만 저장되며 자산배분 비중을 자동 변경하지 않습니다."),
    outlook ? el("p", {}, `원천: 채권 ${outlook.sources?.bond || "—"} · FX ${outlook.sources?.fx || "—"}. ` +
      `국채 관측 ${outlook.yield_asof || "—"} · HP 관측 ${outlook.cost?.asof || "—"} · 추정기준일 ${outlook.asof || "—"}.`) : null));
}
