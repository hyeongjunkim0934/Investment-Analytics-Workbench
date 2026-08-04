/* `dashboard/app.js` 를 node 안에서 실제로 실행시키고, 동작을 측정해 JSON 으로 뱉는다.
   `tests/test_dashboard_ux.py` 가 이 파일을 실행해 결과를 검증한다.

   왜 이렇게까지 하는가: 소스 문자열만 보는 테스트는 "이름은 남고 동작만 뒤집히는"
   회귀를 못 잡는다. 이 하네스는 값을 실제로 계산시키므로, 함수 이름·주석·상수명이
   모두 그대로여도 동작이 바뀌면 빨간불이 된다.

   실행:  node tests/dashboard_probe.js
   출력:  한 줄 JSON (probe 이름 → 측정값) */

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const shim = require("./domshim.js");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "dashboard", "app.js"), "utf8");
const DOC = shim.document;

/* ---------- index.html 이 갖고 있는 뼈대 중 app.js 가 부팅 때 만지는 것만 세운다 ---------- */
function elem(tag, id, cls) {
  const n = DOC.createElement(tag);
  if (id) n.id = id;
  if (cls) n.className = cls;
  return n;
}
const header = elem("header", null, "topbar");
const main = elem("main", "main-content", "page");
const footer = elem("footer", null, "footer");
const skip = elem("a", null, "skip-link");
DOC.body.append(skip, header, main, footer);

header.append(elem("div", "meta-line"), elem("button", "theme-btn"));
const nav = elem("nav", "nav");
header.append(nav);
const gate = elem("div", "gate", "gate");
gate.append(elem("form", "gate-form"), elem("input", "gate-pw"), elem("p", "gate-err"));
DOC.body.append(gate);

const filterRow = elem("div", null, "filter-row");
const rangeGroup = elem("div", "range-group");
filterRow.append(rangeGroup);
main.append(filterRow);

/* 섹션 — SECTION_IDS 와 같은 목록. 마을 포함. */
const SECTIONS = ["overview", "risk", "events", "panel", "hedge", "alloc", "rates",
  "irs", "credit", "fx", "inflation", "acwi", "macro", "catalog"];
const secNodes = {};
SECTIONS.forEach((id) => { const n = elem("section", id, "section"); secNodes[id] = n; main.append(n); });
const village = elem("section", "village", "village");
const villageFrame = elem("div", "village-frame");
/* renderVillage()/mountVillageVideo()/playSceneTransition() 이 전부 #village-map 을
   기준으로 자기를 끼워 넣는다(`.after(v)`). 하나라도 없으면 그 자리에서 죽으므로
   이 셋이 index.html 과의 계약이다. */
villageFrame.append(elem("img", "village-map"), elem("p", "village-missing"));
village.append(villageFrame, elem("nav", "village-list"));
main.append(village);
/* index.html 에서 #detail-overlay 는 <main> 안이 아니라 <body> 직계 자식이다
   (footer 뒤). 배경 inert 판정이 이 위치에 의존하므로 실제 구조를 그대로 흉내 낸다. */
const overlayNode = elem("div", "detail-overlay");
overlayNode.hidden = true;
DOC.body.append(overlayNode);
footer.append(elem("p", "build-line"), elem("div", "build-warnings"));

/* 카탈로그 뼈대 */
const catTable = elem("table", "catalog-table");
const tbody = elem("tbody");
catTable.append(tbody);
secNodes.catalog.append(elem("input", "catalog-search"), elem("span", "catalog-count"), catTable);

/* 이벤트 뼈대 */
["events-headline", "events-filters", "events-timeline"].forEach((id) => secNodes.events.append(elem("div", id)));
secNodes.events.append(elem("details", "events-rules"));

/* 환헤지 뼈대 — index.html 의 #hedge 안 구조를 그대로 흉내 낸다.
   renderHedge() 가 만지는 컨테이너가 하나라도 없으면 그 자리에서 죽으므로,
   이 목록 자체가 index.html 과의 계약이다. */
["hedge-headline", "hedge-views", "hedge-lead", "hedge-matrix",
 "hedge-curve-card", "hedge-bt-card", "hedge-cost-card", "hedge-mtm-card"]
  .forEach((id) => secNodes.hedge.append(elem("div", id, "card")));
secNodes.hedge.append(elem("details", "hedge-method"));

/* 매크로 뼈대 */
secNodes.macro.append(elem("div", "macro-grid"));

/* ---------- app.js 를 vm 안에서 통째로 실행 ---------- */
let REDUCED = false;        // prefers-reduced-motion 스위치 (아래 sceneCycle 프로브가 쓴다)
const INTERVALS = [];       // app.js 가 건 setInterval 기록 (실제로 걸지는 않는다)
const sandbox = {
  document: DOC,
  window: null,
  localStorage: shim.localStorage,
  location: shim.location,
  console: { log() {}, warn() {}, error() {}, info() {} },
  uPlot: shim.UPlotStub,
  /* 기본은 셰이드와 같은 "항상 false" 다. reduced-motion 가드를 실제로 측정해야 하는
     프로브만 REDUCED 를 켰다 끈다 — 켠 채로 두면 앞선 프로브들의 전제가 바뀐다. */
  matchMedia: (q) => ({
    matches: REDUCED && /reduced-motion/.test(String(q)),
    addEventListener() {}, removeEventListener() {},
  }),
  getComputedStyle: shim.win.getComputedStyle,
  requestAnimationFrame: shim.win.requestAnimationFrame,
  cancelAnimationFrame: shim.win.cancelAnimationFrame,
  /* fetch 는 전부 거부시킨다 → boot() 이 "데이터를 불러오지 못했습니다" 가지로 빠져
     조기 종료한다. 렌더링은 우리가 필요한 것만 직접 호출한다. */
  fetch: () => Promise.reject(new Error("probe: no network")),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  setTimeout, clearTimeout,
  /* app.js 의 setInterval 은 마을 자동 순환 딱 하나다(grep 확인). 진짜로 걸지 않고
     (fn, ms) 를 기록만 해 둔다 — 15초를 기다리지 않고 틱 본문을 직접 돌려 보기 위해서다. */
  setInterval: (fn, ms) => { const h = { fn, ms, live: true }; INTERVALS.push(h); return h; },
  clearInterval: (h) => { if (h) h.live = false; },
  Image: class { set src(_v) { setTimeout(() => this.onerror && this.onerror(), 0); } },
  navigator: { userAgent: "probe" },
  performance: { now: () => 0 },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
Object.assign(sandbox, {
  addEventListener: shim.win.addEventListener,
  removeEventListener: shim.win.removeEventListener,
  scrollTo: shim.win.scrollTo,
  innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
});

vm.createContext(sandbox);
/* app.js 의 top-level `const`/`function` 은 스크립트 렉시컬 스코프에 산다 —
   밖에서 잡으려면 같은 스크립트 안에서 내보내야 한다. */
const EXPORTS = ["baseAxes", "stampLatest", "stampDate", "makeTimeChart", "sectionHasRangedChart",
  "routeView", "openOverlayShell", "hideDetail", "overlayBackdrop", "renderCatalog",
  "bandInk", "relLum", "deltaText", "factorRow", "renderEvents", "renderMetaLine",
  "cardScaffold", "el", "registry", "DATA", "BANDS", "SECTION_IDS", "palette",
  "renderHedge", "openHedgeSim", "hedgeRows", "hedgeCostAt", "renderMacro", "COST_SIGN_KEY",
  "SCENE_CYCLE_MS", "sceneCycleAllowed", "restartSceneCycle", "stopSceneCycle",
  "currentScene", "currentTheme", "syncThemeButton"];
vm.runInContext(`${APP}\n;globalThis.__probe = { ${EXPORTS.join(", ")} };`, sandbox,
  { filename: "dashboard/app.js" });
const P = sandbox.__probe;

const out = {};
const safe = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = { ERROR: String(e && e.stack || e) }; } };

/* ============ P1. y축 눈금 중복 해소가 실제로 값에 반영되는가 ============ */
safe("axis", () => {
  const card = P.el("div", { class: "card" });
  DOC.body.append(card);
  const box = P.cardScaffold(card, { title: "probe", sub: "%" });
  /* 「이행 경로」 실제 값역과 같은 조건: 소수 0자리로 찍으면 넷 다 "3%" 가 된다. */
  const t = [1700000000, 1700086400, 1700172800, 1700259200];
  const v = [2.60, 2.65, 2.70, 2.75];
  shim.UPlotStub.made.length = 0;
  P.makeTimeChart(box, { labels: ["x"], colors: ["#000"], data: [t, v], dec: 0, unit: "%" });
  const u = shim.UPlotStub.made[shim.UPlotStub.made.length - 1];
  const yAxis = u.opts.axes[1];
  const labels = yAxis.values(u, v);
  /* refmt 를 주지 않는 호출자는 예전과 완전히 같아야 한다 (회귀 방지). */
  const plain = P.baseAxes({ ink3: "", grid: "" }, (x) => `${Math.round(x)}%`)[1].values(u, v);
  return { labels, unique: new Set(labels).size, n: labels.length, plain, plainUnique: new Set(plain).size };
});

/* ============ P2. 기간 버튼은 효과가 있는 화면에서만 보인다 ============ */
safe("rangeGating", () => {
  P.registry.length = 0;
  const res = {};
  shim.location.hash = "#rates";
  P.routeView();
  res.noChart = filterRow.hidden;                       // 차트 없음 → 숨김이어야 한다
  const fake = shim.UPlotStub.made[0] || { root: P.el("div") };
  const chartRoot = P.el("div");
  secNodes.rates.append(chartRoot);
  P.registry.push({ u: { root: chartRoot }, isTime: true, tmin: 0, tmax: 1 });
  P.routeView();
  res.withChart = filterRow.hidden;                     // 차트 있음 → 보여야 한다
  res.helperTrue = P.sectionHasRangedChart("rates");
  res.helperFalse = P.sectionHasRangedChart("catalog");
  shim.location.hash = "#catalog";
  P.routeView();
  res.otherSection = filterRow.hidden;                  // 차트 없는 다른 화면 → 숨김
  /* 한 번에 한 섹션만 보인다 (기존 계약) */
  shim.location.hash = "#rates";
  P.routeView();
  res.visibleSections = P.SECTION_IDS.filter((id) => secNodes[id] && !secNodes[id].hidden);
  P.registry.length = 0;
  return res;
});

/* ============ P3. 드릴다운 오버레이 = 진짜 대화상자 (열림/닫힘 대칭) ============ */
safe("overlay", () => {
  const opener = P.el("a", { href: "#detail-vol" }, "여는 쪽");
  secNodes.risk.append(opener);
  opener.focus();
  const ov = DOC.getElementById("detail-overlay");
  const inner = P.openOverlayShell({ backLabel: "‹ 돌아가기", backHash: "risk", crumbTail: " / x", title: "테스트 상세" });
  const openState = {
    hidden: ov.hidden,
    role: ov.getAttribute("role"),
    ariaModal: ov.getAttribute("aria-modal"),
    ariaLabel: ov.getAttribute("aria-label"),
    inertHeader: header.inert, inertMain: main.inert, inertFooter: footer.inert,
    /* header/main/footer 만 이름으로 집으면 이 형제가 남아 Tab 이 오버레이 밖으로 샌다.
       실브라우저에서 Tab 16회 중 8회가 밖으로 나갔고 그중 하나가 이 링크였다. */
    inertSkipLink: skip.inert, inertGate: gate.inert,
    overlayItselfNotInert: DOC.getElementById("detail-overlay").inert === false,
    focusIsCloseButton: DOC.activeElement && DOC.activeElement.className === "detail-close",
    hasCloseButton: !!inner.querySelector(".detail-close"),
    closeIsButton: (inner.querySelector(".detail-close") || {}).tagName,
    backHref: (inner.querySelector("a") || {}).getAttribute && inner.querySelector("a").getAttribute("href"),
  };
  P.hideDetail();
  const closedState = {
    hidden: ov.hidden,
    role: ov.getAttribute("role"),
    ariaModal: ov.getAttribute("aria-modal"),
    inertHeader: header.inert, inertMain: main.inert, inertFooter: footer.inert,
    inertSkipLink: skip.inert, inertGate: gate.inert,
    focusRestored: DOC.activeElement === opener,
  };
  opener.remove();
  return { openState, closedState };
});

/* ============ P4. "최근 …" 은 마지막 관측치이고, 기준일보다 미래 날짜를 찍지 않는다 ====== */
safe("stamp", () => {
  const mk = (cfg, asof) => {
    P.DATA.meta = { last_observation: asof };
    const card = P.el("div", { class: "card" });
    DOC.body.append(card);
    const box = P.cardScaffold(card, { title: "t", sub: "s" });
    P.stampLatest(box, cfg);
    const n = card.querySelector(".card-last");
    return n ? n.textContent : null;
  };
  const t = [
    Math.floor(Date.parse("2026-05-31T00:00:00Z") / 1000),
    Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000),
    Math.floor(Date.parse("2026-07-31T00:00:00Z") / 1000),
  ];
  return {
    /* 마지막 값을 찍어야 한다 (첫 값 -1.11 이 아니라 -0.45) */
    lastNotFirst: mk({ data: [t, [-1.11, -0.78, -0.45]], dec: 2, unit: "%" }, "2026-12-31"),
    /* 마지막이 null 이면 그 앞의 마지막 비-null */
    skipsTrailingNull: mk({ data: [t, [-1.11, -0.78, null]], dec: 2, unit: "%" }, "2026-12-31"),
    /* 기준일(2026-07-20)보다 미래인 2026-07-31 은 "2026-07월" 로 낮춰 적는다 */
    futureDateDemoted: mk({ data: [t, [-1.11, -0.78, -0.45]], dec: 2, unit: "%" }, "2026-07-20"),
    /* 계열이 여럿이면 날짜만 */
    multiSeries: mk({ data: [t, [1, 2, 3], [4, 5, 6]], dec: 2 }, "2026-12-31"),
    stampDatePast: P.stampDate(t[0]),
  };
});

/* ============ P5. 카탈로그 검색 0건이면 안내가 뜬다 ============ */
safe("catalogEmpty", () => {
  P.DATA.catalog = { series: [
    { key: "bb:a", name: "가나다", category: "금리", source: "bb", first: "2000-01-01", last: "2026-01-01", n: 10 },
    { key: "bb:b", name: "라마바", category: "환율", source: "bb", first: "2000-01-01", last: "2026-01-01", n: 10 },
  ] };
  P.renderCatalog();
  const search = DOC.getElementById("catalog-search");
  const rowsAll = tbody.querySelectorAll("tr").length;
  search.value = "존재하지않는검색어zzz";
  search.dispatchEvent({ type: "input", target: search });
  const empty = tbody.querySelector(".cat-empty");
  return {
    rowsAll,
    emptyShown: !!empty,
    emptyText: empty ? empty.textContent.slice(0, 40) : null,
    emptyColspan: empty ? empty.getAttribute("colspan") : null,
    count: DOC.getElementById("catalog-count").textContent,
  };
});

/* ============ P6. 등급 밴드 글자색은 대비가 큰 쪽으로 계산해 고른다 ============ */
safe("bandInk", () => {
  const cr = (a, b) => {
    const L = (h) => {
      const n = parseInt(h.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const la = L(a), lb = L(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  return P.BANDS.map(([lo, hi, c, nm]) => ({
    band: nm, bg: c, ink: P.bandInk(c), contrast: +cr(P.bandInk(c), c).toFixed(3),
    whiteContrast: +cr("#ffffff", c).toFixed(3),
  }));
});

/* ============ P7. 요인 행은 진짜 링크이고, 읽히는 이름에 1개월 변화가 남아 있다 ====== */
safe("factorRow", () => {
  const f = { key: "vol", name: "변동성", sub: "시장이 얼마나 요동치나", score: 78.1,
    grade: "경계", delta: 7.8, layer: "stress", hist: { t: [1, 2], v: [70, 78] } };
  const r = { layers: { stress: { name: "스트레스" } }, asof: "2026-07-20" };
  const row = P.factorRow(f, r, 1700000000);
  const pend = P.factorRow({ ...f, pending: "데이터 대기", score: null }, r, 1700000000);
  return {
    tag: row.tagName, href: row.getAttribute("href"),
    ariaLabel: row.getAttribute("aria-label"),
    deltaTextInLabel: /상승 8p/.test(row.getAttribute("aria-label") || ""),
    visibleText: row.textContent,
    pendingTag: pend.tagName, pendingHref: pend.getAttribute("href"),
    pendingChevron: (pend.querySelector(".chev") || {}).textContent,
    activeChevron: (row.querySelector(".chev") || {}).textContent,
    deltaTexts: [P.deltaText(7.8), P.deltaText(-7.8), P.deltaText(0.2), P.deltaText(null)],
  };
});

/* ============ P8. 이벤트 필터 칩은 진짜 버튼이고 aria-pressed 를 갖는다 ============ */
safe("eventChips", () => {
  P.DATA.events = {
    asof: "2026-07-20",
    events: [{ d: "2026-07-10", cat: "금리", sev: "경계", title: "t1", body: "b1" },
             { d: "2026-07-11", cat: "환율", sev: "정보", title: "t2", body: "b2" }],
    catalog: [{ cat: "금리", rule: "r", sev: "경계" }],
  };
  P.renderEvents();
  const chips = DOC.getElementById("events-filters").children;
  const real = chips.filter((c) => c.className !== "sep");
  return {
    tags: [...new Set(real.map((c) => c.tagName))],
    types: [...new Set(real.map((c) => c.getAttribute("type")))],
    ariaPressed: real.map((c) => c.getAttribute("aria-pressed")),
    labels: real.map((c) => c.textContent),
    allHaveAriaPressed: real.every((c) => c.getAttribute("aria-pressed") !== null),
  };
});

/* ============ P9. 빌드 경고는 <p id="build-line"> 밖의 형제 컨테이너에 들어간다 ====== */
safe("footerWarnings", () => {
  P.DATA.meta = { last_observation: "2026-07-27", built_at_kst: "K", built_at_utc: "U",
    series_count: 444, files: [1, 2, 3, 4], warnings: ["w1", "w2", "w3"] };
  P.renderMetaLine();
  const bl = DOC.getElementById("build-line");
  const wb = DOC.getElementById("build-warnings");
  const det = wb.querySelector("details");
  return {
    buildLineTag: bl.tagName,
    detailsParentId: det ? det.parentElement.id : null,
    detailsParentTag: det ? det.parentElement.tagName : null,
    detailsInsideBuildLine: det ? bl.contains(det) : null,
    listItems: det ? det.querySelectorAll("li").length : 0,
    summaryText: det ? (det.querySelector("summary") || {}).textContent : null,
    buildLineText: bl.textContent,
  };
});

/* ====== P10~P13. 환헤지 — 참고치·부호·τ·만기 표기가 전부 데이터에서 나오는가 =========
   실데이터와 **일부러 다른** 값을 태운다. 화면이 숫자나 부호 방향을 문자열로 박아 두면
   (예전에 실제로 "채권 88~102% · 주식 10~30%", "2008년 최악의 달", 굵은 행 9개월이
   그랬다) 여기서 옛 숫자가 그대로 나와 잡힌다. 벤더 값은 한 톨도 들어가지 않는다. */
const HEDGE_FIXTURE = (() => {
  /* 채권 곡선: 최소가 50% 지점(index 10) · 주식 곡선: 최소가 15% 지점(index 3, 유일) */
  const bond = Array.from({ length: 21 }, (_, i) => 10 + Math.abs(i - 10) * 0.5);
  const equity = Array.from({ length: 21 }, (_, i) => 13 + Math.abs(i - 3) * 0.3);
  const mk = (y, m) => Math.floor(Date.UTC(y, m, 1) / 1000) - 86400;   // 전달 말일
  return {
    asof: "2030-01-31", default_tenor_m: 6,
    matrix: [
      { c: "USD", name: "달러", vol_e: 9.1, mvh: 71, corr: -0.4, cost_12m: -0.5,
        cost_curve: { "3M": -0.6, "6M": -0.55, "12M": -0.5 }, src: "실측(HP)",
        bond_kind: "실지수", active: true },
      { c: "JPY", name: "엔", vol_e: 12.3, mvh: 118, corr: 0.2, cost_12m: 3.25,
        cost_curve: { "3M": 3.4, "6M": 3.3, "12M": 3.25 }, src: "실측(HP)",
        bond_kind: "합성(5y 커브)", active: true },
      { c: "CNY", name: "위안", vol_e: 8.0, mvh: null, corr: null, cost_12m: null,
        cost_curve: null, src: "데이터 필요", bond_kind: null, active: false },
    ],
    curves: { bond, equity },
    backtest: { "테스트 자산": { period: "2010-01 ~ 2029-12",
      rows: [{ h: 0, cagr: 1.1, vol: 2.2, mdd: -3.3 }, { h: 50, cagr: 1.2, vol: 2.1, mdd: -3.1 },
             { h: 100, cagr: 1.3, vol: 2.0, mdd: -4.4 }] } },
    /* 최저(= 가장 많이 낸 달)는 2021-07 */
    cost_hist_usd: { t: [mk(2021, 5), mk(2021, 6), mk(2021, 7), mk(2021, 8)],
                     v: [0.5, -0.2, -5.5, 0.1] },
    cost_stats: { mean: 0.1, now: -0.2, min: -5.5 },
    mtm: { sigma_ds_3m: 0.4, worst_ds: 3.3, worst_date: "2019-03-31", corr_ds_e: -0.1 },
    sim: { labels: ["e_USD", "b_USD", "eq", "ds_USD", "e_JPY", "b_JPY"],
           cov: Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 0.01 : 0.001))),
           sample: "2010-01 ~ 2029-12", n_months: 240 },
    acct_model: ["① 유효이자 — 상수"], limits: "한계 문장",
  };
})();

safe("hedgeScreen", () => {
  P.DATA.hedge = HEDGE_FIXTURE;
  P.DATA.meta = { last_observation: "2030-01-31" };
  P.renderHedge();
  const txt = (id) => (DOC.getElementById(id) || { textContent: "" }).textContent;
  const rowsOf = (id) => DOC.getElementById(id).querySelectorAll("tr");
  const mxRows = rowsOf("hedge-matrix");
  const cell = (row, i) => row.children[i].textContent;
  const jpy = mxRows.find((r) => /엔 \(/.test(r.textContent));
  const usd = mxRows.find((r) => /달러 \(/.test(r.textContent));
  const cny = mxRows.find((r) => /위안/.test(r.textContent));
  const mtmRows = rowsOf("hedge-mtm-card");
  const boldRow = mtmRows.find((r) => /700/.test(r.getAttribute("style") || ""));
  return {
    signKey: P.COST_SIGN_KEY,
    headline: txt("hedge-headline"),
    views: txt("hedge-views"),
    lead: txt("hedge-lead"),
    matrixHeader: mxRows[0].children.map((c) => c.textContent),
    /* 부호 방향은 **글자**로 나와야 한다 — 색만으로는 전달되지 않고, 뒤집히면 여기서 잡힌다 */
    jpyCost: jpy ? cell(jpy, 4) : null,
    usdCost: usd ? cell(usd, 4) : null,
    cnyClass: cny ? cny.className : null,
    cnyStyle: cny ? cny.getAttribute("style") : null,
    cnyText: cny ? cny.textContent : null,
    curveSub: DOC.getElementById("hedge-curve-card").querySelector(".card-sub").textContent,
    costSub: DOC.getElementById("hedge-cost-card").querySelector(".card-sub").textContent,
    costNote: txt("hedge-cost-card"),
    mtmHeader: mtmRows[0].children.map((c) => c.textContent),
    /* τ 열 — 만기 ÷ 2 (년). 3/6/9/12 개월 → 0.125/0.250/0.375/0.500 */
    mtmTau: mtmRows.slice(1).map((r) => cell(r, 1)),
    mtmWorst: mtmRows.slice(1).map((r) => cell(r, 3)),
    boldRowText: boldRow ? boldRow.textContent : null,
    method: txt("hedge-method"),
    fxLinks: DOC.getElementById("hedge-matrix").querySelectorAll("a").map((a) => a.getAttribute("href")),
  };
});

/* 필수 필드가 빠진 payload 로도 "undefined" 를 화면에 찍지 않는다 */
safe("hedgeMissingFields", () => {
  const thin = JSON.parse(JSON.stringify(HEDGE_FIXTURE));
  delete thin.default_tenor_m; delete thin.curves; delete thin.mtm;
  delete thin.cost_hist_usd; delete thin.cost_stats; delete thin.backtest;
  P.DATA.hedge = thin;
  let threw = null;
  try { P.renderHedge(); } catch (e) { threw = String(e && e.message || e); }
  const all = DOC.getElementById("hedge").textContent;
  const bad = (all.match(/[^\s]{0,18}(undefined|NaN)[^\s]{0,18}/g) || []).slice(0, 6);
  P.DATA.hedge = HEDGE_FIXTURE;
  P.renderHedge();
  return { threw, hasUndefined: bad.length > 0, where: bad };
});

safe("hedgeSim", () => {
  P.DATA.hedge = HEDGE_FIXTURE;
  shim.location.hash = "#hedge-sim";
  P.openHedgeSim();
  const ov = DOC.getElementById("detail-overlay");
  const inputs = ov.querySelectorAll("input");
  const rows = P.hedgeRows(HEDGE_FIXTURE);
  const gridHead = ov.querySelector(".grid-inp").querySelectorAll("tr")[0];
  const g = (id) => { const n = DOC.getElementById(id); return n ? n.textContent : null; };
  const tenorInput = DOC.getElementById("hg-tenor");
  /* 셰이드는 `value` 를 속성으로만 들고 있어 `.value` 프로퍼티가 비어 있다.
     시뮬레이터를 실제로 굴리려면 프로퍼티를 직접 채운다 — 브라우저에서 사용자가
     타이핑한 것과 같은 상태다. 금액은 검산하기 쉬운 수로 넣는다. */
  const setv = (id, v) => { const n = DOC.getElementById(id); if (n) n.value = String(v); };
  setv("hg-a-USD_b", 4000); setv("hg-q-USD_b", 70); setv("hg-h-USD_b", 90);
  setv("hg-a-USD_e", 2000); setv("hg-h-USD_e", 30);
  setv("hg-a-JPY_b", 2000); setv("hg-q-JPY_b", 100); setv("hg-h-JPY_b", 100);
  setv("hg-a-CNY_b", 0); setv("hg-q-CNY_b", 100); setv("hg-h-CNY_b", 100);
  setv("hg-tenor", 6);
  tenorInput.dispatchEvent({ type: "input", target: tenorInput });
  const read = () => ({
    tenor: tenorInput.value,
    costHead: gridHead.children[4].textContent,
    econ: g("hg-econ"), acct: g("hg-acct"), carry: g("hg-carry"),
    econAmt: g("hg-econ-amt"), acctAmt: g("hg-acct-amt"),
    usdCost: g("hg-c-USD_b"), jpyCost: g("hg-c-JPY_b"),
    usdCarry: g("hg-k-USD_b"), span: g("hg-span"),
  });
  const atDefault = read();
  /* 만기를 바꾸면 헤지비용 열 제목·값이 함께 따라와야 한다 */
  tenorInput.value = "12";
  tenorInput.dispatchEvent({ type: "input", target: tenorInput });
  const at12 = read();
  /* 반올림이 실제로 드러나는 규모에서 한 번 더 읽는다 — 합계가 커지면 「반올림한 σ」와
     「원값 σ」의 곱이 억 단위에서 갈라진다. 화면 문구와 산식이 어긋나면 여기서 잡힌다. */
  setv("hg-tenor", 6);
  setv("hg-a-USD_b", 500000); setv("hg-a-USD_e", 250000); setv("hg-a-JPY_b", 250000);
  tenorInput.dispatchEvent({ type: "input", target: tenorInput });
  const atBig = read();
  const out = {
    total: inputs.length,
    labelled: inputs.filter((i) => (i.getAttribute("aria-label") || "").trim().length > 0).length,
    labels: inputs.map((i) => i.getAttribute("aria-label")),
    eqRef: (rows.find((r) => r.id === "USD_e") || {}).ref,
    tiles: ov.querySelectorAll(".rt").map((t) => t.querySelector(".l").textContent),
    amtLines: ov.querySelectorAll(".amt").length,
    tenorNote: ov.querySelector(".tenor-row").textContent,
    /* hedgeCostAt 의 만기 보간을 프로브가 직접 계산해 화면값과 대조한다 */
    jpyAt6: P.hedgeCostAt(HEDGE_FIXTURE.matrix[1], 6),
    jpyAt12: P.hedgeCostAt(HEDGE_FIXTURE.matrix[1], 12),
    usdAt6: P.hedgeCostAt(HEDGE_FIXTURE.matrix[0], 6),
    /* 캐리·억원 줄을 파이썬 쪽에서 독립 재계산하기 위한 입력 사본 */
    amounts: { USD_b: 4000, USD_e: 2000, JPY_b: 2000 },
    hs: { USD_b: 0.9, USD_e: 0.3, JPY_b: 1.0 },
    cov: HEDGE_FIXTURE.sim.cov, covLabels: HEDGE_FIXTURE.sim.labels,
    bigAmounts: { USD_b: 500000, USD_e: 250000, JPY_b: 250000 },
    atDefault, at12, atBig,
  };
  P.hideDetail();
  shim.location.hash = "#hedge";
  return out;
});

/* ====== P14. 매크로 카드가 파이프라인이 준 단위를 버리지 않는다 ================= */
safe("macroUnit", () => {
  P.DATA.macro = { items: [
    { key: "k1", label: "테스트 고용 MoM", unit: "천명", last: 123, date: "2030-01-31",
      t: [1700000000, 1700086400], v: [40, 123] },
    { key: "k2", label: "테스트 실업률", unit: "%", last: 4.2, date: "2030-01-31",
      t: [1700000000, 1700086400], v: [4.1, 4.2] },
  ] };
  P.renderMacro();
  const cards = DOC.getElementById("macro-grid").children;
  return { subs: cards.map((c) => c.querySelector(".card-sub").textContent) };
});

/* ====== P15. 마을 장면 15초 자동 순환 — 가드 5개와 틱 본문을 실제로 돌린다 ======
   15초를 기다리지 않는다. setInterval 을 기록만 하도록 바꿔 두었으므로 (fn, ms) 를
   꺼내 fn 을 직접 호출하면 틱 한 번이 그대로 재현된다. */
safe("sceneCycle", () => {
  const html = DOC.documentElement;
  const gate = DOC.getElementById("gate");
  const villageEl = DOC.getElementById("village");
  const frame = DOC.getElementById("village-frame");
  const map = DOC.getElementById("village-map");
  const r = {};

  /* 기본값 — bindTheme() 은 boot() 의 동기 구간에서 이미 돌았다. */
  r.cycleMs = P.SCENE_CYCLE_MS;
  r.defaultScene = html.getAttribute("data-scene");
  r.defaultThemeAttr = html.getAttribute("data-theme");   // null = 다크(속성 없음)가 기본

  /* 가드 5개(+reduced-motion). 하나씩만 어긋내고 되돌린다.
     값은 전부 "돌아도 되는가?" 의 답이다 — 정상 상태 하나만 true 여야 한다. */
  villageEl.hidden = false; gate.hidden = false; frame.clientWidth = 800;
  r.allowedWithGateOpen = P.sceneCycleAllowed();
  gate.hidden = true;
  r.allowedOnVillage = P.sceneCycleAllowed();
  villageEl.hidden = true;
  r.allowedOffVillage = P.sceneCycleAllowed();
  villageEl.hidden = false;
  DOC.visibilityState = "hidden";
  r.allowedInBackgroundTab = P.sceneCycleAllowed();
  DOC.visibilityState = "visible";
  frame.clientWidth = 0;
  r.allowedWhenNarrow = P.sceneCycleAllowed();
  frame.clientWidth = 800;
  REDUCED = true;
  r.allowedUnderReducedMotion = P.sceneCycleAllowed();
  REDUCED = false;

  /* 타이머 수명 — reduced-motion 이면 아예 걸지 않는다. */
  INTERVALS.length = 0;
  REDUCED = true; P.restartSceneCycle(); REDUCED = false;
  r.timersUnderReducedMotion = INTERVALS.length;
  P.restartSceneCycle();
  r.timerMs = INTERVALS.map((h) => h.ms);
  r.liveAfterStart = INTERVALS.filter((h) => h.live).length;
  P.restartSceneCycle();                       // 재시작은 앞의 것을 반드시 걷어낸다
  r.liveAfterRestart = INTERVALS.filter((h) => h.live).length;
  P.stopSceneCycle();
  r.liveAfterStop = INTERVALS.filter((h) => h.live).length;

  /* 마을을 떠난 뒤에도 살아남은 틱은 아무 일도 하지 않고 자기 타이머를 걷는다
     (routeView 가 못 멈춘 경우의 2차 방어선). 아래 flip 프로브보다 **먼저** 와야 한다 —
     setScene 이 sceneBusy 를 5.2초 뒤에야 푸는데 프로브는 그 전에 끝나기 때문이다. */
  INTERVALS.length = 0;
  P.restartSceneCycle();
  villageEl.hidden = true;
  const staleTick = INTERVALS[INTERVALS.length - 1].fn;
  const before = P.currentScene();
  staleTick();
  r.staleTickChangedScene = P.currentScene() !== before;
  r.staleTickClearedItself = INTERVALS.filter((h) => h.live).length === 0;
  villageEl.hidden = false;

  /* 틱 본문 — 지도를 숨겨 두면 playSceneTransition 이 영상 없이 즉시 적용한다. */
  map.hidden = true;
  INTERVALS.length = 0;
  P.restartSceneCycle();
  const tick = INTERVALS[INTERVALS.length - 1].fn;
  r.sceneBefore = P.currentScene();
  tick();
  r.sceneAfterOneTick = P.currentScene();
  r.themeUntouchedByTick = html.getAttribute("data-theme");   // 장면 축이 명암 축을 건드리면 안 된다
  /* 전환 연출이 도는 동안 다음 틱이 겹치면 data-transition 요소가 엇갈려 화면이
     얼어붙은 적이 있다 — sceneBusy 가드가 그 자리다. 지금 막 전환했으므로 켜져 있어야 한다.
     지도를 다시 숨기는 것이 이 측정의 핵심이다 — 위 틱 안의 renderVillage() 가 지도를
     되살려 놓기 때문에, 그대로 두면 playSceneTransition 이 영상 경로(비동기)로 빠져
     sceneBusy 를 없애도 장면이 안 바뀐다. 즉 가드를 지운 뮤테이션이 조용히 통과한다. */
  map.hidden = true;
  tick();
  r.sceneAfterOverlappingTick = P.currentScene();

  /* 토글 버튼의 의미 — 마을이면 장면, 섹션이면 명암 */
  const btn = DOC.getElementById("theme-btn");
  villageEl.hidden = false; P.syncThemeButton();
  r.labelOnVillage = btn.getAttribute("aria-label");
  villageEl.hidden = true; P.syncThemeButton();
  r.labelOnSection = btn.getAttribute("aria-label");

  /* routeView 훅 — 섹션으로 나가면 멈추고, 마을로 돌아오면 다시 건다.
     반드시 **마을에서 타이머가 살아 있는 상태로** 나가야 정지 훅을 측정할 수 있다.
     빈 상태에서 섹션으로 가면 정지 훅을 지워도 0 이라 뮤테이션이 통과한다. */
  map.hidden = true; gate.hidden = true; frame.clientWidth = 800;
  INTERVALS.length = 0;
  shim.location.hash = "#village"; P.routeView();
  r.liveBeforeLeaving = INTERVALS.filter((h) => h.live).length;
  shim.location.hash = "#rates"; P.routeView();
  r.liveOnSection = INTERVALS.filter((h) => h.live).length;
  shim.location.hash = "#village"; P.routeView();
  r.liveBackOnVillage = INTERVALS.filter((h) => h.live).length;
  P.stopSceneCycle();
  return r;
});

/* boot() 은 async 라 fetch 거부가 마이크로태스크로 나중에 돌아온다. 그때는 위 프로브가
   DATA 를 이미 채워 놓았기 때문에 boot 이 조기 종료 가지를 타지 않고 renderAll() 로
   들어가 버린다(뼈대에 없는 카드에서 죽는다). 측정은 전부 동기로 끝났으므로
   여기서 바로 끝낸다 — fs.writeSync 로 확실히 흘려보내고 나간다. */
fs.writeSync(1, JSON.stringify(out, null, 1));
process.exit(0);
