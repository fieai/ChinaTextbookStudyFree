'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { preparePronunciation, normalizeNumbers } = require('./pronunciation.cjs')
const { prepareEntries, DEFAULT_SETTINGS } = require('../learning-export/tts-common.cjs')
const rules = require('../../content/reading-prep/pronunciation-rules.json')
const lesson = (changes = {}) => ({ lessonNumber: 1, title: '测试课', recognitionCharacters: [], writingCharacters: [],
  words: [], paragraphs: [{ id: 'p1', text: '音乐使人快乐。' }], ...changes })
function prepare(items, source = lesson(), config = rules) {
  const entries = items.map((item, index) => ({ id: `book/lesson-01/${index}`, bookId: 'book', lessonKey: '01', lessonTitle: source.title,
    readyForSynthesis: true, reviewStatus: 'reviewed', text: '', kind: 'sentence', ...item }))
  return preparePronunciation(entries, [{ bookId: 'book', lessons: [source] }], { rules: config })
}

test('同课乐的两个教材读音分别选择匹配语境，不按第一次命中的词统一读', () => {
  const result = prepare([{ text: '乐', kind: 'character', pinyin: 'yuè' }, { text: '乐', kind: 'character', pinyin: 'lè' }])
  assert.equal(prepareEntries(result.entries, result.overrides, DEFAULT_SETTINGS)[0].readingText, '乐，音乐的乐')
  assert.equal(prepareEntries(result.entries, result.overrides, DEFAULT_SETTINGS)[1].readingText, '乐，快乐的乐')
  assert(result.entries.every(entry => entry.pronunciation.blockers.length === 0))
  assert(result.entries.every(entry => entry.text === '乐' && !entry.pronunciation.listeningVerified))
})
test('没有教材读音且同课两音共存的单字不擅自确定', () => {
  const result = prepare([{ text: '乐', kind: 'character' }])
  assert.equal(result.entries[0].skipped, true)
  assert(result.entries[0].pronunciation.blockers.some(item => item.code === 'ambiguous-character-reading'))
  assert.equal(result.overrides.entries['book/lesson-01/0'].skip, true)
})
test('已给定教材读音但规则没有相应上下文时暂停，不套用其他读音', () => {
  const result = prepare([{ text: '乐', kind: 'character', pinyin: 'lào' }])
  assert(result.entries[0].pronunciation.blockers.some(item => item.code === 'reading-context-unavailable'))
  assert.equal(prepareEntries(result.entries, result.overrides, DEFAULT_SETTINGS)[0].readingText, '乐')
})
test('不为单字凭空编教材词语，缺少语境需暂停', () => {
  const result = prepare([{ text: '龘', kind: 'character' }])
  assert.equal(result.entries[0].skipped, true)
  assert(result.entries[0].pronunciation.blockers.some(item => item.code === 'character-without-context'))
})
test('数字读法区分年份、阵地编号、数量、小数、温度、百分比和分数', () => {
  const source = '1942到1944那几年，391高地，光绪十五年（1889），1987年4月5日，1.8米，14260平方米，-50～150℃，300～400℃，-140℃，1%，95%，1/2和1/4，70后”的人。'
  const normalized = normalizeNumbers(source, rules)
  assert.equal(normalized.text, '一九四二到一九四四那几年，三九一高地，光绪十五年（一八八九），一九八七年四月五日，一点八米，一万四千二百六十平方米，零下五十至一百五十摄氏度，三百至四百摄氏度，零下一百四十摄氏度，百分之一，百分之九十五，二分之一和四分之一，七零后”的人。')
})
test('数字只修改朗读副本，教材原文不动', () => {
  const result = prepare([{ text: '把1/2和1/4相加。' }])
  assert.equal(result.entries[0].text, '把1/2和1/4相加。')
  assert.equal(result.overrides.entries['book/lesson-01/0'].text, '把二分之一和四分之一相加。')
})
test('真实拼音字母仅阻塞包含片段的条目，普通汉字句仍可准备', () => {
  const result = prepare([{ text: '我知道，这便是a、o、e。' }, { text: '我真高兴。' }])
  assert.equal(result.entries[0].skipped, true)
  assert.equal(result.entries[1].skipped, false)
})
test('特殊注音按短语匹配，同课为的两读音分别保留', () => {
  const source = lesson({ title: '文言文二则', pronunciationHints: [
    { text: '为', pinyin: 'wèi', context: '此不为远者小而近者大乎', pdfPage: 104 },
    { text: '为', pinyin: 'wéi', context: '孰为汝多知乎', pdfPage: 104 },
  ] })
  const result = prepare([{ text: '此不为远者小而近者大乎？' }, { text: '孰为汝多知乎？' }, { text: '孔子东游。' }], source)
  assert.equal(result.entries[0].pronunciation.review.find(item => item.code === 'source-pronunciation-hint').expectedPinyin, 'wèi')
  assert.equal(result.entries[1].pronunciation.review.find(item => item.code === 'source-pronunciation-hint').expectedPinyin, 'wéi')
  assert.equal(result.entries[0].skipped, true)
  assert.equal(result.entries[1].skipped, true)
  assert.equal(result.entries[2].skipped, false)
})
test('词级覆写绑定原文，并仅解除明确列出的阻塞原因', () => {
  const config = { ...rules, entryOverrides: { 'book/lesson-01/0': { sourceText: '龘', readingText: '龘，龙行龘龘的龘',
    reason: '编辑核对的带词读', resolveBlockers: ['character-without-context'] } } }
  const result = prepare([{ text: '龘', kind: 'character' }], lesson(), config)
  assert.equal(result.entries[0].skipped, false)
  assert.throws(() => prepare([{ text: '龖', kind: 'character' }], lesson(), config), /来源文字不匹配/u)
})
test('轻声和变调保留汉字，不机械替换字音', () => {
  const text = '一个孩子不怕困难。'
  const result = prepare([{ text }])
  assert.equal(prepareEntries(result.entries, result.overrides, DEFAULT_SETTINGS)[0].readingText, text)
  assert(result.entries[0].pronunciation.review.some(item => item.code === 'neutral-tone-context'))
  assert(result.entries[0].pronunciation.review.some(item => item.code === 'tone-sandhi-context'))
  assert(result.report.policies.neutralTone.includes('保留正常汉字'))
  assert(result.report.policies.toneSandhi.includes('不把表层变调写回'))
})

test('普通带词读不覆盖已有手工读音规则', () => {
  const result = prepare([{ text: '凤', kind: 'character' }], lesson({ paragraphs: [{ text: '凤凰花开了。' }] }))
  assert.equal(result.overrides.entries['book/lesson-01/0'], undefined)
  const merged = { entries: {}, texts: { 凤: { word: '凤尾竹' } } }
  assert.equal(prepareEntries(result.entries, merged, DEFAULT_SETTINGS)[0].readingText, '凤，凤尾竹的凤')
})
