'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { applyLessonPinyin, pinyinCoverage } = require('./pinyin.cjs')
const source = { lessonNumber: 1,
  words: [{ text: '花朵' }, { text: '热闹' }, { text: '明确', pinyin: 'míng què' }],
  recognitionCharacters: [{ char: '花', pinyin: 'huā' }], writingCharacters: [{ char: '花' }, { char: '行' }] }
const annotation = { words: { 花朵: { pinyin: 'huā duǒ', pinyinSource: 'dictionary' }, 热闹: { reviewId: 'pending' }, 明确: { pinyin: 'wrong', pinyinSource: 'reviewed' } },
  recognitionCharacters: { 花: { pinyin: 'wrong', pinyinSource: 'reviewed' } },
  writingCharacters: { 花: { pinyin: 'huā', pinyinSource: 'textbook' }, 行: { pinyin: 'xíng', pinyinSource: 'reviewed' } } }
const lesson = () => ({ basicStages: [
  { widget: 'char-learn', props: { activity: 'words', mode: 'word-and-pinyin', words: [
    { id: 'w1', text: '花朵', audio: { kind: 'audio', sha256: 'a'.repeat(64) } }, { id: 'w2', text: '热闹', pinyin: 'rè nào' }, { id: 'w3', text: '明确' }] } },
  { widget: 'char-learn', props: { activity: 'characters', characters: [{ id: 'r', char: '花' }] } },
  { widget: 'hanzi-write', props: { characters: [{ id: 'c1', char: '花' }, { id: 'c2', char: '行' }] } },
] })

test('exported pronunciation follows textbook > reviewed > dictionary and unresolved fields are absent', () => {
  const target = lesson(); applyLessonPinyin(target, source, annotation)
  const words = target.basicStages[0].props.words
  assert.deepEqual(words[0], { id: 'w1', text: '花朵', pinyin: 'huā duǒ', pinyinSource: 'dictionary', audio: { kind: 'audio', sha256: 'a'.repeat(64) } })
  assert.ok(!Object.hasOwn(words[1], 'pinyin')); assert.ok(!Object.hasOwn(words[1], 'pinyinSource'))
  assert.equal(words[2].pinyin, 'míng què'); assert.equal(words[2].pinyinSource, 'textbook')
  assert.equal(target.basicStages[1].props.characters[0].pinyin, 'huā')
  assert.equal(target.basicStages[1].props.characters[0].pinyinSource, 'textbook')
  assert.equal(target.basicStages[2].props.characters[1].pinyinSource, 'reviewed')
  assert.equal(target.basicStages[0].props.mode, 'word-only')
  assert.ok(target.basicStages.every(stage => !Object.hasOwn(stage.props, 'sourceNote')))
})

test('pinyin annotation preserves authored notes in basic and extension stages', () => {
  const target = lesson()
  target.basicStages[0].props.sourceNote = '读熟了，再试着写一写。'
  target.basicStages.push({ widget: 'char-learn', props: { activity: 'dictation',
    words: structuredClone(target.basicStages[0].props.words), sourceNote: '听一个，写一个。' } })
  target.extension = { stages: [structuredClone(target.basicStages[0])] }
  for (let pass = 0; pass < 2; pass++) {
    applyLessonPinyin(target, source, annotation)
    assert.equal(target.basicStages[0].props.sourceNote, '读熟了，再试着写一写。')
    assert.equal(target.basicStages.at(-1).props.sourceNote, '听一个，写一个。')
    assert.equal(target.extension.stages[0].props.sourceNote, '读熟了，再试着写一写。')
  }
})

test('coverage counts exported occurrences and distinguishes word tables and dictation', () => {
  const target = lesson(); applyLessonPinyin(target, source, annotation)
  target.basicStages.push({ widget: 'char-learn', props: { activity: 'dictation', words: structuredClone(target.basicStages[0].props.words) } })
  const result = pinyinCoverage([{ sourceBookId: 'book', subject: 'chinese', lessons: [{ content: target }] }])
  assert.deepEqual(result.books[0].words, { total: 6, textbook: 2, reviewed: 0, dictionary: 2, pendingHidden: 2 })
  assert.equal(result.books[0].characters.total, 3)
  assert.equal(result.books[0].wordTables.total, 3)
  assert.equal(result.books[0].dictation.total, 3)
})

test('word and character content without an annotation never gains an empty or guessed pinyin', () => {
  const target = lesson(); applyLessonPinyin(target, source, {})
  assert.ok(!Object.hasOwn(target.basicStages[0].props.words[0], 'pinyin'))
  assert.ok(!Object.hasOwn(target.basicStages[2].props.characters[1], 'pinyin'))
})

test('studio extensions and nested family words follow the same reviewed/hide decisions', () => {
  const target = { extension: { stages: [
    { widget: 'char-learn', props: { activity: 'parts', characters: [{ id: 'e', char: '行', pinyin: 'háng' }] } },
    { widget: 'char-learn', props: { activity: 'family', characters: [{ id: 'f', char: '花', pinyin: 'huà', family: [
      { id: 'fw1', text: '花朵', pinyin: 'old' }, { id: 'fw2', text: '热闹', pinyin: 'old' }, { id: 'fw3', word: '鲜花' },
    ] }] } },
  ] } }
  applyLessonPinyin(target, source, { ...annotation, supplementalWords: { 鲜花: { pinyin: 'xiān huā', pinyinSource: 'dictionary' } } })
  assert.equal(target.extension.stages[0].props.characters[0].pinyinSource, 'reviewed')
  const family = target.extension.stages[1].props.characters[0].family
  assert.equal(family[0].pinyinSource, 'dictionary')
  assert.ok(!Object.hasOwn(family[1], 'pinyin'))
  assert.equal(family[2].pinyin, 'xiān huā')
})

test('annotation loader rejects stale curated sources without editing the real source files', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const { loadPinyinAnnotations } = require('./pinyin.cjs')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pinyin-stale-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.resolve(__dirname, '../../content/reading-prep'), root = path.join(base, 'content/reading-prep')
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(base, 'scripts/reading-prep'), { recursive: true })
  for (const name of fs.readdirSync(real).filter(name => /^chinese-.*\.json$/u.test(name) || ['pinyin-annotations.json', 'pronunciation-rules.json'].includes(name)))
    fs.copyFileSync(path.join(real, name), path.join(root, name))
  fs.copyFileSync(path.join(__dirname, '../reading-prep/supplemental-pinyin-items.json'), path.join(base, 'scripts/reading-prep/supplemental-pinyin-items.json'))
  assert.ok(loadPinyinAnnotations(undefined, root).books)
  fs.appendFileSync(path.join(root, 'chinese-g3up-2026.json'), '\n')
  assert.throws(() => loadPinyinAnnotations(undefined, root), /Stale pinyin annotations: chinese-g3up-2026.json/u)
})
