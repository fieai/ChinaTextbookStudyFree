'use strict'

const fs = require('node:fs')
const { sha256 } = require('./common.cjs')

function mediaManifest(pageResult, documents) {
  const entries = [
    ...pageResult.mediaSources.map(item => ({ sha256: item.sha256, kind: 'image', mime: 'image/png',
      path: item.mediaPath, byteLength: fs.statSync(item.sourcePath).size })),
    ...documents.map(item => ({ sha256: item.sha256, kind: item.kind, mime: item.mime,
      path: item.mediaPath, byteLength: item.bytes.length })),
  ]
  return { schemaVersion: 1, media: [...new Map(entries.map(item => [item.sha256, item])).values()]
    .sort((a, b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) }
}

// PagesManifest is intentionally image-only. This exporter sidecar includes documents and audio;
// each identity is validated by the actual contract MediaReferenceSchema.
function mediaManifestSchema({ z, contract }) {
  return z.strictObject({ schemaVersion: z.literal(1), media: z.array(z.strictObject({
    ...contract.MediaReferenceSchema.shape,
    mime: z.enum(['image/png', 'application/json', 'audio/mpeg']),
    path: z.string(), byteLength: z.number().int().positive(),
  }).superRefine((item, ctx) => {
    const formats = { image: ['png', 'image/png'], document: ['json', 'application/json'], audio: ['mp3', 'audio/mpeg'] }
    const [ext, mime] = formats[item.kind] ?? []
    if (!ext || item.mime !== mime
      || item.path !== `media/${item.sha256}.${ext}`)
      ctx.addIssue({ code: 'custom', message: 'Media kind, MIME and content-addressed path must agree' })
  })).refine(items => new Set(items.map(item => item.sha256)).size === items.length, 'Duplicate media hashes') })
}

function validateMediaReferences(content, manifest, sources) {
  const issues = []
  const add = (path, message) => issues.push({ path, message })
  const entries = new Map(manifest.media.map(item => [item.sha256, item]))
  for (const item of manifest.media) {
    const source = sources.find(source => source.sha256 === item.sha256)
    const bytes = source && (source.bytes ?? fs.readFileSync(source.sourcePath))
    if (!bytes || sha256(bytes) !== item.sha256 || bytes.length !== item.byteLength)
      add(`media-manifest.${item.sha256}`, 'Media bytes do not match SHA256/byteLength')
  }
  for (const book of content.books) for (const { content: lesson } of book.lessons)
    for (const stage of [...(lesson.basicStages ?? []), ...(lesson.extension?.stages ?? [])])
      for (const character of stage.props?.characters ?? []) {
        if (!character.strokeData) continue
        const item = entries.get(character.strokeData.sha256)
        if (item?.kind !== 'document') add(`${lesson.sourceLessonId}.${stage.key}.${character.id}.strokeData`, 'Missing stroke document media')
      }
  function walk(value, location) {
    if (!value || typeof value !== 'object') return
    if (value.audio) {
      const item = entries.get(value.audio.sha256)
      if (item?.kind !== 'audio' || item.mime !== 'audio/mpeg')
        add(`${location}.audio`, 'Missing audio media')
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${location}.${key}`)
  }
  walk(content.books, 'books')
  return issues
}

module.exports = { mediaManifest, mediaManifestSchema, validateMediaReferences }
