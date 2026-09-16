import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runtime half of the DSH contract.
 *
 * `test/types/dsh-contract.ts` proves the field names at COMPILE time from the
 * real `@deepseek-ai/*` declarations. This file proves the same thing at RUN
 * time, in the default `npm test` run, so the guarantee survives even if
 * someone drops the contract tsconfig from the build:
 *
 *   1. the authoritative declarations are really present and really say what we
 *      think (not a local stand-in), and
 *   2. `src/hooks.ts` reads those exact fields.
 *
 * Background: the plugin once read `exec.args` for `tools/pre-execute`. The real
 * field is `exec.arguments`. A hand-written mock used the same wrong name, so
 * both agreed and tool-argument restoration was silently dead.
 */

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pluginRoot = join(here, '..')

function readPackageFile(pkg, relative) {
  return readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), relative), 'utf8')
}

const hooksSource = readFileSync(join(pluginRoot, 'src', 'hooks.ts'), 'utf8')

/**
 * Comments in this file deliberately QUOTE the historical bug (`exec.args`), so
 * negative checks must run against code only, never against prose.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const hooksCode = stripComments(hooksSource)

test('DSH declares tools/pre-execute with `arguments`, not `args`', () => {
  const types = readPackageFile('@deepseek-ai/dsh-tools', 'lib/types/index.d.ts')
  assert.match(types, /'tools\/pre-execute'/, 'the event must be declared by dsh-tools')
  assert.match(types, /readonly arguments: unknown/, 'ToolExecutionInput.arguments must exist')
  assert.match(types, /readonly name: string/)
  assert.ok(!/interface ToolExecutionInput \{[^}]*\bargs\b/s.test(types), '`args` must not be a field')
  // And the decision type cannot express a rewrite — the reason we restore upstream.
  assert.match(types, /export type PreToolDecision = \{\s*kind: 'allow'/)
  assert.match(types, /Input rewriting is excluded/)
})

test('DSH streams tool-call arguments as `tool-call-delta.argumentsDelta`', () => {
  const events = readPackageFile('@deepseek-ai/dsh-llm', 'lib/types/index.d.ts')
  assert.match(events, /'llm\/stream'/, 'the event must be declared by dsh-llm')
  const types = readPackageFile('@deepseek-ai/dsh-llm', 'lib/types/types.d.ts')
  assert.match(types, /type: 'tool-call-delta'/)
  assert.match(types, /argumentsDelta: string/)
  assert.match(types, /type: 'text-delta'/)
  assert.match(types, /type: 'finish'/)
})

test('DSH dispatches agent/pre-step with the user batch only', () => {
  const types = readPackageFile('@deepseek-ai/dsh-agent', 'lib/types/runtime-types.d.ts')
  assert.match(types, /'agent\/pre-step'/, 'the event must be declared by dsh-agent')
  // `messages` is documented as UserMessage[] — NOT the whole conversation. Any
  // logic needing the assistant side must read Session.deriveMessages().
  assert.match(types, /messages: UserMessage\[\];/)
  assert.match(types, /export type PreStepDecision = \{\s*kind: 'reject'/)
})

test('Session exposes the derived history the guardian needs', () => {
  const types = readPackageFile('@deepseek-ai/dsh-session', 'lib/types/index.d.ts')
  assert.match(types, /deriveMessages\(\): Message\[\]/)
})

test('src/hooks.ts reads the real field names', () => {
  assert.match(hooksCode, /countRestorableTokens\(exec\.arguments/, 'must read exec.arguments')
  assert.ok(!/exec\.args\b/.test(hooksCode), 'must not read the non-existent exec.args')
  assert.match(hooksCode, /argumentsDelta/, 'must restore streamed tool-call arguments')
  assert.match(hooksCode, /exec: ToolExecution/, 'must type the handler with the real ToolExecution')
  assert.match(hooksCode, /deriveMessages\(\)/, 'must read assistant history from the session')
  // The plugin must not hand-write DSH event payloads any more: the whole point
  // is that upstream is the single source of truth.
  assert.ok(
    !/declare module '@deepseek-ai\/cordis'/.test(hooksCode),
    'must not re-declare DSH events locally',
  )
})
