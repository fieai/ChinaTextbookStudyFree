'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Fixed project namespace; changing this would break cross-release logical identity.
const NAMESPACE = '7cf6f510-4932-5bc9-99bc-35ce4d897d72'
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, canonicalize(value[key])]))
  return value
}

const contentHash = value => sha256(JSON.stringify(canonicalize(value)))

function packageHash(value) {
  const { manifestSha256, ...payload } = value
  return contentHash({
    ...payload,
    books: [...value.books].sort((a, b) => compare(a.sourceBookId, b.sourceBookId))
      .map(book => ({ ...book, lessons: [...book.lessons].sort((a, b) => a.ordinal - b.ordinal) })),
    knowledgePoints: [...value.knowledgePoints].sort((a, b) => compare(a.id, b.id)),
    questions: [...value.questions].sort((a, b) => compare(a.id, b.id)),
  })
}

function logicalKey(kind, locator) {
  const bytes = crypto.createHash('sha1').update(Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex'))
    .update(`${kind}/${locator}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'))
const jsonBytes = value => `${JSON.stringify(value, null, 2)}\n`

function inputFile(label, filename) {
  return { label, path: path.resolve(filename), sha256: sha256(fs.readFileSync(filename)) }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

module.exports = { NAMESPACE, sha256, compare, contentHash, packageHash, logicalKey, readJson, jsonBytes, inputFile, requireCondition }
