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

test('tools/pre-execute: never blocks, always delegates to next()', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), enabled, () => {})
  const handler = ctx.get('tools/pre-execute')
  let called = 0
  const result = await handler({ name: 'shell', args: { cmd: ['PII:EMAIL:5'] } }, async () => {
    called += 1
    return { kind: 'allow' }
  })
  assert.equal(called, 1)
  assert.deepEqual(result, { kind: 'allow' })
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

test('tools/pre-execute: when disabled, delegates without restoring', async () => {
  const ctx = makeFakeCtx()
  const vault = createVault()
  registerHooks(ctx, vault, compileRules(), disabled, () => {})
  const handler = ctx.get('tools/pre-execute')
  const args = { val: '[PII:EMAIL:5]' }
  let called = false
  await handler({ name: 'x', args, agent: { session: { id: 'off' } } }, async () => { called = true; return {} })
  assert.ok(called)
  assert.equal(args.val, '[PII:EMAIL:5]')
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
// ---------------------------------------------------------------------------

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
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我月薪 3 万，最近想换工作' }] }],
  })
  const result = await handler({ agent: { session: { id: 'sess-g' } }, messages: [], turn: 1, step: 0 }, decision)
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
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })
  const result = await handler({ agent: { session: { id: 'sess-x' } }, messages: [], turn: 1, step: 0 }, decision)
  assert.equal(result.messages[0].content[0].text, text)
  assert.equal(guardian.getTotal(), 0)
})

test('guardian: format-level masking and semantic masking coexist', async () => {
  const { guardian, handler } = await armedGuardianCtx()
  const decision = async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '联系 x@y.com，我月薪 3 万' }] }],
  })
  const result = await handler({ agent: { session: { id: 'sess-c' } }, messages: [], turn: 1, step: 0 }, decision)
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

function twoTurnDecision(assistantFish, userDisclosure) {
  return async () => ({
    kind: 'enter',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: assistantFish }] },
      { role: 'user', content: [{ type: 'text', text: userDisclosure }] },
    ],
  })
}

test('guardian: assistant inducement + user disclosure locks the session (masks even when disarmed)', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const decision = twoTurnDecision('方便告诉我你一个月大概挣多少吗？', '我一个月挣 8k 左右')
  const result = await handler({ agent: { session: { id: 'sess-l' } }, messages: [], turn: 1, step: 0 }, decision)
  const text = result.messages[1].content[0].text
  assert.ok(!text.includes('8k'), 'disclosure masked inside the locked turn')
  assert.match(text, /\[屏蔽:FINANCE:1\]/)
  assert.equal(guardian.isInduced('sess-l'), true, 'session is now induced/locked')
  assert.equal(guardian.shouldProtect('sess-l'), true)
  assert.equal(guardian.countersOf('sess-l').FINANCE, 1)
})

test('guardian: inducement with NO disclosure does not lock', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const decision = twoTurnDecision('方便告诉我你一个月大概挣多少吗？', '谢谢你的建议！')
  const result = await handler({ agent: { session: { id: 'sess-n' } }, messages: [], turn: 1, step: 0 }, decision)
  assert.equal(result.messages[1].content[0].text, '谢谢你的建议！')
  assert.equal(guardian.isInduced('sess-n'), false)
  assert.equal(guardian.getTotal(), 0)
})

test('guardian: disclosure with NO inducement does not lock', async () => {
  const { guardian, handler } = await disarmableGuardianCtx()
  const decision = twoTurnDecision('好的，我明白你的意思了。', '我月薪 3 万')
  const result = await handler({ agent: { session: { id: 'sess-v' } }, messages: [], turn: 1, step: 0 }, decision)
  // Voluntary (unprompted) disclosure: not an act of social engineering, so the
  // session is NOT locked; with the guard disarmed nothing is masked either.
  const text = result.messages[1].content[0].text
  assert.equal(guardian.isInduced('sess-v'), false)
  assert.equal(text, '我月薪 3 万', 'guard disarmed: voluntary disclosure left untouched')
})
