'use strict'

const path = require('node:path')
const { collectAudioEntries, loadSettings, readOverrides, prepareEntries, readManifest, readCachedAudio } = require('./tts-common.cjs')

const THINKY_AUDIO_GAPS = []

/** Use exactly the same converted objects and IDs as the generator; never read credentials. */
function attachCachedAudio(studio, { root, env = process.env, cacheDir = path.join(root, '.local/tts-cache') }) {
  // The converter shares word arrays between reading and dictation. Entry-ID
  // overrides may select different recordings, so each stage owns its props.
  for (const patch of Object.values(studio.patches))
    for (const stage of [...patch.basicStages, ...patch.extension.stages]) stage.props = structuredClone(stage.props)
  const settings = loadSettings({ root, env })
  const entries = prepareEntries(collectAudioEntries(studio.patches), readOverrides(root), settings)
  const manifest = readManifest(cacheDir)
  const sources = new Map()
  const lessons = Object.keys(studio.patches).map(lessonId => ({ lessonId, total: 0, withAudio: 0, missingAudio: 0, attached: 0, unsupported: 0, skipped: 0 }))
  const details = []
  const inputs = []
  for (const entry of entries) {
    const counts = lessons.find(item => item.lessonId === entry.lessonId)
    counts.total++
    const audio = entry.skipped ? null : readCachedAudio(cacheDir, entry, manifest)
    if (entry.skipped) counts.skipped++
    if (audio) {
      counts.withAudio++
      sources.set(audio.sha256, audio)
      inputs.push({ label: `tts/${entry.id}`, path: audio.sourcePath, sha256: audio.sha256 })
      if (entry.supportsAudio !== false) {
        entry.target.audio = { sha256: audio.sha256, kind: 'audio' }
        counts.attached++
      } else counts.unsupported++
    } else counts.missingAudio++
    details.push({ id: entry.id, lessonId: entry.lessonId, text: entry.text, readingText: entry.readingText,
      ...(entry.missingWord ? { missingWord: true, readingNote: '无组词' } : {}),
      ...(audio ? { sha256: audio.sha256, mediaPath: audio.mediaPath } : {}),
      status: entry.skipped ? 'skipped' : !audio ? 'missing' : entry.supportsAudio === false ? 'contract-unsupported' : 'attached' })
  }
  // Private grading bindings must retain byte-identical public props after audio attachment.
  for (const [lessonId, gradings] of Object.entries(studio.widgetGradings)) {
    const patch = studio.patches[lessonId]
    for (const item of gradings) {
      const stage = [...patch.basicStages, ...patch.extension.stages].find(stage => stage.key === item.stageKey)
      item.content.props = stage.props
    }
  }
  const listeningReview = entries.filter(entry => entry.polyphonic).map(entry => ({
    id: entry.id, text: entry.text, readingText: entry.readingText, readings: entry.polyphonic,
  }))
  return { sources: [...sources.values()], inputs,
    coverage: { deliverySupported: true, lessons, entries: details, listeningReview,
      missingWords: details.filter(entry => entry.missingWord).map(({ id, text, readingNote }) => ({ id, text, reason: readingNote })) }, gaps: THINKY_AUDIO_GAPS }
}

module.exports = { attachCachedAudio, THINKY_AUDIO_GAPS }
