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
import type { ToggleRegistry } from './toggle.js';
import type { Guardian } from './guardian.js';
import { categoryLabel } from './guardian.js';
export interface HttpLikeRequest {
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}
export interface HttpLikeResponse {
    writeHead(status: number, headers?: Record<string, string>): unknown;
    end(...args: unknown[]): unknown;
}
export interface PrivacyCtlDeps {
    /** Unused, kept so the handler factory signature stays stable. */
    sessions?: unknown;
}
export declare function createPrivacyCtlHandler(deps: PrivacyCtlDeps, toggles: ToggleRegistry, guardian?: Guardian): (req: HttpLikeRequest, res: HttpLikeResponse) => Promise<void>;
export { categoryLabel };
