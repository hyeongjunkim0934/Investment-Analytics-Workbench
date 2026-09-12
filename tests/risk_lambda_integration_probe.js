/* Execute the production portfolio -> risk renderer; Python checks allocations with
   an independent two-asset closed form, rather than another optimizer copy. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const fixture = (name) => {
  const start = source.indexOf(`const ${name} = (() => {`);
  const end = source.indexOf("\n})();", start);
  if (start < 0 || end < 0) throw new Error(`Missing synthetic fixture: ${name}`);
  return source.slice(start, end + 6);
};
const bootEnd = source.indexOf("const out = {};");
const load = new Function("require", "__dirname", source.slice(0, bootEnd)
  + fixture("ALLOC_FIXTURE") + fixture("CMA_ALLOC")
  + "\nreturn {P, DOC, shim, sandbox, CMA_ALLOC};");
const {P, DOC, shim, sandbox, CMA_ALLOC} = load(require, __dirname);
const makeEngine = vm.runInContext("portRiskAllocationEngine", sandbox);
const render = vm.runInContext("renderAllocRiskProc", sandbox);
const card = DOC.getElementById("alloc-risk-proc");
const assets = ["국내채권", "해외주식"];
const portfolio = {
  active: true, asof: "2026-09-08", assets,
  defaults: {groups: {채권: [assets[0]], 주식: [assets[1]], 대체: [], 유동성: []},
    group_default: {채권: 50, 주식: 50, 대체: 0}, liq_default: 0},
  bench_w: {[assets[0]]: .5, [assets[1]]: .5},
  cma_input: {asof: "2026-09-08", mu_pct: {[assets[0]]: 3, [assets[1]]: 7}},
  windows: [{key: "all", n_months: 60, start: "2021-09-30", end: "2026-08-31",
    mean_pct: [1, 1], cov: [[.0016, .0008], [.0008, .01]], corr: [[1, .2], [.2, 1]]}],
};
const dates = ["2026-07-31", "2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-08"];
const scores = [0, 1, 10, 25, 50, 100, 67.34567];
const potential = [100, 50, 25, 10, 1, 0, 62.34567];
const history = (values) => ({frequency: "weekly+latest", asof: dates.at(-1),
  t: dates.map((d) => Date.parse(d + "T00:00:00Z") / 1000), v: values});
P.DATA.risk = {asof: dates.at(-1), layers: {
  stress: {name: "현재 위험", score: scores.at(-1), hist_alloc: history(scores)},
  vuln: {name: "잠재 위험", score: potential.at(-1), hist_alloc: history(potential)},
}};
let captured = "";
sandbox.Blob = class {constructor(parts) {this.text = parts.join("");}};
sandbox.URL = {createObjectURL(blob) {captured = blob.text; return "blob:independent-probe";}};
const readRows = () => {
  captured = "";
  const button = [...card.querySelectorAll("button")].find((n) => n.textContent === "CSV");
  if (!button) return null;
  button.click();
  const lines = captured.replace(/^\uFEFF/, "").trim().split("\n").map((line) => line.split(","));
  return {headers: lines[0], rows: lines.slice(1).map((row) => [row[0], ...row.slice(1).map(Number)])};
};
const run = ({saved = {}, layer = "stress", change = null, legacy = 1} = {}) => {
  const alloc = {...CMA_ALLOC, port: JSON.parse(JSON.stringify(portfolio))};
  if (change) change(alloc);
  P.DATA.alloc = alloc;
  shim.localStorage.setItem("iaw-port", JSON.stringify(saved));
  // A stale institutional lambda and transformation preference must have no effect.
  const state = {...P.allocDefaults(CMA_ALLOC), rp_range: "all", rp_layer: layer,
    rp_map: "log", mvo_lambda: legacy};
  const engine = makeEngine(alloc);
  render(card, engine, state, P.palette(), () => {}, []);
  return {engine: engine?.V || null, error: engine?.error || null,
    csv: readRows(), charts: card.querySelectorAll("svg").length, text: card.textContent};
};
const result = {
  dates, scores, potential,
  baseline: run(), potentialPath: run({layer: "vuln"}),
  legacyChanged: run({legacy: 777}),
  meanChanged: run({saved: {mu: {[assets[0]]: 6}}}),
  volatilityChanged: run({saved: {sig: {[assets[0]]: 8}}}),
  correlationChanged: run({saved: {corr: {[JSON.stringify(assets.slice().sort())]: -.5}}}),
  missingPortfolio: run({change: (a) => {delete a.port;}}),
  inactivePortfolio: run({change: (a) => {a.port.active = false; a.port.reason = "검증용 비활성";}}),
  missingWindow: run({change: (a) => {a.port.windows = [];}}),
  invalidRisk: run({saved: {sig: {[assets[0]]: -1}}}),
};
// Exercise the public wrapper too: a failed alloc.json fetch has no defaults object.
P.DATA.alloc = null;
try {
  vm.runInContext("renderLinkedAllocRisk()", sandbox);
  result.missingAllocationPayload = {threw: false, charts: card.querySelectorAll("svg").length,
    text: card.textContent};
} catch (error) {
  result.missingAllocationPayload = {threw: true, error: String(error)};
}
P.DATA.alloc = {port: JSON.parse(JSON.stringify(portfolio))};
shim.localStorage.setItem("iaw-port", "{}");
shim.localStorage.setItem("iaw-alloc", JSON.stringify({rp_range: "all"}));
vm.runInContext("renderLinkedAllocRisk()", sandbox);
result.portfolioOnlyPayload = {engine: makeEngine(P.DATA.alloc).V,
  charts: card.querySelectorAll("svg").length, csv: readRows(), text: card.textContent};
process.stdout.write(JSON.stringify(result));
