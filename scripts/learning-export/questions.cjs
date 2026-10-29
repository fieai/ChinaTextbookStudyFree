'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { readJson, contentHash, logicalKey, requireCondition: check } = require('./common.cjs')

const AUTHOR_VERSION = 'wp10-author-decisions/2026-10-28@1'
const MANUAL = {
  'g3down-2026:101:unit_test:22': { ruleId: 'A-DATE-COUNT@1', renderKind: 'numeric', answerDomain: 'count', countUnit: '号', answerLiteral: '25' },
  'g3down-2026:3:unit_test:19': { ruleId: 'A-PERIMETER-DM@1', renderKind: 'measurement', targetUnit: 'dm', answerLiteral: '20' },
  'g3down-2026:7:unit_test:25': { ruleId: 'A-CLOCK-COUNT@1', renderKind: 'numeric', answerDomain: 'count', countUnit: '时', answerLiteral: '3' },
  'g3down-2026:7:unit_test:37': { ruleId: 'A-ENERGY-KWH@1', renderKind: 'measurement', targetUnit: 'kWh', answerLiteral: '69' },
}

function loadSourceQuestions({ sourceRoot, dataDir, catalog, addInput }) {
  const inventory = readJson(path.join(dataDir, 'question-type-distribution.json'))
  const locators = readJson(path.join(dataDir, 'question-locators.json'))
  addInput('evidence-data/question-type-distribution.json', path.join(dataDir, 'question-type-distribution.json'))
  addInput('evidence-data/question-locators.json', path.join(dataDir, 'question-locators.json'))
  const byLocator = new Map(locators.map(record => [record.locator, record]))
  check(byLocator.size === locators.length, 'Duplicate source question locator')
  const records = []
  for (const entry of inventory.sourceFiles) {
    const filename = path.resolve(sourceRoot, entry.path)
    check(filename.startsWith(`${path.resolve(sourceRoot)}/output/`), `Invalid source path: ${entry.path}`)
    const file = addInput(entry.path, filename)
    check(file.sha256 === entry.sha256, `Frozen source SHA256 mismatch: ${entry.path}`)
    const source = readJson(filename)
    for (const section of ['unit_test', 'exam']) {
      check(Array.isArray(source[section]?.questions), `Missing source section ${entry.path}#/${section}`)
      source[section].questions.forEach((question, index) => {
        const locator = `${entry.path}#/${section}/questions/${index}`
        const record = byLocator.get(locator)
        check(record && record.type === question.type && record.knowledgePoint === question.knowledge_point
          && record.sourceQuestionId === question.id && record.unitNumber === source.unit_number,
        `Stale or missing question locator: ${locator}`)
        check(catalog.books.some(book => book.sourceBookId === record.sourceBookId), `Unknown question book: ${locator}`)
        records.push({ ...record, question, fileSha256: file.sha256 })
      })
    }
  }
  check(records.length === locators.length && records.length === inventory.questionCount, 'Source question coverage mismatch')
  return records
}

function inferQuestions(records, evidenceDir) {
  return JSON.parse(execFileSync('python3', ['-B', path.join(__dirname, 'infer.py'), evidenceDir], {
    input: JSON.stringify(records.map(record => record.question)), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }))
}

function resolvedMetadata(record, inferred) {
  const q = record.question
  if (q.type === 'true_false') {
    check(['对', '错'].includes(q.answer), `Unknown explicit true_false answer: ${record.locator}`)
    return { renderKind: 'true_false', rulesetVersion: AUTHOR_VERSION, ruleId: 'S-TRUE-FALSE@1', status: 'explicit' }
  }
  const manual = MANUAL[`${record.sourceBookId}:${record.unitNumber}:${record.section}:${Number(record.locator.split('/').at(-1))}`]
  if (manual) {
    check(q.answer === manual.answerLiteral && inferred?.status === 'manual-review', `Manual decision no longer matches: ${record.locator}`)
    return { ...manual, answerValue: Number(manual.answerLiteral), tolerance: 0, rulesetVersion: AUTHOR_VERSION, status: 'explicit' }
  }
  check(inferred?.status === 'inferred-draft', `Inference rejected ${record.locator}: ${inferred?.reason}`)
  return { ...inferred.metadata, rulesetVersion: inferred.rulesetVersion, ruleId: inferred.ruleId, status: 'inferred' }
}

function makePayload(record, metadata, knowledgePointId) {
  const q = record.question
  const kind = metadata.renderKind
  const sourceType = q.type
  // sourceLabel is rendered to learners. Keep internal locators in the report's
  // provenance records instead of presenting a repository path as a source label.
  const question = { kind, prompt: q.question, sourceKind: sourceType }
  const grading = { kind, score: q.score, explanation: q.explanation, partialCredit: false }
  if (kind === 'choice' || kind === 'multi') {
    question.options = q.options.map((label, index) => ({ id: metadata.optionIds[index], label: label.normalize('NFC').trim() }))
    if (kind === 'choice') grading.optionId = metadata.answerOptionIds[0]
    else grading.optionIds = metadata.answerOptionIds
  } else if (kind === 'true_false') {
    grading.value = q.answer === '对'
  } else if (kind === 'text') {
    grading.acceptedTexts = metadata.acceptedTexts
    grading.normalization = 'nfc-trim'
  } else if (['numeric', 'measurement', 'calculation'].includes(kind)) {
    grading.value = metadata.answerValue
    if (kind !== 'calculation') grading.tolerance = metadata.tolerance
    if (kind === 'measurement') {
      question.units = [metadata.targetUnit]
      grading.unit = metadata.targetUnit
    } else if (kind === 'numeric') {
      question.answerDomain = metadata.answerDomain
      if (metadata.countUnit) question.countUnit = metadata.countUnit
    }
  } else {
    throw new Error(`Unsupported resolved kind ${kind}: ${record.locator}`)
  }
  return {
    question, grading,
    source: {
      schemaVersion: 1, sourceType, targetKind: kind, answerEncoding: 'structured-v1',
      knowledgePointIds: [knowledgePointId], sourceKnowledgePoint: q.knowledge_point,
      inference: { rulesetVersion: metadata.rulesetVersion, ruleId: metadata.ruleId, status: metadata.status },
    },
  }
}

function buildQuestions({ records, assignment, catalog, evidenceDir, contract, knowledgePoints }) {
  check(assignment.ruleVersion === 'assign-v2' && assignment.unmatched.length === 0, 'Expected complete assign-v2 evidence')
  const owners = new Map(assignment.assignments.map(record => [record.locator, record]))
  check(owners.size === assignment.assignments.length, 'Duplicate assign-v2 locator')
  const inferred = inferQuestions(records, evidenceDir)
  const questions = []
  const provenance = []
  const warnings = []
  const contractIssues = []
  const knownIds = knowledgePoints.map(point => point.id)
  records.forEach((record, index) => {
    const book = catalog.books.find(book => book.sourceBookId === record.sourceBookId)
    let owner, pointId
    if (book.subject === 'math') {
      const assigned = owners.get(record.locator)
      check(assigned && contentHash(assigned.question) === contentHash(record.question), `Stale assign-v2 question: ${record.locator}`)
      owner = assigned.lessonId
      pointId = assigned.knowledgePointId
    } else {
      const unit = book.units.find(unit => unit.number === record.unitNumber)
      const matches = unit.lessons.filter(lesson => lesson.title === record.question.knowledge_point)
      check(matches.length === 1, `Chinese knowledge point is ambiguous: ${record.locator}`)
      owner = pointId = matches[0].sourceLessonId
    }
    const metadata = resolvedMetadata(record, inferred[index])
    const payload = makePayload(record, metadata, pointId)
    const validation = contract.validateQuestionImport(payload, record.question.sourceMetadata ?? {}, knownIds)
    if (!validation.success) contractIssues.push({ locator: record.locator, issues: validation.error.issues })
    const key = logicalKey('question', record.locator)
    questions.push({ id: key, logicalKey: key, sourceBookId: book.sourceBookId, sourceLessonId: owner, payload })
    provenance.push({ id: key, locator: record.locator, fileSha256: record.fileSha256,
      original: record.question, resolvedMetadata: metadata })
    if (metadata.ruleId === 'A-PERIMETER-DM@1') warnings.push({ code: 'AUTHOR_PROMPT_REQUIRED',
      locator: record.locator, message: '按用户决定以 dm 判分，原题干逐字保留。需作者将末句补为“它的周长是多少分米？”后再发布修订内容。' })
  })
  check(owners.size === records.filter(record => record.sourceBookId.startsWith('g3')).length, 'assign-v2 coverage mismatch')
  return { questions, provenance, warnings, contractIssues }
}

module.exports = { AUTHOR_VERSION, MANUAL, loadSourceQuestions, inferQuestions, resolvedMetadata, makePayload, buildQuestions }
