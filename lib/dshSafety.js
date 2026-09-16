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
export const DSH_SESSION_LOG_FIELD = 'dsh_session_log';
/**
 * Read the extension registry off the context.
 *
 * `deepseekLlmApiExtensions` is deliberately NOT in this plugin's `inject` list —
 * it is optional, and requiring it would refuse to load the privacy plugin on a
 * deployment that does not mount it. An un-injected service is therefore not
 * guaranteed to be materialized as a property, so fall back to `ctx.get`, the
 * same way `webServer` is resolved in `index.ts`.
 */
function readRegistry(ctx) {
    const holder = ctx;
    try {
        const direct = holder?.deepseekLlmApiExtensions;
        if (direct != null)
            return direct;
    }
    catch {
        // a throwing service getter falls through to the registry lookup
    }
    try {
        return typeof holder?.get === 'function' ? holder.get('deepseekLlmApiExtensions') : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Report whether the raw-session-log upload field is currently registered.
 *
 * `DeepSeekLlmApiExtensionRegistry` keeps its fields in a plain `Map` on the
 * service instance; `register()` is effect-scoped, so presence at call time is
 * exactly "the plugin is active right now".
 */
export function probeSessionLogUpload(ctx) {
    const registry = readRegistry(ctx);
    if (registry == null) {
        return {
            state: 'unknown',
            note: 'deepseekLlmApiExtensions is not mounted, so the session-log upload cannot be ruled out',
        };
    }
    const providers = registry.providers;
    if (!(providers instanceof Map)) {
        return { state: 'unknown', note: 'deepseekLlmApiExtensions exposes no readable field registry' };
    }
    return providers.has(DSH_SESSION_LOG_FIELD)
        ? {
            state: 'registered',
            note: `the "${DSH_SESSION_LOG_FIELD}" request field is registered: the raw session log is being sent to the model API`,
        }
        : { state: 'absent', note: 'no session-log upload field is registered' };
}
