/**
 * Guardian registry: per-session sensitive-disclosure counters and the global
 * guardian switch.
 *
 * The guardian is the "semantic" companion of the toggle registry: when the
 * guardian is armed (globally), free-text disclosures ("我月薪 3 万") that the
 * format-level rules could never see are masked before they reach the model,
 * and each masked disclosure increments a per-session category counter so the
 * UI can show the user what was protected.
 *
 * Persistence is plain JSON (counters are not sensitive), following the same
 * shape as the toggle store.
 */

import type { TopicCategory } from './topics.js'

export type CategoryCounters = Partial<Record<TopicCategory, number>>

export interface GuardianSnapshot {
  /** Global arm switch (default OFF). */
  armed: boolean
  /** Per-session category counters: sessionId -> {HEALTH: n, ...}. */
  sessions: Record<string, CategoryCounters>
}

export interface Guardian {
  /** Effective armed state (global only for now). */
  isArmed(): boolean
  setArmed(armed: boolean): void
  /** Increment a category counter for a session id. Blank ids are counted globally-ish? No: ignored. */
  count(sessionId: string | undefined, category: TopicCategory): void
  /** Per-session counters; blank/undefined session returns {}. */
  countersOf(sessionId: string | undefined): CategoryCounters
  /** Total protected disclosures across all sessions. */
  getTotal(): number
  snapshot(): GuardianSnapshot
  load(snapshot: Partial<GuardianSnapshot> | null | undefined): void
  /**
   * Mark a session as "induced": its assistant just fished for a sensitive
   * disclosure and the user then disclosed one. Once induced, the session is
   * locked — the guardian keeps protecting it even if toggled off, and the
   * API refuses to disarm it until files_end:true.
   */
  markInduced(sessionId: string | undefined): void
  /** Whether a session is locked because an inducement vector succeeded. */
  isInduced(sessionId: string | undefined): boolean
  /**
   * Effective protection decision for a session: the user switch or the
   * induced lock, whichever is on. Locked sessions cannot be disarmed and
   * cannot be turned off by an inducement prompt.
   */
  shouldProtect(sessionId: string | undefined): boolean
  /** Sessions currently locked by an induced disclosure. */
  inducedSessions(): string[]
  /** Only meaningful transients; not persisted. */
  clearInduced(sessionId: string | undefined): void
}

export function createGuardian(onMutate?: () => void): Guardian {
  const bySession = new Map<string, CategoryCounters>()
  const induced = new Set<string>()
  let armed = false

  const notify = () => {
    try { onMutate?.() } catch { /* persistence must never break the guardian */ }
  }

  const hasId = (id: unknown): id is string => typeof id === 'string' && id.length > 0

  const protect = (id: string | undefined) =>
    hasId(id) ? armed || induced.has(id) : armed

  return {
    isArmed() {
      return armed
    },

    setArmed(value) {
      armed = value
      notify()
    },

    markInduced(sessionId) {
      if (!hasId(sessionId)) return
      induced.add(sessionId)
      notify()
    },

    isInduced(sessionId) {
      return hasId(sessionId) && induced.has(sessionId)
    },

    shouldProtect(sessionId) {
      return protect(sessionId)
    },

    inducedSessions() {
      return [...induced]
    },

    clearInduced(sessionId) {
      if (hasId(sessionId) && induced.delete(sessionId)) notify()
    },

    count(sessionId, category) {
      if (!hasId(sessionId)) return
      const entry = bySession.get(sessionId) ?? {}
      entry[category] = (entry[category] ?? 0) + 1
      bySession.set(sessionId, entry)
      notify()
    },

    countersOf(sessionId) {
      return hasId(sessionId) ? (bySession.get(sessionId) ?? {}) : {}
    },

    getTotal() {
      let total = 0
      for (const entry of bySession.values()) {
        for (const n of Object.values(entry)) total += n
      }
      return total
    },

    snapshot() {
      const sessions: Record<string, CategoryCounters> = {}
      for (const [id, entry] of bySession) sessions[id] = { ...entry }
      return { armed, sessions }
    },

    load(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return
      if (snapshot.armed !== undefined && typeof snapshot.armed !== 'boolean') return
      if (snapshot.sessions !== undefined && (typeof snapshot.sessions !== 'object' || snapshot.sessions === null || Array.isArray(snapshot.sessions))) return
      if (typeof snapshot.armed === 'boolean') armed = snapshot.armed
      if (snapshot.sessions && typeof snapshot.sessions === 'object') {
        for (const [id, counters] of Object.entries(snapshot.sessions)) {
          if (!hasId(id)) continue
          if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) continue
          const clean: CategoryCounters = {}
          for (const [category, n] of Object.entries(counters)) {
            if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) clean[category as TopicCategory] = n
          }
          if (Object.keys(clean).length > 0) bySession.set(id, clean)
        }
      }
    },
  }
}

export function categoryLabel(category: TopicCategory): string {
  switch (category) {
    case 'HEALTH': return '健康'
    case 'FINANCE': return '财务'
    case 'WORK': return '工作'
    case 'RELATIONSHIP': return '亲密关系'
    case 'IDENTITY': return '身份'
    default: return category
  }
}