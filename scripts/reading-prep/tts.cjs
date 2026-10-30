#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArgs, isDeepStrictEqual } = require('node:util')
const { readBook, entriesFor } = require('./build.cjs')
const { runTts } = require('../learning-export/tts-elevenlabs.cjs')
const ROOT = path.resolve(__dirname, '../..')
const KINDS = new Set(['whole', 'part', 'sentence', 'character', 'word'])
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'))
const check = (value, message) => { if (!value) throw new Error(message) }
const lessonId = entry => `${entry.bookId}/lesson-${entry.lessonKey}`
const list = value => Array.isArray(value) ? value.flatMap(item => item.split(',')) : value?.split(',')

function cliOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    generate: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, book: { type: 'string', multiple: true },
    lesson: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'string' },
    concurrency: { type: 'string', default: '2' }, manifest: { type: 'string' },
    'output-dir': { type: 'string' }, 'cache-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  check(!(values.generate && values['dry-run']), '--generate 与 --dry-run 不能同时使用')
  const concurrency = Number(values.concurrency)
  const limit = values.limit === undefined ? undefined : Number(values.limit)
  check(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16, '并发数必须为 1 至 16')
  check(limit === undefined || Number.isSafeInteger(limit) && limit > 0, 'limit 必须为正整数')
  const kinds = list(values.kind), books = list(values.book)
  check(!kinds || kinds.length && kinds.every(kind => KINDS.has(kind)), 'kind 必须为 whole,part,sentence,character,word 的组合')
  if (values.lesson && !values.lesson.includes('/lesson-'))
    check(books?.length === 1, '--lesson 使用课号键时必须指定单册 --book')
  return { root: ROOT, generate: values.generate === true, books, lesson: values.lesson, kinds, limit, concurrency,
    manifestPath: values.manifest && path.resolve(values.manifest),
    outputDir: values['output-dir'] && path.resolve(values['output-dir']),
    cacheDir: values['cache-dir'] && path.resolve(values['cache-dir']), help: values.help }
}

function loadNarration({ root = ROOT, manifestPath = path.join(root, '.local/reading-prep/review/narration-manifest.json'),
  readBookImpl = readBook } = {}) {
  check(fs.existsSync(manifestPath), '找不到课文清单，请先运行 node scripts/reading-prep/build.cjs')
  const manifest = readJson(manifestPath)
  const inventory = readJson(path.join(root, 'content/reading-prep/inventory.json'))
  check(inventory.schemaVersion === 1 && Array.isArray(inventory.books) && inventory.books.length, '教材目录格式无效')
  const declared = inventory.books.map(book => book.bookId)
  check(new Set(declared).size === declared.length, '教材目录 ID 重复')
  check(manifest.schemaVersion === 1 && manifest.providerCalled === false && manifest.partial === false
    && manifest.purpose === 'text-preparation-only' && Array.isArray(manifest.entries), '课文清单格式无效或不是完整审定清单')
  check(isDeepStrictEqual(manifest.declaredBookIds, declared) && isDeepStrictEqual(manifest.includedBookIds, declared), '课文清单教材范围已变化，请重新 build')
  const books = inventory.books.map(source => {
    check(source.status === 'prepared', `${source.bookId}: 教材尚未准备完成`)
    const book = readBookImpl(source.bookId, source.expectedLessonCount, source.expectedPhonicsCount || 0)
    check(book.bookId === source.bookId && book.source.sha256 === source.sha256
      && book.source.pdfPath === source.pdfPath && book.source.pageCount === source.pageCount, `${source.bookId}: 教材来源与目录不一致`)
    check(fs.existsSync(source.pdfPath) && hash(fs.readFileSync(source.pdfPath)) === source.sha256, `${source.bookId}: 来源 PDF 哈希已变化`)
    check(book.lessons.length === source.expectedLessonCount, `${source.bookId}: 课数与目录不一致`)
    check(book.lessons.every(lesson => lesson.status === 'reviewed' && !lesson.issues?.length), `${source.bookId}: 仍有未审定课文`)
    return book
  })
  const expected = books.flatMap(book => book.lessons.flatMap(lesson => entriesFor(book, lesson)))
  const expectedMap = new Map(expected.map(entry => [entry.id, entry]))
  check(expectedMap.size === expected.length && manifest.entries.length === expected.length, '课文清单条目数已变化，请重新 build')
  const seen = new Set()
  for (const entry of manifest.entries) {
    check(entry && !seen.has(entry.id), '课文清单 ID 缺失或重复')
    seen.add(entry.id)
    check(entry.reviewStatus === 'reviewed' && entry.readyForSynthesis === true, `${entry.id}: 文字尚未审定`)
    check(typeof entry.text === 'string' && entry.text.trim() && entry.textSha256 === hash(entry.text), `${entry.id}: 原文哈希无效`)
    check(isDeepStrictEqual(entry, expectedMap.get(entry.id)), `${entry.id}: 清单与编辑源稿不同，请重新 build`)
  }
  return { manifest, books, entries: manifest.entries, manifestPath, manifestSha256: hash(fs.readFileSync(manifestPath)) }
}

function selectEntries(entries, { books, lesson, kinds, limit } = {}) {
  if (books) for (const bookId of books)
    check(entries.some(entry => entry.bookId === bookId), `未找到教材 ${bookId}`)
  let selected = books ? entries.filter(entry => books.includes(entry.bookId)) : entries
  if (lesson) {
    if (!lesson.includes('/lesson-')) check(books?.length === 1, '--lesson 使用课号键时必须指定单册 --book')
    const fullId = lesson.includes('/lesson-') ? lesson : `${books[0]}/lesson-${lesson}`
    selected = selected.filter(entry => lessonId(entry) === fullId)
    check(selected.length, '未找到指定课程；请使用清单中的稳定 lessonKey')
  }
  if (kinds) {
    check(kinds.length && kinds.every(kind => KINDS.has(kind)), 'kind 范围无效')
    selected = selected.filter(entry => kinds.includes(entry.kind))
  }
  if (limit !== undefined) {
    check(Number.isSafeInteger(limit) && limit > 0, 'limit 必须为正整数')
    selected = selected.slice(0, limit)
  }
  check(selected.length, '筛选范围内没有可准备的配音条目')
  return selected
}

function groupStats(entries, field) {
  const groups = new Map()
  for (const entry of entries) {
    const key = entry[field]
    if (!groups.has(key)) groups.set(key, { key, entries: 0, active: 0, blocked: 0, cached: 0, pending: 0, characters: 0, keys: new Set() })
    const row = groups.get(key)
    row.entries++
    if (entry.skipped) { row.blocked++; continue }
    row.active++
    row.cached += Number(entry.cached)
    row.pending += Number(!entry.cached)
    row.characters += entry.charCount
    if (!entry.cached) row.keys.add(entry.cacheKey)
  }
  return [...groups.values()].map(({ keys, ...row }) => ({ ...row, uniqueNewRequests: keys.size }))
}

function writeJson(filename, value) { fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`) }

async function runReadingTts(options = {}) {
  const { root = ROOT, generate = false, env = process.env,
    outputDir = path.join(root, '.local/reading-prep/tts-plan'), cacheDir = path.join(root, '.local/tts-cache'),
    fetchImpl = globalThis.fetch, log = console.log } = options
  const source = loadNarration({ root, manifestPath: options.manifestPath, readBookImpl: options.readBookImpl })
  const selected = selectEntries(source.entries, options)
  const prepare = options.preparePronunciationImpl || require('./pronunciation.cjs').preparePronunciation
  const pronunciation = prepare(selected, source.books)
  check(Array.isArray(pronunciation.entries) && pronunciation.entries.length === selected.length, '发音准备条目数量无效')
  const selectedMap = new Map(selected.map(entry => [entry.id, entry]))
  const preparedIds = new Set()
  const rawEntries = pronunciation.entries.map(entry => {
    const original = selectedMap.get(entry.id)
    check(original && !preparedIds.has(entry.id) && entry.text === original.text
      && entry.bookId === original.bookId && entry.lessonKey === original.lessonKey
      && entry.kind === original.kind, '发音准备改变原文或条目 ID')
    preparedIds.add(entry.id)
    return { ...entry, lessonId: lessonId(entry), supportsAudio: false,
      skipped: entry.skipped || Boolean(entry.pronunciation?.blockers?.length) }
  })
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  // Passing a throwing transport makes accidental provider calls fail closed in dry-run.
  let providerAttempts = 0
  const transport = generate ? (...args) => { providerAttempts++; return fetchImpl(...args) }
    : () => { throw new Error('离线计划禁止调用语音服务') }
  const result = await runTts({ root, env, rawEntries, entryOverrides: pronunciation.overrides,
    dryRun: !generate, concurrency: options.concurrency ?? 2, cacheDir, fetchImpl: transport,
    planPath: path.join(outputDir, 'plan.json'), resultPath: path.join(outputDir, 'result.json'),
    log: () => {}, ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}) })
  const rawMap = new Map(rawEntries.map(entry => [entry.id, entry]))
  const entries = result.plan.entries.map(entry => ({ ...rawMap.get(entry.id), ...entry,
    textReviewed: rawMap.get(entry.id).readyForSynthesis === true,
    readyForSynthesis: !entry.skipped }))
  const blocked = entries.filter(entry => entry.skipped)
  const reviews = entries.filter(entry => entry.pronunciation?.review?.length)
  const plan = { ...result.plan, purpose: generate ? 'reading-audio-generation' : 'reading-audio-plan-only',
    dryRun: !generate, providerCalled: providerAttempts > 0, providerAttempts,
    manifestSha256: source.manifestSha256, selectedLessons: new Set(entries.map(entry => entry.lessonId)).size,
    selectedBooks: [...new Set(entries.map(entry => entry.bookId))],
    filters: { books: options.books || null, lesson: options.lesson || null, kinds: options.kinds || null, limit: options.limit || null },
    blockedEntries: blocked.length, listeningReviewEntries: reviews.length,
    byBook: groupStats(entries, 'bookId'), byLesson: groupStats(entries, 'lessonId'), byKind: groupStats(entries, 'kind'), entries }
  writeJson(path.join(outputDir, 'plan.json'), plan)
  writeJson(path.join(outputDir, 'pronunciation-review.json'), {
    schemaVersion: 1, providerCalled: false, scope: 'selected entries only', report: pronunciation.report,
    blocked: blocked.map(({ id, text, readingText, contextWord, pronunciation }) => ({ id, text, readingText, contextWord, pronunciation })),
    listeningReview: reviews.map(({ id, text, readingText, contextWord, pronunciation }) => ({ id, text, readingText, contextWord, pronunciation })),
  })
  const cell = text => String(text ?? '').replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim()
  const blockedLines = ['# 配音前待核对项目', '',
    `当前筛选范围 ${entries.length} 条，暂停 ${blocked.length} 条；其余条目完成文本与发音准备，尚未试听。`, '',
    '暂停项目不会发送给语音服务。拼音字母须先选择发音方式；单字歧义须按课文确认带读词；古今异读需先确认合成读法。', '',
    '| 课文 / 类型 | 片段 | 期望读音或原因 | 教材物理页 | 条目 ID |',
    '| --- | --- | --- | --- | --- |']
  for (const entry of blocked) {
    const details = entry.pronunciation.review.filter(item => item.code === 'source-pronunciation-hint')
      .map(item => `${item.context || item.text}：${item.text} ${item.expectedPinyin}`)
    if (!details.length) details.push(...entry.pronunciation.blockers.map(item => item.message))
    blockedLines.push(`| ${cell(entry.lessonTitle)} / ${entry.kind} | ${cell(entry.text.slice(0, 72))}${entry.text.length > 72 ? '…' : ''} | ${cell(details.join('；'))} | ${entry.pdfPages.join('、')} | ${cell(entry.id)} |`)
  }
  blockedLines.push('', '完整上下文、逐条试听提醒与依据见 [pronunciation-review.json](pronunciation-review.json)。', '')
  fs.writeFileSync(path.join(outputDir, 'pronunciation-review.md'), blockedLines.join('\n'))
  const table = (rows, label) => [`| ${label} | 条目 | 可生成 | 阻塞/跳过 | 缓存 | 待生成 | 去重新请求 |`,
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.key} | ${row.entries} | ${row.active} | ${row.blocked} | ${row.cached} | ${row.pending} | ${row.uniqueNewRequests} |`)]
  const lines = ['# 课文配音计划', '',
    `本次${generate ? '按显式 --generate 执行' : '仅生成离线计划，未调用语音服务'}。教材 ${plan.selectedBooks.length} 册、课程 ${plan.selectedLessons} 课。`, '',
    `条目 ${plan.totalEntries}；阻塞/跳过 ${plan.skippedEntries}；已缓存 ${plan.cachedEntries}；待生成 ${plan.newEntries}；去重新请求 ${plan.uniqueNewRequests}。`, '',
    `待生成去重朗读文本 ${plan.estimatedBillableCharacters} 个 Unicode 字符（包含标点与空白）；约 ${plan.estimatedCredits} credits 仅沿用脚本参考算法，未查询账户余额和实时费率。`, '',
    plan.billingNote, '',
    '整篇、分篇和逐句是不同播放素材；本计划包含哪些类型见下表，批量生成前可用 --kind 缩小范围。各分组的去重数存在交集，不能相加作为全局费用。', '',
    ...table(plan.byBook, '教材'), '', ...table(plan.byKind, '类型'), '',
    '## 发音核对', '',
    `阻塞/跳过 ${blocked.length} 条，试听提醒 ${reviews.length} 条；先看 [待核对项目](pronunciation-review.md)，完整原因、预计读音和来源见 [pronunciation-review.json](pronunciation-review.json)。试听提醒不是已经试听通过。`, '',
    '发音准备保留教材原文；规范化仅写入 readingText。拼音课与图表未混入普通课文请求。缓存命中要求文字、声音参数和文件哈希一致，旧音频无法匹配时仍列为待生成。', '',
    '## 逐课统计', '', ...table(plan.byLesson, '课程'), '']
  fs.writeFileSync(path.join(outputDir, 'summary.md'), lines.join('\n'))
  log(`课文配音${generate ? '执行' : '离线计划'}：${plan.selectedBooks.length} 册 ${plan.selectedLessons} 课；${plan.totalEntries} 条，阻塞/跳过 ${plan.skippedEntries}，缓存 ${plan.cachedEntries}，去重新请求 ${plan.uniqueNewRequests}，待生成 ${plan.estimatedBillableCharacters} 字符。`)
  return { ...result, plan, pronunciationReport: pronunciation.report, outputDir }
}

async function main() {
  const options = cliOptions()
  if (options.help) {
    console.log('node scripts/reading-prep/tts.cjs [--book BOOK_ID] [--lesson LESSON_KEY|BOOK_ID/lesson-KEY] [--kind whole,part,sentence,character,word] [--limit N] [--concurrency 2] [--dry-run | --generate] [--manifest PATH] [--output-dir DIR] [--cache-dir DIR]')
    return
  }
  const result = await runReadingTts(options)
  if (result.failed) process.exitCode = 1
}
if (require.main === module) main().catch(error => {
  // Do not print provider responses or environment values; validation errors above contain only source metadata.
  const message = String(error.message || '')
  const ownError = /^(?:找不到课文清单|教材目录|课文清单|发音准备|并发数|limit |kind |--generate |--lesson |筛选范围|未找到|chinese-g\d(?:up|down)-2026[:/]|请配置 ELEVENLABS_)/u.test(message)
  console.error(ownError ? message : '课文配音准备未完成，请检查清单、参数和本地配置。')
  process.exitCode = 1
})
module.exports = { cliOptions, loadNarration, selectEntries, runReadingTts, groupStats }
