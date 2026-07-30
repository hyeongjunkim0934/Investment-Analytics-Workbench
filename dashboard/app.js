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

const FILES = ["meta", "overview", "risk", "events", "hedge", "rates", "irs",
               "credit", "fx", "inflation", "acwi", "macro", "catalog"];

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
  const m = location.hash.match(/^#detail-(.+)$/);
  if (m && DATA.risk) openDetail(decodeURIComponent(m[1]));
  else hideDetail();
}

/* ---------------- 환헤지 ---------------- */

function fmtCost(x) {
  if (x == null) return el("span", { class: "d-flat" }, "—");
  return el("span", { class: x < 0 ? "neg" : "pos" }, `${x > 0 ? "+" : ""}${fmtNum(x, 2)}%`);
}

/* 숫자 x축(헤지비율) 차트 */
function makeRatioChart(box, { seriesDefs, height = 280, unit = "%" }) {
  const pal = palette();
  const xs = seriesDefs[0].x;
  const series = [{ label: "헤지비율", value: (u, v) => v == null ? "–" : v + "%" }];
  seriesDefs.forEach((sd) => series.push({
    label: sd.label, stroke: sd.color, width: 2.5, spanGaps: true,
    points: { show: false },
    value: (u, v) => v == null ? "–" : fmtNum(v, 1) + unit,
  }));
  const u = new uPlot({
    width: Math.max(280, box.clientWidth), height,
    cursor: { points: { size: 8 }, y: false },
    scales: { x: { time: false, range: [0, 100] } },
    series,
    axes: [
      { stroke: pal.ink3, font: AXIS_FONT, grid: { stroke: pal.grid, width: 1 },
        ticks: { show: false }, values: (u2, vals) => vals.map((v) => v + "%") },
      baseAxes(pal, (v) => fmtNum(v, 0) + unit)[1],
    ],
    legend: { live: true },
  }, [xs, ...seriesDefs.map((sd) => sd.v)], box);
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

/* ---------------- render all / boot ---------------- */

function renderAll() {
  destroyAllCharts();
  overlayCharts = [];
  registry.length = 0;
  renderOverview();
  renderRisk();
  renderEvents();
  renderHedge();
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
      location.hash = location.hash === "#hedge-sim" ? "hedge" : "risk";
    }
  });
  handleHash();
  window.__iaw = { registry, state };   // 디버그/테스트 훅
}

boot();
