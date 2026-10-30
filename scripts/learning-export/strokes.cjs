'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { jsonBytes, sha256, inputFile, requireCondition: check } = require('./common.cjs')

/** Extract the frozen data asset; no prototype UI code or network runs. */
function readStrokeDocuments({ siteDir }) {
  const filename = path.join(siteDir, 'stroke-data.js')
  const licensePath = path.join(siteDir, 'vendor/hanzi-writer-data-ARPHICPL.txt')
  const source = fs.readFileSync(filename, 'utf8')
  const data = JSON.parse(vm.runInNewContext(`${source}\nJSON.stringify(window.STROKE_DATA)`, { window: {} }, { timeout: 1000 }))
  const references = {}, documents = []
  for (const [char, value] of Object.entries(data)) {
    check([...char].length === 1 && Array.isArray(value.strokes) && value.strokes.length > 0
      && value.strokes.every(stroke => typeof stroke === 'string' && stroke.length > 0)
      && Array.isArray(value.medians) && value.medians.length === value.strokes.length
      && value.medians.every(points => Array.isArray(points) && points.length > 0
        && points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))),
    `Invalid prototype stroke data: ${char}`)
    // Preserve the upstream strokes/medians object unchanged, including any additional source data.
    const bytes = Buffer.from(jsonBytes(value))
    const digest = sha256(bytes)
    references[char] = { sha256: digest, kind: 'document' }
    documents.push({ char, sha256: digest, kind: 'document', mime: 'application/json',
      mediaPath: `media/${digest}.json`, bytes })
  }
  return { references, documents, licenseBytes: fs.readFileSync(licensePath),
    inputFiles: [inputFile('prototype/stroke-data.js', filename), inputFile('prototype/vendor/hanzi-writer-data-ARPHICPL.txt', licensePath)] }
}

function strokeCoverage(content, strokes) {
  const required = new Set()
  for (const book of content.books) for (const { content: lesson } of book.lessons)
    for (const stage of [...(lesson.basicStages ?? []), ...(lesson.extension?.stages ?? [])])
      if (stage.widget === 'hanzi-write') for (const character of stage.props.characters) required.add(character.char)
  return { required: [...required], covered: [...required].filter(char => strokes.references[char]),
    missing: [...required].filter(char => !strokes.references[char]),
    source: '原型 stroke-data.js；hanzi-writer-data 2.0.1 / Make Me a Hanzi',
    license: 'Arphic Public License', licenseFile: 'Make-Me-a-Hanzi-LICENSE.txt',
    noticeFile: 'Make-Me-a-Hanzi-NOTICE.txt' }
}

const STROKE_NOTICE = `Make Me a Hanzi stroke data\n\nSource: prototype stroke-data.js, copied from hanzi-writer-data 2.0.1.\nUpstream: https://github.com/skishore/makemeahanzi\nDistributor: https://github.com/chanind/hanzi-writer-data\nLicense: Arphic Public License (included verbatim in Make-Me-a-Hanzi-LICENSE.txt).\nCopyright (C) 1999 Arphic Technology Co., Ltd.\n\nExporter transformation (2026-10-29): extracted each character's existing JSON object\nfrom the JavaScript wrapper into a separate UTF-8 JSON document, named by SHA256.\nThe stroke paths, medians and their order are unchanged. No warranty is provided.\nThese stroke documents remain freely available under the included license.\n`

module.exports = { readStrokeDocuments, strokeCoverage, STROKE_NOTICE }
