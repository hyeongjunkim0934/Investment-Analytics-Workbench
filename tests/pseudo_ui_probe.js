/* Exercise the real Pseudo renderer and app routing; skip unrelated optimizer probes. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const end = source.indexOf("const EXPORTS = [");
assert(end > 0, "dashboard bootstrap boundary");
const load = new Function("require", "__dirname", source.slice(0, end) + `
const saved = new Map([
  ["iaw-port", '{"mu":{"국내채권":3}}'],
  ["iaw-alloc", '{"rp_scale":0.1}']
]);
const writes = [];
sandbox.localStorage = {
  getItem: (key) => saved.has(key) ? saved.get(key) : null,
  setItem: (key, value) => { writes.push([key, String(value)]); saved.set(key, String(value)); },
  removeItem: (key) => { writes.push([key, null]); saved.delete(key); }
};
for (const name of ["pseudo/risk.js", "pseudo/alloc.js", "pseudo/hedge.js", "pseudo.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, "dashboard", name), "utf8"), sandbox, {filename: name});
const noBoot = APP.replace(/\\nboot\\(\\);\\s*$/, "\\n");
if (noBoot === APP) throw new Error("app boot boundary");
vm.runInContext(noBoot + "\\n;globalThis.__pseudoProbe = {DATA, FILES, SECTION_IDS, RENDERERS, routeView, renderSection, bindTheme, currentTheme, boot};", sandbox);
return {P:sandbox.__pseudoProbe, DOC, shim, sandbox, saved, writes, FETCH_CALLS, main, nav, elem};
`);
const { P, DOC, shim, sandbox, saved, writes, FETCH_CALLS, main, nav, elem } = load(require, __dirname);
const byId = (id) => DOC.getElementById(id);
const section = elem("section", "pseudo", "section");
section.append(elem("div", "pseudo-content"));
main.append(section);
const html = fs.readFileSync(path.join(__dirname, "../dashboard/index.html"), "utf8");
const navHTML = html.match(/<nav\b[^>]*\bid="nav"[^>]*>([\s\S]*?)<\/nav>/);
assert(navHTML, "real navigation markup");
for (const match of navHTML[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
  const anchor = elem("a"); anchor.setAttribute("href", match[1]); anchor.textContent = match[2]; nav.append(anchor);
}
const docs = sandbox.PSEUDO_DOCS;
const result = { docs: JSON.parse(JSON.stringify(docs)) };
const selected = () => [...byId("pseudo-content").querySelectorAll("button")]
  .filter((node) => node.getAttribute("role") === "tab" && node.getAttribute("aria-selected") === "true")
  .map((node) => node.id);
const keyboard = (id, key) => {
  const event = {type: "keydown", key, preventDefault() { this.defaultPrevented = true; }};
  byId(`pseudo-tab-${id}`).dispatchEvent(event);
  return {selected: selected(), focus: DOC.activeElement.id, prevented: !!event.defaultPrevented};
};
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  P.DATA.pseudoSentinel = {nested: {allocation: [0.6, 0.4]}};
  const dataBefore = JSON.stringify(P.DATA), storageBefore = JSON.stringify([...saved]);
  P.renderSection("pseudo");
  sandbox.location.hash = "#pseudo";
  P.routeView();
  const links = [...nav.querySelectorAll("a")];
  const hashes = links.map((node) => node.getAttribute("href"));
  result.navigation = {
    adjacent: hashes[hashes.indexOf("#hedge") + 1] === "#pseudo",
    registered: P.SECTION_IDS.includes("pseudo") && typeof P.RENDERERS.pseudo === "function",
    visible: !section.hidden && byId("village").hidden && byId("hedge").hidden,
    active: links.filter((node) => node.getAttribute("aria-current") === "page").map((node) => node.getAttribute("href")),
    noBackLink: !section.querySelector(".village-back")
  };
  result.initial = {
    tabs: [...byId("pseudo-content").querySelectorAll("button")]
      .filter((node) => node.getAttribute("role") === "tab")
      .map((node) => ({id: node.id, text: node.textContent, selected: node.getAttribute("aria-selected"),
        tabIndex: node.getAttribute("tabindex"), controls: node.getAttribute("aria-controls")})),
    panelRole: byId("pseudo-panel").getAttribute("role"),
    panelLabel: byId("pseudo-panel").getAttribute("aria-labelledby")
  };
  result.keyboard = [keyboard("risk", "ArrowRight"), keyboard("alloc", "ArrowLeft"),
    keyboard("risk", "ArrowLeft"), keyboard("hedge", "Home"), keyboard("risk", "End"),
    keyboard("hedge", "ArrowRight")];
  result.rendered = {};
  for (const id of ["risk", "alloc", "hedge"]) {
    byId(`pseudo-tab-${id}`).click();
    const cards = [...byId("pseudo-panel").querySelectorAll(".pseudo-card")];
    result.rendered[id] = cards.map((card, index) => {
      const content = docs[id].sections[index], code = card.querySelector("code");
      const formulas = [...card.querySelectorAll(".pseudo-formula")];
      return { codeMatches: code.textContent === content.code,
        formulaMatches: JSON.stringify(formulas.map((node) => node.textContent)) === JSON.stringify(content.formulas.map((f) => f.expression)),
        separate: formulas.every((node) => !code.contains(node) && !node.closest("pre")),
        accessible: formulas.every((node) => node.getAttribute("role") === "math" && node.getAttribute("aria-label") === node.textContent) };
    });
  }
  let copied = null;
  sandbox.navigator.clipboard = {writeText: async (text) => { copied = text; }};
  byId("pseudo-panel").querySelector(".pseudo-copy").click();
  await nextTick();
  result.copy = {text: copied, status: byId("pseudo-panel").querySelector(".pseudo-status").textContent};
  sandbox.navigator.clipboard.writeText = async () => { throw new Error("clipboard denied"); };
  byId("pseudo-panel").querySelector(".pseudo-copy").click();
  await nextTick();
  const fallback = byId("pseudo-panel").querySelector(".pseudo-copy-fallback");
  result.fallback = {text: fallback?.value, readonly: fallback?.hasAttribute("readonly"),
    focused: DOC.activeElement === fallback, label: fallback?.getAttribute("aria-label"),
    status: byId("pseudo-panel").querySelector(".pseudo-status").textContent};
  byId("pseudo-panel").querySelector(".pseudo-copy").click();
  await nextTick();
  result.fallback.count = byId("pseudo-panel").querySelectorAll(".pseudo-copy-fallback").length;
  delete docs.hedge;
  P.renderSection("pseudo");
  result.missing = {message: byId("pseudo-panel").textContent, codeCount: byId("pseudo-panel").querySelectorAll("code").length,
    noRenderError: !section.querySelector(".render-error")};
  docs.hedge = result.docs.hedge;
  P.renderSection("pseudo");
  byId("pseudo-tab-alloc").click();
  result.unchanged = {data: JSON.stringify(P.DATA) === dataBefore,
    storage: JSON.stringify([...saved]) === storageBefore, writes: writes.length, fetches: FETCH_CALLS.length};
  P.bindTheme();
  const oldTheme = P.currentTheme();
  byId("theme-btn").click();
  result.theme = {changed: oldTheme !== P.currentTheme(), selected: selected(),
    panelLabel: byId("pseudo-panel").getAttribute("aria-labelledby"),
    noRenderError: !section.querySelector(".render-error"),
    dataUnchanged: JSON.stringify(P.DATA) === dataBefore,
    onlyThemeSaved: writes.length === 1 && writes[0][0] === "iaw-theme"};
  // Run real boot only here: every market request rejects, as in the shared stub.
  byId("pseudo-content").textContent = "";
  sandbox.location.hash = "#hedge"; P.routeView();
  sandbox.location.hash = "#pseudo";
  await P.boot();
  const renderedWithoutData = byId("pseudo-content").querySelectorAll(".pseudo-card").length > 0;
  const directRouteVisible = !section.hidden && byId("hedge").hidden;
  const hashListeners = shim.windowListeners.hashchange || [];
  sandbox.location.hash = "#hedge";
  hashListeners.forEach((listener) => listener({type: "hashchange"}));
  const hedgeVisible = !byId("hedge").hidden && section.hidden;
  sandbox.location.hash = "#pseudo";
  hashListeners.forEach((listener) => listener({type: "hashchange"}));
  result.bootFailure = {renderedWithoutData, directRouteVisible,
    requestsRejected: FETCH_CALLS.length === P.FILES.length,
    marketDataAbsent: !P.DATA.meta && !P.DATA.overview,
    missingDataReported: byId("meta-line").textContent.includes("데이터를 불러오지 못했습니다"),
    hashRoutingAlive: hashListeners.length > 0 && hedgeVisible && !section.hidden && byId("hedge").hidden,
    noRenderError: !section.querySelector(".render-error")};
  process.stdout.write(JSON.stringify(result));
})().catch((error) => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
