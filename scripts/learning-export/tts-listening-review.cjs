'use strict'

const fs = require('node:fs')
const path = require('node:path')

const HASH = /^[a-f0-9]{64}$/u
const nonempty = value => typeof value === 'string' && Boolean(value.trim())

// IDs restrict the listening decision to the exact reviewed lesson entries.
// Keep the expected reading as a guard against reusing an ID for another sound.
function indexListeningReview(review = { records: [] }) {
  if (review.schemaVersion !== undefined && review.schemaVersion !== 1 || !Array.isArray(review.records))
    throw new Error('tts-listening-review.json 格式无效')
  if (review.draft || review.decisionStatus === 'draft'
    || review.records.some(record => record?.selectionStatus?.startsWith('pending')))
    throw new Error('tts-listening-review.json 尚有待确认的选词')
  const indexed = new Map()
  for (const record of review.records) {
    if (!record || !['approved', 'rejected'].includes(record.status)
      || !['poly', 'single'].includes(record.kind)
      || !nonempty(record.text) || [...record.text].length !== 1
      || !(nonempty(record.pinyin) || record.status === 'approved' && record.pinyin === null)
      || !nonempty(record.readingText) || typeof record.originalReadingText !== 'string'
      || !(HASH.test(record.originalCacheKey || '') || record.status === 'rejected' && record.originalCacheKey === null)
      || record.status === 'approved' && record.readingText !== record.originalReadingText
      || record.status === 'rejected' && !nonempty(record.note)
      || !Array.isArray(record.entryIds) || !record.entryIds.length || record.entryIds.some(id => !nonempty(id)))
      throw new Error('tts-listening-review.json 决定无效')
    // Round 5 can choose a new recording after a held/rejected round 4.
    // Earlier decisions and rewrite evidence still describe the round 4 text.
    const historicalReadingText = record.round5 !== undefined ? record.round4?.readingText : record.readingText
    if (record.round2 !== undefined) {
      const round2 = record.round2
      if (record.status !== 'rejected' || !round2 || typeof round2 !== 'object' || Array.isArray(round2)
        || !['approved', 'rejected', 'pending'].includes(round2.status)
        || !nonempty(round2.readingText) || typeof round2.cacheKey !== 'string' || !HASH.test(round2.cacheKey)
        || typeof round2.note !== 'string'
        || ['approved', 'pending'].includes(round2.status) && round2.readingText !== historicalReadingText)
        throw new Error('tts-listening-review.json 第二轮决定无效')
    }
    if (record.round2Rewrite !== undefined) {
      const rewrite = record.round2Rewrite
      if (record.round2?.status !== 'rejected' || !rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)
        || !nonempty(rewrite.readingText) || !['passed', 'failed'].includes(rewrite.validationStatus)
        || typeof rewrite.applied !== 'boolean' || !nonempty(rewrite.pypinyinVersion)
        || rewrite.selection !== 'coordinator-exact-reading-text'
        || !(rewrite.substitute === null || nonempty(rewrite.substitute) && [...rewrite.substitute].length === 1)
        || !Array.isArray(rewrite.substituteReadings) || rewrite.substituteReadings.some(reading => !nonempty(reading))
        || rewrite.applied && (rewrite.validationStatus !== 'passed' || rewrite.readingText !== (record.round3?.readingText ?? historicalReadingText))
        || !rewrite.applied && record.round2.readingText !== historicalReadingText)
        throw new Error('tts-listening-review.json 第二轮改写校验无效')
    }
    if (record.round3 !== undefined) {
      const round3 = record.round3
      if (record.round2?.status !== 'rejected' || record.round2Rewrite?.applied !== true
        || !round3 || typeof round3 !== 'object' || Array.isArray(round3)
        || !['approved', 'rejected', 'pending'].includes(round3.status)
        || !nonempty(round3.readingText) || typeof round3.cacheKey !== 'string' || !HASH.test(round3.cacheKey)
        || typeof round3.note !== 'string'
        || !['results-file', 'unmarked'].includes(round3.confirmationSource)
        || (round3.status === 'pending') !== (round3.confirmationSource === 'unmarked')
        || round3.status === 'approved' && round3.readingText !== historicalReadingText)
        throw new Error('tts-listening-review.json 第三轮决定无效')
    }
    if (record.round3Rewrite !== undefined) {
      const rewrite = record.round3Rewrite
      if (record.round3?.status !== 'rejected' || !rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)
        || !nonempty(rewrite.readingText) || rewrite.validationStatus !== 'passed' || rewrite.applied !== true
        || !nonempty(rewrite.pypinyinVersion) || rewrite.selection !== 'coordinator-exact-reading-text'
        || !nonempty(rewrite.substitute) || [...rewrite.substitute].length !== 1
        || !Array.isArray(rewrite.substituteReadings) || rewrite.substituteReadings.length !== 1
        || rewrite.substituteReadings[0] !== record.pinyin || rewrite.readingText !== historicalReadingText)
        throw new Error('tts-listening-review.json 第三轮改写校验无效')
    } else if (record.round3?.status === 'rejected' && historicalReadingText !== record.round3.readingText) {
      throw new Error('tts-listening-review.json 第三轮改写校验无效')
    }
    if (record.round4 !== undefined) {
      const round4 = record.round4
      const prior = record.round3 ?? record.round2 ?? record
      if (!record.round2 || prior.status === 'approved'
        || !round4 || typeof round4 !== 'object' || Array.isArray(round4)
        || !['approved', 'rejected', 'pending'].includes(round4.status)
        || !nonempty(round4.readingText) || round4.readingText !== historicalReadingText
        || typeof round4.cacheKey !== 'string' || !HASH.test(round4.cacheKey)
        || typeof round4.note !== 'string'
        || !['results-file', 'user-round4-confirmation', 'unmarked'].includes(round4.confirmationSource)
        || (round4.status === 'pending') !== (round4.confirmationSource === 'unmarked')
        || round4.confirmationSource === 'user-round4-confirmation' && !nonempty(round4.note)
        || !record.round3Rewrite && (round4.readingText !== prior.readingText || round4.cacheKey !== prior.cacheKey))
        throw new Error('tts-listening-review.json 第四轮决定无效')
    }
    if (record.round5 !== undefined) {
      const round5 = record.round5
      if (!['rejected', 'pending'].includes(record.round4?.status)
        || !round5 || typeof round5 !== 'object' || Array.isArray(round5)
        || round5.status !== 'approved' || round5.confirmationSource !== 'user-round5-confirmation'
        || !nonempty(round5.readingText) || round5.readingText !== record.readingText
        || typeof round5.cacheKey !== 'string' || !HASH.test(round5.cacheKey) || !nonempty(round5.note)
        || !Number.isSafeInteger(round5.selectedCandidate) || round5.selectedCandidate < 1
        || !Array.isArray(round5.acceptedCandidates) || !round5.acceptedCandidates.length
        || round5.acceptedCandidates.some(candidate => !Number.isSafeInteger(candidate) || candidate < 1)
        || new Set(round5.acceptedCandidates).size !== round5.acceptedCandidates.length
        || !round5.acceptedCandidates.includes(round5.selectedCandidate))
        throw new Error('tts-listening-review.json 第五轮决定无效')
    }
    for (const id of record.entryIds) {
      if (indexed.has(id)) throw new Error('tts-listening-review.json 条目 ID 重复')
      indexed.set(id, record)
    }
  }
  return indexed
}

function readListeningReview(root, addInput) {
  const filename = path.join(root, 'content/reading-prep/tts-listening-review.json')
  if (!fs.existsSync(filename)) return { schemaVersion: 1, records: [] }
  const review = JSON.parse(fs.readFileSync(filename, 'utf8'))
  indexListeningReview(review)
  addInput?.('reading-prep/tts-listening-review.json', filename)
  return review
}

function decisionForEntry(entry, indexed) {
  const record = indexed.get(entry.id)
  if (!record) return undefined
  if (!entry.isCharacter || entry.text !== record.text
    || entry.expectedPinyin && entry.expectedPinyin.normalize('NFC') !== (record.pinyin || '').normalize('NFC'))
    throw new Error(`试听决定与条目字音冲突：${entry.id}`)
  return record
}

module.exports = { readListeningReview, indexListeningReview, decisionForEntry }
