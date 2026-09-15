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
import { categoryLabel } from './guardian.js';
async function readBody(req) {
    let text = '';
    if (typeof req[Symbol.asyncIterator] !== 'function')
        return text;
    for await (const chunk of req) {
        text += typeof chunk === 'string' ? chunk : String(chunk);
    }
    return text;
}
function sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}
function responsePayload(toggles, sessionId, guardian) {
    const session = toggles.get(sessionId);
    const global = toggles.getGlobal();
    const guardianPayload = guardian
        ? {
            armed: guardian.isArmed(),
            locked: guardian.isInduced(sessionId),
            categories: guardian.countersOf(sessionId),
            total: guardian.getTotal(),
        }
        : undefined;
    return { enabled: toggles.isEnabled(sessionId), global, session, guardian: guardianPayload };
}
export function createPrivacyCtlHandler(deps, toggles, guardian) {
    return async (req, res) => {
        const raw = req.headers?.['x-session-id'];
        const sessionId = Array.isArray(raw) ? raw[0] : raw;
        if (sessionId == null || sessionId === '') {
            sendJson(res, 400, { error: 'missing session id' });
            return;
        }
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
            sendJson(res, 200, responsePayload(toggles, sessionId, guardian));
            return;
        }
        if (method === 'POST') {
            let enabled;
            let scope;
            try {
                const parsed = JSON.parse(await readBody(req));
                if (typeof parsed.enabled !== 'boolean')
                    throw new Error('enabled must be a boolean');
                enabled = parsed.enabled;
                scope = parsed.scope === 'global' ? 'global' : parsed.scope === 'guardian' ? 'guardian' : 'session';
            }
            catch {
                sendJson(res, 400, { error: 'invalid body' });
                return;
            }
            if (scope === 'global') {
                toggles.setGlobal(enabled);
            }
            else if (scope === 'guardian') {
                // An induced session is locked: the assistant fished a disclosure out
                // of this conversation, so the guard cannot be switched off here.
                // This is the backstop against a social-engineering "turn it off" —
                // the session file must be cleared or the conversation ends first.
                if (!enabled && guardian?.isInduced(sessionId)) {
                    sendJson(res, 403, { error: 'guardian is locked by an induced disclosure', locked: true });
                    return;
                }
                guardian?.setArmed(enabled);
            }
            else {
                toggles.set(sessionId, enabled);
            }
            sendJson(res, 200, responsePayload(toggles, sessionId, guardian));
            return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
    };
}
export { categoryLabel };
