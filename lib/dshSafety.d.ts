/**
 * Safety probes for DSH paths that would export the CANONICAL session log.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dsh-privacy-protector` masks what the MODEL sees and restores what the USER
 * reads, but it cannot stop DSH from writing the real values it restored into
 * the durable session log, nor stop another plugin from reading that log:
 *
 *   - `dsh-cost-meter`, `@openviking/dsh-memory-plugin` and `dsh-context` all
 *     read session content, and the log itself (`session.jsonl.zstd`) is only
 *     zstd-compressed, never encrypted.
 *   - `dsh-session-log-deepseek` is worse: when `enabled: true` it uploads the
 *     raw session log to the DeepSeek API as the `dsh_session_log` request
 *     field. It ships with **no** redaction rule and there is no hook we can
 *     mount to sanitize it. It is `enabled: false` by default.
 *
 * The only defence available in-process is to make the dangerous state LOUD
 * rather than silent. This module reports whether that upload field is
 * registered so `index.ts` can warn on first use.
 *
 * The probe is READ-ONLY and best-effort: it must never throw, never register
 * anything, and never change plugin behaviour. When the registry is absent (a
 * deployment without `@deepseek-ai/dsh-deepseek-llm-api-extensions`) it reports
 * "unknown", not "safe".
 */
/** The request field owned by `dsh-session-log-deepseek`. */
export declare const DSH_SESSION_LOG_FIELD = "dsh_session_log";
export type SessionLogUploadState = 'registered' | 'absent' | 'unknown';
export interface SessionLogUploadProbe {
    state: SessionLogUploadState;
    /** Human-readable detail for the warning line. */
    note: string;
}
/**
 * Report whether the raw-session-log upload field is currently registered.
 *
 * `DeepSeekLlmApiExtensionRegistry` keeps its fields in a plain `Map` on the
 * service instance; `register()` is effect-scoped, so presence at call time is
 * exactly "the plugin is active right now".
 */
export declare function probeSessionLogUpload(ctx: unknown): SessionLogUploadProbe;
