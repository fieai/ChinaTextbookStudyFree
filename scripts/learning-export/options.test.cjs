'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { options } = require('./index.cjs')

function assertRoots(config, thinkyRoot, evidenceRoot = thinkyRoot) {
  assert.equal(config['thinky-root'], thinkyRoot)
  assert.equal(config['evidence-root'], evidenceRoot)
  assert.equal(config.thinkyRoot, path.resolve(thinkyRoot))
  assert.equal(config.evidenceDir, path.resolve(evidenceRoot, 'docs/learning/evidence/wp-10'))
  assert.equal(config.dataDir, path.resolve(evidenceRoot, '.local/wp-10'))
}

test('both input roots default to the main Thinky checkout', () => {
  assertRoots(options([], {}), '/Users/my-project/AI-PROJECT/thinky')
  assertRoots(options([], { THINKY_ROOT: '' }), '/Users/my-project/AI-PROJECT/thinky')
})

test('THINKY_ROOT selects the contract without relocating frozen evidence and resolves relative paths', () => {
  assertRoots(options([], { THINKY_ROOT: 'custom/thinky' }), 'custom/thinky', '/Users/my-project/AI-PROJECT/thinky')
  assertRoots(options(['--thinky-root', 'custom/thinky'], {}), 'custom/thinky', '/Users/my-project/AI-PROJECT/thinky')
})

test('CLI roots override THINKY_ROOT independently', () => {
  const env = { THINKY_ROOT: '/env/thinky' }
  assertRoots(options(['--thinky-root', '/cli/thinky'], env), '/cli/thinky', '/Users/my-project/AI-PROJECT/thinky')
  assertRoots(options(['--evidence-root', '/cli/evidence'], env), '/env/thinky', '/cli/evidence')
  assertRoots(options(['--thinky-root', '/cli/thinky', '--evidence-root', '/cli/evidence'], env),
    '/cli/thinky', '/cli/evidence')
})

test('contract worktree and evidence can be selected independently for the full test suite', () => {
  assertRoots(options([], { THINKY_ROOT: '/contract/worktree', THINKY_EVIDENCE_ROOT: '/evidence/main' }), '/contract/worktree', '/evidence/main')
  assertRoots(options(['--evidence-root', '/cli/evidence'], { THINKY_ROOT: '/contract/worktree', THINKY_EVIDENCE_ROOT: '/evidence/main' }), '/contract/worktree', '/cli/evidence')
})
