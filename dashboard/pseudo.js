/* Maintained handoff notes, separate from pricing/optimization. See docs/PSEUDO.md. */
"use strict";

const PSEUDO_ORDER = ["overview", "risk", "alloc", "hedge", "fx"];
const PSEUDO_REPO = "https://github.com/hyeongjunkim0934/Investment-Analytics-Workbench";
const PSEUDO_BASE = `${PSEUDO_REPO}/blob/claude/data-repo-dashboard-automation-cj8y59/`;
let pseudoSelected = "overview";

function pseudoText(doc) {
  const lines = [`# ${doc.title} · Pseudo`, `검토일: ${doc.updated}`, "", doc.summary,
    "", `입력: ${doc.inputs}`, `출력: ${doc.outputs}`];
  if (doc.readingGuide?.length) lines.push("", "## 읽는 순서", ...doc.readingGuide.map((s) => `- ${s}`));
  if (doc.diagram) {
    lines.push("", `## ${doc.diagram.title}`, doc.diagram.caption);
    doc.diagram.layers.forEach((layer) => {
      lines.push("", `### ${layer.title}`, ...layer.nodes.map((n) => `- ${n.title}: ${n.detail}`));
      if (layer.next) lines.push(`→ ${layer.next}`);
    });
    lines.push("", ...doc.diagram.relations.map((s) => `- ${s}`));
  }
  doc.sections.forEach((section) => {
    lines.push("", `## ${section.title}`, section.purpose || "");
    (section.formulas || []).forEach((f) => lines.push("", "\\[", f.latex || f.expression, "\\]", f.legend));
    lines.push("", "### 처리 순서", "```text", section.code, "```", "", section.note);
    if (section.decisions?.length) lines.push("", "### 판단 경계", ...section.decisions.map((s) => `- ${s}`));
    if (section.checks?.length) lines.push("", "### 인수 검증", ...section.checks.map((s) => `- ${s}`));
    (section.sources || []).forEach((s) => lines.push(`${s.path} · ${s.symbols.join(", ")}`, PSEUDO_BASE + s.path));
  });
  lines.push("", "## 원본 코드");
  doc.sources.forEach((s) => lines.push(`${s.path} · ${s.symbols.join(", ")}`, PSEUDO_BASE + s.path));
  return lines.join("\n");
}

function pseudoFormula(formula) {
  const node = el("div", { class: "pseudo-formula", role: "math", "aria-label": formula.expression }, formula.expression);
  try {
    if (!globalThis.katex || !formula.latex) throw new Error("math renderer unavailable");
    globalThis.katex.render(formula.latex, node, {
      displayMode: true, throwOnError: true, trust: false, output: "htmlAndMathml"
    });
  } catch {
    node.textContent = formula.expression;
    node.classList.add("pseudo-formula-fallback");
    node.setAttribute("data-math-fallback", "true");
  }
  return node;
}

function pseudoList(title, items, className) {
  return el("div", { class: className }, el("h4", {}, title),
    el("ul", {}, ...items.map((item) => el("li", {}, item))));
}

function pseudoDiagram(diagram, select) {
  const figure = el("figure", { class: "pseudo-diagram", "aria-label": diagram.title },
    el("figcaption", {}, el("h3", {}, diagram.title), el("p", {}, diagram.caption)));
  diagram.layers.forEach((layer, index) => {
    const row = el("div", { class: "pseudo-map-layer" },
      el("div", { class: "pseudo-map-label" }, `${String(index + 1).padStart(2, "0")} · ${layer.title}`));
    const nodes = el("div", { class: "pseudo-map-nodes" });
    layer.nodes.forEach((item) => {
      const node = el("div", { class: "pseudo-map-node" }, el("strong", {}, item.title), el("p", {}, item.detail));
      if (item.target) {
        const button = el("button", { type: "button", class: "pseudo-map-link" }, "모듈 읽기 →");
        button.addEventListener("click", () => select(item.target, true));
        node.append(button);
      }
      nodes.append(node);
    });
    row.append(nodes); figure.append(row);
    if (layer.next) figure.append(el("p", { class: "pseudo-map-arrow" }, "↓ ", layer.next));
  });
  figure.append(pseudoList("모듈 사이의 연결", diagram.relations, "pseudo-map-relations"));
  return figure;
}

function pseudoSourceLink(source) {
  return el("p", {}, el("a", { href: PSEUDO_BASE + source.path, target: "_blank", rel: "noopener noreferrer" }, source.path),
    " · ", source.symbols.join(" · "));
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
    if (doc.readingGuide?.length) body.append(pseudoList("읽는 순서", doc.readingGuide, "pseudo-guide"));
    if (doc.diagram) body.append(pseudoDiagram(doc.diagram, select));
    const layout = el("div", { class: "pseudo-reading-layout" });
    const toc = el("nav", { class: "pseudo-toc", "aria-label": `${doc.title} 목차` }, el("h3", {}, "이 문서의 흐름"));
    const grid = el("div", { class: "pseudo-grid" });
    let mathFallback = false;
    doc.sections.forEach((section, index) => {
      const number = String(index + 1).padStart(2, "0");
      const card = el("article", { class: "card pseudo-card", id: `pseudo-${id}-${section.id}`, tabindex: "-1" },
        el("h3", {}, el("span", { class: "pseudo-number", "aria-hidden": "true" }, number), section.title));
      const jump = el("button", { type: "button" }, `${number} ${section.title}`);
      jump.addEventListener("click", () => { card.focus(); card.scrollIntoView({ block: "start" }); });
      toc.append(jump);
      if (section.purpose) card.append(el("p", { class: "pseudo-purpose" }, section.purpose));
      (section.formulas || []).forEach((formula) => {
        const node = pseudoFormula(formula);
        mathFallback ||= node.hasAttribute("data-math-fallback");
        card.append(node, el("p", { class: "pseudo-legend" }, formula.legend));
      });
      card.append(el("h4", {}, "처리 순서"),
        el("pre", { class: "pseudo-code" }, el("code", {}, section.code)),
        el("p", { class: "pseudo-note" }, section.note));
      if (section.decisions?.length) card.append(pseudoList("판단 경계", section.decisions, "pseudo-decisions"));
      if (section.checks?.length) card.append(pseudoList("인수 검증", section.checks, "pseudo-checks"));
      if (section.sources?.length) {
        const refs = el("details", { class: "pseudo-section-sources" }, el("summary", {}, "구현 위치"));
        section.sources.forEach((source) => refs.append(pseudoSourceLink(source))); card.append(refs);
      }
      grid.append(card);
    });
    if (mathFallback) body.append(el("p", { class: "pseudo-math-status", role: "status" },
      "일부 수식을 일반 텍스트로 표시합니다. 복사에는 LaTeX 원문이 포함됩니다."));
    layout.append(toc, grid); body.append(layout);
    const sources = el("details", { class: "pseudo-sources" }, el("summary", {}, "원본 코드 · 갱신"));
    doc.sources.forEach((source) => sources.append(pseudoSourceLink(source)));
    sources.append(el("p", {}, "수식·단위·처리 순서 변경 시 해당 문서와 검토일을 함께 갱신합니다."),
      el("a", { href: PSEUDO_BASE + `dashboard/pseudo/${id}.js`, target: "_blank", rel: "noopener noreferrer" }, "문서 원본"),
      " · ", el("a", { href: PSEUDO_BASE + "docs/PSEUDO.md", target: "_blank", rel: "noopener noreferrer" }, "갱신 규칙"));
    body.append(sources);
  };
  PSEUDO_ORDER.forEach((id, index) => {
    const button = el("button", { type: "button", role: "tab", id: `pseudo-tab-${id}`,
      "aria-controls": "pseudo-panel" }, docs[id]?.title || ({overview: "Overview", risk: "리스크", alloc: "자산배분", hedge: "환헤지", fx: "환율전망"}[id]));
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
  select(PSEUDO_ORDER.includes(pseudoSelected) ? pseudoSelected : "overview");
}
