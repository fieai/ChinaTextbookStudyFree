'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { applyMathReviews, loadCatalog, buildCatalog } = require('./catalog.cjs')
const { options } = require('./index.cjs')
const { parseCsv, inputFingerprint } = require('./pages.cjs')
const { inputFile } = require('./common.cjs')

const draft = [{ lessonId: 'lesson', pdfFrom: '88', pdfTo: '91' }]
const review = row => parseCsv(`sourceLessonId,verdict,confirmedFrom,confirmedTo\n${row}\n`)

test('human-review fix overrides both draft page endpoints without changing the draft', () => {
  const math = applyMathReviews(draft, review('lesson,fix,89,92'))
  assert.deepEqual(math[0], { lessonId: 'lesson', pdfFrom: '89', pdfTo: '92' })
  assert.deepEqual(draft[0], { lessonId: 'lesson', pdfFrom: '88', pdfTo: '91' })
})

test('human-review approve uses confirmed pages and blocks disagreement with either draft endpoint', () => {
  assert.deepEqual(applyMathReviews(draft, review('lesson,approve,88,91')), draft)
  for (const row of ['lesson,approve,87,91', 'lesson,approve,88,92'])
    assert.throws(() => applyMathReviews(draft, review(row)), /Approved human-review page range differs from lessons.csv/)
})

test('human-review blocks a lesson absent from lessons.csv', () => {
  assert.throws(() => applyMathReviews(draft, review('unknown,fix,88,91')), /Unknown human-review lesson: unknown/)
})

test('human-review blocks an unknown verdict', () => {
  assert.throws(() => applyMathReviews(draft, review('lesson,reject,88,91')), /Unknown human-review verdict: reject/)
})

test('human-review rejects invalid ranges and duplicate decisions', () => {
  for (const range of [',91', '0,91', '92,91', '88,91.5', 'bad,91'])
    assert.throws(() => applyMathReviews(draft, review(`lesson,fix,${range}`)), /Invalid human-review page range/)
  assert.throws(() => applyMathReviews(draft, review('lesson,approve,88,91\nlesson,fix,89,92')), /Duplicate human-review lesson/)
  assert.deepEqual(applyMathReviews(draft, []), draft)
})

test('real human-review CSV is fingerprinted and restores the approved D9 shared endpoint', () => {
  const config = options([])
  const inputs = []
  const data = loadCatalog({ ...config, addInput: (label, filename) => {
    const file = inputFile(label, filename)
    inputs.push(file)
    return file
  } })
  const label = 'evidence/math-lessons/human-review.csv'
  assert.deepEqual(inputs.find(file => file.label === label),
    inputFile(label, path.join(config.evidenceDir, 'math-lessons/human-review.csv')))
  assert.notEqual(inputFingerprint(inputs), inputFingerprint(inputs.filter(file => file.label !== label)))
  const { books } = buildCatalog({ ...data, patches: {}, questions: [],
    assignment: { ...data.assignment, practiceReferences: [] } })
  const lessons = books.find(book => book.sourceBookId === 'g3down-2026').lessons.map(lesson => lesson.content)
  assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l02').textbookPages, { from: 86, to: 88 })
  assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l03').textbookPages, { from: 88, to: 91 })
})
