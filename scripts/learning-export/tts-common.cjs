'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { contentHash, sha256 } = require('./common.cjs')

const DEFAULT_SETTINGS = Object.freeze({
  modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128',
  voiceSettings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.85 },
})
// Small review list for the characters in the current lessons. This is a listening
// reminder, not an automatic pronunciation decision.
const POLYPHONIC = { 晃: ['huǎng', 'huàng'], 读: ['dú', 'dòu'] }

function readEnvironment(root, env = process.env) {
  const result = {}
  const filename = path.join(root, '.env.local')
  if (fs.existsSync(filename)) {
    for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?(ELEVENLABS_[A-Z_]+)\s*=\s*(.*?)\s*$/u)
      if (!match) continue
      let value = match[2]
      if (/^['"]/u.test(value)) {
        const quote = value[0], closing = value.indexOf(quote, 1)
        if (closing < 0 || !/^\s*(?:#.*)?$/u.test(value.slice(closing + 1))) throw new Error('.env.local 配置格式无效')
        value = value.slice(1, closing)
      } else value = value.replace(/\s+#.*$/u, '').trim()
      result[match[1]] = value
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('ELEVENLABS_') && value !== undefined
      && !(name === 'ELEVENLABS_API_KEY' && !String(value).trim())) result[name] = value
  }
  return result
}

function loadSettings({ root, env = process.env }) {
  const values = readEnvironment(root, env)
  const numeric = (name, fallback, min, max) => {
    const value = values[name] === undefined || values[name] === '' ? fallback : Number(values[name])
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 数值范围无效`)
    return value
  }
  const boolean = (name, fallback) => {
    if (!values[name]) return fallback
    if (!['true', 'false'].includes(values[name])) throw new Error(`${name} 必须为 true 或 false`)
    return values[name] === 'true'
  }
  const settings = {
    voiceId: (values.ELEVENLABS_VOICE_ID || '').trim(),
    modelId: (values.ELEVENLABS_MODEL_ID || DEFAULT_SETTINGS.modelId).trim(),
    outputFormat: (values.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_SETTINGS.outputFormat).trim(),
    voiceSettings: {
      stability: numeric('ELEVENLABS_STABILITY', 0.65, 0, 1),
      similarity_boost: numeric('ELEVENLABS_SIMILARITY_BOOST', 0.75, 0, 1),
      style: numeric('ELEVENLABS_STYLE', 0, 0, 1),
      use_speaker_boost: boolean('ELEVENLABS_USE_SPEAKER_BOOST', true),
      speed: numeric('ELEVENLABS_SPEED', 0.85, 0.7, 1.2),
    },
  }
  if (!/^mp3_\d+_\d+$/u.test(settings.outputFormat)) throw new Error('ELEVENLABS_OUTPUT_FORMAT 必须为 MP3 格式')
  return settings
}

function loadCredentials({ root, env = process.env }) {
  return (readEnvironment(root, env).ELEVENLABS_API_KEY || '').trim()
}

function collectAudioEntries(patches) {
  const entries = []
  const add = (lessonId, stageKey, suffix, text, target, extra = {}) => {
    if (typeof text !== 'string' || !text.trim()) return
    entries.push({ id: `${lessonId}/${stageKey}/${suffix}`, lessonId, stageKey, text, target,
      isCharacter: false, supportsAudio: true, ...extra })
  }
  const lineText = value => typeof value === 'string' ? value : (value || []).map(span => span.text).join('')
  for (const [lessonId, lesson] of Object.entries(patches)) {
    for (const stage of [...(lesson.basicStages || []), ...(lesson.extension?.stages || [])]) {
      const props = stage.props || {}, key = stage.key
      if (['char-learn', 'hanzi-write'].includes(stage.widget)) {
        for (const character of props.characters || []) {
          add(lessonId, key, `characters/${character.id}`, character.char, character, { isCharacter: true })
          for (const word of character.family || []) add(lessonId, key,
            `characters/${character.id}/family/${word.id}`, word.text ?? word.word, word)
        }
        for (const word of props.words || []) add(lessonId, key, `words/${word.id}`, word.text, word)
      }
      if (['read-aloud', 'recite-ladder'].includes(stage.widget)) {
        for (const sentence of props.sentences || []) add(lessonId, key, `sentences/${sentence.id}`, sentence.text, sentence)
        if (stage.widget === 'read-aloud') add(lessonId, key, 'whole',
          (props.sentences || []).map(sentence => sentence.text).join('\n'), props)
        for (const pair of props.pairs || []) add(lessonId, key, `pairs/${pair.id}`,
          `${lineText(pair.upper)}，${lineText(pair.lower)}`, pair)
      }
    }
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('读音条目 ID 重复')
  return entries
}

function readOverrides(root) {
  const filename = path.join(root, 'scripts/learning-export/tts-overrides.json')
  if (!fs.existsSync(filename)) return { entries: {}, texts: {} }
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    for (const group of ['entries', 'texts']) {
      if (data[group] !== undefined && (!data[group] || typeof data[group] !== 'object' || Array.isArray(data[group]))) throw new Error()
      for (const value of Object.values(data[group] || {})) {
        if (typeof value === 'string' && value.trim()) continue
        if (value && typeof value === 'object' && !Array.isArray(value)
          && (value.skip === true || (typeof value.text === 'string' && value.text.trim()))) continue
        throw new Error()
      }
    }
    return { entries: data.entries || {}, texts: data.texts || {} }
  } catch { throw new Error('tts-overrides.json 格式无效') }
}

function prepareEntries(entries, overrides, settings) {
  const configFingerprint = contentHash(settings)
  return entries.map(entry => {
    const override = overrides.entries?.[entry.id] ?? overrides.texts?.[entry.text]
    const readingText = (typeof override === 'string' ? override : override?.text) ?? entry.text
    const skipped = override?.skip === true
    return { ...entry, readingText, charCount: [...readingText].length, skipped, configFingerprint,
      cacheKey: contentHash({ text: readingText, voiceId: settings.voiceId, modelId: settings.modelId,
        voice_settings: settings.voiceSettings, outputFormat: settings.outputFormat }),
      ...(entry.isCharacter && POLYPHONIC[entry.text] ? { polyphonic: POLYPHONIC[entry.text] } : {}) }
  })
}

function readManifest(cacheDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'))
    return data.schemaVersion === 1 && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)
      ? { ...data, cache: data.cache && typeof data.cache === 'object' && !Array.isArray(data.cache) ? data.cache : {} } : { schemaVersion: 1, entries: {}, cache: {} }
  } catch { return { schemaVersion: 1, entries: {}, cache: {} } }
}

function readCachedAudio(cacheDir, entry, manifest = readManifest(cacheDir)) {
  if (entry.skipped || !/^[a-f0-9]{64}$/u.test(entry.cacheKey || '')) return null
  let diskRecord
  try { diskRecord = JSON.parse(fs.readFileSync(path.join(cacheDir, `${entry.cacheKey}.json`), 'utf8')) } catch { /* no saved record */ }
  const records = [manifest.cache?.[entry.cacheKey], diskRecord, manifest.entries[entry.id], ...Object.values(manifest.entries)]
    .filter(item => item?.cacheKey === entry.cacheKey && item.readingText === entry.readingText
      && item.configFingerprint === entry.configFingerprint && item.charCount === entry.charCount
      && /^[a-f0-9]{64}$/u.test(item.sha256 || ''))
  if (!records.length) return null
  const sourcePath = path.join(cacheDir, `${entry.cacheKey}.mp3`)
  try {
    if (!fs.lstatSync(sourcePath).isFile()) return null
    const bytes = fs.readFileSync(sourcePath)
    if (!bytes.length) return null
    const digest = sha256(bytes)
    const record = records.find(item => item.sha256 === digest)
    if (!record) return null
    return { sha256: record.sha256, bytes, size: bytes.length, sourcePath,
      kind: 'audio', mime: 'audio/mpeg', mediaPath: `media/${record.sha256}.mp3` }
  } catch { return null }
}

module.exports = { DEFAULT_SETTINGS, collectAudioEntries, loadSettings, loadCredentials,
  readEnvironment, readOverrides, prepareEntries, readManifest, readCachedAudio }
