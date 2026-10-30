'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { options } = require('./index.cjs')
const { readStrokeDocuments } = require('./strokes.cjs')
const { materializeMedia } = require('./pages.cjs')
const { sha256 } = require('./common.cjs')

test('stroke documents retain every upstream path and median with deterministic byte hashes', () => {
  const config = options([])
  const result = readStrokeDocuments(config)
  const source = fs.readFileSync(path.join(config.siteDir, 'stroke-data.js'), 'utf8')
  const original = JSON.parse(vm.runInNewContext(`${source}\nJSON.stringify(window.STROKE_DATA)`, { window: {} }))
  assert.equal(result.documents.length, 12)
  for (const item of result.documents) {
    assert.equal(sha256(item.bytes), item.sha256)
    assert.equal(item.mediaPath, `media/${item.sha256}.json`)
    assert.deepEqual(JSON.parse(item.bytes), original[item.char])
    assert.deepEqual(result.references[item.char], { sha256: item.sha256, kind: 'document' })
  }
  assert.match(result.licenseBytes.toString(), /ARPHIC PUBLIC LICENSE/)
})

test('document materialization rejects changed bytes and corrupt existing documents', t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-strokes-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const item = readStrokeDocuments(options([])).documents[0]
  assert.throws(() => materializeMedia({ outputDir, mediaSources: [{ ...item, bytes: Buffer.from('{}') }] }), /Document changed/)
  materializeMedia({ outputDir, mediaSources: [item] })
  assert.deepEqual(fs.readFileSync(path.join(outputDir, item.mediaPath)), item.bytes)
  assert.equal(materializeMedia({ outputDir, mediaSources: [item] }).mediaFileCount, 1)
  fs.writeFileSync(path.join(outputDir, item.mediaPath), 'corrupt')
  assert.throws(() => materializeMedia({ outputDir, mediaSources: [item] }), /Existing media/)
})
