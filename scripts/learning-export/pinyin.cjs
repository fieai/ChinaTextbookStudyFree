'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { readJson, inputFile, requireCondition: check } = require('./common.cjs')
const { readingEntries } = require('./cards.cjs')
const ROOT = path.resolve(__dirname, '../../content/reading-prep')
const ANNOTATIONS_PATH = path.join(ROOT, 'pinyin-annotations.json')
const SOURCES = new Set(['textbook', 'reviewed', 'dictionary'])
const clean = text => typeof text === 'string' && text.trim() ? text.trim() : undefined

function loadPinyinAnnotations(addInput = inputFile, root = ROOT) {
  const filename = path.join(root, 'pinyin-annotations.json')
  check(fs.existsSync(filename), 'Missing pinyin annotations; run .local/tools/pinyin-venv/bin/python -I scripts/reading-prep/annotate_pinyin.py')
  addInput('reading-prep/pinyin-annotations.json', filename)
  const annotation = readJson(filename)
  check(annotation.schemaVersion === 1 && annotation.books && annotation.generator?.inputs, 'Invalid pinyin annotations')
  const inputs = annotation.generator.inputs
  const supplemental = '../../scripts/reading-prep/supplemental-pinyin-items.json'
  const expected = fs.readdirSync(root).filter(name => /^chinese-.*\.json$/u.test(name)).concat('pronunciation-rules.json', supplemental).sort()
  check(JSON.stringify(Object.keys(inputs).sort()) === JSON.stringify(expected), 'Incomplete pinyin annotation inputs; rerun annotate_pinyin.py')
  for (const [name, hash] of Object.entries(inputs)) {
    check(path.basename(name) === name || name === supplemental, 'Invalid pinyin input path')
    const file = addInput(name === supplemental ? 'annotator/supplemental-pinyin-items.json' : `reading-prep/${name}`, path.resolve(root, name))
    check(file.sha256 === hash, `Stale pinyin annotations: ${name}; rerun annotate_pinyin.py`)
  }
  addInput('annotator/annotate_pinyin.py', path.resolve(__dirname, '../reading-prep/annotate_pinyin.py'))
  return annotation
}

function pronunciation(source, field, text, annotation) {
  const matching = (source[field] || []).filter(item => (item.text || item.char) === text)
  const explicit = [...new Set(matching.map(item => clean(item.pinyin)).filter(Boolean))]
  if (explicit.length === 1) return { pinyin: explicit[0], pinyinSource: 'textbook' }
  if (explicit.length > 1) return {} // conflicting textbook entries cannot be flattened by character
  const values = matching.map(item => annotation[field]?.[item.id || item.text || item.char]).filter(Boolean)
  const readings = [...new Set(values.map(value => clean(value.pinyin)).filter(Boolean))]
  if (readings.length !== 1 || values.some(value => !clean(value.pinyin))) return {}
  const selected = values.find(value => value.pinyin?.trim() === readings[0])
  check(SOURCES.has(selected.pinyinSource), `Unknown pinyin source: ${selected.pinyinSource}`)
  return { pinyin: readings[0], pinyinSource: selected.pinyinSource }
}

// Called after audio collection/attachment. TTS consumes the same confirmed
// readings through its generated context candidates; this step annotates display.
function applyLessonPinyin(target, source, annotation = {}) {
  for (const stage of [...(target.basicStages || []), ...(target.extension?.stages || [])]) {
    const props = stage.props
    if (!['char-learn', 'hanzi-write'].includes(stage.widget)) continue
    const annotate = (item, field, text) => {
      delete item.pinyin
      delete item.pinyinSource
      Object.assign(item, pronunciation(source, field, text, annotation))
    }
    for (const word of props.words || []) annotate(word, 'words', word.text)
    for (const item of props.characters || []) {
      const field = stage.widget === 'hanzi-write' || props.activity === 'parts' ? 'writingCharacters' : 'recognitionCharacters'
      annotate(item, field, item.char)
      for (const word of item.family || []) {
        delete word.pinyin
        delete word.pinyinSource
        const text = word.text || word.word
        // Both sources use the same word checks; primary vocabulary wins.
        const value = (source.words || []).some(word => word.text === text)
          ? pronunciation(source, 'words', text, annotation) : annotation.supplementalWords?.[text]
        if (clean(value?.pinyin)) {
          check(SOURCES.has(value.pinyinSource), `Unknown pinyin source: ${value.pinyinSource}`)
          Object.assign(word, { pinyin: value.pinyin.trim(), pinyinSource: value.pinyinSource })
        }
      }
    }
    if (['words', 'dictation'].includes(props.activity)) {
      const complete = (props.words || []).every(word => clean(word.pinyin))
      props.mode = complete ? props.activity === 'dictation' ? 'pinyin-only' : 'word-and-pinyin' : 'word-only'
    }
    if (props.words?.length) props.sourceNote = '拼音优先采用教材，其次人工核对，再次词典自动标注；待核对项暂不显示拼音。'
  }
}

const counts = () => ({ total: 0, textbook: 0, reviewed: 0, dictionary: 0, pendingHidden: 0 })
function pinyinCoverage(books) {
  return { scope: '包内基础及扩展关出现次数；词语含听写和字族词重复，字含识字/写字及组诗共享字表重复；不重复计算 authoring 镜像。原稿条目统计见 annotations。', books: books.filter(book => book.subject === 'chinese').map(book => {
    const result = { sourceBookId: book.sourceBookId, words: counts(), characters: counts(), wordTables: counts(), dictation: counts(), familyWords: counts(), recognitionCharacters: counts(), writingCharacters: counts(), extensionCharacters: counts() }
    const add = (kind, item) => {
      result[kind].total++
      if (clean(item.pinyin)) {
        check(SOURCES.has(item.pinyinSource), `Missing pinyinSource: ${item.text || item.char}`)
        result[kind][item.pinyinSource]++
      } else result[kind].pendingHidden++
    }
    for (const { content: lesson } of book.lessons) for (const stage of [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])]) {
      for (const word of stage.props.words || []) {
        add('words', word)
        add(stage.props.activity === 'dictation' ? 'dictation' : 'wordTables', word)
      }
      for (const item of stage.props.characters || []) {
        add('characters', item)
        add(stage.widget === 'hanzi-write' ? 'writingCharacters' : ['family', 'parts'].includes(stage.props.activity) ? 'extensionCharacters' : 'recognitionCharacters', item)
        for (const word of item.family || []) {
          add('words', word)
          add('familyWords', word)
        }
      }
    }
    return result
  }) }
}

function applyPinyinAnnotations(books, readingBooks, annotations) {
  for (const book of books.filter(book => book.subject === 'chinese')) {
    const sourceBook = readingBooks.find(source => source.bookId === book.sourceBookId)
    check(sourceBook, `Missing pinyin source book: ${book.sourceBookId}`)
    const entries = readingEntries(book, sourceBook)
    for (const { content: lesson } of book.lessons) {
      const entry = entries.get(lesson.sourceLessonId)
      if (!entry) continue
      const annotation = annotations.books[book.sourceBookId]?.lessons[String(entry.lesson.lessonNumber)]
      check(annotation, `Missing pinyin lesson: ${book.sourceBookId}/${entry.lesson.lessonNumber}`)
      applyLessonPinyin(lesson, entry.lesson, annotation)
    }
  }
  return { ...pinyinCoverage(books), annotations: annotations.statistics, reviewSummary: annotations.reviewSummary, policies: annotations.policies,
    reviewFile: 'content/reading-prep/pinyin-review.json', reviewMarkdown: 'content/reading-prep/pinyin-review.md' }
}

module.exports = { ANNOTATIONS_PATH, loadPinyinAnnotations, applyLessonPinyin, applyPinyinAnnotations, pinyinCoverage }
