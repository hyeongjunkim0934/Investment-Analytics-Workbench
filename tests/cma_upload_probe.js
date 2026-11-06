"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const XLSX = require(path.join(root, "dashboard/vendor/xlsx.full.min.js"));
const saved = new Map();
let allocationRenders = 0;
const context = vm.createContext({ XLSX, console, Uint8Array, ArrayBuffer, Date,
  DATA: { alloc: { port: { assets: ["국내시가", "국내장부", "해외시가"] } } },
  document: { getElementById: () => null },
  localStorage: { getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value) },
  renderSection: () => { allocationRenders++; }, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(root, "dashboard/cma.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(root, "dashboard/cma-upload.js"), "utf8"), context);
const assets = ["국내시가", "국내장부", "해외시가"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const workbook = (rows, name = "CMA") => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return book;
};
const header = ["자산군", "기대수익률 (%)", "변동성 (%)"];
const parse = (book) => plain(context.cmaParseWorkbook(book, assets));
const rejects = (book, pattern) => assert.throws(() => parse(book), pattern);

(async () => {
  const book = workbook([header, ["국내시가", 4.12, 3.58], ["해외시가", -1.25, 0]]);
  assert.deepEqual(parse(book).rows, [{ asset: "국내시가", mu: 4.12, sig: 3.58 },
    { asset: "해외시가", mu: -1.25, sig: 0 }]);
  const formatted = workbook([header, ["국내채권", .0412, .0358], ["해외채권", "−1.25%", "0.00%"]]);
  formatted.Sheets.CMA.B2.z = "0.00%"; formatted.Sheets.CMA.C2.z = "0.00%";
  assert.deepEqual(parse(formatted).rows, parse(book).rows);
  const quoted = workbook([header, ["국내시가", 4.12, 3.58]]);
  quoted.Sheets.CMA.B2.z = '0.00"%"'; quoted.Sheets.CMA.C2.z = "0.00\\%";
  assert.equal(parse(quoted).rows[0].mu, 4.12);
  assert.equal(parse(quoted).rows[0].sig, 3.58);
  assert.equal(context.cmaUploadNumber({ v: 1.005, t: "n" }, "μ"), 1.01);
  assert.equal(context.cmaUploadNumber({ v: -1.005, t: "n" }, "μ"), -1.01);
  for (const value of [1.005, -1.005, 4.125, -4.125, 0, 0.009, -0.009])
    assert.equal(Number(context.cmaEditedValue(String(value), "mu")), context.cmaUploadRound(value));
  assert.equal(context.cmaEditedValue("-0.001", "sig"), "-0.001");
  rejects(workbook([header, ["국내시가", 1, -0.001]]), /0 이상/);
  rejects(workbook([header, ["국내시가", 1, "−0.001%"]]), /0 이상/);
  rejects(workbook([header, ["국내시가", 1, ""]]), /비어/);
  rejects(workbook([header, ["국내시가", "4,12", 1]]), /숫자/);
  rejects(workbook([header, ["국내시가", true, 1]]), /숫자/);
  rejects(workbook([header, ["국내시가", Infinity, 1]]), /범위|숫자/);
  rejects(workbook([header, ["알수없는자산", 1, 1]]), /지원하지/);
  rejects(workbook([header, ["국내시가", 1, 1], ["국내채권", 2, 2]]), /중복/);
  rejects(workbook([["자산군", "기대수익률", "기대수익", "변동성"], ["국내시가", 1, 1, 1]]), /각각 하나/);
  rejects(workbook([["자산", "누락"], ["국내시가", 1]]), /열이 있는/);
  const formula = workbook([header, ["국내시가", 1, 1]]);
  formula.Sheets.CMA.B2.f = "1+1";
  rejects(formula, /수식 대신/);
  const dated = workbook([header, ["국내시가", 45000, 1]]);
  dated.Sheets.CMA.B2.z = "yyyy-mm-dd";
  rejects(dated, /날짜/);
  const mixed = workbook([["안내"], ["사용 방법"]], "안내");
  XLSX.utils.book_append_sheet(mixed, book.Sheets.CMA, "Assumptions");
  assert.equal(parse(mixed).sheetName, "Assumptions");
  XLSX.utils.book_append_sheet(mixed, quoted.Sheets.CMA, "Second");
  rejects(mixed, /여러 CMA/);
  XLSX.utils.book_append_sheet(mixed, book.Sheets.CMA, "CMA");
  assert.equal(parse(mixed).sheetName, "CMA");

  for (const asset of assets) context.cmaEnsureAsset(asset, { mu: 2, sig: 3 });
  context.cmaApplyAsset("국내시가");
  const originalApplied = plain(context.cmaAssetAssumption("국내시가"));
  const untouched = plain(context.cmaStore().assets["국내장부"]);
  context.cmaStore().assets["국내시가"].draft[0].p = 10;
  context.cmaStore().assets["국내시가"].draft[1].p = 60;
  const beforeRenders = allocationRenders;
  const imported = context.cmaImportRows(parse(book).rows, assets);
  assert.equal(imported.count, 2); assert.equal(imported.persisted, true);
  assert.deepEqual(plain(context.cmaStore().assets["국내시가"].draft.map((s) => s.p)), [10, 60, 30]);
  const moments = context.cmaMoments(context.cmaStore().assets["국내시가"].draft);
  assert.equal(moments.mu, 4.12); assert.ok(Math.abs(moments.sig - 3.58) < 1e-12);
  assert.deepEqual(plain(context.cmaAssetAssumption("국내시가")), originalApplied);
  assert.deepEqual(plain(context.cmaStore().assets["국내장부"]), untouched);
  assert.equal(allocationRenders, beforeRenders);
  const serialized = JSON.stringify(context.cmaStore());
  assert.throws(() => context.cmaImportRows([{ asset: "국내시가", mu: 5, sig: 1 },
    { asset: "국내장부", mu: 2, sig: -1 }], assets), /확인/);
  assert.equal(JSON.stringify(context.cmaStore()), serialized);
  context.cmaStore().assets["해외시가"].draft[0].p = 101;
  const badProbabilities = JSON.stringify(context.cmaStore());
  assert.throws(() => context.cmaImportRows(parse(book).rows, assets), /확률/);
  assert.equal(JSON.stringify(context.cmaStore()), badProbabilities);
  context.cmaStore().assets["해외시가"].draft[0].p = 25;
  context.cmaApplyAsset("국내시가");
  assert.equal(context.cmaAssetAssumption("국내시가").mu, 4.12);

  for (const type of ["xlsx", "xls"]) {
    const bytes = XLSX.write(formatted, { type: "buffer", bookType: type });
    const result = await context.cmaReadUpload({ name: `CMA.${type}`, size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, assets);
    assert.deepEqual(plain(result.rows), parse(book).rows);
  }
  await assert.rejects(context.cmaReadUpload({ name: "x.csv", size: 10 }, assets), /xlsx/);
  await assert.rejects(context.cmaReadUpload({ name: "x.xlsx", size: 6 * 1024 * 1024 }, assets), /5MB/);
  await assert.rejects(context.cmaReadUpload({ name: "x.xlsx", size: 3,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, assets), /올바른/);

  if (process.argv[2]) {
    // This workbook is created independently by openpyxl in the pytest caller.
    const bytes = fs.readFileSync(process.argv[2]);
    const result = await context.cmaReadUpload({ name: "independent.xlsx", size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, assets);
    assert.deepEqual(plain(result.rows), parse(book).rows);
  }
  console.log(JSON.stringify({ numericUnits: true, rejection: true, atomicDraftImport: true,
    workbookReadXlsxXls: true, independentXlsx: Boolean(process.argv[2]) }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
