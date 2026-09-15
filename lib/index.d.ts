import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type HttpLikeRequest, type HttpLikeResponse } from './privacyCtl.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: {
            register(route: {
                kind: 'prefix' | 'exact';
                path: string;
                handler: (req: HttpLikeRequest, res: HttpLikeResponse) => void | Promise<void>;
            }): () => void;
        };
        sessions: {
            get(id: string): unknown;
        };
        tools: unknown;
    }
}
export declare const name = "dsh-privacy-protector";
export declare const inject: string[];
export interface ExtraRuleConfig {
    type: string;
    pattern: string;
    flags?: string;
    groupIndex?: number;
}
export interface Config {
    enabled: boolean;
    logMasked: boolean;
    redactTelemetry: boolean;
    extraRules: ExtraRuleConfig[];
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { createToggleRegistry } from './toggle.js';
export { createPrivacyCtlHandler, categoryLabel } from './privacyCtl.js';
export { createGuardian } from './guardian.js';
export { scanTopics, TOPIC_RULES } from './topics.js';
export type { TopicCategory, TopicScanResult } from './topics.js';
export type { Guardian, GuardianSnapshot } from './guardian.js';
export type { ToggleRegistry } from './toggle.js';
export type { HttpLikeRequest, HttpLikeResponse, PrivacyCtlDeps } from './privacyCtl.js';
export { createToggleFileStore, createVaultFileStore, dataDir, detectSafeStorage } from './store.js';
export type { ToggleFileStore, VaultFileStore, Encryptor } from './store.js';
