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
village.append(elem("div", "village-frame"));
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

/* ---------- app.js 를 vm 안에서 통째로 실행 ---------- */
const sandbox = {
  document: DOC,
  window: null,
  localStorage: shim.localStorage,
  location: shim.location,
  console: { log() {}, warn() {}, error() {}, info() {} },
  uPlot: shim.UPlotStub,
  matchMedia: shim.win.matchMedia,
  getComputedStyle: shim.win.getComputedStyle,
  requestAnimationFrame: shim.win.requestAnimationFrame,
  cancelAnimationFrame: shim.win.cancelAnimationFrame,
  /* fetch 는 전부 거부시킨다 → boot() 이 "데이터를 불러오지 못했습니다" 가지로 빠져
     조기 종료한다. 렌더링은 우리가 필요한 것만 직접 호출한다. */
  fetch: () => Promise.reject(new Error("probe: no network")),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
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
  "cardScaffold", "el", "registry", "DATA", "BANDS", "SECTION_IDS", "palette"];
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

/* boot() 은 async 라 fetch 거부가 마이크로태스크로 나중에 돌아온다. 그때는 위 프로브가
   DATA 를 이미 채워 놓았기 때문에 boot 이 조기 종료 가지를 타지 않고 renderAll() 로
   들어가 버린다(뼈대에 없는 카드에서 죽는다). 측정은 전부 동기로 끝났으므로
   여기서 바로 끝낸다 — fs.writeSync 로 확실히 흘려보내고 나간다. */
fs.writeSync(1, JSON.stringify(out, null, 1));
process.exit(0);
