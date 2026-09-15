import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToggleFileStore, createVaultFileStore, detectSafeStorage } from '../lib/store.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-pp-'))
}

test('toggle store: save + load round-trips', () => {
  const dir = tmpDir()
  try {
    const store = createToggleFileStore(dir)
    store.save({ global: true, sessions: { a: true, b: false } })
    const loaded = store.load()
    assert.deepEqual(loaded, { global: true, sessions: { a: true, b: false }, guardian: undefined })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('toggle store: guardian arm + counters round-trip', () => {
  const dir = tmpDir()
  try {
    const store = createToggleFileStore(dir)
    store.save({
      global: false,
      sessions: {},
      guardian: { armed: true, sessions: { s1: { HEALTH: 2, FINANCE: 1 } } },
    })
    const loaded = store.load()
    assert.equal(loaded.guardian.armed, true)
    assert.deepEqual(loaded.guardian.sessions, { s1: { HEALTH: 2, FINANCE: 1 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('toggle store: load returns null when file missing', () => {
  const store = createToggleFileStore(tmpDir())
  assert.equal(store.load(), null)
})

test('toggle store: foreign/corrupt files degrade to null without throwing', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'toggles.json')
    writeFileSync(file, 'not json', 'utf8')
    const loaded = createToggleFileStore(dir).load()
    assert.equal(loaded, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('toggle store: non-boolean session values are coerced safely', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'toggles.json')
    writeFileSync(file, JSON.stringify({ version: 1, global: 'yes', sessions: { a: 1, b: true } }), 'utf8')
    const loaded = createToggleFileStore(dir).load()
    assert.equal(loaded.global, false)
    assert.deepEqual(loaded.sessions, { a: false, b: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault store without encryptor is memory-only (no-op save, null load)', () => {
  const dir = tmpDir()
  try {
    const store = createVaultFileStore(dir, null)
    assert.equal(store.persistent, false)
    store.save({ items: [['[PII:EMAIL:0]', 'x@example.com']], counters: { EMAIL: 1 } })
    assert.equal(existsSync(join(dir, 'vault.json')), false)
    assert.equal(store.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault store encrypts on disk; no cleartext value visible', () => {
  const dir = tmpDir()
  try {
    const encryptor = {
      encrypt: (text) => `ENC:${Buffer.from(text).toString('base64')}`,
      decrypt: (encoded) => {
        assert.ok(encoded.startsWith('ENC:'))
        return Buffer.from(encoded.slice(4), 'base64').toString()
      },
    }
    const store = createVaultFileStore(dir, encryptor)
    assert.equal(store.persistent, true)
    store.save({ items: [['[PII:EMAIL:0]', 'alice@qq.com']], counters: { EMAIL: 1 } })

    const raw = readFileSync(join(dir, 'vault.json'), 'utf8')
    assert.ok(!raw.includes('alice@qq.com'))
    assert.ok(raw.includes('ENC:'))

    const loaded = store.load()
    assert.deepEqual(loaded, {
      items: [['[PII:EMAIL:0]', 'alice@qq.com']],
      counters: { EMAIL: 1 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault store: load returns null when decrypt fails (foreign key)', () => {
  const dir = tmpDir()
  try {
    const encryptor = {
      encrypt: (text) => `A:${Buffer.from(text).toString('base64')}`,
      decrypt: (encoded) => Buffer.from(encoded.slice(2), 'base64').toString(),
    }
    const store = createVaultFileStore(dir, encryptor)
    store.save({ items: [['[PII:EMAIL:0]', 'x@y.com']], counters: {} })

    // Different key that cannot decode the stored payload.
    const other = {
      encrypt: (text) => `B:${Buffer.from(text).toString('base64')}`,
      decrypt: () => { throw new Error('key mismatch') },
    }
    assert.equal(createVaultFileStore(dir, other).load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectSafeStorage returns null outside Electron (plain Node)', () => {
  assert.equal(detectSafeStorage(), null)
})