/* Maintained handoff notes, separate from pricing/optimization. See docs/PSEUDO.md. */
"use strict";

const PSEUDO_ORDER = ["risk", "alloc", "hedge"];
const PSEUDO_REPO = "https://github.com/hyeongjunkim0934/Investment-Analytics-Workbench";
const PSEUDO_BASE = `${PSEUDO_REPO}/blob/claude/data-repo-dashboard-automation-cj8y59/`;
let pseudoSelected = "risk";

function pseudoText(doc) {
  const lines = [`# ${doc.title} · Pseudo`, `검토일: ${doc.updated}`, "", doc.summary,
    "", `입력: ${doc.inputs}`, `출력: ${doc.outputs}`];
  doc.sections.forEach((section) => {
    lines.push("", `## ${section.title}`);
    (section.formulas || []).forEach((f) => lines.push("", f.expression, f.legend));
    lines.push("", "```text", section.code, "```", section.note);
  });
  lines.push("", "## 원본 코드");
  doc.sources.forEach((s) => lines.push(`${s.path} · ${s.symbols.join(", ")}`, PSEUDO_BASE + s.path));
  return lines.join("\n");
}

function renderPseudoDocs() {
  const host = document.getElementById("pseudo-content");
  if (!host) return;
  const docs = globalThis.PSEUDO_DOCS || {};
  host.textContent = "";
  const tabs = el("div", { class: "seg pseudo-tabs", role: "tablist", "aria-label": "Pseudo 모듈" });
  const body = el("div", { id: "pseudo-panel", role: "tabpanel", tabindex: "0" });
  const select = (id, focus = false) => {
    pseudoSelected = id;
    tabs.querySelectorAll("button").forEach((button) => {
      const active = button.id === `pseudo-tab-${id}`;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("tabindex", active ? "0" : "-1");
      if (active && focus) button.focus();
    });
    body.setAttribute("aria-labelledby", `pseudo-tab-${id}`);
    body.textContent = "";
    const doc = docs[id];
    if (!doc) {
      body.append(el("p", { role: "status" }, "문서를 불러오지 못했습니다. 새로고침 후 다시 확인하세요."));
      return;
    }
    const status = el("span", { class: "pseudo-status", role: "status", "aria-live": "polite" });
    const copy = el("button", { type: "button", class: "pseudo-copy" }, "복사");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pseudoText(doc));
        status.textContent = "복사됨";
      } catch {
        status.textContent = "아래 내용을 선택해 복사하세요.";
        let fallback = body.querySelector(".pseudo-copy-fallback");
        if (!fallback) {
          fallback = el("textarea", { class: "pseudo-copy-fallback", readonly: "",
            "aria-label": "복사용 Pseudo 문서", rows: "8" });
          fallback.value = pseudoText(doc);
          body.append(fallback);
        }
        fallback.focus(); fallback.select();
      }
    });
    body.append(el("div", { class: "pseudo-overview" },
      el("p", { class: "pseudo-summary" }, doc.summary),
      el("div", { class: "pseudo-actions" }, el("span", {}, `검토 ${doc.updated}`), copy, status)),
    el("dl", { class: "pseudo-io" }, el("dt", {}, "입력"), el("dd", {}, doc.inputs),
      el("dt", {}, "출력"), el("dd", {}, doc.outputs)));
    const grid = el("div", { class: "pseudo-grid" });
    doc.sections.forEach((section, index) => {
      const card = el("article", { class: "card pseudo-card" },
        el("h3", {}, el("span", { class: "pseudo-number", "aria-hidden": "true" }, String(index + 1).padStart(2, "0")), section.title));
      (section.formulas || []).forEach((formula) => card.append(
        el("div", { class: "pseudo-formula", role: "math", "aria-label": formula.expression }, formula.expression),
        el("p", { class: "pseudo-legend" }, formula.legend)));
      card.append(el("pre", { class: "pseudo-code" }, el("code", {}, section.code)),
        el("p", { class: "pseudo-note" }, section.note));
      grid.append(card);
    });
    body.append(grid);
    const sources = el("details", { class: "pseudo-sources" }, el("summary", {}, "원본 코드 · 갱신"));
    doc.sources.forEach((source) => sources.append(el("p", {},
      el("a", { href: PSEUDO_BASE + source.path, target: "_blank", rel: "noopener noreferrer" }, source.path),
      " · ", source.symbols.join(" · "))));
    sources.append(el("p", {}, "수식·단위·처리 순서 변경 시 해당 문서와 검토일을 함께 갱신합니다."),
      el("a", { href: PSEUDO_BASE + `dashboard/pseudo/${id}.js`, target: "_blank", rel: "noopener noreferrer" }, "문서 원본"),
      " · ", el("a", { href: PSEUDO_BASE + "docs/PSEUDO.md", target: "_blank", rel: "noopener noreferrer" }, "갱신 규칙"));
    body.append(sources);
  };
  PSEUDO_ORDER.forEach((id, index) => {
    const button = el("button", { type: "button", role: "tab", id: `pseudo-tab-${id}`,
      "aria-controls": "pseudo-panel" }, docs[id]?.title || ({risk: "리스크", alloc: "자산배분", hedge: "환헤지"}[id]));
    button.addEventListener("click", () => select(id));
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % PSEUDO_ORDER.length;
      if (event.key === "ArrowLeft") next = (index + PSEUDO_ORDER.length - 1) % PSEUDO_ORDER.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = PSEUDO_ORDER.length - 1;
      if (next !== undefined) { event.preventDefault(); select(PSEUDO_ORDER[next], true); }
    });
    tabs.append(button);
  });
  host.append(tabs, body);
  select(pseudoSelected);
}
