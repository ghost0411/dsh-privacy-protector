/**
 * Token<->value vault.
 *
 * ONE GLOBAL INSTANCE, shared by every session in the process: `index.ts`
 * creates it once in `apply()` and hands the same object to every hook. Tokens
 * are namespaced by TYPE only (`[PII:EMAIL:0]`), never by session, so two
 * sessions that disclose the same value share one token (and one vault entry).
 * Session isolation lives in the *toggle* (`toggle.ts`), not here.
 *
 * It DOES survive a restart. Since v0.3.0 `index.ts` persists
 * `snapshot()` through `createVaultFileStore`, which encrypts it with Electron
 * `safeStorage` (DPAPI on Windows) before writing `vault.json`. When
 * safeStorage is unavailable the store degrades to memory-only and PII is never
 * written in cleartext — so "does not persist" is true only on that fallback
 * path, not unconditionally as this comment used to claim.
 */

export interface VaultSnapshot {
  items: Array<[string, string]>
  counters: Record<string, number>
}

export interface Vault {
  register(type: string, value: string): string
  lookup(token: string): string | undefined
  readonly size: number
  /** Serializable snapshot for encrypted disk persistence. */
  snapshot(): VaultSnapshot
  /** Restore from a snapshot. Invalid data is ignored safely. */
  load(snapshot: Partial<VaultSnapshot> | null | undefined): void
}

export function createVault(onMutate?: () => void): Vault {
  const items = new Map<string, string>()
  const byValue = new Map<string, string>()
  const counters = new Map<string, number>()

  const notify = () => {
    try { onMutate?.() } catch { /* persistence must never break masking */ }
  }

  return {
    register(type, value) {
      const existing = byValue.get(value)
      if (existing !== undefined) return existing
      let n = counters.get(type) ?? 0
      let token = `[PII:${type}:${n}]`
      while (items.has(token)) {
        n += 1
        token = `[PII:${type}:${n}]`
      }
      items.set(token, value)
      byValue.set(value, token)
      counters.set(type, n + 1)
      notify()
      return token
    },

    lookup(token) {
      return items.get(token)
    },

    get size() {
      return items.size
    },

    snapshot() {
      const itemList: Array<[string, string]> = []
      for (const [token, value] of items) itemList.push([token, value])
      const counterObj: Record<string, number> = {}
      for (const [type, n] of counters) counterObj[type] = n
      return { items: itemList, counters: counterObj }
    },

    load(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return
      if (snapshot.items !== undefined && !Array.isArray(snapshot.items)) return
      if (snapshot.counters !== undefined && (typeof snapshot.counters !== 'object' || snapshot.counters === null || Array.isArray(snapshot.counters))) return
      if (Array.isArray(snapshot.items)) {
        for (const entry of snapshot.items) {
          if (!Array.isArray(entry) || entry.length < 2) continue
          const [token, value] = entry
          if (typeof token !== 'string' || token.length === 0 || typeof value !== 'string') continue
          items.set(token, value)
          byValue.set(value, token)
        }
      }
      if (snapshot.counters && typeof snapshot.counters === 'object') {
        for (const [type, n] of Object.entries(snapshot.counters)) {
          if (typeof n === 'number' && Number.isSafeInteger(n)) counters.set(type, n)
        }
      }
    },
  }
}