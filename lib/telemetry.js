/**
 * Telemetry redaction: the outbound half of the privacy boundary.
 *
 * Why this exists
 * ---------------
 * `agent/pre-step` keeps PII away from the *model*, but the session log is a
 * separate sink. `llm/stream` restores `[PII:...]` tokens so the user reads real
 * values, and the agent loop appends every chunk it consumes to the session log
 * (`dsh-agent-loop`: `session.append('assistant/chunk', { chunk })` plus the
 * assembled `assistant/message`). The log therefore holds real values, and
 * `@deepseek-ai/dsh-session-telemetry` mirrors session-log records onto
 * OTLP/HTTP with **no redaction rules of its own** — the deployment's own
 * comment reads "so exports are the raw captured copy".
 *
 * With the shipping default `FEEDBACK_ONLY` mode, recording `/feedback` uploads
 * the session records since the last handoff to the configured collector
 * (production: harness-telemetry.deepseeksvc.com). `DSH_TELEMETRY_MODE=FULL`
 * uploads continuously, and `DSH_TELEMETRY_OTLP_URL` can point anywhere.
 *
 * `session-telemetry/record` is the Service Definition's designated redaction
 * extension point: "exported data is exactly as clean as the rules a deployment
 * mounts". This module mounts those rules.
 *
 * Contract notes (from the event catalog and the telemetry coordinator)
 * --------------------------------------------------------------------
 * - The waterfall is dispatched **synchronously** on the capture hot path, so the
 *   listener must be synchronous and cheap: no awaits, no I/O.
 * - The received record is "already the coordinator's own deep copy"; listeners
 *   "must not mutate it" and instead return a (possibly new) record.
 * - Redaction applies to the **exported copy only**; the canonical session log is
 *   never rewritten.
 * - Dispatch runs inside the coordinator's containment, where "a throwing rule
 *   withholds the record (fail-closed)". We deliberately do **not** swallow
 *   errors and fall back to the original record: returning unredacted input
 *   would leak exactly what this module exists to withhold. Failing closed
 *   (losing one telemetry record) is the correct trade.
 * - Global scope: `dsh-scope` registers no extractor for this event and the
 *   signature carries no `this: Scoped<...>`, so a plain `ctx.on` listener
 *   receives every record.
 */
import { redactText } from './sanitizer.js';
/**
 * Walk bounds. Telemetry bodies mirror session logs and can be large; the walk
 * runs on the capture path, so bound the work rather than risk stalling capture.
 * Exceeding a bound stops descending (rather than throwing) so one pathological
 * record cannot suppress telemetry wholesale — the strings already visited stay
 * redacted.
 */
const MAX_DEPTH = 12;
const MAX_NODES = 20000;
function redactValue(value, rules, seen, budget, depth) {
    if (typeof value === 'string')
        return redactText(value, rules);
    if (value === null || typeof value !== 'object')
        return value;
    if (depth > MAX_DEPTH || budget.nodes <= 0)
        return value;
    const object = value;
    if (seen.has(object))
        return value;
    seen.add(object);
    budget.nodes -= 1;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const replaced = redactValue(item, rules, seen, budget, depth + 1);
            if (replaced !== item)
                changed = true;
            return replaced;
        });
        return changed ? out : value;
    }
    let changed = false;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const replaced = redactValue(item, rules, seen, budget, depth + 1);
        if (replaced !== item)
            changed = true;
        out[key] = replaced;
    }
    return changed ? out : value;
}
/**
 * Return a redacted copy of one telemetry record. The input is never mutated; an
 * untouched record is returned by identity so the common no-PII case allocates
 * nothing beyond the walk.
 */
export function redactRecord(record, rules) {
    const seen = new WeakSet();
    const budget = { nodes: MAX_NODES };
    const attributes = redactValue(record.attributes, rules, seen, budget, 0);
    const body = redactValue(record.body, rules, seen, budget, 0);
    if (attributes === record.attributes && body === record.body)
        return record;
    return {
        ...record,
        attributes: attributes,
        body,
    };
}
/**
 * Mount the redaction rules on the process-wide telemetry waterfall.
 *
 * Intentionally independent of the per-session masking toggle: the toggle governs
 * whether the *model* sees pseudonyms, whereas a telemetry record has no reliable
 * session key and uploading real PII to a collector is undesirable regardless of
 * that choice. Disable it wholesale with the plugin's `redactTelemetry` config.
 */
export function installTelemetryRedaction(ctx, rules) {
    ctx.on('session-telemetry/record', (record, next) => {
        const base = next();
        if (base === null || typeof base !== 'object')
            return base;
        return redactRecord(base, rules);
    });
}
