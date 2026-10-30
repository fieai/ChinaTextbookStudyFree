'use strict'

const path = require('node:path')
const { logicalKey, readJson, inputFile, requireCondition: check } = require('./common.cjs')
const { readingEntries, loadReadingSources } = require('./cards.cjs')
const { readingActivity, characterActivity, wordsActivity, writingActivity, dictationActivity } = require('./studio-language.cjs')
const RULES_PATH = path.resolve(__dirname, '../../content/reading-prep/pronunciation-rules.json')
const KINDS = ['reading', 'characters', 'words', 'writing', 'dictation']
const LABELS = { reading: '读课文', characters: '认读生字', words: '词语', writing: '写字', dictation: '听写' }
const clean = text => typeof text === 'string' && text.trim() ? text.trim() : undefined
const compact = text => text.replace(/\s/gu, '')
const unique = values => [...new Set(values)]
const itemId = (lessonId, kind, sourceId) => logicalKey('reading-item', `${lessonId}/${kind}/${sourceId}`)
// Exclusion only, never a pronunciation dictionary. Do not spread a table's
// single reading onto other occurrences of these potentially ambiguous forms.
const AMBIGUOUS = new Set([...'假晃朝长重行还转少好为难看教觉乐背没着地了得的种都更发落降场便分空当相处参差传藏薄数累校切挑担扇冠供斗量磨蒙舍尽曲间弹露倒圈卷铺正会应血奔调绿似给将称兴钻扎折喝和结挣脏散杆横曾吓咽咳奇泊别模解度恶率埋宿扁系划划粘拗落爪'] )

function tableReadings(items) {
  const map = new Map()
  for (const item of items || []) if (clean(item.pinyin)) {
    if (!map.has(item.char)) map.set(item.char, new Set())
    map.get(item.char).add(item.pinyin.trim())
  }
  return char => map.get(char)?.size === 1 ? [...map.get(char)][0] : undefined
}

// A table reading is not proof for every occurrence of a polyphonic character.
// Only an explicit rule context or source hint may resolve such an occurrence.
function readingSpans(text, source, rules = {}) {
  // Script dialogue contains intentional internal spacing; whitespace-only
  // spans are invalid TextSchema values. Keep the whole line verbatim instead.
  if (/\s/u.test(text)) return [{ text, role: 'text' }]
  const reading = tableReadings(source.recognitionCharacters)
  return [...text].map((char, position, chars) => {
    const offset = chars.slice(0, position).join('').length
    const candidates = []
    for (const hint of source.pronunciationHints || []) {
      if (hint.text !== char || !clean(hint.pinyin) || !hint.context) continue
      let from = text.indexOf(hint.context)
      while (from >= 0) {
        if (offset >= from && offset < from + hint.context.length) candidates.push(hint.pinyin)
        from = text.indexOf(hint.context, from + 1)
      }
    }
    const contexts = rules.polyphonicContexts?.[char]
    for (const [pinyin, words] of Object.entries(contexts || {})) for (const word of words) {
      let from = text.indexOf(word)
      while (from >= 0) {
        if (offset >= from && offset < from + word.length) candidates.push(pinyin)
        from = text.indexOf(word, from + 1)
      }
    }
    const choices = unique(candidates)
    const pinyin = choices.length === 1 ? choices[0] : choices.length === 0 && !contexts && !AMBIGUOUS.has(char) ? reading(char) : undefined
    return { text: char, ...(pinyin ? { pinyin } : {}), role: 'text' }
  })
}

function generateReadingStages({ sourceLessonId, entry, strokeDataByCharacter = {}, pronunciationRules = {} }) {
  const { lesson: source, part, split } = entry
  const detail = { sourceLessonId, sourceLessonNumber: source.lessonNumber, sourceTitle: source.title,
    ...(part ? { partTitle: part.title } : {}), stages: [], missing: [], dataIssues: [],
    missingStrokeCharacters: [], writingWithoutPinyin: [], wordsWithoutPinyin: [], sharedCharacterTables: Boolean(split) }
  const stages = []
  const add = (kind, widget) => {
    stages.push({ key: `${sourceLessonId}/${kind}`, title: LABELS[kind], ...widget })
    detail.stages.push(kind)
  }
  const missing = (kind, reason) => detail.missing.push({ kind, reason })
  if (source.status !== 'reviewed' || source.issues?.length !== 0) {
    detail.dataIssues.push('源稿未 reviewed 或存在未解决 issues；未生成基础关。')
    for (const kind of KINDS) missing(kind, detail.dataIssues[0])
    return { stages, detail }
  }
  const paragraphIds = part ? new Set(part.paragraphIds) : new Set((source.paragraphs || []).map(item => item.id))
  const paragraphs = (source.paragraphs || []).filter(item => paragraphIds.has(item.id))
  const sentences = (source.sentences || []).filter(item => paragraphIds.has(item.paragraphId))
  const validText = paragraphs.length && sentences.length && paragraphs.every(p => clean(p.text)
    && compact(sentences.filter(s => s.paragraphId === p.id).map(s => s.text).join('')) === compact(p.text))
    && unique(sentences.map(s => s.id)).length === sentences.length
    && (!part || paragraphs.length === paragraphIds.size)
  if (validText) {
    const converted = sentences.map(sentence => {
      const text = sentence.text.trim()
      return { id: itemId(sourceLessonId, 'sentence', sentence.id), text,
        paragraphId: itemId(sourceLessonId, 'paragraph', sentence.paragraphId),
        segments: (text.match(/[^，]+，|[^，]+$/gu) || [text]).map(text => ({ text })),
        spans: readingSpans(text, source, pronunciationRules) }
    })
    add('reading', readingActivity({ presentation: 'reading', sentences: converted,
      passes: [
        { id: 'accurate', title: '读准确', goal: '逐句读准字音，遇到不确定的字回看教材。', presentation: { pinyin: true } },
        { id: 'fluent', title: '读通顺', goal: '按段连起来读，注意标点停顿。', presentation: { pinyin: false,
          pauses: converted.flatMap(sentence => sentence.segments.flatMap((segment, index) => segment.text.endsWith('，')
            ? [{ sentenceId: sentence.id, afterSegment: index }] : [])) } },
      ], parentChecks: [], sourceNote: `教材已核正文${part ? `；本篇《${part.title}》` : ''}。注音仅据本课识字表及已核发音规则。` }))
  } else {
    missing('reading', '无完整段落/逐句文本，或分篇归属、分句拼接不一致。')
    if (paragraphs.length || sentences.length) detail.dataIssues.push(detail.missing.at(-1).reason)
  }
  const sharedNote = split ? '；字表为本编号课整组三诗共用，未按单首推断分配' : ''
  const recognition = source.recognitionCharacters || []
  const recognitionReading = tableReadings(recognition)
  const characters = recognition.map(item => ({ id: itemId(sourceLessonId, 'recognition', item.id || item.char), char: item.char,
    ...(recognitionReading(item.char) ? { pinyin: recognitionReading(item.char) } : {}) }))
  if (characters.length) {
    const widget = characterActivity(characters)
    widget.props.sourceNote = `本课识字表${sharedNote}。`
    add('characters', widget)
  } else missing('characters', '教材无本课识字表。')
  const words = (source.words || []).map(word => {
    const pinyin = clean(word.pinyin) || pronunciationRules.neutralToneWords?.[word.text]
    if (!pinyin) detail.wordsWithoutPinyin.push(word.text)
    return { id: itemId(sourceLessonId, 'word', word.id || word.text), text: word.text,
      ...(pinyin ? { pinyin } : {}) }
  })
  const sourceNote = `本课${unique((source.words || []).map(word => word.source || '词语表')).join('、') || '词语表'}；无可靠整词拼音的词不显示拼音。`
  if (words.length) add('words', wordsActivity(words, {
    mode: words.every(word => word.pinyin) ? 'word-and-pinyin' : 'word-only', sourceNote,
    instructions: '听一听，跟着读，再看词语读。' }))
  else missing('words', '教材词语表未列本课。')
  const writing = (source.writingCharacters || []).map(item => {
    const pinyin = clean(item.pinyin) || recognitionReading(item.char)
    if (!pinyin) detail.writingWithoutPinyin.push(item.char)
    if (!strokeDataByCharacter[item.char]) detail.missingStrokeCharacters.push(item.char)
    return { id: itemId(sourceLessonId, 'writing', item.id || item.char), char: item.char,
      ...(pinyin ? { pinyin } : {}), ...(strokeDataByCharacter[item.char] ? { strokeData: strokeDataByCharacter[item.char] } : {}) }
  })
  if (writing.length) add('writing', writingActivity(writing, {
    sourceNote: `本课写字表${sharedNote}；缺笔顺时看字形、在纸上练写。无明确读音不显示拼音。`,
    instructions: '有笔顺的字先看笔顺，再在纸上练写；其余字对照教材字形练写。' }))
  else missing('writing', '教材无本课写字表。')
  if (words.length >= 4) add('dictation', dictationActivity(structuredClone(words), {
    mode: words.every(word => word.pinyin) ? 'pinyin-only' : 'word-only', sourceNote,
    dictation: { count: Math.min(5, words.length), kinds: [
      { id: 'radical', label: '偏旁' }, { id: 'stroke-count', label: '多笔少笔' },
      { id: 'wrong-character', label: '写成别的字' }, { id: 'stroke-position', label: '笔画位置' },
    ] }, instructions: '听一个，在纸上写一个，再打开词语自查。' }))
  else missing('dictation', `本课词语 ${words.length} 个，少于 4 个，不生成听写。`)
  return { stages, detail }
}

function buildReadingLessons({ books, readingBooks, strokeDataByCharacter = {}, pronunciationRules = {} }) {
  const patches = {}, reports = []
  for (const book of books.filter(book => book.subject === 'chinese')) {
    const source = readingBooks.find(source => source.bookId === book.sourceBookId)
    check(source, `Missing reading book: ${book.sourceBookId}`)
    const entries = readingEntries(book, source), lessons = []
    for (const { content: target } of book.lessons) {
      const entry = entries.get(target.sourceLessonId)
      if (!entry) continue
      if (target.level === 'studio') {
        const stages = unique((target.basicStages || []).map(stage => stage.widget === 'read-aloud' ? 'reading'
          : stage.widget === 'hanzi-write' ? 'writing' : stage.props.activity).filter(kind => KINDS.includes(kind)))
        lessons.push({ sourceLessonId: target.sourceLessonId, title: target.title,
          sourceLessonNumber: entry.lesson.lessonNumber, preservedStudio: true,
          stages, missing: KINDS.filter(kind => !stages.includes(kind)).map(kind => ({ kind, reason: '原 studio 无此类基础关，按要求保持原样。' })),
          dataIssues: [], missingStrokeCharacters: [], writingWithoutPinyin: [], wordsWithoutPinyin: [] })
        continue
      }
      const generated = generateReadingStages({ sourceLessonId: target.sourceLessonId, entry, strokeDataByCharacter, pronunciationRules })
      if (generated.stages.length) patches[target.sourceLessonId] = { basicStages: generated.stages }
      lessons.push({ title: target.title, preservedStudio: false, ...generated.detail })
    }
    reports.push({ sourceBookId: book.sourceBookId, numberedSourceLessons: source.lessons.length,
      numberedLessons: entries.size, lessonsWithBasicStages: lessons.filter(lesson => lesson.stages.length).length,
      preservedStudio: lessons.filter(lesson => lesson.preservedStudio).length,
      generatedLessons: lessons.filter(lesson => !lesson.preservedStudio && lesson.stages.length).length,
      stageCounts: Object.fromEntries(KINDS.map(kind => [kind, lessons.filter(lesson => lesson.stages.includes(kind)).length])),
      missingStrokeCharacters: unique(lessons.flatMap(lesson => lesson.missingStrokeCharacters)), lessons })
  }
  return { patches, report: { books: reports } }
}

function loadReadingLessonPatches(config) {
  const { loadCatalog, buildCatalog } = require('./catalog.cjs')
  const { buildStudioLessons } = require('./studio.cjs')
  const { readStrokeDocuments } = require('./strokes.cjs')
  const data = loadCatalog({ ...config, addInput: inputFile })
  const strokes = readStrokeDocuments(config)
  const studio = buildStudioLessons({ ...config, strokeDataByCharacter: strokes.references })
  const catalog = buildCatalog({ ...data, patches: studio.patches, questions: [], assignment: { ...data.assignment, practiceReferences: [] } })
  return buildReadingLessons({ books: catalog.books, readingBooks: loadReadingSources({ raw: data.raw, addInput: inputFile }),
    strokeDataByCharacter: strokes.references, pronunciationRules: readJson(RULES_PATH) }).patches
}

module.exports = { RULES_PATH, KINDS, LABELS, readingSpans, generateReadingStages, buildReadingLessons, loadReadingLessonPatches }
