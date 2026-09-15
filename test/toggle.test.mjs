import test from 'node:test'
import assert from 'node:assert/strict'
import { createToggleRegistry } from '../lib/toggle.js'
import { createPrivacyCtlHandler } from '../lib/privacyCtl.js'

/** Build a fake request with an async-iterable body. */
function makeFakeReq(method, headers, body) {
  return {
    method,
    headers,
    [Symbol.asyncIterator]() {
      const chunks = body != null ? [body] : []
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

// ---------------------------------------------------------------------------
// ToggleRegistry
// ---------------------------------------------------------------------------

test('defaults to false for unknown sessions', () => {
  const t = createToggleRegistry()
  assert.equal(t.get('abc'), false)
})

test('defaults to false for blank / undefined ids', () => {
  const t = createToggleRegistry()
  assert.equal(t.get(undefined), false)
  assert.equal(t.get(''), false)
})

test('set + get round-trips', () => {
  const t = createToggleRegistry()
  t.set('a', true)
  assert.equal(t.get('a'), true)
  t.set('a', false)
  assert.equal(t.get('a'), false)
})

test('sessions are isolated from each other', () => {
  const t = createToggleRegistry()
  t.set('x', true)
  t.set('y', false)
  assert.equal(t.get('x'), true)
  assert.equal(t.get('y'), false)
})

test('set ignores blank session ids', () => {
  const t = createToggleRegistry()
  t.set('', true)
  t.set(undefined, true)
  assert.equal(t.get(''), false)
  assert.equal(t.get(undefined), false)
})

// ---------------------------------------------------------------------------
// PrivacyCtlHandler
// ---------------------------------------------------------------------------

function makeFakeRes() {
  let status
  let headers
  let body
  return {
    get status() { return status },
    get headers() { return headers },
    get body() { return body },
    writeHead(s, h) { status = s; headers = h; },
    end(b) { body = b; },
  }
}

test('GET returns disabled by default', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 's1' } }, res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).enabled, false)
})

test('POST enables then GET reads enabled', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res1 = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 's1', 'content-type': 'application/json' }, '{"enabled":true}'), res1)
  assert.equal(res1.status, 200)
  assert.equal(JSON.parse(res1.body).enabled, true)

  const res2 = makeFakeRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 's1' } }, res2)
  assert.equal(JSON.parse(res2.body).enabled, true)
})

test('any non-empty session id is accepted and keyed as-is', async () => {
  // The client-issued slot id is NOT resolvable through the host sessions
  // store (regression: strict validation 403'd every live request). The
  // toggle simply keys by the id string, like dsh-file-upload's metadata map.
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res1 = makeFakeRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'ghost-session' } }, res1)
  assert.equal(res1.status, 200)
  assert.equal(JSON.parse(res1.body).enabled, false)

  const res2 = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 'ghost-session' }, '{"enabled":true}'), res2)
  assert.equal(res2.status, 200)
  assert.equal(JSON.parse(res2.body).enabled, true)
})

test('missing session header returns 400', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.status, 400)
})

test('POST with invalid JSON body returns 400', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 's1' }, 'not json'), res)
  assert.equal(res.status, 400)
})

test('POST with missing "enabled" key returns 400', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 's1' }, '{"other":true}'), res)
  assert.equal(res.status, 400)
})

test('non-GET/POST method returns 405', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler({ method: 'DELETE', headers: { 'x-session-id': 's1' } }, res)
  assert.equal(res.status, 405)
})

test('different sessions are isolated', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)

  // Enable for session 'a'
  const res1 = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 'a' }, '{"enabled":true}'), res1)
  assert.equal(JSON.parse(res1.body).enabled, true)

  // Session 'b' should still be off
  const res2 = makeFakeRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'b' } }, res2)
  assert.equal(JSON.parse(res2.body).enabled, false)
})

// ---------------------------------------------------------------------------
// Global toggle
// ---------------------------------------------------------------------------

test('global defaults to false', () => {
  const t = createToggleRegistry()
  assert.equal(t.getGlobal(), false)
})

test('global toggle: setGlobal + getGlobal round-trips', () => {
  const t = createToggleRegistry()
  t.setGlobal(true)
  assert.equal(t.getGlobal(), true)
  t.setGlobal(false)
  assert.equal(t.getGlobal(), false)
})

test('isEnabled returns true when global is ON even if session is OFF', () => {
  const t = createToggleRegistry()
  t.set('x', false)
  t.setGlobal(true)
  assert.equal(t.isEnabled('x'), true)
  assert.equal(t.isEnabled(undefined), true)
})

test('isEnabled returns session value when global is OFF', () => {
  const t = createToggleRegistry()
  t.set('x', true)
  t.setGlobal(false)
  assert.equal(t.isEnabled('x'), true)
  assert.equal(t.isEnabled('y'), false)
})

test('POST scope:global sets global and returns {global,session,enabled}', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 's1' }, '{"enabled":true,"scope":"global"}'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.global, true)
  assert.equal(body.session, false)
  assert.equal(body.enabled, true)
})

test('POST scope:session (default) sets per-session', async () => {
  const toggles = createToggleRegistry()
  const handler = createPrivacyCtlHandler({}, toggles)
  const res = makeFakeRes()
  await handler(makeFakeReq('POST', { 'x-session-id': 's1' }, '{"enabled":true}'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.global, false)
  assert.equal(body.session, true)
  assert.equal(body.enabled, true)
})