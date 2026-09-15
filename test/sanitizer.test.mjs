import test from 'node:test'
import assert from 'node:assert/strict'
import { createVault } from '../lib/vault.js'
import { compileRules } from '../lib/rules.js'
import { anonymize, restoreText } from '../lib/sanitizer.js'

const RULES = compileRules()

test('masks EMAIL, PHONE_CN, ID_CN, SSN_US, CREDIT_CARD, IP, API_KEY, SK_KEY', () => {
  const text =
    'contact alice@example.com or 13800138000; id 11010119900307123X; ssn 123-45-6789; ' +
    'card 4111 1111 1111 1111; ip 192.168.1.1; api_key=abc123def456; sk-sk-abcdefghijklmnop123456'
  const vault = createVault()
  const { text: result, count } = anonymize(text, vault, RULES)
  assert.ok(count >= 7, `expected >=7 hits, got ${count}`)
  assert.ok(!result.includes('alice@example.com'))
  assert.ok(!result.includes('4111 1111'))
  assert.ok(!result.includes('sk-sk-abcdefghijklmnop123456'))
  assert.match(result, /\[PII:EMAIL:/)
  assert.match(result, /\[PII:PHONE_CN:/)
})

test('roundtrip: anonymize then restore returns original', () => {
  const original =
    '联系 13800138000，邮箱 user@test.dev，银行卡 6222 0210 1234 5678，内网 10.0.0.1'
  const vault = createVault()
  const { text: masked } = anonymize(original, vault, RULES)
  assert.notEqual(masked, original)
  const restored = restoreText(masked, vault)
  assert.equal(restored, original)
})

test('idempotent: already-masked text is not re-masked', () => {
  const vault = createVault()
  const first = anonymize('email me@here.com', vault, RULES)
  const sizeAfterFirst = vault.size
  const second = anonymize(first.text, vault, RULES)
  assert.equal(second.count, 0)
  assert.equal(vault.size, sizeAfterFirst)
  assert.equal(second.text, first.text)
})

test('PASSWORD rule keeps the keyword, masks only the value', () => {
  const vault = createVault()
  const { text, count } = anonymize('我的登录密码是 hunter2, 请勿外传', vault, RULES)
  assert.equal(count, 1)
  assert.ok(text.includes('密码是'))
  assert.ok(!text.includes('hunter2'))
})

test('PASSWORD rule does not fire on bare digit strings (order numbers)', () => {
  const vault = createVault()
  const { text, count } = anonymize('订单号 202609141200', vault, RULES)
  assert.equal(count, 0)
  assert.equal(text, '订单号 202609141200')
})

test('vault dedupes identical values to the same token', () => {
  const vault = createVault()
  const a = anonymize('a@b.com x a@b.com', vault, RULES)
  assert.equal(vault.size, 1)
  const matches = a.text.match(/\[PII:EMAIL:\d+\]/g) ?? []
  assert.equal(matches.length, 2)
  assert.equal(matches[0], matches[1])
})

test('restoreText passes non-token text through untouched', () => {
  const vault = createVault()
  assert.equal(restoreText('hello world', vault), 'hello world')
  assert.equal(restoreText('[PII:UNKNOWN:99]', vault), '[PII:UNKNOWN:99]')
})