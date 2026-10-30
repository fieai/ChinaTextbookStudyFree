'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sha256, inputFile } = require('./common.cjs')
const { selectCharacterContext, loadContextCandidates } = require('./tts-context.cjs')
const candidate = (word, pinyin, source) => ({ word, pinyin: pinyin.split(' '), source })
const choose = (info, character = { char: '落' }) => selectCharacterContext(character, info)

test('context sources follow lesson table, body phrases, same book, other books, dictionary priority', () => {
  const sources = ['textbook-word-table', 'textbook-body-phrase', 'same-book-word-table', 'other-book-word-table', 'dictionary-phrase']
  for (let i = 0; i < sources.length; i++) {
    const candidates = sources.slice(i).reverse().map(source => candidate('落叶', 'luò yè', source))
    const info = { pinyin: 'luò', pinyinSource: 'reviewed', polyphonic: ['luò', 'là', 'lào'], candidates }
    assert.equal(choose(info).contextSource, sources[i])
    assert.equal(choose(info).expectedPinyin, 'luò')
    assert.equal(choose(info).contextWord, '落叶')
  }
})

test('every source validates the target syllable, tone, all repeated occurrences and word length', () => {
  for (const source of ['textbook-word-table', 'textbook-body-phrase', 'same-book-word-table', 'other-book-word-table', 'dictionary-phrase']) {
    const candidates = [candidate('落下', 'là xià', source), candidate('落落', 'luò là', source),
      candidate('落叶', 'luò', source), candidate('落', 'luò', source), candidate('落叶', 'luò yè', source)]
    assert.equal(choose({ pinyin: 'luò', pinyinSource: 'textbook', polyphonic: ['luò', 'là'], candidates }).contextWord, '落叶')
  }
})

test('reviewed polyphonic characters use words for that reading, including dictionary-only contexts', () => {
  for (const [char, pinyin, word, sounds] of [
    ['相', 'xiāng', '相同', 'xiāng tóng'], ['落', 'luò', '落叶', 'luò yè'],
    ['盛', 'chéng', '盛饭', 'chéng fàn'], ['朝', 'zhāo', '朝阳', 'zhāo yáng'],
    ['待', 'dāi', '待着', 'dāi zhe'], ['喝', 'hè', '喝彩', 'hè cǎi'],
    ['系', 'jì', '系鞋带', 'jì xié dài'], ['读', 'dú', '读书', 'dú shū'],
  ]) {
    const result = choose({ pinyin, pinyinSource: 'reviewed', polyphonic: [pinyin, 'other'],
      candidates: [candidate(word, sounds, 'dictionary-phrase')] }, { char })
    assert.equal(result.contextWord, word)
    assert.equal(result.skipped, undefined)
  }
})

test('dictionary-only polyphonic fallback requires textbook or reviewed confirmation', () => {
  const info = { pinyin: 'luò', polyphonic: ['luò', 'là'], candidates: [candidate('落叶', 'luò yè', 'dictionary-phrase')] }
  assert.equal(choose({ ...info, pinyinSource: 'dictionary' }).skipped, true)
  assert.equal(choose({ ...info, pinyinSource: 'textbook' }).contextWord, '落叶')
  assert.equal(choose({ ...info, pinyin: undefined }).skipped, true)
  assert.equal(choose({ ...info, pinyin: 'là', pinyinSource: 'reviewed' }).skipped, true)
})

test('non-polyphonic confirmed character may be read alone and marked 单读; unresolved characters pause', () => {
  const result = choose({ pinyin: 'fá', pinyinSource: 'textbook', candidates: [] }, { char: '罚' })
  assert.equal(result.singleReading, true)
  assert.equal(result.readingNote, '单读')
  assert.equal(result.contextSource, 'single-character')
  assert.equal(result.skipped, undefined)
  assert.equal(choose({ candidates: [] }, { char: '罚' }).skipped, true)
})

test('candidate data supplies reviewed reading before raw display annotation and rejects explicit conflicts', () => {
  const info = { pinyin: 'jì', pinyinSource: 'reviewed', polyphonic: ['jì', 'xì'], candidates: [candidate('系鞋带', 'jì xié dài', 'dictionary-phrase')] }
  assert.equal(choose(info, { char: '系' }).contextWord, '系鞋带')
  assert.equal(choose(info, { char: '系', pinyin: 'xì', pinyinSource: 'textbook' }).skipped, true)
})

test('candidate loader blocks stale source data, annotations, rules and generator/helper versions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-candidates-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const inputs = {}
  for (const name of ['chinese-test.json', 'pinyin-annotations.json', 'pronunciation-rules.json']) {
    fs.writeFileSync(path.join(root, name), '{}\n')
    inputs[name] = sha256('{}\n')
  }
  const data = { schemaVersion: 1, lessons: {}, generator: { inputs,
    scriptSha256: sha256(fs.readFileSync(path.join(__dirname, '../reading-prep/tts_context_candidates.py'))),
    helperSha256: sha256(fs.readFileSync(path.join(__dirname, '../reading-prep/annotate_pinyin.py'))) } }
  const save = value => fs.writeFileSync(path.join(root, 'tts-context-candidates.json'), JSON.stringify(value))
  save(data)
  assert.deepEqual(loadContextCandidates(inputFile, root), data)
  for (const name of Object.keys(inputs)) {
    fs.writeFileSync(path.join(root, name), '{"changed":true}\n')
    assert.throws(() => loadContextCandidates(inputFile, root), /Stale TTS context candidates/u)
    fs.writeFileSync(path.join(root, name), '{}\n')
  }
  for (const key of ['scriptSha256', 'helperSha256']) {
    const changed = structuredClone(data)
    changed.generator[key] = '0'.repeat(64)
    save(changed)
    assert.throws(() => loadContextCandidates(inputFile, root), /Stale TTS context/u)
  }
  const incomplete = structuredClone(data)
  delete incomplete.generator.inputs['chinese-test.json']
  save(incomplete)
  assert.throws(() => loadContextCandidates(inputFile, root), /Incomplete TTS context inputs/u)
})
