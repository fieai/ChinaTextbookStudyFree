'use strict'

const fs = require('node:fs')
const path = require('node:path')
const DEFAULT_RULES = path.resolve(__dirname, '../../content/reading-prep/pronunciation-rules.json')
const digits = '零一二三四五六七八九'
const digitReading = value => [...value].map(char => digits[Number(char)]).join('')
const unique = values => [...new Set(values)]
const normalizedPinyin = value => String(value || '').normalize('NFC').trim().replace(/[\s’']/gu, '').toLowerCase()

function integerReading(raw) {
  const value = String(raw).replace(/^0+(?=\d)/u, '')
  if (value === '0') return '零'
  if (value.length > 16) throw new Error('数字超过已实现的朗读范围')
  const small = text => {
    let result = '', pendingZero = false
    for (let index = 0; index < text.length; index++) {
      const number = Number(text[index]), power = text.length - index - 1
      if (!number) { if (result) pendingZero = true; continue }
      if (pendingZero) result += '零'
      result += digits[number] + ['', '十', '百', '千'][power]
      pendingZero = false
    }
    return result
  }
  const groups = []
  for (let index = value.length; index > 0; index -= 4) groups.unshift(value.slice(Math.max(0, index - 4), index))
  let result = '', pendingZero = false
  for (let index = 0; index < groups.length; index++) {
    const number = Number(groups[index]), power = groups.length - index - 1
    if (!number) { if (result) pendingZero = true; continue }
    if (result && (pendingZero || number < 1000)) result += '零'
    result += small(groups[index]) + ['', '万', '亿', '万亿'][power]
    pendingZero = false
  }
  return result.replace(/^一十/u, '十')
}

function numericReading(raw) {
  if (raw.startsWith('-')) return `负${numericReading(raw.slice(1))}`
  const [integer, fraction] = raw.split('.')
  return integerReading(integer) + (fraction === undefined ? '' : `点${digitReading(fraction)}`)
}

function normalizeNumbers(text, rules = {}) {
  const changes = []
  const replace = (regex, transform, rule) => {
    text = text.replace(regex, (...args) => {
      const replacement = transform(...args)
      if (replacement !== args[0]) changes.push({ source: args[0], readingText: replacement, rule })
      return replacement
    })
  }
  for (const phrase of rules.numericPhrases || []) {
    if (text.includes(phrase.text)) {
      changes.push({ source: phrase.text, readingText: phrase.readingText, rule: phrase.reason })
      text = text.split(phrase.text).join(phrase.readingText)
    }
  }
  replace(/(\d{4})到(\d{4})(?=那几年|年)/gu, (_, first, last) => `${digitReading(first)}到${digitReading(last)}`, 'year-range')
  replace(/\d{4}(?=年)/gu, value => digitReading(value), 'calendar-year')
  replace(/\d{2}(?=后[”」』])/gu, value => digitReading(value), 'birth-decade')
  replace(/(\d+)\/(\d+)/gu, (_, numerator, denominator) => `${integerReading(denominator)}分之${integerReading(numerator)}`, 'fraction')
  replace(/(-?\d+(?:\.\d+)?)[～~](-?\d+(?:\.\d+)?)℃/gu,
    (_, start, end) => `${start.startsWith('-') ? '零下' + numericReading(start.slice(1)) : numericReading(start)}至${end.startsWith('-') ? '零下' + numericReading(end.slice(1)) : numericReading(end)}摄氏度`, 'temperature-range')
  replace(/(-?\d+(?:\.\d+)?)℃/gu,
    (_, number) => `${number.startsWith('-') ? '零下' + numericReading(number.slice(1)) : numericReading(number)}摄氏度`, 'temperature')
  replace(/(\d+(?:\.\d+)?)%/gu, (_, number) => `百分之${numericReading(number)}`, 'percentage')
  replace(/\d+(?:\.\d+)?/gu, value => numericReading(value), 'cardinal-number')
  return { text, changes }
}

function preparePronunciation(inputEntries, books, options = {}) {
  const rules = options.rules || JSON.parse(fs.readFileSync(options.rulesPath || DEFAULT_RULES, 'utf8'))
  if (rules.schemaVersion !== 1) throw new Error('发音规则版本无效')
  const lessons = new Map(), globalReadings = new Map(), globalContexts = new Map()
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  for (const book of books) for (const lesson of book.lessons) {
    const key = lesson.lessonKey || String(lesson.lessonNumber).padStart(2, '0')
    const sourceWords = (lesson.words || []).map(item => item.text).filter(Boolean)
    const sourceText = [lesson.title, ...lesson.paragraphs.map(paragraph => paragraph.text)].join('\n')
    const segmented = [...segmenter.segment(sourceText)].filter(part => part.isWordLike && /^\p{Script=Han}{2,8}$/u.test(part.segment))
      .map(part => part.segment)
    const tableReadings = new Map()
    for (const item of [...lesson.recognitionCharacters, ...lesson.writingCharacters]) if (item.pinyin) {
      if (!tableReadings.has(item.char)) tableReadings.set(item.char, new Set())
      tableReadings.get(item.char).add(normalizedPinyin(item.pinyin))
    }
    lessons.set(`${book.bookId}/lesson-${key}`, { ...lesson, bookId: book.bookId, sourceWords, sourceText, segmented, tableReadings })
    for (const word of unique([...sourceWords, ...segmented])) for (const char of new Set([...word])) {
      if (!globalContexts.has(char)) globalContexts.set(char, [])
      globalContexts.get(char).push({ word, bookId: book.bookId, lessonKey: key,
        source: sourceWords.includes(word) ? 'other-textbook-word-table' : 'other-textbook-body-segmentation' })
    }
    for (const item of [...lesson.recognitionCharacters, ...lesson.writingCharacters]) if (item.pinyin) {
      if (!globalReadings.has(item.char)) globalReadings.set(item.char, new Set())
      globalReadings.get(item.char).add(normalizedPinyin(item.pinyin))
    }
  }
  const overrides = { entries: {}, texts: {} }, records = []
  const entries = inputEntries.map(original => {
    const lessonId = `${original.bookId}/lesson-${original.lessonKey}`
    const lesson = lessons.get(lessonId)
    if (!lesson) throw new Error(`未找到配音条目的课文：${original.id}`)
    const blockers = [], review = [], contextEvidence = []
    const isCharacter = original.kind === 'character'
    const sameLessonReadings = [...(lesson.tableReadings.get(original.text) || [])]
    const sourceReading = normalizedPinyin(original.pinyin) || (sameLessonReadings.length === 1 ? sameLessonReadings[0] : '')
    const relatedHints = (lesson.pronunciationHints || []).filter(hint => isCharacter ? hint.text === original.text
      : hint.context ? original.text.includes(hint.context) : original.text.includes(hint.text))
    let expectedPinyin = sourceReading || (isCharacter && unique(relatedHints.map(hint => normalizedPinyin(hint.pinyin))).length === 1
      ? normalizedPinyin(relatedHints[0].pinyin) : null)
    const { sourceWords, sourceText, segmented } = lesson
    const contexts = rules.polyphonicContexts?.[original.text] || {}
    const knownReadings = unique([...Object.keys(contexts), ...(globalReadings.get(original.text) || [])])
    const isPolyphonic = isCharacter && knownReadings.length > 1
    let contextWord = null, contextSource = null
    if (isCharacter) {
      if (expectedPinyin && rules.invalidSourceReadings?.[original.text]?.includes(expectedPinyin))
        blockers.push({ code: 'source-reading-conflict', message: '教材录入读音存在已登记冲突，须回查原页。' })
      const tagged = Object.entries(contexts).flatMap(([pinyin, words]) => words.map(word => ({ pinyin, word })))
      const inSource = tagged.filter(item => sourceWords.includes(item.word) || sourceText.includes(item.word))
      if (isPolyphonic) {
        let desired = expectedPinyin
        if (!desired) {
          const localReadings = unique(inSource.map(item => normalizedPinyin(item.pinyin)))
          if (localReadings.length === 1) desired = localReadings[0]
          else blockers.push({ code: 'ambiguous-character-reading', message: '多音字无唯一教材读音，当前课文上下文无法唯一选音。', candidates: knownReadings })
        }
        const matching = tagged.filter(item => normalizedPinyin(item.pinyin) === desired)
        const selected = matching.find(item => sourceWords.includes(item.word))
          || matching.find(item => sourceText.includes(item.word)) || matching[0]
        if (selected) {
          expectedPinyin ||= desired
          contextWord = selected.word
          contextSource = sourceWords.includes(selected.word) ? 'textbook-word-table'
            : sourceText.includes(selected.word) ? 'textbook-body-with-rule-reading' : 'editorial-pronunciation-rule'
          contextEvidence.push({ word: selected.word, pinyin: desired, source: contextSource })
        } else if (desired) blockers.push({ code: 'reading-context-unavailable', message: '尚无与教材读音匹配的带词读规则。', expectedPinyin: desired })
        review.push({ code: 'polyphonic-character', message: '按匹配读音的词语带读；期望拼音仍需合成后试听。', expectedPinyin: desired })
      } else {
        contextWord = unique([...sourceWords, ...segmented]).find(word => [...word].length > 1 && word.includes(original.text)) || null
        if (contextWord) contextSource = sourceWords.includes(contextWord) ? 'textbook-word-table' : 'textbook-body-segmentation'
        else {
          const globalContext = globalContexts.get(original.text)?.find(item => [...item.word].length > 1)
          if (globalContext) {
            contextWord = globalContext.word
            contextSource = globalContext.source
            contextEvidence.push(globalContext)
          }
        }
      }
      if (!contextWord && !isPolyphonic && rules.characterContexts?.[original.text]?.word) {
        const cue = rules.characterContexts[original.text]
        contextWord = cue.word
        contextSource = cue.source || 'editorial-pronunciation-context'
        contextEvidence.push({ word: cue.word, source: contextSource })
      }
      if (!contextWord) blockers.push({ code: 'character-without-context', message: '单字缺少可确认的带词读上下文。' })
      if (expectedPinyin) review.push({ code: 'source-reading', expectedPinyin, message: '教材拼音作为期望读音记录，不冒充供应商强制音素。' })
    }
    if (!original.readyForSynthesis || original.reviewStatus !== 'reviewed')
      blockers.push({ code: 'source-text-not-reviewed', message: '原始文字尚未完成来源核对。' })
    if (/\p{Script=Latin}/u.test(original.text)) blockers.push({ code: 'phonics-letters-require-voice', message: '正文含汉语拼音字母，需专门发音方案，不能按英文或普通汉字朗读。' })
    if (relatedHints.length && !isCharacter) {
      review.push(...relatedHints.map(hint => ({ code: 'source-pronunciation-hint', text: hint.text, context: hint.context || null,
        expectedPinyin: hint.pinyin, pdfPage: hint.pdfPage, message: '按教材注音检查古今异读或生僻字。' })))
      if (relatedHints.some(hint => hint.context)) blockers.push({ code: 'special-reading-needs-confirmation', message: '含教材明确标注的古今异读或多音短语，需确认该合成读法后再生成整篇。' })
    }
    if (/古诗|文言|古人谈读书|论语/u.test(lesson.title) || (lesson.parts || []).some(part => part.dynasty))
      review.push({ code: 'poetry-classical', message: '保持原诗行和标点；试听停连、节奏、古今异读。' })
    if (/[\u3400-\u4dbf]/u.test(original.text))
      review.push({ code: 'rare-character', message: '含扩展汉字，须检查模型是否漏读或误读。' })
    let readingText = isCharacter && contextWord ? `${original.text}，${contextWord}的${original.text}` : original.text
    const neutralToneMatches = Object.entries(rules.neutralToneWords || {}).filter(([word]) => readingText.includes(word))
    if (neutralToneMatches.length) review.push({ code: 'neutral-tone-context', message: '词内轻声保留汉字；仅作语音试听提示，不能据此修改所有同字。',
      words: neutralToneMatches.map(([word, pinyin]) => ({ word, expectedPinyin: pinyin })) })
    if (/[一不]/u.test(readingText)) review.push({ code: 'tone-sandhi-context', message: '一、不按后接音节及句法自然变调；原字与本调拼音保持不变。' })
    const normalized = normalizeNumbers(readingText, rules)
    readingText = normalized.text
    if (normalized.changes.length) review.push({ code: 'numeric-normalization', message: '数字仅在朗读副本展开，试听数值和单位。', changes: normalized.changes })
    const explicit = rules.entryOverrides?.[original.id]
    if (explicit) {
      if (explicit.sourceText !== original.text) throw new Error(`发音覆写与来源文字不匹配：${original.id}`)
      if (typeof explicit.readingText === 'string') readingText = explicit.readingText
      if (explicit.contextWord) { contextWord = explicit.contextWord; contextSource = 'reviewed-entry-override' }
      // Resolutions name individual blocker codes; a broad override never silently
      // approves unrelated problems or phonics requirements.
      for (const code of explicit.resolveBlockers || []) {
        if (!explicit.reason?.trim()) throw new Error(`发音覆写缺少核对依据：${original.id}`)
        for (let index = blockers.length - 1; index >= 0; index--) if (blockers[index].code === code) blockers.splice(index, 1)
      }
      if (explicit.skip) blockers.push({ code: 'editorial-skip', message: explicit.reason || '编辑规则暂停。' })
      review.push({ code: 'entry-override', message: explicit.reason, source: explicit.source || null })
    }
    const skipped = blockers.length > 0
    const needsTextOverride = normalized.changes.length > 0 || typeof explicit?.readingText === 'string'
    if (needsTextOverride || skipped) overrides.entries[original.id] = {
      ...(needsTextOverride ? { text: readingText } : {}), ...(skipped ? { skip: true } : {}),
    }
    const pronunciation = { expectedPinyin, contextWord, contextSource, contextEvidence, blockers, review,
      status: skipped ? 'blocked' : 'prepared-unlistened', listeningVerified: false }
    const entry = { ...original, lessonId, stageKey: 'reading-prep', supportsAudio: false, isCharacter,
      contextWord, skipped, pronunciation }
    records.push({ id: original.id, lessonId, bookId: original.bookId, lessonTitle: original.lessonTitle,
      kind: original.kind, text: original.text, readingText, ...pronunciation })
    return entry
  })
  return { entries, overrides, report: { schemaVersion: 1, providerCalled: false, listeningVerified: false,
    policies: rules.policies, totalEntries: entries.length, blockedEntries: entries.filter(entry => entry.skipped).length,
    preparedEntries: entries.filter(entry => !entry.skipped).length, reviewEntries: records.filter(record => record.review.length).length,
    blockerCounts: countCodes(records.flatMap(record => record.blockers)),
    reviewCounts: countCodes(records.flatMap(record => record.review)), entries: records } }
}

function countCodes(issues) {
  const counts = {}
  for (const issue of issues) counts[issue.code] = (counts[issue.code] || 0) + 1
  return counts
}

module.exports = { preparePronunciation, normalizeNumbers, integerReading, numericReading, normalizedPinyin }
