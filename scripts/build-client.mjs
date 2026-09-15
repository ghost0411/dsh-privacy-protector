/**
 * Builds the distributable client bundle at client/client.js by wrapping the
 * plain-CJS factory body in the loaders' browser wrapper. Mirrors the wrapper
 * shape emitted for dsh-file-upload's client so the web client runtime can
 * resolve it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client-src', 'index.js'), 'utf8')
const outDir = join(root, 'client')
mkdirSync(outDir, { recursive: true })

const head =
  '// Bundled by scripts/build-client.mjs from client-src/index.js. Do not edit.\n' +
  'window.__ModuleLoader__.load({ id: "dsh-privacy-protector", factory: (require) => { "use strict"; var module = { exports: {} }; var exports = module.exports;\n' +
  '(() => {\n'

const tail = '\n})();\nreturn module.exports; } });\n'

writeFileSync(join(outDir, 'client.js'), head + source + tail)