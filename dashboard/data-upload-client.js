/* Browser upload transport. No token/file persistence; all writes are scoped to private Data. */
"use strict";

globalThis.IAWDataUploadClient = (() => {
  const repository = "hyeongjunkim0934/Data";
  const apiBase = `https://api.github.com/repos/${repository}`;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const SHA = /^[a-f0-9]{40}$/;
  const kinds = ["bb", "info"];

  function failure(code, message, extras = {}) {
    return Object.assign(new Error(message), { code }, extras);
  }
  function checkToken(token) {
    if (typeof token !== "string" || !token.trim() || /\s/.test(token) || token.length > 1024) {
      throw failure("token", "GitHub 토큰을 입력하세요. 토큰 앞뒤의 공백도 제거하세요.");
    }
  }
  function checkSha(sha) {
    if (!SHA.test(sha || "")) throw failure("response", "저장소 응답을 확인할 수 없습니다. 다시 연결하세요.");
    return sha;
  }
  function refPath(branch) {
    if (typeof branch !== "string" || !branch || /[\s?#\\]/.test(branch) || branch.includes("..")) {
      throw failure("branch", "기본 브랜치를 확인할 수 없습니다. 다시 연결하세요.");
    }
    return branch.split("/").map(encodeURIComponent).join("/");
  }
  function fileKind(path) {
    if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(part => !part || part === "." || part === "..")) return null;
    const name = path.split("/").pop().toLowerCase();
    if (name.startsWith("~$") || !name.endsWith(".xlsx")) return null;
    return kinds.find(kind => name.startsWith(`data_${kind}`)) || null;
  }
  async function request(token, path, method = "GET", body) {
    checkToken(token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch(apiBase + path, {
        method, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      if (!response.ok) {
        const messages = {
          401: "토큰 인증에 실패했습니다. 유효기간을 확인하세요.",
          403: "저장소 권한 또는 API 사용 한도를 확인하세요.",
          404: "Data 저장소 또는 요청한 자료에 접근할 수 없습니다. 토큰 권한을 확인하세요.",
          409: "다른 갱신과 충돌했습니다. 다시 연결해 최신 상태를 확인하세요.",
          422: "저장 요청이 거부됐습니다. 다른 갱신 여부와 브랜치 보호 설정을 확인하세요.",
        };
        throw failure("api", messages[response.status] || `GitHub 요청에 실패했습니다 (HTTP ${response.status}).`,
          { status: response.status });
      }
      try { return await response.json(); }
      catch { throw failure("response", "저장소 응답을 확인할 수 없습니다. 다시 연결하세요."); }
    } catch (error) {
      if (error.code && ["api", "response"].includes(error.code)) throw error;
      // Never forward server bodies, request headers, token text, or arbitrary network errors.
      throw failure("network", "GitHub 연결이 중단됐습니다. 네트워크 상태를 확인하세요.");
    } finally { clearTimeout(timer); }
  }
  async function metadata(token) {
    const repo = await request(token, "");
    if (repo.full_name?.toLowerCase() !== repository.toLowerCase() || repo.private !== true ||
        repo.archived || repo.disabled) {
      throw failure("repository", "허용된 비공개 Data 저장소를 확인하지 못해 업로드를 중단했습니다.");
    }
    if (repo.permissions?.push === false) {
      throw failure("permission", "Data 저장소의 Contents 읽기·쓰기 권한이 필요합니다.");
    }
    refPath(repo.default_branch);
    return repo;
  }
  async function head(token, branch) {
    const ref = await request(token, `/git/ref/heads/${refPath(branch)}`);
    if (ref.ref !== `refs/heads/${branch}` || ref.object?.type !== "commit") {
      throw failure("branch", "기본 브랜치의 커밋을 확인할 수 없습니다. 다시 연결하세요.");
    }
    return checkSha(ref.object.sha);
  }
  async function inspect(token) {
    const repo = await metadata(token);
    const branch = repo.default_branch;
    const headSha = await head(token, branch);
    const commit = await request(token, `/git/commits/${headSha}`);
    const treeSha = checkSha(commit.tree?.sha);
    const tree = await request(token, `/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw failure("tree", "파일 목록이 불완전하여 업로드를 중단했습니다.");
    }
    const candidates = { bb: [], info: [] };
    for (const entry of tree.tree) {
      const kind = fileKind(entry.path);
      if (kind && entry.type === "blob" && entry.mode === "100644") {
        candidates[kind].push({ path: entry.path, sha: checkSha(entry.sha) });
      }
    }
    if (kinds.some(kind => !candidates[kind].length)) {
      throw failure("targets", "기존 data_bb·data_info 파일 경로를 모두 찾지 못했습니다.");
    }
    return { repository, branch, headSha, treeSha, candidates };
  }

  function workbookStructure(bytes) {
    // Inspect the ZIP central directory, without inflating worksheets or executing macros.
    const bad = () => { throw failure("workbook", "올바른 .xlsx 통합문서가 아닙니다. Excel에서 다시 저장하세요."); };
    if (bytes.length < 22) bad();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50) bad();
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) {
        end = p; break;
      }
    }
    if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) bad();
    const count = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryStart = view.getUint32(end + 16, true);
    if (!count || count === 0xffff || count > 20000 || count !== view.getUint16(end + 8, true) ||
        directoryStart + directorySize !== end) bad();
    let p = directoryStart, expanded = 0;
    const names = new Set();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) bad();
      const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true);
      const compressed = view.getUint32(p + 20, true), uncompressed = view.getUint32(p + 24, true);
      const n = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      if (flags & 1 || ![0, 8].includes(method) || !n || p + 46 + n + extra + comment > end ||
          offset + 30 > directoryStart || view.getUint32(offset, true) !== 0x04034b50) bad();
      let name;
      try { name = decoder.decode(bytes.subarray(p + 46, p + 46 + n)); } catch { bad(); }
      if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") ||
          names.has(name) || name.toLowerCase().endsWith("vbaproject.bin")) bad();
      const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true);
      if (offset + 30 + localNameLength + localExtraLength + compressed > directoryStart || localNameLength !== n ||
          view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) bad();
      for (let j = 0; j < n; j++) if (bytes[offset + 30 + j] !== bytes[p + 46 + j]) bad();
      expanded += uncompressed;
      if (expanded > 512 * 1024 * 1024) bad();
      names.add(name);
      p += 46 + n + extra + comment;
    }
    if (p !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml") ||
        !names.has("xl/_rels/workbook.xml.rels") || ![...names].some(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) bad();
    return names.size;
  }
  async function readWorkbook(file, kind) {
    if (!kinds.includes(kind) || !file || fileKind(file.name) !== kind || file.name.includes("/")) {
      throw failure("filename", `data_${kind === "info" ? "info" : "bb"}로 시작하는 .xlsx 파일을 선택하세요.`);
    }
    if (!Number.isInteger(file.size) || file.size < 22 || file.size > MAX_FILE_BYTES) {
      throw failure("size", "각 파일은 25 MiB 이하의 .xlsx 통합문서여야 합니다.");
    }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { throw failure("read", "선택한 파일을 읽지 못했습니다. 파일을 다시 선택하세요."); }
    if (bytes.length !== file.size) throw failure("read", "파일을 끝까지 읽지 못했습니다. 다시 선택하세요.");
    const entries = workbookStructure(bytes);
    return { name: file.name, size: bytes.length, entries, bytes };
  }
  async function validateFile(file, kind) {
    const { name, size, entries } = await readWorkbook(file, kind);
    return { name, size, entries };
  }
  function base64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }
  function checkSnapshot(snapshot, files) {
    if (!snapshot || snapshot.repository !== repository || !Array.isArray(files) || files.length !== 2 ||
        !kinds.every(kind => files.filter(item => item.kind === kind).length === 1)) {
      throw failure("selection", "연결 상태와 data_bb·data_info 두 파일을 확인하세요.");
    }
    refPath(snapshot.branch); checkSha(snapshot.headSha); checkSha(snapshot.treeSha);
    for (const item of files) {
      if (fileKind(item.path) !== item.kind || !snapshot.candidates?.[item.kind]?.some(entry =>
        entry.path === item.path && SHA.test(entry.sha))) {
        throw failure("targets", "선택한 저장 경로가 기존 파일 목록과 다릅니다. 다시 연결하세요.");
      }
    }
  }
  async function unchanged(token, snapshot) {
    const repo = await metadata(token);
    if (repo.default_branch !== snapshot.branch || await head(token, snapshot.branch) !== snapshot.headSha) {
      throw failure("conflict", "연결 이후 데이터 또는 기본 브랜치가 바뀌었습니다. 다시 연결해 확인한 뒤 업로드하세요.");
    }
  }
  async function containsCommit(token, branch, commitSha) {
    const current = await head(token, branch);
    if (current === commitSha) return true;
    const comparison = await request(token, `/compare/${commitSha}...${current}`);
    return comparison.status === "ahead" || comparison.status === "identical";
  }
  async function publish(token, snapshot, files, options = {}) {
    checkToken(token); checkSnapshot(snapshot, files);
    const progress = message => { if (typeof options.onProgress === "function") options.onProgress(message); };
    progress("파일 형식 확인");
    // Both files pass local checks before the first remote mutation.
    const prepared = [];
    for (const item of files) prepared.push({ ...item, workbook: await readWorkbook(item.file, item.kind) });
    await unchanged(token, snapshot);
    progress("두 파일 저장 중");
    const treeEntries = [];
    for (const item of prepared) {
      const blob = await request(token, "/git/blobs", "POST", { content: base64(item.workbook.bytes), encoding: "base64" });
      treeEntries.push({ path: item.path, mode: "100644", type: "blob", sha: checkSha(blob.sha) });
    }
    const tree = await request(token, "/git/trees", "POST", { base_tree: snapshot.treeSha, tree: treeEntries });
    const treeSha = checkSha(tree.sha);
    if (treeSha === snapshot.treeSha) {
      // An empty commit would not match Notify workbench's **.xlsx push-path filter.
      // Confirm the source is still current, then explicitly report the no-op.
      await unchanged(token, snapshot);
      return { unchanged: true, repository, branch: snapshot.branch, commitSha: snapshot.headSha,
        commitUrl: `https://github.com/${repository}/commit/${snapshot.headSha}` };
    }
    const commit = await request(token, "/git/commits", "POST", {
      message: "Update data_bb and data_info from Investment Analytics Workbench",
      tree: treeSha, parents: [snapshot.headSha],
    });
    const commitSha = checkSha(commit.sha);
    await unchanged(token, snapshot);
    progress("기본 브랜치에 적용 중");
    try {
      const updated = await request(token, `/git/refs/heads/${refPath(snapshot.branch)}`, "PATCH", { sha: commitSha, force: false });
      if (updated.ref !== `refs/heads/${snapshot.branch}` || updated.object?.sha !== commitSha) {
        throw failure("response", "저장소 응답을 확인할 수 없습니다.");
      }
    } catch (error) {
      let confirmed = false;
      try { confirmed = await containsCommit(token, snapshot.branch, commitSha); } catch { /* outcome remains unknown */ }
      if (!confirmed) {
        const certainRejection = error.code === "api" && [401, 403, 404, 409, 422].includes(error.status);
        throw failure(certainRejection ? "conflict" : "unknown-result", certainRejection
          ? "기본 브랜치 적용이 거부됐습니다. 최신 데이터와 권한을 확인한 뒤 다시 연결하세요."
          : "저장 완료 여부를 확인하지 못했습니다. Data 커밋과 배포 상태를 먼저 확인한 뒤 재시도하세요.",
        { commitSha, branch: snapshot.branch });
      }
    }
    return { repository, branch: snapshot.branch, commitSha, commitUrl: `https://github.com/${repository}/commit/${commitSha}` };
  }
  async function checkNotification(token, commitSha) {
    checkSha(commitSha);
    const result = await request(token, `/actions/workflows/notify-workbench.yml/runs?head_sha=${commitSha}&event=push&per_page=20`);
    if (!Array.isArray(result.workflow_runs)) throw failure("response", "갱신 작업 상태를 확인할 수 없습니다.");
    const runs = result.workflow_runs.filter(run => run.head_sha === commitSha && run.event === "push")
      .sort((a, b) => Number(b.id) - Number(a.id));
    const run = runs[0];
    if (!run) return { status: "pending", conclusion: null, url: `https://github.com/${repository}/actions` };
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw failure("response", "갱신 작업 상태를 확인할 수 없습니다.");
    return { status: run.status, conclusion: run.conclusion || null,
      url: `https://github.com/${repository}/actions/runs/${run.id}` };
  }
  return Object.freeze({ repository, MAX_FILE_BYTES, inspect, validateFile, publish, checkNotification });
})();
