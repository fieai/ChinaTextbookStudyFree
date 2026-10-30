'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { options, exportContent, WORKTREE } = require('./index.cjs')
const { buildReadingLessons } = require('./reading-language.cjs')
const { buildStudioLessons } = require('./studio.cjs')
const tts = require('./tts-common.cjs')

test('real annotated package keeps TTS texts and exports the confirmed pinyin with the new Thinky contract', () => {
  const base = path.join(WORKTREE, '.local/learning-export', `.pinyin-regression-${randomUUID()}`)
  try {
    const config = { ...options([]), outputRoot: base }, result = exportContent(config)
    assert.equal(result.report.valid, true, JSON.stringify(result.report.issues))
    const studio = buildStudioLessons(config).patches
    const readingBooks = ['up', 'down'].map(term => require(`../../content/reading-prep/chinese-g3${term}-2026.json`))
    const reading = buildReadingLessons({ books: result.content.books, readingBooks,
      pronunciationRules: require('../../content/reading-prep/pronunciation-rules.json') }).patches
    const before = tts.prepareEntries(tts.collectAudioEntries({ ...studio, ...reading }),
      tts.readOverrides(WORKTREE), tts.loadSettings({ root: WORKTREE }))
    const after = new Map(result.report.audio.entries.map(entry => [entry.id, entry]))
    for (const entry of before) {
      assert.equal(after.get(entry.id)?.readingText, entry.readingText, entry.id)
      assert.equal(after.get(entry.id)?.status === 'skipped', Boolean(entry.skipped), entry.id)
    }
    for (const book of result.content.books.filter(book => book.subject === 'chinese')) for (const { content: lesson } of book.lessons)
      for (const stage of [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])])
        for (const item of [...(stage.props.words || []), ...(stage.props.characters || []).flatMap(item => [item, ...(item.family || [])])]) {
          assert.equal(Object.hasOwn(item, 'pinyin'), Object.hasOwn(item, 'pinyinSource'))
          if (Object.hasOwn(item, 'pinyin')) {
            assert.ok(item.pinyin.trim()); assert.ok(['textbook', 'reviewed', 'dictionary'].includes(item.pinyinSource))
          }
        }
    const exportedWords = result.content.books.filter(book => book.subject === 'chinese').flatMap(book => book.lessons)
      .flatMap(({ content }) => [...(content.basicStages || []), ...(content.extension?.stages || [])])
      .flatMap(stage => [...(stage.props.words || []), ...(stage.props.characters || []).flatMap(item => item.family || [])])
    for (const text of ['公园', '荷花', '清香', '本领', '姿势', '画家', '燕子']) {
      const words = exportedWords.filter(word => (word.text || word.word) === text)
      assert.ok(words.length > 0, `missing regression word: ${text}`)
      for (const word of words) {
        assert.ok(word.pinyin, `false positive still hidden: ${text}`)
        assert.equal(word.pinyinSource, 'dictionary', text)
      }
    }
    for (const [text, pinyin, pinyinSource] of [
      ['热闹', 'rè nao', 'reviewed'], ['了不起', 'liǎo bu qǐ', 'reviewed'],
      ['粗壮', 'cū zhuàng', 'dictionary'], ['散发', 'sàn fā', 'reviewed'], ['活泼', 'huó po', 'reviewed'],
    ]) {
      const words = exportedWords.filter(word => (word.text || word.word) === text)
      assert.ok(words.length > 0, `missing review regression word: ${text}`)
      for (const word of words) {
        assert.equal(word.pinyin, pinyin, text)
        assert.equal(word.pinyinSource, pinyinSource, text)
      }
    }
    const supplemental = require('../reading-prep/supplemental-pinyin-items.json')
    const words = [...new Set(Object.values(studio).flatMap(lesson => [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])])
      .flatMap(stage => (stage.props.characters || []).flatMap(item => (item.family || []).map(word => word.text || word.word))))].sort()
    assert.deepEqual(supplemental.items.map(item => item.text).sort(), words)
    for (const book of result.report.pinyin.books) for (const kind of ['words', 'characters']) {
      const c = book[kind]
      assert.equal(c.total, c.textbook + c.reviewed + c.dictionary + c.pendingHidden)
      assert.ok(c.dictionary > 0); assert.equal(c.pendingHidden, 0)
    }
    const review = require('../../content/reading-prep/pinyin-review.json')
    assert.equal(review.decision.yiBuToneStyle, 'sandhi')
    assert.ok(review.entries.every(entry => entry.decision && entry.decision !== 'hide'))
    assert.equal(result.report.pinyin.reviewSummary.total, 63)
    assert.equal(result.report.pinyin.reviewSummary.confirmed, 63)
    assert.equal(result.report.pinyin.reviewSummary.pending, 0)
    assert.deepEqual(result.report.pinyin.reviewSummary, review.summary)
    assert.match(fs.readFileSync(path.join(result.outputDir, 'report.md'), 'utf8'), /拼音来源与人工核对/u)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
