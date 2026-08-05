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
               "rates", "irs", "credit", "fx", "inflation", "acwi",
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

function renderOverview() {
  const wrap = $("#cards");
  wrap.textContent = "";
  const pal = palette();
  const ov = DATA.overview;
  if (!ov || !ov.cards) { wrap.append(el("div", { class: "chart-empty" }, "데이터 없음")); return; }
  for (const c of ov.cards) {
    const kpi = el("div", { class: "kpi" });
    kpi.append(el("div", { class: "kpi-label" },
      el("span", {}, c.label), el("span", { class: "kpi-date" }, c.date)));
    const val = el("div", { class: "kpi-value" }, fmtNum(c.value, String(c.value).includes(".") ? 2 : 0));
    if (c.unit) val.append(el("span", { class: "unit" }, c.unit));
    kpi.append(val);
    const d1 = el("div", { class: "kpi-delta" }, deltaSpan("1일", c.chg.d1, c.kind, true));
    kpi.append(d1);
    kpi.append(el("div", { class: "kpi-delta" },
      deltaSpan("1개월", c.chg.m1, c.kind),
      deltaSpan("YTD", c.chg.ytd, c.kind),
      deltaSpan("1년", c.chg.y1, c.kind)));
    kpi.append(sparkSVG(c.spark, pal.accent));
    wrap.append(kpi);
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

function prependRiskCards(r) {
  const wrap = $("#cards");
  if (!wrap || wrap.querySelector(".kpi-risk")) return;
  const asofTs = Math.floor(Date.parse(r.asof + "T00:00:00Z") / 1000);
  ["vuln", "stress"].forEach((k) => {
    const L = r.layers[k];
    if (!L || L.score == null) return;
    const kpi = el("a", { class: "kpi kpi-risk", href: "#risk", style: "cursor:pointer",
      "aria-label": `${L.name} ${Math.round(L.score)}점 ${L.grade} — 리스크 화면으로` });
    kpi.append(el("div", { class: "kpi-label" },
      el("span", {}, L.name), el("span", { class: "kpi-date" }, r.asof)));
    const val = el("div", { class: "kpi-value" }, String(Math.round(L.score)));
    val.append(el("span", { class: "unit" }, "점 "), gradeChip(L.grade));
    kpi.append(val);
    kpi.append(el("div", { class: "kpi-delta" }, el("span", {}, "1개월 "), deltaPts(L.delta)));
    kpi.append(sparkSVG(withToday(L.hist, asofTs, L.score), palette().accent));
    wrap.prepend(kpi);
  });
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
  hw.append(el("b", {}, "점수 읽는 법"), ` — ${r.howto}`);
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
  prependRiskCards(r);
}

/* ---------------- 이벤트 타임라인 ---------------- */

const evFilter = { sev: null, cat: null };

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
  { key: "granary", x: 81.0, y: 31.8, name: "곳간", sub: "자산배분", target: "alloc" },
  { key: "trading", x: 67.8, y: 73.9, name: "교역소", sub: "환헤지", target: "hedge" },
  { key: "archive", x: 24.8, y: 71.1, name: "서고", sub: "카탈로그", target: "catalog" },
  { key: "workshop", x: 10.8, y: 48.9, name: "공방", sub: "모델 랩 — 준비 중", soon: true },
];

const SECTION_IDS = ["overview", "risk", "events", "panel", "hedge", "alloc", "rates",
                     "irs", "credit", "fx", "inflation", "acwi", "macro", "catalog"];

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
        ` — 가장 강한 동행 관계는 ${top.name}(${fmtNum(top.p.r, 2)})입니다. 양수면 위험지표가 오를 때 그 변수도 같이 오르는 관계, 음수면 반대입니다. `,
        "여기 상관은 ", el("b", {}, "같은 시점"), "의 관계만 봅니다 — 어느 쪽이 먼저 움직이는지는 '선행·후행' 탭에서 확인하세요."));
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
    body.append(el("div", { class: "pnl-note" },
      el("b", {}, "읽는 법"),
      ` — corr(위험지표_{t−k}, 변수_t)를 k = −${maxLag}~+${maxLag}${FREQ_LABEL()}에서 계산합니다. `,
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
      "· 읽는 법 — 금액 × 이 비율 = 1년치 금액. ",
      el("b", {}, "다른 만기에는 다른 값입니다"), " — 3·6·12개월 커브와 만기 보간은 ",
      el("a", { href: "#hedge-sim" }, "시뮬레이터"), " 와 아래 표·커브 카드에 있습니다.");
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
  mx.append(el("div", { class: "card-sub", style: "margin-top:8px;line-height:1.7" },
    el("b", {}, "표 읽는 법"), " — ",
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
  hv.append(el("b", {}, "위 표를 어느 관점으로 읽을 것인가 — 관점이 답을 바꿉니다"));
  const vt = el("table", { class: "mini-table view-table" },
    el("tr", {}, el("th", {}, ""),
      el("th", {}, "경제(시가) 관점"), el("th", {}, "회계(손익) 관점")));
  [["누가 보는 숫자인가", "시가평가 자산의 원화 가치", "장부가(만기보유) 해외채권의 회계 손익"],
   ["환율 손실을 상쇄해 줄 상대", "있다 — 자산가격이 반대로 움직임(자연 쿠션)", "없다 — 채권 가격변동을 손익에 안 잡음"],
   ["그래서 변동이 최소가 되는 헤지비율", `채권 ${mvhTxt} · 달러주식 ${eqTxt}`, "100% (모형상 언제나)"],
   ["남는 판단", "환위험을 얼마나 열어 둘까", "비용을 낼까 / 받을까"],
  ].forEach(([k, a1, a2]) => vt.append(el("tr", {},
    el("th", { class: "rowhead" }, k), el("td", {}, a1), el("td", {}, a2))));
  hv.append(wrapTable(vt));
  /* 용어는 접어 둔다 — 필요한 사람만 펼치고, 첫 화면은 숫자로 남는다. */
  const terms = el("details", { class: "terms" });
  terms.append(el("summary", {}, "이 화면에 나오는 말 다섯 개 (펼쳐 보기)"));
  [["헤지비율", "외화 자산 중 선물환·스왑으로 환위험을 덮은 비율. 0% = 환율에 그대로 노출, 100% = 환율이 움직여도 원화 손익은 그대로."],
   ["헤지비용 (= 스왑레이트 = 스왑포인트)", `헤지할 때 해마다 주고받는 연율 %. ${COST_SIGN_KEY} — 이름은 '비용'이지만 부호가 양수면 받습니다. 자산배분·시뮬레이터도 같은 부호 규약입니다.`],
   ["MVH (최소분산 헤지비율)", "경제 관점에서 변동성이 가장 작아지는 헤지비율. 산식은 1 + Cov(자산수익, 환율변화) ÷ Var(환율변화)."],
   ["스왑 MTM (평가손익)", "이미 체결한 스왑의 평가손익. 시장 스왑레이트가 오르면 평가손실입니다(민감도 = 잔존만기 τ = 만기 ÷ 2)."],
   ["장부가 비중", "보유 채권 중 만기보유로 분류돼 가격변동이 손익에 안 잡히는 비율. 회계 관점 계산에만 씁니다."],
  ].forEach(([k, v]) => terms.append(el("div", { class: "term" }, el("b", {}, k), " — ", v)));
  hv.append(terms);

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
  cc.append(el("div", { class: "card-sub", style: "margin-top:6px;line-height:1.7" },
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
  cost.append(el("div", { class: "card-sub", style: "margin-top:6px;line-height:1.7" },
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
    tsCardEl.append(el("div", { class: "card-sub", style: "margin-top:6px;line-height:1.7" },
      "세 선이 벌어져 있으면 만기에 따라 비용이 크게 다르다는 뜻입니다 — ",
      el("a", { href: "#hedge-sim" }, "시뮬레이터"),
      H2.default_tenor_m
        ? ` 는 이 커브 위에서 ${H2.default_tenor_m}개월을 보간하므로, 위 표의 12개월 값과 다른 숫자가 나옵니다.`
        : " 는 이 커브 위에서 만기를 보간하므로, 위 표의 12개월 값과 다른 숫자가 나옵니다."));
  } else {
    tsCardEl.append(el("p", { class: "card-sub" }, "헤지비용 커브 이력을 불러오지 못했습니다."));
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
    el("div", { class: "card-sub", style: "margin-top:6px;line-height:1.7" },
      el("b", {}, "읽는 법"), " — 평가손은 시장 스왑레이트가 ", el("b", {}, "오를"),
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
   hedge 가 alloc 에 쓰면 자산배분 화면의 다음 저장에 조용히 지워진다. */
function allocMixReadOnly() {
  try { return (JSON.parse(localStorage.getItem(ALLOC_LS_KEY)) || {}).mix_acct || null; }
  catch { return null; }
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
     장부가 해외채권 + 시가 해외채권 → USD_b, 해외주식 → USD_e. */
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
                  ...pick(derive("장부가 해외채권", "시가 해외채권"), 5000) });
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
    el("span", { style: "color:var(--ink-3);font-size:12px" },
      `— 조건을 고정하는 기간이자 평가손익 민감도(잔존만기 τ = 만기 ÷ 2)입니다. 위 헤지비용 열은 이 만기로 보간합니다`
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
  note.append(el("b", {}, "③ 이렇게 움직여 보세요"),
    el("br"), "· 엔 채권에 금액을 넣고 헤지비율을 0%로 내려 보세요 — 회계 손익변동성과 연간 캐리가 함께 나빠집니다.",
    el("br"), "· 달러 주식 헤지를 100%로 올려 보세요 — 경제 변동성이 오히려 커집니다(환율이 덜어 주던 몫을 없애기 때문).",
    el("br"), "· 만기를 3 → 12개월로 바꿔 보세요 — 조건은 오래 고정되지만 평가손익 민감도(τ)가 4배가 됩니다.",
    el("br"), el("b", {}, "산식"),
    ` — 회계 손익 모형 5항 분해와 공분산 표본(${H2.sim.sample}, ${H2.sim.n_months}개월)은 환헤지 화면 맨 아래 방법론 패널에 있습니다. 위안 행은 단기금리·헤지비용 데이터를 확보하면 자동으로 켜집니다.`);
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
      spanBox.append(el("div", { class: "card-sub", style: "margin-top:4px" },
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

const ALLOC_ECON = ["국내채권", "해외채권", "국내주식", "해외주식", "대체투자", "단기자금"];
const ALLOC_ACCT = ["장부가 국내채권", "시가 국내채권", "장부가 해외채권", "시가 해외채권",
                    "국내주식", "해외주식", "대체투자", "단기자금"];

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
  const rowBookFx = (h) => { const r = zero(); r[ix.e_usd] = 1 - h; r[ix.swap] = h; r[ix.d_swap] = -h * tau; return r; };

  const sigOf = (row) => Math.sqrt(Math.max(amQuad(row, S), 0)) * 100;

  /* 앵커 — 각 시장 자국통화 기준(승인 ⑤-ⓑ). 헤지 슬라이더와 완전히 무관 —
     헤지비율은 기대수익에 비용항(h×cost)으로만, 위험에 환노출(1−h)로만 들어간다 */
  const rowUsbLoc = zero(); rowUsbLoc[ix.us_bond] = 1;
  const rowEqLoc = zero(); rowEqLoc[ix[proxy]] = 1;
  function anchorLocal() {
    const premKr = R.kr5y.v - R.kr3m.v;
    const premUs = R.us_ytm.v - R.us3m.v;
    const sKr = sigOf(rowKr), sUs = sigOf(rowUsbLoc);
    return { value: (premKr / sKr + premUs / sUs) / 2,
             kr: { prem: premKr, sigma: sKr }, us: { prem: premUs, sigma: sUs } };
  }

  function muEconAt(hbX, heX, anchor) {
    const a = anchor || anchorLocal();
    return [R.kr5y.v,
            R.us_ytm.v + hbX * cost,
            R.kr3m.v + a.value * sigOf(rowKospi),
            R.us3m.v + a.value * sigOf(rowEqLoc) + heX * cost,
            R.cpi.v + st.alt_alpha,
            R.kr3m.v];
  }

  const byKr = st.by_kr != null ? st.by_kr : R.kr5y.v;      // 북일드 미입력 시 [관측] 대체
  const byFx = st.by_fx != null ? st.by_fx : R.us_ytm.v;

  function build(view, hbX, heX) {
    const anchor = anchorLocal();   // 슬라이더 무관 — hbX 는 비용항·로딩에만 쓰인다
    const muE = muEconAt(hbX, heX, anchor);
    let keys, rows, mu;
    if (view === "acct") {
      keys = ALLOC_ACCT;
      rows = [zero(), rowKr, rowBookFx(hbX), rowUsb(hbX),
              rowKospi, rowEq(heX), rowAlt, rowCash];
      mu = [byKr, muE[0], byFx + hbX * cost, muE[1], muE[2], muE[3], muE[4], muE[5]];
    } else {
      keys = ALLOC_ECON;
      rows = [rowKr, rowUsb(hbX), rowKospi, rowEq(heX), rowAlt, rowCash];
      mu = muE;
    }
    const m = keys.length;
    const C = [];
    for (let i = 0; i < m; i++) {
      const Si = amMv(S, rows[i]);
      C.push([]);
      for (let j = 0; j < m; j++) C[i].push(amDot(rows[j], Si) * 10000);   // %² 단위
    }
    return { keys, rows, mu, C, anchor };
  }

  const mixSrc = st.mix_acct;
  const mixEcon = {
    국내채권: mixSrc["장부가 국내채권"] + mixSrc["시가 국내채권"],
    해외채권: mixSrc["장부가 해외채권"] + mixSrc["시가 해외채권"],
    국내주식: mixSrc["국내주식"], 해외주식: mixSrc["해외주식"],
    대체투자: mixSrc["대체투자"], 단기자금: mixSrc["단기자금"],
  };
  const view = st.view === "acct" ? "acct" : "econ";
  const V = build(view, hb, he);
  const mix = view === "acct" ? mixSrc : mixEcon;
  const w0 = V.keys.map((k) => (mix[k] || 0) / 100);
  const bands = view === "acct" ? st.bands_acct : st.bands;
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

  const sigmaW = (w, C) => Math.sqrt(Math.max(amQuad(w, C), 0));
  const eulerRC = (w, C) => {
    const s = sigmaW(w, C);
    const Cw = amMv(C, w);
    return { s, rc: w.map((wi, i) => s > 0 ? wi * Cw[i] / s : 0) };
  };

  return {
    A, st, set, ix, S, cost, costOpt, view, V, mix, mixEcon, w0, lo, hi, total, groups,
    byKr, byFx, kAlt, tau, proxy,
    n_months: set.n_months,
    anchorLocal, muEconAt, build, sigOf, rowUsb, rowEq, rowKospi, rowKr,
    sigmaW, eulerRC,
    seOf(sig) { return sig / Math.sqrt(2 * set.n_months); },
    /* 배분 고정 · 헤지 (hbX,heX) 이동 시 총위험(현재 관점 기준) */
    sigmaHedge(hbX, heX) {
      const B = build(view, hbX, heX);
      return sigmaW(w0, B.C);
    },
    /* --- 헤지 레버의 자유도는 실질 1개다 (pipeline/alloc.py 와 같은 항등식) ---
       로딩에서 두 레버는 같은 방향 g = e_usd − swap 의 스칼라배로만 들어간다:
         x(hb,he) = x1 + [w채(1−hb) + w주(1−he)]·g = x1 + Xe·g
       따라서 같은 Xe 를 만드는 (hb,he) 는 위험이 **정확히** 같다(근사가 아니다).
       한 점을 최적이라 적으면 무한한 동점 중 하나를 임의로 고른 것이 된다. */
    xeOf(hbX, heX) { return w0[1] * (1 - hbX) + w0[3] * (1 - heX); },
    xeOpen() { return w0[1] + w0[3]; },
    /* σ²(Xe) = a0 + 2·a1·Xe + a2·Xe². 정확히 2차식이므로 **세 점이면 계수가 확정**된다
       — 로딩 산식을 여기서 다시 쓰지 않고 sigmaHedge 를 세 번 부르는 편이 어긋날 여지가 없다.
       (hb,he) = (1−t, 1−t) 로 잡으면 Xe = (w채+w주)·t 라 t = 0 / ½ / 1 을 쓴다.
       회계 관점은 d_swap 의 −h·τ 때문에 이 붕괴가 성립하지 **않으므로** 쓰지 말 것. */
    xeQuad() {
      /* 주석이 아니라 실제 가드다 — 회계 관점에서 이 붕괴는 성립하지 않으므로
         조용히 틀린 2차식을 돌려주느니 호출 자체를 막는다. */
      if (view !== "econ") throw new Error("xeQuad: 경제 관점 전용 (회계는 d_swap 때문에 붕괴하지 않음)");
      const X = w0[1] + w0[3];
      if (!(X > 0)) return { a0: sigmaW(w0, build(view, 1, 1).C) ** 2, a1: 0, a2: 0, span: 0 };
      const sq = (t) => this.sigmaHedge(1 - t, 1 - t) ** 2;
      const s0 = sq(0), s1 = sq(0.5), s2 = sq(1);
      const a2 = 2 * (s2 - 2 * s1 + s0) / (X * X);
      const a1 = (s2 - s0 - a2 * X * X) / (2 * X);
      return { a0: s0, a1, a2, span: X };
    },
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
    hedgePairForXe(xe, cur, bands) {
      const wb = w0[1], we = w0[3];
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

/* ================= 자산배분 — 화면 ================= */

const ALLOC_LS_KEY = "iaw-alloc";
let allocCharts = [];

function allocDefaults(A) {
  const d = A.defaults;
  return {
    view: "econ",
    mix_acct: { ...d.mix_acct },
    bands: JSON.parse(JSON.stringify(d.bands)),
    bands_acct: JSON.parse(JSON.stringify(d.bands_acct)),
    loan_w: d.loan_w, loan_y: d.loan_y,
    alt_alpha: d.alt_alpha, alt_vol: d.alt_vol,
    tenor_m: d.tenor_m, h_bond: d.h_bond, h_eq: d.h_eq,
    h_bands: JSON.parse(JSON.stringify(d.h_bands || { 해외채권: [0, 100], 해외주식: [0, 100] })),
    h_tol_hi: { ...(d.h_tol_hi || { 해외채권: null, 해외주식: null }) },
    ccy: JSON.parse(JSON.stringify(d.ccy || { 해외채권: {}, 해외주식: {} })),
    cost_key: d.cost_key, proxy: d.proxy, start_key: d.start_key,
    cap_foreign: null, cap_equity: null, target_ret: null, risk_cap: null,
    by_kr: null, by_fx: null, book_mat_m: null,
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

function allocSrcTag(key) {
  return {
    국내채권: "[관측] 한국 5년 YTM", 해외채권: "[관측] 미 종합 YTM + 헤지캐리",
    "장부가 국내채권": "[입력] 북일드 (미입력 시 [관측] 5년 YTM 대체)",
    "시가 국내채권": "[관측] 한국 5년 YTM",
    "장부가 해외채권": "[입력] 북일드 + 헤지캐리 (미입력 시 [관측] 대체)",
    "시가 해외채권": "[관측] 미 종합 YTM + 헤지캐리",
    국내주식: "[관측→앵커] 무위험 + 샤프×σ", 해외주식: "[관측→앵커] 무위험 + 샤프×σ + 헤지캐리",
    대체투자: "[가정] CPI + α · 위험 별도 입력", 단기자금: "[관측] 한국 3개월",
  }[key] || "";
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
  const pal = palette();
  const st = allocState(A);

  /* 기준선 = 마지막으로 **저장된** 상태(없으면 예시값). 시뮬레이션 조정(st)이 여기서
     얼마나 벗어났는지를 요약·투자선 마커가 이 스냅숏과 비교해 보여준다.
     저장 버튼 → renderAlloc 재실행 → 기준선이 새 저장값으로 갱신되는 구조다. */
  const baseSt = allocState(A);
  const baseE = allocEngine(A, { ...baseSt, view: "econ" });
  const baseSig = baseE.sigmaW(baseE.w0, baseE.V.C);
  const baseMu = amDot(baseE.V.mu, baseE.w0);
  const baseXe = baseE.xeOf(baseSt.h_bond / 100, baseSt.h_eq / 100);

  const hl = $("#alloc-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문 — 지금 배분·헤지에서 무엇을 얼마나 바꾸면 위험이 얼마나 줄어드나"));
  const sub = el("div", { class: "a" }, "모델 참고치 ");
  sub.append(el("small", {}, `권고가 아닙니다 · 표본 ${A.sets[0].start}~${A.sets[0].end} · 기대수익의 출처는 아래 상자에 전부 표시됩니다`));
  hl.append(sub);

  const ctl = $("#alloc-controls");
  ctl.textContent = "";
  const segWrap = el("div", { class: "seg", role: "group" });
  const mkSeg = (label, v) => el("button", {
    class: st.view === v ? "active" : "",
    onclick: () => { st.view = v; allocSaveState(st); renderAlloc(); },
  }, label);
  segWrap.append(mkSeg("경제(시가) 관점 — 기본", "econ"), mkSeg("회계(손익) 관점", "acct"));
  ctl.append(el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;align-items:center" },
    el("b", {}, "관점"), segWrap,
    el("span", { style: "color:var(--ink-3);font-size:12px" },
      st.view === "acct"
        ? "손익에 잡히는 변동만 봅니다 — 장부가 채권의 가격변동은 손익에 오지 않습니다"
        : "시가 기준 경제적 가치의 변동을 봅니다 — 장부가/시가 구분이 없습니다")));

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

  const sliders = el("div", { style: "display:flex;gap:26px;flex-wrap:wrap;margin-top:10px" });
  const mkSlider = (label, key) => {
    const wrap = el("div", {});
    const lbl = el("span", { class: "hlbl" }, `${st[key]}%`);
    const inp = el("input", { type: "range", min: "0", max: "100", step: "5",
      value: String(st[key]), "aria-label": label });
    inp.addEventListener("input", () => {
      st[key] = +inp.value;
      lbl.textContent = `${st[key]}%`;
      markDirty();
      recalc(false);
    });
    inp.addEventListener("change", () => recalc(true));
    wrap.append(el("div", { style: "font-size:12.5px" }, el("b", {}, label),
      el("span", { style: "color:var(--ink-3)" }, " — 조정해 보십시오. 저장 전에는 이 화면에만 적용됩니다")),
      el("div", {}, inp, " ", lbl));
    return wrap;
  };
  sliders.append(mkSlider("해외채권 헤지비율", "h_bond"), mkSlider("해외주식 헤지비율", "h_eq"));
  ctl.append(sliders);

  /* 배분 비중 — 회계 구분 8칸 그대로 받는다(경제 관점은 자동 합산). 경제 6칸으로
     받으면 장부가/시가로 쪼개는 규칙을 지어내야 해서(자의성) 회계 구분을 유지한다. */
  const mixRow = el("div", { class: "sim-mix" });
  const sumBadge = el("span", { class: "sim-sum" });
  const refreshSum = () => {
    const target = 100 - (st.loan_w || 0);
    const sum = ALLOC_ACCT.reduce((a, k) => a + (st.mix_acct[k] || 0), 0);
    const off = Math.abs(sum - target) > 0.05;
    sumBadge.textContent = `합계 ${fmtNum(sum, 1)}% / 목표 ${fmtNum(target, 1)}% (대출 ${fmtNum(st.loan_w || 0, 1)}% 제외)`;
    sumBadge.classList.toggle("warn", off);
    return off;
  };
  ALLOC_ACCT.forEach((k) => {
    const inp = el("input", { type: "number", step: "1",
      value: String(st.mix_acct[k] != null ? st.mix_acct[k] : 0),
      id: "sim-mix-" + k.replace(/\s+/g, "-"), "aria-label": `${k} 비중 %` });
    inp.addEventListener("input", () => {
      st.mix_acct[k] = inp.value === "" ? 0 : +inp.value;
      markDirty();
      refreshSum();
      recalc(false);
    });
    inp.addEventListener("change", () => recalc(true));
    mixRow.append(el("label", { class: "sim-cell" },
      el("span", {}, k), inp));
  });
  const fillCash = el("button", { type: "button", class: "btn-ghost", onclick: () => {
    /* 합계를 몰래 맞추지 않는다 — 사용자가 눌렀을 때만 잔여를 단기자금으로 채운다 */
    const target = 100 - (st.loan_w || 0);
    const others = ALLOC_ACCT.filter((k) => k !== "단기자금")
      .reduce((a, k) => a + (st.mix_acct[k] || 0), 0);
    st.mix_acct["단기자금"] = Math.max(0, +(target - others).toFixed(2));
    const inp = $("#sim-mix-단기자금");
    if (inp) inp.value = String(st.mix_acct["단기자금"]);
    markDirty();
    refreshSum();
    recalc(true);
  } }, "잔여 → 단기자금");
  ctl.append(el("div", { style: "margin-top:10px;font-size:12.5px" },
      el("b", {}, "배분 비중 (%)"),
      el("span", { style: "color:var(--ink-3)" }, " — 바꾸는 즉시 위 요약과 아래 카드·차트가 다시 계산됩니다")),
    mixRow,
    el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px" },
      sumBadge, fillCash));
  refreshSum();

  ctl.append(el("div", { style: "margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
    el("button", { class: "btn-primary", style: "border:0;cursor:pointer;font-family:inherit",
      onclick: () => { allocSaveState(st); renderAlloc(); } },
      "이 상태를 기본값으로 저장"),
    el("button", { type: "button", class: "btn-ghost",
      onclick: () => renderAlloc() },                       // 저장 안 된 조정을 버리고 저장값으로
      "저장값으로 되돌리기"),
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
  let chartTimer = null;

  function recalc(withCharts) {
    const E = allocEngine(A, st);
    const { V, w0 } = E;
    const acct = E.view === "acct";
    const sigCur = E.sigmaW(w0, V.C);
    const muCur = amDot(V.mu, w0);
    const se = E.seOf(sigCur);
    const target = st.target_ret != null ? st.target_ret : muCur;
    /* 실행 불가능한 밴드·그룹 한도 — 최적화를 돌리지 않고 명시적으로 알린다 */
    const infeas = allocFeasibility(E);
    /* 회계 관점은 진단 전용 — 장부가 자산(가격변동 0)을 평균-분산 최적화기에
       넣으면 밴드 상한까지 쏠린다(§7.2-1). 배분 참고치는 경제 관점 전용. */
    const doOpt = !acct && infeas.length === 0;
    const wMin = doOpt ? E.optimize(V.mu, V.C, null) : null;
    const wKeep = doOpt ? E.optimize(V.mu, V.C, target) : null;
    const sigMin = doOpt ? E.sigmaW(wMin, V.C) : 0, muMin = doOpt ? amDot(V.mu, wMin) : 0;
    const sigKeep = doOpt ? E.sigmaW(wKeep, V.C) : 0, muKeep = doOpt ? amDot(V.mu, wKeep) : 0;
    const turnover = doOpt ? w0.reduce((a, w, i) => a + Math.abs(wKeep[i] - w), 0) / 2 * 100 : 0;

    /* 헤지 참고치(위험 최소 Xe·대표점) — 요약과 레버 문단이 **같은 계산 한 벌**을 쓴다.
       두 곳에서 따로 계산하면 언젠가 어긋난 두 "최적"이 화면에 공존하게 된다. */
    let hq = null;
    if (doOpt) {
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
        bound: Math.abs(xeBand - xeFree) > 1e-9,
      };
    }

    /* ----- 요약 — 「그래서 얼마인데?」의 답 한 표 (기능 1) ----- */
    const sumBox = $("#alloc-summary");
    sumBox.textContent = "";
    if (acct) {
      sumBox.append(el("div", { class: "card-title" }, "현재 vs 참고치 — 경제 관점 전용"),
        el("div", { class: "card-sub", style: "margin-top:4px" },
          "배분·헤지 참고치는 경제(시가) 관점에서만 계산합니다 — 위 관점 버튼으로 전환하면 표가 나타납니다. " +
          "회계 관점의 진단(손익변동성·ALM 듀레이션 갭)은 아래 카드에 있습니다."));
    } else if (!doOpt) {
      sumBox.append(el("div", { class: "card-title d-up" }, "현재 vs 참고치 — 제약 모순으로 보류"),
        el("div", { class: "card-sub", style: "margin-top:4px" },
          "밴드·그룹 한도가 서로 모순되어 참고치를 계산하지 않았습니다 — 아래 경고 카드를 보십시오."));
    } else {
      const gCur = allocDurGap(st, allocAssetDuration(st, w0));
      const gKeep = allocDurGap(st, allocAssetDuration(st, wKeep));
      const hasGap = gCur != null && gKeep != null;
      const heads = ["", ...V.keys, "헤지 채권/주식", "미헤지 환노출 Xe", "수익", "위험",
                     ...(hasGap ? ["듀레이션 갭"] : [])];
      const tS = el("table", { class: "mini-table" },
        el("tr", {}, ...heads.map((h, i) => el("th", { style: i === 0 ? "text-align:left" : "" }, h))));
      const row = (name, ws, hedgeTxt, xe, mu, sig, gap, bold) => {
        const tr = el("tr", { style: bold ? "font-weight:650" : "" });
        tr.append(el("td", { style: "text-align:left" }, name));
        ws.forEach((x) => tr.append(el("td", { class: "num" }, x == null ? "–" : fmtNum(x, 1))));
        tr.append(el("td", { class: "num" }, hedgeTxt),
          el("td", { class: "num" }, xe == null ? "–" : fmtNum(xe, 2) + "%"),
          el("td", { class: "num" }, fmtNum(mu, 2) + "%"),
          el("td", { class: "num" }, fmtNum(sig, 2) + "%"));
        if (hasGap) tr.append(el("td", { class: "num" }, gap == null ? "–" : fmtNum(gap, 2) + "년"));
        tS.append(tr);
      };
      if (dirty) {
        const bw = ALLOC_ECON.map((k) => (baseE.mixEcon[k] || 0));
        row("기준(저장값)", bw, `${baseSt.h_bond}/${baseSt.h_eq}%`, baseXe * 100,
            baseMu, baseSig, hasGap ? allocDurGap(baseSt, allocAssetDuration(baseSt, baseE.w0)) : null);
      }
      row(dirty ? "지금 조정" : "현재", w0.map((x) => x * 100),
          `${st.h_bond}/${st.h_eq}%`, hq.xeCur * 100, muCur, sigCur, gCur, dirty);
      const pairTxt = hq.pair
        ? `${fmtNum(hq.pair[0] * 100, 0)}/${fmtNum(hq.pair[1] * 100, 0)}%`
        : "밴드 내 불가";
      row("참고치", wKeep.map((x) => x * 100), pairTxt, hq.xeBand * 100, muKeep, sigKeep, gKeep, true);
      const dtr = el("tr", { class: "sum-delta" });
      dtr.append(el("td", { style: "text-align:left;color:var(--ink-3)" }, "참고치 − 현재"));
      wKeep.forEach((x, i) => {
        const d = (x - w0[i]) * 100;
        dtr.append(el("td", { class: "num " + (d > 0.05 ? "d-down" : d < -0.05 ? "d-up" : "d-flat") },
          `${d > 0 ? "+" : ""}${fmtNum(d, 1)}`));
      });
      /* −0.00 방지 — 반올림해 0 이 되는 차이는 부호 없이 0 으로 적는다 */
      const z2 = (x) => (Math.abs(x) < 0.005 ? 0 : x);
      const dXe = z2((hq.xeBand - hq.xeCur) * 100), dMu = z2(muKeep - muCur), dSig = z2(sigKeep - sigCur);
      dtr.append(el("td", { class: "num" }, "→"),
        el("td", { class: "num" }, `${dXe > 0 ? "+" : ""}${fmtNum(dXe, 2)}%p`),
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
          "배분 참고치는 헤지 고정(수익 유지 ②), 헤지 참고치는 배분 고정(위험 최소 Xe의 현재값 최근접 대표점) — ",
          el("b", {}, "두 부분해이며 동시 최적해가 아닙니다"),
          "(동시해는 통화축 확장 후 제공). ",
          hq.bound ? el("b", {}, `헤지 밴드가 물고 있습니다(무제약 Xe ${fmtNum(hq.xeFree * 100, 2)}%). `) : "",
          "같은 Xe를 만드는 헤지 조합은 위험이 정확히 같습니다 — ",
          el("a", { href: "#alloc-hedge" }, "왜? ›")));
    }

    /* ----- 3칸 카드 ----- */
    cardsBox.textContent = "";
    const riskWord = acct ? "손익변동성" : "위험";
    const card = (title, mu, sig, note, warnRisk) => {
      const c = el("div", { class: "card", style: "padding:14px 16px" });
      c.append(el("div", { class: "card-title" }, title),
        el("div", { style: "font-size:20px;font-weight:700;margin:6px 0 2px" },
          `${riskWord} ${fmtNum(sig, 2)}%`,
          el("small", { style: "font-weight:400;color:var(--ink-3)" }, ` ±${fmtNum(se, 2)} (표본오차)`)),
        el("div", {}, `기대수익 ${fmtNum(mu, 2)}%`),
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
    } else if (acct) {
      /* 진단 카드: 현재 손익변동성 + ALM 듀레이션 갭. 참고치 카드는 없음 */
      cardsBox.append(card("현재 배분 — 손익변동성 (연)", muCur, sigCur,
        "손익에 인식되는 변동만 집계 — 장부가 채권의 가격변동은 포함되지 않습니다", capW(sigCur)));
      const gapCard = el("div", { class: "card", style: "padding:14px 16px" });
      /* 자산군별 듀레이션을 입력했으면 **배분에서 계산**하고, 없으면 수기 dur_asset 으로
         물러난다. 계산 경로여야 배분을 바꿀 때 갭이 따라 움직인다. */
      const dComputed = allocAssetDuration(st, E.mixEcon
        ? ALLOC_ECON.map((k) => (E.mixEcon[k] || 0) / 100) : w0);
      const dAsset = dComputed != null ? dComputed : st.dur_asset;
      if (st.dur_liab != null && dAsset != null) {
        const laR = st.la_ratio != null ? st.la_ratio : 1;
        const gap = dAsset - laR * st.dur_liab;
        gapCard.append(el("div", { class: "card-title" }, "ALM 듀레이션 갭 (표준 근사)"),
          el("div", { style: "font-size:20px;font-weight:700;margin:6px 0 2px" }, `${fmtNum(gap, 2)}년`),
          el("div", { style: "font-size:12px" },
            `갭 = 자산 ${fmtNum(dAsset, 2)} − 부채/자산 ${fmtNum(laR, 2)} × 부채 ${fmtNum(st.dur_liab, 1)}`),
          el("div", { style: "color:var(--ink-3);font-size:11.5px;margin-top:4px" },
            dComputed != null
              ? "자산 듀레이션은 자산군별 입력값과 비중으로 계산합니다 — 배분을 바꾸면 함께 움직입니다. "
              : "자산 듀레이션은 수기 입력값입니다 — 자산군별 듀레이션을 넣으면 배분에 따라 자동으로 움직입니다. ",
            `금리 +100bp 시 순자산가치 변화 ≈ ${fmtNum(-gap, 2)}%p (총자산 대비). 장부가 자산의 진짜 위험은 가격이 아니라 재투자·ALM입니다.`));
      } else {
        gapCard.append(el("div", { class: "card-title" }, "ALM 듀레이션 갭"),
          el("div", { style: "font-size:12.5px;margin-top:6px" },
            "부채 듀레이션 + (자산군별 듀레이션 또는 자산 듀레이션) + 부채/자산 비율을 입력하면 " +
            "여기서 갭과 금리 ±100bp 민감도를 보여줍니다."),
          el("div", { style: "margin-top:6px" }, el("a", { href: "#alloc-sim" }, "수기 입력 →")));
      }
      const whyCard = el("div", { class: "card", style: "padding:14px 16px" });
      whyCard.append(el("div", { class: "card-title" }, "이 관점에는 배분 참고치가 없습니다"),
        el("div", { style: "font-size:12.5px;margin-top:6px" },
          "장부가 자산은 가격변동성이 0이라 평균-분산 최적화기에 넣으면 밴드 상한까지 쏠립니다(§7.2-1). ",
          "그래서 회계 관점은 손익 변동·ALM 진단 전용이고, ",
          /* 관점을 바꾸는 동작이지 이동이 아니다 → <button>. href 없는 <a> 였을 때는
             Tab 으로 닿지 않아 키보드만으로는 경제 관점으로 넘어갈 길이 없었다. */
          el("button", { type: "button", class: "linkish",
            onclick: () => { st.view = "econ"; allocSaveState(st); renderAlloc(); } },
            "배분 참고치는 경제 관점에서 계산합니다 →")));
      cardsBox.append(gapCard, whyCard);
    } else {
      cardsBox.append(
        card("현재 배분 (입력값)", muCur, sigCur, "수기 입력(또는 예시) 그대로", capW(sigCur)),
        card("① 위험 최소 참고치", muMin, sigMin, "헤지 고정 · 밴드 안에서 위험 최소", capW(sigMin)),
        card("② 수익 유지 참고치", muKeep, sigKeep,
          st.target_ret != null ? `목표수익 ${fmtNum(target, 2)}% 입력값 기준` : "기대수익을 현재와 같게 두고 위험만 축소",
          capW(sigKeep)));
      /* ALM 듀레이션 갭 — **제약이 아니라 결과 표시**. 배분을 바꾸면 갭이 따라 움직인다. */
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

    /* ----- 레버 두 개 (경제 관점) / 진단 안내 (회계 관점) ----- */
    leverBox.textContent = "";
    if (acct) {
      leverBox.append(el("b", {}, "회계 관점에서 헤지의 방향은 하나뿐입니다"), el("br"),
        "장부가 해외채권은 상쇄해줄 가격변동이 손익에 없어 ",
        el("b", {}, "헤지 100%가 언제나 손익변동 최소"),
        "입니다 — 판단 변수는 위험이 아니라 비용입니다. 현재 슬라이더 기준 손익변동성 ",
        `${fmtNum(sigCur, 2)}%. `,
        el("a", { href: "#alloc-hedge", style: "margin-left:6px" }, "헤지 곡면 상세 ›"),
        el("span", { style: "color:var(--ink-3)" }, " · 배분을 바꾸는 판단(레버 2)은 경제 관점에서 하십시오."));
    } else if (infeas.length) {
      leverBox.append(el("b", {}, "제약 모순으로 레버 계산을 보류했습니다"),
        " — 위 카드의 항목을 수기 입력에서 고치면 자동으로 다시 계산됩니다.");
    } else {
      /* 헤지 레버의 자유도는 실질 1개(총 미헤지 환노출 Xe)다 — 한 점을 "최적"이라
         적으면 무한한 동점 중 하나를 임의로 고른 것이 된다. 수치는 위 요약과 같은
         계산 한 벌(hq)이다 — 여기는 그 숫자가 왜 그런지를 설명하는 자리다. */
      leverBox.append(el("b", {}, "레버는 두 개뿐입니다 — 겹쳐 세지 마십시오"), el("br"),
        "· ", el("b", {}, "레버 1 (배분 고정, 헤지만 이동)"),
        " — 위험이 보는 것은 헤지비율 2개가 아니라 ",
        el("b", {}, "총 미헤지 환노출 Xe 하나뿐"), "입니다(총자산 대비). ",
        `현재 Xe ${fmtNum(hq.xeCur * 100, 2)}% → 위험 최소 Xe ${fmtNum(hq.xeBand * 100, 2)}%: `,
        `위험 ${fmtNum(sigCur, 2)}→${fmtNum(hq.sBand, 2)}%. `,
        hq.pair
          ? el("span", {}, "같은 Xe 를 만드는 조합은 무수히 많고 ",
              el("b", {}, "위험이 정확히 같습니다"),
              ` — 현재값에 가장 가까운 대표점은 (채권 ${fmtNum(hq.pair[0] * 100, 0)}%, 주식 ${fmtNum(hq.pair[1] * 100, 0)}%)입니다.`)
          : el("b", {}, "다만 이 Xe 는 지금 밴드 안에서 만들 수 없습니다 — 밴드를 확인하십시오."),
        hq.bound ? el("b", {}, ` ⚠ 밴드가 물고 있습니다(무제약 최소 Xe ${fmtNum(hq.xeFree * 100, 2)}%).`) : "",
        el("a", { href: "#alloc-hedge", style: "margin-left:6px" }, "헤지 곡면 상세 ›"), el("br"),
        "· ", el("b", {}, "레버 2 (헤지 고정, 배분만 이동)"),
        ` — 같은 기대수익 ${fmtNum(target, 2)}%를 유지하며 위험 ${fmtNum(sigCur, 2)}→${fmtNum(sigKeep, 2)}% (±표본오차 ${fmtNum(se, 2)}%p 병기 · 매매회전 ${fmtNum(turnover, 1)}%p).`,
        el("a", { href: "#alloc-boot", style: "margin-left:6px" }, "표본을 다시 뽑으면? ›"));
    }

    /* ----- 자산군 표 ----- */
    tableCard.textContent = "";
    tableCard.append(el("div", { class: "card-head" },
      el("span", { class: "card-title" }, `자산군 표 — ${acct ? "회계(손익)" : "경제(시가)"} 관점`),
      el("span", { class: "card-sub" },
        acct
          ? `대출금 ${fmtNum(st.loan_w, 1)}%·수익률 ${fmtNum(st.loan_y, 1)}%는 준고정 · 이 관점은 진단 전용 — 참고치 열이 없습니다(§7.2-1)`
          : `대출금 ${fmtNum(st.loan_w, 1)}%·수익률 ${fmtNum(st.loan_y, 1)}%는 준고정이라 최적화에서 제외 · ⚠ = 밴드 경계에 붙음`)));
    const { rc: rcCur } = E.eulerRC(w0, V.C);
    const rcKeep = doOpt ? E.eulerRC(wKeep, V.C).rc : null;
    const heads = acct
      ? ["자산군", "현재%", "기대수익%", "손익변동성%", "손익변동 기여", "출처"]
      : ["자산군", "현재%", "참고치%(②)", "차이", "기대수익%", "위험%", "위험기여 현재→참고", "밴드", "출처"];
    const t = el("table", { class: "mini-table" },
      el("tr", {}, ...heads.map((h, i) => el("th", { style: i === heads.length - 1 ? "text-align:left" : "" }, h))));
    V.keys.forEach((k, i) => {
      const cur = w0[i] * 100;
      const sig_i = Math.sqrt(Math.max(V.C[i][i], 0));
      if (acct) {
        t.append(el("tr", {},
          el("td", {}, el("a", { href: `#alloc-a-${i}` }, k)),
          el("td", { class: "num" }, fmtNum(cur, 1)),
          el("td", { class: "num" }, fmtNum(V.mu[i], 2)),
          el("td", { class: "num" }, fmtNum(sig_i, 2)),
          el("td", { class: "num" }, fmtNum(rcCur[i], 2)),
          el("td", { style: "text-align:left;color:var(--ink-3);font-size:11.5px" }, allocSrcTag(k))));
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
        el("td", { style: "text-align:left;color:var(--ink-3);font-size:11.5px" }, allocSrcTag(k))));
    });
    tableCard.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t),
      el("div", { class: "card-sub", style: "margin-top:6px" },
        acct
          ? "손익변동 기여 = 오일러 분해(합계 = 총 손익변동성). 장부가 국내채권 행이 0인 것이 정상입니다 — 가격변동이 손익에 오지 않기 때문이며, 그 위험(재투자·ALM)은 위 듀레이션 갭 카드에서 봅니다."
          : "위험기여 = 오일러 분해(합계 = 총위험). 행 이름을 클릭하면 그 자산군의 산식 전개로 이동합니다."));

    /* ----- 상시 노출 — 이 숫자는 어디서 왔나 ----- */
    const R = A.rates;
    inputsBox.textContent = "";
    inputsBox.append(el("b", {}, "이 숫자는 어디서 왔나 — 관측 / 선택 / 가정"), el("br"),
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
      `· [가정] 대체투자 α +${fmtNum(st.alt_alpha, 1)}%p·위험 ${fmtNum(st.alt_vol, 0)}% (평가 스무딩 탓에 실측 σ는 과소평가) · 가중평균 스왑 만기 ${st.tenor_m}개월(3·6·12·12M+ 혼합의 금액가중 — 비용 보간과 MTM 잔존만기에 사용) · 북일드 ${st.by_kr != null ? "입력값" : "미입력 — 시장금리 대체"} — 전부 수기 입력에서 바꿀 수 있습니다`);

    /* ----- 차트 2개 (드래그 중에는 미루고 놓으면 갱신) ----- */
    if (!doOpt) {
      /* 최적화 산출물(투자선·이행경로)은 경제 관점 + 실행 가능 제약에서만 */
      clearTimeout(chartTimer);
      allocCharts.forEach(destroyChart);
      allocCharts = [];
      const why = acct
        ? "회계 관점에는 없습니다 — 장부가 자산(가격변동 0)을 평균-분산 최적화에 넣지 않기 때문입니다(§7.2-1). 경제 관점으로 전환하면 표시됩니다."
        : "제약이 서로 모순되어 계산을 보류했습니다 — 수기 입력에서 밴드·그룹 한도를 고치십시오.";
      [["효율적 투자선", frontierCard], ["이행 경로", pathCard]].forEach(([title, box]) => {
        box.textContent = "";
        box.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, `${title} — 경제 관점 전용`)),
          el("div", { class: "card-sub" }, why));
      });
    } else if (withCharts) {
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
    el("b", {}, "배분 참고치(①②·투자선·이행경로)는 경제 관점 전용"),
    "입니다 — 장부가 자산은 가격변동성이 0이라 평균-분산 최적화기에 넣지 않고(§7.2-1), 회계 관점은 손익 변동·오일러 기여·ALM 듀레이션 갭 진단 전용입니다. ",
    "해외자산 원화수익률 = 현지수익률 + (1−헤지비율)×환율변동 + 헤지비율×스왑레이트, 장부가 해외채권 손익은 환헤지 화면의 5항 회계 모형과 동일 산식."));
  mth.append(el("p", {}, el("b", {}, "기대수익"),
    " — 채권·현금은 현재 시장금리 [관측]. 주식은 손으로 ERP를 정하지 않고, 채권 시장이 지금 위험 1단위에 주는 보상(샤프)을 관측해 주식 σ에 곱합니다(동일 샤프 앵커 — 자유 모수 0개). 역사적 실현 평균은 기대수익으로 쓰지 않습니다(표본 구간을 고른 사람이 답을 고르게 되므로). 환율 기대변동은 0(랜덤워크)."));
  (A.acct_model || []).forEach((s) => mth.append(el("div", { style: "font-size:12.5px" }, s)));
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

    form.append(secHead("① 자산군 비중 (%) — 회계 구분 기준으로 입력하면 경제 관점은 자동 합산"));
    const tw = el("table", { class: "grid-inp" },
      el("tr", {}, ...["자산군", "비중%", "밴드 하한", "밴드 상한"].map((h) => el("th", {}, h))));
    ALLOC_ACCT.forEach((k) => {
      tw.append(el("tr", {},
        el("td", {}, k),
        el("td", {}, numIn(`mix:${k}`, st.mix_acct[k], 0.1)),
        el("td", {}, numIn(`blo:${k}`, (st.bands_acct[k] || [0, 100])[0], 1)),
        el("td", {}, numIn(`bhi:${k}`, (st.bands_acct[k] || [0, 100])[1], 1))));
    });
    form.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, tw));
    form.append(el("div", { class: "section-note" },
      "경제 관점 밴드(국내채권=장부+시가 합산 등)는 아래에 따로 입력합니다."));
    const tw2 = el("table", { class: "grid-inp" },
      el("tr", {}, ...["자산군(경제)", "밴드 하한", "밴드 상한"].map((h) => el("th", {}, h))));
    ALLOC_ECON.forEach((k) => {
      tw2.append(el("tr", {}, el("td", {}, k),
        el("td", {}, numIn(`elo:${k}`, (st.bands[k] || [0, 100])[0], 1)),
        el("td", {}, numIn(`ehi:${k}`, (st.bands[k] || [0, 100])[1], 1))));
    });
    form.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, tw2));

    form.append(secHead("② 대출금·제약"));
    form.append(el("div", { class: "tenor-row" },
      "약관대출 비중 %", numIn("loan_w", st.loan_w, 0.1),
      " 수익률 %", numIn("loan_y", st.loan_y, 0.1),
      " | 해외 합계 상한 %", numIn("cap_foreign", st.cap_foreign, 1, "없음"),
      " 주식 합계 상한 %", numIn("cap_equity", st.cap_equity, 1, "없음")));
    form.append(el("div", { class: "tenor-row" },
      "목표수익률 %", numIn("target_ret", st.target_ret, 0.05, "미입력=현재 유지"),
      " 위험한도 %", numIn("risk_cap", st.risk_cap, 0.05, "없음")));

    form.append(secHead("③ 장부가·ALM (회계 관점용)"));
    form.append(el("div", { class: "tenor-row" },
      "북일드 국내 %", numIn("by_kr", st.by_kr, 0.05, `미입력=${A.rates.kr5y.v}`),
      " 북일드 해외 %", numIn("by_fx", st.by_fx, 0.05, `미입력=${A.rates.us_ytm.v}`),
      " 장부채권 잔존만기(월)", numIn("book_mat_m", st.book_mat_m, 1, "차기 반영"),
      el("span", { class: "section-note", style: "margin-left:6px" },
        "잔존만기는 지금 수집만 합니다 — 재투자 위험 재정의(§7.2-1 차기)에 쓸 예정이며, 현재 계산에는 들어가지 않습니다.")));
    form.append(el("div", { class: "tenor-row" },
      "부채 듀레이션(년)", numIn("dur_liab", st.dur_liab, 0.1),
      " 자산 듀레이션(년)", numIn("dur_asset", st.dur_asset, 0.1, "자산군별 입력 시 무시"),
      " 부채/자산 비율", numIn("la_ratio", st.la_ratio, 0.01, "예: 0.9")));
    form.append(el("div", { class: "tenor-row" },
      "자산군별 듀레이션(년) — 국내채권", numIn("dby:국내채권", (st.dur_by || {})["국내채권"], 0.1, "미입력"),
      " 해외채권", numIn("dby:해외채권", (st.dur_by || {})["해외채권"], 0.1, "미입력"),
      " 단기자금", numIn("dby:단기자금", (st.dur_by || {})["단기자금"], 0.1, "미입력")));
    form.append(el("div", { class: "section-note" },
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
    form.append(el("div", { class: "section-note" },
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
    form.append(el("div", { class: "section-note" },
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
    form.append(el("div", { class: "section-note" },
      "여기 값은 **공개 벤치마크**이며 귀 기관 실제 비중이 아닙니다 — 실제 값을 넣으시면 " +
      "이 브라우저에만 저장되고 저장소·페이지에는 올라가지 않습니다. " +
      "합계를 100%로 강제하지 않습니다: 모형이 덮는 범위를 그대로 보이게 두는 편이 낫기 때문입니다."));

    const btnRow = el("div", { style: "margin-top:12px;display:flex;gap:10px" });
    btnRow.append(
      el("button", { class: "btn-primary", onclick: () => {
        fields.forEach(([key, i]) => {
          const v = i.value === "" ? null : +i.value;
          if (key.startsWith("mix:")) { if (v != null) st.mix_acct[key.slice(4)] = v; }
          else if (key.startsWith("blo:")) { st.bands_acct[key.slice(4)][0] = v == null ? 0 : v; }
          else if (key.startsWith("bhi:")) { st.bands_acct[key.slice(4)][1] = v == null ? 100 : v; }
          else if (key.startsWith("elo:")) { st.bands[key.slice(4)][0] = v == null ? 0 : v; }
          else if (key.startsWith("ehi:")) { st.bands[key.slice(4)][1] = v == null ? 100 : v; }
          else if (key.startsWith("hlo:")) { st.h_bands[key.slice(4)][0] = v == null ? 0 : v; }
          else if (key.startsWith("hhi:")) { st.h_bands[key.slice(4)][1] = v == null ? 100 : v; }
          else if (key.startsWith("htol:")) { st.h_tol_hi[key.slice(5)] = v; }
          else if (key.startsWith("dby:")) { st.dur_by[key.slice(4)] = v; }
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
        if (st.loan_w == null) st.loan_w = A.defaults.loan_w;
        if (st.loan_y == null) st.loan_y = A.defaults.loan_y;
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
      el("span", { class: "card-sub" }, "기대수익이 변하는 것은 해외자산의 비용항(헤지비율 × 스왑레이트)뿐이어야 합니다")));
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
        "앵커·국내주식·해외주식 열은 채권 헤지비율과 무관하게 일정하고, 해외채권 열만 비용항(헤지비율×스왑레이트)만큼 움직입니다. " +
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
      Math.abs(xeBand - xeFree) > 1e-9
        ? el("b", {}, `밴드가 물고 있습니다 — 무제약 최소 Xe 는 ${fmtNum(xeFree * 100, 2)}%입니다. `) : "",
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
      el("tr", {}, ...["읽기", "값", "출처", ...ALLOC_ECON.map((k) => k.slice(0, 4)), "위험%"].map((h) => el("th", {}, h))));
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
    /* 참고치는 경제 관점 전용(§7.2-1) — 회계 관점에서 열어도 경제 기준으로 보여준다 */
    const Ee = E.view === "acct" ? allocEngine(A, { ...st, view: "econ" }) : E;
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "참고치가 밴드 경계에 붙어 있으면, 그 숫자는 모형이 아니라 제약이 정한 것입니다"),
      el("div", { class: "a" }, "⚠ 표시 = 경계에 붙음 ",
        el("small", {}, "참고치는 경제 관점 전용이므로 이 표도 경제 관점 기준입니다"))));
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
    const lines = [];
    const row = E.V.rows[i];
    const parts = [];
    A.sources.labels.forEach((l, j) => {
      if (Math.abs(row[j]) > 1e-12) parts.push(`${row[j] >= 0 ? "+" : "−"} ${fmtNum(Math.abs(row[j]), 3)} × ${l}`);
    });
    lines.push(`재조립: ${k} = ${parts.length ? parts.join(" ") : "상수 (위험 0 — 장부가·유효이자만)"}`);
    lines.push(`기대수익 ${fmtNum(E.V.mu[i], 2)}% — ${allocSrcTag(k)}`);
    lines.push(`위험(연) ${fmtNum(sig_i, 2)}% · 표본 ${E.set.start}~${E.set.end} (${E.set.n_months}개월)`);
    const inner2 = el("div", { class: "card" });
    inner2.append(el("div", { class: "card-head" }, el("span", { class: "card-title" }, "산식 전개 (원천 → 자산군)")));
    lines.forEach((s) => inner2.append(el("div", { style: "font-size:12.5px;padding:2px 0" }, s)));
    inner2.append(el("div", { class: "card-sub", style: "margin-top:6px" },
      "원천 정의: " + A.sources.labels.map((l) => `${l} = ${desc[l] || ""}`).join(" · ")));
    inner.append(inner2);
    if (k.includes("장부가") && st.dur_liab != null && st.dur_asset != null) {
      const gap = st.dur_asset - (st.la_ratio != null ? st.la_ratio : 1) * st.dur_liab;
      inner.append(el("div", { class: "howto", style: "margin-top:12px" },
        el("b", {}, "ALM 듀레이션 갭"),
        ` — 자산 ${fmtNum(st.dur_asset, 1)}년 − 부채/자산 ${fmtNum(st.la_ratio != null ? st.la_ratio : 1, 2)} × 부채 ${fmtNum(st.dur_liab, 1)}년 = ${fmtNum(gap, 2)}년. `,
        "양수면 금리 하락 시 순자산 증가(자산이 더 길다). 장부가 자산의 진짜 위험은 가격이 아니라 재투자·ALM이며, 다음 단계에서 위험 재정의(§7.2-1)에 반영합니다."));
    }
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  hideDetail();
}

/* ---------------- render all / boot ---------------- */

/* 섹션 id → 그 섹션을 그리는 함수. SECTION_IDS 와 1:1 이며 계약 테스트가 강제한다.
   순서는 화면 순서(마을 구역 순)와 같게 둔다 — 읽는 사람이 대조하기 쉽게. */
const RENDERERS = {
  overview: renderOverview, risk: renderRisk, events: renderEvents,
  panel: renderPanel, hedge: renderHedge, alloc: renderAlloc,
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
