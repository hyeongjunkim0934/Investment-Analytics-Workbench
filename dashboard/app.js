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

function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  for (const c of children) {
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

function baseAxes(pal, yFmt) {
  return [
    {
      stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
      ticks: { show: false },
    },
    {
      stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
      ticks: { show: false }, size: 56,
      values: (u, vals) => vals.map((v) => yFmt(v)),
    },
  ];
}

function makeTimeChart(box, cfg) {
  /* cfg: {labels, colors, data, dec, unit, fill, stepped, bars, height} */
  const pal = palette();
  const dec = cfg.dec ?? 2;
  const h = cfg.height ?? 260;
  const yFmt = (v) => fmtNum(v, v != null && Math.abs(v) >= 1000 ? 0 : dec);

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
    axes: baseAxes(pal, yFmt),
    legend: { live: true },
  };

  const u = new uPlot(opts, cfg.data, box);

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

  tsCard($("#card-hedge-ts"), d.hedge_ts, {
    title: "달러/원 헤지 프리미엄", sub: "%", unit: "%", dec: 2,
  });

  const hcard = $("#card-hedge-table");
  hcard.textContent = "";
  hcard.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "환헤지 프리미엄(연율)"),
    el("span", { class: "card-sub" }, (d.hedge && d.hedge[0] && d.hedge[0].date) || "")));
  const rows = (d.hedge || []).map((h) =>
    el("tr", {}, el("td", {}, h.label),
      ...["3M", "6M", "12M"].map((k) =>
        el("td", { class: "num" }, h[k] == null ? "–" : fmtNum(h[k], 2) + "%"))));
  hcard.append(el("div", { class: "table-wrap" },
    el("table", { class: "mini-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "통화"),
        el("th", {}, "3개월"), el("th", {}, "6개월"), el("th", {}, "12개월"))),
      el("tbody", {}, ...rows))));
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
    const box = cardScaffold(card, {
      title: it.label,
      sub: `최근 ${fmtNum(it.last, 2)}${it.unit === "%" ? "%" : ""} (${it.date})`,
      csvName: `${it.label}.csv`,
      tableFn: tsTableFn([it.label], data, 2),
    });
    makeTimeChart(box, {
      labels: [it.label], colors: [pal.series[i % 8]], data,
      dec: 2, unit: it.unit === "%" ? "%" : "", height: 190, bars: true,
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
  const warn = (m.warnings && m.warnings.length)
    ? ` · 경고 ${m.warnings.length}건(콘솔 참조)` : "";
  $("#build-line").textContent =
    `빌드 ${m.built_at_kst} (${m.built_at_utc}) · 원본 파일 ${m.files.length}개 · 시리즈 ${m.series_count}개${warn}`;
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
           el("span", {}, e.title),
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
      el("span", { class: "chev" }, "›"));
    return row;
  }
  const row = el("div", { class: "fr", onclick: () => { location.hash = `detail-${f.key}`; } });
  const sparkWrap = el("span", { class: "spark-wrap" },
    sparkSVG(withToday(f.hist, asofTs, f.score), palette().accent));
  row.append(
    el("span", { class: "nm" }, f.name, el("small", {}, f.sub)),
    sparkWrap,
    el("span", { class: "dl" }, deltaPts(f.delta)),
    el("span", { class: "sc" }, String(Math.round(f.score))),
    el("span", { style: "text-align:right" }, gradeChip(f.grade)),
    el("span", { class: "chev" }, "›"));
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
    const kpi = el("div", { class: "kpi kpi-risk", style: "cursor:pointer",
      onclick: () => { location.href = "#risk"; } });
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
    gb.append(el("div", { style: `flex:1;background:${hexA(c, 0.85)}` }, `${nm} (${lo}–${hi})`)));
  hw.append(gb);

  const em = $("#risk-events-mini");
  em.textContent = "";
  const emHead = el("div", { class: "card-head" }, el("span", { class: "card-title" }, "최근 이벤트"));
  emHead.append(el("a", { href: "#events",
    style: "margin-left:auto;font-size:12px;color:var(--accent);text-decoration:none" }, "전체 보기 →"));
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
    return el("span", { class: on ? "on" : "", onclick: () => {
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

function hideDetail() {
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  const ov = $("#detail-overlay");
  ov.hidden = true;
  ov.textContent = "";
  document.body.style.overflow = "";
}

function openDetail(key) {
  const r = DATA.risk;
  const f = r && r.factors.find((x) => x.key === key);
  if (!f || f.pending || f.score == null) { hideDetail(); return; }
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  const layer = r.layers[f.layer];
  const asofTs = Math.floor(Date.parse(r.asof + "T00:00:00Z") / 1000);
  const pal = palette();
  const ov = $("#detail-overlay");
  ov.textContent = "";
  ov.hidden = false;
  document.body.style.overflow = "hidden";
  const inner = el("div", { class: "detail-inner" });
  ov.append(inner);

  const back = el("a", { onclick: () => { location.hash = "risk"; } }, "‹ 리스크로 돌아가기");
  inner.append(el("div", { class: "crumb" }, back, ` / ${layer.name} / ${f.name}`));

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
  ov.scrollTop = 0;
}

function handleHash() {
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
    pickWrap.append(el("span", {
      class: "vchip", style: on ? "border-color:var(--accent);color:var(--ink-1)" : "opacity:.6;cursor:pointer",
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

function fmtCost(x) {
  if (x == null) return el("span", { class: "d-flat" }, "—");
  return el("span", { class: x < 0 ? "neg" : "pos" }, `${x > 0 ? "+" : ""}${fmtNum(x, 2)}%`);
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
      baseAxes(pal, (v) => fmtNum(v, unit === "" ? 1 : 0) + unit)[1],
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
  const u = new uPlot(cfg, [xs, ...seriesDefs.map((sd) => sd.v)], box);
  const ro = new ResizeObserver(() => u.setSize({ width: Math.max(280, box.clientWidth), height }));
  ro.observe(box);
  return trackChart(u, ro);
}

function renderHedge() {
  const H2 = DATA.hedge;
  if (!$("#hedge")) return;
  if (!H2 || !H2.matrix) {
    $("#hedge-headline").textContent = "환헤지 데이터를 불러오지 못했습니다.";
    return;
  }
  const pal = palette();

  const hl = $("#hedge-headline");
  hl.textContent = "";
  hl.append(el("div", { class: "q" }, "이 화면이 답하는 질문"));
  const a = el("div", { class: "a" }, "통화별 환오픈을 얼마나 둘 것인가 ");
  a.append(el("small", {}, "관점에 따라 답이 다릅니다 — 경제 관점: 채권 88~102% · 주식 10~30% / 회계 관점(장부가): 100%가 손익변동 최소, 판단 변수는 비용"));
  hl.append(a);

  const hv = $("#hedge-views");
  hv.textContent = "";
  hv.append(el("b", {}, "두 관점, 두 참고치"), el("br"),
    "· ", el("b", {}, "경제(시가) 관점"), " — 자산가격과 환율의 상쇄(자연 쿠션)까지 반영한 최소분산 헤지비율(MVH). 위기 때 환율 급등이 주가 하락을 상쇄하므로 주식은 낮은 헤지가 변동성 최소.", el("br"),
    "· ", el("b", {}, "회계(손익) 관점"), " — 장부가 채권은 가격변동이 손익에 안 오지만 환산손익·FX스왑 손익·스왑레이트는 손익 직행. 상쇄해줄 상대가 없어 손익변동 최소는 언제나 헤지 100%이고, 남는 변동은 스왑 MTM뿐입니다.");

  const mx = $("#hedge-matrix");
  mx.textContent = "";
  mx.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "통화 매트릭스 (7통화)"),
    el("span", { class: "card-sub" }, `채권 MVH = 경제 관점 참고치 · 비용 양수 = 프리미엄 수취 · 기준일 ${H2.asof}`)));
  const t = el("table", { class: "mini-table" },
    el("tr", {}, ...["통화", "환변동성(연)", "채권 MVH(경제)", "환-채권 상관", "헤지비용(12M)", "근거"]
      .map((h, i) => el("th", { style: i === 5 ? "text-align:left" : "" }, h))));
  H2.matrix.forEach((m) => {
    t.append(el("tr", { style: m.active ? "" : "opacity:.5" },
      el("td", {}, `${m.name} (${m.c})`),
      el("td", { class: "num" }, `${m.vol_e}%`),
      el("td", { class: "num" }, m.mvh != null ? el("b", {}, `${m.mvh}%`) : "—"),
      el("td", { class: "num" }, m.corr != null ? String(m.corr) : "—"),
      el("td", { class: "num" }, fmtCost(m.cost_12m)),
      el("td", { style: "text-align:left;color:var(--ink-3);font-size:11.5px" },
        `${m.src}${m.bond_kind ? " · " + m.bond_kind : ""}`)));
  });
  mx.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, t));
  const rec = H2.matrix.filter((m) => m.cost_12m != null && m.cost_12m > 0)
    .map((m) => `${m.name}(+${m.cost_12m}%)`).join("·");
  const pay = H2.matrix.filter((m) => m.cost_12m != null && m.cost_12m < 0)
    .map((m) => `${m.name}(${m.cost_12m}%)`).join("·");
  mx.append(el("div", { class: "hl-box" },
    el("b", {}, "💡 현 시점 눈에 띄는 것"),
    ` — 헤지하면 프리미엄을 받는 통화: ${rec || "없음"}. 특히 엔화 장부가 채권은 헤지 100%가 손익변동 제거 + 프리미엄 수취를 동시에 얻습니다. 비용을 내는 통화: ${pay || "없음"}.`));

  const cc = $("#hedge-curve-card");
  cc.textContent = "";
  const bMin = H2.curves.bond.indexOf(Math.min(...H2.curves.bond)) * 5;
  const eMin = H2.curves.equity.indexOf(Math.min(...H2.curves.equity)) * 5;
  const xs = Array.from({ length: 21 }, (_, i) => i * 5);
  const curveBox = cardScaffold(cc, {
    title: "헤지비율 vs 변동성 — 달러 (경제 관점)",
    sub: `변동성 최소: 채권 ${bMin}% · 주식 ${eMin}%`,
    csvName: "헤지비율-변동성.csv",
    tableFn: (cap, raw) => ({
      headers: ["헤지비율", "채권 변동성(%)", "주식 변동성(%)"],
      rows: xs.map((h, i) => [`${h}%`, H2.curves.bond[i], H2.curves.equity[i]]),
    }),
  });
  makeRatioChart(curveBox, { seriesDefs: [
    { label: "미국 채권(종합)", color: pal.series[0], x: xs, v: H2.curves.bond },
    { label: "미국 주식(S&P500 TR)", color: pal.series[1], x: xs, v: H2.curves.equity },
  ] });

  const bt = $("#hedge-bt-card");
  bt.textContent = "";
  bt.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "백테스트 — 달러자산 헤지비율별"),
    el("span", { class: "card-sub" }, Object.values(H2.backtest)[0].period)));
  const bthead = el("tr", {}, ...["자산", "헤지", "CAGR", "변동성", "MDD"].map((h) => el("th", {}, h)));
  const btt = el("table", { class: "mini-table" }, bthead);
  Object.entries(H2.backtest).forEach(([name, b]) => {
    b.rows.forEach((r, i) => {
      const tr = el("tr", {});
      if (i === 0) tr.append(el("td", { rowspan: "3" }, name));
      tr.append(el("td", { class: "num" }, `${r.h}%`), el("td", { class: "num" }, `${r.cagr}%`),
                el("td", { class: "num" }, `${r.vol}%`), el("td", { class: "num" }, `${r.mdd}%`));
      btt.append(tr);
    });
  });
  bt.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, btt),
    el("div", { class: "card-sub", style: "margin-top:6px" },
      "주식 완전 헤지는 MDD를 키웁니다(위기 시 환쿠션 상실) — 헤지비용은 3M 스왑레이트 실측 반영."));

  const cost = $("#hedge-cost-card");
  cost.textContent = "";
  const cs = H2.cost_stats;
  const costBox = cardScaffold(cost, {
    title: "달러 헤지비용 25년 (3M 스왑레이트, 연율)",
    sub: `평균 ${cs.mean > 0 ? "+" : ""}${cs.mean}% · 현재 ${cs.now}% · 최악(2008) ${cs.min}%`,
    csvName: "달러-스왑레이트.csv",
    tableFn: tsTableFn(["스왑레이트(%)"], [H2.cost_hist_usd.t, H2.cost_hist_usd.v], 2),
  });
  makeTimeChart(costBox, { labels: ["3M 스왑레이트"], colors: [pal.series[0]],
    data: [H2.cost_hist_usd.t, H2.cost_hist_usd.v], dec: 2, unit: "%", fill: true, height: 230 });

  const mtm = $("#hedge-mtm-card");
  mtm.textContent = "";
  mtm.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "스왑 MTM — 만기의 트레이드오프"),
    el("span", { class: "card-sub" }, "기체결 스왑의 평가손익 (회계 손익에 인식)")));
  const mt = el("table", { class: "mini-table" },
    el("tr", {}, ...["롤 만기", "MTM 변동성(연, 명목 대비)", "2008년 최악의 달"].map((h) => el("th", {}, h))));
  [[3, 0.125], [6, 0.25], [9, 0.375], [12, 0.5]].forEach(([m, tau]) => {
    const vol = (tau * H2.mtm.sigma_ds_3m * Math.sqrt(12)).toFixed(2);
    const worst = (tau * Math.abs(H2.mtm.worst_ds)).toFixed(2);
    mt.append(el("tr", { style: m === 9 ? "font-weight:700" : "" },
      el("td", {}, `${m}개월${m === 9 ? " (현재 평균)" : ""}`),
      el("td", { class: "num" }, `${vol}%`), el("td", { class: "num" }, `${worst}%`)));
  });
  mtm.append(el("div", { class: "table-wrap", style: "max-height:none;border:0" }, mt),
    el("div", { class: "card-sub", style: "margin-top:6px" },
      `긴 만기 = 캐리 오래 고정(롤 리스크↓), MTM 변동↑. 평가손실은 스왑레이트 상승 시 발생 — 월간 σ ${H2.mtm.sigma_ds_3m}%p, 최대 급등(=최대 평가손) +${H2.mtm.worst_ds}%p (${H2.mtm.worst_date}), 환율과 상관 ${H2.mtm.corr_ds_e}.`));

  const mth = $("#hedge-method");
  mth.textContent = "";
  mth.append(el("summary", {}, "산식 · 회계 모형 · 한계 (방법론)"));
  mth.append(el("p", {}, el("b", {}, "회계 손익 모형 (장부가 해외채권 + FX스왑)")));
  (H2.acct_model || []).forEach((s) => mth.append(el("div", { style: "font-size:12.5px" }, s)));
  mth.append(el("p", {}, el("b", {}, "경제 관점"),
    " — 원화수익 = 자산수익 + (1−h)×환율변화 + h×스왑레이트. MVH = 1 + Cov(자산,환율)/Var(환율). ",
    `공분산 표본 ${H2.sim.sample} (${H2.sim.n_months}개월).`));
  mth.append(el("p", {}, el("b", {}, "한계"), ` — ${H2.limits}`));
}

/* ---------------- 환헤지 시뮬레이터 (오버레이) ---------------- */

const HEDGE_LS_KEY = "iaw-hedge-input";

function hedgeRows(H2) {
  const rows = [];
  H2.matrix.forEach((m) => {
    if (m.c === "USD") {
      rows.push({ id: "USD_b", cur: "USD", kind: "bond", name: "달러 — 채권",
                  ref: `경제 ${m.mvh}% · 회계 100%`, amt: 5000, book: 70, h: 90 });
      rows.push({ id: "USD_e", cur: "USD", kind: "eq", name: "달러 — 해외주식(ACWI)",
                  ref: "경제 10~30%", amt: 3000, book: null, h: 30 });
    } else {
      rows.push({ id: m.c + "_b", cur: m.c, kind: "bond", name: `${m.name} — 채권`,
                  ref: m.active ? `경제 ${m.mvh}% · 회계 100%` : "데이터 확보 전",
                  amt: m.active ? 0 : 0, book: 100, h: 100, dis: !m.active });
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
  const ov = $("#detail-overlay");
  ov.textContent = "";
  ov.hidden = false;
  document.body.style.overflow = "hidden";
  const inner = el("div", { class: "detail-inner" });
  ov.append(inner);

  const back = el("a", { onclick: () => { location.hash = "hedge"; } }, "‹ 환헤지 기본 화면");
  inner.append(el("div", { class: "crumb" }, back, " / 시뮬레이터 (7통화)"));
  const hl = el("div", { class: "qa" });
  hl.append(el("div", { class: "q" }, "이 화면이 하는 일"));
  hl.append(el("div", { class: "a" }, "우리 포트폴리오 숫자로 통화별 헤지비율을 바꿔보기 ",
    el("small", {}, "입력값은 이 브라우저에만 저장되며 서버로 전송되지 않습니다")));
  inner.append(hl);

  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(HEDGE_LS_KEY)) || {}; }
    catch { return {}; }
  })();
  const rows = hedgeRows(H2).map((r) => ({ ...r, ...(saved.rows && saved.rows[r.id]) }));
  const tenor0 = saved.tenor || H2.default_tenor_m;

  const panel = el("div", { class: "card" });
  panel.append(el("div", { class: "card-head" },
    el("span", { class: "card-title" }, "통화·자산별 입력과 헤지비율"),
    el("span", { class: "card-sub" }, "장부가 비중 = 채권 중 만기보유 비율(회계 관점 계산용) · 파란 글씨 = 참고치")));
  const grid = el("table", { class: "grid-inp" },
    el("tr", {}, ...["자산 (통화)", "금액(억)", "장부가 비중", "헤지비율"].map((h) => el("th", {}, h))));
  const inputs = {};
  rows.forEach((r) => {
    const tr = el("tr", { class: r.dis ? "dis" : "" });
    const amt = el("input", { type: "number", id: `hg-a-${r.id}`, value: String(r.amt), min: "0" });
    const book = r.book != null
      ? el("input", { type: "number", id: `hg-q-${r.id}`, value: String(r.book), min: "0", max: "100" })
      : null;
    const slider = el("input", { type: "range", id: `hg-h-${r.id}`, value: String(r.h), min: "0", max: "100", step: "5" });
    const hlbl = el("span", { class: "hlbl" }, `${r.h}%`);
    if (r.dis) { amt.disabled = true; if (book) book.disabled = true; slider.disabled = true; }
    inputs[r.id] = { amt, book, slider, hlbl, cfg: r };
    tr.append(
      el("td", {}, r.name, el("span", { class: "refbadge" }, r.ref)),
      el("td", {}, amt),
      el("td", {}, book ? book : el("span", { style: "color:var(--ink-3)" }, "—"), book ? "%" : ""),
      el("td", {}, slider, hlbl));
    grid.append(tr);
  });
  panel.append(el("div", { class: "table-wrap", style: "max-height:none;border:0;overflow:visible" }, grid));
  const tenorInput = el("input", { type: "number", id: "hg-tenor", value: String(tenor0), min: "3", max: "12" });
  panel.append(el("div", { class: "tenor-row" },
    el("b", {}, "스왑 평균 만기"), tenorInput, "개월",
    el("span", { style: "color:var(--ink-3);font-size:12px" },
      "— 캐리 고정 기간과 MTM 민감도(잔존만기 = 만기/2)에 반영. 현재 실무 평균 9개월")));
  const resetBtn = el("button", { class: "theme-btn", style: "width:auto;padding:0 14px;font-size:12.5px",
    onclick: () => { localStorage.removeItem(HEDGE_LS_KEY); location.reload(); } }, "입력 초기화");
  panel.append(el("div", { style: "margin-top:8px" }, resetBtn));
  inner.append(panel);

  const res = el("div", { class: "res" });
  const tile = (id, label, note) => {
    const d = el("div", { class: "rt" });
    d.append(el("div", { class: "l" }, label), el("div", { class: "v", id }, "–"),
             el("div", { class: "n" }, note));
    return d;
  };
  res.append(
    tile("hg-econ", "경제 관점 변동성 (연)", "시가 기준 · 자연 쿠션 반영"),
    tile("hg-acct", "회계 관점 손익변동성 (연)", "장부가 채권: 환산손익+스왑 MTM만 반영"),
    tile("hg-carry", "연간 헤지 캐리", "Σ 금액 × 헤지비율 × 스왑레이트(만기 보간)"));
  inner.append(res);

  const note = el("div", { class: "howto", style: "margin-top:14px" });
  note.append(el("b", {}, "확인해볼 것"),
    " — ① 엔 채권 헤지를 0%로: 회계 변동성과 캐리가 함께 나빠집니다. ② 달러 주식 헤지를 100%로: 경제 변동성이 오히려 커집니다(자연 쿠션 상실). ③ 만기를 3→12개월로: 캐리는 오래 고정되지만 MTM 변동이 4배가 됩니다.",
    el("br"), el("b", {}, "산식"),
    ` — 회계 손익 모형 5항 분해와 공분산 표본(${H2.sim.sample})은 환헤지 화면의 방법론 패널 참조. 위안 행은 단기금리·헤지비용 데이터 확보 시 활성화됩니다.`);
  inner.append(note);

  const IX = Object.fromEntries(H2.sim.labels.map((l, i) => [l, i]));
  const COV = H2.sim.cov;
  const N = H2.sim.labels.length;
  const mmap = Object.fromEntries(H2.matrix.map((m) => [m.c, m]));

  function recalc(save = true) {
    const tenor = Math.min(12, Math.max(3, +tenorInput.value || 9));
    const tau = tenor / 24;                       // 평균 잔존만기 (년)
    const xe = new Array(N).fill(0), xa = new Array(N).fill(0);
    let tot = 0, carry = 0;
    const state = { rows: {}, tenor };
    for (const [id, o] of Object.entries(inputs)) {
      const r = o.cfg;
      const A = Math.max(0, +o.amt.value || 0);              // 음수 입력 차단
      const h = Math.min(1, Math.max(0, (+o.slider.value || 0) / 100));
      const q = o.book ? Math.min(1, Math.max(0, (+o.book.value || 0) / 100)) : 0;
      o.hlbl.textContent = `${Math.round(h * 100)}%`;
      state.rows[id] = { amt: A, book: o.book ? Math.min(100, Math.max(0, +o.book.value || 0)) : null, h: h * 100 };
      if (r.dis || !A) continue;
      const eK = IX[`e_${r.cur}`], dsK = IX[`ds_${r.cur}`];
      const bK = r.kind === "eq" ? IX.eq : IX[`b_${r.cur}`];
      if (eK == null || bK == null) continue;                // 데이터 계약 불일치 가드 (예: CNY 조기 활성화)
      tot += A;
      carry += A * h * hedgeCostAt(mmap[r.cur], tenor) / 100;
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
    if (save) { try { localStorage.setItem(HEDGE_LS_KEY, JSON.stringify(state)); } catch {} }
    if (!tot) {
      $("#hg-econ").textContent = "–";
      $("#hg-acct").textContent = "–";
      const c0 = $("#hg-carry");
      c0.textContent = "–";
      c0.style.color = "";
      return;
    }
    const qf = (x) => {
      let s = 0;
      for (let i = 0; i < N; i++) {
        if (!x[i]) continue;
        for (let j = 0; j < N; j++) if (x[j]) s += x[i] * x[j] * COV[i][j];
      }
      return Math.sqrt(Math.max(s, 0)) / tot * 100;
    };
    $("#hg-econ").textContent = fmtNum(qf(xe), 1) + "%";
    $("#hg-acct").textContent = fmtNum(qf(xa), 1) + "%";
    const cEl = $("#hg-carry");
    cEl.textContent = `${carry >= 0 ? "+" : "−"}${fmtNum(Math.abs(carry), 0)}억/년`;
    cEl.style.color = carry >= 0 ? "var(--down)" : "var(--up)";
  }
  inner.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => recalc()));
  recalc(false);
  ov.scrollTop = 0;
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
    optimize(mu, C, target, iters) {
      return amOptimize(mu, C, lo, hi, total, target, groups, iters);
    },
  };
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
    cost_key: d.cost_key, proxy: d.proxy, start_key: d.start_key,
    cap_foreign: null, cap_equity: null, target_ret: null, risk_cap: null,
    by_kr: null, by_fx: null, book_mat_m: null,
    dur_liab: null, dur_asset: null, la_ratio: null,
    saved: false,
  };
}

function allocState(A) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ALLOC_LS_KEY)) || {}; } catch { saved = {}; }
  return { ...allocDefaults(A), ...saved };
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

  const sliders = el("div", { style: "display:flex;gap:26px;flex-wrap:wrap;margin-top:10px" });
  const mkSlider = (label, key) => {
    const wrap = el("div", {});
    const lbl = el("span", { class: "hlbl" }, `${st[key]}%`);
    const inp = el("input", { type: "range", min: "0", max: "100", step: "5", value: String(st[key]) });
    inp.addEventListener("input", () => {
      st[key] = +inp.value;
      lbl.textContent = `${st[key]}%`;
      recalc(false);
    });
    inp.addEventListener("change", () => { allocSaveState(st); recalc(true); });
    wrap.append(el("div", { style: "font-size:12.5px" }, el("b", {}, label),
      el("span", { style: "color:var(--ink-3)" }, " — 모델이 고른 값이 아니라 지금 귀사의 상태입니다")),
      el("div", {}, inp, " ", lbl));
    return wrap;
  };
  sliders.append(mkSlider("해외채권 헤지비율", "h_bond"), mkSlider("해외주식 헤지비율", "h_eq"));
  ctl.append(sliders,
    el("div", { style: "margin-top:8px" },
      el("a", { href: "#alloc-sim", class: "btn-primary" }, "우리 기관 숫자로 계산 (수기 입력) →"),
      el("span", { style: "color:var(--ink-3);font-size:12px;margin-left:10px" },
        st.saved ? "저장된 수기 입력을 사용 중" : "예시값 표시 중 — 수기 입력을 저장하면 대체됩니다 (이 브라우저에만 저장)")));

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
      if (st.dur_liab != null && st.dur_asset != null) {
        const laR = st.la_ratio != null ? st.la_ratio : 1;
        const gap = st.dur_asset - laR * st.dur_liab;
        gapCard.append(el("div", { class: "card-title" }, "ALM 듀레이션 갭 (표준 근사)"),
          el("div", { style: "font-size:20px;font-weight:700;margin:6px 0 2px" }, `${fmtNum(gap, 2)}년`),
          el("div", { style: "font-size:12px" },
            `갭 = 자산 ${fmtNum(st.dur_asset, 1)} − 부채/자산 ${fmtNum(laR, 2)} × 부채 ${fmtNum(st.dur_liab, 1)}`),
          el("div", { style: "color:var(--ink-3);font-size:11.5px;margin-top:4px" },
            `금리 +100bp 시 순자산가치 변화 ≈ ${fmtNum(-gap, 2)}%p (총자산 대비). 장부가 자산의 진짜 위험은 가격이 아니라 재투자·ALM입니다.`));
      } else {
        gapCard.append(el("div", { class: "card-title" }, "ALM 듀레이션 갭"),
          el("div", { style: "font-size:12.5px;margin-top:6px" },
            "부채 듀레이션·자산 듀레이션·부채/자산 비율을 입력하면 여기서 갭과 금리 ±100bp 민감도를 보여줍니다."),
          el("div", { style: "margin-top:6px" }, el("a", { href: "#alloc-sim" }, "수기 입력 →")));
      }
      const whyCard = el("div", { class: "card", style: "padding:14px 16px" });
      whyCard.append(el("div", { class: "card-title" }, "이 관점에는 배분 참고치가 없습니다"),
        el("div", { style: "font-size:12.5px;margin-top:6px" },
          "장부가 자산은 가격변동성이 0이라 평균-분산 최적화기에 넣으면 밴드 상한까지 쏠립니다(§7.2-1). ",
          "그래서 회계 관점은 손익 변동·ALM 진단 전용이고, ",
          el("a", { onclick: () => { st.view = "econ"; allocSaveState(st); renderAlloc(); } },
            "배분 참고치는 경제 관점에서 계산합니다 →")));
      cardsBox.append(gapCard, whyCard);
    } else {
      cardsBox.append(
        card("현재 배분 (입력값)", muCur, sigCur, "수기 입력(또는 예시) 그대로", capW(sigCur)),
        card("① 위험 최소 참고치", muMin, sigMin, "헤지 고정 · 밴드 안에서 위험 최소", capW(sigMin)),
        card("② 수익 유지 참고치", muKeep, sigKeep,
          st.target_ret != null ? `목표수익 ${fmtNum(target, 2)}% 입력값 기준` : "기대수익을 현재와 같게 두고 위험만 축소",
          capW(sigKeep)));
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
      const sEq0 = E.sigmaHedge(st.h_bond / 100, 0);
      let bestHb = 0, bestS = Infinity;
      for (let h = 0; h <= 100; h += 5) {
        const s = E.sigmaHedge(h / 100, 0);
        if (s < bestS) { bestS = s; bestHb = h; }
      }
      const flat = [];
      for (let h = 0; h <= 100; h += 5) {
        if (E.sigmaHedge(h / 100, 0) - bestS < 0.02) flat.push(h);
      }
      leverBox.append(el("b", {}, "레버는 두 개뿐입니다 — 겹쳐 세지 마십시오"), el("br"),
        "· ", el("b", {}, "레버 1 (배분 고정, 헤지만 이동)"),
        ` — 주식헤지 ${st.h_eq}→0%: 위험 ${fmtNum(sigCur, 2)}→${fmtNum(sEq0, 2)}% · 이어서 채권헤지 ${st.h_bond}→${bestHb}%: →${fmtNum(bestS, 2)}%. `,
        el("b", {}, `채권헤지는 ${flat[0]}~${flat[flat.length - 1]}%에서 사실상 평평합니다(차이 0.02%p 미만) — 한 점을 고르지 마십시오.`),
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
      "· [관측·선택] 헤지비용 ", (() => {
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
        allocCharts.push(makeRatioChart(fbox, {
          seriesDefs: [
            { label: "투자선", color: pal.series[0], x: xsF, v: pts.map((p) => +p.mu.toFixed(3)) },
          ],
          xLabel: "위험(연)", xRange: [Math.min(sigMin, sigCur) * 0.9, Math.max(sigCur, ...xsF) * 1.05],
          unit: "%", height: 260,
        }));
        frontierCard.append(el("div", { class: "card-sub", style: "margin-top:6px" },
          `× 현재 (위험 ${fmtNum(sigCur, 2)} · 수익 ${fmtNum(muCur, 2)}) · ① (${fmtNum(sigMin, 2)} · ${fmtNum(muMin, 2)}) · ② (${fmtNum(sigKeep, 2)} · ${fmtNum(muKeep, 2)}) — 표 버튼에서 선 위 각 점의 배분(%)을 볼 수 있습니다.`));
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
  overlayCharts.forEach(destroyChart);
  overlayCharts = [];
  const ov = $("#detail-overlay");
  ov.textContent = "";
  ov.hidden = false;
  document.body.style.overflow = "hidden";
  const inner = el("div", { class: "detail-inner" });
  ov.append(inner);
  inner.append(el("div", { class: "crumb" },
    el("a", { onclick: () => { location.hash = "alloc"; } }, "‹ 자산배분 기본 화면"), ` / ${title}`));
  return inner;
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
    const numIn = (key, val, step, ph) => {
      const i = el("input", { type: "number", step: String(step || 0.1), value: val == null ? "" : String(val), placeholder: ph || "" });
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
      " 자산 듀레이션(년)", numIn("dur_asset", st.dur_asset, 0.1),
      " 부채/자산 비율", numIn("la_ratio", st.la_ratio, 0.01, "예: 0.9")));

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
      el("div", { class: "a" }, "곡면이 평평한 능선을 갖습니다 ",
        el("small", {}, "총 환오픈이 비슷하면 어느 쪽에서 열든 위험이 거의 같습니다 — 한 점 고르기보다 구간으로 판단"))));
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
    let best = { s: Infinity, hb: 0, he2: 0 };
    for (let hb2 = 0; hb2 <= 100; hb2 += 5) for (let he2 = 0; he2 <= 100; he2 += 5) {
      const s = E.sigmaHedge(hb2 / 100, he2 / 100);
      if (s < best.s) best = { s, hb: hb2, he2 };
    }
    inner.append(el("div", { class: "howto", style: "margin-top:12px" },
      el("b", {}, "왜 자산별 참고치와 다른가"),
      ` — 채권만 떼어 본 최소분산 헤지(MVH)는 ${fmtNum(mvhBond, 0)}%지만, 포트폴리오 전체의 격자 최소는 (채권 ${best.hb}%, 주식 ${best.he2}%)입니다. 총위험에는 국내주식·환율의 상쇄까지 들어오기 때문입니다. `,
      "회계(손익) 관점은 방향이 정반대 — 장부가 해외채권은 상쇄해줄 가격변동이 손익에 없어 헤지 100%가 언제나 손익변동 최소입니다(판단 변수는 비용)."));
    $("#detail-overlay").scrollTop = 0;
    return;
  }

  /* --- 헤지비용 선택 --- */
  if (topic === "cost") {
    const inner = allocOverlayShell("헤지비용 읽는 법 — 선택이 결과를 얼마나 바꾸나");
    inner.append(el("div", { class: "qa" },
      el("div", { class: "q" }, "헤지비용은 하나의 숫자가 아닙니다 — 네 가지 읽기를 모두 보여드립니다"),
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
       ["hb_star", "위험최소 채권헤지 %"], ["he_star", "위험최소 주식헤지 %"]].forEach(([k, lbl], i) => {
        const q = r[k];
        const tr = el("tr", { style: i === 0 ? "border-top:2px solid var(--border)" : "" });
        if (i === 0) tr.append(el("td", { rowspan: "5" }, `${r.block_len}개월`));
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

function renderAll() {
  destroyAllCharts();
  overlayCharts = [];
  registry.length = 0;
  renderOverview();
  renderRisk();
  renderEvents();
  renderPanel();
  renderHedge();
  renderAlloc();
  renderRates();
  renderIRS();
  renderCredit();
  renderFX();
  renderInflation();
  renderACWI();
  renderMacro();
  if (!$("#detail-overlay").hidden) handleHash();   // 테마 전환 시 열린 상세 재구성
}

function bindTheme() {
  const btn = $("#theme-btn");
  const saved = localStorage.getItem("iaw-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("iaw-theme", next);
    renderAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem("iaw-theme")) renderAll();
  });
}

async function boot() {
  bindTheme();
  bindRangeButtons();
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
  renderAll();
  renderCatalog();
  window.addEventListener("hashchange", handleHash);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#detail-overlay").hidden) {
      location.hash = location.hash === "#hedge-sim" ? "hedge"
        : location.hash.startsWith("#alloc-") ? "alloc" : "risk";
    }
  });
  handleHash();
  window.__iaw = { registry, state };   // 디버그/테스트 훅
}

boot();
