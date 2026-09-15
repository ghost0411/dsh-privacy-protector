/**
 * Privacy toggle registry: per-session and global.
 *
 * Per-session toggles start OFF (default off). The global toggle also
 * starts OFF: when it is ON every session is effectively ON regardless
 * of the per-session setting. State lives only in memory.
 */

export interface ToggleSnapshot {
  global: boolean
  sessions: Record<string, boolean>
}

export interface ToggleRegistry {
  /** Effective enable state for a session (global || per-session). */
  isEnabled(sessionId: string | undefined): boolean
  /** Per-session value (undefined/blank ids are always off). */
  get(sessionId: string | undefined): boolean
  /** Set a per-session value. Blank ids are ignored. */
  set(sessionId: string, enabled: boolean): void
  /** Global toggle state. */
  getGlobal(): boolean
  /** Set the global toggle. */
  setGlobal(enabled: boolean): void
  /** Serializable snapshot for disk persistence. */
  snapshot(): ToggleSnapshot
  /** Restore from a snapshot. Invalid/foreign snapshots are ignored safely. */
  load(snapshot: Partial<ToggleSnapshot> | null | undefined): void
}

export function createToggleRegistry(onMutate?: () => void): ToggleRegistry {
  const bySession = new Map<string, boolean>()
  let global = false

  const notify = () => {
    try { onMutate?.() } catch { /* persistence must never break the toggle */ }
  }

  return {
    isEnabled(sessionId) {
      if (global) return true
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      return bySession.get(sessionId) ?? false
    },

    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      return bySession.get(sessionId) ?? false
    },

    set(sessionId, enabled) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      bySession.set(sessionId, enabled)
      notify()
    },

    getGlobal() {
      return global
    },

    setGlobal(enabled) {
      global = enabled
      notify()
    },

    snapshot() {
      const sessions: Record<string, boolean> = {}
      for (const [id, enabled] of bySession) sessions[id] = enabled
      return { global, sessions }
    },

    load(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return
      if (typeof snapshot.global !== 'undefined' && typeof snapshot.global !== 'boolean') return
      if (snapshot.sessions !== undefined && (typeof snapshot.sessions !== 'object' || snapshot.sessions === null || Array.isArray(snapshot.sessions))) return
      if (typeof snapshot.global === 'boolean') global = snapshot.global
      if (snapshot.sessions && typeof snapshot.sessions === 'object') {
        for (const [id, enabled] of Object.entries(snapshot.sessions)) {
          if (typeof id !== 'string' || id.length === 0) continue
          if (typeof enabled !== 'boolean') continue
          bySession.set(id, enabled)
        }
      }
    },
  }
}
