/**
 * Loopback HTTP interface for privacy toggles (per-session + global).
 *
 * Served through the host webserver under `/api/privacy-ctl` (prefix route).
 * The client half fetches these endpoints with an `x-session-id` header:
 *
 *   GET  /api/privacy-ctl -> { enabled, global, session, guardian }
 *   POST /api/privacy-ctl body { enabled, scope? } -> { enabled, global, session, guardian }
 *
 * - `enabled`  = effective state for this session (global || session)
 * - `global`   = the global "all-session" toggle state
 * - `session`  = this session's own per-session toggle
 * - `scope`    = 'global' (default: 'session')
 * - `guardian` = { armed, locked, categories, total }; `locked` means this
 *   session was induced into disclosing sensitive info and cannot be disarmed
 *   (POST scope=guardian enabled=false -> 403).
 *
 * When global is ON every session is effectively ON regardless of the
 * per-session setting.
 */

import type { ToggleRegistry } from './toggle.js'
import type { Guardian } from './guardian.js'
import { categoryLabel } from './guardian.js'

export interface HttpLikeRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

export interface HttpLikeResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(...args: unknown[]): unknown
}

export interface PrivacyCtlDeps {
  /** Unused, kept so the handler factory signature stays stable. */
  sessions?: unknown
}

async function readBody(req: HttpLikeRequest): Promise<string> {
  let text = ''
  if (typeof req[Symbol.asyncIterator] !== 'function') return text
  for await (const chunk of req as unknown as AsyncIterable<unknown>) {
    text += typeof chunk === 'string' ? chunk : String(chunk)
  }
  return text
}

function sendJson(res: HttpLikeResponse, status: number, obj: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function responsePayload(toggles: ToggleRegistry, sessionId: string, guardian?: Guardian) {
  const session = toggles.get(sessionId)
  const global = toggles.getGlobal()
  const guardianPayload = guardian
    ? {
        armed: guardian.isArmed(),
        locked: guardian.isInduced(sessionId),
        categories: guardian.countersOf(sessionId),
        total: guardian.getTotal(),
      }
    : undefined
  return { enabled: toggles.isEnabled(sessionId), global, session, guardian: guardianPayload }
}

export function createPrivacyCtlHandler(
  deps: PrivacyCtlDeps,
  toggles: ToggleRegistry,
  guardian?: Guardian,
): (req: HttpLikeRequest, res: HttpLikeResponse) => Promise<void> {
  return async (req, res) => {
    const raw = req.headers?.['x-session-id']
    const sessionId = Array.isArray(raw) ? raw[0] : raw
    if (sessionId == null || sessionId === '') {
      sendJson(res, 400, { error: 'missing session id' })
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      sendJson(res, 200, responsePayload(toggles, sessionId, guardian))
      return
    }

    if (method === 'POST') {
      let enabled: boolean
      let scope: 'global' | 'session' | 'guardian'
      try {
        const parsed = JSON.parse(await readBody(req)) as { enabled?: unknown; scope?: unknown }
        if (typeof parsed.enabled !== 'boolean') throw new Error('enabled must be a boolean')
        enabled = parsed.enabled
        scope = parsed.scope === 'global' ? 'global' : parsed.scope === 'guardian' ? 'guardian' : 'session'
      } catch {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      if (scope === 'global') {
        toggles.setGlobal(enabled)
      } else if (scope === 'guardian') {
        // An induced session is locked: the assistant fished a disclosure out
        // of this conversation, so the guard cannot be switched off here.
        // This is the backstop against a social-engineering "turn it off" —
        // the session file must be cleared or the conversation ends first.
        if (!enabled && guardian?.isInduced(sessionId)) {
          sendJson(res, 403, { error: 'guardian is locked by an induced disclosure', locked: true })
          return
        }
        guardian?.setArmed(enabled)
      } else {
        toggles.set(sessionId, enabled)
      }
      sendJson(res, 200, responsePayload(toggles, sessionId, guardian))
      return
    }

    sendJson(res, 405, { error: 'method not allowed' })
  }
}

export { categoryLabel }
