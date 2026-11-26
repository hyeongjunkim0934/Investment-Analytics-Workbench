/* USD hedge premium path implied by the Korea–US forward rate differential.
   A market-implied path with its own track record shown next to it — not a
   forecast claimed to beat "no change". Rendered below the CIP comparison. */
"use strict";

let hedgeForwardCharts = [];

function hedgeForwardDispose() {
  hedgeForwardCharts.forEach((entry) => {
    if (uplots.includes(entry)) destroyChart(entry);
    for (let i = registry.length - 1; i >= 0; i--)
      if (registry[i].u === entry.u) registry.splice(i, 1);
  });
  hedgeForwardCharts = [];
}

function hedgeForwardSegmentLabel(years) {
  const [a, b] = years;
  return a === 0 ? `현재~${b}년` : `${a}~${b}년 뒤`;
}

function hedgeForwardValid(p) {
  const num = Number.isFinite;
  if (p?.active !== true || p.schema !== "hedge_forward_v1" || p.currency !== "USD") return false;
  const c = p.current;
  if (!c || ![c.premium, c.spread_1y, c.gap, c.gap_bp].every(num) || typeof p.asof !== "string") return false;
  if (!Array.isArray(p.segments) || !p.segments.length) return false;
  let end = 0;
  for (const s of p.segments) {
    if (!Array.isArray(s?.years) || s.years.length !== 2 || s.years[0] !== end || !(s.years[1] > s.years[0])
        || ![s.kr, s.us, s.diff, s.implied_premium, s.change_vs_now].every(num)) return false;
    // The identities are the meaning of the columns; a payload that breaks them is not shown.
    if (Math.abs(s.diff - (s.kr - s.us)) > 1e-6 || Math.abs(s.implied_premium - (s.diff + c.gap)) > 1e-6) return false;
    end = s.years[1];
  }
  return Math.abs(p.segments[0].implied_premium - c.premium) <= 1e-6;
}

function hedgeForwardVerdict(backtest) {
  const rows = (Array.isArray(backtest) ? backtest : []).filter((r) => r?.active === true
    && Number.isFinite(r.rmse) && Number.isFinite(r.rw_rmse));
  if (!rows.length) return "과거 평가 표본이 부족해 포워드 금리차의 예측력을 확인하지 못했습니다.";
  const worse = rows.filter((r) => r.rmse >= r.rw_rmse).length;
  if (worse === rows.length) return "과거 평가에서 포워드 금리차의 오차가 「현 수준 유지」보다 컸습니다 — 전망이 아니라 시장이 반영한 경로로 읽으십시오.";
  if (worse === 0) return "과거 평가에서 포워드 금리차의 오차가 「현 수준 유지」보다 작았으나, 겹치는 표본이라 우위가 검증된 것은 아닙니다.";
  return "과거 평가에서 포워드 금리차가 「현 수준 유지」보다 나은 지평과 못한 지평이 섞여 있습니다 — 예측 우위는 확인되지 않았습니다.";
}

function renderHedgeForward(payload) {
  const panel = document.getElementById("hedge-model-a");
  if (!panel) return;
  hedgeForwardDispose();
  const previous = document.getElementById("hedge-forward");
  if (previous) previous.remove();
  const section = el("div", { id: "hedge-forward", class: "hedge-forward" });
  panel.append(section);
  const signed = (v, dec = 2) => Number.isFinite(v) ? `${v > 0 ? "+" : ""}${fmtNum(v, dec)}` : "—";
  section.append(el("div", { class: "hedge-cip-head" },
    el("span", { class: "card-title" }, "USD · 금리 곡선에 내재된 헤지비용 경로"),
    el("span", { class: "hedge-cip-definition" }, `포워드 금리차(한국−미국) + 현재 괴리 · 연 % · ${COST_SIGN_KEY}`)));

  if (!hedgeForwardValid(payload)) {
    section.append(el("p", { class: "port-warn d-up", role: "status" },
      payload?.active === false && payload.reason ? `계산 보류 — ${payload.reason}`
        : "내재 헤지비용 경로를 확인할 수 없어 표시하지 않습니다."));
    return;
  }
  const c = payload.current;
  // Not folded: this line is the reading instruction for every number below it.
  section.append(el("p", { class: "port-warn d-up hedge-forward-verdict", role: "status" }, hedgeForwardVerdict(payload.backtest)));

  const tile = (label, value, unit) => el("div", { class: "card hedge-cip-stat hedge-forward-tile" },
    el("div", { class: "hedge-cip-metric" }, el("span", {}, label),
      el("strong", { class: "hedge-cip-value" }, value), unit ? el("span", { class: "card-sub" }, unit) : null));
  section.append(el("div", { class: "hedge-forward-tiles", "aria-label": "현재 헤지비용과 금리차" },
    tile("현재 헤지 프리미엄(평균)", signed(c.premium), "연 %"),
    tile("현재 1년 금리차", signed(c.spread_1y), "%p"),
    tile("현재 괴리", signed(c.gap_bp, 1), "bp"),
    tile("기준일", payload.asof, "")));

  const pathHeaders = ["구간", "한국 포워드 (%)", "미국 포워드 (%)", "금리차 (%p)", "현재 대비 (%p)", "내재 헤지 프리미엄 (연 %)"];
  const pathRows = payload.segments.map((s) => [hedgeForwardSegmentLabel(s.years), fmtNum(s.kr, 2), fmtNum(s.us, 2),
    signed(s.diff), signed(s.change_vs_now), signed(s.implied_premium)]);
  const table = (headers, rows, cls) => {
    const node = el("table", { class: cls });
    node.append(el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)))));
    const body = el("tbody");
    rows.forEach((row) => body.append(el("tr", {}, ...row.map((cell, i) => el("td", i ? { class: "num" } : {}, cell)))));
    node.append(body);
    return node;
  };
  const pathCard = el("div", { class: "card hedge-forward-card" },
    el("div", { class: "card-head" }, el("span", { class: "card-title" }, "구간별 내재 경로"),
      el("span", { class: "card-sub" }, "괴리는 현재값을 그대로 유지한다고 가정")),
    el("div", { class: "table-wrap" }, table(pathHeaders, pathRows, "hedge-forward-path")));
  section.append(pathCard);

  const history = payload.history || {};
  const shown = (Array.isArray(history.segments) ? history.segments : []).filter((s) => Array.isArray(s?.years)
    && s.years[1] <= 3 && Array.isArray(s.diff) && s.diff.length === (history.t || []).length);
  const historyCard = el("div", { class: "card hedge-forward-card hedge-forward-history" });
  section.append(historyCard);
  const labels = shown.map((s) => `${hedgeForwardSegmentLabel(s.years)} 금리차`);
  const box = cardScaffold(historyCard, { title: "현재 금리차와 포워드 금리차", sub: "한국−미국 · %p · 주별",
    csvName: "USD-forward-rate-differential.csv",
    tableFn: tsTableFn(labels.map((l) => `${l} (%p)`), [history.t || [], ...shown.map((s) => s.diff)], 2) });
  const empty = el("p", { class: "card-sub", role: "status" }, "표시할 이력이 없습니다.");
  box.append(empty);
  if (shown.length && history.t.length) {
    const pal = palette();
    const chart = makeTimeChart(box, { labels, colors: shown.map((_, i) => pal.series[i % pal.series.length]),
      units: shown.map(() => "%p"), data: [history.t, ...shown.map((s) => s.diff)],
      emptyState: empty, dec: 2, height: 255, hoverTooltip: true });
    hedgeForwardCharts.push(chart);
  }

  const backtest = Array.isArray(payload.backtest) ? payload.backtest : [];
  const btHeaders = ["지평", "N", "포워드 RMSE (%p)", "현 수준 유지 RMSE (%p)", "Theil U", "편향 (%p)", "방향 적중률", "기준월"];
  const btRows = backtest.map((r) => r?.active === true
    ? [`${r.horizon_months}개월 뒤 1년 금리차`, String(r.n), fmtNum(r.rmse, 2), fmtNum(r.rw_rmse, 2),
      Number.isFinite(r.theil_u) ? fmtNum(r.theil_u, 3) : "—", signed(r.bias),
      Number.isFinite(r.hit_rate) ? `${fmtNum(r.hit_rate * 100, 0)}% (${r.hit_n})` : "—", `${r.first_origin} ~ ${r.last_origin}`]
    : [`${r?.horizon_months ?? "—"}개월 뒤 1년 금리차`, String(r?.n ?? 0), "—", "—", "—", "—", "—", r?.reason || "평가 보류"]);
  section.append(el("div", { class: "card hedge-forward-card" },
    el("div", { class: "card-head" }, el("span", { class: "card-title" }, "포워드 금리차의 과거 성적"),
      el("span", { class: "card-sub" }, "Theil U = 포워드 RMSE ÷ 현 수준 유지 RMSE · 1 미만이면 포워드가 나음")),
    el("div", { class: "table-wrap" }, table(btHeaders, btRows, "hedge-forward-backtest"))));

  section.append(explainBox("hedge-forward-method", { label: "내재 헤지비용 경로 · 산식과 한계" },
    el("p", {}, "헤지 프리미엄은 1차 근사로 양국 금리차에 괴리(베이시스)를 더한 값입니다. 미래 구간의 금리차는 두 나라 금리 곡선이 " +
      "그 구간에 대해 이미 반영하고 있는 포워드 금리로 읽습니다. 구간 a~b년의 포워드 금리 = [(1+y_b)^b ÷ (1+y_a)^a]^(1/(b−a)) − 1 이며, " +
      "한국·미국 1·2·3·5·10년 국채금리를 연복리 제로금리로 간주했습니다(이표채 금리를 제로금리로 쓰는 근사)."),
    el("p", {}, "내재 헤지 프리미엄 = 구간 포워드 금리차(한국−미국) + 현재 괴리. 현재 괴리 = 현재 평균 헤지 프리미엄 − 현재 1년 금리차이며 " +
      "미래에도 그대로라고 가정합니다. 괴리 자체는 전망하지 않습니다. 따라서 첫 구간(현재~1년)은 현재 프리미엄과 정확히 같습니다. " +
      "평균 헤지 프리미엄은 위 CIP 비교와 같은 정의(HP 3M·6M·12M)입니다."),
    el("p", {}, "과거 성적은 매월 마지막 공통 관측에서 1~2년(2~3년) 구간 포워드 금리차를 12(24)개월 뒤 실제 1년 금리차와 비교한 것입니다. " +
      "비교 기준은 「1년 금리차가 지금 그대로」입니다. 편향이 양수이면 포워드가 실제보다 한국 금리를 상대적으로 높게 보았다는 뜻입니다. " +
      "월별 표본은 서로 겹쳐 독립이 아니며, 현재 자료로 다시 계산한 값이라 당시 실제로 볼 수 있던 자료와 다를 수 있습니다."),
    el("p", {}, "모든 입력이 같은 날짜에 실제로 관측된 경우만 사용하며 채우거나 보간하지 않습니다. 국채금리와 선물환 프리미엄은 상품·만기가 달라 " +
      "이 경로를 실행 가능한 헤지 호가나 차익거래 기준으로 해석할 수 없습니다.")));
}
