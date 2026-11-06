/* Upload is an additional writer to the existing private Data → pipeline → Pages path.
   Mount once: changing tabs/themes must not discard selected files or an in-flight upload. */
(function () {
  "use strict";
  const ACTIONS = "https://github.com/hyeongjunkim0934/Investment-Analytics-Workbench/actions/workflows/build-dashboard.yml";
  const DATA_ACTIONS = "https://github.com/hyeongjunkim0934/Data/actions/workflows/notify-workbench.yml";
  let mounted = false, credential = "", snapshot = null, busy = false, committed = null, checking = false, connectionEpoch = 0;
  const byId = (id) => document.getElementById(id);
  function node(tag, attrs, text) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    if (text != null) n.textContent = text;
    return n;
  }
  function link(url, label) { return node("a", {href: url, target: "_blank", rel: "noopener noreferrer"}, label); }
  function status(message, error = false) {
    const n = byId("upload-status");
    n.textContent = message;
    n.classList.toggle("upload-error", error);
  }
  function updateControls() {
    const connected = !!snapshot && !!credential;
    byId("upload-token").disabled = busy || connected;
    byId("upload-connect").disabled = busy || connected;
    byId("upload-disconnect").disabled = busy || !connected;
    ["bb", "info"].forEach((kind) => {
      byId(`upload-${kind}`).disabled = busy;
      byId(`upload-${kind}-target`).disabled = busy || !connected;
    });
    byId("upload-submit").disabled = busy || !connected;
    byId("upload-check").disabled = busy || checking || !committed;
    byId("upload-refresh").disabled = busy || !committed || !committed.deployed;
    byId("upload-content").setAttribute("aria-busy", busy ? "true" : "false");
  }
  function forgetConnection() {
    credential = ""; snapshot = null;
    byId("upload-token").value = "";
    byId("upload-connection").textContent = "연결 전";
    ["bb", "info"].forEach((kind) => { byId(`upload-${kind}-target`).textContent = ""; });
  }
  async function connect() {
    if (busy || snapshot) return;
    const token = byId("upload-token").value.trim();
    byId("upload-token").value = "";
    if (!token) { status("GitHub 업로드 토큰을 입력하십시오.", true); return; }
    const epoch = connectionEpoch;
    busy = true; updateControls(); status("업로드 연결을 확인하고 있습니다.");
    try {
      const next = await window.IAWDataUploadClient.inspect(token);
      if (epoch !== connectionEpoch) return;
      credential = token; snapshot = next;
      byId("upload-connection").textContent = `${next.repository} · ${next.branch}`;
      ["bb", "info"].forEach((kind) => {
        const select = byId(`upload-${kind}-target`);
        select.textContent = "";
        const candidates = next.candidates[kind];
        if (candidates.length !== 1) select.append(node("option", {value: ""}, "교체할 기존 원본 선택"));
        candidates.forEach((entry) => select.append(node("option", {value: entry.path}, entry.path)));
        select.value = candidates.length === 1 ? candidates[0].path : "";
      });
      status("연결되었습니다. 두 파일과 교체할 원본을 확인한 뒤 업로드하십시오.");
    } catch (error) {
      forgetConnection(); status(error.message || "연결을 확인하지 못했습니다.", true);
    } finally { busy = false; updateControls(); }
  }
  async function publish() {
    if (busy) return;
    if (!credential || !snapshot) { status("먼저 업로드 연결을 확인하십시오.", true); return; }
    const files = ["bb", "info"].map((kind) => ({kind, file: byId(`upload-${kind}`).files?.[0], path: byId(`upload-${kind}-target`).value}));
    if (files.some((entry) => !entry.file || !entry.path)) { status("data_bb와 data_info 파일, 교체할 기존 원본을 모두 선택하십시오.", true); return; }
    busy = true; committed = null;
    byId("upload-result").hidden = true;
    updateControls(); status("두 파일을 확인하고 있습니다.");
    try {
      const result = await window.IAWDataUploadClient.publish(credential, snapshot, files, {onProgress: (message) => status(message)});
      committed = {...result, deployed: false};
      byId("upload-commit").textContent = "";
      byId("upload-commit").append(link(result.commitUrl, `${result.unchanged ? "기존 원본과 동일" : "저장 완료"} · ${result.commitSha.slice(0, 8)}`));
      byId("upload-deployment").textContent = result.unchanged ? "새 배포를 실행하지 않았습니다. 기존 원본의 반영 상태를 확인할 수 있습니다." : "전체 데이터 계산·배포 대기 중입니다. 잠시 후 반영 상태를 확인하십시오.";
      byId("upload-result").hidden = false;
      ["bb", "info"].forEach((kind) => {
        byId(`upload-${kind}`).value = "";
        byId(`upload-${kind}-file`).textContent = "선택된 파일 없음";
      });
      status(result.unchanged ? "파일 내용이 기존 원본과 같아 새 저장·배포를 실행하지 않았습니다." : "두 파일 저장이 완료되었습니다. 홈페이지 반영은 별도로 확인합니다.");
    } catch (error) {
      status(error.message || "업로드를 완료하지 못했습니다. 연결을 다시 확인하십시오.", true);
      // A lost PATCH response is not proof of failure. Keep the candidate SHA so the
      // user can inspect the commit/deployment before deciding whether to retry.
      if (error.commitSha && /^[a-f0-9]{40}$/i.test(error.commitSha)) {
        committed = {commitSha: error.commitSha, deployed: false};
        byId("upload-commit").textContent = "저장 결과 미확인 — 재업로드 전에 Data 저장소와 배포 상태를 확인하십시오.";
        byId("upload-commit").append(link(`https://github.com/hyeongjunkim0934/Data/commit/${error.commitSha}`, " 후보 커밋 확인"));
        byId("upload-deployment").textContent = "반영 상태 미확인";
        byId("upload-result").hidden = false;
      }
    } finally {
      forgetConnection(); busy = false; updateControls();
    }
  }
  async function checkDeployment() {
    if (!committed || checking || busy) return;
    const candidate = committed;
    candidate.deployed = false;
    checking = true; updateControls();
    byId("upload-deployment").textContent = "홈페이지 반영 상태를 확인하고 있습니다.";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`data/meta.json?upload=${encodeURIComponent(candidate.commitSha)}&t=${Date.now()}`, {cache: "no-store", credentials: "omit", signal: controller.signal});
      if (!response.ok) throw new Error("meta unavailable");
      const meta = await response.json();
      if (committed !== candidate) return;
      candidate.deployed = meta.data_source_sha === candidate.commitSha;
      if (candidate.deployed) {
        byId("upload-deployment").textContent = `홈페이지 반영 완료 · 데이터 기준일 ${meta.last_observation || "—"}. 새로고침하면 전체 화면에 적용됩니다.`;
      } else {
        byId("upload-deployment").textContent = "해당 업로드의 배포를 아직 확인하지 못했습니다. 처리 중이거나 후속 갱신이 반영되었을 수 있습니다. 아래 처리 내역을 확인한 뒤 다시 확인하십시오.";
      }
    } catch (_) {
      if (committed === candidate) byId("upload-deployment").textContent = "반영 상태를 조회하지 못했습니다. 저장 결과와 별개이며, 잠시 후 다시 확인하십시오.";
    } finally { clearTimeout(timeout); checking = false; updateControls(); }
  }
  window.renderDataUpload = function () {
    const host = byId("upload-content");
    if (!host || mounted) return;
    mounted = true;
    host.append(node("p", {class: "upload-intro"}, "data_bb · data_info를 함께 올려 홈페이지 데이터를 일괄 갱신합니다."));
    const source = node("div", {class: "upload-source"});
    source.append(node("span", {}, "기존 자동 갱신 유지"), node("span", {}, "파일 업로드 추가"));
    host.append(source);
    const auth = node("div", {class: "upload-card"});
    auth.append(node("h3", {}, "업로드 연결"));
    const authRow = node("div", {class: "upload-auth"});
    const label = node("label", {for: "upload-token"}, "GitHub 업로드 토큰");
    const token = node("input", {id: "upload-token", type: "password", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "Data 저장소 쓰기 권한"});
    const connectButton = node("button", {id: "upload-connect", type: "button", class: "btn-ghost"}, "연결 확인");
    const disconnect = node("button", {id: "upload-disconnect", type: "button", class: "btn-ghost"}, "연결 해제");
    authRow.append(label, token, connectButton, disconnect); auth.append(authRow);
    auth.append(node("p", {id: "upload-connection", class: "upload-muted"}, "연결 전"));
    const help = node("details", {class: "upload-help"});
    help.append(node("summary", {}, "연결 방법"), node("p", {}, "Fine-grained GitHub 토큰에서 hyeongjunkim0934/Data만 선택하고 Contents 읽기·쓰기 권한을 허용하십시오. 토큰은 이 페이지 메모리에서만 사용하며, 업로드 종료·연결 해제·페이지 종료 시 제거합니다."));
    help.append(node("p", {}, "기존 데이터 자동 갱신과 같은 처리 경로를 사용합니다. 다른 갱신이 먼저 반영되면 연결을 다시 확인해야 합니다."));
    auth.append(help); host.append(auth);
    const fileGrid = node("div", {class: "upload-files"});
    ["bb", "info"].forEach((kind) => {
      const card = node("div", {class: "upload-card"});
      card.append(node("h3", {}, `data_${kind}`));
      card.append(node("label", {for: `upload-${kind}`}, "업로드 파일 (.xlsx · 최대 25 MiB)"));
      const input = node("input", {id: `upload-${kind}`, type: "file", accept: ".xlsx"});
      card.append(input, node("p", {id: `upload-${kind}-file`, class: "upload-muted"}, "선택된 파일 없음"));
      card.append(node("label", {for: `upload-${kind}-target`}, "교체할 기존 원본"), node("select", {id: `upload-${kind}-target`}));
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        byId(`upload-${kind}-file`).textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(2)} MiB` : "선택된 파일 없음";
      });
      fileGrid.append(card);
    });
    host.append(fileGrid);
    const submit = node("button", {id: "upload-submit", type: "button", class: "upload-primary"}, "두 파일 업로드 · 전체 업데이트");
    host.append(submit, node("p", {id: "upload-status", role: "status", "aria-live": "polite", "aria-atomic": "true"}, "두 원본을 함께 선택하십시오. 다른 BM·지수 파일은 유지됩니다."));
    const result = node("div", {id: "upload-result", class: "upload-card"});
    result.hidden = true;
    result.append(node("p", {id: "upload-commit"}), node("p", {id: "upload-deployment", role: "status", "aria-live": "polite"}));
    const actions = node("div", {class: "upload-actions"});
    const check = node("button", {id: "upload-check", type: "button", class: "btn-ghost"}, "반영 상태 확인");
    const refresh = node("button", {id: "upload-refresh", type: "button", class: "btn-ghost"}, "전체 화면 새로고침");
    actions.append(check, refresh, link(DATA_ACTIONS, "파일 수신 내역"), link(ACTIONS, "계산·배포 내역"));
    result.append(actions); host.append(result);
    connectButton.addEventListener("click", connect);
    token.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); connect(); } });
    disconnect.addEventListener("click", () => { if (!busy) { forgetConnection(); updateControls(); status("연결을 해제했습니다."); } });
    submit.addEventListener("click", publish);
    check.addEventListener("click", checkDeployment);
    refresh.addEventListener("click", () => { if (committed?.deployed && !busy) location.reload(); });
    // Never persist a PAT in localStorage/sessionStorage or a URL. Clear memory on exit.
    window.addEventListener("pagehide", () => { connectionEpoch++; forgetConnection(); updateControls(); });
    window.addEventListener("pageshow", () => { updateControls(); });
    updateControls();
  };
})();
