'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { options, WORKTREE } = require('./index.cjs')
const { contentHash } = require('./common.cjs')
const { collectAudioEntries, prepareEntries, readOverrides, loadSettings } = require('./tts-common.cjs')
const { readListeningReview, indexListeningReview } = require('./tts-listening-review.cjs')
const { runTts } = require('./tts-elevenlabs.cjs')
const baseline = require('./fixtures/tts-listening-baseline.json')
const ENV = { ELEVENLABS_VOICE_ID: 'listening-test-voice' }
const ROUND2_REPLACEMENTS = new Map([
  ['劲/jìn', '进，使进的进'], ['模/mú', '一模一样'], ['累/lěi', '垒，积垒的垒'],
  ['乘/shèng', '剩，剩下的剩'], ['系/jì', '季，季鞋带的季'], ['和/huò', '货，货弄的货'],
  ['屏/bǐng', '饼，饼住的饼'], ['粘/zhān', '瞻，瞻贴的瞻'], ['缤/bīn', '缤纷'],
  ['喵/miāo', '喵喵'], ['钻/zuān', '钻洞的钻'], ['汪/wāng', '汪汪'],
  ['爪/zhǎo', '沼，前沼的沼'], ['涨/zhàng', '账，账红的账'],
])

// Keep the round 1 human decision and revision regression independent of later rounds.
function round1Review(review) {
  return { ...review, records: review.records.map(({ round2, round2Rewrite, round3, round3Rewrite, round4, round5, ...record }) => ({ ...record,
    ...(round2 ? { readingText: round2.readingText } : {}) })) }
}

function round2Review(review) {
  return { ...review, records: review.records.map(({ round3, round3Rewrite, round4, round5, ...record }) => ({ ...record,
    ...(round3 ? { readingText: round3.readingText } : {}) })) }
}

function round3Review(review) {
  return { ...review, records: review.records.map(({ round4, round5, ...record }) => ({ ...record,
    ...(round4 ? { readingText: round4.readingText } : {}) })) }
}

function round4Review(review) {
  return { ...review, records: review.records.map(({ round5, ...record }) => ({ ...record,
    ...(record.round4 ? { readingText: record.round4.readingText } : {}) })) }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-listening-review-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function digest(entries) {
  const rows = entries.map(entry => [entry.id, entry.readingText, entry.cacheKey])
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
function sourceEntries() {
  const config = options([])
  const cards = require('./cards.cjs').loadCardLessons(config).patches
  const reading = require('./reading-language.cjs').loadReadingLessonPatches(config)
  const patches = Object.fromEntries([...new Set([...Object.keys(cards), ...Object.keys(reading)])]
    .map(id => [id, { ...cards[id], ...reading[id] }]))
  Object.assign(patches, require('./studio.cjs').buildStudioLessons(config).patches)
  return collectAudioEntries(patches)
}
function character(extra = {}) {
  return { id: 'lesson/read/characters/1', lessonId: 'lesson', stageKey: 'lesson/read',
    text: '假', isCharacter: true, kind: 'character', expectedPinyin: 'jià',
    contextWord: '放假', supportsAudio: true, ...extra }
}
function reviewFor(entry, config, changes = {}) {
  const original = prepareEntries([entry], {}, config)[0]
  return { schemaVersion: 1, records: [{ text: entry.text, pinyin: entry.expectedPinyin,
    originalReadingText: original.readingText, originalCacheKey: original.cacheKey,
    readingText: original.readingText, status: 'approved', note: '', kind: 'poly',
    entryIds: [entry.id], contextWord: entry.contextWord, ...changes }] }
}

test('round 1 locks all 211 approvals and changes exactly 98 unique readings; every other source entry retains its cache key', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = round1Review(readListeningReview(WORKTREE))
  const before = prepareEntries(raw, overrides, config)
  const after = prepareEntries(raw, overrides, config, review)
  assert.equal(contentHash(config), baseline.settingsFingerprint, 'round 1 cache-key check requires its original local TTS settings')
  const originalBooks = before.filter(entry => baseline.books.includes(entry.sourceBookId))
  for (const [name, entries] of Object.entries({ all: originalBooks,
    characters: originalBooks.filter(entry => entry.kind === 'character'),
    other: originalBooks.filter(entry => entry.kind !== 'character') })) {
    assert.equal(entries.length, baseline.groups[name].count, `${name}: original entry coverage`)
    assert.equal(digest(entries), baseline.groups[name].sha256, `${name}: original readingText and cacheKey baseline`)
  }
  const approved = review.records.filter(record => record.status === 'approved')
  const rejected = review.records.filter(record => record.status === 'rejected')
  assert.equal(approved.length, 211)
  assert.equal(new Set(approved.map(record => record.originalCacheKey)).size, 211)
  assert.equal(rejected.length, 98)
  assert.equal(rejected.filter(record => record.originalCacheKey === null).length, 1)
  assert.equal(new Set(rejected.map(record => record.originalCacheKey).filter(Boolean)).size, 97)
  assert.equal(rejected.filter(record => record.kind === 'single').length, 55)
  assert.equal(rejected.filter(record => record.kind === 'poly').length, 43)
  for (const [name, records] of Object.entries({ approved, rejected })) {
    const rows = records.filter(record => record.originalCacheKey)
      .map(record => [record.originalCacheKey, record.text, record.pinyin, record.originalReadingText])
      .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    assert.equal(rows.length, baseline.listening[name].count)
    assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      baseline.listening[name].sha256, `${name}: match the actual round 1 human decisions`)
  }
  const oldById = new Map(before.map(entry => [entry.id, entry]))
  const newById = new Map(after.map(entry => [entry.id, entry]))
  const decisions = new Map(review.records.flatMap(record => record.entryIds.map(id => [id, record])))
  assert.equal(after.length, before.length)
  assert.equal(oldById.size, before.length, 'original source IDs are unique')
  assert.equal(newById.size, after.length, 'review cannot duplicate an entry or omit another entry')
  assert.deepEqual(new Set(newById.keys()), new Set(oldById.keys()), 'review preserves the exact source ID set')
  const changedKeys = new Set(), changedDecisions = new Set(), oldApproved = new Set()
  const unchangedKinds = new Set(), replacements = new Map()
  let otherEntries = 0, otherBookEntries = 0
  for (const entry of after) {
    const previous = oldById.get(entry.id), record = decisions.get(entry.id)
    assert.ok(previous, `unexpected ID ${entry.id}`)
    if (!record || record.status === 'approved') {
      assert.equal(entry.readingText, previous.readingText, entry.id)
      assert.equal(entry.cacheKey, previous.cacheKey, entry.id)
      if (!record) {
        otherEntries++
        unchangedKinds.add(entry.kind)
      }
      if (!baseline.books.includes(entry.sourceBookId)) otherBookEntries++
    } else {
      assert.equal(entry.isCharacter, true, entry.id)
      assert.equal(entry.readingText, record.readingText, entry.id)
      assert.notEqual(entry.cacheKey, previous.cacheKey, entry.id)
      assert.equal(entry.skipped, false, entry.id)
      changedKeys.add(entry.cacheKey)
      changedDecisions.add(record)
      const replacement = replacements.get(record)
      if (replacement) assert.equal(entry.cacheKey, replacement, `${entry.id}: one replacement per reviewed sound`)
      replacements.set(record, entry.cacheKey)
    }
  }
  for (const record of review.records) for (const id of record.entryIds) {
    const previous = oldById.get(id), current = newById.get(id)
    assert.ok(previous && current, `review references absent source ID ${id}`)
    assert.equal(previous.text, record.text, id)
    assert.equal(previous.readingText, record.originalReadingText, id)
    if (record.originalCacheKey) assert.equal(previous.cacheKey, record.originalCacheKey, id)
    if (record.status === 'approved') {
      assert.equal(current.readingText, record.originalReadingText, id)
      assert.equal(current.cacheKey, record.originalCacheKey, id)
      oldApproved.add(current.cacheKey)
    }
  }
  assert.equal(oldApproved.size, 211)
  assert.equal(changedKeys.size, 98)
  assert.equal(changedDecisions.size, 98)
  assert.deepEqual(changedDecisions, new Set(rejected), 'only the 98 rejected decisions produce changed keys')
  assert.ok(otherEntries > 2000, 'include vocabulary, sentence and whole-lesson entries')
  for (const kind of ['word', 'sentence', 'whole'])
    assert.ok(unchangedKinds.has(kind), `${kind}: explicitly cover unchanged non-character audio`)
  assert.ok(otherBookEntries > 0, 'compare other books as well as the two reviewed books')
  const missing = rejected.find(record => record.originalCacheKey === null)
  assert.equal(missing.text, '旋'); assert.equal(missing.pinyin, 'xuàn')
  for (const id of missing.entryIds) {
    assert.equal(newById.get(id).skipped, false)
    assert.equal(newById.get(id).missingWord, false)
    assert.ok(newById.get(id).readingText.includes('旋风'))
  }
})

test('round 2 applies exactly 14 validated rewrite proposals; all other source entries remain locked', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = round2Review(readListeningReview(WORKTREE))
  const before = prepareEntries(raw, overrides, config, round1Review(review))
  const after = prepareEntries(raw, overrides, config, review)
  assert.equal(contentHash(config), baseline.settingsFingerprint)
  const reviewed = review.records.filter(record => record.round2)
  const approved = reviewed.filter(record => record.round2.status === 'approved')
  const rejected = reviewed.filter(record => record.round2.status === 'rejected')
  const pending = reviewed.filter(record => record.round2.status === 'pending')
  assert.equal(reviewed.length, 98)
  assert.equal(approved.length, 83)
  assert.equal(rejected.length, 14)
  assert.equal(pending.length, 1)
  assert.equal(`${pending[0].text}/${pending[0].pinyin}`, '冲/chòng')
  assert.equal(review.records.filter(record => record.round2Rewrite).length, 14)
  for (const record of rejected) {
    const sound = `${record.text}/${record.pinyin}`, rewrite = record.round2Rewrite
    assert.ok(ROUND2_REPLACEMENTS.has(sound), `unexpected round 2 rejection ${sound}`)
    assert.ok(rewrite, `missing exact rewrite proposal for ${sound}`)
    assert.equal(rewrite.readingText, ROUND2_REPLACEMENTS.get(sound), sound)
    assert.equal(rewrite.selection, 'coordinator-exact-reading-text', sound)
    assert.equal(rewrite.validationStatus, 'passed', sound)
    assert.equal(rewrite.applied, true, sound)
    assert.deepEqual(rewrite.substituteReadings, rewrite.substitute ? [record.pinyin] : [], sound)
  }
  assert.deepEqual(new Set(rejected.map(record => `${record.text}/${record.pinyin}`)),
    new Set(ROUND2_REPLACEMENTS.keys()))
  const oldById = new Map(before.map(entry => [entry.id, entry]))
  const newById = new Map(after.map(entry => [entry.id, entry]))
  assert.equal(oldById.size, before.length)
  assert.equal(newById.size, after.length)
  assert.deepEqual(new Set(newById.keys()), new Set(oldById.keys()))
  const decisions = new Map(review.records.flatMap(record => record.entryIds.map(id => [id, record])))
  const changedSounds = new Set(), changedKeys = new Set(), approvedKeys = new Set(), originalApprovedKeys = new Set()
  for (const entry of after) {
    const previous = oldById.get(entry.id), record = decisions.get(entry.id)
    assert.equal(entry.text, previous.text, `${entry.id}: child-visible text remains unchanged`)
    if (record?.round2) {
      assert.equal(previous.readingText, record.round2.readingText, `${entry.id}: round 2 listening text`)
      assert.equal(previous.cacheKey, record.round2.cacheKey, `${entry.id}: round 2 listening cache key`)
      assert.equal(entry.listeningReview.status, record.round2.status, entry.id)
      assert.equal(entry.listeningReview.round, 2, entry.id)
      assert.equal(entry.listeningReview.reviewedCacheKey, record.round2.cacheKey, entry.id)
      assert.equal(entry.listeningReview.firstRoundStatus, 'rejected', entry.id)
      assert.equal(entry.contextSource, `listening-review-${record.round2.status}`, entry.id)
    }
    if (record?.round2Rewrite?.applied) {
      const sound = `${record.text}/${record.pinyin}`
      assert.ok(ROUND2_REPLACEMENTS.has(sound), `unexpected round 2 rejection ${sound}`)
      assert.equal(entry.readingText, ROUND2_REPLACEMENTS.get(sound), entry.id)
      assert.notEqual(entry.readingText, previous.readingText, entry.id)
      assert.notEqual(entry.cacheKey, previous.cacheKey, entry.id)
      assert.equal(entry.skipped, false, entry.id)
      changedSounds.add(sound); changedKeys.add(entry.cacheKey)
    } else {
      assert.equal(entry.readingText, previous.readingText, entry.id)
      assert.equal(entry.cacheKey, previous.cacheKey, entry.id)
      if (record?.round2?.status === 'approved') approvedKeys.add(entry.cacheKey)
      if (record?.status === 'approved') {
        assert.equal(entry.readingText, record.originalReadingText, entry.id)
        assert.equal(entry.cacheKey, record.originalCacheKey, entry.id)
        originalApprovedKeys.add(entry.cacheKey)
      }
    }
  }
  assert.deepEqual(changedSounds, new Set(ROUND2_REPLACEMENTS.keys()))
  assert.equal(changedKeys.size, 14)
  assert.equal(approvedKeys.size, 83)
  assert.equal(originalApprovedKeys.size, 211)
  for (const record of reviewed) for (const id of record.entryIds)
    assert.ok(oldById.has(id) && newById.has(id), `round 2 references absent source ID ${id}`)
})

test('round 3 locks 10 approvals, keeps three unmarked recordings pending and changes only the rejected sheng reading from round 2', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = round3Review(readListeningReview(WORKTREE))
  const before = prepareEntries(raw, overrides, config, round2Review(review))
  const after = prepareEntries(raw, overrides, config, review)
  const reviewed = review.records.filter(record => record.round3)
  const approved = reviewed.filter(record => record.round3.status === 'approved')
  const rejected = reviewed.filter(record => record.round3.status === 'rejected')
  assert.equal(reviewed.length, 14)
  assert.equal(approved.length, 10)
  assert.equal(rejected.length, 1)
  assert.equal(approved.filter(record => record.round3.confirmationSource === 'results-file').length, 10)
  assert.deepEqual(new Set(reviewed.filter(record => record.round3.status === 'pending')
    .map(record => record.text)), new Set(['缤', '喵', '汪']))
  const [sheng] = rejected
  assert.equal(`${sheng.text}/${sheng.pinyin}`, '乘/shèng')
  assert.equal(sheng.round3.readingText, '剩，剩下的剩')
  assert.equal(sheng.readingText, '剩，一剩轿子的剩')
  assert.equal(sheng.round3Rewrite.readingText, sheng.readingText)
  assert.equal(sheng.round3Rewrite.substitute, '剩')
  assert.deepEqual(sheng.round3Rewrite.substituteReadings, ['shèng'])
  assert.equal(sheng.round3Rewrite.selection, 'coordinator-exact-reading-text')
  assert.equal(sheng.round3Rewrite.validationStatus, 'passed')
  assert.equal(sheng.round3Rewrite.applied, true)
  assert.equal(sheng.round3Rewrite.contextWord, '一乘轿子')
  assert.match(JSON.stringify(sheng), /一幅名扬中外的画/u)
  assert.equal(review.records.filter(record => record.round3Rewrite).length, 1)
  const oldById = new Map(before.map(entry => [entry.id, entry]))
  const newById = new Map(after.map(entry => [entry.id, entry]))
  assert.equal(newById.size, oldById.size)
  assert.deepEqual(new Set(newById.keys()), new Set(oldById.keys()))
  const decisions = new Map(review.records.flatMap(record => record.entryIds.map(id => [id, record])))
  const changedIds = new Set(), changedKeys = new Set(), approvedKeys = new Set()
  for (const entry of after) {
    const previous = oldById.get(entry.id), record = decisions.get(entry.id)
    assert.equal(entry.text, previous.text, `${entry.id}: child-visible text remains unchanged`)
    if (record?.round3) {
      assert.equal(previous.readingText, record.round3.readingText, entry.id)
      assert.equal(previous.cacheKey, record.round3.cacheKey, entry.id)
      assert.equal(entry.listeningReview.status, record.round3.status, entry.id)
      assert.equal(entry.listeningReview.round, 3, entry.id)
      assert.equal(entry.listeningReview.reviewedCacheKey, record.round3.cacheKey, entry.id)
      assert.equal(entry.listeningReview.firstRoundStatus, 'rejected', entry.id)
      assert.equal(entry.contextSource, `listening-review-${record.round3.status}`, entry.id)
      if (record.round3.status === 'approved') approvedKeys.add(entry.cacheKey)
    }
    if (sheng.entryIds.includes(entry.id)) {
      assert.equal(entry.readingText, '剩，一剩轿子的剩', entry.id)
      assert.equal(entry.contextWord, '一乘轿子', entry.id)
      assert.notEqual(entry.cacheKey, previous.cacheKey, entry.id)
      assert.equal(entry.skipped, false, entry.id)
      changedIds.add(entry.id); changedKeys.add(entry.cacheKey)
    } else {
      assert.equal(entry.readingText, previous.readingText, entry.id)
      assert.equal(entry.cacheKey, previous.cacheKey, entry.id)
    }
  }
  assert.deepEqual(changedIds, new Set(sheng.entryIds))
  assert.equal(changedKeys.size, 1)
  assert.equal(approvedKeys.size, 10)
})

test('all 10 round 3 approvals survive context-candidate and explicit text/word override changes', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = readListeningReview(WORKTREE)
  const approved = review.records.filter(record => record.round3?.status === 'approved')
  assert.equal(approved.length, 10)
  const approvedIds = new Set(approved.flatMap(record => record.entryIds))
  const original = prepareEntries(raw.filter(entry => approvedIds.has(entry.id)), overrides, config, review)
  const changedCandidates = raw.filter(entry => approvedIds.has(entry.id)).map(entry => ({ ...entry,
    contextWord: '全新候选词', contextSource: 'other-book-word-table' }))
  for (const override of ['新读法', { text: '新的字音' }, { word: '新的选词' }]) {
    const changedOverrides = { ...overrides, entries: { ...overrides.entries,
      ...Object.fromEntries([...approvedIds].map(id => [id, override])) } }
    const current = prepareEntries(changedCandidates, changedOverrides, config, review)
    assert.deepEqual(current.map(entry => [entry.id, entry.readingText, entry.cacheKey]),
      original.map(entry => [entry.id, entry.readingText, entry.cacheKey]))
  }
})

test('all 83 round 2 approvals survive context-candidate and explicit text/word override changes', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = readListeningReview(WORKTREE)
  const approved = review.records.filter(record => record.round2?.status === 'approved')
  assert.equal(approved.length, 83)
  const approvedIds = new Set(approved.flatMap(record => record.entryIds))
  const original = prepareEntries(raw.filter(entry => approvedIds.has(entry.id)), overrides, config, review)
  const changedCandidates = raw.filter(entry => approvedIds.has(entry.id)).map(entry => ({ ...entry,
    contextWord: '全新候选词', contextSource: 'other-book-word-table' }))
  for (const override of ['新读法', { text: '新的字音' }, { word: '新的选词' }]) {
    const changedOverrides = { ...overrides, entries: { ...overrides.entries,
      ...Object.fromEntries([...approvedIds].map(id => [id, override])) } }
    const current = prepareEntries(changedCandidates, changedOverrides, config, review)
    assert.deepEqual(current.map(entry => [entry.id, entry.readingText, entry.cacheKey]),
      original.map(entry => [entry.id, entry.readingText, entry.cacheKey]))
  }
})

test('approved audio remains locked when context candidates or explicit text/word overrides change', t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  const review = reviewFor(entry, config), [old] = prepareEntries([entry], {}, config)
  const changed = { ...entry, contextWord: '假期', contextSource: 'other-book-word-table' }
  for (const override of ['新读法', { text: '新的字音' }, { word: '请假' }]) {
    const [current] = prepareEntries([changed], { entries: { [entry.id]: override } }, config, review)
    assert.equal(current.readingText, old.readingText)
    assert.equal(current.cacheKey, old.cacheKey)
  }
})

test('review cannot affect an unreviewed ID or another pronunciation of the same character', t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  const review = reviewFor(entry, config, { status: 'rejected', note: '首字声调错误', readingText: '价，放假的价' })
  for (const other of [character({ id: 'lesson/read/characters/2' }),
    character({ id: 'lesson/read/characters/3', expectedPinyin: 'jiǎ', contextWord: '真假' })]) {
    const [without] = prepareEntries([other], {}, config)
    const [withReview] = prepareEntries([other], {}, config, review)
    assert.equal(withReview.readingText, without.readingText)
    assert.equal(withReview.cacheKey, without.cacheKey)
  }
  assert.throws(() => prepareEntries([character({ expectedPinyin: 'jiǎ' })], {}, config, review), /试听决定与条目字音冲突/u)
  assert.throws(() => prepareEntries([character({ text: '价' })], {}, config, review), /试听决定与条目字音冲突/u)
})

test('explicit skip and independent blockers survive listening approval or rejection', async t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  for (const changes of [{}, { status: 'rejected', note: '首字声调错误', readingText: '价，放假的价' }]) {
    const review = reviewFor(entry, config, changes)
    const skipped = prepareEntries([entry], { entries: { [entry.id]: { skip: true } } }, config, review)[0]
    assert.equal(skipped.skipped, true)
    assert.equal(prepareEntries([{ ...entry, skipped: true }], {}, config, review)[0].skipped, true)
    const directory = path.join(root, 'content/reading-prep')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'tts-listening-review.json'), JSON.stringify(review))
    const result = await runTts({ root, env: ENV, dryRun: true, rawEntries: [
      { ...entry, pronunciation: { blockers: ['independent reviewer hold'] } },
    ], log: () => {}, fetchImpl: () => { throw new Error('offline test must never call TTS') } })
    assert.equal(result.plan.entries[0].skipped, true)
    assert.equal(result.plan.uniqueNewRequests, 0)
  }
})

test('missing review is optional; invalid approvals and conflicting ID assignments are rejected', t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  assert.deepEqual(readListeningReview(root), { schemaVersion: 1, records: [] })
  const directory = path.join(root, 'content/reading-prep'), filename = path.join(directory, 'tts-listening-review.json')
  fs.mkdirSync(directory, { recursive: true })
  const valid = reviewFor(entry, config)
  for (const review of [{ ...valid, records: [{ ...valid.records[0], readingText: '已审核文本被改写' }] },
    { ...valid, records: [valid.records[0], valid.records[0]] },
    { ...valid, records: [{ ...valid.records[0], status: 'rejected', note: '' }] }]) {
    fs.writeFileSync(filename, JSON.stringify(review))
    assert.throws(() => readListeningReview(root), /tts-listening-review\.json/u)
  }
})

test('round 2 schema permits only valid decisions on round 1 rejections and locks approved or pending text', t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  const review = reviewFor(entry, config, { status: 'rejected', note: '第一轮读音错误', readingText: '价，放假的价' })
  const record = review.records[0]
  const round2 = { status: 'approved', readingText: record.readingText,
    cacheKey: prepareEntries([entry], {}, config, review)[0].cacheKey, note: '' }
  const withRound2 = changes => ({ ...review, records: [{ ...record, round2: { ...round2, ...changes } }] })
  for (const status of ['approved', 'rejected', 'pending'])
    assert.equal(indexListeningReview(withRound2({ status })).size, 1)
  assert.equal(indexListeningReview(withRound2({ status: 'rejected', readingText: '上一轮错误读法' })).size, 1)
  for (const invalid of [null, [], 'approved', { ...round2, status: 'ok' },
    { ...round2, cacheKey: '' }, { ...round2, cacheKey: 'a'.repeat(63) },
    { ...round2, cacheKey: 'G'.repeat(64) }, { ...round2, cacheKey: [round2.cacheKey] },
    { ...round2, readingText: '' }, { ...round2, note: null },
    { ...round2, note: undefined }, { ...round2, readingText: '已通过文本被改写' },
    { ...round2, status: 'pending', readingText: '待定文本被改写' }]) {
    assert.throws(() => indexListeningReview({ ...review, records: [{ ...record, round2: invalid }] }),
      /第二轮决定无效/u)
  }
  const approved = reviewFor(entry, config)
  assert.throws(() => indexListeningReview({ ...approved, records: [{ ...approved.records[0],
    round2: { ...round2, readingText: approved.records[0].readingText } }] }), /第二轮决定无效/u)
})

test('round 2 rewrite guard rejects applying a failed substitute or changing held text', t => {
  const root = fixture(t), config = loadSettings({ root, env: ENV }), entry = character()
  const review = reviewFor(entry, config, { status: 'rejected', note: '第一轮读音错误', readingText: '价，放假的价' })
  const record = review.records[0]
  record.round2 = { status: 'rejected', readingText: record.readingText,
    cacheKey: prepareEntries([entry], {}, config, review)[0].cacheKey, note: '第二轮仍有错误' }
  const rewrite = { readingText: '架，放架的架', substitute: '架', substituteReadings: ['jià'],
    pypinyinVersion: '0.55.0', validationStatus: 'passed', applied: true,
    selection: 'coordinator-exact-reading-text' }
  const withRewrite = (changes = {}, readingText = rewrite.readingText) => ({ ...review,
    records: [{ ...record, readingText, round2Rewrite: { ...rewrite, ...changes } }] })
  assert.equal(indexListeningReview(withRewrite()).size, 1)
  assert.equal(indexListeningReview(withRewrite({ applied: false, validationStatus: 'failed' }, record.readingText)).size, 1)
  for (const changes of [{ validationStatus: 'failed' }, { applied: 'true' }, { readingText: '' },
    { substitute: '两个字' }, { substituteReadings: 'jià' }, { substituteReadings: [null] },
    { selection: 'automatic-replacement' }, { pypinyinVersion: '' }, { validationStatus: 'unknown' }])
    assert.throws(() => indexListeningReview(withRewrite(changes)), /第二轮改写校验无效/u)
  assert.throws(() => indexListeningReview(withRewrite({ applied: false, validationStatus: 'failed' })),
    /第二轮改写校验无效/u)
  for (const round2Rewrite of [null, [], 'rewrite'])
    assert.throws(() => indexListeningReview({ ...review, records: [{ ...record, round2Rewrite }] }),
      /第二轮改写校验无效/u)
  assert.throws(() => indexListeningReview({ ...review, records: [{ ...record, round2: undefined,
    round2Rewrite: rewrite }] }), /第二轮改写校验无效/u)
})

test('round 3 schema rejects forged decisions and preserves the earlier rounds of approved audio', () => {
  const review = readListeningReview(WORKTREE)
  const approved = review.records.find(record => record.round3?.status === 'approved')
  const rejected = review.records.find(record => record.round3?.status === 'rejected')
  const check = record => indexListeningReview({ schemaVersion: 1, records: [record] })
  assert.equal(check(approved).size, approved.entryIds.length)
  assert.equal(check(rejected).size, rejected.entryIds.length)
  for (const round3 of [null, [], 'approved', { ...approved.round3, status: 'pending' },
    { ...approved.round3, status: 'ok' }, { ...approved.round3, readingText: '' },
    { ...approved.round3, cacheKey: '' }, { ...approved.round3, cacheKey: 'G'.repeat(64) },
    { ...approved.round3, cacheKey: [approved.round3.cacheKey] },
    { ...approved.round3, note: null }, { ...approved.round3, note: undefined },
    { ...approved.round3, confirmationSource: 'automatic-inference' },
    { ...approved.round3, confirmationSource: undefined }])
    assert.throws(() => check({ ...approved, round3 }), /第二轮改写校验无效|第三轮决定无效/u)
  assert.throws(() => check({ ...approved, readingText: '已通过文本被改写' }), /第三轮决定无效/u)
  assert.throws(() => check({ ...approved, round3: { ...approved.round3, readingText: '伪造试听文本' } }),
    /第二轮改写校验无效|第三轮决定无效/u)
  assert.throws(() => check({ ...approved, round2Rewrite: undefined }), /第三轮决定无效/u)
  for (const status of ['approved', 'pending']) {
    const historical = review.records.find(record => record.round2?.status === status)
    assert.ok(historical)
    assert.throws(() => check({ ...historical,
      round3: { ...approved.round3, readingText: historical.readingText } }), /第三轮决定无效/u)
  }
  assert.throws(() => check({ ...approved, round2Rewrite: { ...approved.round2Rewrite,
    readingText: '第二轮历史改写被篡改' } }), /第二轮改写校验无效/u)
  assert.throws(() => check({ ...approved, round2: { ...approved.round2, status: 'approved' } }),
    /第二轮决定无效|第二轮改写校验无效|第三轮决定无效/u)
})

test('round 3 rewrite guard requires a validated unique reading and cannot rewrite approved audio', () => {
  const review = readListeningReview(WORKTREE)
  const approved = review.records.find(record => record.round3?.status === 'approved')
  const rejected = review.records.find(record => record.round3?.status === 'rejected')
  const rewrite = rejected.round3Rewrite
  const check = record => indexListeningReview({ schemaVersion: 1, records: [record] })
  for (const changes of [{ validationStatus: 'failed' }, { applied: 'true' }, { readingText: '' },
    { substitute: '两个字' }, { substituteReadings: 'shèng' }, { substituteReadings: [null] },
    { substituteReadings: ['shèng', 'chéng'] }, { substituteReadings: ['chéng'] },
    { selection: 'automatic-replacement' }, { pypinyinVersion: '' }, { validationStatus: 'unknown' }])
    assert.throws(() => check({ ...rejected, round3Rewrite: { ...rewrite, ...changes } }), /第三轮改写校验无效/u)
  for (const round3Rewrite of [null, [], 'rewrite'])
    assert.throws(() => check({ ...rejected, round3Rewrite }), /第三轮改写校验无效/u)
  assert.throws(() => check({ ...rejected, round3Rewrite: { ...rewrite, applied: false } }), /第三轮改写校验无效/u)
  assert.throws(() => check({ ...approved, round3Rewrite: rewrite }), /第三轮改写校验无效/u)
  assert.throws(() => check({ ...rejected, round3: undefined }), /第二轮改写校验无效|第三轮改写校验无效/u)
})


test('round 4 applies explicit approvals and rejection without changing any synthesis text or cache key', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = round4Review(readListeningReview(WORKTREE))
  const before = prepareEntries(raw, overrides, config, round3Review(review))
  const after = prepareEntries(raw, overrides, config, review)
  assert.deepEqual(after.map(e => [e.id, e.readingText, e.cacheKey]), before.map(e => [e.id, e.readingText, e.cacheKey]))
  const targets = review.records.filter(record => record.round4)
  assert.equal(targets.length, 5)
  assert.deepEqual(new Set(targets.filter(r => r.round4.status === 'approved').map(r => r.text)), new Set(['乘', '缤', '汪', '冲']))
  assert.deepEqual(review.round4Stats, { approved: 4, rejected: 1, lockedApprovedTotal: 308 })
  const entries = new Map(after.map(e => [e.id, e]))
  for (const record of targets) for (const id of record.entryIds) {
    const entry = entries.get(id)
    assert.equal(entry.listeningReview.round, 4)
    assert.equal(entry.listeningReview.status, record.round4.status)
    assert.equal(entry.listeningReview.reviewedCacheKey, entry.cacheKey)
    assert.equal(entry.readingText, record.round4.readingText)
  }
  const miao = targets.find(r => r.text === '喵')
  assert.equal(miao.readingText, '喵喵')
  assert.equal(miao.round3.status, 'pending')
  assert.equal(miao.round4.status, 'rejected')
  assert.equal(targets.find(r => r.text === '冲').round4.confirmationSource, 'user-round4-confirmation')
})

test('all round 4 approvals survive context-candidate and text/word override changes', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = round4Review(readListeningReview(WORKTREE))
  const ids = new Set(review.records.filter(r => r.round4?.status === 'approved').flatMap(r => r.entryIds))
  const entries = raw.filter(e => ids.has(e.id))
  const original = prepareEntries(entries, overrides, config, review)
  for (const override of ['新读法', { text: '新的字音' }, { word: '新的选词' }]) {
    const current = prepareEntries(entries.map(e => ({ ...e, contextWord: '全新候选词' })),
      { ...overrides, entries: { ...overrides.entries, ...Object.fromEntries([...ids].map(id => [id, override])) } }, config, review)
    assert.deepEqual(current.map(e => [e.id, e.readingText, e.cacheKey]), original.map(e => [e.id, e.readingText, e.cacheKey]))
  }
})

test('round 4 schema requires exact recording evidence and cannot supersede locked approvals', () => {
  const review = round4Review(readListeningReview(WORKTREE))
  const chong = review.records.find(r => r.text === '冲' && r.round4)
  const miao = review.records.find(r => r.text === '喵')
  const check = record => indexListeningReview({ schemaVersion: 1, records: [record] })
  for (const round4 of [null, [], 'approved', { ...chong.round4, status: 'ok' },
    { ...chong.round4, readingText: '' }, { ...chong.round4, cacheKey: 'a'.repeat(63) },
    { ...chong.round4, cacheKey: 'a'.repeat(64) }, { ...chong.round4, readingText: '改写冲劲' },
    { ...chong.round4, note: null }, { ...chong.round4, note: '' },
    { ...chong.round4, confirmationSource: 'automatic-inference' },
    { ...chong.round4, status: 'pending' }])
    assert.throws(() => check({ ...chong, round4 }), /第四轮决定无效/u)
  assert.throws(() => check({ ...chong, round2: { ...chong.round2, status: 'approved' } }), /第四轮决定无效/u)
  assert.throws(() => check({ ...miao, readingText: '喵！' }), /第四轮决定无效|第二轮改写校验无效/u)
  assert.throws(() => check({ ...miao, round3: { ...miao.round3, status: 'approved' } }), /第三轮决定无效/u)
  for (const record of review.records.filter(r => r.round3?.status === 'pending')) {
    assert.equal(record.round3.confirmationSource, 'unmarked')
    assert.throws(() => check({ ...record, round3: { ...record.round3, status: 'approved' } }), /第三轮决定无效/u)
  }
})

test('round 5 changes only 喵 to approved candidate 1 and preserves all 308 prior approvals', () => {
  const raw = sourceEntries(), config = loadSettings({ root: WORKTREE, env: {} })
  const overrides = readOverrides(WORKTREE), review = readListeningReview(WORKTREE)
  const previousReview = round4Review(review)
  const before = prepareEntries(raw, overrides, config, previousReview)
  const after = prepareEntries(raw, overrides, config, review)
  const targets = review.records.filter(record => record.round5)
  assert.equal(targets.length, 1)
  const [miao] = targets, ids = new Set(miao.entryIds)
  assert.equal(miao.text, '喵')
  assert.equal(miao.status, 'rejected', 'retain first-round history')
  assert.equal(miao.round4.status, 'rejected')
  assert.equal(miao.round4.readingText, '喵喵')
  assert.equal(miao.round5.selectedCandidate, 1)
  assert.deepEqual(miao.round5.acceptedCandidates, [1, 2])
  const candidates = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'content/reading-prep/tts-candidates.json'), 'utf8'))
  const selectedKey = 'da511fa5c66f63640ed518068bf9f9d595ae76aab87150bbee89995e9913ca86'
  const previous = new Map(before.map(entry => [entry.id, entry]))
  assert.deepEqual(after.map(entry => entry.id), before.map(entry => entry.id))
  const changed = new Set(), priorApproved = new Set(), approved = new Set()
  for (const entry of after) {
    const old = previous.get(entry.id)
    if (old.listeningReview?.status === 'approved') {
      priorApproved.add(old.cacheKey)
      assert.deepEqual(entry, old, `${entry.id}: preserve the complete prior approval`)
    }
    if (entry.listeningReview?.status === 'approved') approved.add(entry.cacheKey)
    if (!ids.has(entry.id)) {
      assert.deepEqual(entry, old, `${entry.id}: round 5 has no effect on another entry`)
      continue
    }
    changed.add(entry.id)
    assert.equal(entry.readingText, '小猫喵喵叫')
    assert.equal(entry.readingText, candidates.entries[entry.id][miao.round5.selectedCandidate - 1])
    assert.equal(entry.readingText, miao.round5.readingText)
    assert.equal(entry.cacheKey, selectedKey)
    assert.equal(entry.listeningReview.reviewedCacheKey, selectedKey)
    assert.equal(miao.round5.cacheKey, selectedKey)
    assert.notEqual(entry.cacheKey, old.cacheKey)
    assert.equal(entry.listeningReview.round, 5)
    assert.equal(entry.listeningReview.status, 'approved')
    assert.equal(entry.listeningReview.firstRoundStatus, 'rejected')
    assert.equal(entry.contextSource, 'listening-review-approved')
    assert.equal(entry.skipped, false)
  }
  assert.deepEqual(changed, ids)
  assert.equal(priorApproved.size, 308)
  assert.equal(approved.size, 309)

  const approvedEntries = after.filter(entry => entry.listeningReview?.status === 'approved')
  const approvedIds = new Set(approvedEntries.map(entry => entry.id))
  for (const override of ['新读法', { text: '新的字音' }, { word: '新的选词' }]) {
    const current = prepareEntries(raw.filter(entry => approvedIds.has(entry.id))
      .map(entry => ({ ...entry, contextWord: '全新候选词' })),
    { ...overrides, entries: { ...overrides.entries,
      ...Object.fromEntries([...approvedIds].map(id => [id, override])) } }, config, review)
    assert.deepEqual(current.map(entry => [entry.id, entry.readingText, entry.cacheKey, entry.listeningReview.status]),
      approvedEntries.map(entry => [entry.id, entry.readingText, entry.cacheKey, 'approved']),
      'all 309 approved recordings, including round 5, stay locked against overrides')
  }
})

test('round 5 requires explicit selected-candidate approval after a rejected or pending round 4', () => {
  const review = readListeningReview(WORKTREE), miao = review.records.find(record => record.round5)
  const check = record => indexListeningReview({ schemaVersion: 1, records: [record] })
  assert.equal(check(miao).size, miao.entryIds.length)
  assert.equal(check({ ...miao, round4: { ...miao.round4, status: 'pending', confirmationSource: 'unmarked' } }).size,
    miao.entryIds.length)
  const valid = miao.round5
  for (const round5 of [null, [], 'approved', { ...valid, status: 'pending' }, { ...valid, status: 'rejected' },
    { ...valid, confirmationSource: 'results-file' }, { ...valid, confirmationSource: undefined },
    { ...valid, readingText: '' }, { ...valid, readingText: '喵喵叫' },
    { ...valid, cacheKey: 'a'.repeat(63) }, { ...valid, cacheKey: 'G'.repeat(64) },
    { ...valid, cacheKey: [valid.cacheKey] }, { ...valid, note: '' }, { ...valid, note: null },
    { ...valid, selectedCandidate: 0 }, { ...valid, selectedCandidate: 1.5 }, { ...valid, selectedCandidate: '1' },
    { ...valid, selectedCandidate: 3 }, { ...valid, acceptedCandidates: [] }, { ...valid, acceptedCandidates: [2] },
    { ...valid, acceptedCandidates: [1, 1] }, { ...valid, acceptedCandidates: [1, '2'] },
    { ...valid, acceptedCandidates: [0, 1] }, { ...valid, acceptedCandidates: [1, 1.5] },
    { ...valid, acceptedCandidates: null }])
    assert.throws(() => check({ ...miao, round5 }), /第五轮决定无效/u)
  assert.throws(() => check({ ...miao, round4: undefined }), /第五轮决定无效/u)
  assert.throws(() => check({ ...miao, round4: { ...miao.round4, status: 'approved' } }), /第五轮决定无效/u)
  assert.throws(() => check({ ...miao, readingText: '另一个读法' }), /第五轮决定无效/u)
  assert.throws(() => check({ ...miao, round4: { ...miao.round4, readingText: '被改写的第四轮历史' } }), /第四轮决定无效/u)
  assert.throws(() => check({ ...miao, round2Rewrite: { ...miao.round2Rewrite, readingText: '被改写的第二轮历史' } }),
    /第二轮改写校验无效/u)
})
