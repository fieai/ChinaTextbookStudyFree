#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { execFileSync } = require('node:child_process')
const { loadAuthority } = require('./authority.cjs')
const { loadCatalog, buildCatalog, bookPageLabel } = require('./catalog.cjs')
const { loadSourceQuestions, buildQuestions } = require('./questions.cjs')
const { buildStudioLessons } = require('./studio.cjs')
const { inspectPages, materializeMedia, inputFingerprint } = require('./pages.cjs')
const { statistics, sharedEndpoints, markdownReport } = require('./report.cjs')
const { validateExport } = require('./validate.cjs')
const { readStrokeDocuments, strokeCoverage, STROKE_NOTICE } = require('./strokes.cjs')
const { mediaManifest } = require('./media.cjs')
const { inputFile, readJson, jsonBytes, contentHash, packageHash, compare, requireCondition: check } = require('./common.cjs')

const WORKTREE = path.resolve(__dirname, '../..')
const MAIN_READ_ONLY = path.resolve(WORKTREE, '../ChinaTextbookStudyFree')
const DEFAULT_THINKY = '/Users/my-project/AI-PROJECT/thinky'
const DEFAULT_EVIDENCE_ROOT = '/Users/my-project/AI-PROJECT/thinky'
const SITE_RELATIVE = 'deploy-output/family-learning-share-20261027-button-stability/site'
const RESTORED_INTERACTIONS = {
  'g3up-2026-u3-l01': ['extension-1', 'extension-3'],
  'chinese-g3up-2026-u1-kp1': ['basic-4', 'basic-6', 'extension-2', 'extension-4'],
  'chinese-g3down-2026-u1-kp1': ['extension-1', 'extension-3', 'extension-4'],
}

function options(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    'source-root': { type: 'string' }, 'site-dir': { type: 'string' },
    'thinky-root': { type: 'string', default: env.THINKY_ROOT || DEFAULT_THINKY },
    'evidence-root': { type: 'string', default: env.THINKY_ROOT || DEFAULT_EVIDENCE_ROOT },
    'output-root': { type: 'string', default: path.join(WORKTREE, '.local/learning-export') },
    'validate': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  } })
  const sourceRoot = values['source-root'] ?? (fs.existsSync(path.join(WORKTREE, SITE_RELATIVE)) ? WORKTREE : MAIN_READ_ONLY)
  return {
    ...values, sourceRoot: path.resolve(sourceRoot),
    siteDir: path.resolve(values['site-dir'] ?? path.join(sourceRoot, SITE_RELATIVE)),
    thinkyRoot: path.resolve(values['thinky-root']),
    evidenceDir: path.resolve(values['evidence-root'], 'docs/learning/evidence/wp-10'),
    dataDir: path.resolve(values['evidence-root'], '.local/wp-10'),
    outputRoot: path.resolve(values['output-root']),
  }
}

function guardedOutput(outputRoot) {
  outputRoot = path.resolve(outputRoot)
  const allowed = path.join(WORKTREE, '.local/learning-export')
  check(outputRoot === allowed || outputRoot.startsWith(`${allowed}/`), `Output must stay inside ${allowed}`)
  let existing = outputRoot
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const real = fs.realpathSync(existing)
  const root = fs.realpathSync(WORKTREE)
  check(real === root || real.startsWith(`${root}/`), 'Output ancestor resolves outside the worktree')
  // No output symlink may alias the read-only main checkout or another input directory.
  let current = outputRoot
  while (current !== WORKTREE) {
    check(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(), `Output symlink rejected: ${current}`)
    current = path.dirname(current)
  }
}

function exportContent(config) {
  guardedOutput(config.outputRoot)
  const authority = loadAuthority(config.thinkyRoot)
  check(authority.contract.LessonAuthoringSchema, 'Thinky contract dist missing LessonAuthoringSchema; coordinator must build contract v1.6 part two')
  const inputFiles = []
  const addInput = (label, filename) => {
    const file = inputFile(label, filename)
    inputFiles.push(file)
    return file
  }
  const data = loadCatalog({ ...config, addInput })
  const strokes = readStrokeDocuments(config)
  const studio = buildStudioLessons({ ...config, strokeDataByCharacter: strokes.references })
  inputFiles.push(...strokes.inputFiles)
  for (const filename of studio.inputFiles) addInput(filename.startsWith(config.siteDir) ? `prototype/${path.basename(filename)}` : `evidence/${path.basename(filename)}`, filename)
  for (const name of ['lesson-guides.js', 'question-bank.js']) {
    const file = addInput(`prototype/${name}`, path.join(config.siteDir, name))
    check(file.sha256 === data.catalog.provenance.files.find(item => item.path === `prototype/${name}`)?.sha256, `Frozen prototype SHA256 mismatch: ${name}`)
  }
  check(inputFiles.find(file => file.label === 'prototype/lesson-studio.js').sha256 === data.catalog.provenance.files.find(item => item.path === 'prototype/lesson-studio.js')?.sha256, 'Frozen lesson-studio SHA256 mismatch')
  for (const name of ['inference_v1.py', 'numeric_inference_v1.py', 'pdf-toc-chinese-ocr.txt', 'math-lessons/question-assignment.md'])
    addInput(`evidence/${name}`, path.join(config.evidenceDir, name))
  const sourceRecords = loadSourceQuestions({ ...config, catalog: data.catalog, addInput })
  const firstCatalog = buildCatalog({ ...data, patches: studio.patches, questions: [], assignment: { ...data.assignment, practiceReferences: [] } })
  const questionResult = buildQuestions({ records: sourceRecords, assignment: data.assignment, catalog: data.catalog,
    evidenceDir: config.evidenceDir, contract: authority.contract, knowledgePoints: firstCatalog.knowledgePoints })
  const contentCatalog = buildCatalog({ ...data, patches: studio.patches, questions: questionResult.questions })
  const pageResult = inspectPages({ ...config, books: data.raw.books })
  for (const book of contentCatalog.books) {
    const pages = pageResult.manifest.books.find(item => item.sourceBookId === book.sourceBookId).pages
    for (const { content: lesson } of book.lessons) {
      lesson.bookPageLabel = bookPageLabel(pages, lesson.textbookPages)
      if (lesson.homework.questionRefs.length)
        lesson.homework.notice = '本组练习来自题库；课本原题请查看教材原页。'
    }
  }
  inputFiles.push(...pageResult.inputFiles)
  for (const filename of authority.inputPaths) addInput(`thinky/${path.relative(config.thinkyRoot, filename)}`, filename)
  for (const name of fs.readdirSync(__dirname).filter(name => /\.(cjs|py)$/u.test(name) && !name.endsWith('.test.cjs')).sort(compare))
    addInput(`exporter/${name}`, path.join(__dirname, name))
  const unique = new Map()
  for (const file of inputFiles) {
    const prior = unique.get(file.label)
    check(!prior || prior.sha256 === file.sha256, `Input changed while reading: ${file.label}`)
    unique.set(file.label, file)
  }
  const inputs = [...unique.values()].sort((a, b) => compare(a.label, b.label))
  const inputSha256 = contentHash({ files: inputFingerprint(inputs) })
  const head = execFileSync('git', ['-C', WORKTREE, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  const sourceRevision = `${head}-${inputSha256.slice(0, 20)}`
  const content = { schemaVersion: 1, sourceSystem: 'china-textbook-study-free', sourceRevision,
    manifestSha256: '0'.repeat(64), ...contentCatalog, questions: questionResult.questions }
  const authorings = Object.fromEntries(content.books.flatMap(book => book.lessons)
    .filter(lesson => lesson.content.level === 'studio')
    .map(lesson => [lesson.content.sourceLessonId, { definition: lesson.content,
      widgetGradings: studio.widgetGradings?.[lesson.content.sourceLessonId] ?? [] }]))
  // content-sync consumes private grading from the package, not exporter sidecar files.
  // Lessons without graded activities omit authoring: Thinky rejects an empty sidecar.
  for (const book of content.books) for (const lesson of book.lessons) {
    const authoring = authorings[lesson.content.sourceLessonId]
    if (authoring?.widgetGradings.length) lesson.authoring = authoring
  }
  const coverage = strokeCoverage(content, strokes)
  const documents = strokes.documents.filter(item => coverage.required.includes(item.char))
  const mediaSources = [...pageResult.mediaSources, ...documents]
  const media = mediaManifest(pageResult, documents)
  if (documents.length) content.media = media.media.filter(item => item.kind === 'document')
    .map(({ sha256, kind, mime }) => ({ sha256, kind, mime }))
  content.manifestSha256 = authority.packageHash(content)
  check(packageHash(content) === content.manifestSha256, 'Independent package hash differs from Thinky authority')
  const validation = validateExport(content, authority, questionResult.contractIssues, pageResult.manifest, authorings, media, mediaSources)
  const warnings = [...validation.warnings, ...pageResult.warnings, ...questionResult.warnings, ...sharedEndpoints(content)]
  for (const book of content.books) {
    const lessons = book.lessons.filter(lesson => !lesson.content.homework.questionRefs.length).map(lesson => lesson.content.sourceLessonId)
    if (lessons.length) warnings.push({ code: 'NO_HOMEWORK', sourceBookId: book.sourceBookId, lessons,
      message: `${book.sourceBookId} 无题目引用的课时：${lessons.join('、')}；保留空引用，不编造题目。` })
  }
  const prototypeQuestions = Object.entries(studio.prototypeQuestionSets).flatMap(([sourceLessonId, items]) => items.map(item => ({
    sourceLessonId, authorId: item.id, prompt: item.q, sourceLabel: item.source,
    matchingImportedQuestionIds: content.questions.filter(question => question.sourceLessonId === sourceLessonId
      && question.payload.question.prompt === item.q).map(question => question.id),
  })))
  warnings.push({ code: 'PROTOTYPE_QUESTION_COVERAGE',
    message: `${prototypeQuestions.filter(item => !item.matchingImportedQuestionIds.length).length} 道原型手工题不在已确认源题归属中；未编写缺失分值、视觉任务或源类型适配规则，详见 prototypeQuestions。` })
  warnings.push({ code: 'PROTOTYPE_VARIANTS_NOT_IMPORTED',
    message: '原型 VARIANT_SETS 的动态变式绑定已追溯记录，但未把默认题快照写成静态 variants；详见 prototypeVariantGenerators。' })
  const report = {
    schemaVersion: 1, sourceRevision, inputSha256,
    manifestSha256: content.manifestSha256, pagesManifestSha256: contentHash(pageResult.manifest),
    valid: validation.valid && questionResult.contractIssues.length === 0,
    checks: { ...validation.checks, packageHashAuthorityParity: { valid: true },
      frozenInputs: { valid: true, count: inputs.length }, pageInventory: { valid: true, count: pageResult.mediaSources.length } },
    issues: validation.issues, questionContractIssues: questionResult.contractIssues,
    warnings, gaps: [...studio.gaps,
      '统一媒体清单 media-manifest.json 为导出器 sidecar；content-sync 从 package.json.media 读取笔顺文档元数据，从 PagesManifest 读取页图。'],
    interactions: content.books.flatMap(book => book.lessons).flatMap(({ content: lesson }) =>
      [...(lesson.basicStages ?? []), ...(lesson.extension?.stages ?? [])]
        .filter(stage => RESTORED_INTERACTIONS[lesson.sourceLessonId]?.includes(stage.key))
        .map(stage => ({ sourceLessonId: lesson.sourceLessonId, stageKey: stage.key, title: stage.title,
          widget: stage.widget, ...(stage.props.activity ? { activity: stage.props.activity } : {}),
          ...(stage.props.presentation ? { presentation: stage.props.presentation } : {}) }))),
    strokeData: coverage,
    authoringFiles: Object.keys(authorings).map(id => `authoring.${id}.json`),
    authoringSha256: Object.fromEntries(Object.entries(authorings).map(([id, value]) => [id, contentHash(value)])),
    mediaManifestSha256: contentHash(media),
    books: statistics(content, pageResult.manifest, pageResult.bookEvidence),
    assets: { physicalPages: pageResult.mediaSources.length,
      strokeDocuments: documents.length, uniqueMediaFiles: media.media.length },
    inputs, questionProvenance: questionResult.provenance,
    prototypeQuestions, prototypeVariantGenerators: studio.variantGenerators,
  }
  // A concurrent source edit must not be attributed to a previously hashed sourceRevision.
  for (const file of inputs) check(inputFile(file.label, file.path).sha256 === file.sha256, `Input changed during export: ${file.label}`)
  const outputDir = path.join(config.outputRoot, sourceRevision)
  guardedOutput(outputDir)
  guardedOutput(path.join(outputDir, 'media'))
  fs.mkdirSync(outputDir, { recursive: true })
  for (const name of ['package.json', 'candidate-package.json', 'pages-manifest.json', 'media-manifest.json', 'report.json', 'report.md',
    ...report.authoringFiles, 'Make-Me-a-Hanzi-LICENSE.txt', 'Make-Me-a-Hanzi-NOTICE.txt']) {
    const filename = path.join(outputDir, name)
    check(!fs.existsSync(filename) || fs.lstatSync(filename).isFile(), `Output symlink or non-file rejected: ${filename}`)
  }
  materializeMedia({ outputDir, mediaSources })
  atomicWrite(path.join(outputDir, report.valid ? 'package.json' : 'candidate-package.json'), jsonBytes(content))
  atomicWrite(path.join(outputDir, 'pages-manifest.json'), jsonBytes(pageResult.manifest))
  atomicWrite(path.join(outputDir, 'media-manifest.json'), jsonBytes(media))
  for (const [id, authoring] of Object.entries(authorings))
    atomicWrite(path.join(outputDir, `authoring.${id}.json`), jsonBytes(authoring))
  atomicWrite(path.join(outputDir, 'Make-Me-a-Hanzi-LICENSE.txt'), strokes.licenseBytes)
  atomicWrite(path.join(outputDir, 'Make-Me-a-Hanzi-NOTICE.txt'), STROKE_NOTICE)
  atomicWrite(path.join(outputDir, 'report.json'), jsonBytes(report))
  atomicWrite(path.join(outputDir, 'report.md'), markdownReport(report))
  return { outputDir, report, content, authorings, media }
}

function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${require('node:crypto').randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    fs.renameSync(temporary, filename)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function main() {
  const config = options()
  if (config.help) {
    console.log('node scripts/learning-export/index.cjs [--source-root DIR] [--site-dir DIR] [--thinky-root DIR] [--evidence-root DIR] [--output-root .local/learning-export/...]\nnode scripts/learning-export/index.cjs --validate PACKAGE_JSON')
    return
  }
  if (config.validate) {
    const directory = path.dirname(path.resolve(config.validate))
    const content = readJson(config.validate)
    const authorings = Object.fromEntries(content.books.flatMap(book => book.lessons)
      .filter(lesson => lesson.content.level === 'studio').map(lesson => [lesson.content.sourceLessonId,
        readJson(path.join(directory, `authoring.${lesson.content.sourceLessonId}.json`))]))
    const media = readJson(path.join(directory, 'media-manifest.json'))
    const authority = loadAuthority(config.thinkyRoot)
    require('./media.cjs').mediaManifestSchema(authority).parse(media)
    const mediaSources = media.media.map(item => ({ sha256: item.sha256, sourcePath: path.join(directory, item.path) }))
    const report = validateExport(content, authority, [], readJson(path.join(directory, 'pages-manifest.json')), authorings, media, mediaSources)
    console.log(jsonBytes(report))
    if (!report.valid) process.exitCode = 1
    return
  }
  const result = exportContent(config)
  console.log(jsonBytes({ outputDir: result.outputDir, valid: result.report.valid,
    sourceRevision: result.report.sourceRevision, books: result.report.books.map(book => ({
      sourceBookId: book.sourceBookId, lessons: book.lessons, studio: book.studio, textbookOnly: book.textbookOnly,
      questions: book.questions, knowledgePoints: book.knowledgePoints, pageImages: book.pageImages,
      missingPrintedPageCount: book.missingPrintedPages.length,
    })),
    issues: result.report.issues.length, warnings: result.report.warnings.length, gaps: result.report.gaps.length }))
  if (!result.report.valid) process.exitCode = 1
}

if (require.main === module) {
  try { main() } catch (error) {
    console.error(`Export blocked: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { WORKTREE, options, guardedOutput, exportContent }
