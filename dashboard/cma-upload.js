/* Browser-local CMA workbook import. Values are annual percentage points.
   SheetJS is vendored locally; no workbook data leaves the browser. */
"use strict";

const CMA_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const CMA_UPLOAD_MAX_ROWS = 1000;
const CMA_UPLOAD_MAX_COLUMNS = 64;

function cmaUploadRound(value) {
  return cmaRoundHundredth(value);
}

function cmaUploadKey(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s_%()\[\]·]/g, "");
}

function cmaUploadAsset(value, assets) {
  const key = cmaUploadKey(value);
  const direct = assets.filter((asset) => cmaUploadKey(asset) === key);
  if (direct.length === 1) return direct[0];
  const aliases = { 국내채권: "국내시가", 해외채권: "해외시가", 원화유동성: "국내장부" };
  const target = aliases[key];
  return target && assets.includes(target) ? target : null;
}

function cmaUploadHeader(value) {
  const key = cmaUploadKey(value);
  if (["자산", "자산군", "자산명", "asset", "assetclass", "assetname"].includes(key)) return "asset";
  if (["기대수익", "기대수익률", "expectedreturn", "return", "mu", "μ"].includes(key)) return "mu";
  if (["변동성", "volatility", "vol", "sigma", "σ"].includes(key)) return "sig";
  return null;
}

function cmaUploadPercentFormat(format) {
  // Ignore literal/escaped '%' and bracket conditions; only Excel's numeric
  // percent operator scales a stored fraction by 100.
  const code = String(format || "").replace(/"(?:[^"]|"")*"|\\.|\[[^\]]*\]/g, "");
  return code.includes("%");
}

function cmaUploadNumber(cell, label, nonnegative = false) {
  if (!cell || cell.v == null || cell.v === "") throw new Error(`${label}: 값이 비어 있습니다.`);
  if (cell.f != null) throw new Error(`${label}: 수식 대신 계산된 값을 붙여넣으십시오.`);
  if (cell.t === "e" || cell.t === "b" || cell.t === "d" || cell.v instanceof Date)
    throw new Error(`${label}: 숫자를 입력하십시오.`);
  let value;
  if (typeof cell.v === "number") {
    if (typeof XLSX !== "undefined" && XLSX.SSF.is_date(cell.z || ""))
      throw new Error(`${label}: 날짜 형식은 사용할 수 없습니다.`);
    value = cell.v * (cmaUploadPercentFormat(cell.z) ? 100 : 1);
  } else if (typeof cell.v === "string") {
    const text = cell.v.normalize("NFKC").trim().replace(/−/g, "-");
    // Textual 4.12% and a general-format numeric 4.12 both mean 4.12%.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(text))
      throw new Error(`${label}: 숫자 또는 % 수치를 입력하십시오.`);
    value = Number(text.replace(/\s*%$/, ""));
  } else throw new Error(`${label}: 숫자를 입력하십시오.`);
  if (!Number.isFinite(value) || !Number.isFinite(value * value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100)
    throw new Error(`${label}: 숫자가 계산 범위를 초과했습니다.`);
  if (nonnegative && value < 0) throw new Error(`${label}: 변동성은 0 이상이어야 합니다.`);
  return cmaUploadRound(value);
}

function cmaParseWorkbook(workbook, assets) {
  if (typeof XLSX === "undefined") throw new Error("엑셀 읽기 기능을 불러오지 못했습니다. 새로고침 후 다시 시도하십시오.");
  if (!Array.isArray(assets) || !assets.length) throw new Error("자산배분 데이터가 없습니다.");
  const candidates = [];
  for (const name of workbook?.SheetNames || []) {
    const sheet = workbook.Sheets?.[name];
    if (!sheet?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"]);
    // CMA is a small table. Refuse oversized dimensions before traversing cells.
    if (range.e.r >= CMA_UPLOAD_MAX_ROWS || range.e.c >= CMA_UPLOAD_MAX_COLUMNS) {
      if (cmaUploadKey(name) === "cma") throw new Error("CMA 시트는 1,000행·64열 이내로 작성하십시오.");
      continue;
    }
    for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 19); row++) {
      const columns = {}, duplicates = [];
      for (let col = range.s.c; col <= range.e.c; col++) {
        const key = cmaUploadHeader(sheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v);
        if (!key) continue;
        if (columns[key] != null) duplicates.push(key);
        columns[key] = col;
      }
      if (["asset", "mu", "sig"].every((key) => columns[key] != null)) {
        candidates.push({ name, sheet, range, row, columns, duplicates });
        break;
      }
    }
  }
  const named = candidates.filter((candidate) => cmaUploadKey(candidate.name) === "cma");
  const matches = named.length ? named : candidates;
  if (!matches.length) throw new Error("자산군 · 기대수익률 (%) · 변동성 (%) 열이 있는 시트를 작성하십시오.");
  if (matches.length !== 1) throw new Error("여러 CMA 표가 있습니다. 불러올 시트 이름을 CMA로 지정하십시오.");
  const { name, sheet, range, row: headerRow, columns, duplicates } = matches[0];
  if (duplicates.length) throw new Error(`${name}: 자산군·기대수익률·변동성 열은 각각 하나만 작성하십시오.`);
  const rows = [], seen = new Set();
  for (let row = headerRow + 1; row <= range.e.r; row++) {
    const cells = Object.fromEntries(Object.entries(columns).map(([key, col]) =>
      [key, sheet[XLSX.utils.encode_cell({ r: row, c: col })]]));
    if (Object.values(cells).every((cell) => cell?.v == null || String(cell.v).trim() === "")) continue;
    const label = `${name} ${row + 1}행`;
    if (cells.asset?.f != null) throw new Error(`${label}: 자산명은 수식 대신 텍스트로 입력하십시오.`);
    const asset = cmaUploadAsset(cells.asset?.v, assets);
    if (!asset) throw new Error(`${label}: 지원하지 않는 자산군입니다 (${String(cells.asset?.v ?? "빈칸")}).`);
    if (seen.has(asset)) throw new Error(`${label}: ${asset}이(가) 중복되었습니다.`);
    const mu = cmaUploadNumber(cells.mu, `${label} 기대수익률`);
    // Validate the original sign before rounding; −0.001% is invalid, not zero.
    const sig = cmaUploadNumber(cells.sig, `${label} 변동성`, true);
    seen.add(asset); rows.push({ asset, mu, sig });
  }
  if (!rows.length) throw new Error(`${name}: 불러올 자산 수치가 없습니다.`);
  return { rows, sheetName: name };
}

async function cmaReadUpload(file, assets) {
  if (!file || !/\.(xlsx|xls)$/i.test(file.name || "")) throw new Error(".xlsx 또는 .xls 엑셀 파일을 선택하십시오.");
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > CMA_UPLOAD_MAX_BYTES)
    throw new Error("5MB 이하의 엑셀 파일을 선택하십시오.");
  if (typeof XLSX === "undefined") throw new Error("엑셀 읽기 기능을 불러오지 못했습니다. 새로고침 후 다시 시도하십시오.");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
  if (!zip && !ole) throw new Error("올바른 Excel 통합 문서가 아닙니다. Excel에서 .xlsx로 저장한 뒤 다시 선택하십시오.");
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "array", cellNF: true, cellDates: false,
      cellFormula: true, cellHTML: false, sheetRows: CMA_UPLOAD_MAX_ROWS + 1 });
  } catch {
    throw new Error("엑셀 파일을 읽지 못했습니다. 손상 여부와 암호 설정을 확인하십시오.");
  }
  return cmaParseWorkbook(workbook, assets);
}

function cmaImportRows(rows, assets) {
  // Validate the whole operation before changing any draft. Applied snapshots
  // remain active until the user presses the asset's allocation-apply button.
  if (!Array.isArray(rows) || !rows.length) throw new Error("불러올 자산 수치가 없습니다.");
  const seen = new Set();
  for (const row of rows) {
    if (!assets.includes(row?.asset) || seen.has(row.asset)) throw new Error("자산군이 유효하지 않거나 중복되었습니다.");
    if (![row.mu, row.sig].every((v) => typeof v === "number" && Number.isFinite(v) && Number.isFinite(v * v)) || row.sig < 0)
      throw new Error(`${row.asset}: 기대수익률·변동성을 확인하십시오.`);
    seen.add(row.asset);
  }
  const store = cmaStore(), replacements = [];
  for (const row of rows) {
    const current = store.assets[row.asset];
    const oldDraft = Array.isArray(current?.draft) && current.draft.length === 3 ? current.draft : null;
    const draft = CMA_SCENARIOS.map((scenario, index) => ({ id: scenario.id,
      p: oldDraft ? oldDraft[index]?.p : index === 1 ? 50 : 25,
      mu: cmaUploadRound(row.mu), sig: cmaUploadRound(row.sig) }));
    cmaSyncDraftProbability(draft);
    if (!cmaMoments(draft).valid) throw new Error(`${row.asset}: 먼저 낙관·중립 확률을 확인하십시오. 업로드 수치는 반영되지 않았습니다.`);
    replacements.push([row.asset, { ...(current || { enabled: false, applied: null }), draft }]);
  }
  for (const [asset, entry] of replacements) store.assets[asset] = entry;
  return { count: replacements.length, persisted: cmaSave() };
}
