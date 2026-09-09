/* 기존 VM/DOM 부팅부만 재사용한다. 전체 대시보드 최적화 프로브는 실행하지 않는다. */
"use strict";
const fs = require("fs");
const path = require("path");
const source = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const marker = "\nconst out = {};";
if (!source.includes(marker)) throw new Error("dashboard_probe 부팅 경계를 찾지 못했습니다");
const boot = source.slice(0, source.indexOf(marker)).replace("const EXPORTS = [",
  'const EXPORTS = ["todayKst", "observationAge", "observationBadge", "renderDataFreshness", "renderOverview", "openOvDetail",');

new Function("require", "__dirname", "process", boot + `
const out = {};
const today = "2026-09-09";
let nowMs = Date.parse("2026-09-09T00:00:00Z");
sandbox.Date = class extends Date {
  constructor(...args) { super(...(args.length ? args : [nowMs])); }
  static now() { return nowMs; }
};
out.ages = {
  same: P.observationAge("2026-09-09", today),
  four: P.observationAge("2026-09-05", today),
  five: P.observationAge("2026-09-04", today),
  future: P.observationAge("2026-09-10", today),
  missing: P.observationAge(null, today),
  invalid: P.observationAge("2026-02-30", today),
  invalidLeap: P.observationAge("2025-02-29", today),
  validLeap: P.observationAge("2024-02-29", "2024-03-01"),
  invalidToday: P.observationAge("2026-09-09", "2026-02-30"),
  malformed: P.observationAge("2026-9-9", today),
};
out.kst = ["2026-09-08T14:59:59.999Z", "2026-09-08T15:00:00.000Z",
  "2026-12-31T15:00:00.000Z"].map((x) => P.todayKst(new Date(x)));

const host = elem("div", "data-freshness");
header.append(host);
const readHost = () => ({ text: host.textContent, check: host.classList.contains("needs-check"),
  hidden: host.hidden, link: host.querySelector("a").getAttribute("href") });
const card = (label, date, extra = {}) => ({ key: "info:" + label, label, source: "info",
  kind: "price", unit: "", value: 117.9, date, link: "fx", chg: {d1: 17.9},
  spark: null, ...extra });
P.DATA.meta = {last_observation: "2026-09-04", built_at: "2026-09-09T01:00:00Z"};
P.DATA.overview = {cards: [
  card("오늘", "2026-09-09"), card("4일", "2026-09-05"), card("5일", "2026-09-04"),
  card("누락", null), card("미래", "2026-09-10"), card("무효", "2026-02-30"),
]};
P.renderOverview();
P.renderDataFreshness(today);
out.staleDespiteNewBuild = readHost();
out.badges = [...DOC.querySelectorAll(".observation-age")].map((n) => ({
  text: n.textContent, check: n.classList.contains("needs-check"), date: n.getAttribute("data-observed")
}));
P.renderDataFreshness("2026-09-10");
out.nextDayBadges = [...DOC.querySelectorAll(".observation-age")].map((n) => ({
  text: n.textContent, check: n.classList.contains("needs-check")
}));
P.DATA.meta = {last_observation: today, built_at: "2026-07-01T00:00:00Z"};
P.renderDataFreshness(today);
out.freshMetaStaleCards = readHost();
P.DATA.overview.cards = [card("최신", today)];
P.renderDataFreshness(today);
out.freshDespiteOldBuild = readHost();
P.DATA.meta = {built_at: "2026-09-09T01:00:00Z"};
P.renderDataFreshness(today);
out.missingObservation = readHost();
P.DATA.meta = {last_observation: "2026-09-10", built_at: "2026-09-09T01:00:00Z"};
P.renderDataFreshness(today);
out.futureObservation = readHost();
delete P.DATA.meta;
host.hidden = true;
host.textContent = "이전 값";
P.renderMetaLine();
out.metaLineWithoutMeta = readHost();

P.DATA.meta = {last_observation: today};
P.DATA.overview.cards = [card("경계 전", "2026-09-05")];
P.renderOverview();
P.renderDataFreshness(today);
out.beforeRoute = readHost();
nowMs = Date.parse("2026-09-09T15:00:00Z");
sandbox.location.hash = "#overview";
P.routeView();
out.afterRoute = readHost();
nowMs = Date.parse("2026-09-10T15:00:00Z");
DOC.hidden = true;
(DOC.listeners.visibilitychange || []).forEach((fn) => fn());
out.whileHidden = readHost();
DOC.hidden = false;
(DOC.listeners.visibilitychange || []).forEach((fn) => fn());
out.afterVisible = readHost();
nowMs = Date.parse("2026-09-09T00:00:00Z");

const gap = card("기간", "2026-09-01", {previous_date: "2026-08-20", d1_label: "직전 관측"});
const consecutive = card("연속", "2026-07-06", {previous_date: "2026-07-03", d1_label: "1일"});
const single = card("단일", "2026-09-01", {previous_date: null, d1_label: "직전 관측", chg: {d1:null}});
const legacy = card("이전 형식", "2026-09-01");
P.DATA.overview = {cards: [gap, consecutive, single, legacy]};
P.renderOverview();
out.overview = [...DOC.querySelectorAll(".kpi")].map((n) => ({text: n.textContent,
  delta: n.querySelector(".kpi-delta").textContent,
  period: n.querySelector(".kpi-period")?.textContent || null,
  source: n.querySelector(".kpi-source").textContent,
}));
P.openOvDetail({...gap, link: "", hist: {t: [1787184000, 1788220800], v: [100, 117.9]}});
out.detail = {delta: DOC.querySelector(".ov-detail-deltas").textContent,
  period: DOC.querySelector(".ov-detail-panel .kpi-period").textContent};
fs.writeSync(1, JSON.stringify(out));
process.exit(0);
`)(require, __dirname, process);
