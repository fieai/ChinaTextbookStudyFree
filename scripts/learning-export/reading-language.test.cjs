'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { generateReadingStages, readingSpans, buildReadingLessons } = require('./reading-language.cjs')
const { options } = require('./index.cjs')
const { loadCatalog, buildCatalog } = require('./catalog.cjs')
const { loadReadingSources } = require('./cards.cjs')
const { buildStudioLessons } = require('./studio.cjs')
const { readStrokeDocuments } = require('./strokes.cjs')
const { inputFile } = require('./common.cjs')
const rules = require('../../content/reading-prep/pronunciation-rules.json')
const lesson = () => ({ lessonNumber: 1, title: '小课文', status: 'reviewed', issues: [],
  paragraphs: [{ id: 'p1', text: '开花，花落。', pdfPages: [1] }],
  sentences: [{ id: 's1', text: '开花，花落。', paragraphId: 'p1' }],
  recognitionCharacters: [{ char: '花', pinyin: 'huā' }, { char: '落', pinyin: 'luò' }],
  writingCharacters: [{ char: '花', pinyin: null }, { char: '开', pinyin: null }],
  words: ['开花', '花落', '花朵', '鲜花'].map(text => ({ text, source: '词语表' })) })
const generate = (source, extra = {}) => generateReadingStages({ sourceLessonId: 'test-lesson', entry: { lesson: source }, ...extra })

test('generates the five validated activity shapes without inventing pinyin, grading or strokes', () => {
  const result = generate(lesson(), { strokeDataByCharacter: { 花: { kind: 'document', sha256: 'a'.repeat(64) } } })
  assert.deepEqual(result.detail.stages, ['reading', 'characters', 'words', 'writing', 'dictation'])
  const [reading, recognition, words, writing, dictation] = result.stages
  assert.equal(reading.widget, 'read-aloud')
  assert.equal(reading.props.sentences[0].spans.map(x => x.text).join(''), '开花，花落。')
  assert.equal(recognition.props.activity, 'characters')
  assert.equal(words.props.mode, 'word-only')
  assert.ok(words.props.words.every(word => !Object.hasOwn(word, 'pinyin')))
  assert.equal(writing.props.characters[0].pinyin, 'huā')
  assert.ok(!Object.hasOwn(writing.props.characters[1], 'pinyin'))
  assert.ok(!Object.hasOwn(writing.props.characters[1], 'strokeData'))
  assert.deepEqual(result.detail.missingStrokeCharacters, ['开'])
  assert.equal(dictation.props.dictation.count, 4)
  assert.ok(!Object.hasOwn(dictation, 'grading'))
  assert.ok(result.stages.every(stage => !Object.hasOwn(stage.props, 'sourceNote')))
})

test('split poems keep only a child-friendly shared character table note', () => {
  const source = lesson()
  const result = generate(source, { entry: { lesson: source, split: true,
    part: { title: '小诗', paragraphIds: ['p1'] } } })
  assert.equal(result.detail.sharedCharacterTables, true)
  for (const stage of result.stages) {
    if (stage.props.activity === 'characters' || stage.widget === 'hanzi-write')
      assert.equal(stage.props.sourceNote, '这几首诗共用这张字表。')
    else assert.ok(!Object.hasOwn(stage.props, 'sourceNote'))
  }
})

test('empty sources never produce empty stages; dictation requires at least four words', () => {
  const empty = { ...lesson(), paragraphs: [], sentences: [], recognitionCharacters: [], writingCharacters: [], words: [] }
  assert.deepEqual(generate(empty).stages, [])
  assert.equal(generate(empty).detail.missing.length, 5)
  const short = lesson(); short.words.pop()
  assert.ok(!generate(short).stages.some(stage => stage.props.activity === 'dictation'))
  assert.deepEqual(generate({ ...lesson(), status: 'draft' }).stages, [])
})

test('stage and item identities survive repeated exports, source insertion and reordering', () => {
  const source = lesson(), first = generate(source).stages
  assert.deepEqual(first, generate(structuredClone(source)).stages)
  const altered = structuredClone(source)
  altered.recognitionCharacters.reverse(); altered.words.reverse(); altered.writingCharacters.reverse()
  altered.words.unshift({ text: '花草', source: '词语表' })
  altered.paragraphs.unshift({ id: 'p0', text: '新句。' })
  altered.sentences.unshift({ id: 's0', text: '新句。', paragraphId: 'p0' })
  const second = generate(altered).stages
  for (const before of first) {
    const after = second.find(stage => stage.key === before.key)
    assert.ok(after)
    for (const field of ['characters', 'words', 'sentences']) for (const item of before.props[field] || [])
      assert.equal(after.props[field].find(candidate => (candidate.char || candidate.text) === (item.char || item.text)).id, item.id)
  }
  assert.notEqual(first[0].props.sentences[0].id, generateReadingStages({ sourceLessonId: 'other-lesson', entry: { lesson: source } }).stages[0].props.sentences[0].id)
})

test('annotation resolves only exact contextual occurrences of polyphonic characters', () => {
  const source = { recognitionCharacters: [{ char: '假', pinyin: 'jià' }, { char: '花', pinyin: 'huā' }] }
  const spans = readingSpans('假日真假花', source, { polyphonicContexts: { 假: { jià: ['假日'], jiǎ: ['真假'] } } })
  assert.equal(spans[0].pinyin, 'jià'); assert.equal(spans[3].pinyin, 'jiǎ'); assert.equal(spans[4].pinyin, 'huā')
  assert.ok(!Object.hasOwn(readingSpans('假', source, rules)[0], 'pinyin'))
  assert.ok(!Object.hasOwn(readingSpans('新', source, rules)[0], 'pinyin'))
  const ambiguous = { recognitionCharacters: [{ char: '花', pinyin: 'huā' }, { char: '花', pinyin: 'huà' }] }
  assert.ok(!Object.hasOwn(readingSpans('花', ambiguous)[0], 'pinyin'))
})

test('whole-word pinyin is sourced explicitly, never assembled from character readings', () => {
  const source = lesson(); source.words[0].pinyin = 'kāi huā'
  source.words[1].text = '朋友'
  const words = generate(source, { pronunciationRules: rules }).stages.find(stage => stage.props.activity === 'words').props.words
  assert.equal(words[0].pinyin, 'kāi huā')
  assert.equal(words[1].pinyin, 'péngyou')
  assert.equal(words[2].pinyin, undefined)
})

test('bad sentence/paragraph joins are reported instead of silently publishing truncated text', () => {
  const source = lesson(); source.sentences[0].text = '花落。'
  const result = generate(source)
  assert.ok(!result.stages.some(stage => stage.widget === 'read-aloud'))
  assert.equal(result.detail.dataIssues.length, 1)
})

test('script dialogue keeps internal spacing without whitespace-only rich spans', () => {
  const text = '慢 裁缝说：“请再等一等。”'
  const spans = readingSpans(text, lesson(), rules)
  assert.equal(spans.map(span => span.text).join(''), text)
  assert.ok(spans.every(span => span.text.trim()))
})

test('real reviewed books cover all 61 split lessons, preserve studio, and leave non-numbered lessons untouched', async () => {
  const config = options([]), data = loadCatalog({ ...config, addInput: inputFile })
  const strokes = readStrokeDocuments(config)
  const studio = buildStudioLessons({ ...config, strokeDataByCharacter: strokes.references })
  const catalog = buildCatalog({ ...data, patches: studio.patches, questions: [], assignment: { ...data.assignment, practiceReferences: [] } })
  const readingBooks = loadReadingSources({ raw: data.raw, addInput: inputFile })
  const result = buildReadingLessons({ books: catalog.books, readingBooks, strokeDataByCharacter: strokes.references, pronunciationRules: rules })
  assert.equal(Object.keys(result.patches).length, 59)
  assert.deepEqual(result.report.books.map(book => [book.numberedSourceLessons, book.numberedLessons, book.lessonsWithBasicStages]), [[26, 30, 30], [27, 31, 31]])
  assert.ok(result.report.books.every(book => book.lessons.every(lesson => !lesson.dataIssues.length)))
  for (const id of Object.keys(studio.patches)) assert.equal(result.patches[id], undefined)
  for (const book of catalog.books) for (const { content } of book.lessons) if (content.lessonKind === 'activity') assert.equal(result.patches[content.sourceLessonId], undefined)
  for (const book of readingBooks) for (const source of book.lessons.filter(source => source.title === '古诗三首')) {
    for (const part of source.parts) {
      const patch = result.patches[part.sourceLessonId]
      if (!patch) continue // frozen 绝句 studio
      const expected = source.sentences.filter(sentence => part.paragraphIds.includes(sentence.paragraphId)).map(sentence => sentence.text.trim())
      assert.deepEqual(patch.basicStages.find(stage => stage.widget === 'read-aloud').props.sentences.map(sentence => sentence.text), expected)
      assert.equal(patch.basicStages.find(stage => stage.props.activity === 'characters').props.sourceNote, '这几首诗共用这张字表。')
      assert.equal(patch.basicStages.find(stage => stage.widget === 'hanzi-write').props.sourceNote, '这几首诗共用这张字表。')
    }
  }
  const { LessonDefinitionSchema } = await import(require('node:path').join(config.thinkyRoot, 'packages/learning-contract/dist/index.js'))
  for (const book of catalog.books) for (const { content } of book.lessons) if (result.patches[content.sourceLessonId])
    LessonDefinitionSchema.parse({ ...content, ...result.patches[content.sourceLessonId] })
})
