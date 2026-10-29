'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectPages, materializeMedia, inputFingerprint, pngDimensions, sha256, parseCsv } = require('./pages.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-export-pages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const siteDir = path.join(root, 'site'), evidenceDir = path.join(root, 'evidence');
  const sourceBookId = 'chinese-g3up-2026';
  fs.mkdirSync(path.join(siteDir, 'textbook'), { recursive: true });
  fs.mkdirSync(path.join(siteDir, 'page-image', sourceBookId), { recursive: true });
  fs.mkdirSync(evidenceDir);
  const pdf = Buffer.from('%PDF-1.4\nfixture');
  fs.writeFileSync(path.join(siteDir, 'textbook', `${sourceBookId}.pdf`), pdf);
  for (let n = 1; n <= 8; n++) fs.writeFileSync(path.join(siteDir, 'page-image', sourceBookId, `${n}.png`), PNG);
  fs.writeFileSync(path.join(root, 'checksums.json'), JSON.stringify({ files: Object.fromEntries(
    Array.from({ length: 8 }, (_, n) => [`page-image/${sourceBookId}/${n + 1}.png`, { sha256: sha256(PNG), bytes: PNG.length }]),
  ) }));
  fs.writeFileSync(path.join(evidenceDir, 'page-start-review.csv'), 'sourceBookId,sourceLessonId,printedStart,physicalStart,evidenceLocations\nchinese-g3up-2026,lesson1,2,8,pdf-toc-chinese-ocr.txt:5\n');
  fs.writeFileSync(path.join(evidenceDir, 'pdf-toc-chinese-ocr.txt'), 'reviewed toc');
  fs.writeFileSync(path.join(evidenceDir, 'prototype-toc-columns-ocr.txt'), 'reviewed columns');
  return { root, siteDir, evidenceDir, books: [{ id: sourceBookId, pdf: { pages: 8, sha256: sha256(pdf) } }] };
}

test('manifest is deterministic and uses only reviewed printed-page evidence', t => {
  const args = fixture(t), first = inspectPages(args), second = inspectPages(args);
  assert.equal(JSON.stringify(first.manifest), JSON.stringify(second.manifest));
  const book = first.manifest.books[0];
  assert.equal(book.pages.length, 8);
  assert.equal(book.pages[7].printedPageNumber, 2);
  assert.match(book.pages[7].printedPageEvidence, /page-start-review.csv:2/);
  assert.ok(book.pages.slice(0, 7).every(page => page.printedPageNumber === null));
  assert.deepEqual(first.warnings[0].pages, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual({ width: book.pages[0].width, height: book.pages[0].height }, { width: 1, height: 1 });
  assert.equal(book.pages[0].sha256, sha256(PNG));
  assert.equal(book.pages[0].mediaPath, `media/${sha256(PNG)}.png`);
});

test('input fingerprint excludes absolute paths and order, includes evidence contents', t => {
  const args = fixture(t), inputs = inspectPages(args).inputFiles;
  const before = inputFingerprint(inputs);
  assert.equal(inputFingerprint(inputs.slice().reverse().map(f => ({ ...f, path: '/somewhere/else' }))), before);
  fs.appendFileSync(path.join(args.evidenceDir, 'pdf-toc-chinese-ocr.txt'), ' changed');
  assert.notEqual(inputFingerprint(inspectPages(args).inputFiles), before);
  assert.throws(() => inputFingerprint([...inputs, { ...inputs[0], sha256: 'a'.repeat(64) }]), /Conflicting input/);
});

test('hashed media are materialized once and repeat writes verify existing bytes', t => {
  const args = fixture(t), data = inspectPages(args), outputDir = path.join(args.root, 'out');
  assert.equal(materializeMedia({ outputDir, mediaSources: data.mediaSources }).mediaFileCount, 1);
  assert.equal(materializeMedia({ outputDir, mediaSources: data.mediaSources }).mediaFileCount, 1);
  const destination = path.join(outputDir, data.mediaSources[0].mediaPath);
  assert.deepEqual(fs.readFileSync(destination), PNG);
  // Unlink first because the materializer may have created a hard link to a read-only input.
  fs.unlinkSync(destination);
  fs.writeFileSync(destination, 'corruption');
  assert.throws(() => materializeMedia({ outputDir, mediaSources: data.mediaSources }), /Existing media/);
  assert.deepEqual(fs.readFileSync(data.mediaSources[0].sourcePath), PNG);
});

test('missing physical page, incorrect PDF hash, invalid PNG, bad evidence all block export', t => {
  const args = fixture(t);
  assert.throws(() => inspectPages({ ...args, books: [{ ...args.books[0], pdf: { pages: 8, sha256: '0'.repeat(64) } }] }), /PDF hash differs/);
  const image = path.join(args.siteDir, 'page-image', args.books[0].id, '1.png');
  fs.unlinkSync(image);
  assert.throws(() => inspectPages(args), /expected exactly pages/);
  fs.writeFileSync(image, 'invalid PNG');
  assert.throws(() => inspectPages(args), /Invalid or truncated PNG/);
  fs.writeFileSync(image, PNG);
  fs.writeFileSync(path.join(args.evidenceDir, 'page-start-review.csv'), 'sourceBookId,printedStart,physicalStart,evidenceLocations\nchinese-g3up-2026,99,8,wrong\n');
  assert.throws(() => inspectPages(args), /Invalid reviewed printed-page/);
});

test('a page changed after read-only inventory cannot be linked under an old hash', t => {
  const args = fixture(t), data = inspectPages(args);
  fs.writeFileSync(data.mediaSources[0].sourcePath, 'changed');
  assert.throws(() => materializeMedia({ outputDir: path.join(args.root, 'out'), mediaSources: data.mediaSources }), /Page changed after inventory/);
});

test('frozen deployment checksums are fingerprinted and reject replaced or unlisted page PNGs', t => {
  const args = fixture(t);
  const data = inspectPages(args);
  assert.ok(data.inputFiles.some(file => file.label === 'prototype-deployment/checksums.json'));
  const checksumsPath = path.join(args.root, 'checksums.json');
  const frozen = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
  const page = `page-image/${args.books[0].id}/1.png`;
  frozen.files[page].sha256 = '0'.repeat(64);
  fs.writeFileSync(checksumsPath, JSON.stringify(frozen));
  assert.throws(() => inspectPages(args), /differs from frozen deployment SHA256/);
  delete frozen.files[page];
  fs.writeFileSync(checksumsPath, JSON.stringify(frozen));
  assert.throws(() => inspectPages(args), /differs from frozen deployment SHA256/);
});

test('media directory symlinks are rejected without writing through them', t => {
  const args = fixture(t), data = inspectPages(args);
  const outputDir = path.join(args.root, 'out'), outside = path.join(args.root, 'outside');
  fs.mkdirSync(outputDir); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(outputDir, 'media'), 'dir');
  assert.throws(() => materializeMedia({ outputDir, mediaSources: data.mediaSources }), /must not be a symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an existing media hard link is read or rejected, never overwritten', t => {
  const args = fixture(t), data = inspectPages(args), outputDir = path.join(args.root, 'out');
  fs.mkdirSync(path.join(outputDir, 'media'), { recursive: true });
  const protectedFile = path.join(args.root, 'protected-file');
  fs.writeFileSync(protectedFile, 'protected original');
  const destination = path.join(outputDir, data.mediaSources[0].mediaPath);
  fs.linkSync(protectedFile, destination);
  assert.throws(() => materializeMedia({ outputDir, mediaSources: data.mediaSources }), /Existing media/);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected original');
});

test('copy fallback verifies the destination bytes after materialization', t => {
  const args = fixture(t), data = inspectPages(args), outputDir = path.join(args.root, 'out');
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, 'linkSync', () => { const error = new Error('cross-device fixture'); error.code = 'EXDEV'; throw error; });
  t.mock.method(fs, 'copyFileSync', (source, target, mode) => {
    originalCopy(source, target, mode);
    fs.appendFileSync(target, 'simulated copy corruption');
  });
  assert.throws(() => materializeMedia({ outputDir, mediaSources: data.mediaSources }), /Materialized media differs/);
  assert.deepEqual(fs.readFileSync(data.mediaSources[0].sourcePath), PNG);
});

test('PNG corruption in IHDR and IDAT CRCs is rejected even with valid dimensions', () => {
  for (const offset of [29, 52]) {
    const corrupted = Buffer.from(PNG);
    corrupted[offset] ^= 255;
    assert.throws(() => pngDimensions(corrupted), /CRC mismatch/);
  }
  assert.deepEqual(pngDimensions(PNG), { width: 1, height: 1 });
  assert.throws(() => pngDimensions(Buffer.concat([PNG, Buffer.from('trailing data')])), /trailing bytes/);
});

test('CSV quoting and image format fail closed', () => {
  assert.deepEqual(parseCsv('a,b\n"x,y","say ""hello"""\n'), [{ a: 'x,y', b: 'say "hello"' }]);
  assert.throws(() => parseCsv('a,b\n"unterminated'), /Unclosed/);
  assert.throws(() => pngDimensions(PNG.subarray(0, 40)), /truncated|Truncated/);
});
