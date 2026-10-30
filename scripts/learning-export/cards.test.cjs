'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTextbookCards, loadReadingSources, readingEntries } = require('./cards.cjs')
const { options } = require('./index.cjs')
const { loadCatalog, buildCatalog } = require('./catalog.cjs')
const { inputFile, contentHash } = require('./common.cjs')
const { buildStudioLessons } = require('./studio.cjs')

function fixture() {
  const lesson = { sourceLessonId: 'lesson', title: '花的学校', subject: 'chinese', level: 'textbook-only',
    knowledgePointIds: ['kp'], homework: { questionRefs: [] }, cards: [] }
  const book = { sourceBookId: 'book', subject: 'chinese', lessons: [{ content: lesson }] }
  const source = { bookId: 'book', source: { sha256: 'a'.repeat(64) }, lessons: [{ sourceLessonId: 'lesson', lessonNumber: 2,
    title: '花的学校', status: 'reviewed', issues: [],
    writingCharacters: [{ char: '轰', pdfPage: 118 }],
    recognitionCharacters: [{ char: '轰', pinyin: 'hōng', pdfPage: 115 }, { char: '湿', pinyin: 'shī', pdfPage: 115 }, { char: '笛', pinyin: 'dí', pdfPage: 115 }],
    words: [{ text: '轰响', pdfPage: 120 }, { text: '湿润', pdfPage: 120 }, { text: '风笛', pdfPage: 120 }] }] }
  return { books: [book], raw: { books: [{ id: 'book', units: [{ lessons: [{ id: 'kp', knowledgeStatus: 'available', title: '知识点',
    knowledge: { coreConcept: '这是源概念。', keyFormula: '这是源结论。', tips: '这是源提示。' } }] }] }] }, readingBooks: [source] }
}

test('reviewed character cards need both explicit lesson pinyin and source vocabulary; writing comes first', () => {
  const data = fixture(), result = buildTextbookCards(data)
  assert.deepEqual(result.patches.lesson.cards.map(c => c.label), ['轰', '湿', '笛'])
  assert.equal(result.patches.lesson.cards[0].answer, 'hōng；本课组词：轰响')
  assert.equal(result.patches.lesson.cards[0].kind, 'character')
  data.readingBooks[0].lessons[0].recognitionCharacters[0].pinyin = null
  const insufficient = buildTextbookCards(data)
  assert.deepEqual(insufficient.patches.lesson.cards, [])
  assert.match(insufficient.report.lessons[0].reasons.join(), /仅 2 张/)
})

test('missing or unreviewed source and ambiguous pinyin never get guessed cards', () => {
  for (const mutate of [data => { data.readingBooks = [] }, data => { data.readingBooks[0].lessons[0].status = 'needs-review' },
    data => { data.readingBooks[0].lessons[0].issues = ['待核'] },
    data => { data.readingBooks[0].lessons[0].recognitionCharacters.push({ char: '轰', pinyin: 'hóng' }) }]) {
    const data = fixture(); mutate(data)
    const result = buildTextbookCards(data)
    assert.deepEqual(result.patches.lesson.cards, [])
    assert.ok(result.report.lessons[0].reasons.length)
  }
})

test('word pronunciation is not composed from character readings (neutral tones need word-level evidence)', () => {
  const data = fixture(), source = data.readingBooks[0].lessons[0]
  source.recognitionCharacters.push({ char: '答', pinyin: 'dā' }, { char: '应', pinyin: 'yìng' })
  source.words.push({ text: '答应', pdfPage: 120 })
  assert.equal(buildTextbookCards(data).patches.lesson.cards.some(card => card.label === '答应'), false)
  source.words.at(-1).pinyin = 'dā ying'
  assert.equal(buildTextbookCards(data).patches.lesson.cards.find(card => card.label === '答应').answer, 'dā ying')
})

test('short-answer fallback retains original answer, rejects image-dependent questions and keys by source ID', () => {
  const data = fixture(), lesson = data.books[0].lessons[0].content
  data.books[0].subject = lesson.subject = 'math'
  data.raw.books[0].units[0].lessons[0].knowledge = {}
  data.questions = ['a', 'b', 'c', 'image'].map(id => ({ id, sourceBookId: 'book', sourceLessonId: 'lesson', payload: { question: { kind: 'choice' } } }))
  lesson.homework.questionRefs = data.questions.map(q => q.id)
  data.questionProvenance = data.questions.map((q, index) => ({ id: q.id, locator: `output/math.json#/unit_test/questions/${index}`,
    original: { id: q.id, type: 'choice', knowledge_point: '源标签', question: q.id === 'image' ? '如图，答案是什么？' : `源题${q.id}？`, answer: `答案${q.id}`, options: [`答案${q.id}`, '其他'] } }))
  const first = buildTextbookCards(data).patches.lesson.cards
  assert.deepEqual(first.map(card => card.answer), ['答案a', '答案b', '答案c'])
  data.questionProvenance.reverse().forEach((p, index) => { p.locator = `output/math.json#/unit_test/questions/${index}` })
  const second = buildTextbookCards(data).patches.lesson.cards
  assert.deepEqual(first, second)
})

test('character identity survives source insertion/reordering and pinyin correction; cap is eight', () => {
  const data = fixture(), first = buildTextbookCards(data).patches.lesson.cards
  data.readingBooks[0].lessons[0].recognitionCharacters.reverse()
  data.readingBooks[0].lessons[0].recognitionCharacters.find(c => c.char === '轰').pinyin = 'hóng'
  const second = buildTextbookCards(data).patches.lesson.cards
  for (const card of first) assert.equal(second.find(c => c.label === card.label).key, card.key)
  data.readingBooks[0].lessons[0].recognitionCharacters.push(...[...'甲乙丙丁戊己庚辛壬'].map(char => ({ char, pinyin: 'source' })))
  data.readingBooks[0].lessons[0].words.push(...[...'甲乙丙丁戊己庚辛壬'].map(char => ({ text: char + '字', pdfPage: 120 })))
  assert.equal(buildTextbookCards(data).patches.lesson.cards.length, 8)
})

test('math answers copy source fields verbatim, IDs do not depend on field position, and studio is untouched', () => {
  const data = fixture(); data.books[0].subject = data.books[0].lessons[0].content.subject = 'math'
  const first = buildTextbookCards(data).patches.lesson.cards
  assert.equal(first.length, 3)
  assert.deepEqual(first.map(c => c.answer), ['这是源概念。', '这是源结论。', '这是源提示。'])
  data.books[0].lessons[0].content.level = 'studio'
  data.books[0].lessons[0].content.cards = [{ key: 'original' }]
  assert.deepEqual(buildTextbookCards(data).patches, {})
  assert.deepEqual(data.books[0].lessons[0].content.cards, [{ key: 'original' }])
})

test('cards preserve a lesson level that already has basic stages', () => {
  const data = fixture()
  const lesson = data.books[0].lessons[0].content
  lesson.basicStages = [{ key: 'existing-stage', title: '读课文' }]
  assert.equal(buildTextbookCards(data).patches.lesson.level, lesson.level)
  assert.deepEqual(lesson.basicStages, [{ key: 'existing-stage', title: '读课文' }])
})

function anthology() {
  const titles = ['甲诗', '乙诗', '丙诗']
  const book = { lessons: titles.map((title, index) => ({ content: { sourceLessonId: `poem-${index}`, title: `古诗三首：${title}` } })) }
  const lesson = { lessonNumber: 1, title: '古诗三首', sourceLessonId: 'poem-0',
    paragraphs: titles.map((_, index) => ({ id: `p-${index}`, text: `第${index}首` })),
    parts: titles.map((title, index) => ({ title, sourceLessonId: `poem-${index}`, paragraphIds: [`p-${index}`] })) }
  return { book, source: { bookId: 'book', lessons: [lesson] }, lesson }
}

test('poems resolve explicit part IDs in either source layout and survive reordered catalogs', () => {
  const { book, source, lesson } = anthology()
  for (const sourceLessonIds of [undefined, ['poem-0', 'poem-1', 'poem-2']]) {
    lesson.sourceLessonIds = sourceLessonIds
    book.lessons.reverse()
    const result = readingEntries(book, source)
    assert.equal(result.size, 3)
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(result.get(`poem-${index}`).part.paragraphIds, [`p-${index}`])
      assert.equal(result.get(`poem-${index}`).split, true)
      assert.equal(result.get(`poem-${index}`).lesson, lesson)
    }
  }
  // Old sources without explicit part IDs can still use exact poem titles.
  lesson.parts.forEach(part => { delete part.sourceLessonId })
  assert.equal(readingEntries(book, source).size, 3)
})

test('poem IDs, titles and paragraph references must agree; missing parts never receive whole anthologies', () => {
  for (const mutate of [
    data => { data.lesson.parts[0].sourceLessonId = 'poem-1' },
    data => { data.lesson.parts[0].title = '错篇' },
    data => { data.lesson.parts[0].paragraphIds = ['absent'] },
    data => { data.lesson.parts[0].paragraphIds = ['p-0', 'p-0'] },
    data => { data.lesson.parts[0].paragraphIds = ['p-1'] },
    data => { data.lesson.parts.shift() },
    data => { data.lesson.sourceLessonIds = ['poem-0', 'poem-0'] },
  ]) {
    const data = anthology(); mutate(data)
    assert.throws(() => readingEntries(data.book, data.source), /reading (part|lesson ID)/)
  }
})

test('real textbook cards include exact poem parts, source fingerprint and no changed studio cards', () => {
  const config = options([]), inputs = []
  const addInput = (label, filename) => { const file = inputFile(label, filename); inputs.push(file); return file }
  const data = loadCatalog({ ...config, addInput })
  const studio = buildStudioLessons(config)
  const catalog = buildCatalog({ ...data, patches: studio.patches, questions: [], assignment: { ...data.assignment, practiceReferences: [] } })
  const readingBooks = loadReadingSources({ raw: data.raw, addInput })
  const result = buildTextbookCards({ ...catalog, raw: data.raw, readingBooks })
  assert.equal(inputs.filter(item => item.label.startsWith('reading-prep/')).length, 2)
  const poem = result.patches['chinese-g3down-2026-u1-kp2'].cards
  assert.equal(poem.length, 3)
  assert.deepEqual([poem[0].prompt, poem[0].answer], ['接下一句：竹外桃花三两枝，', '春江水暖鸭先知。'])
  assert.equal(poem.some(card => /迟日|梅子黄/.test(card.prompt + card.answer)), false)
  const upperPoem = result.patches['chinese-g3up-2026-u2-kp2'].cards
  assert.equal(upperPoem.length, 3)
  assert.equal(upperPoem[0].answer, '白云生处有人家。')
  for (const id of Object.keys(studio.patches)) assert.equal(result.patches[id], undefined)
  // Freeze every pre-existing generated card key, including source ownership.
  // A fresh reading-prep export must retain student card/progress identities.
  for (const [bookId, cardCount, fingerprint] of [
    ['chinese-g3up-2026', 46, 'fa27c69bfbffe04b65f173d2b81c5bb436822b108f3a0676dcce7fd927b7d89c'],
    ['chinese-g3down-2026', 61, '404d97ee5b1533eb231a4936fe4b95328d44e0e8a0a9813c95f4187523ff8369'],
  ]) {
    const identities = Object.entries(result.patches).filter(([id]) => id.startsWith(bookId))
      .flatMap(([sourceLessonId, patch]) => patch.cards.map(card => ({ sourceLessonId, key: card.key })))
      .sort((a, b) => a.key.localeCompare(b.key))
    assert.equal(identities.length, cardCount)
    assert.equal(contentHash(identities), fingerprint)
    const covered = result.report.lessons.filter(item => item.sourceBookId === bookId && item.cardCount)
    assert.equal(covered.length, bookId.includes('g3up') ? 14 : 15)
  }
  for (const patch of Object.values(result.patches)) assert.ok(patch.cards.length === 0 || (patch.cards.length >= 3 && patch.cards.length <= 8))
  assert.equal(new Set(result.report.provenance.map(p => p.cardKey)).size, result.report.provenance.length)
  const modified = structuredClone(data.raw); modified.books.find(book => book.subject === 'chinese').pdf.sha256 = 'b'.repeat(64)
  assert.throws(() => loadReadingSources({ raw: modified, addInput }), /PDF differs/)
})
