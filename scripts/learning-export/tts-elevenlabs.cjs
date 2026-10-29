#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArgs } = require('node:util')
const { sha256 } = require('./common.cjs')
const { collectAudioEntries, loadSettings, loadCredentials, readOverrides,
  prepareEntries, readManifest, readCachedAudio } = require('./tts-common.cjs')

const ROOT = path.resolve(__dirname, '../..')

function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, filename)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}

function cliOptions(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    'dry-run': { type: 'boolean' }, sample: { type: 'boolean' }, only: { type: 'string' }, limit: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    'source-root': { type: 'string' }, 'site-dir': { type: 'string' },
    'thinky-root': { type: 'string' }, 'evidence-root': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } })
  const forwarded = Object.entries(values).filter(([name]) => ['source-root', 'site-dir', 'thinky-root', 'evidence-root'].includes(name))
    .flatMap(([name, value]) => [`--${name}`, value])
  const config = require('./index.cjs').options(forwarded, env)
  const concurrency = Number(values.concurrency), limit = values.limit === undefined ? undefined : Number(values.limit)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('并发数必须为 1 至 16')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit 必须为正整数')
  validateSampleOptions(values.sample, values.only, limit)
  return { root: ROOT, config, dryRun: values['dry-run'] || false, sample: values.sample || false,
    only: values.only, limit, concurrency, help: values.help }
}

function validateSampleOptions(sample, only, limit) {
  if (sample && !only) throw new Error('--sample 必须配合 --only 指定课程')
  if (sample && limit !== undefined) throw new Error('--sample 不能与 --limit 同时使用')
}

function selectSample(entries) {
  const selected = []
  for (const [kind, count] of [['character', 3], ['word', 3], ['sentence', 2]]) {
    const seen = new Set()
    const candidates = entries.filter(entry => {
      if (entry.skipped || entry.kind !== kind || seen.has(entry.text)) return false
      seen.add(entry.text)
      return true
    }).slice(0, count)
    if (candidates.length < count) throw new Error('--sample 指定课程不足 3 个单字、3 个词语和 2 个句子')
    selected.push(...candidates)
  }
  return selected
}

function buildPlan(entries, cacheDir, manifest, settings = {}) {
  const active = entries.filter(entry => !entry.skipped)
  const cached = active.filter(entry => readCachedAudio(cacheDir, entry, manifest))
  const cachedKeys = new Set(cached.map(entry => entry.cacheKey))
  const pending = new Map(active.filter(entry => !cachedKeys.has(entry.cacheKey)).map(entry => [entry.cacheKey, entry]))
  const estimatedBillableCharacters = [...pending.values()].reduce((sum, entry) => sum + entry.charCount, 0)
  return {
    schemaVersion: 1, modelId: settings.modelId, languageCode: settings.languageCode,
    languageCodeEffective: Boolean(settings.languageCode && settings.modelId !== 'eleven_multilingual_v2'),
    totalEntries: entries.length, skippedEntries: entries.length - active.length,
    totalCharacters: active.reduce((sum, entry) => sum + entry.charCount, 0),
    cachedEntries: cached.length, newEntries: active.length - cached.length,
    uniqueNewRequests: pending.size, estimatedBillableCharacters,
    estimatedCredits: estimatedBillableCharacters,
    billingNote: '按实际朗读文本的 Unicode 字符数（含标点和空白）估算；相同配置和文本去重。约 1 credit/字符仅作参考，实际以账户模型费率、额度和服务端结算为准。重试可能增加计费。',
    needsListeningReview: active.filter(entry => entry.polyphonic).map(entry => ({ id: entry.id, text: entry.text, readings: entry.polyphonic })),
    missingWords: active.filter(entry => entry.missingWord).map(entry => ({ id: entry.id, text: entry.text, reason: '无组词' })),
    entries: entries.map(({ id, lessonId, text, readingText, cacheKey, charCount, skipped, polyphonic, supportsAudio, kind, contextWord, missingWord }) => ({
      id, lessonId, text, readingText, cacheKey, charCount, skipped, supportsAudio, kind, contextWord, missingWord,
      cached: Boolean(!skipped && cachedKeys.has(cacheKey)), ...(polyphonic ? { polyphonic } : {}),
    })),
  }
}

async function synthesize(entry, settings, apiKey, { fetchImpl, sleep, maxRetries }) {
  // Never include provider bodies, exception text, request options or headers in
  // errors: providers and mock transports may echo the secret in all of them.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response
    try {
      response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=${encodeURIComponent(settings.outputFormat)}`, {
        method: 'POST', headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: entry.readingText, model_id: settings.modelId, voice_settings: settings.voiceSettings,
          ...(settings.languageCode && settings.modelId !== 'eleven_multilingual_v2' ? { language_code: settings.languageCode } : {}) }),
        signal: AbortSignal.timeout(120000),
      })
    } catch {
      if (attempt < maxRetries) { await sleep(1000 * 2 ** attempt); continue }
      throw new Error('音频请求未完成（网络错误或超时）')
    }
    if (response.ok) {
      let bytes
      try { bytes = Buffer.from(await response.arrayBuffer()) } catch { throw new Error('音频响应读取失败') }
      if (!bytes.length) throw new Error('音频响应为空')
      const mime = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase()
      const hasMp3Header = bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      if (!['audio/mpeg', 'audio/mp3'].includes(mime) || !hasMp3Header) throw new Error('音频响应格式无效')
      return bytes
    }
    const status = Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0
    // Consume no response body. Cancel streams so retries release sockets.
    try { await response.body?.cancel() } catch { /* deliberately suppress provider details */ }
    if ((status === 429 || status >= 500) && attempt < maxRetries) {
      await sleep(1000 * 2 ** attempt)
      continue
    }
    throw new Error(`音频请求失败（HTTP ${status}）`)
  }
}

function acquireGenerationLock(cacheDir) {
  const filename = path.join(cacheDir, '.generation.lock')
  const identity = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() })
  let fd
  try { fd = fs.openSync(filename, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有读音生成任务持有缓存锁；确认没有生成进程后，可删除 .local/tts-cache/.generation.lock 再运行')
    throw new Error('无法创建读音缓存锁')
  }
  try { fs.writeFileSync(fd, identity) } catch {
    fs.closeSync(fd)
    fs.unlinkSync(filename)
    throw new Error('无法创建读音缓存锁')
  }
  fs.closeSync(fd)
  // A stale lock is intentionally never cleared automatically. Confirm the old
  // generation process has stopped before manually deleting it.
  return () => {
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === identity) fs.unlinkSync(filename)
  }
}

async function runTts({ root = ROOT, env = process.env, config, patches,
  dryRun = false, sample = false, only, limit, concurrency = 2, fetchImpl = globalThis.fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxRetries = 3, log = message => console.log(message), cacheDir = path.join(root, '.local/tts-cache') } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('并发数必须为 1 至 16')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit 必须为正整数')
  validateSampleOptions(sample, only, limit)
  const settings = loadSettings({ root, env })
  if (settings.modelId === 'eleven_multilingual_v2' && settings.languageCode)
    log('该模型不支持指定中文，建议改为 eleven_v4')
  const apiKey = loadCredentials({ root, env })
  if (!dryRun && !apiKey) throw new Error('请配置 ELEVENLABS_API_KEY；未配置时仅允许 --dry-run')
  if (!dryRun && !settings.voiceId) throw new Error('请配置 ELEVENLABS_VOICE_ID')
  if (!patches) {
    config ||= require('./index.cjs').options([], env)
    patches = require('./studio.cjs').buildStudioLessons(config).patches
  }
  let entries = prepareEntries(collectAudioEntries(patches), readOverrides(root), settings)
  if (only) {
    if (!Object.hasOwn(patches, only)) throw new Error('未找到 --only 指定的课程 ID')
    entries = entries.filter(entry => entry.lessonId === only)
  }
  if (limit !== undefined) entries = entries.slice(0, limit)
  if (sample) entries = selectSample(entries)
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  const release = dryRun ? () => {} : acquireGenerationLock(cacheDir)
  try {
    const manifest = readManifest(cacheDir)
    const plan = buildPlan(entries, cacheDir, manifest, settings)
    atomicWrite(path.join(cacheDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
    log(`读音计划：${plan.totalEntries} 条，${plan.totalCharacters} 字符；已缓存 ${plan.cachedEntries} 条，需新生成 ${plan.newEntries} 条（去重请求 ${plan.uniqueNewRequests} 次）；预估计费 ${plan.estimatedBillableCharacters} 字符 / 约 ${plan.estimatedCredits} credits。`)
    log(`模型：${settings.modelId}；language_code：${settings.languageCode || '未指定'}（${plan.languageCodeEffective ? '生效' : '不生效'}）。`)
    const characterExamples = entries.filter(entry => entry.isCharacter && !entry.skipped).slice(0, 3)
    if (characterExamples.length) log(`单字朗读示例：${characterExamples.map(entry => `${entry.id} → ${entry.readingText}`).join('；')}`)
    if (plan.missingWords.length) log(`无组词（仅朗读单字）：${plan.missingWords.map(entry => `${entry.text}（${entry.id}）`).join('、')}`)
    if (plan.needsListeningReview.length) log(`请人工试听多音字：${plan.needsListeningReview.map(entry => `${entry.text}（${entry.id}）`).join('、')}`)
    const writeSample = results => {
      if (!sample) return
      const statuses = new Map(results.map(item => [item.id, item.status]))
      const lines = entries.map(entry => `${entry.id}\t${entry.readingText}\t${path.resolve(cacheDir, `${entry.cacheKey}.mp3`)}\t${statuses.get(entry.id) || (readCachedAudio(cacheDir, entry, manifest) ? 'cached' : 'planned')}`)
      const listing = `条目 ID\t朗读文本\tmp3 文件绝对路径\t状态\n${lines.join('\n')}\n`
      atomicWrite(path.join(cacheDir, 'sample.txt'), listing)
      log(listing.trimEnd())
    }
    if (dryRun) {
      writeSample([])
      return { plan, results: [], success: 0, failed: 0, cached: plan.cachedEntries, skipped: plan.skippedEntries }
    }

    const groups = new Map(), results = []
    for (const entry of entries) if (!entry.skipped) {
      if (!groups.has(entry.cacheKey)) groups.set(entry.cacheKey, [])
      groups.get(entry.cacheKey).push(entry)
    }
    const jobs = [...groups.values()]
    let next = 0
    const saveRecord = (entry, hash) => {
      const record = { cacheKey: entry.cacheKey, sha256: hash, charCount: entry.charCount,
        readingText: entry.readingText, configFingerprint: entry.configFingerprint }
      manifest.entries[entry.id] = record
      manifest.cache[entry.cacheKey] = record
    }
    const persist = () => atomicWrite(path.join(cacheDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    async function worker() {
      while (next < jobs.length) {
        const group = jobs[next++], entry = group[0]
        try {
          const cached = readCachedAudio(cacheDir, entry, manifest)
          const bytes = cached?.bytes || await synthesize(entry, settings, apiKey, { fetchImpl, sleep, maxRetries })
          const hash = cached?.sha256 || sha256(bytes)
          // Save the independently verifiable record first, so an interrupted or
          // failed manifest update does not discard a paid-for audio file.
          if (!cached) {
            const record = { cacheKey: entry.cacheKey, sha256: hash, charCount: entry.charCount,
              readingText: entry.readingText, configFingerprint: entry.configFingerprint }
            atomicWrite(path.join(cacheDir, `${entry.cacheKey}.json`), `${JSON.stringify(record, null, 2)}\n`)
            atomicWrite(path.join(cacheDir, `${entry.cacheKey}.mp3`), bytes)
          }
          for (const item of group) saveRecord(item, hash)
          persist()
          for (const item of group) results.push({ id: item.id, status: cached ? 'cached' : 'success', sha256: hash })
        } catch (error) {
          // Only our fixed error messages are safe. Even filesystem exceptions can
          // include arbitrary paths; report a category instead of raw exceptions.
          const safeErrors = new Set(['音频请求未完成（网络错误或超时）', '音频响应读取失败', '音频响应为空', '音频响应格式无效'])
          const message = safeErrors.has(error.message) || /^音频请求失败（HTTP \d{1,3}）$/u.test(error.message || '')
            ? error.message : '音频生成或缓存写入失败'
          for (const item of group) results.push({ id: item.id, status: 'failed', message })
          log(`音频生成失败：${entry.id}；${message}`)
        }
      }
    }
    // Keep the lock until every worker has settled, even if a reporting callback
    // unexpectedly throws while another worker is still writing its cache.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
    const rejected = workers.find(item => item.status === 'rejected')
    if (rejected) throw rejected.reason
    const summary = { plan, results, success: results.filter(item => item.status === 'success').length,
      cached: results.filter(item => item.status === 'cached').length, failed: results.filter(item => item.status === 'failed').length,
      skipped: plan.skippedEntries }
    atomicWrite(path.join(cacheDir, 'result.json'), `${JSON.stringify({ ...summary, plan: undefined }, null, 2)}\n`)
    writeSample(results)
    log(`读音完成：成功 ${summary.success} 条，缓存 ${summary.cached} 条，失败 ${summary.failed} 条，跳过 ${summary.skipped} 条。`)
    return summary
  } finally { release() }
}

async function main() {
  const options = cliOptions()
  if (options.help) {
    console.log('node scripts/learning-export/tts-elevenlabs.cjs [--dry-run] [--only LESSON_ID] [--sample | --limit N] [--concurrency 2] [--source-root DIR] [--site-dir DIR] [--thinky-root DIR] [--evidence-root DIR]')
    return
  }
  const result = await runTts(options)
  if (result.failed) process.exitCode = 1
}

if (require.main === module) main().catch(error => {
  // Only fixed messages from our own configuration validation are printable.
  const safe = new Set(['请配置 ELEVENLABS_API_KEY；未配置时仅允许 --dry-run', '请配置 ELEVENLABS_VOICE_ID',
    '已有读音生成任务持有缓存锁；确认没有生成进程后，可删除 .local/tts-cache/.generation.lock 再运行', '无法创建读音缓存锁',
    '并发数必须为 1 至 16', 'limit 必须为正整数', '未找到 --only 指定的课程 ID', '.env.local 配置格式无效', 'tts-overrides.json 格式无效',
    '--sample 必须配合 --only 指定课程', '--sample 不能与 --limit 同时使用', '--sample 指定课程不足 3 个单字、3 个词语和 2 个句子'])
  const settingsError = /^ELEVENLABS_(?:STABILITY|SIMILARITY_BOOST|STYLE|SPEED) 数值范围无效$|^ELEVENLABS_USE_SPEAKER_BOOST 必须为 true 或 false$|^ELEVENLABS_OUTPUT_FORMAT 必须为 MP3 格式$/u.test(error.message || '')
  console.error(safe.has(error.message) || settingsError ? error.message : '读音生成未启动或未完成；请检查环境变量、路径和参数配置。')
  process.exitCode = 1
})
module.exports = { cliOptions, buildPlan, runTts, synthesize, selectSample }
