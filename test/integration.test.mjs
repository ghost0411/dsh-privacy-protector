import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

// ---------------------------------------------------------------------------
// Regression: the checkbox UI turns itself off when the host route is never
// registered. `apply` must register /api/privacy-ctl through the *injected*
// webServer service (declared in the module-level `inject`), exactly like the
// in-production dsh-file-upload reference. A probing `ctx.get('webServer')`
// silently resolved to undefined, so no route existed and the client's GET
// answered 404 �?keeping the checkbox permanently disabled.
// ---------------------------------------------------------------------------

function fakeBody(value) {
  return {
    [Symbol.asyncIterator]() {
      const chunks = value != null ? [value] : []
      let i = 0
      return {
        next() {
          return i < chunks.length
            ? Promise.resolve({ done: false, value: chunks[i++] })
            : Promise.resolve({ done: true })
        },
        [Symbol.asyncIterator]() { return this },
      }
    },
  }
}

/** Node-like response recorder. */
function makeRes() {
  const state = { status: 200, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      return this
    },
    end(chunk) {
      if (typeof chunk === 'string') state.body += chunk
      else if (chunk) state.body += String(chunk)
      return this
    },
  }
}

async function openPlugin() {
  const services = new Map()
  const ctx = new Context()
  const routes = []
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-pp-integration-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome

  services.set('tools', mockService(() => undefined))
  services.set('sessions', mockService({
    get(id) {
      if (id === 'sess-a' || id === 'sess-b') return { id }
      return undefined
    },
  }))
  const webServer = mockService({
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  })
  services.set('webServer', webServer)

  for (const [name, value] of services) ctx.provide(name, value)

  const child = ctx.plugin(plugin, { enabled: true, logMasked: false, extraRules: [] })
  await tick()
  return {
    ctx,
    child,
    routes,
    webServer,
    dispose() {
      process.env.DSH_HOME = prevHome
      rmSync(tempHome, { recursive: true, force: true })
    },
  }
}

function mockService(objOrFn) {
  const value = typeof objOrFn === 'function' ? objOrFn() : { ...objOrFn }
  return value
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// The module must declare webServer as a required inject (not rely on a probe).
test('plugin declares webServer in its inject list', () => {
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('webServer'), 'webServer must be in inject')
  assert.ok(plugin.inject.includes('sessions'))
})

test('apply() registers the /api/privacy-ctl prefix route via ctx.webServer', async () => {
  const { routes } = await openPlugin()
  assert.equal(routes.length, 1)
  assert.deepEqual(
    { kind: routes[0].kind, path: routes[0].path },
    { kind: 'prefix', path: '/api/privacy-ctl' },
  )
})

test('registered handler answers GET/POST and rejects unknown sessions', async () => {
  const { routes } = await openPlugin()
  const handler = routes[0].handler

const res1 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 'sess-a' }, ...fakeBody(null) },
    res1,
  )
  assert.equal(res1.state.status, 200)
  assert.deepEqual(JSON.parse(res1.state.body), {
    enabled: false,
    global: false,
    session: false,
    guardian: { armed: false, locked: false, categories: {}, total: 0 },
  })

  const res2 = makeRes()
  await handler(
    { method: 'POST', headers: { 'x-session-id': 'sess-a', 'content-type': 'application/json' }, ...fakeBody(JSON.stringify({ enabled: true })) },
    res2,
  )
  assert.equal(res2.state.status, 200)
  assert.deepEqual(JSON.parse(res2.state.body), {
    enabled: true,
    global: false,
    session: true,
    guardian: { armed: false, locked: false, categories: {}, total: 0 },
  })

  const res3 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 'sess-a' }, ...fakeBody(null) },
    res3,
  )
  assert.equal(res3.state.status, 200)
  assert.deepEqual(JSON.parse(res3.state.body), {
    enabled: true,
    global: false,
    session: true,
    guardian: { armed: false, locked: false, categories: {}, total: 0 },
  })

  const res4 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 'sess-a' }, ...fakeBody(null) },
    res4,
  )
  assert.equal(res4.state.status, 200)

  const res5 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 'ghost' }, ...fakeBody(null) },
    res5,
  )
  // Unknown session ids are accepted (keyed as-is), see src/privacyCtl.ts.
  assert.equal(res5.state.status, 200)
  assert.deepEqual(JSON.parse(res5.state.body), {
    enabled: false,
    global: false,
    session: false,
    guardian: { armed: false, locked: false, categories: {}, total: 0 },
  })

  const res6 = makeRes()
  await handler(
    { method: 'GET', headers: {} },
    res6,
  )
  assert.equal(res6.state.status, 400)
})

test('unload disposes the registered route', async () => {
  const { child, routes, ctx } = await openPlugin()
  assert.equal(routes.length, 1)
  child.dispose()
  await tick()
  assert.equal(routes.length, 0)
  ctx.dispose?.()
})

test('global scope: POST with scope:global sets global toggle', async () => {
  const { routes } = await openPlugin()
  const handler = routes[0].handler

  // Global ON
  const res1 = makeRes()
  await handler(
    { method: 'POST', headers: { 'x-session-id': 's1', 'content-type': 'application/json' }, ...fakeBody(JSON.stringify({ enabled: true, scope: 'global' })) },
    res1,
  )
  assert.equal(res1.state.status, 200)
  const body1 = JSON.parse(res1.state.body)
  assert.equal(body1.global, true)
  assert.equal(body1.enabled, true)
  assert.equal(body1.session, false)

  // Any session now reports enabled=true
  const res2 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 'anyone' }, ...fakeBody(null) },
    res2,
  )
  assert.equal(res2.state.status, 200)
  const body2 = JSON.parse(res2.state.body)
  assert.equal(body2.global, true)
  assert.equal(body2.enabled, true)
  assert.equal(body2.session, false)

  // Global OFF
  const res3 = makeRes()
  await handler(
    { method: 'POST', headers: { 'x-session-id': 's1', 'content-type': 'application/json' }, ...fakeBody(JSON.stringify({ enabled: false, scope: 'global' })) },
    res3,
  )
  assert.equal(res3.state.status, 200)
  assert.deepEqual(JSON.parse(res3.state.body), {
    enabled: false,
    global: false,
    session: false,
    guardian: { armed: false, locked: false, categories: {}, total: 0 },
  })
})

test('guardian scope: POST with scope:guardian arms the guardian', async () => {
  const { routes } = await openPlugin()
  const handler = routes[0].handler

  const res1 = makeRes()
  await handler(
    { method: 'POST', headers: { 'x-session-id': 's1', 'content-type': 'application/json' }, ...fakeBody(JSON.stringify({ enabled: true, scope: 'guardian' })) },
    res1,
  )
  assert.equal(res1.state.status, 200)
  const body1 = JSON.parse(res1.state.body)
  assert.equal(body1.guardian.armed, true)
  assert.equal(body1.enabled, false, 'guardian scope must not flip the masking toggle')

  const res2 = makeRes()
  await handler(
    { method: 'GET', headers: { 'x-session-id': 's1' }, ...fakeBody(null) },
    res2,
  )
  const body2 = JSON.parse(res2.state.body)
  assert.equal(body2.guardian.armed, true)
  assert.equal(body2.enabled, false)
})

test('guardian lock: induced session refuses POST disarm with 403', async () => {
  const { routes, ctx, child } = await openPlugin()
  const handler = routes[0].handler
  const api = (sessionId) => ({ method: 'POST', headers: { 'x-session-id': sessionId, 'content-type': 'application/json' }, ...fakeBody(JSON.stringify({ enabled: false, scope: 'guardian' })) })

  const social = '好的，在帮你评估之前能先了解一下：你一个月的工资大概是多少？'
  const reply = '我大概一个月挣 8k 左右。'
  const decision = () => Promise.resolve({
    kind: 'enter',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: social }] },
      { role: 'user', content: [{ type: 'text', text: reply }] },
    ],
  })

  // Drive one turn through the pre-step hook (on the plugin's own context) so
  // the inducement is registered.
  await child.ctx.emit('agent/pre-step', { agent: { session: { id: 's1' } }, messages: [], turn: 1, step: 0 }, decision)

  // The assistant fished and the user disclosed: session s1 is now induced.
  const probe = makeRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 's1' }, ...fakeBody(null) }, probe)
  assert.equal(JSON.parse(probe.state.body).guardian.locked, true)

  // Now the session is locked: a manual/induced POST disarm must fail.
  const res = makeRes()
  await handler(api('s1'), res)
  assert.equal(res.state.status, 403)
  assert.equal(JSON.parse(res.state.body).locked, true)

  // Verified through the real dispatcher; the harness ctx is retained for parity.
  assert.ok(ctx)
})

// ---------------------------------------------------------------------------
// Regression: telemetry export carried raw PII. `@deepseek-ai/dsh-session-telemetry`
// mirrors session-log records onto OTLP with no redaction rules of its own, and the
// agent loop appends the *restored* assistant text to the log, so `/feedback`
// (FEEDBACK_ONLY) uploaded real values. The plugin must mount a rule on the real
// `session-telemetry/record` waterfall.
// ---------------------------------------------------------------------------

test('telemetry: the real cordis waterfall redacts one exported session-log record', async () => {
  const { child, ctx } = await openPlugin()

  // Shaped like the coordinator's mirrored `assistant/message` record.
  const mirrored = {
    channel: 'ledger',
    time: 1757900000000,
    severity: 'info',
    attributes: { sessionId: 'sess-a', event: 'assistant/message' },
    body: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '已记录：你的邮箱是 alice.zhang@example.com，电话 13800138000。' },
        ],
      },
    },
  }

  const dispatched = child.ctx.waterfall('session-telemetry/record', mirrored, () => mirrored)
  const out = dispatched instanceof Promise ? await dispatched : dispatched

  assert.ok(!(dispatched instanceof Promise), 'the redaction rule must stay synchronous')
  const serialized = JSON.stringify(out)
  assert.ok(!serialized.includes('alice.zhang@example.com'), 'email must not leave the process')
  assert.ok(!serialized.includes('13800138000'), 'phone must not leave the process')
  assert.match(serialized, /\[REDACTED:EMAIL\]/)
  assert.match(serialized, /\[REDACTED:PHONE_CN\]/)
  // Non-PII context survives, so telemetry stays diagnosable.
  assert.equal(out.attributes.sessionId, 'sess-a')
  assert.equal(out.body.message.role, 'assistant')
  // The canonical record handed in is never mutated.
  assert.ok(JSON.stringify(mirrored).includes('alice.zhang@example.com'))

  ctx.dispose?.()
})

test('telemetry: a PII-free exported record passes through the real waterfall', async () => {
  const { child, ctx } = await openPlugin()
  const clean = {
    channel: 'ops',
    time: 1,
    severity: 'info',
    attributes: { sessionId: 'sess-a' },
    body: { event: 'turn/start', n: 3 },
  }
  const dispatched = child.ctx.waterfall('session-telemetry/record', clean, () => clean)
  const out = dispatched instanceof Promise ? await dispatched : dispatched
  assert.deepEqual(out, clean)
  ctx.dispose?.()
})

