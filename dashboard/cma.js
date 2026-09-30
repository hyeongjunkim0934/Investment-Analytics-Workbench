/* Capital Market Assumptions: user scenario drafts and explicitly applied values.
   Annual percentage units throughout; no market payload or portfolio inputs mutate.
   Loaded before app.js; functions run only after its DOM/helpers are available. */
"use strict";

const CMA_LS_KEY = "iaw-cma-scenarios-v1";
const CMA_SCENARIOS = [
  { id: "optimistic", label: "낙관" },
  { id: "neutral", label: "중립" },
  { id: "pessimistic", label: "비관" },
];
const CMA_PROBABILITY_TOLERANCE = Number.EPSILON * 100 * 16;
let cmaStateCache = null;
let cmaStorageError = "";
let cmaPopup = null;
let cmaPopupSequence = 0;

function cmaNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function cmaMoments(scenarios) {
  const fail = (error, probabilitySum = null) => ({ valid: false, error, mu: null, sig: null, probabilitySum });
  if (!Array.isArray(scenarios) || scenarios.length !== 3)
    return fail("낙관·중립·비관 시나리오 3개를 입력하십시오.");
  const rows = scenarios.map((s) => ({ p: cmaNumber(s?.p), mu: cmaNumber(s?.mu), sig: cmaNumber(s?.sig) }));
  if (rows.some((s) => !Number.isFinite(s.p) || s.p < 0 || s.p > 100))
    return fail("확률은 0부터 100% 사이의 숫자로 입력하십시오.");
  const probabilitySum = rows.reduce((sum, s) => sum + s.p, 0);
  if (rows.some((s) => !Number.isFinite(s.mu)))
    return fail("모든 시나리오의 기대수익률을 숫자로 입력하십시오.", probabilitySum);
  if (rows.some((s) => !Number.isFinite(s.sig) || s.sig < 0))
    return fail("모든 시나리오의 변동성을 0 이상의 숫자로 입력하십시오.", probabilitySum);
  if (Math.abs(probabilitySum - 100) > CMA_PROBABILITY_TOLERANCE)
    return fail("시나리오 확률 합계를 100%로 맞추십시오.", probabilitySum);
  // Only IEEE-754 summation roundoff passes the tolerance above. Dividing by
  // that accepted sum corrects roundoff; substantive non-100 weights are rejected.
  // Centering preserves an identical-mean scenario exactly, including large means.
  const anchor = rows.find((s) => s.p > 0).mu;
  const mu = anchor + rows.reduce((sum, s) => s.p === 0 ? sum
    : sum + s.p / probabilitySum * (s.mu - anchor), 0);
  // Total variance = within-scenario variance + between-scenario mean variance.
  // Zero-probability rows are validated above, but contribute precisely zero.
  const variance = rows.reduce((sum, s) => s.p === 0 ? sum
    : sum + s.p / probabilitySum * (s.sig * s.sig + (s.mu - mu) ** 2), 0);
  if (!Number.isFinite(mu) || !Number.isFinite(variance) || variance < 0)
    return fail("입력값이 계산 범위를 초과했습니다.", probabilitySum);
  return { valid: true, error: "", mu, sig: Math.sqrt(variance), probabilitySum };
}

function cmaCopyScenarios(rows) {
  return CMA_SCENARIOS.map((definition, i) => ({ id: definition.id,
    p: rows[i].p, mu: rows[i].mu, sig: rows[i].sig }));
}

function cmaMigrateAssetNames(store) {
  const assets = typeof DATA === "undefined" ? [] : DATA.alloc?.port?.assets || [];
  // Asset labels are storage identities. Preserve the applied values, unfinished
  // drafts and enabled flag as one record; an existing current-name entry wins.
  // Recheck cached state after data loads or the portfolio universe changes.
  for (const [oldName, name] of Object.entries({
    원화유동성: "국내장부", 국내채권: "국내시가", 해외채권: "해외시가",
  })) {
    if (!assets.includes(name) || assets.includes(oldName)
        || !Object.prototype.hasOwnProperty.call(store.assets, oldName)) continue;
    if (!Object.prototype.hasOwnProperty.call(store.assets, name))
      store.assets[name] = store.assets[oldName];
    delete store.assets[oldName];
  }
  return store;
}

function cmaStore() {
  if (cmaStateCache) return cmaMigrateAssetNames(cmaStateCache);
  cmaStateCache = { version: 1, assets: {} };
  try {
    const text = localStorage.getItem(CMA_LS_KEY);
    if (text == null) return cmaStateCache;
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || !parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets))
      throw new Error("Unsupported CMA state");
    cmaStateCache = parsed;
  } catch {
    cmaStorageError = "저장된 CMA를 읽지 못했습니다. 이번 화면의 입력은 새 초안입니다.";
  }
  return cmaMigrateAssetNames(cmaStateCache);
}

function cmaSave() {
  try {
    localStorage.setItem(CMA_LS_KEY, JSON.stringify(cmaStore()));
    cmaStorageError = "";
  } catch {
    cmaStorageError = "CMA 저장 실패 — 현재 화면에만 반영됩니다. 새로고침하면 변경분이 사라질 수 있습니다.";
  }
  const status = document.getElementById("cma-storage-status");
  if (status) { status.textContent = cmaStorageError; status.hidden = !cmaStorageError; }
  return !cmaStorageError;
}

function cmaUnderlyingBaseline(P, st, asset) {
  const i = P.assets.indexOf(asset), wins = P.windows || [];
  const W = wins.find((w) => w.key === st.win) || wins[wins.length - 1];
  const manualMu = cmaNumber(st.mu?.[asset]), fileMu = cmaNumber(P.cma_input?.mu_pct?.[asset]);
  const manualSig = cmaNumber(st.sig?.[asset]), variance = W?.cov?.[i]?.[i];
  const mu = Number.isFinite(manualMu) ? manualMu : Number.isFinite(fileMu) ? fileMu : cmaNumber(W?.mean_pct?.[i]);
  const sig = Number.isFinite(manualSig) && manualSig >= 0 ? manualSig
    : Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance * 1e4) : NaN;
  return { mu: Number.isFinite(mu) ? mu : "", sig: Number.isFinite(sig) ? sig : "",
    source: Number.isFinite(manualMu) ? "자산배분 키인" : Number.isFinite(fileMu) ? "CMA 파일" : "과거 평균",
    window: W?.key || null };
}

function cmaEnsureAsset(asset, baseline = { mu: "", sig: "", source: "미설정" }) {
  const store = cmaStore();
  if (!Object.prototype.hasOwnProperty.call(store.assets, asset) || !store.assets[asset]
      || typeof store.assets[asset] !== "object" || Array.isArray(store.assets[asset]))
    store.assets[asset] = { enabled: false, applied: null, baseline: { ...baseline },
      draft: CMA_SCENARIOS.map((s, i) => ({ id: s.id, p: i === 1 ? 50 : 25, mu: baseline.mu, sig: baseline.sig })) };
  const entry = store.assets[asset];
  if (!Array.isArray(entry.draft) || entry.draft.length !== 3 || entry.draft.some((s) => !s || typeof s !== "object")) {
    entry.draft = cmaMoments(entry.applied).valid ? cmaCopyScenarios(entry.applied)
      : CMA_SCENARIOS.map((s, i) => ({ id: s.id, p: i === 1 ? 50 : 25, mu: baseline.mu, sig: baseline.sig }));
    cmaStorageError = "저장된 CMA 초안의 형식이 잘못되어 복구했습니다. 적용값을 확인하십시오.";
  }
  if (entry.applied != null && !cmaMoments(entry.applied).valid) {
    entry.enabled = false;
    entry.applied = null;
    cmaStorageError = "저장된 CMA 적용값이 유효하지 않아 적용을 해제했습니다. 초안을 확인한 뒤 다시 적용하십시오.";
  }
  return entry;
}

function cmaAssetAssumption(asset) {
  const entry = cmaStore().assets[asset];
  if (!entry || entry.enabled !== true) return null;
  const moments = cmaMoments(entry.applied);
  if (!moments.valid) return null;
  return { mu: moments.mu, sig: moments.sig,
    scenarios: cmaCopyScenarios(entry.applied).map((s) => ({ ...s, p: Number(s.p), mu: Number(s.mu), sig: Number(s.sig) })) };
}

function cmaNotifyAllocation() {
  cmaClosePopup();
  if (typeof renderSection === "function") renderSection("alloc");
}

function cmaApplyAsset(asset) {
  const entry = cmaStore().assets[asset];
  const moments = cmaMoments(entry?.draft);
  if (!moments.valid) return moments;
  entry.applied = cmaCopyScenarios(entry.draft).map((s) => ({ ...s, p: Number(s.p), mu: Number(s.mu), sig: Number(s.sig) }));
  entry.enabled = true;
  const persisted = cmaSave();
  cmaNotifyAllocation();
  return { ...moments, persisted };
}

function cmaSetEnabled(asset, enabled) {
  const entry = cmaStore().assets[asset];
  if (!entry) return false;
  if (enabled && !cmaMoments(entry.applied).valid) return false;
  entry.enabled = enabled === true;
  cmaSave(); cmaNotifyAllocation();
  return true;
}

function cmaDraftChanged(entry) {
  return !cmaMoments(entry.applied).valid || JSON.stringify(cmaCopyScenarios(entry.draft).map((s) =>
    ({ p: cmaNumber(s.p), mu: cmaNumber(s.mu), sig: cmaNumber(s.sig) }))) !== JSON.stringify(
    cmaCopyScenarios(entry.applied).map((s) => ({ p: cmaNumber(s.p), mu: cmaNumber(s.mu), sig: cmaNumber(s.sig) })));
}

function renderCma() {
  cmaClosePopup();
  const host = document.getElementById("cma-content");
  if (!host) return;
  host.replaceChildren();
  cmaStore();
  const storage = el("p", { id: "cma-storage-status", class: "cma-warning", role: "status" }, cmaStorageError);
  storage.hidden = !cmaStorageError;
  host.append(el("div", { class: "cma-heading" },
    el("span", { class: "cma-subtitle" }, "Capital Market Assumptions"),
    el("a", { href: "#alloc", class: "btn-ghost" }, "자산배분")), storage);
  const P = typeof DATA === "undefined" ? null : DATA.alloc?.port;
  if (!P?.active || !P.assets?.length || !P.windows?.length) {
    host.append(el("p", { class: "cma-warning", role: "status" },
      `포트폴리오 데이터가 없습니다${P?.reason ? ` — ${P.reason}` : ". 데이터 갱신 후 사용할 수 있습니다."}`));
    return;
  }
  const st = typeof portPanelDraft !== "undefined" && portPanelDraft?.source === P ? portPanelDraft.st : portState(P);
  host.append(el("p", { class: "cma-unit" }, "1년 가정 · 연간 기대수익률·변동성 % · 자산별 확률 합계 100% · 적용 후 자산배분 반영"));
  const grid = el("div", { class: "cma-grid" });
  P.assets.forEach((asset, i) => {
    const entry = cmaEnsureAsset(asset, cmaUnderlyingBaseline(P, st, asset));
    const statusId = `cma-asset-status-${i}`;
    const toggle = el("input", { type: "checkbox", "aria-label": `${asset} CMA 적용` });
    const card = el("article", { class: "card cma-card", "aria-label": `${asset} CMA` });
    const stateLabel = el("span", { class: "cma-state" });
    card.append(el("div", { class: "cma-card-head" }, el("h3", {}, asset),
      el("label", { class: "cma-enable" }, toggle, stateLabel)));
    if (P.asset_notes?.[asset]) card.append(el("p", { class: "cma-unit cma-source-note" }, P.asset_notes[asset]));
    const table = el("table", { class: "cma-table" });
    table.append(el("thead", {}, el("tr", {},
      ...["시나리오", "확률 %", "기대수익 %", "변동성 %"].map((s) => el("th", { scope: "col" }, s)))));
    const body = el("tbody"), inputs = [];
    const status = el("p", { id: statusId, class: "cma-status", role: "status" });
    const totals = el("div", { class: "cma-totals" });
    const applied = el("p", { class: "cma-applied" });
    const apply = el("button", { type: "button", class: "btn-ghost cma-apply" }, "적용");
    const refresh = () => {
      const result = cmaMoments(entry.draft), validApplied = cmaMoments(entry.applied).valid;
      toggle.checked = entry.enabled === true && validApplied;
      toggle.disabled = !validApplied;
      stateLabel.textContent = toggle.checked ? "CMA 적용" : "CMA 해제";
      inputs.forEach(({ input, row, field }) => {
        const v = cmaNumber(entry.draft[row][field]);
        const valid = Number.isFinite(v) && (field !== "p" || v >= 0 && v <= 100) && (field !== "sig" || v >= 0);
        input.setAttribute("aria-invalid", String(!valid));
      });
      totals.replaceChildren(
        el("span", {}, "확률 합계 ", el("strong", {}, `${fmtNum(result.probabilitySum, 2)}%`)),
        el("span", {}, "기대수익 ", el("strong", {}, `${fmtNum(result.mu, 2)}%`)),
        el("span", {}, "변동성 ", el("strong", {}, `${fmtNum(result.sig, 2)}%`)));
      const changed = cmaDraftChanged(entry);
      status.classList.toggle("cma-warning", !result.valid);
      status.textContent = !result.valid ? `${result.error} 기존 적용값은 유지됩니다.`
        : changed ? "미적용 초안" : entry.enabled ? "자산배분 반영 중" : "CMA 해제 · 자산배분 입력 사용";
      const current = cmaAssetAssumption(asset);
      applied.textContent = current ? `적용값 ${fmtNum(current.mu, 2)}% / ${fmtNum(current.sig, 2)}% (μ / σ)`
        : "자산배분 입력값 사용";
      apply.disabled = !result.valid;
      apply.textContent = current && !changed ? "적용 완료" : "적용";
    };
    CMA_SCENARIOS.forEach((definition, row) => {
      const tr = el("tr", {}, el("th", { scope: "row", class: `cma-${definition.id}` }, definition.label));
      [["p", "확률"], ["mu", "기대수익"], ["sig", "변동성"]].forEach(([field, label]) => {
        const attrs = { type: "number", step: "any", value: entry.draft[row][field] ?? "",
          "aria-label": `${asset} ${definition.label} ${label} %`, "aria-describedby": statusId };
        if (field !== "mu") attrs.min = "0";
        if (field === "p") attrs.max = "100";
        const input = el("input", attrs);
        input.addEventListener("input", () => {
          entry.draft[row][field] = input.validity?.badInput ? "" : input.value;
          cmaSave(); refresh();
        });
        inputs.push({ input, row, field });
        tr.append(el("td", {}, input));
      });
      body.append(tr);
    });
    table.append(body);
    apply.addEventListener("click", () => { cmaApplyAsset(asset); refresh(); });
    toggle.addEventListener("change", () => { cmaSetEnabled(asset, toggle.checked); refresh(); });
    card.append(table, totals, el("div", { class: "cma-card-actions" }, applied, apply), status);
    refresh(); grid.append(card);
  });
  host.append(grid);
  const details = [
    el("p", {}, "입력·산출: 사용자 가정, 1년 수익률 기준(연 %) · 추가 환헤지 전. 자산별 적용을 누르면 기대수익과 변동성이 자산배분에 함께 반영됩니다."),
    el("p", {}, "초기 확률 25/50/25%는 편집용 가정이며 세 시나리오의 μ·σ는 모두 현재 자산배분 기준값으로 시작합니다. 전망 차이는 직접 입력하십시오."),
    el("p", {}, "기대수익은 확률가중 평균입니다. 변동성은 시나리오 내부 분산과 시나리오 평균 차이의 분산을 합산합니다."),
    el("p", {}, "기존 자산 간 상관계수를 유지합니다. 자산별 시나리오는 공동 시나리오를 정의하지 않으므로 시나리오별 포트폴리오 손익·공분산을 직접 추정한 결과가 아닙니다."),
    el("p", {}, "초안과 적용값은 이 브라우저에 저장됩니다. CMA 해제 시 기존 자산배분 μ·σ 입력을 사용합니다."),
  ];
  host.append(typeof explainBox === "function" ? explainBox("cma-method", { label: "산식·기준" }, ...details)
    : el("details", { class: "explain" }, el("summary", {}, "산식·기준"), ...details));
  storage.textContent = cmaStorageError; storage.hidden = !cmaStorageError;
}

function cmaClosePopup() {
  if (!cmaPopup) return;
  const previous = cmaPopup;
  cmaPopup = null;
  clearTimeout(previous.timer);
  previous.node.remove();
  previous.trigger.setAttribute("aria-expanded", "false");
  previous.cleanup();
}

function cmaCloseTooltip() { cmaClosePopup(); }

function cmaAssetLabel(asset) {
  let suppressFocus = false;
  const popupId = `cma-popup-${++cmaPopupSequence}`;
  const trigger = el("button", { type: "button", class: "cma-asset-label", "aria-haspopup": "dialog",
    "aria-expanded": "false", "aria-controls": popupId, "aria-label": `${asset} 시나리오 보기` }, asset);
  const restoreFocus = () => {
    suppressFocus = true; trigger.focus(); suppressFocus = false;
  };
  const open = () => {
    if (cmaPopup?.trigger === trigger) { clearTimeout(cmaPopup.timer); return; }
    cmaClosePopup();
    const node = el("div", { id: popupId, class: "cma-popup", role: "dialog", "aria-label": `${asset} CMA 시나리오` });
    const close = el("button", { type: "button", class: "cma-popup-close", "aria-label": "시나리오 닫기" }, "×");
    const heading = el("div", { class: "cma-popup-head" }, el("strong", {}, asset), close);
    node.append(heading);
    const entry = cmaStore().assets[asset], result = cmaMoments(entry?.applied);
    if (result.valid) {
      node.append(el("p", { class: "cma-popup-state" }, entry.enabled ? "적용 중 · 1년 가정 · 연 % · 추가 환헤지 전" : "CMA 해제 · 마지막 적용 시나리오 · 1년 가정 · 연 %"));
      const table = el("table", { class: "cma-popup-table" });
      table.append(el("thead", {}, el("tr", {}, ...["시나리오", "확률 %", "기대수익 %", "변동성 %"].map((s) => el("th", {}, s)))));
      const tbody = el("tbody");
      CMA_SCENARIOS.forEach((definition, i) => {
        const s = entry.applied[i];
        tbody.append(el("tr", {}, el("th", { scope: "row" }, definition.label),
          ...[s.p, s.mu, s.sig].map((v) => el("td", {}, fmtNum(cmaNumber(v), 2)))));
      });
      table.append(tbody); node.append(table);
      node.append(el("p", { class: "cma-popup-total" }, `${entry.enabled ? "적용" : "마지막 적용"} μ ${fmtNum(result.mu, 2)}% · σ ${fmtNum(result.sig, 2)}%`));
      if (Array.isArray(entry.draft) && entry.draft.length === 3 && entry.draft.every((s) => s && typeof s === "object") && cmaDraftChanged(entry))
        node.append(el("p", { class: "cma-popup-state" }, "미적용 초안 있음"));
    } else node.append(el("p", { class: "cma-popup-state" }, "적용된 시나리오가 없습니다. CMA에서 입력 후 적용하십시오."));
    node.append(el("a", { href: "#cma", class: "cma-popup-link" }, "CMA 편집 →"));
    document.body.append(node);
    trigger.setAttribute("aria-expanded", "true");
    const position = () => {
      const anchor = trigger.getBoundingClientRect(), rect = node.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
      const left = Math.max(8, Math.min(anchor.left, viewportWidth - rect.width - 8));
      const below = anchor.bottom + 6;
      const top = Math.max(8, below + rect.height <= viewportHeight - 8 ? below : anchor.top - rect.height - 6);
      node.style.left = `${left}px`; node.style.top = `${top}px`;
    };
    const keydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); cmaClosePopup(); restoreFocus(); }
    };
    const outside = (event) => { if (!node.contains(event.target) && !trigger.contains(event.target)) cmaClosePopup(); };
    const hide = () => cmaClosePopup();
    const onScroll = (event) => { if (!node.contains(event.target)) cmaClosePopup(); };
    const focusout = (event) => { if (!node.contains(event.relatedTarget) && event.relatedTarget !== trigger) scheduleClose(); };
    const scheduleClose = () => {
      if (cmaPopup?.trigger !== trigger) return;
      clearTimeout(cmaPopup.timer);
      cmaPopup.timer = setTimeout(() => {
        if (cmaPopup?.trigger === trigger && document.activeElement !== trigger && !node.contains(document.activeElement)) cmaClosePopup();
      }, 180);
    };
    node.addEventListener("mouseenter", () => { if (cmaPopup) clearTimeout(cmaPopup.timer); });
    node.addEventListener("mouseleave", scheduleClose);
    node.addEventListener("focusout", focusout);
    close.addEventListener("click", () => { cmaClosePopup(); restoreFocus(); });
    node.querySelector("a").addEventListener("click", hide);
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("hashchange", hide);
    cmaPopup = { node, trigger, timer: null, cleanup: () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("hashchange", hide);
    } };
    position();
  };
  trigger.addEventListener("mouseenter", open);
  trigger.addEventListener("focus", () => { if (!suppressFocus) open(); });
  trigger.addEventListener("click", open);
  trigger.addEventListener("mouseleave", () => {
    if (cmaPopup?.trigger !== trigger) return;
    clearTimeout(cmaPopup.timer);
    cmaPopup.timer = setTimeout(() => {
      if (cmaPopup?.trigger === trigger && document.activeElement !== trigger && !cmaPopup.node.contains(document.activeElement)) cmaClosePopup();
    }, 180);
  });
  trigger.addEventListener("blur", (event) => {
    if (cmaPopup?.trigger !== trigger || cmaPopup.node.contains(event.relatedTarget)) return;
    cmaClosePopup();
  });
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault(); open(); cmaPopup?.node.querySelector("a")?.focus();
    }
  });
  return trigger;
}
