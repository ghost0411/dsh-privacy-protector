import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuardian, categoryLabel } from '../lib/guardian.js'

test('defaults: unarmed, no counters', () => {
  const g = createGuardian()
  assert.equal(g.isArmed(), false)
  assert.deepEqual(g.countersOf('s1'), {})
  assert.equal(g.getTotal(), 0)
})

test('arm toggle persists + notifies', () => {
  let notified = 0
  const g = createGuardian(() => { notified += 1 })
  g.setArmed(true)
  assert.equal(g.isArmed(), true)
  assert.equal(notified, 1)
  g.setArmed(false)
  assert.equal(notified, 2)
})

test('count increments per session + category; total sums', () => {
  const g = createGuardian()
  g.count('s1', 'HEALTH')
  g.count('s1', 'FINANCE')
  g.count('s2', 'HEALTH')
  assert.deepEqual(g.countersOf('s1'), { HEALTH: 1, FINANCE: 1 })
  assert.deepEqual(g.countersOf('s2'), { HEALTH: 1 })
  assert.equal(g.getTotal(), 3)
})

test('count ignores blank / undefined session ids', () => {
  const g = createGuardian()
  g.count(undefined, 'HEALTH')
  g.count('', 'FINANCE')
  assert.equal(g.getTotal(), 0)
})

test('snapshot + load round-trips', () => {
  const g = createGuardian()
  g.setArmed(true)
  g.count('s1', 'HEALTH')
  g.count('s1', 'WORK')
  const snap = g.snapshot()
  const h = createGuardian()
  h.load(snap)
  assert.equal(h.isArmed(), true)
  assert.deepEqual(h.countersOf('s1'), { HEALTH: 1, WORK: 1 })
})

test('load ignores invalid snapshots safely', () => {
  const g = createGuardian()
  g.load(null)
  g.load({ armed: 'yes' })
  g.load({ sessions: 'x' })
  assert.equal(g.isArmed(), false)
  assert.equal(g.getTotal(), 0)
})

test('categoryLabel maps categories to Chinese labels', () => {
  assert.equal(categoryLabel('HEALTH'), '健康')
  assert.equal(categoryLabel('FINANCE'), '财务')
  assert.equal(categoryLabel('WORK'), '工作')
  assert.equal(categoryLabel('RELATIONSHIP'), '亲密关系')
  assert.equal(categoryLabel('IDENTITY'), '身份')
})

test('induced sessions lock: shouldProtect when armed OR induced', () => {
  const g = createGuardian()
  g.setArmed(false)
  assert.equal(g.shouldProtect('u1'), false)
  g.markInduced('u1')
  assert.equal(g.isInduced('u1'), true)
  assert.equal(g.shouldProtect('u1'), true, 'induced session stays protected while disarmed')
  assert.equal(g.shouldProtect('u2'), false, 'other sessions unaffected')
})

test('induced lock can be cleared only explicitly', () => {
  const g = createGuardian()
  g.markInduced('u1')
  assert.equal(g.isInduced('u1'), true)
  g.clearInduced('u1')
  assert.equal(g.isInduced('u1'), false)
  assert.equal(g.shouldProtect('u1'), false)
})

test('induced set is transient: not persisted in snapshot', () => {
  const g = createGuardian()
  g.markInduced('u1')
  const h = createGuardian()
  h.load({ ...g.snapshot() })
  assert.equal(h.isInduced('u1'), false, 'locks are per-process only')
})