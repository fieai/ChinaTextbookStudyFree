'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { cliOptions, loadNarration, selectEntries, runReadingTts } = require('./tts.cjs')
const { entriesFor } = require('./build.cjs')
const { runTts } = require('../learning-export/tts-elevenlabs.cjs')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const quiet = () => {}
const ENV = { ELEVENLABS_API_KEY: 'test-secret-must-stay-private', ELEVENLABS_VOICE_ID: 'test-voice' }
const ok = () => new Response(Buffer.from('ID3mock-audio'), { headers: { 'content-type': 'audio/mpeg' } })
const write = (filename, data) => fs.writeFileSync(filename, JSON.stringify(data))

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-tts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'content/reading-prep'), { recursive: true })
  fs.mkdirSync(path.join(root, '.local/reading-prep/review'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts/learning-export'), { recursive: true })
  const pdfPath = path.join(root, 'book.pdf')
  fs.writeFileSync(pdfPath, 'fixture source pdf bytes')
  const bookId = 'chinese-g1up-2026'
  const source = { pdfPath, sha256: digest(fs.readFileSync(pdfPath)), pageCount: 4 }
  const lessons = [1, 2].map(number => ({
    lessonNumber: number, lessonKey: `reading-0${number}`, title: `课文${number}`, sourceLessonId: null,
    status: 'reviewed', issues: [], pdfPages: [number],
    paragraphs: [{ id: 'p1', text: '我们学习。', pdfPages: [number] }],
    sentences: [{ id: 's1', text: '我们学习。', paragraphId: 'p1' }],
    recognitionCharacters: [{ char: '学', pinyin: 'xué', pdfPage: 3 }], writingCharacters: [],
    words: [{ text: '学习', pdfPage: 4, source: '词语表' }],
  }))
  const book = { schemaVersion: 1, bookId, source, lessons }
  write(path.join(root, 'content/reading-prep/inventory.json'), {
    schemaVersion: 1, books: [{ bookId, ...source, expectedLessonCount: 2, status: 'prepared' }],
  })
  const manifestPath = path.join(root, '.local/reading-prep/review/narration-manifest.json')
  const manifest = { schemaVersion: 1, purpose: 'text-preparation-only', providerCalled: false, partial: false,
    declaredBookIds: [bookId], includedBookIds: [bookId], entries: lessons.flatMap(lesson => entriesFor(book, lesson)) }
  write(manifestPath, manifest)
  const readBookImpl = () => book
  return { root, book, manifest, manifestPath, readBookImpl, bookId }
}
function prepare(entries) {
  return { entries: entries.map(entry => ({ ...entry, isCharacter: entry.kind === 'character',
    contextWord: entry.kind === 'character' ? '学习' : undefined,
    pronunciation: { blockers: [], review: [] } })), overrides: { entries: {}, texts: {} }, report: { ready: entries.length } }
}

test('CLI defaults to offline and validates explicit generation and stable lesson selection', () => {
  assert.equal(cliOptions([]).generate, false)
  assert.equal(cliOptions(['--generate']).generate, true)
  assert.throws(() => cliOptions(['--dry-run', '--generate']), /不能同时/u)
  assert.throws(() => cliOptions(['--lesson', '01']), /必须指定单册/u)
  assert.throws(() => cliOptions(['--kind', 'phonics']), /kind/u)
  assert.throws(() => cliOptions(['--limit', '0']), /正整数/u)
  assert.deepEqual(cliOptions(['--book', 'one,two', '--kind', 'whole,word']).books, ['one', 'two'])
})

test('manifest source is checked against current PDF and editorial entries, including review status', t => {
  const f = fixture(t)
  assert.equal(loadNarration(f).entries.length, 8)
  const sourceText = f.manifest.entries[0].text
  f.manifest.entries[0].text = '被修改的内容。'
  f.manifest.entries[0].textSha256 = digest(f.manifest.entries[0].text)
  write(f.manifestPath, f.manifest)
  assert.throws(() => loadNarration(f), /编辑源稿不同/u)
  f.manifest.entries[0].text = sourceText
  f.manifest.entries[0].textSha256 = digest(sourceText)
  f.manifest.partial = true
  write(f.manifestPath, f.manifest)
  assert.throws(() => loadNarration(f), /完整审定/u)
  f.manifest.partial = false
  write(f.manifestPath, f.manifest)
  f.book.lessons[0].status = 'needs-review'
  assert.throws(() => loadNarration(f), /未审定课文/u)
  f.book.lessons[0].status = 'reviewed'
  fs.appendFileSync(f.book.source.pdfPath, 'changed')
  assert.throws(() => loadNarration(f), /PDF 哈希/u)
  fs.unlinkSync(f.manifestPath)
  assert.throws(() => loadNarration(f), /找不到课文清单/u)
})

test('filters use stable lessonKey and reject unknown books or accidental bare ambiguous course numbers', t => {
  const f = fixture(t)
  const selected = selectEntries(f.manifest.entries, { books: [f.bookId], lesson: 'reading-02', kinds: ['word'] })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].lessonNumber, 2)
  assert.throws(() => selectEntries(f.manifest.entries, { lesson: '02' }), /指定单册/u)
  assert.throws(() => selectEntries(f.manifest.entries, { books: ['missing'] }), /未找到教材/u)
  assert.throws(() => selectEntries(f.manifest.entries, { lesson: `${f.bookId}/lesson-absent` }), /未找到指定课程/u)
})

test('default run is offline, preserves the legacy plan and writes source-preserving blocked review report', async t => {
  const f = fixture(t), cacheDir = path.join(f.root, '.local/tts-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'plan.json'), 'existing plan must survive')
  let called = 0
  const result = await runReadingTts({ ...f, env: {}, log: quiet,
    preparePronunciationImpl: entries => {
      const out = prepare(entries)
      const first = out.entries[0]
      first.pronunciation = { blockers: ['fixture unresolved'], review: ['needs listening'] }
      out.overrides.entries[first.id] = { text: '我们来学习。', skip: false }
      return out
    }, fetchImpl: () => { called++; throw new Error('unexpected') } })
  assert.equal(called, 0)
  assert.equal(result.plan.providerCalled, false)
  assert.equal(result.plan.skippedEntries, 1)
  assert.equal(result.plan.entries[0].text, '我们学习。')
  assert.equal(result.plan.entries[0].readingText, '我们来学习。')
  assert.equal(result.plan.entries[0].skipped, true)
  assert.equal(result.plan.entries[0].readyForSynthesis, false)
  assert.equal(result.plan.entries[0].textReviewed, true)
  assert.equal(result.plan.selectedLessons, 2)
  assert.equal(result.plan.byKind.find(row => row.key === 'word').uniqueNewRequests, 1)
  assert.equal(fs.readFileSync(path.join(cacheDir, 'plan.json'), 'utf8'), 'existing plan must survive')
  const report = JSON.parse(fs.readFileSync(path.join(result.outputDir, 'pronunciation-review.json')))
  assert.equal(report.blocked.length, 1)
  assert.equal(report.listeningReview.length, 1)
  assert(fs.readFileSync(path.join(result.outputDir, 'summary.md'), 'utf8').includes('未调用语音服务'))
})

test('existing cache is reused across legacy/new IDs and duplicate words issue no repeated request', async t => {
  const f = fixture(t)
  let calls = 0
  await runTts({ root: f.root, env: ENV, rawEntries: [{ id: 'old/word/1', lessonId: 'old', text: '学习', kind: 'word' }],
    fetchImpl: async () => { calls++; return ok() }, log: quiet })
  const result = await runReadingTts({ ...f, env: ENV, generate: true, kinds: ['word'],
    preparePronunciationImpl: prepare, log: quiet,
    fetchImpl: async () => { calls++; throw new Error('cache miss') } })
  assert.equal(calls, 1)
  assert.equal(result.cached, 2)
  assert.equal(result.plan.uniqueNewRequests, 0)
  assert.equal(result.plan.estimatedBillableCharacters, 0)
  assert.equal(result.plan.providerCalled, false)
  assert(!JSON.stringify(result.plan).includes(ENV.ELEVENLABS_API_KEY))
})

test('raw-entry runner resumes successes and retries only failed requests with bounded retries', async t => {
  const f = fixture(t)
  const rawEntries = ['成功', '失败'].map(text => ({ id: `new/${text}`, lessonId: 'new', text, kind: 'word' }))
  const firstRequests = []
  const first = await runTts({ root: f.root, env: ENV, rawEntries, log: quiet, concurrency: 1, maxRetries: 0,
    fetchImpl: async (_, request) => {
      const text = JSON.parse(request.body).text; firstRequests.push(text)
      return text === '失败' ? new Response(null, { status: 503 }) : ok()
    } })
  assert.equal(first.success, 1)
  assert.equal(first.failed, 1)
  const secondRequests = []
  const second = await runTts({ root: f.root, env: ENV, rawEntries, log: quiet, concurrency: 1, maxRetries: 1, sleep: async () => {},
    fetchImpl: async (_, request) => {
      secondRequests.push(JSON.parse(request.body).text)
      return secondRequests.length === 1 ? new Response(null, { status: 429 }) : ok()
    } })
  assert.deepEqual(firstRequests, ['成功', '失败'])
  assert.deepEqual(secondRequests, ['失败', '失败'])
  assert.equal(second.cached, 1)
  assert.equal(second.success, 1)
  assert.equal(second.failed, 0)
})

test('adapter rejects altered IDs or source text from pronunciation layer before any synthesis', async t => {
  const f = fixture(t)
  await assert.rejects(runReadingTts({ ...f, preparePronunciationImpl: entries => ({ entries: entries.map(entry => ({ ...entry, text: 'changed' })) }),
    fetchImpl: () => assert.fail('must not fetch'), log: quiet }), /改变原文/u)
})

test('generation reports attempted provider calls even when every request fails', async t => {
  const f = fixture(t)
  const result = await runReadingTts({ ...f, generate: true, env: ENV, kinds: ['word'],
    preparePronunciationImpl: prepare, log: quiet, maxRetries: 0,
    fetchImpl: async () => new Response(null, { status: 503 }) })
  assert.equal(result.failed, 2)
  assert.equal(result.plan.providerCalled, true)
  assert.equal(result.plan.providerAttempts, 1)
})

test('existing text-level word override remains effective while unresolved blockers cannot be reopened', async t => {
  const f = fixture(t)
  write(path.join(f.root, 'scripts/learning-export/tts-overrides.json'), {
    texts: { 学: { word: '学校' } }, entries: { [f.manifest.entries[2].id]: { text: '不应解除阻塞', skip: false } },
  })
  const result = await runReadingTts({ ...f, kinds: ['character'], env: {}, log: quiet,
    preparePronunciationImpl: entries => {
      const out = prepare(entries)
      out.entries[0].pronunciation.blockers = ['unresolved']
      return out
    } })
  assert.equal(result.plan.entries[0].skipped, true)
  assert.equal(result.plan.entries[1].readingText, '学，学校的学')
  assert.equal(result.plan.entries[1].contextWord, '学校')
})
