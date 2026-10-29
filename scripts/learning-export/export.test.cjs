'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { options, exportContent, WORKTREE, guardedOutput } = require('./index.cjs')
const { loadAuthority } = require('./authority.cjs')
const { contentHash, packageHash, logicalKey, sha256 } = require('./common.cjs')
const { inputFingerprint } = require('./pages.cjs')
const { validateExport } = require('./validate.cjs')

const authority = loadAuthority(options([]).thinkyRoot)

test('canonical content and collection hashing exactly match the Thinky implementation', () => {
  const cases = [null, [], { z: '中文𠮷', a: 1.25, b: [-0, { z: true, a: 'e\u0301' }] },
    { '9': 'numeric-key', '10': 'also numeric', A: 1, a: 2, '𠮷': 3, '中': 4 }]
  for (const value of cases) assert.equal(contentHash(value), authority.contentHash(value))
  const transport = { manifestSha256: 'f'.repeat(64), sourceRevision: 'test',
    books: [{ sourceBookId: 'z', lessons: [{ ordinal: 3 }, { ordinal: 1 }] }, { sourceBookId: 'a', lessons: [] }],
    questions: [{ id: 'z' }, { id: 'a' }], knowledgePoints: [{ id: 'z' }, { id: 'a' }] }
  assert.equal(packageHash(transport), authority.packageHash(transport))
  assert.equal(packageHash(transport), packageHash({ ...transport,
    books: transport.books.toReversed(), questions: transport.questions.toReversed() }))
  assert.notEqual(contentHash(['stage-a', 'stage-b']), contentHash(['stage-b', 'stage-a']))
})

test('UUID v5 identity is fixed, input-sensitive, and independently matches Python uuid5', () => {
  const { execFileSync } = require('node:child_process')
  const { NAMESPACE } = require('./common.cjs')
  const locator = 'output/语文.json#/unit_test/questions/0'
  const python = execFileSync('python3', ['-B', '-c',
    'import sys,uuid;print(uuid.uuid5(uuid.UUID(sys.argv[1]),sys.argv[2]))', NAMESPACE, `question/${locator}`], { encoding: 'utf8' }).trim()
  assert.equal(logicalKey('question', locator), python)
  assert.equal(logicalKey('question', locator)[14], '5')
  assert.notEqual(logicalKey('lesson', locator), python)
})

test('output path cannot alias the main checkout or another directory through symlinks', () => {
  assert.throws(() => guardedOutput(path.resolve(WORKTREE, '../ChinaTextbookStudyFree')), /Output must stay/)
  const base = path.join(WORKTREE, '.local/learning-export', `.guard-${randomUUID()}`)
  fs.mkdirSync(base, { recursive: true })
  try {
    fs.symlinkSync('/private/tmp', path.join(base, 'revision'))
    assert.throws(() => guardedOutput(path.join(base, 'revision')), /outside|symlink/)
    fs.mkdirSync(path.join(base, 'valid'))
    fs.symlinkSync('/private/tmp', path.join(base, 'valid/media'))
    assert.throws(() => guardedOutput(path.join(base, 'valid/media')), /outside|symlink/)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

test('full real-source export is byte deterministic, retains decisions and blocks bad packages', () => {
  const base = path.join(WORKTREE, '.local/learning-export', `.determinism-${randomUUID()}`)
  const config = options([])
  let one, two
  try {
    one = exportContent({ ...config, outputRoot: path.join(base, 'one') })
    two = exportContent({ ...config, outputRoot: path.join(base, 'two') })
    assert.equal(one.content.sourceRevision, two.content.sourceRevision)
    assert.deepEqual(one.report, two.report)
    const names = fs.readdirSync(one.outputDir).filter(name => name !== 'media').sort()
    assert.deepEqual(names, fs.readdirSync(two.outputDir).filter(name => name !== 'media').sort())
    for (const name of names) assert.deepEqual(fs.readFileSync(path.join(one.outputDir, name)), fs.readFileSync(path.join(two.outputDir, name)))
    const media = fs.readdirSync(path.join(one.outputDir, 'media')).sort()
    assert.deepEqual(media, fs.readdirSync(path.join(two.outputDir, 'media')).sort())
    for (const name of media) {
      const first = fs.readFileSync(path.join(one.outputDir, 'media', name))
      const second = fs.readFileSync(path.join(two.outputDir, 'media', name))
      assert.deepEqual(first, second)
      assert.equal(sha256(first), name.slice(0, -4))
    }
    assert.equal(one.report.books.reduce((sum, book) => sum + book.lessons, 0), 213)
    assert.equal(one.content.questions.length, 1446)
    assert.equal(one.content.knowledgePoints.length, 191)
    assert.equal(one.report.books.reduce((sum, book) => sum + book.pageImages, 0), 478)
    assert.equal(one.report.books.reduce((sum, book) => sum + book.studio, 0), 5)
    assert.equal(one.report.checks.LessonDefinitionSchema.valid, true)
    assert.equal(one.report.checks.validateLessonDefinition.valid, true)
    assert.equal(one.report.issues.some(issue => /overlap lesson g3down-2026-u101-l02/u.test(issue.message)), false)
    assert.equal(one.report.checks.validateLessonCatalog.valid, true)
    const lessons = one.content.books.flatMap(book => book.lessons.map(lesson => lesson.content))
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l02').textbookPages, { from: 86, to: 88 })
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l03').textbookPages, { from: 88, to: 91 })
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'chinese-g3down-2026-u4-kp7').textbookPages, { from: 60, to: 60 })
    assert.equal(lessons.filter(lesson => lesson.level === 'textbook-only').every(lesson => !lesson.opening && !lesson.takeaways && !lesson.basicStages), true)
    assert.equal(one.content.manifestSha256, packageHash(one.content))
    assert.equal(inputFingerprint(one.report.inputs), inputFingerprint([...one.report.inputs].reverse()))
    assert.notEqual(inputFingerprint(one.report.inputs), inputFingerprint(one.report.inputs.map((file, i) => i === 0 ? { ...file, sha256: 'f'.repeat(64) } : file)))
    const practice = lessons.find(lesson => lesson.sourceLessonId === 'g3up-2026-u1-l03')
    const shared = lessons.find(lesson => lesson.sourceLessonId === 'g3up-2026-u1-l01').homework.questionRefs
    assert.equal(shared.every(id => practice.homework.questionRefs.includes(id)), true)
    assert.equal(new Set(one.content.questions.map(question => question.logicalKey)).size, 1446)
    assert.equal(one.report.questionContractIssues.length, 0, 'Question imports require the Thinky v1.6 calculation mapping')
    assert.equal(one.report.valid, true)
    assert.equal(fs.existsSync(path.join(one.outputDir, 'package.json')), true)

    const fixture = structuredClone(one.content)
    for (const question of fixture.questions) {
      if (question.payload.source.sourceType === 'calculation') {
        assert.ok(['calculation', 'numeric', 'measurement'].includes(question.payload.question.kind))
        assert.equal(question.payload.question.sourceKind, 'calculation')
      }
    }
    fixture.manifestSha256 = authority.packageHash(fixture)
    assert.equal(authority.validateContentPackage(fixture).report.valid, true)
    const badCases = [
      [value => delete value.books[0].lessons[0].content.title, /title/],
      [value => value.books[0].lessons[0].content.opening.question = '你能说说', /Generic sentence/],
      [value => value.books[0].lessons[0].content.textbookPages.to = 9999, /Physical page/],
      [value => value.books[0].lessons[0].content.homework.questionRefs.push('missing-question'), /Question not in/],
      [value => value.books[0].lessons[1].content.textbookPages.from = 7, /overlap/],
      [value => value.questions[0].payload.source.knowledgePointIds = ['unknown-kp'], /Knowledge point/],
      [value => value.manifestSha256 = '0'.repeat(64), /SHA256/],
    ]
    for (const [mutate, message] of badCases) {
      const invalid = structuredClone(fixture)
      mutate(invalid)
      const result = authority.validateContentPackage(invalid).report
      assert.equal(result.valid, false)
      assert.match(JSON.stringify(result.issues), message)
    }
    assert.equal(validateExport(one.content, authority, one.report.questionContractIssues).valid, one.report.valid)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
