import type { Context } from '@deepseek-ai/cordis';
import type { Rule } from './rules.js';
import type { Vault } from './vault.js';
import type { Guardian } from './guardian.js';
export interface HookLog {
    (message: string): Promise<void> | void;
}
export type SessionGate = (sessionId: string | undefined) => boolean;
export declare function registerHooks(ctx: Context, vault: Vault, rules: Rule[], isEnabled: SessionGate, log: HookLog, guardian?: Guardian, onFirstUse?: () => void): void;
