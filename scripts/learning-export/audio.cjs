'use strict'

const path = require('node:path')
const { collectAudioEntries, loadSettings, readOverrides, prepareEntries, readManifest, readCachedAudio } = require('./tts-common.cjs')

const THINKY_AUDIO_GAPS = [
  'Thinky content-sync 当前包内 media 仅允许 document/application/json。音频登记于 media-manifest.json 并随包携带，支持的 props 写 audio 引用；尚不能由当前 content-sync 导入、发布音频。',
  'Thinky 需要补齐 audio/mpeg 元数据、MP3 文件校验和存储扩展名、音频引用完整性校验及媒体发布；当前媒体接口会拒绝音频 MIME。已有 immutable 缓存头，但未实现 Range/206/416。',
  'Thinky CharacterFamilySchema 和 ReadAloudPropsSchema 尚无字族词 audio、整篇 audio 字段。已缓存的这两类音频随包携带并列于音频报告，未往 strict props 添加不支持的字段。',
]

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
    details.push({ id: entry.id, lessonId: entry.lessonId, text: entry.text,
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
    coverage: { deliverySupported: false, lessons, entries: details, listeningReview }, gaps: THINKY_AUDIO_GAPS }
}

module.exports = { attachCachedAudio, THINKY_AUDIO_GAPS }
