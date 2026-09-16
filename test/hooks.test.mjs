import test from 'node:test'
import assert from 'node:assert/strict'
import { createVault } from '../lib/vault.js'
import { compileRules } from '../lib/rules.js'
import { registerHooks } from '../lib/hooks.js'

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

const enabled = () => true
const disabled = () => false

test('registers all three DSH hooks', () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  assert.ok(ctx.get('agent/pre-step'))
  assert.ok(ctx.get('llm/stream'))
  assert.ok(ctx.get('tools/pre-execute'))
})

test('agent/pre-step: sanitizes text blocks and calls next()', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('agent/pre-step')

  const defaultDecision = async () => ({
    kind: 'enter',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '联系 bob@test.com 谢谢' }] },
    ],
  })
  const decision = await handler({ messages: [], turn: 1, step: 0 }, defaultDecision)

  assert.equal(decision.kind, 'enter')
  const blocks = decision.messages[0].content
  assert.match(blocks[0].text, /\[PII:EMAIL:/)
  assert.ok(!blocks[0].text.includes('bob@test.com'))
})

test('agent/pre-step: malformed input (undefined decision, non-enter kind) is safe', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('agent/pre-step')

  const d1 = await handler({ messages: [], turn: 1, step: 0 }, async () => undefined)
  assert.equal(d1, undefined)

  const d2 = await handler({ messages: [], turn: 1, step: 0 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(d2, { kind: 'reject' })
})

test('llm/stream: restores [PII:PASSWORD:0] in text-delta chunks, passes others through', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('llm/stream')

  vault.register('EMAIL', '[PII:EMAIL:4]')
  const up = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '联系 [PII:EMAIL:5]' }
    yield { type: 'finish', reason: 'stop' }
  })()

  async function* next() {
    yield* up
  }

  const out = handler({ provider: 'x', model: 'y' }, next)
  const chunks = []
  for await (const c of out) chunks.push(c)

  assert.ok(chunks[1].text.includes('[PII:EMAIL:0]') || chunks[1].text.includes('[PII:EMAIL:5]'))
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[2].type, 'finish')
})

// The real event field is `exec.arguments` (NOT `args`) and the registry hands it
// over deep-frozen; rewriting it is unsupported by design. This hook is a
// read-only backstop, so the mock below mirrors the real shape exactly.
// `test/contract.test.mjs` pins that shape against the installed DSH.
test('tools/pre-execute: never blocks, never mutates arguments, always delegates', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  const logs = []
  registerHooks(ctx, vault, compileRules(), enabled, (m) => { logs.push(m) })
  const handler = ctx.get('tools/pre-execute')
  const exec = Object.freeze({
    name: 'shell',
    arguments: Object.freeze({ cmd: ['echo hi'] }),
    agent: { session: { id: 'sess-1' } },
  })
  let called = 0
  const result = await handler(exec, async () => {
    called += 1
    return { kind: 'allow' }
  })
  assert.equal(called, 1)
  assert.deepEqual(result, { kind: 'allow' })
  assert.deepEqual(exec.arguments, { cmd: ['echo hi'] }, 'frozen arguments stay untouched')
  assert.deepEqual(logs, [], 'no warning when no placeholder reached the tool')
})

test('tools/pre-execute: warns (read-only) when a placeholder reached a tool un-restored', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  vault.register('EMAIL', '[PII:EMAIL:0]')
  const logs = []
  registerHooks(ctx, vault, compileRules(), enabled, (m) => { logs.push(m) })
  const handler = ctx.get('tools/pre-execute')
  const exec = Object.freeze({
    name: 'write',
    arguments: Object.freeze({ path: 'a.md', content: 'mail [PII:EMAIL:0]' }),
    agent: { session: { id: 'sess-1' } },
  })
  await handler(exec, async () => ({ kind: 'allow' }))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /un-restored/)
  assert.match(logs[0], /write/)
  // A placeholder the vault cannot resolve is not actionable and must not warn.
  logs.length = 0
  await handler(
    Object.freeze({ name: 'x', arguments: Object.freeze({ v: '[PII:EMAIL:99]' }) }),
    async () => ({ kind: 'allow' }),
  )
  assert.deepEqual(logs, [])
})

test('llm/stream: undefined/failing next() does not crash the listener', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('llm/stream')
  await assert.rejects(async () => {
    const out = handler({}, async () => {
      throw new Error('downstream failed')
    })
    for await (const c of out) void c
  }, /downstream failed/)
})

test('llm/stream: token split across multiple deltas is reassembled (buffered restore)', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('llm/stream')

  const original = '联系方式是 [PII:EMAIL:9]，请查收'
  const { text: masked } = (await import('../lib/sanitizer.js')).anonymize(original, vault, compileRules())

  const pieces = []
  for (let i = 0; i < masked.length; i++) {
    pieces.push(masked[i])
  }
  const up = (async function* () {
    for (const p of pieces) yield { type: 'text-delta', index: 0, text: p }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: masked } }
    yield { type: 'finish', reason: 'stop' }
  })()

  async function* next() {
    yield* up
  }

  const out = handler({}, next)
  const restored = []
  for await (const c of out) {
    if (c.type === 'text-delta') restored.push(c.text)
    if (c.type === 'block-end') restored.push(c.block.text)
  }
  assert.equal(restored.join(''), original + original,
    'delta stream AND assembled block both restore the original')
})

// ---------------------------------------------------------------------------
// Tool-call argument restoration.
//
// `tools/pre-execute` CANNOT rewrite `exec.arguments` (deep-frozen, and the
// event explicitly refuses rewrites), so restoration must happen on the streamed
// `tool-call-delta.argumentsDelta` fragments — the last writable point before
// `BlockAssembler` concatenates them into the frozen block the loop executes.
// ---------------------------------------------------------------------------

async function collect(iterable) {
  const out = []
  for await (const c of iterable) out.push(c)
  return out
}

test('llm/stream: restores a token inside a streamed tool-call argument delta', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const token = vault.register('EMAIL', 'alice.zhang@example.com')

  const up = (async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: `{"to":"${token}"` }
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: ',"n":1}' }
    yield { type: 'finish', reason: 'tool-calls' }
  })()

  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 's1' }, async function* () { yield* up }))
  const args = chunks.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join('')
  assert.deepEqual(JSON.parse(args), { to: 'alice.zhang@example.com', n: 1 })
  assert.ok(!args.includes('[PII:'), 'the tool must not receive a placeholder')
})

test('llm/stream: a restored value containing a quote stays valid JSON', async () => {
  // The API_KEY rule can capture a leading quote, so a stored value may contain
  // `"`. Splicing it in raw would corrupt the JSON arguments.
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const token = vault.register('API_KEY', 'api_key="s3cret\\value')

  const up = (async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: `{"k":"${token}"}` }
    yield { type: 'finish', reason: 'tool-calls' }
  })()

  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 's1' }, async function* () { yield* up }))
  const args = chunks.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join('')
  assert.equal(JSON.parse(args).k, 'api_key="s3cret\\value')
})

test('llm/stream: a tool-call token split across many deltas is reassembled', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const token = vault.register('PHONE_CN', '13800138000')
  const full = `{"phone":"${token}"}`

  const up = (async function* () {
    for (const ch of full) yield { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: ch }
    yield { type: 'finish', reason: 'tool-calls' }
  })()

  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 's1' }, async function* () { yield* up }))
  const args = chunks.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join('')
  assert.deepEqual(JSON.parse(args), { phone: '13800138000' })
})

test('llm/stream: an assembled tool-call block-end is restored (it wins over deltas)', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const token = vault.register('EMAIL', 'bob@example.com')

  const up = (async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 't', argumentsDelta: `{"e":"${token}"}` }
    // BlockAssembler: "first close wins", so this block replaces the deltas.
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 't', arguments: `{"e":"${token}"}` } }
    yield { type: 'finish', reason: 'tool-calls' }
  })()

  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 's1' }, async function* () { yield* up }))
  const end = chunks.find((c) => c.type === 'block-end')
  assert.deepEqual(JSON.parse(end.block.arguments), { e: 'bob@example.com' })
})

test('llm/stream: a bare "[" in prose or JSON is never swallowed', async () => {
  // Regression: the old tail buffer held any trailing "[", and only a later
  // chunk could flush it, so prose and JSON fragments lost text.
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('llm/stream')

  const prose = ['使用 [', '符号说明']
  const up = (async function* () {
    for (const text of prose) yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: 'stop' }
  })()
  const chunks = await collect(handler({ sessionId: 's1' }, async function* () { yield* up }))
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '使用 [符号说明')

  const upJson = (async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"note":"a [ b"}' }
    yield { type: 'finish', reason: 'tool-calls' }
  })()
  const chunks2 = await collect(handler({ sessionId: 's1' }, async function* () { yield* upJson }))
  const args = chunks2.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join('')
  assert.deepEqual(JSON.parse(args), { note: 'a [ b' })
})

test('llm/stream: a partial token held at end of stream is drained before finish', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const up = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'x [PII:EMAIL' }
    yield { type: 'finish', reason: 'stop' }
  })()
  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 's1' }, async function* () { yield* up }))
  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, ['text-delta', 'text-delta', 'finish'], 'tail drains before finish')
  assert.equal(chunks.map((c) => c.text ?? '').join(''), 'x [PII:EMAIL')
})

test('llm/stream: tool-call restoration is gated off per session', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), disabled, () => {})
  const token = vault.register('EMAIL', 'alice@example.com')
  const raw = `{"e":"${token}"}`
  const up = (async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: raw }
    yield { type: 'finish', reason: 'tool-calls' }
  })()
  const chunks = await collect(ctx.get('llm/stream')({ sessionId: 'off' }, async function* () { yield* up }))
  assert.equal(chunks[0].argumentsDelta, raw)
})


// ---------------------------------------------------------------------------
// Per-session gating tests
// ---------------------------------------------------------------------------

test('agent/pre-step: when disabled, passes through without touching messages', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), disabled, () => {})
  const handler = ctx.get('agent/pre-step')

  const input = '联系 bob@test.com 谢谢'
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
  })
  const result = await handler({ agent: { session: { id: 'sess-disabled' } }, messages: [], turn: 1, step: 0 }, decision)
  assert.equal(result.messages[0].content[0].text, input)
})

test('agent/pre-step: when enabled, masks as before', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('agent/pre-step')

  const input = '联系 alice@qq.com 谢谢'
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
  })
  const result = await handler({ agent: { session: { id: 'sess-enabled' } }, messages: [], turn: 1, step: 0 }, decision)
  assert.ok(!result.messages[0].content[0].text.includes('alice@qq.com'))
  assert.match(result.messages[0].content[0].text, /\[PII:EMAIL:/)
})

test('llm/stream: when disabled, upstream chunks pass through untouched', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), disabled, () => {})
  const handler = ctx.get('llm/stream')

  vault.register('EMAIL', '[PII:EMAIL:4]')
  const up = (async function* () {
    yield { type: 'text-delta', index: 0, text: '[PII:EMAIL:5]' }
  })()
  const out = handler({ sessionId: 'off' }, async function* () { yield* up })
  const chunks = []
  for await (const c of out) chunks.push(c)
  assert.equal(chunks[0].text, '[PII:EMAIL:5]')
})

test('tools/pre-execute: when disabled, delegates and stays silent', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  vault.register('EMAIL', '[PII:EMAIL:0]')
  const logs = []
  registerHooks(ctx, vault, compileRules(), disabled, (m) => { logs.push(m) })
  const handler = ctx.get('tools/pre-execute')
  const exec = Object.freeze({ name: 'x', arguments: Object.freeze({ val: '[PII:EMAIL:0]' }), agent: { session: { id: 'off' } } })
  let called = false
  await handler(exec, async () => { called = true; return {} })
  assert.ok(called)
  assert.equal(exec.arguments.val, '[PII:EMAIL:0]')
  assert.deepEqual(logs, [], 'a disabled session does no work and logs nothing')
})

test('agent/pre-step: undefined session id respects isEnabled (default-off)', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), disabled, () => {})
  const handler = ctx.get('agent/pre-step')

  const input = '联系 [PII:EMAIL:9] 谢谢'
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
  })
  const result = await handler({ messages: [], turn: 1, step: 0 }, decision)
  assert.equal(result.messages[0].content[0].text, input)
})

// ---------------------------------------------------------------------------
// Guardian (semantic disclosure masking) tests
//
// REAL PAYLOAD CONTRACT (the thing the old tests got wrong): the agent loop
// dispatches `agent/pre-step` with `messages = <the claimed user batch for this
// turn>` (its `inbox.claim()`), so `decision.messages` NEVER contains an
// assistant message. Assistant history comes from
// `payload.agent.session.deriveMessages()`. Mocks below mirror that split; the
// old ones put both roles in `decision.messages`, which made a permanently
// unreachable inducement lock look healthy.
// ---------------------------------------------------------------------------

/** A minimal stand-in for the live `Session` the payload carries. */
function sessionWithHistory(id, history = []) {
  return { id, deriveMessages: () => history }
}

function assistantTurn(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** The decision the loop's own default would produce: the user batch only. */
function enterWithUserText(text) {
  return async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })
}

async function armedGuardianCtx() {
  const { createGuardian } = await import('../lib/guardian.js')
  const ctx = makeFakeCtx()
  const vault = createVault()
  const guardian = createGuardian()
  guardian.setArmed(true)
  registerHooks(ctx, vault, compileRules(), enabled, () => {}, guardian)
  return { ctx, vault, guardian, handler: ctx.get('agent/pre-step') }
}

test('guardian: armed + enabled masks free-text disclosure and counts it', async () => {
  const { guardian, handler } = await armedGuardianCtx()
  const result = await handler(
    { agent: { session: sessionWithHistory('sess-g') }, messages: [], turn: 1, step: 0 },
    enterWithUserText('我月薪 3 万，最近想换工作'),
  )
  const text = result.messages[0].content[0].text
  assert.ok(!text.includes('3 万'))
  assert.match(text, /\[屏蔽:FINANCE:1\]/)
  assert.equal(guardian.countersOf('sess-g').FINANCE, 1)
})

test('guardian: disarmed passes text through untouched', async () => {
  const { createGuardian } = await import('../lib/guardian.js')
  const ctx = makeFakeCtx()
  const vault = createVault()
  const guardian = createGuardian()
  guardian.setArmed(false)
  registerHooks(ctx, vault, compileRules(), enabled, () => {}, guardian)
  const handler = ctx.get('agent/pre-step')

  const text = '我月薪 3 万'
  const result = await handler(
    { agent: { session: sessionWithHistory('sess-x') }, messages: [], turn: 1, step: 0 },
    enterWithUserText(text),
  )
  assert.equal(result.messages[0].content[0].text, text)
  assert.equal(guardian.getTotal(), 0)
})

test('guardian: format-level masking and semantic masking coexist', async () => {
  const { guardian, handler } = await armedGuardianCtx()
  const result = await handler(
    { agent: { session: sessionWithHistory('sess-c') }, messages: [], turn: 1, step: 0 },
    enterWithUserText('联系 x@y.com，我月薪 3 万'),
  )
  const text = result.messages[0].content[0].text
  assert.ok(!text.includes('x@y.com'))
  assert.ok(!text.includes('3 万'))
  assert.match(text, /\[PII:EMAIL:/)
  assert.match(text, /\[屏蔽:FINANCE:1\]/)
  assert.equal(guardian.countersOf('sess-c').FINANCE, 1)
})

async function disarmableGuardianCtx() {
  const { createGuardian } = await import('../lib/guardian.js')
  const ctx = makeFakeCtx()
  const vault = createVault()
  const guardian = createGuardian()
  guardian.setArmed(false)
  registerHooks(ctx, vault, compileRules(), enabled, () => {}, guardian)
  return { ctx, vault, guardian, handler: ctx.get('agent/pre-step') }
}

/** Assistant fish lives in session history; the disclosure is the claimed batch. */
function twoTurn(sessionId, assistantFish, userDisclosure) {
  return {
    payload: {
      agent: { session: sessionWithHistory(sessionId, [assistantTurn(assistantFish)]) },
      messages: [],
      turn: 2,
      step: 0,
    },
    decision: enterWithUserText(userDisclosure),
  }
}

test('guardian: assistant inducement + user disclosure locks the session (masks even when disarmed)', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const { payload, decision } = twoTurn('sess-l', '方便告诉我你一个月大概挣多少吗？', '我一个月挣 8k 左右')
  const result = await handler(payload, decision)
  const text = result.messages[0].content[0].text
  assert.ok(!text.includes('8k'), 'disclosure masked inside the locked turn')
  assert.match(text, /\[屏蔽:FINANCE:1\]/)
  assert.equal(guardian.isInduced('sess-l'), true, 'session is now induced/locked')
  assert.equal(guardian.shouldProtect('sess-l'), true)
  assert.equal(guardian.countersOf('sess-l').FINANCE, 1)
})

test('guardian: inducement with NO disclosure does not lock', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const { payload, decision } = twoTurn('sess-n', '方便告诉我你一个月大概挣多少吗？', '谢谢你的建议！')
  const result = await handler(payload, decision)
  assert.equal(result.messages[0].content[0].text, '谢谢你的建议！')
  assert.equal(guardian.isInduced('sess-n'), false)
  assert.equal(guardian.getTotal(), 0)
})

test('guardian: disclosure with NO inducement does not lock', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const { payload, decision } = twoTurn('sess-v', '好的，我明白你的意思了。', '我月薪 3 万')
  const result = await handler(payload, decision)
  // Voluntary (unprompted) disclosure: not an act of social engineering, so the
  // session is NOT locked; with the guard disarmed nothing is masked either.
  assert.equal(guardian.isInduced('sess-v'), false)
  assert.equal(result.messages[0].content[0].text, '我月薪 3 万', 'guard disarmed: voluntary disclosure left untouched')
})

test('guardian: an inducement alone in the batch (no history) never locks', async () => {
  // Regression guard for the bug this contract fixes: with the assistant text
  // absent from history there is no inducement, however the batch is worded.
  const { guardian, handler } = await disarmableGuardianCtx()
  const result = await handler(
    { agent: { session: sessionWithHistory('sess-empty') }, messages: [], turn: 1, step: 0 },
    enterWithUserText('你一个月挣多少？我一个月挣 8k'),
  )
  assert.equal(guardian.isInduced('sess-empty'), false)
  assert.equal(result.messages[0].content[0].text, '你一个月挣多少？我一个月挣 8k')
})

test('guardian: a session whose log cannot be projected degrades safely', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const broken = { id: 'sess-broken', deriveMessages: () => { throw new Error('log unavailable') } }
  const result = await handler(
    { agent: { session: broken }, messages: [], turn: 1, step: 0 },
    enterWithUserText('我月薪 3 万'),
  )
  assert.equal(result.messages[0].content[0].text, '我月薪 3 万')
  assert.equal(guardian.isInduced('sess-broken'), false)
})

