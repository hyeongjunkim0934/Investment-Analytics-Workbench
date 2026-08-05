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

/* 자산배분 뼈대 — renderAlloc 이 $("#alloc-…") 로 집는 자리들(index.html 과의 계약).
   하나라도 빠지면 그 자리에서 죽으므로 실제 마크업과 같은 목록을 둔다. */
["alloc-headline", "alloc-controls", "alloc-cards", "alloc-levers",
 "alloc-frontier-card", "alloc-path-card", "alloc-table-card",
 "alloc-inputs-box", "alloc-method"].forEach((id) => secNodes.alloc.append(elem("div", id)));

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
 "hedge-curve-card", "hedge-bt-card", "hedge-cost-card", "hedge-mtm-card",
 "hedge-ts-card"]
  .forEach((id) => secNodes.hedge.append(elem("div", id, "card")));
secNodes.hedge.append(elem("details", "hedge-method"));

/* ACWI 뼈대 — 시장 폭 카드 포함 */
["acwi-stats", "card-acwi-price", "card-acwi-dd", "card-breadth"]
  .forEach((id) => secNodes.acwi.append(elem("div", id, "card")));

/* 매크로 뼈대 */
secNodes.macro.append(elem("div", "macro-grid"));

/* ---------- app.js 를 vm 안에서 통째로 실행 ---------- */
let REDUCED = false;        // prefers-reduced-motion 스위치 (아래 sceneCycle 프로브가 쓴다)
const INTERVALS = [];       // app.js 가 건 setInterval 기록 (실제로 걸지는 않는다)
const FETCH_CALLS = [];     // 네트워크 호출 기록 (시뮬레이터 유출 검사용)
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
  /* 호출 **횟수**를 센다 — 시뮬레이터 입력이 브라우저 밖으로 나가지 않는다는 것을
     "코드에 fetch 가 없다"가 아니라 실행으로 확인하기 위해서다. */
  fetch: (...a) => { FETCH_CALLS.push(a[0]); return Promise.reject(new Error("probe: no network")); },
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
  /* 관문 암구호는 SHA-256(Web Crypto)으로 검증한다 — 브라우저에서는 전역이라
     여기서도 전역으로 넣어 준다(노드 22 내장, 외부 의존성 0). */
  crypto: globalThis.crypto,
  TextEncoder, TextDecoder,
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
  "currentScene", "currentTheme", "syncThemeButton",
  "RENDERERS", "renderAll", "renderSection", "renderACWI",
  "allocEngine", "allocHBands", "allocXeRange", "allocDefaults", "ALLOC_ECON",
  "allocAssetDuration", "allocDurGap", "bindGate", "sha256Hex", "GATE_SHA256"];
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
    /* 읽는 법은 파이프라인이 정한다 — 실데이터와 **일부러 다른** 라벨을 태워
       화면이 문자열을 박아 두면 여기서 옛 문구가 그대로 나와 잡히게 한다. */
    cost_read: { label: "프로브전용읽기", window: 7, asof: "2030-01-30" },
    matrix: [
      { c: "USD", name: "달러", vol_e: 9.1, mvh: 71, corr: -0.4, cost_12m: -0.5,
        cost_curve: { "3M": -0.6, "6M": -0.55, "12M": -0.5 }, src: "실측(HP)",
        bond_kind: "실지수", active: true,
        /* 두 표본이 같은 행 — 한 줄로 줄어야 한다 */
        sample: { vol: { start: "2002-01", end: "2029-12", n: 294 },
                  fit: { start: "2002-01", end: "2029-12", n: 294 } } },
      { c: "JPY", name: "엔", vol_e: 12.3, mvh: 118, corr: 0.2, cost_12m: 3.25,
        cost_curve: { "3M": 3.4, "6M": 3.3, "12M": 3.25 }, src: "실측(HP)",
        bond_kind: "합성(5y 커브)", active: true,
        /* 두 표본이 다른 행 — 둘 다 적혀야 한다(뭉뚱그리면 같은 표본으로 읽힌다) */
        sample: { vol: { start: "2001-02", end: "2029-12", n: 305 },
                  fit: { start: "2002-01", end: "2029-12", n: 294 } } },
      { c: "CNY", name: "위안", vol_e: 8.0, mvh: null, corr: null, cost_12m: null,
        cost_curve: null, src: "데이터 필요", bond_kind: null, active: false,
        /* 적합 표본이 없는 행 — 변동성만 적는다 */
        sample: { vol: { start: "2002-01", end: "2029-12", n: 294 }, fit: null } },
    ],
    curves: { bond, equity },
    backtest: { "테스트 자산": { period: "2010-01 ~ 2029-12",
      rows: [{ h: 0, cagr: 1.1, vol: 2.2, mdd: -3.3 }, { h: 50, cagr: 1.2, vol: 2.1, mdd: -3.1 },
             { h: 100, cagr: 1.3, vol: 2.0, mdd: -4.4 }] } },
    /* 최저(= 가장 많이 낸 달)는 2021-07 */
    cost_hist_usd: { t: [mk(2021, 5), mk(2021, 6), mk(2021, 7), mk(2021, 8)],
                     v: [0.5, -0.2, -5.5, 0.1] },
    /* FX 화면에서 이관된 일별 커브 — 세 계열이 서로 다른 값이어야 흡수 검사가 의미 있다 */
    cost_hist_curve: {
      "3M":  { t: [mk(2029, 10), mk(2029, 11)], v: [-0.61, -0.60] },
      "6M":  { t: [mk(2029, 10), mk(2029, 11)], v: [-0.56, -0.55] },
      "12M": { t: [mk(2029, 10), mk(2029, 11)], v: [-0.51, -0.50] },
    },
    /* 표본 길이·계열명도 payload 에서 온다 — 실데이터(25.2년 · 303개월)와 **일부러
       다른** 수를 태워, 화면이 「25년 평균」처럼 박아 두면 여기서 잡히게 한다. */
    cost_stats: { mean: 0.1, now: -0.2, min: -5.5, series: "프로브전용계열",
                  start: "2027-01", end: "2029-12", n_months: 36, years: 3.0 },
    mtm: { sigma_ds_3m: 0.4, worst_ds: 3.3, worst_date: "2019-03-31", corr_ds_e: -0.1,
           series: "프로브전용MTM계열", start: "2027-02", end: "2029-12", n_months: 35 },
    sim: { labels: ["e_USD", "b_USD", "eq", "ds_USD", "e_JPY", "b_JPY"],
           cov: Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 0.01 : 0.001))),
           sample: "2010-01 ~ 2029-12", n_months: 240 },
    acct_model: ["① 유효이자 — 상수"], limits: "한계 문장",
  };
})();

safe("hedgeScreen", () => {
  shim.UPlotStub.made.length = 0;          // 이 렌더에서 만들어진 차트만 본다
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
  /* 헤더 텍스트에 이름이 들어 있는 열을 찾아 그 행의 같은 위치를 돌려준다. */
  const heads = mxRows[0].children.map((c) => c.textContent);
  const col = (row, name) => {
    if (!row) return null;
    const i = heads.findIndex((h) => h.includes(name));
    return i < 0 ? `열없음:${name}` : row.children[i].textContent;
  };
  const mtmRows = rowsOf("hedge-mtm-card");
  const boldRow = mtmRows.find((r) => /700/.test(r.getAttribute("style") || ""));
  return {
    signKey: P.COST_SIGN_KEY,
    headline: txt("hedge-headline"),
    views: txt("hedge-views"),
    lead: txt("hedge-lead"),
    matrixHeader: mxRows[0].children.map((c) => c.textContent),
    matrixSub: DOC.getElementById("hedge-matrix").querySelector(".card-sub").textContent,
    matrixCosts: HEDGE_FIXTURE.matrix.map((m) => ({ name: m.name, cost: m.cost_12m })),
    /* 부호 방향은 **글자**로 나와야 한다 — 색만으로는 전달되지 않고, 뒤집히면 여기서 잡힌다.
       열은 인덱스가 아니라 **헤더 이름**으로 집는다 — 예전에는 `cell(row, 4)` 라
       3·6개월 열을 흡수하자 조용히 다른 열을 재고 있었다. */
    jpyCost: col(jpy, "12개월"), usdCost: col(usd, "12개월"),
    jpyCost3m: col(jpy, "헤지비용 3개월"), jpyCost6m: col(jpy, "6개월"),
    cnyCost3m: col(cny, "헤지비용 3개월"),
    usdSample: col(usd, "표본"), jpySample: col(jpy, "표본"), cnySample: col(cny, "표본"),
    tsCardText: txt("hedge-ts-card"),
    tsCardSeries: DOC.getElementById("hedge-ts-card")
      .querySelectorAll(".legend-item, .chart-legend span").map((n) => n.textContent),
    cnyClass: cny ? cny.className : null,
    cnyStyle: cny ? cny.getAttribute("style") : null,
    cnyText: cny ? cny.textContent : null,
    curveSub: DOC.getElementById("hedge-curve-card").querySelector(".card-sub").textContent,
    costSub: DOC.getElementById("hedge-cost-card").querySelector(".card-sub").textContent,
    mtmSub: DOC.getElementById("hedge-mtm-card").querySelector(".card-sub").textContent,
    /* 차트에 **실제로 그려진 계열**. 설명 문장만 보면 "겹쳐 그렸다"고 적어 두고
       그리지 않는 변경이 통과한다 — uPlot 에 넘어간 series 를 직접 센다. */
    chartSeries: shim.UPlotStub.made.map((u) => ({
      title: (u.opts && u.opts.title) || "",
      labels: ((u.opts && u.opts.series) || []).slice(1).map((sr) => sr.label),
      rows: (u.data && u.data[0] && u.data[0].length) || 0,
    })),
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
  const rows = P.hedgeRows(HEDGE_FIXTURE, {});
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
    /* E-6 — 부호를 **문자열 존재**가 아니라 **계산된 값과의 대응**으로 본다.
       화면에 찍힌 부호 문자와, 같은 입력에서 산식이 내는 부호가 일치해야 한다.
       이 저장소는 부호 반전으로 최악월을 1.8배 과소 발표한 전력이 있다. */
    perRow: Object.fromEntries(["USD_b", "USD_e", "JPY_b"].map((id) => {
      const amt = +(DOC.getElementById(`hg-a-${id}`) || {}).value || 0;
      const h = +(DOC.getElementById(`hg-h-${id}`) || {}).value || 0;
      const cur = id.split("_")[0];
      const m = HEDGE_FIXTURE.matrix.find((x) => x.c === cur);
      const cost = P.hedgeCostAt(m, +tenorInput.value || 6);
      return [id, {
        shown: g(`hg-k-${id}`),
        costShown: g(`hg-c-${id}`),
        // 캐리 = 금액 × 헤지비율 × 헤지비용 (hedge.py 회계모형 ④ 와 같은 식)
        expect: amt * (h / 100) * cost / 100,
        expectCost: cost,
      }];
    })),
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
    tenorNote: ov.querySelectorAll(".tenor-row").filter((n) => !n.classList.contains("aum-row"))[0].textContent,
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

/* ====== P17. 시뮬레이터 금액의 출처 3단 + 비공개 정보 유출 없음 (지시 3) ======
   ① 표 직접 입력 ② 총자산 × 자산배분 비중 ③ 예시값. 배지와 실제 쓰인 값의 출처가
   어긋나면 배지가 거짓말이 된다 — 그 대응을 값으로 확인한다. */
safe("hedgeAmounts", () => {
  const r = {};
  const store = shim.localStorage;
  const wrote = [];
  const realSet = store.setItem;
  store.setItem = (k, v) => { wrote.push(k); return realSet(k, v); };
  const fetchesBefore = FETCH_CALLS.length;

  /* ③ 예시값 — 총자산도 자산배분 저장값도 없을 때 */
  store.removeItem("iaw-alloc");
  const sample = P.hedgeRows(HEDGE_FIXTURE, {});
  const pick = (rows, id) => rows.find((x) => x.id === id) || {};
  r.sampleUsdB = pick(sample, "USD_b").amt;
  r.sampleUsdBSrc = pick(sample, "USD_b").src;
  r.sampleUsdE = pick(sample, "USD_e").amt;

  /* 총자산만 있고 자산배분 저장값이 없으면 여전히 예시값이어야 한다 */
  r.aumOnlySrc = pick(P.hedgeRows(HEDGE_FIXTURE, { total_aum: 20000 }), "USD_b").src;

  /* ② 유도 — 자산배분 화면이 저장해 둔 비중을 읽는다(쓰지는 않는다) */
  realSet("iaw-alloc", JSON.stringify({ mix_acct: {
    "장부가 해외채권": 12, "시가 해외채권": 6, "해외주식": 5 } }));
  const derived = P.hedgeRows(HEDGE_FIXTURE, { total_aum: 20000 });
  r.derivedUsdB = pick(derived, "USD_b").amt;        // 20000 × (12+6)/100 = 3600
  r.derivedUsdBSrc = pick(derived, "USD_b").src;
  r.derivedUsdE = pick(derived, "USD_e").amt;        // 20000 × 5/100 = 1000
  r.derivedUsdESrc = pick(derived, "USD_e").src;
  /* 통화 구성 정보가 없는 통화는 유도하지 않는다 */
  r.jpyAmt = pick(derived, "JPY_b").amt;
  r.jpySrc = pick(derived, "JPY_b").src;

  /* 시뮬레이터를 실제로 굴렸을 때 — 저장은 hedge 키에만, 네트워크는 0 */
  P.DATA.hedge = HEDGE_FIXTURE;
  shim.location.hash = "#hedge-sim";
  store.removeItem("iaw-hedge-input");     // 앞 프로브가 남긴 상태를 지운다
  wrote.length = 0;
  P.openHedgeSim();
  /* **최초 렌더 시점의 배지**. 총자산을 아직 안 넣었으므로 예시값이어야 한다.
     이 측정이 없으면 "배지를 항상 「우리 값」으로" 같은 뮤테이션이 통과한다 —
     총자산 입력 뒤의 배지만 보면 그 경로는 별도 리스너가 다시 쓰기 때문이다. */
  r.badgeAtOpen = (DOC.getElementById("hg-s-USD_b") || {}).textContent;
  r.badgeAtOpenJpy = (DOC.getElementById("hg-s-JPY_b") || {}).textContent;
  const aum = DOC.getElementById("hg-aum");
  aum.value = "20000";
  aum.dispatchEvent({ type: "input", target: aum });
  r.aumInputExists = !!aum;
  r.aumHasLabel = !!(aum && aum.getAttribute("aria-label"));
  r.rowAmtAfterAum = DOC.getElementById("hg-a-USD_b").value;
  r.badgeAfterAum = (DOC.getElementById("hg-s-USD_b") || {}).textContent;
  /* 직접 고치면 배지가 「우리 값」으로 바뀐다 */
  const cell = DOC.getElementById("hg-a-USD_b");
  cell.value = "7777";
  cell.dispatchEvent({ type: "input", target: cell });
  r.badgeAfterEdit = (DOC.getElementById("hg-s-USD_b") || {}).textContent;

  r.storageKeysWritten = Array.from(new Set(wrote));
  r.wroteAllocStore = wrote.includes("iaw-alloc");
  r.savedTotalAum = JSON.parse(store.getItem("iaw-hedge-input") || "{}").total_aum;
  r.fetchCalls = FETCH_CALLS.length - fetchesBefore;
  r.hashHasNoNumbers = !/\d{3,}/.test(shim.location.hash);
  store.setItem = realSet;
  return r;
});

/* ====== P18. 미국 시장 폭 카드 — 관측 1일이면 차트를 그리지 않는다 ==========
   점 하나짜리 차트는 정보가 0인데 "이력이 있다"고 읽힌다. 그 구분이 이 카드의
   전부라 값으로 확인한다. 판정 문구도 **두 수의 대소**에서 나와야 한다. */
safe("breadth", () => {
  const r = {};
  const card = DOC.getElementById("card-breadth");
  const mk = (n) => ({
    asof: "2030-05-17", n, src: "합성 출처",
    rows: [
      { key: "ad_ratio", label: "상승/하락 종목수 비율", unit: "배", note: "합성",
        last: 3.0, date: "2030-05-17", n },
      { key: "net_new_high", label: "52주 신고가권 − 신저가권", unit: "종목",
        note: "합성", last: -300, date: "2030-05-17", n },
      { key: "net_new_high_pct", label: "신고가권 − 신저가권 (전체 대비)", unit: "%",
        note: "합성", last: -7.5, date: "2030-05-17", n },
      { key: "skew_sp500", label: "S&P500 쏠림", unit: "%p", note: "합성",
        last: 0.5, date: "2030-05-17", n },
    ],
    ts: n >= 2 ? {
      ad_ratio: { t: [1900000000, 1900086400], v: [2.0, 3.0] },
      net_new_high_pct: { t: [1900000000, 1900086400], v: [-5, -7.5] },
    } : {},
  });

  /* 관측 1일 */
  shim.UPlotStub.made.length = 0;
  P.DATA.acwi = { breadth: mk(1) };
  P.renderACWI();
  r.oneDayText = card.textContent;
  r.oneDayCharts = shim.UPlotStub.made.length;
  r.oneDaySaysSoManyDays = card.textContent.includes("관측 1일");
  r.oneDaySaysItIsOneDayOnly = card.textContent.includes("아직 하루치");
  /* 판정은 두 수의 대소에서 나온다 — 상승 우세(3.0배)인데 신고가−신저가가 음수 */
  r.verdictOnDivergence = card.textContent.includes("겉은 상승, 속은 갈라짐");

  /* 이력 2일 */
  shim.UPlotStub.made.length = 0;
  P.DATA.acwi = { breadth: mk(2) };
  P.renderACWI();
  r.twoDayCharts = shim.UPlotStub.made.length;
  r.twoDaySeries = shim.UPlotStub.made.map((u) =>
    ((u.opts && u.opts.series) || []).slice(1).map((x) => x.label));
  /* rows 에 없는 키는 그리지 않는다 — 범례에 내부 키가 찍히는 것을 막는다 */
  shim.UPlotStub.made.length = 0;
  const orphan = mk(2);
  orphan.rows = orphan.rows.filter((x) => x.key !== "net_new_high_pct");
  P.DATA.acwi = { breadth: orphan };
  P.renderACWI();
  r.orphanSeries = shim.UPlotStub.made.map((u) =>
    ((u.opts && u.opts.series) || []).slice(1).map((x) => x.label));
  r.twoDayStillSaysOneDayOnly = card.textContent.includes("아직 하루치");

  /* 판정이 데이터 따라 뒤집히는가 — 같은 화면 코드로 반대 상황 */
  const wide = mk(1);
  wide.rows[1].last = 120;                    // 신고가 − 신저가 양수
  P.DATA.acwi = { breadth: wide };
  P.renderACWI();
  r.verdictOnBroadRally = card.textContent.includes("넓은 상승");

  /* payload 가 없으면 카드를 숨긴다 — 빈 카드는 고장으로 읽힌다 */
  P.DATA.acwi = {};
  P.renderACWI();
  r.hiddenWhenAbsent = card.hidden === true;
  return r;
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

/* ====== P16. 렌더 격리 — 렌더러 하나가 던져도 뒤 섹션이 그려지는가 ============
   SECTION_IDS 순서상 macro 가 catalog 보다 **앞**이다. 예전 renderAll 은 호출을
   나열했으므로 macro 에서 던지면 catalog 는 영영 안 그려졌다. */
safe("renderIsolation", () => {
  const r = {};
  P.DATA.macro = { items: [{ key: "k", label: "격리 테스트", unit: "%", last: 1,
    date: "2030-01-31", t: [1700000000], v: [1] }] };
  P.DATA.catalog = { series: [
    { key: "bb:격리", source: "bb", category: "테스트", start: "2020-01-01",
      end: "2030-01-01", n: 10 },
  ] };
  const real = P.RENDERERS.macro;
  P.RENDERERS.macro = () => { throw new Error("probe: 일부러 던진다"); };
  P.renderAll();
  P.RENDERERS.macro = real;

  const macro = DOC.getElementById("macro");
  const notes = macro.querySelectorAll(".render-error");
  r.failedSectionIsMarked = notes.length === 1;
  r.noticeMentionsTheSection = notes.length ? notes[0].textContent.includes("macro") : false;
  r.noticeSaysOthersAreFine = notes.length ? notes[0].textContent.includes("다른 화면은 정상") : false;
  /* macro 뒤에 오는 catalog 가 그려졌는가 — 이것이 격리의 전부다. */
  r.laterSectionStillRendered =
    DOC.getElementById("catalog-table").querySelectorAll("tr").length > 0;
  /* 두 번 던져도 안내가 겹쳐 쌓이지 않는다 */
  P.RENDERERS.macro = () => { throw new Error("probe: 또 던진다"); };
  P.renderSection("macro");
  P.RENDERERS.macro = real;
  r.noticeNotDuplicated = macro.querySelectorAll(".render-error").length === 1;
  return r;
});

/* ====== P17. 헤지 레버의 자유도는 실질 1개(Xe)인가 =========================
   화면이 "최적 헤지비율 (35%, 100%)" 처럼 한 점을 적던 시절, 그 점은 무한한 동점
   중 격자 스캔 순서가 고른 구석이었고 하필 가장 반직관적인 값이 나왔다. 아래는
   ① 붕괴가 실제로 성립하는지 ② 폐형 최소가 진짜 최소인지 ③ 대표점 규칙이
   현재값 최근접인지 ④ 회계 관점에서 가드가 실제로 막는지를 **실행으로** 잰다. */
const ALLOC_FIXTURE = (() => {
  const L = ["kr_bond", "us_bond", "kospi", "acwi", "spx", "alt", "cash", "e_usd", "swap", "d_swap"];
  /* 대각 + 몇 개의 실제 공분산. 해외주식↔달러원은 **음(−)** 으로 둔다(자연헤지). */
  const sd = { kr_bond: 0.038, us_bond: 0.043, kospi: 0.223, acwi: 0.161, spx: 0.155,
               alt: 0.010, cash: 0.001, e_usd: 0.113, swap: 0.005, d_swap: 0.004 };
  const rho = { "acwi|e_usd": -0.63, "spx|e_usd": -0.54, "us_bond|e_usd": -0.31,
                "kospi|e_usd": -0.44, "kr_bond|e_usd": -0.28, "acwi|kospi": 0.62,
                "acwi|spx": 0.95, "swap|d_swap": 0.30, "us_bond|kr_bond": 0.45 };
  const cov = L.map((a) => L.map((b) => {
    if (a === b) return sd[a] * sd[a];
    const r = rho[`${a}|${b}`] != null ? rho[`${a}|${b}`] : (rho[`${b}|${a}`] || 0);
    return r * sd[a] * sd[b];
  }));
  return {
    asof: "2030-06-30",
    sources: { labels: L, desc: {} },
    sets: [{ key: "full", label: "공통 표본 전체", cov, n_months: 234 },
           { key: "y2015", label: "2015년 이후", cov, n_months: 138 }],
    rates: { kr3m: { v: 3.0 }, kr5y: { v: 3.6 }, us3m: { v: 4.2 },
             us_ytm: { v: 4.8 }, cpi: { v: 2.0 } },
    cost_options: [{ key: "hp", label: "실측 HP", v: -0.8, src: "probe",
                     curve: { "3M": -0.9, "6M": -0.85, "12M": -0.7 } }],
    anchor_ref: {},
    defaults: {
      mix: { 국내채권: 42, 해외채권: 18, 국내주식: 3, 해외주식: 5, 대체투자: 15, 단기자금: 5 },
      bands: { 국내채권: [20, 55], 해외채권: [0, 30], 국내주식: [0, 10],
               해외주식: [0, 15], 대체투자: [5, 25], 단기자금: [2, 15] },
      mix_acct: { "장부가 국내채권": 30, "시가 국내채권": 12, "장부가 해외채권": 12,
                  "시가 해외채권": 6, 국내주식: 3, 해외주식: 5, 대체투자: 15, 단기자금: 5 },
      bands_acct: { "장부가 국내채권": [15, 45], "시가 국내채권": [0, 25],
                    "장부가 해외채권": [0, 25], "시가 해외채권": [0, 20],
                    국내주식: [0, 10], 해외주식: [0, 15], 대체투자: [5, 25], 단기자금: [2, 15] },
      loan_w: 12, loan_y: 4, alt_alpha: 3, alt_vol: 8, tenor_m: 9,
      h_bond: 90, h_eq: 90,
      h_bands: { 해외채권: [0, 100], 해외주식: [0, 100] },
      h_tol_hi: { 해외채권: null, 해외주식: null },
      start_key: "full", proxy: "acwi", cost_key: "hp", block_len: 24,
    },
    boot: { rows: [], note: "probe" }, checks: {}, acct_model: [], limits: "probe",
  };
})();

safe("hedgeXe", () => {
  const r = {};
  const A = ALLOC_FIXTURE;
  const st = P.allocDefaults(A);
  const E = P.allocEngine(A, st);
  const q = E.xeQuad();

  /* ① 3점 적합이 sigmaHedge 를 그대로 재현하는가 — 계수를 손으로 다시 쓰지 않았다는 증거 */
  let worst = 0;
  for (let hb = 0; hb <= 1.0001; hb += 0.1) {
    for (let he = 0; he <= 1.0001; he += 0.1) {
      const d = Math.abs(E.sigmaXe(E.xeOf(hb, he), q) - E.sigmaHedge(hb, he));
      if (d > worst) worst = d;
    }
  }
  r.quadFitMaxErr = worst;

  /* ② 붕괴 — 같은 Xe 면 위험이 **정확히** 같은가 */
  const wb = E.w0[1], we = E.w0[3];
  const target = E.xeOf(0.35, 1.0);
  const ring = [];
  for (let hb = 0; hb <= 1.0001; hb += 0.05) {
    const he = 1 - (target - wb * (1 - hb)) / we;
    if (he < -1e-9 || he > 1 + 1e-9) continue;
    ring.push(E.sigmaHedge(hb, he));
  }
  r.tieCount = ring.length;
  r.tieSpread = ring.length ? Math.max(...ring) - Math.min(...ring) : -1;

  /* ③ 폐형 최소가 격자 전수보다 낮은가 */
  const xeFree = E.xeStar(null, null, q);
  const sFree = E.sigmaXe(xeFree, q);
  let gridMin = Infinity;
  for (let hb = 0; hb <= 1.0001; hb += 0.05) {
    for (let he = 0; he <= 1.0001; he += 0.05) gridMin = Math.min(gridMin, E.sigmaHedge(hb, he));
  }
  r.closedFormBeatsGrid = sFree <= gridMin + 1e-12;
  r.xeStarPct = xeFree * 100;

  /* ④ 자연헤지 부호 — 해외주식만 담았을 때 최소점이 '거의 오픈' 쪽인가 */
  const stEq = { ...st, mix_acct: { "장부가 국내채권": 0, "시가 국내채권": 0,
    "장부가 해외채권": 0, "시가 해외채권": 0, 국내주식: 0, 해외주식: 100,
    대체투자: 0, 단기자금: 0 } };
  const Eq = P.allocEngine(A, stEq);
  const xeEq = Eq.xeStar(null, null, Eq.xeQuad());
  r.equityOnlyHedgePct = 100 - xeEq * 100;     // Xe=w(1−h), w=1 → h = 1−Xe
  r.equityFullHedgeIsWorse = Eq.sigmaHedge(0, 1) > Eq.sigmaHedge(0, 0);

  /* ⑤ 대표점 — 목표 Xe 를 만들고, 밴드 안이고, 현재값에 가장 가깝다 */
  const bandsFree = [[0, 1], [0, 1]];
  const cur = [0.98, 0.0];
  const pair = E.hedgePairForXe(target, cur, bandsFree);
  r.pairKeepsXe = Math.abs(E.xeOf(pair[0], pair[1]) - target) < 1e-12;
  const dPair = (pair[0] - cur[0]) ** 2 + (pair[1] - cur[1]) ** 2;
  let closest = true;
  for (let hb = 0; hb <= 1.0001; hb += 0.005) {
    const he = 1 - (target - wb * (1 - hb)) / we;
    if (he < 0 || he > 1) continue;
    if ((hb - cur[0]) ** 2 + (he - cur[1]) ** 2 < dPair - 1e-12) closest = false;
  }
  r.pairIsClosest = closest;
  /* 현재값이 이미 그 Xe 위면 움직이지 않는다 */
  const same = E.hedgePairForXe(E.xeOf(cur[0], cur[1]), cur, bandsFree);
  r.pairStaysPutWhenAlreadyOnTarget =
    Math.abs(same[0] - cur[0]) < 1e-12 && Math.abs(same[1] - cur[1]) < 1e-12;

  /* ⑥ 밴드 — 자르고, 불가능하면 null 로 알린다 */
  const stB = { ...st, h_bands: { 해외채권: [70, 100], 해외주식: [0, 20] } };
  const EB = P.allocEngine(A, stB);
  const hb2 = P.allocHBands(stB);
  r.bandsRead = hb2;
  const [xeLo, xeHi] = P.allocXeRange(EB, hb2);
  const xeBand = EB.xeStar(xeLo, xeHi, EB.xeQuad());
  r.bandClips = xeBand >= xeLo - 1e-12 && xeBand <= xeHi + 1e-12;
  r.bandActuallyBinds = Math.abs(xeBand - xeFree) > 1e-9;
  r.infeasibleReturnsNull = EB.hedgePairForXe(xeHi + 0.01, cur, hb2) === null;
  /* 기본값은 **중립**이어야 한다 — 기관 내규를 코드에 박지 않았다는 계약 */
  r.defaultBandsAreNeutral = JSON.stringify(P.allocHBands(st)) === JSON.stringify([[0, 1], [0, 1]]);

  /* ⑦ 회계 관점 가드가 주석이 아니라 실제로 막는가 */
  const EA = P.allocEngine(A, { ...st, view: "acct" });
  let threw = false;
  try { EA.xeQuad(); } catch (e) { threw = /경제 관점 전용/.test(String(e.message)); }
  r.acctViewGuardThrows = threw;
  return r;
});

/* ====== P18. 레버 문구가 실제로 렌더되는가 (DOM 경로) ======================
   위 P17 은 엔진만 본다. 화면에 나가는 문장은 별도 경로이며, 여기서 실제로
   #alloc 을 그려 그 문단을 읽는다 — "최적 헤지비율 한 점"이 되살아나면 잡힌다. */
safe("hedgeLeverText", () => {
  const r = {};
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const box = DOC.getElementById("alloc-levers");
  const txt = box ? box.textContent : "";
  r.rendered = txt.length > 0;
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.mentionsXe = /총 미헤지 환노출/.test(txt);
  r.saysRiskIsOneAxis = /헤지비율 2개가 아니라/.test(txt);
  r.saysTiesAreEqual = /위험이 정확히 같습니다/.test(txt);
  r.labelsPairAsRepresentative = /대표점/.test(txt);
  /* 되살아나면 안 되는 옛 문구 */
  r.noFlatnessThreshold = !/사실상 평평합니다/.test(txt);
  /* 밴드를 걸면 경고가 붙는가 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({
    saved: true, h_bands: { 해외채권: [70, 100], 해외주식: [0, 20] } }));
  P.renderSection("alloc");
  const txt2 = DOC.getElementById("alloc-levers").textContent;
  r.warnsWhenBandBinds = /밴드가 물고 있습니다/.test(txt2);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P19. ALM 듀레이션 갭 — 제약이 아니라 **결과 표시**인가 ==============
   내규 한도가 없으므로 최적화 제약으로 걸지 않는다(허용 괴리폭을 지어내면 자의성
   금지 위반). 대신 자산군별 듀레이션에서 자산 듀레이션을 **계산**해 배분을 바꾸면
   갭이 따라 움직여야 한다 — 수기 dur_asset 만 쓰던 예전에는 움직이지 않았다. */
safe("durationGap", () => {
  const r = {};
  const A = ALLOC_FIXTURE;
  const st = P.allocDefaults(A);
  const w = P.ALLOC_ECON.map((k) => (A.defaults.mix[k] || 0) / 100);

  /* 입력이 없으면 계산하지 않는다 — 0 을 만들어내지 않는다 */
  r.nullWithoutInputs = P.allocAssetDuration(st, w) === null;

  const st2 = { ...st, dur_by: { 국내채권: 4.5, 해외채권: 6.0, 단기자금: 0.25 },
                dur_liab: 9.0, la_ratio: 0.9 };
  const d = P.allocAssetDuration(st2, w);
  /* 손으로 재계산: 0.42×4.5 + 0.18×6.0 + 0.05×0.25 (주식·대체는 0) */
  r.assetDuration = d;
  r.assetDurationHand = 0.42 * 4.5 + 0.18 * 6.0 + 0.05 * 0.25;
  r.gap = P.allocDurGap(st2, d);
  r.gapHand = d - 0.9 * 9.0;

  /* 배분을 채권 쪽으로 옮기면 자산 듀레이션이 **늘어야** 한다 */
  const wLong = P.ALLOC_ECON.map((k) => (k === "국내채권" ? 0.62 : k === "해외주식" ? 0 : (A.defaults.mix[k] || 0) / 100));
  r.movesWithAllocation = P.allocAssetDuration(st2, wLong) > d;

  /* 주식·대체는 듀레이션 0 — 주식만 담은 배분의 자산 듀레이션은 0 */
  const wEq = P.ALLOC_ECON.map((k) => (k === "해외주식" ? 1 : 0));
  r.equityHasNoDuration = P.allocAssetDuration(st2, wEq) === 0;

  /* 해외채권을 0 으로 두면 그만큼만 빠진다(사용자가 위험요인을 분리할 수 있는 길) */
  const stNoFx = { ...st2, dur_by: { ...st2.dur_by, 해외채권: 0 } };
  r.foreignCanBeExcluded = Math.abs((d - P.allocAssetDuration(stNoFx, w)) - 0.18 * 6.0) < 1e-12;

  /* 부채 입력이 없으면 갭도 없다 */
  r.gapNullWithoutLiability = P.allocDurGap({ ...st2, dur_liab: null }, d) === null;

  /* 화면 — 경제 관점 카드에 갭이 붙고, **제약이 아님**을 명시하는가 */
  P.DATA.alloc = A;
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    dur_by: { 국내채권: 4.5, 해외채권: 6.0, 단기자금: 0.25 }, dur_liab: 9.0, la_ratio: 0.9 }));
  P.renderSection("alloc");
  const cards = DOC.getElementById("alloc-cards").textContent;
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.cardShown = /ALM 듀레이션 갭/.test(cards);
  r.saysNotAConstraint = /최적화 제약이 아니라 결과 표시입니다/.test(cards);
  r.showsReferenceGaps = /① 참고치/.test(cards);
  /* 옛 저장 상태(신규 키 없음)로도 죽지 않는가 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, h_bond: 90 }));
  P.renderSection("alloc");
  r.survivesLegacyState = DOC.getElementById("alloc").querySelectorAll(".render-error").length === 0;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20. 관문 — **접속할 때마다** 묻는가 ================================
   예전에는 통과 사실을 localStorage 에 영구 저장해 처음 한 번만 물었다. 사용자
   지시로 매 접속마다 묻도록 바꿨으므로, "저장하지 않는다"와 "옛 키를 지운다"가
   문구가 아니라 동작으로 지켜지는지 실행해서 확인한다. 암구호 검증은 async 다. */
const safeAsync = async (name, fn) => {
  try { out[name] = await fn(); } catch (e) { out[name] = { ERROR: String(e && e.stack || e) }; }
};

/* 제출 핸들러는 async 다(crypto.subtle.digest). setTimeout 한 번으로는 끝났다는 보장이
   없어 실제로 **간헐적으로 빈 값을 읽었다** — 판정이 DOM 에 반영될 때까지 기다린다.
   상한을 둬서 영영 안 끝나면 그대로 실패로 드러나게 한다(조용히 통과시키지 않는다). */
const settled = async (pred, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return false;
};
const submitGate = async (pw) => {
  const err = DOC.getElementById("gate-err");
  const gate = DOC.getElementById("gate");
  err.textContent = "";
  err.hidden = true;
  const before = gate.hidden;
  DOC.getElementById("gate-pw").value = pw;
  const form = DOC.getElementById("gate-form");
  form.dispatchEvent({ type: "submit", preventDefault() {}, target: form });
  /* 결과는 둘 중 하나다: 관문이 닫히거나(통과) 오류 문구가 뜨거나(거부) */
  return settled(() => gate.hidden !== before || err.hidden === false);
};

(async () => {
  /* **await 하는 순간 boot() 의 뒷부분이 이어서 돈다.** 지금까지는 마지막 write 가
     동기라 boot 을 앞질렀는데, 여기서 처음으로 마이크로태스크를 양보하기 때문이다.
     boot 은 renderMetaLine() 을 먼저 부르고 그건 renderSection 의 try/catch 밖이라,
     meta 가 없으면 프로브가 통째로 죽는다. 측정 대상이 아니므로 형태만 맞춰 둔다. */
  P.DATA.meta = { last_observation: "2030-06-30", built_at_kst: "2030-07-01 09:00 KST",
                  built_at_utc: "2030-07-01T00:00:00Z", series_count: 456,
                  files: [], warnings: [] };
  await safeAsync("passGate", async () => {
    const r = {};
    const store = shim.localStorage;
    /* 예전 버전이 남긴 '기억' 키를 심어 둔다 — 그래도 관문이 떠야 한다 */
    store.setItem("iaw-gate", "1");
    const gate = DOC.getElementById("gate");
    gate.hidden = true;
    P.bindGate();
    r.shownEvenWithLegacyKey = gate.hidden === false;
    r.legacyKeyCleared = store.getItem("iaw-gate") == null;

    /* 해시가 알려진 값과 맞는가 (구현이 SHA-256 인지 직접 확인) */
    r.sha256Known = await P.sha256Hex("abc");
    r.sha256Expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    /* 32bit 해시(FNV-1a)로 되돌아가지 않았는가 — 길이로 바로 드러난다 */
    r.hashIsWide = typeof P.GATE_SHA256 === "string" && P.GATE_SHA256.length === 64;

    r.wrongSettled = await submitGate("wrong-passphrase");
    r.blockedOnWrong = gate.hidden === false;
    r.errShown = DOC.getElementById("gate-err").hidden === false;
    r.errText = DOC.getElementById("gate-err").textContent;

    /* 공백이 든 암구호다 — 앞뒤·연속 공백은 오타로 보고 접는지 함께 확인한다 */
    r.sloppySettled = await submitGate("  postal   village  ");
    r.opensOnSloppyWhitespace = gate.hidden === true;
    gate.hidden = false;
    r.rightSettled = await submitGate("postal village");
    r.opensOnRight = gate.hidden === true;
    gate.hidden = false;
    await submitGate("Postal Village");
    r.caseStillMatters = gate.hidden === false;
    gate.hidden = true;
    /* 통과해도 아무것도 저장하지 않는다 — 이것이 "접속할 때마다"의 실체다 */
    r.nothingRemembered = store.getItem("iaw-gate") == null;
    return r;
  });

  /* boot() 은 async 라 fetch 거부가 마이크로태스크로 나중에 돌아온다. 그때는 위 프로브가
     DATA 를 이미 채워 놓았기 때문에 boot 이 조기 종료 가지를 타지 않고 renderAll() 로
     들어가 버린다(뼈대에 없는 카드에서 죽는다). 측정이 끝났으므로 여기서 바로 끝낸다
     — fs.writeSync 로 확실히 흘려보내고 나간다. */
  fs.writeSync(1, JSON.stringify(out, null, 1));
  process.exit(0);
})();
