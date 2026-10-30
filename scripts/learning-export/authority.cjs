'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Module, createRequire } = require('node:module')

/** Compile the read-only authority modules in memory. No Thinky build or file writes. */
function loadAuthority(thinkyRoot) {
  const externalRequire = createRequire(path.join(thinkyRoot, 'package.json'))
  const ts = externalRequire('typescript')
  const cache = new Map()
  const directory = path.join(thinkyRoot, 'src/modules/learning-v2/content-release')
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports
    if (!['content-package', 'content-validation', 'activity-validation', 'content-media-references'].includes(name))
      throw new Error(`Unexpected authority module: ${name}`)
    const filename = path.join(directory, `${name}.ts`)
    const instance = new Module(filename)
    instance.filename = filename
    instance.paths = Module._nodeModulePaths(directory)
    instance.require = request => request.startsWith('./') ? load(request.slice(2)) : externalRequire(request)
    cache.set(name, instance)
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    })
    instance._compile(result.outputText, filename)
    return instance.exports
  }
  return {
    ...load('content-package'),
    ...load('content-validation'),
    contract: externalRequire('@thinky/learning-contract'),
    z: externalRequire('zod').z,
    inputPaths: [
      ...[...cache.keys()].map(name => path.join(directory, `${name}.ts`)),
      externalRequire.resolve('@thinky/learning-contract'),
    ],
  }
}

module.exports = { loadAuthority }
