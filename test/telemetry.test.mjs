import test from 'node:test'
import assert from 'node:assert/strict'
import { compileRules } from '../lib/rules.js'
import { redactText } from '../lib/sanitizer.js'
import { redactRecord, installTelemetryRedaction } from '../lib/telemetry.js'

const RULES = compileRules()

function makeFakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, handler) {
      listeners.set(name, handler)
    },
    get(name) {
      return listeners.get(name)
    },
  }
}

function record(overrides = {}) {
  return {
    channel: 'ledger',
    time: 1757900000000,
    severity: 'info',
    attributes: {},
    body: undefined,
    ...overrides,
  }
}

test('redactText: PII becomes a one-way [REDACTED:TYPE] marker', () => {
  const out = redactText('mail bob@test.com or call 13800138000', RULES)
  assert.ok(!out.includes('bob@test.com'))
  assert.ok(!out.includes('13800138000'))
  assert.match(out, /\[REDACTED:EMAIL\]/)
  assert.match(out, /\[REDACTED:PHONE_CN\]/)
})

test('redactText: PII-free text is returned unchanged', () => {
  const text = 'just a normal sentence with 1234 and no secrets'
  assert.equal(redactText(text, RULES), text)
})

test('redactText: existing [PII:...] tokens are already safe and not re-wrapped', () => {
  const text = 'email is [PII:EMAIL:0] ok'
  assert.equal(redactText(text, RULES), text)
})

test('redactText: a second pass is idempotent (markers are not re-redacted)', () => {
  const once = redactText('mail bob@test.com', RULES)
  assert.equal(redactText(once, RULES), once)
})

test('redactText: redaction is NOT tied to the vault, so PASSWORD keeps its keyword', () => {
  const out = redactText('登录密码是 hunter2abc 请勿外传', RULES)
  assert.ok(out.includes('密码是'))
  assert.ok(!out.includes('hunter2abc'))
  assert.match(out, /\[REDACTED:PASSWORD\]/)
})

test('redactRecord: redacts attribute strings and preserves non-strings', () => {
  const out = redactRecord(
    record({ attributes: { note: 'mail bob@test.com', seq: 42, ok: true } }),
    RULES,
  )
  assert.match(out.attributes.note, /\[REDACTED:EMAIL\]/)
  assert.equal(out.attributes.seq, 42)
  assert.equal(out.attributes.ok, true)
})

test('redactRecord: walks a nested body deeply (arrays included)', () => {
  const out = redactRecord(
    record({
      body: {
        event: 'assistant/chunk',
        items: [
          { text: 'phone 13800138000' },
          { nested: { deeper: ['card 4111 1111 1111 1111'] } },
        ],
      },
    }),
    RULES,
  )
  const serialized = JSON.stringify(out.body)
  assert.ok(!serialized.includes('13800138000'))
  assert.ok(!serialized.includes('4111 1111 1111 1111'))
  assert.match(serialized, /\[REDACTED:PHONE_CN\]/)
  assert.match(serialized, /\[REDACTED:CREDIT_CARD\]/)
  assert.equal(out.body.event, 'assistant/chunk')
})

test('redactRecord: never mutates the input record or its nested body', () => {
  const input = record({
    attributes: { note: 'mail bob@test.com' },
    body: { items: [{ text: 'call 13800138000' }] },
  })
  const snapshot = JSON.stringify(input)
  const out = redactRecord(input, RULES)
  assert.equal(JSON.stringify(input), snapshot)
  assert.notEqual(out, input)
  assert.notEqual(out.body, input.body)
})

test('redactRecord: a PII-free record is returned by identity (no needless copy)', () => {
  const input = record({ attributes: { seq: 1 }, body: { event: 'x' } })
  assert.equal(redactRecord(input, RULES), input)
})

test('redactRecord: cyclic and exotic shapes do not throw or hang', () => {
  const cyclic = record()
  const body = { self: null, items: [] }
  body.self = body
  body.items.push(body)
  cyclic.body = body
  const out = redactRecord(cyclic, RULES)
  assert.ok(out)

  assert.equal(redactRecord(record({ body: null }), RULES).body, null)
  assert.equal(redactRecord(record({ body: undefined }), RULES).body, undefined)
  assert.equal(redactRecord(record({ body: 7 }), RULES).body, 7)
  assert.equal(redactRecord(record({ body: 'plain' }), RULES).body, 'plain')
})

test('redactRecord: deeply nested structures stop descending without throwing', () => {
  let deep = { text: 'mail bob@test.com' }
  for (let i = 0; i < 40; i++) deep = { down: deep }
  const out = redactRecord(record({ body: deep }), RULES)
  assert.ok(out)
})

test('installTelemetryRedaction: registers the waterfall and composes next()', () => {
  const ctx = makeFakeCtx()
  installTelemetryRedaction(ctx, RULES)
  const handler = ctx.get('session-telemetry/record')
  assert.ok(handler, 'listener must be registered on session-telemetry/record')

  const input = record({ attributes: { note: 'mail bob@test.com' }, body: { text: 'call 13800138000' } })
  let called = 0
  const out = handler(input, () => {
    called += 1
    return input
  })
  assert.equal(called, 1, 'next() must be invoked exactly once')
  assert.match(out.attributes.note, /\[REDACTED:EMAIL\]/)
  assert.match(out.body.text, /\[REDACTED:PHONE_CN\]/)
})

test('installTelemetryRedaction: the listener is synchronous (capture hot path)', () => {
  const ctx = makeFakeCtx()
  installTelemetryRedaction(ctx, RULES)
  const input = record({ attributes: { note: 'mail bob@test.com' } })
  const out = ctx.get('session-telemetry/record')(input, () => input)
  assert.ok(!(out instanceof Promise), 'a Promise would break the synchronous waterfall')
})

test('installTelemetryRedaction: an end-to-end session-log-shaped record carries no PII', () => {
  const ctx = makeFakeCtx()
  installTelemetryRedaction(ctx, RULES)
  // Shaped like the mirrored `assistant/message` the coordinator exports.
  const mirrored = record({
    channel: 'ledger',
    attributes: { sessionId: 'sess-1', event: 'assistant/message' },
    body: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '已记录，你的邮箱是 alice.zhang@example.com，电话 13800138000。' },
        ],
      },
    },
  })
  const out = ctx.get('session-telemetry/record')(mirrored, () => mirrored)
  const serialized = JSON.stringify(out)
  assert.ok(!serialized.includes('alice.zhang@example.com'))
  assert.ok(!serialized.includes('13800138000'))
  assert.match(serialized, /\[REDACTED:EMAIL\]/)
  assert.match(serialized, /\[REDACTED:PHONE_CN\]/)
  assert.equal(out.attributes.sessionId, 'sess-1')
})
