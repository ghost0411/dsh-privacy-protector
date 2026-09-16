import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { probeSessionLogUpload, DSH_SESSION_LOG_FIELD } from '../lib/dshSafety.js'

/**
 * `dsh-session-log-deepseek` uploads the RAW session log to the model API as the
 * `dsh_session_log` request field when `enabled: true`. There is no redaction
 * hook we can mount, so the plugin's only defence is to notice the state and
 * warn loudly. These tests pin that probe.
 */

test('probe: reports "registered" when the session-log upload field is present', () => {
  const ctx = { deepseekLlmApiExtensions: { providers: new Map([[DSH_SESSION_LOG_FIELD, {}]]) } }
  const probe = probeSessionLogUpload(ctx)
  assert.equal(probe.state, 'registered')
  assert.match(probe.note, /dsh_session_log/)
})

test('probe: reports "absent" for an empty registry', () => {
  const ctx = { deepseekLlmApiExtensions: { providers: new Map() } }
  assert.equal(probeSessionLogUpload(ctx).state, 'absent')
})

test('probe: reports "absent" for unrelated fields only', () => {
  const ctx = { deepseekLlmApiExtensions: { providers: new Map([['something_else', {}]]) } }
  assert.equal(probeSessionLogUpload(ctx).state, 'absent')
})

test('probe: missing or unreadable registry reports "unknown", never "safe"', () => {
  assert.equal(probeSessionLogUpload({}).state, 'unknown')
  assert.equal(probeSessionLogUpload(undefined).state, 'unknown')
  assert.equal(probeSessionLogUpload({ deepseekLlmApiExtensions: {} }).state, 'unknown')
  assert.equal(probeSessionLogUpload({ deepseekLlmApiExtensions: { providers: {} } }).state, 'unknown')
  const thrower = {
    get deepseekLlmApiExtensions() {
      throw new Error('service unavailable')
    },
  }
  assert.equal(probeSessionLogUpload(thrower).state, 'unknown')
})

test('probe: falls back to ctx.get for a service that is not injected', () => {
  // `deepseekLlmApiExtensions` is intentionally NOT in the plugin's inject list,
  // so a context that only exposes it through `get(name)` must still be read.
  const registry = { providers: new Map([[DSH_SESSION_LOG_FIELD, {}]]) }
  const ctx = { get: (name) => (name === 'deepseekLlmApiExtensions' ? registry : undefined) }
  assert.equal(probeSessionLogUpload(ctx).state, 'registered')
  assert.equal(probeSessionLogUpload({ get: () => undefined }).state, 'unknown')
})

// ---------------------------------------------------------------------------
// End to end through the real plugin: the warning must appear on first use.
// ---------------------------------------------------------------------------

async function openPlugin(services, config = {}) {
  const ctx = new Context()
  const logs = []
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-pp-safety-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
  // Capture for the LIFETIME of the plugin: the warning fires on first model
  // use, which happens after `apply()` returns. The plugin prefers `ctx.logger`
  // (a cordis builtin), and a child context inherits an own property from its
  // parent, so stubbing here reaches the plugin's own context.
  const original = console.log
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    value: () => ({ info: (message) => logs.push(String(message)) }),
  })
  console.log = (...args) => { logs.push(args.join(' ')) }
  const child = ctx.plugin(await import('../lib/index.js'), {
    enabled: true,
    logMasked: true,
    redactTelemetry: false,
    warnUnsafeSinks: true,
    extraRules: [],
    ...config,
  })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  return {
    child,
    logs,
    dispose() {
      console.log = original
      process.env.DSH_HOME = prevHome
      rmSync(tempHome, { recursive: true, force: true })
    },
  }
}

function services(registry) {
  return {
    tools: {},
    sessions: { get: () => undefined },
    webServer: { register: () => () => {} },
    deepseekLlmApiExtensions: registry,
  }
}

test('warns once on first model use when the session-log upload is registered', async () => {
  const { child, logs, dispose } = await openPlugin(services({ providers: new Map([[DSH_SESSION_LOG_FIELD, {}]]) }))
  const decision = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  const payload = { agent: { session: { id: 's1' } }, messages: [], turn: 1, step: 0 }
  await child.ctx.emit('agent/pre-step', payload, decision)
  await child.ctx.emit('agent/pre-step', payload, decision)
  const warnings = logs.filter((line) => line.includes('DANGER'))
  assert.equal(warnings.length, 1, 'exactly one warning, not one per turn')
  assert.match(warnings[0], /dsh_session_log/)
  dispose()
})

test('stays silent when the session-log upload is not registered', async () => {
  const { child, logs, dispose } = await openPlugin(services({ providers: new Map() }))
  const decision = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  await child.ctx.emit(
    'agent/pre-step',
    { agent: { session: { id: 's1' } }, messages: [], turn: 1, step: 0 },
    decision,
  )
  assert.deepEqual(logs.filter((line) => line.includes('DANGER')), [])
  dispose()
})

test('warnUnsafeSinks:false disables the warning entirely', async () => {
  const { child, logs, dispose } = await openPlugin(
    services({ providers: new Map([[DSH_SESSION_LOG_FIELD, {}]]) }),
    { warnUnsafeSinks: false },
  )
  const decision = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  await child.ctx.emit(
    'agent/pre-step',
    { agent: { session: { id: 's1' } }, messages: [], turn: 1, step: 0 },
    decision,
  )
  assert.deepEqual(logs.filter((line) => line.includes('DANGER')), [])
  dispose()
})
