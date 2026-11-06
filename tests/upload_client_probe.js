/* Exercise the real upload client against a small Git commit graph, without live credentials. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { deflateRawSync } = require("node:zlib");
const source = fs.readFileSync(path.join(__dirname, "../dashboard/data-upload-client.js"), "utf8");
const hash = value => createHash("sha1").update(value).digest("hex");
const TOKEN = "unit-only-secret-value";
const REPO = "hyeongjunkim0934/Data";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function workbook(entries) {
  const locals = [], directories = [];
  let offset = 0;
  for (const [name, content] of entries || [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
    ["xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'],
  ]) {
    const filename = Buffer.from(name), raw = Buffer.from(content), data = deflateRawSync(raw), crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    directories.push(directory, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directories), end = Buffer.alloc(22), count = directories.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function file(name = "data_bb.xlsx", bytes = workbook()) {
  return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}
const infoWorkbook = () => workbook([
  ["[Content_Types].xml", "<Types/>"], ["xl/workbook.xml", "<workbook/>"],
  ["xl/_rels/workbook.xml.rels", "<Relationships/>"], ["xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>"],
]);
const treeHash = entries => hash(JSON.stringify(entries.map(entry =>
  [entry.path, entry.mode, entry.type, entry.sha]).sort((a, b) => a[0].localeCompare(b[0]))));
function mock(options = {}) {
  const requests = [], writes = [];
  const initialHead = hash("initial head");
  let branch = "release/current", currentHead = initialHead, lastCommit, lastTree;
  const tree = [
    { path: "raw/data_bb_대체투자 (2).xlsx", sha: hash(options.identical ? workbook() : "old bb"), mode: "100644", type: "blob" },
    { path: "raw/data_info.xlsx", sha: hash(options.identical ? infoWorkbook() : "old info"), mode: "100644", type: "blob" },
    { path: "raw/ACWI.xlsx", sha: hash("index"), mode: "100644", type: "blob" },
    { path: "raw/~$data_bb.xlsx", sha: hash("lock"), mode: "100644", type: "blob" },
  ];
  const initialTree = treeHash(tree);
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, init) => {
    assert.ok(url.startsWith(`https://api.github.com/repos/${REPO}`));
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const endpoint = url.slice(`https://api.github.com/repos/${REPO}`.length);
    const body = init.body ? JSON.parse(init.body) : null;
    const request = { endpoint, method: init.method, body };
    requests.push(request);
    if (init.method !== "GET") writes.push(request);
    if (options.onRequest) options.onRequest(request, { setHead: value => { currentHead = value; }, setBranch: value => { branch = value; } });
    if (options.apiError) return response({ message: `should never be exposed: ${TOKEN}` }, options.apiError);
    if (!endpoint) return response({ full_name: options.wrongRepo || REPO, private: options.public !== true,
      default_branch: branch, archived: false, permissions: { push: options.readOnly !== true } });
    if (endpoint.startsWith("/git/ref/heads/")) return response({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: currentHead } });
    if (endpoint === `/git/commits/${initialHead}`) return response({ sha: initialHead, tree: { sha: initialTree } });
    if (endpoint === `/git/trees/${initialTree}?recursive=1`) return response({ truncated: !!options.truncated, tree });
    if (endpoint === "/git/blobs") {
      assert.equal(body.encoding, "base64");
      return response({ sha: hash(Buffer.from(body.content, "base64")) }, 201);
    }
    if (endpoint === "/git/trees") {
      assert.equal(body.base_tree, initialTree);
      assert.equal(body.tree.length, 2);
      const replacements = new Map(body.tree.map(entry => [entry.path, entry]));
      lastTree = tree.map(entry => replacements.get(entry.path) || entry);
      return response({ sha: treeHash(lastTree) }, 201);
    }
    if (endpoint === "/git/commits" && init.method === "POST") {
      assert.deepEqual(body.parents, [initialHead]);
      assert.equal(body.tree, treeHash(lastTree));
      lastCommit = hash(JSON.stringify(body));
      return response({ sha: lastCommit }, 201);
    }
    if (endpoint.startsWith("/git/refs/heads/") && init.method === "PATCH") {
      assert.equal(body.force, false);
      assert.equal(body.sha, lastCommit);
      if (options.refReject) return response({ message: TOKEN }, 422);
      if (!options.refNetworkFail) currentHead = lastCommit;
      if (options.refNetworkApply || options.refNetworkFail) throw new Error(TOKEN);
      return response({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: currentHead } });
    }
    if (endpoint.startsWith("/compare/")) return response({ status: "diverged" });
    if (endpoint.startsWith("/actions/workflows/notify-workbench.yml/runs?")) {
      return response({ workflow_runs: options.runs || [] });
    }
    throw new Error(`Unhandled mock endpoint ${endpoint}`);
  };
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, Uint8Array, DataView, TextDecoder,
    btoa: value => Buffer.from(value, "binary").toString("base64") });
  vm.runInContext(source, context);
  return { client: context.IAWDataUploadClient, requests, writes, initialHead, initialTree,
    tree, get currentHead() { return currentHead; }, get lastTree() { return lastTree; } };
}
const selected = snapshot => [
  { kind: "bb", path: snapshot.candidates.bb[0].path, file: file() },
  { kind: "info", path: snapshot.candidates.info[0].path, file: file("data_info_20261106.xlsx", infoWorkbook()) },
];
async function rejects(fn, code) {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert.ok(caught, `Expected ${code}`);
  assert.equal(caught.code, code, caught.message);
  assert.ok(!caught.message.includes(TOKEN));
  return caught;
}
async function main() {
  const passed = {};
  {
    const api = mock(), snapshot = await api.client.inspect(TOKEN), progress = [];
    assert.equal(snapshot.branch, "release/current");
    assert.equal(snapshot.candidates.bb.length, 1);
    const input = selected(snapshot), result = await api.client.publish(TOKEN, snapshot, input, { onProgress: value => progress.push(value) });
    assert.equal(result.commitSha, api.currentHead);
    assert.equal(result.commitUrl, `https://github.com/${REPO}/commit/${result.commitSha}`);
    assert.deepEqual(api.writes.map(item => item.endpoint), ["/git/blobs", "/git/blobs", "/git/trees", "/git/commits", "/git/refs/heads/release/current"]);
    assert.equal(api.lastTree.find(entry => entry.path === "raw/ACWI.xlsx").sha, hash("index"));
    assert.ok(api.lastTree.some(entry => entry.path === input[0].path));
    assert.ok(!api.lastTree.some(entry => entry.path === input[0].file.name));
    for (const item of input) {
      assert.equal(api.lastTree.find(entry => entry.path === item.path).sha, hash(Buffer.from(await item.file.arrayBuffer())));
    }
    assert.equal(api.requests.filter(item => item.endpoint === "").length, 3);
    assert.equal(progress.length, 3);
    assert.equal(api.writes.filter(item => item.endpoint.startsWith("/git/refs")).length, 1);
    passed.atomic_existing_paths_and_preserved_unrelated_files = true;
  }
  {
    const api = mock({ identical: true }), snapshot = await api.client.inspect(TOKEN);
    const result = await api.client.publish(TOKEN, snapshot, selected(snapshot));
    assert.equal(result.unchanged, true);
    assert.equal(result.commitSha, api.initialHead);
    assert.equal(api.currentHead, api.initialHead);
    assert.deepEqual(api.writes.map(item => item.endpoint), ["/git/blobs", "/git/blobs", "/git/trees"]);
    assert.equal(api.requests.filter(item => item.endpoint === "").length, 3);
    passed.identical_pair_creates_no_commit_or_ref_update = true;
  }
  {
    for (const options of [{ public: true }, { wrongRepo: "another/Project" }, { readOnly: true }, { truncated: true }]) {
      const api = mock(options);
      await rejects(() => api.client.inspect(TOKEN), options.readOnly ? "permission" : options.truncated ? "tree" : "repository");
      assert.equal(api.writes.length, 0);
    }
    passed.repository_privacy_permissions_and_complete_tree = true;
  }
  {
    const api = mock(), snapshot = await api.client.inspect(TOKEN);
    for (const invalid of [file("report.xlsx"), file("~$data_info.xlsx"), file("data_info.xlsm"),
      file("data_info.xlsx", Buffer.from("not an xlsx workbook padded")),
      file("data_info.xlsx", workbook([["something.txt", "hello"]])),
      { name: "data_info.xlsx", size: api.client.MAX_FILE_BYTES + 1, arrayBuffer: () => { throw Error("not read"); } }]) {
      const input = selected(snapshot); input[1].file = invalid;
      let error;
      try { await api.client.publish(TOKEN, snapshot, input); } catch (value) { error = value; }
      assert.ok(error); assert.equal(api.writes.length, 0);
    }
    const input = selected(snapshot); input[1].path = "raw/ACWI.xlsx";
    await rejects(() => api.client.publish(TOKEN, snapshot, input), "targets");
    await rejects(() => api.client.publish(TOKEN, snapshot, input.slice(0, 1)), "selection");
    assert.equal(api.writes.length, 0);
    passed.invalid_pair_has_no_remote_mutation = true;
  }
  {
    let mutate = false;
    const api = mock({ onRequest: (request, state) => { if (mutate && request.endpoint === "") state.setHead(hash("concurrent")); } });
    const snapshot = await api.client.inspect(TOKEN); mutate = true;
    await rejects(() => api.client.publish(TOKEN, snapshot, selected(snapshot)), "conflict");
    assert.equal(api.writes.length, 0);
    passed.concurrent_update_before_upload_stops_all_writes = true;
  }
  {
    const api = mock({ onRequest: (request, state) => { if (request.endpoint === "/git/commits" && request.method === "POST") state.setHead(hash("concurrent")); } });
    const snapshot = await api.client.inspect(TOKEN);
    await rejects(() => api.client.publish(TOKEN, snapshot, selected(snapshot)), "conflict");
    assert.ok(api.writes.length > 0);
    assert.equal(api.writes.filter(item => item.method === "PATCH").length, 0);
    assert.equal(api.currentHead, hash("concurrent"));
    passed.concurrent_update_before_ref_preserves_other_writer = true;
  }
  {
    let changeBranch = false;
    const api = mock({ onRequest: (request, state) => { if (changeBranch && request.endpoint === "") state.setBranch("renamed/default"); } });
    const snapshot = await api.client.inspect(TOKEN); changeBranch = true;
    await rejects(() => api.client.publish(TOKEN, snapshot, selected(snapshot)), "conflict");
    assert.equal(api.writes.length, 0);
    passed.default_branch_change_stops_upload = true;
  }
  {
    const api = mock({ refNetworkApply: true }), snapshot = await api.client.inspect(TOKEN);
    const result = await api.client.publish(TOKEN, snapshot, selected(snapshot));
    assert.equal(result.commitSha, api.currentHead);
    assert.equal(api.writes.filter(item => item.method === "PATCH").length, 1);
    passed.lost_success_response_recovers_by_readback = true;
  }
  {
    const api = mock({ refNetworkFail: true }), snapshot = await api.client.inspect(TOKEN);
    const error = await rejects(() => api.client.publish(TOKEN, snapshot, selected(snapshot)), "unknown-result");
    assert.match(error.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(api.currentHead, api.initialHead);
    assert.equal(api.writes.filter(item => item.method === "PATCH").length, 1);
    passed.unknown_final_outcome_has_commit_id_without_retry = true;
  }
  {
    const api = mock({ refReject: true }), snapshot = await api.client.inspect(TOKEN);
    await rejects(() => api.client.publish(TOKEN, snapshot, selected(snapshot)), "conflict");
    assert.equal(api.currentHead, api.initialHead);
    assert.equal(api.writes.filter(item => item.method === "PATCH").length, 1);
    passed.ref_rejection_is_not_success = true;
  }
  {
    const api = mock({ apiError: 403 });
    await rejects(() => api.client.inspect(TOKEN), "api");
    const normal = mock();
    await rejects(() => normal.client.inspect(""), "token");
    assert.equal(normal.requests.length, 0);
    assert.ok(!/localStorage|sessionStorage|console\./.test(source));
    passed.token_error_redaction_and_no_persistence = true;
  }
  {
    const api = mock({ runs: [{ id: 123, head_sha: hash("upload"), event: "push", status: "completed", conclusion: "success", html_url: "https://untrusted.invalid/" }] });
    const result = await api.client.checkNotification(TOKEN, hash("upload"));
    assert.equal(result.status, "completed"); assert.equal(result.conclusion, "success");
    assert.equal(result.url, `https://github.com/${REPO}/actions/runs/123`);
    const pending = await api.client.checkNotification(TOKEN, hash("different"));
    assert.equal(pending.status, "pending");
    passed.notification_is_scoped_to_uploaded_commit = true;
  }
  {
    const api = mock();
    const result = await api.client.validateFile(file("DATA_BB_20261106.XLSX"), "bb");
    assert.equal(result.entries, 4); assert.equal(result.name, "DATA_BB_20261106.XLSX");
    const bytes = workbook(); bytes.writeUInt16LE(1, 6); // encrypted local header
    await rejects(() => api.client.validateFile(file("data_bb.xlsx", bytes), "bb"), "workbook");
    await rejects(() => api.client.validateFile(file("data_bb.xlsx", workbook([["../bad", "x"]])), "bb"), "workbook");
    passed.xlsx_structure_and_case_insensitive_names = true;
  }
  process.stdout.write(JSON.stringify(passed));
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
