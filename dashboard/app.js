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

const FILES = ["meta", "overview", "rates", "irs", "credit", "fx",
               "inflation", "acwi", "macro", "catalog"];

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

/* ---------------- render all / boot ---------------- */

function renderAll() {
  destroyAllCharts();
  registry.length = 0;
  renderOverview();
  renderRates();
  renderIRS();
  renderCredit();
  renderFX();
  renderInflation();
  renderACWI();
  renderMacro();
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
  window.__iaw = { registry, state };   // 디버그/테스트 훅
}

boot();
