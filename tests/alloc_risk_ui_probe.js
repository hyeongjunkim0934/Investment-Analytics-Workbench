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
  + fixture("ALLOC_FIXTURE") + fixture("CMA_ALLOC")
  + '\nreturn {P, DOC, shim, sandbox, CMA_ALLOC, render:vm.runInContext("renderAllocRiskProc",sandbox)};');
const { P, DOC, shim, sandbox, CMA_ALLOC, render } = load(require, __dirname);
const byId = (id) => DOC.getElementById(id);
const card = byId("alloc-risk-proc");
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
const engine = P.allocEngine(CMA_ALLOC, P.allocDefaults(CMA_ALLOC));
let state;
const draw = () => render(card, engine, state, P.palette(), draw, []);
const reset = (data = risk, saved = {}) => {
  P.DATA.risk = data;
  shim.localStorage.removeItem("iaw-alloc");
  state = {...P.allocDefaults(CMA_ALLOC), ...saved};
  draw();
};
const button = (text) => [...card.querySelectorAll("button")].find((n) => n.textContent === text);
const click = (text) => { const n = button(text); assert(n, `button ${text}`); n.click(); };
const keyboard = (node, key) => {
  assert(node, `keyboard target for ${key}`);
  node.dispatchEvent({type: "keydown", key, preventDefault() { this.defaultPrevented = true; }});
};
const table = () => {
  const wrap = card.querySelector(".chart-table");
  if (wrap.classList.contains("hidden")) click("표");
  return [...wrap.querySelectorAll("tbody tr")].map((n) => [...n.children].map((c) => c.textContent));
};
const result = {};
reset();
assert.equal(byId("alloc-rp-tab-stress").getAttribute("role"), "tab");
assert.equal(byId("alloc-rp-tab-stress").getAttribute("aria-selected"), "true");
assert.equal(byId("alloc-rp-tab-vuln").getAttribute("aria-selected"), "false");
assert.equal(byId("alloc-rp-panel").getAttribute("role"), "tabpanel");
assert.equal(byId("alloc-rp-tab-stress").getAttribute("aria-controls"), "alloc-rp-panel");
assert.equal(byId("alloc-rp-panel").getAttribute("aria-labelledby"), "alloc-rp-tab-stress");
assert.equal(byId("alloc-rp-layer"), null, "old layer select remains");
byId("alloc-rp-tab-vuln").click();
assert.equal(byId("alloc-rp-tab-vuln").getAttribute("aria-selected"), "true");
assert.equal(P.allocState(CMA_ALLOC).rp_layer, "vuln");
assert.equal(DOC.activeElement, byId("alloc-rp-tab-vuln"), "selected tab focus was lost on redraw");
assert.equal(+table()[0][1], 62.35);
keyboard(byId("alloc-rp-tab-vuln"), "ArrowLeft");
assert.equal(byId("alloc-rp-tab-stress").getAttribute("aria-selected"), "true");
assert.equal(DOC.activeElement, byId("alloc-rp-tab-stress"));
keyboard(byId("alloc-rp-tab-stress"), "End");
assert.equal(byId("alloc-rp-tab-vuln").getAttribute("aria-selected"), "true");
keyboard(byId("alloc-rp-tab-vuln"), "Home");
assert.equal(byId("alloc-rp-tab-stress").getAttribute("aria-selected"), "true");
result.tabsAndFocus = true;

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
click("CSV");
const csv = captured.replace(/^\uFEFF/, "").split("\n").map((line) => line.split(","));
assert.equal(csv.length, timestamps.length + 1);
assert.equal(csv[1][0], asof);
assert.equal(+csv[1][1], risk.layers.stress.score, "CSV score was rounded");
const expectedLambda = Math.pow(10, (risk.layers.stress.score - 50) / 25);
assert(Math.abs(+csv[1][2] - expectedLambda) < 1e-12, "CSV λ was rounded");
assert(csv.slice(1).every((row) => Math.abs(row.slice(3).reduce((n, v) => n + +v, 0) - 100) < 1e-8));
assert.deepEqual(csv.slice(1).map((row) => row[0]), allRows.map((row) => row[0]));
result.rawExports = true;

// The last period is four days; plot coordinates must follow dates, not row indexes.
const paths = [...card.querySelectorAll("svg path")];
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
result.chartGeometryAndCleanNotes = true;

// Tooltip is a chart-local, initially empty readout. Keyboard/pointer paths must agree.
const tooltip = card.querySelector(".rp-tooltip");
assert(tooltip, "chart tooltip missing");
assert(card.querySelector(".chart-box").contains(tooltip));
assert(tooltip.hidden, "latest readout visible before chart interaction");
const chartSurface = card.querySelector(".rp-chart");
assert.equal(chartSurface.getAttribute("tabindex"), "0");
assert.equal(chartSurface.getAttribute("role"), "group");
keyboard(chartSurface, "End");
assert(!tooltip.hidden);
assert(tooltip.textContent.includes(asof));
assert(tooltip.textContent.includes("67.35"));
assert(!tooltip.textContent.includes("λ"));
keyboard(chartSurface, "Home");
assert(tooltip.textContent.includes("2020-01-03"));
keyboard(chartSurface, "ArrowRight");
assert(tooltip.textContent.includes("2020-01-10"));
keyboard(chartSurface, "Escape");
assert(tooltip.hidden);
const svg = card.querySelector("svg");
const hit = [...svg.querySelectorAll("rect")].at(-1);
hit.dispatchEvent({type: "pointermove", clientX: svg.clientWidth * .978});
assert(!tooltip.hidden && tooltip.textContent.includes(asof));
hit.dispatchEvent({type: "pointerleave"});
assert(tooltip.hidden);
result.tooltipInteraction = true;

// A redraw with revised CMA inputs must invalidate previously solved allocations.
const beforeMu = engine.V.mu[2], beforeCap = engine.hi[2];
const beforeWeights = table()[0].slice(3).map(Number);
engine.V.mu[2] = beforeMu + 40;
draw();
const revisedWeights = table()[0].slice(3).map(Number);
assert(revisedWeights.some((w, i) => Math.abs(w - beforeWeights[i]) > .01), "CMA change reused old weights");
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
  assert.equal(card.querySelectorAll("svg").length, 0, "stale chart survives invalid history");
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
reset();
assert(card.querySelector("svg"), "valid history does not recover after rejection");
assert.equal(+state.mvo_lambda, 1);
// Sparse selected ranges must retain controls so users can recover to the full history.
const sparse = JSON.parse(JSON.stringify(risk));
sparse.layers.stress.hist_alloc.t = [second("2020-01-03"), second(asof)];
sparse.layers.stress.hist_alloc.v = [20, risk.layers.stress.score];
reset(sparse, {rp_range: "1"});
assert(/보류/.test(card.textContent));
click("전체");
assert(card.querySelector("svg"), "range controls disappear when the selected interval is sparse");
assert.equal(table().length, 2);
result.rejectsBrokenFutureAndMonthlyFallback = true;
console.log(JSON.stringify(result));
