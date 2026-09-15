import type { Rule } from './rules.js';
import type { Vault } from './vault.js';
export declare const TOKEN_RE: RegExp;
export interface AnonymizeResult {
    text: string;
    count: number;
}
/** Replace every PII hit in `text` with a `[PII:TYPE:N]` placeholder. */
export declare function anonymize(text: string, vault: Vault, rules: Rule[]): AnonymizeResult;
/** Replace `[PII:TYPE:N]` tokens back with their original values. Non-string input passes through untouched. */
export declare function restoreText(text: string, vault: Vault): string;
/** Deep-scrub a JSON-serializable structure in place. */
export declare function scrubDeep(value: unknown, vault: Vault, rules: Rule[]): unknown;
