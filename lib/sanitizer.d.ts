import type { Rule } from './rules.js';
import type { Vault } from './vault.js';
export declare const TOKEN_RE: RegExp;
/**
 * A trailing fragment that can still GROW into a token once more text arrives.
 *
 * Streaming restorers must hold back a partial token that is split across
 * chunk boundaries, but they must not hold back a literal `[` that can never
 * become one: buffering on a bare `[` swallows ordinary prose (`使用 [ 符号`)
 * and, worse, corrupts a JSON argument fragment (`{"note":"a [ b"}`), because
 * the held tail is only flushed by a later chunk.
 */
export declare const PARTIAL_TOKEN_RE: RegExp;
export interface AnonymizeResult {
    text: string;
    count: number;
}
export interface PiiHit {
    start: number;
    end: number;
    type: string;
}
/**
 * Collect non-overlapping PII hits: earliest start wins, and a longer match beats
 * a shorter one sharing the same start.
 */
export declare function collectHits(text: string, rules: Rule[]): PiiHit[];
/** Replace every PII hit in `text` with a `[PII:TYPE:N]` placeholder. */
export declare function anonymize(text: string, vault: Vault, rules: Rule[]): AnonymizeResult;
export declare const REDACTED_RE: RegExp;
/**
 * One-way redaction for sinks that must never carry PII and can never be
 * un-redacted: each hit becomes a `[REDACTED:TYPE]` marker.
 *
 * Unlike `anonymize` this never touches the vault, so it is safe to run on the
 * synchronous telemetry capture path and the exported record carries no
 * reversible mapping. Already-safe markers (`[PII:...]`, `[REDACTED:...]`) are
 * not re-wrapped because no rule matches them.
 */
export declare function redactText(text: string, rules: Rule[]): string;
/** Replace `[PII:TYPE:N]` tokens back with their original values. Non-string input passes through untouched. */
export declare function restoreText(text: string, vault: Vault): string;
/**
 * Restore tokens that sit inside JSON text — a streamed tool-call `arguments`
 * fragment, or a fully assembled tool-call block.
 *
 * This differs from {@link restoreText} in one way that matters: the splice
 * target is a JSON string literal, so the replacement must be JSON escaped. A
 * stored value can contain `"` or `\` (the API_KEY rule can even capture a
 * leading quote), and splicing such a value in raw produces invalid JSON, which
 * would make the local tool call fail or run with truncated arguments.
 *
 * Tokens with no vault entry are left untouched: a placeholder is bad, but
 * corrupt JSON is worse.
 */
export declare function restoreJsonText(text: string, vault: Vault): string;
/**
 * Count tokens inside a JSON-serializable structure that the vault COULD
 * resolve, i.e. placeholders that should have been restored upstream but were
 * not. Used as a read-only backstop on `tools/pre-execute`, which cannot
 * rewrite the frozen arguments it observes.
 */
export declare function countRestorableTokens(value: unknown, vault: Vault, depth?: number): number;
/** Deep-scrub a JSON-serializable structure in place. */
export declare function scrubDeep(value: unknown, vault: Vault, rules: Rule[]): unknown;
