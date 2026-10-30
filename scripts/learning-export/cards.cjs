'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { readJson, logicalKey, contentHash, requireCondition: check } = require('./common.cjs')

const READING_ROOT = path.resolve(__dirname, '../../content/reading-prep')
const KNOWLEDGE_FIELDS = {
  coreConcept: '核心概念是什么？', keyFormula: '要记住什么结论或关系？', tips: '学习时要注意什么？',
}

// These are reviewed editorial sources, not OCR output or a pronunciation dictionary.
function loadReadingSources({ raw, addInput, readingRoot = READING_ROOT }) {
  return raw.books.filter(book => book.subject === 'chinese').map(book => {
    const filename = path.join(readingRoot, `${book.id}.json`)
    check(fs.existsSync(filename), `Missing reviewed reading source: ${filename}`)
    addInput(`reading-prep/${book.id}.json`, filename)
    const source = readJson(filename)
    check(source.schemaVersion === 1 && source.bookId === book.id && Array.isArray(source.lessons), `Invalid reading source: ${book.id}`)
    check(source.source?.sha256 === book.pdf.sha256 && source.source.pageCount === book.pdf.pages,
      `Reading source PDF differs from frozen textbook: ${book.id}`)
    return source
  })
}

function readingEntries(book, source) {
  const catalog = book.lessons.map(item => item.content)
  const entries = new Map()
  for (const lesson of source.lessons) {
    const ids = lesson.sourceLessonIds ?? [lesson.sourceLessonId]
    check(ids.length > 0 && ids.every(id => text(id)) && new Set(ids).size === ids.length,
      `Unknown or repeated reading lesson ID: ${source.bookId}/${lesson.lessonNumber}`)
    // Some volumes list the anthology's first ID only and put the remaining
    // IDs on parts. Include those explicit IDs without inferring catalog order.
    const allIds = new Set([...ids, ...(lesson.parts ?? []).map(part => part.sourceLessonId).filter(Boolean)])
    const matching = catalog.filter(item => allIds.has(item.sourceLessonId))
    check(matching.length === allIds.size, `Unknown or repeated reading lesson ID: ${source.bookId}/${lesson.lessonNumber}`)
    // A split poem uses an explicit part ID or an exact title match within the
    // source's own ID list. Never assign a whole anthology to each sub-poem.
    for (const target of matching) {
      check(!entries.has(target.sourceLessonId), `Duplicate reading source: ${target.sourceLessonId}`)
      const parts = (lesson.parts ?? []).filter(part => part.sourceLessonId
        ? part.sourceLessonId === target.sourceLessonId
        : target.title === `古诗三首：${part.title}`)
      check(parts.length <= 1, `Ambiguous reading part: ${target.sourceLessonId}`)
      const part = parts[0]
      const split = matching.length > 1 || target.title.startsWith('古诗三首：')
      if (split) {
        check(part && target.title === `古诗三首：${part.title}`, `Missing or mismatched reading part: ${target.sourceLessonId}`)
        const paragraphIds = new Set((lesson.paragraphs ?? []).map(paragraph => paragraph.id))
        check(part.paragraphIds?.length > 0 && new Set(part.paragraphIds).size === part.paragraphIds.length
          && part.paragraphIds.every(id => paragraphIds.has(id)), `Invalid reading part paragraphs: ${target.sourceLessonId}`)
        check(!(lesson.parts ?? []).some(other => other !== part
          && (other.paragraphIds ?? []).some(id => part.paragraphIds.includes(id))),
        `Overlapping reading part paragraphs: ${target.sourceLessonId}`)
      }
      if (matching.length === 1 && !target.title.startsWith('古诗三首：'))
        check(target.title === lesson.title, `Reading lesson title mismatch: ${target.sourceLessonId}`)
      entries.set(target.sourceLessonId, { lesson, part, split })
    }
  }
  return entries
}

function reviewed(lesson) { return lesson?.status === 'reviewed' && lesson.issues?.length === 0 }
function text(value) { return typeof value === 'string' && value.trim().length > 0 }

function buildTextbookCards({ books, raw, readingBooks, questions = [], questionProvenance = [] }) {
  const patches = {}, provenance = [], lessons = [], sourceCoverage = []
  const originals = new Map(questionProvenance.map(item => [item.id, item]))
  for (const book of books) {
    const rawBook = raw.books.find(item => item.id === book.sourceBookId)
    const points = new Map(rawBook.units.flatMap(unit => unit.lessons).map(item => [item.id, item]))
    const readingBook = readingBooks.find(item => item.bookId === book.sourceBookId)
    const readings = readingBook ? readingEntries(book, readingBook) : new Map()
    const coverage = { sourceBookId: book.sourceBookId, totalLessons: book.lessons.length,
      knowledge: 0, recognitionCharacters: 0, writingCharacters: 0, words: 0, reviewedReading: 0,
      poemText: 0, questions: 0, shortAnswerQuestions: 0,
      // A heading or a knowledge label is not a transcribed textbook exercise/summary.
      textbookExercises: 0, dailyAccumulation: 0 }
    for (const { content: lesson } of book.lessons) {
      const candidates = [], reasons = [], available = new Set(), seen = new Set()
      const add = (identity, card, source) => {
        const dedup = `${card.kind}/${card.prompt}/${card.answer}`
        if (seen.has(dedup)) return
        seen.add(dedup)
        candidates.push({ card: { key: logicalKey('card', `${lesson.sourceLessonId}/${identity}`), ...card }, source })
      }
      const owned = new Set(lesson.homework.questionRefs)
      const localQuestions = questions.filter(q => owned.has(q.id) && q.sourceBookId === book.sourceBookId)
      if (localQuestions.length) coverage.questions++
      const shortQuestions = localQuestions.filter(q => {
        const original = originals.get(q.id)?.original
        return original && ['choice', 'fill_blank', 'calculation'].includes(original.type)
          && text(original.answer) && [...original.answer].length <= 24
          && ['choice', 'text', 'numeric', 'measurement', 'calculation'].includes(q.payload.question.kind)
          && !q.payload.question.visual && !/如图|看图|下图|图中|图形|下列|下面|选项|选择|[①②③④]|[_＿]{2,}/u.test(original.question)
          && (original.type !== 'choice' || original.options.filter(value => value === original.answer).length === 1)
          && originals.get(q.id).resolvedMetadata?.ruleId !== 'A-PERIMETER-DM@1'
      })
      if (shortQuestions.length) coverage.shortAnswerQuestions++
      const knowledge = lesson.knowledgePointIds.map(id => points.get(id)).filter(point => point?.knowledgeStatus === 'available')
      if (knowledge.some(point => Object.keys(KNOWLEDGE_FIELDS).some(field => text(point.knowledge?.[field])))) coverage.knowledge++
      if (book.subject === 'math') {
        // Field names supply question framing only; every answer is copied verbatim.
        for (const [field, prompt] of Object.entries(KNOWLEDGE_FIELDS)) for (const point of knowledge) {
          const answer = point.knowledge?.[field]
          if (text(answer)) add(`knowledge/${point.id}/${field}`, { kind: 'concept', label: point.title,
            prompt: `“${point.title}”${prompt}`, answer }, {
            type: 'knowledge', path: 'prototype/textbook-data.js', sourceId: point.id, field,
            notice: point.knowledgeSourceNote,
          })
        }
        for (const q of shortQuestions) {
          if (candidates.length >= 3) break
          const record = originals.get(q.id), original = record.original
          // Source ID (content hash if absent), never the question array position.
          const identity = `${record.locator.split('#')[0]}/${record.locator.split('/questions/')[0].split('#/')[1]}/${original.id ?? contentHash({ prompt: original.question, answer: original.answer })}`
          add(`question/${identity}`, { kind: 'concept', label: original.knowledge_point,
            prompt: original.question, answer: original.answer }, {
            type: 'question-bank', locator: record.locator, sourceQuestionId: original.id,
            notice: '本项目配套题库，非教材原题。',
          })
        }
      } else {
        const entry = readings.get(lesson.sourceLessonId), source = entry?.lesson
        const isReviewed = reviewed(source)
        if (source?.recognitionCharacters?.length) coverage.recognitionCharacters++
        if (source?.writingCharacters?.length) coverage.writingCharacters++
        const rawPoint = points.get(lesson.sourceLessonId)
        if (source?.words?.length || rawPoint?.words?.length) coverage.words++
        if (isReviewed) coverage.reviewedReading++
        if (entry?.part && isReviewed && lesson.title.startsWith('古诗三首：')) coverage.poemText++
        if (!source) reasons.push('没有与本课对应的已核识写字表、词语读音或古诗正文；目录讲解不代替这些教材数据。')
        else if (!isReviewed) reasons.push('语文源稿尚未核定（needs-review 或仍有 issues），未采用正文及字词。')
        else {
          const sourcePath = `reading-prep/${book.sourceBookId}.json`
          const sourceBase = { path: sourcePath, lessonNumber: source.lessonNumber, pdfSha256: readingBook.source.sha256 }
          const words = (source.words ?? []).filter(word => text(word.text) && Number.isInteger(word.pdfPage))
          const readingMap = new Map()
          for (const character of source.recognitionCharacters ?? []) {
            if (!text(character.pinyin)) continue
            const values = readingMap.get(character.char) ?? new Set()
            values.add(character.pinyin); readingMap.set(character.char, values)
          }
          const characters = [...(source.writingCharacters ?? []), ...(source.recognitionCharacters ?? [])]
          for (const character of characters) {
            // Group-level character tables are not proof of a sub-poem's vocabulary.
            if (entry.split) continue
            const pronunciations = readingMap.get(character.char)
            const vocabulary = words.filter(word => [...word.text].length > 1 && word.text.includes(character.char))
            if (pronunciations?.size !== 1 || !vocabulary.length) continue
            add(`character/${source.lessonNumber}/${character.char}`, { kind: 'character', label: character.char,
              prompt: `读一读：${character.char}`, answer: `${[...pronunciations][0]}；本课组词：${vocabulary.map(word => word.text).join('、')}` },
            { ...sourceBase, type: 'character', char: character.char, pdfPage: character.pdfPage,
              pinyinSource: 'recognitionCharacters', words: vocabulary })
          }
          // A bare word list has no answer for a pronunciation/meaning question.
          // Character readings cannot establish whole-word tones (e.g. 答应).
          if (!entry.split) for (const word of words) {
            if (!text(word.pinyin)) continue
            add(`word/${source.lessonNumber}/${word.text}`, { kind: 'reading', label: word.text,
              prompt: `读一读本课词语：${word.text}`, answer: word.pinyin },
            { ...sourceBase, type: 'word', text: word.text, pdfPage: word.pdfPage, pinyinSource: 'words.pinyin' })
          }
          if (entry.part && lesson.title.startsWith('古诗三首：')) {
            const ids = new Set(entry.part.paragraphIds)
            const lines = (source.sentences ?? []).filter(sentence => ids.has(sentence.paragraphId)).map(sentence => sentence.text.trim())
            if (lines.length >= 2 && lines.every(line => /^[\p{Script=Han}]{5,7}[，。！？]$/u.test(line))) {
              for (let index = 0; index < lines.length - 1; index++) add(`poem/${entry.part.title}/${lines[index]}`,
                { kind: 'reading', label: entry.part.title, prompt: `接下一句：${lines[index]}`, answer: lines[index + 1] },
                { ...sourceBase, type: 'poem', partTitle: entry.part.title, paragraphIds: entry.part.paragraphIds,
                  upper: lines[index], lower: lines[index + 1] })
            } else reasons.push('古诗分篇或诗行格式不足以可靠生成上下句。')
          }
          if (!candidates.length) reasons.push('缺少同课明确拼音与词语表组词的交集；不跨课补音、不猜组词。')
        }
      }
      for (const candidate of candidates) available.add(candidate.source.type)
      const selected = candidates.length >= 3 ? candidates.slice(0, 8) : []
      if (candidates.length > 0 && candidates.length < 3) reasons.push(`仅 ${candidates.length} 张可靠候选，未达到每课至少 3 张，整课保留空卡片。`)
      if (!selected.length && !reasons.length) reasons.push('没有足够的可靠知识点或唯一简短答案题。')
      if (lesson.level !== 'studio') patches[lesson.sourceLessonId] = { subject: lesson.subject, level: lesson.level, cards: selected.map(item => item.card) }
      if (lesson.level !== 'studio') for (const item of selected) provenance.push({ sourceLessonId: lesson.sourceLessonId, cardKey: item.card.key, ...item.source })
      lessons.push({ sourceBookId: book.sourceBookId, sourceLessonId: lesson.sourceLessonId, title: lesson.title,
        studio: lesson.level === 'studio', candidateCount: candidates.length,
        cardCount: lesson.level === 'studio' ? lesson.cards.length : selected.length,
        sources: [...available], reasons: lesson.level === 'studio' || selected.length ? [] : reasons })
    }
    sourceCoverage.push(coverage)
  }
  const keys = provenance.map(item => item.cardKey)
  check(new Set(keys).size === keys.length, 'Duplicate generated card key')
  return { patches, report: { sourceCoverage, lessons, provenance } }
}

// TTS reads the same source decisions without materializing media or an export package.
function loadCardLessons(config) {
  const { loadCatalog, buildCatalog } = require('./catalog.cjs')
  const { loadSourceQuestions, buildQuestions } = require('./questions.cjs')
  const { loadAuthority } = require('./authority.cjs')
  const { inputFile } = require('./common.cjs')
  const { SOURCE_LESSON_IDS } = require('./studio.cjs')
  const data = loadCatalog({ ...config, addInput: inputFile })
  const base = buildCatalog({ ...data, patches: {}, questions: [], assignment: { ...data.assignment, practiceReferences: [] } })
  const records = loadSourceQuestions({ ...config, catalog: data.catalog, addInput: inputFile })
  const questionResult = buildQuestions({ records, assignment: data.assignment, catalog: data.catalog,
    evidenceDir: config.evidenceDir, contract: loadAuthority(config.thinkyRoot).contract, knowledgePoints: base.knowledgePoints })
  const catalog = buildCatalog({ ...data, patches: {}, questions: questionResult.questions })
  const result = buildTextbookCards({ books: catalog.books, raw: data.raw,
    readingBooks: loadReadingSources({ raw: data.raw, addInput: inputFile }),
    questions: questionResult.questions, questionProvenance: questionResult.provenance })
  for (const id of Object.values(SOURCE_LESSON_IDS)) delete result.patches[id]
  return result
}

module.exports = { loadReadingSources, readingEntries, buildTextbookCards, loadCardLessons }
