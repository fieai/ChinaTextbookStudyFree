'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { inputFile, requireCondition: check } = require('./common.cjs')
const ROOT = path.resolve(__dirname, '../../content/reading-prep')
const SOURCES = ['textbook-word-table', 'textbook-body-phrase', 'same-book-word-table', 'other-book-word-table', 'dictionary-phrase']
const normalize = value => String(value || '').normalize('NFC').trim().toLowerCase()

function loadContextCandidates(addInput = inputFile, root = ROOT) {
  const filename = path.join(root, 'tts-context-candidates.json')
  const hint = 'run .local/tools/pinyin-venv/bin/python -I scripts/reading-prep/tts_context_candidates.py'
  check(fs.existsSync(filename), `Missing TTS context candidates; ${hint}`)
  addInput('reading-prep/tts-context-candidates.json', filename)
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
  check(data.schemaVersion === 1 && data.lessons && data.generator?.inputs, 'Invalid TTS context candidates')
  const expected = fs.readdirSync(root).filter(name => /^chinese-.*\.json$/u.test(name))
    .concat('pinyin-annotations.json', 'pronunciation-rules.json').sort()
  check(JSON.stringify(Object.keys(data.generator.inputs).sort()) === JSON.stringify(expected), `Incomplete TTS context inputs; ${hint}`)
  for (const [name, hash] of Object.entries(data.generator.inputs)) {
    check(path.basename(name) === name, 'Invalid TTS context input path')
    check(addInput(`reading-prep/${name}`, path.join(root, name)).sha256 === hash, `Stale TTS context candidates: ${name}; ${hint}`)
  }
  check(addInput('tts-context/tts_context_candidates.py', path.resolve(__dirname, '../reading-prep/tts_context_candidates.py')).sha256
    === data.generator.scriptSha256, `Stale TTS context generator; ${hint}`)
  check(addInput('annotator/annotate_pinyin.py', path.resolve(__dirname, '../reading-prep/annotate_pinyin.py')).sha256
    === data.generator.helperSha256, `Stale TTS context pinyin helper; ${hint}`)
  return data
}

function selectCharacterContext(character, info = {}) {
  const expectedPinyin = normalize(info.pinyin)
  const polyphonic = Array.isArray(info.polyphonic) && info.polyphonic.length ? info.polyphonic : undefined
  const metadata = { ...(expectedPinyin ? { expectedPinyin, expectedPinyinSource: info.pinyinSource } : {}),
    ...(polyphonic ? { polyphonic } : {}) }
  const pause = reason => ({ ...metadata, skipped: true, missingWord: true, pronunciationIssue: reason })
  if (!expectedPinyin) return pause(polyphonic ? '多音字无明确教材拼音' : '无可确认的本课字读音')
  if (character.pinyin && ['textbook', 'reviewed'].includes(character.pinyinSource)
    && normalize(character.pinyin) !== expectedPinyin) return pause('本课已确认字读音冲突')
  for (const source of SOURCES) {
    if (source === 'dictionary-phrase' && (!polyphonic || !['textbook', 'reviewed'].includes(info.pinyinSource))) continue
    for (const candidate of info.candidates || []) {
      if (candidate.source !== source || typeof candidate.word !== 'string') continue
      const chars = [...candidate.word], sounds = candidate.pinyin
      if (chars.length < 2 || !chars.includes(character.char) || !/^\p{Script=Han}+$/u.test(candidate.word)
        || !Array.isArray(sounds) || sounds.length !== chars.length || sounds.some(sound => !normalize(sound))) continue
      if (source === 'textbook-body-phrase' && chars.length > 4) continue
      if (!chars.every((char, i) => char !== character.char || normalize(sounds[i]) === expectedPinyin)) continue
      return { ...metadata, contextWord: candidate.word, contextSource: source,
        contextEvidence: { pinyin: sounds, sourceBookId: candidate.sourceBookId, lessonNumber: candidate.lessonNumber,
          ...(candidate.offset !== undefined ? { offset: candidate.offset } : {}) } }
    }
  }
  if (!polyphonic) return { ...metadata, contextSource: 'single-character', singleReading: true, readingNote: '单读' }
  return pause('无匹配本课已确认读音的带词读上下文')
}

function contextSourceCounts(entries) {
  const result = {}
  for (const entry of entries) if (entry.isCharacter && !entry.skipped) {
    const source = entry.contextSource || 'legacy-context'
    result[source] = (result[source] || 0) + 1
  }
  return result
}

module.exports = { loadContextCandidates, selectCharacterContext, contextSourceCounts }
