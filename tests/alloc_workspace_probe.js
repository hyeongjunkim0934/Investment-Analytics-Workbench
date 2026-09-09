/* 자산배분 체계 전환 회귀. 기존 합성 데이터·DOM 부팅만 재사용하고 전체
   dashboard_probe의 고비용 최적화 반복은 실행하지 않는다. 외부 요청/의존성 0. */
"use strict";
const fs = require("fs");
const path = require("path");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const fixture = (name) => {
  const start = source.indexOf(`const ${name} = (() => {`);
  const end = source.indexOf("\n})();", start);
  if (start < 0 || end < 0) throw new Error(`missing synthetic fixture: ${name}`);
  return source.slice(start, end + 6);
};
const bootEnd = source.indexOf("const out = {};");
if (bootEnd < 0) throw new Error("missing DOM boot boundary");
const load = new Function("require", "__dirname",
  source.slice(0, bootEnd) + fixture("ALLOC_FIXTURE") + fixture("CMA_ALLOC") +
  "\nreturn { P, DOC, shim, sandbox, ALLOC_FIXTURE, CMA_ALLOC };\n");
const { P, DOC, shim, ALLOC_FIXTURE, CMA_ALLOC } = load(require, __dirname);
const r = {};
const byId = (id) => DOC.getElementById(id);
const info = () => byId("alloc-workspace-info").textContent;
const periodText = (root) => byId(root).querySelector(".alloc-period-range").textContent;
const choose = (key) => byId(`alloc-workspace-${key}`).click();
const input = (root, label) => [...byId(root).querySelectorAll("input")]
  .find((n) => n.getAttribute("aria-label") === label);
const change = (n, value, event = "input") => {
  if (!n) throw new Error("missing input");
  n.value = String(value);
  n.dispatchEvent({ type: event, target: n });
};
const snapshot = () => JSON.stringify([shim.localStorage.getItem("iaw-port"),
  shim.localStorage.getItem("iaw-alloc")]);
const engineValues = () => {
  const E = P.allocEngine(CMA_ALLOC, P.allocState(CMA_ALLOC));
  const ep = P.portEngine(CMA_ALLOC.port, P.portState(CMA_ALLOC.port));
  return JSON.stringify({ institution: { mu: E.V.mu, cov: E.V.C, w: E.w0 },
    port: { mu: ep.mu, cov: ep.W.cov, frontier: ep.front, bench: ep.bench } });
};
shim.location.hash = "#alloc";
P.DATA.alloc = CMA_ALLOC;
const originalNumbers = engineValues();
P.renderSection("alloc");
r.noRenderErrors = byId("alloc").querySelectorAll(".render-error").length === 0;
r.defaultPort = !byId("alloc-port-panel").hidden && byId("alloc-sim-panel").hidden;
r.portContext = byId("alloc-workspace-info").hidden
  && byId("alloc-workspace").textContent === "포트폴리오기관 배분·헤지"
  && /2027-01-31~2030-06-30/.test(periodText("alloc-port-panel"))
  && /42개월/.test(periodText("alloc-port-panel"));
r.portToc = [...byId("alloc-toc").querySelectorAll("button")]
  .map((b) => b.getAttribute("aria-controls"));
const beforeSelect = snapshot();
choose("institution");
r.institutionContext = byId("alloc-workspace-info").hidden
  && /2026-01-31~2030-06-30/.test(periodText("alloc-sim-panel"))
  && /54개월/.test(periodText("alloc-sim-panel"));
const institutionPanels = ["alloc-sim-panel", "alloc-headline", "alloc-summary", "alloc-controls",
  "alloc-cards", "alloc-levers", "alloc-risk-proc"];
r.onlyInstitutionVisible = byId("alloc-port-panel").hidden
  && institutionPanels.every((id) => !byId(id).hidden);
const activeButton = byId("alloc-workspace-institution");
r.pressedState = activeButton.getAttribute("aria-pressed") === "true"
  && byId("alloc-workspace-port").getAttribute("aria-pressed") === "false";
r.institutionToc = [...byId("alloc-toc").querySelectorAll("button")]
  .map((b) => b.getAttribute("aria-controls"));
r.tocVisibleTargets = r.institutionToc.every((id) => !byId(id).hidden);
byId("alloc-toc").querySelectorAll("button").forEach((b) => b.click());
choose("port");
r.switchDoesNotSave = snapshot() === beforeSelect;
r.switchDoesNotRecalculateNumbers = engineValues() === originalNumbers;
r.hashUntouched = shim.location.hash === "#alloc";

/* 저장 전 초안은 전환만으로 버려지거나 다른 체계로 섞이지 않아야 한다. */
const portWeight = input("alloc-port-panel", "국내채권 비중");
change(portWeight, 31.2);
r.portDirty = +portWeight.value === 31.2 && shim.localStorage.getItem("iaw-port") === null;
choose("institution");
const instWeight = byId("sim-mix-국내채권");
const instOriginal = +instWeight.value;
change(instWeight, instOriginal + 1);
r.institutionDirty = +instWeight.value === instOriginal + 1 && shim.localStorage.getItem("iaw-alloc") === null;
choose("port");
r.portDraftPreserved = input("alloc-port-panel", "국내채권 비중") === portWeight && +portWeight.value === 31.2;
choose("institution");
r.institutionDraftPreserved = byId("sim-mix-국내채권") === instWeight && +instWeight.value === instOriginal + 1;
P.renderSection("alloc");
r.selectionSurvivesRerender = byId("alloc-port-panel").hidden && !byId("alloc-sim-panel").hidden
  && byId("alloc-workspace-institution").getAttribute("aria-pressed") === "true";
r.portDraftSurvivesRerender = +input("alloc-port-panel", "국내채권 비중").value === 31.2;

/* 기존 저장 규약 그대로: λ·μ 변경이 현재 입력을 함께 저장한다. */
change(byId("alloc-lambda"), 2.3, "change");
r.institutionSaved = JSON.parse(shim.localStorage.getItem("iaw-alloc")).mvo_lambda === 2.3
  && byId("alloc-workspace-info").hidden;
r.portDraftSurvivesInstitutionSave = +input("alloc-port-panel", "국내채권 비중").value === 31.2
  && shim.localStorage.getItem("iaw-port") === null;
const savedInstitution = shim.localStorage.getItem("iaw-alloc");
const institutionalDraftInput = byId("sim-mix-국내채권");
change(institutionalDraftInput, 47.2);
choose("port");
change(input("alloc-port-panel", "국내채권 비중"), 29.1);
change(input("alloc-port-panel", "국내채권 기대수익"), 4.1);
const portSaved = JSON.parse(shim.localStorage.getItem("iaw-port"));
r.portSaveSemantics = portSaved.mix.국내채권 === 29.1 && portSaved.mu.국내채권 === 4.1
  && byId("alloc-workspace-info").hidden;
r.separateStorage = shim.localStorage.getItem("iaw-alloc") === savedInstitution;
r.institutionDraftSurvivesPortSave = byId("sim-mix-국내채권") === institutionalDraftInput
  && +institutionalDraftInput.value === 47.2;
change(input("alloc-port-panel", "국내채권 비중"), 27.9);
DOC.documentElement.setAttribute("data-theme", "light");
P.renderAll();
r.portDraftSurvivesThemeRerender = +input("alloc-port-panel", "국내채권 비중").value === 27.9;
const revert = [...byId("alloc-port-panel").querySelectorAll("button")]
  .find((b) => b.textContent === "저장값 복원");
revert.click();
r.portExplicitRevertWorks = +input("alloc-port-panel", "국내채권 비중").value === 29.1;
change(input("alloc-port-panel", "국내채권 비중"), 26.8);
P.DATA.alloc = { ...CMA_ALLOC, port: JSON.parse(JSON.stringify(CMA_ALLOC.port)) };
P.renderSection("alloc");
r.newDatasetStartsFromSaved = +input("alloc-port-panel", "국내채권 비중").value === 29.1;

/* 비활성/대체 이유를 상단에서도 보이며, 한 체계의 누락이 다른 체계를 막지 않는다. */
P.DATA.alloc = ALLOC_FIXTURE;
P.renderSection("alloc");
choose("institution");
r.fallbackShown = /프록시로 계산/.test(info()) && /벤치마크 CMA 없음/.test(info());
P.DATA.alloc = { ...CMA_ALLOC, sets: [] };
P.renderSection("alloc");
r.institutionMissingShown = /기관 배분·헤지 데이터를 불러오지 못했습니다/.test(info());
choose("port");
r.portWorksWithoutInstitution = !byId("alloc-port-panel").hidden
  && !!input("alloc-port-panel", "국내채권 비중") && /42개월/.test(periodText("alloc-port-panel"));
P.DATA.alloc = { ...CMA_ALLOC, port: { active: false, reason: "합성 데이터 없음" } };
P.renderSection("alloc");
r.portMissingShown = /합성 데이터 없음/.test(info());
choose("institution");
r.institutionWorksWithoutPort = !byId("alloc-sim-panel").hidden && !!byId("alloc-lambda");
choose("port");
P.openAllocDetail("sim");
r.detailSelectsInstitution = byId("alloc-port-panel").hidden && !byId("alloc-sim-panel").hidden;
P.hideDetail();

/* 서로 다른 창 통계로 선택값·표·차트·저장을 연결해서 확인한다. */
const sampled = JSON.parse(JSON.stringify(CMA_ALLOC));
sampled.port.cma_input = null;
const three = sampled.port.windows.find((w) => w.key === "3");
three.start = "2027-07-31";
three.mean_pct = three.mean_pct.map((v) => v + 1);
three.vol_pct = three.vol_pct.map((v) => v / 2);
three.cov = three.cov.map((row) => row.map((v) => v / 4));
shim.localStorage.removeItem("iaw-port");
shim.localStorage.removeItem("iaw-alloc");
P.DATA.alloc = sampled;
P.renderSection("alloc");
choose("port");
const options = (id) => [...byId(id).querySelectorAll("option")].map((n) => n.getAttribute("value"));
r.availablePeriodsOnly = JSON.stringify(options("port-period")) === JSON.stringify(sampled.port.windows.map((w) => w.key));
const chartData = () => JSON.stringify(shim.UPlotStub.made.filter((u) =>
  u.opts.series.some((s) => s.label === "경계선")).at(-1).data);
const beforePeriodChart = chartData();
change(input("alloc-port-panel", "국내채권 비중"), 30.4);
change(byId("port-period"), "3", "change");
const firstRow = byId("alloc-port-panel").querySelector("tbody tr");
const cells = [...firstRow.querySelectorAll("td")];
r.periodUpdatesStatistics = +cells[3].textContent === three.mean_pct[0]
  && Math.abs(+cells[4].textContent - three.vol_pct[0]) < 1e-9
  && /2027-07-31~2030-06-30 · 36개월/.test(periodText("alloc-port-panel"));
r.periodUpdatesChart = chartData() !== beforePeriodChart;
r.periodSavesDraft = JSON.parse(shim.localStorage.getItem("iaw-port")).mix.국내채권 === 30.4
  && JSON.parse(shim.localStorage.getItem("iaw-port")).win === "3";
r.periodRetainsFocus = DOC.activeElement === byId("port-period");
const savedPortPeriod = shim.localStorage.getItem("iaw-port");
change(byId("port-period"), "10", "change");
r.unavailablePeriodIgnored = byId("port-period").value === "3"
  && shim.localStorage.getItem("iaw-port") === savedPortPeriod;
choose("institution");
const instWindow = sampled.cma.windows.find((w) => w.key !== byId("institution-period").value);
change(byId("institution-period"), instWindow.key, "change");
r.institutionPeriodSelected = JSON.parse(shim.localStorage.getItem("iaw-alloc")).cma_win === instWindow.key
  && byId("institution-period").value === instWindow.key
  && DOC.activeElement === byId("institution-period")
  && P.allocEngine(sampled, P.allocState(sampled)).cmaW.key === instWindow.key;
choose("port");
r.periodsStaySeparate = byId("port-period").value === "3"
  && shim.localStorage.getItem("iaw-port") === savedPortPeriod;
shim.localStorage.setItem("iaw-port", JSON.stringify({win: "10"}));
P.renderPortPanel(sampled);
r.unavailableSavedPeriodFallsBack = byId("port-period").value === "all";
P.DATA.alloc = ALLOC_FIXTURE;
P.renderSection("alloc");
choose("institution");
change(byId("institution-period"), "y2015", "change");
r.proxyPeriodSelected = JSON.parse(shim.localStorage.getItem("iaw-alloc")).start_key === "y2015"
  && P.allocEngine(ALLOC_FIXTURE, P.allocState(ALLOC_FIXTURE)).set.key === "y2015"
  && byId("institution-period").value === "y2015";
r.finalNoRenderErrors = byId("alloc").querySelectorAll(".render-error").length === 0;
process.stdout.write(JSON.stringify(r));
