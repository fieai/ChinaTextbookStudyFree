'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { options, exportContent, WORKTREE } = require('./index.cjs')
const { buildStudioLessons } = require('./studio.cjs')
const { collectAudioEntries, loadSettings, prepareEntries } = require('./tts-common.cjs')
const { attachCachedAudio } = require('./audio.cjs')
const { loadAuthority } = require('./authority.cjs')
const { sha256, jsonBytes } = require('./common.cjs')
const { validateMediaReferences } = require('./media.cjs')

function cacheEntries(root, entries) {
  const cacheDir = path.join(root, '.local/tts-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const manifest = { schemaVersion: 1, entries: {} }
  for (const entry of entries) {
    // Two complete MPEG-1 Layer III frames; no speech service is contacted.
    const bytes = Buffer.alloc(417 * 2)
    for (const offset of [0, 417]) {
      bytes.writeUInt32BE(0xfffb9000, offset)
      bytes.write(entry.cacheKey, offset + 4, 'ascii')
    }
    fs.writeFileSync(path.join(cacheDir, `${entry.cacheKey}.mp3`), bytes)
    manifest.entries[entry.id] = { cacheKey: entry.cacheKey, sha256: sha256(bytes), charCount: entry.charCount,
      readingText: entry.readingText, configFingerprint: entry.configFingerprint }
  }
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), jsonBytes(manifest))
  return cacheDir
}

test('all converted audio targets are bundled, supported props validate, and absent audio stays absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-audio-'))
  const outputRoot = path.join(WORKTREE, '.local/learning-export', `.audio-${randomUUID()}`)
  const config = options([])
  const secret = 'private-export-key-never-in-reports'
  const env = { ELEVENLABS_VOICE_ID: 'test-voice', ELEVENLABS_API_KEY: secret }
  try {
    const studio = buildStudioLessons(config)
    const studioLessonIds = new Set(Object.keys(studio.patches))
    const studioOnly = items => items.filter(item => studioLessonIds.has(item.lessonId || item.id.split('/')[0]))
    const entries = prepareEntries(collectAudioEntries(studio.patches), {}, loadSettings({ root, env }))
    assert.equal(entries.length, 125, 'the existing studio lesson collection must not change')
    assert.ok(entries.some(item => item.id.endsWith('/whole')))
    assert.ok(entries.some(item => item.id.includes('/family/')))
    assert.ok(entries.some(item => item.id.includes('/pairs/')))
    const missing = entries.find(item => item.isCharacter)
    const readingPatches = require('./reading-language.cjs').loadReadingLessonPatches(config)
    const newEntries = prepareEntries(collectAudioEntries(readingPatches), {}, loadSettings({ root, env }))
    const newCached = ['sentence', 'whole', 'character', 'word'].map(kind => newEntries.find(entry => entry.kind === kind))
    assert.ok(newCached.every(Boolean))
    cacheEntries(root, [...entries.filter(item => item.id !== missing.id && item.cacheKey !== missing.cacheKey), ...newCached])
    const result = exportContent({ ...config, ttsRoot: root, ttsEnv: env, outputRoot })
    assert.equal(result.report.valid, true, JSON.stringify(result.report.issues))
    for (const name of fs.readdirSync(result.outputDir).filter(name => name !== 'media'))
      assert.ok(!fs.readFileSync(path.join(result.outputDir, name), 'utf8').includes(secret), `Secret excluded from ${name}`)
    const audio = result.media.media.filter(item => item.kind === 'audio')
    assert.ok(audio.length > 50)
    for (const item of audio) {
      assert.equal(item.mime, 'audio/mpeg')
      assert.equal(item.path, `media/${item.sha256}.mp3`)
      assert.equal(sha256(fs.readFileSync(path.join(result.outputDir, item.path))), item.sha256)
    }
    const lessons = Object.fromEntries(result.content.books.flatMap(book => book.lessons).map(item => [item.content.sourceLessonId, item.content]))
    for (const entry of collectAudioEntries(lessons)) {
      const record = result.report.audio.entries.find(item => item.id === entry.id)
      if (record.status === 'attached') assert.deepEqual(entry.target.audio, { sha256: record.sha256, kind: 'audio' })
      else assert.equal(entry.target.audio, undefined)
    }
    assert.ok(result.report.audio.entries.some(item => item.status === 'missing'))
    const newTargets = studioOnly(collectAudioEntries(lessons)).filter(item => item.id.includes('/family/') || item.id.endsWith('/whole'))
    assert.ok(newTargets.length > 0)
    for (const entry of newTargets) {
      const record = result.report.audio.entries.find(item => item.id === entry.id)
      assert.equal(record.status, 'attached', entry.id)
      assert.deepEqual(entry.target.audio, { sha256: record.sha256, kind: 'audio' })
    }
    assert.ok(studioOnly(result.report.audio.entries).every(item => item.status !== 'contract-unsupported'))
    for (const entry of newCached) {
      const actual = collectAudioEntries(lessons).find(item => item.id === entry.id)
      assert.equal(result.report.audio.entries.find(item => item.id === entry.id).status, 'attached')
      assert.equal(actual.target.audio.kind, 'audio')
    }
    assert.ok(result.report.audio.entries.some(item => readingPatches[item.lessonId] && item.status === 'missing'))
    const missingWords = entries.filter(item => item.missingWord)
      .map(({ id, text }) => ({ id, text, reason: '无组词' }))
    assert.ok(missingWords.length > 0, 'fixture includes characters without lesson context words')
    assert.deepEqual(studioOnly(result.report.audio.missingWords), missingWords)
    const savedReport = JSON.parse(fs.readFileSync(path.join(result.outputDir, 'report.json'), 'utf8'))
    assert.deepEqual(studioOnly(savedReport.audio.missingWords), missingWords)
    for (const entry of entries) {
      const saved = savedReport.audio.entries.find(item => item.id === entry.id)
      assert.equal(saved.readingText, entry.readingText)
      if (entry.missingWord) {
        assert.equal(saved.missingWord, true)
        assert.equal(saved.readingNote, '无组词')
      }
    }
    const counts = studioOnly(result.report.audio.lessons)
    assert.equal(counts.reduce((n, x) => n + x.total, 0), entries.length)
    assert.ok(counts.every(x => x.total === x.withAudio + x.missingAudio))
    assert.ok(counts.every(x => x.withAudio === x.attached && x.unsupported === 0))
    assert.match(fs.readFileSync(path.join(result.outputDir, 'report.md'), 'utf8'), /音频覆盖/u)
    assert.match(fs.readFileSync(path.join(result.outputDir, 'report.md'), 'utf8'), /无组词/u)
    assert.equal(result.report.audio.deliverySupported, true)
    assert.ok(!result.report.warnings.some(item => item.code === 'AUDIO_DELIVERY_UNSUPPORTED'))
    assert.deepEqual(result.content.media.filter(item => item.kind === 'audio'),
      audio.map(({ sha256, kind, mime }) => ({ sha256, kind, mime })))
    const authority = loadAuthority(config.thinkyRoot)
    assert.equal(authority.ContentPackageSchema.safeParse(result.content).success, true)
    assert.equal(authority.validateContentPackage(result.content).report.valid, true)
    // Validate the real bundle, including MP3 sidecar metadata and frame checks.
    const validated = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only',
      '-r', 'tsconfig-paths/register', 'scripts/content-sync/cli.ts', 'validate', result.outputDir], {
      cwd: config.thinkyRoot, env: { ...process.env, NODE_ENV: 'learning-local' }, encoding: 'utf8',
    })
    assert.match(validated, /VALID: package accepted/u)
    const bad = { ...result.media, media: result.media.media.filter(item => item.kind !== 'audio') }
    assert.ok(validateMediaReferences(result.content, bad, result.media.media.map(item => ({
      sha256: item.sha256, sourcePath: path.join(result.outputDir, item.path),
    }))).some(item => /Missing audio/.test(item.message)))
    const changedVoice = attachCachedAudio(buildStudioLessons(config), { root, env: { ELEVENLABS_VOICE_ID: 'different-voice' } })
    assert.equal(changedVoice.sources.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('entry-specific word overrides do not overwrite the shared dictation word recording', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-audio-overrides-'))
  const config = options([]), env = { ELEVENLABS_VOICE_ID: 'test-voice' }
  try {
    const studio = buildStudioLessons(config)
    const words = collectAudioEntries(studio.patches).filter(x => x.id.endsWith('/words/word-1'))
    assert.equal(words.length, 2)
    const overrides = { entries: { [words[0].id]: '山坡，山坡上的花' }, texts: {} }
    fs.mkdirSync(path.join(root, 'scripts/learning-export'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/learning-export/tts-overrides.json'), jsonBytes(overrides))
    const entries = prepareEntries(words, overrides, loadSettings({ root, env }))
    cacheEntries(root, entries)
    attachCachedAudio(studio, { root, env })
    const result = collectAudioEntries(studio.patches).filter(x => x.id.endsWith('/words/word-1'))
    assert.notEqual(result[0].target.audio.sha256, result[1].target.audio.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cached textbook card readings are reported without adding unsupported audio to cards', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-card-audio-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { ELEVENLABS_VOICE_ID: 'test-voice' }
  const patch = { level: 'textbook-only', cards: [
    { key: 'recognize-yang', kind: 'character', label: '扬', prompt: '读一读。', answer: 'yáng；组词：飘扬' },
    { key: 'poem-first', kind: 'reading', label: '第一句', prompt: '迟日江山丽。', answer: '读得流畅。' },
  ] }
  const input = { patches: { lesson: patch } }, original = structuredClone(patch)
  const entries = prepareEntries(collectAudioEntries(input.patches), {}, loadSettings({ root, env }))
  cacheEntries(root, entries)
  const result = attachCachedAudio(input, { root, env })
  assert.equal(result.coverage.entries.length, entries.length)
  assert.equal(result.sources.length, 0, 'unreferenced card recordings must not enter package media')
  assert.ok(result.coverage.entries.every(entry => entry.status === 'contract-unsupported'))
  assert.equal(result.coverage.lessons[0].attached, 0)
  assert.equal(result.coverage.lessons[0].unsupported, entries.length)
  assert.deepEqual(patch, original)
  assert.ok(patch.cards.every(card => !Object.hasOwn(card, 'audio')))
})

for (const byteLength of [2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
  test(`cached whole-lesson audio at ${byteLength} bytes respects the 2 MiB contract limit`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-audio-size-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const env = { ELEVENLABS_VOICE_ID: 'test-voice' }
    const input = { patches: { lesson: { basicStages: [{ key: 'reading', widget: 'read-aloud', props: {
      sentences: [{ id: 'first', text: '山坡上的花开了。' }, { id: 'second', text: '小朋友一起看花。' }],
    } }] } } }
    const entries = prepareEntries(collectAudioEntries(input.patches), {}, loadSettings({ root, env }))
    const whole = entries.find(entry => entry.kind === 'whole')
    assert.ok(whole)
    const cacheDir = cacheEntries(root, [whole])
    const filename = path.join(cacheDir, `${whole.cacheKey}.mp3`)
    const bytes = Buffer.alloc(byteLength)
    fs.readFileSync(filename).copy(bytes)
    fs.writeFileSync(filename, bytes)
    const digest = sha256(bytes)
    const manifestPath = path.join(cacheDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.entries[whole.id].sha256 = digest
    fs.writeFileSync(manifestPath, jsonBytes(manifest))
    const originalManifest = fs.readFileSync(manifestPath)

    const result = attachCachedAudio(input, { root, env })
    const actual = collectAudioEntries(input.patches).find(entry => entry.id === whole.id)
    const record = result.coverage.entries.find(entry => entry.id === whole.id)
    const rejected = byteLength > 2 * 1024 * 1024
    assert.equal(record.status, rejected ? 'contract-unsupported' : 'attached')
    assert.equal(record.sha256, digest)
    assert.deepEqual(result.inputs, [{ label: `tts/${whole.id}`, path: filename, sha256: digest }])
    assert.deepEqual(result.coverage.lessons, [{ lessonId: 'lesson', total: 3, withAudio: 1,
      missingAudio: 2, attached: rejected ? 0 : 1, unsupported: rejected ? 1 : 0, skipped: 0 }])
    if (rejected) {
      const reason = 'Audio exceeds 2 MiB size limit'
      assert.equal(actual.target.audio, undefined)
      assert.deepEqual(result.sources, [])
      assert.equal(record.rejectionReason, reason)
      assert.equal(record.byteLength, byteLength)
      assert.deepEqual(result.coverage.rejectedMedia, [{ id: whole.id, text: whole.text, byteLength, reason }])
    } else {
      assert.deepEqual(actual.target.audio, { sha256: digest, kind: 'audio' })
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].size, byteLength)
      assert.equal(result.sources[0].sha256, digest)
      assert.deepEqual(result.sources[0].bytes, bytes)
      assert.equal(record.rejectionReason, undefined)
      assert.deepEqual(result.coverage.rejectedMedia, [])
    }
    assert.deepEqual(fs.readFileSync(filename), bytes, 'attachment must preserve the original cached recording')
    assert.deepEqual(fs.readFileSync(manifestPath), originalManifest, 'attachment must preserve the cache manifest')
  })
}
