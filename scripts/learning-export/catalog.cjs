'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parseCsv } = require('./pages.cjs')
const { readJson, logicalKey, contentHash, requireCondition: check } = require('./common.cjs')

// Explicit TOC categories, from pdf-toc-chinese-ocr.txt; no title heuristics for essays.
const ACTIVITIES = new Set([
  '我的暑假生活', '猜猜他是谁', '写日记', '名字里的故事', '续写故事', '我来编童话',
  '我们眼中的缤纷世界', '这儿真美', '身边的“小事”', '我有一个想法', '请教', '那次经历真难忘',
  '春游去哪里', '我的植物朋友', '劝告', '看图画，写一写', '我做了一项小实验', '中华传统节日',
  '奇妙的想象', '应该怎样安排座位', '身边那些有特点的人', '国宝大熊猫', '趣味故事会', '这样想象真有趣',
])

function applyMathReviews(math, reviews) {
  const lessons = new Map(math.map(row => [row.lessonId, row]))
  const confirmed = new Map()
  for (const review of reviews) {
    const id = review.sourceLessonId
    const draft = lessons.get(id)
    check(draft, `Unknown human-review lesson: ${id}`)
    check(['fix', 'approve'].includes(review.verdict), `Unknown human-review verdict: ${review.verdict} (${id})`)
    check(!confirmed.has(id), `Duplicate human-review lesson: ${id}`)
    const from = Number(review.confirmedFrom), to = Number(review.confirmedTo)
    check(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from,
      `Invalid human-review page range: ${id}`)
    if (review.verdict === 'approve') check(from === Number(draft.pdfFrom) && to === Number(draft.pdfTo),
      `Approved human-review page range differs from lessons.csv: ${id}`)
    confirmed.set(id, { pdfFrom: review.confirmedFrom, pdfTo: review.confirmedTo })
  }
  return math.map(row => ({ ...row, ...confirmed.get(row.lessonId) }))
}

function loadCatalog({ siteDir, dataDir, evidenceDir, addInput }) {
  const catalogPath = path.join(dataDir, 'course-catalog.json')
  const prototypePath = path.join(siteDir, 'textbook-data.js')
  addInput('evidence-data/course-catalog.json', catalogPath)
  const prototype = addInput('prototype/textbook-data.js', prototypePath)
  const catalog = readJson(catalogPath)
  const expected = catalog.provenance.files.find(file => file.path === 'prototype/textbook-data.js')
  check(expected?.sha256 === prototype.sha256, 'Prototype catalog differs from frozen WP-10 evidence')
  const source = fs.readFileSync(prototypePath, 'utf8')
  const raw = JSON.parse(source.slice(source.indexOf('{')).trim().replace(/;$/, ''))
  check(catalog.books.length === 4 && raw.books.length === 4, 'Expected exactly four revised grade-3 books')
  const readCsv = name => {
    const filename = path.join(evidenceDir, name)
    addInput(`evidence/${name}`, filename)
    return parseCsv(fs.readFileSync(filename, 'utf8'))
  }
  const math = readCsv('math-lessons/lessons.csv')
  const reviews = readCsv('math-lessons/human-review.csv')
  const maps = readCsv('math-lessons/kp-map.csv')
  const candidates = readCsv('page-candidates.csv')
  const sampleRanges = {
    'chinese-g3up-2026-u1-kp1': { from: 8, to: 10 },
    'chinese-g3down-2026-u1-kp1': { from: 8, to: 9 },
  }
  for (const [name, marker] of [
    ['page-notes.md', '明确包含课文及课后要求物理8–10'],
    ['review-chinese.md', 'p9为三首诗共用生字及逐诗景象理解练习'],
  ]) {
    const filename = path.join(evidenceDir, name)
    addInput(`evidence/${name}`, filename)
    check(fs.readFileSync(filename, 'utf8').includes(marker), `Chinese sample page evidence changed: ${name}`)
  }
  check(math.length === 108 && maps.length === 86, 'D9 requires 108 lessons and 86 mathematics knowledge points')
  const assignmentPath = path.join(dataDir, 'math-question-assignment.json')
  addInput('evidence-data/math-question-assignment.json', assignmentPath)
  const assignment = readJson(assignmentPath)
  check(assignment.prototypeSha256 === prototype.sha256, 'Stale assignment prototype SHA256')
  for (const row of math) {
    const snapshot = assignment.lessons.find(lesson => lesson.lessonId === row.lessonId)
    check(snapshot && snapshot.title === row['标题'] && snapshot.lessonKind === row.lessonKind
      && snapshot.pdfFrom === Number(row.pdfFrom) && snapshot.pdfTo === Number(row.pdfTo), `Stale D9 lesson evidence: ${row.lessonId}`)
    const pointIds = maps.filter(point => point.lessonIds.split(';').includes(row.lessonId)).map(point => point.knowledgePointId)
    check(contentHash([...pointIds].sort()) === contentHash(row['知识点 ID'].split(';').filter(Boolean).sort()), `D9 knowledge-point mapping mismatch: ${row.lessonId}`)
  }
  return { catalog, raw, math: applyMathReviews(math, reviews), maps, candidates, assignment, sampleRanges }
}

function buildCatalog({ catalog, raw, math, maps, candidates, questions, assignment, patches, sampleRanges }) {
  const knowledgePoints = maps.map(row => ({ id: row.knowledgePointId, title: row.title, subject: 'math',
    sourceBookId: row.bookId, unitNumber: Number(row.unit) }))
  const books = []
  for (const book of catalog.books) {
    const rawBook = raw.books.find(raw => raw.id === book.sourceBookId)
    check(rawBook && rawBook.pdf.sha256 === book.pdf.sha256, `Frozen book mismatch: ${book.sourceBookId}`)
    const items = book.subject === 'math'
      ? math.filter(row => row.bookId === book.sourceBookId).map(row => ({
        id: row.lessonId, title: row['标题'], kind: row.lessonKind, unit: Number(row.unit),
        from: Number(row.pdfFrom), to: Number(row.pdfTo),
        points: row['知识点 ID'].split(';').filter(Boolean),
      }))
      : book.units.flatMap(unit => unit.lessons.map(lesson => {
        const row = candidates.find(candidate => candidate.sourceLessonId === lesson.sourceLessonId)
        const festival = lesson.sourceLessonId === 'chinese-g3down-2026-u4-kp7'
        const sample = sampleRanges[lesson.sourceLessonId]
        check(sample || (row && (festival || row.status === 'machine-verified')
          && (festival || (row.confirmedFrom && row.confirmedTo))), `Unconfirmed Chinese page range: ${lesson.sourceLessonId}`)
        const point = { id: lesson.sourceLessonId, title: lesson.title, subject: 'chinese', sourceBookId: book.sourceBookId, unitNumber: unit.number }
        knowledgePoints.push(point)
        return { id: lesson.sourceLessonId, title: lesson.title,
          kind: ACTIVITIES.has(lesson.title) || /^(语文园地|快乐读书吧)/u.test(lesson.title) ? 'activity' : 'new',
          unit: unit.number, from: sample?.from ?? (festival ? 60 : Number(row.confirmedFrom)),
          to: sample?.to ?? (festival ? 60 : Number(row.confirmedTo)), points: [point.id] }
      }))
    const lessons = items.map((item, ordinal) => {
      const unit = book.units.find(unit => unit.number === item.unit)
      check(unit, `Missing unit metadata: ${item.id}`)
      const owned = questions.filter(question => question.sourceLessonId === item.id).map(question => question.id)
      const shared = assignment.practiceReferences.filter(ref => ref.lessonId === item.id).map(ref => {
        const question = questions.find(question => question.id === logicalKey('question', ref.locator))
        check(question && question.sourceLessonId === ref.sourceLessonId, `Stale practice reference: ${ref.locator}`)
        return question.id
      })
      const content = {
        schemaVersion: 1, sourceLessonId: item.id, title: item.title, subject: book.subject,
        lessonKind: item.kind, knowledgePointIds: item.points,
        textbookPages: { from: item.from, to: item.to }, bookPageLabel: `PDF 第 ${item.from}–${item.to} 页`,
        level: 'textbook-only', homework: { questionRefs: [...new Set([...owned, ...shared])] }, cards: [],
        ...patches[item.id],
      }
      return { logicalKey: logicalKey('lesson', item.id), unitNumber: item.unit, unitTitle: unit.title,
        ordinal, isSample: content.level === 'studio', content }
    })
    books.push({ sourceBookId: book.sourceBookId, logicalKey: logicalKey('book', book.sourceBookId),
      subject: book.subject, grade: book.grade, semester: book.semester,
      publisher: '人民教育出版社', edition: rawBook.edition, title: book.title, totalPages: book.pdf.pages, lessons })
  }
  return { books, knowledgePoints }
}

module.exports = { ACTIVITIES, applyMathReviews, loadCatalog, buildCatalog }
