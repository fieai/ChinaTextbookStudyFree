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
    // Simulated provider bytes; this test never contacts a speech service.
    const bytes = Buffer.from(`ID3 simulated MP3 ${entry.cacheKey}`)
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
    const entries = prepareEntries(collectAudioEntries(studio.patches), {}, loadSettings({ root, env }))
    assert.ok(entries.some(item => item.id.endsWith('/whole')))
    assert.ok(entries.some(item => item.id.includes('/family/')))
    assert.ok(entries.some(item => item.id.includes('/pairs/')))
    const missing = entries.find(item => item.isCharacter)
    cacheEntries(root, entries.filter(item => item.id !== missing.id && item.cacheKey !== missing.cacheKey))
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
    assert.ok(result.report.audio.entries.some(item => item.status === 'contract-unsupported'))
    const counts = result.report.audio.lessons
    assert.equal(counts.reduce((n, x) => n + x.total, 0), entries.length)
    assert.ok(counts.every(x => x.total === x.withAudio + x.missingAudio))
    assert.match(fs.readFileSync(path.join(result.outputDir, 'report.md'), 'utf8'), /音频覆盖/u)
    assert.match(result.report.gaps.join('\n'), /Range\/206\/416/u)
    assert.ok(result.content.media.every(item => item.kind === 'document')) // frozen Thinky package contract
    const authority = loadAuthority(config.thinkyRoot)
    assert.equal(authority.ContentPackageSchema.safeParse(result.content).success, true)
    assert.equal(authority.validateContentPackage(result.content).report.valid, true)
    // Current content-sync validates supported audio props but does not import
    // audio sidecars; document that gap rather than claiming playback support.
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
