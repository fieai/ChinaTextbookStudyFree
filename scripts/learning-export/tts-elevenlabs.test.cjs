'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTts, cliOptions } = require('./tts-elevenlabs.cjs')
const { collectAudioEntries, loadSettings, loadCredentials, readOverrides, prepareEntries,
  readManifest, readCachedAudio } = require('./tts-common.cjs')
const SECRET = 'private-elevenlabs-key-never-print'
const ENV = { ELEVENLABS_API_KEY: SECRET, ELEVENLABS_VOICE_ID: 'voice-a' }
const ok = () => new Response(Buffer.from('ID3mock-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
const stage = (key, widget, props) => ({ key, widget, props })
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-tts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts/learning-export'), { recursive: true })
  return root
}
function basicPatches() {
  return { lesson: { basicStages: [stage('basic-1', 'char-learn', { characters: [{ id: 'read-1', char: '晃', pinyin: 'huàng' }] })] } }
}
const quiet = () => {}
function cacheContents(root) {
  const dir = path.join(root, '.local/tts-cache')
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
}

test('uses shared converted props references and stable IDs for all requested structures', () => {
  const character = { id: 'a', char: '读', family: [{ id: 'f', word: '读书' }] }
  const sentence = { id: 's', text: '迟日江山丽' }, pair = { id: 'p', upper: [{ text: '泥融' }], lower: '沙暖' }
  const patches = { lesson: { basicStages: [
    stage('c', 'char-learn', { characters: [character], words: [{ id: 'w', text: '热闹' }] }),
    stage('h', 'hanzi-write', { characters: [character] }),
    stage('r', 'read-aloud', { sentences: [sentence] }),
    stage('p', 'recite-ladder', { sentences: [sentence], pairs: [pair] }),
  ], extension: { stages: [stage('l', 'read-aloud', { presentation: 'listen', sentences: [sentence] })] } } }
  const entries = collectAudioEntries(patches)
  assert.equal(entries.length, 11)
  assert.equal(entries.find(item => item.id === 'lesson/c/characters/a').target, character)
  assert.equal(entries.find(item => item.id === 'lesson/c/characters/a/family/f').supportsAudio, false)
  assert.equal(entries.find(item => item.id === 'lesson/r/whole').supportsAudio, false)
  assert.equal(entries.find(item => item.id === 'lesson/p/pairs/p').text, '泥融，沙暖')
  assert.equal(entries.find(item => item.id === 'lesson/p/pairs/p').target, pair)
  assert(entries.some(item => item.id === 'lesson/l/whole'))
})

test('environment settings support local file fallback, overrides, and key exclusion', t => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, '.env.local'), `# secret stays in this local input\nELEVENLABS_API_KEY="${SECRET}"\nELEVENLABS_VOICE_ID='local-voice'\nELEVENLABS_SPEED=0.9\n`)
  assert.equal(loadCredentials({ root, env: {} }), SECRET)
  assert.equal(loadCredentials({ root, env: { ELEVENLABS_API_KEY: '' } }), SECRET)
  assert.equal(loadCredentials({ root, env: { ELEVENLABS_API_KEY: 'env-key' } }), 'env-key')
  const settings = loadSettings({ root, env: { ELEVENLABS_VOICE_ID: 'env-voice', ELEVENLABS_USE_SPEAKER_BOOST: 'false' } })
  assert.equal(settings.voiceId, 'env-voice')
  assert.equal(settings.voiceSettings.speed, 0.9)
  assert.equal(settings.voiceSettings.use_speaker_boost, false)
  assert(!JSON.stringify(settings).includes(SECRET))
  assert.throws(() => loadSettings({ root, env: { ELEVENLABS_SPEED: SECRET } }), error => !error.message.includes(SECRET))
})

test('dry-run requires no key, never calls fetch, writes estimates and polyphonic reminders', async t => {
  const root = fixture(t), logs = []
  const patches = basicPatches()
  patches.lesson.basicStages.push(stage('basic-2', 'char-learn', { words: [{ id: 'word', text: '晃' }] }))
  const result = await runTts({ root, patches, env: {}, dryRun: true, log: line => logs.push(line),
    fetchImpl: () => { throw new Error('dry-run must not fetch') } })
  assert.equal(result.plan.totalEntries, 2)
  assert.equal(result.plan.totalCharacters, 2)
  assert.equal(result.plan.uniqueNewRequests, 1)
  assert.equal(result.plan.estimatedBillableCharacters, 1)
  assert.equal(result.plan.needsListeningReview[0].text, '晃')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.local/tts-cache/plan.json'))).totalEntries, 2)
  assert(logs[0].includes('2 条'))
  await assert.rejects(runTts({ root, patches, env: {}, log: quiet }), /ELEVENLABS_API_KEY/u)
  await assert.rejects(runTts({ root, patches, env: { ELEVENLABS_API_KEY: SECRET }, log: quiet }), /ELEVENLABS_VOICE_ID/u)
})

test('successful generation uses native fetch contract, cache hit and voice A/B/A avoid duplicate billing', async t => {
  const root = fixture(t), patches = basicPatches(), logs = []
  let requests = 0
  const fetchImpl = async (url, options) => {
    requests++
    assert(url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/voice-'))
    assert.equal(options.headers['xi-api-key'], SECRET)
    assert.equal(JSON.parse(options.body).voice_settings.speed, 0.85)
    return ok()
  }
  const base = { root, patches, env: ENV, log: line => logs.push(line), fetchImpl }
  assert.equal((await runTts(base)).success, 1)
  assert.equal((await runTts(base)).cached, 1)
  assert.equal(requests, 1)
  await runTts({ ...base, env: { ...ENV, ELEVENLABS_VOICE_ID: 'voice-b' } })
  assert.equal(requests, 2)
  assert.equal((await runTts(base)).cached, 1)
  assert.equal(requests, 2)
  assert.equal(Object.keys(readManifest(path.join(root, '.local/tts-cache')).cache).length, 2)
  assert(!logs.join('\n').includes(SECRET))
  assert(!cacheContents(root).includes(SECRET))
  assert(!fs.readdirSync(path.join(root, '.local/tts-cache')).join('').includes(SECRET))
})

test('independent per-key record recovers cache when manifest write was interrupted', async t => {
  const root = fixture(t), args = { root, patches: basicPatches(), env: ENV, log: quiet, fetchImpl: async () => ok() }
  await runTts(args)
  fs.unlinkSync(path.join(root, '.local/tts-cache/manifest.json'))
  const result = await runTts({ ...args, fetchImpl: () => assert.fail('paid audio must be reused') })
  assert.equal(result.cached, 1)
})

test('retries 429 and 5xx with exponential backoff using mocked fetch', async t => {
  const root = fixture(t), waits = [], statuses = [429, 503, 200]
  const result = await runTts({ root, patches: basicPatches(), env: ENV, log: quiet,
    sleep: async delay => waits.push(delay), fetchImpl: async () => {
      const status = statuses.shift()
      return status === 200 ? ok() : new Response(SECRET, { status })
    } })
  assert.equal(result.success, 1)
  assert.deepEqual(waits, [1000, 2000])
})

test('failures do not stop other entries and raw transport/provider secrets never reach outputs', async t => {
  const root = fixture(t), patches = basicPatches(), logs = []
  patches.lesson.basicStages.push(stage('basic-2', 'char-learn', { words: [{ id: 'word', text: '学校' }] }))
  const result = await runTts({ root, patches, env: ENV, log: line => logs.push(line), maxRetries: 0,
    fetchImpl: async (url, options) => {
      if (JSON.parse(options.body).text === '晃') throw new Error(`音频请求 ${SECRET}`)
      return ok()
    } })
  assert.equal(result.failed, 1)
  assert.equal(result.success, 1)
  assert(!JSON.stringify(result).includes(SECRET))
  assert(!cacheContents(root).includes(SECRET))
  assert(!logs.join('\n').includes(SECRET))
  const http = await runTts({ root, patches: basicPatches(), env: ENV, log: line => logs.push(line),
    fetchImpl: async () => new Response(SECRET, { status: 401 }) })
  assert.equal(http.failed, 1)
  assert(!logs.join('\n').includes(SECRET))
})

test('200 JSON response is rejected instead of cached as MP3', async t => {
  const root = fixture(t)
  const result = await runTts({ root, patches: basicPatches(), env: ENV, log: quiet,
    fetchImpl: async () => new Response(JSON.stringify({ error: SECRET }), { headers: { 'content-type': 'application/json' } }) })
  assert.equal(result.failed, 1)
  assert(!fs.readdirSync(path.join(root, '.local/tts-cache')).some(name => name.endsWith('.mp3')))
  assert(!cacheContents(root).includes(SECRET))
})

test('overrides by ID take priority, support skip, and all voice settings change cache keys', t => {
  const root = fixture(t), raw = collectAudioEntries(basicPatches())
  fs.writeFileSync(path.join(root, 'scripts/learning-export/tts-overrides.json'), JSON.stringify({
    entries: { [raw[0].id]: { text: '晃，摇晃的晃' } }, texts: { 晃: { skip: true } },
  }))
  const settings = loadSettings({ root, env: ENV }), overrides = readOverrides(root)
  const [entry] = prepareEntries(raw, overrides, settings)
  assert.equal(entry.readingText, '晃，摇晃的晃')
  assert.equal(entry.skipped, false)
  assert.equal(prepareEntries(raw, { texts: { 晃: { skip: true } } }, settings)[0].skipped, true)
  for (const alternate of [{ ...settings, modelId: 'other' }, { ...settings, outputFormat: 'mp3_22050_32' },
    { ...settings, voiceSettings: { ...settings.voiceSettings, speed: 0.9 } }]) {
    assert.notEqual(prepareEntries(raw, overrides, alternate)[0].cacheKey, entry.cacheKey)
  }
})

test('only/limit select stable entries and concurrency bounds independent requests', async t => {
  const root = fixture(t), patches = basicPatches()
  patches.other = basicPatches().lesson
  patches.lesson.basicStages.push(stage('basic-2', 'char-learn', { words: [{ id: 'w1', text: '学校' }, { id: 'w2', text: '课文' }, { id: 'w3', text: '声音' }] }))
  let active = 0, maximum = 0, calls = 0
  const args = { root, patches, env: ENV, only: 'lesson', concurrency: 2, log: quiet, fetchImpl: async () => {
    calls++; active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setImmediate(resolve))
    active--; return ok()
  } }
  const limited = await runTts({ ...args, dryRun: true, limit: 2 })
  assert.equal(limited.plan.totalEntries, 2)
  const all = await runTts(args)
  assert.equal(all.success, 4)
  assert.equal(calls, 4)
  assert.equal(maximum, 2)
  await assert.rejects(runTts({ ...args, only: 'unknown' }), /课程 ID/u)
  assert.throws(() => cliOptions(['--concurrency', '0'], {}), /并发/u)
})

test('cache digest is verified and corrupt MP3 is not accepted', async t => {
  const root = fixture(t), patches = basicPatches()
  await runTts({ root, patches, env: ENV, log: quiet, fetchImpl: async () => ok() })
  const [entry] = prepareEntries(collectAudioEntries(patches), {}, loadSettings({ root, env: ENV }))
  const dir = path.join(root, '.local/tts-cache')
  assert(readCachedAudio(dir, entry))
  fs.writeFileSync(path.join(dir, `${entry.cacheKey}.mp3`), 'corrupt')
  assert.equal(readCachedAudio(dir, entry), null)
})

test('parallel runs share an exclusive generation lock, reject before billing, and release after completion', async t => {
  const root = fixture(t), lock = path.join(root, '.local/tts-cache/.generation.lock')
  let calls = 0
  const args = { root, patches: basicPatches(), env: ENV, log: quiet, fetchImpl: async () => {
    calls++
    assert(fs.existsSync(lock))
    await new Promise(resolve => setImmediate(resolve))
    return ok()
  } }
  const results = await Promise.allSettled([runTts(args), runTts(args)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /已有读音生成任务持有缓存锁/u)
  assert.equal(calls, 1)
  assert.equal(fs.existsSync(lock), false)
  assert.equal((await runTts(args)).cached, 1)
  assert.equal(calls, 1)
})

test('generation lock is released after provider failure and unexpected plan failure', async t => {
  const root = fixture(t), lock = path.join(root, '.local/tts-cache/.generation.lock')
  const args = { root, patches: basicPatches(), env: ENV, log: quiet, maxRetries: 0,
    fetchImpl: async () => { throw new Error(SECRET) } }
  assert.equal((await runTts(args)).failed, 1)
  assert.equal(fs.existsSync(lock), false)
  await assert.rejects(runTts({ ...args, log: () => { throw new Error('mock plan output failure') } }))
  assert.equal(fs.existsSync(lock), false)
  assert.equal((await runTts({ ...args, fetchImpl: async () => ok() })).success, 1)
})

test('stale manifest checksum does not hide a valid independent cache record', async t => {
  const root = fixture(t), patches = basicPatches(), dir = path.join(root, '.local/tts-cache')
  const args = { root, patches, env: ENV, log: quiet, fetchImpl: async () => ok() }
  await runTts(args)
  const [entry] = prepareEntries(collectAudioEntries(patches), {}, loadSettings({ root, env: ENV }))
  const manifest = readManifest(dir), validSha = manifest.cache[entry.cacheKey].sha256
  manifest.cache[entry.cacheKey].sha256 = '0'.repeat(64)
  manifest.entries[entry.id].sha256 = '0'.repeat(64)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  assert.equal(readCachedAudio(dir, entry).sha256, validSha)
  const recovered = await runTts({ ...args, fetchImpl: () => assert.fail('valid paid audio must not be requested twice') })
  assert.equal(recovered.cached, 1)
  assert.equal(readManifest(dir).cache[entry.cacheKey].sha256, validSha)
})

test('dry-run needs no generation lock and does not remove another run lock', async t => {
  const root = fixture(t), dir = path.join(root, '.local/tts-cache')
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, '.generation.lock')
  fs.writeFileSync(lock, 'existing-generation')
  const result = await runTts({ root, patches: basicPatches(), env: {}, dryRun: true, log: quiet,
    fetchImpl: () => assert.fail('dry-run must not fetch') })
  assert.equal(result.plan.totalEntries, 1)
  assert.equal(fs.readFileSync(lock, 'utf8'), 'existing-generation')
})
