'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// These bounds are the reviewed body pages, never a guess based on PDF length.
const MATH_PRINTED_RANGES = {
  'g3up-2026': { from: 7, to: 109, evidence: 'math-lessons/page-structure-up.md:3', marker: '物理p7–109，对应印刷p1–103' },
  'g3down-2026': { from: 7, to: 111, evidence: 'math-lessons/page-structure-down.md:3,5', marker: '印刷页 = p − 6' },
};

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (ch === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else cell += ch;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift() || [];
  if (new Set(header).size !== header.length) throw new Error('Duplicate CSV header');
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`CSV row ${index + 2}: wrong number of fields`);
    return Object.fromEntries(header.map((key, j) => [key, values[j]]));
  });
}

function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error('Invalid or truncated PNG signature');
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('Invalid PNG IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('Invalid PNG dimensions');
  let offset = 8, hasData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + size + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size))
      throw new Error(`PNG ${kind} chunk CRC mismatch`);
    if (kind === 'IHDR' && offset !== 8) throw new Error('Duplicate PNG IHDR');
    if (kind === 'IDAT') hasData = true;
    if (kind === 'IEND') {
      if (size !== 0 || offset + 12 !== bytes.length) throw new Error('Invalid PNG end chunk or trailing bytes');
      ended = true; break;
    }
    offset += size + 12;
  }
  if (!hasData || !ended) throw new Error('PNG missing image data or end chunk');
  return { width, height };
}

/** Read-only inventory. Pass the prototype's raw books to also verify frozen PDF hashes. */
function inspectPages({ siteDir, evidenceDir, books }) {
  if (!Array.isArray(books) || !books.length) throw new Error('Page inventory requires books');
  const inputFiles = [], mediaSources = [], warnings = [], bookEvidence = [];
  const readInput = (filePath, label) => {
    const bytes = fs.readFileSync(filePath);
    inputFiles.push({ path: filePath, label, sha256: sha256(bytes) });
    return bytes;
  };
  const checksumPath = path.join(path.dirname(siteDir), 'checksums.json');
  const frozen = JSON.parse(readInput(checksumPath, 'prototype-deployment/checksums.json').toString('utf8'));
  if (!frozen.files || typeof frozen.files !== 'object' || Array.isArray(frozen.files))
    throw new Error('Invalid frozen deployment checksums');
  const startsPath = path.join(evidenceDir, 'page-start-review.csv');
  const starts = parseCsv(readInput(startsPath, 'evidence/page-start-review.csv').toString('utf8'));
  const printedByBook = new Map();
  for (const [index, start] of starts.entries()) {
    const physical = Number(start.physicalStart), printed = Number(start.printedStart);
    if (!/^chinese-g3(?:up|down)-2026$/.test(start.sourceBookId)
      || !Number.isInteger(physical) || physical < 1 || !Number.isInteger(printed) || printed < 1
      || physical - printed !== 6 || !start.evidenceLocations)
      throw new Error(`Invalid reviewed printed-page mapping at CSV row ${index + 2}`);
    let map = printedByBook.get(start.sourceBookId);
    if (!map) printedByBook.set(start.sourceBookId, map = new Map());
    const prior = map.get(physical);
    if (prior && prior.printed !== printed) throw new Error(`Conflicting printed page at ${start.sourceBookId}/${physical}`);
    map.set(physical, { printed, evidence: `page-start-review.csv:${index + 2};${start.evidenceLocations}` });
  }
  // Hash OCR evidence as inputs even though the reviewed CSV is the mapping authority.
  for (const name of ['pdf-toc-chinese-ocr.txt', 'prototype-toc-columns-ocr.txt'])
    readInput(path.join(evidenceDir, name), `evidence/${name}`);

  const seenBooks = new Set();
  const manifestBooks = [...books].sort((a, b) => (a.sourceBookId || a.id).localeCompare(b.sourceBookId || b.id, 'en')).map(book => {
    const sourceBookId = book.sourceBookId || book.id;
    if (!/^(?:chinese-)?g3(?:up|down)-2026$/.test(sourceBookId) || seenBooks.has(sourceBookId))
      throw new Error(`Unsupported or duplicate source book ${sourceBookId}`);
    seenBooks.add(sourceBookId);
    const totalPages = book.totalPages ?? book.pdf?.pages;
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error(`${sourceBookId}: invalid totalPages`);
    const pdfPath = path.join(siteDir, 'textbook', `${sourceBookId}.pdf`);
    const pdf = readInput(pdfPath, `prototype/textbook/${sourceBookId}.pdf`);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`${sourceBookId}: invalid PDF`);
    const pdfSha256 = sha256(pdf);
    const expectedHash = book.pdfSha256 ?? book.pdf?.sha256;
    if (expectedHash && expectedHash !== pdfSha256) throw new Error(`${sourceBookId}: PDF hash differs from prototype metadata`);
    const imageDir = path.join(siteDir, 'page-image', sourceBookId);
    const imageNames = fs.readdirSync(imageDir).filter(name => name.endsWith('.png'));
    if (imageNames.length !== totalPages || imageNames.some(name => !/^[1-9]\d*\.png$/.test(name) || Number(name.slice(0, -4)) > totalPages))
      throw new Error(`${sourceBookId}: expected exactly pages 1..${totalPages}, found ${imageNames.length} PNGs`);
    const math = MATH_PRINTED_RANGES[sourceBookId];
    if (math) {
      const name = math.evidence.split(':')[0];
      const text = readInput(path.join(evidenceDir, name), `evidence/${name}`).toString('utf8');
      if (!text.includes(math.marker)) throw new Error(`${sourceBookId}: reviewed printed-page rule changed`);
      if (sourceBookId === 'g3down-2026' && !text.includes('p7–111 为课时正文'))
        throw new Error(`${sourceBookId}: reviewed body-page bounds changed`);
    }
    const unknown = [], pages = [], pageEvidence = [];
    for (let physicalPage = 1; physicalPage <= totalPages; physicalPage++) {
      const sourcePath = path.join(imageDir, `${physicalPage}.png`);
      const bytes = readInput(sourcePath, `prototype/page-image/${sourceBookId}/${physicalPage}.png`);
      const dimensions = pngDimensions(bytes);
      const digest = sha256(bytes), mediaPath = `media/${digest}.png`;
      const frozenPage = frozen.files[`page-image/${sourceBookId}/${physicalPage}.png`];
      if (!frozenPage || frozenPage.sha256 !== digest || frozenPage.bytes !== bytes.length)
        throw new Error(`${sourceBookId}/${physicalPage}: page PNG differs from frozen deployment SHA256/bytes`);
      let printedPageNumber = null, printedPageEvidence = null;
      if (math && physicalPage >= math.from && physicalPage <= math.to) {
        printedPageNumber = physicalPage - 6;
        printedPageEvidence = math.evidence;
      } else if (!math) {
        const reviewed = printedByBook.get(sourceBookId)?.get(physicalPage);
        if (reviewed) { printedPageNumber = reviewed.printed; printedPageEvidence = reviewed.evidence; }
      }
      if (printedPageNumber === null) unknown.push(physicalPage);
      pages.push({ page: physicalPage, printedPage: printedPageNumber === null ? null : String(printedPageNumber),
        sha256: digest, mime: 'image/png', ...dimensions });
      pageEvidence.push({ physicalPage, printedPageNumber, printedPageEvidence, mediaPath });
      mediaSources.push({ sourcePath, mediaPath, sha256: digest });
    }
    for (const physical of printedByBook.get(sourceBookId)?.keys() || [])
      if (physical > totalPages) throw new Error(`${sourceBookId}: reviewed printed page exceeds PDF bounds`);
    if (unknown.length) warnings.push({
      code: 'PRINTED_PAGE_UNKNOWN', sourceBookId, pages: unknown,
      message: `${sourceBookId}: ${unknown.length} 页缺少可直接使用的印刷页码证据，保留 null；语文只采用目录明确起页，数学只采用逐页记录明示的正文偏移区间。`,
    });
    bookEvidence.push({ sourceBookId, totalPages, pdfSha256, pages: pageEvidence });
    return { sourceBookId, pages };
  });
  return { manifest: { schemaVersion: 1, books: manifestBooks }, bookEvidence, inputFiles, warnings, mediaSources };
}

/** Hash stable labels and bytes, never absolute filesystem paths or timestamps. */
function inputFingerprint(inputFiles) {
  const entries = new Map();
  for (const file of inputFiles) {
    if (!file.label || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid input fingerprint entry');
    if (entries.has(file.label) && entries.get(file.label) !== file.sha256) throw new Error(`Conflicting input ${file.label}`);
    entries.set(file.label, file.sha256);
  }
  return sha256(JSON.stringify([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

/** Materialize only under the caller's output directory; existing corrupted files block export. */
function materializeMedia({ outputDir, mediaSources }) {
  for (const directory of [outputDir, path.join(outputDir, 'media')]) {
    let info;
    try { info = fs.lstatSync(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`Media output directory must not be a symlink or non-directory: ${directory}`);
    fs.mkdirSync(directory, { recursive: true });
  }
  const seen = new Set();
  for (const item of mediaSources) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.mediaPath !== `media/${item.sha256}.png`)
      throw new Error('Invalid content-addressed media path');
    if (seen.has(item.mediaPath)) continue;
    seen.add(item.mediaPath);
    const target = path.join(outputDir, item.mediaPath);
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile() || sha256(fs.readFileSync(target)) !== item.sha256)
        throw new Error(`Existing media is not the expected content: ${item.mediaPath}`);
      continue;
    }
    if (sha256(fs.readFileSync(item.sourcePath)) !== item.sha256) throw new Error(`Page changed after inventory: ${item.sourcePath}`);
    try { fs.linkSync(item.sourcePath, target); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(error.code)) throw error;
      fs.copyFileSync(item.sourcePath, target, fs.constants.COPYFILE_EXCL);
    }
    if (!fs.lstatSync(target).isFile() || sha256(fs.readFileSync(target)) !== item.sha256)
      throw new Error(`Materialized media differs from its content hash: ${item.mediaPath}`);
  }
  return { mediaFileCount: seen.size };
}

module.exports = { inspectPages, materializeMedia, inputFingerprint, pngDimensions, parseCsv, sha256 };
