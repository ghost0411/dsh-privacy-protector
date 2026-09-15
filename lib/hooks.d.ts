import type { Context } from '@deepseek-ai/cordis';
import type { Rule } from './rules.js';
import type { Vault } from './vault.js';
import type { Guardian } from './guardian.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'agent/pre-step': (payload: {
            agent?: unknown;
            messages: unknown[];
            turn: number;
            step: number;
            signal?: unknown;
        }, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;
        'llm/stream': (options: Record<string, unknown> & {
            sessionId?: string;
        }, next: () => AsyncIterable<Record<string, unknown>>) => AsyncIterable<Record<string, unknown>>;
        'tools/pre-execute': (execution: {
            agent?: unknown;
            name?: string;
            args?: unknown;
        }, next: () => Promise<unknown>) => Promise<unknown>;
    }
}
export interface HookLog {
    (message: string): Promise<void> | void;
}
export type SessionGate = (sessionId: string | undefined) => boolean;
export declare function registerHooks(ctx: Context, vault: Vault, rules: Rule[], isEnabled: SessionGate, log: HookLog, guardian?: Guardian): void;
