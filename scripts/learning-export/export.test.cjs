'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { options, exportContent, WORKTREE, guardedOutput } = require('./index.cjs')
const { loadAuthority } = require('./authority.cjs')
const { contentHash, packageHash, logicalKey, sha256 } = require('./common.cjs')
const { inputFingerprint } = require('./pages.cjs')
const { validateExport } = require('./validate.cjs')

const authority = loadAuthority(options([]).thinkyRoot)

function snapshotTts(base) {
  const tts = require('./tts-common.cjs')
  const ttsRoot = path.join(base, 'tts-input')
  const cache = path.join(ttsRoot, '.local/tts-cache')
  fs.mkdirSync(cache, { recursive: true })
  // A separate generator may append to the live cache during the two exports.
  // Snapshot one manifest and its immutable recordings, while retaining the real
  // non-secret settings and editorial overrides for both runs.
  const settings = tts.loadSettings({ root: WORKTREE })
  const ttsEnv = {
    ELEVENLABS_VOICE_ID: settings.voiceId, ELEVENLABS_MODEL_ID: settings.modelId,
    ELEVENLABS_LANGUAGE_CODE: settings.languageCode, ELEVENLABS_OUTPUT_FORMAT: settings.outputFormat,
    ELEVENLABS_STABILITY: String(settings.voiceSettings.stability),
    ELEVENLABS_SIMILARITY_BOOST: String(settings.voiceSettings.similarity_boost),
    ELEVENLABS_STYLE: String(settings.voiceSettings.style),
    ELEVENLABS_USE_SPEAKER_BOOST: String(settings.voiceSettings.use_speaker_boost),
    ELEVENLABS_SPEED: String(settings.voiceSettings.speed),
  }
  fs.mkdirSync(path.join(ttsRoot, 'scripts/learning-export'), { recursive: true })
  fs.writeFileSync(path.join(ttsRoot, 'scripts/learning-export/tts-overrides.json'), JSON.stringify(tts.readOverrides(WORKTREE)))
  const liveCache = path.join(WORKTREE, '.local/tts-cache')
  const manifest = tts.readManifest(liveCache)
  fs.writeFileSync(path.join(cache, 'manifest.json'), JSON.stringify(manifest))
  const keys = new Set([...Object.values(manifest.entries), ...Object.values(manifest.cache)].map(item => item?.cacheKey)
    .filter(key => /^[a-f0-9]{64}$/u.test(key)))
  for (const key of keys) {
    try { fs.copyFileSync(path.join(liveCache, `${key}.mp3`), path.join(cache, `${key}.mp3`)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  assert.deepEqual(tts.loadSettings({ root: ttsRoot, env: ttsEnv }), settings)
  return { ttsRoot, ttsEnv }
}

test('canonical content and collection hashing exactly match the Thinky implementation', () => {
  const cases = [null, [], { z: '中文𠮷', a: 1.25, b: [-0, { z: true, a: 'e\u0301' }] },
    { '9': 'numeric-key', '10': 'also numeric', A: 1, a: 2, '𠮷': 3, '中': 4 }]
  for (const value of cases) assert.equal(contentHash(value), authority.contentHash(value))
  const transport = { manifestSha256: 'f'.repeat(64), sourceRevision: 'test',
    books: [{ sourceBookId: 'z', lessons: [{ ordinal: 3 }, { ordinal: 1 }] }, { sourceBookId: 'a', lessons: [] }],
    questions: [{ id: 'z' }, { id: 'a' }], knowledgePoints: [{ id: 'z' }, { id: 'a' }],
    media: [{ sha256: 'f'.repeat(64), kind: 'document', mime: 'application/json' },
      { sha256: 'a'.repeat(64), kind: 'document', mime: 'application/json' }] }
  assert.equal(packageHash(transport), authority.packageHash(transport))
  assert.equal(packageHash(transport), packageHash({ ...transport,
    books: transport.books.toReversed(), questions: transport.questions.toReversed(), media: transport.media.toReversed() }))
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
    Object.assign(config, snapshotTts(base))
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
      assert.equal(sha256(first), path.parse(name).name)
    }
    assert.equal(one.report.books.reduce((sum, book) => sum + book.lessons, 0), 213)
    assert.equal(one.content.questions.length, 1446)
    assert.equal(one.content.knowledgePoints.length, 191)
    assert.equal(one.report.books.reduce((sum, book) => sum + book.pageImages, 0), 478)
    assert.equal(one.report.books.reduce((sum, book) => sum + book.studio, 0), 5)
    const pagesManifest = JSON.parse(fs.readFileSync(path.join(one.outputDir, 'pages-manifest.json'), 'utf8'))
    assert.equal(authority.contract.PagesManifestSchema.safeParse(pagesManifest).success, true)
    assert.equal(one.report.checks.PagesManifestSchema.valid, true)
    const diskReport = JSON.parse(fs.readFileSync(path.join(one.outputDir, 'report.json'), 'utf8'))
    for (const book of pagesManifest.books) {
      const evidence = diskReport.books.find(item => item.sourceBookId === book.sourceBookId)
      assert.equal(evidence.totalPages, book.pages.length)
      assert.equal(evidence.pdfSha256, one.report.inputs.find(file => file.label === `prototype/textbook/${book.sourceBookId}.pdf`).sha256)
      assert.equal(evidence.pages.length, book.pages.length)
      for (const [index, page] of book.pages.entries()) {
        const recorded = evidence.pages[index]
        assert.equal(recorded.physicalPage, page.page)
        assert.equal(page.printedPage, recorded.printedPageNumber === null ? null : String(recorded.printedPageNumber))
        assert.equal(recorded.printedPageEvidence === null, page.printedPage === null)
        if (page.printedPage !== null) assert.ok(recorded.printedPageEvidence.length > 0)
        assert.equal(recorded.mediaPath, `media/${page.sha256}.png`)
        assert.ok(fs.existsSync(path.join(one.outputDir, recorded.mediaPath)))
      }
    }
    assert.equal(pagesManifest.books.find(book => book.sourceBookId === 'g3up-2026').pages[6].printedPage, '1')
    assert.equal(one.report.checks.LessonDefinitionSchema.valid, true)
    assert.equal(one.report.checks.validateLessonDefinition.valid, true)
    assert.equal(one.report.issues.some(issue => /overlap lesson g3down-2026-u101-l02/u.test(issue.message)), false)
    assert.equal(one.report.checks.validateLessonCatalog.valid, true)
    const lessons = one.content.books.flatMap(book => book.lessons.map(lesson => lesson.content))
    assert.ok(lessons.filter(lesson => lesson.level === 'textbook-only' && lesson.cards.length).length > 100,
      'the real catalog must populate textbook-only cards for collection and warmup')
    const originalStudio = require('./studio.cjs').buildStudioLessons(config).patches
    const readingSources = ['up', 'down'].map(term => require(`../../content/reading-prep/chinese-g3${term}-2026.json`))
    const legacyReading = require('./reading-language.cjs').buildReadingLessons({ books: one.content.books, readingBooks: readingSources,
      pronunciationRules: require('../../content/reading-prep/pronunciation-rules.json') }).patches
    const tts = require('./tts-common.cjs')
    const originalEntries = tts.prepareEntries(tts.collectAudioEntries({ ...originalStudio, ...legacyReading }),
      tts.readOverrides(config.ttsRoot), tts.loadSettings({ root: config.ttsRoot, env: config.ttsEnv }))
    const exportedAudio = new Map(one.report.audio.entries.map(entry => [entry.id, entry]))
    for (const entry of originalEntries) {
      assert.equal(exportedAudio.get(entry.id)?.readingText, entry.readingText, `display pinyin changed TTS text: ${entry.id}`)
      assert.equal(exportedAudio.get(entry.id)?.status === 'skipped', Boolean(entry.skipped), `display pinyin changed TTS skip: ${entry.id}`)
    }
    const supplemental = require('../reading-prep/supplemental-pinyin-items.json')
    const familyWords = [...new Set(Object.values(originalStudio).flatMap(lesson => [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])])
      .flatMap(stage => (stage.props.characters || []).flatMap(item => (item.family || []).map(word => word.text || word.word))))].sort()
    assert.deepEqual(supplemental.items.map(item => item.text).sort(), familyWords)
    for (const lesson of lessons) {
      if (lesson.level === 'studio') assert.deepEqual(lesson.cards, originalStudio[lesson.sourceLessonId].cards)
      else assert.ok(lesson.cards.length === 0 || (lesson.cards.length >= 3 && lesson.cards.length <= 8))
    }
    assert.equal(one.report.inputs.filter(file => file.label.startsWith('reading-prep/')).length, 12)
    assert.ok(one.report.inputs.some(file => file.label === 'reading-prep/tts-context-candidates.json'))
    assert.ok(one.report.inputs.some(file => file.label === 'tts-context/tts_context_candidates.py'))
    assert.ok(one.report.inputs.some(file => file.label === 'annotator/annotate_pinyin.py'))
    assert.ok(one.report.inputs.some(file => file.label === 'annotator/supplemental-pinyin-items.json'))
    for (const book of one.report.pinyin.books) for (const kind of ['words', 'characters']) {
      const c = book[kind]
      assert.equal(c.total, c.textbook + c.reviewed + c.dictionary + c.pendingHidden)
      assert.ok(c.dictionary > 0)
      assert.equal(c.pendingHidden, 0, `${book.sourceBookId}/${kind}: all pronunciation decisions are confirmed`)
    }
    assert.deepEqual(one.report.pinyin.reviewSummary, {
      total: 63, pending: 0, confirmed: 63, hide: 0, staleDecisions: 0,
      reasonCounts: { textbookConflict: 16, neutralTone: 30, yiBuTone: 4, polyphonicUnlisted: 13 },
      pendingReasonCounts: { textbookConflict: 0, neutralTone: 0, yiBuTone: 0, polyphonicUnlisted: 0 },
    })
    assert.deepEqual(one.report.pinyin.books.map(({ sourceBookId, words, characters }) => ({ sourceBookId, words, characters })), [
      { sourceBookId: 'chinese-g3up-2026',
        words: { total: 490, textbook: 0, reviewed: 46, dictionary: 444, pendingHidden: 0 },
        characters: { total: 549, textbook: 520, reviewed: 9, dictionary: 20, pendingHidden: 0 } },
      { sourceBookId: 'chinese-g3down-2026',
        words: { total: 486, textbook: 0, reviewed: 66, dictionary: 420, pendingHidden: 0 },
        characters: { total: 517, textbook: 501, reviewed: 3, dictionary: 13, pendingHidden: 0 } },
    ])
    for (const lesson of lessons) for (const stage of [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])]) {
      for (const item of [...(stage.props.words || []), ...(stage.props.characters || []).flatMap(item => [item, ...(item.family || [])])]) {
        assert.equal(Object.hasOwn(item, 'pinyin'), Object.hasOwn(item, 'pinyinSource'))
        if (item.pinyin) assert.ok(['textbook', 'reviewed', 'dictionary'].includes(item.pinyinSource))
      }
    }
    for (const book of one.report.books) {
      const items = lessons.filter(lesson => one.content.books.find(b => b.sourceBookId === book.sourceBookId).lessons.some(l => l.content.sourceLessonId === lesson.sourceLessonId))
      assert.equal(book.lessonsWithCards, items.filter(lesson => lesson.cards.length).length)
      assert.equal(book.cardCount, items.reduce((sum, lesson) => sum + lesson.cards.length, 0))
      assert.equal(book.noCardLessons.length, book.lessons - book.lessonsWithCards)
      assert.ok(book.noCardLessons.every(lesson => lesson.reasons.length > 0))
    }
    assert.equal(one.report.cards.provenance.length, lessons.filter(lesson => lesson.level === 'textbook-only').reduce((sum, lesson) => sum + lesson.cards.length, 0))
    for (const lesson of lessons) {
      assert.doesNotMatch(lesson.bookPageLabel, /PDF/u, lesson.sourceLessonId)
      const range = lesson.bookPageLabel.match(/第\s*(\d+)\s*–\s*(\d+)\s*页/u)
      if (range) assert.notEqual(Number(range[1]), Number(range[2]), lesson.sourceLessonId)
    }
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l02').textbookPages, { from: 86, to: 88 })
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'g3down-2026-u101-l03').textbookPages, { from: 88, to: 91 })
    assert.deepEqual(lessons.find(lesson => lesson.sourceLessonId === 'chinese-g3down-2026-u4-kp7').textbookPages, { from: 60, to: 60 })
    assert.equal(lessons.filter(lesson => lesson.level === 'textbook-only').every(lesson => !lesson.opening && !lesson.takeaways), true)
    assert.equal(lessons.filter(lesson => lesson.level === 'textbook-only' && lesson.basicStages).length, 59)
    assert.ok(lessons.filter(lesson => lesson.lessonKind === 'activity' || lesson.subject === 'math')
      .filter(lesson => lesson.level !== 'studio').every(lesson => !lesson.basicStages))
    assert.deepEqual(one.report.chineseBasicStages.books.map(book => [book.numberedSourceLessons, book.numberedLessons, book.lessonsWithBasicStages]),
      [[26, 30, 30], [27, 31, 31]])
    assert.match(fs.readFileSync(path.join(one.outputDir, 'report.md'), 'utf8'), /三年级语文基础关覆盖/u)
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

    assert.equal(one.report.interactions.length, 9)
    assert.equal(one.report.interactions.some(item => item.widget === 'concept-card'), false)
    assert.equal(one.report.checks.LessonAuthoringSchema.valid, true)
    assert.equal(one.report.checks.MediaManifestSchema.valid, true)
    assert.equal(one.report.strokeData.covered.length, 12)
    assert.ok(one.report.strokeData.missing.length > 200)
    for (const book of one.report.chineseBasicStages.books)
      assert.ok(book.missingStrokeCharacters.every(char => one.report.strokeData.missing.includes(char)))
    assert.equal(one.report.assets.strokeDocuments, 12)
    assert.equal(one.media.media.filter(item => item.kind === 'document').length, 12)
    assert.deepEqual(one.content.media, one.media.media.filter(item => ['document', 'audio'].includes(item.kind))
      .map(({ sha256, kind, mime }) => ({ sha256, kind, mime })))
    const packagedLessons = one.content.books.flatMap(book => book.lessons)
    assert.deepEqual(packagedLessons.filter(lesson => lesson.authoring).map(lesson =>
      [lesson.content.sourceLessonId, lesson.authoring.widgetGradings.map(item => item.stageKey)]), [
      ['g3up-2026-u3-l01', ['extension-1', 'extension-3']],
      ['g3down-2026-u1-l01', ['basic-1', 'basic-2', 'extension-2']],
      ['chinese-g3up-2026-u1-kp1', ['extension-2', 'extension-3']],
    ])
    for (const lesson of packagedLessons) {
      const authoring = one.authorings[lesson.content.sourceLessonId]
      assert.deepEqual(lesson.authoring, authoring?.widgetGradings.length ? authoring : undefined)
    }
    const legacy = structuredClone(one.content)
    delete legacy.media
    for (const book of legacy.books) for (const lesson of book.lessons) delete lesson.authoring
    legacy.manifestSha256 = authority.packageHash(legacy)
    const legacyIssues = authority.validateContentPackage(legacy).report.issues
    const audioFiles = one.content.media.filter(item => item.kind === 'audio').length
    assert.equal(legacyIssues.length, 19 + audioFiles)
    assert.equal(legacyIssues.filter(issue => /Missing stroke document metadata/.test(issue.message)).length, 12)
    assert.equal(legacyIssues.filter(issue => /Missing audio metadata/.test(issue.message)).length, audioFiles)
    assert.equal(legacyIssues.filter(issue => /requires complete private grading/.test(issue.message)).length, 7)
    for (const lesson of packagedLessons.filter(lesson => lesson.authoring)) {
      for (const { stageKey } of lesson.authoring.widgetGradings) {
        const incomplete = structuredClone(one.content)
        const target = incomplete.books.flatMap(book => book.lessons)
          .find(item => item.content.sourceLessonId === lesson.content.sourceLessonId)
        const { grading } = target.authoring.widgetGradings.find(item => item.stageKey === stageKey).content
        if (grading.items) grading.items.shift()
        else if (grading.shapes) delete grading.shapes[Object.keys(grading.shapes)[0]]
        else if (grading.detective) delete grading.detective[Object.keys(grading.detective)[0]]
        else delete grading.characters[Object.keys(grading.characters)[0]]
        incomplete.manifestSha256 = authority.packageHash(incomplete)
        const report = authority.validateContentPackage(incomplete).report
        assert.equal(report.valid, false, `${lesson.content.sourceLessonId}/${stageKey}`)
        const expected = grading.items
          ? /(?:Choice|Comparison) grading must match all item IDs/
          : new RegExp(`^Activity ${stageKey} requires complete private grading$`)
        assert.ok(report.issues.some(issue => issue.path.includes('.authoring') && expected.test(issue.message)),
          `${lesson.content.sourceLessonId}/${stageKey}: ${JSON.stringify(report.issues)}`)
      }
    }
    const changedPrivate = structuredClone(one.content)
    changedPrivate.books[0].lessons[11].authoring.widgetGradings[0].content.grading.items[0].explanation += ' changed'
    assert.notEqual(authority.packageHash(changedPrivate), one.content.manifestSha256)
    const cli = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only',
      '-r', 'tsconfig-paths/register', 'scripts/content-sync/cli.ts', 'validate', one.outputDir], {
      cwd: config.thinkyRoot, env: { ...process.env, NODE_ENV: 'learning-local' }, encoding: 'utf8',
    })
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`)
    const cliOutput = cli.stdout
    assert.match(cliOutput, /VALID: package accepted/)
    assert.doesNotMatch(cliOutput, /ERROR /)
    assert.equal(one.media.media.filter(item => item.kind === 'image').length,
      new Set(pagesManifest.books.flatMap(book => book.pages.map(page => page.sha256))).size)
    for (const [id, authoring] of Object.entries(one.authorings)) {
      const stored = JSON.parse(fs.readFileSync(path.join(one.outputDir, `authoring.${id}.json`), 'utf8'))
      assert.deepEqual(stored, authoring)
      assert.equal(authority.contract.LessonAuthoringSchema.safeParse(stored).success, true)
      assert.deepEqual(stored.definition, lessons.find(lesson => lesson.sourceLessonId === id))
      for (const stage of [...authoring.definition.basicStages, ...authoring.definition.extension.stages]) {
        assert.doesNotMatch(JSON.stringify(stage.props), /"(?:grading|answer|optionExplanations|correctPartId|symmetric|feedback)":/u)
        for (const character of stage.props.characters ?? []) {
          if (stage.widget !== 'hanzi-write') continue
          const ref = character.strokeData
          assert.equal(ref.kind, 'document')
          const item = one.media.media.find(item => item.sha256 === ref.sha256)
          assert.equal(item.mime, 'application/json')
          const bytes = fs.readFileSync(path.join(one.outputDir, item.path))
          assert.equal(sha256(bytes), ref.sha256)
          assert.equal(bytes.length, item.byteLength)
          const strokes = JSON.parse(bytes)
          assert.equal(strokes.strokes.length, strokes.medians.length)
        }
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(one.outputDir, 'Make-Me-a-Hanzi-LICENSE.txt')),
      fs.readFileSync(path.join(config.siteDir, 'vendor/hanzi-writer-data-ARPHICPL.txt')))
    for (const question of one.content.questions)
      assert.doesNotMatch(JSON.stringify(question.payload.question), /output\/.*\.json#/u)
    assert.ok(one.report.questionProvenance.every(item => item.locator.startsWith('output/')))
    const sourceEntries = one.media.media.map(item => ({ sha256: item.sha256, sourcePath: path.join(one.outputDir, item.path) }))
    const validateFull = (authorings = one.authorings, manifest = one.media) =>
      validateExport(one.content, authority, [], pagesManifest, authorings, manifest, sourceEntries)
    assert.equal(validateFull().valid, true)
    const badPrivate = structuredClone(one.authorings)
    badPrivate['g3up-2026-u3-l01'].widgetGradings[0].content.grading.items[0].answer = '未定义的单位'
    assert.equal(validateFull(badPrivate).checks.LessonAuthoringSchema.valid, false)
    const badBinding = structuredClone(one.authorings)
    badBinding['g3up-2026-u3-l01'].widgetGradings[0].content.props.items[0].prompt = '不相同的题面'
    assert.equal(validateFull(badBinding).valid, false)
    const badMedia = structuredClone(one.media)
    badMedia.media.find(item => item.kind === 'document').byteLength += 1
    assert.equal(validateFull(one.authorings, badMedia).checks.MediaManifestSchema.valid, false)
    const noDocuments = structuredClone(one.media)
    noDocuments.media = noDocuments.media.filter(item => item.kind !== 'document')
    assert.equal(validateFull(one.authorings, noDocuments).checks.MediaManifestSchema.valid, false)
    const noImages = structuredClone(one.media)
    noImages.media = noImages.media.filter(item => item.kind !== 'image')
    assert.equal(validateFull(one.authorings, noImages).checks.MediaManifestSchema.valid, false)

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
    assert.equal(validateExport(one.content, authority, one.report.questionContractIssues, pagesManifest).valid, one.report.valid)
    const badManifests = [
      value => value.books[0].totalPages = 8,
      value => value.books[0].pdfSha256 = 'a'.repeat(64),
      value => value.books[0].pages[0].physicalPage = 1,
      value => value.books[0].pages[0].printedPageNumber = null,
      value => value.books[0].pages[0].printedPageEvidence = 'evidence',
      value => value.books[0].pages[0].mediaPath = 'media/page.png',
      value => value.books[0].pages[0].printedPage = 1,
      value => value.books[0].pages[0].printedPage = '1'.repeat(17),
    ]
    for (const mutate of badManifests) {
      const invalid = structuredClone(pagesManifest)
      mutate(invalid)
      const result = validateExport(one.content, authority, [], invalid)
      assert.equal(result.valid, false)
      assert.equal(result.checks.ContentPackageSchema.valid, true)
      assert.equal(result.checks.PagesManifestSchema.valid, false)
      assert.ok(result.issues.some(issue => issue.path.startsWith('pages-manifest.books.0')))
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

test('extra manifest fields block a valid package and are written to both reports', t => {
  const base = path.join(WORKTREE, '.local/learning-export', `.invalid-manifest-${randomUUID()}`)
  const schema = authority.contract.PagesManifestSchema
  const safeParse = schema.safeParse.bind(schema)
  // Inject an exporter regression at the manifest boundary; the real schema still validates it.
  t.mock.method(schema, 'safeParse', manifest => {
    manifest.books[0].pages[0].mediaPath = `media/${manifest.books[0].pages[0].sha256}.png`
    return safeParse(manifest)
  })
  try {
    const result = exportContent({ ...options([]), ...snapshotTts(base), outputRoot: base })
    assert.equal(result.report.valid, false)
    assert.equal(result.report.checks.validateContentPackage.valid, true)
    assert.equal(result.report.checks.PagesManifestSchema.valid, false)
    assert.equal(fs.existsSync(path.join(result.outputDir, 'package.json')), false)
    assert.equal(fs.existsSync(path.join(result.outputDir, 'candidate-package.json')), true)
    const report = JSON.parse(fs.readFileSync(path.join(result.outputDir, 'report.json'), 'utf8'))
    assert.equal(report.valid, false)
    assert.ok(report.issues.some(issue => issue.path === 'pages-manifest.books.0.pages.0' && /mediaPath/.test(issue.message)))
    assert.match(fs.readFileSync(path.join(result.outputDir, 'report.md'), 'utf8'), /pages-manifest\.books\.0\.pages\.0: .*mediaPath/)
    const manifest = JSON.parse(fs.readFileSync(path.join(result.outputDir, 'pages-manifest.json'), 'utf8'))
    assert.equal(safeParse(manifest).success, false)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
