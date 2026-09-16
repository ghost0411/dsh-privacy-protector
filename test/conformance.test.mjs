import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVault } from '../lib/vault.js'
import { compileRules } from '../lib/rules.js'
import { anonymize, restoreText } from '../lib/sanitizer.js'

/**
 * The DSH plugin is one of THREE copies of the same 9 rules (Python gateway,
 * opencode plugin, DSH plugin). The canonical vectors live at the project root
 * so all three are checked against one file instead of drifting apart.
 *
 * The corpus is skipped, loudly, when this repository is checked out on its own
 * (it is published standalone as `ghost0411/dsh-privacy-protector`); inside the
 * project it always runs.
 */

const here = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(here, '..', '..', 'conformance', 'pii-vectors.json')

test('cross-implementation conformance corpus', { skip: !existsSync(corpusPath) && `not vendored: ${corpusPath} is absent outside the privacy_gateway project` }, () => {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
  const cases = corpus.cases
  assert.ok(Array.isArray(cases) && cases.length > 0, 'corpus must contain cases')

  const failures = []
  for (const testCase of cases) {
    const vault = createVault()
    const { text } = anonymize(testCase.input, vault, compileRules())
    if (text !== testCase.masked) {
      failures.push(
        `  ${testCase.name}\n` +
          `    input    ${JSON.stringify(testCase.input)}\n` +
          `    expected ${JSON.stringify(testCase.masked)}\n` +
          `    actual   ${JSON.stringify(text)}`,
      )
    }
    // Masking must stay reversible for every vector.
    if (restoreText(text, vault) !== testCase.input) {
      failures.push(`  round trip failed: ${testCase.name}`)
    }
  }
  assert.equal(failures.length, 0, `${failures.length}/${cases.length} vectors diverged:\n${failures.join('\n')}`)
})
