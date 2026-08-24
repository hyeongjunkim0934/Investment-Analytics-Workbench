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
const SECTIONS = ["overview", "risk", "estimate", "alloc", "hedge", "events", "panel", "rates",
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
secNodes.alloc.append(elem("nav", "alloc-toc"));
["alloc-port-panel",
 "alloc-sim-panel",
 "alloc-headline", "alloc-summary", "alloc-controls", "alloc-cards", "alloc-levers",
 "alloc-frontier-card", "alloc-path-card", "alloc-tv-card", "alloc-char-card",
 "alloc-table-card", "alloc-inputs-box", "alloc-method"]
  .forEach((id) => secNodes.alloc.append(elem("div", id)));

/* 개요 뼈대(§7.9) — 상단 탭이 7개로 줄면서 시장 화면들이 여기로 내려왔다.
   renderOverview 는 구역을 #ov-groups 에 조립하고 카탈로그 입구를 #ov-catalog 에 둔다. */
secNodes.overview.append(elem("div", "ov-groups"), elem("p", "ov-catalog"));
/* 리스크 안의 관계분석 입구 */
secNodes.risk.append(elem("p", "risk-panel-link"));

/* 수익률 추정 뼈대(§7.8) — renderEstimate 가 $("#est-…") 로 집는 자리들.
   `est-method` 만 <details> 다(다른 섹션과 같은 규약). */
["est-summary", "est-controls", "est-table-card", "est-market-card",
 "est-scenario-result", "est-contrib-card", "est-sources"]
  .forEach((id) => secNodes.estimate.append(elem("div", id)));
secNodes.estimate.append(elem("details", "est-method"));

/* 카탈로그 뼈대 */
const catTable = elem("table", "catalog-table");
const tbody = elem("tbody");
catTable.append(tbody);
secNodes.catalog.append(elem("input", "catalog-search"), elem("span", "catalog-count"), catTable);

/* 이벤트 뼈대 */
["events-headline", "events-brief", "events-filters", "events-timeline"].forEach((id) => secNodes.events.append(elem("div", id)));
secNodes.events.append(elem("details", "events-rules"));

/* 환헤지 뼈대 — index.html 의 #hedge 안 구조를 그대로 흉내 낸다.
   renderHedge() 가 만지는 컨테이너가 하나라도 없으면 그 자리에서 죽으므로,
   이 목록 자체가 index.html 과의 계약이다. */
["hedge-headline", "hedge-views", "hedge-lead", "hedge-matrix",
 "hedge-curve-card", "hedge-bt-card", "hedge-cost-card", "hedge-mtm-card",
 "hedge-ts-card", "hedge-merit-card"]
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

/* 브리핑 TTS 스텁 — speak/cancel 을 기록만 한다. voices 배열을 프로브가 갈아 끼우며
   "기기 내(localService) 한국어 음성만 쓴다" 규약을 실행으로 확인한다(아래 eventsBrief). */
const SPOKEN = [];
const TTS_CANCELS = [];
class UtterStub { constructor(text) { this.text = text; this.lang = ""; this.voice = null; this.onend = null; } }
const speechStub = {
  voices: [],
  getVoices: () => speechStub.voices,
  speak: (u) => SPOKEN.push(u),
  cancel: () => TTS_CANCELS.push(1),
  onvoiceschanged: null,
};
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
  speechSynthesis: speechStub,
  SpeechSynthesisUtterance: UtterStub,
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
  "allocAssetDuration", "allocDurGap", "bindGate", "sha256Hex", "GATE_SHA256",
  "allocCcySum", "ALLOC_CCY", "allocState", "amOptimizeUtil", "allocCharStats",
  "allocRedistribute", "allocIsAlt", "allocLambdaForSigma", "allocJointOpt", "allocCcyHedgeRows",
  "allocXeBinds", "allocXeBindNotes", "allocXeRange", "openAllocDetail",
  "estEngine", "estDayCount", "estIndexYtd", "EST_ASSETS",
  "SECTION_LABELS", "sectionLink", "estScenario", "estAxisLevels", "estAxisAt", "EST_SCEN", "estMigrateLevels",
  "explainBox", "EXPLAIN_OPEN",
  "renderPortPanel", "portState", "portDefaults", "portMixFromGroups", "portEngine",
  "portRound01", "projSimplex", "PORT_LS_KEY"];
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
  /* 알려진 공백 ② (CLAUDE.md) — 라벨이 **처음부터 유일하면 refmt 가 적용되면 안 된다.**
     "refmt 를 조건 없이 항상 적용" 뮤테이션은 위 두 측정으로는 안 잡혔다(중복 케이스는
     어차피 재포맷되고, plain 은 refmt 자체가 없다). 유일 케이스를 직접 태운다. */
  const v2 = [1, 2, 3, 4];
  shim.UPlotStub.made.length = 0;
  P.makeTimeChart(box, { labels: ["x"], colors: ["#000"], data: [t, v2], dec: 0, unit: "%" });
  const u2 = shim.UPlotStub.made[shim.UPlotStub.made.length - 1];
  const uniqueLabels = u2.opts.axes[1].values(u2, v2);
  return { labels, unique: new Set(labels).size, n: labels.length, plain,
           plainUnique: new Set(plain).size, uniqueLabels };
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

/* ============ P2b. 상단 탭이 「지금 이 화면」을 보조기기에 알린다 ============
   알려진 공백 ④ (CLAUDE.md) — aria-current 를 안 달아도(또는 안 떼어도) 색(.active)만
   보는 검사로는 통과한다. index.html 의 실제 탭과 같은 링크를 세워 라우팅을 실행한다. */
safe("navCurrent", () => {
  const links = ["#village", "#overview", "#risk"].map((h) => P.el("a", { href: h }, h));
  nav.append(...links);
  shim.location.hash = "#risk";
  P.routeView();
  const at = links.map((a) => [a.getAttribute("href"), a.getAttribute("aria-current"),
                               a.classList.contains("active")]);
  shim.location.hash = "#overview";
  P.routeView();
  const after = links.map((a) => [a.getAttribute("href"), a.getAttribute("aria-current")]);
  links.forEach((a) => a.remove());          // 뒤 프로브의 #nav a 순회에 영향 없게 청소
  return { at, after };
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
    /* 알려진 공백 ③ — 열 때 body 스크롤을 잠근다. 닫을 때 안 풀면 페이지 전체가
       스크롤 불가가 되는데 겉보기엔 멀쩡해서 눈으로 못 잡는다. */
    bodyOverflow: DOC.body.style.overflow,
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
    bodyOverflow: DOC.body.style.overflow,
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
    /* 알려진 공백 ① — 계열마다 마지막 관측 인덱스가 다르면 **가장 최신**(Math.max)을
       찍어야 한다. 위 multiSeries 는 두 계열이 같은 길이라 max→min 뮤테이션이 통과했다.
       여기서는 둘째 계열이 한 관측 짧다(마지막 null) — min 이면 6/30 이 나온다. */
    multiSeriesStaggered: mk({ data: [t, [1, 2, 3], [4, 5, null]], dec: 2 }, "2026-12-31"),
    /* 알려진 공백 ⑥ — 같은 카드에 두 번 불려도 「최근 …」 은 한 번만 붙는다.
       가드(줄 265-266)를 지우는 뮤테이션이 여기서 잡힌다. */
    dupCount: (() => {
      const card = P.el("div", { class: "card" });
      DOC.body.append(card);
      const box = P.cardScaffold(card, { title: "t", sub: "s" });
      P.DATA.meta = { last_observation: "2026-12-31" };
      P.stampLatest(box, { data: [t, [1, 2, 3]], dec: 2, unit: "%" });
      P.stampLatest(box, { data: [t, [1, 2, 3]], dec: 2, unit: "%" });
      return card.querySelectorAll(".card-last").length;
    })(),
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

/* ============ P8b. 이벤트 브리핑 — 원고 원문 표시 + 기기 내 음성만 사용 ============
   원고는 파이프라인이 조립한 문장 배열(events.json.brief)이고, 화면은 그것을 그대로
   표시·낭독만 해야 한다. 여기서는 ① 문장이 한 글자도 안 바뀌고 렌더되는가
   ② 클라우드 음성만 있으면 재생을 거부하고 이유를 적는가(외부 요청 0 규약)
   ③ 기기 내 한국어 음성이 있으면 전 문장을 그 음성·ko-KR 로 읽는가
   ④ 화면을 떠나면 멈추는가 — 를 전부 실행으로 확인한다. */
safe("eventsBrief", () => {
  const BRIEF = [
    "6월 18일부터 8월 3일까지 검출된 이벤트는 모두 2건 — 경계 1 · 주의 1 · 정보 0. 경계·주의만 읽습니다.",
    "[경계] 6월 23일 — KOSPI TR 일간 급락 (-10.0%)",
    "[주의] 7월 1일 — 국고 10년 일간 급등 (+14.0bp)",
    "검출 규칙은 아래 타임라인·방법론에 있습니다. 이 브리핑은 검출 규칙이 만든 이벤트를 그대로 읽은 것으로, 해석·전망을 담지 않습니다. 모델 참고치입니다.",
  ];
  const EVS = [
    { date: "2026-06-23", sev: "경계", cat: "급변", title: "KOSPI TR 일간 급락", value: "-10.0%", rule: "r1" },
    { date: "2026-07-01", sev: "주의", cat: "급변", title: "국고 10년 일간 급등", value: "+14.0bp", rule: "r2" },
  ];
  const box = DOC.getElementById("events-brief");
  const r = {};

  /* ① 원고가 없으면 카드는 숨김 */
  P.DATA.events = { asof: "2026-07-27", lookback_days: 45, events: EVS, catalog: [] };
  P.renderEvents();
  r.hiddenWithoutBrief = box.hidden === true;

  /* ② 클라우드 한국어 음성뿐 → 버튼 비활성 + 이유 표시, 클릭해도 재생 0 */
  const cloudKo = { lang: "ko-KR", localService: false, name: "Google 한국의" };
  speechStub.voices = [cloudKo];
  P.DATA.events.brief = BRIEF;
  P.renderEvents();
  const btn = () => DOC.getElementById("brief-play");
  const note = () => DOC.getElementById("brief-note");
  r.shownWithBrief = box.hidden === false;
  r.linesVerbatim = BRIEF.every((l) => box.textContent.includes(l));
  r.cloudOnlyDisables = btn().disabled === true;
  r.cloudOnlyNoteShown = note().hidden === false;
  r.noteMentionsWhy = /외부|클라우드/.test(note().textContent);
  SPOKEN.length = 0;
  btn().click();
  r.cloudOnlySpeaks = SPOKEN.length;              // 0 이어야 한다

  /* ③ 기기 내 음성이 (클라우드 뒤에) 나타나면 voiceschanged 가 버튼을 살린다.
     find 가 local 을 고르는지 보려고 클라우드를 앞에 둔다. */
  const localKo = { lang: "ko_KR", localService: true, name: "Yuna" };   // Android 식 ko_KR
  speechStub.voices = [cloudKo, localKo];
  speechStub.onvoiceschanged();
  r.localEnables = btn().disabled === false;
  r.noteHiddenWithLocal = note().hidden === true;
  SPOKEN.length = 0; TTS_CANCELS.length = 0;
  btn().click();
  r.spokenTexts = SPOKEN.map((u) => u.text);
  r.allLang = [...new Set(SPOKEN.map((u) => u.lang))];
  r.allLocalVoice = SPOKEN.every((u) => u.voice === localKo);
  r.pressedWhileSpeaking = btn().getAttribute("aria-pressed");
  r.labelWhileSpeaking = btn().textContent;

  /* ④ 화면을 떠나면 멈춘다 */
  shim.location.hash = "#rates";
  P.routeView();
  r.cancelledOnLeave = TTS_CANCELS.length > 0;
  r.labelAfterLeave = btn().textContent;
  r.pressedAfterLeave = btn().getAttribute("aria-pressed");

  /* 마지막 문장이 끝나면 스스로 정지 상태로 돌아온다 */
  SPOKEN.length = 0;
  btn().click();
  SPOKEN[SPOKEN.length - 1].onend();
  r.labelAfterEnd = btn().textContent;
  shim.location.hash = "";
  return r;
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
    /* §7.7.14 미국채 메리트 — 손계산 가능한 4주: spread = ust + cost − ktb */
    ust_merit: {
      active: true, asof: "2029-12-22", freq: "W-FRI",
      series: { cost: "3개월 스왑레이트(SMB, 연율)", ust: "미국채 10년", ktb: "국고 10년" },
      start: "2029-12", n_weeks: 4,
      t: [mk(2029, 11), mk(2029, 11) + 7 * 86400, mk(2029, 11) + 14 * 86400,
          mk(2029, 11) + 21 * 86400],
      cost: [-1.5, -1.4, -1.6, -1.5],
      ust: [4.2, 4.25, 4.3, 4.4],
      ktb: [3.0, 3.05, 3.0, 3.1],
      hedged: [2.7, 2.85, 2.7, 2.9],
      spread: [-0.3, -0.2, -0.3, -0.2],
      now: { cost: -1.5, ust: 4.4, ktb: 3.1, hedged: 2.9, spread: -0.2, spread_pctile: 75 },
    },
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
    /* §5.3.1 공백 ④ — 「평상시 MTM 변동」 = τ × σ_Δs,3M × √12 (연율). √12 를 빼면
       ±0.23% 가 ±0.07% 로 줄어드는데 열 제목은 「연 %」 그대로다 — 값으로 대조한다. */
    mtmVol: mtmRows.slice(1).map((r) => cell(r, 2)),
    mtmSigma: HEDGE_FIXTURE.mtm.sigma_ds_3m,
    mtmWorst: mtmRows.slice(1).map((r) => cell(r, 3)),
    boldRowText: boldRow ? boldRow.textContent : null,
    method: txt("hedge-method"),
    fxLinks: DOC.getElementById("hedge-matrix").querySelectorAll("a").map((a) => a.getAttribute("href")),
  };
});

/* 필수 필드가 빠진 payload 로도 "undefined" 를 화면에 찍지 않는다 */
/* ====== §7.7.14 미국채 메리트 모니터 — 항등식·부호·만기 정직성 =============== */
safe("hedgeMerit", () => {
  const r = {};
  /* mk 는 HEDGE_FIXTURE IIFE 스코프 안에 있다 — 여기서는 지역 헬퍼를 쓴다 */
  const wmk = (y, m) => Math.floor(Date.UTC(y, m, 1) / 1000) - 86400;
  const M = HEDGE_FIXTURE.ust_merit;
  /* ① 항등식 — hedged = ust + cost, spread = hedged − ktb (픽스처 손계산 대조) */
  r.identityHolds = M.t.every((_, i) =>
    Math.abs(M.hedged[i] - (M.ust[i] + M.cost[i])) < 1e-9
    && Math.abs(M.spread[i] - (M.hedged[i] - M.ktb[i])) < 1e-9);
  /* ② 렌더 — 타일·차트·부호 규약·만기 구분 문장 */
  P.DATA.hedge = HEDGE_FIXTURE;
  P.DATA.panel = null;               // 패널 없음 — 상관 문장 대신 링크 폴백이어야 한다
  P.renderSection("hedge");
  const card = DOC.getElementById("hedge-merit-card");
  const txt = card ? card.textContent : "";
  r.renderErrors = DOC.getElementById("hedge").querySelectorAll(".render-error").length;
  r.cardRendered = /미국채 투자 메리트/.test(txt);
  r.tilesShowSpread = /메리트 스프레드/.test(txt) && /백분위 75%/.test(txt);
  r.statesSignKey = txt.includes(P.COST_SIGN_KEY);
  r.statesTenorSplit = /HP 12M/.test(txt) && /3M 스왑레이트|3개월 스왑레이트/.test(txt);
  r.subtractionExplained = /차감/.test(txt);
  r.panelLinkFallback = /관계분석/.test(txt) && !/13주 변화 기준 상관/.test(txt);
  /* ③ 위험 연동 — 패널(주간 stress)이 있으면 13주 변화 상관 문장이 붙는다.
     40주 합성: 위험과 비용이 정확히 반대로 움직이게 만들어 부호를 고정 관측한다. */
  const N = 60;   // 13주 차분 후 47쌍 — 렌더 최소 표본(30쌍)을 넘겨야 한다
  const t40 = Array.from({ length: N }, (_, i) => wmk(2029, 0) + i * 7 * 86400);
  const stress = Array.from({ length: N }, (_, i) => 50 + 20 * Math.sin(i / 4));
  const M2 = { ...M, t: t40,
    cost: stress.map((x) => -x / 20),                       // 위험↑ → 더 내는 쪽(음수 확대)
    ust: Array.from({ length: N }, () => 4.0),
    ktb: Array.from({ length: N }, () => 3.0) };
  M2.hedged = M2.ust.map((u, i) => +(u + M2.cost[i]).toFixed(3));
  M2.spread = M2.hedged.map((h, i) => +(h - M2.ktb[i]).toFixed(3));
  M2.now = { cost: M2.cost[N - 1], ust: 4, ktb: 3, hedged: M2.hedged[N - 1],
             spread: M2.spread[N - 1], spread_pctile: 50 };
  P.DATA.hedge = { ...HEDGE_FIXTURE, ust_merit: M2 };
  P.DATA.panel = { t: t40, risk: { stress } };
  P.renderSection("hedge");
  const txt2 = DOC.getElementById("hedge-merit-card").textContent;
  r.riskCorrRendered = /13주 변화 기준 상관/.test(txt2);
  /* fmtNum(toLocaleString ko-KR)은 음수 부호가 U+2212(−)일 수 있다 — 둘 다 허용 */
  const mCorr = txt2.match(/위험지수↔헤지비용 ([-\u2212]?[\d.]+)/);
  r.riskCostCorrIsNegative = !!mCorr && +mCorr[1].replace("\u2212", "-") < -0.9;
  /* ④ active:false — 사유를 적고 죽지 않는다 */
  P.DATA.hedge = { ...HEDGE_FIXTURE, ust_merit: { active: false, reason: "프로브 사유" } };
  P.renderSection("hedge");
  const txt3 = DOC.getElementById("hedge-merit-card").textContent;
  r.inactiveExplains = /데이터 없음/.test(txt3) && /프로브 사유/.test(txt3);
  r.inactiveRenderErrors = DOC.getElementById("hedge").querySelectorAll(".render-error").length;
  P.DATA.hedge = HEDGE_FIXTURE;
  P.DATA.panel = null;
  return r;
});

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
  /* 신규 7자산군 포트폴리오 구성(port) 블록 — 파이프라인 port.build 게시물의 축약판 */
  const PA = ["국내채권", "해외채권", "국내주식", "해외주식", "대체투자", "달러유동성", "원화유동성"];
  const psd = [0.035, 0.09, 0.28, 0.14, 0.22, 0.10, 0.002];
  const prho = { "0|1": 0.30, "2|3": 0.55, "1|5": 0.60, "3|5": -0.45, "4|5": 0.25 };
  const pcorr = PA.map((_, i) => PA.map((_, j) => i === j ? 1
    : (prho[`${i}|${j}`] != null ? prho[`${i}|${j}`] : (prho[`${j}|${i}`] || 0))));
  const pcov = PA.map((_, i) => PA.map((_, j) => pcorr[i][j] * psd[i] * psd[j]));
  const pmean = [2.0, 5.0, 9.0, 12.0, 4.0, 6.0, 3.0];
  const pwb = PA.map((a) => a === "해외주식" ? 0.6 : a === "국내채권" ? 0.4 : 0);
  const bmean = pwb.reduce((s, w, i) => s + w * pmean[i], 0);
  const bvar = PA.reduce((s, _, i) => s + PA.reduce((t, __, j) => t + pwb[i] * pwb[j] * pcov[i][j], 0), 0);
  const pwin = (key) => ({
    key, n_months: key === "all" ? 42 : 36, start: "2027-01-31", end: "2030-06-30",
    mean_pct: pmean, vol_pct: psd.map((s) => s * 100), mdd_pct: PA.map(() => 10),
    corr: pcorr, cov: pcov,
    bench: { mean_pct: bmean, vol_pct: Math.sqrt(bvar) * 100, mdd_pct: 8.0 },
  });
  const port = {
    active: true, asof: "2030-06-30", assets: PA,
    proxies: Object.fromEntries(PA.map((a) => [a, `bb:${a}-probe`])),
    usd_assets: ["대체투자", "해외주식", "해외채권"], fx_key: "bb:달러원",
    basis: "KRW 원화 환산(미헤지)",
    defaults: {
      groups: { 주식: ["국내주식", "해외주식"], 채권: ["국내채권", "해외채권"],
                대체: ["대체투자"], 유동성: ["달러유동성", "원화유동성"] },
      group_default: { 주식: 50, 채권: 30, 대체: 20 },
      liq_default: 10, liq_range: [0, 20], split_note: "probe",
    },
    bench_w: { 해외주식: 0.6, 국내채권: 0.4 },
    coverage: PA.map((a) => ({ asset: a, key: `bb:${a}-probe`, currency: "KRW",
      first: a === "원화유동성" ? "2027-01-31" : "2010-01-31",
      last: "2030-06-30", n_months: a === "원화유동성" ? 42 : 246 })),
    windows: [pwin("3"), pwin("all")],
    window_years: [1, 3, 5, 10], missing_windows: [5, 10],
    ref10y: { years: 10,
      per_asset: Object.fromEntries(PA.map((a) => [a, a === "원화유동성" ? null
        : { mean_pct: 5.5, vol_pct: 11.1, start: "2020-07-31", end: "2030-06-30", n_months: 120 }])),
      bench: { mean_pct: 8.4, vol_pct: 9.1, mdd_pct: 12.3,
               start: "2020-07-31", end: "2030-06-30", n_months: 120 },
      note: "probe" },
    /* 공개 경계(2026-08-22) — 파이프라인은 asof·mu_pct 만 게시한다(source·note 없음) */
    cma_input: { asof: "2030-06-01",
      mu_pct: { 국내채권: 3.0, 해외채권: 4.5, 국내주식: 7.5, 해외주식: 6.5,
                대체투자: 5.0, 달러유동성: 3.5, 원화유동성: 2.5 } },
    krw_liq_ref: { key: "bb:한국_크레딧_CD_AAA_3m", years: 10,
      mean_pct: 3.7, vol_pct: 0.5, start: "2020-07-31", end: "2030-06-30", n_months: 120,
      overlap: { n_months: 41, corr: 0.91, mean_diff_pa_pct: 0.25 },
      note: "CD(AAA) 3M 일할 적립 지수 — 참고 전용(공통 행렬 미포함)" },
    method: "probe",
  };
  return {
    port,
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
      mix: { 국내채권: 48, 해외채권: 21, 국내주식: 3, 해외주식: 6,
             "대체투자(대출형)": 3, "대체투자(지분형)": 13, 단기자금: 6 },
      bands: { 국내채권: [20, 55], 해외채권: [0, 30], 국내주식: [0, 10],
               해외주식: [0, 15], "대체투자(대출형)": [0, 10],
               "대체투자(지분형)": [0, 25], 단기자금: [2, 15] },
      loan_w: 0, loan_y: 0, alt_alpha: 3, alt_vol: 8, tenor_m: 9,
      mu_over: { 국내채권: 3.25, 해외채권: 2.94, 국내주식: 6.29, 해외주식: 5.43,
                 "대체투자(대출형)": 4.39, "대체투자(지분형)": 6.86, 단기자금: 2.09 },
      h_bond: 90, h_eq: 90,
      h_bands: { 해외채권: [0, 100], 해외주식: [0, 100] },
      h_tol_hi: { 해외채권: null, 해외주식: null },
      ccy: { 해외채권: {}, 해외주식: {} },
      start_key: "full", proxy: "acwi", cost_key: "hp", block_len: 24,
    },
    ccy_bench: {
      해외채권: { asof: "2026-08-03", src: "probe", basis: "표시통화 직접 집계",
        w: { USD: 45.77, EUR: 22.95, CNY: 10.56, JPY: 7.54, GBP: 3.96, CAD: 2.61, AUD: 1.51 },
        krw: 0.99, other: 4.11, dur: {}, dur_all: 5.93, note: "" },
      해외주식: { asof: "2026-06-30", src: "probe", basis: "국가→통화 근사",
        w: { USD: 62.49, JPY: 4.94, CNY: 4.08, EUR: 3.89, GBP: 2.99, CAD: 2.89, AUD: 0 },
        krw: 2.83, other: 15.89, dur: {}, dur_all: null, note: "" },
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
  const stEq = { ...st, mix: { 국내채권: 0, 해외채권: 0, 국내주식: 0, 해외주식: 100,
    "대체투자(대출형)": 0, "대체투자(지분형)": 0, 단기자금: 0 } };
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

  /* ⑦ 장부가 축 제거(§7.7.11) — 우주는 시가 7축 하나이고, 구 관점(view) 저장분이
     남아 있어도 엔진 키에 장부가 축이 되살아나지 않는다 */
  const EA = P.allocEngine(A, { ...st, view: "acct" });
  r.universeIs7 = EA.V.keys.length === 7 && E.V.keys.length === 7;
  r.noBookAxis = EA.V.keys.every((k) => !k.includes("장부가"))
    && E.V.keys.every((k) => !k.includes("장부가"));
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
  /* §7.7.17 로 문구가 바뀌었다 — 「물고 있습니다」(원인만) → 「구간을 좁힙니다 + 풀면
     얼마가 움직이는지」(조치의 크기까지). 옛 문구가 되살아나는 것도 함께 막는다. */
  r.warnsWhenBandBinds = /헤지 밴드\(내규 키인\)가 구간을 좁힙니다/.test(txt2);
  r.bandWarningStatesGain = /밴드를 중립\(0~100%\)까지 풀면 Xe [\d.]+% → [\d.]+%/.test(txt2);
  r.noLegacyBandPhrase = !/밴드가 물고 있습니다/.test(txt2);
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
  /* 손으로 재계산: 0.48×4.5 + 0.21×6.0 + 0.06×0.25 (주식·대체는 0) */
  r.assetDuration = d;
  r.assetDurationHand = 0.48 * 4.5 + 0.21 * 6.0 + 0.06 * 0.25;
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
  r.foreignCanBeExcluded = Math.abs((d - P.allocAssetDuration(stNoFx, w)) - 0.21 * 6.0) < 1e-12;

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

/* ====== P20-b. 벤치마크(CMA) 데이터층 — §7.7 1-2c ==========================
   위험 원천 스위치가 실제로 벤치마크 공분산으로 계산하는지, 대체투자 팩터
   매핑(기관 방식)이 잔차까지 정확한지, 회계 관점 최적화와 장부가 합산 상한이
   실제로 물리는지를 **손계산 대조**로 잰다. 값은 전부 이 파일 안의 합성이다. */
const CMA_ALLOC = (() => {
  const labels = ["장부가 국내채권", "장부가 해외채권", "장부가 단기자금",
                  "시가 국내주식", "시가 해외주식", "시가 국내채권", "시가 해외채권",
                  "시가 대체투자"];
  const cols = [...labels, "_alt", "_fx"];
  const sd = { "장부가 국내채권": 0.0024, "장부가 해외채권": 0.0034, "장부가 단기자금": 0.0027,
               "시가 국내주식": 0.30, "시가 해외주식": 0.13, "시가 국내채권": 0.021,
               "시가 해외채권": 0.045, "시가 대체투자": 0.014, _alt: 0.0199, _fx: 0.103 };
  const rho = { "시가 해외주식|_fx": -0.02, "시가 해외채권|_fx": -0.5, "시가 국내주식|_fx": -0.3,
                "시가 국내주식|시가 해외주식": 0.6, "시가 국내채권|시가 해외채권": 0.4,
                "_alt|시가 해외주식": -0.05, "_alt|시가 국내채권": -0.04,
                "시가 대체투자|_alt": 0.7 };
  const cov = cols.map((a) => cols.map((b) => {
    if (a === b) return sd[a] * sd[a];
    const r = rho[`${a}|${b}`] != null ? rho[`${a}|${b}`] : (rho[`${b}|${a}`] || 0);
    return r * sd[a] * sd[b];
  }));
  const corr = cols.map((a, i) => cols.map((b, j) => cov[i][j] / (sd[a] * sd[b])));
  /* 국내주식 σ 만 두 배(합동변환 — PSD 유지)인 시점 — 시변 방향성 검사용 */
  const iEq2 = cols.indexOf("시가 국내주식");
  const covEq2 = cov.map((row, i) => row.map((v, j) =>
    v * (i === iEq2 ? 2 : 1) * (j === iEq2 ? 2 : 1)));
  const win = (key, n, start) => ({ key, n_months: n, start, end: "2030-06-30",
    mean_pct: [3.2, 3.4, 3.1, 8.0, 9.5, 3.3, 4.1, 5.0, 5.2, 1.0],
    vol_pct: cols.map((c) => sd[c] * 100),
    mdd_pct: cols.map((c) => +(sd[c] * 100 * 1.5).toFixed(4)),   // 결정론 자리값
    corr, cov });
  return {
    ...ALLOC_FIXTURE,
    cma: {
      active: true, asof: "2030-06-30", labels, cols,
      groups: labels.map((l) => l.split(" ")[0]),
      fx_col: "_fx", alt: { label: "시가 대체투자", alpha: 0.31, n_fit: 90 },
      /* §7.7.16 μ 기준일 컷 — 데이터는 더 있는데(2030-08) 표본은 2030-06 에서 끊었다 */
      sample_end: "2030-06-30", data_last: "2030-08-31",
      econ_map: { "장부가 국내채권": "시가 국내채권", "장부가 해외채권": "시가 해외채권",
                  "장부가 단기자금": "장부가 단기자금", "시가 국내주식": "시가 국내주식",
                  "시가 해외주식": "시가 해외주식", "시가 국내채권": "시가 국내채권",
                  "시가 해외채권": "시가 해외채권", "시가 대체투자": "시가 대체투자" },
      coverage: [...labels, "장부가 금융상품", "장부가 대출금"].map((l) => ({
        label: l, group: l.split(" ")[0], first: "2026-01-31", last: "2030-06-30",
        n_months: 54, included: !/금융상품|대출금/.test(l) })),
      excluded: ["장부가 금융상품", "장부가 대출금"],
      windows: [win("1", 12, "2029-07-31"), win("all", 54, "2026-01-31")],
      tv: [{ key: "1", n_window: 12,
             dates: ["2030-04-30", "2030-05-31", "2030-06-30"],
             cov: [covEq2, cov, cov] }],
      method: "월말 표본·부분월 제거 (probe)",
    },
  };
})();

safe("cmaLayer", () => {
  const r = {};
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const mv = (M, w) => M.map((row) => dot(row, w));
  const quad = (w, M) => dot(w, mv(M, w));
  const cm = CMA_ALLOC.cma;
  const CI = {}; cm.cols.forEach((c, i) => { CI[c] = i; });
  const M = cm.windows[1].cov;
  const eV = (lb, extra) => {
    const v = new Array(cm.cols.length).fill(0);
    v[CI[lb]] = 1;
    (extra || []).forEach(([l, x]) => { v[CI[l]] += x; });
    return v;
  };

  /* ① 층 스위치 — CMA 있으면 기본, 없으면 프록시로 물러나며 그 사실을 적는다 */
  shim.localStorage.removeItem("iaw-alloc");
  const E = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
  r.defaultLayerIsCma = E.layer === "cma";
  const Eoff = P.allocEngine(ALLOC_FIXTURE, P.allocDefaults(ALLOC_FIXTURE));
  r.fallsBackWithoutCma = Eoff.layer === "proxy" && !!Eoff.layerNote;
  const Einact = P.allocEngine({ ...ALLOC_FIXTURE, cma: { active: false, reason: "probe-이유" } },
    P.allocDefaults(ALLOC_FIXTURE));
  r.fallbackKeepsReason = Einact.layer === "proxy" && /probe-이유/.test(Einact.layerNote || "");

  /* ② 경제 관점 행렬 — 손계산 대조 (기본 헤지 90% → 환노출 0.1) */
  const V = E.V;
  const iKr = 0, iFb = 1, iEq = 3, iAltD = 4, iAlt = 5;   // ALLOC_ECON 순서(대출형 4·지분형 5)
  r.domesticEquityVarExact =
    Math.abs(V.C[2][2] - quad(eV("시가 국내주식"), M) * 1e4) < 1e-9;
  const fbRow = eV("시가 해외채권", [["_fx", 0.1]]);
  r.foreignBondVarWithFxExact = Math.abs(V.C[iFb][iFb] - quad(fbRow, M) * 1e4) < 1e-9;
  r.krBondUsesMarketTwin = Math.abs(V.C[iKr][iKr] - quad(eV("시가 국내채권"), M) * 1e4) < 1e-9;

  /* ③ 대체투자 분류별 팩터 매핑 — 잔차까지 폐형 손계산과 일치해야 한다.
     기본 매핑은 두 분류 모두 50/50(2026-08-12 사용자 지시)이라 분류 구분이 시험되지
     않으므로, 손계산 대조는 **서로 다른 블렌드를 명시로 걸어** 잰다(65/35 · 0/100 —
     §7.7.9 민감도 대안). 잔차 = _alt 를 두 팩터 스팬에 회귀한 잔차분산(매핑 비율과
     무관), 분류별 독립(대각 2, 교차항 없음). */
  const Es = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC),
    alt_map: { mode: "factor", eq_we: 65, eq_wb: 35, dt_we: 0, dt_wb: 100 } });
  const Vs = Es.V;
  /* 손계산 팩터 행 — **대체투자 환헤지가 걸린 뒤의 행**이어야 한다(§7.7.20).
     팩터인 시가 해외주식이 h₀=0(미헤지)이라 we 만큼 환이 딸려 오고, 그중 h_alt 를
     헤지해 `_fx` 에서 뺀다. 기본값 90% 기준이며, hAlt 인자로 다른 값도 잰다. */
  const mkFH = (we, wb, hAlt) => {
    const v = new Array(cm.cols.length).fill(0);
    v[CI["시가 해외주식"]] = we; v[CI["시가 국내채권"]] = wb;
    if (CI._fx != null && we !== 0) v[CI._fx] -= hAlt * we;
    return v;
  };
  const H_ALT_D = (P.allocDefaults(CMA_ALLOC).h_alt || 0) / 100;
  const mkF = (we, wb) => mkFH(we, wb, H_ALT_D);
  const fEq = mkF(0.65, 0.35), fDt = mkF(0, 1);
  const fEE = M[CI["시가 해외주식"]][CI["시가 해외주식"]];
  const fEB = M[CI["시가 해외주식"]][CI["시가 국내채권"]];
  const fBB = M[CI["시가 국내채권"]][CI["시가 국내채권"]];
  const cE = M[CI["시가 해외주식"]][CI._alt], cB = M[CI["시가 국내채권"]][CI._alt];
  const det = fEE * fBB - fEB * fEB;
  const idio = M[CI._alt][CI._alt]
    - (fBB * cE * cE - 2 * fEB * cE * cB + fEE * cB * cB) / det;
  r.idioIsPositive = idio > 1e-10;
  /* 기본 매핑 = 두 분류 모두 50/50 (2026-08-12 사용자 지시) — 기본 엔진 E 로 확인 */
  r.defaultMappingIsFiftyFifty =
    Math.abs(V.C[iAlt][iAlt] - (quad(mkF(0.5, 0.5), M) + idio) * 1e4) < 1e-9
    && Math.abs(V.C[iAltD][iAltD] - V.C[iAlt][iAlt]) < 1e-9;
  r.altVarIsFactorPlusIdio = Math.abs(Vs.C[iAlt][iAlt] - (quad(fEq, M) + idio) * 1e4) < 1e-9;
  r.altDebtVarIsFactorPlusIdio = Math.abs(Vs.C[iAltD][iAltD] - (quad(fDt, M) + idio) * 1e4) < 1e-9;
  /* 두 분류 사이 — 팩터 교차만(잔차는 분류별 독립 — 공유하면 행렬이 도로 특이해진다.
     실측: 공유안은 완전헤지에서 촐레스키 피벗 −2.3e−14 로 죽었다) */
  r.altClassCrossIsFactorOnly =
    Math.abs(Vs.C[iAlt][iAltD] - dot(fEq, mv(M, fDt)) * 1e4) < 1e-9;
  /* 합산 잔차 = (w1²+w2²)·σ²res — 대출형 3%·지분형 12% 배분의 합산 분산 손계산 */
  const wMix = [0, 0, 0, 0, 0.03, 0.12, 0];
  const fMix = fEq.map((x, j) => 0.12 * x + 0.03 * fDt[j]);
  r.altAggregateIdioIsIndependent =
    Math.abs(quad(wMix, Vs.C) - (quad(fMix, M) + (0.12 ** 2 + 0.03 ** 2) * idio) * 1e4) < 1e-9;
  /* 해외주식 BM 은 **미헤지 계열**(h₀=0)이라 헤지하면 _fx 를 **뺀다** — 기본 he=0.9 면
     −0.9 다. 예전에는 전 계열을 헤지 기준으로 읽어 +0.1 을 더했고, 그 결과 환노출을
     w주식 만큼 이중계상했다(§7.7.19). 부호가 되돌아가면 여기서 걸린다. */
  const eqRow = eV("시가 해외주식", [["_fx", -0.9]]);
  r.altCrossIsFactorCross = Math.abs(Vs.C[iAlt][iEq] - dot(eqRow, mv(M, fEq)) * 1e4) < 1e-9;
  r.foreignEquityRowSubtractsFx =
    Math.abs(V.C[iEq][iEq] - quad(eqRow, M) * 1e4) < 1e-9;
  /* h = h₀ 면 보정이 정확히 0 — 계열별 기준점이 맞는지 직접 확인한다.
     해외주식은 he=0(오픈)에서, 해외채권은 hb=1(완전헤지)에서 BM 그대로여야 한다. */
  const Eh0 = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), h_eq: 0, h_bond: 100 });
  r.equityAtOpenIsRawBm =
    Math.abs(Eh0.V.C[iEq][iEq] - quad(eV("시가 해외주식"), M) * 1e4) < 1e-9;
  r.bondAtFullHedgeIsRawBm =
    Math.abs(Eh0.V.C[iFb][iFb] - quad(eV("시가 해외채권"), M) * 1e4) < 1e-9;
  /* 자연헤지 — 미헤지 계열을 헤지하면 해외주식 위험은 **늘어난다**(달러가 주식과
     음의 상관이라 환노출이 완충 역할을 한다). 부호가 뒤집히면 여기서 걸린다. */
  const Eh1 = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), h_eq: 100, h_bond: 100 });
  r.hedgingEquityRaisesItsRisk = Eh1.V.C[iEq][iEq] > Eh0.V.C[iEq][iEq];
  /* 매핑 대체투자는 _fx 열이 0 인데도 팩터를 통해 환을 진다 — 총 환노출 ≠ Xe.
     지분형 12%·대출형 3%, 기본 매핑 50/50 이면 팩터 몫이 0.5×0.15 = 7.5%p 다. */
  const wAlt = [0, 0, 0, 0, 0.03, 0.12, 0];
  const fxTot = E.fxLoadW ? E.fxLoadW(wAlt) : null;
  /* 매핑 대체투자가 지는 환은 **헤지비율이 걸린 뒤**의 값이다(§7.7.20).
     50/50 매핑·비중 15% 면 딸려 오는 환이 7.5%p 이고 거기에 (1 − h_alt) 가 곱해진다. */
  r.altCarriesEmbeddedFx = fxTot != null
    && Math.abs(fxTot - 0.075 * (1 - H_ALT_D)) < 1e-9;
  r.altXeIsZeroSoTotalExceedsXe = Math.abs(E.xeOfW(wAlt, 0.9, 0.9)) < 1e-12 && fxTot > 0;
  /* 레버가 실제로 움직이는가 — 0% 면 전액 노출, 100% 면 0 */
  {
    const mkE = (ha) => P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), h_alt: ha });
    const f0 = mkE(0).fxLoadW(wAlt), f100 = mkE(100).fxLoadW(wAlt);
    r.altHedgeMovesFxLoad = Math.abs(f0 - 0.075) < 1e-9 && Math.abs(f100) < 1e-12;
    /* **Xe 에는 들어가지 않는다** — 최적 헤지쌍이 사용자가 정한 값을 덮어쓰지 않게 */
    r.altHedgeNotInXe =
      Math.abs(mkE(0).xeOf(0.9, 0.9) - mkE(100).xeOf(0.9, 0.9)) < 1e-12;
    /* 위험은 실제로 달라진다 — 모형 입력이 계산에 닿지 않으면 칸만 있는 것이다.
       **방향을 손으로 못박지 말 것**: 대체투자는 미헤지 BM(시가 해외주식)을 팩터로
       쓰므로 자연헤지 성질이 그대로 옮겨 오고, 헤지가 위험을 **올릴** 수 있다
       (직접 해외주식에서 실측된 성질 — `hedgingEquityRaisesItsRisk`). 그래서
       ① 값이 움직이는가 ② 방향이 직접 해외주식과 같은가 로 나눠 잰다. 상관이
       뒤집히는 데이터가 오면 둘이 **함께** 뒤집혀 검사는 그대로 성립한다. */
    const cA0 = mkE(0).V.C[iAlt][iAlt], cA100 = mkE(100).V.C[iAlt][iAlt];
    r.altHedgeChangesRisk = Math.abs(cA100 - cA0) > 1e-9;
    r.altHedgeDirectionMatchesEquity =
      (cA100 > cA0) === (Eh1.V.C[iEq][iEq] > Eh0.V.C[iEq][iEq]);
    /* 매핑이 채권 100%(we=0)면 걸 환이 없어 비율과 무관하게 0 — 분류별 매핑이 달라도
       한 비율로 맞게 작동한다는 근거(슬라이더를 분류마다 두지 않은 이유) */
    const bondOnly = { mode: "factor", eq_we: 0, eq_wb: 100, dt_we: 0, dt_wb: 100 };
    const Eb0 = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), alt_map: bondOnly, h_alt: 0 });
    r.altHedgeInertWhenNoEquityFactor = Math.abs(Eb0.fxLoadW(wAlt)) < 1e-12;
  }
  /* fxLoadW 는 **직접 해외주식 슬리브도** 세야 한다 — 매핑 대체만 세면 w주식 만큼
     과소계상이다(감사에서 제기된 자리). 해외주식만 10%, he 를 움직이며 확인. */
  const wEqOnly = [0, 0, 0, 0.10, 0, 0, 0];
  r.fxLoadCountsDirectEquity = [0, 0.5, 1].every((he) => {
    const Eh = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), h_bond: 100, h_eq: he * 100 });
    return Math.abs(Eh.fxLoadW(wEqOnly) - 0.10 * (1 - he)) < 1e-9;
  });
  /* **Xe 항등식이 h₀ 도입 후에도 성립하는가** — 이것이 감사에서 제기된 핵심 가설이다.
     _fx 열 계수는 Σwᵢ(h₀ᵢ−hᵢ) 라 xeOf 가 돌려주는 Σwᵢ(1−hᵢ) 와 **w주식 만큼 다르다**.
     그러나 그 차이는 (hb,he) 와 무관한 **상수 평행이동**이므로 등위집합이 보존되고,
     같은 Xe 를 만드는 모든 쌍의 σ 가 여전히 정확히 같다. 실데이터로 확인했고 여기서
     고정한다 — 좌표가 어긋나는 변경이 들어오면 산포가 0 을 벗어난다. */
  {
    const Ex = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
    const wb = Ex.w0[1], we = Ex.w0[3];
    const sigAt = (hb, he) => Ex.sigmaHedge(hb, he);
    const target = 0.5 * (wb + we);            // 도달 가능한 중간 Xe
    const pairs = [];
    for (let t = 0; t <= 100; t++) {
      const hb = t / 100, he = 1 - (target - wb * (1 - hb)) / we;
      if (he >= -1e-12 && he <= 1 + 1e-12) pairs.push([hb, Math.min(Math.max(he, 0), 1)]);
    }
    const pick = [pairs[0], pairs[(pairs.length / 2) | 0], pairs[pairs.length - 1]];
    const ss = pick.map(([hb, he]) => sigAt(hb, he));
    r.isoXePairsGiveSameSigma = pick.length === 3
      && Math.max(...ss) - Math.min(...ss) < 1e-9;
    /* 구조적 범위 [0, wF] 도 유지되는가 — §7.7.17 의 서술이 h₀ 도입 후에도 참인지 */
    r.xeStaysInStructuralRange =
      Math.abs(Ex.xeOf(1, 1)) < 1e-12 && Math.abs(Ex.xeOf(0, 0) - (wb + we)) < 1e-12;
  }
  /* 잔차 덕에 정칙 — 촐레스키가 끝까지 간다 */
  const chol = (C) => {
    const n = C.length, L = C.map((row) => row.slice());
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = L[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) return false; L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    return true;
  };
  r.econMatrixIsPD = chol(V.C);
  /* 벤치마크 그대로(진단) 모드 — 관측 σ 로 되돌아간다 */
  const Ebm = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC),
    alt_map: { mode: "bm", eq_we: 65, eq_wb: 35, dt_we: 0, dt_wb: 100 } });
  r.bmModeUsesRawAlt =
    Math.abs(Ebm.V.C[iAlt][iAlt] - quad(eV("시가 대체투자"), M) * 1e4) < 1e-9;
  /* bm 진단 모드에서 두 분류는 같은 벤치마크 행(잔차 0) — 완전상관(교차 = 분산) */
  r.bmModeClassesIdentical =
    Math.abs(Ebm.V.C[iAlt][iAltD] - Ebm.V.C[iAlt][iAlt]) < 1e-9;

  /* ④ 창 전환·표본 표기 — 기본 창 "5"는 픽스처에 미게시라 최장(전체 54개월)으로
     물러나야 한다(2026-08-12: 위험 디폴트 = BM 5년, 게시 전엔 최장 폴백) */
  const E1 = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), cma_win: "1" });
  r.windowSwitchChangesSample = E1.sample.n_months === 12 && E.sample.n_months === 54;
  r.defaultWinIsFive = P.allocDefaults(CMA_ALLOC).cma_win === "5";
  r.unpublishedWinFallsBackToLongest = E.cmaW.key === "all";

  /* ⑤ 기대수익 키인 — **최종치**(§7.7.10): 키인이 그대로 μ 가 되고 캐리를 다시
     더하지 않는다. 디폴트도 사용자 지정 CMA 수치가 그대로 실려야 한다. */
  const Emu = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC),
    mu_over: { 국내주식: 9, 해외채권: 5 } });
  r.muOverridePlain = Math.abs(Emu.V.mu[2] - 9) < 1e-12;
  r.muOverrideIsFinal = Math.abs(Emu.V.mu[1] - 5) < 1e-12;
  /* 디폴트 μ = 사용자 지정 수치 그대로 (경제 관점: 국내채권·해외채권·국내주식·
     해외주식·대출형·지분형·단기자금) */
  r.defaultMuIsUserCma = [3.25, 2.94, 6.29, 5.43, 4.39, 6.86, 2.09]
    .every((v, i) => Math.abs(E.V.mu[i] - v) < 1e-12);
  /* 순서 계약 — 우주는 시가 7축 하나(§7.7.11)이고 삽입 위치(해외채권 1·해외주식 3)가
     xeOf 계약이다. 구 저장분의 view:"acct" 가 남아 있어도 축이 바뀌지 않는다. */
  const EmuA = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), view: "acct" });
  r.universeOrderIsEcon7 = JSON.stringify(EmuA.V.keys) === JSON.stringify(
    ["국내채권", "해외채권", "국내주식", "해외주식",
     "대체투자(대출형)", "대체투자(지분형)", "단기자금"])
    && JSON.stringify(E.V.keys) === JSON.stringify(EmuA.V.keys);

  /* ⑥ 앵커 σ 가 벤치마크에서 온다 (시가 국내채권 2.1%) */
  r.anchorSigmaFromBm = Math.abs(E.V.anchor.kr.sigma - 2.1) < 1e-9;

  /* ⑦ Xe 붕괴·헤지 감응 — CMA 층에서도 정확히 성립해야 한다 */
  const q = E.xeQuad();
  let worst = 0;
  for (let hb = 0; hb <= 1.0001; hb += 0.2) {
    for (let he = 0; he <= 1.0001; he += 0.2) {
      const d = Math.abs(E.sigmaXe(E.xeOf(hb, he), q) - E.sigmaHedge(hb, he));
      if (d > worst) worst = d;
    }
  }
  r.xeQuadExactOnCma = worst < 1e-12;
  r.hedgeSliderMatters = Math.abs(E.sigmaHedge(0, 0) - E.sigmaHedge(1, 1)) > 1e-6;

  /* ⑧ cap_book 폐지(§7.7.11) — 구 저장분에 cap_book 이 남아 있어도 그룹이
     되살아나지 않는다(장부가 쏠림 자체가 축 제거로 소멸 — 상한의 존재 이유 소멸) */
  const Ee = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), cap_book: 50 });
  r.capBookGone = !Ee.groups.some((g) => g.label === "장부가 성격 합계");

  /* ⑨ 화면 — 층 스위치·매핑 콘솔·출처 태그·회계 참고치가 실제로 렌더되는가 */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const ctlTxt = DOC.getElementById("alloc-controls").textContent;
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.controlsShowSource = /위험 원천/.test(ctlTxt) && /기관 벤치마크/.test(ctlTxt);
  r.controlsShowMapping = /대체투자 위험/.test(ctlTxt) && /디스무딩/.test(ctlTxt);
  r.controlsShowPerClassMapping = /지분형/.test(ctlTxt) && /대출형/.test(ctlTxt);
  r.tableShowsMappingTag = /\[매핑\]/.test(DOC.getElementById("alloc-table-card").textContent);
  const mthTxt = DOC.getElementById("alloc-method").textContent;
  /* 환 기준은 **계열마다 다르다**는 사실이 방법론에 적혀야 한다(§7.7.19). 예전 문구
     「해외 벤치마크는 환노출 제거 기준」은 해외주식에 대해 틀렸고, 그 오진이 환노출
     이중계상으로 이어졌다 — 문구가 되살아나면 두 번째 검사가 걸린다. */
  r.methodShowsFxBasis = /계열마다 다릅니다/.test(mthTxt)
    && /해외채권은 환헤지 반영/.test(mthTxt) && /해외주식은 미헤지/.test(mthTxt);
  r.methodDroppedWrongFxClaim = !/환노출 제거 기준/.test(mthTxt);
  r.methodShowsExcluded = /장부가 금융상품/.test(mthTxt) && /제외/.test(mthTxt);
  r.headlineShowsLayer = /기관 벤치마크/.test(DOC.getElementById("alloc-headline").textContent);
  /* 구 저장분(view:"acct")이 남아 있어도 — 단일 요약이 그대로 나오고 죽지 않는다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, view: "acct" }));
  P.renderSection("alloc");
  const sumTxt = DOC.getElementById("alloc-summary").textContent;
  r.legacyViewSummaryHasReference = /현재 vs 참고치/.test(sumTxt) && /참고치/.test(sumTxt);
  r.legacyViewNoAcctTitle = !/회계\(손익\) 관점/.test(sumTxt);
  r.legacyViewRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  /* 프록시 폴백 화면 — 사유가 적히고 CMA 버튼이 비활성이다 */
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  r.fallbackNoteRendered = /벤치마크 CMA 없음/.test(DOC.getElementById("alloc-controls").textContent);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-c. 시변·창 민감도 — λ-효용 MVO (§7.7 1-2c 후속, 2026-08-11) ======
   표본(롤링 시점·고정 창)을 바꿔 가며 같은 λ-MVO 를 풀어 배분 경로를 보여주는
   카드. ① λ 단조성(위험회피↑ → 위험↓) ② 방향성(σ 두 배인 자산의 비중 감소)
   ③ 롤링 종점 = 고정 창 (같은 표본 → 같은 해) ④ 화면 렌더를 실행으로 잰다. */
safe("cmaTv", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");
  const E = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
  const cm = CMA_ALLOC.cma;
  const opt = (M, lam) => {
    const B = E.buildFrom(M, 0.9, 0.9);
    return { B, w: E.optimizeUtil(B.mu, B.C, lam, 2000) };
  };
  const sig = (B, w) => E.sigmaW(w, B.C);
  const M = cm.windows[1].cov;
  const { B: B1, w: w1 } = opt(M, 1);
  const { w: wHi } = opt(M, 50);

  /* ① 위험회피 단조 — λ 50 은 λ 1 보다 위험이 낮고 기대수익도 낮다 */
  r.lambdaMonotoneRisk = sig(B1, wHi) <= sig(B1, w1) + 1e-9;
  const mdot = (mu, w) => w.reduce((s, wi, i) => s + wi * mu[i], 0);
  r.lambdaMonotoneReturn = mdot(B1.mu, wHi) <= mdot(B1.mu, w1) + 1e-9;
  /* λ=1 해가 고위험회피 해보다 효용(소수 단위)이 낮지 않다 — 목적함수 검산 */
  const util = (B, w, lam) => mdot(B.mu, w) / 100
    - lam / 2 * w.reduce((s, wi, i) => s + wi * B.C[i].reduce((t, c, j) => t + c * w[j], 0), 0) / 1e4;
  r.lambda1SolutionHasHigherUtility = util(B1, w1, 1) >= util(B1, wHi, 1) - 1e-9;

  /* ② 방향성 — 국내주식 σ 가 두 배인 롤링 시점에서는 국내주식 비중이 준다.
     이 두 검사는 μ 지형이 만드는 기하(상한 붙음/내부해)를 전제하므로, μ 를 앵커
     폴백(mu_over 비움)으로 고정해 잰다 — 2026-08-12 부터 기본 μ 가 사용자 지정
     CMA 수치라 기본 상태의 λ 지형이 달라졌기 때문이다(검사 대상은 최적화기의
     성질이지 디폴트 숫자가 아니다). λ=1 에서는 이 자산이 밴드 상한(10%)에 붙어
     σ 가 변해도 못 움직인다 — 방향성은 내부해가 되는 λ=15 로 잰다(같은 목적함수
     족·같은 코드 경로). */
  const Ean = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), mu_over: {} });
  const optAn = (M2, lam) => {
    const B = Ean.buildFrom(M2, 0.9, 0.9);
    return { B, w: Ean.optimizeUtil(B.mu, B.C, lam, 2000) };
  };
  const iEq = P.ALLOC_ECON.indexOf("국내주식");
  /* **「λ=1 이면 국내주식이 상한 10% 에 붙는다」를 픽스처로 못박지 말 것.**
     그 상태는 μ·Σ 가 바뀌면 따라 움직인다 — §7.7.20 에서 대체투자 환헤지가 들어와
     행렬이 바뀌자 **롤링 표본 쪽에서** 풀렸다(기본 행렬은 여전히 0.10 에 붙어 있고
     롤링 tv[0].cov[0] 만 내부해가 됐다). 옛 검사는 두 표본 모두 붙어 있다고 전제해
     그 순간 빨간불이 됐지만 코드는 멀쩡했다. 검사하려는 성질은 「밴드에 **붙은**
     자산은 σ 가 변해도 못 움직인다」이므로, 밴드를 눌러 **확실히 붙는 상태를
     구성한 뒤** 잰다(자의적 픽스처가 아니라 성질의 구성이다). 자연 상태의 두 값은
     진단용으로 함께 싣는다 — 다음에 또 움직이면 어느 쪽인지 바로 보인다. */
  const dAn = P.allocDefaults(CMA_ALLOC);
  const Epin = P.allocEngine(CMA_ALLOC, { ...dAn, mu_over: {},
    bands: { ...dAn.bands, 국내주식: [0, 2] } });
  const optPin = (M2, lam) => {
    const B = Epin.buildFrom(M2, 0.9, 0.9);
    return Epin.optimizeUtil(B.mu, B.C, lam, 2000);
  };
  const wPinA = optPin(M, 1), wPinB = optPin(cm.tv[0].cov[0], 1);
  r.bandPinnedAtLowLambda =
    Math.abs(wPinA[iEq] - 0.02) < 5e-3 && Math.abs(wPinB[iEq] - wPinA[iEq]) < 5e-3;
  const { w: w1an } = optAn(M, 1);
  const { w: w2at1 } = optAn(cm.tv[0].cov[0], 1);
  r.natEqAtLambda1 = +w1an[iEq].toFixed(4);        // 진단 — 단언하지 않는다
  r.natEqAtLambda1Tv = +w2at1[iEq].toFixed(4);     // 같음
  const { w: wA15 } = optAn(M, 15);
  const { w: wB15 } = optAn(cm.tv[0].cov[0], 15);
  r.riskierAssetGetsLess = wB15[iEq] < wA15[iEq] - 1e-3;

  /* ③ 롤링 종점 = 고정 창(같은 표본·같은 결정 알고리즘 → 같은 해) — 단, 프로브
     픽스처의 고정 "1"창과 tv 종점은 같은 행렬을 공유하므로 여기서 성립해야 한다 */
  const { w: wEnd } = opt(cm.tv[0].cov[2], 1);
  const { w: wAll } = opt(cm.windows[1].cov, 1);
  r.sameMatrixSameSolution = wEnd.every((x, i) => Math.abs(x - wAll[i]) < 1e-12);

  /* ④ 화면 — 롤링 차트 카드와 창 민감도 표가 실제로 렌더된다 */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const tvBox = DOC.getElementById("alloc-tv-card");
  const txt = tvBox ? tvBox.textContent : "";
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.rollCardRendered = /시간 경로/.test(txt) && /λ/.test(txt);
  r.saysInputsAreFrozen = /현재 설정으로 고정/.test(txt);
  r.saysThirdObjective = /①②/.test(txt);
  /* 창 민감도 모드 — 저장 상태로 전환해 표가 나오는지 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, tv_mode: "win" }));
  P.renderSection("alloc");
  const txt2 = DOC.getElementById("alloc-tv-card").textContent;
  r.winModeRendersTable = /창 민감도/.test(txt2) && /전체/.test(txt2);
  /* 프록시 층에서는 카드가 안내문으로 물러난다 */
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  r.proxyLayerShowsGuidance = /벤치마크 층 전용/.test(DOC.getElementById("alloc-tv-card").textContent);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-d. 포트폴리오 특성 + 목차 (2026-08-11 사용자 지시) ==============
   비중을 바꿀 때 샤프·분산비·상관·MDD·효율 갭이 함께 움직이는 카드와, 긴 화면의
   구역 이동용 목차(해시 아님 — 라우팅 축과 분리). 지표는 손계산과 대조한다. */
safe("allocChar", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");
  const E = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
  const w = E.w0;
  const cs = P.allocCharStats(E, w);

  /* ① 손계산 대조 — 샤프·E[MDD]·ρ(포트,자산)·상관 대각 */
  const rf = CMA_ALLOC.rates.kr3m.v;
  r.sharpeHand = Math.abs(cs.sharpe - (cs.mu - rf) / cs.sig) < 1e-12;
  /* 기하 정합형(재점검 정정): E[%MDD] = 1 − e^(−√(π/2)·σ_dec·√T) — 100% 상한 내장 */
  r.emddHand = Math.abs(cs.emdd - (1 - Math.exp(-1.2533 * (cs.sig / 100) * Math.sqrt(cs.T))) * 100) < 1e-12;
  r.emddBelow100 = cs.emdd < 100;
  const Cw = E.V.C.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
  const i0 = 0;
  r.rhoHand = Math.abs(cs.rho[i0] - Cw[i0] / (cs.sig * cs.sigs[i0])) < 1e-12;
  r.rhoBounded = cs.rho.every((x) => x == null || (x >= -1 - 1e-9 && x <= 1 + 1e-9));
  r.corrDiagOnes = cs.corr.every((row, i) => Math.abs(row[i] - 1) < 1e-9);
  r.drAtLeastOne = cs.dr >= 1 - 1e-9;

  /* ② 분산비가 실제로 「분산」을 재나 — 한 자산 몰빵이면 DR = 1 */
  const wOne = w.map((_, i) => (i === 0 ? 1 : 0));
  r.drOneWhenConcentrated = Math.abs(P.allocCharStats(E, wOne).dr - 1) < 1e-9;

  /* ③ 화면 — 카드·목차가 렌더되고, 매핑된 대체투자의 실측 MDD 칸은 비운다 */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const box = DOC.getElementById("alloc-char-card");
  const txt = box ? box.textContent : "";
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.cardRendered = /포트폴리오 특성/.test(txt) && /샤프/.test(txt) && /분산비/.test(txt);
  r.mddLabeledAsModel = /\[모형\]/.test(txt) && /기하브라운/.test(txt);
  r.showsEfficiencyGap = /효율 갭|투자선 위에 있습니다/.test(txt);
  r.hasCorrMatrix = /상관 행렬/.test(txt);
  /* 매핑 자산의 실측 MDD 는 원지수가 대표하지 않으므로 비워야 한다 — 두 분류 모두.
     상관 행렬 표의 행도 "대체투자"를 담으므로 5칸짜리(자산군 표) 행만 고른다. */
  const rows = [...box.querySelectorAll("table tr")];
  const altRows = rows.filter((tr) => tr.children.length === 5
    && /대체투자/.test(tr.children[0].textContent));
  r.mappedAltRowCount = altRows.length;
  r.mappedAltMddBlank = altRows.length === 2
    && altRows.every((tr) => /–/.test(tr.children[3].textContent));
  /* 목차 — 버튼이 있고, 눌러도 죽지 않는다(scrollIntoView 가드) */
  const toc = DOC.getElementById("alloc-toc");
  const btns = toc ? [...toc.querySelectorAll("button")] : [];
  r.tocButtonCount = btns.length;
  let clickOk = true;
  try { btns.forEach((b) => b.onclick && b.onclick()); } catch (e) { clickOk = false; }
  r.tocClicksSafe = clickOk;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-e. 재점검(2026-08-11) 수정 검증 — 축 부재·소독·정직 문구 ========
   독립 리뷰 2건이 실측한 결함들의 수정을 실행으로 고정한다: _fx 부재 시 허구의
   "완전헤지 최적", _alt 부재 시 무언 특이 위험, 손상 저장의 NaN 전파, 밴드 밖
   배분에서 효율 갭 문구 거짓, 복구 후에도 남는 고장 배너. */
const stripCmaCol = (cma, col) => {
  const i = cma.cols.indexOf(col);
  if (i < 0) return cma;
  const cut = (arr) => arr.filter((_, j) => j !== i);
  const cutM = (M) => M.filter((_, k) => k !== i).map((row) => cut(row));
  return { ...cma,
    cols: cut(cma.cols),
    fx_col: col === "_fx" ? null : cma.fx_col,
    alt: col === "_alt" ? null : cma.alt,
    windows: cma.windows.map((w) => ({ ...w,
      mean_pct: cut(w.mean_pct), vol_pct: cut(w.vol_pct),
      mdd_pct: w.mdd_pct ? cut(w.mdd_pct) : w.mdd_pct,
      corr: cutM(w.corr), cov: cutM(w.cov) })),
    tv: (cma.tv || []).map((b) => ({ ...b, cov: b.cov.map(cutM) })),
  };
};

safe("cmaAudit", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");

  /* ① _fx 부재 — 헤지비율이 전부 동점이므로 참고치를 내지 않고 사유를 적는다 */
  const NOFX = { ...CMA_ALLOC, cma: stripCmaCol(CMA_ALLOC.cma, "_fx") };
  const Ef = P.allocEngine(NOFX, P.allocDefaults(NOFX));
  r.fxLiveFalse = Ef.fxLive === false;
  r.hedgeIsFlat = Math.abs(Ef.sigmaHedge(0, 0) - Ef.sigmaHedge(1, 1)) < 1e-12;
  P.DATA.alloc = NOFX;
  P.renderSection("alloc");
  const sumTxt = DOC.getElementById("alloc-summary").textContent;
  r.noFxSummaryExplains = /헤지 참고치가 없습니다/.test(sumTxt) && /_fx/.test(sumTxt);
  r.noFxNoHedgeColumn = !/헤지 채권\/주식/.test(sumTxt);
  r.noFxLeverExplains = /무력합니다/.test(DOC.getElementById("alloc-levers").textContent);
  r.noFxSrcTagHonest = !/\+환노출/.test(DOC.getElementById("alloc-table-card").textContent);
  r.noFxRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;

  /* ② _alt 부재 + 팩터 모드 — 잔차 미가산을 화면이 밝힌다 */
  const NOALT = { ...CMA_ALLOC, cma: stripCmaCol(CMA_ALLOC.cma, "_alt") };
  P.DATA.alloc = NOALT;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  r.noAltWarns = /잔차 미가산/.test(DOC.getElementById("alloc-controls").textContent);
  const Ea = P.allocEngine(NOALT, P.allocDefaults(NOALT));
  r.noAltIdioZero = Ea.altInfo.idio === 0 && Ea.altInfo.unsmoothed == null;

  /* ③ 완전헤지(fx 로딩 0)에서도 잔차 덕에 정칙 — 뮤테이션 ②의 PD 사각 봉쇄 */
  const chol = (C) => {
    const n = C.length, L = C.map((row) => row.slice());
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = L[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 0) return false; L[i][i] = Math.sqrt(s); }
      else L[i][j] = s / L[j][j];
    }
    return true;
  };
  const Eh = P.allocEngine(CMA_ALLOC, { ...P.allocDefaults(CMA_ALLOC), h_bond: 100, h_eq: 100 });
  r.pdAtFullHedge = chol(Eh.V.C);

  /* ④ 손상 저장 소독 — "abc" 상한·문자열 비중·숫자형 창 키가 NaN 으로 퍼지지 않는다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    cap_book: "abc", cap_foreign: "x", mix_acct: { "장부가 국내채권": "30" }, cma_win: 1 }));
  const stS = P.allocState(CMA_ALLOC);
  r.badCapSanitized = stS.cap_book === undefined && stS.cap_foreign === null;   // cap_book 은 §7.7.11 폐기
  r.stringMixCoerced = stS.mix["국내채권"] === 30;   // 구 회계 저장분("30")이 fold 로 승계
  r.numericWinCoerced = stS.cma_win === "1";
  P.DATA.alloc = CMA_ALLOC;
  P.renderSection("alloc");
  r.sanitizedRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.sanitizedHasReference = /참고치/.test(DOC.getElementById("alloc-summary").textContent);

  /* ⑤ 매핑 가중 합≠100 — 몰래 정규화하지 않고 분류별 배지로 알린다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    alt_map: { mode: "factor", eq_we: 200, eq_wb: 0, dt_we: 0, dt_wb: 100 } }));
  P.renderSection("alloc");
  r.sumBadgeShown = /⚠ 합 200%/.test(DOC.getElementById("alloc-controls").textContent);

  /* ⑥ 효율 갭 정직성 — 현재 배분이 밴드 밖이라 목표 μ 도달 불가면 그렇다고 적는다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    mix_acct: { "장부가 국내채권": 5, "시가 국내채권": 5, "장부가 해외채권": 5,
      "시가 해외채권": 5, 국내주식: 5, 해외주식: 65,
      "대체투자(지분형)": 4, "대체투자(대출형)": 1, 단기자금: 5 } }));
  P.renderSection("alloc");
  r.gapUnreachableFlagged = /도달 불가/.test(DOC.getElementById("alloc-char-card").textContent);

  /* ⑧ §7.7.9 이관 — 구 저장분(단일 「대체투자」 키·구 매핑)이 분할 축으로 옮겨지고
     합계가 보존되며, 렌더가 죽지 않는다. 대체투자 20 은 구 예시값(15)이 아니어서
     "사용자가 만진 숫자"로 취급돼 보존 분할되어야 한다. */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    mix_acct: { "장부가 국내채권": 30, "시가 국내채권": 12, "장부가 해외채권": 12,
      "시가 해외채권": 6, 국내주식: 3, 해외주식: 5, 대체투자: 20, 단기자금: 5 },
    bands: { 대체투자: [5, 25] },
    mu_over: { 대체투자: 5.5 },
    sig_over: { 대체투자: 9 },
    alt_map: { mode: "factor", w_eq: 50, w_bd: 50 } }));
  const stM = P.allocState(CMA_ALLOC);
  r.migSplitsMixPreservingSum = stM.mix["대체투자"] === undefined
    && Math.abs(stM.mix["대체투자(지분형)"] + stM.mix["대체투자(대출형)"] - 20) < 1e-9;
  r.migCopiesMuToBothClasses = stM.mu_over["대체투자(지분형)"] === 5.5
    && stM.mu_over["대체투자(대출형)"] === 5.5 && stM.mu_over["대체투자"] === undefined;
  r.migDropsLegacySigOver = stM.sig_over["대체투자"] === undefined;
  r.migMapsBandsToEquityClass = JSON.stringify(stM.bands["대체투자(지분형)"]) === "[5,25]"
    && Array.isArray(stM.bands["대체투자(대출형)"]);
  r.migAltMapGetsClassKeys = stM.alt_map.eq_we === 50 && stM.alt_map.dt_wb === 50
    && stM.alt_map.w_eq === undefined;
  P.renderSection("alloc");
  r.migRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;

  /* ⑨ 2026-08-12 이관 — 대출금 제외(강제 0)·구 예시 그대로인 저장분의 예시 교체·
     구 매핑 기본값(65/35·0/100) → 50/50·μ/북일드 디폴트 채움 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, loan_w: 12,
    mix_acct: { "장부가 국내채권": 30, "시가 국내채권": 12, "장부가 해외채권": 12,
      "시가 해외채권": 6, 국내주식: 3, 해외주식: 5,
      "대체투자(지분형)": 12, "대체투자(대출형)": 3, 단기자금: 5 },
    alt_map: { mode: "factor", eq_we: 65, eq_wb: 35, dt_we: 0, dt_wb: 100 } }));
  const stO = P.allocState(CMA_ALLOC);
  r.migLoanForcedZero = stO.loan_w === 0;
  const sumO = P.ALLOC_ECON.reduce((a, k) => a + stO.mix[k], 0);
  r.migOldExampleMixReplacedTo100 = Math.abs(sumO - 100) < 1e-9
    && stO.mix["국내채권"] === 48;
  r.migOldDefaultMapBecomesFiftyFifty = stO.alt_map.eq_we === 50 && stO.alt_map.eq_wb === 50
    && stO.alt_map.dt_we === 50 && stO.alt_map.dt_wb === 50;
  r.migFillsMuDefaults = stO.mu_over["국내주식"] === 6.29
    && stO.mu_over["대체투자(대출형)"] === 4.39;
  /* 구 북일드·회계 저장분은 폐기된다(§7.7.11) — 저장 스키마에서 지워져야 다음
     저장이 깨끗하다 */
  r.migDropsLegacyFields = stO.by_kr === undefined && stO.by_fx === undefined
    && stO.mix_acct === undefined && stO.bands_acct === undefined && stO.view === undefined;
  /* fold — 사용자가 만진 회계 9축 비중은 채권 쌍 합산으로 승계된다(합계 보존) */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    mix_acct: { "장부가 국내채권": 20, "시가 국내채권": 22, "장부가 해외채권": 10,
      "시가 해외채권": 11, 국내주식: 3, 해외주식: 5,
      "대체투자(지분형)": 12, "대체투자(대출형)": 3, 단기자금: 14 } }));
  const stF = P.allocState(CMA_ALLOC);
  r.migFoldsBondPairs = stF.mix["국내채권"] === 42 && stF.mix["해외채권"] === 21
    && Math.abs(P.ALLOC_ECON.reduce((a, k) => a + stF.mix[k], 0) - 100) < 1e-9;
  /* 사용자가 만진 매핑(60/40 등)은 이관이 건드리지 않는다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    alt_map: { mode: "factor", eq_we: 60, eq_wb: 40, dt_we: 0, dt_wb: 100 } }));
  r.migKeepsUserTunedMap = P.allocState(CMA_ALLOC).alt_map.eq_we === 60;

  /* ⑩ μ 디폴트 갱신 전파(2026-08-12 실측 사고) — 옛 저장분이 새 디폴트를 영영
     덮어 대체투자 두 분류가 같은 μ 로 굳어 있었다. `mu_dflt` 스냅숏으로 "자동
     채움"과 "사용자 키인"을 구분해, 전자만 새 디폴트로 갱신되어야 한다. */
  const D1 = { ...CMA_ALLOC, defaults: { ...CMA_ALLOC.defaults,
    mu_over: { ...CMA_ALLOC.defaults.mu_over, "대체투자(지분형)": 6.86 } } };
  const D2 = { ...CMA_ALLOC, defaults: { ...CMA_ALLOC.defaults,
    mu_over: { ...CMA_ALLOC.defaults.mu_over, "대체투자(지분형)": 7.5 } } };
  shim.localStorage.removeItem("iaw-alloc");
  const sA = P.allocState(D1);                       // 디폴트 자동 채움
  r.dfltFillsAndStamps = sA.mu_over["대체투자(지분형)"] === 6.86
    && sA.mu_dflt["대체투자(지분형)"] === 6.86;
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ ...sA, saved: true }));
  const sB = P.allocState(D2);                       // 디폴트가 바뀌면 따라간다
  r.dfltUpdatePropagates = sB.mu_over["대체투자(지분형)"] === 7.5;
  /* 사용자가 손댄 값은 디폴트가 바뀌어도 유지된다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({
    ...sA, saved: true, mu_over: { ...sA.mu_over, "대체투자(지분형)": 9.9 } }));
  const sC = P.allocState(D2);
  r.dfltKeepsUserKeyedValue = sC.mu_over["대체투자(지분형)"] === 9.9;
  /* 스냅숏이 없는 옛 저장분(사고 상태)은 유지되지만 — 화면이 표시로 알리고
     「μ·σ 디폴트로 되돌리기」 버튼이 한 번에 정리한다(아래 ⑪) */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    mu_over: { "대체투자(대출형)": 4.39, "대체투자(지분형)": 4.39 } }));
  const sD = P.allocState(D1);
  r.legacyStaleStateSurvivesUntilReset = sD.mu_over["대체투자(지분형)"] === 4.39;
  P.DATA.alloc = D1;
  P.renderSection("alloc");
  const offMark = DOC.getElementById("alloc-sim-panel").querySelectorAll(".keyed-off-default").length;
  r.offDefaultIsMarked = offMark >= 1;
  /* ⑪ 「μ·σ 디폴트로 되돌리기」 — 눌러야만 게시 디폴트로 돌아간다(명시적 조작) */
  const resetBtn = Array.from(DOC.getElementById("alloc-controls").querySelectorAll("button"))
    .find((n) => /μ·σ 디폴트로 되돌리기/.test(n.textContent));
  r.muResetButtonExists = !!resetBtn;
  if (resetBtn) resetBtn.click();
  const sE = P.allocState(D1);
  r.muResetRestoresDefaults = sE.mu_over["대체투자(지분형)"] === 6.86
    && sE.mu_over["대체투자(대출형)"] === 4.39;
  r.muResetClearsSigOver = P.ALLOC_ECON.every((k) => sE.sig_over[k] == null);
  shim.localStorage.removeItem("iaw-alloc");
  P.DATA.alloc = CMA_ALLOC;

  /* ⑦ 복구된 화면은 고장 배너를 걷는다 */
  shim.localStorage.removeItem("iaw-alloc");
  const realA = P.RENDERERS.alloc;
  P.RENDERERS.alloc = () => { throw new Error("probe: 일부러 실패"); };
  P.renderSection("alloc");
  const had = DOC.getElementById("alloc").querySelectorAll(".render-error").length === 1;
  P.RENDERERS.alloc = realA;
  P.renderSection("alloc");
  r.bannerClearedAfterRecovery = had &&
    DOC.getElementById("alloc").querySelectorAll(".render-error").length === 0;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-f. 포트폴리오 시뮬레이터(§7.7.8) — μ·σ 키인·최적·막대·도넛 ======
   ① 재분배 순수 함수 손계산 ② σ 키인 = (키인/실측)² 배 분산 + 상관 불변 + 앵커
   비오염 ③ 패널 렌더(막대 8·▼ 마커 = 최적화 산출·도넛·카드) ④ 합계 유지 모드
   ⑤ 프록시층 강등을 전부 실행으로 잰다. */
safe("simPanel", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");

  /* ① 재분배 — 합 유지·값 고정·클램프·0-나머지 균등 (목표 100 — 대출금 제외) */
  const mix0 = { 국내채권: 48, 해외채권: 21, 국내주식: 3, 해외주식: 6,
    "대체투자(대출형)": 3, "대체투자(지분형)": 13, 단기자금: 6 };   // 합 100
  const tot = (m) => Object.values(m).reduce((a, b) => a + b, 0);
  const m1 = P.allocRedistribute(mix0, "해외주식", 25, 100);
  /* 0.1%p 단위(2026-08-12) — 최대잔여법이라 합계가 목표와 **정확히** 같아야 한다 */
  r.lockKeepsSum = Math.abs(tot(m1) - 100) < 1e-9;
  r.lockValuesAre1dp = Object.values(m1).every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9);
  r.lockSetsValue = Math.abs(m1["해외주식"] - 25) < 1e-9;
  r.lockClamps = Math.abs(P.allocRedistribute(mix0, "해외주식", 250, 100)["해외주식"] - 100) < 0.1;
  const zeros = Object.fromEntries(Object.keys(mix0).map((k) => [k, k === "해외주식" ? 50 : 0]));
  r.lockSplitsEquallyWhenOthersZero = Math.abs(tot(P.allocRedistribute(zeros, "해외주식", 30, 100)) - 100) < 1e-9;

  /* ② σ 키인 — 실측 30% 를 15% 로: 분산 1/4, 상관 불변, 앵커 관측 유지, 주식 μ 하락.
     μ 하락 검사는 앵커 폴백 경로의 성질이므로 μ 키인을 비운 상태에서 잰다(§7.7.10 —
     키인(디폴트 포함)이 있으면 μ 는 최종치라 σ 와 무관해야 한다). */
  const st0 = P.allocDefaults(CMA_ALLOC);
  const stAnchor = { ...st0, mu_over: {} };
  const E0c = P.allocEngine(CMA_ALLOC, stAnchor);
  const iEq = P.ALLOC_ECON.indexOf("국내주식"), iFb = P.ALLOC_ECON.indexOf("해외채권");
  const ES = P.allocEngine(CMA_ALLOC, { ...stAnchor, sig_over: { ...st0.sig_over, 국내주식: 15 } });
  r.sigmaScales = Math.abs(ES.V.C[iEq][iEq] - E0c.V.C[iEq][iEq] / 4) < 1e-9;
  const corr = (E, i, j) => E.V.C[i][j] / Math.sqrt(E.V.C[i][i] * E.V.C[j][j]);
  r.corrPreserved = Math.abs(corr(ES, iEq, iFb) - corr(E0c, iEq, iFb)) < 1e-9;
  r.anchorUnpolluted = Math.abs(ES.V.anchor.kr.sigma - E0c.V.anchor.kr.sigma) < 1e-12;
  r.equityMuFollowsKeyedSigma = ES.V.mu[iEq] < E0c.V.mu[iEq] - 1e-9;
  /* 키인(디폴트) μ 는 σ 키인과 무관 — 최종치 계약 */
  const ESd = P.allocEngine(CMA_ALLOC, { ...st0, sig_over: { ...st0.sig_over, 국내주식: 15 } });
  const E0d = P.allocEngine(CMA_ALLOC, st0);
  r.keyedMuUnaffectedBySigma = Math.abs(ESd.V.mu[iEq] - E0d.V.mu[iEq]) < 1e-12;

  /* ③ 렌더 — 목차 첫 버튼·막대 8·▼ = 최적 위치·도넛 2·카드 2·상관 정책 문구 */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const panel = DOC.getElementById("alloc-sim-panel");
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.tocFirstIsSim =
    (DOC.getElementById("alloc-toc").querySelectorAll("button")[0] || {}).textContent === "시뮬레이터";
  /* **비중 막대만** 센다 — §7.7.15 에서 헤지 슬라이더도 같은 .sim-bar-wrap 래퍼를
     쓰게 되어(최적 ▼ 마커 공유) 패널 전체 셀렉터는 9개를 세게 됐다. 축이 다른 둘을
     한 수로 묶으면 어느 쪽이 깨져도 이 검사가 거짓말한다 — 행(.sim8-row)으로 좁힌다.
     헤지 쪽 개수·마커는 hedgeTracks 프로브가 따로 잰다. */
  r.barCount = panel.querySelectorAll(".sim8-row .sim-bar-wrap").length;
  r.markerVisibleCount = Array.from(panel.querySelectorAll(".sim8-row .sim-opt-mark"))
    .filter((n) => !n.hidden).length;
  r.donutCount = panel.querySelectorAll("svg").length;
  const ptxt = panel.textContent;
  r.hasOptCard = /① 최적 포트폴리오/.test(ptxt);
  r.hasSimCard = /② 지금 시뮬레이션/.test(ptxt);
  r.statesCorrPolicy = /상관은 벤치마크 실측/.test(ptxt);
  /* 도넛이 각자 자기 카드의 열(sim8-col) 안에 있다 — 카드 아래 중앙 배치의 구조 검증.
     최적 열: 최적 카드 + 「최적 포트폴리오 비중」 도넛 / 시뮬 열: 시뮬 카드 + 「시뮬레이션 비중」. */
  const cols9 = [...panel.querySelectorAll(".sim8-col")];
  r.donutColumns = cols9.length;
  const colHas = (re, reDonut) => cols9.some((c) =>
    re.test(c.textContent) && reDonut.test(c.textContent) && c.querySelectorAll("svg").length === 1);
  r.optDonutUnderOptCard = colHas(/① 최적 포트폴리오/, /최적 포트폴리오 비중/);
  r.simDonutUnderSimCard = colHas(/② 지금 시뮬레이션/, /시뮬레이션 비중/);
  /* 도넛 크기 — 210 (구 132 에서 확대, 2026-08-12 사용자 지시) */
  const svg0 = panel.querySelector(".sim8-donut svg");
  r.donutSize = svg0 ? +svg0.getAttribute("width") : null;
  /* CMA 층에서 대체투자 두 분류의 σ 키인만 비활성 — 매핑 콘솔이 정본이라서 */
  const sigInputsCma = Array.from(panel.querySelectorAll("input"))
    .filter((n) => (n.getAttribute("aria-label") || "").includes("위험 % 키인"));
  r.cmaAltSigDisabled = sigInputsCma.filter((n) => n.disabled).length === 2
    && sigInputsCma.filter((n) => n.disabled)
      .every((n) => (n.getAttribute("placeholder") || "") === "매핑이 정함");
  /* 실측 σ 자리표시자 — "적용 중"이 붙어 미반영으로 오독되지 않는다(2026-08-12) */
  r.sigPlaceholderSaysApplied = sigInputsCma
    .filter((n) => !n.disabled)
    .every((n) => /실측 [\d.]+ 적용 중/.test(n.getAttribute("placeholder") || ""));
  const Ea = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
  const wOpt = P.allocJointOpt(Ea, P.allocDefaults(CMA_ALLOC)).w;   // ① = 배분+헤지 동시(§7.7.13)
  const mark0 = panel.querySelectorAll(".sim-opt-mark")[0];
  r.markerMatchesOptimum = Math.abs(parseFloat(mark0.style.left) - wOpt[0] * 100) < 0.6;

  /* ⑥ 최적 불변(목표 100% 기준) + 「막대를 최적 비중으로」 버튼 — 2026-08-12 사용자
     발견·요청. 엔진: 합계가 표류해도 optimizeUtilAt(…, 1) 해가 같아야 한다.
     화면: 자유 조정으로 합계를 흩뜨려도 ▼ 위치가 그대로여야 하고, 버튼을 누르면
     막대 = 최적·합계 100·경고 없음·저장 안 됨이어야 한다. */
  const stDrift = P.allocDefaults(CMA_ALLOC);
  stDrift.mix = { ...stDrift.mix, 해외주식: 26 };                      // 합 120 으로 표류
  const Edrift = P.allocEngine(CMA_ALLOC, stDrift);
  const wOptDrift = P.allocJointOpt(Edrift, stDrift).w;
  r.optimumIgnoresMixDrift = wOpt.every((x, i) => Math.abs(x - wOptDrift[i]) < 1e-12);
  const markPos = () => Array.from(panel.querySelectorAll(".sim-opt-mark")).map((n) => n.style.left);
  const marksBefore = JSON.stringify(markPos());
  const drag = DOC.getElementById("sim-mix-해외주식");
  drag.value = "26";
  drag.dispatchEvent({ type: "input", target: drag });
  drag.dispatchEvent({ type: "change", target: drag });
  r.optMarkersStableUnderDrift = JSON.stringify(markPos()) === marksBefore;
  const applyBtn = Array.from(panel.querySelectorAll("button"))
    .find((n) => /최적 비중으로/.test(n.textContent));
  r.applyButtonExists = !!applyBtn;
  if (applyBtn) applyBtn.click();
  /* id 로 읽되 getElementById 를 쓰지 않는다 — 셰이드의 getElementById 는
     querySelector("#id") 위임이라 괄호가 든 id(대체투자(대출형))를 못 찾는다.
     실제 브라우저의 getElementById 는 문제없다(문자 제한 없음) — 프로브 한정 우회. */
  const mixById = {};
  Array.from(panel.querySelectorAll("input"))
    .filter((n) => (n.id || "").startsWith("sim-mix-"))
    .forEach((n) => { mixById[n.id.slice("sim-mix-".length)] = n; });
  const mixVals = P.ALLOC_ECON.map((k) =>
    +(mixById[k.replace(/\s+/g, "-")] || { value: NaN }).value);
  const sumApplied = mixVals.reduce((a, b) => a + b, 0);
  r.applyMakesSum100 = Math.abs(sumApplied - 100) < 1e-9;   // 0.1 단위 잔차 흡수 — 정확히 100.0
  /* 0.1%p 반올림 + 최대비중 잔차 흡수(최대 ±0.35) — 그 안이어야 한다 */
  r.applyMatchesOptimum = mixVals.every((v, i) => Math.abs(v - wOpt[i] * 100) < 0.4);
  r.applyValuesAre1dp = mixVals.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9);
  r.applyClearsSumWarning = !panel.querySelector(".sim-sum").classList.contains("warn");
  r.applyDoesNotSave = shim.localStorage.getItem("iaw-alloc") == null;

  /* ④ 합계 100% 유지 모드 — 숫자 입력 하나가 나머지를 재분배해 합을 지킨다 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, sum_lock: true }));
  P.renderSection("alloc");
  const inp = DOC.getElementById("sim-mix-해외주식");
  inp.value = "25";
  inp.dispatchEvent({ type: "input", target: inp });
  const mixInputs = Array.from(DOC.getElementById("alloc-sim-panel").querySelectorAll("input"))
    .filter((n) => (n.id || "").startsWith("sim-mix-"));
  const sumNow = mixInputs.reduce((a, n) => a + (+n.value || 0), 0);
  r.lockModeRedistributesInUi = Math.abs(sumNow - 100) < 0.2 && Math.abs(+inp.value - 25) < 1e-9;

  /* ⑤ 프록시층 — σ 키인 비활성·최적 보류 안내(조용한 강등 금지) */
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const p2 = DOC.getElementById("alloc-sim-panel");
  const sigInputs = Array.from(p2.querySelectorAll("input"))
    .filter((n) => (n.getAttribute("aria-label") || "").includes("위험 % 키인"));
  r.proxySigDisabled = sigInputs.length === 7 && sigInputs.every((n) => n.disabled === true);
  r.proxyOptDeferred = /최적 포트폴리오 — 보류/.test(p2.textContent);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P-port. 포트폴리오 구성(신규 7자산군 · §7.14) — 실행으로 잰다 ==========
   ① 대분류 디폴트(50/30/20/10)와 적용 규칙(비례 축소·그룹 내 균등·합계 100.0)
   ② 2트랙 저장(비중 = 저장 안 함 / μ 키인 = 즉시 저장) ③ CMA 파일 디폴트 표시
   ④ 효율적 경계선 hover 상세 ⑤ 벤치마크 리뷰 표 ⑥ 창 미충족 경고의 가시성. */
safe("portPanel", () => {
  const r = {};
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem("iaw-alloc");
  shim.localStorage.removeItem(P.PORT_LS_KEY);
  shim.UPlotStub.made.length = 0;
  P.renderSection("alloc");
  const panel = DOC.getElementById("alloc-port-panel");
  r.panelRendered = /포트폴리오 구성/.test(panel.textContent);
  /* 패널이 시뮬레이터보다 위(제일 상단)인가 — DOM 순서로 잰다 */
  const kids = DOC.getElementById("alloc").childNodes;
  r.panelAboveSim = kids.indexOf(panel) >= 0 &&
    kids.indexOf(panel) < kids.indexOf(DOC.getElementById("alloc-sim-panel"));

  /* ① 대분류 디폴트 + 적용 */
  const gIn = Array.from(panel.querySelectorAll("input"))
    .filter((n) => (n.getAttribute("aria-label") || "").startsWith("대분류"));
  r.groupDefaults = gIn.map((n) => +n.value);          // [50, 30, 20, 10]
  const applyBtn = Array.from(panel.querySelectorAll("button"))
    .find((b) => b.textContent === "7자산군에 적용");
  applyBtn.dispatchEvent({ type: "click", target: applyBtn });
  const mixIn = Array.from(panel.querySelectorAll("input"))
    .filter((n) => /비중$/.test(n.getAttribute("aria-label") || ""));
  const mixVals = mixIn.map((n) => +n.value);
  r.applySum = mixVals.reduce((a, b) => a + b, 0);     // 100 정확
  r.applyMix = mixVals;                                // [13.5,13.5,22.5,22.5,18,5,5]
  const la = mixIn.map((n) => n.getAttribute("aria-label"));
  const vOf = (name) => mixVals[la.indexOf(`${name} 비중`)];
  r.liqEqualSplit = vOf("달러유동성") === vOf("원화유동성");
  r.applyDoesNotSave = shim.localStorage.getItem(P.PORT_LS_KEY) == null;

  /* ② 비중 입력도 저장하지 않는다 / μ 키인은 즉시 저장한다 */
  const wIn = mixIn[0];
  wIn.value = "20";
  wIn.dispatchEvent({ type: "input", target: wIn });
  r.mixInputDoesNotSave = shim.localStorage.getItem(P.PORT_LS_KEY) == null;
  const muIn = Array.from(panel.querySelectorAll("input"))
    .find((n) => (n.getAttribute("aria-label") || "") === "국내채권 기대수익");
  muIn.value = "4.2";
  muIn.dispatchEvent({ type: "input", target: muIn });
  const savedRaw = shim.localStorage.getItem(P.PORT_LS_KEY);
  r.muInputSavesImmediately = savedRaw != null && JSON.parse(savedRaw).mu["국내채권"] === 4.2;

  /* ③ μ 출처 — 키인 > CMA 파일 > 과거 평균. 열이 아니라 키인 칸 아래 주석(.port-src)이고
     (2026-08-23 사용자 지시), 그 자리는 실현 μ(선택 창) 열이 받았다 */
  r.srcAfterKeyin = Array.from(panel.querySelectorAll(".port-src"))
    .some((n) => n.textContent === "키인");
  r.srcShowsCmaFile = Array.from(panel.querySelectorAll(".port-src"))
    .some((n) => n.textContent === "CMA 파일");
  r.srcIsAnnotationNotColumn = !Array.from(panel.querySelectorAll("th"))
    .some((n) => /μ 출처/.test(n.textContent));
  const pTh = Array.from(panel.querySelectorAll(".port-table th")).map((n) => n.textContent);
  r.realizedColShown = pTh.some((t) => /^실현 μ %/.test(t));
  /* 실현 μ 열의 값이 게시 창 평균과 일치하는가 — 국내채권 행(첫 행), 픽스처 pmean[0]=2.0 */
  const row0 = panel.querySelector(".port-table tbody tr");
  r.realizedMatchesWindowMean = !!row0
    && Array.from(row0.querySelectorAll("td")).some((n) => n.textContent === "2.00");

  /* ④ 효율적 경계선 — 차트가 실제로 만들어지고 hover 훅이 상세를 적는가.
     recalc 마다 다시 만들므로 **마지막** 인스턴스를 집는다(앞 것의 hover 는 떼어졌다). */
  const chart = shim.UPlotStub.made.filter((u) =>
    u.opts && u.opts.series && u.opts.series.some((s) => s.label === "경계선")).pop();
  r.frontierChartMade = !!chart;
  const hook = chart && chart.opts.hooks && chart.opts.hooks.setCursor
    && chart.opts.hooks.setCursor[0];
  r.hoverHookPresent = typeof hook === "function";
  if (hook) {
    hook({ cursor: { idx: 2 } });
    const hv = panel.querySelector(".port-hover");
    r.hoverShowsDetail = /배분/.test(hv.textContent) && /국내채권/.test(hv.textContent)
      && /위험/.test(hv.textContent);
    hook({ cursor: { idx: null } });
    r.hoverResets = /마우스를 올리면/.test(hv.textContent);
  }
  /* 경계선 점들이 위험 오름차순·수익 비내림인가 (게시가 아니라 엔진 실행으로) */
  const E = P.portEngine(ALLOC_FIXTURE.port, P.portState(ALLOC_FIXTURE.port));
  r.frontierMonotone = E.front.every((p, i, arr) => !i
    || (p.sig >= arr[i - 1].sig - 1e-9 && p.mu >= arr[i - 1].mu - 1e-6));
  r.frontierMaxSharpeBeatsBench = E.maxSharpe
    && (E.maxSharpe.mu - E.rf) / E.maxSharpe.sig
       >= (E.bench.mu - E.rf) / E.bench.sig - 1e-9;

  /* ⑤ 벤치마크 리뷰 표 + 실현 성과 참고 줄 */
  const rvTxt = panel.textContent;
  r.reviewHasRows = /최적\(최대 샤프\)/.test(rvTxt) && /벤치마크 60\/40/.test(rvTxt);
  r.reviewShowsRealized = /실현 성과\(창/.test(rvTxt) && /실현 성과\(10년 참고/.test(rvTxt);

  /* ⑥ 10년 창 미충족 경고 — 접힌 설명(details.explain) 안이 아니라 본문에 있어야 한다 */
  const warnNode = Array.from(panel.querySelectorAll(".port-warn"))
    .find((n) => /창 미충족/.test(n.textContent));
  let warnFolded = false;
  for (let anc = warnNode; anc; anc = anc.parentElement)
    if ((anc.className || "").split(/\s+/).includes("explain")) warnFolded = true;
  r.missingWindowWarnVisible = !!warnNode && !warnFolded;

  /* ⑦ 합계 ≠ 100 이면 현재점을 몰래 정규화하지 않고 사유를 적는다 */
  r.sumWarnAfterDrift = /100% 가 아니라 현재점을 계산하지 않았습니다/.test(panel.textContent);

  /* ⑦b 기본 창 = 최장 공통 표본(all) — 저장이 없을 때 가장 긴 창이 기본이고
     화면이 그 사실을 적는다 (2026-08-22 사용자 지시 "가능한 긴 표본") */
  r.defaultWindowLongest = /최장 공통 표본\(기본\)/.test(panel.textContent);

  /* ⑦c 원화유동성 CD 적립 참고 — 10년 참고가 없는 자리에 CD 수치가 참고 표기로
     들어오고, 출처·기간·실ETF 겹침 검증치는 툴팁에 있다 (참고 전용 — 행렬 미포함) */
  const cdSpan = Array.from(panel.querySelectorAll("span"))
    .find((n) => /CD 적립 참고/.test(n.textContent));
  r.cdRefShown = !!cdSpan && /3\.7 \/ 0\.5/.test(cdSpan.textContent);
  r.cdRefTooltipHasOverlap = !!cdSpan
    && /참고 전용/.test(cdSpan.getAttribute("title") || "")
    && /겹침 41개월 corr 0\.91/.test(cdSpan.getAttribute("title") || "");

  /* ⑧ 창 선택은 모형 입력 — 즉시 저장 */
  const segBtn = Array.from(panel.querySelectorAll(".seg button"))
    .find((b) => b.textContent === "3년");
  segBtn.dispatchEvent({ type: "click", target: segBtn });
  const saved2 = JSON.parse(shim.localStorage.getItem(P.PORT_LS_KEY) || "{}");
  r.windowChoiceSaved = saved2.win === "3";
  /* 최장 표본 표기는 all 창에만 붙는다 — 3년 창으로 바꾸면 사라져야 한다 */
  r.longestMarkOnlyOnAll = !/최장 공통 표본\(기본\)/.test(
    DOC.getElementById("alloc-port-panel").textContent);

  /* ⑨ 비활성 블록 — 조용히 사라지지 않고 사유를 적는다 */
  P.DATA.alloc = { ...ALLOC_FIXTURE, port: { active: false, reason: "probe 사유" } };
  P.renderSection("alloc");
  r.inactiveShowsReason = /비활성 — probe 사유/.test(
    DOC.getElementById("alloc-port-panel").textContent);
  P.DATA.alloc = ALLOC_FIXTURE;
  shim.localStorage.removeItem(P.PORT_LS_KEY);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-j. μ 기준일 컷(§7.7.16) — σ 표본을 μ 기준일에 맞춰 잘랐음을 밝히는가 ==
   조용히 자르면 사용자는 σ 가 최신이라고 믿는다(μ·σ 시점 불일치의 반대 방향 사고).
   화면이 ① 컷 날짜 ② 데이터는 어디까지 있는지 두 수를 모두 말해야 한다. */
/* ====== 수익률 추정 (§7.8) — 연환산 산식·주식 제외·자동 채움 ==================
   합성 지수를 직접 만들어 **손계산과 대조**한다. 값이 그럴듯하기만 하면 통과하는
   검사는 이 화면에서 특히 위험하다 — 연환산 계수를 잘못 잡아도 숫자는 여전히
   "수익률처럼" 보이기 때문이다. */
const EST_FIXTURE = (() => {
  /* 2025-01-01 ~ 2026-12-31 일별. 2025 년말을 정확히 1000 으로 놓고 2026-06-30 을
     1200 으로 놓아 YTD 가 **정확히 +20%** 가 되게 만든다(손계산 앵커). */
  const t = [], v = [];
  const start = Date.UTC(2025, 0, 1), end = Date.UTC(2026, 11, 31);
  const y0 = Date.UTC(2025, 11, 31), y1 = Date.UTC(2026, 5, 30);
  for (let d = start; d <= end; d += 86400000) {
    t.push(Math.floor(d / 1000));
    /* 구간 선형: 연말 1000 → 6/30 1200 → 이후 완만. 어느 날을 집어도 결정적이다. */
    v.push(d <= y0 ? 900 + 100 * (d - start) / (y0 - start)
         : d <= y1 ? 1000 + 200 * (d - y0) / (y1 - y0)
         : 1200 + 60 * (d - y1) / (end - y1));
  }
  const mk = (key, asset, label, ok) => ({
    key, asset, label, src: `test:${key}`,
    basis: ok ? "총수익 지수(배당 포함)" : "가격지수(배당 미포함, PR)",
    basis_matches_request: ok, caveat: ok ? "" : "TR 이 아니라 PR 입니다",
    t, v, year_end: { 2024: { v: 900, d: "2024-12-31" }, 2025: { v: 1000, d: "2025-12-31" },
                     /* 2026 앵커가 있어야 "기준일이 데이터 밖" 케이스를 만들 수 있다 */
                     2026: { v: 1260, d: "2026-12-31" } },
    first: "2025-01-01", last: "2026-12-31",
  });
  /* 시장 축은 **평평하게** 둔다 — 기준일 수준이 결정적이어야 「수준 키인」(§7.12)을
     손계산과 대조할 수 있고, 자동 변화가 0 이라 키인 효과만 따로 잰다. */
  const flat = (val) => ({ t, v: t.map(() => val), first: "2025-01-01", last: "2026-12-31" });
  return {
    active: true, asof: "2026-12-31",
    indices: [mk("kospi_tr", "국내주식", "KOSPI TR", true),
              mk("acwi", "해외주식", "MSCI ACWI", false)],
    axes: [
      { key: "kr_rate", label: "국고", kind: "rate", unit: "bp", src: "t",
        level_unit: "%", level_dp: 2, note: "국내채권", ...flat(3.0) },
      { key: "us_rate", label: "미국채", kind: "rate", unit: "bp", src: "t",
        level_unit: "%", level_dp: 2, note: "해외채권", ...flat(4.0) },
      { key: "usdkrw", label: "달러원", kind: "price", unit: "%", src: "t",
        level_unit: "원", level_dp: 1, note: "환효과", ...flat(1300) },
      { key: "swap", label: "스왑", kind: "rate", unit: "bp", src: "t",
        level_unit: "%", level_dp: 2, note: "스왑 MTM", ...flat(-2.0) },
      { key: "kospi", label: "KOSPI TR", kind: "price", unit: "%", index: "kospi_tr",
        level_unit: "", level_dp: 1, note: "국내주식" },
      { key: "acwi", label: "ACWI", kind: "price", unit: "%", index: "acwi",
        level_unit: "", level_dp: 1, note: "해외주식" },
    ],
    unavailable: [{ assets: ["시가 해외채권 직접", "장부가 해외채권"],
                    want: "미국채 총수익 지수",
                    reason: "보유 시리즈는 전부 금리(yield)입니다", have_kind: "금리(yield)" }],
    annualize: { basis: "days", day_count: 365, note: "주식은 연환산하지 않습니다" },
    scenario: {
      formula: "F", terms: ["a"], book_value: "BV", limits: "L",
      cumulative: "CUM", cross_year: "XY", size_carry: "SIZE",
      hedge_band: { lo: 0, hi: 105, step: 1, note: "HB" },
      row_modes: [{ asset: "대체투자", mode: "carry", why: "가격 축 없음" }],
    },
  };
})();

/* ====== 정보구조 개편 (§7.9) — 개요가 시장 화면의 입구가 되었는가 ============== */
safe("infoArchitecture", () => {
  const r = {};
  const card = (key, label, group, link, v) => ({
    key, label, kind: "price", unit: "", group, link, value: v, date: "2026-06-30",
    chg: { d1: 0.1, m1: 0.2, ytd: 0.3, y1: 0.4 },
    spark: { t: [1, 2, 3], v: [1, 2, 3] },
  });
  const OV = {
    groups: [
      { key: "equity", label: "주식", sections: ["acwi"] },
      { key: "rate", label: "금리", sections: ["rates", "irs"] },
      { key: "fx", label: "환율", sections: ["fx"] },
      { key: "other", label: "기타", sections: ["credit", "inflation", "macro"] },
    ],
    /* 일부러 **구역 순서와 섞어서** 넣는다 — 렌더가 payload 의 groups 순서를 따르는지
       보려는 것이다(카드 배열 순서를 그대로 쓰면 이 검사가 통과하지 못한다). */
    cards: [card("a", "미 HY", "other", "credit", 2.6),
            card("b", "MSCI ACWI", "equity", "acwi", 1117),
            card("c", "달러/원", "fx", "fx", 1555),
            card("d", "국고 3년", "rate", "rates", 3.87),
            card("e", "VIX", "equity", "", 15.8),
            card("f", "WTI", "other", "", 75)],
  };
  P.DATA.overview = OV;
  P.renderSection("overview");
  const sec = DOC.getElementById("overview");
  r.renderErrors = sec.querySelectorAll(".render-error").length;

  const groups = Array.from(DOC.querySelectorAll(".ov-group"));
  r.groupCount = groups.length;
  r.groupOrderFollowsPayload = groups.map((g) =>
    (g.querySelector(".ov-group-title") || {}).textContent).join(",") === "주식,금리,환율,기타";
  r.cardsGroupedNotFlat = groups.map((g) => g.querySelectorAll(".kpi").length).join(",") === "2,1,1,2";

  /* 겹치는 지표는 **그 화면으로 들어가는 링크**여야 한다(사용자 지시) */
  const acwi = Array.from(DOC.querySelectorAll(".kpi"))
    .find((n) => /MSCI ACWI/.test(n.textContent));
  r.overlappingCardIsLink = acwi.tagName === "A" && acwi.getAttribute("href") === "#acwi";
  r.linkCardHasAriaLabel = /MSCI ACWI 화면으로/.test(acwi.getAttribute("aria-label") || "");
  /* 전용 화면이 없는 카드는 링크가 **아니어야** 한다 — 눌러도 무동작이면 고장으로 읽힌다 */
  const vix = Array.from(DOC.querySelectorAll(".kpi")).find((n) => /VIX/.test(n.textContent));
  r.cardWithoutScreenIsNotLink = vix.tagName !== "A" && !vix.getAttribute("href");
  r.everyLinkPointsAtRealSection = Array.from(DOC.querySelectorAll(".kpi-link"))
    .every((n) => P.SECTION_IDS.includes(n.getAttribute("href").slice(1)));

  /* 구역 머리의 상세 화면 버튼 */
  const rateHead = groups[1].querySelectorAll(".sec-link");
  r.groupHeadLinks = Array.from(rateHead).map((n) => n.getAttribute("href")).join(",");
  r.groupHeadUsesSectionTitles = /금리/.test(rateHead[0].textContent)
    && /IRS 포워드/.test(rateHead[1].textContent);

  /* 카탈로그는 개요 맨 아래 한 줄로만 남는다 */
  const cat = DOC.getElementById("ov-catalog").querySelector("a");
  r.catalogEntryExists = !!cat && cat.getAttribute("href") === "#catalog";

  /* 위험 점수 카드는 개요에서 **빠졌다**(리스크 화면에 있는 내용 — 사용자 지시) */
  r.riskScoreCardsGone = DOC.querySelectorAll(".kpi-risk").length === 0
    && !/prependRiskCards/.test(String(P.renderSection));

  /* 옛 페이로드(groups 없음)에서도 화면이 비지 않아야 한다 */
  P.DATA.overview = { cards: OV.cards };
  P.renderSection("overview");
  r.legacyPayloadStillRenders = DOC.querySelectorAll("#ov-groups .kpi").length === 6
    && DOC.getElementById("overview").querySelectorAll(".render-error").length === 0;

  /* 섹션 이름표가 SECTION_IDS 전부를 덮는가 — 버튼 이름이 도착 화면과 어긋나면
     사용자는 다른 화면에 왔다고 느낀다 */
  r.labelsCoverEverySection = P.SECTION_IDS.every((id) => !!P.SECTION_LABELS[id]);

  P.DATA.overview = OV;
  return r;
});

safe("estimateCalc", () => {
  const r = {};
  const A = EST_FIXTURE;

  /* ① 경과일수·계수 — 2026-06-30 은 전년 12/31 로부터 181일 */
  const dc = P.estDayCount("2026-06-30");
  r.daysFromPriorYearEnd = dc.days;                       // 181
  r.baseIsPriorYearEnd = dc.base === "2025-12-31";
  r.factorIsDayCount = Math.abs(dc.factor - 365 / 181) < 1e-12;
  /* 월수 기준이면 정확히 2.0 이다 — 일수 기준을 골랐으므로 2.0 이 **아니어야** 한다 */
  r.factorIsNotMonthBased = Math.abs(dc.factor - 2) > 1e-6;
  r.rejectsBadDate = P.estDayCount("2026-6-30") === null && P.estDayCount("") === null;

  /* ② 지수 YTD — 픽스처가 정확히 +20% 가 되게 만들어져 있다 */
  const ix = A.indices[0];
  const y = P.estIndexYtd(ix, "2026-06-30");
  r.ytdExact = Math.abs(y.ytd - 0.20) < 1e-9;
  r.ytdUsesPriorYearEndAnchor = y.base.d === "2025-12-31" && y.base.v === 1000;
  r.ytdReportsObservationDate = y.obs.d === "2026-06-30";
  /* 앵커가 없는 해는 조용히 0 이 아니라 **오류를 돌려준다** */
  r.missingAnchorErrors = !!P.estIndexYtd(ix, "2024-06-30").error;

  /* ③ 엔진 — 손계산 대조. **입력이 그 자체로 연환산 수익률이다**(§7.11 — 2026-08-13
     사용자 지시). 화면이 계수를 다시 곱하면 이중 연환산이므로 곱하지 않는다.
     주식은 애초에 연환산 대상이 아니라 연초이후 지수 변화 그대로다. */
  const st = { asof: "2026-06-30",
    amt: { "장부가 국내채권": 6000, "국내주식": 2000, "대체투자": 2000 },
    ret: { "장부가 국내채권": 1.5, "대체투자": 3.0 }, dur: { "장부가 국내채권": 5 } };
  const E = P.estEngine(A, st);
  const f = 365 / 181;
  const row = (k) => E.rows.find((x) => x.key === k);
  r.equityUsesIndexYtd = Math.abs(row("국내주식").r - 0.20) < 1e-9;
  r.keyedInputNotReAnnualized = Math.abs(row("장부가 국내채권").r - 0.015) < 1e-15
    && Math.abs(row("대체투자").r - 0.03) < 1e-15;
  /* 계수를 곱하던 옛 동작이 되살아나면 여기서 깨진다(1.50% → 3.02% 였다) */
  r.noDoubleAnnualization = Math.abs(row("장부가 국내채권").r - 0.015 * f) > 1e-6;
  r.appliedFieldRemoved = row("장부가 국내채권").applied === undefined
    && row("장부가 국내채권").factor === undefined;
  r.profitUsesInputDirectly = Math.abs(row("장부가 국내채권").profit - 6000 * 0.015) < 1e-12;
  const manual = (6000 * 0.015 + 2000 * 0.20 + 2000 * 0.03) / 10000;
  r.portfolioMatchesHandCalc = Math.abs(E.port - manual) < 1e-15;
  r.totalAmt = E.totalAmt;
  /* 기여도 합 = 포트폴리오 수익률 (항등식) */
  const csum = E.rows.reduce((a, x) => a + (x.contrib || 0), 0);
  r.contribSumsToPortfolio = Math.abs(csum - E.port) < 1e-15;
  /* 「미연환산 참고치」는 폐지됐다 — 입력이 곧 연환산이면 본치와 같은 수라 두 칸이 될 수 없다 */
  r.periodReferenceRemoved = E.portPeriod === undefined;
  r.bondDurationWeighted = E.durW === 5;

  /* ④ 자동 vs 수기 — 수기값이 자동을 이기고, 지우면 자동으로 돌아간다 */
  r.autoUsedWhenBlank = row("해외주식").source === "자동"
    && Math.abs(row("해외주식").r - 0.20) < 1e-9;
  const stKeyed = { ...st, ret: { ...st.ret, "해외주식": 5 } };
  const keyed = P.estEngine(A, stKeyed).rows.find((x) => x.key === "해외주식");
  r.keyedBeatsAuto = keyed.source === "수기" && Math.abs(keyed.r - 0.05) < 1e-12;
  const stCleared = { ...st, ret: { ...st.ret, "해외주식": null } };
  const cleared = P.estEngine(A, stCleared).rows.find((x) => x.key === "해외주식");
  r.clearingRevertsToAuto = cleared.source === "자동";
  /* 규모는 있는데 수익률이 비면 **0 으로 대체하지 않고** 미입력으로 센다 */
  const stMiss = { asof: "2026-06-30", amt: { "대출금": 500 }, ret: {}, dur: {} };
  const EM = P.estEngine(A, stMiss);
  r.missingReturnFlagged = EM.missingRet.length === 1 && EM.missingRet[0].key === "대출금";
  r.missingReturnNotZeroFilled = EM.rows.find((x) => x.key === "대출금").r === null;

  /* ⑤ 화면 */
  P.DATA.estimate = A;
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true, ...st }));
  P.renderSection("estimate");
  const sec = DOC.getElementById("estimate");
  r.renderErrors = sec.querySelectorAll(".render-error").length;
  /* **축을 좁혀서 센다** — `.est-table` 은 시나리오 카드의 축 표도 함께 쓰므로 전체
     셀렉터로 세면 기준일 표 11행이 17행이 된다(§7.7.15 의 `.sim-bar-wrap` 과 같은 함정). */
  /* 헤더가 **2행**이다(기준일/추정일 그룹 + 세부 열) — §7.11 로 표를 합치며 생긴 구조라
     `-1` 로 세면 자산군 행이 12개로 잡힌다. */
  r.headerRowCount = DOC.getElementById("est-table-card")
    .querySelectorAll(".est-table th").length > 0
    ? Array.from(DOC.getElementById("est-table-card").querySelectorAll(".est-table tr"))
        .filter((tr) => tr.querySelectorAll("th").length > 0).length : 0;   // 2
  r.assetRowCount = DOC.getElementById("est-table-card")
    .querySelectorAll(".est-table tr").length - r.headerRowCount;        // 11
  r.inputCount = DOC.getElementById("est-table-card")
    .querySelectorAll(".est-table input").length;                       // 규모11+수익11+듀레6
  /* 자동 표식은 **자동값이 실제로 들어간 칸에만** — 빈 칸까지 칠하면 채워진 것처럼 읽힌다 */
  r.autoMarkCount = DOC.getElementById("est-table-card")
    .querySelectorAll(".est-auto").length;                              // 국내주식·해외주식 2
  /* 한 표 안에 기준일 블록과 추정일 블록이 **나란히** 있는가(§7.11 의 요구 그 자체).
     폐지된 두 열(반영 수익률·기여도)이 되살아나면 함께 잡힌다. */
  const headTxt = Array.from(DOC.getElementById("est-table-card").querySelectorAll("th"))
    .map((n) => n.textContent).join("|");
  r.headerHasBothDateBlocks = /기준일/.test(headTxt) && /추정일/.test(headTxt);
  r.headerDroppedAppliedColumn = !/반영 수익률/.test(headTxt) && !/연환산\|/.test(headTxt);
  r.headerDroppedContribColumn = !/기여도/.test(headTxt);
  /* §7.12 — 4항 열은 표에서 빠져 결과 카드 접이식으로 갔다. 표에는 「근거」 한 줄만 */
  r.headerDroppedFourTermColumns = !/캐리/.test(headTxt) && !/스왑 MTM/.test(headTxt);
  r.headerHasReason = /근거/.test(headTxt);
  r.headerHasDiffColumn = /차이/.test(headTxt);
  /* 출처 열도 내렸다 — 접이식으로 갔을 뿐 사라지지 않았는지 함께 본다 */
  r.headerDroppedSourceColumn = !/출처/.test(headTxt);
  r.sourcesMovedToDetails = DOC.getElementById("est-sources")
    .querySelectorAll("details").length === 1;
  /* 구분선은 **클래스로** 붙는다 — 재계산이 className 을 통째로 다시 써도 살아남아야 한다 */
  r.sepCellsPresent = DOC.getElementById("est-table-card")
    .querySelectorAll(".est-sep").length >= 11;
  const secTxt = sec.textContent.replace(/\s+/g, " ");
  r.screenStatesElapsed = /경과 181일/.test(secTxt);
  r.screenSaysInputIsAnnualized = /기준일 수익률은 이미 연환산된 값을 넣으십시오/.test(secTxt);
  r.screenSaysEquityExcluded = /주식\(국내·해외\)은 연환산하지 않는/.test(secTxt);
  r.screenWarnsPrNotTr = /PR/.test(secTxt) && /⚠/.test(secTxt);
  r.screenStatesUstUnavailable = /미국채 총수익 지수 부재/.test(secTxt);
  /* 듀레이션은 **이제 실제로 쓰인다**(시나리오 가격효과) — 옛 문장이 남아 있으면 거짓말이다 */
  r.screenSaysDurationUsedForPrice = /추정일 가격효과/.test(secTxt);
  r.screenDropsStaleDurationClaim = !/지금 수익률 계산에 쓰이지 않습니다/.test(secTxt);
  /* 입력은 모형 입력이라 즉시 저장된다(자산배분 비중 시뮬레이션과 다른 축).
     **축을 좁혀서 집는다** — 시나리오 카드가 표보다 위로 올라가서(§7.11) 문서 전체의
     `.est-table input`[0] 은 이제 축 입력이다. */
  const amtIn = DOC.getElementById("est-table-card").querySelectorAll(".est-table input")[0];
  amtIn.value = "7777";
  amtIn.dispatchEvent({ type: "input" });
  const savedNow = JSON.parse(shim.localStorage.getItem("iaw-estimate"));
  r.inputsSaveImmediately = savedNow.amt["장부가 국내채권"] === 7777;

  /* ⑥ 지수 없는 페이로드 — 화면이 살아 있고 사유를 적어야 한다 */
  P.DATA.estimate = { active: false, reason: "지수 없음(테스트)", indices: [],
                      unavailable: A.unavailable, annualize: A.annualize };
  shim.localStorage.removeItem("iaw-estimate");
  P.renderSection("estimate");
  r.inactiveRenderErrors = DOC.getElementById("estimate").querySelectorAll(".render-error").length;
  r.inactiveExplains = /지수 없음\(테스트\)/.test(DOC.getElementById("estimate").textContent);
  r.inactiveStillHasInputs = DOC.querySelectorAll(".est-table input").length > 0;

  /* ⑦ 재점검(§7.8.1)에서 나온 결함 셋 — 전부 실데이터로 재현했던 것들 */

  // (a) 존재하지 않는 날짜는 Date 가 조용히 다음 달로 굴린다(2026-02-30 → 3/2, 경과 61일)
  r.rejectsRolledOverDate = P.estDayCount("2026-02-30") === null;
  r.acceptsRealLeapDay = !!P.estDayCount("2024-02-29");
  r.rejectsFakeLeapDay = P.estDayCount("2025-02-29") === null;

  /* (b) 기준일이 지수의 마지막 관측보다 뒤면 **그 사실이 값에 실려야** 한다.
     전용 지수를 만든다 — 공용 픽스처는 2026-12-31 까지 있어서 그 뒤 기준일이
     「그 해 관측 없음」 분기로 빠진다(그건 (b2) 에서 따로 본다). */
  const stop = { ...A.indices[0], last: "2026-06-30",
    t: A.indices[0].t.filter((x) => x <= Math.floor(Date.UTC(2026, 5, 30) / 1000)) };
  stop.v = A.indices[0].v.slice(0, stop.t.length);
  const far = P.estIndexYtd(stop, "2026-11-30");
  r.beyondDataFlagged = far.beyondData === true && far.gapDays > 100;
  r.beyondDataStillReturnsValue = Math.abs(far.ytd - 0.20) < 1e-9;   // 값은 내되 표를 단다
  const inRange = P.estIndexYtd(stop, "2026-06-30");
  r.inRangeNotFlagged = inRange.beyondData === false && inRange.gapDays === 0;
  /* (b2) 기준일 연도에 관측이 **하나도 없으면** 「전년 연말보다 앞섭니다」가 아니라
     그 사실을 적어야 한다(예전 문구는 사실과 달라 사용자를 엉뚱한 데로 보냈다). */
  const noYear = P.estIndexYtd(A.indices[0], "2027-06-30");
  r.emptyYearSaysSo = /2027년 관측이 없습니다/.test(noYear.error || "");
  r.emptyYearNotMislabelled = !/전년 연말보다 앞섭니다/.test(noYear.error || "");

  // (c) 화면 — 쓴 관측일이 **눈에 보여야** 한다(예전에는 title 툴팁에만 있었다)
  P.DATA.estimate = { ...A, indices: [stop, A.indices[1]] };
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true,
    asof: "2026-11-30", amt: { "국내주식": 1000 }, ret: {}, dur: {} }));
  P.renderSection("estimate");
  const staleTxt = DOC.getElementById("estimate").textContent.replace(/\s+/g, " ");
  r.rowShowsUsedObservationDate = /2026-06-30 까지만 있음/.test(staleTxt);
  r.summaryWarnsStale = /자동 채움 지수가 기준일까지 오지 않았습니다/.test(staleTxt);
  /* 표식이 **실제 노드**로 있어야 한다 — title 속성에만 있으면 터치 기기에서 아예
     보이지 않는다(셰이드에 innerHTML 이 없으므로 노드로 확인한다). */
  /* §7.12 로 출처 열을 내렸지만 이 경고는 **값에 대한 경고**라 행에 남아야 한다
     (실제로 한 번 함께 사라졌고 이 단언이 잡았다). 이제 「근거」 열에 붙는다. */
  r.staleMarkIsVisibleNotTooltipOnly = Array.from(
    DOC.getElementById("est-table-card").querySelectorAll("span"))
    .some((n) => /까지만 있음/.test(n.textContent || ""));

  // (d) 음수 규모 / 규모 합 0 — 왜 결과가 비는지 화면이 적는다
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true,
    asof: "2026-06-30", amt: { "대출금": -500 }, ret: { "대출금": 3 }, dur: {} }));
  P.renderSection("estimate");
  const negTxt = DOC.getElementById("est-summary").textContent.replace(/\s+/g, " ");
  r.negativeAmountWarned = /규모가 음수인 자산군 1개/.test(negTxt);
  r.zeroTotalExplained = /규모 합이 0 이하라 포트폴리오 수익률을 낼 수 없습니다/.test(negTxt);
  r.amountInputHasMinZero = Array.from(DOC.querySelectorAll(".est-table input"))
    .filter((n) => /규모$/.test(n.getAttribute("aria-label") || ""))
    .every((n) => n.getAttribute("min") === "0");

  // (e) 기본 기준일은 **모든 지수가 도달한 날**이어야 한다 — 늦게 끝나는 지수 하나 때문에
  //     다른 지수가 처음부터 묵은 값으로 뜨면 안 된다(실측 16일)
  const mixed = { ...A, asof: "2026-12-31", asof_all: "2026-06-30" };
  P.DATA.estimate = mixed;
  shim.localStorage.removeItem("iaw-estimate");
  P.renderSection("estimate");
  /* 셰이드는 `.type` 프로퍼티를 노출하지 않는다 — 속성으로 집는다 */
  const dateIn = Array.from(DOC.querySelectorAll("#est-controls input"))
    .find((n) => n.getAttribute("type") === "date");
  r.defaultAsofUsesAllIndexReach = dateIn && dateIn.value === "2026-06-30";

  /* ⑧ 적대적 재점검(§7.10.1)이 잡은 결함 — 전부 실브라우저로 재현했던 것들 */

  // (a) CRITICAL: 입력 중인 칸을 되쓰면 사용자가 친 문자가 지워지고 자동값 뒤에 붙는다
  //     (실측: 자동 20.00% 칸에 `-3.5` → **20.0035**, 그대로 저장까지 됐다)
  P.DATA.estimate = A;
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true,
    asof: "2026-06-30", amt: { "국내주식": 1000 }, ret: {}, dur: {}, dlt: {}, hedge: {} }));
  P.renderSection("estimate");
  const retIn = Array.from(DOC.getElementById("est-table-card").querySelectorAll("input"))
    .find((n) => /국내주식 기준일 수익률/.test(n.getAttribute("aria-label") || ""));
  r.autoFillPresentBeforeTyping = retIn.value !== "";
  retIn.focus();                                   // 사용자가 그 칸에 들어간 상태
  retIn.value = "";                                // "-" 만 친 순간과 같은 상태
  retIn.dispatchEvent({ type: "input" });
  r.focusedFieldNotOverwritten = retIn.value === "";
  retIn.value = "-3.5";
  retIn.dispatchEvent({ type: "input" });
  r.typedNegativeSurvives = retIn.value === "-3.5"
    && JSON.parse(shim.localStorage.getItem("iaw-estimate")).ret["국내주식"] === -3.5;
  /* 포커스를 뺀 뒤에는(=수기값이 없으면) 자동값으로 다시 맞춰야 한다 */
  retIn.value = "";
  retIn.dispatchEvent({ type: "input" });
  DOC.body.focus();
  retIn.dispatchEvent({ type: "blur" });
  r.blurRestoresAutoFill = retIn.value !== "";

  /* (b) 기준일이 없어도 **키인한 수익률은 그대로 계산된다**(§7.11 — 계수를 안 쓰므로).
     §7.10.1 이 잡았던 CRITICAL(계수가 없어 비주식 행이 통째로 빠지고 「주식 수익 ÷ 전체
     규모」가 헤드라인으로 나가던 상태)은 계수 자체가 없어져 구조적으로 사라졌다. 대신
     남는 위험은 **수익률이 하나도 없는데 0.00% 를 내는 것**이라 그쪽을 고정한다. */
  const EnoAsof = P.estEngine(A, { asof: null, amt: { "장부가 국내채권": 5000, "국내주식": 1000 },
    ret: { "장부가 국내채권": 1.5, "국내주식": 4 }, dur: {}, dlt: {}, hedge: {} });
  r.noAsofStillComputesKeyedRows =
    Math.abs(EnoAsof.port - (5000 * 0.015 + 1000 * 0.04) / 6000) < 1e-15;
  r.noAsofNotFlaggedWhenKeyed = EnoAsof.portBlockedNoRet === false;
  const EnoRet = P.estEngine(A, { asof: "2026-06-30", amt: { "대출금": 5000 },
    ret: {}, dur: {}, dlt: {}, hedge: {} });
  r.noReturnsPortIsNull = EnoRet.port === null;      // 0.00% 는 「계산했더니 0」이라는 뜻이다
  r.noReturnsFlagged = EnoRet.portBlockedNoRet === true;
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true,
    asof: "2026-06-30", amt: { "대출금": 5000 }, ret: {}, dur: {}, dlt: {}, hedge: {} }));
  P.renderSection("estimate");
  const sumTxt = DOC.getElementById("est-summary").textContent.replace(/\s+/g, " ");
  r.noReturnsExplainedOnScreen = /수익률이 하나도 없어 포트폴리오 수익률을 내지 않았습니다/.test(sumTxt);
  r.noReturnsHeadlineBlank = /기준일 수익률 \(연환산\)\s*–/.test(sumTxt);
  r.noReturnsProfitBlank = /총 운용수익 \(연환산 기준\)\s*–/.test(sumTxt);
  /* 추정일이 없으면 추정일 헤드라인도 비고 **왜 비었는지**를 적는다 */
  r.noEstDateHeadlineBlank = /추정일 수익률 \(연환산\)\s*–/.test(sumTxt);
  r.noEstDateExplained = /추정일 수익률은 아직 없습니다/.test(sumTxt);

  // (c) NaN 경과일수 — `days <= 0` 만으로는 통과한다(연도 0000 → 전년이 -1년)
  r.rejectsNaNElapsed = P.estDayCount("0000-01-01") === null;

  // (d) 축약 구간의 오류 문구가 **사실**이어야 한다 — estDayCount 가 기준일 > 전년 연말을
  //     보장하므로 "기준일이 전년 연말보다 앞섭니다"는 결코 참이 될 수 없다
  const packedGap = { ...A.indices[0],
    t: [Math.floor(Date.UTC(2025, 11, 26) / 1000), Math.floor(Date.UTC(2026, 0, 9) / 1000)],
    v: [100, 110], last: "2026-01-09",
    year_end: { 2025: { v: 101, d: "2025-12-31" } } };
  const gapErr = P.estIndexYtd(packedGap, "2026-01-02");
  r.compactionGapSaysTruth = /축약되지 않은 관측이 없습니다/.test(gapErr.error || "");
  r.compactionGapNotMislabelled = !/전년 연말보다 앞섭니다/.test(gapErr.error || "");

  P.DATA.estimate = A;
  shim.localStorage.removeItem("iaw-estimate");
  P.renderSection("estimate");
  return r;
});

/* ====== 추정일 시나리오 (§7.10) — 부호가 이 화면의 심장이다 ==================== */
safe("estimateScenario", () => {
  const r = {};
  /* 축 6개를 직접 만든다. 값은 **결정적**으로 두어 손계산과 1:1 로 맞춘다. */
  const t = [], v0 = [];
  for (let d = Date.UTC(2026, 0, 1); d <= Date.UTC(2026, 11, 31); d += 86400000) {
    t.push(Math.floor(d / 1000)); v0.push(100);
  }
  const flat = (val) => ({ t, v: t.map(() => val), last: "2026-12-31" });
  const A = {
    active: true, asof: "2026-12-31", asof_all: "2026-12-31",
    indices: [
      { key: "kospi_tr", asset: "국내주식", label: "KOSPI TR", src: "s", basis: "b",
        basis_matches_request: true, caveat: "", ...flat(100),
        year_end: { 2025: { v: 100, d: "2025-12-31" } }, first: "2026-01-01" },
      { key: "acwi", asset: "해외주식", label: "ACWI", src: "s", basis: "b",
        basis_matches_request: true, caveat: "", ...flat(100),
        year_end: { 2025: { v: 100, d: "2025-12-31" } }, first: "2026-01-01" },
    ],
    axes: [
      { key: "kr_rate", label: "국고", kind: "rate", unit: "bp", src: "a", ...flat(3.0), first: "2026-01-01" },
      { key: "us_rate", label: "미국채", kind: "rate", unit: "bp", src: "a", ...flat(4.0), first: "2026-01-01" },
      { key: "usdkrw", label: "달러원", kind: "price", unit: "%", src: "a", ...flat(1300), first: "2026-01-01" },
      { key: "swap", label: "스왑", kind: "rate", unit: "bp", src: "a", ...flat(-2.0), first: "2026-01-01" },
      { key: "kospi", label: "KOSPI TR", kind: "price", unit: "%", index: "kospi_tr" },
      { key: "acwi", label: "ACWI", kind: "price", unit: "%", index: "acwi" },
    ],
    unavailable: [], annualize: { basis: "days", day_count: 365, note: "n" },
    scenario: { formula: "F", terms: ["a"], book_value: "BV", limits: "L",
                cumulative: "CUM", cross_year: "XY" },
  };
  /* 기준일 6/30 → 추정일 12/31 (184일). 전부 수기 시나리오. */
  const st = {
    asof: "2026-06-30", est_date: "2026-12-31",
    amt: { "장부가 국내채권": 1000, "장부가 해외채권": 1000, "시가 국내채권 직접": 1000,
           "국내주식": 1000, "해외주식": 1000 },
    ret: { "장부가 국내채권": 3.65, "장부가 해외채권": 3.65, "시가 국내채권 직접": 3.65 },
    dur: { "장부가 국내채권": 5, "장부가 해외채권": 5, "시가 국내채권 직접": 4 },
    lvl: { kr_rate: 3.5, us_rate: 4.3, usdkrw: 1339, swap: -3.0, kospi: 105, acwi: 104 },
    amt2: {}, ret2: {}, dlt: {},
    hedge: { "장부가 해외채권": 90, "해외주식": 30 }, swap_tau: 0.25,
  };
  const S = P.estScenario(A, st);
  r.ready = S.ready === true;
  r.days = S.days;                                   // 184
  const row = (k) => S.rows.find((x) => x.key === k);

  /* ① 부호 — 금리 상승은 채권 가격 하락. 이 하나가 뒤집히면 화면 전체가 거짓이 된다. */
  const kb = row("시가 국내채권 직접");
  r.rateUpMeansPriceDown = kb.price < 0;
  r.priceIsMinusDurationTimesDy = Math.abs(kb.price - (-4 * 0.005)) < 1e-15;

  /* ② 부호 — 스왑레이트 하락은 MTM 이익(사용자 예시: −2% 체결 → −3% 로 하락) */
  const fb = row("장부가 해외채권");
  r.swapDownMeansGain = fb.swap > 0;
  r.swapMtmMatchesAcctModel = Math.abs(fb.swap - (0.9 * 0.25 * 0.01)) < 1e-15;
  const stUp = { ...st, lvl: { ...st.lvl, swap: -1.0 } };
  r.swapUpMeansLoss = P.estScenario(A, stUp).rows
    .find((x) => x.key === "장부가 해외채권").swap < 0;

  /* ③ 장부가는 원가법 — 듀레이션을 넣어도 가격효과가 0 이어야 한다 */
  /* §7.12 — 장부가 **국내**채권은 승계(carry)라 분해가 없다. 원가법이라 가격효과가
     0 이라는 성질은 계산(calc) 대상인 장부가 **해외**채권으로 확인한다(듀레이션을
     넣었는데도 0 이어야 한다 — 검사가 헛돌지 않게 그 입력도 함께 단언한다). */
  r.bookValueHasNoPriceEffect = row("장부가 해외채권").price === 0;
  r.bookValueDurationWasEntered = st.dur["장부가 해외채권"] === 5;
  r.bookDomesticIsCarryNotCalc = row("장부가 국내채권").mode === "carry"
    && row("장부가 국내채권").price === null;
  /* 장부가 **해외**채권은 환·스왑으로 움직인다(사용자 지시의 핵심) */
  r.bookForeignMovesByFxAndSwap = fb.fx !== 0 && fb.swap !== 0 && fb.total !== fb.carry;
  /* 승계 행의 구간수익은 캐리 그 자체다(4항을 만들지 않으므로 total 로 직접 본다) */
  r.bookDomesticMovesOnlyByCarry = Math.abs(row("장부가 국내채권").total
    - 0.0365 * 184 / 365) < 1e-15;

  /* ④ 환효과 = (1−h)·Δ환율 — 헤지분만 상쇄된다 */
  const eq = row("해외주식");
  r.fxIsUnhedgedShareOnly = Math.abs(eq.fx - (1 - 0.3) * 0.03) < 1e-15;
  r.domesticHasNoFx = row("시가 국내채권 직접").fx === 0;
  /* 헤지 100% 면 환효과가 정확히 0 */
  const stFull = { ...st, hedge: { ...st.hedge, "해외주식": 100 } };
  r.fullHedgeZeroesFx = Math.abs(P.estScenario(A, stFull).rows
    .find((x) => x.key === "해외주식").fx) < 1e-15;

  /* ⑤ 캐리 — 기준일 **연환산** 수익률(=입력값 그대로)의 구간 비례분.
     주식은 캐리가 없다(가격이 곧 수익). */
  r.carryIsProRated = Math.abs(kb.carry - (0.0365 * 184 / 365)) < 1e-15;
  r.equityHasNoCarry = eq.carry === 0 && row("국내주식").carry === 0;
  r.equityPriceIsIndexMove = Math.abs(row("국내주식").price - 0.05) < 1e-15;

  /* ⑥ 합계·포트폴리오가 항의 합과 정확히 같은가 */
  r.totalIsSumOfTerms = S.rows.filter((x) => x.mode === "calc" && x.total != null)
    .every((x) => Math.abs(x.total - (x.carry + x.price + x.fx + x.swap)) < 1e-15);
  /* 승계 행에는 분해가 **없어야** 한다 — 계산하지 않은 행에 분해를 붙이면 계산한 척이 된다 */
  r.carryRowsHaveNoBreakdown = S.rows.filter((x) => x.mode === "carry")
    .every((x) => x.carry === null && x.price === null && x.fx === null && x.swap === null);
  const manual = S.rows.reduce((a, x) => a + (x.amt || 0) * (x.total || 0), 0) / S.totalAmt;
  r.portfolioMatchesHandCalc = Math.abs(S.portPeriod - manual) < 1e-15;

  /* ⑥-b **나란히 놓기의 항등식**(§7.11) — 기준일 값이 연환산이므로 기간수익으로 되돌려
     더한 뒤 추정일 기준으로 다시 연환산한다. 캐리가 연환산율을 보존하므로 결과는
     `추정일 = 기준일 + 시장효과 × 365 ÷ 연초→추정일 일수` 와 **대수적으로 같아야** 한다.
     되돌리기를 빠뜨리면(옛 코드처럼 `r + total`) 이 단언이 깨진다. */
  const yd = S.yearDays;                                    // 2026-12-31 → 365
  r.yearDaysIsToEstDate = yd === 365;
  r.cumIdentityNonEquity = ["시가 국내채권 직접", "장부가 해외채권"].every((k) => {
    const x = row(k);
    return Math.abs(x.cumAnnual - (x.r + (x.price + x.fx + x.swap) * 365 / yd)) < 1e-15;
  });
  r.basePeriodIsUnAnnualized = Math.abs(kb.basePeriod - 0.0365 * 181 / 365) < 1e-15;
  /* 주식은 양쪽 다 연환산하지 않으므로 차이 = 지수 변화(+환효과) 그대로 */
  r.cumIdentityEquity = Math.abs(row("국내주식").cumAnnual
    - (row("국내주식").r + row("국내주식").total)) < 1e-15;
  /* **계수가 1 이 아닌 날로 한 번 더 잰다.** 위 검사들의 추정일이 12/31 이라 재연환산
     계수가 정확히 1 이고, 그 상태에서는 주식/비주식 구분이 수에 드러나지 않아 규약이
     조용히 뒤집혀도 통과한다(§7.8 의 「2.0 이 아님」 단언과 같은 성격의 자리다). */
  const S9 = P.estScenario(A, { ...st, est_date: "2026-09-30" });
  const f9 = 365 / S9.yearDays;                              // 365/273 ≈ 1.337
  r.reannualFactorNotOne = Math.abs(f9 - 1) > 0.3;
  const eq9 = S9.rows.find((x) => x.key === "국내주식");
  const kb9 = S9.rows.find((x) => x.key === "시가 국내채권 직접");
  r.equityNotReannualized = Math.abs(eq9.cumAnnual - (eq9.r + eq9.total)) < 1e-15;
  r.nonEquityReannualized =
    Math.abs(kb9.cumAnnual - (kb9.r + (kb9.price + kb9.fx + kb9.swap) * f9)) < 1e-15;
  r.nonEquityDiffersFromRaw = Math.abs(kb9.cumAnnual - (kb9.r + kb9.total)) > 1e-6;
  r.diffIsCumMinusBase = S.rows.filter((x) => x.diff != null).every((x) =>
    Math.abs(x.diff - (x.cumAnnual - x.r)) < 1e-15);
  /* 포트폴리오 차이는 **두 헤드라인을 그대로 뺀 값**이어야 한다(세 수가 서로 맞아야 한다) */
  r.portDiffMatchesHeadlines =
    Math.abs(S.portDiff - (S.portCumAnnual - S.portBase)) < 1e-15;
  r.portBaseMatchesEngine = Math.abs(S.portBase - P.estEngine(A, st).port) < 1e-15;

  /* ⑥-c 추정일이 **다른 해**면 연초 기준이 달라져 누적을 잇지 못한다.
     옛 코드는 그때도 `기준일값 + 구간` 을 만들고 추정일 연도의 짧은 경과일수로 연환산했다
     (2026-07-21 → 2027-03-31 이면 ×365/90 = 4.06배). 지어낸 수를 내지 않는지 본다. */
  const SX = P.estScenario(A, { ...st, est_date: "2027-03-31" });
  r.crossYearFlagged = SX.ready === true && SX.crossYear === true;
  r.crossYearNoCumulative = SX.portCumAnnual === null && SX.portDiff === null
    && SX.rows.every((x) => x.cumAnnual === null);
  r.crossYearStillGivesPeriod = SX.portPeriod != null
    && Math.abs(SX.rows.find((x) => x.key === "시가 국내채권 직접").total) > 0;

  /* ⑦ 입력이 모자라면 **0 으로 대체하지 않고** 막고 사유를 남긴다 */
  const stNoDur = { ...st, dur: {} };
  const SN = P.estScenario(A, stNoDur);
  const kbn = SN.rows.find((x) => x.key === "시가 국내채권 직접");
  r.missingDurationBlocks = kbn.total === null && /듀레이션 미입력/.test(kbn.priceNote);
  r.blockedListed = SN.blocked.some((x) => x.key === "시가 국내채권 직접");

  /* ⑧ 추정일이 기준일보다 앞이면 거부 */
  r.rejectsBackwardEstDate =
    P.estScenario(A, { ...st, est_date: "2026-01-31" }).ready === false;

  /* ⑨ 축 자동 조회 — 수기값이 없으면 데이터에서, 실제 두 관측일을 밝힌다 */
  const stAuto = { ...st, lvl: {} };
  const SA = P.estScenario(A, stAuto);
  const ax = SA.axes.find((x) => x.key === "kr_rate");
  r.axisAutoFilled = ax.source === "자동" && ax.from.d === "2026-06-30"
    && ax.toAuto.d === "2026-12-31";
  r.axisAutoFlatIsZero = Math.abs(ax.delta) < 1e-15;      // 픽스처가 평평하므로 0
  r.keyedAxisBeatsAuto = SA.axes.find((x) => x.key === "kospi").source === "자동"
    && S.axes.find((x) => x.key === "kospi").source === "수기";

  /* ⑨-b **수준 키인**(§7.12) — 사용자는 변화량이 아니라 추정일 수준을 친다.
     기준일 수준은 언제나 데이터에서 오고, 변화는 화면이 아니라 엔진이 계산한다. */
  const axKr = S.axes.find((x) => x.key === "kr_rate");
  r.axisFromLevelFromData = Math.abs(axKr.from.v - 3.0) < 1e-12;
  r.axisKeyedLevelUsed = Math.abs(axKr.to.v - 3.5) < 1e-12;   // st.lvl 이 3.5
  r.axisRateDeltaIsDifference = Math.abs(axKr.delta - 0.005) < 1e-15;  // (3.5−3.0)/100
  const axFx = S.axes.find((x) => x.key === "usdkrw");
  r.axisPriceDeltaIsRatio = Math.abs(axFx.delta - (1339 / 1300 - 1)) < 1e-15;
  /* 자동인데 두 날짜가 같은 관측이면 변화는 0 이 아니라 **모른다** */
  const same = P.estAxisLevels(A, A.axes[0], "2026-06-30", "2026-06-30", null);
  r.sameObservationIsUnknownNotZero = same.delta === null && !!same.error;

  /* ⑩ 화면 */
  P.DATA.estimate = A;
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true, ...st }));
  P.renderSection("estimate");
  const sec = DOC.getElementById("estimate");
  r.renderErrors = sec.querySelectorAll(".render-error").length;
  /* 시장지표 카드가 **표 밑의 자기 카드**로 분리됐다(§7.12) */
  r.axisRowCount = DOC.getElementById("est-market-card")
    .querySelectorAll(".est-table tr").length - 1;                       // 6
  r.marketCardShowsBothLevels = /3\.00/.test(
    DOC.getElementById("est-market-card").textContent);
  /* **4항 분해는 표에서 빠지고 결과 카드의 접이식으로 갔다**(§7.12) — 표에는 「근거」
     한 줄만 간다. 두 곳에 그리지 않는 규약은 그대로다. */
  const tableTxt = DOC.getElementById("est-table-card").textContent.replace(/\s+/g, " ");
  r.tableHasNoFourTermColumns = !/캐리/.test(tableTxt) && !/스왑 MTM/.test(tableTxt);
  r.resultCardHasBreakdown = /캐리/.test(
    DOC.getElementById("est-scenario-result").textContent);
  /* 통합 표의 추정일 칸이 실제로 채워졌는가 */
  const kbCum = (kb.cumAnnual * 100).toFixed(2);
  r.tableShowsEstReturn = tableTxt.indexOf(kbCum) >= 0;
  const kbDiff = (kb.diff * 100).toFixed(2);
  r.tableShowsDiff = tableTxt.indexOf(kbDiff) >= 0;
  const txt = sec.textContent.replace(/\s+/g, " ");
  r.screenStatesSignRule = /금리 상승 = 채권 가격 하락/.test(txt);
  r.screenStatesSwapSign = /스왑레이트 상승 = 스왑 MTM 손실/.test(txt);
  r.screenStatesBookValue = /BV/.test(txt);
  r.screenStatesLimits = /L/.test(txt);
  r.screenStatesCumulativeRule = /CUM/.test(txt);      // 나란히 놓기의 항등식 문장
  /* 다른 해면 화면이 **사유를 적는다** — 조용히 비우면 고장으로 읽힌다 */
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true, ...st,
    est_date: "2027-03-31" }));
  P.renderSection("estimate");
  r.screenStatesCrossYear = /XY/.test(
    DOC.getElementById("estimate").textContent.replace(/\s+/g, " "));
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true, ...st }));
  P.renderSection("estimate");
  /* 시장지표 입력도 즉시 저장(모형 입력) */
  const tauIn = Array.from(DOC.getElementById("est-market-card").querySelectorAll("input"))
    .find((n) => /스왑 잔존만기/.test(n.getAttribute("aria-label") || ""));
  tauIn.value = "0.5";
  tauIn.dispatchEvent({ type: "input" });
  r.scenarioInputsSave =
    JSON.parse(shim.localStorage.getItem("iaw-estimate")).swap_tau === 0.5;
  const lvlIn = Array.from(DOC.getElementById("est-market-card").querySelectorAll("input"))
    .find((n) => /국고 추정일 수준/.test(n.getAttribute("aria-label") || ""));
  lvlIn.value = "4.25";
  lvlIn.dispatchEvent({ type: "input" });
  r.levelInputSaves =
    JSON.parse(shim.localStorage.getItem("iaw-estimate")).lvl["kr_rate"] === 4.25;

  shim.localStorage.removeItem("iaw-estimate");
  return r;
});

/* ====== §7.12 — 추정일 자동계산 · 규모 승계 · 헤지 선택 ====================== */
safe("estimateTwoBlocks", () => {
  const r = {};
  const A = EST_FIXTURE;
  const base = {
    asof: "2026-06-30", est_date: "2026-12-31",
    amt: { "장부가 국내채권": 5000, "대체투자": 3000, "시가 국내채권 직접": 2000 },
    ret: { "장부가 국내채권": 3.0, "대체투자": 4.0, "시가 국내채권 직접": 3.65 },
    dur: { "시가 국내채권 직접": 5 },
    lvl: {}, amt2: {}, ret2: {}, dlt: {}, hedge: {}, swap_tau: 0.25,
  };

  /* ① 모드 축이 사용자가 지정한 그대로인가 — calc 7 / carry 4 */
  const modes = Object.keys(P.EST_SCEN).map((k) => P.EST_SCEN[k].mode);
  r.calcCount = modes.filter((m) => m === "calc").length;       // 7
  r.carryCount = modes.filter((m) => m === "carry").length;     // 4
  r.carrySetExact = ["장부가 국내채권", "단기자금", "대출금", "대체투자"]
    .every((k) => P.EST_SCEN[k].mode === "carry");
  r.bookForeignIsCalc = P.EST_SCEN["장부가 해외채권"].mode === "calc";

  /* ② 규모 승계 — 비우면 기준일 규모를 그대로 쓰고, 넣으면 그것이 정본 */
  const S0 = P.estScenario(A, base);
  const row = (S, k) => S.rows.find((x) => x.key === k);
  r.sizeInheritedWhenBlank = row(S0, "대체투자").amt2 === 3000
    && row(S0, "대체투자").amt2Keyed === false;
  r.inheritedTotalMatches = S0.totalAmt2 === S0.totalAmt;
  r.sizeChangedFlagFalse = S0.sizeChanged === false;
  const S1 = P.estScenario(A, { ...base, amt2: { "대체투자": 1000 } });
  r.keyedSizeUsed = row(S1, "대체투자").amt2 === 1000
    && row(S1, "대체투자").amt2Keyed === true;
  r.otherRowsStillInherit = row(S1, "장부가 국내채권").amt2 === 5000;
  r.sizeChangedFlagTrue = S1.sizeChanged === true;
  /* **추정일 열은 추정일 규모로 가중한다** — 한 벌로 재면 리밸런싱 효과가 사라진다 */
  const w = S1.rows.reduce((a, x) => a + (x.amt2 || 0), 0);
  const manual = S1.rows.reduce((a, x) =>
    a + ((x.amt2 != null && x.cumAnnual != null) ? x.amt2 * x.cumAnnual : 0), 0) / w;
  r.estPortUsesEstSizes = Math.abs(S1.portCumAnnual - manual) < 1e-15;
  r.estPortDiffersFromBaseWeighting =
    Math.abs(S1.portCumAnnual - S0.portCumAnnual) > 1e-9;

  /* ③ carry 자산군 — 기준일 승계가 기본, 수기로 덮을 수 있고, 4항을 만들지 않는다 */
  const alt = row(S0, "대체투자");
  r.carryInheritsBaseReturn = Math.abs(alt.cumAnnual - 0.04) < 1e-15;
  r.carryDiffIsZero = Math.abs(alt.diff) < 1e-15;
  r.carryHasNoBreakdown = alt.carry === null && alt.price === null
    && alt.fx === null && alt.swap === null;
  r.carryNoteSaysInherited = alt.modeNote === "기준일 승계";
  /* 구간수익은 낸다 — 포트폴리오 「추정 구간」에 들어가야 하기 때문 */
  r.carryStillHasPeriodReturn = Math.abs(alt.total - 0.04 * 184 / 365) < 1e-15;
  const S2 = P.estScenario(A, { ...base, ret2: { "대체투자": 6 } });
  const alt2 = row(S2, "대체투자");
  r.carryKeyedOverride = Math.abs(alt2.cumAnnual - 0.06) < 1e-15
    && alt2.ret2Keyed === true && alt2.modeNote === "수기";
  r.carryKeyedDiff = Math.abs(alt2.diff - 0.02) < 1e-15;

  /* ④ calc 자산군은 수기 덮어쓰기가 **없다** — 산식이 정본이라 ret2 를 무시해야 한다 */
  const S3 = P.estScenario(A, { ...base, ret2: { "시가 국내채권 직접": 99 } });
  r.calcIgnoresKeyedReturn =
    Math.abs(row(S3, "시가 국내채권 직접").cumAnnual
             - row(S0, "시가 국내채권 직접").cumAnnual) < 1e-15;

  /* ⑤ 헤지비율에 **기본값이 없다** — 고르기 전에는 0 으로 지어내지 않는다 */
  const fb = row(S0, "장부가 해외채권");
  r.hedgeHasNoDefault = fb.h === null && fb.fx === null && fb.swap === null
    && /헤지비율 미입력/.test(fb.fxNote);
  r.hedgeBandIs0to105 = P.EST_SCEN && A.scenario && A.scenario.hedge_band
    ? (A.scenario.hedge_band.lo === 0 && A.scenario.hedge_band.hi === 105) : false;
  const S4 = P.estScenario(A, { ...base, amt: { ...base.amt, "장부가 해외채권": 1000 },
    ret: { ...base.ret, "장부가 해외채권": 2.0 },
    hedge: { "장부가 해외채권": 100 }, lvl: { usdkrw: 1339, swap: -3.0 } });
  const fb4 = row(S4, "장부가 해외채권");
  /* 100% 헤지면 환효과가 정확히 0, 스왑 MTM 은 남는다(파생이라 MTM 이 난다) */
  r.fullHedgeZeroesFx = Math.abs(fb4.fx) < 1e-15;
  r.fullHedgeKeepsSwapMtm = fb4.swap > 0;
  /* 오버헤지 105% 는 **음의 환효과**를 만든다 — 밴드가 100 을 넘는다는 사실의 결과다 */
  const S5 = P.estScenario(A, { ...base, amt: { ...base.amt, "장부가 해외채권": 1000 },
    ret: { ...base.ret, "장부가 해외채권": 2.0 },
    hedge: { "장부가 해외채권": 105 }, lvl: { usdkrw: 1339 } });
  r.overHedgeFlipsFxSign = row(S5, "장부가 해외채권").fx < 0;

  /* ⑥ 구 저장분(변화량) → 수준 이관. **기준일 수준 + Δ** 로 옮겨야 한다. */
  const stOld = { ...base, lvl: {}, dlt: { kr_rate: 50, usdkrw: 3 }, _hadDlt: true };
  const moved = P.estMigrateLevels(A, stOld);
  r.migrationRan = moved === true;
  r.migratedRateLevel = Math.abs(stOld.lvl["kr_rate"] - (3.0 + 0.5)) < 1e-9;
  r.migratedPriceLevel = Math.abs(stOld.lvl["usdkrw"] - 1300 * 1.03) < 1e-6;
  r.migrationRunsOnce = P.estMigrateLevels(A, stOld) === false;

  /* ⑦ 화면 */
  P.DATA.estimate = A;
  shim.localStorage.setItem("iaw-estimate", JSON.stringify({ saved: true, ...base }));
  P.renderSection("estimate");
  const card = DOC.getElementById("est-table-card");
  r.renderErrors = DOC.getElementById("estimate").querySelectorAll(".render-error").length;
  const heads = Array.from(card.querySelectorAll("th")).map((n) => n.textContent).join("|");
  r.headerHasTwoBlocks = /기준일/.test(heads) && /추정일/.test(heads);
  r.headerHasSizeTwice = (heads.match(/규모/g) || []).length === 2;
  r.headerHasWeightTwice = (heads.match(/비중/g) || []).length === 2;
  r.headerHasReasonColumn = /근거/.test(heads);
  /* 입력칸: 규모11 + 수익률11 + 듀레6 + 추정일규모11 + carry 추정일수익률4 = 43 */
  r.inputCount = card.querySelectorAll("input").length;
  r.estSizeInputsExist = Array.from(card.querySelectorAll("input"))
    .filter((n) => /추정일 규모$/.test(n.getAttribute("aria-label") || "")).length === 11;
  r.carryReturnInputsOnly = Array.from(card.querySelectorAll("input"))
    .filter((n) => /추정일 수익률$/.test(n.getAttribute("aria-label") || "")).length === 4;
  /* 해외자산 이름은 **버튼**이다(헤지비율을 여는 자리). 그 외는 버튼이 아니다. */
  const btns = Array.from(card.querySelectorAll(".est-name-btn"));
  r.foreignNamesAreButtons = btns.length === 4;   // 장부가해외채권·해외주식·시가해외채권 직접/간접
  r.hedgeTagSaysUnsetFirst = /헤지 미입력/.test(card.textContent);
  /* 승계 규모가 **실제로 칸에 보인다** — placeholder 로만 두면 빈 칸으로 읽힌다 */
  const a2 = Array.from(card.querySelectorAll("input"))
    .find((n) => /^대체투자 추정일 규모$/.test(n.getAttribute("aria-label") || ""));
  r.inheritedSizeShownInInput = a2.value === "3000";
  r.inheritedSizeNotStored =
    JSON.parse(shim.localStorage.getItem("iaw-estimate")).amt2["대체투자"] == null;

  /* ⑧ 헤지 고르기 오버레이 — 자산군을 누르면 열리고, 고른 값만 저장된다 */
  const before = JSON.parse(shim.localStorage.getItem("iaw-estimate")).hedge["해외주식"];
  r.hedgeUnsetBeforeClick = before == null;
  const eqBtn = btns.find((n) => /해외주식/.test(n.textContent));
  eqBtn.dispatchEvent({ type: "click" });
  const panel = DOC.querySelectorAll(".est-hedge-panel");
  r.hedgePanelOpens = panel.length === 1;
  const slider = DOC.querySelectorAll(".est-hedge-back input")[0];
  r.sliderRangeIs0to105 = slider.getAttribute("min") === "0"
    && slider.getAttribute("max") === "105";
  slider.value = "70";
  slider.dispatchEvent({ type: "input" });
  r.hedgeSavesOnPick =
    JSON.parse(shim.localStorage.getItem("iaw-estimate")).hedge["해외주식"] === 70;
  /* 밴드 밖은 조용히 받지 않고 밴드 안으로 되돌린다 */
  const numIn = Array.from(DOC.querySelectorAll(".est-hedge-back input"))
    .find((n) => /숫자/.test(n.getAttribute("aria-label") || ""));
  numIn.value = "180";
  numIn.dispatchEvent({ type: "input" });
  r.hedgeClampedToBand =
    JSON.parse(shim.localStorage.getItem("iaw-estimate")).hedge["해외주식"] === 105;

  shim.localStorage.removeItem("iaw-estimate");
  P.DATA.estimate = A;
  P.renderSection("estimate");
  return r;
});

safe("cmaSampleCut", () => {
  const r = {};
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const ctl = DOC.getElementById("alloc-controls");
  const txt = ctl ? ctl.textContent : "";
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  r.noteRendered = !!ctl && !!ctl.querySelector(".cma-cut-note");
  r.statesCutMonth = /표본 종료 2030-06/.test(txt);
  r.statesDataLast = /데이터는 2030-08 까지 있습니다/.test(txt);
  r.tiesToMu = /기대수익\(μ\) 키인 기준일에 맞춰/.test(txt);
  /* 컷이 없으면(구 페이로드) 문장을 만들지 않는다 — 없는 사실을 적지 않는다 */
  const noCut = { ...CMA_ALLOC, cma: { ...CMA_ALLOC.cma, sample_end: null, data_last: null } };
  P.DATA.alloc = noCut;
  P.renderSection("alloc");
  r.absentWhenNoCut = !DOC.getElementById("alloc-controls").querySelector(".cma-cut-note");
  r.absentRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;

  /* §7.7.18 — 표시하는 날짜는 **요청한 컷(상수)이 아니라 실제로 도달한 표본 끝(asof)**.
     둘은 갈릴 수 있다: BM 파일이 짧거나, μ 를 새 기준일로 옮겼는데 새 BM 데이터가 아직
     안 온 경우다(후자는 문서가 지시하는 정상 유지보수 순서라 실제로 일어난다).
     상수를 그대로 적으면 ① 표본이 닿지도 않은 달을 「표본 종료」라 쓰고 ② 하지도 않은
     절단을 했다고 단언하며 ③ **μ·σ 시점이 어긋난 사실을 숨긴다** — §7.7.16 이 막으려던
     바로 그 상태다. 세 갈래를 전부 렌더시켜 확인한다. */
  const withCma = (over) => ({ ...CMA_ALLOC, cma: { ...CMA_ALLOC.cma, ...over } });
  const noteText = (over) => {
    P.DATA.alloc = withCma(over);
    shim.localStorage.removeItem("iaw-alloc");
    P.renderSection("alloc");
    const n = DOC.querySelector(".cma-cut-note");
    return n ? n.textContent.replace(/\s+/g, " ") : "";
  };
  // ① 데이터가 컷에 못 미침 — 도달한 끝을 적고 시점 어긋남을 경고해야 한다
  const tShort = noteText({ asof: "2030-03-31", sample_end: "2030-06-30", data_last: "2030-03-31" });
  r.shortStatesReachedEnd = /표본 종료 2030-03/.test(tShort);
  r.shortDoesNotClaimConstant = !/표본 종료 2030-06/.test(tShort);
  r.shortDoesNotClaimCut = !/맞춰 잘랐습니다/.test(tShort);
  r.shortWarnsMismatch = /σ 와 μ 의 시점이 어긋납니다/.test(tShort);
  r.shortIsFlagged = !!DOC.querySelector(".cma-cut-note .d-up");
  // ② 컷이 실제로 잘라냄 — 기존 문장 유지
  const tCut = noteText({ asof: "2030-06-30", sample_end: "2030-06-30", data_last: "2030-08-31" });
  r.cutStatesReachedEnd = /표본 종료 2030-06/.test(tCut);
  r.cutSaysDataLast = /데이터는 2030-08 까지 있습니다/.test(tCut);
  r.cutNotFlagged = !DOC.querySelector(".cma-cut-note .d-up");
  // ③ 자를 것이 없었음 — 절단했다고만 적고 끝내지 않는다
  const tExact = noteText({ asof: "2030-06-30", sample_end: "2030-06-30", data_last: "2030-06-30" });
  r.exactSaysNothingToCut = /자를 데이터가 없었습니다/.test(tExact);
  // className 이 문자열 "null" 로 새지 않는가(el 의 attrs 는 그대로 반영된다)
  r.noNullClass = !/\bnull\b/.test(DOC.querySelector(".cma-cut-note").innerHTML || "");
  r.threeCaseRenderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;

  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-i. 카드 위계 — 기대수익이 위·크고 위험이 아래·작다 (§7.7.15) =====
   2026-08-12 사용자 지시. 라벨 문자열은 그대로 두고 **순서와 크기만** 바꾼 것이므로,
   문자열 검사로는 회귀를 못 잡는다 — DOM 순서와 font-size 를 실제로 읽어 잰다. */
safe("cardHierarchy", () => {
  const r = {};
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const px = (n) => {
    const m = /font-size:\s*([\d.]+)px/.exec(n.getAttribute("style") || "");
    return m ? +m[1] : null;
  };
  const check = (card) => {
    const divs = Array.from(card.querySelectorAll("div"));
    const mu = divs.find((d) => /^기대수익 [\d.]+%/.test(d.textContent));
    const sg = divs.find((d) => /^위험 [\d.]+%/.test(d.textContent));
    if (!mu || !sg) return null;
    const order = divs.indexOf(mu) < divs.indexOf(sg);
    const fMu = px(mu), fSg = px(sg);
    return { order, fMu, fSg, bigger: fMu != null && fSg != null && fMu > fSg };
  };
  const simCards = Array.from(DOC.getElementById("alloc-sim-panel").querySelectorAll(".sim8-card"))
    .map(check).filter(Boolean);
  r.simCardCount = simCards.length;
  r.simReturnFirst = simCards.length > 0 && simCards.every((c) => c.order);
  r.simReturnBigger = simCards.length > 0 && simCards.every((c) => c.bigger);
  r.simFontPair = simCards.length ? [simCards[0].fMu, simCards[0].fSg] : null;
  const refCards = Array.from(DOC.getElementById("alloc-cards").querySelectorAll(".card"))
    .map(check).filter(Boolean);
  r.refCardCount = refCards.length;
  r.refReturnFirst = refCards.length > 0 && refCards.every((c) => c.order);
  r.refReturnBigger = refCards.length > 0 && refCards.every((c) => c.bigger);
  /* 라벨 문자열은 유지돼야 한다(다른 검사가 문자열을 본다) */
  const txt = DOC.getElementById("alloc").textContent;
  r.labelsIntact = /기대수익 /.test(txt) && /위험 /.test(txt);
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-g. λ(위험회피계수) 선택 — 2026-08-12 사용자 지시 =================
   ① λ 단조성이 화면 경로에서도 성립하는가(키인 → 최적 위험이 준다)
   ② 역산(현재 위험을 재현하는 λ)이 **실제로 그 위험을 재현**하는가 — 손계산이 아니라
      역산값을 다시 최적화에 넣어 σ 를 대조한다
   ③ 도달 불가면 조용히 끝값을 쓰지 않고 `bounded` 로 알리는가
   ④ λ 는 모형 입력이라 즉시 저장되고(비중과 반대), 손상값은 소독되는가 */
safe("lambdaControl", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");
  const A = CMA_ALLOC;
  const st = P.allocDefaults(A);
  const E = P.allocEngine(A, st);
  const { mu, C } = E.V;
  const sigAt = (lam) => E.sigmaW(E.optimizeUtilAt(mu, C, lam, 1, 700), C);

  /* ① 단조성 — λ 가 커지면 최적해의 위험이 준다(역산 이분법의 전제) */
  const s1 = sigAt(0.5), s2 = sigAt(5), s3 = sigAt(50);
  r.sigmaMonotoneInLambda = s1 >= s2 - 1e-9 && s2 >= s3 - 1e-9;
  r.sigmaActuallyMoves = s1 - s3 > 1e-3;

  /* ② 역산 — 임의의 λ 로 만든 최적해의 위험을 목표로 주면 그 λ 가 되돌아온다
     (자기무결성 검사: 손계산 상수 없이 왕복으로 잰다) */
  const lamTrue = 4;
  const sigTrue = sigAt(lamTrue);
  const fit = P.allocLambdaForSigma(E, sigTrue);
  r.fitFound = !!fit && fit.bounded === null;
  r.fitReproducesSigma = !!fit && Math.abs(fit.sig - sigTrue) < 0.02;
  r.fitLambdaCloseToTruth = !!fit && Math.abs(fit.lam - lamTrue) / lamTrue < 0.25;

  /* ③ 도달 불가 — 아주 낮은/높은 목표는 bounded 로 알린다(끝값을 정답이라 하지 않는다) */
  const tooLow = P.allocLambdaForSigma(E, sigAt(500) * 0.5);
  const tooHigh = P.allocLambdaForSigma(E, sigAt(0.02) * 2);
  r.boundedHigh = !!tooLow && tooLow.bounded === "high";
  r.boundedLow = !!tooHigh && tooHigh.bounded === "low";
  r.rejectsBadTarget = P.allocLambdaForSigma(E, 0) === null;

  /* ④ 화면 — 입력칸이 있고, 바꾸면 즉시 저장되며(모형 입력), 최적 카드가 따라 움직인다 */
  P.DATA.alloc = A;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const panel = DOC.getElementById("alloc-sim-panel");
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  const inp = DOC.getElementById("alloc-lambda");
  r.inputExists = !!inp;
  const riskOf = () => {
    const m = (panel.textContent.match(/① 최적 포트폴리오[^위]*위험 ([\d.]+)%/) || [])[1];
    return m ? +m : null;
  };
  const riskBefore = riskOf();
  inp.value = "50";
  inp.dispatchEvent({ type: "change", target: inp });
  const savedLam = JSON.parse(shim.localStorage.getItem("iaw-alloc") || "null");
  r.savesImmediately = !!savedLam && savedLam.mvo_lambda === 50;
  const riskAfter = riskOf();
  r.optimumFollowsLambda = riskBefore != null && riskAfter != null && riskAfter < riskBefore - 1e-9;
  /* 손상값 소독 — 0·음수·문자는 기본 1 로 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, mvo_lambda: -3 }));
  r.badLambdaSanitized = P.allocState(A).mvo_lambda === 1;

  /* ⑤ 「현재 위험과 같은 λ 찾기」 버튼 — 눌렀을 때 저장된 λ 가 현재 위험을 재현한다 */
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const p2 = DOC.getElementById("alloc-sim-panel");
  const fitBtn = Array.from(p2.querySelectorAll("button"))
    .find((n) => /현재 위험과 같은 λ/.test(n.textContent));
  r.fitButtonExists = !!fitBtn;
  const Ecur = P.allocEngine(A, P.allocDefaults(A));
  const sigCur = Ecur.sigmaW(Ecur.w0, Ecur.V.C);
  if (fitBtn) fitBtn.click();
  const st2 = P.allocState(A);
  r.fitButtonSavedLambda = st2.mvo_lambda > 0 && st2.mvo_lambda !== 1;
  const E2 = P.allocEngine(A, st2);
  const sigOpt = E2.sigmaW(E2.optimizeUtilAt(E2.V.mu, E2.V.C, st2.mvo_lambda, 1, 700), E2.V.C);
  r.fitButtonReproducesCurrentRisk = Math.abs(sigOpt - sigCur) < 0.05;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P20-h. 헤지 2트랙(§7.7.13) — 최적(배분+헤지 교대) vs 시뮬 ============
   ① 교대 최적화가 수렴하고, 헤지쌍이 Xe 를 정확히 재현하며(대표점 계약),
      효용이 "현재 헤지 고정 배분 최적"보다 나쁘지 않은가(동시해 ≥ 부분해)
   ② 화면 — 두 카드 모두 헤지 문장, ① 대표점 표기, 「헤지 슬라이더를 최적으로」가
      슬라이더를 실제로 움직이고 저장하지 않는가(조정/저장 분리)
   ③ 통화별 분해 — 벤치마크 출처 표기·행 합 = 슬리브 노출·비율 균일 사실 명시
   ④ 환율 축 부재 — 헤지 무력을 밝히고 배분만 최적화하는가 */
safe("hedgeTracks", () => {
  const r = {};
  shim.localStorage.removeItem("iaw-alloc");
  const st = P.allocDefaults(CMA_ALLOC);
  const E = P.allocEngine(CMA_ALLOC, st);
  const jo = P.allocJointOpt(E, st);

  /* ① 수렴·대표점 정합·동시해 우월성 */
  r.converged = !!jo && jo.converged === true;
  r.pairReproducesXe = !!jo && Math.abs(E.xeOfW(jo.w, jo.hb, jo.he) - jo.xe) < 1e-9;
  const util = (mu, C, w, lam) => {
    const m = w.reduce((a, wi, i) => a + wi * mu[i], 0) / 100;
    const v = w.reduce((a, wi, i) => a + wi * C[i].reduce((t, c, j) => t + c * w[j], 0), 0) / 1e4;
    return m - lam / 2 * v;
  };
  const B0 = E.build(st.h_bond / 100, st.h_eq / 100);
  const wFixed = E.optimizeUtilAt(B0.mu, B0.C, 1, 1);
  const Bj = E.build(jo.hb, jo.he);
  r.jointBeatsFixedHedge = util(Bj.mu, Bj.C, jo.w, 1) >= util(B0.mu, B0.C, wFixed, 1) - 1e-9;
  /* 헤지 밴드가 물면 쌍이 밴드 안에 있어야 한다 */
  const stB = { ...st, h_bands: { 해외채권: [70, 100], 해외주식: [0, 20] } };
  const joB = P.allocJointOpt(P.allocEngine(CMA_ALLOC, stB), stB);
  r.pairRespectsBands = !!joB && joB.hb >= 0.7 - 1e-9 && joB.he <= 0.2 + 1e-9;

  /* ② 화면 */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const panel = DOC.getElementById("alloc-sim-panel");
  r.renderErrors = DOC.getElementById("alloc").querySelectorAll(".render-error").length;
  const hedgeLines = panel.querySelectorAll(".sim-hedge-line");
  r.bothCardsShowHedge = hedgeLines.length === 2;
  r.optCardSaysRepresentative = /대표점/.test(panel.textContent)
    && /배분\+헤지/.test(panel.textContent);
  const sliders = Array.from(panel.querySelectorAll("input"))
    .filter((n) => /헤지비율$/.test(n.getAttribute("aria-label") || ""));
  r.slidersLiveInPanel = sliders.length === 2;
  const applyH = Array.from(panel.querySelectorAll("button"))
    .find((n) => /헤지 슬라이더를 최적으로/.test(n.textContent));
  r.applyHedgeButtonExists = !!applyH;
  /* 이미 최적이면 버튼이 스스로 그 사실을 말한다(눌리는데 무동작 = 고장으로 읽힌다) */
  const noopBtnBefore = Array.from(panel.querySelectorAll("button"))
    .find((n) => /헤지 슬라이더 — 이미 최적/.test(n.textContent));
  r.noopButtonAbsentWhenMovable = !noopBtnBefore;
  if (applyH) applyH.click();
  const st2 = P.allocState(CMA_ALLOC);   // 저장 안 됨 — 디폴트 그대로여야 한다
  r.applyHedgeDoesNotSave = shim.localStorage.getItem("iaw-alloc") == null;
  /* 적용 후 재렌더에서는 「이미 최적」 비활성 버튼이 되어 있어야 한다 */
  const p2b = DOC.getElementById("alloc-sim-panel");
  const noopBtn = Array.from(p2b.querySelectorAll("button"))
    .find((n) => /헤지 슬라이더 — 이미 최적/.test(n.textContent));
  r.noopButtonAppearsAfterApply = !!noopBtn && noopBtn.disabled === true;
  const sliderVals = sliders.map((n) => +n.value);
  r.applyHedgeMovesSliders = !!jo
    && Math.abs(sliderVals[0] - Math.round(jo.hb * 100)) < 1.5
    && Math.abs(sliderVals[1] - Math.round(jo.he * 100)) < 1.5;

  /* ③ 통화별 분해 — 벤치마크 출처·행 합 = 슬리브 노출 */
  const d = P.allocCcyHedgeRows(CMA_ALLOC, st, 21, 6, 0.9, 0.3);
  r.ccyRowsExist = !!d && d.rows.length >= 5;
  r.ccySrcIsBench = !!d && d.src.해외채권 === "벤치마크" && d.src.해외주식 === "벤치마크";
  if (d) {
    const expSum = d.rows.reduce((a, x) => a + x.exp, 0);
    const covered = 21 * d.coverage.해외채권 / 100 + 6 * d.coverage.해외주식 / 100;
    r.ccyExposureSumMatchesCoverage = Math.abs(expSum - covered) < 1e-6;
    /* 슬리브 균일 비율 — 채권만 담으면 모든 통화의 헤지/노출 비가 hb 와 같다 */
    const db = P.allocCcyHedgeRows(CMA_ALLOC, st, 30, 0, 0.8, 0);
    r.ccyUniformWithinSleeve = db.rows.every((x) => Math.abs(x.hedged / x.exp - 0.8) < 1e-9);
  }
  const det = panel.querySelector(".sim-ccy");
  r.ccyTableRendered = !!det && /통화별 환헤지 분해/.test(det.textContent);
  r.ccyHonestAboutUniform = !!det && /같은 비율이 걸립니다/.test(det.textContent);

  /* ③-b 최적 헤지 마커(§7.7.15, 2026-08-12 사용자 지시) — 비중 막대의 ▼ 와 같은 방식.
     비중 0 슬리브는 위험에 무영향이라 마커를 숨기고, 그 사실을 카드가 적어야 한다. */
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const p3 = DOC.getElementById("alloc-sim-panel");
  /* **대체투자 환헤지 래퍼를 함께 세지 말 것**(§7.7.20) — 같은 행·같은 래퍼를 쓰지만
     최적화 레버가 아니라 모형 입력이라 ▼ 가 없다. `.sim-alt-hedge` 로 갈라낸다
     (§7.7.15 의 `.sim8-row` 한정과 같은 이유 — 래퍼 공유는 계속 늘어난다). */
  const allWraps = Array.from(p3.querySelectorAll(".sim-hedge-row .sim-bar-wrap"));
  const hedgeWraps = allWraps.filter((w) => !w.classList.contains("sim-alt-hedge"));
  r.hedgeMarkWrappers = hedgeWraps.length;
  r.altHedgeWrapSeparate = allWraps.length - hedgeWraps.length === 1;
  const hMarks = hedgeWraps.map((w) => w.querySelector(".sim-opt-mark")).filter(Boolean);
  r.hedgeMarksExist = hMarks.length === 2;
  const jo2 = P.allocJointOpt(P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC)),
    P.allocDefaults(CMA_ALLOC));
  const shown = hMarks.filter((m) => !m.hidden);
  /* 보이는 마커의 위치가 최적쌍과 일치하는가(무영향 슬리브는 숨김이 정답) */
  r.hedgeMarkMatchesOptimum = shown.every((m) => {
    const left = parseFloat(m.style.left);
    return Math.abs(left - jo2.hb * 100) < 0.6 || Math.abs(left - jo2.he * 100) < 0.6;
  });
  r.hedgeMarkSaysRepresentative = shown.every((m) => /대표점/.test(m.title || ""));
  r.hedgeMarkHiddenWhenInert =
    (!jo2.inertBond || hMarks[0].hidden) && (!jo2.inertEq || hMarks[1].hidden);

  /* ③-c 대체투자 환헤지 슬라이더(§7.7.20 — 2026-08-19 사용자 지시) — 같은 행에
     있지만 **규약이 셋 다 다르다**: ① 최적 ▼ 가 없고(최적화 대상이 아님) ②
     조정하면 즉시 저장되며(모형 입력 — μ·σ·λ 와 같은 칸) ③ 「저장 안 됨」 배지를
     띄우지 않는다(저장했으니 배지가 뜨면 거짓말이다). 셋을 실행으로 고정한다. */
  {
    const altWrap = p3.querySelector(".sim-bar-wrap.sim-alt-hedge");
    const altInp = altWrap && altWrap.querySelector("input");
    r.altHedgeSliderExists = !!altInp
      && altInp.getAttribute("aria-label") === "대체투자 환헤지 비율";
    r.altHedgeHasNoOptMark = !!altWrap
      && altWrap.querySelectorAll(".sim-opt-mark").length === 0;
    /* Xe 와 다르다는 사실을 화면이 적는가 — 합치면 최적 헤지쌍이 이 값을 덮어쓴다 */
    r.altHedgeExplainsNotXe = /Xe 에는 들어가지 않습니다/.test(p3.textContent);
    const badgeBefore = p3.querySelector(".sim-dirty");
    if (altInp) {
      altInp.value = "40";
      altInp.dispatchEvent({ type: "input", target: altInp });
      altInp.dispatchEvent({ type: "change", target: altInp });
      const savedAlt = JSON.parse(shim.localStorage.getItem("iaw-alloc") || "null");
      r.altHedgeSavesImmediately = !!savedAlt && savedAlt.h_alt === 40;
      /* 배지는 「조정했지만 저장 안 됨」의 표시다 — 즉시 저장 칸이 이걸 켜면 안 된다 */
      const badgeAfter = DOC.getElementById("alloc-sim-panel").querySelector(".sim-dirty");
      r.altHedgeDoesNotMarkDirty =
        (!badgeBefore || badgeBefore.hidden) && (!badgeAfter || badgeAfter.hidden);
    }
  }
  /* 비중 0 슬리브가 있으면 카드가 그 사유를 적는다 — 합성으로 강제한다:
     해외채권 밴드를 [0,0] 으로 눌러 최적 배분의 해외채권을 0 으로 만든다. */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    bands: { ...P.allocDefaults(CMA_ALLOC).bands, 해외채권: [0, 0] } }));
  P.renderSection("alloc");
  const whyTxt = DOC.getElementById("alloc-sim-panel").textContent;
  r.inertSleeveExplained = /해외채권 비중이 0이라 채권 헤지비율은 위험에 영향이 없습니다/.test(whyTxt);
  /* 구속의 **출처**를 구분하는가 — 내규 밴드(band) vs 구조적 한계(cap).
     한 문장으로 뭉치면 중립 밴드 상태에서도 「밴드가 물고 있다」가 나가 사용자를
     밴드 완화라는 틀린 조치로 보낸다(재점검 발견). */
  const BAND_RE = /헤지 밴드\(내규 키인\)가 구간을 좁힙니다/;
  const CAP_RE = /환노출의 상한입니다/;
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    h_bands: { 해외채권: [95, 100], 해외주식: [95, 100] } }));
  P.renderSection("alloc");
  const bandTxt = DOC.getElementById("alloc-sim-panel").textContent;
  r.bandBindExplained = BAND_RE.test(bandTxt);
  /* **「밴드 단독」을 픽스처로 못박지 말 것.** 두 구속은 동시에 성립할 수 있고(§7.7.17),
     어느 쪽이 무는지는 공분산이 바뀌면 따라 바뀐다 — 실제로 §7.7.19 의 환 기준 교정 뒤
     이 시나리오가 band-only 에서 both 로 옮겨 갔다(헤지를 강제당한 해외주식이 더
     위험해져 최적 배분이 해외자산을 비우고, 그러면 구조적 상한도 함께 문다 — 화면이
     둘 다 적는 것이 옳다). 그래서 「밴드만 나와야 한다」가 아니라 **화면 문장이 이 카드가
     실제로 쓰는 판정(allocJointOpt)과 일치하는가**를 본다. 둘을 구분하는 능력 자체는
     아래 ③-e 의 단위 검사(crafted 입력)가 고정한다.
     비교 대상은 **최적 배분**이다 — 이 카드는 ① 이라 현재 배분(w0)이 아니다. */
  const stBand = { ...P.allocDefaults(CMA_ALLOC),
    h_bands: { 해외채권: [95, 100], 해외주식: [95, 100] } };
  const joBand = P.allocJointOpt(P.allocEngine(CMA_ALLOC, stBand), stBand);
  r.bandCaseActuallyBindsBand = joBand.bandBinds === true;
  r.bandScreenMatchesVerdict =
    BAND_RE.test(bandTxt) === joBand.bandBinds && CAP_RE.test(bandTxt) === joBand.capBinds;
  /* 중립 밴드 + 노출 상한 구속 — 밴드가 아니라 비중이 원인이라고 적어야 한다.
     해외 비중을 눌러(밴드 [0,2]) 최적 노출 폭을 좁히면 이 상태가 만들어진다. */
  const dflt2 = P.allocDefaults(CMA_ALLOC);
  const stCap = { ...dflt2,
    bands: { ...dflt2.bands, 해외채권: [0, 2], 해외주식: [0, 2] } };
  const joCap = P.allocJointOpt(P.allocEngine(CMA_ALLOC, stCap), stCap);
  r.capFlagSet = joCap.capBinds === true && joCap.bandBinds === false;
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, bands: stCap.bands }));
  P.renderSection("alloc");
  const capTxt = DOC.getElementById("alloc-sim-panel").textContent;
  r.capExplainedAsExposure = CAP_RE.test(capTxt);
  r.capCaseNotCalledBand = !BAND_RE.test(capTxt);

  /* ③-c **동시 구속**(§7.7.17 — 적대적 재검증이 잡은 결함).
     예전 코드는 band/cap 을 if/else 로 갈라 하나만 켰다. 그래서 「내규 최소헤지가
     있으면서 동시에 무제약 최적 Xe 가 해외자산 비중보다 큰」 상태에서 **밴드 문장만**
     나가고, 사용자가 지시대로 밴드를 중립까지 풀어도 목표에 못 닿았다 —
     §7.7.16 이 없애려던 오귀인이 그대로 되살아난 것이다(실데이터 λ×하한 28조합 중 6).
     여기서는 해외 비중을 눌러 구조적 상한을 만들고 채권 헤지 하한을 얹어 그 상태를
     재현한다. **두 문장이 모두** 나가야 한다.
     해외채권 밴드는 `[2,2]` 로 **고정**해야 한다 — `[0,2]` 로 두면 최적화가 해외채권을
     0 으로 보내 버려 채권 헤지 하한이 아무것도 좁히지 못하고(band=false) 시나리오가
     성립하지 않는다(실측). */
  const stBoth = { ...dflt2,
    bands: { ...dflt2.bands, 해외채권: [2, 2], 해외주식: [0, 2] },
    h_bands: { 해외채권: [50, 100], 해외주식: [0, 100] } };
  const joBoth = P.allocJointOpt(P.allocEngine(CMA_ALLOC, stBoth), stBoth);
  r.coBindFlagsBothSet = joBoth.bandBinds === true && joBoth.capBinds === true;
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    bands: stBoth.bands, h_bands: stBoth.h_bands }));
  P.renderSection("alloc");
  const bothTxt = DOC.getElementById("alloc-sim-panel").textContent;
  r.coBindShowsBandSentence = BAND_RE.test(bothTxt);
  r.coBindShowsCapSentence = CAP_RE.test(bothTxt);
  /* 밴드 문장은 **완화하면 얼마가 움직이는지** 두 수를 적어야 한다(조치의 크기) */
  r.bandSentenceStatesGain = /구간을 좁힙니다 — 밴드를 중립\(0~100%\)까지 풀면 Xe [\d.]+% → [\d.]+%/
    .test(bothTxt);
  shim.localStorage.removeItem("iaw-alloc");

  /* ③-d 옛 오귀인 문구가 **어디에도** 남아 있지 않은가 — 화면 네 자리가 같은
     copy(`allocXeBindNotes`)를 쓰는지 확인하는 자리다. 예전에는 ① 카드만 고치고
     요약표·레버 문단·헤지 곡면 오버레이가 분리 이전 단일 플래그를 그대로 썼다. */
  r.legacyPhraseGone = !/헤지 밴드가 물고 있습니다|밴드가 물고 있습니다/
    .test(DOC.getElementById("alloc").textContent);

  /* ③-e 판정 함수 단위 — 네 상태 × 두 방향. 특히 **하한 물림**에 상한 문안을
     붙이지 않는지(그때의 구속은 해외자산 비중이 아니라 「오버헤지 불가」다). */
  const bNone = P.allocXeBinds(0.15, 0, 0.15, 0.08);
  const bBand = P.allocXeBinds(0.15, 0, 0.10, 0.12);
  const bCap = P.allocXeBinds(0.05, 0, 0.05, 0.11);
  const bBoth = P.allocXeBinds(0.05, 0, 0.045, 0.11);
  const bLo = P.allocXeBinds(0.15, 0, 0.15, -0.03);
  r.unitNone = !bNone.bandBinds && !bNone.capBinds && bNone.side === null;
  r.unitBandOnly = bBand.bandBinds && !bBand.capBinds && bBand.side === "hi";
  r.unitCapOnly = !bCap.bandBinds && bCap.capBinds && bCap.side === "hi";
  r.unitBoth = bBoth.bandBinds && bBoth.capBinds;
  r.unitLowerIsCap = !bLo.bandBinds && bLo.capBinds && bLo.side === "lo";
  const loNotes = P.allocXeBindNotes(bLo);
  r.lowerBoundUsesOverhedgeWording =
    loNotes.length === 1 && /오버헤지 불가/.test(loNotes[0]);
  r.lowerBoundNotBlamedOnWeight = !/해외자산 비중/.test(loNotes.join(" "));
  r.bothNotesAreTwoSentences = P.allocXeBindNotes(bBoth).length === 2;
  r.noneNotesEmpty = P.allocXeBindNotes(bNone).length === 0;

  /* ③-f 화면 **네 자리**가 실제로 같은 판정을 쓰는가.
     ① 시뮬레이터 최적 카드는 위에서 봤고, 나머지 셋(요약표 `#alloc-summary` ·
     레버 문단 · 헤지 곡면 오버레이)을 여기서 본다. 이 셋은 **현재 배분(w0)** 기준이라
     ① 과 수가 다를 수 있다 — 다른 포트폴리오를 설명하는 자리이므로 정상이다.
     따라서 「① 과 같은 문장이 나오는가」가 아니라 「자기 w0 판정과 일치하는가」를 본다.
     해외 비중을 각 1% 로 두고 밴드는 중립 — 구조적 상한만 무는 상태다(각 2% 로 두면
     이 픽스처에서는 xeFree 3.31% < wF 4.00% 라 아무것도 물지 않는다 — 실측). */
  const mixLowFx = { ...dflt2.mix, 해외채권: 1, 해외주식: 1, 국내채권: dflt2.mix.국내채권 +
    ((dflt2.mix.해외채권 - 1) + (dflt2.mix.해외주식 - 1)) };
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, mix: mixLowFx,
    h_bands: { 해외채권: [0, 100], 해외주식: [0, 100] } }));
  P.renderSection("alloc");
  const stLow = P.allocState(CMA_ALLOC);
  const ELow = P.allocEngine(CMA_ALLOC, stLow);
  const qLow = ELow.xeQuad();
  const [lLo, lHi] = P.allocXeRange(ELow, P.allocHBands(stLow));
  const bLow = P.allocXeBinds(ELow.xeOf(0, 0), lLo, lHi, ELow.xeStar(null, null, qLow));
  const sumTxt = DOC.getElementById("alloc-summary").textContent;
  const wantCap = bLow.capBinds, wantBand = bLow.bandBinds;
  r.summaryMatchesOwnBinds =
    CAP_RE.test(sumTxt) === wantCap && BAND_RE.test(sumTxt) === wantBand;
  r.summaryCapBindsHere = wantCap === true;   // 시나리오가 실제로 그 상태인지 고정
  r.summaryNotCalledBand = !BAND_RE.test(sumTxt);
  /* 레버 문단은 요약표와 `hq` 한 벌을 공유한다 — 따로 계산하면 두 「최적」이 갈린다 */
  const leverTxt = DOC.getElementById("alloc").textContent;
  r.leverMatchesSummary = CAP_RE.test(leverTxt) === wantCap;
  /* 헤지 곡면 오버레이 — 방법론 설명 자리라 원인 진단의 근거로 읽힌다.
     여는 것은 `handleHash()` 지만 프로브는 그 진입점을 갖고 있지 않으므로(해시만 바꿔서는
     열리지 않는다 — 실측) 렌더 함수를 직접 부른다. */
  P.openAllocDetail("hedge");
  const ovTxt = DOC.getElementById("detail-overlay").textContent;
  r.overlayRendered = /동률 능선/.test(ovTxt);
  r.overlayMatchesOwnBinds =
    CAP_RE.test(ovTxt) === wantCap && BAND_RE.test(ovTxt) === wantBand;
  r.overlayLegacyPhraseGone = !/밴드가 물고 있습니다/.test(ovTxt);
  P.hideDetail();
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");

  /* ④ 환율 축 부재 — 무력 명시 + 배분만 최적화 */
  const NOFX2 = { ...CMA_ALLOC, cma: stripCmaCol(CMA_ALLOC.cma, "_fx") };
  const Ef = P.allocEngine(NOFX2, P.allocDefaults(NOFX2));
  const jf = P.allocJointOpt(Ef, P.allocDefaults(NOFX2));
  r.noFxJointStillOptimizesWeights = !!jf && jf.xe === null && Array.isArray(jf.w);
  P.DATA.alloc = NOFX2;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  r.noFxCardSaysInert = /헤지는 무력/.test(DOC.getElementById("alloc-sim-panel").textContent);
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P21. 통화 구성 — 벤치마크 디폴트와 커버리지 =========================
   기관 실제 비중은 수기입력이고 저장소에 없다. 화면이 채워 주는 것은 **공개 벤치마크**
   뿐이며, 두 자산군의 근거 품질이 달라(채권=표시통화 직접 집계 / 주식=국가→통화 근사)
   커버리지를 숨기지 않고 그대로 세는지 확인한다. */
safe("ccyMix", () => {
  const r = {};
  const A = ALLOC_FIXTURE;
  const st = P.allocDefaults(A);

  /* 기본은 **미입력** — 벤치마크를 몰래 적용하지 않는다 */
  r.emptyByDefault = P.allocCcySum(st, "해외채권").entered === false;

  /* 모형 통화 집합이 hedge.py 와 같은 7개인가 */
  r.currencies = P.ALLOC_CCY;

  const b = A.ccy_bench["해외채권"];
  const st2 = { ...st, ccy: { 해외채권: { ...b.w, KRW: b.krw, OTHER: b.other }, 해외주식: {} } };
  const s = P.allocCcySum(st2, "해외채권");
  r.bondInModel = +s.inModel.toFixed(4);
  r.bondKrw = s.krw;
  r.bondOther = s.other;
  r.bondTotal = +s.total.toFixed(4);
  r.bondEntered = s.entered;

  const be = A.ccy_bench["해외주식"];
  const st3 = { ...st, ccy: { 해외채권: {}, 해외주식: { ...be.w, KRW: be.krw, OTHER: be.other } } };
  const se = P.allocCcySum(st3, "해외주식");
  r.eqInModel = +se.inModel.toFixed(4);
  r.eqTotal = +se.total.toFixed(4);
  /* 채권 커버리지가 주식보다 높아야 한다 — 근거 품질 차이가 숫자로 드러나는 자리 */
  r.bondCoverageBeatsEquity = s.inModel > se.inModel;

  /* 부분 입력이어도 합계를 100 으로 **부풀리지 않는다** */
  const st4 = { ...st, ccy: { 해외채권: { USD: 50 }, 해외주식: {} } };
  r.partialStaysPartial = P.allocCcySum(st4, "해외채권").total === 50;

  /* 구버전 저장 상태(ccy 키 없음)로도 죽지 않는가 */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true, h_bond: 90 }));
  const legacy = P.allocState(A);
  r.legacyStateGetsCcy = !!(legacy.ccy && legacy.ccy["해외채권"] && legacy.ccy["해외주식"]);
  shim.localStorage.removeItem("iaw-alloc");
  return r;
});

/* ====== P22. 시뮬레이션 콘솔 — 즉시 반영·저장 분리 (기능 2의 동선) ==========
   담당자의 두 메인 용례: ① 최적 배분·헤지가 얼마인가(요약 표) ② 마음대로 조정하며
   수익·위험 변화를 보기(즉시 반영 + 저장 분리). 아래는 그 동선이 실제로 성립하는지를
   **실행으로** 잰다 — 특히 "조정이 localStorage 에 몰래 저장되지 않는다"가 계약이다. */
safe("simConsole", () => {
  const r = {};
  P.DATA.alloc = ALLOC_FIXTURE;
  const store = shim.localStorage;
  store.removeItem("iaw-alloc");
  P.renderSection("alloc");

  const summary = DOC.getElementById("alloc-summary");
  const txt0 = summary.textContent;
  r.summaryRendered = txt0.length > 0;
  r.summaryHasBothAnswers = /참고치/.test(txt0) && /미헤지 환노출 Xe/.test(txt0) && /헤지 채권\/주식/.test(txt0);
  r.summaryAdmitsPartiality = /동시 최적해가 아닙니다/.test(txt0);

  /* ① 배분 입력 즉시 반영 — 해외주식을 6→20 으로 올리면 요약 위험이 변해야 한다 */
  const sigOf = (t) => {
    const m = t.match(/(\d+\.\d+)%/g);           // 셀 텍스트에서 숫자만 — 위치 비교는 아래에서
    return m ? m.join("|") : "";
  };
  const inp = DOC.getElementById("sim-mix-해외주식");
  r.mixInputExists = !!inp;
  const before = summary.textContent;
  inp.value = "20";
  inp.dispatchEvent({ type: "input", target: inp });
  const after = summary.textContent;
  r.recalcIsImmediate = before !== after;
  r.dirtyBadgeShown = Array.from(DOC.body.querySelectorAll(".sim-dirty")).some((n) => !n.hidden);
  r.showsBaselineRowWhenDirty = /기준\(저장값\)/.test(after) && /지금 조정/.test(after);

  /* ② 조정은 저장되지 않는다 — change 이벤트까지 보내도 localStorage 는 빈 채여야 한다 */
  inp.dispatchEvent({ type: "change", target: inp });
  r.notSavedOnChange = store.getItem("iaw-alloc") == null;

  /* 헤지 슬라이더도 같은 계약 — range input 을 움직여도 저장 안 됨 */
  /* 헤지 슬라이더는 §7.7.13 에서 시뮬레이터 패널로 이사 — aria-label 로 집는다
     (패널에는 비중 막대 range 7개도 있다) */
  const range = Array.from(DOC.getElementById("alloc-sim-panel").querySelectorAll("input"))
    .find((n) => (n.getAttribute("aria-label") || "") === "해외채권 헤지비율");
  r.sliderExists = !!range;
  if (range) {
    range.value = "40";
    range.dispatchEvent({ type: "input", target: range });
    range.dispatchEvent({ type: "change", target: range });
  }
  r.sliderNotAutoSaved = store.getItem("iaw-alloc") == null;

  /* ③ 합계 가드 — 20 으로 올렸으니 목표 100(대출금 제외 확정)과 어긋나 경고여야 한다 */
  const badge = DOC.body.querySelector(".sim-sum");
  r.sumBadgeWarns = !!badge && badge.classList.contains("warn");
  r.badgeHasNoLoanClause = !!badge && !/대출/.test(badge.textContent);
  /* 과다 배분(합계 114 > 목표 100)은 단기자금을 0 으로 눌러도 못 맞춘다 — 버튼이
     조용히 "맞췄다"고 하면 안 된다. 눌러도 warn 이 남아야 한다. */
  const fillBtn = Array.from(DOC.getElementById("alloc").querySelectorAll("button"))
    .find((n) => n.textContent.includes("잔여"));
  if (fillBtn) fillBtn.click();
  r.fillCashCannotFixOverAllocation = !!badge && badge.classList.contains("warn");
  /* 과소 배분(해외주식 2 → 합계 96)은 잔여 4%p 를 단기자금에 채워 목표에 맞는다 */
  inp.value = "2";
  inp.dispatchEvent({ type: "input", target: inp });
  if (fillBtn) fillBtn.click();
  r.fillCashFixesUnderAllocation = !!badge && !badge.classList.contains("warn");

  /* ④ 저장은 버튼으로만 — 누르면 비로소 localStorage 에 남고 기준선이 갱신된다 */
  const saveBtn = Array.from(DOC.getElementById("alloc-controls").querySelectorAll("button"))
    .find((n) => n.textContent.includes("기본값으로 저장"));
  r.saveButtonExists = !!saveBtn;
  if (saveBtn) saveBtn.click();
  const saved = JSON.parse(store.getItem("iaw-alloc") || "null");
  r.saveWritesStorage = !!saved && saved.mix && saved.mix["해외주식"] === 2;
  r.saveSchemaHasNoLegacyKeys = !!saved && saved.mix_acct === undefined && saved.bands_acct === undefined;
  /* 저장 후 재렌더 — 기준선 = 새 저장값이므로 「기준(저장값)」 행이 사라져야 한다 */
  r.baselineResetAfterSave = !/기준\(저장값\)/.test(DOC.getElementById("alloc-summary").textContent);

  /* ⑤ 되돌리기 — 조정 후 누르면 저장값으로 복귀 */
  const inp2 = DOC.getElementById("sim-mix-해외주식");
  inp2.value = "7";
  inp2.dispatchEvent({ type: "input", target: inp2 });
  const revertBtn = Array.from(DOC.getElementById("alloc-controls").querySelectorAll("button"))
    .find((n) => n.textContent.includes("되돌리기"));
  if (revertBtn) revertBtn.click();
  r.revertRestoresSaved = (DOC.getElementById("sim-mix-해외주식") || {}).value === "2";

  store.removeItem("iaw-alloc");
  return r;
});

/* ============ §7.13 설명 접기 — 답·경고만 보이고 산문은 클릭 뒤 ============
   details.explain 은 코드 토글(preventDefault + open 반전)이라 셰이드에서도 실행으로
   잰다. 핵심 계약 둘: ① 기본 닫힘 + 같은 id 재생성 시 열림 유지(recalc 내성) ②
   **경고·사유는 explain 안에 있지 않다** — 접힌 정보는 없는 정보라, 구속 ⚠·폴백
   사유가 접히면 §7.7.17·§7.8.1 계약이 조용히 무력화된다. visText() 가 닫힌 explain
   본문을 제외한 「보이는 텍스트」를 계산해 그 계약을 실행으로 확인한다. */
const visText = (node) => {
  let t = "";
  const walk = (n) => {
    if (n.nodeType === 3) { t += n.textContent; return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === "DETAILS" && !n.hasAttribute("open")) {
      const sum = (n.children || []).find((c) => c.tagName === "SUMMARY");
      if (sum) t += sum.textContent;
      return;
    }
    (n.childNodes || []).forEach(walk);
  };
  walk(node);
  return t;
};
safe("explainFold", () => {
  const r = {};
  r.helperExists = typeof P.explainBox === "function";
  /* 단독 동작 — 기본 닫힘 · 클릭 토글 · 같은 id 재생성 시 상태 유지 */
  P.EXPLAIN_OPEN.clear();
  const d1 = P.explainBox("probe-x", "본문내용");
  r.closedByDefault = !d1.hasAttribute("open");
  r.labelDefault = d1.querySelector("summary").textContent === "설명";
  r.customLabel = P.explainBox("probe-y", { label: "커스텀" }, "x")
    .querySelector("summary").textContent === "커스텀";
  d1.querySelector("summary").click();
  r.clickOpens = d1.hasAttribute("open");
  const d2 = P.explainBox("probe-x", "본문내용");     // recalc 재생성 시뮬레이션
  r.reopenSurvivesRerender = d2.hasAttribute("open");
  d2.querySelector("summary").click();
  r.clickCloses = !d2.hasAttribute("open");
  r.closeAlsoSurvives = !P.explainBox("probe-x", "본문내용").hasAttribute("open");
  /* 닫힌 본문은 「보이는 텍스트」에서 빠지고, 열면 들어온다 */
  const d3 = P.explainBox("probe-z", "숨은본문");
  const host = P.el("div", {}, "보이는답 ", d3);
  r.closedBodyHidden = !visText(host).includes("숨은본문") && visText(host).includes("보이는답");
  d3.querySelector("summary").click();
  r.openBodyVisible = visText(host).includes("숨은본문");

  /* 화면 적용 — alloc 를 렌더해 explain 이 실제로 깔렸고 전부 닫혀 있는지 */
  P.EXPLAIN_OPEN.clear();
  P.DATA.alloc = CMA_ALLOC;
  shim.localStorage.removeItem("iaw-alloc");
  P.renderSection("alloc");
  const panel = DOC.getElementById("alloc");
  const folds = panel.querySelectorAll("details.explain");
  r.allocHasFolds = folds.length >= 5;
  r.allFoldsClosedByDefault = folds.every((d) => !d.hasAttribute("open"));
  const vis = visText(panel);
  const full = panel.textContent;
  /* 접기의 요점 — 보이는 글자가 전체의 일부여야 한다(산문이 실제로 접혀 있다) */
  r.visibleIsSubset = vis.length < full.length * 0.85;
  /* 계약 문자열은 textContent 에 남는다(닫혀 있어도) — 기존 프로브들의 전제 */
  r.contractStringsStillInDom = /Xe 에는 들어가지 않습니다/.test(full);
  /* 핵심 답·경고는 **보이는 텍스트**에 있어야 한다 */
  r.answersVisible = /기대수익 /.test(vis) && /위험 /.test(vis) && /① 최적 포트폴리오/.test(vis);
  r.hedgeControlsVisible = /해외채권 헤지비율/.test(vis) && /대체투자 환헤지 비율/.test(vis);
  /* 산문 대표 두 건은 보이는 텍스트에서 빠져 있어야 한다(접힘 확인) */
  r.proseFolded = !/레버는 두 개뿐입니다/.test(vis) && !/원가법 BM 은 시장위험을 나르지 않아/.test(vis);

  /* 경고는 접히지 않는다 — 밴드를 눌러 구속을 강제하고, ⚠ 문장이 **보이는** 텍스트에
     있는지 잰다(§7.7.17 네 자리 중 시뮬레이터 카드·요약표가 이 화면에 있다). */
  shim.localStorage.setItem("iaw-alloc", JSON.stringify({ saved: true,
    h_bands: { 해외채권: [95, 100], 해외주식: [95, 100] } }));
  P.renderSection("alloc");
  const vis2 = visText(DOC.getElementById("alloc"));
  r.bindWarningVisibleNotFolded = /(헤지 밴드\(내규 키인\)가 구간을 좁힙니다|환노출의 상한입니다|오버헤지 불가)/.test(vis2);
  shim.localStorage.removeItem("iaw-alloc");

  /* 프록시 폴백 사유(layerNote)도 보이는 텍스트에 남는다 */
  P.DATA.alloc = { ...CMA_ALLOC, cma: { active: false, reason: "probe-접힘검사" } };
  P.renderSection("alloc");
  r.fallbackReasonVisible = /probe-접힘검사/.test(visText(DOC.getElementById("alloc")));
  P.DATA.alloc = CMA_ALLOC;
  P.renderSection("alloc");
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
    /* 두 번 불러도 리스너가 두 벌 걸리면 안 된다 — 제출 한 번에 async 핸들러가
       두 벌 돌고 늦게 끝난 쪽이 판정을 덮어쓴다(실제로 테스트가 간헐 실패했다). */
    let submits = 0;
    const form0 = DOC.getElementById("gate-form");
    form0.addEventListener("submit", () => { submits++; });
    P.bindGate(); P.bindGate();
    form0.dispatchEvent({ type: "submit", preventDefault() {}, target: form0 });
    await new Promise((r2) => setTimeout(r2, 30));
    r.listenerBoundOnce = submits === 1;
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
