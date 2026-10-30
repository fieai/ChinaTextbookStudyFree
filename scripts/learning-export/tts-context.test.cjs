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

test('generated stages consume confirmed candidate readings and preserve display, IDs and cache determinism', t => {
  const root = fixture(t), lessonId = 'chinese-g3up-2026-u1-kp2'
  const input = { [lessonId]: { basicStages: [
    stage(`${lessonId}/recognition`, 'char-learn', { characters: [
      { id: 'music', char: '乐', pinyin: 'yuè' }, { id: 'happy', char: '欢', pinyin: 'huān' },
      { id: 'shine', char: '晃', pinyin: 'huǎng' }, { id: 'elm', char: '枣', pinyin: 'zǎo' },
    ] }),
    stage(`${lessonId}/words`, 'char-learn', { words: [{ id: 'w', text: '欢乐' }] }),
    stage(`${lessonId}/read`, 'read-aloud', { sentences: [{ id: 's', text: '乐曲声中，我们快乐地听着音乐。' }] }),
  ] } }
  const original = structuredClone(input)
  const contextCandidates = { lessons: { [lessonId]: { characters: {
    乐: { pinyin: 'yuè', pinyinSource: 'reviewed', polyphonic: ['lè', 'yuè'], candidates: [
      { word: '音乐', pinyin: ['yīn', 'yuè'], source: 'textbook-body-phrase' }] },
    欢: { pinyin: 'huān', pinyinSource: 'textbook', candidates: [
      { word: '欢乐', pinyin: ['huān', 'lè'], source: 'textbook-word-table' }] },
    晃: { pinyin: 'huǎng', pinyinSource: 'textbook', polyphonic: ['huǎng', 'huàng'], candidates: [
      { word: '晃眼', pinyin: ['huǎng', 'yǎn'], source: 'dictionary-phrase' }] },
    枣: { pinyin: 'zǎo', pinyinSource: 'textbook', candidates: [
      { word: '红枣', pinyin: ['hóng', 'zǎo'], source: 'other-book-word-table' }] },
  } } } }
  const entries = prepareEntries(collectAudioEntries(input, { contextCandidates }), {}, settings(root))
  const music = entries.find(entry => entry.id.endsWith('/characters/music'))
  assert.equal(music.readingText, '乐，音乐的乐')
  assert.equal(music.contextSource, 'textbook-body-phrase')
  assert.equal(music.expectedPinyin, 'yuè')
  assert.deepEqual(music.polyphonic, ['lè', 'yuè'])
  assert.equal(entries.find(entry => entry.id.endsWith('/characters/happy')).readingText, '欢，欢乐的欢')
  assert.equal(entries.find(entry => entry.text === '晃').readingText, '晃，晃眼的晃')
  assert.equal(entries.find(entry => entry.text === '枣').readingText, '枣，红枣的枣')
  assert.deepEqual(input, original)
  const first = Object.fromEntries(entries.map(entry => [entry.id, entry.cacheKey]))
  const second = Object.fromEntries(prepareEntries(collectAudioEntries(structuredClone(input), { contextCandidates }), {}, settings(root)).map(entry => [entry.id, entry.cacheKey]))
  assert.deepEqual(first, second)
})

test('generated unknown readings never borrow another pronunciation, are skipped and remain in the plan report', async t => {
  const root = fixture(t), lessonId = 'chinese-g3down-2026-u1-kp2'
  const input = { [lessonId]: { basicStages: [stage(`${lessonId}/recognition`, 'char-learn', { characters: [
    { id: 'unknown', char: '乐' }, { id: 'unmatched', char: '乐', pinyin: 'lào' }, { id: 'no-context', char: '龘' },
  ], words: [{ id: 'w', text: '快乐' }] })] } }
  const logs = []
  const { plan } = await runTts({ root, patches: input, dryRun: true, env: {}, log: line => logs.push(line),
    fetchImpl: () => assert.fail('dry-run must not fetch') })
  assert.equal(plan.skippedEntries, 3)
  assert.equal(plan.missingWords.length, 3)
  const chars = plan.entries.filter(entry => entry.kind === 'character')
  assert(chars.every(entry => entry.skipped && !entry.contextWord && entry.pronunciationIssue))
  assert.equal(chars[0].readingText, '乐')
  // The unconfirmed display value is not a confirmed lesson pronunciation.
  assert.equal(chars[1].expectedPinyin, undefined)
  assert(logs.some(line => line.includes('共 3 条')))
})

test('explicit text and word overrides resolve generated context pauses, while skip and external blockers remain binding', async t => {
  const root = fixture(t), lessonId = 'chinese-g3up-2026-u1-kp2'
  const input = { [lessonId]: { basicStages: [stage(`${lessonId}/characters`, 'char-learn', {
    characters: [{ id: 'unknown', char: '乐' }],
  })] } }
  const raw = collectAudioEntries(input), id = raw[0].id, config = settings(root)
  assert.equal(prepareEntries(raw, {}, config)[0].skipped, true)
  for (const overrides of [
    { entries: { [id]: { text: '乐，音乐的乐' } } },
    { entries: { [id]: '乐，音乐的乐' } },
    { texts: { 乐: { word: '音乐' } } },
    { texts: { 乐: { text: '乐，音乐的乐' } } },
  ]) {
    const [prepared] = prepareEntries(raw, overrides, config)
    assert.equal(prepared.skipped, false)
    assert.equal(prepared.readingText, '乐，音乐的乐')
    assert.equal(prepared.missingWord, false)
    assert.equal(Object.hasOwn(prepared, 'pronunciationIssue'), false)
    assert.equal(prepared.contextSource, 'reviewed-entry-override')
    const { plan } = await runTts({ root, patches: input, entryOverrides: overrides, env: {}, dryRun: true, log: quiet,
      fetchImpl: () => assert.fail('dry-run must not fetch') })
    assert.equal(plan.skippedEntries, 0)
    assert.equal(plan.missingWords.length, 0)
    assert.equal(plan.entries[0].pronunciationIssue, undefined)
  }
  const blocked = prepareEntries(raw, { entries: { [id]: { text: '乐，音乐的乐', skip: true } } }, config)[0]
  assert.equal(blocked.skipped, true)
  assert.equal(blocked.missingWord, true)
  assert(blocked.pronunciationIssue)
  const external = { ...raw[0], stageKey: 'reading-prep', pronunciationIssue: undefined,
    pronunciation: { blockers: ['unresolved source'] } }
  const { plan } = await runTts({ root, rawEntries: [external], entryOverrides: { entries: { [id]: { word: '音乐' } } },
    env: {}, dryRun: true, log: quiet })
  assert.equal(plan.skippedEntries, 1)
  // New-rule reading lists win over the small legacy listening reminder table.
  assert.deepEqual(prepareEntries([{ ...raw[0], text: '晃', polyphonic: ['huàng', 'huǎng', 'custom-review'] }], {}, config)[0].polyphonic,
    ['huàng', 'huǎng', 'custom-review'])
})

test('studio keys retain original character reading and cache IDs despite pronunciation rules', t => {
  const root = fixture(t), input = { lesson: { basicStages: [stage('basic-1', 'char-learn', {
    characters: [{ id: 'music', char: '乐', pinyin: 'yuè' }], words: [{ id: 'w', text: '快乐' }],
  })] } }
  const before = prepareEntries(collectAudioEntries(input, { pronunciationRules: {} }), {}, settings(root))
  const after = prepareEntries(collectAudioEntries(input), {}, settings(root))
  assert.equal(after[0].readingText, '乐，快乐的乐')
  assert.equal(after[0].id, 'lesson/basic-1/characters/music')
  assert.deepEqual(after.map(({ id, cacheKey }) => ({ id, cacheKey })), before.map(({ id, cacheKey }) => ({ id, cacheKey })))
})

test('generated single readings and reviewed polyphonic contexts appear in reports; overrides still win', async t => {
  const root = fixture(t), lessonId = 'fixture-reading'
  const input = { [lessonId]: { basicStages: [stage(`${lessonId}/characters`, 'char-learn', {
    characters: [{ id: 'fa', char: '罚' }, { id: 'ji', char: '系' }],
  })] } }
  const contextCandidates = { lessons: { [lessonId]: { characters: {
    罚: { pinyin: 'fá', pinyinSource: 'textbook', candidates: [] },
    系: { pinyin: 'jì', pinyinSource: 'reviewed', polyphonic: ['jì', 'xì'], candidates: [
      { word: '系鞋带', pinyin: ['jì', 'xié', 'dài'], source: 'dictionary-phrase' }] },
  } } } }
  const args = { root, patches: input, contextCandidates, env: {}, dryRun: true, log: quiet,
    fetchImpl: () => assert.fail('dry-run must not fetch') }
  const { plan } = await runTts(args)
  assert.equal(plan.skippedEntries, 0)
  assert.equal(plan.missingWords.length, 0)
  assert.equal(plan.singleReadings[0].readingNote, '单读')
  assert.equal(plan.entries[0].readingText, '罚')
  assert.equal(plan.entries[1].readingText, '系，系鞋带的系')
  assert.deepEqual(plan.characterContextSources, { 'single-character': 1, 'dictionary-phrase': 1 })
  const overridden = await runTts({ ...args, entryOverrides: { texts: { 罚: { word: '罚站' }, 系: { word: '系带' } } } })
  assert.deepEqual(overridden.plan.characterContextSources, { 'reviewed-entry-override': 2 })
  assert.equal(overridden.plan.singleReadings.length, 0)
  assert.equal(overridden.plan.entries[0].readingText, '罚，罚站的罚')
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
  const filename = path.join(root, '.local/tts-dry-run/sample.txt')
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

test('textbook cards use stable keys, Chinese readings and lesson words without collecting studio cards', t => {
  const root = fixture(t)
  const cards = [
    { key: 'recognize-yang', kind: 'character', label: '扬', prompt: '读一读这个字。', answer: 'yáng；本课组词：飘扬、扬起' },
    { key: 'poem-first', kind: 'reading', label: '第一句', prompt: '迟日江山丽，春风花草香。', answer: '请读得流畅。' },
    { key: 'pinyin-only', kind: 'reading', label: '拼音', prompt: 'chí rì', answer: 'jiāng shān' },
  ]
  const input = { textbook: { level: 'textbook-only', cards }, studio: { cards, basicStages: [] } }
  const original = structuredClone(input)
  const entries = prepareEntries(collectAudioEntries(input), {}, settings(root))
  assert.equal(entries.length, 5)
  assert.deepEqual(entries.map(entry => entry.id), [
    'textbook/cards/recognize-yang/character', 'textbook/cards/recognize-yang/prompt',
    'textbook/cards/recognize-yang/answer', 'textbook/cards/poem-first/prompt', 'textbook/cards/poem-first/answer',
  ])
  const character = entries[0]
  assert.equal(character.text, '扬')
  assert.equal(character.contextWord, '飘扬')
  assert.equal(character.readingText, '扬，飘扬的扬')
  assert.ok(entries.every(entry => entry.supportsAudio === false && !/\p{Script=Latin}/u.test(entry.readingText)))
  assert.ok(entries.some(entry => entry.text === '迟日江山丽，春风花草香。'))
  assert.deepEqual(input, original)
  const reordered = { textbook: { level: 'textbook-only', cards: [...cards].reverse() } }
  const keys = value => Object.fromEntries(prepareEntries(collectAudioEntries(value), {}, settings(root)).map(entry => [entry.id, entry.cacheKey]))
  assert.deepEqual(keys(reordered), keys(input))
})

test('default dry-run loads textbook cards and keeps studio patches on overlapping lesson IDs', async t => {
  const root = fixture(t), config = { fixture: true }
  const cardModule = require('./cards.cjs'), studioModule = require('./studio.cjs')
  const readingModule = require('./reading-language.cjs')
  t.mock.method(readingModule, 'loadReadingLessonPatches', received => {
    assert.equal(received, config)
    return { generated: { level: 'textbook-only', basicStages: [stage('read', 'read-aloud', {
      sentences: [{ id: 's', text: '新增编号课文。' }],
    })] }, overlap: { basicStages: [stage('wrong', 'read-aloud', {
      sentences: [{ id: 'wrong', text: '样板课不应使用这条。' }],
    })] } }
  })
  const card = { key: 'first-line', kind: 'reading', label: '诗句', prompt: '迟日江山丽。', answer: '春风花草香。' }
  t.mock.method(cardModule, 'loadCardLessons', received => {
    assert.equal(received, config)
    return { patches: { textbook: { level: 'textbook-only', cards: [card] },
      overlap: { level: 'textbook-only', cards: [card] } } }
  })
  t.mock.method(studioModule, 'buildStudioLessons', received => {
    assert.equal(received, config)
    return { patches: { overlap: { basicStages: [stage('text', 'read-aloud', {
      sentences: [{ id: 's', text: '课文保持原样。' }],
    })] } } }
  })
  const { plan } = await runTts({ root, config, env: {}, dryRun: true, log: quiet,
    fetchImpl: () => assert.fail('dry-run must not fetch') })
  assert.deepEqual(plan.entries.map(entry => entry.id), [
    'textbook/cards/first-line/prompt', 'textbook/cards/first-line/answer',
    'overlap/text/sentences/s', 'overlap/text/whole',
    'generated/read/sentences/s', 'generated/read/whole',
  ])
  assert.ok(plan.entries.filter(entry => entry.lessonId === 'textbook').every(entry => entry.supportsAudio === false))
})

test('textbook concept readings do not lose Latin variables or units through pronunciation filtering', () => {
  const entries = collectAudioEntries({ math: { level: 'textbook-only', cards: [
    { key: 'area', kind: 'concept', label: '面积', prompt: '长方形面积怎么算？', answer: '面积等于 a×b。' },
    { key: 'units', kind: 'concept', label: '毫米', prompt: '五毫米等于多少 mm？', answer: '五毫米。' },
  ] } })
  assert.deepEqual(entries.map(({ id, text }) => ({ id, text })), [
    { id: 'math/cards/area/prompt', text: '长方形面积怎么算？' },
    { id: 'math/cards/units/answer', text: '五毫米。' },
  ])
})
