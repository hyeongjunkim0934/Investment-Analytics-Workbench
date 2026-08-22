/* Investment Analytics Workbench — dashboard renderer.
   Consumes pipeline JSON from data/ and renders uPlot charts.
   All series values are also reachable via the per-card table view (표). */

"use strict";

/* ---------------- state ---------------- */

const DATA = {};                 // fetched JSON payloads by file stem
const registry = [];             // {u, tmin, tmax, isTime} for range scoping
let uplots = [];                 // live charts: {u, ro} (for teardown)
const state = { years: 5 };

function trackChart(u, ro) {
  const entry = { u, ro };
  uplots.push(entry);
  return entry;
}

function destroyChart(entry) {
  if (!entry) return;
  if (entry.ro) entry.ro.disconnect();
  entry.u.destroy();
  uplots = uplots.filter((e) => e !== entry);
}

function destroyAllCharts() {
  for (const e of uplots) {
    if (e.ro) e.ro.disconnect();
    e.u.destroy();
  }
  uplots = [];
}

const FILES = ["meta", "overview", "risk", "events", "panel", "hedge", "alloc",
               "estimate", "rates", "irs", "credit", "fx", "inflation", "acwi",
               "macro", "catalog"];

/* ---------------- theme & palette ---------------- */

/* ══ 테마는 축이 둘이다 (2026-08-04 사용자 지시) ═══════════════════════════
   ① chrome — 대시보드 섹션·카드·헤더·차트 색.  <html data-theme>
      **기본값 다크.** 속성이 없으면 다크, 사용자가 토글하면 "light".
      localStorage 'iaw-theme' 에 영구 저장. prefers-color-scheme 은 보지 않는다.
   ② scene  — 마을 지도의 낮/밤(스틸·루프영상·전환영상·SVG fx·구역 라벨). <html data-scene>
      **저장하지 않는다** — 15초마다 뒤집히는 값이라 저장하면 쓰기 폭주이고,
      "저장값 없으면 …" 분기가 무의미해진다. 페이지 수명 동안만 사는 런타임 상태다.

   예전에는 data-theme 하나가 둘 다 몰았다. 그래서 대시보드를 어둡게 하면 마을이
   밤이 됐고, 마을을 밤으로 보려면 대시보드까지 어두워졌다. 축을 쪼갠 이유가 그것이다.
   ══════════════════════════════════════════════════════════════════════ */
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function currentScene() {
  return document.documentElement.getAttribute("data-scene") === "night" ? "night" : "day";
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    series: ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"].map(cssVar),
    ink2: cssVar("--ink-2"),
    ink3: cssVar("--ink-3"),
    grid: cssVar("--grid"),
    baseline: cssVar("--baseline"),
    accent: cssVar("--accent"),
    surface: cssVar("--surface"),
    up: cssVar("--up"),
    down: cssVar("--down"),
    // one-hue recency ramp for curve snapshots (ordered: 최근 → 과거)
    snapRamp: currentTheme() === "dark"
      ? ["#9ec5f4", "#3987e5", "#184f95"]
      : ["#1c5cab", "#3987e5", "#86b6ef"],
  };
}

/* ---------------- utils ---------------- */

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  /* 배열은 펼친다 — `el("td", {}, rows.map(...))` 를 쓰면 예전에는 자식이
     `String(배열)` 로 뭉개져 화면에 "[object HTMLSpanElement],..." 가 찍혔다.
     오류가 안 나고 글자만 이상해지는 종류라 눈으로 잡기 전까지 살아남는다. */
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

/* ---- 설명 접기 (§7.13 — 2026-08-19 사용자 지시 "화면을 심플하게") -------------
   화면 기본은 답(숫자·컨트롤·경고)만 보이고, 산문 해설은 「ⓘ 설명」을 눌러 편다.
   **경고·사유·관측일·폴백 이유는 여기 넣지 말 것** — 접힌 정보는 없는 정보라,
   §7.8.1(묵은 자동값)·§7.7.17(구속 귀속)·layerNote 류가 접히면 그 계약이 깨진다.
   구현 규약 둘:
   ① 토글은 브라우저 기본 동작이 아니라 **코드가 직접** 연다(preventDefault + open
      반전). DOM 셰이드에는 details 네이티브 토글이 없어, 기본 동작에 기대면
      프로브가 동작을 실행으로 못 잰다 — 코드 토글이면 셰이드·실브라우저가 같은
      경로를 탄다. (index.html 의 정적 details 는 재렌더가 없어 네이티브로 둔다.)
   ② 열림 상태는 EXPLAIN_OPEN(세션 메모리)에 id 로 남긴다 — recalc 가 DOM 을 통째로
      다시 만들므로 이게 없으면 슬라이더를 끌 때마다 열어 둔 설명이 닫힌다.
      localStorage 에는 넣지 않는다 — 새로 열면 접힌 기본값이 의도다. */
const EXPLAIN_OPEN = new Set();
function explainBox(id, ...children) {
  /* 첫 인자가 { label } 이면 요약 라벨을 바꾼다 — 기본은 「설명」.
     (접이식 제목이 내용을 말해야 하는 자리 — 예: 「이 숫자는 어디서 왔나」) */
  let label = "설명";
  if (children[0] && typeof children[0] === "object" && !children[0].nodeType
      && typeof children[0].label === "string") {
    label = children[0].label;
    children = children.slice(1);
  }
  const body = el("div", { class: "explain-body" }, ...children);
  const sum = el("summary", {}, label);
  const d = el("details", { class: "explain" }, sum, body);
  if (EXPLAIN_OPEN.has(id)) d.setAttribute("open", "");
  sum.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();   // 셰이드는 평범한 객체를 보낸다
    if (d.hasAttribute("open")) { d.removeAttribute("open"); EXPLAIN_OPEN.delete(id); }
    else { d.setAttribute("open", ""); EXPLAIN_OPEN.add(id); }
  });
  return d;
}

function fmtNum(v, dec = 2) {
  if (v == null || !isFinite(v)) return "–";
  return v.toLocaleString("ko-KR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function tsToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/* union-join series [{t,v},...] -> uPlot aligned data [xs, y1, y2, ...] */
function joinSeries(list) {
  const set = new Set();
  for (const s of list) for (const t of s.t) set.add(t);
  const xs = [...set].sort((a, b) => a - b);
  const pos = new Map(xs.map((t, i) => [t, i]));
  const ys = list.map((s) => {
    const arr = new Array(xs.length).fill(null);
    for (let i = 0; i < s.t.length; i++) arr[pos.get(s.t[i])] = s.v[i];
    return arr;
  });
  return [xs, ...ys];
}

function downloadCSV(filename, headers, rows) {
  const esc = (x) => {
    const s = x == null ? "" : String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [headers, ...rows]
    .map((r) => r.map(esc).join(",")).join("\n");
  const a = el("a", {
    href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })),
    download: filename,
  });
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------------- chart card scaffold ---------------- */

function cardScaffold(container, { title, sub, tableFn, csvName, controls }) {
  container.textContent = "";
  const head = el("div", { class: "card-head" },
    el("span", { class: "card-title" }, title),
    sub ? el("span", { class: "card-sub" }, sub) : null);
  if (controls) head.append(controls);

  const actions = el("div", { class: "card-actions" });
  const box = el("div", { class: "chart-box" });
  const tableWrap = el("div", { class: "table-wrap chart-table hidden" });

  if (tableFn) {
    actions.append(
      el("button", {
        onclick: () => {
          if (tableWrap.classList.contains("hidden")) {
            renderTable(tableWrap, tableFn());
            tableWrap.classList.remove("hidden");
          } else tableWrap.classList.add("hidden");
        },
      }, "표"),
      el("button", {
        onclick: () => {
          // CSV는 화면 표시용 포맷이 아닌 원시 값으로 내보낸다.
          const { headers, rows } = tableFn(Infinity, true);
          downloadCSV(csvName || "data.csv", headers, rows);
        },
      }, "CSV"),
    );
  }
  head.append(actions);
  container.append(head, box, tableWrap);
  return box;
}

function renderTable(wrap, { headers, rows, note }) {
  wrap.textContent = "";
  const thead = el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, h))));
  const tbody = el("tbody");
  for (const r of rows) {
    tbody.append(el("tr", {}, ...r.map((c, i) =>
      el("td", { class: i > 0 ? "num" : "" }, c == null ? "–" : c))));
  }
  wrap.append(el("table", {}, thead, tbody));
  if (note) wrap.append(el("div", { class: "section-note", style: "padding:6px 10px" }, note));
}

/* table builder for time-series charts (latest first, capped for DOM) */
function tsTableFn(labels, data, dec) {
  return (cap = 400, raw = false) => {
    const [xs, ...ys] = data;
    const rows = [];
    for (let i = xs.length - 1; i >= 0 && rows.length < cap; i--) {
      rows.push([tsToDate(xs[i]),
        ...ys.map((y) => y[i] == null ? null : (raw ? y[i] : fmtNum(y[i], dec)))]);
    }
    return {
      headers: ["일자", ...labels], rows,
      note: cap < xs.length ? `최근 ${Math.min(cap, xs.length)}개 관측치만 표시 — 전체는 CSV로 내려받을 수 있습니다.` : null,
    };
  };
}

/* ---------------- uPlot factories ---------------- */

const AXIS_FONT = "11px system-ui, sans-serif";

/* y축 눈금이 반올림 때문에 같은 글자로 뭉개지는 것을 막는다.

   실측으로 잡은 결함이다: 자산배분의 「이행 경로」는 y 범위가 2.62~2.75% 인데 소수점 0자리로
   찍혀 눈금 4개가 전부 "3%" 였고(고유 라벨 1개), 「효율적 투자선」·「총위험 vs 주식헤지」·
   「총위험 vs 채권헤지」도 같은 증상이었다. 축이 "3% 3% 3% 3%" 로 서 있으면 그래프가 무엇을
   말하는지 읽을 수 없다.

   `refmt(v, 추가소수점)` 을 주면, 기본 표기로 라벨이 겹칠 때만 소수점을 한 자리씩 늘려
   전부 서로 다른 라벨이 될 때까지 다시 찍는다. refmt 를 안 주는 호출자는 이전과 완전히
   동일하게 동작한다 — 겹치지 않는 차트는 첫 줄에서 그대로 반환된다. */
function baseAxes(pal, yFmt, refmt) {
  return [
    {
      stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
      ticks: { show: false },
    },
    {
      stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
      ticks: { show: false }, size: 56,
      values: (u, vals) => {
        let out = vals.map((v) => yFmt(v));
        if (!refmt) return out;
        for (let extra = 1; extra <= 3 && new Set(out).size < out.length; extra++) {
          out = vals.map((v) => refmt(v, extra));
        }
        return out;
      },
    },
  ];
}

/* 차트 제목줄에 "지금 얼마인가"를 한 줄로 박는다.

   uPlot 범례는 마우스를 올리기 전까지 "일자: --  달러/원: –" 처럼 대시만 보인다.
   차트를 처음 보는 사람에게는 값이 없는 것처럼 읽히고, 최신 수치를 알려면 커서를
   정확히 오른쪽 끝에 올려야 했다. 매크로 카드에만 있던 "최근 3.80% (2026-07-20)"
   표기를 모든 시계열 카드로 넓힌다.

   그리는 값은 이미 그 차트에 찍혀 있는 계열의 마지막 관측치다 — 새로 계산하거나
   새로 공개하는 수치가 아니다. 계열이 여럿이면 값 나열이 길어지므로 기준일만 적는다.

   날짜 표기 규칙: 이 대시보드의 기준일(meta.last_observation)보다 뒤의 날짜는 찍지
   않는다. 월말 시계열(예: 환헤지비용)은 마지막 점이 2026-07-31 인데 기준일은
   2026-07-20 이라, 그대로 찍으면 한 화면에 미래 날짜가 나타나 관측일로 오독된다.
   그런 경우 "2026-07월" 처럼 월까지만 적는다. 값은 어느 경우에도 그대로다. */
function stampDate(ts) {
  const d = tsToDate(ts);
  const asof = DATA.meta && DATA.meta.last_observation;
  return (asof && d > asof) ? `${d.slice(0, 7)}월` : d;
}

function stampLatest(box, cfg) {
  const card = box.parentElement;
  const head = card && card.querySelector(".card-head");
  if (!head || head.querySelector(".card-last")) return;
  if (/최근/.test(head.textContent)) return;      // 이미 적혀 있으면(매크로) 건드리지 않는다
  const [xs, ...ys] = cfg.data;
  if (!xs || !xs.length) return;
  const lastIdxOf = (y) => { for (let i = y.length - 1; i >= 0; i--) if (y[i] != null) return i; return -1; };
  const newest = Math.max(...ys.map(lastIdxOf));
  if (newest < 0) return;
  const dec = cfg.dec ?? 2;
  const txt = ys.length === 1
    ? `최근 ${fmtNum(ys[0][newest], dec)}${cfg.unit || ""} (${stampDate(xs[newest])})`
    : `최근 ${stampDate(xs[newest])} 기준`;
  const node = el("span", { class: "card-last" }, txt);
  const actions = head.querySelector(".card-actions");
  if (actions) head.insertBefore(node, actions); else head.append(node);
}

function makeTimeChart(box, cfg) {
  /* cfg: {labels, colors, data, dec, unit, fill, stepped, bars, height} */
  const pal = palette();
  const dec = cfg.dec ?? 2;
  const h = cfg.height ?? 260;
  const yFmt = (v) => fmtNum(v, v != null && Math.abs(v) >= 1000 ? 0 : dec);
  const yReFmt = (v, extra) => fmtNum(v, (v != null && Math.abs(v) >= 1000 ? 0 : dec) + extra);

  const series = [{ label: "일자", value: "{YYYY}-{MM}-{DD}" }];
  cfg.labels.forEach((lbl, i) => {
    const color = cfg.colors[i];
    const s = {
      label: lbl, stroke: color, width: 2, spanGaps: true,
      points: { show: false },
      value: (u, v) => v == null ? "–" : fmtNum(v, dec) + (cfg.unit || ""),
    };
    if (cfg.fill) s.fill = color + "1a";                       // ~10% wash
    if (cfg.stepped) s.paths = uPlot.paths.stepped({ align: 1 });
    if (cfg.bars) {
      s.paths = uPlot.paths.bars({ size: [0.6, 24] });
      s.fill = color;
      s.width = 0;
    }
    series.push(s);
  });

  const opts = {
    width: Math.max(280, box.clientWidth),
    height: h,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC"),
    cursor: { points: { size: 8 }, y: false },
    scales: cfg.bars ? { y: { range: (u, mn, mx) => [Math.min(mn, 0), Math.max(mx, 0)] } } : {},
    series,
    axes: baseAxes(pal, yFmt, yReFmt),
    legend: { live: true },
  };

  const u = new uPlot(opts, cfg.data, box);
  stampLatest(box, cfg);

  const xs = cfg.data[0];
  const rangeEntry = { u, tmin: xs[0], tmax: xs[xs.length - 1], isTime: true };
  registry.push(rangeEntry);
  applyRange(rangeEntry);

  const ro = new ResizeObserver(() => {
    u.setSize({ width: Math.max(280, box.clientWidth), height: h });
  });
  ro.observe(box);
  return trackChart(u, ro);
}

function makeOrdinalChart(box, cfg) {
  /* cfg: {ticks, labels, colors, rows: [[v,...] per series], dec, unit, height} */
  const pal = palette();
  const dec = cfg.dec ?? 2;
  const h = cfg.height ?? 280;
  const xs = cfg.ticks.map((_, i) => i);

  const series = [{ label: "구간" }];
  cfg.labels.forEach((lbl, i) => {
    series.push({
      label: lbl, stroke: cfg.colors[i], width: 2, spanGaps: true,
      points: { show: true, size: 7, fill: cfg.colors[i], stroke: pal.surface, width: 2 },
      value: (u, v) => v == null ? "–" : fmtNum(v, dec) + (cfg.unit || ""),
    });
  });

  const opts = {
    width: Math.max(280, box.clientWidth),
    height: h,
    cursor: { points: { size: 9 }, y: false },
    scales: { x: { time: false, range: [-0.4, xs.length - 0.6] } },
    series,
    axes: [
      {
        stroke: palette().ink3, font: AXIS_FONT, grid: { show: false },
        ticks: { show: false }, incrs: [1],
        values: (u, vals) => vals.map((v) =>
          Number.isInteger(v) && cfg.ticks[v] != null ? cfg.ticks[v] : ""),
      },
      baseAxes(pal, (v) => fmtNum(v, dec))[1],
    ],
    legend: { live: true },
  };
  const u = new uPlot(opts, [xs, ...cfg.rows], box);
  const ro = new ResizeObserver(() => {
    u.setSize({ width: Math.max(280, box.clientWidth), height: h });
  });
  ro.observe(box);
  return trackChart(u, ro);
}

/* ---------------- range scoping ---------------- */

function applyRange(entry) {
  if (!entry.isTime) return;
  const { u, tmin, tmax } = entry;
  const min = state.years === 0 ? tmin
    : Math.max(tmin, tmax - state.years * 31557600);
  u.setScale("x", { min, max: tmax });
}

function bindRangeButtons() {
  const group = $("#range-group");
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.years = Number(btn.dataset.range);
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    registry.forEach(applyRange);
  });
}

/* ---------------- sparkline (SVG) ---------------- */

function sparkSVG(spk, accent) {
  const w = 100, h = 30, pad = 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("spark");
  if (!spk || spk.v.length < 2) return svg;
  const vmin = Math.min(...spk.v), vmax = Math.max(...spk.v);
  const t0 = spk.t[0], t1 = spk.t[spk.t.length - 1];
  const X = (t) => t1 === t0 ? 0 : pad + (t - t0) / (t1 - t0) * (w - 2 * pad);
  const Y = (v) => vmax === vmin ? h / 2 : (h - pad) - (v - vmin) / (vmax - vmin) * (h - 2 * pad);
  const d = spk.t.map((t, i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(spk.v[i]).toFixed(1)}`).join("");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.classList.add("spark-line");
  svg.append(path);
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", X(t1).toFixed(1));
  dot.setAttribute("cy", Y(spk.v[spk.v.length - 1]).toFixed(1));
  dot.setAttribute("r", "2.5");
  dot.setAttribute("fill", accent);
  svg.append(dot);
  return svg;
}

/* ---------------- deltas ---------------- */

const KIND_UNIT = { rate: "bp", price: "%", level: "pt" };

function deltaSpan(label, v, kind, big = false) {
  const unit = KIND_UNIT[kind] || "";
  const cls = v == null || v === 0 ? "d-flat" : v > 0 ? "d-up" : "d-down";
  const arrow = v == null || v === 0 ? "–" : v > 0 ? "▲" : "▼";
  const txt = v == null ? "–" : `${arrow} ${fmtNum(Math.abs(v), kind === "rate" ? 1 : 2)}${unit}`;
  const s = el("span", {}, `${label} `);
  s.append(el("b", { class: cls }, txt));
  if (big) s.style.fontSize = "13px";
  return s;
}

/* ---------------- section renderers ---------------- */

/* 섹션 id → 사람이 읽는 이름. 상단 탭이 7개로 줄면서(2026-08-13) 내려온 화면들의
   이름을 화면 안에서 부를 자리가 필요해졌다 — index.html 의 <h2> 와 같은 문자열이며
   계약 테스트가 둘을 대조한다(어긋나면 버튼 이름과 도착 화면 제목이 달라진다). */
const SECTION_LABELS = {
  overview: "시장 개요", risk: "리스크", estimate: "수익률 추정", alloc: "자산배분",
  hedge: "환헤지", events: "이벤트", panel: "관계분석", rates: "금리",
  irs: "IRS 포워드", credit: "크레딧", fx: "FX · 환율", inflation: "기대인플레이션",
  acwi: "MSCI ACWI", macro: "매크로", catalog: "시리즈 카탈로그",
};

/* 상세 화면으로 들어가는 버튼 한 벌 — 개요 구역·리스크·카탈로그가 같은 모양을 쓴다. */
function sectionLink(id, extra) {
  return el("a", { href: `#${id}`, class: "btn-ghost sec-link" },
    SECTION_LABELS[id] || id, extra ? el("span", { class: "sec-link-sub" }, ` ${extra}`) : "", " ›");
}

function renderOverview() {
  const host = $("#ov-groups");
  if (!host) return;
  host.textContent = "";
  const pal = palette();
  const ov = DATA.overview;
  if (!ov || !ov.cards) {
    host.append(el("div", { class: "chart-empty" }, "데이터 없음"));
    return;
  }
  /* 카드 한 장. `link` 가 있으면 그 화면으로 들어가는 링크가 된다 —
     "개요의 ACWI 카드를 클릭하면 ACWI 화면" (2026-08-13 사용자 지시).
     **링크가 없는 카드는 <div> 그대로 둔다** — 전용 화면이 없는 지표(VIX·VKOSPI·WTI)를
     눌리게 만들면 눌러도 아무 일이 없어 고장으로 읽힌다. */
  const kpiOf = (c) => {
    const linked = !!c.link;
    const kpi = linked
      ? el("a", { class: "kpi kpi-link", href: `#${c.link}`,
                  "aria-label": `${c.label} — ${SECTION_LABELS[c.link] || c.link} 화면으로` })
      : el("div", { class: "kpi" });
    kpi.append(el("div", { class: "kpi-label" },
      el("span", {}, c.label), el("span", { class: "kpi-date" }, c.date)));
    const val = el("div", { class: "kpi-value" }, fmtNum(c.value, String(c.value).includes(".") ? 2 : 0));
    if (c.unit) val.append(el("span", { class: "unit" }, c.unit));
    kpi.append(val);
    kpi.append(el("div", { class: "kpi-delta" }, deltaSpan("1일", c.chg.d1, c.kind, true)));
    kpi.append(el("div", { class: "kpi-delta" },
      deltaSpan("1개월", c.chg.m1, c.kind),
      deltaSpan("YTD", c.chg.ytd, c.kind),
      deltaSpan("1년", c.chg.y1, c.kind)));
    kpi.append(sparkSVG(c.spark, pal.accent));
    return kpi;
  };

  /* 구역(주식 → 금리 → 환율 → 기타). 페이로드에 groups 가 없는 옛 빌드에서는
     한 덩어리로 떨어뜨린다 — 화면이 통째로 비는 것보다 낫다(조용한 실패 금지). */
  const groups = (ov.groups && ov.groups.length)
    ? ov.groups : [{ key: null, label: "", sections: [] }];
  groups.forEach((g) => {
    const mine = g.key ? ov.cards.filter((c) => c.group === g.key) : ov.cards;
    if (!mine.length) return;
    const box = el("section", { class: "ov-group" });
    const head = el("div", { class: "ov-group-head" });
    if (g.label) head.append(el("h3", { class: "ov-group-title" }, g.label));
    (g.sections || []).forEach((sid) => head.append(sectionLink(sid)));
    if (head.childNodes.length) box.append(head);
    const cards = el("div", { class: "cards" });
    mine.forEach((c) => cards.append(kpiOf(c)));
    box.append(cards);
    host.append(box);
  });

  /* 카탈로그 — 상단 탭에서 내려와 개요 맨 아래 한 줄로만 남는다 */
  const cat = $("#ov-catalog");
  if (cat) {
    cat.textContent = "";
    cat.append(sectionLink("catalog", "— 게시 중인 전 시리즈의 출처·기간·관측 수"));
  }
}

function snapshotCard(container, payload, { title, sub, unit, dec }) {
  /* payload: {CODE: {label, tenors, snaps:[{label,date,v[]}]}} with country tabs */
  const codes = Object.keys(payload);
  if (!codes.length) {
    container.textContent = "";
    container.append(el("div", { class: "chart-empty" }, "데이터 없음"));
    return;
  }
  let active = codes[0];
  let chartEntry = null;
  const seg = el("div", { class: "seg" });
  const render = () => {
    const cfg = payload[active];
    seg.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.code === active));
    destroyChart(chartEntry);   // 탭 전환 시 이전 uPlot 인스턴스 해제
    chartEntry = null;
    const pal = palette();
    const labels = cfg.snaps.map((s) => s.date ? `${s.label} (${s.date})` : s.label);
    const box = cardScaffold(container, {
      title, sub: cfg.label + (sub ? " · " + sub : ""),
      controls: seg,
      csvName: `${title}-${active}.csv`,
      tableFn: (cap, raw = false) => ({
        headers: ["구간", ...labels],
        rows: cfg.tenors.map((t, i) => [t, ...cfg.snaps.map((s) =>
          s.v[i] == null ? null : (raw ? s.v[i] : fmtNum(s.v[i], dec)))]),
      }),
    });
    chartEntry = makeOrdinalChart(box, {
      ticks: cfg.tenors, labels,
      colors: pal.snapRamp,
      rows: cfg.snaps.map((s) => s.v),
      dec, unit,
    });
  };
  for (const code of codes) {
    seg.append(el("button", {
      "data-code": code,
      onclick: () => { if (code === active) return; active = code; render(); },
    }, payload[code].label.split(" ")[0]));
  }
  render();
}

function tsCard(container, group, { title, sub, unit, dec, colorOffset = 0, fill = false, stepped = false, height }) {
  container.textContent = "";
  if (!group || !group.length) {
    container.append(el("div", { class: "chart-empty" }, "데이터 없음"));
    return;
  }
  const pal = palette();
  const labels = group.map((g) => g.label);
  const colors = group.map((_, i) => pal.series[(i + colorOffset) % 8]);
  const data = joinSeries(group);
  const box = cardScaffold(container, {
    title, sub,
    csvName: `${title}.csv`,
    tableFn: tsTableFn(labels, data, dec),
  });
  makeTimeChart(box, { labels, colors, data, dec, unit, fill, stepped, height });
}

function renderRates() {
  const r = DATA.rates || {};
  snapshotCard($("#card-curve"), r.curves || {}, {
    title: "국채 수익률 커브", sub: "최근 · 1개월 전 · 1년 전", unit: "%", dec: 2,
  });
  tsCard($("#card-ts10"), r.ts10, { title: "국채 10년 금리", sub: "%", unit: "%", dec: 2 });
  tsCard($("#card-spreads"), r.spreads, { title: "금리 스프레드", sub: "bp", unit: "bp", dec: 0 });
  tsCard($("#card-policy"), r.policy, { title: "기준금리", sub: "%", unit: "%", dec: 2, stepped: true });
}

function renderIRS() {
  const d = DATA.irs || {};
  snapshotCard($("#card-irs-fwd"), d.fwd || {}, {
    title: "IRS 포워드 구조", sub: "최근 · 1개월 전 · 1년 전", unit: "%", dec: 2,
  });
  tsCard($("#card-irs-ts"), d.ts, { title: "IRS 포워드 시계열", sub: "%", unit: "%", dec: 2 });
}

function renderCredit() {
  const d = DATA.credit || {};
  const kr = d.kr || [];
  tsCard($("#card-credit-kr1"), kr.slice(0, 4), {
    title: "국내 크레딧 스프레드 — 우량", sub: "국고 3년 대비, bp", unit: "bp", dec: 0,
  });
  tsCard($("#card-credit-kr2"), kr.slice(4), {
    title: "국내 크레딧 스프레드 — 회사채·여전채", sub: "국고 3년 대비, bp", unit: "bp", dec: 0, colorOffset: 4,
  });
  tsCard($("#card-credit-us"), d.us, { title: "미국 크레딧 스프레드", sub: "%p", unit: "%p", dec: 2 });
  tsCard($("#card-cds"), d.cds, { title: "CDS 5년", sub: "bp", unit: "bp", dec: 0 });
}

function renderFX() {
  const d = DATA.fx || {};
  const grid = $("#fx-grid");
  grid.textContent = "";
  const pal = palette();
  (d.ts || []).forEach((g, i) => {
    const card = el("div", { class: "card" });
    grid.append(card);
    const data = joinSeries([g]);
    const box = cardScaffold(card, {
      title: g.label, csvName: `${g.label}.csv`,
      tableFn: tsTableFn([g.label], data, 2),
    });
    makeTimeChart(box, {
      labels: [g.label], colors: [pal.series[i % 8]], data,
      dec: 2, height: 200, fill: true,
    });
  });

}

function renderInflation() {
  const d = DATA.inflation || {};
  tsCard($("#card-bei"), d.bei, { title: "BEI 10년", sub: "%", unit: "%", dec: 2 });
  tsCard($("#card-tips"), d.tips, { title: "실질금리 (TIPS 10년)", sub: "%", unit: "%", dec: 2 });
}

function renderACWI() {
  const d = DATA.acwi || {};
  const stats = $("#acwi-stats");
  stats.textContent = "";
  if (d.stats) {
    const s = d.stats;
    const tile = (label, valNode, deltaNode) => {
      const k = el("div", { class: "kpi" });
      k.append(el("div", { class: "kpi-label" }, el("span", {}, label)));
      k.append(valNode);
      if (deltaNode) k.append(deltaNode);
      return k;
    };
    const v = (txt, unit) => {
      const n = el("div", { class: "kpi-value" }, txt);
      if (unit) n.append(el("span", { class: "unit" }, unit));
      return n;
    };
    stats.append(
      tile(`종가 (${s.date})`, v(fmtNum(s.last, 1)),
        el("div", { class: "kpi-delta" },
          deltaSpan("1일", s.chg.d1, "price", true), deltaSpan("YTD", s.chg.ytd, "price", true))),
      tile("연환산 수익률 (CAGR)", v(fmtNum(s.cagr, 2), "%"),
        el("div", { class: "kpi-delta" }, el("span", {}, `기점 ${s.first_date}`))),
      tile("변동성 (1년, 연율)", v(fmtNum(s.vol_1y, 2), "%")),
      tile("최대 낙폭 (MDD)", v(fmtNum(s.mdd, 2), "%"),
        el("div", { class: "kpi-delta" },
          el("span", {}, `52주 ${fmtNum(s.low_52w, 1)} ~ ${fmtNum(s.high_52w, 1)}`))),
    );
  }
  const pal = palette();
  if (d.price) {
    const data = [d.price.t, d.price.v];
    const box = cardScaffold($("#card-acwi-price"), {
      title: "ACWI 지수", sub: "일별 종가(과거 구간 주별)",
      csvName: "ACWI.csv", tableFn: tsTableFn(["종가"], data, 2),
    });
    makeTimeChart(box, { labels: ["종가"], colors: [pal.series[0]], data, dec: 2, fill: true });
  }
  if (d.drawdown) {
    const data = [d.drawdown.t, d.drawdown.v];
    const box = cardScaffold($("#card-acwi-dd"), {
      title: "고점 대비 낙폭", sub: "%",
      csvName: "ACWI-drawdown.csv", tableFn: tsTableFn(["낙폭(%)"], data, 2),
    });
    makeTimeChart(box, { labels: ["낙폭(%)"], colors: [pal.series[7]], data, dec: 2, unit: "%", fill: true });
  }
  renderBreadth(d.breadth, pal);
}

/* ── 미국 증시 시장 폭 ──────────────────────────────────────────────────────
   ACWI 가격은 "올랐다/내렸다"만 말한다. 같은 상승이라도 **전 종목이 함께 오른 것**과
   **대형주 몇 개가 끈 것**은 뜻이 전혀 다른데, 이 대시보드에는 그 구분을 주는
   시리즈가 하나도 없었다(전부 가격·금리·스프레드다).

   **관측이 하루뿐일 수 있다.** 원본이 데일리 리포트라 이력은 날짜별 파일이 쌓여야
   생긴다. 그래서 없는 이력을 있는 것처럼 보이는 차트를 그리지 않고, 관측 수를
   화면에 그대로 적는다 — 「보이는 것이 곧 가진 것」이어야 한다. */
function renderBreadth(B, pal) {
  const card = $("#card-breadth");
  if (!card) return;
  card.textContent = "";
  if (!B || !B.rows || !B.rows.length) { card.hidden = true; return; }
  card.hidden = false;

  const byKey = Object.fromEntries(B.rows.map((r) => [r.key, r]));
  const val = (k) => (byKey[k] ? byKey[k].last : null);
  const fmt = (k, dec) => (byKey[k] ? fmtNum(byKey[k].last, dec) : "–");

  card.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "미국 증시 시장 폭 (breadth)"),
    el("span", { class: "card-sub" },
      `${B.asof} 종가 기준 · 관측 ${B.n}일 · ${B.src}`)));

  /* 결론 한 줄 — 이 카드가 답하는 질문은 "넓은 상승인가 좁은 상승인가" 하나다.
     판정은 **화면이 만드는 말이 아니라 두 수의 대소**다(부호가 곧 결론). */
  const ad = val("ad_ratio");
  const nnh = val("net_new_high");
  if (ad != null && nnh != null) {
    const wide = ad >= 1;
    const deep = nnh >= 0;
    const verdict = wide && deep ? "넓은 상승 — 오른 종목이 많고 신고가도 신저가보다 많습니다."
      : wide && !deep ? "겉은 상승, 속은 갈라짐 — 오른 종목이 많은데 52주 바닥을 깨는 종목이 더 많습니다."
      : !wide && deep ? "겉은 하락, 속은 버팀 — 내린 종목이 많은데 신고가가 신저가보다 많습니다."
      : "넓은 하락 — 내린 종목이 많고 신저가도 신고가보다 많습니다.";
    card.append(el("div", { class: "qa", style: "margin:8px 0 12px" },
      el("b", {}, verdict),
      el("div", { class: "card-sub", style: "margin-top:4px" },
        `상승/하락 ${fmt("ad_ratio", 2)}배 · 신고가권 − 신저가권 ${fmt("net_new_high", 0)}종목`
        + (val("net_new_high_pct") != null ? ` (상장 종목의 ${fmt("net_new_high_pct", 2)}%)` : ""))));
  }

  const t = el("table", { class: "mini-table" },
    el("tr", {}, el("th", {}, "지표"),
      el("th", {}, "값"), el("th", { style: "text-align:left" }, "읽는 법")));
  B.rows.forEach((r) => {
    const dec = r.unit === "종목" ? 0 : (r.unit === "%p" ? 3 : 2);
    t.append(el("tr", {},
      el("td", {}, r.label),
      el("td", { class: "num" }, `${fmtNum(r.last, dec)}${r.unit ? " " + r.unit : ""}`),
      el("td", { style: "text-align:left;font-size:11.5px" }, r.note || "")));
  });
  card.append(wrapTable(t));

  /* 이력이 2일 이상 쌓이면 추세를 그린다. 그 전까지는 그리지 않는다 —
     점 하나짜리 차트는 정보가 0인데 "이력이 있다"고 읽힌다. */
  const tsKeys = Object.keys(B.ts || {});
  if (tsKeys.length) {
    /* `rows` 에 없는 키는 그리지 않는다 — 라벨을 만들 수 없어 범례에 `net_new_high_pct`
       같은 **내부 키가 그대로 찍힌다**(프로브에서 실제로 그랬다). 이름 없는 계열은
       "그 자리에서 한 줄로 설명한다" 규약을 지킬 수 없으므로 아예 빼는 쪽이 맞다. */
    const pick = ["ad_ratio", "net_new_high_pct"].filter((k) => B.ts[k] && byKey[k]);
    const groups = pick.map((k) => ({ label: byKey[k].label, t: B.ts[k].t, v: B.ts[k].v }));
    if (groups.length) {
      const box = cardScaffold(card, {
        title: "시장 폭 추이", sub: `관측 ${B.n}일`,
        csvName: "미국-시장폭.csv",
        tableFn: tsTableFn(groups.map((g) => g.label), joinSeries(groups), 2),
      });
      makeTimeChart(box, {
        labels: groups.map((g) => g.label),
        colors: groups.map((_, i) => pal.series[i % 8]),
        data: joinSeries(groups), dec: 2, height: 220,
      });
    }
  } else {
    card.append(el("p", { class: "card-sub", style: "margin-top:8px;line-height:1.7" },
      el("b", {}, "아직 하루치입니다"), " — 이 리포트는 하루치 스냅샷이라 ",
      "추세·백분위·위험 요인 반영은 ", el("b", {}, "날짜별 파일이 쌓여야"), " 가능합니다. ",
      "같은 리포트를 계속 올리시면 여기에 추이 차트가 자동으로 붙습니다."));
  }
}

function renderMacro() {
  const grid = $("#macro-grid");
  grid.textContent = "";
  const items = (DATA.macro && DATA.macro.items) || [];
  const pal = palette();
  items.forEach((it, i) => {
    const card = el("div", { class: "card" });
    grid.append(card);
    const data = [it.t, it.v];
    /* macro.json 은 시리즈마다 unit 을 싣는데("%" 또는 "천명") 화면은 "%" 가 아니면
       단위를 **통째로 버리고** 있었다 — 「미국 비농업고용 MoM 최근 57.00」 처럼 무엇의
       57 인지 알 수 없는 카드가 그렇게 나왔다. 파이프라인이 준 단위를 그대로 쓴다. */
    const u = it.unit === "%" ? "%" : (it.unit ? ` ${it.unit}` : "");
    const box = cardScaffold(card, {
      title: it.label,
      sub: `최근 ${fmtNum(it.last, 2)}${u} (${it.date})`,
      csvName: `${it.label}.csv`,
      tableFn: tsTableFn([`${it.label}${it.unit ? ` (${it.unit})` : ""}`], data, 2),
    });
    makeTimeChart(box, {
      labels: [it.label], colors: [pal.series[i % 8]], data,
      dec: 2, unit: u, height: 190, bars: true,
    });
  });
}

function renderCatalog() {
  const cat = DATA.catalog;
  if (!cat || !cat.series) return;
  const tbody = $("#catalog-table tbody");
  const count = $("#catalog-count");
  const input = $("#catalog-search");
  const srcName = { bb: "Bloomberg", info: "Infomax", idx: "Index" };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    tbody.textContent = "";
    let n = 0;
    for (const s of cat.series) {
      if (q && !(`${s.name} ${s.category} ${s.key}`.toLowerCase().includes(q))) continue;
      n++;
      tbody.append(el("tr", {},
        el("td", {}, el("span", { class: "src-chip" }, srcName[s.source] || s.source)),
        el("td", {}, s.category || "–"),
        el("td", {}, s.name),
        el("td", {}, s.first),
        el("td", {}, s.last),
        el("td", { class: "num" }, s.n.toLocaleString("ko-KR"))));
    }
    /* 검색 결과가 없을 때 표가 통째로 비어 버리면 "고장났다"로 읽힌다 —
       무슨 일이 일어났는지 표 안에서 한 줄로 말해 준다. */
    if (n === 0) {
      tbody.append(el("tr", {}, el("td", { colspan: "6", class: "cat-empty" },
        q ? `'${input.value.trim()}' 과(와) 일치하는 시리즈가 없습니다 — 검색어를 지우면 전체 ${cat.series.length.toLocaleString("ko-KR")}개가 다시 나옵니다.`
          : "표시할 시리즈가 없습니다.")));
    }
    count.textContent = `${n.toLocaleString("ko-KR")} / ${cat.series.length.toLocaleString("ko-KR")}개 시리즈`;
  };
  input.addEventListener("input", draw);
  draw();
}

function renderMetaLine() {
  const m = DATA.meta;
  if (!m) return;
  $("#meta-line").textContent =
    `기준일 ${m.last_observation} · 빌드 ${m.built_at_kst} · ${m.series_count}개 시리즈`;
  $("#build-line").textContent =
    `빌드 ${m.built_at_kst} (${m.built_at_utc}) · 원본 파일 ${m.files.length}개 · 시리즈 ${m.series_count}개`;
  /* 예전에는 "경고 N건(콘솔 참조)" 라고만 적혀 있었다. 브라우저 개발자 콘솔을 여는 것은
     이 화면을 쓰는 사람의 일이 아니다 — 같은 내용을 화면에서 펼쳐 볼 수 있게 한다.
     내용은 이미 meta.json 으로 내려받아지는 값이라 새로 공개되는 것은 없다.
     반드시 #build-warnings(<p> 의 형제 <div>)에 넣을 것 — <p id="build-line"> 안에
     넣으면 펼치는 순간 문단이 18px→209px 로 늘며 빌드 메타 줄과 설명 문장이 같은
     시각적 줄에 겹친다(실제 클릭으로 재현). 콘솔 출력도 그대로 남긴다. */
  const wbox = $("#build-warnings");
  if (wbox) {
    wbox.textContent = "";
    if (m.warnings && m.warnings.length) {
      const det = el("details", { class: "warn-box", id: "build-warnings-details" });
      det.append(el("summary", {}, `빌드 경고 ${m.warnings.length}건 — 펼쳐 보기`));
      const ul = el("ul");
      m.warnings.forEach((w) => ul.append(el("li", {}, w)));
      det.append(ul, el("p", {},
        "경고는 대시보드의 값이 틀렸다는 뜻이 아니라, 원본 엑셀에서 같은 이름의 열이 겹쳐 "
        + "뒤쪽 열이 버려졌다는 기록입니다. 건수가 늘거나 성격이 바뀌면 원본 파일 구조가 바뀐 것입니다."));
      wbox.append(det);
    }
  }
  if (m.warnings && m.warnings.length) console.warn("pipeline warnings:", m.warnings);
}

/* ---------------- 리스크 스코어보드 ---------------- */

const GRADE_CLS = { "낮음": "c-low", "보통": "c-mid", "주의": "c-warn", "경계": "c-crit" };
const BANDS = [[0, 25, "#0ca30c", "낮음"], [25, 50, "#898781", "보통"],
               [50, 75, "#eda100", "주의"], [75, 100, "#d03b3b", "경계"]];

function gradeChip(g) {
  return g ? el("span", { class: `chip ${GRADE_CLS[g] || "c-mid"}` }, g)
           : el("span", { class: "chip c-mid" }, "대기");
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/* WCAG 상대휘도 → 어떤 배경색 위에 검정/흰색 중 어느 쪽이 더 잘 읽히는지 고른다.
   등급 밴드 범례("낮음 (0–25)" …)는 예전에 네 칸 모두 흰 글자였는데 실측 대비가
   1.94~3.88:1 로 AA(4.5:1) 미달이었다 — 특히 '주의'(노랑)는 1.94:1 로 사실상 안 보였다.
   임의로 색을 고르지 않고 대비가 큰 쪽을 계산해 쓴다: 낮음 5.63 · 보통 5.26 ·
   주의 8.72 · 경계 4.80:1 (전부 AA 통과). */
function relLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function bandInk(hex) {
  const L = relLum(hex);
  const onDark = (L + 0.05) / 0.05;          // 검정 글자 대비
  const onLight = 1.05 / (L + 0.05);         // 흰 글자 대비
  return onDark >= onLight ? "#111111" : "#ffffff";
}

/* 화면용 deltaPts 와 같은 값을 글자로만 — aria-label 처럼 기호(▲▼)가 읽히지 않는
   자리에서 쓴다. 숫자·반올림 규칙은 deltaPts 와 동일하게 유지할 것. */
function deltaText(d) {
  if (d == null) return "자료 없음";
  if (Math.abs(d) < 0.5) return "변화 없음";
  return `${d > 0 ? "상승" : "하락"} ${fmtNum(Math.abs(d), 0)}p`;
}

function deltaPts(d) {
  if (d == null) return el("span", { class: "d-flat" }, "–");
  if (Math.abs(d) < 0.5) return el("span", { class: "d-flat" }, "변화 없음");
  const cls = d > 0 ? "d-up" : "d-down";
  return el("span", { class: cls }, `${d > 0 ? "▲" : "▼"} ${fmtNum(Math.abs(d), 0)}p`);
}

function legendKey(color, text) {
  const s = el("span", {}, "");
  s.append(el("i", { style: `border-color:${color}` }), text);
  return s;
}

function withToday(hist, asofTs, cur) {
  const t = [...hist.t], v = [...hist.v];
  if (t.length && t[t.length - 1] < asofTs) { t.push(asofTs); v.push(cur); }
  return { t, v };
}

/* 0~100 고정 스케일 + 등급 밴드 배경 차트 (기간 필터 미적용) */
function makeBandChart(box, { seriesDefs, height = 300 }) {
  const pal = palette();
  const dark = currentTheme() === "dark";
  const data = joinSeries(seriesDefs);
  const series = [{ label: "주", value: "{YYYY}-{MM}-{DD}" }];
  seriesDefs.forEach((sd) => series.push({
    label: sd.label, stroke: sd.color, width: 2.5, spanGaps: true,
    points: { show: false },
    value: (u, v) => v == null ? "–" : fmtNum(v, 0) + "점",
  }));
  const opts = {
    width: Math.max(280, box.clientWidth), height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC"),
    cursor: { points: { size: 8 }, y: false },
    scales: { y: { range: () => [0, 100] } },
    series,
    axes: baseAxes(pal, (v) => fmtNum(v, 0)),
    legend: { live: true },
    hooks: {
      drawClear: [(u) => {
        const { ctx, bbox } = u;
        ctx.save();
        for (const [lo, hi, c] of BANDS) {
          const y1 = u.valToPos(hi, "y", true), y0 = u.valToPos(lo, "y", true);
          ctx.fillStyle = hexA(c, dark ? 0.10 : 0.07);
          ctx.fillRect(bbox.left, y1, bbox.width, y0 - y1);
        }
        ctx.restore();
      }],
      draw: [(u) => {
        const { ctx, bbox } = u;
        ctx.save();
        // 등급 라벨 (좌측 안쪽)
        ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
        ctx.textAlign = "left";
        for (const [lo, hi, c, nm] of BANDS) {
          ctx.fillStyle = c;
          ctx.fillText(`${nm} ${lo}–${hi}`, bbox.left + 8 * devicePixelRatio,
                       u.valToPos((lo + hi) / 2, "y", true) + 4 * devicePixelRatio);
        }
        // 끝점 값 라벨
        let prevY = null;
        seriesDefs.forEach((sd, i) => {
          const xs = u.data[0], ys = u.data[i + 1];
          let li = ys.length - 1;
          while (li >= 0 && ys[li] == null) li--;
          if (li < 0) return;
          const x = u.valToPos(xs[li], "x", true), y = u.valToPos(ys[li], "y", true);
          ctx.beginPath(); ctx.arc(x, y, 4.5 * devicePixelRatio, 0, 2 * Math.PI);
          ctx.fillStyle = sd.color; ctx.fill();
          ctx.lineWidth = 2 * devicePixelRatio; ctx.strokeStyle = palette().surface; ctx.stroke();
          ctx.font = `700 ${12.5 * devicePixelRatio}px system-ui, sans-serif`;
          ctx.fillStyle = sd.color;
          let ly = y - 8 * devicePixelRatio;
          if (prevY != null && Math.abs(ly - prevY) < 15 * devicePixelRatio) ly = prevY + 18 * devicePixelRatio;
          ctx.fillText(String(Math.round(ys[li])), Math.max(bbox.left + 4, x - 24 * devicePixelRatio), ly);
          prevY = ly;
        });
        ctx.restore();
      }],
    },
  };
  const u = new uPlot(opts, data, box);
  const ro = new ResizeObserver(() => u.setSize({ width: Math.max(280, box.clientWidth), height }));
  ro.observe(box);
  return trackChart(u, ro);
}

function evMini(e) {
  const sevCls = e.sev === "경계" ? "c-crit" : e.sev === "주의" ? "c-warn" : "c-mid";
  const d = el("div", { class: "evmini" });
  d.append(el("span", { class: "d" }, e.date),
           el("span", { class: `chip ${sevCls}` }, e.sev),
           /* 제목에 클래스가 필요하다 — 없으면 flex 기본값(min-width:auto)이 min-content 로
              풀려서, 값이 긴 이벤트가 오면 제목이 **한글 한 글자 폭**까지 짜부라진다
              (실측: 16px × 413px 세로 텍스트). 회귀 테스트 있음. */
           el("span", { class: "t" }, e.title),
           el("b", {}, e.value));
  return d;
}

function factorRow(f, r, asofTs) {
  if (f.pending || f.score == null) {
    const row = el("div", { class: "fr pend" });
    row.append(
      el("span", { class: "nm" }, f.name, el("small", {}, f.sub)),
      el("span", { style: "color:var(--ink-3);font-size:12px" }, f.pending || "데이터 대기"),
      el("span"), el("span"),
      el("span", { style: "text-align:right" }, gradeChip(null)),
      /* 대기 행은 눌러도 갈 곳이 없다 — `›` 를 남겨 두면 "눌리는 줄"로 읽힌다.
         빈 칸으로 두고 스크린리더에도 그렇게 알린다. */
      el("span", { class: "chev", "aria-hidden": "true" }, ""));
    return row;
  }
  /* <div onclick> 이었다 — 마우스로만 열렸고 Tab 으로는 닿지 않아, 2단 구조(결론 →
     클릭해서 상세)의 입구가 키보드 사용자에게는 아예 없었다. 진짜 <a href> 로 바꾸면
     포커스·Enter·새 탭 열기가 전부 브라우저 기본으로 따라온다. 겉모습은 그대로. */
  const row = el("a", { class: "fr", href: `#detail-${f.key}`,
    /* aria-label 은 행 안의 글자를 '대체'한다 — 1개월 변화를 빼면 화면을 못 보는
       사용자에게만 정보가 줄어든다. 화면에 있는 것을 모두 담고 링크 목적만 덧붙인다. */
    "aria-label": `${f.name}, ${f.sub}. ${Math.round(f.score)}점 ${f.grade}. `
      + `1개월 변화 ${deltaText(f.delta)}. 상세 보기` });
  const sparkWrap = el("span", { class: "spark-wrap" },
    sparkSVG(withToday(f.hist, asofTs, f.score), palette().accent));
  row.append(
    el("span", { class: "nm" }, f.name, el("small", {}, f.sub)),
    sparkWrap,
    el("span", { class: "dl" }, deltaPts(f.delta)),
    el("span", { class: "sc" }, String(Math.round(f.score))),
    el("span", { style: "text-align:right" }, gradeChip(f.grade)),
    el("span", { class: "chev", "aria-hidden": "true" }, "›"));
  return row;
}

function renderFactorGroup(titleSel, rowsSel, layerKey, layer, subtitle, r, asofTs) {
  const title = $(titleSel);
  title.textContent = "";
  title.append(`${layer.name} ${Math.round(layer.score)}점 `, gradeChip(layer.grade), ` — ${subtitle}`);
  const wrap = $(rowsSel);
  wrap.textContent = "";
  const head = el("div", { class: "frh" });
  ["요인", "점수 추이 (24개월)", "1개월 변화", "점수", "등급", ""].forEach((h, i) =>
    head.append(el("span", { style: i >= 2 && i <= 4 ? "text-align:right" : "" }, h)));
  wrap.append(head);
  r.factors.filter((f) => f.layer === layerKey).forEach((f) => wrap.append(factorRow(f, r, asofTs)));
}

function buildRiskMethod(r) {
  const box = $("#risk-method");
  box.textContent = "";
  box.append(el("summary", {}, "산식 · 가중치 · 검증 (방법론)"));
  const w = r.weights;
  box.append(el("p", {}, el("b", {}, "점수"), ` — ${r.howto}`));
  box.append(el("p", {}, el("b", {}, "현재 위험 가중치"),
    ` — ${w.desc} (학습 타깃: ${w.target} · 최근 재학습 ${w.refit})`));
  const wt = el("table", {},
    el("tr", {}, ...w.items.map((x) => el("th", {}, x.name))),
    el("tr", {}, ...w.items.map((x) => el("td", { class: "num" }, (x.w * 100).toFixed(1) + "%"))));
  box.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, wt));
  const v = r.validation;
  if (v && v.metrics) {
    box.append(el("p", {}, el("b", {}, "표본 외 검증"),
      ` — ${v.window} (${v.n_weeks}주 · 위기주 ${v.crisis_weeks}주)`));
    const vt = el("table", {},
      el("tr", {}, el("th", {}, "합성 방식"), el("th", { class: "num" }, "위험 추적력(IC)"),
        el("th", { class: "num" }, "위기 판별(AUC)")),
      ...v.metrics.map((m) => el("tr", {}, el("td", {}, m.name),
        el("td", { class: "num" }, String(m.ic)), el("td", { class: "num" }, String(m.auc5)))));
    box.append(vt, el("p", { style: "font-size:11.5px;color:var(--ink-3)" }, v.note));
  }
  box.append(el("p", {}, el("b", {}, "한계"), ` — ${r.limits}`));
}

function renderRisk() {
  const r = DATA.risk;
  if (!$("#risk")) return;
  if (!r || !r.layers) {
    $("#risk-headline").textContent = "리스크 데이터를 불러오지 못했습니다 — 파이프라인 로그를 확인하세요.";
    return;
  }
  const S = r.layers.stress, V = r.layers.vuln;
  const asofTs = Math.floor(Date.parse(r.asof + "T00:00:00Z") / 1000);
  const pal = palette();

  const hl = $("#risk-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문"));
  const a = el("div", { class: "a" }, `지금 시장 위험은 어느 수준인가 — 현재 위험 ${Math.round(S.score)} `);
  a.append(gradeChip(S.grade), ` · 잠재 위험 ${Math.round(V.score)} `, gradeChip(V.grade));
  hl.append(a);

  const cc = $("#risk-chart-card");
  cc.textContent = "";
  cc.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "위험 수준 추이 — 최근 24개월"),
    el("span", { class: "card-sub" }, `기준일 ${r.asof} · 선이 위로 갈수록 위험 · 배경 음영 = 등급 구간`)));
  const lg = el("div", { class: "legendline" });
  lg.append(legendKey(pal.series[0], `현재 위험 — ${S.question}`),
            legendKey(pal.series[1], `잠재 위험 — ${V.question} (가동 ${V.active}/${V.total} 요인)`));
  cc.append(lg);
  const box = el("div", { class: "chart-box" });
  cc.append(box);
  const sh = withToday(S.hist, asofTs, S.score), vh = withToday(V.hist, asofTs, V.score);
  makeBandChart(box, { seriesDefs: [
    { label: "현재 위험", color: pal.series[0], t: sh.t, v: sh.v },
    { label: "잠재 위험", color: pal.series[1], t: vh.t, v: vh.v },
  ] });

  const hw = $("#risk-howto");
  hw.textContent = "";
  hw.append(explainBox("risk-howto", { label: "점수 읽는 법" }, r.howto));
  const gb = el("div", { class: "gradebar" });
  BANDS.forEach(([lo, hi, c, nm]) =>
    gb.append(el("div", { style: `flex:1;background:${c};color:${bandInk(c)}` }, `${nm} (${lo}–${hi})`)));
  hw.append(gb);

  const em = $("#risk-events-mini");
  em.textContent = "";
  const emHead = el("div", { class: "card-head" }, el("span", { class: "card-title" }, "최근 이벤트"));
  emHead.append(el("a", { href: "#events",
    /* display/padding 은 24×24 최소 조작부(WCAG 2.5.8)를 맞추기 위한 것 — 카드 머리글의
       유일한 링크라 문장 속 인라인 링크 예외에 해당하지 않는다. */
    style: "margin-left:auto;font-size:12px;color:var(--accent-ink);text-decoration:none;"
         + "display:inline-block;padding:5px 4px" }, "전체 보기 →"));
  em.append(emHead);
  const evs = ((DATA.events && DATA.events.events) || []).slice(0, 5);
  if (!evs.length) em.append(el("div", { class: "chart-empty" }, "최근 이벤트 없음"));
  else evs.forEach((e) => em.append(evMini(e)));

  renderFactorGroup("#risk-stress-title", "#risk-stress-rows", "stress", S, "무엇이 흔들리고 있나", r, asofTs);
  renderFactorGroup("#risk-vuln-title", "#risk-vuln-rows", "vuln", V, "무엇이 쌓여 있나", r, asofTs);
  buildRiskMethod(r);
  /* 관계분석은 리스크 안의 입구가 되었다(2026-08-13 사용자 지시 — 상단 탭에서 내려옴).
     화면 자체는 그대로이므로 여기서는 들어가는 자리만 만든다. */
  const pl = $("#risk-panel-link");
  if (pl) {
    pl.textContent = "";
    pl.append(sectionLink("panel",
      "— 위험 지표와 시장 변수의 상관·교차상관·회귀"));
  }
}

/* ---------------- 이벤트 타임라인 ---------------- */

const evFilter = { sev: null, cat: null };

/* ── 이벤트 브리핑 — events.json.brief 를 카드로 보이고, 원하면 음성으로 읽는다.
   원고는 파이프라인(risk.compose_brief)이 이벤트 필드를 **원문 그대로** 템플릿에
   끼운 것이라(LLM 없음) 아래 타임라인과 한 글자도 어긋날 수 없다 — 화면은 받은
   문장을 그대로 표시·낭독만 한다(여기서 문장을 만들지 말 것).
   음성 규약(사용자 승인 2026-08-11): **기기 내(localService) 한국어 음성만** 쓴다.
   Chrome 의 "Google 한국의" 같은 클라우드 음성은 문장을 구글 서버로 보내므로
   「외부 요청 0」 규약을 조용히 깬다 — 그 경우 재생 대신 이유를 카드에 적는다
   (원고 자체는 항상 눈으로 읽을 수 있다). 자동재생 없음(버튼으로만 — WCAG 1.4.2),
   재생 중 화면을 떠나면 정지(routeView 의 stopBrief). */
const speechOK = () =>
  typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";

function briefVoice() {
  if (!speechOK()) return null;
  return speechSynthesis.getVoices().find(
    (v) => v.localService &&
      String(v.lang).toLowerCase().replace("_", "-").startsWith("ko")) || null;
}

let briefSpeaking = false;

function stopBrief() {
  if (!speechOK()) return;
  speechSynthesis.cancel();
  briefSpeaking = false;
  const b = $("#brief-play");
  if (b) { b.textContent = "▶ 브리핑 듣기"; b.setAttribute("aria-pressed", "false"); }
}

function playBrief(lines) {
  const btn = $("#brief-play"), note = $("#brief-note");
  const voice = briefVoice();
  if (!voice) {
    /* 음성 목록이 늦게 로드되는 브라우저가 있어 클릭 시점에 다시 확인한다 —
       기기 내 한국어 음성이 없으면 클라우드로 넘어가지 않고 이유를 적는다. */
    if (note) note.hidden = false;
    return;
  }
  speechSynthesis.cancel();
  briefSpeaking = true;
  btn.textContent = "■ 정지";
  btn.setAttribute("aria-pressed", "true");
  lines.forEach((line, i) => {
    const u = new SpeechSynthesisUtterance(line);
    u.lang = "ko-KR";
    u.voice = voice;
    if (i === lines.length - 1) u.onend = () => stopBrief();
    speechSynthesis.speak(u);
  });
}

function renderEventsBrief(E) {
  const box = $("#events-brief");
  if (!box) return;
  if (briefSpeaking) stopBrief();          // 필터 클릭 재렌더 중 유령 재생 방지
  box.textContent = "";
  const lines = E && E.brief;
  if (!Array.isArray(lines) || !lines.length) { box.hidden = true; return; }
  box.hidden = false;
  const head = el("div", { class: "brief-head" }, el("strong", {}, "브리핑"));
  if (speechOK()) {
    head.append(el("button", {
      type: "button", id: "brief-play", class: "brief-play", "aria-pressed": "false",
      onclick: () => (briefSpeaking ? stopBrief() : playBrief(lines)),
    }, "▶ 브리핑 듣기"));
  }
  box.append(head);
  lines.forEach((l, i) => box.append(el("p", {
    class: "brief-line" + (i === 0 ? " brief-lead"
         : i === lines.length - 1 ? " brief-disc" : ""),
  }, l)));
  const note = el("p", { class: "brief-note", id: "brief-note" },
    "이 브라우저에는 기기 내 한국어 음성이 없어 음성 재생을 하지 않습니다 — ",
    "클라우드 음성은 문장을 외부 서버로 보내므로 쓰지 않습니다(외부 요청 0 규약).");
  note.hidden = true;
  box.append(note);
  if (speechOK()) {
    /* 목록이 이미 로드돼 있고 기기 내 한국어 음성이 없으면 미리 밝힌다.
       늦게 도착하는 브라우저는 voiceschanged 가 다시 판정한다 — on* 대입이라
       재렌더가 겹쳐도 리스너는 한 벌이다. */
    const sync = () => {
      const btn = $("#brief-play"), n = $("#brief-note");
      if (!btn || !n) return;
      const loaded = speechSynthesis.getVoices().length > 0;
      const missing = loaded && !briefVoice();
      btn.disabled = missing;
      n.hidden = !missing;
    };
    sync();
    speechSynthesis.onvoiceschanged = sync;
  }
}

function renderEventsTimeline() {
  const E = DATA.events;
  const tl = $("#events-timeline");
  tl.textContent = "";
  let list = E.events;
  if (evFilter.sev) list = list.filter((e) => e.sev === evFilter.sev);
  if (evFilter.cat) list = list.filter((e) => e.cat === evFilter.cat);
  if (!list.length) {
    tl.append(el("div", { class: "chart-empty" }, "조건에 맞는 이벤트가 없습니다."));
    return;
  }
  const byDate = new Map();
  list.forEach((e) => {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  });
  const sevRail = { "경계": "s-crit", "주의": "s-warn", "정보": "s-info" };
  for (const [date, evs] of byDate) {
    const body = el("div", { class: "tlbody" });
    evs.forEach((e) => {
      const sevCls = e.sev === "경계" ? "c-crit" : e.sev === "주의" ? "c-warn" : "c-mid";
      const card = el("div", { class: "ecard" });
      card.append(el("span", { class: `chip ${sevCls}` }, e.sev),
                  el("span", { class: "t" }, e.title),
                  el("span", { class: "v" }, e.value),
                  el("span", { class: "r" }, `규칙: ${e.rule}`));
      body.append(card);
    });
    tl.append(el("div", { class: "tlday" },
      el("div", { class: "tldate" }, date),
      el("div", { class: `tlrail ${sevRail[evs[0].sev]}` }, el("i")),
      body));
  }
}

function renderEvents() {
  const E = DATA.events;
  if (!$("#events")) return;
  if (!E || !E.events) {
    $("#events-headline").textContent = "이벤트 데이터를 불러오지 못했습니다.";
    return;
  }
  const counts = { "경계": 0, "주의": 0, "정보": 0 };
  E.events.forEach((e) => { counts[e.sev] = (counts[e.sev] || 0) + 1; });
  const hl = $("#events-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문"));
  const a = el("div", { class: "a" },
    `지난 업로드 이후 무엇이 특이했나 — 최근 ${E.lookback_days}일 이벤트 ${E.events.length}건 `);
  a.append(el("small", {}, `경계 ${counts["경계"]} · 주의 ${counts["주의"]} · 정보 ${counts["정보"]} · 엑셀 업로드 시마다 자동 검출`));
  hl.append(a);

  renderEventsBrief(E);

  const ft = $("#events-filters");
  ft.textContent = "";
  const mkChip = (label, kind, val) => {
    const on = kind === "sev" ? evFilter.sev === val : kind === "cat" ? evFilter.cat === val
             : !evFilter.sev && !evFilter.cat;
    return el("button", { type: "button", class: on ? "on" : "",
      "aria-pressed": on ? "true" : "false", onclick: () => {
      if (kind === "all") { evFilter.sev = null; evFilter.cat = null; }
      else if (kind === "sev") evFilter.sev = evFilter.sev === val ? null : val;
      else evFilter.cat = evFilter.cat === val ? null : val;
      renderEvents();
    } }, label);
  };
  ft.append(mkChip("전체", "all"));
  ["경계", "주의", "정보"].forEach((s) => ft.append(mkChip(s, "sev", s)));
  ft.append(el("span", { class: "sep" }, "|"));
  [...new Set(E.events.map((e) => e.cat))].forEach((c) => ft.append(mkChip(c, "cat", c)));

  renderEventsTimeline();

  const rules = $("#events-rules");
  rules.textContent = "";
  rules.append(el("summary", {}, "이벤트 규칙 카탈로그 (전 규칙 공개)"));
  const t = el("table", {},
    el("tr", {}, el("th", {}, "분류"), el("th", {}, "규칙"), el("th", {}, "심각도")));
  (E.catalog || []).forEach((c) =>
    t.append(el("tr", {}, el("td", {}, c.cat), el("td", {}, c.rule), el("td", {}, c.sev))));
  rules.append(t, el("p", { style: "font-size:11.5px;color:var(--ink-3)" },
    "알림 피로 방지: 동일 시리즈·동일 규칙은 하루 1건으로 병합됩니다."));
}

/* ---------------- 요인 상세 오버레이 ---------------- */

let overlayCharts = [];
let overlayReturnFocus = null;

/* 드릴다운 오버레이의 공통 껍데기 — 요인 상세(리스크)·시뮬레이터(환헤지)·자산배분
   드릴다운이 모두 같은 `#detail-overlay` 하나를 쓰므로 여는 방식도 한 곳으로 모은다.

   실측으로 잡은 결함: 오버레이가 떠 있는 상태에서 Tab 을 12번 눌러도 초점이 오버레이
   **안으로 한 번도 들어가지 않았다**(0/12). 뒤에 깔린 섹션과 상단 메뉴를 계속 돌았다.
   닫는 길도 화면 왼쪽 위 작은 글씨 링크 하나뿐이었다.

   ① `role="dialog"` + `aria-modal` 로 보조기술에 "지금은 이 층이 전부"라고 알린다.
   ② 뒤 배경(header/main/footer)에 `inert` 를 걸어 초점과 클릭이 새지 않게 한다.
      오버레이는 position:fixed·inset:0·z-index:60 으로 헤더(z-index:30)를 **덮는다** —
      즉 헤더는 보이지 않는 상태이므로 조작 가능하게 두는 편이 오히려 틀렸다.
      (테마 버튼이 오버레이 중에는 눌리지 않게 되는데, 이는 회귀가 아니라 의도다.)
      inert 를 모르는 브라우저에서는 지금과 똑같이 동작할 뿐 나빠지지 않는다.
   ③ 눈에 보이는 「✕ 닫기」 버튼을 넣고, 열 때 그 버튼으로 초점을 옮긴다.
      닫을 때는 열기 전에 초점이 있던 자리로 되돌린다. Esc 는 그대로 산다. */
function overlayBackdrop(on) {
  /* 오버레이 **자신을 뺀** body 직계 자식 전부에 건다.
     header/main/footer 만 이름으로 집으면 그 셋에 속하지 않는 형제(본문 바로가기 링크,
     관문)가 남아 초점이 그리로 샌다 — 실측으로 Tab 16회 중 8회가 오버레이 밖으로
     나갔고, 그중 하나가 `.skip-link` 였다. 여기서 "그 외 전부"로 잡으면 나중에 body
     자식이 하나 더 늘어도 자동으로 따라온다. */
  document.querySelectorAll("body > *").forEach((n) => {
    if (n.id === "detail-overlay") return;
    if ("inert" in n) n.inert = on;
  });
}

function openOverlayShell({ backLabel, backHash, crumbTail, title }) {
  const ov = $("#detail-overlay");
  const prev = document.activeElement;
  if (prev && prev !== document.body && !ov.contains(prev)) overlayReturnFocus = prev;
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  ov.textContent = "";
  ov.hidden = false;
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", title);
  overlayBackdrop(true);
  document.body.style.overflow = "hidden";
  const inner = el("div", { class: "detail-inner" });
  ov.append(inner);
  const back = el("a", { href: `#${backHash}` }, backLabel);
  const close = el("button", {
    class: "detail-close", type: "button", "aria-label": `${title} 닫기 (Esc)`,
    onclick: () => { location.hash = backHash; },
  }, "✕ 닫기");
  inner.append(el("div", { class: "crumb" }, back, crumbTail, close));
  close.focus();
  ov.scrollTop = 0;
  return inner;
}

function hideDetail() {
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  const ov = $("#detail-overlay");
  const wasOpen = !ov.hidden;
  ov.hidden = true;
  ov.textContent = "";
  ov.removeAttribute("role");
  ov.removeAttribute("aria-modal");
  ov.removeAttribute("aria-label");
  overlayBackdrop(false);
  document.body.style.overflow = "";
  if (wasOpen && overlayReturnFocus && document.contains(overlayReturnFocus)
      && overlayReturnFocus.offsetParent !== null) {
    overlayReturnFocus.focus();
  }
  overlayReturnFocus = null;
}

function openDetail(key) {
  const r = DATA.risk;
  const f = r && r.factors.find((x) => x.key === key);
  if (!f || f.pending || f.score == null) { hideDetail(); return; }
  const layer = r.layers[f.layer];
  const asofTs = Math.floor(Date.parse(r.asof + "T00:00:00Z") / 1000);
  const pal = palette();
  const inner = openOverlayShell({
    backLabel: "‹ 리스크로 돌아가기", backHash: "risk",
    crumbTail: ` / ${layer.name} / ${f.name}`, title: `${f.name} 요인 상세`,
  });

  const hl = el("div", { class: "qa" });
  hl.append(el("div", { class: "q" }, `이 요인이 답하는 질문 — ${f.question}`));
  const a = el("div", { class: "a" }, `${f.name} ${Math.round(f.score)}점 `);
  a.append(gradeChip(f.grade), " ", el("small", {}, "1개월 전 대비 "), deltaPts(f.delta));
  hl.append(a);
  inner.append(hl);

  const two = el("div", { class: "detail-two" });
  inner.append(two);

  const left = el("div", {});
  const chartCard = el("div", { class: "card" });
  chartCard.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, `${f.name} 점수 추이 — 24개월`),
    el("span", { class: "card-sub" }, "배경 음영 = 등급 구간")));
  const box = el("div", { class: "chart-box" });
  chartCard.append(box);
  left.append(chartCard);

  const steps = el("div", { class: "howto", style: "margin-top:14px" });
  steps.append(el("b", {}, "이 점수가 나오는 과정"));
  const stepBox = el("div", { class: "steps" });
  (f.steps || []).forEach((s) => stepBox.append(el("div", {}, s)));
  if (f.weight != null) {
    stepBox.append(el("div", {}, el("b", {},
      `현재 위험 합성 시 이 요인의 가중치 ${(f.weight * 100).toFixed(1)}%`),
      " (예측력 비례 + 최소바닥 8%, 매 4주 재학습)"));
  }
  steps.append(stepBox);
  left.append(steps);
  if (f.note) left.append(el("p", { class: "section-note", style: "margin-top:10px" }, `참고 — ${f.note}`));
  left.append(el("p", { class: "section-note", style: "margin-top:6px" }, `한계 — ${r.limits}`));
  two.append(left);

  const right = el("div", {});
  right.append(el("h3", { style: "font-size:14px;margin:2px 0 10px" }, "구성 지표 (원자료)"));
  (f.indicators || []).forEach((ind, i) => {
    const c = el("div", { class: "icard" });
    const head = el("div", { style: "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap" });
    head.append(el("b", {}, ind.label));
    if (ind.desc) head.append(el("span", { style: "color:var(--ink-3);font-size:11.5px" }, ind.desc));
    const vb = el("span", { class: "vbig", style: "margin-left:auto" }, ind.value);
    vb.append(el("small", {}, ind.unit ? ` ${ind.unit}` : ""));
    head.append(vb);
    c.append(head);
    if (ind.spark) c.append(sparkSVG(ind.spark, pal.series[i % 8]));
    c.append(el("div", { class: "expl" },
      `${ind.since}년 이후 이력 대비 백분위 ${Math.round(ind.pctl)}% → 점수 `,
      el("b", {}, `${Math.round(ind.score)}점`), ` (${ind.date} 기준)`));
    right.append(c);
  });
  const rel = ((DATA.events && DATA.events.events) || [])
    .filter((e) => (e.tags || []).some((t) => (f.tags || []).includes(t))).slice(0, 6);
  if (rel.length) {
    const rc = el("div", { class: "card" });
    rc.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "관련 이벤트")));
    rel.forEach((e) => rc.append(evMini(e)));
    right.append(rc);
  }
  two.append(right);

  const fh = withToday(f.hist, asofTs, f.score);
  overlayCharts.push(makeBandChart(box, {
    seriesDefs: [{ label: `${f.name} 점수`, color: pal.series[0], t: fh.t, v: fh.v }],
    height: 280,
  }));
  /* 맨 위로 올리는 것은 openOverlayShell() 이 이미 한다 — 여기서 지역변수 ov 를 다시
     들여다보면 ReferenceError 로 상세 화면이 통째로 죽는다. */
}

/* ==========================================================================
   Post Village — 관문(게이트) + 마을 지도(홈/내비게이션)
   ==========================================================================
   설계 규약(docs/HANDOVER.md §3.3):
   - 은유는 이 층(관문·마을·헤더 여백)에만. 데이터 섹션 14개는 손대지 않는다.
   - 지도 이미지에는 글자가 없다 — 라벨은 전부 여기서 얹는다(선명·수정·다국어·접근성).
   - 낮/밤 두 장은 구도가 동일해야 하며, 아래 비율 좌표를 공통으로 쓴다.
   - 움직임 규약(2026-08-03 개정): 마을 층에는 앰비언트 모션(물·새·행인·낙엽·구름
     그림자)과 건물 입장 연출을 허용. 데이터 섹션은 정적 유지, reduced-motion 존중.
     패럴랙스·자동 낮밤순환은 여전히 없음.
   - 같은 날 2차 개정(사용자: "그림에 구운 새·구름·사람이 안 움직여 이상하다"):
     마을 배경에 상시 앰비언트 영상 루프 허용(mountVillageVideo). 단 루프는 테마
     안에서만 돈다 — 낮 테마엔 낮 루프, 밤 테마엔 밤 루프. 자동 낮밤순환 금지는 유지.

   **관문은 접근 차단이 아니다.** 이 사이트는 서버 없는 공개 정적 호스팅이라
   data/*.json 은 주소만 알면 인증 없이 받아진다 — 암구호를 해시로 두어도 마찬가지다.
   해시를 쓰는 이유는 소스에서 평문이 바로 눈에 띄지 않게 하는 것뿐이며, 보안이 아니다.
   진짜 "공유한 사람만"이 필요하면 접근제어 되는 호스팅으로 옮겨야 한다(§3.3).            */

/* 예전에는 통과 사실을 localStorage(`iaw-gate`)에 영구 저장해 **처음 한 번만** 물었다.
   사용자 지시(2026-08-05)로 **접속할 때마다** 묻는다 — 그래서 저장하지 않는다.
   남아 있던 옛 키는 켜질 때 지운다(안 지우면 예전 방문자는 계속 통과된다).
   해시 탐색을 다시 넣고 싶으면 sessionStorage 한 줄이면 되지만, 그건 "탭을 닫을 때까지"
   기억하는 것이라 지시와 다르다. */
const GATE_STALE_KEY = "iaw-gate";

/* SHA-256 16진수. 예전엔 FNV-1a 32bit 이었는데 값 공간이 43억뿐이라 **충돌하는 다른
   문자열로도 열렸다** — 같은 상수를 어차피 바꾸는 김에 교체했다. Web Crypto 라 의존성 0.
   바꾸려면 아래 한 줄만 새 해시로 교체한다.
   콘솔에서: await __iaw.gateHash("새암구호")
   또는:     python3 -c "import hashlib;print(hashlib.sha256('새암구호'.encode()).hexdigest())" */
const GATE_SHA256 = "ad1eb115d256a4ad6d7b0b47747888f39286869bc23079d67df26a2cd99d15a6";

/* 암구호에 **공백이 들어 있다**. 앞뒤 공백과 중간 연속 공백은 오타이지 다른 암구호가
   아니므로 하나로 접는다 — 대소문자는 접지 않는다(그건 실제로 값 공간을 줄인다).
   모바일 자동 대문자화는 입력칸의 autocapitalize/autocorrect 속성으로 막는다. */
const gateNormalize = (s) => String(s).trim().replace(/\s+/g, " ");

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* 건물 ↔ 화면. x/y 는 지도 이미지 기준 백분율(좌상단 0,0).
   target 하나면 바로 그 화면으로, menu 가 있으면 클릭 시 하위 메뉴를 연다.
   soon 은 아직 없는 화면(눌러도 아무 일 없음).

   2026-08-03 지도 교체(사용자 Gemini 영상 기반). 새 지도에는 성채·망루가 없어
   두 구역을 재배정했다: 리스크 → 종탑(교회 — 경보의 종), 이벤트 → 여관(소식이
   모이는 곳). 언덕 위 탑은 밤에만 서서히 나타나는 영상 속 연출로 남겨 두었고
   클릭 대상이 아니다. 좌표는 새 지도(1280×720) 실측. */
const VILLAGE_ZONES = [
  { key: "belltower", x: 83.6, y: 65.0, name: "종탑", sub: "리스크", target: "risk" },
  { key: "observatory", x: 59.5, y: 20.6, name: "관천대", sub: "관계분석", target: "panel" },
  { key: "inn", x: 31.3, y: 30.6, name: "여관", sub: "이벤트", target: "events" },
  { key: "post", x: 48.6, y: 42.8, name: "중앙 우체국", sub: "오늘의 개요", target: "overview" },
  { key: "market", x: 36.6, y: 54.9, name: "저잣거리", sub: "시장 시세 7종", menu: [
      ["rates", "금리"], ["irs", "IRS"], ["credit", "크레딧"], ["fx", "FX"],
      ["inflation", "물가"], ["acwi", "ACWI"], ["macro", "매크로"]] },
  /* 곳간은 메뉴 구역이다 — 지도 이미지가 고정이라 새 섹션마다 핫스팟 좌표를 지어내면
     건물 없는 빈 땅을 가리키게 된다(§7.8). 포트폴리오를 다루는 두 화면을 한 건물에 둔다. */
  { key: "granary", x: 81.0, y: 31.8, name: "곳간", sub: "자산배분·수익률 추정", menu: [
      ["estimate", "수익률 추정"], ["alloc", "자산배분"]] },
  { key: "trading", x: 67.8, y: 73.9, name: "교역소", sub: "환헤지", target: "hedge" },
  { key: "archive", x: 24.8, y: 71.1, name: "서고", sub: "카탈로그", target: "catalog" },
  { key: "workshop", x: 10.8, y: 48.9, name: "공방", sub: "모델 랩 — 준비 중", soon: true },
];

const SECTION_IDS = ["overview", "risk", "estimate", "alloc", "hedge", "events", "panel",
                     "rates", "irs", "credit", "fx", "inflation", "acwi", "macro", "catalog"];

/* 오버레이 해시는 그 아래에 어느 섹션이 깔려 있어야 하는지를 정한다 */
function underlyingSection(hash) {
  if (hash === "hedge-sim") return "hedge";
  if (hash.startsWith("alloc-")) return "alloc";
  if (hash.startsWith("detail-")) return "risk";
  return SECTION_IDS.includes(hash) ? hash : null;
}

/* 지도 파일 후보. webp 가 정석(용량)이지만 png 도 받는다 — 변환 도구 없이 GitHub 웹으로
   바로 올릴 수 있어야 하기 때문이다. 앞에서부터 시도하고 전부 실패하면 안내 문구를 띄운다. */
const VILLAGE_EXTS = ["webp", "png", "jpg"];

function villageImgUrl(ext = VILLAGE_EXTS[0]) {
  return `assets/village-${currentScene()}.${ext}`;
}

/* ---- 앰비언트 레이어 — 정적 지도 위에 코드로 얹는 "살아 있는 마을" ----------------
   지도 이미지 자체는 손대지 않는다(승인된 원본이 스펙). 영상 루프(mountVillageVideo)가
   재생되는 동안에는 .has-video 가 이 레이어를 감춘다(움직임 중복 방지) — 즉 이 SVG 는
   영상이 없거나(파일 미존재·재생 거부·자동재생 차단) 좁은 화면 폴백일 때의 모션이다:
   시냇물 반짝임·새(낮)·반딧불이(밤)·행인 6명·낙엽·구름 그림자.
   - 좌표계는 viewBox 1280×720 = 지도(영상 프레임) 원본 픽셀. preserveAspectRatio="none" 이라
     지도가 어떤 폭으로 늘어나도 1:1 로 따라붙는다 (VILLAGE_ZONES 의 % 좌표와 동일 원리).
   - pointer-events 없음 — 클릭은 전부 핫스팟이 받는다.
   - prefers-reduced-motion 이면 CSS 가 레이어째 감춘다(SMIL 은 그 설정을 모른다).
   - 풀·나무 자체를 흔드는 것은 픽셀 왜곡(displacement) 이라 화질·성능을 해쳐서 넣지
     않았다 — 낙엽·구름 그림자가 바람의 간접 신호다. */
function villageFxMarkup() {
  const person = (road, dur, begin, coat) => `
    <g class="fx-person">
      <ellipse cx="0" cy="0" rx="3.4" ry="1.3" fill="rgba(30,20,10,.28)"/>
      <rect x="-2.6" y="-9.5" width="5.2" height="8.4" rx="2.4" fill="${coat}"/>
      <circle cx="0" cy="-11.4" r="2.6" fill="#e8c39a"/>
      <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite"
        keyPoints="0;1;1;0;0" keyTimes="0;.46;.5;.96;1" calcMode="linear">
        <mpath href="#${road}"/>
      </animateMotion>
    </g>`;
  const bird = (path, dur, begin) => `
    <g class="fx-bird">
      <path fill="none" stroke="#2f2a24" stroke-width="1.5" stroke-linecap="round" opacity=".6">
        <animate attributeName="d" dur=".8s" begin="${begin}s" repeatCount="indefinite"
          values="M-4.5,0 Q-2.2,-3 0,-.5 Q2.2,-3 4.5,0;M-4.5,-1.4 Q-2.2,1.2 0,-.9 Q2.2,1.2 4.5,-1.4;M-4.5,0 Q-2.2,-3 0,-.5 Q2.2,-3 4.5,0"/>
      </path>
      <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/>
    </g>`;
  const fly = (x, y, dur, begin) => `
    <circle class="fx-fly" r="1.7" fill="#ffd98c">
      <animate attributeName="opacity" values="0;.9;.15;.75;0" dur="5.5s" begin="${begin}s" repeatCount="indefinite"/>
      <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite"
        path="M ${x},${y} c 16,-11 30,5 20,18 c -10,13 -30,2 -20,-18"/>
    </circle>`;
  const leaf = (path, dur, begin, fill) => `
    <g class="fx-leaf" opacity=".5">
      <path d="M0,0 q3,-4 6,0 q-3,4 -6,0" fill="${fill}"/>
      <animateTransform attributeName="transform" type="rotate" values="0;140;250;360"
        dur="6s" begin="${begin}s" repeatCount="indefinite" additive="sum"/>
      <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/>
    </g>`;
  return `
  <defs>
    <path id="fx-road1" d="M 190,385 C 260,405 330,410 400,402 C 425,398 445,395 458,395"/>
    <path id="fx-road2" d="M 505,412 C 560,420 600,430 625,455 C 638,468 645,480 650,492"/>
    <path id="fx-road3" d="M 628,308 C 665,288 705,272 748,268 C 762,267 770,267 776,268"/>
    <path id="fx-road4" d="M 850,278 C 905,285 955,288 1000,278 C 1015,274 1028,268 1038,260"/>
    <path id="fx-road5" d="M 340,540 C 420,560 500,555 560,530 C 590,518 615,505 635,498"/>
    <path id="fx-road6" d="M 890,555 C 940,558 985,548 1020,528 C 1032,520 1042,512 1048,504"/>
    <radialGradient id="fx-cloud-g">
      <stop offset="0" stop-color="#000" stop-opacity=".09"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="fx-fire-g">
      <stop offset="0" stop-color="#ffb347" stop-opacity=".55"/>
      <stop offset="1" stop-color="#ffb347" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="fx-water">
    <!-- 경로는 이미지에서 물 색 픽셀을 검출해 뽑은 실측 중심선.
         끊긴 자리(윗다리 y≈265-300 · 돌다리 y≈490-540)는 다리 그림 위로
         점선이 지나가지 않게 일부러 비워 둔 구간이다 -->
    <path d="M 918,136 C 906,155 905,170 911,185 C 908,200 897,210 872,222 C 850,232 834,244 826,258"/>
    <path d="M 827,304 C 833,320 850,334 860,348 C 866,362 867,376 864,390 C 856,404 843,418 828,430 C 812,442 795,454 777,466 C 765,474 760,480 759,488"/>
    <path d="M 662,545 C 630,560 612,580 607,600 C 602,616 590,630 574,644 C 556,658 530,672 508,682 C 498,687 492,690 486,693"/>
    <path class="slow" transform="translate(4,3)" d="M 918,136 C 906,155 905,170 911,185 C 908,200 897,210 872,222 C 850,232 834,244 826,258"/>
    <path class="slow" transform="translate(4,3)" d="M 827,304 C 833,320 850,334 860,348 C 866,362 867,376 864,390 C 856,404 843,418 828,430 C 812,442 795,454 777,466"/>
    <path class="slow" transform="translate(4,3)" d="M 662,545 C 630,560 612,580 607,600 C 602,616 590,630 574,644 C 556,658 530,672 508,682"/>
  </g>
  <g class="fx-fire">
    <!-- 저잣거리 모닥불 — 그림 속 불꽃 위에 은은한 온기 맥동(낮밤 공통) -->
    <circle cx="456" cy="385" r="26" fill="url(#fx-fire-g)">
      <animate attributeName="opacity" values=".5;1;.65;1;.5" dur="2.6s" repeatCount="indefinite"/>
      <animate attributeName="r" values="22;28;24;29;22" dur="2.6s" repeatCount="indefinite"/>
    </circle>
  </g>
  <g class="fx-cloud">
    <ellipse rx="230" ry="120" fill="url(#fx-cloud-g)">
      <animateMotion dur="95s" repeatCount="indefinite"
        path="M -280,200 C 180,140 500,240 790,175 C 1070,120 1350,215 1580,165 C 1300,240 550,130 -280,200"/>
    </ellipse>
  </g>
  <g class="fx-birds">
    ${bird("M -40,130 C 280,85 650,140 930,85 C 1120,55 1260,105 1330,90", 58, -12)}
    ${bird("M 1330,110 C 1020,65 650,130 370,75 C 190,48 60,100 -50,85", 72, -35)}
    ${bird("M -40,100 C 330,55 750,110 1330,65", 49, -44)}
  </g>
  <g class="fx-fireflies">
    ${fly(470, 400, 13, -3)}${fly(622, 372, 15, -8)}${fly(310, 542, 16, -11)}
    ${fly(866, 552, 14, -1)}${fly(1058, 502, 12, -5)}${fly(1040, 288, 15, -7)}
  </g>
  <g class="fx-people">
    ${person("fx-road1", 46, -9, "#8a4a2f")}
    ${person("fx-road2", 38, -22, "#4f6b8a")}
    ${person("fx-road3", 28, -5, "#6b7d4a")}
    ${person("fx-road4", 32, -17, "#7d4a6b")}
    ${person("fx-road5", 52, -30, "#5a5a5a")}
    ${person("fx-road6", 30, -12, "#a05c33")}
  </g>
  <g class="fx-leaves">
    ${leaf("M 300,300 c 38,56 -18,112 28,168 c 38,56 -10,112 28,158", 17, -4, "#7c8f4e")}
    ${leaf("M 560,180 c 28,65 -23,122 19,187 c 33,61 -5,122 23,168", 21, -12, "#8a9b55")}
    ${leaf("M 1150,380 c 23,51 -19,94 14,150 c 28,51 0,103 19,150", 15, -7, "#b7863f")}
    ${leaf("M 220,420 c 33,51 -14,103 23,159 c 28,51 -5,94 19,140", 19, -15, "#7c8f4e")}
  </g>`;
}

function buildVillageFx(frame) {
  if ($("#village-fx")) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "village-fx");
  svg.setAttribute("class", "village-fx");
  svg.setAttribute("viewBox", "0 0 1280 720");   // 지도 원본 픽셀 (영상 프레임과 동일)
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = villageFxMarkup();
  $("#village-map").after(svg);
}

/* ---- 상시 앰비언트 영상 — 지도 스틸 위에 깔리는 "실제로 움직이는" 마을 ---------------
   사용자의 Gemini 전환 영상(10초, 낮→밤)에서 잘라 만든 테마별 무이음새 루프 두 벌:
   낮 = 낮 안정 구간(0~6.0초)을 크로스페이드(1.25초)로 이어붙인 4.75초 루프,
   밤 = 밤 꼬리 구간(7.17~10초)을 정·역재생(palindrome)으로 이은 5.58초 루프.
   원본 10초를 통째로 <video loop> 에 거는 것은 안 된다: 실측으로 원본은 루프가 아니라
   낮→밤 전환이라(첫↔끝 프레임 MAD 55.3 vs 인접 프레임 평균 0.4) 10초마다 밤→낮이
   튀고, 상시 재생은 곧 자동 낮밤순환이라 위 움직임 규약이 금지한다 — 루프는 테마 안에서만.
   생성 레시피는 dashboard/assets/README.md. 파일이 없거나 재생이 거부되면 조용히
   물러나 스틸 + SVG 모션이 그대로 남는다(영상은 장식이지 필수가 아니다). 재생 중에는
   .has-video 가 SVG 모션을 끈다 — 영상 자체에 새·구름·행인·연기 모션이 들어 있다. */
const IDLE_VIDEO = { night: "assets/village-night-loop", day: "assets/village-day-loop" };
const IDLE_VIDEO_EXTS = ["webm", "mp4"];   // webm(VP9) 우선, 못 읽는 브라우저는 mp4(H.264)로

function mountVillageVideo(frame) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!frame || !frame.clientWidth) return;              // ≤720px 에서는 지도째 숨김 — 마운트 안 함
  if (frame.querySelector(".village-video[data-transition]")) return;  // 전환 연출 중 — 끝나면 다시 불린다
  const base = IDLE_VIDEO[currentScene()];
  const existing = frame.querySelector(".village-video[data-idle]");
  if (existing) {
    if (existing.dataset.base === base) { existing.play().catch(() => {}); return; }
    existing.remove();                                   // 테마가 바뀌었다 — 그 테마의 루프로 교체
    frame.classList.remove("has-video");
  }
  const v = document.createElement("video");
  v.className = "village-video";
  v.dataset.idle = "1";
  v.dataset.base = base;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("aria-hidden", "true");
  v.preload = "auto";
  const giveUp = () => { v.remove(); frame.classList.remove("has-video"); };
  /* 자동재생 거부(NotAllowedError — 절전 모드 등)만 포기 사유다. 소스 포맷 불가
     (NotSupportedError)는 아래 error 사다리가 다음 확장자로 넘어가며 처리한다. */
  const tryPlay = () => v.play().catch((e) => {
    if (e && e.name === "NotAllowedError") giveUp();
  });
  let tried = 0;
  v.addEventListener("error", () => {
    tried += 1;
    if (tried < IDLE_VIDEO_EXTS.length) {
      v.src = `${base}.${IDLE_VIDEO_EXTS[tried]}`;
      tryPlay();
    } else {
      giveUp();
    }
  });
  /* 재생이 실제로 시작된 뒤에 무대에 올리고(.has-video), 한 프레임 뒤 .is-on 으로 페이드인한다.
     낮 루프의 첫 프레임은 원본 f24 라 낮 스틸(=원본 f0)보다 1초 앞서 있다 — 새·구름이 1초분
     순간이동하는 셈인데(실측 MAD 3.84 vs 무이음 기준선 2.34), 0.45초 크로스페이드가 이 도약을
     덮는다. 밤 루프는 첫 프레임이 전환 끝 프레임과 같아(2.33 ≈ 기준선 2.04) 페이드가 무해하다.
     rAF 를 거치는 이유: display:none→block 과 opacity 를 같은 프레임에 바꾸면 전이가 생략된다. */
  v.addEventListener("playing", () => {
    frame.classList.add("has-video");
    requestAnimationFrame(() => v.classList.add("is-on"));
  });
  v.src = `${base}.${IDLE_VIDEO_EXTS[0]}`;
  $("#village-map").after(v);
  tryPlay();
}

/* ---- 테마 전환 연출 — 마을에 밤이 내리는(걷히는) 영상 -------------------------------
   정지 지도 두 장(낮/밤)은 사용자가 만든 전환 영상의 첫/끝 프레임에서 뽑았다. 그래서
   영상 첫 프레임 = 현재 지도, 끝 프레임 = 목표 지도가 항상 성립하고, 이 함수는 그 사이를
   재생으로 메운다: 현재 지도 위에 영상을 깔고, 재생이 실제로 시작된 순간 밑의 테마를
   바꾼 뒤, 끝나면 영상을 걷는다 — 어느 시점에 실패해도 즉시 전환으로 떨어질 뿐이다.
   루프가 필요 없으므로 이음새 문제도 없다. dusk = 낮→밤, dawn = 밤→낮(역재생 인코딩본).
   reduced-motion 사용자는 영상 없이 즉시 전환한다. */
/* dusk = 낮→밤, dawn = 밤→낮(역재생 인코딩본). **scene 축이다** — 정지 지도 2장이
   이 영상의 첫/끝 프레임이라, chrome 에 붙이면 "대시보드를 어둡게 했더니 해가 진다"는
   모순이 생긴다. */
const SCENE_VIDEO = { night: "assets/village-dusk.mp4", day: "assets/village-dawn.mp4" };
const SCENE_VIDEO_RATE = 2.5;            // 원본 10초 → 4초 연출

function preloadSceneVideos() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (preloadSceneVideos.done) return;
  preloadSceneVideos.done = true;
  Object.values(SCENE_VIDEO).forEach((src) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.src = src;                          // DOM 에 넣지 않는다 — 캐시 워밍용
  });
}

function playSceneTransition(nextScene, applyScene) {
  const frame = $("#village-frame");
  const cinematic = frame && !$("#village").hidden && !$("#village-map").hidden &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!cinematic) { applyScene(); return; }

  /* 상시 루프를 걷어내고 전환 영상이 프레임을 덮는다. 끝나면(done) 새 테마의 루프를
     다시 깐다 — applyScene→renderVillage 경로의 mountVillageVideo 는
     data-transition 가드에 막히므로, 재마운트 책임은 여기 done 하나뿐이다. */
  frame.querySelectorAll(".village-video").forEach((n) => n.remove());
  const v = document.createElement("video");
  v.className = "village-video";
  v.dataset.transition = "1";
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("aria-hidden", "true");
  let applied = false;
  const apply = () => { if (!applied) { applied = true; applyScene(); } };
  const done = () => {
    apply();
    v.remove();
    frame.classList.remove("has-video");
    mountVillageVideo(frame);
  };
  /* 영상이 늦으면(느린 네트워크·자동재생 거부) 연출을 포기하고 즉시 전환 */
  const guard = setTimeout(done, 700);
  v.addEventListener("playing", () => {
    clearTimeout(guard);
    frame.classList.add("has-video");     // 영상 표시 + SVG 모션 숨김 (.has-video CSS)
    apply();                              // 영상이 현재 모습을 덮은 뒤에 밑을 갈아끼운다
  });
  v.addEventListener("ended", done);
  v.addEventListener("error", () => { clearTimeout(guard); done(); });
  v.src = SCENE_VIDEO[nextScene === "night" ? "night" : "day"];
  v.playbackRate = SCENE_VIDEO_RATE;
  $("#village-map").after(v);
  v.play().catch(() => { clearTimeout(guard); done(); });
}

/* 건물 입장 연출 — 클릭한 건물을 향해 지도를 확대하며 페이드, 끝나면 그 화면으로.
   reduced-motion 이거나 지도가 없으면 연출 없이 바로 이동한다. */
function enterZone(z, targetHash) {
  const frame = $("#village-frame");
  /* 확대 연출(520ms)이 도는 동안 자동 순환이 끼어들면 확대 중인 지도가 통째로
     낮↔밤 전환 영상에 덮인다. 해시가 바뀌면 routeView 가 어차피 멈추지만
     그건 연출이 끝난 뒤라 늦다. */
  stopSceneCycle();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || $("#village-map").hidden || frame.classList.contains("vz-enter")) {
    location.hash = targetHash;
    return;
  }
  frame.style.transformOrigin = `${z.x}% ${z.y}%`;
  frame.classList.add("vz-enter");
  setTimeout(() => {
    location.hash = targetHash;
    frame.classList.remove("vz-enter");
    frame.style.transformOrigin = "";
  }, 520);
}

function renderVillage() {
  const img = $("#village-map");
  const frame = $("#village-frame");
  document.documentElement.style.setProperty("--village-img", `url("${villageImgUrl()}")`);

  frame.querySelectorAll(".vz, .vz-menu").forEach((n) => n.remove());
  img.hidden = false;
  $("#village-missing").hidden = true;
  let tried = 0;
  img.onerror = () => {
    tried += 1;
    if (tried < VILLAGE_EXTS.length) {
      const url = villageImgUrl(VILLAGE_EXTS[tried]);
      document.documentElement.style.setProperty("--village-img", `url("${url}")`);
      img.src = url;
      return;
    }
    /* 지도가 없으면 핫스팟도 지운다 — 비율 좌표로 붙어 있어서 안내 문구 위에
       겹쳐 얹히고, 지도가 없는 마당에 클릭할 건물도 없다. 아래 대체 목록이 그 역할을
       그대로 대신한다. */
    img.hidden = true;
    frame.querySelectorAll(".vz, .vz-menu, .village-fx, .village-video").forEach((n) => n.remove());
    frame.classList.remove("has-video");
    $("#village-missing").hidden = false;
  };
  img.onload = () => { buildVillageFx(frame); preloadSceneVideos(); };
  img.src = villageImgUrl();
  /* onload 안이 아니라 여기서 직접 마운트한다 — 같은 src 재할당은 브라우저에 따라
     load 이벤트를 다시 안 줄 수 있고, 마을로 돌아올 때마다 루프가 다시 돌아야 한다
     (routeView 가 떠날 때 pause 해 둔다). 마운트는 멱등이라 중복 호출이 안전하다. */
  mountVillageVideo(frame);
  /* 같은 이유로 폴백 SVG 도 캐시 경로에서 한 번 더 챙긴다 — 이미 붙어 있으면
     buildVillageFx 가 즉시 반환한다(멱등). 영상이 뜨면 어차피 .has-video 가 가린다. */
  if (img.complete && img.naturalWidth) { buildVillageFx(frame); preloadSceneVideos(); }

  VILLAGE_ZONES.forEach((z) => {
    const btn = el("button", {
      class: "vz", type: "button",
      style: `left:${z.x}%;top:${z.y}%`,
      "aria-label": z.soon ? `${z.name} — ${z.sub}` : `${z.name} — ${z.sub} 화면으로`,
    });
    if (z.soon) btn.setAttribute("data-soon", "1");
    btn.append(
      el("span", { class: "vz-dot" }),
      el("span", { class: "vz-label" }, z.name, el("span", { class: "vz-sub" }, z.sub)),
    );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      frame.querySelectorAll(".vz-menu").forEach((n) => n.remove());
      if (z.soon) return;
      if (z.target) { enterZone(z, z.target); return; }
      const menu = el("div", { class: "vz-menu", style: `left:${z.x}%;top:${z.y}%` });
      z.menu.forEach(([id, label]) => {
        const a = el("a", { href: `#${id}` }, label);
        a.addEventListener("click", (ev) => {   // 하위 메뉴도 같은 입장 연출을 탄다
          ev.preventDefault();
          ev.stopPropagation();
          menu.remove();
          enterZone(z, id);
        });
        menu.append(a);
      });
      frame.append(menu);
    });
    frame.append(btn);
  });
  /* 빈 곳을 누르면 열린 하위 메뉴를 닫는다. renderVillage() 는 테마 전환·마을 복귀 때마다
     다시 도므로 리스너는 한 번만 붙인다(안 그러면 호출 수만큼 쌓인다). */
  if (!frame.dataset.bound) {
    frame.dataset.bound = "1";
    frame.addEventListener("click", () => {
      frame.querySelectorAll(".vz-menu").forEach((n) => n.remove());
    });
  }

  /* 대체 목록 — 지도가 없거나 좁은 화면에서도 모든 화면에 도달할 수 있어야 한다 */
  const list = $("#village-list");
  list.textContent = "";
  VILLAGE_ZONES.forEach((z) => {
    if (z.soon) return;
    if (z.target) { list.append(el("a", { href: `#${z.target}` }, `${z.name} · ${z.sub}`)); return; }
    z.menu.forEach(([id, label]) => list.append(el("a", { href: `#${id}` }, `저잣거리 · ${label}`)));
  });
}

/* 기간 버튼이 실제로 무언가를 움직이는 화면인가.

   `registry` 에는 기간 필터가 축을 다시 잡아 주는 차트만 들어간다(makeTimeChart).
   실측 결과 개요·리스크·이벤트·관계분석·자산배분·카탈로그 6개 화면에는 그런 차트가
   **0개**인데도 "기간 1년/3년/5년/10년/전체" 줄이 그대로 떠 있었다. 눌러도 아무 일이
   일어나지 않는 버튼이 화면 맨 위에 있는 셈이라, 처음 쓰는 사람은 "내가 잘못 눌렀나"
   부터 의심하게 된다. 관계분석은 더 나쁘다 — 화면 안에 '기간' 이라는 이름의 다른
   드롭다운이 따로 있어서 같은 이름의 컨트롤 두 개가 서로 다른 뜻으로 겹쳐 있었다.

   DOM 포함관계로 판정하므로 차트가 다른 카드로 옮겨가도 따라온다. */
function sectionHasRangedChart(sec) {
  const node = document.getElementById(sec);
  if (!node) return false;
  return registry.some((e) => e.isTime && e.u && e.u.root && node.contains(e.u.root));
}

/* 마을 ↔ 섹션 화면 전환. 섹션은 한 번에 하나만 보인다(스크롤 길이 문제 해결). */
function routeView() {
  const hash = location.hash.replace(/^#/, "");
  const sec = underlyingSection(hash);
  const showVillage = !sec;
  /* 브리핑 음성은 화면 전환과 함께 끝낸다 — 이벤트 화면을 떠났는데 목소리만 남아
     따라오는 상태를 만들지 않는다(멱등이라 어느 전환에서 불려도 무해). */
  stopBrief();

  $("#village").hidden = !showVillage;
  $("#village-frame").classList.remove("vz-enter");   // 입장 연출 중 해시가 먼저 바뀌어도 잔상 없게
  const filter = document.querySelector(".filter-row");
  if (filter) filter.hidden = showVillage || !sectionHasRangedChart(sec);
  SECTION_IDS.forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.hidden = showVillage || id !== sec;
  });
  document.querySelectorAll("#nav a").forEach((a) => {
    const on = a.getAttribute("href") === `#${sec}`;
    a.classList.toggle("active", on);
    /* .active 는 색일 뿐이라 화면을 못 보는 사용자에게는 아무 신호도 아니었다.
       aria-current 가 "지금 이 화면"을 읽어 준다. */
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (showVillage) {
    renderVillage();
    /* 자동 순환은 마을이 보일 때만 돈다. hidden 을 위에서 이미 풀었으므로
       sceneCycleAllowed() 의 ②·⑤(가시성·폭) 판정이 여기서 유효하다. */
    restartSceneCycle();
  } else {
    /* 섹션으로 나가 있는 동안 상시 루프의 디코딩을 세운다 — 돌아오면
       renderVillage → mountVillageVideo 가 같은 요소를 다시 play 한다. */
    const iv = $("#village-frame video[data-idle]");
    if (iv) iv.pause();
    stopSceneCycle();
    ensureVillageBack(sec);
  }
  /* 토글 버튼의 의미가 화면에 따라 바뀐다(마을=장면, 섹션=명암) — 라벨을 같이 돌린다. */
  syncThemeButton();
  window.scrollTo(0, 0);
}

function ensureVillageBack(sec) {
  const node = document.getElementById(sec);
  if (!node || node.querySelector(".village-back")) return;
  const p = el("p", { class: "village-back" }, el("a", { href: "#village" }, "‹ 마을로 돌아가기"));
  node.prepend(p);
}

function bindGate() {
  const gate = $("#gate");
  /* 관문 배경은 마을 지도. renderVillage() 는 JSON 로딩이 끝나야 도는데 관문은 그 전에
     떠 있으므로 여기서 먼저 변수를 채운다. */
  document.documentElement.style.setProperty("--village-img", `url("${villageImgUrl()}")`);

  /* 접속할 때마다 묻는다 — 통과 상태를 저장하지 않고, 예전 버전이 남긴 키는 지운다. */
  try { localStorage.removeItem(GATE_STALE_KEY); } catch { /* 사생활 모드 등 */ }
  gate.hidden = false;
  /* 리스너는 **한 번만** 건다. 두 번 걸리면 제출 한 번에 async 핸들러가 두 벌 돌고,
     늦게 끝난 쪽이 뒤늦게 gate.hidden 을 덮어써 판정이 뒤집힌다(테스트에서 실측).
     지금은 boot() 이 한 번만 부르지만, 재초기화 경로가 생기면 그대로 재현된다. */
  const form = $("#gate-form");
  if (form.dataset && form.dataset.bound === "1") return;
  if (form.dataset) form.dataset.bound = "1";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = gateNormalize($("#gate-pw").value);
    let ok = false;
    try {
      ok = (await sha256Hex(val)) === GATE_SHA256;
    } catch {
      /* crypto.subtle 은 보안 컨텍스트(https·localhost)에서만 산다. 없으면 **열지 않는다** —
         조용히 통과시키면 관문이 있다는 표시만 남고 실제로는 없는 상태가 된다. */
      $("#gate-err").textContent = "이 브라우저에서는 암구호를 확인할 수 없습니다 (https 로 접속하십시오).";
      $("#gate-err").hidden = false;
      return;
    }
    if (ok) {
      gate.hidden = true;
      /* 관문이 떠 있는 동안은 sceneCycleAllowed() ③ 이 막고 있었다.
         통과한 지금이 자동 순환의 실제 시작점이다 — routeView 는 이미 지나갔다. */
      restartSceneCycle();
    } else {
      /* 앞선 시도가 crypto 오류 문구를 남겼을 수 있다 — 매번 제자리로 되돌린다. */
      $("#gate-err").textContent = "암구호가 다릅니다.";
      $("#gate-err").hidden = false;
      $("#gate-pw").select();
    }
  });
}

function handleHash() {
  routeView();
  if (location.hash === "#hedge-sim") {
    if (DATA.hedge) openHedgeSim();
    return;
  }
  const am = location.hash.match(/^#alloc-(.+)$/);
  if (am) {
    if (DATA.alloc) openAllocDetail(decodeURIComponent(am[1]));
    return;
  }
  const m = location.hash.match(/^#detail-(.+)$/);
  if (m && DATA.risk) openDetail(decodeURIComponent(m[1]));
  else hideDetail();
}

/* ---------------- 통계 엔진 (관계분석) ---------------- */

function statMean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }

function pairwise(x, y) {
  const ax = [], ay = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] == null || y[i] == null || !isFinite(x[i]) || !isFinite(y[i])) continue;
    ax.push(x[i]); ay.push(y[i]);
  }
  return [ax, ay];
}

function pearson(x, y) {
  const [a, b] = pairwise(x, y);
  const n = a.length;
  if (n < 10) return { r: null, n };
  const ma = statMean(a), mb = statMean(b);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - ma, dy = b[i] - mb;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const d = Math.sqrt(sxx * syy);
  return { r: d > 0 ? sxy / d : null, n };
}

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(x, y) {
  const [a, b] = pairwise(x, y);
  if (a.length < 10) return { r: null, n: a.length };
  return { r: pearson(ranks(a), ranks(b)).r, n: a.length };
}

/* corr(x_{t-k}, y_t): k>0 이면 x가 y를 k기 선행 */
function crossCorr(x, y, maxLag) {
  const out = [];
  for (let k = -maxLag; k <= maxLag; k++) {
    const xs = [], ys = [];
    for (let t = 0; t < y.length; t++) {
      const s = t - k;
      if (s < 0 || s >= x.length) continue;
      xs.push(x[s]); ys.push(y[t]);
    }
    const { r, n } = pearson(xs, ys);
    out.push({ k, r, n });
  }
  return out;
}

/* --- 선형대수 --- */
function matSolve(A, b) {           // 가우스-조던 (k×k, k ≤ 8)
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c];
    for (let j = c; j <= n; j++) M[c][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

function matInv(A) {
  const n = A.length;
  const inv = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1;
    const col = matSolve(A, e);
    if (!col) return null;
    inv.push(col);
  }
  // inv[j] = j번째 열 → 전치
  return inv[0].map((_, i) => inv.map((col) => col[i]));
}

function erf(z) {                   // Abramowitz-Stegun 7.1.26 (|오차| < 1.5e-7)
  const s = z < 0 ? -1 : 1;
  z = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-z * z));
}
const pValue = (t) => 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));

/* 표준정규 분위수 (Acklam 근사) — 다중검정 보정 임계값 산출용 */
function normInv(p) {
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2,
             1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2,
             6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
         / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
         / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
        / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/* OLS + Newey-West HAC 표준오차. X는 상수항 제외한 열 배열 */
function ols(y, Xcols, hacLag) {
  const k = Xcols.length + 1;
  const rows = [];
  for (let i = 0; i < y.length; i++) {
    if (y[i] == null || !isFinite(y[i])) continue;
    const xr = [1];
    let ok = true;
    for (const c of Xcols) {
      const v = c[i];
      if (v == null || !isFinite(v)) { ok = false; break; }
      xr.push(v);
    }
    if (ok) rows.push({ x: xr, y: y[i] });
  }
  const n = rows.length;
  if (n < k + 10) return { error: `표본 부족 (n=${n})` };
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (const { x, y: yy } of rows) {
    for (let a = 0; a < k; a++) {
      Xty[a] += x[a] * yy;
      for (let b = 0; b < k; b++) XtX[a][b] += x[a] * x[b];
    }
  }
  const beta = matSolve(XtX.map((r) => [...r]), [...Xty]);
  if (!beta) return { error: "설명변수가 서로 중복(공선성)되어 추정할 수 없습니다" };
  const u = rows.map(({ x, y: yy }) => yy - x.reduce((s, v, j) => s + v * beta[j], 0));
  const my = statMean(rows.map((r) => r.y));
  let ssr = 0, sst = 0;
  rows.forEach((r, i) => { ssr += u[i] * u[i]; sst += (r.y - my) ** 2; });
  const r2 = sst > 0 ? 1 - ssr / sst : null;
  const adj = r2 == null ? null : 1 - (1 - r2) * (n - 1) / (n - k);

  const L = Math.max(0, Math.min(hacLag, n - 2));
  const S = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let t = 0; t < n; t++) {
    const x = rows[t].x, w = u[t] * u[t];
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a][b] += w * x[a] * x[b];
  }
  for (let l = 1; l <= L; l++) {
    const wl = 1 - l / (L + 1);
    for (let t = l; t < n; t++) {
      const x = rows[t].x, xl = rows[t - l].x, uu = u[t] * u[t - l];
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) S[a][b] += wl * uu * (x[a] * xl[b] + xl[a] * x[b]);
      }
    }
  }
  const XtXinv = matInv(XtX);
  if (!XtXinv) return { error: "행렬 역산 실패" };
  const V = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) s += XtXinv[a][i] * S[i][j] * XtXinv[j][b];
      V[a][b] = s;
    }
  }
  const se = V.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
  const coef = beta.map((b, i) => ({
    b, se: se[i], t: se[i] > 0 ? b / se[i] : null,
    p: se[i] > 0 ? pValue(b / se[i]) : null,
  }));
  return { coef, n, k, r2, adj, hacLag: L };
}

/* ---------------- 관계분석 화면 ---------------- */

const pnl = {
  risk: "stress", freq: "W", mode: "diff", years: 0,
  vars: null, tab: "corr", maxLag: 26,
  dep: null, regMode: "sync", h: 4, regressors: null,
};

function pnlVarMap() {
  return Object.fromEntries(DATA.panel.vars.map((v) => [v.id, v]));
}

/* 현재 설정의 정렬된 표본: {t, risk:{key:[...]}, vars:{id:[...]}} (수준값) */
function pnlSample() {
  const P = DATA.panel;
  let idx = P.t.map((_, i) => i);
  if (pnl.freq === "M") {
    const keep = [];
    for (let i = 0; i < P.t.length; i++) {
      const cur = new Date(P.t[i] * 1000).getUTCMonth();
      const nxt = i + 1 < P.t.length ? new Date(P.t[i + 1] * 1000).getUTCMonth() : -1;
      if (cur !== nxt) keep.push(i);
    }
    idx = keep;
  }
  if (pnl.years > 0) {
    const cut = P.t[P.t.length - 1] - pnl.years * 31557600;
    idx = idx.filter((i) => P.t[i] >= cut);
  }
  return {
    t: idx.map((i) => P.t[i]),
    pick: (arr) => idx.map((i) => (arr && arr[i] != null ? arr[i] : null)),
  };
}

function transformVals(vals, kind, mode) {
  if (mode === "level") return vals.slice();
  const out = new Array(vals.length).fill(null);
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if (a == null || b == null) continue;
    out[i] = kind === "price" ? (a !== 0 ? (b / a - 1) * 100 : null)
           : kind === "rate" ? (b - a) * 100 : b - a;
  }
  return out;
}

function forwardChange(vals, kind, h) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i + h < vals.length; i++) {
    const a = vals[i], b = vals[i + h];
    if (a == null || b == null) continue;
    out[i] = kind === "price" ? (a !== 0 ? (b / a - 1) * 100 : null)
           : kind === "rate" ? (b - a) * 100 : b - a;
  }
  return out;
}

const UNIT_OF = (v) => v.kind === "price" ? "%" : v.kind === "rate" ? "bp" : "pt";
const FREQ_LABEL = () => (pnl.freq === "W" ? "주" : "개월");

function pnlSeries(sample, id) {
  const P = DATA.panel;
  if (P.risk[id]) return { vals: sample.pick(P.risk[id]), kind: "score", name: (P.risk_meta.find((m) => m.key === id) || {}).name || id, unit: "점" };
  const v = pnlVarMap()[id];
  if (!v) return null;
  return { vals: sample.pick(v.v), kind: v.kind, name: v.name, unit: UNIT_OF(v) };
}

function renderPanelControls() {
  const P = DATA.panel;
  const c = $("#pnl-controls");
  c.textContent = "";
  const sel = (label, opts, cur, onchange) => {
    const s = el("select", { onchange: (e) => onchange(e.target.value) });
    opts.forEach(([v, t]) => {
      const o = el("option", { value: v }, t);
      if (String(v) === String(cur)) o.selected = true;
      s.append(o);
    });
    return el("div", { class: "grp" }, el("b", {}, label), s);
  };
  c.append(sel("위험지표", P.risk_meta.map((m) => [m.key, m.name]), pnl.risk,
    (v) => { pnl.risk = v; renderPanelBody(); }));
  c.append(sel("빈도", [["W", "주간"], ["M", "월간"]], pnl.freq,
    (v) => { pnl.freq = v; pnl.maxLag = v === "W" ? 26 : 12; renderPanelBody(); }));
  c.append(sel("분석 기준", [["diff", "변화 (권장)"], ["level", "수준"]], pnl.mode,
    (v) => { pnl.mode = v; renderPanelBody(); }));
  c.append(sel("기간", [[0, "전체"], [10, "최근 10년"], [5, "최근 5년"], [3, "최근 3년"]], pnl.years,
    (v) => { pnl.years = +v; renderPanelBody(); }));
}

function renderPanelVars() {
  const P = DATA.panel;
  const vmap = pnlVarMap();
  const wrap = $("#pnl-vars");
  wrap.textContent = "";
  const pal = palette();
  pnl.vars.forEach((id, i) => {
    const v = vmap[id];
    if (!v) return;
    const chip = el("span", { class: "vchip" });
    chip.append(el("i", { style: `background:${pal.series[i % 8]}` }), v.name);
    chip.append(el("button", {
      title: "제외", onclick: () => {
        pnl.vars = pnl.vars.filter((x) => x !== id);
        if (pnl.dep === id) pnl.dep = pnl.vars[0] || null;
        pnl.regressors = null;
        renderPanelVars(); renderPanelBody();
      },
    }, "×"));
    wrap.append(chip);
  });
  const det = el("details", { class: "vadd" });
  det.append(el("summary", {}, "＋ 변수 추가"));
  const pick = el("div", { class: "vpick" });
  const groups = [...new Set(P.vars.map((v) => v.group))];
  groups.forEach((gname) => {
    pick.append(el("h4", {}, gname));
    P.vars.filter((v) => v.group === gname).forEach((v) => {
      const lb = el("label", {});
      const cb = el("input", { type: "checkbox" });
      cb.checked = pnl.vars.includes(v.id);
      cb.addEventListener("change", () => {
        if (cb.checked) { if (!pnl.vars.includes(v.id)) pnl.vars.push(v.id); }
        else pnl.vars = pnl.vars.filter((x) => x !== v.id);
        pnl.regressors = null;
        if (!pnl.vars.includes(pnl.dep)) pnl.dep = pnl.vars[0] || null;
        renderPanelVars(); renderPanelBody();
        det.open = true;
      });
      lb.append(cb, `${v.name} `, el("span", { style: "color:var(--ink-3);font-size:11px" }, `(${v.first}~)`));
      pick.append(lb);
    });
  });
  det.append(pick);
  wrap.append(det);
}

function renderPanelTabs() {
  const t = $("#pnl-tabs");
  t.textContent = "";
  [["corr", "상관"], ["lead", "선행·후행"], ["reg", "회귀"]].forEach(([k, label]) => {
    t.append(el("button", { class: pnl.tab === k ? "active" : "",
      onclick: () => { pnl.tab = k; renderPanelTabs(); renderPanelBody(); } }, label));
  });
}

function corrBar(r) {
  const box = el("div", { class: "corrbar" });
  box.append(el("u", {}));
  if (r != null) {
    const w = Math.abs(r) * 50;
    const left = r >= 0 ? 50 : 50 - w;
    box.append(el("i", { style: `left:${left}%;width:${w}%;background:${r >= 0 ? "var(--up)" : "var(--down)"}` }));
  }
  return box;
}

function renderPanelBody() {
  const body = $("#pnl-body");
  body.textContent = "";
  overlayCharts.filter((e) => e.panel).forEach(destroyChart);
  const P = DATA.panel;
  const sample = pnlSample();
  const risk = pnlSeries(sample, pnl.risk);
  const rvals = transformVals(risk.vals, "score", pnl.mode);
  const pal = palette();
  const modeLabel = pnl.mode === "diff" ? "변화" : "수준";

  if (pnl.tab === "corr") {
    const rows = pnl.vars.map((id, i) => {
      const v = pnlSeries(sample, id);
      const vv = transformVals(v.vals, v.kind, pnl.mode);
      const p = pearson(rvals, vv), s = spearman(rvals, vv);
      return { id, name: v.name, unit: v.unit, p, s, color: pal.series[i % 8] };
    });
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, `${risk.name}와의 동행 상관`),
      el("span", { class: "card-sub" },
        `${modeLabel} 기준 · ${pnl.freq === "W" ? "주간" : "월간"} · ${pnl.years ? `최근 ${pnl.years}년` : "전체 기간"}`)));
    const tbl = el("table", { class: "mini-table" },
      el("tr", {}, ...["변수", "상관계수(Pearson)", "순위상관(Spearman)", "표본 n", ""].map((h, i) =>
        el("th", { style: i === 0 || i === 4 ? "text-align:left" : "" }, h))));
    rows.sort((a, b) => Math.abs((b.p.r ?? 0)) - Math.abs((a.p.r ?? 0)));
    rows.forEach((r) => {
      tbl.append(el("tr", {},
        el("td", {}, el("span", { style: `display:inline-block;width:9px;height:9px;border-radius:50%;background:${r.color};margin-right:7px` }), r.name),
        el("td", { class: "num" }, r.p.r == null ? "–" : fmtNum(r.p.r, 2)),
        el("td", { class: "num" }, r.s.r == null ? "–" : fmtNum(r.s.r, 2)),
        el("td", { class: "num" }, String(r.p.n)),
        el("td", {}, corrBar(r.p.r))));
    });
    card.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tbl));
    body.append(card);

    const top = rows[0];
    if (top && top.p.r != null) {
      body.append(el("div", { class: "pnl-note" },
        el("b", {}, "읽기"),
        ` — 가장 강한 동행 관계는 ${top.name}(${fmtNum(top.p.r, 2)})입니다.`,
        explainBox("pnl-corr-read",
          "양수면 위험지표가 오를 때 그 변수도 같이 오르는 관계, 음수면 반대입니다. ",
          "여기 상관은 ", el("b", {}, "같은 시점"), "의 관계만 봅니다 — 어느 쪽이 먼저 움직이는지는 '선행·후행' 탭에서 확인하세요.")));
    }
    if (pnl.mode === "level") {
      body.append(el("div", { class: "warnbox" },
        el("b", {}, "주의"),
        " — '수준' 기준 상관은 두 시계열이 각자 추세를 갖기만 해도 높게 나오는 허구적 상관일 수 있습니다. 판단은 '변화' 기준을 우선하세요."));
    }
  }

  if (pnl.tab === "lead") {
    const maxLag = pnl.maxLag;
    const defs = [];
    const summary = [];
    pnl.vars.forEach((id, i) => {
      const v = pnlSeries(sample, id);
      const vv = transformVals(v.vals, v.kind, pnl.mode);
      const cc = crossCorr(rvals, vv, maxLag);
      defs.push({ label: v.name, color: pal.series[i % 8],
                  x: cc.map((d) => d.k), v: cc.map((d) => d.r) });
      let best = null;
      cc.forEach((d) => { if (d.r != null && (!best || Math.abs(d.r) > Math.abs(best.r))) best = d; });
      const n0 = (cc.find((d) => d.k === 0) || {}).n || 0;
      summary.push({ name: v.name, best, n0, color: pal.series[i % 8] });
    });
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, `교차상관 — ${risk.name}가 선행하는가`),
      el("span", { class: "card-sub" },
        `가로축 = 시차(${FREQ_LABEL()}) · 오른쪽(양수)에서 최대면 위험지표가 선행 · ${modeLabel} 기준`)));
    const box = el("div", { class: "chart-box" });
    card.append(box);
    body.append(card);
    const n0 = summary[0] ? summary[0].n0 : 0;
    const band = n0 > 0 ? 1.96 / Math.sqrt(n0) : null;
    // 시차 53개 중 최대값을 고르는 구조이므로 단일시차 임계값을 그대로 쓰면
    // 우연한 최대치가 '유의'로 오판된다 — 본페로니 보정 임계값을 병기한다.
    const nLags = 2 * maxLag + 1;
    const bandPeak = n0 > 0 ? normInv(1 - 0.025 / nLags) / Math.sqrt(n0) : null;
    const entry = makeRatioChart(box, {
      seriesDefs: defs, height: 300, unit: "", xLabel: `시차 (${FREQ_LABEL()})`,
      xRange: [-maxLag, maxLag], yRange: [-1, 1], band, zeroLine: true,
    });
    entry.panel = true;

    const tbl = el("table", { class: "mini-table" },
      el("tr", {}, ...["변수", "최대 상관 시차", "그때 상관계수", "해석"].map((h, i) =>
        el("th", { style: i === 0 || i === 3 ? "text-align:left" : "" }, h))));
    summary.forEach((s) => {
      const k = s.best ? s.best.k : null;
      const interp = k == null ? "–"
        : k > 0 ? `위험지표가 ${k}${FREQ_LABEL()} 선행`
        : k < 0 ? `위험지표가 ${-k}${FREQ_LABEL()} 후행`
        : "동행 (시차 없음)";
      const sig = s.best && bandPeak && Math.abs(s.best.r) > bandPeak;
      tbl.append(el("tr", {},
        el("td", {}, el("span", { style: `display:inline-block;width:9px;height:9px;border-radius:50%;background:${s.color};margin-right:7px` }), s.name),
        el("td", { class: "num" }, k == null ? "–" : `${k > 0 ? "+" : ""}${k}`),
        el("td", { class: "num" }, s.best && s.best.r != null ? fmtNum(s.best.r, 2) : "–"),
        el("td", {}, interp,
          sig ? el("span", { class: "stars" }, " ✓유의")
              : el("span", { style: "color:var(--ink-3)" }, " (우연과 구별 안 됨)"))));
    });
    body.append(el("div", { class: "card", style: "margin-top:14px" },
      el("div", { class: "card-head" }, el("span", { class: "card-title" }, "최대 상관 시차 요약")),
      el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tbl)));
    body.append(explainBox("pnl-lead-read", { label: "읽는 법" },
      ` corr(위험지표_{t−k}, 변수_t)를 k = −${maxLag}~+${maxLag}${FREQ_LABEL()}에서 계산합니다. `,
      "최대 상관이 ", el("b", {}, "양(+)의 시차"), "에서 나오면 위험지표가 그만큼 먼저 움직인 것(선행), ",
      el("b", {}, "음(−)의 시차"), "면 뒤따라 움직인 것(후행)입니다. 차트의 점선은 ",
      el("b", {}, "단일 시차"), ` 기준 95% 신뢰구간(±${band ? fmtNum(band, 2) : "–"})입니다. `,
      "다만 표의 '최대 상관'은 ", el("b", {}, `시차 ${nLags}개 중 가장 큰 값을 고른 것`),
      `이라 우연히 커지기 쉬워, ✓유의 판정에는 다중검정을 보정한 더 엄격한 임계값(±${bandPeak ? fmtNum(bandPeak, 2) : "–"})을 적용했습니다.`));
  }

  if (pnl.tab === "reg") renderRegression(body, sample, risk, rvals);

  const mth = $("#pnl-method");
  mth.textContent = "";
  mth.append(el("summary", {}, "산식 · 통계 처리 · 한계 (방법론)"));
  mth.append(el("p", {}, el("b", {}, "변환"), ` — ${P.method.transform}`));
  mth.append(el("p", {}, el("b", {}, "선행·후행"), ` — ${P.method.leadlag}`));
  mth.append(el("p", {}, el("b", {}, "회귀"), ` — ${P.method.regression}`));
  mth.append(el("p", {}, el("b", {}, "한계"),
    " — 상관·회귀는 관계의 크기를 재는 도구이지 인과관계의 증거가 아닙니다. 표본 내 적합도이며, "
    + "구조 변화(레짐 전환)가 있으면 기간별로 결과가 크게 달라질 수 있으니 기간 필터로 안정성을 확인하세요. "
    + "변수를 늘릴수록 우연히 유의해 보이는 관계가 생깁니다(다중검정)."));
}

function renderRegression(body, sample, risk, rvals) {
  const P = DATA.panel;
  const vmap = pnlVarMap();
  if (!pnl.dep || !pnl.vars.includes(pnl.dep)) pnl.dep = pnl.vars[0] || null;
  if (!pnl.regressors) pnl.regressors = [pnl.risk];

  const ctl = el("div", { class: "pnl-controls" });
  const mkSel = (label, opts, cur, on) => {
    const s = el("select", { onchange: (e) => on(e.target.value) });
    opts.forEach(([v, t]) => {
      const o = el("option", { value: v }, t);
      if (String(v) === String(cur)) o.selected = true;
      s.append(o);
    });
    return el("div", { class: "grp" }, el("b", {}, label), s);
  };
  ctl.append(mkSel("종속변수", pnl.vars.map((id) => [id, vmap[id] ? vmap[id].name : id]), pnl.dep,
    (v) => { pnl.dep = v; renderPanelBody(); }));
  ctl.append(mkSel("모형", [["sync", "동행 (같은 시점)"], ["pred", "예측 (h기 후 변화)"]], pnl.regMode,
    (v) => { pnl.regMode = v; renderPanelBody(); }));
  if (pnl.regMode === "pred") {
    const inp = el("input", { type: "number", min: "1", max: "52", value: String(pnl.h) });
    inp.addEventListener("change", () => {
      pnl.h = Math.max(1, Math.min(52, +inp.value || 4));
      renderPanelBody();
    });
    ctl.append(el("div", { class: "grp" }, el("b", {}, "예측 지평 h"), inp, `${FREQ_LABEL()} 후`));
  }
  body.append(ctl);

  // 설명변수 선택 (위험지표들 + 선택된 시장변수)
  const pickWrap = el("div", { class: "pnl-vars" });
  pickWrap.append(el("span", { style: "font-size:12.5px;color:var(--ink-2);font-weight:600" }, "설명변수"));
  const cand = [...P.risk_meta.map((m) => ({ id: m.key, name: m.name, isRisk: true })),
                ...pnl.vars.filter((id) => id !== pnl.dep).map((id) => ({ id, name: vmap[id].name, isRisk: false }))];
  cand.forEach((c) => {
    const on = pnl.regressors.includes(c.id);
    pickWrap.append(el("button", {
      type: "button", "aria-pressed": on ? "true" : "false",
      class: "vchip", style: on ? "border-color:var(--accent-ink);color:var(--ink-1)" : "opacity:.6;cursor:pointer",
      onclick: () => {
        pnl.regressors = on ? pnl.regressors.filter((x) => x !== c.id) : [...pnl.regressors, c.id];
        renderPanelBody();
      },
    }, (on ? "✓ " : "+ ") + c.name));
  });
  body.append(pickWrap);

  if (!pnl.dep) { body.append(el("div", { class: "chart-empty" }, "변수를 하나 이상 선택하세요.")); return; }
  if (!pnl.regressors.length) { body.append(el("div", { class: "chart-empty" }, "설명변수를 하나 이상 선택하세요.")); return; }

  const depV = pnlSeries(sample, pnl.dep);
  const h = pnl.h;
  const y = pnl.regMode === "pred"
    ? forwardChange(depV.vals, depV.kind, h)
    : transformVals(depV.vals, depV.kind, "diff");

  const names = [], forms = [], Xcols = [];
  pnl.regressors.forEach((id) => {
    const s = pnlSeries(sample, id);
    if (!s) return;
    const isRisk = !!P.risk[id];
    const useLevel = pnl.regMode === "pred" && isRisk;
    Xcols.push(transformVals(s.vals, s.kind, useLevel ? "level" : "diff"));
    names.push(s.name);
    forms.push(useLevel ? "수준(점)" : (isRisk ? "Δ점" : `Δ${s.unit}`));
  });

  const hacLag = pnl.regMode === "pred" ? Math.max(h - 1, Math.floor(4 * Math.pow(y.filter((v) => v != null).length / 100, 2 / 9)))
                                        : Math.floor(4 * Math.pow(y.filter((v) => v != null).length / 100, 2 / 9));
  const res = ols(y, Xcols, hacLag);

  const card = el("div", { class: "card", style: "margin-top:4px" });
  const depLabel = pnl.regMode === "pred"
    ? `${depV.name}의 향후 ${h}${FREQ_LABEL()} 변화 (${depV.unit})`
    : `${depV.name} 변화 (${depV.unit})`;
  card.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, `회귀: ${depLabel}`),
    el("span", { class: "card-sub" },
      `${pnl.freq === "W" ? "주간" : "월간"} · ${pnl.years ? `최근 ${pnl.years}년` : "전체 기간"} · Newey-West HAC 표준오차`)));
  if (res.error) {
    card.append(el("div", { class: "chart-empty" }, res.error));
    body.append(card);
    return;
  }
  const tbl = el("table", { class: "mini-table regtable" },
    el("tr", {}, ...["설명변수", "형태", "계수 β", "표준오차", "t값", "p값", ""].map((hh, i) =>
      el("th", { style: i <= 1 || i === 6 ? "text-align:left" : "" }, hh))));
  res.coef.forEach((c, i) => {
    const isConst = i === 0;
    const star = c.p == null ? "" : c.p < 0.01 ? "***" : c.p < 0.05 ? "**" : c.p < 0.1 ? "*" : "";
    tbl.append(el("tr", {},
      el("td", {}, isConst ? "상수항" : names[i - 1]),
      el("td", { style: "color:var(--ink-3);font-size:11.5px" }, isConst ? "" : forms[i - 1]),
      el("td", { class: "num sig" }, fmtNum(c.b, Math.abs(c.b) < 1 ? 4 : 3)),
      el("td", { class: "num" }, fmtNum(c.se, Math.abs(c.se) < 1 ? 4 : 3)),
      el("td", { class: "num" }, c.t == null ? "–" : fmtNum(c.t, 2)),
      el("td", { class: "num" }, c.p == null ? "–" : (c.p < 0.001 ? "<0.001" : fmtNum(c.p, 3))),
      el("td", { class: "stars" }, star)));
  });
  card.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tbl));
  card.append(el("div", { class: "card-sub", style: "margin-top:8px" },
    `R² ${fmtNum(res.r2 * 100, 1)}% · 조정 R² ${fmtNum(res.adj * 100, 1)}% · 표본 n=${res.n} · HAC 시차 ${res.hacLag} · 유의수준 *** 1% ** 5% * 10%`));
  body.append(card);

  const main = res.coef[1];
  if (main) {
    const unit = forms[0] === "수준(점)" ? "위험지표 1점 상승" : "위험지표 1점 변화";
    const dir = main.b >= 0 ? "상승" : "하락";
    body.append(el("div", { class: "pnl-note" },
      el("b", {}, "읽기"),
      ` — ${unit} 시 ${depLabel}가 평균 ${fmtNum(Math.abs(main.b), 3)}${depV.unit} ${dir}하는 관계입니다`,
      main.p != null && main.p < 0.05
        ? " (통계적으로 유의). "
        : " (다만 통계적으로 유의하지 않아 우연과 구별되지 않습니다). ",
      `이 모형이 ${depLabel}의 변동 중 설명하는 비중은 ${fmtNum(res.r2 * 100, 1)}%입니다.`));
  }
  if (pnl.regMode === "pred") {
    body.append(el("div", { class: "warnbox" },
      el("b", {}, "중첩 표본 주의"),
      ` — 향후 ${h}${FREQ_LABEL()} 변화는 이웃한 관측끼리 구간이 겹칩니다. 표준오차는 이를 보정한 Newey-West HAC(시차 ${res.hacLag})를 사용했지만, `,
      "그래도 유의성은 보수적으로 해석하는 것이 안전합니다."));
  }
}

function renderPanel() {
  if (!$("#panel")) return;
  const P = DATA.panel;
  if (!P || !P.vars) {
    $("#pnl-headline").textContent = "관계분석 데이터를 불러오지 못했습니다.";
    return;
  }
  if (!pnl.vars) pnl.vars = [...P.defaults];
  const hl = $("#pnl-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문"));
  hl.append(el("div", { class: "a" }, "내 위험지표는 시장 변수와 어떤 관계인가 — 그리고 먼저 움직이는가 ",
    el("small", {}, `주간 ${P.n_weeks}주 패널 · 상관 → 선행·후행 → 회귀 순으로 확인`)));
  renderPanelControls();
  renderPanelVars();
  renderPanelTabs();
  renderPanelBody();
}

/* ---------------- 환헤지 ---------------- */

/* 헤지비용의 이름과 부호는 **파이프라인이 정한다** — 화면이 새 이름을 만들지 않는다.
   `pipeline/hedge.py` 는 이 양을 `cost_curve`/`cost_12m` 으로 담고 문서·`limits` 문자열에서
   일관되게 「헤지비용」이라 부른다(`alloc.py` 도 같다). 부호는 산식이 정한다: 시뮬레이터의
   캐리가 `A × h × cost` 이고 회계모형 ④(스왑레이트 캐리)·백테스트의 `+ h × f` 가 같은
   부호이므로 **양수 = 받음 / 음수 = 지불**이다.
   그래서 이름은 「헤지비용」으로 두되 방향을 색이 아니라 **글자**로 적는다 —
   색만으로는 방향을 전달할 수 없고(WCAG 1.4.1), 무엇보다 "헤지비용 −0.92%" 는
   "비용이 마이너스니 이득"으로 정반대로 읽힌다.
   dir=false 면 숫자만 (좁은 자리·이미 열 제목에 열쇠가 있는 자리용). */
const COST_SIGN_KEY = "＋받음 −지불";

function fmtCost(x, dir = false) {
  if (x == null) return el("span", { class: "d-flat" }, "—");
  const n = el("span", { class: x < 0 ? "neg" : "pos" }, `${x > 0 ? "+" : ""}${fmtNum(x, 2)}%`);
  if (!dir || x === 0) return n;
  /* 앞의 공백은 장식이 아니다 — 없으면 화면낭독기가 "마이너스 0.92퍼센트지불" 로 붙여 읽는다. */
  return el("span", {}, n, el("small", { class: "cost-dir" }, ` ${x > 0 ? "받음" : "지불"}`));
}

/* 표를 감싸고, 가로로 넘치면 넘친다는 사실을 글자로 알린다.
   좁은 화면에서 열이 잘리는데 스크롤 막대가 보이지 않으면 그 열은 **도달 불가**다
   (390px 실측으로 확인한 자리). 넘칠 때만 힌트를 붙인다. */
function wrapTable(t, hint = "옆으로 밀면 나머지 열이 나옵니다") {
  const w = el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t);
  const note = el("div", { class: "scroll-hint", hidden: "" }, `→ ${hint}`);
  const box = el("div", {}, w, note);
  const check = () => {
    const over = w.scrollWidth > w.clientWidth + 1;
    w.classList.toggle("is-scrollable", over);
    if (over) note.removeAttribute("hidden"); else note.setAttribute("hidden", "");
  };
  /* 레이아웃이 끝난 뒤에 재야 한다. rAF 가 없는 환경(테스트 셰이드)에서는 즉시 잰다. */
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(check); else check();
  if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(check); ro.observe(w); }
  return box;
}

/* 숫자 x축 차트 (헤지비율 곡선 · 교차상관 등) */
function makeRatioChart(box, opts) {
  const { seriesDefs, height = 280, unit = "%", xLabel = "헤지비율",
          xRange = [0, 100], yRange = null, band = null, zeroLine = false,
          xSuffix = xLabel === "헤지비율" ? "%" : "" } = opts;
  const pal = palette();
  const xs = seriesDefs[0].x;
  const series = [{ label: xLabel, value: (u, v) => v == null ? "–" : v + xSuffix }];
  seriesDefs.forEach((sd) => series.push({
    label: sd.label, stroke: sd.color, width: 2.5, spanGaps: true,
    points: { show: false },
    value: (u, v) => v == null ? "–" : fmtNum(v, unit === "" ? 2 : 1) + unit,
  }));
  const cfg = {
    width: Math.max(280, box.clientWidth), height,
    cursor: { points: { size: 8 }, y: false },
    scales: { x: { time: false, range: xRange } },
    series,
    axes: [
      { stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
        ticks: { show: false }, values: (u2, vals) => vals.map((v) => v + xSuffix) },
      baseAxes(pal, (v) => fmtNum(v, unit === "" ? 1 : 0) + unit,
                    (v, extra) => fmtNum(v, (unit === "" ? 1 : 0) + extra) + unit)[1],
    ],
    legend: { live: true },
  };
  if (yRange) cfg.scales.y = { range: () => yRange };
  if (band != null || zeroLine) {
    cfg.hooks = { drawClear: [(u) => {
      const { ctx, bbox } = u;
      ctx.save();
      if (zeroLine) {
        const y0 = u.valToPos(0, "y", true), x0 = u.valToPos(0, "x", true);
        ctx.strokeStyle = pal.baseline; ctx.lineWidth = 1 * devicePixelRatio;
        ctx.beginPath(); ctx.moveTo(bbox.left, y0); ctx.lineTo(bbox.left + bbox.width, y0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, bbox.top); ctx.lineTo(x0, bbox.top + bbox.height); ctx.stroke();
      }
      if (band != null) {
        ctx.strokeStyle = pal.ink3; ctx.lineWidth = 1 * devicePixelRatio;
        ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
        [band, -band].forEach((b) => {
          const yy = u.valToPos(b, "y", true);
          ctx.beginPath(); ctx.moveTo(bbox.left, yy); ctx.lineTo(bbox.left + bbox.width, yy); ctx.stroke();
        });
        ctx.setLineDash([]);
      }
      ctx.restore();
    }] };
  }
  /* 점 마커 — 효율적 투자선 위의 「기준 × · 조정 ▲ · 참고치 ●」 처럼, 선이 아니라
     **한 점**인 상태를 라벨과 함께 그린다. 시리즈로 넣지 않는 이유: uPlot 은 x 배열이
     공유라 선 밖 임의 좌표를 못 받는다 — draw 훅에서 좌표 변환으로 직접 찍는다. */
  if (opts.onCursor) {
    cfg.hooks = cfg.hooks || {};
    (cfg.hooks.setCursor = cfg.hooks.setCursor || []).push(
      (u) => opts.onCursor(u.cursor ? u.cursor.idx : null));
  }
  if (opts.markers && opts.markers.length) {
    cfg.hooks = cfg.hooks || {};
    (cfg.hooks.draw = cfg.hooks.draw || []).push((u) => {
      const { ctx } = u;
      const dpr = devicePixelRatio || 1;
      ctx.save();
      ctx.font = `${11 * dpr}px sans-serif`;
      opts.markers.forEach((m) => {
        const px = u.valToPos(m.x, "x", true), py = u.valToPos(m.y, "y", true);
        if (!isFinite(px) || !isFinite(py)) return;
        ctx.strokeStyle = m.color || pal.ink;
        ctx.fillStyle = m.color || pal.ink;
        ctx.lineWidth = 2 * dpr;
        const r = 5 * dpr;
        ctx.beginPath();
        if (m.kind === "x") {
          ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r);
          ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r);
          ctx.stroke();
        } else if (m.kind === "tri") {
          ctx.moveTo(px, py - r); ctx.lineTo(px + r, py + r); ctx.lineTo(px - r, py + r);
          ctx.closePath(); ctx.fill();
        } else {
          ctx.arc(px, py, r * 0.8, 0, Math.PI * 2); ctx.fill();
        }
        if (m.label) ctx.fillText(m.label, px + r + 3 * dpr, py + 4 * dpr);
      });
      ctx.restore();
    });
  }
  const u = new uPlot(cfg, [xs, ...seriesDefs.map((sd) => sd.v)], box);
  const ro = new ResizeObserver(() => u.setSize({ width: Math.max(280, box.clientWidth), height }));
  ro.observe(box);
  return trackChart(u, ro);
}

/* 매트릭스 표본 칸. 변동성 표본과 적합(MVH·상관) 표본이 다른 행에는 **둘 다** 적는다 —
   같으면 한 줄로 줄인다. 뭉뚱그려 한 구간만 적으면 "같은 표본"으로 읽힌다. */
function sampleTxt(sample) {
  if (!sample) return "—";
  const f = (x) => (x ? `${x.start}~${x.end} (${x.n})` : null);
  const vol = f(sample.vol), fit = f(sample.fit);
  if (!vol) return "—";
  if (!fit) return `변동성 ${vol}`;
  if (vol === fit) return vol;
  return el("span", {}, `변동성 ${vol}`, el("br"), `MVH·상관 ${fit}`);
}

function renderHedge() {
  const H2 = DATA.hedge;
  if (!$("#hedge")) return;
  if (!H2 || !H2.matrix) {
    $("#hedge-headline").textContent = "환헤지 데이터를 불러오지 못했습니다.";
    return;
  }
  const pal = palette();

  /* 화면에 뜨는 참고치는 **전부 hedge.json 에서 계산해** 뽑는다.
     예전에는 헤드라인에 "경제 관점: 채권 88~102% · 주식 10~30%" 가 문자열로 박혀 있었다.
     ① 88~102 는 마침 현재 MVH 의 최소~최대와 같았지만 데이터가 움직이면 화면만 조용히
     틀린다. ② "주식 10~30%" 의 10 은 **어느 산식에서도 나오지 않는 수**였다 — 실측한
     curves.equity 는 30% 지점이 최소(13.05%)이고 10% 지점은 13.25% 로 0.20%p 더 높다.
     hedge.py 가 계산하지 않은 수를 화면이 지어내지 않도록 전부 유도값으로 바꾼다.
     payload 필드가 없을 때 "undefined" 를 렌더하지 않도록 전 경로에 가드를 둔다. */
  const argMin = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return -1;
    let k = -1;
    for (let i = 0; i < arr.length; i++) if (arr[i] != null && (k < 0 || arr[i] < arr[k])) k = i;
    return k;
  };
  const curves = H2.curves || {};
  const bMinI = argMin(curves.bond), eMinI = argMin(curves.equity);
  const bMin = bMinI < 0 ? null : bMinI * 5;
  const eMin = eMinI < 0 ? null : eMinI * 5;
  /* 최소점이 동률일 수 있다(실데이터: 주식 곡선의 30%·35% 가 2자리 반올림 후 둘 다 13.05).
     첫 번째만 집어 유일한 점처럼 말하지 않고, 동률이면 구간으로 적는다. */
  const eqTieHi = eMinI < 0 ? null
    : (() => { let k = eMinI; while (k + 1 < curves.equity.length && curves.equity[k + 1] === curves.equity[eMinI]) k++; return k * 5; })();
  const eqTxt = eMin == null ? "—" : (eqTieHi > eMin ? `${eMin}~${eqTieHi}%` : `${eMin}%`);
  const mvhs = H2.matrix.filter((m) => m.mvh != null).map((m) => m.mvh);
  const mvhLo = mvhs.length ? Math.min(...mvhs) : null;
  const mvhHi = mvhs.length ? Math.max(...mvhs) : null;
  const mvhTxt = mvhs.length ? (mvhLo === mvhHi ? `${mvhLo}%` : `${mvhLo}~${mvhHi}%`) : "—";
  const usdMvh = (H2.matrix.find((m) => m.c === "USD") || {}).mvh;
  const tenorM = H2.default_tenor_m;                    // 없으면 아래에서 문장 자체를 뺀다
  /* τ(잔존만기, 년) = 만기 ÷ 2 → 개월 만기 m 이면 m/24. hedge.py 의 정의와 같은 식이고
     시뮬레이터의 `tau = tenor / 24` 와도 같은 식이다. 한 자리에서만 정의한다. */
  const tauOf = (m) => m / 24;
  const MTM = H2.mtm || {};

  const hl = $("#hedge-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문"));
  const a = el("div", { class: "a" }, "통화별로 환위험을 얼마나 열어 둘 것인가 ");
  a.append(el("small", {}, `관점이 답을 바꿉니다 — 경제(시가) 관점은 통화별 채권 ${mvhTxt} · 달러주식 ${eqTxt}, `
    + "회계(손익) 관점은 장부가 채권이라면 언제나 100%가 손익변동 최소이고 남는 판단은 비용뿐입니다."));
  hl.append(a);

  /* 결론 두 줄 — 표보다 먼저. 만기를 반드시 밝힌다(아래 표·시뮬레이터와 만기가 다르면
     같은 통화가 다른 숫자로 보이기 때문이다: 엔 12개월 +2.30% vs 9개월 +2.36%). */
  const lead = $("#hedge-lead");
  if (lead) {
    lead.textContent = "";
    const listOf = (arr) => arr.map((m) => `${m.name} ${m.cost_12m > 0 ? "+" : "−"}${fmtNum(Math.abs(m.cost_12m), 2)}%`).join(" · ") || "없음";
    const recv = H2.matrix.filter((m) => m.cost_12m != null && m.cost_12m > 0);
    const paid = H2.matrix.filter((m) => m.cost_12m != null && m.cost_12m < 0);
    const box = el("div", { class: "hl-box", style: "margin:12px 0 0" });
    box.append(el("b", {}, `지금 12개월 만기로 헤지한다면 (${H2.asof} 기준)`), el("br"),
      "· 헤지하면 ", el("b", { class: "pos" }, "받는 통화"), " — ", listOf(recv), el("br"),
      "· 헤지하면 ", el("b", { class: "neg" }, "내는 통화"), " — ", listOf(paid), el("br"),
      explainBox("hedge-lead-read",
        "읽는 법 — 금액 × 이 비율 = 1년치 금액. ",
        el("b", {}, "다른 만기에는 다른 값입니다"), " — 3·6·12개월 커브와 만기 보간은 ",
        el("a", { href: "#hedge-sim" }, "시뮬레이터"), " 와 아래 표·커브 카드에 있습니다."));
    lead.append(box);
  }

  /* 읽는 법 문자열 — 파이프라인 값. 없으면(옛 payload) 문장을 짧게 줄인다. */
  const costRead = (H2.cost_read && H2.cost_read.label) || "실측 커브";

  const mx = $("#hedge-matrix");
  mx.textContent = "";
  /* 기준일이 하나가 아니다 — 월간 통계(변동성·MVH·상관)와 헤지비용 커브와 환율
     최종 관측일이 서로 다른 날짜다. "기준일 …" 한 줄로 뭉뚱그리면 헤지비용 열이 그날
     값인 줄로 읽힌다. 셋을 그대로 적는다.
     읽는 법(최신 호가 / N영업일 중앙값)은 **파이프라인이 정해서 실어 준다** — 화면에
     박아 두면 산식을 되돌려도 문장만 남는다. */
  mx.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "통화별 한눈에 보기 (7통화)"),
    el("span", { class: "card-sub" },
      `변동성·MVH·상관 = 월간 수익률(완성된 달까지) · 헤지비용 = ${costRead}`
      + ` · 환율 최종 관측 ${H2.asof}`)));
  const t = el("table", { class: "mini-table" },
    el("tr", {},
      el("th", {}, "통화"),
      el("th", {}, "환변동성", el("small", { class: "th-sub" }, "연 %, 클수록 환위험 큼")),
      el("th", {}, "채권 MVH", el("small", { class: "th-sub" }, "경제 관점 참고치")),
      el("th", {}, "환-채권 상관", el("small", { class: "th-sub" }, "−면 환쿠션 있음")),
      /* 부호 열쇠를 **열 제목에** 붙인다. 예전에는 이 규약이 표에서 한참 위의 회색 한 줄
         ("비용 양수 = 프리미엄 수취")에만 있었고, 그 문장 자체가 "비용인데 양수면 받는다"는
         모순 표현이었다. 만기도 열 제목이 스스로 들고 있어야 한다(다른 만기에는 다른 값).
         2026-08-04 이관: 예전에 FX 화면에 따로 있던 3·6·12개월 표를 여기로 흡수했다.
         12M 열은 그 표와 **완전히 같은 숫자**였으므로(실측 4/4) 한 화면에 두 번 나올
         이유가 없고, 흡수하면서 캐나다달러·파운드의 3/6M 이 처음으로 화면에 나온다. */
      el("th", {}, "헤지비용 3개월", el("small", { class: "th-sub" }, `연 %, ${COST_SIGN_KEY}`)),
      el("th", {}, "6개월", el("small", { class: "th-sub" }, "연 %")),
      el("th", {}, "12개월", el("small", { class: "th-sub" }, "연 %")),
      el("th", { style: "text-align:left" }, "근거"),
      /* 표본을 통일하지 않고 게시한다 — 같은 행 안에서도 열마다 표본이 다르다.
         `vol_e` 는 조인 전에, `mvh`/`corr` 은 채권 프록시와 조인한 뒤에 계산되므로
         짧은 쪽에 맞춰 잘린다(실측: EUR·JPY 305 vs 294). 짧은 쪽에 통일하면 변동성이
         11개월치를 버리고, 긴 쪽에 맞출 방법은 없다. */
      el("th", { style: "text-align:left" }, "표본", el("small", { class: "th-sub" }, "월수"))));
  H2.matrix.forEach((m) => {
    /* 비활성 통화를 opacity 로 흐리게 하던 것을 색으로 바꾼다. pristine 빌드 실측 결과
       opacity .5 는 본문 대비를 3.67:1 로 떨어뜨려 WCAG AA(4.5:1) 미달이었다(활성 행 19.2:1).
       또 흐림만으로 상태를 전달하면 1.4.1 에도 걸리므로 근거 칸에 글자로 적는다. */
    const off = !m.active;
    t.append(el("tr", { class: off ? "row-off" : "" },
      el("td", {}, `${m.name} (${m.c})`),
      el("td", { class: "num" }, `${fmtNum(m.vol_e, 1)}%`),
      el("td", { class: "num" }, m.mvh != null ? el("b", {}, `${m.mvh}%`) : "—"),
      el("td", { class: "num" }, m.corr != null ? String(m.corr) : "—"),
      el("td", { class: "num" }, fmtCost(m.cost_curve ? m.cost_curve["3M"] : null, true)),
      el("td", { class: "num" }, fmtCost(m.cost_curve ? m.cost_curve["6M"] : null)),
      el("td", { class: "num" }, fmtCost(m.cost_12m, true)),
      el("td", { style: "text-align:left;font-size:11.5px" },
        off ? "헤지비용·단기금리 데이터 확보 전 — 계산 대상 아님"
            : `${m.src}${m.bond_kind ? " · 채권 " + m.bond_kind : ""}`),
      el("td", { style: "text-align:left;font-size:11.5px" }, sampleTxt(m.sample))));
  });
  mx.append(wrapTable(t));
  mx.append(explainBox("hedge-matrix-read", { label: "표 읽는 법" },
    el("b", {}, "환변동성"), ": 그 통화가 원화 대비 1년에 몇 % 흔들렸나. ",
    el("b", {}, "채권 MVH"), ": 경제 관점에서 변동이 가장 작아지는 헤지비율(100%보다 낮으면 그만큼 환율이 완충해 준다는 뜻). ",
    el("b", {}, "환-채권 상관"), ": 음수면 환율이 오를 때 그 나라 채권 수익이 낮아져 서로 상쇄된다는 뜻이고, MVH 가 100% 아래로 내려가는 이유입니다. ",
    el("b", {}, "헤지비용"), `: 헤지할 때 해마다 주고받는 연율 %, ${COST_SIGN_KEY}. `,
    el("b", {}, "표본"), ": 이 행의 통계를 뽑은 구간과 월 수입니다. ",
    "변동성은 환율만 쓰므로 길고, MVH·상관은 채권 프록시와 겹치는 구간만 쓰므로 짧습니다 ",
    "— 두 값이 다른 행에는 둘 다 적었습니다. ",
    "달러 3·6·12개월의 일별 이력은 아래 ", el("b", {}, "「헤지비용 커브 추이」"), " 카드에 있습니다."));

  /* 두 관점 설명은 원래 9개 용어가 든 231자 산문 한 덩어리였다. 같은 내용을 4행 비교표로
     세운다 — "나는 어느 쪽을 봐야 하나"에 줄 하나로 답한다. 위치는 표 **뒤**다: 찾아온
     숫자보다 해설이 먼저 나오면 정작 표가 화면 아래로 밀린다(실측). */
  const hv = $("#hedge-views");
  hv.textContent = "";
  /* §7.13 — 비교표·용어 전체를 접는다. 요점(관점별 최소 헤지비율)은 헤드라인 답에
     이미 있으므로, 여기는 「왜 그런가」를 찾는 사람이 여는 자리다. */
  const hvFold = explainBox("hedge-views", { label: "위 표를 어느 관점으로 읽을 것인가 — 관점이 답을 바꿉니다" });
  hv.append(hvFold);
  const hvBody = hvFold.querySelector(".explain-body");
  const vt = el("table", { class: "mini-table view-table" },
    el("tr", {}, el("th", {}, ""),
      el("th", {}, "경제(시가) 관점"), el("th", {}, "회계(손익) 관점")));
  [["누가 보는 숫자인가", "시가평가 자산의 원화 가치", "장부가(만기보유) 해외채권의 회계 손익"],
   ["환율 손실을 상쇄해 줄 상대", "있다 — 자산가격이 반대로 움직임(자연 쿠션)", "없다 — 채권 가격변동을 손익에 안 잡음"],
   ["그래서 변동이 최소가 되는 헤지비율", `채권 ${mvhTxt} · 달러주식 ${eqTxt}`, "100% (모형상 언제나)"],
   ["남는 판단", "환위험을 얼마나 열어 둘까", "비용을 낼까 / 받을까"],
  ].forEach(([k, a1, a2]) => vt.append(el("tr", {},
    el("th", { class: "rowhead" }, k), el("td", {}, a1), el("td", {}, a2))));
  hvBody.append(wrapTable(vt));
  /* 용어는 접어 둔다 — 필요한 사람만 펼치고, 첫 화면은 숫자로 남는다. */
  const terms = el("details", { class: "terms" });
  terms.append(el("summary", {}, "이 화면에 나오는 말 다섯 개 (펼쳐 보기)"));
  [["헤지비율", "외화 자산 중 선물환·스왑으로 환위험을 덮은 비율. 0% = 환율에 그대로 노출, 100% = 환율이 움직여도 원화 손익은 그대로."],
   ["헤지비용 (= 스왑레이트 = 스왑포인트)", `헤지할 때 해마다 주고받는 연율 %. ${COST_SIGN_KEY} — 이름은 '비용'이지만 부호가 양수면 받습니다. 자산배분·시뮬레이터도 같은 부호 규약입니다.`],
   ["MVH (최소분산 헤지비율)", "경제 관점에서 변동성이 가장 작아지는 헤지비율. 산식은 1 + Cov(자산수익, 환율변화) ÷ Var(환율변화)."],
   ["스왑 MTM (평가손익)", "이미 체결한 스왑의 평가손익. 시장 스왑레이트가 오르면 평가손실입니다(민감도 = 잔존만기 τ = 만기 ÷ 2)."],
   ["장부가 비중", "보유 채권 중 만기보유로 분류돼 가격변동이 손익에 안 잡히는 비율. 회계 관점 계산에만 씁니다."],
  ].forEach(([k, v]) => terms.append(el("div", { class: "term" }, el("b", {}, k), " — ", v)));
  hvBody.append(terms);

  const cc = $("#hedge-curve-card");
  cc.textContent = "";
  /* 곡선이 없으면 카드를 통째로 건너뛴다 — 없는 배열을 훑어 "undefined" 를 그리지 않는다. */
  if (bMin != null && eMin != null) {
  const xs = Array.from({ length: 21 }, (_, i) => i * 5);
  const curveBox = cardScaffold(cc, {
    title: "헤지비율을 올리면 변동성은 — 달러 (경제 관점)",
    sub: `가로 = 헤지비율, 세로 = 연 변동성(%) · 가장 낮은 점: 채권 ${bMin}% · 주식 ${eqTxt}`
      + (usdMvh != null ? ` (곡선은 5%p 격자로 읽은 값이라 표의 달러 MVH ${usdMvh}% 와 한 칸 차이가 날 수 있습니다)` : ""),
    csvName: "헤지비율-변동성.csv",
    tableFn: (cap, raw) => ({
      headers: ["헤지비율", "채권 변동성(%)", "주식 변동성(%)"],
      rows: xs.map((h, i) => [`${h}%`, curves.bond[i], curves.equity[i]]),
    }),
  });
  makeRatioChart(curveBox, { seriesDefs: [
    { label: "미국 채권(종합)", color: pal.series[0], x: xs, v: curves.bond },
    { label: "미국 주식(S&P500 TR)", color: pal.series[1], x: xs, v: curves.equity },
  ] });
  cc.append(explainBox("hedge-curve-read",
    `선이 아래로 내려갈수록 변동이 작습니다. 채권은 ${bMin}% 까지 내리다가 다시 오르고, `
    + `주식은 ${eqTxt} 를 지나면 헤지를 늘릴수록 오히려 변동이 커집니다 — 환율이 주가 하락을 상쇄해 주던 몫(자연 쿠션)이 사라지기 때문입니다.`));
  }

  const bt = $("#hedge-bt-card");
  bt.textContent = "";
  /* 카드 부제에 첫 자산의 구간만 적어 두 자산 모두에 해당하는 것처럼 보이게 하고 있었다.
     구간이 갈리는 날 조용히 틀린 라벨이 된다 — 같을 때만 적는다. */
  const btPeriods = [...new Set(Object.values(H2.backtest || {}).map((x) => x.period))];
  bt.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "실제로 그렇게 했다면 — 달러자산 헤지비율별"),
    el("span", { class: "card-sub" },
      btPeriods.length === 1 ? `${btPeriods[0]} 월간, 헤지비용 반영` : "표본 구간이 자산별로 다름 — 방법론 참조")));
  const bthead = el("tr", {},
    el("th", {}, "자산"), el("th", {}, "헤지비율"),
    el("th", {}, "CAGR", el("small", { class: "th-sub" }, "연평균 수익률")),
    el("th", {}, "변동성", el("small", { class: "th-sub" }, "연 표준편차")),
    el("th", {}, "MDD", el("small", { class: "th-sub" }, "고점 대비 최대 낙폭")));
  const btt = el("table", { class: "mini-table" }, bthead);
  Object.entries(H2.backtest || {}).forEach(([name, b]) => {
    b.rows.forEach((r, i) => {
      const tr = el("tr", {});
      if (i === 0) tr.append(el("td", { rowspan: "3" }, name));
      tr.append(el("td", { class: "num" }, `${r.h}%`),
                el("td", { class: "num" }, `${fmtNum(r.cagr, 2)}%`),
                el("td", { class: "num" }, `${fmtNum(r.vol, 1)}%`),
                el("td", { class: "num" }, `${fmtNum(r.mdd, 1)}%`));
      btt.append(tr);
    });
  });
  bt.append(wrapTable(btt),
    el("div", { class: "card-sub", style: "margin-top:6px;line-height:1.7" },
      el("b", {}, "주식을 100% 헤지하면 낙폭이 오히려 커집니다"),
      " — 위기에 환율이 올라 주가 하락을 덜어 주던 몫(자연 쿠션)까지 없애기 때문입니다. 헤지비용은 3개월 스왑레이트 실측을 반영했습니다."));

  const cost = $("#hedge-cost-card");
  cost.textContent = "";
  const cs = H2.cost_stats || {};
  /* "최악(2008)" 은 연도가 코드에 박혀 있었다 — 실제 최저월을 계열에서 찾아 적는다.
     실측하면 스왑레이트 최저월과 아래 MTM 표의 최악의 달(최대 급등월)은 **다른 달**이다.
     두 수를 같은 화면에서 "2008" 로만 부르면 섞여 읽힌다. */
  const ch = H2.cost_hist_usd || { t: [], v: [] };
  const minI = argMin(ch.v);
  const minYm = minI >= 0 ? tsToDate(ch.t[minI]).slice(0, 7) : null;
  const nowYm = ch.t.length ? tsToDate(ch.t[ch.t.length - 1]).slice(0, 7) : null;
  const sgn = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${fmtNum(x, 2)}%`);
  const costBox = cardScaffold(cost, {
    title: "달러 헤지비용 이력 — 3개월 스왑레이트(월말)",
    /* 「25년 평균」은 **하드코딩이었다.** 표본이 늘거나 줄어도 문장이 25년에 멈춰
       있으면 거짓이 된다 — 파이프라인이 실어 주는 표본 길이를 쓴다. */
    sub: `${COST_SIGN_KEY} · ${cs.years ? cs.years + "년" : "장기"} 평균 ${sgn(cs.mean)}`
      + (nowYm ? ` · ${nowYm} ${sgn(cs.now)}` : "")
      + (minYm ? ` · 가장 많이 낸 달 ${minYm} ${sgn(cs.min)}` : "")
      + (cs.start ? ` · ${cs.series || "이력"} ${cs.start}~${cs.end} (${cs.n_months}개월)` : ""),
    csvName: "달러-헤지비용.csv",
    tableFn: tsTableFn(["헤지비용 3개월 스왑레이트(%)"], [ch.t, ch.v], 2),
  });
  /* HP 3M(2024-10~)을 보조 계열로 겹친다 — "같은 성격, 다른 계열"이라는 아래 문장을
     그림이 증명한다. 추가 공개는 없다(같은 값이 바로 옆 커브 카드에 이미 있다). */
  const hp3 = (H2.cost_hist_curve || {})["3M"];
  const costGroups = [{ label: "3개월 스왑레이트(SMB, 월말)", t: ch.t, v: ch.v }];
  if (hp3 && hp3.t && hp3.t.length) {
    costGroups.push({ label: `HP 3개월(일별, ${costRead})`, t: hp3.t, v: hp3.v });
  }
  makeTimeChart(costBox, {
    labels: costGroups.map((g) => g.label),
    colors: costGroups.map((_, i) => pal.series[i === 0 ? 0 : 3]),
    data: joinSeries(costGroups), dec: 2, unit: "%",
    fill: costGroups.length === 1, height: 230,
  });
  /* 같은 화면에 「헤지비용」이 두 개 있고 값이 다르다 — 위 표는 인포맥스 실측 스왑포인트
     (HP), 이 차트는 3개월 스왑레이트(SMB, 월말)다. 어느 쪽을 보고 있는지
     화면이 말해 주지 않으면 두 숫자가 충돌한다(실측: 달러 3M −1.15% vs 월말 −0.45%). */
  cost.append(explainBox("hedge-hp-smb", { label: "이 차트의 「헤지비용」과 위 표의 값이 다른 이유" },
    "위 「통화별 한눈에 보기」의 헤지비용 열은 ", el("b", {}, `일별 스왑포인트 ${costRead}`),
    " 이고, 이 차트는 ", el("b", {}, "3개월 스왑레이트 월말값"),
    " 입니다 — 같은 성격의 값이지만 계열과 시점이 달라 숫자가 일치하지 않습니다. ",
    hp3 ? el("span", {}, "위 차트에 ", el("b", {}, "HP 3개월을 보조선으로 겹쳐"),
      " 두 계열이 같이 움직인다는 것을 그림으로 확인할 수 있습니다 — ",
      "겹치는 구간 421일에서 상관 0.9644, 평균차 +0.04%p(sd 0.13, 범위 −1.35~+0.70)입니다. ") : null,
    "수준은 HP, 이력은 SMB 로 역할이 나뉩니다 — HP 는 2024-10 시작이라 이력이 없고, ",
    "공분산의 스왑레이트 요인은 그래서 SMB(2001~)를 씁니다. 일별 호가 추이는 ",
    el("b", {}, "옆의 「헤지비용 커브 추이」"), " 카드에 있습니다."));

  /* ── 이관 카드(2026-08-04): 달러 헤지비용 3·6·12개월 일별 커브 ─────────────
     예전에는 FX 화면에 "달러/원 스왑포인트 추이"로 있었다. 여기 있어야 하는 이유는
     이 세 계열이 **시뮬레이터의 만기 보간(hedgeCostAt)이 쓰는 곡선의 원자료**이기
     때문이다 — 시세가 아니라 "만기별 비용"이고, 그것은 이 화면의 질문 안에 있다.
     payload 도 fx.json 에서 hedge.json 으로 옮겼다(같은 값이 두 JSON 에 실리면
     새 이중 진실이고, DATA.fx 를 읽으면 fx.json 하나가 깨질 때 이 화면까지 빈다). */
  const tsCardEl = $("#hedge-ts-card");
  tsCardEl.textContent = "";
  const CH = H2.cost_hist_curve || {};
  const curveGroups = [["3M", "3개월"], ["6M", "6개월"], ["12M", "12개월"]]
    .filter(([k]) => CH[k] && CH[k].t && CH[k].t.length)
    .map(([k, label]) => ({ label, t: CH[k].t, v: CH[k].v }));
  if (curveGroups.length) {
    const cdata = joinSeries(curveGroups);
    const cbox = cardScaffold(tsCardEl, {
      title: "달러 헤지비용 커브 추이 (3·6·12개월)",
      /* 만기를 모르면 그 조각을 통째로 뺀다 — "undefined개월" 을 내보내지 않는다.
         이 화면의 다른 문장들도 같은 규약이다(tenorM 이 없으면 문장 자체를 뺀다). */
      sub: `연율 %, ${COST_SIGN_KEY}`
        + (H2.default_tenor_m ? ` · 시뮬레이터가 ${H2.default_tenor_m}개월을 보간할 때 쓰는 원자료` : ""),
      csvName: "달러-헤지비용-커브.csv",
      tableFn: tsTableFn(curveGroups.map((g) => g.label), cdata, 2),
    });
    makeTimeChart(cbox, {
      labels: curveGroups.map((g) => g.label),
      colors: curveGroups.map((_, i) => pal.series[i % 8]),
      data: cdata, dec: 2, unit: "%", height: 230,
    });
    tsCardEl.append(explainBox("hedge-ts-read",
      "세 선이 벌어져 있으면 만기에 따라 비용이 크게 다르다는 뜻입니다 — ",
      el("a", { href: "#hedge-sim" }, "시뮬레이터"),
      H2.default_tenor_m
        ? ` 는 이 커브 위에서 ${H2.default_tenor_m}개월을 보간하므로, 위 표의 12개월 값과 다른 숫자가 나옵니다.`
        : " 는 이 커브 위에서 만기를 보간하므로, 위 표의 12개월 값과 다른 숫자가 나옵니다."));
  } else {
    tsCardEl.append(el("p", { class: "card-sub" }, "헤지비용 커브 이력을 불러오지 못했습니다."));
  }

  /* ── 미국채 투자 메리트 모니터(§7.7.14 — 2026-08-12 사용자 요청) ─────────────
     "헤지비용은 미국채 수익률에서 차감된다 → 비용이 오르면(더 내면) 미국채 메리트가
     준다"는 관계와, 위험수준과 비용의 연동을 한 카드에서 상시 감시한다.
     산식은 파이프라인 항등식(헤지 후 UST = UST10y + 스왑레이트 — 부호 규약상 덧셈,
     내는 국면은 음수라 차감이 된다). 위험 연동은 관계분석과 같은 pearson 을 쓰되,
     수준이 아니라 **13주 변화**로 잰다 — 둘 다 추세가 강한 수준 계열이라 수준 상관은
     허구 상관이 되기 쉽다(정식 통계는 관계분석 화면으로 안내). */
  const meritCard = $("#hedge-merit-card");
  if (meritCard) {
    meritCard.textContent = "";
    const M = H2.ust_merit;
    if (!M || !M.active) {
      meritCard.append(el("div", { class: "card-title" }, "미국채 투자 메리트 — 데이터 없음"),
        el("p", { class: "card-sub" },
          (M && M.reason ? M.reason + " — " : "") + "원천 시리즈가 들어오면 자동으로 복구됩니다."));
    } else {
      const now = M.now || {};
      const tile = (label, val, sub, cls) => el("div",
        { class: "card", style: "padding:10px 14px;min-width:150px" },
        el("div", { class: "card-title", style: "font-size:11.5px" }, label),
        el("div", { class: cls || "", style: "font-size:18px;font-weight:700;margin:3px 0 1px" }, val),
        el("div", { style: "color:var(--ink-3);font-size:11px" }, sub));
      const sgn2 = (x, d) => (x == null ? "—" : `${x > 0 ? "+" : ""}${fmtNum(x, d == null ? 2 : d)}%`);
      meritCard.append(el("div", { class: "card-head" },
        el("span", { class: "card-title" }, "미국채 투자 메리트 — 헤지 후 원화수익률 vs 국고"),
        el("span", { class: "card-sub" }, `주간(W-FRI) · ${M.start}~ (${M.n_weeks}주)`)));
      meritCard.append(explainBox("hedge-merit-formula",
        `헤지 후 미국채 = 미국채 10년 + 3개월 스왑레이트(연율) · ${COST_SIGN_KEY} — ` +
        "내는 국면에서는 스왑레이트가 음수라 수익률에서 차감됩니다."));
      const tiles = el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;margin:8px 0" });
      tiles.append(
        tile("헤지비용 (3M 스왑레이트)", sgn2(now.cost), "이력 축 — 현재 수준 정본은 위 매트릭스(HP 12M)와 만기가 다릅니다"),
        tile("헤지 후 미국채 10년", fmtNum(now.hedged, 2) + "%", `미국채 ${fmtNum(now.ust, 2)}% + 스왑 ${sgn2(now.cost)}`),
        tile("국고 10년", fmtNum(now.ktb, 2) + "%", "비교 기준"),
        tile("메리트 스프레드", sgn2(now.spread) + "p",
          `헤지 후 미국채 − 국고 · 자기 이력 백분위 ${fmtNum(now.spread_pctile, 0)}%`,
          now.spread > 0 ? "d-down" : "d-up"));
      meritCard.append(tiles);
      /* cardScaffold 는 컨테이너를 **비우고** 시작한다(container.textContent = "") —
         카드에 직접 걸면 위의 머리글·타일이 지워진다(실측). 차트 전용 호스트를 분리. */
      const chartHost = el("div", {});
      meritCard.append(chartHost);
      const mbox = cardScaffold(chartHost, {
        title: "헤지 후 미국채 10년 vs 국고 10년 — 메리트 스프레드",
        sub: "스프레드 > 0 이면 헤지하고도 미국채가 국고보다 수익률이 높다는 뜻",
        csvName: "미국채-메리트.csv",
        tableFn: tsTableFn(["헤지 후 미국채(%)", "국고 10년(%)", "메리트 스프레드(%p)"],
          [M.t, M.hedged, M.ktb, M.spread], 2),
      });
      makeTimeChart(mbox, {
        labels: ["헤지 후 미국채 10년", "국고 10년", "메리트 스프레드"],
        colors: [pal.series[0], pal.series[1], pal.series[3]],
        data: [M.t, M.hedged, M.ktb, M.spread], dec: 2, unit: "%", height: 240,
      });
      /* 위험수준 연동 — 관계분석 패널의 주간 위험 점수(stress)와 13주 변화 상관.
         패널이 없으면 문장을 빼고 관계분석 링크만 남긴다(없는 수를 만들지 않는다). */
      const P13 = 13;
      const chg = (arr) => arr.map((v, i) => (i >= P13 && v != null && arr[i - P13] != null
        ? v - arr[i - P13] : null));
      let riskLine = null;
      const PN = DATA.panel;
      if (PN && PN.risk && PN.risk.stress && PN.t) {
        const byT = new Map();
        PN.t.forEach((t, i) => byT.set(t, PN.risk.stress[i]));
        const riskOnMerit = M.t.map((t) => (byT.has(t) ? byT.get(t) : null));
        const dRisk = chg(riskOnMerit), dCost = chg(M.cost), dSpr = chg(M.spread);
        const pairs = (a, b) => {
          const xs = [], ys = [];
          a.forEach((x, i) => { if (x != null && b[i] != null) { xs.push(x); ys.push(b[i]); } });
          return [xs, ys];
        };
        const [x1, y1] = pairs(dRisk, dCost);
        const [x2, y2] = pairs(dRisk, dSpr);
        if (x1.length >= 30) {
          /* pearson 은 {r, n} 을 돌려준다(관계분석 엔진과 공유) — r 만 뽑는다 */
          const c1 = pearson(x1, y1).r, c2 = pearson(x2, y2).r;
          riskLine = explainBox("hedge-merit-risk", { label: "위험수준과의 관계" },
            `13주 변화 기준 상관: 위험지수↔헤지비용 ${fmtNum(c1, 2)}, ` +
            `위험지수↔메리트 스프레드 ${fmtNum(c2, 2)} (겹치는 표본 ${x1.length}주). `,
            c1 < -0.1
              ? "음(−)이면 위험이 오를 때 비용이 더 내는 쪽으로 움직여 미국채 메리트가 함께 준다는 뜻입니다. "
              : "이 표본에서는 위험 상승과 비용 악화의 동행이 뚜렷하지 않습니다. ",
            "지연·교차상관·회귀(HAC)는 ",
            el("a", { href: "#panel" }, "관계분석"),
            " 에서 「환헤지 비용 (3개월 스왑레이트)」 변수로 보십시오.");
        }
      }
      meritCard.append(riskLine || el("div", { class: "card-sub", style: "margin-top:6px" },
        "위험수준과의 정식 통계(상관·교차상관·회귀)는 ",
        el("a", { href: "#panel" }, "관계분석"),
        " 에서 「환헤지 비용 (3개월 스왑레이트)」 변수로 보십시오."));
    }
  }

  const mtm = $("#hedge-mtm-card");
  mtm.textContent = "";
  /* mtm 통계가 없으면 이 카드도 통째로 건너뛴다 — 없는 수로 표를 그리면 NaN 이 나간다. */
  if (MTM.sigma_ds_3m != null && MTM.worst_ds != null) {
  const worstYm = String(MTM.worst_date || "").slice(0, 7);
  mtm.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "스왑을 몇 개월짜리로 굴릴 것인가 — 스왑 MTM"),
    el("span", { class: "card-sub" }, "이미 체결한 스왑의 평가손익 — 회계 손익에 그대로 잡힙니다"
      + (MTM.start ? ` · ${MTM.series || "표본"} ${MTM.start}~${MTM.end} (${MTM.n_months}개월)` : ""))));
  /* 부호가 이 표의 전부다. MTM = 잔존만기 × (−Δ스왑레이트) 이므로 **스왑레이트가 오르는
     달에 평가손**이 난다(hedge.py 주석과 동일). 예전 표는 최악월을 부호 없는 양수로 찍어
     "손실"이라는 말이 두 줄 아래 회색 글씨에만 있었다 — 손실을 손실로 적는다. */
  const mt = el("table", { class: "mini-table" },
    el("tr", {},
      el("th", {}, "스왑 만기"),
      el("th", {}, "잔존만기 τ", el("small", { class: "th-sub" }, "= 만기 ÷ 2, 년")),
      el("th", {}, "평상시 MTM 변동", el("small", { class: "th-sub" }, "연 %, 헤지 명목 대비")),
      el("th", {}, "최악의 달 평가손", el("small", { class: "th-sub" }, `${worstYm || "관측 최대 급등월"}, 명목 대비`))));
  [3, 6, 9, 12].forEach((m) => {
    const tau = tauOf(m);
    const vol = (tau * MTM.sigma_ds_3m * Math.sqrt(12)).toFixed(2);
    const worst = (tau * Math.abs(MTM.worst_ds)).toFixed(2);
    const isDefault = m === tenorM;
    mt.append(el("tr", { style: isDefault ? "font-weight:700" : "" },
      el("td", {}, `${m}개월${isDefault ? " ← 우리 평균" : ""}`),
      el("td", { class: "num" }, fmtNum(tau, 3)),
      el("td", { class: "num" }, `±${vol}%`),
      el("td", { class: "num" }, el("span", { class: "neg" }, `−${worst}%`))));
  });
  mtm.append(wrapTable(mt),
    explainBox("hedge-mtm-read", { label: "읽는 법" },
      "평가손은 시장 스왑레이트가 ", el("b", {}, "오를"),
      " 때 납니다(MTM = 잔존만기 τ × −Δ스왑레이트). 만기를 늘리면 조건을 오래 고정하는 대신"
      + " τ 가 커져 평가손익이 그만큼 크게 흔들립니다 — 위 두 열이 만기에 정비례하는 이유입니다."
      + ` 근거: 스왑레이트 월간 변동 σ ${MTM.sigma_ds_3m}%p, 관측 최대 상승 +${MTM.worst_ds}%p`
      + `${MTM.worst_date ? ` (${MTM.worst_date})` : ""}`
      + `${MTM.corr_ds_e != null ? `, 달러/원 변화와의 상관 ${MTM.corr_ds_e}` : ""}.`
      + " (%p = 스왑레이트 자체가 몇 %포인트 움직였나)"));
  }

  const mth = $("#hedge-method");
  mth.textContent = "";
  mth.append(el("summary", {}, "산식 · 회계 모형 · 한계 (방법론)"));
  mth.append(el("p", {}, el("b", {}, "회계 손익 모형 (장부가 해외채권 + FX스왑)")));
  (H2.acct_model || []).forEach((s) => mth.append(el("div", { style: "font-size:12.5px" }, s)));
  mth.append(el("p", {}, el("b", {}, "경제 관점"),
    " — 원화수익 = 자산수익 + (1−h)×환율변화 + h×헤지비용. MVH = 1 + Cov(자산,환율)/Var(환율). ",
    `공분산 표본 ${H2.sim.sample} (${H2.sim.n_months}개월).`));
  mth.append(el("p", {}, el("b", {}, "부호 규약"),
    ` — 헤지비용(= 스왑레이트 = 스왑포인트)은 ${COST_SIGN_KEY}. 스왑 MTM 은 잔존만기 τ = 만기 ÷ 2 를 곱한 τ×(−Δ스왑레이트) 이므로 `,
    el("b", {}, "스왑레이트가 오르는 달에 평가손실"),
    "입니다. 이 규약은 이 화면·FX 화면·자산배분·시뮬레이터가 모두 같습니다."));
  mth.append(el("p", {}, el("b", {}, "한계"), ` — ${H2.limits}`));
}

/* ---------------- 환헤지 시뮬레이터 (오버레이) ---------------- */

const HEDGE_LS_KEY = "iaw-hedge-input";

/* 시뮬레이터 금액의 출처 3단 — 사용자 지시(2026-08-04) 3번 "시뮬레이터 기본금액 연결".
   ① 표에 직접 입력한 값  ② 총 운용자산 × 자산배분 화면의 비중  ③ 예시값.
   ②가 왜 총자산 한 칸인가: `iaw-alloc` 스키마에는 **금액 필드가 하나도 없다**(비중 %·
   밴드·헤지비율 총계뿐). 통화별 구성 분해는 §7.3 미구현분이라 이번 범위를 넘는다.
   총자산 하나만 있으면 해외채권·해외주식 비중과 곱해 달러 금액을 유도할 수 있고,
   그것이 지금 하드코딩된 5000/3000 이 하던 일 전부다. */
const AMT_SRC = { input: "우리 값", derived: "자산배분에서 유도", sample: "예시값" };

/* `iaw-alloc` 은 **읽기만** 한다. allocSaveState() 가 저장 시 state 전체를 덮어쓰므로,
   hedge 가 alloc 에 쓰면 자산배분 화면의 다음 저장에 조용히 지워진다.
   새 스키마는 시가 7축 `mix`(§7.7.11), 구 저장분은 회계 9축 `mix_acct` — 구 쪽은
   allocState 의 fold 와 같은 규칙(채권 쌍 합산)으로 접어서 돌려준다. */
function allocMixReadOnly() {
  try {
    const s = JSON.parse(localStorage.getItem(ALLOC_LS_KEY)) || {};
    if (s.mix && typeof s.mix === "object") return s.mix;
    const m = s.mix_acct;
    if (!m || typeof m !== "object") return null;
    const g = (k) => (m[k] != null && isFinite(+m[k]) ? +m[k] : NaN);
    return { 해외채권: g("장부가 해외채권") + g("시가 해외채권"),
             해외주식: g("해외주식") };
  } catch { return null; }
}

/* 총 운용자산(억원) — hedge 자신의 저장소에만 둔다(스키마는 추가만 하므로 하위 호환). */
function hedgeTotalAum(saved) {
  const v = saved && +saved.total_aum;
  return isFinite(v) && v > 0 ? v : null;
}

function hedgeRows(H2, saved) {
  const rows = [];
  const aum = hedgeTotalAum(saved);
  const mix = aum ? allocMixReadOnly() : null;
  /* 유도 매핑 — 통화 구성 정보가 없으므로 **달러 두 줄만** 유도한다.
     해외채권 → USD_b, 해외주식 → USD_e (시가 7축 — 구 저장분은 fold 되어 온다). */
  const pct = (...keys) => {
    if (!mix) return null;
    const vals = keys.map((k) => +mix[k]).filter((x) => isFinite(x));
    return vals.length === keys.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const derive = (...keys) => {
    const w = pct(...keys);
    return w == null ? null : Math.round(aum * w / 100);
  };
  const pick = (derived, sample) => (derived != null
    ? { amt: derived, src: AMT_SRC.derived }
    : { amt: sample, src: AMT_SRC.sample });

  /* 주식 참고치는 곡선의 최소점에서 뽑는다 — 예전의 "경제 10~30%" 는 산식이 만들어 낸 수가
     아니었다(실측: 10% 지점은 최소점보다 변동성이 0.20%p 높다). 곡선이 없으면 아예 안 적는다. */
  const eq = (H2.curves || {}).equity;
  let eqMinH = null;
  if (Array.isArray(eq) && eq.length) {
    let k = 0;
    for (let i = 1; i < eq.length; i++) if (eq[i] != null && eq[i] < eq[k]) k = i;
    eqMinH = k * 5;
  }
  H2.matrix.forEach((m) => {
    if (m.c === "USD") {
      rows.push({ id: "USD_b", cur: "USD", kind: "bond", name: "달러 — 채권",
                  ref: `경제 ${m.mvh}% · 회계 100%`, book: 70, h: 90,
                  ...pick(derive("해외채권"), 5000) });
      rows.push({ id: "USD_e", cur: "USD", kind: "eq", name: "달러 — 해외주식(ACWI)",
                  ref: eqMinH == null ? "경제 —" : `경제 ${eqMinH}% (변동성 최소)`,
                  book: null, h: 30,
                  ...pick(derive("해외주식"), 3000) });
    } else {
      /* 통화 구성 정보가 없어 유도하지 않는다 — 0 으로 두고 사용자가 넣는다.
         (예전에는 `amt: m.active ? 0 : 0` 이라는 죽은 삼항이 있었다.) */
      rows.push({ id: m.c + "_b", cur: m.c, kind: "bond", name: `${m.name} — 채권`,
                  ref: m.active ? `경제 ${m.mvh}% · 회계 100%` : "데이터 확보 전",
                  amt: 0, src: AMT_SRC.sample, book: 100, h: 100, dis: !m.active });
    }
  });
  return rows;
}

function hedgeCostAt(m, tenorM) {
  if (!m.cost_curve) return 0;
  const c = m.cost_curve;
  const x = Math.min(12, Math.max(3, tenorM));
  if (x <= 6) return c["3M"] + (c["6M"] - c["3M"]) * (x - 3) / 3;
  return c["6M"] + (c["12M"] - c["6M"]) * (x - 6) / 6;
}

function openHedgeSim() {
  const H2 = DATA.hedge;
  if (!H2 || !H2.sim) { hideDetail(); return; }
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  const inner = openOverlayShell({
    backLabel: "‹ 환헤지 기본 화면", backHash: "hedge",
    crumbTail: " / 시뮬레이터 (7통화)", title: "환헤지 시뮬레이터",
  });
  const hl = el("div", { class: "qa" });
  hl.append(el("div", { class: "q" }, "이 화면이 하는 일"));
  hl.append(el("div", { class: "a" }, "우리 포트폴리오 숫자로 통화별 헤지비율을 바꿔보기 ",
    el("small", {}, "표에 금액과 헤지비율을 넣으면 아래 세 숫자가 즉시 다시 계산됩니다. 입력값은 이 브라우저에만 저장되며 서버로 전송되지 않습니다")));
  inner.append(hl);

  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(HEDGE_LS_KEY)) || {}; }
    catch { return {}; }
  })();
  const rows = hedgeRows(H2, saved).map((r) => {
    const mine = saved.rows && saved.rows[r.id];
    /* 표에 금액을 직접 넣었으면 그것이 이긴다 — 배지도 함께 바뀌어야 한다.
       배지와 실제 쓰인 값의 출처가 어긋나면 배지가 거짓말이 된다. */
    const amtGiven = mine && mine.amt != null;
    return { ...r, ...mine, src: amtGiven ? AMT_SRC.input : r.src };
  });
  const tenor0 = saved.tenor || H2.default_tenor_m || 9;
  const aum0 = hedgeTotalAum(saved);

  const panel = el("div", { class: "card" });
  panel.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "① 우리 숫자를 넣습니다"),
    el("span", { class: "card-sub" }, "금액 = 억원 · 장부가 비중 = 채권 중 만기보유 비율(회계 관점 계산에만 씀) · 파란 글씨 = 모델 참고치")));
  /* 총 운용자산 한 칸 — 자산배분 화면의 비중과 곱해 달러 두 줄의 초기값을 유도한다.
     통화별 금액은 지금처럼 표에서 직접 넣는다(§7.3 통화 구성 분해는 미구현). */
  const aumInput = el("input", { type: "number", id: "hg-aum", min: "0", step: "100",
                                 value: aum0 == null ? "" : String(aum0),
                                 placeholder: "예: 20000",
                                 "aria-label": "총 운용자산(억원)" });
  const aumNote = el("span", { style: "color:var(--ink-3);font-size:12px" });
  const setAumNote = () => {
    const mix = allocMixReadOnly();
    aumNote.textContent = !aumInput.value
      ? "— 넣으면 아래 달러 두 줄의 금액을 자산배분 화면의 비중으로 유도합니다(빈칸이면 예시값)."
      : mix
        ? "— 자산배분 화면에 저장된 비중으로 달러 채권·주식 금액을 유도했습니다. 표에서 직접 고치면 그 값이 이깁니다."
        : "— 자산배분 화면에서 비중을 먼저 저장해야 유도됩니다. 지금은 예시값입니다.";
  };
  setAumNote();
  /* 클래스를 `tenor-row` 와 나눈다 — 같은 줄 모양이지만 다른 입력이고,
     프로브·테스트가 `.tenor-row` 로 만기 줄을 집기 때문이다(합치면 이 줄이 먼저
     잡혀 만기 설명 검사가 엉뚱한 문장을 본다 — 실제로 그렇게 깨졌다). */
  panel.append(el("div", { class: "tenor-row aum-row" },
    el("b", {}, "총 운용자산"), aumInput, "억원", aumNote));
  panel.append(el("p", { class: "card-sub", style: "margin:4px 0 10px" },
    "입력값은 이 브라우저에만 저장되며 서버로 전송되지 않습니다 — 이 페이지는 정적 호스팅이라 보낼 상대가 없습니다."));
  /* 헤지비용 열의 제목은 **지금 만기**를 스스로 들고 있어야 한다. 기본 만기와 매트릭스의
     12개월은 다른 값이므로(엔 9개월 +2.36% vs 12개월 +2.30%), 만기를 밝히지 않은 문장은
     같은 통화가 두 숫자로 보이게 만든다. 만기 입력이 바뀌면 이 제목도 같이 바뀐다. */
  const costTh = el("small", { class: "th-sub" }, `만기 ${tenor0}개월, 연 %, ${COST_SIGN_KEY}`);
  const grid = el("table", { class: "grid-inp" },
    el("tr", {},
      el("th", {}, "자산 (통화)"), el("th", {}, "금액(억원)"),
      el("th", {}, "장부가 비중"), el("th", {}, "헤지비율"),
      /* 세 번째 타일(캐리)이 왜 그 숫자인지 표에서 바로 보이게 한다 —
         캐리 = Σ 금액 × 헤지비율 × 이 열. */
      el("th", {}, "이 통화 헤지비용", costTh),
      el("th", {}, "연간 헤지 캐리", el("small", { class: "th-sub" }, `억원, ${COST_SIGN_KEY}`))));
  const inputs = {};
  rows.forEach((r) => {
    const tr = el("tr", { class: r.dis ? "dis" : "" });
    /* 입력 3종에 접근 가능한 이름을 붙인다 — 예전에는 <label> 도 aria-label 도 없어서
       화면낭독기에는 "편집" 이 24개 늘어설 뿐이었고, 표 헤더만으로는 어느 통화의 칸인지
       읽히지 않았다(pristine 실측: 이름 붙은 입력 0/24). */
    const amt = el("input", { type: "number", id: `hg-a-${r.id}`, value: String(r.amt), min: "0",
                              "aria-label": `${r.name} 금액(억원)` });
    const book = r.book != null
      ? el("input", { type: "number", id: `hg-q-${r.id}`, value: String(r.book), min: "0", max: "100",
                      "aria-label": `${r.name} 장부가 비중(%)` })
      : null;
    const slider = el("input", { type: "range", id: `hg-h-${r.id}`, value: String(r.h), min: "0", max: "100", step: "5",
                                 "aria-label": `${r.name} 헤지비율(%)` });
    const hlbl = el("span", { class: "hlbl" }, `${r.h}%`);
    const costCell = el("td", { class: "num", id: `hg-c-${r.id}` }, "–");
    const carryCell = el("td", { class: "num", id: `hg-k-${r.id}` }, "–");
    if (r.dis) { amt.disabled = true; if (book) book.disabled = true; slider.disabled = true; }
    inputs[r.id] = { amt, book, slider, hlbl, costCell, carryCell, cfg: r };
    tr.append(
      el("td", {}, r.name, el("span", { class: "refbadge" }, r.ref),
        /* 이 금액이 어디서 왔는지 — 「모든 숫자는 그 자리에서 한 줄로 설명한다」 */
        el("span", { class: "amtbadge", id: `hg-s-${r.id}` }, r.src || AMT_SRC.sample)),
      el("td", {}, amt),
      el("td", {}, book ? book : el("span", { style: "color:var(--ink-3)" }, "—"), book ? "%" : ""),
      el("td", {}, slider, hlbl),
      costCell, carryCell);
    grid.append(tr);
  });
  panel.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, grid));
  const tenorInput = el("input", { type: "number", id: "hg-tenor", value: String(tenor0), min: "3", max: "12",
                                   "aria-label": "스왑 평균 만기(개월)" });
  panel.append(el("div", { class: "tenor-row" },
    el("b", {}, "스왑 평균 만기"), tenorInput, "개월",
    explainBox("hedge-sim-tenor",
      `조건을 고정하는 기간이자 평가손익 민감도(잔존만기 τ = 만기 ÷ 2)입니다. 위 헤지비용 열은 이 만기로 보간합니다`
      + (H2.default_tenor_m ? `. 기본값 ${H2.default_tenor_m}개월은 현재 실무의 금액가중평균` : ""))));
  const resetBtn = el("button", { class: "theme-btn", style: "width:auto;padding:0 14px;font-size:12.5px",
    onclick: () => { localStorage.removeItem(HEDGE_LS_KEY); location.reload(); } }, "입력 초기화");
  panel.append(el("div", { style: "margin-top:8px" }, resetBtn));
  inner.append(panel);

  const res = el("div", { class: "res" });
  const tile = (id, label, note, withAmt) => {
    const d = el("div", { class: "rt" });
    d.append(el("div", { class: "l" }, label), el("div", { class: "v", id }, "–"));
    if (withAmt) d.append(el("div", { class: "amt", id: `${id}-amt` }, "–"));
    d.append(el("div", { class: "n" }, note));
    return d;
  };
  inner.append(el("div", { class: "card-head", style: "margin:16px 0 0" },
    el("span", { class: "card-title" }, "② 결과는 이렇게 읽습니다"),
    /* B3 판정 — 화면에 적힌 산식과 코드가 **글자 단위로** 같아야 한다.
       ±억원은 소수 둘째 자리까지 반올림한 변동성에 입력 금액 합계를 곱한 값이고,
       그 세 수(합계 · %, 곱)를 전부 같은 줄에 적어 사용자가 직접 검산할 수 있게 한다.
       (큰 타일의 %는 소수 첫째 자리라, 그것으로 곱하면 최대 몇 % 어긋난다.) */
    el("span", { class: "card-sub" }, "±억원 = 입력 금액 합계 × 변동성(소수 둘째 자리) — 줄에 적힌 세 수를 그대로 곱한 값입니다")));
  res.append(
    tile("hg-econ", "경제(시가) 관점 — 1년 변동성", "자산을 시가로 볼 때. 환율이 자산가격을 상쇄해 주는 몫까지 반영", true),
    tile("hg-acct", "회계(손익) 관점 — 1년 손익변동성", "장부가 채권은 가격변동이 손익에 안 잡히고, 환산손익과 스왑 평가손익만 반영", true),
    tile("hg-carry", "연간 헤지 캐리", `Σ 금액 × 헤지비율 × 헤지비용(만기 보간) · ${COST_SIGN_KEY}`));
  inner.append(res);
  /* 숫자 하나만 보여주면 "5.7% 가 큰 건가"에 답할 수 없다. 같은 입력·같은 산식으로
     양 끝(전 통화 0% / 100%)을 같이 계산해 폭을 보여준다 — 임의 기준선이 아니라
     모형이 낼 수 있는 헤지비율의 하한·상한이다. */
  const span = el("div", { class: "howto", id: "hg-span", style: "margin-top:10px" });
  inner.append(span);

  const note = el("div", { class: "howto", style: "margin-top:14px" });
  note.append(explainBox("hedge-sim-try", { label: "③ 이렇게 움직여 보세요" },
    "· 엔 채권에 금액을 넣고 헤지비율을 0%로 내려 보세요 — 회계 손익변동성과 연간 캐리가 함께 나빠집니다.",
    el("br"), "· 달러 주식 헤지를 100%로 올려 보세요 — 경제 변동성이 오히려 커집니다(환율이 덜어 주던 몫을 없애기 때문).",
    el("br"), "· 만기를 3 → 12개월로 바꿔 보세요 — 조건은 오래 고정되지만 평가손익 민감도(τ)가 4배가 됩니다.",
    el("br"), el("b", {}, "산식"),
    ` — 회계 손익 모형 5항 분해와 공분산 표본(${H2.sim.sample}, ${H2.sim.n_months}개월)은 환헤지 화면 맨 아래 방법론 패널에 있습니다. 위안 행은 단기금리·헤지비용 데이터를 확보하면 자동으로 켜집니다.`));
  inner.append(note);

  const IX = Object.fromEntries(H2.sim.labels.map((l, i) => [l, i]));
  const COV = H2.sim.cov;
  const N = H2.sim.labels.length;
  const mmap = Object.fromEntries(H2.matrix.map((m) => [m.c, m]));

  const qf = (x, tot) => {
    let s = 0;
    for (let i = 0; i < N; i++) {
      if (!x[i]) continue;
      for (let j = 0; j < N; j++) if (x[j]) s += x[i] * x[j] * COV[i][j];
    }
    return Math.sqrt(Math.max(s, 0)) / tot * 100;
  };

  /* 노출벡터 조립 — 산식은 예전 recalc 안에 있던 것 **그대로**다.
     hOverride 를 주면 모든 행의 헤지비율을 그 값(0~1)으로 강제해 같은 코드로 양 끝점을
     계산한다. 화면의 「전 통화 0% / 지금 / 전 통화 100%」 표가 여기서 나온다. */
  function assemble(tenor, hOverride) {
    const tau = tenor / 24;                       // 평균 잔존만기 τ (년) = 만기 ÷ 2
    const xe = new Array(N).fill(0), xa = new Array(N).fill(0);
    let tot = 0, carry = 0;
    const per = {};
    for (const [id, o] of Object.entries(inputs)) {
      const r = o.cfg;
      const A = Math.max(0, +o.amt.value || 0);              // 음수 입력 차단
      const hIn = Math.min(1, Math.max(0, (+o.slider.value || 0) / 100));
      const h = hOverride == null ? hIn : hOverride;
      const q = o.book ? Math.min(1, Math.max(0, (+o.book.value || 0) / 100)) : 0;
      if (r.dis || !A) { per[id] = null; continue; }
      const eK = IX[`e_${r.cur}`], dsK = IX[`ds_${r.cur}`];
      const bK = r.kind === "eq" ? IX.eq : IX[`b_${r.cur}`];
      if (eK == null || bK == null) { per[id] = null; continue; }  // 데이터 계약 불일치 가드 (예: CNY 조기 활성화)
      tot += A;
      const cost = hedgeCostAt(mmap[r.cur], tenor);
      const k = A * h * cost / 100;
      carry += k;
      per[id] = { cost, carry: k };
      if (r.kind === "eq") {
        xe[bK] += A; xa[bK] += A;
        xe[eK] += A * (1 - h); xa[eK] += A * (1 - h);
      } else {
        xe[bK] += A;                       // 경제: 가격변동 전액
        xa[bK] += A * (1 - q);             // 회계: 시가 채권만 가격손익
        xe[eK] += A * (1 - h); xa[eK] += A * (1 - h);
      }
      // 스왑 MTM (회계): 헤지 명목 전체(채권·주식)에 인식
      if (dsK != null) xa[dsK] += -A * h * tau;
    }
    return { xe, xa, tot, carry, per };
  }

  const carryTxt = (v) => `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), 0)}억/년`;

  function recalc(save = true) {
    const tenor = Math.min(12, Math.max(3, +tenorInput.value || H2.default_tenor_m || 9));
    costTh.textContent = `만기 ${tenor}개월, 연 %, ${COST_SIGN_KEY}`;
    const aum = Math.max(0, +aumInput.value || 0);
    const state = { rows: {}, tenor, total_aum: aum || null };
    for (const [id, o] of Object.entries(inputs)) {
      const h = Math.min(1, Math.max(0, (+o.slider.value || 0) / 100));
      o.hlbl.textContent = `${Math.round(h * 100)}%`;
      state.rows[id] = { amt: Math.max(0, +o.amt.value || 0),
        book: o.book ? Math.min(100, Math.max(0, +o.book.value || 0)) : null, h: h * 100 };
      /* 배지는 **지금 그 칸에 들어 있는 값의 출처**를 말해야 한다. 사용자가 손대는
         순간 유도·예시가 아니라 「우리 값」이 된다 — 배지와 실제 값의 출처가
         어긋나면 배지가 거짓말이 된다. */
      const badge = document.getElementById(`hg-s-${id}`);
      if (badge && +o.amt.value !== o.cfg.amt) badge.textContent = AMT_SRC.input;
    }
    const cur = assemble(tenor, null);
    /* 행별 헤지비용·캐리 — 세 번째 타일의 근거를 그 자리에서 보여준다 */
    for (const [id, o] of Object.entries(inputs)) {
      const p = cur.per[id];
      o.costCell.textContent = "";
      o.carryCell.textContent = "";
      if (!p) { o.costCell.append("–"); o.carryCell.append("–"); continue; }
      o.costCell.append(fmtCost(+p.cost.toFixed(2), true));
      o.carryCell.append(el("span", { class: p.carry >= 0 ? "pos" : "neg" }, carryTxt(p.carry)));
    }
    if (save) {
      /* `iaw-hedge-input` 에만 쓴다 — `iaw-alloc` 은 읽기 전용이다.
         allocSaveState() 가 저장 시 state 전체를 덮어쓰므로, 여기서 alloc 에 쓰면
         자산배분 화면의 다음 저장에 조용히 지워진다. */
      try { localStorage.setItem(HEDGE_LS_KEY, JSON.stringify(state)); } catch {}
    }
    const spanBox = $("#hg-span");
    const setAmt = (id, txt) => { const n = $("#" + id); if (n) n.textContent = txt; };
    if (!cur.tot) {
      $("#hg-econ").textContent = "–";
      $("#hg-acct").textContent = "–";
      const c0 = $("#hg-carry");
      c0.textContent = "–";
      c0.style.color = "";
      setAmt("hg-econ-amt", "금액을 입력하면 계산됩니다");
      setAmt("hg-acct-amt", "금액을 입력하면 계산됩니다");
      if (spanBox) spanBox.textContent = "금액을 입력하면 계산됩니다.";
      return;
    }
    const se = qf(cur.xe, cur.tot), sa = qf(cur.xa, cur.tot);
    $("#hg-econ").textContent = fmtNum(se, 1) + "%";
    $("#hg-acct").textContent = fmtNum(sa, 1) + "%";
    /* 퍼센트만 보여 주면 "그래서 얼마냐" 가 안 읽힌다 — 같은 수에 입력 금액 합계를 곱한
       억원을 바로 아래 붙인다. 화면 문구와 **글자 단위로 같은** 산식을 쓰기 위해 소수 둘째
       자리로 반올림한 변동성을 쓰고, 그 세 수를 전부 줄에 적어 검산이 되게 한다. */
    const amtLine = (id, sigma) => {
      const s2 = Math.round(sigma * 100) / 100;
      setAmt(id, `${fmtNum(cur.tot, 0)}억 × ${fmtNum(s2, 2)}% = ±${fmtNum(cur.tot * s2 / 100, 0)}억/년`);
    };
    amtLine("hg-econ-amt", se);
    amtLine("hg-acct-amt", sa);
    const cEl = $("#hg-carry");
    cEl.textContent = carryTxt(cur.carry) + (cur.carry >= 0 ? " 받음" : " 지불");
    cEl.style.color = cur.carry >= 0 ? "var(--down-ink)" : "var(--up-ink)";

    if (spanBox) {
      const lo = assemble(tenor, 0), hi = assemble(tenor, 1);
      spanBox.textContent = "";
      spanBox.append(el("b", {}, `지금 숫자가 큰 건지 작은 건지 — 같은 금액·만기 ${tenor}개월로 양 끝을 계산하면`));
      const st = el("table", { class: "mini-table" },
        el("tr", {}, el("th", {}, ""), el("th", {}, "경제 변동성"),
          el("th", {}, "회계 손익변동성"), el("th", {}, "연간 헤지 캐리")));
      [["전 통화 헤지 0%", lo], ["지금 입력한 비율", cur], ["전 통화 헤지 100%", hi]]
        .forEach(([label, s], i) => st.append(el("tr", { style: i === 1 ? "font-weight:700" : "" },
          el("th", { class: "rowhead" }, label),
          el("td", { class: "num" }, fmtNum(qf(s.xe, s.tot), 1) + "%"),
          el("td", { class: "num" }, fmtNum(qf(s.xa, s.tot), 1) + "%"),
          el("td", { class: "num" }, el("span", { class: s.carry >= 0 ? "pos" : "neg" }, carryTxt(s.carry))))));
      spanBox.append(wrapTable(st));
      spanBox.append(explainBox("hedge-span-read",
        "양 끝은 임의 기준선이 아니라 이 모형이 낼 수 있는 헤지비율의 하한·상한입니다(장부가 비중·금액·만기는 지금 입력 그대로)."));
    }
  }
  /* 총자산을 고치면 **아직 손대지 않은** 행의 금액만 다시 유도한다.
     직접 넣은 값을 덮으면 사용자가 방금 입력한 숫자가 사라진다. */
  aumInput.addEventListener("input", () => {
    const fresh = hedgeRows(H2, { total_aum: +aumInput.value || null });
    fresh.forEach((f) => {
      const o = inputs[f.id];
      if (!o) return;
      const untouched = +o.amt.value === o.cfg.amt;      // cfg.amt = 직전에 유도/제시한 값
      if (untouched) { o.amt.value = String(f.amt); o.cfg.amt = f.amt; }
      const badge = document.getElementById(`hg-s-${f.id}`);
      if (badge && untouched) badge.textContent = f.src || AMT_SRC.sample;
    });
    setAumNote();
  });
  inner.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => recalc()));
  recalc(false);
  /* 맨 위로 올리는 것은 openOverlayShell() 이 이미 한다 — 여기서 지역변수 ov 를 다시
     들여다보면 ReferenceError 로 시뮬레이터가 통째로 죽는다. */
}

/* ================= 자산배분 — 수학 엔진 (DOM 없음 · node 교차검증 대상) =================
   원본 수익률은 브라우저에 오지 않는다. alloc.json 의 원천 10개 공분산(연율, 소수²)을
   선형 재조립해 자산군 공분산·σ·앵커·μ를 만들고, 투영 경사법으로 최적화한다.
   산식은 pipeline/alloc.py 와 1:1 — 한쪽만 고치면 안 된다. */

function amDot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function amMv(C, w) { return C.map((row) => amDot(row, w)); }
function amQuad(w, C) { return amDot(w, amMv(C, w)); }

/* 박스 ∩ {합=total} 유클리드 투영 — 이분 40회 (alloc.py project 와 동일) */
function amProject(w, lo, hi, total) {
  let a = -2, b = 2;
  const clipSum = (m) => {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += Math.min(hi[i], Math.max(lo[i], w[i] + m));
    return s;
  };
  for (let k = 0; k < 40; k++) {
    const m = (a + b) / 2;
    if (clipSum(m) > total) b = m; else a = m;
  }
  const m = (a + b) / 2;
  return w.map((v, i) => Math.min(hi[i], Math.max(lo[i], v + m)));
}

/* 그룹 상한(예: 해외 합계 ≤ cap)이 있으면 Dykstra 교대투영 (Boyle–Dykstra 1986) */
function amProjectSet(w, lo, hi, total, groups) {
  const gs = (groups || []).filter((g) => g.cap != null && g.idx.length);
  if (!gs.length) return amProject(w, lo, hi, total);
  const sets = [(v) => amProject(v, lo, hi, total)];
  gs.forEach((g) => sets.push((v) => {
    let s = 0;
    g.idx.forEach((i) => { s += v[i]; });
    if (s <= g.cap) return v.slice();
    const d = (s - g.cap) / g.idx.length;
    const r = v.slice();
    g.idx.forEach((i) => { r[i] -= d; });
    return r;
  }));
  let x = w.slice();
  const corr = sets.map(() => w.map(() => 0));
  for (let it = 0; it < 15; it++) {
    for (let k = 0; k < sets.length; k++) {
      const y = x.map((v, i) => v + corr[k][i]);
      const z = sets[k](y);
      corr[k] = y.map((v, i) => v - z[i]);
      x = z;
    }
  }
  return x;
}

/* λ-효용 MVO: max μ'w − (λ/2)·w'Σw — 시변·창 민감도 카드의 목적함수.
   단위: **소수 기준**(μ 소수, Σ 소수² — 교과서 관례라 λ=1 이 통상적 저위험회피).
   내부 C 는 %²·mu 는 % 라서 여기서 환산한다. 투영은 amOptimize 와 같은 한 벌. */
function amOptimizeUtil(mu, C, lo, hi, total, lam, groups, iters) {
  iters = iters || 3000;
  let w = amProjectSet(mu.map(() => total / mu.length), lo, hi, total, groups);
  for (let t = 0; t < iters; t++) {
    const g = amMv(C, w);
    for (let i = 0; i < g.length; i++) g[i] = lam * g[i] / 1e4 - mu[i] / 100;
    let gm = 1e-12;
    for (const v of g) gm = Math.max(gm, Math.abs(v));
    w = amProjectSet(w.map((v, i) => v - 0.02 * g[i] / gm), lo, hi, total, groups);
  }
  return w;
}

/* 투영 경사법 + (목표수익) 쌍대 상승 — alloc.py optimize 이식본 */
function amOptimize(mu, C, lo, hi, total, target, groups, iters) {
  iters = iters || 3000;
  let w = amProjectSet(mu.map(() => total / mu.length), lo, hi, total, groups);
  let lam = 0;
  for (let t = 0; t < iters; t++) {
    const g = amMv(C, w);
    if (lam) for (let i = 0; i < g.length; i++) g[i] -= lam * mu[i];
    let gm = 1e-12;
    for (const v of g) gm = Math.max(gm, Math.abs(v));
    w = amProjectSet(w.map((v, i) => v - 0.02 * g[i] / gm), lo, hi, total, groups);
    if (target != null) lam = Math.max(0, lam + 3 * (target - amDot(mu, w)));
  }
  return w;
}

/* 자산군 우주는 **시가 기준 7축 하나**다(2026-08-12 사용자 지시 — 장부가 축 제거 §7.7.11).
   장부가 BM 은 원가법이라 손익변동 σ(실측 0.18%/0.17%)가 시장위험을 나르지 않아 같은
   MVO 방법론을 적용할 수 없고, 장부 보유분의 경제적 위험은 시가 축이 나른다(구 경제
   관점의 채권 쌍 합산 규칙 그대로 — 이관도 같은 fold 를 쓴다). 이때 회계 9축·관점
   토글·장부가 합산 상한(cap_book)·북일드(by_kr/by_fx)가 함께 폐지됐다.
   대체투자는 지분형/대출형 두 분류다(2026-08-12 사용자 지시). 삽입 위치가 계약이다 —
   해외채권 index 1·해외주식 index 3 을 xeOf/hedgePairForXe 가 쓰므로 그 앞을
   건드리지 말 것. 두 분류의 위험은 CMA 층의 분류별 팩터 매핑(cmaAltRows)이 정하고,
   프록시층은 같은 프록시를 공유한다(pipeline/alloc.py loadings 와 동일 규약).
   대출금은 배분 우주에서 제외 — 7개가 합 100. */
const ALLOC_ECON = ["국내채권", "해외채권", "국내주식", "해외주식",
                    "대체투자(대출형)", "대체투자(지분형)", "단기자금"];
const ALLOC_ALT_KEYS = ["대체투자(지분형)", "대체투자(대출형)"];
const allocIsAlt = (k) => k === "대체투자(지분형)" || k === "대체투자(대출형)";
/* 좁은 표 머리글용 축약 — slice(0,4)는 두 분류를 구분하지 못한다 */
const ALLOC_SHORT = { "대체투자(지분형)": "대체(지분)", "대체투자(대출형)": "대체(대출)" };
const allocShortK = (k) => ALLOC_SHORT[k] || k.slice(0, 4);

/* 상태 + alloc.json → 그 자리에서 계산 가능한 엔진 객체 */
/* 실측 HP 곡선(3/6/12M)을 가중평균 스왑 만기(개월)로 선형 보간.
   12M 초과는 12M 값 고정(호가 없음 — 화면 명시). pipeline/alloc.py 의 hp_cost_at 과 동일 산식. */
function allocHpAt(curve, tenorM) {
  const xs = [3, 6, 12], ys = [curve["3M"], curve["6M"], curve["12M"]];
  const t = Math.min(12, Math.max(3, +tenorM || 9));
  let i = 0;
  while (i < xs.length - 2 && t > xs[i + 1]) i++;
  const w = (t - xs[i]) / (xs[i + 1] - xs[i]);
  return +(ys[i] + w * (ys[i + 1] - ys[i])).toFixed(3);
}

function allocEngine(A, st) {
  const set = A.sets.find((s) => s.key === st.start_key) || A.sets[0];
  const L = A.sources.labels;
  const ix = {};
  L.forEach((l, i) => { ix[l] = i; });
  const S = set.cov;                       // 10×10, 연율, (소수)²
  const n = L.length;
  const R = A.rates;
  const costOpt = A.cost_options.find((o) => o.key === st.cost_key) || A.cost_options[0];
  /* HP 옵션은 곡선(3/6/12M)을 가중평균 만기로 보간 — 12M 초과는 12M 값 고정(호가 없음) */
  const cost = costOpt.curve ? allocHpAt(costOpt.curve, st.tenor_m) : costOpt.v;
  const hb = st.h_bond / 100, he = st.h_eq / 100, tau = st.tenor_m / 24;
  const sigAlt = Math.sqrt(S[ix.alt][ix.alt]) * 100;
  const kAlt = sigAlt > 0 ? st.alt_vol / sigAlt : 0;
  /* spx02 표본은 ACWI 가 표본 밖(행·열 0) — 프록시를 강제한다 */
  const proxy = set.proxy_only || (ix[st.proxy] != null ? st.proxy : "acwi");

  const zero = () => new Array(n).fill(0);
  const rowKr = zero(); rowKr[ix.kr_bond] = 1;
  const rowCash = zero(); rowCash[ix.cash] = 1;
  const rowKospi = zero(); rowKospi[ix.kospi] = 1;
  const rowAlt = zero(); rowAlt[ix.alt] = kAlt;
  const rowUsb = (h) => { const r = zero(); r[ix.us_bond] = 1; r[ix.e_usd] = 1 - h; r[ix.swap] = h; return r; };
  const rowEq = (h) => { const r = zero(); r[ix[proxy]] = 1; r[ix.e_usd] = 1 - h; r[ix.swap] = h; return r; };

  const sigOf = (row) => Math.sqrt(Math.max(amQuad(row, S), 0)) * 100;

  /* ---- 위험 원천(데이터층) — §7.7: 벤치마크 CMA 기본, 구 벤더 프록시는 대조·비상용.
     CMA 비활성이거나 필요한 라벨이 없으면 조용히 프록시로 물러나되 layerNote 로
     화면에 밝힌다(조용한 대체는 금지 — 실패 처리 규약과 같은 정신). ---- */
  const cmaAll = A.cma && A.cma.active ? A.cma : null;
  let layer = st.src === "proxy" ? "proxy" : "cma";
  let layerNote = null;
  if (layer === "cma" && !cmaAll) {
    layer = "proxy";
    layerNote = A.cma && A.cma.reason
      ? `벤치마크 CMA 비활성 — ${A.cma.reason}` : "벤치마크 CMA 없음 — 프록시로 계산";
  }
  /* 자산군 7키 → CMA 라벨. 채권·주식은 시가 벤치마크, 단기자금은 장부가 단기자금
     계열이 정의상 그 자산이다(현금성 — 원가와 시가가 사실상 같다). 대체투자 두
     분류는 벤치마크 계열 하나(시가 대체투자)를 공유한다 — 분류별 위험 구분은
     벤치마크가 아니라 분류별 팩터 매핑(cmaAltRows)이 만든다. 장부가 채권 계열은
     BM 파일에 여전히 게시되지만(coverage 진단용) 여기서는 더 이상 요구하지도
     사용하지도 않는다(§7.7.11). */
  const CMA_LBL = {
    국내채권: "시가 국내채권", 해외채권: "시가 해외채권",
    국내주식: "시가 국내주식", 해외주식: "시가 해외주식",
    "대체투자(지분형)": "시가 대체투자", "대체투자(대출형)": "시가 대체투자",
    단기자금: "장부가 단기자금",
  };
  let cmaW = null, cmaCI = null;
  if (layer === "cma") {
    const have = new Set(cmaAll.cols);
    const missing = [...new Set(Object.values(CMA_LBL))].filter((lb) => !have.has(lb));
    if (missing.length) {
      layer = "proxy";
      layerNote = `벤치마크 CMA 에 자산군 누락(${missing.join(", ")}) — 프록시로 계산`;
    } else {
      cmaW = cmaAll.windows.find((w) => w.key === st.cma_win)
        || cmaAll.windows[cmaAll.windows.length - 1];
      cmaCI = {};
      cmaAll.cols.forEach((c, i) => { cmaCI[c] = i; });
    }
  }
  const cmaSig = (lb) => Math.sqrt(Math.max(cmaW.cov[cmaCI[lb]][cmaCI[lb]], 0)) * 100;
  /* 환율 축이 실제로 있는가 — 없으면 헤지비율이 위험을 전혀 못 바꾸므로(모든
     (hb,he) 동점) 헤지 참고치는 허구가 된다. 재점검 발견: 이 상태에서 예전엔
     "완전헤지 100/100 최적"이 나갔다 — 무한 동점 중 임의 구석이었다. */
  const fxLive = layer !== "cma" || (cmaCI != null && cmaCI["_fx"] != null);

  /* σ 키인(§7.7.8) — 라벨별 배율 sigScale 을 만들어 행렬을 D·M·D 로 갈아끼운다.
     상관은 불변(벤치마크 실측 ρ), σ 만 사용자 값. 키인 σ 는 **그 계열의 BM 과 같은
     환 기준**이다 — 계열마다 다르다(해외채권 h₀=1 헤지 / 해외주식 h₀=0 미헤지,
     §7.7.19). 즉 해외주식 σ 를 키인할 때 넣는 값은 **환노출을 포함한** 값이어야 하고,
     로딩은 거기서 (h₀ − h) 만큼만 조정한다. **앵커는
     관측 σ 를 유지한다** — 앵커는 시장이 위험 1단위에 주는 관측 보상이라 키인으로
     오염되면 "관측" 출처 표기가 거짓이 된다. 반면 주식 μ 디폴트(무위험+샤프×σ)의
     σ 는 유효(키인) 값을 쓴다 — 동일 샤프 논리는 실제로 지는 위험에 걸리는 것. */
  const sigScale = {};
  if (layer === "cma" && st.sig_over) {
    Object.entries(CMA_LBL).forEach(([k, lb]) => {
      /* 대체투자 두 분류는 σ 키인 대상이 아니다 — 위험은 분류별 팩터 매핑이 정하고
         (매핑 콘솔에서 조정), 두 키가 같은 라벨을 공유해 배율이 충돌하기도 한다. */
      if (allocIsAlt(k)) return;
      const v = st.sig_over[k];
      if (v == null || !isFinite(+v) || +v <= 0) return;
      const base = cmaSig(lb);
      if (base > 1e-9) sigScale[lb] = +v / base;
    });
  }
  const cmaSigEff = (lb) => cmaSig(lb) * (sigScale[lb] || 1);
  function scaleCmaM(M) {
    if (!Object.keys(sigScale).length) return M;
    const d = cmaAll.cols.map((c) => sigScale[c] || 1);
    return M.map((row, i) => row.map((v, j) => v * d[i] * d[j]));
  }

  /* 앵커 — 각 시장 자국통화 기준(승인 ⑤-ⓑ). 헤지 슬라이더와 완전히 무관 —
     헤지비율은 기대수익에 비용항(h×cost)으로만, 위험에 환노출(1−h)로만 들어간다.
     σ 는 활성 데이터층에서 온다 — CMA 의 **해외채권** 벤치마크는 환노출 제거 기준이라
     (실측 β_fx = −0.05) "자국통화 기준" 요건에 부합한다. **이 성질을 해외주식 벤치마크로
     일반화하지 말 것** — 그쪽은 미헤지다(β_fx = +1.00, §7.7.19). 다만 주식 앵커는 BM 이
     아니라 벤더 프록시(ix[proxy], 자국통화 표시)를 쓰므로 이 자리는 영향이 없다. */
  const rowUsbLoc = zero(); rowUsbLoc[ix.us_bond] = 1;
  const rowEqLoc = zero(); rowEqLoc[ix[proxy]] = 1;
  function anchorLocal() {
    const premKr = R.kr5y.v - R.kr3m.v;
    const premUs = R.us_ytm.v - R.us3m.v;
    const sKr = layer === "cma" ? cmaSig("시가 국내채권") : sigOf(rowKr);
    const sUs = layer === "cma" ? cmaSig("시가 해외채권") : sigOf(rowUsbLoc);
    return { value: (premKr / sKr + premUs / sUs) / 2,
             kr: { prem: premKr, sigma: sKr }, us: { prem: premUs, sigma: sUs } };
  }

  function muEconAt(hbX, heX, anchor) {
    const a = anchor || anchorLocal();
    const sKospi = layer === "cma" ? cmaSigEff("시가 국내주식") : sigOf(rowKospi);
    const sEqLoc = layer === "cma" ? cmaSigEff("시가 해외주식") : sigOf(rowEqLoc);
    return [R.kr5y.v,
            R.us_ytm.v + hbX * cost,
            R.kr3m.v + a.value * sKospi,
            R.us3m.v + a.value * sEqLoc + heX * cost,
            R.cpi.v + st.alt_alpha,      // 대체투자(대출형) — CPI+α [가정] (키인이 대체)
            R.cpi.v + st.alt_alpha,      // 대체투자(지분형) — 같은 자리표시자
            R.kr3m.v];
  }

  /* 기대수익 키인(§7.7.10, 2026-08-12 사용자 지정 디폴트) — 키인은 **최종치**
     (헤지비용 반영 후 원화 기대수익, 사용자 CMA 정본)로 base 를 통째로 대체하고
     캐리를 다시 더하지 않는다(중복 가산 금지 — 구 「캐리 별도 가산」 규약 폐지).
     헤지 슬라이더는 μ 가 아니라 위험(환노출 (1−h))으로만 작동한다. 미입력 자산만
     앵커/관측+캐리 폴백. 구 북일드(by_kr/by_fx)는 장부가 축과 함께 폐지(§7.7.11). */
  function applyMuOver(keys, mu) {
    keys.forEach((k, i) => {
      const v = st.mu_over ? st.mu_over[k] : null;
      if (v == null || !isFinite(v)) return;
      mu[i] = +v;
    });
    return mu;
  }

  function buildProxy(hbX, heX) {
    const anchor = anchorLocal();   // 슬라이더 무관 — hbX 는 비용항·로딩에만 쓰인다
    const muE = muEconAt(hbX, heX, anchor);
    /* 대체투자 두 분류는 프록시층에서 같은 행(rowAlt)을 공유한다 — 완전상관이라
       합계 비중이 같으면 총위험이 구 단일 「대체투자」와 정확히 같다. */
    const keys = ALLOC_ECON;
    const rows = [rowKr, rowUsb(hbX), rowKospi, rowEq(heX), rowAlt, rowAlt, rowCash];
    const mu = muE;
    const m = keys.length;
    const C = [];
    for (let i = 0; i < m; i++) {
      const Si = amMv(S, rows[i]);
      C.push([]);
      for (let j = 0; j < m; j++) C[i].push(amDot(rows[j], Si) * 10000);   // %² 단위
    }
    applyMuOver(keys, mu);
    return { keys, rows, mu, C, anchor };
  }

  /* ---- CMA 층 — 자산군 로딩을 벤치마크 열(+보조축)에 직접 건다 --------------
     **BM 계열마다 자체 헤지 스탠스(h₀)가 다르다 — 기관이 자산군별 실제 정책 그대로
     지수를 산출하기 때문이다**(2026-08-17 사용자 확인: "시가해외주식 BM 은 언헤지,
     주식은 오픈이 기본"). 그래서 노출은 **BM + (h₀ − h)·_fx** 이고 h = h₀ 면 보정이
     0 이다. 계열별 h₀ 는 아래 CMA_BM_H0.

     **단순상관으로 판정하지 말 것 — 그렇게 했다가 틀렸다(§7.7.19).** 처음에는
     corr(시가 해외주식, 달러원) ≈ 0 을 보고 「환노출이 포함이면 나올 수 없는 수치」라며
     전 계열을 헤지 기준으로 읽었다. 그러나 ACWI 자체가 달러원과 음의 상관이라(위험회피
     국면에 주가↓·달러↑) **미헤지 원화환산 해외주식은 달러원과의 단순상관이 0 근처로
     상쇄된다** — 두 효과가 서로를 지운다. 갈라내려면 다변량 회귀라야 한다(월간, 실데이터):
       시가 해외주식 ~ ACWI + 달러원 → β(달러원) = **+1.000** (SE 0.027, R² 97.9%,
                                       부표본 4개 전부 0.96~1.06)
       시가 해외채권 ~ 가격효과 + 달러원 → β(달러원) = **−0.048** (SE 0.024)
     방증: 게시 공분산에서 corr(시가 해외주식 − _fx, _fx) = −0.646 으로, 환을 벗기면
     다른 원화 계열(해외채권 −0.589 · 국내채권 −0.612)과 같은 자리에 들어간다.

     구 층의 스왑 MTM 항(d_swap)은 CMA 행렬에 없어 반영되지 않는다(방법론에 명시) —
     그 결과 헤지 위험이 Xe 로 붕괴하지만, 헤지 참고치는 경제 관점 전용으로 둔다. */
  const CMA_BM_H0 = { "시가 해외채권": 1, "시가 해외주식": 0 };
  function cmaAltRows(M) {
    const mcols = cmaAll.cols.length;
    if (st.alt_map.mode === "bm") {
      /* 진단 모드 — 두 분류 모두 벤치마크 계열 그대로(동일 행 = 완전상관) */
      const r = new Array(mcols).fill(0);
      r[cmaCI["시가 대체투자"]] = 1;
      return { rEq: r, rDt: r.slice(), idio: 0 };
    }
    /* 분류별 팩터 매핑(2026-08-12 사용자 지시) — 지분형은 주식 성격이 지배적이고
       대출형은 채권 성격이라 다른 블렌드를 기본으로 둔다(콘솔에서 조정).

       **환헤지(§7.7.20 — 2026-08-19 사용자 지시 "유동적으로 환헤지 하는중").**
       팩터로 쓰는 시가 해외주식은 h₀=0(미헤지)이라 매핑 비율 `we/100` 만큼 환이
       **딸려 들어온다**. 그 몫에 사용자의 대체투자 헤지비율을 걸어 `_fx` 를 뺀다:
       순 환노출 = (we/100)·(1 − h_alt). 매핑이 채권 100%(we=0)면 걸 환이 없어
       비율과 무관하게 0 이 된다 — 분류별 매핑이 달라도 한 비율로 맞게 작동하므로
       슬라이더를 분류마다 두지 않았다(2026-08-19 사용자 선택 「하나로」).
       **Xe 에는 넣지 않는다** — Xe 는 최적화가 고르는 레버(해외채권·해외주식)의
       축이고 이쪽은 모형 입력이라, 합치면 「최적 헤지쌍」이 사용자가 이미 정한 값을
       덮어쓰게 된다. 총 환노출은 `fxLoadW` 가 따로 세고 화면이 Xe 와 구분해 적는다. */
    const hAlt = (isFinite(+st.h_alt) ? +st.h_alt : 90) / 100;
    const mk = (we, wb) => {
      const r = new Array(mcols).fill(0);
      r[cmaCI["시가 해외주식"]] += we / 100;
      r[cmaCI["시가 국내채권"]] += wb / 100;
      const fxi = cmaCI["_fx"];
      /* h₀(시가 해외주식) = 0 이므로 딸려 온 환은 we/100 이고, 그중 h_alt 를 헤지한다.
         부호는 뺄셈이다 — 더하면 헤지가 노출을 늘리는 반대 모형이 된다. */
      if (fxi != null && we !== 0 && hAlt !== 0) r[fxi] -= hAlt * (we / 100);
      return r;
    };
    const am = st.alt_map;
    const num = (v, dflt) => (isFinite(+v) ? +v : dflt);
    const rEq = mk(num(am.eq_we, 50), num(am.eq_wb, 50));
    const rDt = mk(num(am.dt_we, 50), num(am.dt_wb, 50));
    /* 고유위험(잔차) — 팩터의 정확한 선형결합만 넣으면 공분산이 특이행렬이 된다
       (실측: 최소고유값 −1.8e−18 → QP 불정). 디스무딩 보조축(_alt)을 **두 팩터
       (시가 해외주식·시가 국내채권)의 스팬**에 회귀한 잔차분산을 폐형으로 더한다 —
       분류가 둘이라 "블렌드 하나에 대한 잔차"는 더 이상 유일하지 않고, 스팬 잔차는
       매핑 비율과 무관하며 어느 분류 행과도 직교라 유일하게 정의된다.
       잔차는 분류마다 **독립**으로 넣는다(대각 2곳만, 교차항 없음). 두 분류는
       서로 다른 딜의 부분북이라 고유위험이 같은 성분일 이유가 없고, 공유(완전상관)
       잔차로 넣으면 네 행(국내채권·해외주식·지분형·대출형)이 3차원에 갇혀 행렬이
       도로 특이해진다 — 실측: 완전헤지에서 촐레스키 피벗 −2.3e−14. 잔차가 막으려던
       바로 그 병이 재발하므로 공유안은 기각(§7.7.9). */
    let idio = 0;
    const ai = cmaCI["_alt"];
    if (ai != null) {
      const iE = cmaCI["시가 해외주식"], iB = cmaCI["시가 국내채권"];
      const fEE = M[iE][iE], fEB = M[iE][iB], fBB = M[iB][iB];
      const cE = M[iE][ai], cB = M[iB][ai];
      const det = fEE * fBB - fEB * fEB;
      const expl = det > 1e-18
        ? (fBB * cE * cE - 2 * fEB * cE * cB + fEE * cB * cB) / det
        : (fEE > 1e-18 ? cE * cE / fEE : 0);   // 팩터 공선 시 1축 폴백
      idio = Math.max(M[ai][ai] - expl, 0);
    }
    return { rEq, rDt, idio };
  }
  /* M 을 갈아끼울 수 있게 분리 — 시변(롤링)·창 민감도 카드가 같은 로딩·매핑으로
     다른 시점의 공분산을 쓴다. buildCma 는 현재 창을 꽂은 것일 뿐이다. */
  function buildCmaFrom(M0, hbX, heX) {
    const M = scaleCmaM(M0);      // σ 키인 반영 — 상관 불변, σ 만 교체
    const fxi = cmaCI["_fx"];
    const base = (lb) => {
      const r = new Array(cmaAll.cols.length).fill(0);
      r[cmaCI[lb]] = 1;
      return r;
    };
    /* 인자는 (h₀ − h) 이므로 **음수가 정상이다** — h₀=0 인 미헤지 계열을 헤지하면
       _fx 를 뺀다. 예전 가드가 `open > 1e-12` 라 음수를 조용히 버렸으므로 절대값으로
       판정할 것(부호를 살리는 것이 이 함수의 요점이다). */
    const withFx = (r, add) => { if (fxi != null && Math.abs(add) > 1e-12) r[fxi] += add; return r; };
    const alt = cmaAltRows(M);
    const anchor = anchorLocal();
    const muE = muEconAt(hbX, heX, anchor);
    const keys = ALLOC_ECON;
    const rows = [base("시가 국내채권"),
                  withFx(base("시가 해외채권"), CMA_BM_H0["시가 해외채권"] - hbX),
                  base("시가 국내주식"),
                  withFx(base("시가 해외주식"), CMA_BM_H0["시가 해외주식"] - heX),
                  alt.rDt, alt.rEq, base("장부가 단기자금")];
    const mu = muE;
    const m = keys.length;
    const C = [];
    for (let i = 0; i < m; i++) {
      const Mi = amMv(M, rows[i]);
      C.push([]);
      for (let j = 0; j < m; j++) C[i].push(amDot(rows[j], Mi) * 10000);   // %² 단위
    }
    /* 분류별 독립 잔차 — 대각 2곳만(교차항 없음 — cmaAltRows 의 기각 사유 참조).
       합산 잔차 기여는 (w지분² + w대출²)·σ²res 다. */
    const iAe = keys.indexOf("대체투자(지분형)"), iAd = keys.indexOf("대체투자(대출형)");
    if (iAe >= 0 && alt.idio > 0) {
      const add = alt.idio * 10000;
      C[iAe][iAe] += add;
      if (iAd >= 0) C[iAd][iAd] += add;
    }
    applyMuOver(keys, mu);
    return { keys, rows, mu, C, anchor };
  }
  const buildCma = (hbX, heX) => buildCmaFrom(cmaW.cov, hbX, heX);
  const build = layer === "cma" ? buildCma : buildProxy;

  const mix = st.mix;
  const V = build(hb, he);
  const w0 = V.keys.map((k) => (mix[k] || 0) / 100);
  const bands = st.bands;
  const lo = V.keys.map((k) => (bands[k] ? bands[k][0] : 0) / 100);
  const hi = V.keys.map((k) => (bands[k] ? bands[k][1] : 100) / 100);
  const total = w0.reduce((a, b) => a + b, 0);
  const groups = [];
  if (st.cap_foreign != null) {
    groups.push({ label: "해외 합계", cap: st.cap_foreign / 100,
      idx: V.keys.map((k, i) => [k, i]).filter(([k]) => k.includes("해외")).map(([, i]) => i) });
  }
  if (st.cap_equity != null) {
    groups.push({ label: "주식 합계", cap: st.cap_equity / 100,
      idx: V.keys.map((k, i) => [k, i]).filter(([k]) => k.includes("주식")).map(([, i]) => i) });
  }
  /* 구 「장부가 성격 합산 상한」(cap_book)은 장부가 축과 함께 폐지(§7.7.11) —
     현금 쏠림이 문제가 되면 단기자금 밴드 상한이 그 자리다. */

  const sigmaW = (w, C) => Math.sqrt(Math.max(amQuad(w, C), 0));
  const eulerRC = (w, C) => {
    const s = sigmaW(w, C);
    const Cw = amMv(C, w);
    return { s, rc: w.map((wi, i) => s > 0 ? wi * Cw[i] / s : 0) };
  };

  /* 데이터층 표식 — 화면 전 구역이 이 세 값으로 표본·출처 문구를 만든다.
     sample 이 층 중립 진실이고, set 은 프록시층 전용(선택기·부트스트랩)이다. */
  const sample = layer === "cma"
    ? { label: `벤치마크 ${cmaW.key === "all" ? "전체 공통 표본" : cmaW.key + "년 창"}`,
        start: cmaW.start, end: cmaW.end, n_months: cmaW.n_months }
    : { label: set.label, start: set.start, end: set.end, n_months: set.n_months };
  const altInfo = layer === "cma" ? (() => {
    const M = scaleCmaM(cmaW.cov);   // σ 키인 반영 — 화면 진단이 행렬과 같은 수를 말하게
    const a = cmaAltRows(M);
    const num = (v, dflt) => (isFinite(+v) ? +v : dflt);
    const mapped = (r) => Math.sqrt(Math.max(amQuad(r, M) + a.idio, 0)) * 100;
    return {
      mode: st.alt_map.mode,
      /* 분류별 매핑 가중과 결과 σ — 잔차는 분류별 독립 성분이며 σ 는 같은 값을 쓴다 */
      eq: { we: num(st.alt_map.eq_we, 50), wb: num(st.alt_map.eq_wb, 50), mapped: mapped(a.rEq) },
      dt: { we: num(st.alt_map.dt_we, 50), wb: num(st.alt_map.dt_wb, 50), mapped: mapped(a.rDt) },
      obs: cmaSig("시가 대체투자"),
      unsmoothed: cmaCI["_alt"] != null
        ? Math.sqrt(Math.max(M[cmaCI["_alt"]][cmaCI["_alt"]], 0)) * 100 : null,
      idio: Math.sqrt(Math.max(a.idio, 0)) * 100,
      alpha: cmaAll.alt ? cmaAll.alt.alpha : null,
    };
  })() : null;

  return {
    A, st, set, ix, S, cost, costOpt, V, mix, w0, lo, hi, total, groups,
    kAlt, tau, proxy,
    layer, layerNote, cmaAll, cmaW, sample, altInfo, fxLive, sigScale,
    /* 시뮬레이터용 — 자산군의 관측/유효(키인 반영) σ. CMA 층 밖에서는 null */
    cmaSigInfo(k) {
      if (layer !== "cma") return null;
      const lb = CMA_LBL[k];
      return lb ? { obs: cmaSig(lb), eff: cmaSigEff(lb) } : null;
    },
    n_months: sample.n_months,
    anchorLocal, muEconAt, build, sigOf, rowUsb, rowEq, rowKospi, rowKr,
    sigmaW, eulerRC,
    seOf(sig) { return sig / Math.sqrt(2 * sample.n_months); },
    /* 배분 고정 · 헤지 (hbX,heX) 이동 시 총위험 */
    sigmaHedge(hbX, heX) {
      const B = build(hbX, heX);
      return sigmaW(w0, B.C);
    },
    /* --- 헤지 레버의 자유도는 실질 1개다 (pipeline/alloc.py 와 같은 항등식) ---
       로딩에서 두 레버는 같은 방향 g = e_usd − swap 의 스칼라배로만 들어간다:
         x(hb,he) = x1 + [w채(1−hb) + w주(1−he)]·g = x1 + Xe·g
       따라서 같은 Xe 를 만드는 (hb,he) 는 위험이 **정확히** 같다(근사가 아니다).
       한 점을 최적이라 적으면 무한한 동점 중 하나를 임의로 고른 것이 된다. */
    xeOf(hbX, heX) { return w0[1] * (1 - hbX) + w0[3] * (1 - heX); },
    xeOfW(w, hbX, heX) { return w[1] * (1 - hbX) + w[3] * (1 - heX); },
    xeOpen() { return w0[1] + w0[3]; },
    /* 배분이 실제로 지는 **총 환노출** — _fx 열 적재량에 더해, 팩터로 쓴 BM 계열에
       **내재된** 환(계열별 1 − h₀)까지 센다. 매핑 대체투자는 시가 해외주식(h₀=0,
       환 내재)을 팩터로 쓰므로 슬리브당 we/100 의 환을 지고, 거기에 사용자의
       대체투자 헤지비율이 걸려 순 노출이 (we/100)(1 − h_alt) 가 된다(§7.7.20).
       **Xe 와 같은 수가 아니다** — Xe 는 최적화가 고르는 레버(해외채권·해외주식)의
       축이고, 대체투자 헤지는 모형 입력이라 Xe 밖에 있다. 그래서 화면은 둘을 구분해
       적어야 한다(합치면 「최적 헤지쌍」이 사용자가 정한 값을 덮어쓰게 된다).
       프록시 층은 로딩 기저가 달라(e_usd 축을 명시로 얹고 대체투자 기저가 원화라
       환노출이 구조적으로 0) null 을 돌려준다 — 없는 수를 0 으로 지어내지 않는다. */
    fxLoadW(w) {
      if (layer !== "cma" || cmaCI == null || cmaCI["_fx"] == null) return null;
      const f = cmaCI["_fx"];
      let tot = 0;
      V.rows.forEach((row, i) => {
        let c = row[f] || 0;
        Object.keys(CMA_BM_H0).forEach((lb) => {
          const j = cmaCI[lb];
          if (j != null) c += (row[j] || 0) * (1 - CMA_BM_H0[lb]);
        });
        tot += (w[i] || 0) * c;
      });
      return tot;
    },
    /* σ²(Xe) = a0 + 2·a1·Xe + a2·Xe². 정확히 2차식이므로 **세 점이면 계수가 확정**된다
       — 로딩 산식을 여기서 다시 쓰지 않고 σ 를 세 번 재는 편이 어긋날 여지가 없다.
       (hb,he) = (1−t, 1−t) 로 잡으면 Xe = (w채+w주)·t 라 t = 0 / ½ / 1 을 쓴다.
       (구 회계 관점은 d_swap 의 −h·τ 때문에 이 붕괴가 성립하지 않아 가드로 막았었다 —
       장부가 축 폐지로 그 관점 자체가 없어져 가드도 함께 내렸다 §7.7.11.)
       `xeQuadW(w)` 는 임의 배분용 — 시뮬레이터 헤지 2트랙(§7.7.13)이 최적 배분에
       대해 같은 붕괴식을 쓴다(현재 배분 전용이던 것을 w 인자로 일반화). */
    xeQuadW(w) {
      const X = w[1] + w[3];
      if (!(X > 0)) return { a0: sigmaW(w, build(1, 1).C) ** 2, a1: 0, a2: 0, span: 0 };
      const sq = (t) => sigmaW(w, build(1 - t, 1 - t).C) ** 2;
      const s0 = sq(0), s1 = sq(0.5), s2 = sq(1);
      const a2 = 2 * (s2 - 2 * s1 + s0) / (X * X);
      const a1 = (s2 - s0 - a2 * X * X) / (2 * X);
      return { a0: s0, a1, a2, span: X };
    },
    xeQuad() { return this.xeQuadW(w0); },
    sigmaXe(xe, q) {
      const { a0, a1, a2 } = q || this.xeQuad();
      return Math.sqrt(Math.max(a0 + 2 * a1 * xe + a2 * xe * xe, 0));
    },
    /* 위험 최소 Xe — 폐형. 밴드가 주어지면 실행 가능 구간으로 자른다(볼록이라 그것이 제약 하 최소). */
    xeStar(loXe, hiXe, q) {
      const { a1, a2 } = q || this.xeQuad();
      let xe = a2 > 0 ? -a1 / a2 : 0;
      if (loXe != null) xe = Math.max(xe, loXe);
      if (hiXe != null) xe = Math.min(xe, hiXe);
      return xe;
    },
    /* 목표 Xe 를 만드는 (hb,he) 중 **현재값에 가장 가까운** 한 점 — 유클리드 정사영.
       임의 계수 0개이고 해가 폐형이다. 밴드 안에서 불가능하면 null.
       pipeline/alloc.py 의 hedge_pair_for_xe 와 같은 규칙. */
    hedgePairForXe(xe, cur, bands) { return this.hedgePairForXeW(w0, xe, cur, bands); },
    hedgePairForXeW(w, xe, cur, bands) {
      const wb = w[1], we = w[3];
      const [hb0, he0] = cur;
      const [[blo, bhi], [elo, ehi]] = bands;
      const c = wb + we - xe;
      const cl = (v, a, b) => Math.min(Math.max(v, a), b);
      if (wb <= 1e-12 && we <= 1e-12) return [hb0, he0];
      if (we <= 1e-12) return [cl(c / wb, blo, bhi), he0];
      if (wb <= 1e-12) return [hb0, cl(c / we, elo, ehi)];
      const r = wb / we;
      let hb = (hb0 + r * (c / we - he0)) / (1 + r * r);
      const lo = Math.max(blo, (c - we * ehi) / wb);
      const hi = Math.min(bhi, (c - we * elo) / wb);
      if (lo > hi + 1e-12) return null;
      hb = cl(hb, lo, hi);
      return [hb, (c - wb * hb) / we];
    },
    optimize(mu, C, target, iters) {
      return amOptimize(mu, C, lo, hi, total, target, groups, iters);
    },
    /* λ-효용 최적화 — 시변·창 민감도 카드 전용 목적함수 (요약의 ①②와 다르다) */
    optimizeUtil(mu, C, lam, iters) {
      return amOptimizeUtil(mu, C, lo, hi, total, lam, groups, iters);
    },
    /* 같은 λ-효용을 **명시한 합계**로 푼다 — 시뮬레이터의 ① 최적은 목표 100% 기준이라
       자유 조정으로 현재 합계가 표류해도 흔들리면 안 된다(사용자 발견 2026-08-12:
       예산이 현재 합계를 따라가 드래그마다 "최적"이 움직였다 — μ·σ 를 안 건드렸는데
       최적이 변하는 것은 그 자체로 버그 신호가 맞다). */
    optimizeUtilAt(mu, C, lam, totalX, iters) {
      return amOptimizeUtil(mu, C, lo, hi, totalX, lam, groups, iters);
    },
    /* CMA 층 전용 — 임의 시점(롤링)·임의 창의 공분산으로 같은 로딩·매핑을 편다 */
    buildFrom: layer === "cma" ? buildCmaFrom : null,
  };
}

/* 헤지비율 밴드(내규) — 기관 내부정보이므로 **수기 입력**이고, 기본값은 중립(0~100)이다.
   pipeline/alloc.py DEFAULTS.h_bands 와 같은 규약: 코드에 특정 기관의 내규를 박지 않는다.
   반환은 소수 [[채권lo,채권hi],[주식lo,주식hi]]. */
function allocHBands(st) {
  const g = (k, i, dflt) => {
    const b = st.h_bands && st.h_bands[k];
    const v = Array.isArray(b) ? b[i] : null;
    return (v == null || !isFinite(v)) ? dflt : Math.min(Math.max(v, 0), 100) / 100;
  };
  return [[g("해외채권", 0, 0), g("해외채권", 1, 100)],
          [g("해외주식", 0, 0), g("해외주식", 1, 100)]];
}

/* ---- ALM 듀레이션 갭 --------------------------------------------------------
   내규 한도가 **없다**(사용자 확인, 2026-08-05). 따라서 최적화 **제약으로 걸지 않는다**
   — 허용 괴리폭을 지어내면 「자의성 금지」 위반이다. 대신 각 후보 배분의 자산
   듀레이션을 **계산해서 함께 표시**한다: 갭 축소가 내부 목표이므로 "이 배분을 택하면
   갭이 얼마가 되나"가 보이면 그것만으로 의사결정에 쓰인다. 새 계수는 0개다.
   금리위험이 없는 자산군(주식·대체)의 듀레이션은 표준 근사대로 0이다. */
const ALLOC_DUR_KEYS = ["국내채권", "해외채권", "단기자금"];

/* 후보 배분 w(경제 관점 6축, 소수)의 자산 듀레이션 = Σ wᵢ·Dᵢ.
   자산군별 듀레이션을 하나도 입력하지 않았으면 null — 그때는 수기 `dur_asset` 을 쓴다. */
function allocAssetDuration(st, w) {
  const by = st.dur_by || {};
  const has = ALLOC_DUR_KEYS.some((k) => by[k] != null && isFinite(by[k]));
  if (!has) return null;
  let d = 0;
  ALLOC_ECON.forEach((k, i) => {
    const v = ALLOC_DUR_KEYS.includes(k) && by[k] != null && isFinite(by[k]) ? +by[k] : 0;
    d += (w[i] || 0) * v;
  });
  return d;
}

/* 갭 = 자산 듀레이션 − (부채/자산)×부채 듀레이션 (표준 근사). 입력이 없으면 null. */
function allocDurGap(st, dAsset) {
  if (st.dur_liab == null || dAsset == null) return null;
  const laR = st.la_ratio != null ? st.la_ratio : 1;
  return dAsset - laR * st.dur_liab;
}

/* 밴드가 허용하는 Xe 구간 — pipeline/alloc.py xe_range 와 같은 산식. */
function allocXeRange(E, bands) {
  const [[blo, bhi], [elo, ehi]] = bands;
  return [E.xeOf(bhi, ehi), E.xeOf(blo, elo)];
}

/* **환노출 구속의 출처를 한 곳에서 판정한다** (§7.7.17 — 재점검 발견).
   화면에서 이 판정을 쓰는 자리가 셋이다: ① 시뮬레이터 최적 카드 · ② 요약표
   `#alloc-summary` · ③ 헤지 곡면 오버레이. §7.7.16 에서 ① 만 고쳤더니 같은 화면
   안에서 같은 사실에 두 가지 원인 설명이 공존했다(②③ 은 분리 이전의 단일 플래그
   `|xeBand − xeFree| > 1e-9` 를 그대로 쓰고 있었다 — 중립 밴드에서도 「밴드가 물고
   있습니다」가 나갔다. 실데이터 페이로드로 재현함). 세 자리가 이 함수 하나를 부른다.

   Xe 의 실행 가능 구간은 **두 겹**이다:
     ① 구조적 한계 [0, wF] — wF = 해외자산 비중 합. 헤지 100% 를 걸어도 Xe ≥ 0
        (오버헤지 불가), 0% 로 풀어도 Xe ≤ wF. **밴드를 중립까지 풀어도 이 밖은 못 간다.**
     ② 내규 밴드 [xeLo, xeHi] ⊆ ①
   두 구속은 **동시에 성립할 수 있다.** if/else 로 하나만 고르면 그 경우 밴드 문장만
   나가고, 사용자는 지시대로 밴드를 중립까지 풀어도 목표에 못 닿는다 — §7.7.16 이
   없애려던 「틀린 조치로 보낸다」가 그대로 재현된다(실측: 실제 게시 페이로드에서
   λ×헤지하한 28조합 중 **6조합**이 이 상태. 예 λ=30·채권하한 10% → 해외비중 5.00%,
   xeHi 4.50%, xeFree 11.08% 인데 밴드 문장만 출력). 그래서 **집합으로** 돌려주고
   화면이 해당하는 문장을 모두 적는다.

   판정은 xe(수렴 잔차가 섞인 값)가 아니라 **xeFree** 로 하고 허용오차는 상대값이다 —
   비수렴 잔차가 제약 판정으로 새면 아무것도 안 무는 상태에서 경고가 뜬다(실측 λ=100). */
function allocXeBinds(wF, xeLo, xeHi, xeFree) {
  /* `xeNeutral` 은 **밴드를 중립까지 풀었을 때 도달 가능한 최선**이다 — 엔진의
     `E.xeOpen()`(= wF, 헤지 0% 일 때의 노출 그 자체)과 다른 수이므로 이름을 나눈다. */
  const out = { bandBinds: false, capBinds: false, side: null,
                wF, xeFree, xeNeutral: null, xeBand: null };
  if (xeFree == null || wF == null) return out;
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  const tol = 1e-6 * Math.max(1, Math.abs(xeFree));
  const xeNeutral = clamp(xeFree, 0, wF);        // 밴드를 중립까지 풀면 갈 수 있는 곳
  const xeBand = clamp(xeFree, xeLo, xeHi);      // 실제 밴드에서 갈 수 있는 곳
  out.xeNeutral = xeNeutral;
  out.xeBand = xeBand;
  out.capBinds = Math.abs(xeNeutral - xeFree) > tol;   // 구조적 — 밴드를 풀어도 못 간다
  out.bandBinds = Math.abs(xeBand - xeNeutral) > tol;  // 밴드가 그 위에 더 얹은 몫
  if (xeFree > xeBand + tol) out.side = "hi";
  else if (xeFree < xeBand - tol) out.side = "lo";
  return out;
}

/* 위 판정을 **화면 문장**으로 — 세 자리가 같은 copy 를 쓰게 하는 자리다.
   두 문장은 서로 배타가 아니며, 각자 **다른 조치**를 가리킨다:
     · 밴드 → 내규 완화로 얼마가 움직이는지(정확한 두 수를 적는다)
     · 구조 → 밴드로는 해결되지 않는다는 사실 + 진짜 한계가 무엇인지
   하한 물림(side "lo")에 상한 문안을 쓰지 않는다 — 그때의 구속은 해외자산 비중이
   아니라 「오버헤지 불가(Xe ≥ 0)」이고, 비중을 원인으로 지목하면 성립하지 않는
   설명이 된다(재점검 발견). */
function allocXeBindNotes(b) {
  const out = [];
  if (!b) return out;
  const pc = (x, d) => fmtNum(x * 100, d == null ? 2 : d);
  if (b.bandBinds) {
    out.push(`헤지 밴드(내규 키인)가 구간을 좁힙니다 — 밴드를 중립(0~100%)까지 풀면 `
      + `Xe ${pc(b.xeBand)}% → ${pc(b.xeNeutral)}%`);
  }
  if (b.capBinds) {
    out.push(b.side === "lo"
      ? `환노출은 음수가 될 수 없습니다(오버헤지 불가) — 헤지를 100%까지 걸어도 Xe 하한은 `
        + `0%라 무제약 위험최소 Xe ${pc(b.xeFree)}% 에는 닿지 않습니다`
      : `해외자산 비중(${pc(b.wF, 1)}%)이 환노출의 상한입니다 — 헤지를 0%까지 풀어도 `
        + `무제약 위험최소 Xe ${pc(b.xeFree)}% 에는 닿지 않습니다(밴드 문제가 아닙니다)`);
  }
  return out;
}

/* 실행 불가능한 제약 입력을 침묵 속에 흡수하지 않는다 — pipeline/alloc.py
   check_feasible 와 같은 규칙 + 그룹 상한의 두 가지 모순까지 검사. */
function allocFeasibility(E) {
  const probs = [];
  const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d);
  const sumLo = E.lo.reduce((a, b) => a + b, 0);
  const sumHi = E.hi.reduce((a, b) => a + b, 0);
  if (sumLo > E.total + 1e-9) probs.push(`밴드 하한 합 ${pct(sumLo)}% > 투자 합계 ${pct(E.total)}%`);
  if (sumHi < E.total - 1e-9) probs.push(`밴드 상한 합 ${pct(sumHi)}% < 투자 합계 ${pct(E.total)}%`);
  E.groups.forEach((g) => {
    const gLo = g.idx.reduce((a, i) => a + E.lo[i], 0);
    if (g.cap < gLo - 1e-9) probs.push(`${g.label} 상한 ${pct(g.cap, 0)}% < 소속 자산 하한 합 ${pct(gLo)}%`);
    const others = E.hi.reduce((a, h, i) => a + (g.idx.includes(i) ? 0 : h), 0);
    if (g.cap + others < E.total - 1e-9)
      probs.push(`${g.label} 상한 ${pct(g.cap, 0)}% + 나머지 상한 합 ${pct(others)}% < 투자 합계 ${pct(E.total)}%`);
  });
  return probs;
}

/* ---- 시변·창 민감도 카드 — λ-효용 MVO 로 표본을 바꿔 가며 최적 배분 재계산 ----
   목적함수는 요약의 ①②(위험최소·수익유지)와 **다른 세 번째 참고축**이다:
   max μ'w − (λ/2)·w'Σw, λ = 시뮬레이터의 위험회피계수 키인(소수 단위, 기본 1 —
   2026-08-12 부터 화면에서 선택). μ·밴드·그룹 한도·대체투자 매핑·헤지비율은 현재 설정으로 **고정**하므로
   경로의 움직임은 위험 구조(σ·상관)의 변화만 반영한다 — 롤링 실현 평균을 μ 로
   쓰는 문은 일부러 열지 않았다(§7.7: 과거 평균을 기대수익으로 쓰지 않는다). */
function renderAllocTv(box, E, st, pal, rerender) {
  /* 차트 등록부를 allocCharts 와 분리한다 — 이 카드는 recalc 의 타이머 **밖**에서
     그려지는데, 타이머가 allocCharts 를 전부 파괴하고 다시 그리므로 같은 등록부를
     쓰면 방금 만든 시변 차트가 120ms 뒤에 소리 없이 죽는다. */
  allocTvCharts.forEach(destroyChart);
  allocTvCharts = [];
  box.textContent = "";
  if (E.layer !== "cma") {
    box.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "최적 배분의 표본 민감도 — 벤치마크 층 전용")),
      el("div", { class: "card-sub" },
        "위험 원천을 기관 벤치마크(CMA)로 두면 창 민감도와 시변(롤링) 경로가 표시됩니다."));
    return;
  }
  const lam = +st.mvo_lambda || 1;
  const hb = st.h_bond / 100, he = st.h_eq / 100;
  const optAt = (M) => {
    const B = E.buildFrom(M, hb, he);
    const w = E.optimizeUtil(B.mu, B.C, lam, 1500);
    return { B, w, sig: E.sigmaW(w, B.C), mu: amDot(B.mu, w) };
  };
  const tvAll = E.cmaAll.tv || [];
  const mode = tvAll.length && st.tv_mode === "roll" ? "roll" : "win";
  const modeSeg = el("div", { class: "seg", role: "group" });
  const mkMode = (label, v, disabled, title) => {
    const b = el("button", { class: mode === v ? "active" : "",
      onclick: () => { st.tv_mode = v; allocSaveState(st); rerender(); } }, label);
    if (disabled) { b.disabled = true; if (title) b.title = title; }
    return b;
  };
  modeSeg.append(mkMode("시변(롤링)", "roll", !tvAll.length, "롤링 데이터 없음"),
                 mkMode("창 민감도", "win"));
  const note = () => explainBox("alloc-tv-note",
    "목적함수 max μ'w − (λ/2)·w'Σw — 요약의 ①②(위험최소·수익유지)와 다른 세 번째 참고축입니다. ",
    el("b", {}, "μ·밴드·그룹 한도·대체투자 매핑·헤지비율은 현재 설정으로 고정"),
    " — 움직임은 위험 구조(σ·상관)의 변화만 반영합니다(롤링 실현 평균을 μ 로 쓰지 않습니다). λ 는 시뮬레이터에서 바꿉니다.");

  if (mode === "roll") {
    const blk = tvAll.find((b) => b.key === String(st.tv_len)) || tvAll[tvAll.length - 1];
    const lenSeg = el("div", { class: "seg", role: "group" });
    tvAll.forEach((b) => lenSeg.append(el("button", { class: b.key === blk.key ? "active" : "",
      onclick: () => { st.tv_len = b.key; allocSaveState(st); rerender(); } }, `${b.key}년 롤링`)));
    const pts = blk.cov.map((M, i) => ({ d: blk.dates[i], ...optAt(M) }));
    const keys = pts[0].B.keys;
    const fbox = cardScaffold(box, {
      title: `최적 배분의 시간 경로 — λ-효용 MVO (λ=${fmtNum(lam, 1)}, 소수 단위)`,
      sub: `${blk.key}년 롤링 × ${pts.length}시점 · 시가 기준 7축`,
      csvName: "최적배분_시변.csv",
      controls: el("span", { style: "display:inline-flex;gap:8px;flex-wrap:wrap" }, modeSeg, lenSeg),
      tableFn: () => ({
        headers: ["월말", ...keys.map((k) => k + "%"), "위험%", "수익%"],
        rows: pts.map((p) => [p.d, ...p.w.map((x) => fmtNum(x * 100, 1)),
                              fmtNum(p.sig, 2), fmtNum(p.mu, 2)]),
      }),
    });
    const xs = pts.map((p) => {
      const [y, m] = p.d.split("-").map(Number);
      return +(y + (m - 0.5) / 12).toFixed(3);
    });
    allocTvCharts.push(makeRatioChart(fbox, {
      seriesDefs: keys.map((k, i) => ({ label: k, color: pal.series[i % pal.series.length],
        x: xs, v: pts.map((p) => +(p.w[i] * 100).toFixed(2)) })),
      xLabel: "롤링 창의 끝(월말)", unit: "%", height: 280,
    }));
    box.append(note());
    return;
  }

  /* 창 민감도 — 게시된 고정 창마다 같은 λ-MVO 를 풀어 배분을 나란히 놓는다 */
  const rows = E.cmaAll.windows.map((w) => ({ key: w.key, n: w.n_months, ...optAt(w.cov) }));
  const keys = rows[0].B.keys;
  box.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, `최적 배분의 창 민감도 — λ-효용 MVO (λ=${fmtNum(lam, 1)}, 소수 단위)`),
    el("span", { class: "card-sub" }, "창을 바꾸면 배분이 얼마나 움직이나 · 시가 기준 7축"),
    el("span", {}, modeSeg)));
  const t = el("table", { class: "mini-table" },
    el("tr", {}, ...["창", "개월", ...keys.map((k) => k + "%"), "위험%", "수익%"]
      .map((h) => el("th", {}, h))));
  rows.forEach((r) => {
    t.append(el("tr", {},
      el("td", { style: "text-align:left" }, r.key === "all" ? "전체" : `${r.key}년`),
      el("td", { class: "num" }, String(r.n)),
      ...r.w.map((x) => el("td", { class: "num" }, fmtNum(x * 100, 1))),
      el("td", { class: "num" }, fmtNum(r.sig, 2)),
      el("td", { class: "num" }, fmtNum(r.mu, 2))));
  });
  box.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t), note());
}

/* ---- 포트폴리오 특성 — 비중을 움직일 때 함께 움직이는 계량 지표 한 벌 --------
   전부 활성 층의 Σ·μ 에서 폐형으로 나온다. 유일한 모형치는 포트폴리오 MDD:
   실측 경로 MDD 는 원본 수익률 미게시 계약상 화면에서 계산할 수 없어(자산별
   실측 MDD 는 파이프라인이 창 통계로 사전계산), 무추세 기하브라운 근사
   E[%MDD] ≈ 1 − e^(−√(π/2)·σ·√T) 를 [모형] 라벨로 낸다. √(π/2)=1.2533 은
   산술 브라운 최대낙폭의 표준 기대값이고, 지수화가 로그경로 낙폭을 %낙폭으로
   되돌려 100% 상한을 구조적으로 지킨다 — 재점검 몬테카를로에서 원식(1.2533·σ√T)
   은 σ√T 가 크면 −100% 를 넘는 불가능한 값을 냈다(예: 주식 몰빵 + 전체 창). */
function allocCharStats(E, w) {
  const V = E.V;
  const sig = E.sigmaW(w, V.C);
  const mu = amDot(V.mu, w);
  const rf = E.A.rates.kr3m.v;
  const Cw = amMv(V.C, w);
  const sigs = V.keys.map((_, i) => Math.sqrt(Math.max(V.C[i][i], 0)));
  const T = E.sample.n_months / 12;
  return {
    mu, sig, se: E.seOf(sig), rf, T,
    sharpe: sig > 1e-12 ? (mu - rf) / sig : null,
    /* 분산비 DR = Σ|w|σᵢ ÷ σₚ — 1 이면 분산효과 0, 클수록 상관이 위험을 지워 준 것 */
    dr: sig > 1e-12 ? w.reduce((a, wi, i) => a + Math.abs(wi) * sigs[i], 0) / sig : null,
    /* 포트폴리오와 각 자산의 상관 ρ(p,i) = (Σw)ᵢ ÷ (σₚσᵢ) */
    rho: V.keys.map((_, i) =>
      sig > 1e-12 && sigs[i] > 1e-12 ? Cw[i] / (sig * sigs[i]) : null),
    sigs,
    corr: V.keys.map((_, i) => V.keys.map((_, j) =>
      sigs[i] > 1e-12 && sigs[j] > 1e-12 ? V.C[i][j] / (sigs[i] * sigs[j]) : null)),
    emdd: (1 - Math.exp(-1.2533 * (sig / 100) * Math.sqrt(T))) * 100,
  };
}

/* 특성 카드 — 비중 조정과 함께 즉시 갱신된다. gapSig = 같은 기대수익의 투자선 위
   점까지 줄일 수 있는 위험(효율 갭, doOpt 일 때만). */
function renderAllocChar(box, E, w, opts) {
  box.textContent = "";
  const V = E.V;
  const cs = allocCharStats(E, w);
  const riskWord = "위험";
  box.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "포트폴리오 특성 — 즉시 갱신"),
    el("span", { class: "card-sub" },
      `표본 ${E.sample.start}~${E.sample.end} (${E.sample.n_months}개월) · 위 콘솔의 비중·헤지·매핑을 그대로 따릅니다`)));

  const tile = (label, val, sub, cls) => el("div", { class: "card", style: "padding:10px 14px;min-width:130px" },
    el("div", { class: "card-title", style: "font-size:11.5px" }, label),
    el("div", { class: cls || "", style: "font-size:18px;font-weight:700;margin:3px 0 1px" }, val),
    el("div", { style: "color:var(--ink-3);font-size:11px" }, sub));
  const tiles = el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;margin-top:8px" });
  tiles.append(
    tile("기대수익 (연)", `${fmtNum(cs.mu, 2)}%`, "출처는 자산군 표의 출처 열"),
    tile(`${riskWord} (연)`, `${fmtNum(cs.sig, 2)}%`, `±표본오차 ${fmtNum(cs.se, 2)}%p`),
    tile("샤프 (관측 무위험)", cs.sharpe == null ? "–" : fmtNum(cs.sharpe, 2),
      `(μ − 한국 3개월 ${fmtNum(cs.rf, 2)}%) ÷ σ`),
    tile("분산비 DR", cs.dr == null ? "–" : fmtNum(cs.dr, 2),
      "Σ비중×σ ÷ 포트σ — 1보다 클수록 상관이 위험을 지움"),
    tile("예상 최대낙폭 [모형]", `−${fmtNum(cs.emdd, 1)}%`,
      `무추세 기하브라운 1−e^(−√(π/2)·σ√T), T=${fmtNum(cs.T, 1)}년 — 실측 경로는 미게시 계약상 불가`));
  if (opts && opts.gapSig != null) {
    const gap = cs.sig - opts.gapSig;
    /* 정직성 가드(재점검 발견): 현재 배분이 밴드 밖이면 최적화가 현재 μ 에 도달하지
       못한다 — 그때 "같은 기대수익"이라 적으면 참고점의 μ 손실을 은폐하게 된다. */
    const unreach = opts.gapMu != null && opts.gapMu < cs.mu - 0.005;
    tiles.append(tile("투자선까지의 효율 갭", `${gap > 0.005 ? "−" : ""}${fmtNum(Math.abs(gap), 2)}%p`,
      unreach
        ? `⚠ 현재 기대수익 ${fmtNum(cs.mu, 2)}% 는 제약(밴드) 안에서 도달 불가 — 참고점 μ ${fmtNum(opts.gapMu, 2)}% 기준 위험차입니다`
        : gap > 0.005 ? "같은 기대수익 이상을 내는 투자선 위 점까지 줄일 수 있는 위험" : "사실상 투자선 위에 있습니다",
      unreach || gap > 0.005 ? "d-up" : "d-down"));
  }
  box.append(tiles);

  /* 자산별: 비중·σ·실측 MDD(벤치마크 원지수)·포트와의 상관 */
  const mddOf = (k) => {
    if (E.layer !== "cma" || !E.cmaW || !E.cmaW.mdd_pct) return null;
    if (allocIsAlt(k) && E.altInfo && E.altInfo.mode === "factor") return null;   // 매핑 자산 — 원지수 실측이 대표하지 않는다
    const lb = { 국내채권: "시가 국내채권", 해외채권: "시가 해외채권",
      국내주식: "시가 국내주식", 해외주식: "시가 해외주식",
      "대체투자(지분형)": "시가 대체투자", "대체투자(대출형)": "시가 대체투자",
      단기자금: "장부가 단기자금" }[k];
    const i = E.cmaAll.cols.indexOf(lb);
    return i >= 0 ? E.cmaW.mdd_pct[i] : null;
  };
  const t = el("table", { class: "mini-table", style: "margin-top:10px" },
    el("tr", {}, ...["자산군", "비중%", `${riskWord}%`, "실측 MDD%", "ρ(포트, 자산)"]
      .map((h) => el("th", {}, h))));
  V.keys.forEach((k, i) => {
    const m = mddOf(k);
    t.append(el("tr", {},
      el("td", { style: "text-align:left" }, k),
      el("td", { class: "num" }, fmtNum(w[i] * 100, 1)),
      el("td", { class: "num" }, fmtNum(cs.sigs[i], 2)),
      el("td", { class: "num" }, m == null ? "–" : `−${fmtNum(m, 1)}`),
      el("td", { class: "num" }, cs.rho[i] == null ? "–" : fmtNum(cs.rho[i], 2))));
  });
  box.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
    explainBox("alloc-char-legend",
      "실측 MDD 는 벤치마크 원지수의 창 안 최대낙폭(월말 관측 — 월중 저점은 보이지 않음). ",
      "매핑된 대체투자는 원지수 실측이 대표하지 않아 비웁니다. ρ(포트,자산) = 공분산 ÷ (σₚσᵢ)."));

  /* 상관 행렬 — 길어서 접는다. 값은 현재 매핑·헤지가 반영된 V.C 기준이다 */
  const det = el("details", { style: "margin-top:8px" },
    el("summary", {}, "자산군 상관 행렬 (현재 매핑·헤지 반영)"));
  const tc = el("table", { class: "mini-table" },
    el("tr", {}, el("th", {}, ""), ...V.keys.map((k) => el("th", {}, k))));
  V.keys.forEach((a, i) => {
    const tr = el("tr", {}, el("td", { style: "text-align:left" }, a));
    V.keys.forEach((_, j) => {
      const v = cs.corr[i][j];
      tr.append(el("td", { class: "num " + (v != null && i !== j ? (v > 0.5 ? "d-up" : v < -0.3 ? "d-down" : "") : "") },
        v == null ? "–" : fmtNum(v, 2)));
    });
    tc.append(tr);
  });
  det.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tc));
  box.append(det);
}

/* ---- 시뮬레이터(§7.7.8) 보조 — 합계 유지 재분배 + 도넛 차트 ----------------
   재분배는 순수 함수로 뺀다(프로브가 손계산 대조). 「합계 100% 유지」는 사용자가
   명시적으로 고른 모드라 몰래 맞추기 금지 규약과 충돌하지 않는다 — 자유 모드에서는
   재분배하지 않고 합계 배지만 보인다(기존 규약 그대로). */
function allocRedistribute(mix, key, newV, target) {
  const out = { ...mix };
  const others = ALLOC_ECON.filter((k) => k !== key);
  const v = Math.min(Math.max(0, newV), Math.max(0, target));
  out[key] = Math.round(v * 10) / 10;
  const need = Math.max(0, Math.round((target - out[key]) * 10));   // 0.1%p 단위 정수
  const oldSum = others.reduce((a, k) => a + Math.max(0, out[k] || 0), 0);
  /* 비례 재분배 후 0.1 단위 최대잔여법 — 합계가 목표와 **정확히** 일치해야
     「합계 100% 유지」 모드가 배지를 안 띄운다(비중 표시 0.1 단위 — 2026-08-12). */
  const raw = others.map((k) => oldSum <= 1e-9
    ? need / 10 / others.length : Math.max(0, out[k] || 0) * (need / 10) / oldSum);
  const fl = raw.map((x) => Math.floor(x * 10));
  let rem = need - fl.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x * 10 - fl[i], i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (rem > 0) { fl[i] += 1; rem -= 1; } });
  others.forEach((k, i) => { out[k] = fl[i] / 10; });
  return out;
}

/* ---- λ 역산 — 「지금 감수 중인 위험을 재현하는 위험회피계수」 (2026-08-12) --------
   λ 자체는 관측되지 않는 선호 모수라 **정답 숫자가 없다**. 그래서 임의의 권장값을
   코드에 박는 대신(자의성 금지), 관측 가능한 앵커 하나 — **현재 배분의 위험 수준** —
   을 재현하는 λ 를 역산해 준다. 이것이 실무의 역최적화(reverse optimization)
   앵커이고, 사용자가 "지금과 같은 위험을 감수한다면 배분은 어디로 가야 하나"를
   물을 수 있게 한다.

   σ*(λ) = 최적해의 위험은 λ 에 대해 **단조 감소**(위험회피가 커질수록 위험을 줄인다)
   하므로 이분법이 안전하다 — 격자 스캔이나 임의 초기값이 필요 없다. 반환의
   `bounded` 는 목표 위험이 탐색 구간 밖(밴드 제약상 도달 불가)임을 알리는 정직성
   신호다: 그 경우 조용히 끝값을 "정답"이라 적지 않고 화면이 사실을 밝힌다. */
function allocLambdaForSigma(E, sigTarget, opts) {
  const o = opts || {};
  /* 비용 주의: 이분법 1회 = STEPS × IT 번의 경사 반복이라 프로브·CI 시간에 직접 잡힌다.
     로그 이분법이라 14스텝이면 구간비가 25000^(1/2^14) ≈ 1.0006 로 이미 과잉 정밀하다. */
  const LO = o.lo || 0.02, HI = o.hi || 500, IT = o.iters || 400, STEPS = o.steps || 14;
  const { mu, C } = E.V;
  const sigAt = (lam) => E.sigmaW(E.optimizeUtilAt(mu, C, lam, 1, IT), C);
  const sLo = sigAt(LO), sHi = sigAt(HI);
  if (!(sigTarget > 0) || !isFinite(sigTarget)) return null;
  if (sigTarget >= sLo) return { lam: LO, sig: sLo, bounded: "low" };
  if (sigTarget <= sHi) return { lam: HI, sig: sHi, bounded: "high" };
  let lo = LO, hi = HI;
  for (let i = 0; i < STEPS; i++) {
    const mid = Math.sqrt(lo * hi);          // 로그 중점 — λ 는 스케일 모수라 배수로 움직인다
    if (sigAt(mid) > sigTarget) lo = mid; else hi = mid;
  }
  const lam = Math.sqrt(lo * hi);
  return { lam, sig: sigAt(lam), bounded: null };
}

/* ---- 배분+헤지 동시 최적(§7.7.13) — 교대(블록 좌표) 최적화 ------------------
   시뮬레이터의 ① 최적 트랙: "최적 배분"과 "그에 맞는 최적 헤지"를 한 쌍으로 낸다
   (2026-08-12 사용자 지시 — 배분 2트랙과 매칭되는 헤지 2트랙).

   왜 교대가 정당한가: 헤지비율은 위험에 **총 미헤지 환노출 Xe 를 통해서만** 들어가고
   (Xe 붕괴 — 같은 Xe 는 위험이 정확히 같다), μ 키인은 최종치라 헤지와 무관하다
   (§7.7.10 — 캐리 미가산). 좌표를 (w, Xe) 로 잡으면 노출 벡터가 그 둘에 **선형**이라
   목적함수가 결합 볼록(convex)이고, w-스텝(λ-효용 QP)과 Xe-스텝(폐형 2차식 최소)을
   번갈아 돌리면 전역해로 수렴한다 — 임의 초기값·격자 없음, 시작점은 현재 슬라이더.

   반환하는 (hb,he) 는 그 Xe\* 의 **현재값 최근접 대표점**이다(동점 무한 — Xe 가 정본,
   한 쌍을 「최적」이라 적으면 임의 선택이 된다는 §5.3 규약 그대로).
   환율 축이 없으면(fxLive=false) 헤지가 무력(모든 조합 동점)이라 배분만 최적화한다. */
function allocJointOpt(E, st) {
  if (E.layer !== "cma") return null;              // ① 최적은 벤치마크 층 전용(기존 게이트)
  const lam = +st.mvo_lambda || 1;
  const hbnds = allocHBands(st);
  let hb = Math.min(Math.max(st.h_bond / 100, hbnds[0][0]), hbnds[0][1]);
  let he = Math.min(Math.max(st.h_eq / 100, hbnds[1][0]), hbnds[1][1]);
  let w = null, xePrev = null, converged = !E.fxLive, iters = 0;
  for (let it = 0; it < 6; it++) {
    iters = it + 1;
    const B = E.build(hb, he);
    w = E.optimizeUtilAt(B.mu, B.C, lam, 1);
    if (!E.fxLive) break;                          // 헤지 무력 — w 한 번이면 끝
    const q = E.xeQuadW(w);
    const [[blo, bhi], [elo, ehi]] = hbnds;
    const xeLo = w[1] * (1 - bhi) + w[3] * (1 - ehi);
    const xeHi = w[1] * (1 - blo) + w[3] * (1 - elo);
    const xe = E.xeStar(xeLo, xeHi, q);
    const pair = E.hedgePairForXeW(w, xe, [hb, he], hbnds);
    if (pair) { hb = pair[0]; he = pair[1]; }
    if (xePrev != null && Math.abs(xe - xePrev) < 1e-7) { converged = true; break; }
    xePrev = xe;
  }
  const B = E.build(hb, he);
  w = E.optimizeUtilAt(B.mu, B.C, lam, 1);         // 최종 헤지에서 배분 한 번 더 — 보고값 정합
  /* 진단 — "버튼을 눌러도 헤지가 안 움직인다"의 **이유**를 화면이 말할 수 있어야 한다
     (2026-08-12 사용자 보고). 무반응은 대개 버그가 아니라 다음 셋 중 하나다:
     ① 최적 배분에서 그 슬리브 비중이 0 → 그 헤지비율은 Xe 에 기여가 없어 위험과 무관
        (hedgePairForXeW 가 현재값을 그대로 둔다 — 임의로 움직이지 않는 것이 옳다)
     ② 밴드가 물어 Xe\* 가 경계로 잘림 → 최적쌍이 현재값과 같아질 수 있다
     ③ 이미 최적점에 있음.
     셋을 구분하지 않으면 사용자는 전부 "고장"으로 읽는다. */
  const q = E.fxLive ? E.xeQuadW(w) : null;
  const xeFree = q ? E.xeStar(null, null, q) : null;
  const xe = E.fxLive ? E.xeOfW(w, hb, he) : null;
  /* 구속의 출처는 `allocXeBinds` 한 곳이 정한다(§7.7.17) — 요약표·오버레이와 같은 답을
     쓰기 위해서다. 두 구속은 배타가 아니며 동시에 성립할 수 있다(그 함수의 주석 참조). */
  let binds = null, xeLo = null, xeHi = null;
  if (E.fxLive && xeFree != null) {
    const [[blo2, bhi2], [elo2, ehi2]] = hbnds;
    xeLo = w[1] * (1 - bhi2) + w[3] * (1 - ehi2);
    xeHi = w[1] * (1 - blo2) + w[3] * (1 - elo2);
    binds = allocXeBinds(w[1] + w[3], xeLo, xeHi, xeFree);
  }
  return {
    w, hb, he, xe,
    sig: E.sigmaW(w, B.C), mu: amDot(B.mu, w),
    fxLive: E.fxLive, converged, iters,
    /* 슬리브 비중이 사실상 0이면 그 헤지비율은 위험에 무영향 */
    inertBond: E.fxLive && w[1] < 1e-9,
    inertEq: E.fxLive && w[3] < 1e-9,
    xeFree, xeLo, xeHi, binds,
    bandBinds: !!(binds && binds.bandBinds),   // 내규 밴드가 구간을 좁혀 잘림
    capBinds: !!(binds && binds.capBinds),     // 구조적 한계 — 밴드를 풀어도 못 간다
  };
}

/* 통화별 환헤지 분해(§7.7.13) — 슬리브 헤지비율(채권 hb·주식 he)을 통화 구성으로
   펼친 **표시용 분해**다. 통화 구성은 수기 입력이 있으면 그것(출처 "입력"), 없으면
   공개 벤치마크(출처 "벤치마크"). 반환 값은 총자산 대비 %.
   **통화별 「최적」 헤지비율이 아니다** — 이 모형의 환축은 달러원 하나라(통화축 확장
   전) 통화별 최적을 말할 근거가 없고, 여기서는 두 슬리브의 비율이 그 슬리브의 모든
   통화에 균일하게 걸린다는 사실을 그대로 보여 준다. 통화별 판단은 환헤지 화면. */
function allocCcyHedgeRows(A, st, wBond, wEq, hb, he) {
  const src = {};
  ["해외채권", "해외주식"].forEach((sl) => {
    const keyed = allocCcySum(st, sl).entered;
    const bench = (A.ccy_bench && A.ccy_bench[sl]) || null;
    src[sl] = keyed ? { w: st.ccy[sl], tag: "입력" }
      : bench ? { w: bench.w || {}, tag: "벤치마크" } : null;
  });
  if (!src["해외채권"] && !src["해외주식"]) return null;
  const rows = ALLOC_CCY.map((c) => {
    const eb = wBond * ((src["해외채권"] && +src["해외채권"].w[c]) || 0) / 100;
    const ee = wEq * ((src["해외주식"] && +src["해외주식"].w[c]) || 0) / 100;
    const open = eb * (1 - hb) + ee * (1 - he);
    return { c, exp: eb + ee, hedged: eb * hb + ee * he, open };
  }).filter((r) => r.exp > 1e-6);
  const covB = src["해외채권"]
    ? ALLOC_CCY.reduce((a, c) => a + (+src["해외채권"].w[c] || 0), 0) : null;
  const covE = src["해외주식"]
    ? ALLOC_CCY.reduce((a, c) => a + (+src["해외주식"].w[c] || 0), 0) : null;
  return { rows, src: { 해외채권: src["해외채권"] && src["해외채권"].tag,
                        해외주식: src["해외주식"] && src["해외주식"].tag },
           coverage: { 해외채권: covB, 해외주식: covE } };
}

/* 도넛 — 비중 시각화 전용(값 왜곡 없음: 각도 = 비중/합). 합이 0이면 빈 링. */
function allocDonutSVG(entries, size) {
  const NS = "http://www.w3.org/2000/svg";
  const s = size || 132, r = s * 0.34, cx = s / 2, cy = s / 2;
  const C = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${s} ${s}`);
  svg.setAttribute("width", s); svg.setAttribute("height", s);
  svg.setAttribute("role", "img");
  const total = entries.reduce((a, e) => a + Math.max(0, e.w), 0);
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("r", r);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "var(--border)");
  ring.setAttribute("stroke-width", s * 0.16);
  svg.append(ring);
  if (total > 1e-9) {
    let off = C * 0.25;                       // 12시 방향 시작
    entries.forEach((e) => {
      const frac = Math.max(0, e.w) / total;
      if (frac <= 1e-9) return;
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
      c.setAttribute("fill", "none");
      c.setAttribute("stroke", e.color);
      c.setAttribute("stroke-width", s * 0.16);
      c.setAttribute("stroke-dasharray", `${frac * C} ${C - frac * C}`);
      c.setAttribute("stroke-dashoffset", off);
      c.setAttribute("class", "donut-seg");
      svg.append(c);
      off -= frac * C;
    });
  }
  return svg;
}

/* ================= 자산배분 — 화면 ================= */

const ALLOC_LS_KEY = "iaw-alloc";
let allocCharts = [];
let allocTvCharts = [];   // 시변 카드 전용 — recalc 타이머의 전체 파괴와 분리

function allocDefaults(A) {
  const d = A.defaults;
  return {
    /* 시가 기준 7축 하나(§7.7.11) — 구 mix_acct/bands_acct/view 는 이관 절이 접는다 */
    mix: { ...(d.mix || {}) },
    bands: JSON.parse(JSON.stringify(d.bands)),
    loan_w: d.loan_w, loan_y: d.loan_y,
    alt_alpha: d.alt_alpha, alt_vol: d.alt_vol,
    tenor_m: d.tenor_m, h_bond: d.h_bond, h_eq: d.h_eq,
    /* 대체투자 환헤지 비율 — 위 둘과 **성격이 다르다**(2026-08-19 사용자 지시).
       해외채권·해외주식 헤지는 최적화가 고르는 레버(시뮬레이션 트랙·저장 안 함)인 반면
       이쪽은 **모형 입력**이라 즉시 저장한다 — 사용자가 「유동적으로 헤지 중」인 현재
       운용 상태를 모형에 넣는 칸이지 최적화가 고를 선택지가 아니다(§7.7.20). */
    h_alt: d.h_alt == null ? 90 : d.h_alt,
    h_bands: JSON.parse(JSON.stringify(d.h_bands || { 해외채권: [0, 100], 해외주식: [0, 100] })),
    h_tol_hi: { ...(d.h_tol_hi || { 해외채권: null, 해외주식: null }) },
    ccy: JSON.parse(JSON.stringify(d.ccy || { 해외채권: {}, 해외주식: {} })),
    cost_key: d.cost_key, proxy: d.proxy, start_key: d.start_key,
    /* --- 위험 원천(데이터층) — §7.7: 벤치마크 CMA 가 기본, 구 벤더 프록시는 대조용.
       CMA 가 비활성이면 엔진이 조용히 프록시로 물러나고 그 사실을 화면에 적는다.
       창 기본 5년(2026-08-12 사용자 지시 — 위험 디폴트 = BM 5년 σ). 5년 창이 아직
       게시되지 않은 표본(공통 표본 < 60개월)에서는 엔진이 게시된 최장 창으로
       물러나며, 어느 창이 쓰였는지는 창 선택기·표본 라벨에 그대로 보인다. --- */
    src: "cma", cma_win: "5",
    /* 대체투자 위험 매핑 — 기관 현행 방식 그대로 두 분류 모두 해외주식·국내채권
       50/50 이 기본(2026-08-12 사용자 지시 "전에 말한대로 5대5"). 분류별로 다르게
       두고 싶으면 콘솔에서 조정한다(예: 지분형 65/35·대출형 0/100 — §7.7.9 의
       민감도 대안). 잔차(고유위험)는 디스무딩 보조축(_alt)의 팩터 스팬 회귀에서
       폐형으로 계산해 분류마다 독립 가산한다(§7.7.9). */
    alt_map: { mode: "factor", eq_we: 50, eq_wb: 50, dt_we: 50, dt_wb: 50 },
    /* 기대수익 키인(연 %) — 디폴트는 파이프라인이 게시한 사용자 지정 CMA 수치
       (2026-08-12). 키인은 최종치라 캐리 미가산(§7.7.10). 구 alloc.json(디폴트
       미게시)에서는 null = 앵커/관측 폴백. */
    mu_over: { 국내채권: null, 해외채권: null, 국내주식: null, 해외주식: null,
               "대체투자(대출형)": null, "대체투자(지분형)": null, 단기자금: null,
               ...(d.mu_over || {}) },
    /* 시변·창 민감도 카드 — λ-효용 MVO. λ=1 소수 단위(2026-08-11 사용자 지정,
       2026-08-12 부터 시뮬레이터에서 선택). tv_len 은 롤링 길이(년) — null = 게시된 것 중 최장. */
    mvo_lambda: 1, tv_mode: "roll", tv_len: null,
    /* 시뮬레이터(§7.7.8) — 자산군별 위험 키인(연 %, 대체투자 두 분류 제외 5키).
       null = 벤치마크 실측. **상관은 항상 벤치마크 실측 ρ 를 유지**하고 σ 만
       갈아끼운다(키인 σ × 실측 ρ — 표준 CMA 관행). 그래야 특성 카드·효율선·시변이
       같은 행렬에서 한 몸으로 움직인다. 미입력 = 실측이 디폴트다. */
    sig_over: { 국내채권: null, 해외채권: null, 국내주식: null, 해외주식: null,
                단기자금: null },
    /* 비중 막대 합계 모드 — true: 하나를 끌면 나머지가 비례 재분배돼 합이 유지된다
       (명시적 모드 선택이므로 「몰래 맞추기」가 아니다). 기본은 자유 조정 + 합계
       배지 — 기존 「몰래 맞추지 않는다」 원칙의 기본값을 유지하고 유지 모드는 옵트인. */
    sum_lock: false,
    cap_foreign: null, cap_equity: null, target_ret: null, risk_cap: null,
    dur_liab: null, dur_asset: null, la_ratio: null,
    dur_by: { 국내채권: null, 해외채권: null, 단기자금: null },
    saved: false,
  };
}

function allocState(A) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ALLOC_LS_KEY)) || {}; } catch { saved = {}; }
  const st = { ...allocDefaults(A), ...saved };
  /* 예전 버전이 저장한 상태에는 아래 세 객체가 없다 — 없거나 모양이 깨졌으면 기본값으로
     되돌린다. 여기서 막지 않으면 저장 핸들러가 undefined 에 인덱싱하며 죽는다. */
  const d = allocDefaults(A);
  if (!st.h_bands || typeof st.h_bands !== "object") st.h_bands = d.h_bands;
  ["해외채권", "해외주식"].forEach((k) => {
    if (!Array.isArray(st.h_bands[k])) st.h_bands[k] = [0, 100];
  });
  if (!st.h_tol_hi || typeof st.h_tol_hi !== "object") st.h_tol_hi = d.h_tol_hi;
  if (!st.dur_by || typeof st.dur_by !== "object") st.dur_by = d.dur_by;
  if (!st.ccy || typeof st.ccy !== "object") st.ccy = d.ccy;
  ["해외채권", "해외주식"].forEach((k) => {
    if (!st.ccy[k] || typeof st.ccy[k] !== "object") st.ccy[k] = {};
  });
  if (st.src !== "proxy" && st.src !== "cma") st.src = "cma";
  if (!isFinite(+st.mvo_lambda) || +st.mvo_lambda <= 0) st.mvo_lambda = 1;
  if (st.tv_mode !== "win" && st.tv_mode !== "roll") st.tv_mode = "roll";
  if (!st.alt_map || typeof st.alt_map !== "object") st.alt_map = d.alt_map;
  if (st.alt_map.mode !== "bm" && st.alt_map.mode !== "factor") st.alt_map.mode = "factor";
  /* §7.7.9 이관 — 구 저장분의 단일 「대체투자」 매핑(w_eq/w_bd)은 북 전체용이라
     분류별 축에 그대로 옮길 수 없다. 버리고 분류별 기본값으로 시작한다(매핑 콘솔에
     그대로 표시되므로 조용한 변경이 아니다). */
  ["eq_we", "eq_wb", "dt_we", "dt_wb"].forEach((k) => {
    if (!isFinite(+st.alt_map[k])) st.alt_map[k] = d.alt_map[k];
  });
  delete st.alt_map.w_eq;
  delete st.alt_map.w_bd;
  if (!st.mu_over || typeof st.mu_over !== "object") st.mu_over = d.mu_over;
  /* §7.7.9 이관 — 구 저장분의 「대체투자」 단일 키. μ 키인은 두 분류에 복사하면
     어떤 분할 비중에서도 합계 μ 가 보존된다. 비중·밴드는 예시 분할비(기본값의
     지분:대출 비율)로 나눈다 — 어차피 시뮬레이션 입력이라 화면에서 바로 보인다. */
  if (st.mu_over["대체투자"] != null) {
    if (st.mu_over["대체투자(지분형)"] == null) st.mu_over["대체투자(지분형)"] = st.mu_over["대체투자"];
    if (st.mu_over["대체투자(대출형)"] == null) st.mu_over["대체투자(대출형)"] = st.mu_over["대체투자"];
    delete st.mu_over["대체투자"];
  }
  if (st.mix_acct && typeof st.mix_acct === "object"
      && st.mix_acct["대체투자"] != null && isFinite(+st.mix_acct["대체투자"])
      && st.mix_acct["대체투자(지분형)"] == null) {
    const v = +st.mix_acct["대체투자"];
    const de = d.mix["대체투자(지분형)"], dd = d.mix["대체투자(대출형)"];
    const fe = de + dd > 0 ? de / (de + dd) : 0.5;
    const ve = +(v * fe).toFixed(2);
    st.mix_acct["대체투자(지분형)"] = ve;
    st.mix_acct["대체투자(대출형)"] = +(v - ve).toFixed(2);   // 합계 보존
  }
  if (st.mix_acct) delete st.mix_acct["대체투자"];
  {
    const b = st.bands;
    if (b && typeof b === "object") {
      if (Array.isArray(b["대체투자"]) && !Array.isArray(b["대체투자(지분형)"])) {
        b["대체투자(지분형)"] = b["대체투자"].slice();
        b["대체투자(대출형)"] = (d.bands["대체투자(대출형)"] || [0, 100]).slice();
      }
      delete b["대체투자"];
      /* 분할 키 백필 — 저장분에 없으면 기본값. 수기 입력 저장 핸들러가 이 배열을
         직접 인덱싱하므로(bands[k][0]) 없는 채로 두면 저장 버튼에서 죽는다. */
      ALLOC_ALT_KEYS.forEach((k) => {
        if (!Array.isArray(b[k])) b[k] = (d.bands[k] || [0, 100]).slice();
      });
    }
  }
  if (st.sig_over && typeof st.sig_over === "object") delete st.sig_over["대체투자"];
  if (st.cma_win != null) st.cma_win = String(st.cma_win);   // tv_len 과 대칭 — 숫자형 저장 수용
  /* 숫자 칸 소독(재점검 발견) — 손상 저장("abc")이 NaN 으로 스며들면 그룹 상한이
     NaN 이 되어 참고치가 사유 없이 전부 "–"가 된다(NaN 비교는 모든 검사를 통과).
     null 은 유효한 "없음"이므로 유지하고, 숫자로 못 읽는 값만 기본값으로 되돌린다. */
  ["cap_foreign", "cap_equity", "target_ret", "risk_cap",
   "loan_w", "loan_y", "alt_alpha", "alt_vol", "tenor_m", "h_bond", "h_eq", "h_alt",
   "dur_liab", "dur_asset", "la_ratio"].forEach((k) => {
    if (st[k] == null) return;
    st[k] = isFinite(+st[k]) ? +st[k] : d[k];
  });
  /* 대체투자 헤지비율은 밴드도 함께 소독한다(§7.7.20) — 슬라이더는 0~100 이지만
     저장분은 손으로 고칠 수 있고, 범위를 벗어난 값은 라벨에 그대로 찍히면서
     계산에도 들어간다(예 −50% 는 「오버노출」이라는 없는 상태를 만든다). */
  st.h_alt = Math.min(100, Math.max(0, st.h_alt == null ? d.h_alt : st.h_alt));
  /* ---- 2026-08-12 이관 ② — 장부가 축 제거(§7.7.11) ----
     회계 9축 저장분을 시가 7축으로 접는다. 채권 쌍은 **합산**(구 경제 관점 mixEcon 과
     같은 규칙 — 합계 100 과 경제적 환노출 보존), σ 키인은 시가 키를 승계하고,
     장부가 키·북일드(by_kr/by_fx)·cap_book·bands_acct·view(관점)는 폐기한다.
     장부 보유분의 경제적 위험은 시가 축이 나른다 — 저장분을 조용히 버리지 않는
     이유이자, 접는 규칙이 유일하게 정해지는 이유다. */
  const OLD_MIX = { "장부가 국내채권": 30, "시가 국내채권": 12, "장부가 해외채권": 12,
    "시가 해외채권": 6, 국내주식: 3, 해외주식: 5,
    "대체투자(지분형)": 12, "대체투자(대출형)": 3, 단기자금: 5 };
  /* 주의: st.mix 는 디폴트 스프레드로 항상 존재한다 — fold 여부는 **저장분**에 새
     스키마(mix)가 있었는지로 판정해야 한다(실측: st.mix 로 가드하면 fold 가 영영
     안 돈다). */
  if ((!saved.mix || typeof saved.mix !== "object")
      && st.mix_acct && typeof st.mix_acct === "object") {
    if (Object.keys(OLD_MIX).every((k) => +st.mix_acct[k] === OLD_MIX[k])) {
      st.mix = { ...d.mix };   // 구 「예시」 그대로 — 사용자가 만진 값이 아니라 새 예시로
    } else {
      const g = (k) => (st.mix_acct[k] != null && isFinite(+st.mix_acct[k]) ? +st.mix_acct[k] : 0);
      st.mix = { 국내채권: g("장부가 국내채권") + g("시가 국내채권"),
                 해외채권: g("장부가 해외채권") + g("시가 해외채권"),
                 국내주식: g("국내주식"), 해외주식: g("해외주식"),
                 "대체투자(대출형)": g("대체투자(대출형)"),
                 "대체투자(지분형)": g("대체투자(지분형)"), 단기자금: g("단기자금") };
    }
  }
  if (!st.mix || typeof st.mix !== "object") st.mix = { ...d.mix };
  ALLOC_ECON.forEach((k) => {
    const v = st.mix[k];
    st.mix[k] = v != null && isFinite(+v) ? +v : d.mix[k];
  });
  if (!st.sig_over || typeof st.sig_over !== "object") st.sig_over = { ...d.sig_over };
  [["시가 국내채권", "국내채권"], ["시가 해외채권", "해외채권"]].forEach(([o, n]) => {
    if (st.sig_over[n] == null && st.sig_over[o] != null) st.sig_over[n] = st.sig_over[o];
  });
  {
    const sigOld = st.sig_over;
    st.sig_over = {};
    ALLOC_ECON.forEach((k) => {
      const v = sigOld[k];
      st.sig_over[k] = v != null && isFinite(+v) && +v > 0 ? +v : null;
    });
  }
  ["mix_acct", "bands_acct", "by_kr", "by_fx", "cap_book", "book_mat_m", "view"]
    .forEach((k) => { delete st[k]; });
  /* ---- 2026-08-12 이관 ① — 대출금 제외·μ/매핑 디폴트(사용자 지정) ---- */
  /* 대출금은 배분 우주에서 제외 확정 — 저장분의 12% 도 무효(7개 자산군 합 100). */
  st.loan_w = 0;
  /* 구 매핑 기본값(지분형 65/35·대출형 0/100) 그대로면 새 기본 50/50 으로(2026-08-12
     지시 "전에 말한대로 5대5"). 사용자가 조정한 다른 값은 유지. */
  if (+st.alt_map.eq_we === 65 && +st.alt_map.eq_wb === 35
      && +st.alt_map.dt_we === 0 && +st.alt_map.dt_wb === 100) {
    ["eq_we", "eq_wb", "dt_we", "dt_wb"].forEach((k) => { st.alt_map[k] = d.alt_map[k]; });
  }
  /* μ 디폴트(사용자 지정 CMA) — 미입력(null)은 지정 디폴트로 채운다.
     "미입력 = 사용자 지정 디폴트"가 새 계약이다(§7.7.10 — 구 앵커/관측 도출은
     디폴트가 게시되지 않은 자산의 폴백으로만 남는다).

     **채워 넣은 값은 `mu_dflt` 에 그대로 기억한다.** 그러지 않으면 저장된 옛 값과
     "자동으로 채운 디폴트"를 구분할 수 없어, 파이프라인 디폴트를 갱신해도 예전에
     저장된 화면에는 영영 반영되지 않는다(실측 사고: 대체투자 두 분류가 옛 저장분
     때문에 같은 μ 4.39 로 굳어 있었다 — 지분형 게시 디폴트는 6.86). 지금 값이
     "우리가 채운 그 값 그대로"면 새 디폴트로 갱신하고, 사용자가 고친 값이면
     건드리지 않는다. 구 북일드 스냅숏(by_kr/by_fx)은 축과 함께 폐기. */
  if (!st.mu_dflt || typeof st.mu_dflt !== "object") st.mu_dflt = {};
  delete st.mu_dflt.by_kr;
  delete st.mu_dflt.by_fx;
  const dfltSync = (cur, was, next) =>
    (cur == null || (was != null && Math.abs(+cur - +was) < 1e-12)) ? +next : cur;
  if (d.mu_over) Object.entries(d.mu_over).forEach(([k, v]) => {
    if (v == null || !isFinite(+v)) return;
    st.mu_over[k] = dfltSync(st.mu_over[k], st.mu_dflt[k], v);
    st.mu_dflt[k] = +v;
  });
  st.sum_lock = st.sum_lock === true;
  return st;
}

/* 모형이 아는 통화. hedge.py CURRENCIES 와 같은 집합이며 순서도 맞춘다. */
const ALLOC_CCY = ["USD", "EUR", "JPY", "CNY", "AUD", "CAD", "GBP"];
const ALLOC_CCY_NAME = { USD: "달러", EUR: "유로", JPY: "엔", CNY: "위안",
                         AUD: "호주달러", CAD: "캐나다달러", GBP: "파운드" };

/* 입력된 통화 구성의 합계·커버리지. **원화는 환노출이 0** 이라 헤지 대상이 아니고
   (원화 투자자에게는 정의상 그렇다), 모형 밖 통화는 「기타」로 따로 세어 화면에 밝힌다.
   합계를 100 으로 강제하거나 임의로 비례배분하지 않는다 — 숨기면 커버리지가 안 보인다. */
function allocCcySum(st, sleeve) {
  const src = (st.ccy && st.ccy[sleeve]) || {};
  let inModel = 0, any = false;
  ALLOC_CCY.forEach((c) => {
    const v = src[c];
    if (v != null && isFinite(v)) { inModel += +v; any = true; }
  });
  const krw = src.KRW != null && isFinite(src.KRW) ? +src.KRW : 0;
  const other = src.OTHER != null && isFinite(src.OTHER) ? +src.OTHER : 0;
  if (src.KRW != null || src.OTHER != null) any = true;
  return { inModel, krw, other, total: inModel + krw + other, entered: any };
}

function allocSaveState(st) {
  try { localStorage.setItem(ALLOC_LS_KEY, JSON.stringify({ ...st, saved: true })); } catch {}
}

/* CMA 층의 출처 태그 — 위험은 벤치마크 직접 관측. 기대수익을 키인했으면 그 사실이
   태그에 드러나야 한다(출처 정직성 — 키인이 정본이라는 §7.7 규약의 표시면). */
function allocCmaSrcTag(key, E) {
  const over = E.st.mu_over && E.st.mu_over[key] != null && isFinite(E.st.mu_over[key]);
  /* 키인 = 최종치(§7.7.10) — 캐리를 다시 더하지 않는다. 아래 폴백 문구는 미입력용. */
  const muTag = (dflt) => over ? "μ 키인(최종치)" : dflt;
  /* 환율 축이 없으면 "+환노출"은 거짓 — 실린 로딩만 적는다(재점검 발견) */
  const fxSuf = E.fxLive ? "+환노출" : "";
  if (allocIsAlt(key)) {
    const ai = E.altInfo;
    if (!ai || ai.mode !== "factor") return "[BM] 벤치마크 그대로 — 스무딩 σ 과소 (진단용)";
    const c = key === "대체투자(지분형)" ? ai.eq : ai.dt;
    return `[매핑] σ = ${fmtNum(c.we, 0)}% 해외주식 + ${fmtNum(c.wb, 0)}% 국내채권 + 잔차 · ${muTag("μ = CPI+α")}`;
  }
  if (key.includes("주식")) return `[BM+앵커] σ 벤치마크 · ${muTag("μ 무위험+샤프×σ")}`;
  if (key.includes("해외채권")) return `[BM+관측] σ 벤치마크${fxSuf} · ${muTag("μ YTM+헤지캐리")}`;
  return `[BM+관측] σ 벤치마크 · ${muTag("μ 시장금리")}`;
}

function allocSrcTag(key) {
  return {
    국내채권: "[관측] 한국 5년 YTM", 해외채권: "[관측] 미 종합 YTM + 헤지캐리",
    국내주식: "[관측→앵커] 무위험 + 샤프×σ", 해외주식: "[관측→앵커] 무위험 + 샤프×σ + 헤지캐리",
    "대체투자(지분형)": "[가정] CPI + α · 위험 별도 입력(두 분류 공유 프록시)",
    "대체투자(대출형)": "[가정] CPI + α · 위험 별도 입력(두 분류 공유 프록시)",
    단기자금: "[관측] 한국 3개월",
  }[key] || "";
}

/* ---------------- 포트폴리오 구성 — 신규 7자산군 (§7.14 인프라) ---------------- */

const PORT_LS_KEY = "iaw-port";
let portCharts = [];

function projSimplex(v) {
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let css = 0, theta = 0;
  for (let i = 0; i < n; i++) {
    css += u[i];
    const t = (css - 1) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(x - theta, 0));
}

function portRound01(vals, total = 100) {
  const scaled = vals.map((v) => Math.max(0, +v || 0) * 10);
  const fl = scaled.map(Math.floor);
  let rem = Math.round(total * 10) - fl.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rem > 0; k++, rem--) fl[order[k % order.length][1]] += 1;
  return fl.map((x) => x / 10);
}

function portMixFromGroups(P, grp, liq) {
  const G = (P.defaults && P.defaults.groups) || {};
  const base = ["주식", "채권", "대체"];
  const bsum = base.reduce((a, g) => a + Math.max(0, +grp[g] || 0), 0);
  const scale = bsum > 0 ? (100 - liq) / bsum : 0;
  const raw = {};
  base.forEach((g) => {
    const assets = G[g] || [];
    assets.forEach((a) => { raw[a] = Math.max(0, +grp[g] || 0) * scale / assets.length; });
  });
  (G["유동성"] || []).forEach((a, _, arr) => { raw[a] = liq / arr.length; });
  const vals = portRound01(P.assets.map((a) => raw[a] || 0));
  const out = {};
  P.assets.forEach((a, i) => { out[a] = vals[i]; });
  return out;
}

function portDefaults(P) {
  const d = P.defaults || {};
  const grp = { ...(d.group_default || { 주식: 50, 채권: 30, 대체: 20 }) };
  const liq = d.liq_default != null ? +d.liq_default : 10;
  return { grp, liq, mix: portMixFromGroups(P, grp, liq), mu: {}, win: null };
}

function portState(P) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PORT_LS_KEY)) || {}; } catch { saved = {}; }
  const d = portDefaults(P);
  const st = { ...d, ...saved };
  if (!st.grp || typeof st.grp !== "object") st.grp = d.grp;
  ["주식", "채권", "대체"].forEach((g) => { if (!isFinite(+st.grp[g])) st.grp[g] = d.grp[g]; });
  if (!isFinite(+st.liq)) st.liq = d.liq;
  if (!st.mix || typeof st.mix !== "object") st.mix = { ...d.mix };
  P.assets.forEach((a) => { if (!isFinite(+st.mix[a])) st.mix[a] = d.mix[a] || 0; });
  if (!st.mu || typeof st.mu !== "object") st.mu = {};
  return st;
}

function portSaveState(st) {
  try {
    localStorage.setItem(PORT_LS_KEY, JSON.stringify({
      grp: st.grp, liq: st.liq, mix: st.mix, mu: st.mu, win: st.win, saved: true }));
  } catch {}
}

function portWinLabel(k) { return k === "all" ? "전체" : `${k}년`; }

function portEngine(P, st) {
  const wins = P.windows || [];
  const W = wins.find((w) => w.key === st.win) || wins[wins.length - 1];
  const n = P.assets.length;
  const C = W.cov.map((row) => row.map((v) => v * 1e4));          // %² 단위
  const fileMu = (P.cma_input && P.cma_input.mu_pct) || {};
  const mu = [], src = [];
  P.assets.forEach((a, i) => {
    const k = st.mu[a];
    if (k != null && isFinite(+k)) { mu.push(+k); src.push("키인"); }
    else if (fileMu[a] != null && isFinite(+fileMu[a])) { mu.push(+fileMu[a]); src.push("CMA 파일"); }
    else { mu.push(W.mean_pct[i]); src.push("과거 평균(참고)"); }
  });
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const mv = (M, v) => M.map((r) => dot(r, v));
  const sig = (w) => Math.sqrt(Math.max(0, dot(w, mv(C, w))));
  const muOf = (w) => dot(mu, w);
  const L = Math.max(1e-9, ...C.map((r) => r.reduce((a, b) => a + Math.abs(b), 0)));
  const solve = (lam, iters = 400) => {
    let w = new Array(n).fill(1 / n);
    const eta = 1 / L;
    for (let t = 0; t < iters; t++) {
      const g = mv(C, w).map((x, i) => x - mu[i] / lam);
      w = projSimplex(w.map((x, i) => x - eta * g[i]));
    }
    return w;
  };
  const pts = [];
  for (let k = 0; k <= 32; k++) {
    const lam = Math.pow(10, 3 - 6 * k / 32);
    const w = solve(lam);
    pts.push({ sig: sig(w), mu: muOf(w), w, lam });
  }
  pts.sort((a, b) => a.sig - b.sig || a.mu - b.mu);
  const front = [];
  for (const p of pts) {
    if (!front.length) { front.push(p); continue; }
    const last = front[front.length - 1];
    if (p.sig - last.sig < 1e-4) { if (p.mu > last.mu) front[front.length - 1] = p; }
    else if (p.mu > last.mu - 1e-9) front.push(p);
  }
  const wb = P.assets.map((a) => (P.bench_w && P.bench_w[a]) || 0);
  const bench = { sig: sig(wb), mu: muOf(wb), w: wb };
  const rf = mu[P.assets.indexOf("원화유동성")] ?? 0;
  let best = null;
  for (const p of front) {
    const s = p.sig > 1e-9 ? (p.mu - rf) / p.sig : -Infinity;
    if (!best || s > best.sharpe) best = { ...p, sharpe: s };
  }
  const metrics = (w) => {
    const m = muOf(w), s = sig(w);
    const dw = w.map((x, i) => x - wb[i]);
    const te = sig(dw);
    return { mu: m, sig: s, sharpe: s > 1e-9 ? (m - rf) / s : null,
             act: m - bench.mu, te, ir: te > 1e-9 ? (m - bench.mu) / te : null };
  };
  return { W, mu, src, rf, front, minVar: front[0] || null,
           maxSharpe: best, bench, wb, sig, muOf, metrics };
}

function renderPortPanel(A) {
  const box = $("#alloc-port-panel");
  if (!box) return;
  portCharts.forEach(destroyChart);
  portCharts = [];
  box.textContent = "";
  const P = A && A.port;
  const head = el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "포트폴리오 구성 — 7자산군 (신규 우주 · 인프라)"));
  if (!P || !P.active || !(P.windows || []).length) {
    head.append(el("span", { class: "card-sub d-up" },
      `비활성 — ${(P && P.reason) || "데이터 없음"}`));
    box.append(head);
    return;
  }
  const pal = palette();
  const st = portState(P);
  const wins = P.windows;
  const W = wins.find((w) => w.key === st.win) || wins[wins.length - 1];

  head.append(el("span", { class: "card-sub" },
    `원화 기준(미헤지 환산) · 월말 표본 · 창 ${portWinLabel(W.key)} ${W.start}~${W.end} (${W.n_months}개월)`
    + (W.key === "all" ? " — 최장 공통 표본(기본)" : "")));
  const seg = el("div", { class: "seg", role: "group" });
  wins.forEach((w) => seg.append(el("button", {
    class: w.key === W.key ? "active" : "",
    onclick: () => { st.win = w.key; portSaveState(st); renderPortPanel(A); },
  }, portWinLabel(w.key))));
  head.append(el("span", {}, seg));
  box.append(head);

  const missing = P.missing_windows || [];
  if (missing.length) {
    const cov = P.coverage || [];
    const short = cov.length ? cov.reduce((a, b) => (a.n_months <= b.n_months ? a : b)) : null;
    box.append(el("div", { class: "port-warn d-up" },
      `⚠ ${missing.map((y) => `${y}년`).join("·")} 창 미충족 — ` +
      (short ? `최단 자산 ${short.asset} 표본 ${short.first}~. ` : "") +
      "요청된 10년 통계는 공통 표본이 쌓이면 자동으로 열립니다(참고: 아래 자산별 10년 열)."));
  }
  box.append(explainBox("port-method",
    { label: "방법론 · 프록시 · 규약" },
    el("p", {}, `프록시: ${P.assets.map((a) => `${a}=${(P.proxies || {})[a] || "?"}`).join(" · ")}`),
    el("p", {}, P.method || ""),
    el("p", {}, "대분류 초기 세팅: 주식·채권·대체의 상대비를 유지한 채 (100−유동성)% 로 " +
      "비례 축소하고, 그룹 안은 균등 분할(달러/원화 유동성 동일 비중은 사용자 지정)합니다. " +
      "50+30+20=100 과 「유동성 10% 내외」가 동시에 성립하도록 채택한 규칙입니다."),
    el("p", {}, "CMA 키인은 이 브라우저(localStorage)에 즉시 저장됩니다. 「CMA JSON 내보내기」로 만든 " +
      "내용을 비공개 Data 저장소의 port_cma.json 으로 커밋하면 다음 빌드부터 모든 브라우저의 " +
      "디폴트로 실립니다 — 그 값은 공개 대시보드 JSON 에 게시됩니다(원본 지수 값은 게시되지 않습니다).")));

  /* ① 대분류 초기 세팅 */
  const gWrap = el("div", { class: "port-groups" });
  const gInputs = {};
  const preview = el("div", { class: "port-preview" });
  const grpRow = (label, get, set, min, max) => {
    const inp = el("input", { type: "number", step: "0.5", min: String(min), max: String(max),
                              value: String(get()), "aria-label": `대분류 ${label}` });
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      set(isFinite(v) ? v : 0);
      updPreview();
    });
    gInputs[label] = inp;
    return el("label", { class: "port-grp" }, `${label} `, inp, " %");
  };
  gWrap.append(
    grpRow("주식", () => st.grp["주식"], (v) => { st.grp["주식"] = v; }, 0, 100),
    grpRow("채권", () => st.grp["채권"], (v) => { st.grp["채권"] = v; }, 0, 100),
    grpRow("대체", () => st.grp["대체"], (v) => { st.grp["대체"] = v; }, 0, 100),
    grpRow("유동성", () => st.liq, (v) => { st.liq = v; },
           (P.defaults.liq_range || [0, 20])[0], (P.defaults.liq_range || [0, 20])[1]));
  const applyBtn = el("button", { class: "btn-primary", onclick: () => {
    const mix = portMixFromGroups(P, st.grp, st.liq);
    P.assets.forEach((a) => {
      st.mix[a] = mix[a];
      if (mixInputs[a]) mixInputs[a].value = String(mix[a]);
    });
    recalc();
  } }, "7자산군에 적용");
  gWrap.append(applyBtn);
  box.append(el("div", { class: "port-sec-title" },
    "① 대분류 초기 세팅 — 유동성만큼 주식·채권·대체를 비례 축소"), gWrap, preview);
  function updPreview() {
    const mix = portMixFromGroups(P, st.grp, st.liq);
    preview.textContent = "적용 시: " +
      P.assets.map((a) => `${a} ${fmtNum(mix[a], 1)}`).join(" · ") + " (합계 100.0)";
  }
  updPreview();

  /* ② 자산군 표 — 비중(시뮬레이션·저장 안 함) + CMA μ 키인(모형 입력·즉시 저장) */
  const E0 = portEngine(P, st);
  const mixInputs = {}, srcCells = {};
  const table = el("table", { class: "port-table" });
  table.append(el("thead", {}, el("tr", {},
    ...["자산군", "비중 %", "기대수익 μ % (키인)", "μ 출처", `σ % (${portWinLabel(W.key)})`,
        "10년 참고 μ/σ"].map((h) => el("th", {}, h)))));
  const tbody = el("tbody");
  P.assets.forEach((a, i) => {
    const wInp = el("input", { type: "number", step: "0.1", min: "0", max: "100",
                               value: String(st.mix[a]), "aria-label": `${a} 비중` });
    wInp.addEventListener("input", () => {
      const v = parseFloat(wInp.value);
      st.mix[a] = isFinite(v) ? v : 0;
      recalc();
    });
    mixInputs[a] = wInp;
    const dflt = (P.cma_input && P.cma_input.mu_pct && P.cma_input.mu_pct[a] != null)
      ? P.cma_input.mu_pct[a] : E0.W.mean_pct[i];
    const muInp = el("input", { type: "number", step: "0.01",
                                placeholder: fmtNum(dflt, 2), "aria-label": `${a} 기대수익` });
    if (st.mu[a] != null && isFinite(+st.mu[a])) muInp.value = String(st.mu[a]);
    muInp.addEventListener("input", () => {
      const v = parseFloat(muInp.value);
      if (isFinite(v)) st.mu[a] = v; else delete st.mu[a];
      portSaveState(st);
      const E = portEngine(P, st);
      srcCells[a].textContent = E.src[i];
      recalc();
    });
    const srcCell = el("td", {}, E0.src[i]);
    srcCells[a] = srcCell;
    const r10 = (P.ref10y && P.ref10y.per_asset && P.ref10y.per_asset[a]) || null;
    const cdRef = a === "원화유동성" && !r10 && P.krw_liq_ref ? P.krw_liq_ref : null;
    const refCell = r10 ? `${fmtNum(r10.mean_pct, 1)} / ${fmtNum(r10.vol_pct, 1)}`
      : cdRef ? el("span", { title: `${cdRef.note} · ${cdRef.start}~${cdRef.end}`
          + (cdRef.overlap ? ` · 실ETF 겹침 ${cdRef.overlap.n_months}개월 corr ${fmtNum(cdRef.overlap.corr, 2)}` : "") },
          `${fmtNum(cdRef.mean_pct, 1)} / ${fmtNum(cdRef.vol_pct, 1)} (CD 적립 참고)`)
      : "–";
    tbody.append(el("tr", {},
      el("td", {}, a),
      el("td", { class: "num" }, wInp),
      el("td", { class: "num" }, muInp),
      srcCell,
      el("td", { class: "num" }, fmtNum(W.vol_pct[i], 2)),
      el("td", { class: "num" }, refCell)));
  });
  table.append(tbody);
  const sumBadge = el("span", { class: "port-badge" });
  const saveNote = el("span", { class: "port-note" },
    "비중·대분류는 저장 전까지 이 화면에만 적용됩니다(μ 키인은 즉시 저장).");
  const btnRow = el("div", { class: "port-btns" },
    sumBadge,
    el("button", { class: "btn-ghost", onclick: () => { portSaveState(st); renderPortPanel(A); } },
      "기본값으로 저장"),
    el("button", { class: "btn-ghost", onclick: () => { renderPortPanel(A); } },
      "저장값으로 되돌리기"),
    el("button", { class: "btn-ghost", onclick: () => {
      st.mu = {}; portSaveState(st); renderPortPanel(A);
    } }, "μ 디폴트로 되돌리기"),
    el("button", { class: "btn-ghost", onclick: () => { expWrap.hidden = !expWrap.hidden; } },
      "CMA JSON 내보내기"),
    saveNote);
  box.append(el("div", { class: "port-sec-title" }, "② 자산군 비중 · CMA 기대수익 키인"),
    el("div", { class: "table-wrap" }, table), btnRow);

  const expTa = el("textarea", { class: "port-export", readonly: "", rows: "11",
                                 "aria-label": "CMA JSON" });
  const expWrap = el("div", { class: "port-export-wrap" }, expTa,
    el("div", { class: "port-note" },
      "위 내용을 비공개 Data 저장소에 port_cma.json 으로 저장하면 다음 빌드부터 " +
      "디폴트로 실립니다. 이 값은 공개 대시보드 JSON 에 게시됩니다."));
  expWrap.hidden = true;
  box.append(expWrap);

  /* ③ 효율적 경계선 + ④ 벤치마크 성과 리뷰 */
  const frontCard = el("div", { class: "card port-sub-card" });
  const reviewCard = el("div", { class: "card port-sub-card" });
  box.append(el("div", { class: "port-two" }, frontCard, reviewCard));

  function recalc() {
    const E = portEngine(P, st);
    const sum = P.assets.reduce((s, a) => s + (+st.mix[a] || 0), 0);
    const sumOk = Math.abs(sum - 100) <= 0.05;
    sumBadge.textContent = `합계 ${fmtNum(sum, 1)}%` + (sumOk ? "" : " — 100% 아님");
    sumBadge.className = "port-badge" + (sumOk ? "" : " d-up");
    expTa.value = JSON.stringify({
      asof: new Date().toISOString().slice(0, 10),
      mu_pct: Object.fromEntries(P.assets.map((a, i) => [a, +E.mu[i].toFixed(4)])),
      note: "워크벤치 화면에서 내보낸 CMA 기대수익 (연 %)",
    }, null, 2);

    const wCur = sumOk ? P.assets.map((a) => (+st.mix[a] || 0) / 100) : null;
    const pts = E.front;
    const fbox = cardScaffold(frontCard, {
      title: "효율적 경계선 — 합계 100 · 공매도 금지",
      sub: `μ 출처 혼합(키인/CMA 파일/과거 평균) · 무위험 = 원화유동성 μ ${fmtNum(E.rf, 2)}%`,
      csvName: "효율적경계선.csv",
      tableFn: () => ({
        headers: ["위험%", "기대수익%", ...P.assets.map((a) => `${a}%`)],
        rows: pts.map((p) => [fmtNum(p.sig, 2), fmtNum(p.mu, 2),
                              ...p.w.map((x) => fmtNum(x * 100, 1))]),
      }),
    });
    const markers = [];
    if (E.minVar) markers.push({ x: E.minVar.sig, y: E.minVar.mu, kind: "dot",
                                 label: "최소위험", color: pal.series[1] });
    if (E.maxSharpe) markers.push({ x: E.maxSharpe.sig, y: E.maxSharpe.mu, kind: "tri",
                                    label: "최적(샤프)", color: pal.series[1] });
    markers.push({ x: E.bench.sig, y: E.bench.mu, kind: "dot",
                   label: "BM 60/40", color: pal.series[2] });
    if (wCur) markers.push({ x: E.sig(wCur), y: E.muOf(wCur), kind: "x", label: "현재" });
    const xsF = pts.map((p) => +p.sig.toFixed(3));
    const ysF = pts.map((p) => +p.mu.toFixed(3));
    const mxs = markers.map((m) => m.x), mys = markers.map((m) => m.y);
    const hover = el("div", { class: "port-hover" });
    const hoverReset = () => {
      hover.textContent = "선 위에 마우스를 올리면 그 점의 위험·수익·배분이 여기에 표시됩니다.";
    };
    hoverReset();
    portCharts.push(makeRatioChart(fbox, {
      seriesDefs: [{ label: "경계선", color: pal.series[0], x: xsF, v: ysF }],
      xLabel: "위험(연)", unit: "%", height: 260, markers,
      xRange: [Math.min(...xsF, ...mxs) * 0.9, Math.max(...xsF, ...mxs) * 1.05],
      yRange: [Math.min(...ysF, ...mys) - 0.3, Math.max(...ysF, ...mys) + 0.3],
      onCursor: (idx) => {
        if (idx == null || !pts[idx]) { hoverReset(); return; }
        const p = pts[idx];
        const sh = p.sig > 1e-9 ? (p.mu - E.rf) / p.sig : null;
        hover.textContent =
          `위험 ${fmtNum(p.sig, 2)}% · 기대수익 ${fmtNum(p.mu, 2)}% · 샤프 ${fmtNum(sh, 2)} — 배분: ` +
          P.assets.map((a, i) => `${a} ${fmtNum(p.w[i] * 100, 1)}`).join(" · ");
      },
    }));
    frontCard.append(hover);

    reviewCard.textContent = "";
    reviewCard.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "벤치마크 대비 성과 리뷰"),
      el("span", { class: "card-sub" },
        `BM = S&P500_TR(원화) 60 / 한국종합 40 · 창 ${portWinLabel(E.W.key)}`)));
    const rows = [];
    const fmtRow = (name, m) => [name, fmtNum(m.mu, 2), fmtNum(m.sig, 2), fmtNum(m.sharpe, 2),
                                 fmtNum(m.act, 2), fmtNum(m.te, 2), fmtNum(m.ir, 2)];
    if (wCur) rows.push(fmtRow("현재 배분", E.metrics(wCur)));
    if (E.maxSharpe) rows.push(fmtRow("최적(최대 샤프)", E.metrics(E.maxSharpe.w)));
    if (E.minVar) rows.push(fmtRow("최소위험", E.metrics(E.minVar.w)));
    rows.push(["벤치마크 60/40", fmtNum(E.bench.mu, 2), fmtNum(E.bench.sig, 2),
               fmtNum(E.bench.sig > 1e-9 ? (E.bench.mu - E.rf) / E.bench.sig : null, 2),
               "0.00", "0.00", "–"]);
    const wrap = el("div", { class: "table-wrap" });
    renderTable(wrap, {
      headers: ["구분", "기대수익%", "위험%", "샤프", "초과수익%p", "TE%p", "IR"], rows });
    reviewCard.append(wrap);
    if (!wCur) reviewCard.append(el("div", { class: "port-warn d-up" },
      `합계 ${fmtNum(sum, 1)}% — 100% 가 아니라 현재점을 계산하지 않았습니다(몰래 정규화하지 않습니다).`));
    const wb = E.W.bench || null;
    if (wb) reviewCard.append(el("div", { class: "port-note" },
      `실현 성과(창 ${portWinLabel(E.W.key)} · 월별 리밸런싱): BM μ ${fmtNum(wb.mean_pct, 2)}% · ` +
      `σ ${fmtNum(wb.vol_pct, 2)}% · MDD ${fmtNum(wb.mdd_pct, 2)}%`));
    const rb10 = P.ref10y && P.ref10y.bench;
    if (rb10) reviewCard.append(el("div", { class: "port-note" },
      `실현 성과(10년 참고 ${rb10.start}~${rb10.end}): BM μ ${fmtNum(rb10.mean_pct, 2)}% · ` +
      `σ ${fmtNum(rb10.vol_pct, 2)}% · MDD ${fmtNum(rb10.mdd_pct, 2)}%`));
  }
  recalc();
}

function renderAlloc() {
  const A = DATA.alloc;
  if (!$("#alloc")) return;
  if (!A || !A.sets || !A.sets.length) {
    $("#alloc-headline").textContent = "자산배분 데이터를 불러오지 못했습니다.";
    return;
  }
  allocCharts.forEach(destroyChart);
  allocCharts = [];
  allocTvCharts.forEach(destroyChart);
  allocTvCharts = [];
  const pal = palette();
  const st = allocState(A);

  /* 기준선 = 마지막으로 **저장된** 상태(없으면 예시값). 시뮬레이션 조정(st)이 여기서
     얼마나 벗어났는지를 요약·투자선 마커가 이 스냅숏과 비교해 보여준다.
     저장 버튼 → renderAlloc 재실행 → 기준선이 새 저장값으로 갱신되는 구조다. */
  const baseSt = allocState(A);
  const baseE = allocEngine(A, baseSt);
  const baseSig = baseE.sigmaW(baseE.w0, baseE.V.C);
  const baseMu = amDot(baseE.V.mu, baseE.w0);
  const baseXe = baseE.xeOf(baseSt.h_bond / 100, baseSt.h_eq / 100);

  /* 컨텐츠 탭(목차) — 화면이 길어져 상단에서 각 구역으로 바로 이동한다.
     해시(href="#…")를 쓰지 않는 이유: 해시는 섹션 라우팅 축이라(routeView)
     섹션 안 앵커로 쓰면 마을로 튕긴다 — 버튼 + scrollIntoView 로만 움직인다. */
  const toc = $("#alloc-toc");
  toc.textContent = "";
  [["시뮬레이터", "#alloc-sim-panel"], ["포트폴리오 구성", "#alloc-port-panel"],
   ["요약", "#alloc-summary"], ["설정", "#alloc-controls"],
   ["참고치", "#alloc-cards"], ["투자선", "#alloc-frontier-card"], ["시변·민감도", "#alloc-tv-card"],
   ["특성", "#alloc-char-card"], ["자산군 표", "#alloc-table-card"], ["방법론", "#alloc-method"]]
    .forEach(([label, sel]) => {
      toc.append(el("button", { type: "button", onclick: () => {
        const n = $(sel);
        if (n && n.scrollIntoView) n.scrollIntoView({ block: "start" });
      } }, label));
    });

  renderPortPanel(A);

  /* 층·창·매핑 표식용 엔진 한 벌 — recalc 는 매번 새로 만들므로 이건 표시 전용이다 */
  const E0 = allocEngine(A, st);

  /* ---- ⓪ 포트폴리오 시뮬레이터 (§7.7.8 — 화면 최상단, 2026-08-11 사용자 지시) ----
     7자산군(시가 기준 — 장부가 축 제외 §7.7.11) μ·σ 키인 → λ-MVO 최적 배분(막대 위
     ▼ + 도넛) + 비중 막대 드래그 즉시 시뮬레이션(카드 + 도넛). 비중 = 시뮬레이션
     (즉시 반영·저장 안 함 — 기존 조작/저장 분리 승계), μ·σ = 모형 입력(즉시 저장 —
     cost/매핑과 같은 규약). 비중 표시·입력은 0.1%p 단위(2026-08-12 사용자 지시).
     이 배치가 2026-08-05 「요약 먼저」 동선을 대체한다(HANDOVER §7.7.8). */
  const simBox = $("#alloc-sim-panel");
  let simDyn = null;
  {
    simBox.textContent = "";
    const target = () => 100;   // 대출금·장부가 축 제외(2026-08-12) — 7개 자산군이 합 100
    const lockSeg = el("div", { class: "seg", role: "group" });
    const mkLock = (label, v) => el("button", {
      class: st.sum_lock === v ? "active" : "",
      onclick: () => { st.sum_lock = v; allocSaveState(st); renderAlloc(); } }, label);
    lockSeg.append(mkLock("자유 조정", false), mkLock("합계 100% 유지", true));
    simBox.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "포트폴리오 시뮬레이터 — 기대수익·위험 키인 → 최적 배분 + 즉시 시뮬레이션"),
      el("span", { class: "card-sub" },
        `7자산군 · 시가 기준 · λ=${fmtNum(+st.mvo_lambda || 1, 1)}` +
        (E0.layer === "cma" ? "" : " · 프록시층 — 최적·σ 키인은 벤치마크 층 전용")),
      el("span", {}, lockSeg)));
    simBox.append(explainBox("alloc-sim-head",
      "장부가 축은 배분 우주에서 제외했습니다(2026-08-12 — 원가법 BM 은 시장위험을 나르지 " +
      "않아 MVO 대상이 아닙니다). 최적 = λ-효용 MVO(λ = 위험회피계수, 클수록 보수적)이고, " +
      "벤치마크 층에서 상관은 벤치마크 실측 ρ 를 유지합니다."));

    /* ---- λ(위험회피계수) 선택 — 2026-08-12 사용자 지시 「람다도 선택할 수 있게」 ----
       모형 입력이라 즉시 저장한다(μ·σ 키인과 같은 규약 — 비중만 시뮬레이션이다).
       **권장값을 코드에 박지 않는다**: λ 는 관측되지 않는 선호 모수라 "보험사 표준
       숫자" 같은 것이 없고(자의성 금지), 대신 관측 가능한 앵커를 역산해 준다 —
       ⓐ 현재 배분의 위험을 재현하는 λ(아래 버튼) ⓑ 화면에서 λ 를 바꿔 가며 보기. */
    const lamIn = el("input", { type: "number", step: "0.1", min: "0.02",
      value: String(+st.mvo_lambda || 1), id: "alloc-lambda",
      style: "width:88px", "aria-label": "위험회피계수 λ" });
    lamIn.addEventListener("change", () => {
      const v = +lamIn.value;
      st.mvo_lambda = isFinite(v) && v > 0 ? v : 1;
      allocSaveState(st);
      renderAlloc();
    });
    const lamNote = el("span", { style: "color:var(--ink-3);font-size:12px" });
    const lamFit = el("button", { type: "button", class: "btn-ghost", onclick: () => {
      /* 현재 배분의 위험을 재현하는 λ — 관측 앵커(역최적화). 비중이 밴드 밖이거나
         탐색 구간 밖이면 **그 사실을 적고** 값을 바꾸지 않는다(조용한 대체 금지). */
      const Ef = allocEngine(A, st);
      const sigCur = Ef.sigmaW(Ef.w0, Ef.V.C);
      const fit = allocLambdaForSigma(Ef, sigCur);
      if (!fit) { lamNote.textContent = "현재 위험을 읽을 수 없습니다."; return; }
      if (fit.bounded) {
        lamNote.textContent = fit.bounded === "low"
          ? `현재 위험 ${fmtNum(sigCur, 2)}% 는 λ→0 의 최적(${fmtNum(fit.sig, 2)}%)보다도 높습니다 — 재현하는 λ 가 없습니다(밴드 확인).`
          : `현재 위험 ${fmtNum(sigCur, 2)}% 는 λ→∞ 의 최소위험(${fmtNum(fit.sig, 2)}%)보다 낮습니다 — 재현하는 λ 가 없습니다.`;
        return;
      }
      st.mvo_lambda = +fit.lam.toFixed(2);
      allocSaveState(st);
      renderAlloc();
    } }, "현재 위험과 같은 λ 찾기");
    simBox.append(el("div", { class: "tenor-row", style: "margin:2px 0 8px" },
      el("b", { style: "font-size:12.5px" }, "위험회피계수 λ"), lamIn, lamFit, lamNote,
      explainBox("alloc-lambda",
        "최적 = max(기대수익 − λ/2 × 분산). 클수록 보수적이고, λ→∞ 는 최소위험 · λ→0 은 " +
        "기대수익 최대(밴드까지 몰림)입니다. 소수 단위 — λ=1 이면 위험 5→6%를 " +
        "기대수익 +0.06%p 로 교환합니다. 관측되지 않는 선호 모수라 표준값이 없어 " +
        "권장값을 넣지 않았습니다: 「현재 위험과 같은 λ」로 지금 배분이 함의하는 값을 " +
        "역산해 출발점으로 쓰십시오.")));

    const simSum = el("span", { class: "sim-sum" });
    const refreshSimSum = () => {
      const sum = ALLOC_ECON.reduce((a, k) => a + (st.mix[k] || 0), 0);
      const off = Math.abs(sum - target()) > 0.05;
      simSum.textContent = `합계 ${fmtNum(sum, 1)}% / 목표 ${fmtNum(target(), 1)}%`;
      simSum.classList.toggle("warn", off);
      return off;
    };
    const rowRefs = {};
    const syncRow = (k) => {
      const rr = rowRefs[k];
      if (!rr) return;
      const v = st.mix[k] || 0;
      rr.bar.value = String(v);
      rr.num.value = String(v);
    };
    const applyWeight = (k, v, final) => {
      const v1 = Math.round(Math.max(0, v) * 10) / 10;   // 0.1%p 단위(2026-08-12)
      if (st.sum_lock) {
        st.mix = allocRedistribute(st.mix, k, v1, target());
        ALLOC_ECON.forEach(syncRow);
      } else {
        st.mix[k] = v1;
        syncRow(k);
      }
      refreshSimSum();
      markDirty();
      recalc(!!final);
    };
    const rows = el("div", { class: "sim8" });
    rows.append(el("div", { class: "sim8-row sim8-head" },
      el("span", {}, "자산군"), el("span", {}, "비중 막대 — 끌어서 조정 (▼ = 최적)"),
      el("span", {}, "비중%"), el("span", {}, "기대수익%"), el("span", {}, "위험%")));
    ALLOC_ECON.forEach((k, i) => {
      const color = pal.series[i % pal.series.length];
      const bar = el("input", { type: "range", min: "0", max: "100", step: "0.1",
        value: String(st.mix[k] || 0), "aria-label": `${k} 비중 % (막대)` });
      const mark = el("span", { class: "sim-opt-mark", hidden: true, title: `${k} 최적 비중` }, "▼");
      const barWrap = el("div", { class: "sim-bar-wrap" }, bar, mark);
      bar.addEventListener("input", () => applyWeight(k, +bar.value, false));
      bar.addEventListener("change", () => applyWeight(k, +bar.value, true));
      const num = el("input", { type: "number", step: "0.1",
        value: String(st.mix[k] || 0), id: "sim-mix-" + k.replace(/\s+/g, "-"),
        "aria-label": `${k} 비중 %` });
      num.addEventListener("input", () => applyWeight(k, num.value === "" ? 0 : +num.value, false));
      num.addEventListener("change", () => applyWeight(k, num.value === "" ? 0 : +num.value, true));
      const muVal = st.mu_over[k];
      const muDflt = st.mu_dflt ? st.mu_dflt[k] : null;
      const muIn = el("input", { type: "number", step: "0.05",
        value: muVal == null ? "" : String(muVal), placeholder: "앵커/관측",
        "aria-label": `${k} 기대수익 % 키인` });
      /* 게시 디폴트를 툴팁에 상시 노출하고, 저장된 값이 그와 다르면 화면에서 보이게
         표시한다 — 옛 저장분이 새 디폴트를 덮고 있어도 눈에 띄도록(실측 사고 대응) */
      if (muDflt != null) {
        muIn.title = `게시 디폴트 ${fmtNum(muDflt, 2)}%`
          + (muVal != null && Math.abs(+muVal - +muDflt) > 1e-9
            ? ` — 지금 값은 수기 입력분입니다(디폴트로 되돌리려면 아래 「μ·σ 디폴트로 되돌리기」)` : "");
        if (muVal != null && Math.abs(+muVal - +muDflt) > 1e-9) muIn.classList.add("keyed-off-default");
      }
      muIn.addEventListener("change", () => {
        const v = muIn.value === "" ? null : +muIn.value;
        st.mu_over[k] = v != null && isFinite(v) ? v : null;
        allocSaveState(st);
        renderAlloc();
      });
      const as = E0.cmaSigInfo ? E0.cmaSigInfo(k) : null;
      const isAlt = allocIsAlt(k);
      /* 회색 값 = placeholder 지만 장식이 아니다 — 칸이 비어 있으면 벤치마크 실측 σ
         가 **그 숫자 그대로** 공분산에 들어간다(미입력 = 실측 적용. 프로브
         domesticEquityVarExact 등이 행렬 원소 = 벤치마크 공분산임을 실행으로 확인).
         "적용 중"을 붙여 미반영으로 오독되지 않게 한다(2026-08-12 사용자 질문). */
      const sgIn = el("input", { type: "number", step: "0.1", min: "0",
        value: !isAlt && st.sig_over[k] != null ? String(st.sig_over[k]) : "",
        placeholder: !as ? "벤치마크 층 전용" : isAlt ? "매핑이 정함" : `실측 ${fmtNum(as.obs, 2)} 적용 중`,
        "aria-label": `${k} 위험 % 키인` });
      if (!as || isAlt) sgIn.disabled = true;
      if (isAlt) sgIn.title = "대체투자 위험은 σ 키인이 아니라 설정의 「대체투자 위험 (분류별)」 매핑 콘솔이 정합니다";
      else if (as) sgIn.title = `비워 두면 벤치마크 실측 σ ${fmtNum(as.obs, 2)}% 가 그대로 계산에 들어갑니다 — 회색 표시는 적용 중인 값입니다`;
      sgIn.addEventListener("change", () => {
        const v = sgIn.value === "" ? null : +sgIn.value;
        st.sig_over[k] = v != null && isFinite(v) && v > 0 ? v : null;
        allocSaveState(st);
        renderAlloc();
      });
      rows.append(el("div", { class: "sim8-row" },
        el("span", { class: "sim8-name" }, el("i", { class: "sim-dot", style: `background:${color}` }), k),
        barWrap, num, muIn, sgIn));
      rowRefs[k] = { bar, num, mark };
    });
    simBox.append(rows);

    /* ---- ② 트랙의 헤지 슬라이더(§7.7.13) — 설정 구역에서 시뮬레이터로 이사 ----
       배분 2트랙(최적/시뮬)과 매칭되는 헤지 2트랙(2026-08-12 사용자 지시): ① 최적
       카드가 배분+헤지 한 쌍을 내고, 이 슬라이더가 ② 시뮬 트랙의 헤지다. 규약은
       비중 막대와 동일 — 즉시 반영·저장 안 함(저장은 「기본값으로 저장」 버튼만). */
    const hedgeRefs = {};
    const mkHedge = (label, key) => {
      const lbl = el("span", { class: "hlbl" }, `${st[key]}%`);
      const inp = el("input", { type: "range", min: "0", max: "100", step: "1",
        value: String(st[key]), "aria-label": label });
      /* 비중 막대와 같은 방식의 최적 위치 마커(2026-08-12 사용자 지시 "환헤지 비율도
         최적을 표시"). 다만 의미가 다르다 — 헤지쌍은 유일하지 않으므로(Xe 붕괴)
         이 마커는 **대표점**이고, title/aria 로 그 사실을 밝힌다. 비중 0 슬리브의
         마커는 아예 숨긴다(위험에 무영향인 축에 「최적」을 찍으면 거짓 정보다). */
      const mark = el("span", { class: "sim-opt-mark", hidden: true }, "▼");
      const wrap = el("div", { class: "sim-bar-wrap" }, inp, mark);
      inp.addEventListener("input", () => {
        st[key] = +inp.value;
        lbl.textContent = `${st[key]}%`;
        markDirty();
        recalc(false);
      });
      inp.addEventListener("change", () => recalc(true));
      hedgeRefs[key] = { inp, lbl, mark };
      return el("div", {},
        el("div", { style: "font-size:12.5px" }, el("b", {}, label)),
        el("div", { style: "display:flex;gap:8px;align-items:center" }, wrap, lbl));
    };
    /* 대체투자 환헤지 — 슬라이더 모양은 위와 같지만 **트랙이 다르다**(§7.7.20):
       최적 ▼ 마커가 없고(최적화가 고르는 축이 아니다), 조정하면 **즉시 저장**한다
       (모형 입력 — μ·σ·λ 와 같은 규약). markDirty() 를 부르지 않는 이유가 그것이다 —
       "저장 안 된 조정"이 아니므로 배지를 띄우면 사용자를 헷갈리게 한다. */
    const altHedgeBox = () => {
      const lbl = el("span", { class: "hlbl" }, `${st.h_alt}%`);
      const inp = el("input", { type: "range", min: "0", max: "100", step: "1",
        value: String(st.h_alt), "aria-label": "대체투자 환헤지 비율" });
      inp.addEventListener("input", () => {
        st.h_alt = +inp.value;
        lbl.textContent = `${st.h_alt}%`;
        recalc(false);
      });
      inp.addEventListener("change", () => { allocSaveState(st); recalc(true); });
      return el("div", { style: "margin-top:8px" },
        el("div", { style: "font-size:12.5px" },
          el("b", {}, "대체투자 환헤지 비율"),
          el("span", { style: "color:var(--ink-3);font-size:11.5px;margin-left:6px" },
            "모형 입력 — 즉시 저장 · 최적화 대상이 아닙니다")),
        /* 래퍼에 `sim-alt-hedge` 를 더 단다 — 위 두 레버와 **다른 트랙**이라
           래퍼만 세는 검사가 이 칸을 헤지 레버로 잘못 세지 않게 하는 자리다
           (§7.7.15 의 `.sim-bar-wrap` 함정과 같은 종류). */
        el("div", { style: "display:flex;gap:8px;align-items:center" },
          el("div", { class: "sim-bar-wrap sim-alt-hedge" }, inp), lbl),
        explainBox("alloc-alt-hedge",
          "매핑 팩터인 시가 해외주식이 미헤지 계열이라 대체투자에 환이 딸려 옵니다 — 그 몫에 이 비율을 겁니다. ",
          "위 두 슬라이더와 달리 ", el("b", {}, "Xe 에는 들어가지 않습니다"),
          " (최적 헤지쌍이 여기 값을 덮어쓰지 않도록). 총 환노출은 아래 레버 문단이 Xe 와 나눠 적습니다."));
    };
    const syncHedgeUi = () => {
      ["h_bond", "h_eq"].forEach((k) => {
        const r = hedgeRefs[k];
        if (!r) return;
        r.inp.value = String(st[k]);
        r.lbl.textContent = `${st[k]}%`;
      });
    };
    /* 최적 헤지쌍을 슬라이더 위 ▼ 로 — opt 이 없거나 그 슬리브가 무영향이면 숨긴다 */
    const syncHedgeMarks = (opt) => {
      [["h_bond", "hb", "inertBond", "해외채권"], ["h_eq", "he", "inertEq", "해외주식"]]
        .forEach(([k, hk, inertK, name]) => {
          const r = hedgeRefs[k];
          if (!r) return;
          const show = !!(opt && opt.fxLive && !opt[inertK]);
          r.mark.hidden = !show;
          if (!show) return;
          r.mark.style.left = `${Math.min(100, Math.max(0, opt[hk] * 100))}%`;
          r.mark.title = `${name} 최적 헤지비율 ${fmtNum(opt[hk] * 100, 0)}% — `
            + "같은 미헤지 환노출(Xe)을 만드는 조합 중 현재값 최근접 대표점입니다";
          r.mark.setAttribute("aria-label", `${name} 최적 헤지비율(대표점) ${fmtNum(opt[hk] * 100, 0)}%`);
        });
    };
    simBox.append(el("div", { class: "sim-hedge-row",
      style: "display:flex;gap:26px;flex-wrap:wrap;align-items:center;margin-top:8px" },
      el("b", { style: "font-size:12.5px" }, "② 시뮬레이션 헤지비율"),
      mkHedge("해외채권 헤지비율", "h_bond"), mkHedge("해외주식 헤지비율", "h_eq"),
      el("span", { style: "color:var(--ink-3);font-size:11.5px" }, "즉시 반영 · 저장 안 함"),
      explainBox("alloc-hedge-sliders",
        "위험은 총 미헤지 환노출(Xe)로만 움직이므로, 같은 Xe 를 만드는 " +
        "조합은 위험이 정확히 같습니다. ① 최적 카드의 헤지쌍은 그 동점 중 현재값 최근접 대표점입니다."),
      /* 대체투자 헤지는 **위 둘과 다른 칸이다**(§7.7.20 — 2026-08-19 사용자 지시).
         최적화가 고르는 레버가 아니라 「지금 이렇게 운용 중」을 넣는 모형 입력이라
         μ·σ·λ 와 같이 **즉시 저장**하고, Xe 에도 넣지 않는다(합치면 최적 헤지쌍이
         사용자가 정한 값을 덮어쓴다). 두 분류에 같은 비율을 걸지만 매핑이 다르면
         환노출은 자동으로 달라진다 — 매핑이 채권 100%면 걸 환이 없어 0 이다. */
      altHedgeBox()));

    const fillCash = el("button", { type: "button", class: "btn-ghost", onclick: () => {
      /* 합계를 몰래 맞추지 않는다 — 사용자가 눌렀을 때만 잔여를 단기자금으로 채운다 */
      const others = ALLOC_ECON.filter((x) => x !== "단기자금")
        .reduce((a, x) => a + (st.mix[x] || 0), 0);
      st.mix["단기자금"] = Math.max(0, +(target() - others).toFixed(1));
      syncRow("단기자금");
      refreshSimSum();
      markDirty();
      recalc(true);
    } }, "잔여 → 단기자금");
    const dynBox = el("div", { class: "sim8-dyn" });
    simBox.append(el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px" },
      simSum, st.sum_lock ? "" : fillCash,
      el("span", { style: "color:var(--ink-3);font-size:11.5px" },
        "비중 = 즉시 반영·저장 안 함 · μ·σ = 즉시 저장 · 회색 σ = 적용 중"),
      explainBox("alloc-sim-tracks",
        "비중은 즉시 반영·저장 안 함(저장은 아래 「기본값으로 저장」) · μ·σ 키인은 모형 입력이라 즉시 저장 · " +
        "μ 디폴트 = 사용자 지정 CMA(키인은 최종치 — 헤지캐리 미가산 §7.7.10) · " +
        "위험 칸의 회색 숫자 = 적용 중인 벤치마크 실측 σ(기본 5년 창 — 게시 전에는 최장 창): " +
        "비워 두면 그 값이 그대로 계산에 들어가고, 키인하면 키인 σ × 실측 ρ 로 대체 · 키인 σ 는 그 계열 벤치마크와 같은 환 기준(해외채권=헤지 후, 해외주식=환노출 포함)")),
      dynBox);
    refreshSimSum();

    /* 동적 갱신 — ① 최적은 **목표 합계 100% 기준**이라 비중(합계 표류 포함)과
       무관하다: μ·σ·λ·헤지를 안 바꿨는데 막대를 끌었다고 최적이 움직이면 안 된다
       (2026-08-12 사용자 발견 — 구현이 예산을 현재 합계로 풀어 드래그마다 최적이
       따라 움직였다). 드래그 중(recalc(false))에는 캐시를 쓰고, 시뮬 카드·도넛·
       합계만 매번 갱신한다. */
    let optCache = null;
    simDyn = (Es, withCharts) => {
      const w = ALLOC_ECON.map((k) => (st.mix[k] || 0) / 100);
      const V8 = Es.V;
      const hbS = st.h_bond / 100, heS = st.h_eq / 100;
      const sim = { mu: amDot(V8.mu, w), sig: Es.sigmaW(w, V8.C),
                    xe: Es.fxLive ? Es.xeOfW(w, hbS, heS) : null };
      /* ② 트랙의 헤지 참고 — 이 배분 기준 위험최소 Xe·대표쌍(요약 hq 와 같은 계산) */
      let simRef = null;
      if (Es.fxLive && Es.layer === "cma") {
        const q = Es.xeQuadW(w);
        const hbnds = allocHBands(st);
        const [[blo, bhi], [elo, ehi]] = hbnds;
        const xeB = Es.xeStar(w[1] * (1 - bhi) + w[3] * (1 - ehi),
                              w[1] * (1 - blo) + w[3] * (1 - elo), q);
        simRef = { xe: xeB, sig: Es.sigmaXe(xeB, q),
                   pair: Es.hedgePairForXeW(w, xeB, [hbS, heS], hbnds) };
      }
      /* 실행 가능성도 목표 100% 기준으로 검사한다 — 현재 합계 기준이면 표류가
         최적 카드를 껐다 켰다 한다 */
      const canOpt = Es.layer === "cma"
        && allocFeasibility({ lo: Es.lo, hi: Es.hi, total: 1, groups: Es.groups }).length === 0;
      if (withCharts || optCache == null) {
        /* ① 최적 = 배분+헤지 동시(교대) 최적 — §7.7.13. 드래그 중에는 캐시. */
        optCache = canOpt ? allocJointOpt(Es, st) : null;
      }
      const opt = optCache;
      ALLOC_ECON.forEach((k, i) => {
        const rr = rowRefs[k];
        if (!rr) return;
        rr.mark.hidden = !opt;
        if (opt) rr.mark.style.left = `${Math.min(100, Math.max(0, opt.w[i] * 100))}%`;
      });
      syncHedgeMarks(opt);
      dynBox.textContent = "";
      /* 카드 아래 중앙에 그 카드의 도넛(2026-08-12 사용자 지시) — ① 최적 카드+최적
         도넛, ② 시뮬 카드+시뮬 도넛을 세로 열로 묶어 위치를 일치시킨다. */
      /* 기대수익이 크고 위, 위험이 작고 아래 (2026-08-12 사용자 지시) — 담당자가
         먼저 보는 수가 기대수익이라는 판단. 라벨 문자열("위험 "/"기대수익 ")은
         그대로 둔다(다른 검사가 문자열을 본다 — 크기·순서만 바꾼다). */
      const card8 = (title, mu, sig, note, strong) => el("div",
        { class: "card sim8-card" + (strong ? " sim8-strong" : "") },
        el("div", { class: "card-title" }, title),
        el("div", { style: "font-size:19px;font-weight:700;margin:4px 0 2px" }, `기대수익 ${fmtNum(mu, 2)}%`),
        el("div", { style: "font-size:13px" }, `위험 ${fmtNum(sig, 2)}%`),
        el("div", { style: "color:var(--ink-3);font-size:11px;margin-top:3px" }, note));
      const entries = (ws) => ALLOC_ECON.map((k, i) => ({
        label: k, w: Math.max(0, ws[i]), color: pal.series[i % pal.series.length] }));
      const dwrap = (title, ws) => el("div", { class: "sim8-donut" },
        allocDonutSVG(entries(ws), 210),
        el("div", { class: "card-sub", style: "text-align:center" }, title));
      const col = (card, donut) => {
        const c = el("div", { class: "sim8-col" }, card);
        if (donut) c.append(donut);
        return c;
      };
      /* 헤지 문장 — 두 카드가 같은 서식을 쓴다. 쌍은 대표점(동점 무한 — Xe 가 정본) */
      /* inertB/inertE = 그 슬리브 비중이 0 이라 헤지비율이 위험에 무영향인 경우.
         그때 적히는 숫자는 **최적값이 아니라 현재 슬라이더값의 반사**다(엔진의
         hedgePairForXeW 가 현재값을 그대로 돌려준다) — 큰 숫자만 보면 최적으로
         읽히므로 숫자 자리에 * 를 달아 각주와 연결한다(재점검 발견). */
      const hedgeLine = (hb, he, xe, tag, inertB, inertE) => el("div",
        { class: "sim-hedge-line", style: "font-size:12px;margin-top:4px" },
        el("b", {}, "헤지 "),
        `채권 ${fmtNum(hb * 100, 0)}%${inertB ? "*" : ""} / 주식 ${fmtNum(he * 100, 0)}%${inertE ? "*" : ""}`,
        xe != null ? ` · 미헤지 환노출 Xe ${fmtNum(xe * 100, 2)}%` : "",
        tag ? el("span", { style: "color:var(--ink-3)" }, ` (${tag})`) : "",
        (inertB || inertE)
          ? el("span", { style: "color:var(--ink-3)" }, " · * = 위험에 무영향(현재값 표시)") : "");
      let optCol;
      if (opt) {
        const optCard = card8("① 최적 포트폴리오 (λ-MVO · 배분+헤지)", opt.mu, opt.sig,
          "막대 위 ▼ = 최적 위치" +
          (opt.fxLive ? "" : " · 환율 축 없음 — 헤지는 무력(모든 조합 동점)이라 배분만 최적화"), true);
        optCard.append(explainBox("alloc-opt-card",
          "키인 μ·σ + 실측 상관 · 밴드·합산 상한 반영 · 합계 100% 기준(비중 조정과 무관) · " +
          "배분과 헤지를 교대로 최적화한 한 쌍입니다."));
        if (opt.fxLive) {
          optCard.append(hedgeLine(opt.hb, opt.he, opt.xe,
            "대표점 — 같은 Xe 조합은 위험이 정확히 같음", opt.inertBond, opt.inertEq));
          /* 「최적으로」를 눌러도 슬라이더가 안 움직이는 경우의 **이유**를 적는다
             (2026-08-12 사용자 보고 — 무반응을 고장으로 읽지 않게).
             ① 최적 배분에서 그 슬리브 비중이 0 → 그 헤지비율은 위험과 무관
             ② 밴드가 물어 Xe 가 경계로 잘림  ③ 이미 최적점 */
        const why = [];
        if (opt.inertBond) {
          why.push("이 최적 배분은 해외채권 비중이 0이라 채권 헤지비율은 위험에 영향이 없습니다(어떤 값이든 동일)");
        }
        if (opt.inertEq) {
          why.push("이 최적 배분은 해외주식 비중이 0이라 주식 헤지비율은 위험에 영향이 없습니다(어떤 값이든 동일)");
        }
        /* 구속 문장은 `allocXeBindNotes` 한 곳이 만든다(§7.7.17) — 요약표·오버레이와
           **같은 copy**. 둘 다 무는 경우 두 문장이 함께 나간다(배타가 아니다). */
        allocXeBindNotes(opt.binds).forEach((s) => why.push(s));
        if (opt.converged === false) {
          why.push("교대 최적화가 반복 상한에서 멈췄습니다 — 표시값은 근사입니다");
        }
        const same = Math.round(opt.hb * 100) === st.h_bond && Math.round(opt.he * 100) === st.h_eq;
        if (same) why.push("현재 슬라이더가 이미 이 대표점이라 「최적으로」를 눌러도 값이 그대로입니다");
        if (why.length) {
          optCard.append(el("div",
            { class: "sim-hedge-why", style: "color:var(--ink-3);font-size:11px;margin-top:2px" },
            "· " + why.join(" · ")));
        }
        }
        /* 「막대를 최적 비중으로」(2026-08-12 사용자 요청) — 최적 해를 막대·숫자에
           얹는다. 반올림 잔차는 최대 비중 자산에 흡수해 합계 100 을 정확히 유지.
           시뮬레이션 조정이므로 저장하지 않는다(조정/저장 분리 승계 — 저장은
           「기본값으로 저장」 버튼만). 「헤지도」 버튼은 최적 헤지쌍을 ② 슬라이더에
           얹는다 — ①을 그대로 따라가 보는 선택지(§7.7.13, 같은 조정/저장 분리). */
        const btnRow8 = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:7px" });
        btnRow8.append(el("button", { type: "button", class: "btn-ghost", onclick: () => {
            /* 0.1%p 단위(2026-08-12) — 각 값을 1자리로 반올림한 뒤 잔차(0.1 의 배수)를
               최대 비중 자산에 흡수해 합계 100.0 을 정확히 유지한다. */
            const vals = opt.w.map((x) => +(x * 100).toFixed(1));
            let iMax = 0;
            vals.forEach((v, i) => { if (v > vals[iMax]) iMax = i; });
            vals[iMax] = +(vals[iMax] + (100 - vals.reduce((a, b) => a + b, 0))).toFixed(1);
            ALLOC_ECON.forEach((k, i) => { st.mix[k] = vals[i]; });
            ALLOC_ECON.forEach(syncRow);
            refreshSimSum();
            markDirty();
            recalc(true);
          } }, "막대를 최적 비중으로"));
        if (opt.fxLive) {
          /* 무동작이 확정된 경우(이미 대표점) 버튼이 스스로 그 사실을 말한다 —
             눌리는데 아무 일도 안 하는 것이 「고장」으로 읽힌 1차 신호였다. */
          const hb0 = Math.round(opt.hb * 100), he0 = Math.round(opt.he * 100);
          const noop = hb0 === st.h_bond && he0 === st.h_eq;
          const hBtn = el("button", { type: "button", class: "btn-ghost", onclick: () => {
              st.h_bond = hb0;
              st.h_eq = he0;
              syncHedgeUi();
              markDirty();
              recalc(true);
            } }, noop ? "헤지 슬라이더 — 이미 최적" : "헤지 슬라이더를 최적으로");
          if (noop) {
            hBtn.disabled = true;
            hBtn.title = "현재 슬라이더가 이미 이 대표점입니다 — 눌러도 값이 바뀌지 않습니다";
          }
          btnRow8.append(hBtn);
        }
        optCard.append(btnRow8);
        optCol = col(optCard, dwrap("최적 포트폴리오 비중", opt.w));
      } else {
        optCol = col(el("div", { class: "card sim8-card" },
          el("div", { class: "card-title" }, "① 최적 포트폴리오 — 보류"),
          el("div", { style: "font-size:12px;margin-top:4px" },
            Es.layer !== "cma"
              ? "위험 원천을 기관 벤치마크(CMA)로 두면 계산됩니다."
              : "제약이 서로 모순입니다 — 수기 입력에서 밴드·상한을 확인하세요.")));
      }
      const simCard = card8("② 지금 시뮬레이션 (조정값)", sim.mu, sim.sig,
          opt ? `최적 대비 수익 ${sim.mu - opt.mu >= 0 ? "+" : ""}${fmtNum(sim.mu - opt.mu, 2)}%p · ` +
                `위험 ${sim.sig - opt.sig >= 0 ? "+" : ""}${fmtNum(sim.sig - opt.sig, 2)}%p`
              : "막대를 끌면 즉시 다시 계산됩니다");
      simCard.append(hedgeLine(hbS, heS, sim.xe, "아래 슬라이더 = 이 트랙의 헤지"));
      if (simRef && simRef.pair) {
        simCard.append(el("div", { style: "color:var(--ink-3);font-size:11px;margin-top:2px" },
          `이 배분의 위험최소 Xe ${fmtNum(simRef.xe * 100, 2)}% ` +
          `(대표점 채권 ${fmtNum(simRef.pair[0] * 100, 0)}%/주식 ${fmtNum(simRef.pair[1] * 100, 0)}% → 위험 ${fmtNum(simRef.sig, 2)}%)`));
      }
      const simCol = col(simCard, dwrap("시뮬레이션 비중", w));
      const cols = el("div", { class: "sim8-cols" }, optCol, simCol);
      const legend = el("div", { class: "sim8-legend" },
        ...ALLOC_ECON.map((k, i) => el("span", {},
          el("i", { class: "sim-dot", style: `background:${pal.series[i % pal.series.length]}` }), ` ${k}`)));
      dynBox.append(cols, legend);

      /* ---- 통화별 환헤지 분해(§7.7.13) — 두 트랙 나란히. 표시용 분해이며
         통화별 최적이 아니다(모형 환축이 달러원 하나 — 통화축 확장 §안2 전). ---- */
      const ccyBox = el("details", { class: "sim-ccy", style: "margin-top:8px" },
        el("summary", {}, "통화별 환헤지 분해 (총자산 대비 %)"));
      const mk = (label, wv, hb, he) => {
        const d = allocCcyHedgeRows(A, st, wv[1] * 100, wv[3] * 100, hb, he);
        if (!d) return null;
        const t = el("table", { class: "mini-table" },
          el("tr", {}, ...["통화", "노출", "헤지", "미헤지"].map((h) => el("th", {}, h))));
        d.rows.forEach((r) => t.append(el("tr", {},
          el("td", { style: "text-align:left" }, `${r.c} ${ALLOC_CCY_NAME[r.c] || ""}`),
          el("td", { class: "num" }, fmtNum(r.exp, 2)),
          el("td", { class: "num" }, fmtNum(r.hedged, 2)),
          el("td", { class: "num" }, fmtNum(r.open, 2)))));
        return el("div", { style: "min-width:250px" },
          el("div", { class: "card-title", style: "font-size:12px" }, label),
          el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
          el("div", { style: "color:var(--ink-3);font-size:11px" },
            `통화 구성 출처 — 채권 [${d.src.해외채권 || "없음"}]` +
            (d.coverage.해외채권 != null ? ` 커버리지 ${fmtNum(d.coverage.해외채권, 1)}%` : "") +
            ` · 주식 [${d.src.해외주식 || "없음"}]` +
            (d.coverage.해외주식 != null ? ` 커버리지 ${fmtNum(d.coverage.해외주식, 1)}%` : "")));
      };
      const g1 = opt && opt.fxLive ? mk("① 최적 (배분+헤지)", opt.w, opt.hb, opt.he) : null;
      const g2 = mk("② 시뮬레이션 (조정값)", w, hbS, heS);
      if (g1 || g2) {
        ccyBox.append(el("div", { style: "display:flex;gap:18px;flex-wrap:wrap" },
          ...(g1 ? [g1] : []), ...(g2 ? [g2] : [])),
          el("div", { class: "card-sub", style: "margin-top:4px" },
            "슬리브 헤지비율(해외채권/해외주식)을 통화 구성으로 펼친 표시입니다 — 같은 슬리브의 모든 통화에 " +
            "같은 비율이 걸립니다. 통화별로 다른 헤지비율의 위험 계산·최적화는 통화축 확장(백로그) 후이며, " +
            "통화별 분산최소 참고치는 환헤지 화면에 있습니다."));
        dynBox.append(ccyBox);
      }
    };
  }

  const hl = $("#alloc-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문 — 지금 배분·헤지에서 무엇을 얼마나 바꾸면 위험이 얼마나 줄어드나"));
  const sub = el("div", { class: "a" }, "모델 참고치 ");
  sub.append(el("small", {},
    `권고가 아닙니다 · 위험 원천 ${E0.layer === "cma" ? "기관 벤치마크(CMA)" : "벤더 프록시"}` +
    ` · 표본 ${E0.sample.start}~${E0.sample.end} (${E0.sample.n_months}개월)` +
    " · 기대수익의 출처는 아래 상자에 전부 표시됩니다"));
  hl.append(sub);

  const ctl = $("#alloc-controls");
  ctl.textContent = "";
  /* 구 「경제/회계 관점」 토글은 장부가 축과 함께 폐지(§7.7.11) — 전 화면이 시가
     기준 하나다. 장부가 자산의 진짜 위험(재투자·ALM)은 듀레이션 갭 카드가 담당. */
  ctl.append(el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;align-items:center" },
    el("span", { style: "font-size:12.5px" }, el("b", {}, "전 화면 시가 기준")),
    explainBox("alloc-basis",
      "장부가 자산 축은 배분 우주에서 제외했습니다(2026-08-12: " +
      "원가법 BM 은 손익변동 σ 가 시장위험을 나르지 않아 MVO 방법론을 같은 방식으로 적용할 수 없음). " +
      "장부 보유 채권의 경제적 위험은 국내채권·해외채권(시가) 축이 나릅니다.")));

  /* ---- 위험 원천(데이터층) — §7.7: 기관 벤치마크(CMA) 기본, 프록시는 대조용 ----
     층·창·매핑은 "어떤 모형으로 보나"이므로 시뮬레이션이 아니라 관측 설정이다 —
     표본·프록시·비용 선택과 같은 규약으로 바꾸는 즉시 저장한다. */
  const srcRow = el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:8px" });
  const srcSeg = el("div", { class: "seg", role: "group" });
  const cmaOk = !!(A.cma && A.cma.active);
  const mkSrc = (label, v, disabled, title) => {
    const b = el("button", {
      class: E0.layer === v ? "active" : "",
      onclick: () => { st.src = v; allocSaveState(st); renderAlloc(); },
    }, label);
    if (disabled) { b.disabled = true; if (title) b.title = title; }
    return b;
  };
  srcSeg.append(
    mkSrc("기관 벤치마크(CMA) — 기본", "cma", !cmaOk, cmaOk ? "" : (A.cma && A.cma.reason) || "비활성"),
    mkSrc("벤더 프록시(구)", "proxy"));
  srcRow.append(el("b", {}, "위험 원천"), srcSeg);
  if (E0.layer === "cma") {
    const winSeg = el("div", { class: "seg", role: "group" });
    (E0.cmaAll.windows || []).forEach((w) => {
      winSeg.append(el("button", {
        class: E0.cmaW && E0.cmaW.key === w.key ? "active" : "",
        onclick: () => { st.cma_win = w.key; allocSaveState(st); renderAlloc(); },
      }, `${w.key === "all" ? "전체" : w.key + "년"} (${w.n_months}개월)`));
    });
    srcRow.append(el("span", { style: "font-size:12.5px" }, "창"), winSeg,
      explainBox("alloc-cma-src",
        "귀 기관 전략 벤치마크의 월간 수익률에서 직접 계산한 σ·상관입니다 — 프록시 근사가 없습니다."));
    /* μ 기준일 컷(§7.7.16) — 데이터가 더 있는데 잘랐다는 사실을 화면이 말한다.
       조용히 자르면 사용자는 σ 가 최신인 줄 안다(μ·σ 시점 불일치의 반대 사고).

       **표시하는 날짜는 요청한 컷(`sample_end`, 상수)이 아니라 실제로 도달한 표본 끝
       (`asof`)이다** (§7.7.18 — 재점검 발견). 둘은 갈릴 수 있다: BM 파일이 짧거나,
       μ 를 새 기준일로 옮겼는데 새 BM 데이터가 아직 안 온 경우다(후자는 문서가 지시하는
       **정상 유지보수 순서**라 실제로 일어난다). 상수를 그대로 적으면 표본이 닿지도 않은
       달을 「표본 종료」라 쓰고, 하지도 않은 절단을 했다고 단언하며, **무엇보다 μ·σ 시점이
       어긋난 사실을 숨긴다** — §7.7.16 이 막으려던 바로 그 상태다. 그래서 세 갈래로 적는다. */
    const cmaCut = E0.cmaAll && E0.cmaAll.sample_end;
    const cmaAsof = E0.cmaAll && E0.cmaAll.asof;
    const cmaDataLast = E0.cmaAll && E0.cmaAll.data_last;
    if (cmaCut && cmaAsof) {
      const mon = (s) => String(s).slice(0, 7);
      const short = cmaAsof < cmaCut;                       // 데이터가 컷에 못 미침
      const later = cmaDataLast && cmaDataLast > cmaCut;    // 컷이 실제로 잘라냄
      srcRow.append(el("span", { class: "cma-cut-note", style: "font-size:12px" },
        /* `el` 은 attrs 를 그대로 setAttribute/className 한다 — `class: null` 을 주면
           className 이 문자열 "null" 이 된다(조용히 어긋나는 종류). 객체를 갈라 넘긴다. */
        el("b", short ? { class: "d-up" } : {}, `표본 종료 ${mon(cmaAsof)}`),
        short
          ? el("span", { class: "d-up" },
              ` — 기대수익(μ) 기준일 ${mon(cmaCut)} 보다 데이터가 짧습니다 · σ 와 μ 의 시점이 어긋납니다`)
          : " — 기대수익(μ) 키인 기준일에 맞춰 잘랐습니다",
        short
          ? el("span", { style: "color:var(--ink-3)" },
              " (BM 파일을 갱신하거나 μ 기준일을 데이터에 맞추십시오)")
          : later ? el("span", { style: "color:var(--ink-3)" },
              ` (데이터는 ${mon(cmaDataLast)} 까지 있습니다 — μ 를 새 기준일로 갱신하면 이 컷도 함께 옮깁니다)`)
          : el("span", { style: "color:var(--ink-3)" }, " (자를 데이터가 없었습니다)")));
    }
  } else if (E0.layerNote) {
    srcRow.append(el("span", { class: "d-up", style: "font-size:12px" }, E0.layerNote));
  }
  ctl.append(srcRow);

  /* ---- 대체투자 위험 매핑 — 기관 현행 방식(팩터)이 기본, 벤치마크 그대로는 진단 ---- */
  if (E0.layer === "cma" && E0.altInfo) {
    const ai = E0.altInfo;
    const mapRow = el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px" });
    const mapSeg = el("div", { class: "seg", role: "group" });
    const mkMap = (label, v) => el("button", {
      class: ai.mode === v ? "active" : "",
      onclick: () => { st.alt_map.mode = v; allocSaveState(st); renderAlloc(); },
    }, label);
    mapSeg.append(mkMap("기관 방식 — 주식·채권 매핑", "factor"), mkMap("벤치마크 그대로 (진단)", "bm"));
    mapRow.append(el("b", {}, "대체투자 위험 (분류별)"), mapSeg);
    if (ai.mode === "factor") {
      /* 분류별 매핑 — 지분형/대출형이 각자 해외주식·국내채권 블렌드를 가진다(§7.7.9) */
      const clsRow = (label, cls, keyE, keyB) => {
        const mkW = (key, wLabel) => {
          const inp = el("input", { type: "number", step: "5", min: "0", max: "100",
            value: String(st.alt_map[key]), id: "alt-map-" + key,
            "aria-label": `대체투자 ${label} 매핑 ${wLabel} 비중 %`, style: "width:64px" });
          inp.addEventListener("change", () => {
            st.alt_map[key] = inp.value === "" ? 0 : +inp.value;
            allocSaveState(st);
            renderAlloc();
          });
          return el("label", { style: "font-size:12.5px;display:inline-flex;gap:4px;align-items:center" },
            wLabel, inp, "%");
        };
        const wrap = el("span", { style: "display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap" },
          el("b", { style: "font-size:12.5px" }, label),
          mkW(keyE, "해외주식"), mkW(keyB, "국내채권"),
          el("span", { style: "color:var(--ink-3);font-size:12px" },
            `→ σ ${fmtNum(cls.mapped, 2)}%`));
        const wSum = cls.we + cls.wb;
        if (Math.abs(wSum - 100) > 0.5) {
          wrap.append(el("span", { class: "d-up", style: "font-size:12px" },
            `⚠ 합 ${fmtNum(wSum, 0)}%`));
        }
        return wrap;
      };
      mapRow.append(clsRow("지분형", ai.eq, "eq_we", "eq_wb"),
                    clsRow("대출형", ai.dt, "dt_we", "dt_wb"));
    }
    mapRow.append(el("span", { style: "color:var(--ink-3);font-size:12px" },
      ai.mode === "factor"
        ? `벤치마크 σ: 관측 ${fmtNum(ai.obs, 2)}% → 디스무딩 ${ai.unsmoothed != null ? fmtNum(ai.unsmoothed, 2) : "–"}%` +
          ` · 잔차(분류별 독립) ${fmtNum(ai.idio, 2)}%` +
          (ai.alpha != null ? ` · α=${fmtNum(ai.alpha, 3)}` : "")
        : `벤치마크 관측 σ ${fmtNum(ai.obs, 2)}% — 평가 스무딩으로 과소(ρ₁ 유의)이며 상관도 0과 구분 불가. 진단·대조용입니다`));
    if (ai.mode === "factor" && ai.unsmoothed == null) {
      /* 재점검 발견: 보조축이 없으면 잔차가 0으로 조용히 들어가 완전헤지 근처에서
         행렬이 특이해진다 — 그 상태를 화면에 밝힌다 */
      mapRow.append(el("span", { class: "d-up", style: "font-size:12px" },
        "⚠ 디스무딩 보조축(_alt) 없음 — 잔차 미가산: 완전헤지 근처에서 공분산이 특이해질 수 있습니다"));
    }
    ctl.append(mapRow);
  }

  /* ---- 시뮬레이션 콘솔 — 조정은 즉시 반영, 저장은 버튼으로만 (2026-08-05 사용자 승인) ----
     예전에는 배분을 바꾸려면 수기입력 오버레이 → 저장 → 복귀의 왕복이 필요했고,
     헤지 슬라이더는 놓는 순간 자동 저장됐다. 지금은 배분·헤지 모두 이 자리에서
     즉시 반영되고, **만져보는 것(조정)과 남기는 것(저장)이 분리**된다 —
     저장 전의 조정은 이 화면에만 존재하고 새로고침하면 사라진다.
     (표본·프록시·비용 선택은 "어떤 모형으로 보나"라서 이전처럼 즉시 저장된다 —
     그건 시뮬레이션 대상이 아니라 관측 설정이다.) */
  let dirty = false;
  const dirtyBadge = el("span", { class: "sim-dirty", hidden: true },
    "조정 중 — 저장 전 (새로고침하면 사라집니다)");
  const markDirty = () => { dirty = true; dirtyBadge.hidden = false; };

  /* 헤지 슬라이더 2개는 §7.7.13 에서 시뮬레이터 패널(② 트랙)로 이사했다 —
     배분·헤지를 한 자리에서 함께 조정하는 동선. 같은 상태(h_bond/h_eq)·같은
     조정/저장 분리를 그대로 승계한다. */
  ctl.append(explainBox("alloc-ctl-where",
    "헤지비율 슬라이더는 위 시뮬레이터(② 트랙)에 있습니다 — 배분과 헤지를 한 자리에서 조정합니다."));

  /* 배분 8칸·잔여 버튼은 §7.7.8 시뮬레이터 패널(화면 최상단)로 이사했다 — 같은
     id(sim-mix-*)·같은 계약(즉시 반영·저장 안 함·합계 배지·명시적 잔여 버튼) 승계. */
  ctl.append(el("div", { style: "margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
    el("button", { class: "btn-primary", style: "border:0;cursor:pointer;font-family:inherit",
      onclick: () => { allocSaveState(st); renderAlloc(); } },
      "이 상태를 기본값으로 저장"),
    el("button", { type: "button", class: "btn-ghost",
      onclick: () => renderAlloc() },                       // 저장 안 된 조정을 버리고 저장값으로
      "저장값으로 되돌리기"),
    /* μ·σ 만 게시 디폴트로 — 비중·밴드·헤지는 그대로 둔다. 옛 저장분이 갱신된
       디폴트를 덮고 있을 때 한 번에 정리하는 자리다(실측 사고 대응, 2026-08-12). */
    el("button", { type: "button", class: "btn-ghost", onclick: () => {
      const dd = A.defaults || {};
      st.mu_over = { ...st.mu_over, ...(dd.mu_over || {}) };
      ALLOC_ECON.forEach((k) => { st.sig_over[k] = null; });   // σ 미입력 = 벤치마크 실측
      allocSaveState(st);
      renderAlloc();
    } }, "μ·σ 디폴트로 되돌리기"),
    dirtyBadge,
    el("a", { href: "#alloc-sim", style: "font-size:12.5px" }, "상세 수기 입력 (밴드·듀레이션·통화 구성) →"),
    el("span", { style: "color:var(--ink-3);font-size:12px" },
      st.saved ? "저장된 수기 입력 기준" : "예시값 기준 — 저장하면 대체됩니다 (이 브라우저에만)")));

  const cardsBox = $("#alloc-cards");
  const leverBox = $("#alloc-levers");
  const tableCard = $("#alloc-table-card");
  const inputsBox = $("#alloc-inputs-box");
  const frontierCard = $("#alloc-frontier-card");
  const pathCard = $("#alloc-path-card");
  const tvCard = $("#alloc-tv-card");
  const charCard = $("#alloc-char-card");
  let chartTimer = null;

  function recalc(withCharts) {
    const E = allocEngine(A, st);
    const { V, w0 } = E;
    const sigCur = E.sigmaW(w0, V.C);
    const muCur = amDot(V.mu, w0);
    const se = E.seOf(sigCur);
    const target = st.target_ret != null ? st.target_ret : muCur;
    /* 시뮬레이터(§7.7.8) — 우주가 하나(시가 7축 §7.7.11)라 같은 엔진을 그대로 쓴다 */
    if (simDyn) simDyn(E, withCharts);
    /* 실행 불가능한 밴드·그룹 한도 — 최적화를 돌리지 않고 명시적으로 알린다 */
    const infeas = allocFeasibility(E);
    const doOpt = infeas.length === 0;
    const wMin = doOpt ? E.optimize(V.mu, V.C, null) : null;
    const wKeep = doOpt ? E.optimize(V.mu, V.C, target) : null;
    const sigMin = doOpt ? E.sigmaW(wMin, V.C) : 0, muMin = doOpt ? amDot(V.mu, wMin) : 0;
    const sigKeep = doOpt ? E.sigmaW(wKeep, V.C) : 0, muKeep = doOpt ? amDot(V.mu, wKeep) : 0;
    const turnover = doOpt ? w0.reduce((a, w, i) => a + Math.abs(wKeep[i] - w), 0) / 2 * 100 : 0;

    /* 헤지 참고치(위험 최소 Xe·대표점) — 요약과 레버 문단이 **같은 계산 한 벌**을 쓴다.
       두 곳에서 따로 계산하면 언젠가 어긋난 두 "최적"이 화면에 공존하게 된다.
       경제 관점 전용(xeQuad 가드) — 회계 관점 최적화(CMA)에서는 배분 참고치만 낸다.
       환율 축이 없는 표본(fxLive=false)에서도 내지 않는다 — 모든 헤지비율이 동점이라
       한 점을 적으면 임의 선택이 된다(재점검 발견). */
    let hq = null;
    if (doOpt && E.fxLive) {
      const q = E.xeQuad();
      const hbnds = allocHBands(st);
      const [xeLo, xeHi] = allocXeRange(E, hbnds);
      const xeFree = E.xeStar(null, null, q);
      const xeBand = E.xeStar(xeLo, xeHi, q);
      hq = {
        q, hbnds, xeLo, xeHi, xeFree, xeBand,
        xeCur: E.xeOf(st.h_bond / 100, st.h_eq / 100),
        sBand: E.sigmaXe(xeBand, q),
        pair: E.hedgePairForXe(xeBand, [st.h_bond / 100, st.h_eq / 100], hbnds),
        /* §7.7.17 — 여기도 ① 최적 카드와 **같은 판정·같은 문장**을 쓴다. 예전에는
           `|xeBand − xeFree| > 1e-9` 라는 분리 이전의 단일 플래그였고, 그래서 밴드가
           중립이어도 「헤지 밴드가 물고 있습니다」가 이 표에 나갔다(실제 게시 페이로드로
           재현). 요약표는 「그래서 얼마인데?」의 답 자리라 여기의 오귀인이 가장 비싸다.
           해외자산 비중 합은 `E.xeOf(0, 0)` = w채 + w주 (헤지 0% 일 때의 노출). */
        binds: allocXeBinds(E.xeOf(0, 0), xeLo, xeHi, xeFree),
      };
    }

    /* ----- 요약 — 「그래서 얼마인데?」의 답 한 표 (기능 1) ----- */
    const sumBox = $("#alloc-summary");
    sumBox.textContent = "";
    if (!doOpt) {
      sumBox.append(el("div", { class: "card-title d-up" }, "현재 vs 참고치 — 제약 모순으로 보류"),
        el("div", { class: "card-sub", style: "margin-top:4px" },
          "밴드·그룹 한도가 서로 모순되어 참고치를 계산하지 않았습니다 — 아래 경고 카드를 보십시오."));
    } else {
      const gCur = allocDurGap(st, allocAssetDuration(st, w0));
      const gKeep = allocDurGap(st, allocAssetDuration(st, wKeep));
      const hasGap = gCur != null && gKeep != null;
      const heads = ["", ...V.keys,
                     ...(hq ? ["헤지 채권/주식", "미헤지 환노출 Xe"] : []),
                     "수익", "위험",
                     ...(hasGap ? ["듀레이션 갭"] : [])];
      const tS = el("table", { class: "mini-table" },
        el("tr", {}, ...heads.map((h, i) => el("th", { style: i === 0 ? "text-align:left" : "" }, h))));
      const row = (name, ws, hedgeTxt, xe, mu, sig, gap, bold) => {
        const tr = el("tr", { style: bold ? "font-weight:650" : "" });
        tr.append(el("td", { style: "text-align:left" }, name));
        ws.forEach((x) => tr.append(el("td", { class: "num" }, x == null ? "–" : fmtNum(x, 1))));
        if (hq) tr.append(el("td", { class: "num" }, hedgeTxt),
          el("td", { class: "num" }, xe == null ? "–" : fmtNum(xe, 2) + "%"));
        tr.append(el("td", { class: "num" }, fmtNum(mu, 2) + "%"),
          el("td", { class: "num" }, fmtNum(sig, 2) + "%"));
        if (hasGap) tr.append(el("td", { class: "num" }, gap == null ? "–" : fmtNum(gap, 2) + "년"));
        tS.append(tr);
      };
      if (dirty) {
        row("기준(저장값)", baseE.w0.map((x) => x * 100), `${baseSt.h_bond}/${baseSt.h_eq}%`,
            baseXe * 100, baseMu, baseSig,
            hasGap ? allocDurGap(baseSt, allocAssetDuration(baseSt, baseE.w0)) : null);
      }
      row(dirty ? "지금 조정" : "현재", w0.map((x) => x * 100),
          `${st.h_bond}/${st.h_eq}%`, hq ? hq.xeCur * 100 : null, muCur, sigCur, gCur, dirty);
      const pairTxt = hq && hq.pair
        ? `${fmtNum(hq.pair[0] * 100, 0)}/${fmtNum(hq.pair[1] * 100, 0)}%`
        : "밴드 내 불가";
      row("참고치", wKeep.map((x) => x * 100), pairTxt, hq ? hq.xeBand * 100 : null,
          muKeep, sigKeep, gKeep, true);
      const dtr = el("tr", { class: "sum-delta" });
      dtr.append(el("td", { style: "text-align:left;color:var(--ink-3)" }, "참고치 − 현재"));
      wKeep.forEach((x, i) => {
        const d = (x - w0[i]) * 100;
        dtr.append(el("td", { class: "num " + (d > 0.05 ? "d-down" : d < -0.05 ? "d-up" : "d-flat") },
          `${d > 0 ? "+" : ""}${fmtNum(d, 1)}`));
      });
      /* −0.00 방지 — 반올림해 0 이 되는 차이는 부호 없이 0 으로 적는다 */
      const z2 = (x) => (Math.abs(x) < 0.005 ? 0 : x);
      const dMu = z2(muKeep - muCur), dSig = z2(sigKeep - sigCur);
      if (hq) {
        const dXe = z2((hq.xeBand - hq.xeCur) * 100);
        dtr.append(el("td", { class: "num" }, "→"),
          el("td", { class: "num" }, `${dXe > 0 ? "+" : ""}${fmtNum(dXe, 2)}%p`));
      }
      dtr.append(
        el("td", { class: "num" }, `${dMu > 0 ? "+" : ""}${fmtNum(dMu, 2)}%p`),
        el("td", { class: "num " + (dSig < 0 ? "d-down" : dSig > 0 ? "d-up" : "d-flat") },
          `${dSig > 0 ? "+" : ""}${fmtNum(dSig, 2)}%p`));
      if (hasGap) dtr.append(el("td", { class: "num" },
        `${gKeep - gCur > 0 ? "+" : ""}${fmtNum(gKeep - gCur, 2)}년`));
      tS.append(dtr);
      sumBox.append(el("div", { class: "card-head" },
        el("span", { class: "card-title" }, "현재 vs 참고치 — 한눈에"),
        el("span", { class: "card-sub" }, `±표본오차 ${fmtNum(se, 2)}%p · 아래 조작을 움직이면 즉시 다시 계산`)),
        el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tS),
        el("div", { class: "card-sub", style: "margin-top:5px" },
          ...(hq ? [
            /* ⚠(구속 귀속 §7.7.17)은 사유라 접지 않는다 — 설명 산문만 explain 으로 */
            ...allocXeBindNotes(hq.binds).map((s) => el("b", {}, `${s}. `)),
            explainBox("alloc-summary-partial",
              "배분 참고치는 헤지 고정(수익 유지 ②), 헤지 참고치는 배분 고정(위험 최소 Xe의 현재값 최근접 대표점) — ",
              el("b", {}, "두 부분해이며 동시 최적해가 아닙니다"),
              "(동시해는 통화축 확장 후 제공). ",
              "같은 Xe를 만드는 헤지 조합은 위험이 정확히 같습니다 — ",
              el("a", { href: "#alloc-hedge" }, "왜? ›")),
          ] : [
            /* 환율 축 부재(재점검 발견) — 헤지 참고치를 내지 않는 이유를 밝힌다 */
            el("b", {}, "헤지 참고치가 없습니다"),
            " — 이 표본에는 환율 축(_fx)이 없어 헤지비율이 위험을 전혀 바꾸지 못합니다(모든 조합이 동점). ",
            "달러원 시리즈가 파이프라인에 들어오면 자동으로 복구됩니다.",
          ])));
    }

    /* ----- 포트폴리오 특성 — 비중 조정과 함께 즉시 갱신 (드래그 중에도) -----
       효율 갭은 「같은 기대수익」 기준이라, 목표수익 입력이 있으면 wKeep(목표
       기준)을 그대로 못 쓰고 현재 μ 에서 한 번 더 푼다. */
    const gapW = doOpt
      ? (st.target_ret == null ? wKeep : E.optimize(V.mu, V.C, muCur))
      : null;
    renderAllocChar(charCard, E, w0, gapW
      ? { gapSig: E.sigmaW(gapW, V.C), gapMu: amDot(V.mu, gapW) }
      : {});

    /* ----- 3칸 카드 ----- */
    cardsBox.textContent = "";
    const riskWord = "위험";
    /* 참고치 카드도 시뮬레이터 카드와 같은 위계 — 기대수익이 크고 위(2026-08-12
       사용자 지시). 표본오차는 위험에 붙는 값이라 위험 줄로 함께 내린다. */
    const card = (title, mu, sig, note, warnRisk) => {
      const c = el("div", { class: "card", style: "padding:14px 16px" });
      c.append(el("div", { class: "card-title" }, title),
        el("div", { style: "font-size:20px;font-weight:700;margin:6px 0 2px" },
          `기대수익 ${fmtNum(mu, 2)}%`),
        el("div", { style: "font-size:13px" },
          `${riskWord} ${fmtNum(sig, 2)}%`,
          el("small", { style: "color:var(--ink-3)" }, ` ±${fmtNum(se, 2)} (표본오차)`)),
        el("div", { style: "color:var(--ink-3);font-size:11.5px;margin-top:4px" }, note));
      if (warnRisk) c.append(el("div", { class: "d-up", style: "font-size:11.5px" },
        `⚠ 위험한도 ${fmtNum(st.risk_cap, 2)}% 초과`));
      return c;
    };
    const capW = (s) => st.risk_cap != null && s > st.risk_cap;
    if (infeas.length) {
      const warnCard = el("div", { class: "card", style: "padding:14px 16px" });
      warnCard.append(el("div", { class: "card-title d-up" }, "⚠ 제약이 서로 모순됩니다 — 참고치 계산 보류"),
        ...infeas.map((p) => el("div", { style: "font-size:12.5px;margin-top:4px" }, "· " + p)),
        el("div", { style: "color:var(--ink-3);font-size:11.5px;margin-top:6px" },
          el("a", { href: "#alloc-sim" }, "수기 입력에서 밴드·그룹 한도를 고치십시오 →")));
      cardsBox.append(card("현재 배분 (입력값)", muCur, sigCur, "수기 입력(또는 예시) 그대로", capW(sigCur)), warnCard);
    } else {
      cardsBox.append(
        card("현재 배분 (입력값)", muCur, sigCur, "수기 입력(또는 예시) 그대로", capW(sigCur)),
        card("① 위험 최소 참고치", muMin, sigMin, "헤지 고정 · 밴드 안에서 위험 최소", capW(sigMin)),
        card("② 수익 유지 참고치", muKeep, sigKeep,
          st.target_ret != null ? `목표수익 ${fmtNum(target, 2)}% 입력값 기준` : "기대수익을 현재와 같게 두고 위험만 축소",
          capW(sigKeep)));
      /* ALM 듀레이션 갭 — **제약이 아니라 결과 표시**. 배분을 바꾸면 갭이 따라 움직인다.
         장부가 축 폐지 후에도 살아 있다 — 장부 보유 채권의 진짜 위험(재투자·ALM)을
         보는 자리가 여기다(§7.7.11). */
      const dCur = allocAssetDuration(st, w0);
      if (dCur != null && st.dur_liab != null) {
        const gCur = allocDurGap(st, dCur);
        const gapCard = el("div", { class: "card", style: "padding:14px 16px" });
        gapCard.append(el("div", { class: "card-title" }, "ALM 듀레이션 갭 — 이 배분을 택하면"),
          el("div", { style: "font-size:20px;font-weight:700;margin:6px 0 2px" }, `${fmtNum(gCur, 2)}년`));
        if (doOpt) {
          const gMin = allocDurGap(st, allocAssetDuration(st, wMin));
          const gKeep = allocDurGap(st, allocAssetDuration(st, wKeep));
          gapCard.append(el("div", { style: "font-size:12px" },
            `① 참고치 ${fmtNum(gMin, 2)}년 · ② 참고치 ${fmtNum(gKeep, 2)}년`));
        }
        gapCard.append(el("div", { style: "color:var(--ink-3);font-size:11.5px;margin-top:4px" },
          `자산 듀레이션 ${fmtNum(dCur, 2)}년 = Σ(비중 × 자산군 듀레이션), 주식·대체는 0. `,
          `부채 ${fmtNum(st.dur_liab, 1)}년 × 부채/자산 ${fmtNum(st.la_ratio != null ? st.la_ratio : 1, 2)}. `,
          el("b", {}, "최적화 제약이 아니라 결과 표시입니다"),
          " — 내규 한도가 없어 허용 괴리폭을 임의로 정하지 않았습니다."));
        cardsBox.append(gapCard);
      }
    }

    /* ----- 레버 두 개 ----- */
    leverBox.textContent = "";
    if (infeas.length) {
      leverBox.append(el("b", {}, "제약 모순으로 레버 계산을 보류했습니다"),
        " — 위 카드의 항목을 수기 입력에서 고치면 자동으로 다시 계산됩니다.");
    } else if (!hq) {
      /* 환율 축 부재 — 헤지 레버가 위험을 못 바꾸는데 "최적"을 적으면 임의 선택이다 */
      leverBox.append(el("b", {}, "레버 1(헤지)이 이 표본에서는 무력합니다"),
        " — 환율 축(_fx)이 없어 모든 헤지비율 조합의 위험이 정확히 같습니다. ",
        "헤지 참고치는 내지 않고, 배분 참고치(레버 2)만 위 표와 카드에 표시합니다.");
    } else {
      /* 헤지 레버의 자유도는 실질 1개(총 미헤지 환노출 Xe)다 — 한 점을 "최적"이라
         적으면 무한한 동점 중 하나를 임의로 고른 것이 된다. 수치는 위 요약과 같은
         계산 한 벌(hq)이다. §7.13 이후 이 문단은 **숫자·⚠ 만 보이고** 왜 그런지의
         산문은 explainBox 뒤에 있다 — ⚠(allocXeBindNotes)는 사유라 절대 접지 말 것. */
      const totFx = E.fxLoadW ? E.fxLoadW(E.w0) : null;
      const totDiffers = totFx != null && Math.abs(totFx - hq.xeCur) >= 5e-5;
      leverBox.append(
        "· ", el("b", {}, "레버 1 (배분 고정, 헤지만 이동)"),
        ` — 현재 Xe ${fmtNum(hq.xeCur * 100, 2)}% → 위험 최소 Xe ${fmtNum(hq.xeBand * 100, 2)}%: `,
        `위험 ${fmtNum(sigCur, 2)}→${fmtNum(hq.sBand, 2)}%. `,
        /* 총 환노출 숫자는 판독에 필요한 결과라 보이게 남긴다 — 산문 근거만 접는다 */
        totDiffers
          ? el("span", {}, el("b", {}, `총 환노출 ${fmtNum(totFx * 100, 2)}%`),
              ` (대체투자 환헤지 ${fmtNum(st.h_alt, 0)}% 적용 후 · Xe 밖 몫 포함). `)
          : "",
        hq.pair
          ? `대표점 (채권 ${fmtNum(hq.pair[0] * 100, 0)}%, 주식 ${fmtNum(hq.pair[1] * 100, 0)}%). `
          : el("b", {}, "다만 이 Xe 는 지금 밴드 안에서 만들 수 없습니다 — 밴드를 확인하십시오."),
        /* §7.7.17 — 레버 문단도 같은 판정·같은 문장(요약표와 `hq` 한 벌을 공유한다).
           네 자리(① 카드·요약표·이 문단·헤지 곡면 오버레이)가 전부 `allocXeBindNotes` 다. */
        ...allocXeBindNotes(hq.binds).map((s) => el("b", {}, ` ⚠ ${s}.`)),
        el("a", { href: "#alloc-hedge", style: "margin-left:6px" }, "헤지 곡면 상세 ›"), el("br"),
        "· ", el("b", {}, "레버 2 (헤지 고정, 배분만 이동)"),
        ` — 같은 기대수익 ${fmtNum(target, 2)}%를 유지하며 위험 ${fmtNum(sigCur, 2)}→${fmtNum(sigKeep, 2)}% (±표본오차 ${fmtNum(se, 2)}%p 병기 · 매매회전 ${fmtNum(turnover, 1)}%p).`,
        el("a", { href: "#alloc-boot", style: "margin-left:6px" }, "표본을 다시 뽑으면? ›"),
        explainBox("alloc-levers",
          el("b", {}, "레버는 두 개뿐입니다 — 겹쳐 세지 마십시오."),
          " 위험이 보는 것은 헤지비율 2개가 아니라 ",
          el("b", {}, "총 미헤지 환노출 Xe 하나뿐"), "입니다(총자산 대비). ",
          "같은 Xe 를 만드는 조합은 무수히 많고 ", el("b", {}, "위험이 정확히 같습니다"),
          " — 위에 적는 헤지쌍은 그 동점 중 현재값 최근접 대표점입니다. ",
          /* Xe 는 **최적화가 고르는 레버**의 축이다. 매핑 대체투자도 팩터(시가 해외주식 —
             미헤지 계열)를 통해 환을 지지만 그 헤지는 모형 입력이라 Xe 밖에 있다 — 그
             차이를 적지 않으면 사용자는 Xe 를 총 환노출로 읽는다. §7.7.19·§7.7.20. */
          totDiffers
            ? el("span", {}, "총 환노출이 Xe 와 다른 것은 매핑 대체투자가 팩터를 통해 지는 몫 때문이며, ",
                el("b", {}, "이 몫은 위 두 슬라이더가 아니라 「대체투자 환헤지 비율」이 움직입니다"), ". ")
            : ""));
    }

    /* ----- 자산군 표 ----- */
    tableCard.textContent = "";
    tableCard.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "자산군 표 — 시가 기준"),
      el("span", { class: "card-sub" },
        !doOpt
          ? "제약 모순으로 참고치 열이 없습니다 — 밴드·그룹 한도를 확인하십시오"
          : "⚠ = 밴드 경계에 붙음 · 대출금·장부가 축은 배분 우주에서 제외(2026-08-12)")));
    const { rc: rcCur } = E.eulerRC(w0, V.C);
    const rcKeep = doOpt ? E.eulerRC(wKeep, V.C).rc : null;
    const srcTagFor = (k) => E.layer === "cma" ? allocCmaSrcTag(k, E) : allocSrcTag(k);
    const heads = !doOpt
      ? ["자산군", "현재%", "기대수익%", `${riskWord}%`, `${riskWord} 기여`, "출처"]
      : ["자산군", "현재%", "참고치%(②)", "차이", "기대수익%", `${riskWord}%`, "위험기여 현재→참고", "밴드", "출처"];
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...heads.map((h, i) => el("th", { style: i === heads.length - 1 ? "text-align:left" : "" }, h))));
    V.keys.forEach((k, i) => {
      const cur = w0[i] * 100;
      const sig_i = Math.sqrt(Math.max(V.C[i][i], 0));
      if (!doOpt) {
        t.append(el("tr", {},
          el("td", {}, el("a", { href: `#alloc-a-${i}` }, k)),
          el("td", { class: "num" }, fmtNum(cur, 1)),
          el("td", { class: "num" }, fmtNum(V.mu[i], 2)),
          el("td", { class: "num" }, fmtNum(sig_i, 2)),
          el("td", { class: "num" }, fmtNum(rcCur[i], 2)),
          el("td", { style: "text-align:left;color:var(--ink-3);font-size:11.5px" }, srcTagFor(k))));
        return;
      }
      const ref = doOpt ? wKeep[i] * 100 : cur;
      const d = ref - cur;
      const bandArr = st.bands[k] || [0, 100];
      const bind = doOpt && (ref <= bandArr[0] + 0.05 || ref >= bandArr[1] - 0.05);
      t.append(el("tr", {},
        el("td", {}, el("a", { href: `#alloc-a-${i}` }, k)),
        el("td", { class: "num" }, fmtNum(cur, 1)),
        el("td", { class: "num" }, doOpt ? el("b", {}, fmtNum(ref, 1)) : "–"),
        el("td", { class: "num " + (d > 0.05 ? "d-down" : d < -0.05 ? "d-up" : "d-flat") },
          doOpt ? `${d > 0 ? "+" : ""}${fmtNum(d, 1)}` : "–"),
        el("td", { class: "num" }, fmtNum(V.mu[i], 2)),
        el("td", { class: "num" }, fmtNum(sig_i, 2)),
        el("td", { class: "num" }, doOpt ? `${fmtNum(rcCur[i], 2)} → ${fmtNum(rcKeep[i], 2)}` : fmtNum(rcCur[i], 2)),
        el("td", { class: "num" }, `${bandArr[0]}~${bandArr[1]}${bind ? " ⚠" : ""}`),
        el("td", { style: "text-align:left;color:var(--ink-3);font-size:11.5px" }, srcTagFor(k))));
    });
    tableCard.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
      explainBox("alloc-table-legend",
        "위험기여 = 오일러 분해(합계 = 총위험). 행 이름을 클릭하면 그 자산군의 산식 전개로 이동합니다."));

    /* ----- 상시 노출 — 이 숫자는 어디서 왔나 ----- */
    const R = A.rates;
    inputsBox.textContent = "";
    /* §7.13 — 출처 상자 전체를 접는다(요약이 곧 제목). 안의 선택기(비용·프록시·표본)는
       열면 그대로 조작할 수 있고, recalc 재렌더에도 EXPLAIN_OPEN 이 열림을 유지한다. */
    inputsBox.append(explainBox("alloc-inputs",
      { label: "이 숫자는 어디서 왔나 — 관측 / 선택 / 가정" },
      `· [관측] 한국 3개월 ${R.kr3m.v}% · 한국 5년 ${R.kr5y.v}% · 미 종합 YTM ${R.us_ytm.v}% · 미국 3개월 ${R.us3m.v}% · 근원 CPI ${R.cpi.v}% (${R.kr3m.date} 기준)`, el("br"),
      /* 부호 열쇠를 여기에도 적는다 — 헤지비용은 환헤지·FX·시뮬레이터와 **같은 양·같은
         부호**인데 이 화면에만 열쇠가 없어 "비용이 음수" 를 이득으로 읽을 수 있었다. */
      `· [관측·선택] 헤지비용 (${COST_SIGN_KEY}) `, (() => {
        const sel = el("select", {});
        A.cost_options.forEach((o) => {
          const opt = el("option", { value: o.key }, `${o.label}: ${o.v > 0 ? "+" : ""}${o.v}%`);
          if (o.key === st.cost_key) opt.selected = true;
          sel.append(opt);
        });
        sel.addEventListener("change", () => { st.cost_key = sel.value; allocSaveState(st); recalc(true); });
        return sel;
      })(),
      (E.costOpt.curve
        ? el("span", { style: "color:var(--ink-3);font-size:11.5px" },
            ` → 적용 ${E.cost > 0 ? "+" : ""}${fmtNum(E.cost, 2)}% (가중평균 만기 ${st.tenor_m}개월 보간${st.tenor_m > 12 ? " — 12M 값 고정" : ""})`)
        : ""),
      el("a", { href: "#alloc-cost", style: "margin-left:6px" }, "선택이 결과를 얼마나 바꾸나 ›"), el("br"),
      `· [관측→앵커] 채권 샤프 ${fmtNum(V.anchor.value, 3)} — 국내 (${fmtNum(V.anchor.kr.prem, 2)}%p ÷ σ${fmtNum(V.anchor.kr.sigma, 2)}%) · 해외 (${fmtNum(V.anchor.us.prem, 2)}%p ÷ σ${fmtNum(V.anchor.us.sigma, 2)}%, 각자 자국통화 기준) 평균. `,
      el("b", {}, "앵커는 헤지 슬라이더와 무관합니다 — 헤지비율은 기대수익에 비용으로만, 위험에 환노출로만 들어갑니다."),
      el("a", { href: "#alloc-anchor", style: "margin-left:6px" }, "도출·검증 ›"), el("br"),
      ...(E.layer === "proxy" ? [
        "· [선택] 해외주식 프록시 ", (() => {
          const sel = el("select", {});
          [["acwi", "ACWI (현재 PR — 배당 미포함)"], ["spx", "S&P500 TR"]].forEach(([v, lbl]) => {
            const opt = el("option", { value: v }, lbl);
            if (E.proxy === v) opt.selected = true;
            sel.append(opt);
          });
          if (E.set.proxy_only) {
            sel.disabled = true;
            sel.title = "이 표본은 ACWI(2006-12 시작) 표본 밖 구간을 포함해 S&P500 TR 전용입니다";
          }
          sel.addEventListener("change", () => { st.proxy = sel.value; allocSaveState(st); recalc(true); });
          return sel;
        })(),
        (E.set.proxy_only ? el("span", { style: "color:var(--ink-3);font-size:11.5px" }, " (이 표본은 S&P500 TR 전용)") : ""),
        " · 표본 시작 ", (() => {
          const sel = el("select", {});
          A.sets.forEach((s) => {
            const opt = el("option", { value: s.key }, `${s.label} (${s.start}~, ${s.n_months}개월)`);
            if (st.start_key === s.key) opt.selected = true;
            sel.append(opt);
          });
          sel.addEventListener("change", () => { st.start_key = sel.value; allocSaveState(st); recalc(true); });
          return sel;
        })(), el("br"),
      ] : [
        /* CMA 층 — 프록시·표본 선택기가 적용되지 않는 이유를 밝힌다 */
        `· [BM] 위험 원천: 기관 전략 벤치마크 (${E.sample.label} ${E.sample.start}~${E.sample.end}, ${E.sample.n_months}개월 — 월말 표본·부분월 제거). `,
        "해외 벤치마크의 환 기준은 계열마다 다릅니다(실측) — 해외채권은 환헤지 반영, 해외주식은 미헤지. 계열별 기준 헤지비율에서 벌어진 만큼만 달러원 변동을 더합니다. 프록시·표본 선택기는 이 층에 적용되지 않습니다.",
        el("br"),
      ]),
      `· [가정] 대체투자 α +${fmtNum(st.alt_alpha, 1)}%p` +
      (E.layer === "cma"
        ? ` · 위험은 위 「대체투자 위험 (분류별)」 매핑이 정합니다(수기 alt_vol 은 이 층에서 미사용)`
        : ` · 위험 ${fmtNum(st.alt_vol, 0)}% (평가 스무딩 탓에 실측 σ는 과소평가)`) +
      ` · 가중평균 스왑 만기 ${st.tenor_m}개월(3·6·12·12M+ 혼합의 금액가중 — 비용 보간과 MTM 잔존만기에 사용) — 전부 수기 입력에서 바꿀 수 있습니다`));

    /* ----- 차트 2개 (드래그 중에는 미루고 놓으면 갱신) ----- */
    if (!doOpt) {
      /* 최적화 산출물(투자선·이행경로)은 실행 가능 제약에서만 */
      clearTimeout(chartTimer);
      allocCharts.forEach(destroyChart);
      allocCharts = [];
      const why = "제약이 서로 모순되어 계산을 보류했습니다 — 수기 입력에서 밴드·그룹 한도를 고치십시오.";
      [["효율적 투자선", frontierCard], ["이행 경로", pathCard],
       ["표본 민감도·시변", tvCard]].forEach(([title, box]) => {
        box.textContent = "";
        box.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, `${title} — 보류`)),
          el("div", { class: "card-sub" }, why));
      });
    } else if (withCharts) {
      /* 시변·창 민감도 — 타이머 밖 동기 렌더(드래그 중(recalc(false))에는 안 돈다).
         타이머 안에 두면 프로브가 못 본다 — 셰이드는 타이머를 흘리지 않는다. */
      renderAllocTv(tvCard, E, st, pal, () => recalc(true));
      clearTimeout(chartTimer);
      chartTimer = setTimeout(() => {
        allocCharts.forEach(destroyChart);
        allocCharts = [];
        /* 효율적 투자선 */
        const muLo = muMin, muHiW = E.optimize(V.mu.map((x) => x), V.C, Math.max(...V.mu), 800);
        const muHi = amDot(V.mu, muHiW);
        const pts = [];
        for (let k = 0; k <= 24; k++) {
          const tg = muLo + (muHi - muLo) * k / 24;
          const w = E.optimize(V.mu, V.C, tg, 1000);
          pts.push({ mu: amDot(V.mu, w), sig: E.sigmaW(w, V.C), w });
        }
        const fbox = cardScaffold(frontierCard, {
          title: "효율적 투자선 — 밴드 제약 반영",
          sub: "× 현재 · ① 위험최소 · ② 수익유지 (참고치)",
          csvName: "효율적투자선.csv",
          tableFn: () => ({
            headers: ["위험%", "기대수익%", ...V.keys.map((k) => k + "%")],
            rows: pts.map((p) => [fmtNum(p.sig, 2), fmtNum(p.mu, 2), ...p.w.map((x) => fmtNum(x * 100, 1))]),
          }),
        });
        const xsF = pts.map((p) => +p.sig.toFixed(3));
        /* 점 마커 — "내가 지금 어디에 있고, 어디로 움직였고, 참고치는 어디인가"를
           선 위에 직접 찍는다. 조정 중이면 기준(저장값)과 조정점이 따로 보인다. */
        const markers = [
          { x: sigMin, y: muMin, kind: "dot", label: "①", color: pal.series[1] },
          { x: sigKeep, y: muKeep, kind: "dot", label: "②", color: pal.series[1] },
        ];
        if (dirty) {
          markers.push({ x: baseSig, y: baseMu, kind: "x", label: "기준(저장값)" },
                       { x: sigCur, y: muCur, kind: "tri", label: "조정" });
        } else {
          markers.push({ x: sigCur, y: muCur, kind: "x", label: "현재" });
        }
        const mxs = markers.map((m) => m.x), mys = markers.map((m) => m.y);
        const yAll = [...pts.map((p) => p.mu), ...mys];
        allocCharts.push(makeRatioChart(fbox, {
          seriesDefs: [
            { label: "투자선", color: pal.series[0], x: xsF, v: pts.map((p) => +p.mu.toFixed(3)) },
          ],
          xLabel: "위험(연)",
          xRange: [Math.min(sigMin, ...mxs) * 0.9, Math.max(...xsF, ...mxs) * 1.05],
          yRange: [Math.min(...yAll) - 0.08, Math.max(...yAll) + 0.08],
          unit: "%", height: 260, markers,
        }));
        frontierCard.append(el("div", { class: "card-sub", style: "margin-top:6px" },
          (dirty
            ? `× 기준(저장값) (${fmtNum(baseSig, 2)} · ${fmtNum(baseMu, 2)}) · ▲ 조정 (${fmtNum(sigCur, 2)} · ${fmtNum(muCur, 2)})`
            : `× 현재 (위험 ${fmtNum(sigCur, 2)} · 수익 ${fmtNum(muCur, 2)})`)
          + ` · ① (${fmtNum(sigMin, 2)} · ${fmtNum(muMin, 2)}) · ② (${fmtNum(sigKeep, 2)} · ${fmtNum(muKeep, 2)}) — 표 버튼에서 선 위 각 점의 배분(%)을 볼 수 있습니다.`));
        /* 이행 경로 */
        const steps = [];
        for (let k = 0; k <= 20; k++) {
          const tt = k / 20;
          const w = w0.map((x, i) => x + tt * (wKeep[i] - x));
          steps.push(+E.sigmaW(w, V.C).toFixed(4));
        }
        const pbox = cardScaffold(pathCard, {
          title: "이행 경로 — 현재 → ② 참고치",
          sub: `전량 이행 시 매매회전 ${fmtNum(turnover, 1)}%p · 부분 이행도 위험이 단조 감소하는지 확인`,
          csvName: "이행경로.csv",
          tableFn: () => ({
            headers: ["이행률%", "위험%"],
            rows: steps.map((s, i) => [i * 5, fmtNum(s, 3)]),
          }),
        });
        allocCharts.push(makeRatioChart(pbox, {
          seriesDefs: [{ label: "총위험", color: pal.series[0], x: steps.map((_, i) => i * 5), v: steps }],
          xLabel: "이행률", unit: "%", height: 260,
        }));
      }, 120);
    }
  }
  recalc(true);

  const mth = $("#alloc-method");
  mth.textContent = "";
  mth.append(el("summary", {}, "산식 · 출처 · 한계 (방법론)"));
  mth.append(el("p", {}, el("b", {}, "방법"),
    " — 평균-분산 최적화(Markowitz 1952) + 자산군 밴드 제약, 투영 경사법(역행렬 불사용). ",
    el("b", {}, "자산군 우주는 시가 기준 7축 하나"),
    "입니다 — 장부가 자산 축은 2026-08-12 배분 우주에서 제외했습니다(원가법 BM 의 손익변동 σ 는 시장위험을 나르지 않아 같은 MVO 방법론을 적용할 수 없음 — §7.7.11). ",
    "장부 보유 채권의 경제적 위험은 시가 채권 축이 나르고, 원가법이 숨기는 진짜 위험(재투자·ALM)은 듀레이션 갭 카드가 표시합니다. ",
    "해외자산 원화수익률 = 현지수익률 + (1−헤지비율)×환율변동 + 헤지비율×스왑레이트. 장부가 해외채권의 회계 손익 곡면은 환헤지 화면(5항 회계 모형)에 그대로 있습니다."));
  if (E0.layer === "cma" && E0.cmaAll) {
    const cm = E0.cmaAll;
    mth.append(el("p", {}, el("b", {}, "위험 원천 — 기관 전략 벤치마크(CMA)"),
      ` — ${cm.method || ""} `,
      el("b", {}, "해외 벤치마크의 환 기준은 계열마다 다릅니다"),
      " — 기관이 자산군별 실제 정책 그대로 지수를 만들기 때문입니다. 해외채권은 환헤지 반영"
      + "(달러원 회귀계수 −0.05), 해외주식은 미헤지(계수 +1.00, R² 97.9%)입니다. 그래서 계열별 "
      + "기준 헤지비율 h₀ 를 두고 (h₀ − h) 만큼 달러원 축(_fx)을 더해 헤지 반영 공분산을 폐형 "
      + "재구성합니다 — h = h₀ 면 보정이 0 입니다. 단순상관으로는 갈리지 않습니다(ACWI 자체가 "
      + "달러원과 음의 상관이라 미헤지 해외주식도 단순상관이 0 근처로 상쇄됩니다). ",
      "대체투자는 지분형/대출형 두 분류로 나뉘고, 각 분류에 기관 현행 방식의 시가 해외주식·시가 국내채권 변동성 매핑을 따로 겁니다(기본 지분형 65/35 · 대출형 0/100 — 비율은 위 콘솔에서 조정). 잔차(고유위험)는 디스무딩 보조축을 두 팩터의 스팬에 회귀한 잔차분산으로 폐형 계산해 분류마다 독립으로 더합니다 — 두 분류는 서로 다른 딜의 부분북이고, 공유(완전상관) 잔차로 넣으면 행렬이 도로 특이해집니다(실측 §7.7.9). 잔차 없이 넣으면 공분산이 특이행렬이 됩니다. ",
      "구 층의 스왑 MTM 항(d_swap)은 이 층에 없습니다. 아래 부트스트랩·재추출 카드는 프록시층 표본 기준입니다(벤치마크 부트스트랩은 차기)."));
    if (cm.coverage && cm.coverage.length) {
      const ct = el("table", { class: "mini-table" },
        el("tr", {}, ...["자산군", "그룹", "표본", "개월", "배분 대상"].map((h) => el("th", {}, h))));
      cm.coverage.forEach((c) => {
        ct.append(el("tr", {},
          el("td", { style: "text-align:left" }, c.label),
          el("td", {}, c.group),
          el("td", { class: "num" }, `${c.first || "–"} ~ ${c.last || "–"}`),
          el("td", { class: "num" }, String(c.n_months)),
          el("td", {}, c.included ? "포함" : "제외")));
      });
      mth.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, ct),
        el("div", { style: "font-size:11.5px;color:var(--ink-3)" },
          "제외 = 행렬 미게시 자산군(금융상품·대출금 — 2026-08-11 지시). 장부가 채권 두 계열은 행렬에는 있으나 " +
          "배분 축이 아닙니다(2026-08-12 장부가 축 제거 — 원가법 σ 는 시장위험이 아니라서 진단·대조용으로만 남습니다)."));
    }
  }
  mth.append(el("p", {}, el("b", {}, "기대수익"),
    " — 키인(사용자 CMA)이 정본이고, 미입력 자산만 폴백을 씁니다: 채권·현금은 현재 시장금리 [관측], 주식은 손으로 ERP를 정하지 않고 채권 시장이 지금 위험 1단위에 주는 보상(샤프)을 관측해 주식 σ에 곱합니다(동일 샤프 앵커 — 자유 모수 0개). 역사적 실현 평균은 기대수익으로 쓰지 않습니다(표본 구간을 고른 사람이 답을 고르게 되므로). 환율 기대변동은 0(랜덤워크)."));
  mth.append(el("p", {}, el("b", {}, "한계"), ` — ${A.limits}`));
}

/* ----- 자산배분 드릴다운 오버레이 ----- */

function allocOverlayShell(title) {
  return openOverlayShell({
    backLabel: "‹ 자산배분 기본 화면", backHash: "alloc",
    crumbTail: ` / ${title}`, title: `자산배분 — ${title}`,
  });
}

function openAllocDetail(topic) {
  const A = DATA.alloc;
  if (!A || !A.sets || !A.sets.length) { hideDetail(); return; }
  const st = allocState(A);
  const E = allocEngine(A, st);
  const pal = palette();

  /* --- 수기 입력 (내부 정보 — 이 브라우저에만 저장) --- */
  if (topic === "sim") {
    const inner = allocOverlayShell("수기 입력 (우리 기관 내부 정보)");
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "이 화면이 하는 일 — 내부 정보를 넣으면 모든 참고치가 귀사 기준으로 다시 계산됩니다"),
      el("div", { class: "a" }, "입력값은 이 브라우저(localStorage)에만 저장 ",
        el("small", {}, "서버·저장소로 전송되지 않습니다. 공용 PC에서는 사용 후 초기화를 누르십시오."))));
    const form = el("div", { class: "card" });
    const fields = [];
    /* 입력칸에 id·aria-label 을 붙인다. 예전에는 둘 다 없어서 스크린리더에 "숫자 입력"
       으로만 읽혔다(표의 행 머리글은 보조기술이 자동으로 이어 주지 않는다).
       id 는 `:` 를 빼고 만든다 — CSS 선택자에서 이스케이프가 필요해지기 때문이다. */
    const numIn = (key, val, step, ph, label) => {
      const i = el("input", {
        type: "number", step: String(step || 0.1),
        value: val == null ? "" : String(val), placeholder: ph || "",
        id: "in-" + key.replace(/[^\w가-힣]+/g, "-"),
        "aria-label": label || key,
      });
      fields.push([key, i]);
      return i;
    };
    const secHead = (txt) => el("div", { class: "card-head", style: "margin-top:10px" }, el("span", { class: "card-title" }, txt));

    form.append(secHead("① 자산군 비중 (%) — 시가 기준 7축 (장부가 축 제외 2026-08-12)"));
    const tw = el("table", { class: "grid-inp" },
      el("tr", {}, ...["자산군", "비중%", "밴드 하한", "밴드 상한"].map((h) => el("th", {}, h))));
    ALLOC_ECON.forEach((k) => {
      tw.append(el("tr", {},
        el("td", {}, k),
        el("td", {}, numIn(`mix:${k}`, st.mix[k], 0.1)),
        el("td", {}, numIn(`elo:${k}`, (st.bands[k] || [0, 100])[0], 1)),
        el("td", {}, numIn(`ehi:${k}`, (st.bands[k] || [0, 100])[1], 1))));
    });
    form.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, tw));
    form.append(explainBox("alloc-form-basis",
      "장부 보유 채권은 국내채권·해외채권(시가) 칸에 합산해 입력합니다 — 장부가 축은 배분 우주에서 " +
      "제외됐습니다(원가법 BM 은 시장위험을 나르지 않음 — 재투자·ALM 위험은 아래 ③ 듀레이션 갭이 담당)."));

    form.append(secHead("② 제약"));
    /* 대출금 칸(2026-08-12)·장부가 합산 상한(cap_book, §7.7.11)은 폐지 — 7개 자산군이 합 100 */
    form.append(el("div", { class: "tenor-row" },
      "해외 합계 상한 %", numIn("cap_foreign", st.cap_foreign, 1, "없음"),
      " 주식 합계 상한 %", numIn("cap_equity", st.cap_equity, 1, "없음")));
    form.append(el("div", { class: "tenor-row" },
      "목표수익률 %", numIn("target_ret", st.target_ret, 0.05, "미입력=현재 유지"),
      " 위험한도 %", numIn("risk_cap", st.risk_cap, 0.05, "없음")));

    form.append(secHead("②-1 기대수익 키인 (연 %) — 디폴트 = 사용자 지정 CMA (2026-08-12)"));
    const cmaMean = (ek) => {
      /* 과거 평균 배지 — 참고용(§7.7: 기대수익으로 쓰지 않는다). 현재 창 기준. */
      if (E.layer !== "cma" || !E.cmaW) return null;
      const lb = { 국내채권: "시가 국내채권", 해외채권: "시가 해외채권", 국내주식: "시가 국내주식",
                   해외주식: "시가 해외주식", "대체투자(지분형)": "시가 대체투자",
                   "대체투자(대출형)": "시가 대체투자", 단기자금: "장부가 단기자금" }[ek];
      const i = E.cmaAll.cols.indexOf(lb);
      return i >= 0 ? E.cmaW.mean_pct[i] : null;
    };
    const muRow = el("div", { class: "tenor-row" });
    ALLOC_ECON.forEach((k) => {
      const m = cmaMean(k);
      muRow.append(el("span", {}, k), numIn(`mo:${k}`, (st.mu_over || {})[k], 0.05, "앵커", `${k} 기대수익 %`),
        m != null ? el("small", { style: "color:var(--ink-3)" }, `과거 ${fmtNum(m, 2)}%`) : "");
    });
    form.append(muRow);
    form.append(explainBox("alloc-form-mu",
      "키인은 **최종치**(헤지비용 반영 후 원화 기대수익)로 그대로 쓰입니다 — 캐리를 다시 더하지 " +
      "않으며(§7.7.10), 헤지 슬라이더는 기대수익이 아니라 위험(환노출)에 작용합니다. " +
      "「과거」 배지는 벤치마크 창의 실현 평균이며 참고용입니다 — 기대수익으로 자동 사용하지 않습니다(§7.7). " +
      "전망 모델(모델 랩)이 완성되면 그 출력이 이 자리에 꽂힙니다."));

    /* 구 「북일드·장부채권 잔존만기」 칸은 장부가 축과 함께 폐지(§7.7.11) —
       장부 보유 채권의 위험은 시가 축(σ)과 아래 듀레이션 갭(재투자·ALM)이 담당한다. */
    form.append(secHead("③ ALM — 듀레이션 갭"));
    form.append(el("div", { class: "tenor-row" },
      "부채 듀레이션(년)", numIn("dur_liab", st.dur_liab, 0.1),
      " 자산 듀레이션(년)", numIn("dur_asset", st.dur_asset, 0.1, "자산군별 입력 시 무시"),
      " 부채/자산 비율", numIn("la_ratio", st.la_ratio, 0.01, "예: 0.9")));
    form.append(el("div", { class: "tenor-row" },
      "자산군별 듀레이션(년) — 국내채권", numIn("dby:국내채권", (st.dur_by || {})["국내채권"], 0.1, "미입력"),
      " 해외채권", numIn("dby:해외채권", (st.dur_by || {})["해외채권"], 0.1, "미입력"),
      " 단기자금", numIn("dby:단기자금", (st.dur_by || {})["단기자금"], 0.1, "미입력")));
    form.append(explainBox("alloc-form-dur",
      "자산군별 듀레이션을 넣으면 자산 듀레이션을 **배분에서 계산**하므로, 배분을 바꿀 때 갭이 함께 움직입니다 " +
      "(주식·대체는 표준 근사대로 0). 듀레이션 갭은 **최적화 제약이 아니라 결과 표시**입니다 — " +
      "내규에 허용 괴리폭이 없어 임의의 폭을 만들지 않았습니다. " +
      "해외채권 듀레이션은 해외 금리에 대한 민감도라 원화 부채의 할인율과 같은 위험요인이 아닙니다 — " +
      "그 부분을 갭에서 빼고 보시려면 해외채권 칸을 0으로 두십시오."));

    form.append(secHead("④ 통화·헤지·가정"));
    form.append(el("div", { class: "tenor-row" },
      "해외채권 헤지 %", numIn("h_bond", st.h_bond, 5),
      " 해외주식 헤지 %", numIn("h_eq", st.h_eq, 5),
      " 가중평균 스왑 만기(월)", numIn("tenor_m", st.tenor_m, 1, "예: 9"),
      " 대체 α %p", numIn("alt_alpha", st.alt_alpha, 0.1),
      " 대체 위험 %", numIn("alt_vol", st.alt_vol, 0.5)));
    form.append(explainBox("alloc-form-tenor",
      "스왑 만기는 3·6·12·12개월 초과 계약을 섞어 쓰는 실무를 반영해 금액가중평균 하나로 입력합니다 — " +
      "헤지비용(HP 곡선 보간, 12개월 초과는 12M 값 고정)과 스왑 MTM 잔존만기(만기/2) 계산에 쓰입니다. " +
      "통화별(유로·엔 등) 구성 분해는 차기 확장입니다 — 현재 해외자산은 달러 프록시 기준이며, 통화별 헤지 판단은 환헤지 시뮬레이터를 함께 쓰십시오."));

    /* 헤지비율 밴드 — 내규는 기관 내부정보라 기본값을 중립(0~100)으로 두고 여기서만 받는다.
       '일시 초과 허용선'은 NAV 감소로 계약을 즉시 줄이지 못해 생기는 운영 허용오차이지
       최적화가 고를 수 있는 값이 아니므로 결정범위와 칸을 나눈다. */
    const tw3 = el("table", { class: "mini-table" },
      el("tr", {}, ...["헤지비율 밴드", "하한 %", "상한 %(결정범위)", "일시 초과 허용선 %"]
        .map((h) => el("th", {}, h))));
    ["해외채권", "해외주식"].forEach((k) => {
      const b = (st.h_bands && st.h_bands[k]) || [0, 100];
      tw3.append(el("tr", {},
        el("td", { style: "text-align:left" }, k),
        el("td", {}, numIn(`hlo:${k}`, b[0], 5)),
        el("td", {}, numIn(`hhi:${k}`, b[1], 5)),
        el("td", {}, numIn(`htol:${k}`, (st.h_tol_hi || {})[k], 5, "없음"))));
    });
    form.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, tw3));
    form.append(explainBox("alloc-form-bands",
      "기본값은 「밴드 없음」(0~100)입니다 — 기관 내규 값은 여기에 입력하시면 이 브라우저에만 저장되고 " +
      "저장소·페이지에는 올라가지 않습니다. 일시 초과 허용선은 결정범위에 넣지 않습니다: " +
      "펀드 NAV가 줄어 헤지 계약을 즉시 줄이지 못할 때 생기는 운영상 허용오차이지, 최적화가 고를 선택지가 아니기 때문입니다."));

    /* ----- 통화 구성 ----- */
    const bench = A.ccy_bench || {};
    const tw4 = el("table", { class: "mini-table" },
      el("tr", {}, ...["통화", "해외채권 %", "해외주식 %"].map((h) => el("th", {}, h))));
    const ccyRow = (code, label, note) => {
      const tr = el("tr", {},
        el("td", { style: "text-align:left" }, label,
          note ? el("small", { style: "color:var(--ink-3);margin-left:6px" }, note) : ""));
      ["해외채권", "해외주식"].forEach((sl) => {
        tr.append(el("td", {}, numIn(`ccy:${sl}:${code}`, (st.ccy[sl] || {})[code], 0.1,
                                     "미입력", `${sl} ${label} 비중 %`)));
      });
      tw4.append(tr);
    };
    ALLOC_CCY.forEach((c) => ccyRow(c, `${c} ${ALLOC_CCY_NAME[c]}`));
    ccyRow("KRW", "KRW 원화", "환노출 0");
    ccyRow("OTHER", "기타", "모형 밖 통화");
    form.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, tw4));

    /* 벤치마크 채우기 — 공개 벤치마크 값을 입력칸에 **써 넣기만** 한다(자동 적용 아님).
       사용자가 저장을 눌러야 반영되므로, 기관 실제 비중을 덮어쓸 위험이 없다. */
    const fillRow = el("div", { class: "tenor-row" });
    ["해외채권", "해외주식"].forEach((sl) => {
      const b = bench[sl];
      if (!b) return;
      fillRow.append(el("button", { type: "button", class: "btn-ghost", onclick: () => {
        const put = (code, v) => {
          const f = fields.find(([k]) => k === `ccy:${sl}:${code}`);
          if (f) f[1].value = v == null ? "" : String(v);
        };
        ALLOC_CCY.forEach((c) => put(c, (b.w || {})[c] || 0));
        put("KRW", b.krw); put("OTHER", b.other);
      } }, `${sl} 벤치마크 채우기`));
    });
    form.append(fillRow);
    /* 출처·기준일·근거 품질을 그대로 적는다 — 두 자산군의 품질이 다르다. */
    ["해외채권", "해외주식"].forEach((sl) => {
      const b = bench[sl];
      if (!b) return;
      const cov = ALLOC_CCY.reduce((a, c) => a + ((b.w || {})[c] || 0), 0);
      form.append(el("div", { class: "section-note" },
        el("b", {}, `${sl} 벤치마크`), ` — ${b.src} · 기준일 ${b.asof} · 모형 7통화 커버리지 `,
        el("b", {}, `${fmtNum(cov, 2)}%`),
        `(원화 ${fmtNum(b.krw, 2)}% 는 환노출 0, 기타 ${fmtNum(b.other, 2)}% 는 모형 밖). `,
        b.basis, b.note ? el("span", {}, " ", el("b", {}, "주의"), " — " + b.note) : ""));
    });
    form.append(explainBox("alloc-form-ccy", { label: "이 값은 공개 벤치마크입니다 (기관 실제 비중 아님)" },
      "여기 값은 **공개 벤치마크**이며 귀 기관 실제 비중이 아닙니다 — 실제 값을 넣으시면 " +
      "이 브라우저에만 저장되고 저장소·페이지에는 올라가지 않습니다. " +
      "합계를 100%로 강제하지 않습니다: 모형이 덮는 범위를 그대로 보이게 두는 편이 낫기 때문입니다."));

    const btnRow = el("div", { style: "margin-top:12px;display:flex;gap:10px" });
    btnRow.append(
      el("button", { class: "btn-primary", onclick: () => {
        fields.forEach(([key, i]) => {
          const v = i.value === "" ? null : +i.value;
          if (key.startsWith("mix:")) { if (v != null) st.mix[key.slice(4)] = v; }
          else if (key.startsWith("elo:")) { st.bands[key.slice(4)][0] = v == null ? 0 : v; }
          else if (key.startsWith("ehi:")) { st.bands[key.slice(4)][1] = v == null ? 100 : v; }
          else if (key.startsWith("hlo:")) { st.h_bands[key.slice(4)][0] = v == null ? 0 : v; }
          else if (key.startsWith("hhi:")) { st.h_bands[key.slice(4)][1] = v == null ? 100 : v; }
          else if (key.startsWith("htol:")) { st.h_tol_hi[key.slice(5)] = v; }
          else if (key.startsWith("dby:")) { st.dur_by[key.slice(4)] = v; }
          else if (key.startsWith("mo:")) { st.mu_over[key.slice(3)] = v; }
          else if (key.startsWith("ccy:")) {
            const [, sl, code] = key.split(":");
            if (!st.ccy[sl]) st.ccy[sl] = {};
            if (v == null) delete st.ccy[sl][code]; else st.ccy[sl][code] = v;
          }
          else st[key] = v;
        });
        ["h_bond", "h_eq"].forEach((k) => { st[k] = Math.min(100, Math.max(0, st[k] == null ? 90 : st[k])); });
        if (st.tenor_m == null) st.tenor_m = A.defaults.tenor_m;
        if (st.alt_alpha == null) st.alt_alpha = A.defaults.alt_alpha;
        if (st.alt_vol == null) st.alt_vol = A.defaults.alt_vol;
        allocSaveState(st);
        location.hash = "alloc";
        renderAlloc();
      } }, "저장하고 기본 화면으로"),
      el("button", { class: "theme-btn", style: "width:auto;padding:0 14px;font-size:12.5px",
        onclick: () => { localStorage.removeItem(ALLOC_LS_KEY); location.hash = "alloc"; renderAlloc(); } },
        "입력 초기화 (예시값으로)"));
    form.append(btnRow);
    inner.append(form);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 앵커 도출·민감도 --- */
  if (topic === "anchor") {
    const inner = allocOverlayShell("동일 샤프 앵커 — 도출과 민감도");
    const a = E.V.anchor;
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "왜 주식 기대수익을 손으로 정하지 않는가"),
      el("div", { class: "a" }, `채권 샤프 앵커 ${fmtNum(a.value, 4)} `,
        el("small", {}, "ERP를 두 개(국내·해외) 가정하는 대신, 관측되는 값 하나로 줄였습니다"))));
    const c1 = el("div", { class: "card" });
    c1.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "도출 (전부 [관측])")));
    const R = A.rates;
    [
      `국내: (한국 5년 ${R.kr5y.v}% − 한국 3개월 ${R.kr3m.v}%) ÷ 국내채권 σ ${fmtNum(a.kr.sigma, 3)}% = ${fmtNum(a.kr.prem / a.kr.sigma, 4)}`,
      `해외: (미 종합 YTM ${R.us_ytm.v}% − 미국 3개월 ${R.us3m.v}%) ÷ 미국종합 σ(달러표시) ${fmtNum(a.us.sigma, 3)}% = ${fmtNum(a.us.prem / a.us.sigma, 4)}`,
      `앵커 = 두 값의 평균 = ${fmtNum(a.value, 4)} → 주식 ERP = 앵커 × 각 주식의 자국통화 σ`,
      `두 다리 모두 자국통화 기준(환율·헤지 개입 전)이라 앵커는 헤지 슬라이더와 무관합니다.`,
    ].forEach((s) => c1.append(el("div", { style: "font-size:12.5px;padding:2px 0" }, s)));
    inner.append(c1);
    const c2 = el("div", { class: "card", style: "margin-top:12px" });
    c2.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "검증 — 헤지비율을 움직여도 앵커·주식 기대수익이 흔들리지 않는가"),
      el("span", { class: "card-sub" },
        "키인(최종치)된 자산의 μ 는 헤지비율과 무관하게 일정해야 하고(§7.7.10), 키인을 비운 해외자산만 비용항(헤지비율 × 스왑레이트)만큼 움직여야 합니다")));
    const t2 = el("table", { class: "mini-table" },
      el("tr", {}, ...["채권헤지", "앵커", "국내주식 μ%", "해외주식 μ%", "해외채권 μ%"].map((h) => el("th", {}, h))));
    [0, 25, 50, 75, 90, 100].forEach((h) => {
      const stx = { ...st, h_bond: h };
      const Ex = allocEngine(A, stx);
      const B = Ex.build("econ", h / 100, st.h_eq / 100);
      const kI = B.keys.indexOf("국내주식"), gI = B.keys.indexOf("해외주식"), bI = B.keys.indexOf("해외채권");
      t2.append(el("tr", { style: h === st.h_bond ? "font-weight:700" : "" },
        el("td", {}, `${h}%${h === st.h_bond ? " (현재)" : ""}`),
        el("td", { class: "num" }, fmtNum(B.anchor.value, 4)),
        el("td", { class: "num" }, fmtNum(B.mu[kI], 2)),
        el("td", { class: "num" }, fmtNum(B.mu[gI], 2)),
        el("td", { class: "num" }, fmtNum(B.mu[bI], 2))));
    });
    c2.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t2),
      el("div", { class: "card-sub", style: "margin-top:6px" },
        "앵커·국내주식·해외주식 열은 채권 헤지비율과 무관하게 일정합니다. 해외채권 열은 키인(최종치)이면 일정하고, " +
        "키인을 비우면 비용항(헤지비율×스왑레이트)만큼 움직입니다(§7.7.10). " +
        "구버전은 앵커의 해외 다리를 원화 헤지 기준으로 재서 채권 헤지를 만지면 국내주식 기대수익까지 흔들렸습니다 — 검증에서 지적되어 자국통화 기준으로 교체(승인 ⑤-ⓑ 확정)."));
    inner.append(c2);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 헤지 곡면 --- */
  if (topic === "hedge") {
    const inner = allocOverlayShell("헤지 곡면 — 배분 고정, 헤지만 움직일 때");
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "채권·주식 헤지비율을 함께 움직이면 총위험이 어떻게 변하나"),
      el("div", { class: "a" }, "곡면에 완전히 평평한 능선이 있습니다 ",
        el("small", {}, "총 미헤지 환노출 Xe 가 같으면 어느 쪽에서 열든 위험이 정확히 같습니다 — 근사가 아니라 항등식입니다"))));
    const hs = [];
    for (let h = 0; h <= 100; h += 5) hs.push(h);
    const mk = (title, fn) => {
      const card = el("div", { class: "card", style: "margin-top:12px" });
      const box = cardScaffold(card, { title, csvName: "헤지곡면.csv",
        tableFn: () => ({ headers: ["헤지비율", "0%", "50%", "100%"],
          rows: hs.map((h) => [h + "%", ...[0, 50, 100].map((o) => fmtNum(fn(h, o), 3))]) }) });
      overlayCharts.push(makeRatioChart(box, {
        seriesDefs: [0, 50, 100].map((o, i) => ({
          label: `상대축 ${o}%`, color: pal.series[i], x: hs, v: hs.map((h) => +fn(h, o).toFixed(3)) })),
        xLabel: "헤지비율", unit: "%", height: 250 }));
      return card;
    };
    inner.append(mk("총위험 vs 채권헤지 (선 = 주식헤지 0/50/100%)", (h, o) => E.sigmaHedge(h / 100, o / 100)));
    inner.append(mk("총위험 vs 주식헤지 (선 = 채권헤지 0/50/100%)", (h, o) => E.sigmaHedge(o / 100, h / 100)));
    /* 자산별 MVH 와 포트폴리오 최적의 차이 — MVH 는 현지채권 vs 환율만 (hedge.py 정의) */
    const rowUsLocal = new Array(E.S.length).fill(0); rowUsLocal[E.ix.us_bond] = 1;
    const rowE = new Array(E.S.length).fill(0); rowE[E.ix.e_usd] = 1;
    const covBE = amDot(rowUsLocal, amMv(E.S, rowE));
    const varE = E.S[E.ix.e_usd][E.ix.e_usd];
    const mvhBond = (1 + covBE / varE) * 100;
    /* 왜 해외주식은 열어 두는 쪽이 위험을 낮추나 — 부호를 표본별로 직접 보여 준다.
       (위험자산이 빠질 때 달러가 오르는 '자연헤지'가 데이터에 있는지 확인하는 자리.) */
    const corrOf = (cov, a, b) => {
      const d = Math.sqrt(cov[a][a] * cov[b][b]);
      return d > 0 ? cov[a][b] / d : NaN;
    };
    const cNat = el("div", { class: "card", style: "margin-top:12px" });
    const tNat = el("table", { class: "mini-table" },
      el("tr", {}, ...["표본", "해외주식 ↔ 달러/원", "해외채권 ↔ 달러/원"].map((h) => el("th", {}, h))));
    A.sets.forEach((s) => {
      const cE = corrOf(s.cov, E.ix[s.proxy_only || E.proxy], E.ix.e_usd);
      const cB = corrOf(s.cov, E.ix.us_bond, E.ix.e_usd);
      tNat.append(el("tr", { style: s.key === (st.start_key || "full") ? "font-weight:700" : "" },
        el("td", { style: "text-align:left" }, s.label + (s.key === (st.start_key || "full") ? " (선택됨)" : "")),
        el("td", { class: "num" }, isFinite(cE) ? fmtNum(cE, 3) : "—"),
        el("td", { class: "num" }, isFinite(cB) ? fmtNum(cB, 3) : "—")));
    });
    cNat.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "자연헤지가 실제로 있는가 — 달러/원과의 상관"),
      el("span", { class: "card-sub" }, "음(−)이면 환을 열어 두는 쪽이 총위험을 낮춥니다")),
      el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tNat),
      el("div", { class: "card-sub", style: "margin-top:6px" },
        "해외주식이 빠질 때 달러/원이 오르는 관계가 음의 상관으로 나타납니다 — 미헤지 해외주식이 " +
        "그 자체로 완충 역할을 한다는 실무 통념과 같은 방향이며, 표본을 바꿔도 부호가 유지되는지 여기서 확인하십시오. " +
        "부호가 뒤집히면 위 Xe 곡선의 기울기도 함께 뒤집힙니다."));
    inner.append(cNat);

    /* 진짜 1차원 축 — σ vs Xe. 위의 두 곡면은 이 곡선을 (hb,he) 로 다시 그린 것뿐이다. */
    const q = E.xeQuad();
    const xeOpen = E.xeOpen();
    const xeFree = E.xeStar(null, null, q);
    const hbands = allocHBands(st);
    const [xeLo, xeHi] = allocXeRange(E, hbands);
    const xeBand = E.xeStar(xeLo, xeHi, q);
    const xeCur = E.xeOf(st.h_bond / 100, st.h_eq / 100);
    const xs = [];
    for (let i = 0; i <= 40; i++) xs.push(+(xeOpen * 100 * i / 40).toFixed(4));
    const cardXe = el("div", { class: "card", style: "margin-top:12px" });
    const boxXe = cardScaffold(cardXe, {
      title: "총위험 vs 총 미헤지 환노출 Xe — 헤지 레버의 진짜 축은 이것 하나입니다",
      csvName: "헤지_Xe곡선.csv",
      tableFn: () => ({ headers: ["Xe %", "총위험 %"],
        rows: xs.map((x) => [fmtNum(x, 2), fmtNum(E.sigmaXe(x / 100, q), 3)]) }) });
    overlayCharts.push(makeRatioChart(boxXe, {
      seriesDefs: [{ label: "총위험", color: pal.series[0], x: xs,
        v: xs.map((x) => +E.sigmaXe(x / 100, q).toFixed(3)) }],
      xLabel: "총 미헤지 환노출 Xe (총자산 대비 %)", unit: "%", height: 250 }));
    inner.append(cardXe);
    /* 동률 능선을 표로 직접 보여 준다 — "같은 Xe 면 위험이 같다"를 눈으로 확인시키는 자리 */
    const tie = el("table", { class: "mini-table" },
      el("tr", {}, ...["채권헤지 %", "주식헤지 %", `Xe %`, "총위험 %"].map((h) => el("th", {}, h))));
    const wbb = E.w0[1], wee = E.w0[3];
    if (wbb > 1e-12 && wee > 1e-12) {
      const cc = wbb + wee - xeBand;
      for (let hb2 = 0; hb2 <= 100; hb2 += 5) {
        const he2 = (cc - wbb * hb2 / 100) / wee;
        if (he2 < -1e-9 || he2 > 1 + 1e-9) continue;
        tie.append(el("tr", {},
          el("td", { class: "num" }, fmtNum(hb2, 0)),
          el("td", { class: "num" }, fmtNum(he2 * 100, 1)),
          el("td", { class: "num" }, fmtNum(E.xeOf(hb2 / 100, he2) * 100, 4)),
          el("td", { class: "num" }, fmtNum(E.sigmaHedge(hb2 / 100, he2), 6))));
      }
    }
    const cardTie = el("div", { class: "card", style: "margin-top:12px" });
    cardTie.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "동률 능선 — 위험 최소 Xe 를 만드는 조합들"),
      el("span", { class: "card-sub" }, "마지막 열이 소수점 여섯 자리까지 같습니다 — 한 점을 최적이라 적으면 임의 선택입니다")),
      el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tie));
    inner.append(cardTie);
    inner.append(el("div", { class: "howto", style: "margin-top:12px" },
      el("b", {}, "왜 자산별 참고치와 다른가"),
      ` — 채권만 떼어 본 최소분산 헤지(MVH)는 ${fmtNum(mvhBond, 0)}%지만, 포트폴리오 전체의 위험 최소 Xe 는 ${fmtNum(xeBand * 100, 2)}%입니다(현재 ${fmtNum(xeCur * 100, 2)}%). 총위험에는 국내주식·환율의 상쇄까지 들어오기 때문입니다. `,
      /* §7.7.17 — 여기도 요약표·① 카드와 같은 판정·같은 문장. 예전에는 분리 이전의
         단일 플래그라 밴드가 중립이어도 「밴드가 물고 있습니다」가 나갔다. 이 문단은
         방법론 설명 자리라 사용자가 원인 진단의 근거로 읽는 지점이다. */
      ...allocXeBindNotes(allocXeBinds(xeOpen, xeLo, xeHi, xeFree)).map((s) => el("b", {}, `${s}. `)),
      "회계(손익) 관점은 방향이 정반대 — 장부가 해외채권은 상쇄해줄 가격변동이 손익에 없어 헤지 100%가 언제나 손익변동 최소입니다(판단 변수는 비용). ",
      el("b", {}, "회계 관점에서는 이 Xe 붕괴가 성립하지 않습니다"), " — 스왑 MTM(−h·만기/2)이 채권 축을 따로 남기기 때문입니다."));
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 헤지비용 선택 --- */
  if (topic === "cost") {
    const inner = allocOverlayShell("헤지비용 읽는 법 — 선택이 결과를 얼마나 바꾸나");
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, `헤지비용은 하나의 숫자가 아닙니다 — 네 가지 읽기를 모두 보여드립니다 (${COST_SIGN_KEY})`),
      el("div", { class: "a" }, "선택은 사용자 몫 ", el("small", {}, "기본값은 실측 헤지 포인트(HP)를 귀 기관의 가중평균 스왑 만기로 보간한 값 — 실무 데스크 기준(사용자 확정). 이력(공분산의 스왑레이트 요인)은 HP가 2024-10 시작이라 짧아 SMB 3M(2001~)을 씁니다"))));
    const c = el("div", { class: "card" });
    c.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "네 가지 읽기 (전부 [관측]) — 그리고 각 선택에서의 ② 참고치")));
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...["읽기", "값", "출처", ...ALLOC_ECON.map(allocShortK), "위험%"].map((h) => el("th", {}, h))));
    A.cost_options.forEach((o) => {
      const stx = { ...st, cost_key: o.key, view: "econ" };
      const Ex = allocEngine(A, stx);
      const tgt = amDot(Ex.V.mu, Ex.w0);
      const w = Ex.optimize(Ex.V.mu, Ex.V.C, tgt);
      const shown = o.curve ? allocHpAt(o.curve, st.tenor_m) : o.v;
      t.append(el("tr", { style: o.key === st.cost_key ? "font-weight:700" : "" },
        el("td", {}, `${o.label}${o.curve ? ` [3M ${o.curve["3M"]} · 6M ${o.curve["6M"]} · 12M ${o.curve["12M"]} → ${st.tenor_m}개월 보간]` : ""}${o.key === st.cost_key ? " (선택됨)" : ""}`),
        el("td", { class: "num" }, `${shown > 0 ? "+" : ""}${shown}%`),
        el("td", { style: "text-align:left;font-size:11px;color:var(--ink-3)" }, o.src),
        ...w.map((x) => el("td", { class: "num" }, fmtNum(x * 100, 1))),
        el("td", { class: "num" }, fmtNum(Ex.sigmaW(w, Ex.V.C), 2))));
    });
    c.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
      el("div", { class: "card-sub", style: "margin-top:6px" },
        "주의 — 여기의 '금리차(CIP) 함의'는 비용 수준의 대안 읽기입니다. 환헤지 화면에서 폐기된 것은 금리차의 '변화'를 스왑 MTM 프록시로 쓰는 방식(실측과 상관 0.07)이며, 서로 다른 주장입니다. 수준 프록시는 달러 실측과 상관 0.89로 검증되어 있습니다."));
    inner.append(c);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 표본 재추출 --- */
  if (topic === "boot") {
    const inner = allocOverlayShell("표본을 다시 뽑으면 — 블록 부트스트랩");
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "이 참고치는 표본 우연에 얼마나 흔들리는가"),
      el("div", { class: "a" }, `${A.boot.rows[0] ? A.boot.rows[0].n_reps : 2000}회 재추출 · 복제마다 공분산→σ→앵커→μ→최적화 전부 재추정 `,
        el("small", {}, "블록 재추출(Künsch 1989)로 자기상관을 보존합니다"))));
    const c = el("div", { class: "card" });
    c.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "분위수 — 블록 길이 12 / 24개월 (판정이 뒤집히는지 직접 비교)"),
      el("span", { class: "card-sub" }, "두 길이를 항상 나란히 게시합니다 — 하나를 고르지 않습니다")));
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...["블록", "지표", "5%", "25%", "중앙값", "75%", "95%"].map((h) => el("th", {}, h))));
    A.boot.rows.forEach((r) => {
      [["anchor", "앵커"], ["d1", "레버1 위험 감소 %p"], ["d2", "레버2 위험 감소 %p"],
       ["xe_star", "위험최소 Xe % (총 미헤지 환노출)"]].forEach(([k, lbl], i) => {
        const q = r[k];
        const tr = el("tr", { style: i === 0 ? "border-top:2px solid var(--border)" : "" });
        if (i === 0) tr.append(el("td", { rowspan: "4" }, `${r.block_len}개월`));
        tr.append(el("td", { style: "text-align:left" }, lbl),
          ...["q05", "q25", "q50", "q75", "q95"].map((qq) => el("td", { class: "num" }, fmtNum(q[qq], k === "anchor" ? 3 : 2))));
        t.append(tr);
      });
    });
    c.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
      el("div", { class: "card-sub", style: "margin-top:6px" }, A.boot.note,
        " 기본 화면의 ±표본오차는 σ̂/√(2n) 정규 근사이며, 여기 분포와 자릿수가 맞는지 비교하십시오."));
    inner.append(c);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 오일러 분해 --- */
  if (topic === "euler") {
    const inner = allocOverlayShell("위험기여 — 오일러 분해 검산");
    const { s, rc } = E.eulerRC(E.w0, E.V.C);
    const sum = rc.reduce((a, b) => a + b, 0);
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "자산군별 위험기여의 합이 총위험과 정확히 같은가 (오일러 정리)"),
      el("div", { class: "a" }, `합계 ${fmtNum(sum, 4)}% = 총위험 ${fmtNum(s, 4)}% `,
        el("small", {}, `오차 ${Math.abs(sum - s).toExponential(1)} — 산식: RC_i = w_i(Σw)_i/σ`))));
    const c = el("div", { class: "card" });
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...["자산군", "비중%", "위험기여 %p", "비중당 기여"].map((h) => el("th", {}, h))));
    E.V.keys.forEach((k, i) => t.append(el("tr", {},
      el("td", {}, k), el("td", { class: "num" }, fmtNum(E.w0[i] * 100, 1)),
      el("td", { class: "num" }, fmtNum(rc[i], 3)),
      el("td", { class: "num" }, E.w0[i] > 0 ? fmtNum(rc[i] / E.w0[i], 2) : "–"))));
    c.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t));
    inner.append(c);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 밴드·그룹 한도 --- */
  if (topic === "bands") {
    const inner = allocOverlayShell("밴드·그룹 한도 — 어떤 제약이 결과를 묶고 있나");
    const Ee = E;
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "참고치가 밴드 경계에 붙어 있으면, 그 숫자는 모형이 아니라 제약이 정한 것입니다"),
      el("div", { class: "a" }, "⚠ 표시 = 경계에 붙음")));
    const infeas = allocFeasibility(Ee);
    if (infeas.length) {
      inner.append(el("div", { class: "howto" },
        el("b", { class: "d-up" }, "⚠ 제약이 서로 모순됩니다 — 참고치 계산 보류"), el("br"),
        ...infeas.map((p) => el("div", {}, "· " + p))));
      $("#detail-overlay").scrollTop = 0;
      return;
    }
    const tgt = st.target_ret != null ? st.target_ret : amDot(Ee.V.mu, Ee.w0);
    const w = Ee.optimize(Ee.V.mu, Ee.V.C, tgt);
    const c = el("div", { class: "card" });
    const bands = st.bands;
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...["자산군", "하한", "② 참고치", "상한", "상태"].map((h) => el("th", {}, h))));
    Ee.V.keys.forEach((k, i) => {
      const b = bands[k] || [0, 100];
      const v = w[i] * 100;
      const bind = v <= b[0] + 0.05 ? "하한 ⚠" : v >= b[1] - 0.05 ? "상한 ⚠" : "내부";
      t.append(el("tr", {}, el("td", {}, k), el("td", { class: "num" }, b[0]),
        el("td", { class: "num" }, el("b", {}, fmtNum(v, 1))), el("td", { class: "num" }, b[1]),
        el("td", {}, bind)));
    });
    c.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t));
    const gline = Ee.groups.length
      ? Ee.groups.map((g) => `${g.label} ≤ ${fmtNum(g.cap * 100, 0)}% (현재 참고치 합 ${fmtNum(g.idx.reduce((a2, i) => a2 + w[i], 0) * 100, 1)}%)`).join(" · ")
      : "그룹 한도 미설정 (수기 입력에서 해외 합계·주식 합계 상한을 둘 수 있습니다)";
    c.append(el("div", { class: "card-sub", style: "margin-top:6px" }, gline));
    inner.append(c);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 자산군 상세 (#alloc-a-<i>) --- */
  if (topic.startsWith("a-")) {
    const i = +topic.slice(2);
    const k = E.V.keys[i];
    if (k == null) { hideDetail(); return; }
    const inner = allocOverlayShell(`자산군 상세 — ${k}`);
    const sig_i = Math.sqrt(Math.max(E.V.C[i][i], 0));
    const desc = A.sources.desc || {};
    const srcLabels = E.layer === "cma" ? E.cmaAll.cols : A.sources.labels;
    const lines = [];
    const row = E.V.rows[i];
    const parts = [];
    srcLabels.forEach((l, j) => {
      if (Math.abs(row[j]) > 1e-12) parts.push(`${row[j] >= 0 ? "+" : "−"} ${fmtNum(Math.abs(row[j]), 3)} × ${l}`);
    });
    lines.push(`재조립: ${k} = ${parts.length ? parts.join(" ") : "상수 (위험 0)"}`);
    if (E.layer === "cma" && allocIsAlt(k) && E.altInfo && E.altInfo.mode === "factor") {
      lines.push(`+ 잔차(고유위험) σ ${fmtNum(E.altInfo.idio, 2)}% — 디스무딩 보조축(_alt)을 팩터 스팬에 회귀한 잔차. 분류별 독립 성분으로 더합니다. 팩터만 넣으면 공분산이 특이행렬이 됩니다`);
    }
    lines.push(`기대수익 ${fmtNum(E.V.mu[i], 2)}% — ${E.layer === "cma" ? allocCmaSrcTag(k, E) : allocSrcTag(k)}`);
    lines.push(`위험(연) ${fmtNum(sig_i, 2)}% · 표본 ${E.sample.start}~${E.sample.end} (${E.sample.n_months}개월, ${E.layer === "cma" ? "벤치마크 월말" : "프록시"})`);
    const inner2 = el("div", { class: "card" });
    inner2.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "산식 전개 (원천 → 자산군)")));
    lines.forEach((s) => inner2.append(el("div", { style: "font-size:12.5px;padding:2px 0" }, s)));
    inner2.append(el("div", { class: "card-sub", style: "margin-top:6px" },
      E.layer === "cma"
        ? "원천 = 기관 전략 벤치마크 열(_alt = 디스무딩 보조축, _fx = 달러원). 프록시 재조립이 아니라 벤치마크 자체 통계입니다."
        : "원천 정의: " + A.sources.labels.map((l) => `${l} = ${desc[l] || ""}`).join(" · ")));
    inner.append(inner2);
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  hideDetail();
}

/* ══════════════════ 수익률 추정 (§7.8) ═══════════════════════════════════
   자산군별 규모·기준일 수익률·듀레이션을 넣으면 포트폴리오의 **연초이후 수익률을
   기준일 기준으로** 계산한다. 2026-08-13 사용자 지시.

   규약 세 가지 — 전부 사용자가 정한 것이라 코드가 임의로 바꾸지 말 것:
   ① **연환산은 일수 기준**: 계수 = 365 ÷ 경과일수(전년 12/31 → 기준일).
      6/30 이면 181일 → 2.0166. (월수 기준이면 정확히 2.0 이지만 사용자가 일수를 골랐다.)
   ② **주식만 연환산하지 않는다**(국내주식·해외주식). 채권·대체는 수익이 안정적으로
      확보된다는 가정 아래 연환산한다.
   ③ **듀레이션은 지금 계산에 쓰이지 않는다** — 향후 「사용자가 예상하는 금리·주가
      변화로 추정일 성과를 보는」 기능의 입력이다(2026-08-13 사용자 설명). 지금은
      입력·저장·가중평균 표시까지만 하고, **화면이 그 사실을 밝힌다**(안 쓰는 칸을
      말없이 두면 계산에 반영된 줄 안다).

   입력은 전부 **모형 입력**이라 즉시 저장한다(자산배분의 μ·σ 키인과 같은 취급).
   기관 실제 수치이므로 저장 위치는 브라우저 localStorage 뿐이다 — 공개 저장소에
   기본값으로 박지 말 것. */

const EST_LS_KEY = "iaw-estimate";

/* 자산군 11개 — 2026-08-13 사용자 지정. **이름·순서를 바꾸지 말 것**: `idx` 는
   `pipeline/estimate.py` 의 `INDICES[].asset` 과 문자 단위로 대조되고(회귀 테스트가
   두 파일을 본다), 저장된 사용자 입력의 키도 이 문자열이다. */
const EST_ASSETS = [
  { key: "장부가 국내채권", bond: true },
  { key: "장부가 해외채권", bond: true },
  { key: "단기자금" },
  { key: "대출금" },
  { key: "국내주식", equity: true, idx: "kospi_tr" },
  { key: "해외주식", equity: true, idx: "acwi" },
  { key: "시가 국내채권 직접", bond: true },
  { key: "시가 국내채권 간접", bond: true },
  { key: "시가 해외채권 직접", bond: true },
  { key: "시가 해외채권 간접", bond: true },
  { key: "대체투자" },
];

const EST_DAY_MS = 86400000;

/* 자산군 → 시나리오 축 매핑(§7.10). **어느 축이 어느 자산을 움직이는가**의 정본이다.
     rate : 이 자산의 Δy 를 주는 축(시가 채권만 — 장부가는 원가법이라 가격효과 0)
     px   : 지수 변화가 곧 수익률인 축(주식)
     fx   : 해외자산인가 — 환효과 (1−h)·Δ환율 과 스왑 MTM h·τ·(−Δ스왑)이 붙는다
   **장부가 해외채권이 `rate:null` + `fx:true` 인 것이 이 표의 핵심이다**(2026-08-13
   사용자 설명): 채권 자체는 원가법이라 금리에 안 움직이지만, 환헤지 스왑은 파생상품이라
   스왑레이트가 변하면 평가손익이 난다("−2% 로 체결했는데 −3% 로 떨어지면 계약 가치가
   올라 수익률이 소폭 상승"). `hedge.py` 회계모형 ②③⑤ 가 그대로 이 두 항이다. */
/* `mode` 는 §7.12 에서 붙었다(2026-08-13 사용자 지시로 자산군을 하나하나 지정했다):
     calc  — 화면이 시장 축으로 **계산한다**. 수기 덮어쓰기 없음(산식이 정본)
     carry — 기준일 수익률을 **그대로 승계**하고 필요하면 사용자가 수기로 덮는다
   가르는 선은 「가격 축이 있는가」이고 그 판정은 사용자가 내렸다 — 임의로 옮기지 말 것.
   파이프라인 `estimate.ROW_MODES` 가 같은 표를 사유와 함께 싣고 화면이 그것을 적는다
   (`tests/test_estimate.py` 가 두 파일을 대조한다). */
const EST_SCEN = {
  "장부가 국내채권":    { mode: "carry", fx: false },
  "장부가 해외채권":    { mode: "calc",  fx: true },
  "단기자금":           { mode: "carry", fx: false },
  "대출금":             { mode: "carry", fx: false },
  "국내주식":           { mode: "calc",  px: "kospi", fx: false },
  "해외주식":           { mode: "calc",  px: "acwi", fx: true },
  "시가 국내채권 직접": { mode: "calc",  rate: "kr_rate", fx: false },
  "시가 국내채권 간접": { mode: "calc",  rate: "kr_rate", fx: false },
  "시가 해외채권 직접": { mode: "calc",  rate: "us_rate", fx: true },
  "시가 해외채권 간접": { mode: "calc",  rate: "us_rate", fx: true },
  "대체투자":           { mode: "carry", fx: false },
};

/* 헤지비율 입력 범위(§7.12). **기본값을 두지 않는다** — 기관의 현재 헤지 정책은 운용
   정보라 공개 저장소에 박지 않는다(2026-08-13 사용자 확인). 파이프라인이 같은 값을
   `scenario.hedge_band` 로 싣고 화면은 그것을 우선 쓴다. */
const EST_HEDGE_BAND = { lo: 0, hi: 105, step: 1 };

function estDefaults() {
  return { asof: null, amt: {}, ret: {}, dur: {}, saved: false,
           /* 시나리오(§7.10 → §7.12): 추정일 · 축별 **수준** 수기값(`lvl`) ·
              추정일 규모(`amt2`, 비면 기준일 승계) · carry 자산군의 추정일 수익률
              수기값(`ret2`) · 슬리브 헤지비율 · 스왑 잔존만기.
              `dlt`(구 변화량 저장분)는 `estMigrateLevels` 가 수준으로 옮긴다. */
           est_date: null, lvl: {}, amt2: {}, ret2: {}, dlt: {},
           hedge: {}, swap_tau: null };
}

function estState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(EST_LS_KEY)) || {}; } catch { saved = {}; }
  const st = { ...estDefaults(), ...saved };
  /* 옛 저장분·손상 저장분 방어 — 없으면 저장 핸들러가 undefined 에 인덱싱하며 죽는다.
     `dlt`/`hedge` 는 §7.10 에서 새로 생긴 칸이라 그 이전 저장분에는 아예 없다. */
  ["amt", "ret", "dur", "dlt", "lvl", "amt2", "ret2", "hedge"].forEach((k) => {
    if (!st[k] || typeof st[k] !== "object") st[k] = {};
  });
  /* 구 저장분 판정은 **`saved` 쪽으로** 한다 — `st` 는 위에서 빈 객체를 채워 넣으므로
     `st.dlt` 로 가드하면 영영 참이 되어 마이그레이션이 매번 돈다(§7.7.11 의 fold 가드에서
     같은 실수를 했다). 실제 변환은 기준일 수준이 필요해 렌더에서 한다. */
  st._hadDlt = !!(saved && saved.dlt && Object.keys(saved.dlt).length
                  && !(saved.lvl && Object.keys(saved.lvl).length));
  return st;
}

/* 구 저장분(축별 **변화량** `dlt`)을 새 형식(추정일 **수준** `lvl`)으로 한 번 옮긴다.
   §7.12 에서 사용자가 "추정일 수준을 친다"로 규약을 바꿨기 때문이다. 기준일 수준이
   있어야 변환되므로 데이터가 로드된 뒤(렌더 시점)에 돈다.
     rate  : 수준 = 기준일수준 + Δbp/100        (게시 금리가 % 단위)
     price : 수준 = 기준일수준 × (1 + Δ%/100)
   변환하지 못한 축은 **버리지 않고 그대로 둔다** — 조용히 0 으로 만들면 사용자가 넣은
   시나리오가 소리 없이 사라진다. */
function estMigrateLevels(A, st) {
  if (!st._hadDlt || !st.asof) return false;
  let moved = 0;
  ((A && A.axes) || []).forEach((ax) => {
    const d = st.dlt[ax.key];
    if (d == null || d === "" || !isFinite(+d)) return;
    const s = estAxisSeries(A, ax);
    const at = estAxisAt(s, st.asof);
    if (!at) return;
    const v = ax.kind === "rate" ? at.v + (+d) / 100 : at.v * (1 + (+d) / 100);
    if (isFinite(v)) { st.lvl[ax.key] = +v.toFixed(6); moved += 1; }
  });
  st._hadDlt = false;
  return moved > 0;
}

/* 축 하나의 기준일→추정일 변화. **kind 가 뜻을 정한다** — 금리는 차이(%p), 지수·환율은
   변화율. 이 구분을 화면이 스스로 정하게 두면 금리를 비율로 나누는 사고가 조용히 난다.
   돌려주는 `delta` 는 **소수**(bp 도 %도 아닌 decimal)이며 표시 단위 변환은 화면이 한다.
   실제로 쓴 두 관측일을 함께 돌려준다 — 자동 채움 규약과 같다(조용한 대체 금지). */
function estAxisSeries(A, axis) {
  if (!axis) return null;
  if (axis.index) {
    const ix = ((A && A.indices) || []).find((x) => x.key === axis.index);
    return ix ? { t: ix.t, v: ix.v, last: ix.last, label: ix.label } : null;
  }
  return axis.t ? { t: axis.t, v: axis.v, last: axis.last, label: axis.label } : null;
}

/* 시리즈에서 **그 날짜 이하 마지막 관측**을 집는다(이분 탐색). 실제로 집힌 날짜를 함께
   돌려주는 것이 규약이다 — 화면이 「언제 값을 썼는지」를 밝혀야 하기 때문(조용한 대체 금지). */
function estAxisAt(s, dstr) {
  if (!s || !dstr || !s.t || !s.t.length) return null;
  const target = Math.floor(Date.parse(dstr + "T23:59:59Z") / 1000);
  if (!isFinite(target)) return null;
  let lo = 0, hi = s.t.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid] <= target) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return k < 0 ? null : { v: s.v[k], d: tsToDate(s.t[k]) };
}

/* 축 하나의 **기준일 수준 · 추정일 수준 · 변화**(§7.12 — 사용자가 변화량 대신 추정일
   수준을 친다). 돌려주는 `delta` 는 소수이고 단위 변환은 `kind` 가 정한다:
     rate  → (수준To − 수준From) / 100   (게시값이 % 단위 금리라 소수로 내린다)
     price → 수준To / 수준From − 1
   이 구분을 화면이 스스로 정하게 두면 금리를 비율로 나누는 사고가 조용히 난다. */
function estAxisLevels(A, axis, fromStr, toStr, keyedLevel) {
  const s = estAxisSeries(A, axis);
  const from = estAxisAt(s, fromStr);
  const toAuto = estAxisAt(s, toStr);
  const isKeyed = keyedLevel != null && keyedLevel !== "" && isFinite(+keyedLevel);
  const to = isKeyed ? { v: +keyedLevel, d: null } : toAuto;
  const beyondData = !!(s && s.last && toStr && toStr > s.last);
  if (!from) return { from: null, to, toAuto, isKeyed, delta: null, beyondData,
                      error: "기준일 관측이 없습니다" };
  if (!to) return { from, to: null, toAuto, isKeyed, delta: null, beyondData,
                    error: "추정일 수준을 넣으십시오" };
  /* **자동인데 두 날짜가 같은 관측을 가리키면 변화는 0 이 아니라 「모른다」다.**
     수기로 수준을 넣은 경우는 해당 없다 — 사용자가 값을 정했기 때문이다. */
  if (!isKeyed && toAuto && from.d === toAuto.d) {
    return { from, to, toAuto, isKeyed, delta: null, beyondData,
             error: "기준일과 추정일이 같은 관측을 가리킵니다" };
  }
  let delta;
  if (axis.kind === "rate") delta = (to.v - from.v) / 100;
  else if (from.v === 0) return { from, to, toAuto, isKeyed, delta: null, beyondData,
                                  error: "기준일 값이 0 입니다" };
  else delta = to.v / from.v - 1;
  return { from, to, toAuto, isKeyed, delta, beyondData, error: "" };
}

/* 추정 산식 — `estimate.json.scenario` 가 적은 그대로.
     추정 기간수익률 = 캐리 + 가격효과 + 환효과 + 스왑 MTM
   부호 둘이 심장이다: 가격효과 = **−**D·Δy, 스왑 MTM = h·τ·(**−**Δ스왑).
   기준(base)은 `estEngine` 결과다 — 캐리를 기준일 수익률에서 환산하기 때문(사용자 선택). */
function estScenario(A, st) {
  /* base 를 **여기서 만든다** — 예전에는 인자로 받았는데, 호출부가 다른 `st` 로 만든 base 를
     넘기면 듀레이션·수익률이 어긋난 채 조용히 계산된다(프로브가 잡은 함정). 인자를 없애면
     그 상태가 아예 만들어지지 않는다. */
  const base = estEngine(A, st);
  const from = st.asof, to = st.est_date;
  if (!from || !to) return { ready: false, reason: "기준일과 추정일을 모두 넣으십시오" };
  const dcFrom = estDayCount(from), dcTo = estDayCount(to);
  if (!dcFrom || !dcTo) return { ready: false, reason: "날짜 형식이 올바르지 않습니다" };
  const days = Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / EST_DAY_MS);
  if (days <= 0) return { ready: false, reason: "추정일은 기준일보다 뒤여야 합니다" };

  /* 축별 **수준** — 사용자가 치는 것은 추정일 수준이다(§7.12). 기준일 수준은 항상
     데이터에서 오고, 추정일 수준은 수기값이 정본, 없으면 조회. 변화는 화면이 아니라
     여기서 계산한다(단위 규약이 `kind` 에 있기 때문). */
  const axes = ((A && A.axes) || []).map((ax) => {
    const lv = estAxisLevels(A, ax, from, to, st.lvl[ax.key]);
    return { ...ax, ...lv,
             source: lv.isKeyed ? "수기" : (lv.delta != null ? "자동" : "미입력") };
  });
  const byKey = {};
  axes.forEach((a) => { byKey[a.key] = a; });
  const d = (k) => (byKey[k] && byKey[k].delta != null ? byKey[k].delta : null);
  const dFx = d("usdkrw"), dSwap = d("swap");
  const tau = isFinite(+st.swap_tau) && st.swap_tau !== "" && st.swap_tau != null
    ? +st.swap_tau : null;

  const yearDays = dcTo.days;                  // 연초 → 추정일 (연환산 계수용)
  /* **추정일이 다른 해면 연초이후 누적을 잇지 못한다.** 그 해의 연초(1/1)부터 기준일까지의
     수익을 우리는 모르기 때문이다 — 기준일 값은 *기준일 연도*의 연초이후 수익률이다.
     예전 코드는 이 경우에도 `기준일값 + 구간` 을 만들고 추정일 연도의 짧은 경과일수로
     연환산했다(기준일 2026-07-21 → 추정일 2027-03-31 이면 ×365/90 = 4.06배). 지어낸 수라
     내지 않고 사유를 적는다 — 추정 구간(기준일 → 추정일)은 그대로 낸다. */
  const crossYear = dcFrom.year !== dcTo.year;
  const rows = base.rows.map((b) => {
    const spec = EST_SCEN[b.key] || {};
    const mode = spec.mode || "carry";
    /* **추정일 규모 — 비면 기준일 규모를 승계한다**(§7.12 사용자 지시). 승계인지
       수기인지를 함께 실어야 화면이 밝힐 수 있다: 조용히 같은 수를 보여 주면
       사용자는 리밸런싱이 반영된 줄 알고 넘어간다. */
    const a2 = st.amt2[b.key];
    const amt2Keyed = a2 != null && a2 !== "" && isFinite(+a2);
    const amt2 = amt2Keyed ? +a2 : b.amt;

    /* ---- carry 자산군: 기준일 수익률 승계(+ 수기 덮어쓰기) ----
       가격 축이 없는 자산군이다(장부가 국내채권·단기자금·대출금·대체투자).
       **4항 분해를 만들지 않는다** — 계산하지 않은 행에 분해를 붙이면 계산한 척이 된다.
       다만 포트폴리오 「추정 구간」에는 들어가야 하므로 구간수익만 낸다. */
    if (mode === "carry") {
      const k = st.ret2[b.key];
      const ret2Keyed = k != null && k !== "" && isFinite(+k);
      /* **다른 해면 승계 행도 비운다.** 「기준일과 같다」고 적고 싶어지지만, 그때
         비교 대상은 *다른 연초*부터 잰 수익률이라 같다고 말할 근거가 없다. 무엇보다
         계산(calc) 행은 다른 해에서 비는데 승계 행만 수를 내면 **한 열 안에 두 규칙이
         공존**하고 포트폴리오 합계는 비어 있는 모순이 생긴다. */
      const r2 = crossYear ? null : (ret2Keyed ? +k / 100 : b.r);
      /* 승계면 구간수익 = 연환산율 × 구간일수/365(캐리 그 자체) — 이건 연초 기준과
         무관하므로 다른 해에도 낸다. 수기로 덮었으면 두 연환산율을 각자 기간수익으로
         되돌려 그 차로 내는데, 되돌리기가 연초 기준을 쓰므로 다른 해면 비운다. */
      let total = null;
      if (!ret2Keyed) total = b.r == null ? null : b.r * (days / 365);
      else if (!crossYear && b.r != null) {
        total = r2 * (yearDays / 365) - b.r * (dcFrom.days / 365);
      }
      return { ...b, mode, amt2, amt2Keyed, ret2Keyed,
               carry: null, price: null, fx: null, swap: null,
               priceNote: "", fxNote: "", h: null, total,
               basePeriod: b.r == null ? null : b.r * (dcFrom.days / 365),
               cumAnnual: r2,
               diff: (r2 == null || b.r == null) ? null : r2 - b.r,
               modeNote: ret2Keyed ? "수기" : "기준일 승계" };
    }

    /* ---- calc 자산군: 시장 축으로 계산 ---- */
    /* 캐리 — 기준일 **연환산** 수익률(= 입력값 그대로)을 구간 길이로 비례 배분.
       주식은 기준일 수익률이 연환산이 아니라 가격 그 자체이므로 캐리가 없다. */
    const carry = (b.equity || b.r == null) ? 0 : b.r * (days / 365);
    let price = null, priceNote = "";
    if (spec.px) {
      price = d(spec.px);
      if (price == null) priceNote = "지수 변화 미입력";
    } else if (spec.rate) {
      const dy = d(spec.rate);
      if (dy == null) priceNote = "금리 변화 미입력";
      else if (b.dur == null) { priceNote = "듀레이션 미입력"; }
      else price = -b.dur * dy;                 // ★ 부호: 금리 상승 → 가격 하락
    } else {
      price = 0;
      priceNote = b.bond ? "장부가 — 원가법이라 가격효과 없음" : "가격 축 없음";
    }
    const hRaw = st.hedge[b.key];
    const h = hRaw != null && hRaw !== "" && isFinite(+hRaw) ? +hRaw / 100 : null;
    let fx = null, swap = null, fxNote = "";
    if (spec.fx) {
      /* **헤지비율에 기본값이 없다**(§7.12) — 고르기 전에는 0 으로 지어내지 않고 비운다. */
      if (h == null) { fxNote = "헤지비율 미입력"; }
      else {
        if (dFx != null) fx = (1 - h) * dFx;
        if (dSwap != null && tau != null) swap = h * tau * (-dSwap);   // ★ 회계모형 ⑤
        if (dFx == null) fxNote = "환율 변화 미입력";
        else if (dSwap == null) fxNote = "스왑레이트 변화 미입력";
        else if (tau == null) fxNote = "스왑 잔존만기 미입력";
      }
    } else { fx = 0; swap = 0; }
    const parts = [carry, price, fx, swap];
    const total = parts.some((x) => x == null) ? null : parts.reduce((a, x) => a + x, 0);
    /* 연초 → 추정일 누적. **기준일 값이 연환산이므로 먼저 기간수익으로 되돌린다** —
       되돌리기는 사용자 규칙(연환산 = 기간수익 × 365 ÷ 경과일수)의 정확한 역이지 새
       가정이 아니다. 되돌린 뒤 구간을 더하고 추정일 기준으로 다시 연환산한다.
       캐리가 `r × days/365` 이므로 대수적으로 정확히 아래가 성립한다:
         cumAnnual = r + (price + fx + swap) × 365 ÷ yearDays
       즉 **기준일 열과 추정일 열의 차이가 곧 시장효과의 연환산분**이고, 그래서 둘을
       나란히 놓는 것이 뜻을 가진다(2026-08-13 사용자 지시). */
    const basePeriod = b.r == null ? null
      : (b.equity ? b.r : b.r * (dcFrom.days / 365));
    const cumPeriod = (basePeriod == null || total == null || crossYear)
      ? null : basePeriod + total;
    const cumAnnual = cumPeriod == null ? null
      : (b.equity ? cumPeriod : cumPeriod * (365 / yearDays));
    /* 나란히 놓은 두 열의 차이 — 화면이 이 값을 그대로 적는다(빼기를 화면에서 다시 하면
       반올림 자리가 어긋난 두 수가 공존한다). */
    const diff = (cumAnnual == null || b.r == null) ? null : cumAnnual - b.r;
    return { ...b, mode, amt2, amt2Keyed, ret2Keyed: false,
             carry, price, priceNote, h, fx, swap, fxNote, total,
             basePeriod, cumPeriod, cumAnnual, diff, modeNote: "계산" };
  });

  /* 가중치가 **두 벌**이다 — 기준일 열은 기준일 규모로, 추정일 열은 추정일 규모로 잰다.
     리밸런싱을 넣으면 비중이 달라지므로 한 벌로 재면 그 효과가 통째로 사라진다. */
  const tot = rows.reduce((a, x) => a + (x.amt || 0), 0);
  const tot2 = rows.reduce((a, x) => a + (x.amt2 || 0), 0);
  const wsum = (amtOf, total, f) => (total > 0
    ? rows.reduce((a, x) => {
        const w = amtOf(x);
        return a + ((w != null && f(x) != null) ? w * f(x) : 0);
      }, 0) / total
    : null);
  /* 포트폴리오 기준일 수익률은 **base 에서 다시 계산하지 않고 같은 가중합으로 낸다** —
     `estEngine.port` 와 같은 수이지만, 여기서 따로 부르면 한쪽만 고쳤을 때 화면 안에
     서로 다른 두 「기준일 수익률」이 공존한다(§7.7.17 에서 겪은 실패). */
  const anyRet = rows.some((x) => x.amt && x.r != null);
  const anyEst = rows.some((x) => x.amt2 && x.cumAnnual != null);
  const portBase = anyRet ? wsum((x) => x.amt, tot, (x) => x.r) : null;
  const portCumAnnual = (crossYear || !anyEst) ? null
    : wsum((x) => x.amt2, tot2, (x) => x.cumAnnual);
  /* 차이는 **가중합을 따로 내지 않고 두 헤드라인을 그대로 뺀다.** 행별 diff 를 가중합하면
     추정 불가 행(blocked)이 기준일 쪽에는 들어가고 추정일 쪽에는 0 으로 들어가서
     「차이 ≠ 추정일 − 기준일」인 세 수가 한 화면에 놓인다. 그 왜곡의 원인(blocked)은
     화면이 따로 적는다 — 숫자끼리는 반드시 맞아야 한다. */
  const portDiff = (portCumAnnual == null || portBase == null) ? null : portCumAnnual - portBase;
  return {
    ready: true, days, yearDays, axes, tau, rows, crossYear,
    totalAmt: tot, totalAmt2: tot2,
    sizeChanged: rows.some((x) => x.amt2Keyed && x.amt2 !== x.amt),
    portBase, portCumAnnual, portDiff,
    portPeriod: wsum((x) => x.amt, tot, (x) => x.total),
    blocked: rows.filter((x) => x.amt2 && x.cumAnnual == null),
  };
}

function estSaveState(st) {
  try { localStorage.setItem(EST_LS_KEY, JSON.stringify({ ...st, saved: true })); } catch {}
}

/* 경과일수와 연환산 계수. 연초 = **전년 12/31** 이다(1/1 이 아니다 — 1/1 을 쓰면
   하루가 사라져 계수가 미세하게 커진다). 날짜는 UTC 로 파싱해 시간대에 따라
   하루가 밀리지 않게 한다. */
function estDayCount(asofStr) {
  if (!asofStr || !/^\d{4}-\d{2}-\d{2}$/.test(asofStr)) return null;
  const asof = Date.parse(asofStr + "T00:00:00Z");
  if (!isFinite(asof)) return null;
  /* 존재하지 않는 날짜(2026-02-30 등)는 Date 가 **조용히 다음 달로 넘긴다** —
     정규식만으로는 못 잡는다(실측: 2026-02-30 이 3/2 로 굴러가 경과 61일이 됐다).
     되돌려 찍어 같은 문자열이 나오는지 확인한다. `<input type=date>` 로는 만들 수
     없지만 저장분이 손상되면 들어온다. */
  if (new Date(asof).toISOString().slice(0, 10) !== asofStr) return null;
  const year = +asofStr.slice(0, 4);
  const base = Date.parse(`${year - 1}-12-31T00:00:00Z`);
  const days = Math.round((asof - base) / EST_DAY_MS);
  /* NaN 은 `<= 0` 을 통과한다 — 예: 연도 0000 이면 전년이 `-1-12-31` 이라 Date.parse 가
     NaN 을 주고, 그대로 두면 계수가 NaN 이 되어 비주식 자산이 전부 조용히 사라진다. */
  if (!isFinite(days) || days <= 0) return null;
  return { year, base: `${year - 1}-12-31`, days, factor: 365 / days };
}

/* 지수의 연초이후 수익률 — 자동 채움의 값이자 근거.
   분모는 파이프라인이 **축약 전 원본**에서 뽑아 실은 `year_end` 앵커다(축약된 계열에서
   뽑으면 그 해의 모든 YTD 가 함께 어긋난다). 분자는 기준일 **이하** 마지막 관측이며,
   실제로 쓴 두 날짜를 함께 돌려준다 — 화면이 밝혀야 하기 때문이다(조용한 대체 금지). */
function estIndexYtd(idx, asofStr) {
  const dc = estDayCount(asofStr);
  if (!idx || !dc) return null;
  const anchor = idx.year_end && idx.year_end[String(dc.year - 1)];
  if (!anchor || !isFinite(anchor.v) || anchor.v === 0) {
    return { error: `${dc.year - 1}년 연말 관측이 없습니다` };
  }
  const t = idx.t || [], v = idx.v || [];
  const target = Math.floor(Date.parse(asofStr + "T23:59:59Z") / 1000);
  let lo = 0, hi = t.length - 1, at = -1;
  while (lo <= hi) {                          // 기준일 이하 마지막 관측 (이분 탐색)
    const mid = (lo + hi) >> 1;
    if (t[mid] <= target) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (at < 0) return { error: "기준일 이전 관측이 없습니다" };
  const obsDate = tsToDate(t[at]);
  /* 두 경우를 갈라서 적는다(재점검 발견 — 예전에는 둘 다 "기준일이 전년 연말보다
     앞섭니다"였는데, 아래쪽 경우엔 그게 사실이 아니라 사용자를 엉뚱한 데로 보낸다).
       · obsDate < anchor.d : 정말로 기준일이 전년 연말보다 앞이다
       · obsDate == anchor.d: 기준일은 뒤인데 **그 해 관측이 하나도 없다**
         (지수가 전년 말에서 멈춤 — 기준일 연도로 넘어온 데이터가 없다) */
  /* **여기서 "기준일이 전년 연말보다 앞섭니다"라고 적으면 안 된다** — `estDayCount` 가
     이미 기준일 > 전년 12/31 을 보장하므로 그 문장은 참이 될 수 없다(재점검 발견).
     실제 원인은 하나뿐이다: 게시 계열이 5년보다 오래된 구간을 주별로 축약해서, 연말
     앵커(원본에서 뽑음)와 기준일 사이에 **축약된 관측이 하나도 없는** 것이다.
     실측: KOSPI TR 로 기준일 2019-01-02 를 물으면 앵커 2018-12-31 보다 앞선 금요일
     관측이 잡혀 이 가지로 빠졌다. */
  if (obsDate < anchor.d) {
    return { error: `${dc.year - 1}년 연말과 기준일 사이에 축약되지 않은 관측이 없습니다`
                    + ` (앵커 ${anchor.d} · 가장 가까운 관측 ${obsDate})` };
  }
  if (obsDate === anchor.d) {
    return { error: `${dc.year}년 관측이 없습니다 — 지수가 ${anchor.d} 에서 멈춰 있습니다` };
  }
  const gap = Math.round((Date.parse(asofStr + "T00:00:00Z") - t[at] * 1000) / EST_DAY_MS);
  return {
    ytd: v[at] / anchor.v - 1,
    base: anchor, obs: { v: v[at], d: obsDate }, gapDays: gap,
    /* **기준일이 이 지수의 마지막 관측보다 뒤인가.** 그렇다면 자동값은 기준일의 값이
       아니라 지수가 멈춘 날의 값이다 — 실측: 기본 기준일(2026-08-06)에서 ACWI 는
       2026-07-21 관측을 쓰고 있었고 화면 어디에도 그 사실이 없었다. 미래 기준일이면
       간극이 150일을 넘는다. 휴장일(며칠)과 **데이터가 거기까지 오지 않은 것**은
       전혀 다른 사건이라 임의 임계값 대신 이 조건으로 가른다. */
    beyondData: !!(idx.last && asofStr > idx.last),
  };
}

/* 계산 한 벌 — 요약·표·기여도가 **같은 산식**을 공유한다(따로 계산하면 화면 안에서
   서로 다른 수익률이 공존하게 된다. §7.7.17 에서 겪은 실패다). */
function estEngine(A, st) {
  const dc = estDayCount(st.asof);
  const byAsset = {};
  ((A && A.indices) || []).forEach((ix) => { byAsset[ix.asset] = ix; });

  const rows = EST_ASSETS.map((spec) => {
    const ix = spec.idx ? byAsset[spec.key] : null;
    const auto = ix ? estIndexYtd(ix, st.asof) : null;
    const keyed = st.ret[spec.key];
    const isKeyed = keyed != null && keyed !== "" && isFinite(+keyed);
    /* 수기값이 있으면 그것이 정본, 없으면 자동값. 자동도 없으면 미입력이다 —
       0 으로 대체하지 않는다(빈 칸과 0% 는 다른 뜻이다). */
    const r = isKeyed ? +keyed / 100
      : (auto && auto.ytd != null ? auto.ytd : null);
    const amt = isFinite(+st.amt[spec.key]) && st.amt[spec.key] !== "" && st.amt[spec.key] != null
      ? +st.amt[spec.key] : null;
    /* **입력값이 곧 반영값이다** — 2026-08-13 사용자 지시로 기준일 수익률은 이미
       연환산된 값을 넣는다(주식 제외 — 주식은 연환산하지 않는 연초이후 수익률).
       여기서 계수를 다시 곱하면 이중 연환산이다. 계수는 시나리오에서만 쓴다. */
    const profit = (amt != null && r != null) ? amt * r : null;
    return {
      ...spec, ix, auto, isKeyed, r, amt, profit,
      dur: isFinite(+st.dur[spec.key]) && st.dur[spec.key] !== "" && st.dur[spec.key] != null
        ? +st.dur[spec.key] : null,
      source: isKeyed ? "수기" : (auto && auto.ytd != null ? "자동" : (ix ? "자동 실패" : "수기")),
    };
  });

  const totalAmt = rows.reduce((a, x) => a + (x.amt || 0), 0);
  const totalProfit = rows.reduce((a, x) => a + (x.profit || 0), 0);
  rows.forEach((x) => {
    x.weight = totalAmt > 0 && x.amt != null ? x.amt / totalAmt : null;
    x.contrib = totalAmt > 0 && x.profit != null ? x.profit / totalAmt : null;
  });
  /* 채권 가중평균 듀레이션 — 지금 수익률 계산에는 안 쓰지만, 입력한 값이 무엇을
     이루는지 보여 주는 자리이자 향후 시나리오 기능의 기준값이다. */
  const bondRows = rows.filter((x) => x.bond && x.amt != null && x.dur != null);
  const bondAmt = bondRows.reduce((a, x) => a + x.amt, 0);
  const durW = bondAmt > 0
    ? bondRows.reduce((a, x) => a + x.amt * x.dur, 0) / bondAmt : null;

  /* 미입력 진단 — 규모는 넣었는데 수익률이 비었으면 그 자산은 수익 0 으로 잡힌다.
     조용히 넘기면 포트폴리오 수익률이 이유 없이 낮아 보인다. */
  const missingRet = rows.filter((x) => x.amt != null && x.amt !== 0 && x.r == null);
  /* **수익률이 하나도 없으면 0.00% 를 내지 않는다.** `totalProfit / totalAmt` 는 그 상태에서
     0 을 돌려주는데, 0% 는 「계산했더니 0」이라는 뜻이라 「아직 못 냈다」와 전혀 다르다.
     (구 `portBlockedByAsof` 가 막던 자리 — 입력이 곧 연환산이 되면서 비주식 행이 기준일
     없이도 계산되므로 조건이 「기준일 부재」가 아니라 「수익률 전무」로 바뀌었다.) */
  const withRet = rows.filter((x) => x.amt != null && x.amt !== 0 && x.r != null);
  return {
    dc, rows, totalAmt, totalProfit,
    port: (totalAmt > 0 && withRet.length) ? totalProfit / totalAmt : null,
    portBlockedNoRet: totalAmt > 0 && !withRet.length,
    durW, bondAmt, missingRet,
    unavailable: (A && A.unavailable) || [],
    active: !!(A && A.active),
  };
}

/* 추정 결과 — **자산군별 4항 분해는 통합 표(`#est-table-card`)로 이사했다**(2026-08-13
   사용자 지시로 기준일·추정일을 한 행에 나란히 놓았기 때문). 여기 남는 것은 포트폴리오
   수준의 구간 요약과 산식·한계다. 분해를 여기서 한 번 더 그리면 같은 수가 한 화면에
   두 번 나오고, 한쪽만 고쳤을 때 조용히 갈린다. */
function renderEstScenarioResult(A, S) {
  const box = $("#est-scenario-result");
  if (!box) return;
  const sc = A.scenario || {};
  box.textContent = "";
  box.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "추정 산식"),
    el("span", { class: "card-sub" }, sc.formula || "캐리 + 가격효과 + 환효과 + 스왑 MTM")));

  if (S.ready) {
    const pc = (x) => (x == null ? "–" : fmtNum(x * 100, 2));
    const big = (label, v, size, sub) => el("div", { style: "min-width:200px" },
      el("div", { style: "color:var(--ink-3);font-size:12px" }, label),
      el("div", { style: `font-size:${size}px;font-weight:700;line-height:1.25` },
        v == null ? "–" : pc(v) + "%"),
      sub ? el("div", { style: "color:var(--ink-3);font-size:11px" }, sub) : "");
    box.append(el("div", { style: "display:flex;gap:26px;flex-wrap:wrap;margin:6px 0 8px" },
      big("추정 구간만", S.portPeriod, 20, `기준일 → 추정일 ${S.days}일 · 연환산 안 함`),
      big("기준일 수익률 (연환산)", S.portBase, 15, "기준일 규모 가중"),
      big("추정일 수익률 (연환산)", S.portCumAnnual, 15,
          S.crossYear ? "다른 해라 미산출" : "추정일 규모 가중")));
    /* 계산한 자산군의 4항 분해 — 표에서 뺀 열이라 여기 한 번만 둔다(§7.12).
       표에는 「근거」 한 줄이 가고, 어느 항이 결과를 끌고 갔는지는 이 접이식에서 본다.
       두 곳에 그리지 않는 이유는 §7.11 과 같다 — 한쪽만 고치면 조용히 갈린다. */
    const calc = S.rows.filter((x) => x.mode === "calc" && x.amt2);
    if (calc.length) {
      const det = el("details", { class: "method", style: "margin-top:6px" });
      det.append(el("summary", {}, "자산군별 4항 분해 (계산한 자산군만)"));
      const t = el("table", { class: "mini-table est-table" },
        el("tr", {}, ...["자산군", "캐리", "가격효과", "환효과", "스왑 MTM", "추정 구간(%)"]
          .map((h, i) => el("th", { style: i === 0 ? "text-align:left" : "" }, h))));
      const cell = (v) => el("td",
        { class: "num" + (v == null ? "" : v >= 0 ? " d-up" : " d-down") },
        v == null ? "–" : pc(v));
      calc.forEach((x) => {
        t.append(el("tr", {}, el("td", {}, x.key),
          cell(x.carry), cell(x.price), cell(x.fx), cell(x.swap),
          el("td", { class: "num" + (x.total == null ? "" : x.total >= 0 ? " d-up" : " d-down") },
            x.total == null ? "–" : el("b", {}, pc(x.total)))));
      });
      det.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t));
      box.append(det);
    }
  } else {
    box.append(el("div", { class: "card-sub", style: "margin:6px 0" },
      S.reason || "기준일과 추정일을 모두 넣으십시오"));
  }

  (sc.terms || []).forEach((t) => {
    box.append(el("div", { style: "font-size:12px;color:var(--ink-3);margin-top:2px" }, "· " + t));
  });
  box.append(el("div", { style: "margin-top:8px;font-size:12px;color:var(--ink-3)" },
    sc.cumulative || "", el("br"), sc.book_value || "", el("br"),
    el("b", { class: "d-up" }, "한계 "), sc.limits || ""));
}

function renderEstimate() {
  const A = DATA.estimate || {};
  const st = estState();
  /* 기준일 기본값 — **모든 지수가 도달한 마지막 날**(`asof_all`). 가장 멀리 간 지수의
     날짜(`asof`)를 쓰면 다른 지수의 자동값이 처음부터 묵은 채로 뜬다(실측 16일).
     둘 다 없으면 비워 두고 사용자가 넣게 한다 — 오늘 날짜를 지어 넣으면 지수가 아직
     없는 날을 기준일로 잡아 자동 채움이 조용히 어긋난다. */
  if (!st.asof) st.asof = A.asof_all || A.asof || null;
  /* 구 저장분(축별 변화량) → 새 형식(추정일 수준) 1회 이관. 데이터가 있어야 변환되므로
     여기서 돈다. 옮긴 뒤에는 저장해 둔다 — 안 그러면 매 렌더마다 다시 변환한다. */
  if (estMigrateLevels(A, st)) estSaveState(st);

  const band = (A.scenario && A.scenario.hedge_band) || EST_HEDGE_BAND;
  const modeWhy = {};
  ((A.scenario && A.scenario.row_modes) || []).forEach((m) => { modeWhy[m.asset] = m.why; });

  const cells = {};        // 자산군 → 계산 결과를 쓰는 노드들(입력을 다시 만들지 않는다)
  const retInputs = {};
  const ret2Inputs = {};
  const amt2Inputs = {};
  const hedgeCells = {};
  /* 재계산은 **한 벌**이다 — 기준일 블록과 추정일 블록이 한 표에 있으므로 둘을 따로
     돌리면 같은 행의 왼쪽과 오른쪽이 다른 상태로 그려진다. 입력 핸들러는 전부 이 이름을
     부르고, 실제 함수는 아래에서 채운다(시나리오 노드가 먼저 있어야 한다). */
  let recalcAll = () => {};

  /* ---- 조작: 기준일 · 추정일 ---- */
  const ctl = $("#est-controls");
  ctl.textContent = "";
  const asofInput = el("input", {
    type: "date", value: st.asof || "", "aria-label": "기준일", style: "width:150px",
  });
  const estInput = el("input", {
    type: "date", value: st.est_date || "", "aria-label": "추정일", style: "width:150px",
  });
  const dcLine = el("span", { style: "color:var(--ink-3);font-size:12px;margin-left:10px" });
  ctl.append(
    el("div", { style: "display:flex;gap:22px;flex-wrap:wrap;align-items:center" },
      el("span", {}, el("b", {}, "기준일"), " ", asofInput),
      el("span", {}, el("b", {}, "추정일"), " ", estInput),
      dcLine),
    el("div", { style: "margin-top:6px;color:var(--ink-3);font-size:12px" },
      el("b", {}, "기준일 수익률은 이미 연환산된 값을 넣으십시오"),
      " (주식 제외)",
      explainBox("est-input-conv",
        "화면이 다시 연환산하지 않습니다(이중 연환산 방지). ",
        el("b", {}, "주식(국내·해외)은 연환산하지 않는 연초이후 수익률"), "입니다. ",
        (A.scenario && A.scenario.size_carry) || "")));

  /* ---- 표 — 기준일 블록 ‖ 추정일 블록 (§7.12 사용자 지시) ----
     왼쪽에서 자산군·규모·수익률을 넣고, 오른쪽에서 같은 모양으로 추정일을 본다.
     추정일 쪽에서 **사용자가 치는 것은 규모뿐**이고(비면 기준일 승계), 수익률은
     자산군마다 계산(calc)이거나 승계(carry, 수기 덮어쓰기 가능)다. */
  const card = $("#est-table-card");
  card.textContent = "";
  card.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "자산군별 기준일 ‖ 추정일"),
    el("span", { class: "card-sub" },
      "추정일 규모를 비우면 기준일을 승계합니다 · 해외자산은 자산군을 눌러 헤지비율을 고르십시오")));

  const BASE_HEADS = ["규모", "비중", "듀레이션", "수익률(%)"];
  const EST_HEADS = ["규모", "비중", "수익률(%)", "차이(%p)"];
  const tbl = el("table", { class: "mini-table est-table" },
    el("tr", {},
      el("th", { rowspan: "2", style: "text-align:left" }, "자산군"),
      el("th", { colspan: String(BASE_HEADS.length), class: "est-sep" }, "기준일"),
      el("th", { colspan: String(EST_HEADS.length), class: "est-sep" }, "추정일"),
      el("th", { rowspan: "2", style: "text-align:left" }, "근거")),
    el("tr", {},
      ...BASE_HEADS.map((h, i) => el("th", { class: i === 0 ? "est-sep" : "" }, h)),
      ...EST_HEADS.map((h, i) => el("th", { class: i === 0 ? "est-sep" : "" }, h))));

  const numInput = (bag, key, step, width) => el("input", {
    type: "number", step: String(step), inputmode: "decimal",
    value: bag[key] == null ? "" : String(bag[key]),
    style: `width:${width}px;text-align:right`,
  });

  EST_ASSETS.forEach((spec) => {
    const scen = EST_SCEN[spec.key] || {};
    const tr = el("tr", {});
    const amtIn = numInput(st.amt, spec.key, "any", 96);
    amtIn.setAttribute("aria-label", `${spec.key} 규모`);
    amtIn.setAttribute("min", "0");        // 음수 규모는 뜻이 없다(요약이 한 번 더 잡는다)
    const retIn = numInput(st.ret, spec.key, "0.01", 78);
    retIn.setAttribute("aria-label", `${spec.key} 기준일 수익률`);
    retInputs[spec.key] = retIn;
    const durIn = spec.bond ? numInput(st.dur, spec.key, "0.1", 60) : null;
    if (durIn) durIn.setAttribute("aria-label", `${spec.key} 듀레이션`);
    const amt2In = numInput(st.amt2, spec.key, "any", 96);
    amt2In.setAttribute("aria-label", `${spec.key} 추정일 규모`);
    amt2In.setAttribute("min", "0");
    amt2Inputs[spec.key] = amt2In;
    /* **calc 자산군의 추정일 수익률은 입력칸이 아니다** — 산식이 정본이므로 덮어쓸
       자리를 만들지 않는다. carry 자산군만 수기 칸을 준다(사용자 지시). */
    const ret2In = scen.mode === "carry" ? numInput(st.ret2, spec.key, "0.01", 78) : null;
    if (ret2In) {
      ret2In.setAttribute("aria-label", `${spec.key} 추정일 수익률`);
      ret2Inputs[spec.key] = ret2In;
    }

    /* 해외자산이면 자산군 이름이 **헤지비율을 여는 버튼**이 된다(§7.12 사용자 지시
       "개별 해외자산 자산군을 클릭해서 선택"). 아닌 자산군은 그냥 글자로 둔다 —
       눌러도 아무 일이 없는 자리를 만들면 고장으로 읽힌다. */
    const hCell = el("span", { class: "est-hedge-tag" });
    hedgeCells[spec.key] = hCell;
    let nameNode;
    if (scen.fx) {
      nameNode = el("button", {
        class: "est-name-btn", type: "button",
        "aria-label": `${spec.key} 헤지비율 고르기`,
      }, spec.key, " ", hCell);
      nameNode.addEventListener("click", () => openEstHedge(spec.key, st, band, recalcAll));
    } else {
      nameNode = el("span", {}, spec.key, spec.equity
        ? el("span", { style: "color:var(--ink-3);font-size:11px" }, " · 연환산 안 함") : "");
    }

    const c = {
      w: el("td", { class: "num" }), w2: el("td", { class: "num" }),
      r2: el("td", { class: "num" }), diff: el("td", { class: "num" }),
      why: el("td", { class: "est-memo", style: "font-size:11px;color:var(--ink-3)" }),
    };
    cells[spec.key] = c;

    amtIn.addEventListener("input", () => {
      st.amt[spec.key] = amtIn.value === "" ? null : +amtIn.value;
      estSaveState(st); recalcAll();
    });
    retIn.addEventListener("blur", () => { recalcAll(); });
    retIn.addEventListener("input", () => {
      /* 빈칸으로 지우면 **자동값으로 되돌아간다** — 되돌리기 버튼을 따로 두지 않아도
         되고, "지웠는데 0% 가 되는" 놀람도 없다. */
      st.ret[spec.key] = retIn.value === "" ? null : +retIn.value;
      estSaveState(st); recalcAll();
    });
    if (durIn) {
      durIn.addEventListener("input", () => {
        st.dur[spec.key] = durIn.value === "" ? null : +durIn.value;
        estSaveState(st); recalcAll();
      });
    }
    amt2In.addEventListener("input", () => {
      st.amt2[spec.key] = amt2In.value === "" ? null : +amt2In.value;
      estSaveState(st); recalcAll();
    });
    if (ret2In) {
      ret2In.addEventListener("input", () => {
        st.ret2[spec.key] = ret2In.value === "" ? null : +ret2In.value;
        estSaveState(st); recalcAll();
      });
    }

    tr.append(
      el("td", {}, nameNode),
      el("td", { class: "num est-sep" }, amtIn), c.w,
      el("td", { class: "num" }, durIn || el("span", { style: "color:var(--ink-3)" }, "–")),
      el("td", { class: "num" }, retIn),
      el("td", { class: "num est-sep" }, amt2In), c.w2,
      /* **`c.r2` 는 이미 `<td>` 다 — 다시 `<td>` 로 감싸면 안 된다.** 감싸면 중첩 td 가
         되고 브라우저가 풀면서 **셀이 하나 더 생겨** 그 행만 열이 밀린다(실측: calc 행이
         11칸, carry 행이 10칸이었다). 셰이드는 중첩을 그대로 두어 이 사고를 못 잡는다. */
      ret2In ? el("td", { class: "num" }, ret2In) : c.r2,
      c.diff, c.why);
    /* carry 행은 수익률 칸이 입력이라 계산 결과를 쓸 자리가 따로 필요 없다 —
       입력칸 자체에 승계값을 표시(placeholder 아님, 실제 value)한다. */
    if (ret2In) c.r2 = null;
    tbl.append(tr);
  });
  card.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, tbl));
  const tblNote = el("div", { style: "margin-top:6px;font-size:12px;color:var(--ink-3)" });
  card.append(tblNote);

  /* ---- 페인트: 표 ---- */
  function paintTable(E, S) {
    dcLine.textContent = E.dc
      ? `기준일 경과 ${E.dc.days}일` + (S.ready ? ` · 구간 ${S.days}일` : "")
      : "기준일을 넣으면 경과일수가 여기 나옵니다";
    tblNote.textContent = "";
    if (!S.ready) {
      tblNote.append(el("span", { class: "d-up" }, "추정일 블록이 비어 있습니다 — "),
        S.reason || "추정일을 넣으십시오");
    } else if (S.crossYear) {
      tblNote.append(el("span", { class: "d-up" }, "추정일이 다른 해입니다 — "),
        (A.scenario && A.scenario.cross_year) || "연초 기준이 달라져 누적을 잇지 못합니다.");
    } else {
      tblNote.append((A.scenario && A.scenario.cumulative) || "");
    }
    const srow = {};
    if (S.ready) S.rows.forEach((x) => { srow[x.key] = x; });
    const put = (node, v, opt) => {
      if (!node) return;
      const o = opt || {};
      node.textContent = "";
      /* className 을 통째로 다시 쓰므로 **구분선 클래스도 여기서 같이 붙여야 한다** —
         빠뜨리면 재계산 한 번에 기준일/추정일 경계선이 조용히 사라진다. */
      node.className = "num" + (o.sep ? " est-sep" : "")
        + (v == null ? "" : v >= 0 ? " d-up" : " d-down");
      if (v == null) { node.textContent = "–"; return; }
      node.append(o.bold ? el("b", {}, fmtNum(v * 100, 2)) : fmtNum(v * 100, 2));
    };

    E.rows.forEach((r) => {
      const c = cells[r.key];
      const s = srow[r.key];
      const scen = EST_SCEN[r.key] || {};
      /* 자동값은 입력칸에 **표시만** 하고 상태에는 안 넣는다 — 넣는 순간 "수기"가 되어
         기준일을 바꿔도 옛 자동값이 눌러앉는다(자산배분 μ 디폴트에서 겪은 사고). */
      const hasAuto = !r.isKeyed && r.auto && r.auto.ytd != null;
      /* **입력 중인 칸은 절대 되쓰지 않는다**(§7.10.1 CRITICAL).
         `<input type=number>` 는 사용자가 "-" 하나만 쳤거나 지운 순간 value 가 "" 다.
         그러면 수기 판정이 풀리고, 되쓰기가 자동값을 도로 넣어 방금 친 문자를 지우며
         캐럿을 끝으로 보낸다 — 이어 치는 숫자가 그 뒤에 붙는다.
         실측: 자동 20.00% 칸에 `-3.5` 를 치면 **20.0035** 가 되고 그대로 저장됐다. */
      if (!r.isKeyed && document.activeElement !== retInputs[r.key]) {
        retInputs[r.key].value = hasAuto ? (r.auto.ytd * 100).toFixed(2) : "";
      }
      retInputs[r.key].classList.toggle("est-auto", !!hasAuto);
      c.w.textContent = r.weight == null ? "–" : fmtNum(r.weight * 100, 1) + "%";

      /* ---- 추정일 블록 ---- */
      /* 규모: 비었으면 **승계값을 실제로 표시**한다(placeholder 로만 두면 빈 칸으로 읽혀
         "규모를 안 넣었으니 계산이 안 되나" 하고 다시 넣게 된다). 표시하되 상태에는
         넣지 않는다 — 넣으면 기준일 규모를 바꿔도 옛 값이 눌러앉는다. */
      const a2 = amt2Inputs[r.key];
      if (!(s && s.amt2Keyed) && document.activeElement !== a2) {
        a2.value = (s && s.amt2 != null) ? String(s.amt2) : "";
      }
      a2.classList.toggle("est-auto", !!(s && !s.amt2Keyed && s.amt2 != null));
      const w2 = (s && s.amt2 != null && S.totalAmt2 > 0) ? s.amt2 / S.totalAmt2 : null;
      c.w2.textContent = w2 == null ? "–" : fmtNum(w2 * 100, 1) + "%";

      const r2in = ret2Inputs[r.key];
      if (r2in) {
        /* carry 자산군 — 승계값을 칸에 채워 보여 주고, 사용자가 치면 그것이 정본이 된다 */
        if (!(s && s.ret2Keyed) && document.activeElement !== r2in) {
          r2in.value = (s && s.cumAnnual != null) ? (s.cumAnnual * 100).toFixed(2) : "";
        }
        r2in.classList.toggle("est-auto", !!(s && !s.ret2Keyed && s.cumAnnual != null));
      } else {
        put(c.r2, s ? s.cumAnnual : null, { bold: true });
      }
      put(c.diff, s ? s.diff : null);

      /* 근거 — 왜 이 수가 나왔는가. 계산이면 산식 요약, 승계면 그 사실, 막혔으면 사유. */
      c.why.textContent = "";
      c.why.className = "est-memo";
      /* **묵은 자동값 경고를 여기서 되살린다(§7.8.1).** 이 경고는 「출처 정보」가 아니라
         「지금 보고 있는 수가 며칠 전 값이다」라는 **값에 대한 경고**라, 출처 열을 내렸을
         때(§7.12) 함께 사라져서는 안 된다 — 실제로 한 번 사라졌고 프로브가 잡았다.
         요약에도 한 줄 나가지만 어느 행인지는 여기서만 보인다. */
      if (r.auto && r.auto.beyondData && !r.isKeyed) {
        c.why.append(el("span", { class: "d-up", style: "display:block" },
          `⚠ ${r.auto.obs.d} 까지만 있음 (${r.auto.gapDays}일 전)`));
      } else if (r.auto && r.auto.gapDays > 0 && !r.isKeyed) {
        c.why.append(el("span", { style: "display:block;color:var(--ink-3)" },
          `${r.auto.obs.d} 관측`));
      }
      /* **경고색은 실제로 막혔을 때만.** `priceNote` 에는 「장부가 — 원가법이라 가격효과
         없음」처럼 정상 동작을 설명하는 문장도 들어 있어서, 그것까지 빨갛게 칠하면
         계산이 잘 된 행이 고장난 것처럼 읽힌다(실측: 장부가 해외채권 2.33% 가 정상인데
         경고색이었다). 판정 기준은 문구가 아니라 **결과가 비었는가**다. */
      const isBlocked = !!(s && s.cumAnnual == null && !S.crossYear);
      const blockNote = s ? [s.priceNote, s.fxNote].filter(Boolean).join(" · ") : "";
      if (!S.ready) {
        c.why.append(el("span", { style: "color:var(--ink-3)" }, modeWhy[r.key] || ""));
      } else if (isBlocked && blockNote) {
        c.why.append(el("span", { class: "d-up" }, blockNote));
      } else if (s && s.modeNote === "수기") {
        c.why.append(el("span", { class: "d-up" }, "수기 입력"));
      } else if (s && s.modeNote === "기준일 승계") {
        c.why.append(el("span", { style: "color:var(--ink-3)" }, "기준일 승계"));
      } else {
        c.why.append(el("span", { style: "color:var(--ink-3)" }, modeWhy[r.key] || "계산"));
      }

      /* 헤지비율 배지 — 고르기 전에는 **미입력**이라고 적는다(0 으로 지어내지 않는다) */
      const hc = hedgeCells[r.key];
      if (hc) {
        const hv = st.hedge[r.key];
        const hasH = hv != null && hv !== "" && isFinite(+hv);
        hc.textContent = hasH ? `헤지 ${fmtNum(+hv, 0)}%` : "헤지 미입력";
        hc.className = "est-hedge-tag" + (hasH ? "" : " d-up");
      }
    });
  }

  /* ---- 페인트: 요약 ---- */
  function paintSummary(E, S) {
    const box = $("#est-summary");
    box.textContent = "";
    const big = (label, v, unit, size) => el("div", { style: "min-width:180px" },
      el("div", { style: "color:var(--ink-3);font-size:12px" }, label),
      el("div", { style: `font-size:${size}px;font-weight:700;line-height:1.25` },
        v == null ? "–" : fmtNum(v, 2) + unit));
    box.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "포트폴리오 연초이후 수익률"),
      el("span", { class: "card-sub" },
        (E.dc ? `${st.asof} 기준` : "기준일 미입력")
        + (S.ready ? ` → ${st.est_date} 추정` : "") + " · 주식 제외 연환산")));
    box.append(el("div", { style: "display:flex;gap:26px;flex-wrap:wrap;margin-top:6px" },
      big("기준일 수익률 (연환산)", E.port == null ? null : E.port * 100, "%", 26),
      big("추정일 수익률 (연환산)", S.portCumAnnual == null ? null : S.portCumAnnual * 100, "%", 26),
      big("차이", S.portDiff == null ? null : S.portDiff * 100, "%p", 15),
      big("기준일 규모", E.totalAmt || null, "", 15),
      big("추정일 규모", S.ready ? (S.totalAmt2 || null) : null, "", 15),
      big("총 운용수익 (연환산 기준)", E.port == null ? null : (E.totalProfit || null), "", 15),
      big("채권 가중평균 듀레이션", E.durW, "", 15)));
    const notes = [];
    if (E.portBlockedNoRet) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        "규모는 있는데 수익률이 하나도 없어 포트폴리오 수익률을 내지 않았습니다 — "
        + "0.00% 는 「계산했더니 0」이라는 뜻이라 쓰지 않습니다."));
    }
    if (!S.ready) {
      notes.push(el("div", { style: "margin-top:6px;font-size:12px;color:var(--ink-3)" },
        `추정일 수익률은 아직 없습니다 — ${S.reason || "추정일을 넣으십시오"}`));
    } else if (S.crossYear) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        (A.scenario && A.scenario.cross_year)
        || "추정일이 다른 해라 연초이후 누적을 잇지 못합니다."));
    } else if (S.blocked.length) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        `추정 입력이 모자란 자산군 ${S.blocked.length}개 — `
        + S.blocked.map((x) => `${x.key}(${x.priceNote || x.fxNote || "입력 부족"})`).join(", ")
        + " · 추정일 쪽에서만 빠지므로 차이가 실제보다 작게 나옵니다"));
    }
    /* 리밸런싱을 넣었으면 **두 열의 가중치가 다르다**는 사실을 적는다 — 안 적으면
       수익률만 보고 "왜 이만큼 움직였지" 하고 시장효과 탓을 하게 된다. */
    if (S.ready && S.sizeChanged) {
      notes.push(el("div", { style: "margin-top:6px;font-size:12px;color:var(--ink-3)" },
        "추정일 규모를 직접 넣으셨습니다 — 추정일 수익률은 그 비중으로 가중합한 값이라 "
        + "차이에는 시장효과와 리밸런싱 효과가 함께 들어 있습니다."));
    }
    const stale = E.rows.filter((x) => x.auto && x.auto.beyondData && !x.isKeyed && x.amt);
    if (stale.length) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        "⚠ 자동 채움 지수가 기준일까지 오지 않았습니다 — "
        + stale.map((x) => `${x.key}(${x.ix.label} ${x.auto.obs.d}, ${x.auto.gapDays}일 전)`).join(", ")
        + " · 그 날의 값이 기준일 값으로 쓰이고 있습니다"));
    }
    const negAmt = E.rows.filter((x) => x.amt != null && x.amt < 0);
    if (negAmt.length) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        `규모가 음수인 자산군 ${negAmt.length}개 — ${negAmt.map((x) => x.key).join(", ")}`));
    }
    if (E.totalAmt <= 0 && E.rows.some((x) => x.amt != null)) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        "규모 합이 0 이하라 포트폴리오 수익률을 낼 수 없습니다 — 규모를 확인하십시오"));
    }
    if (E.missingRet.length) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        `규모는 있는데 수익률이 빈 자산군 ${E.missingRet.length}개 — `
        + `${E.missingRet.map((x) => x.key).join(", ")} · 이 자산군은 수익 0 으로 잡힙니다`));
    }
    if (S.ready && !S.crossYear && S.yearDays < 30) {
      notes.push(el("div", { class: "d-up", style: "margin-top:6px;font-size:12px" },
        `연초→추정일이 ${S.yearDays}일뿐이라 추정일 재연환산 계수가 `
        + `${fmtNum(365 / S.yearDays, 1)}배입니다 — 추정일 수익률은 크게 흔들립니다`));
    }
    notes.forEach((n) => box.append(n));
    box.append(el("div", { style: "margin-top:6px;color:var(--ink-3);font-size:12px" },
      "듀레이션은 ", el("b", {}, "추정일 가격효과"), "(−듀레이션 × Δ금리)에 쓰입니다 — ",
      "기준일 수익률 계산에는 쓰이지 않고, 넣은 값은 저장됩니다."));
  }

  /* ---- 페인트: 기여도 막대 ---- */
  function paintContrib(E) {
    const cc = $("#est-contrib-card");
    cc.textContent = "";
    cc.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "자산군별 기여도"),
      el("span", { class: "card-sub" }, "합 = 기준일 수익률")));
    cc.append(explainBox("est-contrib-legend",
      "합이 기준일 수익률과 정확히 같습니다 (기여도 = 규모 × 기준일 수익률 ÷ 총규모)."));
    const withC = E.rows.filter((r) => r.contrib != null && r.contrib !== 0);
    if (!withC.length) {
      cc.append(el("div", { class: "card-sub", style: "margin-top:6px" },
        "규모와 수익률을 넣으면 기여도가 나옵니다."));
      return;
    }
    const mx = Math.max(...withC.map((r) => Math.abs(r.contrib)));
    const bt = el("table", { class: "mini-table" });
    withC.forEach((r) => {
      const pctW = mx > 0 ? Math.abs(r.contrib) / mx * 100 : 0;
      bt.append(el("tr", {},
        el("td", { style: "text-align:left" }, r.key),
        el("td", { class: "num" }, fmtNum(r.contrib * 100, 2)),
        el("td", { style: "width:52%" },
          el("div", { style: "background:var(--border);height:9px;border-radius:5px;overflow:hidden" },
            el("div", { style: `width:${pctW.toFixed(1)}%;height:9px;background:var(--${r.contrib >= 0 ? "up" : "down"}-ink)` })))));
    });
    cc.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, bt));
  }

  /* ---- 시장지표 카드 (§7.12) — 기준일·추정일 **수준**을 나란히 ----
     사용자가 치는 것은 추정일 수준이다("국고 10년이 3.50% 가 될 것"). 변화(bp/%)는
     화면이 계산해 옆에 적는다 — 사용자가 두 단위를 오가며 환산하지 않도록. */
  const mkCard = $("#est-market-card");
  const axInputs = {};
  const axCells = {};
  let paintAxes = () => {};
  if (mkCard) {
    mkCard.textContent = "";
    mkCard.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, "시장지표"),
      el("span", { class: "card-sub" },
        "추정일이 데이터 안이면 실제 수준을 채우고, 미래면 예상 수준을 넣으십시오")));
    const at = el("table", { class: "mini-table est-table" },
      el("tr", {}, ...["시장 축", "기준일", "추정일", "변화", "출처"]
        .map((h, i) => el("th", { style: i === 0 || i === 4 ? "text-align:left" : "" }, h))));
    (A.axes || []).forEach((ax) => {
      const inp = el("input", {
        type: "number", step: "any", inputmode: "decimal",
        value: st.lvl[ax.key] == null ? "" : String(st.lvl[ax.key]),
        style: "width:104px;text-align:right", "aria-label": `${ax.label} 추정일 수준`,
      });
      axInputs[ax.key] = inp;
      inp.addEventListener("input", () => {
        st.lvl[ax.key] = inp.value === "" ? null : +inp.value;
        estSaveState(st); recalcAll();
      });
      const c = { from: el("td", { class: "num" }), chg: el("td", { class: "num" }),
                  src: el("td", { style: "font-size:11.5px" }) };
      axCells[ax.key] = c;
      at.append(el("tr", {},
        el("td", {}, ax.label),
        c.from,
        el("td", { class: "num" }, inp,
          el("span", { style: "color:var(--ink-3);font-size:11px;margin-left:3px" },
            ax.level_unit || "")),
        c.chg, c.src));
    });
    mkCard.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, at));

    /* 스왑 잔존만기 — 스왑 MTM 에 필요한 유일한 비-시장 입력이라 여기 둔다 */
    const tauIn = el("input", { type: "number", step: "0.05", min: "0", inputmode: "decimal",
      value: st.swap_tau == null ? "" : String(st.swap_tau),
      style: "width:74px;text-align:right", "aria-label": "스왑 잔존만기(년)" });
    tauIn.addEventListener("input", () => {
      st.swap_tau = tauIn.value === "" ? null : +tauIn.value;
      estSaveState(st); recalcAll();
    });
    mkCard.append(el("div", { style: "margin-top:10px;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap" },
      el("label", { style: "font-size:12px" },
        el("div", { style: "color:var(--ink-3)" }, "스왑 잔존만기(년)"), tauIn)));
    mkCard.append(el("div", { style: "margin-top:8px;color:var(--ink-3);font-size:12px" },
      el("b", {}, "금리 상승 = 채권 가격 하락"), "(−듀레이션×Δ금리), ",
      el("b", {}, "스왑레이트 상승 = 스왑 MTM 손실"), "."));

    paintAxes = (S) => {
      (S.axes || []).forEach((ax) => {
        const c = axCells[ax.key];
        if (!c) return;
        const dp = ax.level_dp == null ? 2 : ax.level_dp;
        const unit = ax.level_unit || "";
        c.from.textContent = ax.from ? fmtNum(ax.from.v, dp) + unit : "–";
        /* 수기가 아니면 조회한 수준을 칸에 **표시**한다(상태에는 안 넣는다 — 기준일을
           바꿔도 옛 값이 눌러앉지 않게). 포커스가 있는 칸은 되쓰지 않는다. */
        if (!ax.isKeyed && document.activeElement !== axInputs[ax.key]) {
          axInputs[ax.key].value = (ax.toAuto && ax.toAuto.v != null)
            ? ax.toAuto.v.toFixed(dp) : "";
        }
        axInputs[ax.key].classList.toggle("est-auto",
          !ax.isKeyed && !!(ax.toAuto && ax.toAuto.v != null));
        c.chg.textContent = "";
        c.chg.className = "num";
        if (ax.delta == null) { c.chg.textContent = "–"; }
        else {
          const disp = ax.kind === "rate" ? ax.delta * 1e4 : ax.delta * 100;
          c.chg.className = "num " + (disp >= 0 ? "d-up" : "d-down");
          c.chg.textContent = (disp >= 0 ? "+" : "") + fmtNum(disp, ax.unit === "bp" ? 0 : 2)
            + (ax.unit === "bp" ? "bp" : "%");
        }
        c.src.textContent = "";
        c.src.className = "";
        if (ax.isKeyed) {
          c.src.textContent = "수기";
        } else if (ax.delta != null) {
          c.src.append(el("span", { class: ax.beyondData ? "d-up" : "" },
            ax.beyondData ? "⚠ 자동(데이터 밖)" : "자동"));
          c.src.append(el("span", { style: "display:block;font-size:10.5px;color:var(--ink-3)" },
            `${ax.from ? ax.from.d : "?"} → ${ax.toAuto ? ax.toAuto.d : "?"}`));
        } else {
          c.src.append(el("span", { class: "d-up" }, "미입력"));
          if (ax.error) {
            c.src.append(el("span", { style: "display:block;font-size:10.5px;color:var(--ink-3)" },
              ax.error));
          }
        }
      });
    };
  }

  asofInput.addEventListener("input", () => {
    st.asof = asofInput.value || null;
    estSaveState(st); recalcAll();
  });
  estInput.addEventListener("input", () => {
    st.est_date = estInput.value || null;
    estSaveState(st); recalcAll();
  });

  /* **계산은 한 번, 그림은 다섯 곳.** 표·요약·기여도·시장지표·산식카드가 전부 같은
     `E`/`S` 를 보므로 한 화면 안에서 서로 다른 수가 공존할 수 없다. */
  recalcAll = () => {
    const E = estEngine(A, st);
    const S = estScenario(A, st);
    paintTable(E, S);
    paintSummary(E, S);
    paintContrib(E);
    paintAxes(S);
    renderEstScenarioResult(A, S);
  };
  recalcAll();

  /* ---- 출처·부재 — 접이식 (§7.12 사용자 지시 "자료 출처, 쓰는 곳은 빼버려") ----
     지우지는 않는다. ACWI 가 PR 이라는 사실과 미국채 부재 사유는 숫자의 뜻을 바꾸는
     정보라 화면에서 닿을 수 있어야 한다 — 다만 상시 노출에서 한 단계 내린다. */
  const srcBox = $("#est-sources");
  srcBox.textContent = "";
  const det = el("details", { class: "method" });
  det.append(el("summary", {}, "자료 출처 · 자동 채움 범위"));
  const inner = el("div", { class: "howto" });
  if (A.active && (A.indices || []).length) {
    (A.indices || []).forEach((ix) => {
      const bad = ix.basis_matches_request === false;
      inner.append(el("div", { style: "font-size:12px;margin-top:3px" },
        `· ${ix.asset} ← `, el("b", {}, ix.label), ` (${ix.src}) — ${ix.basis}`,
        bad ? el("span", { class: "d-up" }, ` ⚠ ${ix.caveat}`) : ""));
    });
  } else {
    inner.append(el("div", { class: "d-up", style: "font-size:12px" },
      A.reason || "자동 채움 지수가 없습니다 — 전부 수기 입력입니다"));
  }
  (A.axes || []).forEach((ax) => {
    inner.append(el("div", { style: "font-size:12px;margin-top:3px;color:var(--ink-3)" },
      `· ${ax.label}${ax.src ? ` (${ax.src})` : ""} — ${ax.note || ""}`));
  });
  (A.unavailable || []).forEach((u) => {
    inner.append(el("div", { style: "font-size:12px;margin-top:5px" },
      el("b", { class: "d-up" }, `· ${u.assets.join(" · ")} — 자동 채움 없음`), el("br"),
      el("span", { style: "color:var(--ink-3)" }, `${u.want} 부재. ${u.reason}`)));
  });
  det.append(inner);
  srcBox.append(det);
  /* **PR 경고만은 접힌 채로 두지 않는다** — 배당이 빠진 수가 보고 숫자로 들어가는
     자리라 자동 채움이 실제로 쓰이는 동안에는 겉에 한 줄 남긴다. */
  const prBad = (A.indices || []).filter((x) => x.basis_matches_request === false);
  if (prBad.length) {
    srcBox.append(el("div", { class: "d-up", style: "font-size:12px;margin-top:6px" },
      "⚠ " + prBad.map((x) => `${x.asset} 자동값은 ${x.label} 가격지수(PR)입니다`).join(" · ")
      + " — 배당수익률만큼 낮게 나옵니다."));
  }

  const meth = $("#est-method");
  meth.textContent = "";
  meth.append(el("summary", {}, "계산 방법"),
    el("div", { class: "howto" },
      el("p", {}, el("b", {}, "연환산"), " — ",
        (A.annualize && A.annualize.note)
        || "기준일 수익률은 이미 연환산된 값을 넣습니다. 주식은 연환산하지 않습니다."),
      el("p", {}, el("b", {}, "포트폴리오 기준일 수익률"),
        " = Σ(자산군 규모 × 기준일 수익률) ÷ Σ(자산군 규모). 입력값을 그대로 쓰며 계수를 다시 "
        + "곱하지 않습니다. 기여도의 합은 이 값과 정확히 같습니다."),
      el("p", {}, el("b", {}, "포트폴리오 추정일 수익률"),
        " = Σ(추정일 규모 × 추정일 수익률) ÷ Σ(추정일 규모). **가중치가 기준일과 다를 수 "
        + "있습니다** — 추정일 규모를 직접 넣으면 리밸런싱 효과가 차이에 함께 들어갑니다."),
      el("p", {}, el("b", {}, "추정일 수익률"), " — 자산군마다 기준일 연환산율을 "
        + "기간수익으로 되돌리고(× 경과일수 ÷ 365) 추정 구간 4항을 더한 뒤 추정일 기준으로 다시 "
        + "연환산합니다(× 365 ÷ 연초→추정일 일수). 되돌리기는 위 연환산 규칙의 정확한 역입니다. "
        + "캐리가 기준일 연환산율을 보존하므로 결과는 "
        + "「기준일 수익률 + 시장효과 × 365 ÷ 연초→추정일 일수」와 대수적으로 같습니다."),
      el("p", {}, el("b", {}, "자동 채움"),
        " — 지수의 연초이후 수익률 = 지수(기준일 이하 마지막 관측) ÷ 지수(전년 마지막 관측) − 1. "
        + "분모 앵커는 파이프라인이 축약 전 원본에서 뽑아 싣습니다. 값을 직접 넣으면 수기가 되고, "
        + "지우면 자동으로 돌아갑니다."),
      el("p", {}, el("b", {}, "헤지비율"), " — ", (band && band.note) || ""),
      el("p", {}, el("b", {}, "저장"),
        " — 입력값은 이 브라우저에만 저장됩니다(서버로 나가지 않습니다).")));
}

/* 헤지비율 고르기 — 해외자산 자산군을 눌렀을 때 뜨는 작은 오버레이(§7.12 사용자 지시).
   **기본값을 넣지 않는다**: 열었을 때 비어 있으면 비어 있는 채로 두고, 사용자가 고른
   값만 저장한다. 범위는 파이프라인이 싣는 `hedge_band`(0~105%)를 쓴다 —
   105% 는 펀드 NAV 변동에 따른 일시 오버헤지를 담기 위한 상한이다. */
function openEstHedge(key, st, band, done) {
  const lo = band && band.lo != null ? band.lo : 0;
  const hi = band && band.hi != null ? band.hi : 105;
  const step = band && band.step != null ? band.step : 1;
  const cur = st.hedge[key];
  const has = cur != null && cur !== "" && isFinite(+cur);

  const back = el("div", { class: "est-hedge-back" });
  const panel = el("div", { class: "est-hedge-panel", role: "dialog",
                            "aria-label": `${key} 헤지비율` });
  const val = el("span", { style: "font-weight:700;font-size:19px" },
    has ? `${fmtNum(+cur, 0)}%` : "미입력");
  const slider = el("input", { type: "range", min: String(lo), max: String(hi),
    step: String(step), value: String(has ? +cur : 0),
    "aria-label": `${key} 헤지비율 슬라이더`, style: "width:100%" });
  const num = el("input", { type: "number", min: String(lo), max: String(hi),
    step: String(step), inputmode: "decimal", value: has ? String(+cur) : "",
    "aria-label": `${key} 헤지비율 숫자`, style: "width:86px;text-align:right" });

  const close = () => {
    document.removeEventListener("keydown", onKey);
    back.remove();
    done();
  };
  const onKey = (e) => { if (e && e.key === "Escape") close(); };
  const set = (v) => {
    /* 밴드 밖 값은 **조용히 자르지 않고** 밴드 안으로 되돌린 뒤 그 사실이 보이게 한다 */
    const c = Math.min(hi, Math.max(lo, v));
    st.hedge[key] = c;
    slider.value = String(c);
    if (document.activeElement !== num) num.value = String(c);
    val.textContent = `${fmtNum(c, 0)}%`;
    estSaveState(st);
    done();
  };
  slider.addEventListener("input", () => set(+slider.value));
  num.addEventListener("input", () => {
    if (num.value === "") return;              // 지우는 중에는 건드리지 않는다
    if (isFinite(+num.value)) set(+num.value);
  });

  const clearBtn = el("button", { class: "btn-ghost", type: "button" }, "비우기");
  clearBtn.addEventListener("click", () => {
    delete st.hedge[key];
    num.value = "";
    val.textContent = "미입력";
    estSaveState(st);
    done();
  });
  const okBtn = el("button", { class: "btn-ghost", type: "button" }, "닫기");
  okBtn.addEventListener("click", close);
  back.addEventListener("click", (e) => { if (!e || e.target === back) close(); });
  document.addEventListener("keydown", onKey);

  panel.append(
    el("div", { class: "card-head" },
      el("span", { class: "card-title" }, `${key} 헤지비율`),
      el("span", { class: "card-sub" }, `${lo}~${hi}%`)),
    el("div", { style: "margin:8px 0 4px" }, val),
    slider,
    el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap" },
      num, el("span", { style: "color:var(--ink-3);font-size:12px" }, "%"),
      clearBtn, okBtn),
    el("div", { style: "margin-top:8px;color:var(--ink-3);font-size:11.5px" },
      (band && band.note) || ""));
  back.append(panel);
  document.body.appendChild(back);
}

/* ---------------- render all / boot ---------------- */

/* 섹션 id → 그 섹션을 그리는 함수. SECTION_IDS 와 1:1 이며 계약 테스트가 강제한다.
   순서는 화면 순서(마을 구역 순)와 같게 둔다 — 읽는 사람이 대조하기 쉽게. */
const RENDERERS = {
  overview: renderOverview, risk: renderRisk, events: renderEvents,
  panel: renderPanel, hedge: renderHedge, alloc: renderAlloc, estimate: renderEstimate,
  rates: renderRates, irs: renderIRS, credit: renderCredit,
  fx: renderFX, inflation: renderInflation, acwi: renderACWI,
  macro: renderMacro, catalog: renderCatalog,
};

/* ── 렌더 격리 ────────────────────────────────────────────────────────────
   JSON 로딩(Promise.allSettled)과 파이프라인(risk/hedge 의 try/except)은 이미
   격리돼 있는데 **렌더 계층에만 그 규약이 없었다**. 렌더러 하나가 던지면
   renderAll 이 거기서 끊겨 그 뒤의 섹션이 전부 안 그려진다 — 실측으로
   index.html 의 id 하나(`#card-curve`)를 지웠더니 렌더된 섹션이 10 → 5 로
   줄었고(rates·irs·credit·fx·inflation·acwi·macro 전멸), 화면은 오류 없이
   그냥 비어 보였다. 여기서 섹션 단위로 가둔다. */
function renderSection(id) {
  const fn = RENDERERS[id];
  if (!fn) return;
  try {
    fn();
    /* 성공하면 이전 실패 배너를 걷는다 — 남겨 두면 복구된 화면이 계속 "고장"
       이라고 말한다(재점검 발견). 실패 경로는 아래 catch 가 다시 붙인다.
       (:scope 는 domshim 이 몰라 직계 자식 필터로 쓴다.) */
    const ok = document.getElementById(id);
    if (ok) [...ok.querySelectorAll(".render-error")]
      .filter((n) => n.parentElement === ok || n.parentNode === ok)
      .forEach((n) => n.remove());
  } catch (e) {
    console.error(`render failed: ${id}`, e);
    const node = document.getElementById(id);
    if (!node || node.querySelector(".render-error")) return;
    /* 빈 화면은 "데이터가 없다"로 읽힌다 — 고장임을 화면에 적는다. */
    node.prepend(el("p", { class: "render-error", role: "status" },
      "이 화면을 그리는 중 오류가 났습니다. 다른 화면은 정상입니다 — ",
      "브라우저 콘솔의 ", el("code", {}, `render failed: ${id}`), " 를 확인하세요."));
  }
}

function renderAll() {
  destroyAllCharts();
  overlayCharts = [];
  registry.length = 0;
  SECTION_IDS.forEach(renderSection);
  if (!$("#village").hidden) renderVillage();       // 장면 전환 시 낮/밤 지도 교체
  if (!$("#detail-overlay").hidden) handleHash();   // 명암 전환 시 열린 상세 재구성
}

/* ── 마을 장면(scene) 15초 자동 순환 ─────────────────────────────────────
   사용자 지시(2026-08-04): "그냥 놔두면 15초 간격으로 낮↔밤이 바뀌고, 수기로 바꿔도
   그대로 두면 15초 뒤 다시 바뀐다."
   **이 지시는 이 저장소의 옛 규약 「자동 낮밤순환 금지」를 명시적으로 해제한다** —
   몰래 어긴 것이 아니라 사용자가 바꾼 것이다(docs/HANDOVER.md §3.3 에 기록).
   해제되지 않은 것: prefers-reduced-motion. 자동 순환은 모션이고, 배경 이미지 교체는
   CSS 로 막을 수 없으므로 **타이머를 만드는 지점에 JS 가드**가 있어야 한다. */
const SCENE_CYCLE_MS = 15000;      // 사용자가 정한 수. 임의 상수가 아니다.
let sceneTimer = null;
let sceneBusy = false;             // 전환 연출(약 4초) 진행 중

/* 타이머가 살아 있어도 되는 조건 5개 — 하나라도 어긋나면 돌리지 않는다. */
function sceneCycleAllowed() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;  // ① 접근성
  const village = $("#village");
  if (!village || village.hidden) return false;                              // ② 마을이 안 보임
  const gate = $("#gate");
  if (gate && !gate.hidden) return false;                                    // ③ 암구호 입력 중
  if (document.visibilityState !== "visible") return false;                  // ④ 백그라운드 탭
  const frame = $("#village-frame");
  return !!(frame && frame.clientWidth);                                     // ⑤ ≤720px 는 지도째 숨김
}

function stopSceneCycle() {
  if (sceneTimer) { clearInterval(sceneTimer); sceneTimer = null; }
}

/* 항상 stop 후 start — 수동 토글이 주기를 리셋한다("바꾼 뒤 15초"). */
function restartSceneCycle() {
  stopSceneCycle();
  if (!sceneCycleAllowed()) return;
  sceneTimer = setInterval(() => {
    if (sceneBusy) return;                    // 전환 중이면 이번 틱은 건너뛴다
    if (!sceneCycleAllowed()) { stopSceneCycle(); return; }
    setScene(currentScene() === "day" ? "night" : "day");
  }, SCENE_CYCLE_MS);
}

/* 장면 전환. 전환 영상이 현재 화면을 덮은 뒤에 밑을 갈아끼운다.
   renderAll() 이 아니라 renderVillage() 만 부른다 — 15초마다 14개 화면의 차트를
   전부 다시 그릴 이유가 없고, chrome 은 이 축과 무관하다. */
function setScene(next, opts) {
  const reset = !opts || opts.resetCycle !== false;
  sceneBusy = true;
  playSceneTransition(next, () => {
    document.documentElement.setAttribute("data-scene", next);
    if (!$("#village").hidden) renderVillage();
    syncThemeButton();
  });
  /* 연출이 끝나는 시점을 정확히 알 수 없으므로(영상 실패 시 즉시 전환) 여유를 두고 푼다.
     이 플래그가 없으면 전환 중에 다음 틱이 겹쳐 data-transition 요소가 엇갈리고,
     mountVillageVideo 의 가드가 영구히 막혀 화면이 정지한다 — 실제로 한 번 난 사고다. */
  setTimeout(() => { sceneBusy = false; }, 5200);
  if (reset) restartSceneCycle();
}

/* ── 토글 버튼(◐) — 지금 보고 있는 것을 바꾼다 ───────────────────────────
   마을이 보이면 장면(낮↔밤), 섹션이 보이면 명암(라이트↔다크).
   반대로 배정하면 "눌러도 아무 일이 없는 버튼"이 된다 — 섹션에서 장면을 토글하면
   지도가 안 보이니 변화가 없고, 마을에서 명암을 토글하면 헤더 색만 바뀐다.
   이 저장소는 이미 같은 이유로 효과 없는 기간 버튼을 숨긴 적이 있다. */
function syncThemeButton() {
  const btn = $("#theme-btn");
  if (!btn) return;
  const onVillage = !$("#village").hidden;
  const label = onVillage
    ? "마을 낮/밤 전환 (그냥 두면 15초마다 자동으로 바뀝니다)"
    : (currentTheme() === "dark" ? "화면을 밝게 전환" : "화면을 어둡게 전환");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function bindTheme() {
  const btn = $("#theme-btn");
  /* 기본값은 다크다 — 속성을 붙이지 않으면 :root 가 다크 토큰이다.
     저장된 값이 "light" 일 때만 속성을 단다. 기존 사용자의 'iaw-theme' 키·값을
     그대로 재사용하므로 마이그레이션 코드가 필요 없다. */
  if (localStorage.getItem("iaw-theme") === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
  document.documentElement.setAttribute("data-scene", "day");

  btn.addEventListener("click", () => {
    if (!$("#village").hidden) {            // 마을 → 장면 토글 + 주기 리셋
      setScene(currentScene() === "day" ? "night" : "day");
      return;
    }
    const next = currentTheme() === "dark" ? "light" : "dark";   // 섹션 → 명암 토글
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("iaw-theme", next);
    renderAll();
    syncThemeButton();
  });

  /* 탭이 백그라운드로 가면 영상 디코드·타이머를 멈추고, 돌아오면 다시 건다. */
  document.addEventListener("visibilitychange", restartSceneCycle);
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", restartSceneCycle);
  syncThemeButton();
}

function bindSkipLink() {
  const a = document.querySelector(".skip-link");
  const main = document.getElementById("main-content");
  if (!a || !main) return;
  a.addEventListener("click", (e) => {
    e.preventDefault();          /* 해시를 건드리면 routeView() 가 마을로 튕긴다 */
    main.focus();
    const first = main.querySelector("section:not([hidden])");
    if (first) first.scrollIntoView({ block: "start" });
  });
}

async function boot() {
  bindGate();
  bindTheme();
  bindRangeButtons();
  bindSkipLink();
  const results = await Promise.allSettled(
    FILES.map((f) => fetch(`data/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`${f}.json ${r.status}`);
      return r.json();
    })),
  );
  results.forEach((res, i) => {
    if (res.status === "fulfilled") DATA[FILES[i]] = res.value;
    else console.error("load failed:", FILES[i], res.reason);
  });
  if (!DATA.meta && !DATA.overview) {
    $("#meta-line").textContent = "데이터를 불러오지 못했습니다 — 파이프라인 실행 여부를 확인하세요.";
    return;
  }
  renderMetaLine();
  renderAll();          // 카탈로그도 RENDERERS 에 있으므로 따로 부르지 않는다
  window.addEventListener("hashchange", handleHash);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#detail-overlay").hidden) {
      location.hash = location.hash === "#hedge-sim" ? "hedge"
        : location.hash.startsWith("#alloc-") ? "alloc" : "risk";
    }
  });
  handleHash();
  window.__iaw = { registry, state, gateHash: sha256Hex };   // 디버그·테스트 훅 (await 필요)
}

boot();
