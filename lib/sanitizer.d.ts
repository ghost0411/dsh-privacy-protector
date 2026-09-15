import type { Rule } from './rules.js';
import type { Vault } from './vault.js';
export declare const TOKEN_RE: RegExp;
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
/** Deep-scrub a JSON-serializable structure in place. */
export declare function scrubDeep(value: unknown, vault: Vault, rules: Rule[]): unknown;
