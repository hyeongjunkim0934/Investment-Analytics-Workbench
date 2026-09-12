/* Risk linkage contract: real weekly observations, view state, chart geometry and exports.
   Reuses the existing synthetic engine/DOM boot without running unrelated optimizer probes. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const fixture = (name) => {
  const start = source.indexOf(`const ${name} = (() => {`);
  const end = source.indexOf("\n})();", start);
  assert(start >= 0 && end > start, `fixture ${name}`);
  return source.slice(start, end + 6);
};
const bootEnd = source.indexOf("const out = {};");
const load = new Function("require", "__dirname", source.slice(0, bootEnd)
  + fixture("ALLOC_FIXTURE") + fixture("CMA_ALLOC") + fixture("RISK_PORT_ALLOC")
  + '\nreturn {P, DOC, shim, sandbox, CMA_ALLOC, RISK_PORT_ALLOC, render:vm.runInContext("renderAllocRiskProc",sandbox)};');
const { P, DOC, shim, sandbox, CMA_ALLOC, RISK_PORT_ALLOC, render } = load(require, __dirname);
const byId = (id) => DOC.getElementById(id);
const card = byId("alloc-risk-proc");
const panel = (layer = "stress") => byId(`alloc-rp-panel-${layer}`);
const asof = "2026-09-08";
const second = (date) => Date.parse(date + "T00:00:00Z") / 1000;
const week = 7 * 86400;
const timestamps = [];
for (let t = second("2020-01-03"); t <= second("2026-09-04"); t += week) timestamps.push(t);
timestamps.push(second(asof));
const history = (shift = 0) => ({
  frequency: "weekly+latest", asof, t: [...timestamps],
  v: timestamps.map((_, i) => i === timestamps.length - 1 ? 67.34567 - shift : [20, 40, 60, 80][i % 4] - shift),
});
const risk = {
  asof, layers: {
    stress: {name: "현재 위험", score: 67.34567, hist_alloc: history(),
      hist_m: {t: [second("2026-07-31")], v: [7]}},
    vuln: {name: "잠재 위험", score: 62.34567, hist_alloc: history(5)},
  },
};
const engine = P.portRiskAllocationEngine(RISK_PORT_ALLOC);
let state;
const draw = () => render(card, engine, state, P.palette(), draw, []);
const reset = (data = risk, saved = {}) => {
  P.DATA.risk = data;
  shim.localStorage.removeItem("iaw-alloc");
  state = {...P.allocDefaults(CMA_ALLOC), ...saved};
  draw();
};
const button = (text, root = card) => [...root.querySelectorAll("button")].find((n) => n.textContent === text);
const click = (text, root = card) => { const n = button(text, root); assert(n, `button ${text}`); n.click(); };
const keyboard = (node, key) => {
  assert(node, `keyboard target for ${key}`);
  node.dispatchEvent({type: "keydown", key, preventDefault() { this.defaultPrevented = true; }});
};
const table = (layer = "stress") => {
  const wrap = panel(layer).querySelector(".chart-table");
  if (wrap.classList.contains("hidden")) click("표", panel(layer));
  return [...wrap.querySelectorAll("tbody tr")].map((n) => [...n.children].map((c) => c.textContent));
};
const result = {};
reset();
for (const [layer, label, score] of [["stress", "현재", 67.35], ["vuln", "잠재", 62.35]]) {
  assert(panel(layer), `${layer} panel missing`);
  assert.equal(panel(layer).tagName, "SECTION");
  assert.equal(panel(layer).getAttribute("aria-label"), label);
  assert(!panel(layer).hidden, `${layer} is hidden on the combined page`);
  assert(byId(`alloc-rp-svg-${layer}`));
  assert.equal(+table(layer)[0][1], score);
  assert.equal(byId(`alloc-rp-tab-${layer}`), null, "retired layer tab remains");
}
assert.equal(byId("alloc-rp-layer"), null, "old layer select remains");
assert.equal(byId("alloc-rp-panel"), null);
assert.equal(byId("alloc-rp-scale-1").getAttribute("aria-pressed"), "true");
result.combinedLayers = true;

const defaultRows = table();
const dateWindow = (years) => {
  const d = new Date(asof + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() - years); return d.getTime() / 1000;
};
assert.equal(defaultRows.length, timestamps.filter((t) => t >= dateWindow(3)).length);
assert.equal(defaultRows[0][0], asof);
assert.equal(+defaultRows[0][1], 67.35);
assert.equal(defaultRows[1][0], "2026-09-04");
assert(defaultRows.length > 150, "still using monthly history");
for (const years of [1, 5, 3]) {
  click(`${years}Y`);
  assert.equal(table().length, timestamps.filter((t) => t >= dateWindow(years)).length, `${years}Y observations`);
  assert.equal(table("vuln").length, table().length, "range control did not update both layers");
  assert.equal(String(P.allocState(CMA_ALLOC).rp_range), String(years));
  assert.equal(DOC.activeElement, button(`${years}Y`), "range selection loses focus");
}
click("전체");
const allRows = table();
assert.equal(allRows.length, timestamps.length);
assert.equal(P.allocState(CMA_ALLOC).rp_range, "all");
assert(allRows.every((row) => Math.abs(row.slice(3).reduce((n, v) => n + +v, 0) - 100) < .04));
assert.equal(allRows.at(-1)[0], "2020-01-03");
assert.equal(+P.allocState(CMA_ALLOC).mvo_lambda, 1, "view controls mutated preference λ");
state = P.allocState(CMA_ALLOC); draw();
assert.equal(table().length, timestamps.length, "range was not restored from saved state");
result.weeklyLatestAndRange = true;

let captured = "";
sandbox.Blob = class { constructor(parts) { this.text = parts.join(""); } };
sandbox.URL = {createObjectURL(blob) {captured = blob.text; return "blob:probe";}};
click("CSV", panel());
const csv = captured.replace(/^\uFEFF/, "").split("\n").map((line) => line.split(","));
assert.equal(csv.length, timestamps.length + 1);
assert.equal(csv[1][0], asof);
assert.equal(+csv[1][1], risk.layers.stress.score, "CSV score was rounded");
const expectedLambda = risk.layers.stress.score;
assert.equal(+csv[1][2], expectedLambda, "CSV λ differs from raw score");
assert(csv.slice(1).every((row) => +row[1] === +row[2]), "some observation λ values were transformed");
assert.equal(byId("alloc-rp-map"), null, "obsolete risk-to-λ selector remains");
assert.deepEqual(csv[0].slice(3), ["국내채권", "국내장부", "해외채권", "국내주식", "해외주식", "대체투자"]);
assert(csv.slice(1).every((row) => Math.abs(row.slice(3).reduce((n, v) => n + +v, 0) - 100) < 1e-8));
assert.deepEqual(csv.slice(1).map((row) => row[0]), allRows.map((row) => row[0]));
result.rawExports = true;

// The last period is four days; plot coordinates must follow dates, not row indexes.
const paths = [...panel().querySelectorAll("svg path")];
const scorePath = paths.find((node) => {
  const d = node.getAttribute("d") || "";
  return (d.match(/[ML]/g) || []).length === timestamps.length && !d.endsWith("Z");
});
assert(scorePath, "score path unavailable");
const coordinates = [...scorePath.getAttribute("d").matchAll(/[ML]([\d.e+-]+),([\d.e+-]+)/g)].map((m) => +m[1]);
const lastGap = coordinates.at(-1) - coordinates.at(-2);
const priorGap = coordinates.at(-2) - coordinates.at(-3);
assert(Math.abs(lastGap / priorGap - 4 / 7) < .08, "x axis spaces unequal periods as equal rows");
assert(card.classList.contains("port-frontier"), "risk plot does not share frontier card styling");
assert.equal(card.querySelectorAll(".rp-hover").length, 0, "old bottom readout remains");
assert(!/화면 λ|λ →|점수−50|점수\/50|마지막 달|자동 반영 없음|백테스트/.test(card.textContent));
const holdingPaths = paths.filter((node) => node !== scorePath);
assert.equal(holdingPaths.length, 11, "six assets must have six bands and five boundaries");
for (const node of holdingPaths) {
  const d = node.getAttribute("d");
  assert.equal((d.match(/H/g) || []).length, timestamps.length - 1, "weights must stay constant until next observation");
  let x = 0, y = 0;
  for (const m of d.matchAll(/([MLHV])([\d.e+-]+)(?:,([\d.e+-]+))?/g)) {
    const op = m[1], a = +m[2], b = +m[3];
    if (op === "L") assert(a === x || b === y, "allocation band interpolates between rebalance dates");
    if (op === "M" || op === "L") { x = a; y = b; }
    else if (op === "H") x = a;
    else if (op === "V") y = a;
  }
}
result.chartGeometryAndCleanNotes = true;

// Tooltip is a chart-local, initially empty readout. Keyboard/pointer paths must agree.
const tooltip = panel().querySelector(".rp-tooltip");
assert(tooltip, "chart tooltip missing");
assert(panel().querySelector(".chart-box").contains(tooltip));
assert(tooltip.hidden, "latest readout visible before chart interaction");
const chartSurface = panel().querySelector(".rp-chart");
assert.equal(chartSurface.getAttribute("tabindex"), "0");
assert.equal(chartSurface.getAttribute("role"), "group");
keyboard(chartSurface, "End");
assert(!tooltip.hidden);
assert(tooltip.textContent.includes(asof));
assert(tooltip.textContent.includes("67.35"));
assert(tooltip.textContent.includes("λ 67.35"), "tooltip omits actual MVO λ");
keyboard(chartSurface, "Home");
assert(tooltip.textContent.includes("2020-01-03"));
keyboard(chartSurface, "ArrowRight");
assert(tooltip.textContent.includes("2020-01-10"));
keyboard(chartSurface, "Escape");
assert(tooltip.hidden);
const svg = panel().querySelector("svg");
const hit = [...svg.querySelectorAll("rect")].at(-1);
hit.dispatchEvent({type: "pointermove", clientX: svg.clientWidth * .978});
assert(!tooltip.hidden && tooltip.textContent.includes(asof));
hit.dispatchEvent({type: "pointerleave"});
assert(tooltip.hidden);
const potentialTooltip = byId("alloc-rp-tooltip-vuln");
keyboard(panel("vuln").querySelector(".rp-chart"), "End");
assert(!potentialTooltip.hidden && potentialTooltip.textContent.includes("62.35"));
assert(tooltip.hidden, "potential interaction reused the current tooltip");
keyboard(panel("vuln").querySelector(".rp-chart"), "Escape");
result.tooltipInteraction = true;

// Scale, bounds and comparison controls are saved independently of institutional preferences.
const rawWeights = table()[0].slice(3).map(Number);
byId("alloc-rp-scale-0.1").click();
assert.equal(P.allocState(CMA_ALLOC).rp_scale, .1);
assert.equal(DOC.activeElement, byId("alloc-rp-scale-0.1"));
for (const layer of ["stress", "vuln"]) {
  assert.equal(+table(layer)[0][2], Math.round(risk.layers[layer].score * 10) / 100);
  click("CSV", panel(layer));
  const row = captured.replace(/^\uFEFF/, "").split("\n")[1].split(",");
  assert.equal(+row[1], risk.layers[layer].score);
  assert.equal(+row[2], risk.layers[layer].score * .1);
}
assert(table()[0].slice(3).some((w, i) => Math.abs(+w - rawWeights[i]) > .01));
byId("alloc-rp-scale-1").click();
assert.deepEqual(table()[0].slice(3).map(Number), rawWeights);
byId("alloc-rp-lo-0").value = "10";
byId("alloc-rp-hi-0").value = "20";
byId("alloc-rp-hi-0").dispatchEvent({type: "input", target: byId("alloc-rp-hi-0")});
byId("alloc-rp-scale-0.1").click();
assert.equal(byId("alloc-rp-lo-0").value, "10", "scale redraw lost pending lower limit");
assert.equal(byId("alloc-rp-hi-0").value, "20", "scale redraw lost pending upper limit");
assert.equal(P.allocState(CMA_ALLOC).rp_bounds?.[engine.V.keys[0]], undefined, "pending limits were applied silently");
assert(/미적용/.test(card.querySelector(".rp-limits").textContent));
byId("alloc-rp-scale-1").click();
byId("alloc-rp-bounds-apply").click();
assert.deepEqual(Array.from(P.allocState(CMA_ALLOC).rp_bounds[engine.V.keys[0]]), [10, 20]);
for (const layer of ["stress", "vuln"])
  assert(table(layer).every((row) => +row[3] >= 9.999 && +row[3] <= 20.001));
const comparison = byId("alloc-rp-comparison");
const limitLines = [...comparison.querySelectorAll("line")].filter((n) => n.getAttribute("data-asset") != null);
assert.equal(limitLines.length, engine.V.keys.length);
assert.equal(+limitLines[0].getAttribute("data-lo"), 10);
assert.equal(+limitLines[0].getAttribute("data-hi"), 20);
const points = [...comparison.querySelectorAll("circle")];
assert.equal(points.length, 4 * engine.V.keys.length);
for (const layer of ["stress", "vuln"]) {
  const latest = table(layer)[0].slice(3).map(Number);
  for (const [i, key] of engine.V.keys.entries()) {
    const point = points.find((n) => n.getAttribute("data-asset") === key
      && n.getAttribute("data-layer") === layer && n.getAttribute("data-mode") === "constrained");
    assert(Math.abs(+point.getAttribute("data-weight") - latest[i]) <= .0051);
  }
}
const savedBounds = JSON.stringify(P.allocState(CMA_ALLOC).rp_bounds);
byId("alloc-rp-mode-free").click();
assert.equal(P.allocState(CMA_ALLOC).rp_mode, "free");
assert.equal(DOC.activeElement, byId("alloc-rp-mode-free"));
assert.deepEqual(table()[0].slice(3).map(Number), rawWeights, "free path still uses asset limits");
assert.equal(JSON.stringify(P.allocState(CMA_ALLOC).rp_bounds), savedBounds);
state = P.allocState(CMA_ALLOC); draw();
assert.equal(byId("alloc-rp-mode-free").getAttribute("aria-pressed"), "true");
assert.equal(byId("alloc-rp-hi-0").value, "20", "saved limits were not restored");
byId("alloc-rp-mode-constrained").click();
const validWeights = table()[0].slice(3);
byId("alloc-rp-hi-0").value = "100";
byId("alloc-rp-lo-0").value = "80";
byId("alloc-rp-lo-1").value = "50";
byId("alloc-rp-bounds-apply").click();
assert.equal(JSON.stringify(P.allocState(CMA_ALLOC).rp_bounds), savedBounds, "infeasible lower sums were persisted");
assert.deepEqual(table()[0].slice(3), validWeights, "invalid draft replaced applied allocations");
assert.equal(byId("alloc-rp-lo-0").value, "80", "invalid input was silently clamped");
assert(/하한/.test(card.querySelector(".rp-limits").textContent));
draw();
for (let i = 0; i < engine.V.keys.length; i++) {
  byId(`alloc-rp-lo-${i}`).value = "0";
  byId(`alloc-rp-hi-${i}`).value = "10";
}
byId("alloc-rp-bounds-apply").click();
assert.equal(JSON.stringify(P.allocState(CMA_ALLOC).rp_bounds), savedBounds, "infeasible upper sums were persisted");
assert.deepEqual(table()[0].slice(3), validWeights);
byId("alloc-rp-bounds-reset").click();
assert.deepEqual(Object.keys(P.allocState(CMA_ALLOC).rp_bounds), []);
assert.deepEqual(table()[0].slice(3).map(Number), rawWeights);
result.scaleBoundsAndFreeComparison = true;

// A redraw with revised portfolio inputs must invalidate previously solved allocations.
const beforeMu = engine.V.mu[2], beforeCap = engine.hi[2];
const beforeWeights = table()[0].slice(3).map(Number);
engine.V.mu[2] = beforeMu + 40;
draw();
const revisedWeights = table()[0].slice(3).map(Number);
assert(revisedWeights.some((w, i) => Math.abs(w - beforeWeights[i]) > .01), "portfolio mean change reused old weights");
engine.hi[2] = .03;
draw();
assert(table().every((row) => +row[5] <= 3.001), "revised asset cap reused old weights");
engine.V.mu[2] = beforeMu; engine.hi[2] = beforeCap;
draw();
assert.deepEqual(table()[0].slice(3).map(Number), beforeWeights, "restored inputs did not reproduce allocations");
result.cacheRespondsToInputs = true;

const broken = (change) => {
  const data = JSON.parse(JSON.stringify(risk)); change(data.layers.stress.hist_alloc, data); reset(data);
  assert(/보류/.test(card.textContent), "invalid history silently rendered");
  assert.equal(panel().querySelectorAll("svg").length, 0, "stale current chart survives invalid history");
  assert(panel("vuln").querySelector("svg"), "valid potential history was hidden by current history error");
  assert.equal(+table("vuln")[0][1], 62.35);
};
broken((h) => h.v.pop());
broken((h) => {h.v[1] = null;});
broken((h) => {h.v[1] = 101;});
broken((h) => {h.t[1] = h.t[0];});
broken((h) => {h.t[1] = h.t[2] + 1;});
broken((h) => {h.t[h.t.length - 1] = second("2026-09-09");});
broken((h) => {h.t[1] = "invalid";});
broken((h, data) => {delete data.layers.stress.hist_alloc;});
assert(/주간 이력/.test(card.textContent), "missing history has no actionable reason");
const missingPotential = JSON.parse(JSON.stringify(risk));
delete missingPotential.layers.vuln.hist_alloc;
reset(missingPotential);
assert(panel().querySelector("svg"), "missing potential history suppressed valid current history");
assert.equal(panel("vuln").querySelectorAll("svg").length, 0);
assert.equal(+table()[0][1], 67.35);
reset();
assert(panel().querySelector("svg"), "valid history does not recover after rejection");
assert.equal(+state.mvo_lambda, 1);
// Sparse selected ranges must retain controls so users can recover to the full history.
const sparse = JSON.parse(JSON.stringify(risk));
sparse.layers.stress.hist_alloc.t = [second("2020-01-03"), second(asof)];
sparse.layers.stress.hist_alloc.v = [20, risk.layers.stress.score];
reset(sparse, {rp_range: "1"});
assert(/보류/.test(card.textContent));
click("전체");
assert(panel().querySelector("svg"), "range controls disappear when the selected interval is sparse");
assert.equal(table().length, 2);
result.rejectsBrokenFutureAndMonthlyFallback = true;
// Production wiring must consume the visible portfolio and ignore retired institutional preferences.
shim.localStorage.removeItem("iaw-port");
shim.localStorage.removeItem("iaw-alloc");
P.DATA.alloc = RISK_PORT_ALLOC;
P.DATA.risk = risk;
P.renderSection("alloc");
byId("alloc-workspace-risk").click();
click("전체");
const original = table().map((row) => row.slice(3));
const legacy = { ...P.allocDefaults(CMA_ALLOC), mvo_lambda: 29.7, rp_map: "lin", rp_range: "all",
  source: "proxy", h_bond: 0, h_eq: 0, h_alt: 0,
  bands: Object.fromEntries(Object.keys(P.allocDefaults(CMA_ALLOC).bands).map((key) => [key, [0, 0]])) };
shim.localStorage.setItem("iaw-alloc", JSON.stringify(legacy));
P.renderSection("alloc");
assert.deepEqual(table().map((row) => row.slice(3)), original, "retired institutional state changed risk weights");
assert(table().every((row) => +row[1] === +row[2]), "legacy λ preference changed score passthrough");
const editVisible = (label, value) => {
  byId("alloc-workspace-port").click();
  const input = [...byId("alloc-port-panel").querySelectorAll("input")]
    .find((n) => n.getAttribute("aria-label") === label);
  assert(input, `visible portfolio input ${label}`);
  input.value = String(value);
  input.dispatchEvent({ type: "input", target: input });
  if (label.endsWith("상관계수")) byId("port-corr-apply").click();
  byId("alloc-workspace-risk").click();
};
const latestWeights = () => table()[0].slice(3).map(Number);
const changed = (before, after) => before.some((v, i) => Math.abs(v - after[i]) > .001);
let before = latestWeights();
editVisible("해외채권 기대수익", 8.5);
assert(changed(before, latestWeights()), "visible expected return does not update risk allocation");
before = latestWeights();
editVisible("해외채권 변동성", 8);
assert(changed(before, latestWeights()), "visible volatility does not update risk allocation");
before = latestWeights();
editVisible("국내장부 · 해외채권 상관계수", .85);
assert(changed(before, latestWeights()), "applied visible correlation does not update risk allocation");
const E = P.portRiskAllocationEngine(RISK_PORT_ALLOC);
assert.equal(E.V.mu[2], 8.5);
assert.equal(E.V.C[2][2], 64);
assert(Math.abs(E.V.C[1][2] - .2 * 8 * .85) < 1e-12);
assert(byId("alloc-workspace-info").hidden, "retired infeasible bounds block valid portfolio inputs");
result.visiblePortfolioInputsDriveRisk = true;
console.log(JSON.stringify(result));
