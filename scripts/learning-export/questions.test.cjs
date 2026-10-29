'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadAuthority } = require('./authority.cjs')
const { logicalKey } = require('./common.cjs')
const { inferQuestions, resolvedMetadata, makePayload, buildQuestions, MANUAL } = require('./questions.cjs')

const thinkyRoot = process.env.THINKY_ROOT || '/Users/my-project/AI-PROJECT/thinky'
const evidenceDir = process.env.WP10_EVIDENCE_DIR || '/Users/my-project/AI-PROJECT/thinky-wp-10/docs/learning/evidence/wp-10'
const { contract } = loadAuthority(thinkyRoot)
const pointId = 'g3up-2026-u1-kp1'

function record(overrides = {}, recordOverrides = {}) {
  return {
    sourceBookId: 'g3up-2026', unitNumber: 1, section: 'unit_test',
    locator: 'output/math/quizzes/unit1.json#/unit_test/questions/0', fileSha256: 'a'.repeat(64),
    question: { type: 'calculation', question: '12×3=（）', answer: '36', options: [],
      score: 5, explanation: '12×3=36。', knowledge_point: '从不同方向观察物体', ...overrides },
    ...recordOverrides,
  }
}

function buildOne(source, options = {}) {
  const assigned = { locator: source.locator, lessonId: 'g3up-2026-u1-l01', knowledgePointId: pointId,
    question: structuredClone(source.question), ...options.assigned }
  return buildQuestions({
    records: [source], evidenceDir, contract,
    catalog: { books: [{ sourceBookId: source.sourceBookId, subject: 'math' }] },
    knowledgePoints: options.knowledgePoints ?? [{ id: pointId }],
    assignment: { ruleVersion: 'assign-v2', unmatched: [], assignments: [assigned] },
  })
}

test('numeric inference rejects multiple unbound slots, unit ambiguity and undeclared targets', () => {
  const cases = [
    { question: '3厘米=（）毫米，5厘米=（）毫米。', answer: '30', reason: 'multiple_unbound_answer_slots' },
    { question: '一共用了（）分。', answer: '3', reason: 'ambiguous_fen_time_or_currency' },
    { question: '每人分到几个小时？', answer: '3', reason: 'quantity_or_rate_hidden_after_count_word' },
    { question: '小丽家4人用电276千瓦时，平均每人用电量是多少？', answer: '69', reason: 'no_explicit_target_or_matching_template' },
  ]
  const records = cases.map(({ reason, ...question }) => record({ type: 'fill_blank', ...question }))
  const inferred = inferQuestions(records, evidenceDir)
  for (const [index, source] of records.entries()) {
    assert.equal(inferred[index].status, 'manual-review')
    assert.equal(inferred[index].reason, cases[index].reason)
    assert.throws(() => resolvedMetadata(source, inferred[index]), /Inference rejected/)
    assert.throws(() => buildOne(source), /Inference rejected/)
  }
})

test('existing explicit inference fields cannot be overwritten by guessed metadata', () => {
  const source = record({ targetUnit: 'cm' })
  const [inferred] = inferQuestions([source], evidenceDir)
  assert.equal(inferred.reason, 'existing_metadata_requires_validation_not_overwrite')
  assert.throws(() => resolvedMetadata(source, inferred), /Inference rejected/)
})

test('four author decisions preserve their exact domains and reject stale source answers or inference state', () => {
  const expected = [
    ['g3down-2026:101:unit_test:22', 'numeric', 'count', '号', undefined, '25'],
    ['g3down-2026:3:unit_test:19', 'measurement', undefined, undefined, 'dm', '20'],
    ['g3down-2026:7:unit_test:25', 'numeric', 'count', '时', undefined, '3'],
    ['g3down-2026:7:unit_test:37', 'measurement', undefined, undefined, 'kWh', '69'],
  ]
  assert.deepEqual(Object.keys(MANUAL).sort(), expected.map(row => row[0]).sort())
  for (const [key, renderKind, answerDomain, countUnit, targetUnit, answer] of expected) {
    const [sourceBookId, unit, section, index] = key.split(':')
    const source = record({ answer }, { sourceBookId, unitNumber: Number(unit), section,
      locator: `output/math/quizzes/unit${unit}.json#/${section}/questions/${index}` })
    const metadata = resolvedMetadata(source, { status: 'manual-review' })
    assert.equal(metadata.renderKind, renderKind)
    assert.equal(metadata.answerDomain, answerDomain)
    assert.equal(metadata.countUnit, countUnit)
    assert.equal(metadata.targetUnit, targetUnit)
    assert.equal(metadata.answerValue, Number(answer))
    assert.equal(metadata.tolerance, 0)
    assert.equal(metadata.status, 'explicit')
    assert.match(metadata.ruleId, /^A-/)
    assert.throws(() => resolvedMetadata({ ...source, question: { ...source.question, answer: `${answer}0` } }, { status: 'manual-review' }), /Manual decision no longer matches/)
    assert.throws(() => resolvedMetadata(source, { status: 'inferred-draft' }), /Manual decision no longer matches/)
  }
})

test('source calculation exports as numeric and retains its supplied exact final value', () => {
  const source = record()
  const result = buildOne(source)
  const payload = result.questions[0].payload
  assert.equal(payload.question.kind, 'numeric')
  assert.equal(payload.question.sourceKind, 'calculation')
  assert.equal(payload.source.sourceType, 'calculation')
  assert.equal(payload.source.targetKind, 'numeric')
  assert.equal(payload.question.answerDomain, 'scalar')
  assert.equal(payload.grading.value, 36)
  assert.equal(payload.grading.partialCredit, false)
  assert.equal(payload.grading.tolerance, 0)
  // Source-answer inference parses representation; it must not silently recalculate source answers.
  assert.equal(buildOne(record({ answer: '35' })).questions[0].payload.grading.value, 35)
  assert.equal(contract.validateQuestionImport(payload, {}, [pointId]).success, true)
})

test('internal question locators remain report provenance and never become a learner-facing source label', () => {
  const source = record()
  const result = buildOne(source)
  const exported = result.questions[0]
  assert.equal(Object.hasOwn(exported.payload.question, 'sourceLabel'), false)
  assert.equal(JSON.stringify(exported.payload.question).includes('output/'), false)
  assert.equal(JSON.stringify(exported.payload.question).includes('.json#/'), false)
  assert.equal(result.provenance[0].locator, source.locator)
  assert.equal(result.provenance[0].fileSha256, source.fileSha256)
  assert.equal(exported.id, logicalKey('question', source.locator))
  assert.equal(exported.logicalKey, exported.id)
  assert.equal(exported.sourceLessonId, 'g3up-2026-u1-l01')
  assert.equal(contract.validateQuestionImport(exported.payload, {}, [pointId]).success, true)
})

for (const metadata of [
  { renderKind: 'numeric', answerDomain: 'count', countUnit: '个', answerValue: 36 },
  { renderKind: 'measurement', answerDomain: 'quantity', targetUnit: 'dm', answerValue: 20 },
]) {
  test(`calculation retains its source type for ${metadata.renderKind} under contract v1.6`, () => {
    const source = record()
    const original = resolvedMetadata(source, inferQuestions([source], evidenceDir)[0])
    const payload = makePayload(source, { ...original, ...metadata }, pointId)
    assert.equal(payload.source.sourceType, 'calculation')
    assert.equal(payload.question.sourceKind, 'calculation')
    assert.equal(payload.question.kind, metadata.renderKind)
    assert.equal(payload.source.targetKind, metadata.renderKind)
    if (metadata.renderKind === 'numeric') assert.equal(payload.question.countUnit, '个')
    else {
      assert.deepEqual(payload.question.units, ['dm'])
      assert.equal(payload.grading.unit, 'dm')
    }
    assert.equal(contract.validateQuestionImport(payload, {}, [pointId]).success, true)
  })
}

test('explicit original source metadata conflicts block the exporter', () => {
  for (const sourceMetadata of [{ targetKind: 'calculation' }, { sourceType: 'fill_blank' }]) {
    const rejected = buildOne(record({ sourceMetadata }))
    assert.equal(rejected.contractIssues.length, 1)
    assert.match(JSON.stringify(rejected.contractIssues), /Resolved metadata conflicts/)
  }
  const valid = record({ sourceMetadata: { sourceType: 'calculation', targetKind: 'numeric', answerEncoding: 'structured-v1' } })
  assert.equal(buildOne(valid).questions.length, 1)
})

test('assignment knowledge points must exist and stale assignment payloads are rejected', () => {
  for (const options of [{ knowledgePoints: [] }, { assigned: { knowledgePointId: 'does-not-exist' } }]) {
    const rejected = buildOne(record(), options)
    assert.equal(rejected.contractIssues.length, 1)
    assert.match(JSON.stringify(rejected.contractIssues), /Knowledge point ID must exist/)
  }
  assert.throws(() => buildOne(record(), { assigned: { question: { ...record().question, answer: '99' } } }), /Stale assign-v2 question/)
})

test('choice answer ownership is checked both during inference and by the real contract', () => {
  const source = record({ type: 'choice', question: '下面哪个数最大？', options: ['3', '5', '8'], answer: '8' })
  const payload = buildOne(source).questions[0].payload
  assert.equal(payload.question.kind, 'choice')
  assert.equal(payload.question.options.find(item => item.id === payload.grading.optionId).label, '8')
  const outside = structuredClone(payload)
  outside.grading.optionId = 'option-not-in-public-items'
  assert.equal(contract.validateQuestionImport(outside, {}, [pointId]).success, false)
  assert.throws(() => buildOne(record({ ...source.question, answer: '9' })), /Inference rejected/)
  assert.throws(() => buildOne(record({ ...source.question, options: ['8', ' 8 ', '3'] })), /Inference rejected/)
})

test('multi-choice cannot assign a correct answer to an unrelated option', () => {
  const source = record({ type: 'choice', question: '多选：选出所有大于3的数。', options: ['3', '5', '8'], answer: '["5","8"]' })
  const payload = buildOne(source).questions[0].payload
  assert.equal(payload.question.kind, 'multi')
  assert.equal(payload.grading.optionIds.length, 2)
  const outside = structuredClone(payload)
  outside.grading.optionIds[1] = 'option-outside'
  assert.equal(contract.validateQuestionImport(outside, {}, [pointId]).success, false)
  assert.throws(() => buildOne(record({ ...source.question, answer: '["5","9"]' })), /Inference rejected/)
})
