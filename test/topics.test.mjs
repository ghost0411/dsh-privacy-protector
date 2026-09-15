import test from 'node:test'
import assert from 'node:assert/strict'
import { scanTopics } from '../lib/topics.js'

test('detects finance disclosure: "我月薪 3 万" masks and reports FINANCE', () => {
  const r = scanTopics('我月薪 3 万，今年准备换车')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['FINANCE'])
  assert.ok(!r.masked.includes('3 万'))
  assert.match(r.masked, /\[屏蔽:FINANCE:1\]/)
})

test('detects finance disclosure: "我一个月挣 8k"', () => {
  const r = scanTopics('我一个月挣 8k 左右')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['FINANCE'])
  assert.ok(!r.masked.includes('8k'))
})

test('health disclosure: "我确诊了糖尿病" is masked', () => {
  const r = scanTopics('我确诊了糖尿病，需要长期吃药')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['HEALTH'])
  assert.ok(!r.masked.includes('糖尿病'))
})

test('health disclosure: "我爸有高血压" is masked (family member)', () => {
  const r = scanTopics('我爸有高血压，最近在吃药')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['HEALTH'])
})

test('work disclosure: "我在XX公司做销售总监" is masked', () => {
  const r = scanTopics('我在XX科技有限公司做销售总监')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['WORK'])
  assert.match(r.masked, /\[屏蔽:WORK:1\]/)
})

test('relationship disclosure: "我和我老公感情不好" is masked', () => {
  const r = scanTopics('我和我老公感情不好，经常吵架')
  assert.equal(r.hit, true)
  assert.deepEqual(r.categories, ['RELATIONSHIP'])
  assert.ok(!r.masked.includes('老公'))
})

test('multiple categories in one message are all reported', () => {
  const r = scanTopics('我月薪 3 万，有糖尿病，我和我老婆最近在冷战')
  assert.equal(r.hit, true)
  const cats = r.categories.slice()
  assert.ok(cats.includes('FINANCE'))
  assert.ok(cats.includes('HEALTH'))
  assert.ok(cats.includes('RELATIONSHIP'))
})

test('neutral/technical asks without personal disclosure are NOT masked', () => {
  assert.equal(scanTopics('工资条怎么算扣除的？').hit, false)
  assert.equal(scanTopics('糖尿病饮食要注意什么？').hit, false)
  assert.equal(scanTopics('如何做销售总监的季度汇报？').hit, false)
  assert.equal(scanTopics('hello world').hit, false)
})

test('non-string / empty input passes through as no-hit', () => {
  assert.deepEqual(scanTopics(''), { categories: [], masked: '', hit: false })
  assert.equal(scanTopics(undefined).hit, false)
})