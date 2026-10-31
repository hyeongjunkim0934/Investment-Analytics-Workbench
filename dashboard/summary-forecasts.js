/* Quarterly model summaries read published model outputs and applied browser settings. */
"use strict";

let summaryForecastMarket = null;

function summaryForecastNumber(value, digits = 0, suffix = "") {
  return Number.isFinite(value) ? `${fmtNum(value, digits)}${suffix}` : "—";
}

function summaryForecastMetric(label, value, { className = "", title = "" } = {}) {
  return el("div", { class: `summary-forecast-metric ${className}`, ...(title ? { title } : {}) },
    el("span", {}, label), el("b", {}, value));
}

function summaryForecastCard(model, kind) {
  const hedge = kind === "hedge", digits = hedge ? 2 : 0, suffix = hedge ? "%" : "";
  const card = el("article", { class: "card summary-forecast-card", "data-model": model.key,
    "aria-label": model.label });
  const heading = el("div", { class: "summary-forecast-card-head" },
    el("h3", {}, model.label), el("span", { class: "summary-forecast-basis" }, model.basis || ""));
  card.append(heading);
  if (model.constraintLabel) card.append(el("div", { class: "summary-forecast-missing" }, model.constraintLabel));
  card.append(el("div", { class: "summary-forecast-meta" },
    el("span", {}, model.anchorDate ? `기준 ${model.anchorDate}` : "기준일 —"),
    el("span", {}, hedge ? "누적수익률 %" : "원/달러")));
  const quarters = el("div", { class: "summary-forecast-quarters" });
  (model.rows || []).forEach((row) => {
    const quarter = el("div", { class: "summary-forecast-quarter", "data-horizon": String(row.horizonMonths) });
    quarter.append(el("div", { class: "summary-forecast-quarter-head" },
      el("strong", {}, row.quarterLabel || `${row.horizonMonths}개월`),
      el("time", { ...(row.targetDate ? { datetime: row.targetDate } : {}) }, row.targetDate || "—")));
    if (hedge) quarter.append(summaryForecastMetric("헤지비율 (%)", summaryForecastNumber(row.hedgePct, 2, "%"),
      { title: row.hedgeReason || "" }));
    quarter.append(summaryForecastMetric(hedge ? "기대수익률 (%)" : model.pointLabel || "예상치 (원)",
      summaryForecastNumber(hedge ? row.meanPct : row.point, digits, suffix), { className: "summary-forecast-point" }));
    const lower = row.lower ?? row.lower95, upper = row.upper ?? row.upper95;
    const range = Number.isFinite(lower) && Number.isFinite(upper)
      ? `${summaryForecastNumber(lower, digits, suffix)} ~ ${summaryForecastNumber(upper, digits, suffix)}` : "—";
    quarter.append(summaryForecastMetric(row.intervalLabel || model.intervalLabel || model.uncertaintyKind || "95% 범위", range,
      { title: row.intervalReason || "" }));
    quarter.append(summaryForecastMetric("VaR 97.5%", summaryForecastNumber(row.var975Pct, 2, "%"),
      { className: "summary-forecast-var", title: row.varReason || (hedge ? "원화 누적 총수익의 손실" : "달러 보유자의 원화 환손실") }));
    if (row.reason) quarter.append(el("div", { class: "summary-forecast-missing", role: "status",
      title: row.reason }, row.reason.includes("fx_lstm_xgb.json") ? "학습 산출물 미등록" : row.reason));
    else if (row.intervalReason) quarter.append(el("div", { class: "summary-forecast-missing" }, row.intervalReason));
    if (model.key === "consensus") quarter.append(el("div", { class: "summary-forecast-sample" },
      `응답 ${row.sampleCount || 0}개 · VaR 미산출`));
    quarters.append(quarter);
  });
  card.append(quarters);
  const details = el("details", { class: "summary-forecast-method", "data-method": `${kind}-${model.key}` },
    el("summary", {}, "산출 기준"));
  [...(Array.isArray(model.details) ? model.details : [model.description]), ...(model.notes || [])].filter(Boolean)
    .forEach((line) => details.append(el("p", {}, line)));
  if (model.reason) details.append(el("p", {}, model.reason));
  card.append(details);
  return card;
}

function summaryForecastCsv(models, kind) {
  const hedge = kind === "hedge";
  return {
    headers: ["구분", "모형", "산출 기준", "기준일", "기준환율", "지평 (개월)", "분기", "목표일",
      "중심 정의", "예상치", "단위", "헤지비율 (%)", "구간 정의", "하단", "상단", "VaR 신뢰수준 (%)",
      "VaR (%)", "표본/응답 N", "미산출 사유", "구간 미산출 사유", "VaR 미산출 사유"],
    rows: models.flatMap((model) => (model.rows || []).map((row) => [
      hedge ? "환헤지" : "환율", model.label, model.basis, row.anchorDate || model.anchorDate,
      row.anchorValue ?? model.anchorValue ?? null, model.key === "consensus" ? null : row.horizonMonths,
      row.quarterLabel || "", row.targetDate,
      hedge ? "누적 기대수익률" : model.pointLabel, hedge ? row.meanPct : row.point,
      hedge ? "%" : "KRW/USD", hedge ? row.hedgePct : null,
      row.intervalLabel || model.intervalLabel || model.uncertaintyKind, row.lower ?? row.lower95 ?? null,
      row.upper ?? row.upper95 ?? null, 97.5, row.var975Pct, row.sampleCount ?? null,
      row.reason || "", row.intervalReason || "", row.varReason || "",
    ])),
  };
}

function renderSummaryForecasts() {
  const host = document.getElementById("summary-forecasts");
  if (!host) return;
  const opened = new Set([...host.querySelectorAll("details")]
    .filter((node) => node.hasAttribute("open")).map((node) => node.getAttribute("data-method")));
  host.textContent = "";
  const lx = DATA.fx?.lstm_xgb, validB = fxLxValid(lx);
  const viewB = validB.ok ? fxLxViewState(lx, validB) : null;
  const fx = summaryFxModels(DATA.fx, fxOutlookState(), viewB);
  const names = fxOutlookNames();
  fx.forEach((model) => { if (names[model.key]) model.label = names[model.key]; });
  const stored = hedgeModelBLoadState();
  const markets = typeof HEDGE_B_MARKETS !== "undefined" ? HEDGE_B_MARKETS : [];
  if (!markets.some((market) => market.code === summaryForecastMarket)) summaryForecastMarket = stored.market || "UST";
  const hedge = summaryHedgeModels(DATA.hedge, stored.markets, summaryForecastMarket);
  const section = (id, title, subtitle, models, kind, controls) => {
    const area = el("section", { class: "summary-forecast-section", "aria-labelledby": id });
    const csv = el("button", { type: "button", class: "btn-ghost", "aria-label": `${title} CSV 다운로드`, onclick: () => {
      const data = summaryForecastCsv(models, kind);
      downloadCSV(`IAW-${kind}-quarterly${kind === "hedge" ? `-${summaryForecastMarket}` : ""}.csv`, data.headers, data.rows);
    } }, "CSV");
    const toolbar = el("div", { class: "summary-forecast-toolbar" },
      el("div", { class: "summary-forecast-heading" }, el("h2", { id }, title), el("span", {}, subtitle)),
      controls || null, csv);
    const grid = el("div", { class: `summary-forecast-grid summary-forecast-grid-${kind}` });
    models.forEach((model) => grid.append(summaryForecastCard(model, kind)));
    area.append(toolbar, grid); host.append(area);
  };
  section("summary-fx-title", "환율전망", "기준일 이후 1년 · 분기별", fx, "fx");
  const market = el("select", { id: "summary-hedge-market", "aria-label": "요약 환헤지 시장" });
  markets.forEach(({ code, label }) => market.append(el("option", { value: code }, label)));
  market.value = summaryForecastMarket;
  market.addEventListener("change", () => {
    summaryForecastMarket = market.value; renderSummaryForecasts();
    document.getElementById("summary-hedge-market")?.focus();
  });
  section("summary-hedge-title", "환헤지", "기준일 이후 1년 · 조건부 누적수익", hedge, "hedge", market);
  host.querySelectorAll("details").forEach((node) => {
    if (opened.has(node.getAttribute("data-method"))) node.setAttribute("open", "");
  });
}
