import test from 'node:test'
import assert from 'node:assert/strict'
import { createVault } from '../lib/vault.js'
import { compileRules } from '../lib/rules.js'
import { anonymize, restoreText } from '../lib/sanitizer.js'

const RULES = compileRules()

// ---------------------------------------------------------------------------
// 1. Streaming restore edge cases: tokens split across deltas
// ---------------------------------------------------------------------------

function restoreChunkNaive(chunkText, vault) {
  // Exactly what the current hooks.ts does
  return restoreText(chunkText, vault)
}

test('BUG CASE: a token split across two text-delta chunks is NOT restored', () => {
  const vault = createVault()
  const original = '联系方式是 alice@example.com，请查收'
  const { text: masked } = anonymize(original, vault, RULES)

  const half = Math.floor(masked.length / 2)
  const c1 = masked.slice(0, half)
  const c2 = masked.slice(half)
  assert.ok(c1.includes('[') && !c1.includes(']'), 'first chunk contains an open token bracket')
  assert.ok(c2.includes(']'))

  const r1 = restoreChunkNaive(c1, vault)
  const r2 = restoreChunkNaive(c2, vault)
  const joined = r1 + r2
  assert.notEqual(joined, original, 'naive per-chunk restore loses the split token')
  assert.ok(!joined.includes('alice@example.com'))
  assert.match(joined, /\[PII:/, 'user sees a broken placeholder')
})

function restoreBuffered(chunks, vault) {
  // Correct buffered strategy: hold the open-bracket tail, restore the rest.
  const out = []
  let buf = ''
  for (const c of chunks) {
    const combined = buf + c
    const open = combined.lastIndexOf('[')
    let head, tail
    if (open >= 0 && !combined.slice(open).includes(']')) {
      head = combined.slice(0, open)
      tail = combined.slice(open)
    } else {
      head = combined
      tail = ''
    }
    out.push(restoreText(head, vault))
    buf = tail
  }
  if (buf) out.push(buf)
  return out.join('')
}

test('FIX PREVIEW: buffered restore reassembles a token split across chunks', () => {
  const vault = createVault()
  const original = '联系方式是 alice@example.com，请查收'
  const { text: masked } = anonymize(original, vault, RULES)

  for (const splitAt of [1, 2, 5, Math.floor(masked.length / 2), masked.length - 1]) {
    const c1 = masked.slice(0, splitAt)
    const c2 = masked.slice(splitAt)
    const joined = restoreBuffered([c1, c2], vault)
    assert.equal(joined, original, `split at ${splitAt}`)
  }
})

// ---------------------------------------------------------------------------
// 2. The cross-turn leak: what the session log stores is what the model sees
// ---------------------------------------------------------------------------

test('BUG CASE: restoring at llm/stream leaks the true value to the session log', () => {
  const vault = createVault()
  const userMsg = '我的电话 13800138000'
  const masked = anonymize(userMsg, vault, RULES).text

  // Model answers BY ECHOING the masked value (as it should)
  const modelReplyWithTokens = `收到，${masked.replace('我的电话', '你的电话')}`
  // llm/stream restore layer rewrites what is then LOGGED to the session
  const logged = restoreText(modelReplyWithTokens, vault)

  assert.ok(logged.includes('13800138000'),
    'restored assistant text enters the session log with the REAL phone number')
  // next turn: deriveMessages() replays the log -> model sees the real number
  assert.match(logged, /13800138000/, 'privacy is broken from turn 2 onward')
})

// ---------------------------------------------------------------------------
// 3. Scale + stability stress
// ---------------------------------------------------------------------------

test('large input: masking 1000 emails in one string stays correct', () => {
  const vault = createVault()
  const text = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`).join(' ')
  const { text: masked, count } = anonymize(text, vault, RULES)
  assert.equal(count, 1000)
  assert.equal(restoreText(masked, vault), text)
  assert.equal(vault.size, 1000)
})

test('repeated identical value maps to one token (no counter blowup)', () => {
  const vault = createVault()
  const { text: masked, count } = anonymize('x@x.com x@x.com x@x.com', vault, RULES)
  assert.equal(count, 3)
  assert.equal((masked.match(/\[PII:EMAIL:/g) ?? []).length, 3)
  assert.equal(vault.size, 1)
})

test('non-PII text is untouched end-to-end (false positive audit)', () => {
  const samples = [
    '今天的会议改到明天下午三点',
    '订单号 202609141200 已发货',
    '文件的总大小是 42MB',
    '计算公式 a = b + c',
    '第 1001 条记录',
  ]
  for (const s of samples) {
    const vault = createVault()
    const { text, count } = anonymize(s, vault, RULES)
    assert.equal(count, 0, `should not mask: ${s}`)
    assert.equal(text, s)
  }
})

test('restore of unknown token keeps the placeholder (no materal shift)', () => {
  const vault = createVault()
  assert.equal(restoreText('foo [PII:ZZZ:9] bar', vault), 'foo [PII:ZZZ:9] bar')
})

// ---------------------------------------------------------------------------
// 4. Determinism: same input + fresh vault yields identical output
// ---------------------------------------------------------------------------

test('deterministic across runs', () => {
  const input = '邮箱 a@b.com 手机 13900000000 vpn[PII:IP:0]'
  const run = () => {
    const vault = createVault()
    return anonymize(input, vault, RULES).text
  }
  assert.equal(run(), run())
})