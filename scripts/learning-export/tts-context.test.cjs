'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTts, cliOptions, selectSample } = require('./tts-elevenlabs.cjs')
const { collectAudioEntries, loadSettings, prepareEntries, readOverrides } = require('./tts-common.cjs')
const ENV = { ELEVENLABS_API_KEY: 'mock-key', ELEVENLABS_VOICE_ID: 'mock-voice' }
const quiet = () => {}
const stage = (key, widget, props) => ({ key, widget, props })
const ok = () => new Response(Buffer.from('ID3mock-audio'), { headers: { 'content-type': 'audio/mpeg' } })
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-tts-context-'))
  fs.mkdirSync(path.join(root, 'scripts/learning-export'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function patches() {
  return { lesson: { basicStages: [
    stage('read', 'char-learn', { characters: [
      { id: 'yang', char: '扬', family: [{ id: 'fy', word: '飞扬' }] },
      { id: 'rong', char: '绒' }, { id: 'qiang', char: '墙' },
    ], words: [{ id: 'w1', text: '飘扬' }, { id: 'duplicate-word', text: '飘扬' },
      { id: 'w2', text: '绒毛' }, { id: 'w3', text: '墙壁' }, { id: 'w4', text: '扬起' }] }),
    stage('write', 'hanzi-write', { characters: [{ id: 'yang2', char: '扬' }] }),
    stage('text', 'read-aloud', { sentences: [
      { id: 's1', text: '红旗飘扬。' }, { id: 'duplicate-sentence', text: '红旗飘扬。' },
      { id: 's2', text: '墙壁上有绒毛。' }, { id: 's3', text: '我们一起读课文。' },
    ], pairs: [{ id: 'p1', upper: '红旗飘扬', lower: '墙壁洁白' }] }),
  ] } }
}
function settings(root, env = {}) { return loadSettings({ root, env: { ...ENV, ...env } }) }

test('defaults select eleven_v4 and zh; local language can override or explicitly disable it', t => {
  const root = fixture(t)
  assert.equal(settings(root).modelId, 'eleven_v4')
  assert.equal(settings(root).languageCode, 'zh')
  fs.writeFileSync(path.join(root, '.env.local'), 'ELEVENLABS_LANGUAGE_CODE=ja\n')
  assert.equal(settings(root).languageCode, 'ja')
  assert.equal(settings(root, { ELEVENLABS_LANGUAGE_CODE: '' }).languageCode, '')
  fs.writeFileSync(path.join(root, '.env.local'), 'ELEVENLABS_LANGUAGE_CODE=\n')
  assert.equal(settings(root).languageCode, '')
})

test('v4 sends zh, multilingual_v2 omits it and warns without modifying local settings', async t => {
  const root = fixture(t), bodies = [], logs = []
  const args = { root, patches: patches(), only: 'lesson', limit: 1, env: ENV, log: line => logs.push(line),
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return ok() } }
  await runTts(args)
  assert.equal(bodies[0].model_id, 'eleven_v4')
  assert.equal(bodies[0].language_code, 'zh')
  const local = 'ELEVENLABS_MODEL_ID=eleven_multilingual_v2\n'
  fs.writeFileSync(path.join(root, '.env.local'), local)
  await runTts(args)
  assert.equal(bodies[1].model_id, 'eleven_multilingual_v2')
  assert.equal(Object.hasOwn(bodies[1], 'language_code'), false)
  assert(logs.some(line => line.includes('该模型不支持指定中文，建议改为 eleven_v4')))
  assert.equal(fs.readFileSync(path.join(root, '.env.local'), 'utf8'), local)
  await runTts({ ...args, env: { ...ENV, ELEVENLABS_MODEL_ID: 'eleven_v4', ELEVENLABS_LANGUAGE_CODE: '' } })
  assert.equal(Object.hasOwn(bodies[2], 'language_code'), false)
})

test('characters use first lesson word before family, share the same context, and preserve display and ID', t => {
  const root = fixture(t), raw = collectAudioEntries(patches())
  const entries = prepareEntries(raw, {}, settings(root))
  const yang = entries.filter(entry => entry.isCharacter && entry.text === '扬')
  assert.equal(yang.length, 2)
  assert(yang.every(entry => entry.readingText === '扬，飘扬的扬'))
  assert(yang.every(entry => entry.contextWord === '飘扬'))
  assert.equal(yang[0].id, 'lesson/read/characters/yang')
  assert.equal(yang[0].target.char, '扬')
  assert.equal(entries.find(entry => entry.text === '绒').readingText, '绒，绒毛的绒')
  assert.equal(entries.find(entry => entry.id === 'lesson/read/words/w1').readingText, '飘扬')
})

test('family words beat sentence context; sentence segmentation supplies two-character words and missing ones are marked', t => {
  const root = fixture(t)
  const input = { lesson: { basicStages: [
    stage('read', 'char-learn', { characters: [
      { id: 'yang', char: '扬', family: [{ id: 'fy', word: '飞扬' }] },
      { id: 'qiang', char: '墙' }, { id: 'empty', char: '龘' },
    ] }),
    stage('text', 'read-aloud', { sentences: [{ id: 's', text: '红旗飘扬，墙壁洁白。' }] }),
  ] } }
  const entries = prepareEntries(collectAudioEntries(input), {}, settings(root))
  assert.equal(entries.find(entry => entry.text === '扬').readingText, '扬，飞扬的扬')
  assert.equal(entries.find(entry => entry.text === '墙').readingText, '墙，墙壁的墙')
  const missing = entries.find(entry => entry.text === '龘')
  assert.equal(missing.readingText, '龘')
  assert.equal(missing.missingWord, true)
})

test('overrides accept strings, explicit text, and context words with ID priority over text lookup', t => {
  const root = fixture(t), raw = collectAudioEntries(patches()), config = settings(root)
  const id = 'lesson/read/characters/yang'
  const prepare = override => prepareEntries(raw, override, config).find(entry => entry.id === id)
  assert.equal(prepare({ texts: { 扬: '扬，悠扬的扬' } }).readingText, '扬，悠扬的扬')
  assert.equal(prepare({ texts: { 扬: { text: '请读扬' } } }).readingText, '请读扬')
  assert.equal(prepare({ texts: { 扬: { word: '悠扬' } } }).readingText, '扬，悠扬的扬')
  assert.equal(prepare({ entries: { [id]: { word: '表扬' } }, texts: { 扬: { text: '被覆盖的内容' } } }).readingText, '扬，表扬的扬')
  assert.equal(prepare({ entries: { [id]: { text: '直接朗读', word: '表扬' } } }).readingText, '直接朗读')
  fs.writeFileSync(path.join(root, 'scripts/learning-export/tts-overrides.json'), JSON.stringify({ texts: { 扬: { word: '悠扬' } } }))
  assert.equal(readOverrides(root).texts.扬.word, '悠扬')
})

test('cache keys change when model or language changes, including omitted language', t => {
  const root = fixture(t), raw = collectAudioEntries(patches())
  const key = env => prepareEntries(raw, {}, settings(root, env))[0].cacheKey
  const original = key({})
  for (const alternate of [{ ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2' },
    { ELEVENLABS_LANGUAGE_CODE: 'ja' }, { ELEVENLABS_LANGUAGE_CODE: '' }]) assert.notEqual(key(alternate), original)
  assert.equal(key({}), original)
})

test('sample selection is stable with three unique characters, three words and two sentences, excluding whole/pairs/skipped', t => {
  const root = fixture(t), entries = prepareEntries(collectAudioEntries(patches()), {}, settings(root))
  const selected = selectSample(entries)
  assert.equal(selected.length, 8)
  assert.equal(new Set(selected.map(entry => entry.readingText)).size, 8)
  assert.deepEqual(selected.map(entry => entry.kind), ['character', 'character', 'character', 'word', 'word', 'word', 'sentence', 'sentence'])
  assert.deepEqual(selectSample(entries).map(entry => entry.id), selected.map(entry => entry.id))
  const skip = entries.find(entry => entry.id === 'lesson/read/words/w1')
  const selectedAfterSkip = selectSample(entries.map(entry => entry === skip ? { ...entry, skipped: true } : entry))
  assert(!selectedAfterSkip.some(entry => entry.id === skip.id))
  assert.throws(() => selectSample(entries.filter(entry => entry.kind !== 'sentence')), /样本|句子|不足/u)
})

test('sample requires --only, rejects --limit, and CLI retains the sample option', async t => {
  const root = fixture(t), args = { root, patches: patches(), env: {}, dryRun: true, sample: true, log: quiet }
  await assert.rejects(runTts(args), /only/u)
  await assert.rejects(runTts({ ...args, only: 'lesson', limit: 8 }), /limit/u)
  assert.equal(cliOptions(['--sample', '--only', 'lesson'], {}).sample, true)
  assert.throws(() => cliOptions(['--sample'], {}), /only/u)
  assert.throws(() => cliOptions(['--sample', '--only', 'lesson', '--limit', '8'], {}), /limit/u)
})

test('dry-run sample reports model/language, reading text, missing words and eight planned absolute MP3 paths without fetching', async t => {
  const root = fixture(t), logs = [], input = patches()
  input.lesson.basicStages[0].props.characters.push({ id: 'missing', char: '龘' })
  const { plan } = await runTts({ root, patches: input, only: 'lesson', sample: true, env: {}, dryRun: true,
    log: line => logs.push(line), fetchImpl: () => assert.fail('dry-run must not fetch') })
  assert.equal(plan.modelId, 'eleven_v4')
  assert.equal(plan.languageCode, 'zh')
  assert.equal(plan.languageCodeEffective, true)
  assert.equal(plan.totalEntries, 8)
  assert(logs.join('\n').includes('扬，飘扬的扬'))
  const filename = path.join(root, '.local/tts-cache/sample.txt')
  const report = fs.readFileSync(filename, 'utf8')
  for (const entry of plan.entries) {
    assert(report.includes(entry.id))
    assert(report.includes(entry.readingText))
    assert(report.includes(path.join(root, '.local/tts-cache', `${entry.cacheKey}.mp3`)))
  }
  assert.match(report, /planned/u)
  const full = await runTts({ root, patches: input, only: 'lesson', env: {}, dryRun: true, log: quiet })
  assert(full.plan.missingWords.some(entry => entry.text === '龘'))
})

test('sample report records success, cache hits and failed generation paths', async t => {
  const root = fixture(t), args = { root, patches: patches(), only: 'lesson', sample: true, env: ENV, log: quiet,
    maxRetries: 0, fetchImpl: async () => ok() }
  const first = await runTts(args)
  assert.equal(first.success, 8)
  const second = await runTts({ ...args, fetchImpl: () => assert.fail('sample cache must be reused') })
  assert.equal(second.cached, 8)
  const filename = path.join(root, '.local/tts-cache/sample.txt')
  assert.match(fs.readFileSync(filename, 'utf8'), /cached/u)
  const failed = await runTts({ ...args, env: { ...ENV, ELEVENLABS_LANGUAGE_CODE: 'ja' },
    fetchImpl: async () => new Response('', { status: 401 }) })
  assert.equal(failed.failed, 8)
  assert.match(fs.readFileSync(filename, 'utf8'), /failed/u)
})
