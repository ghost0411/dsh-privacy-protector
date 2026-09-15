/**
 * Disk persistence for the privacy protector.
 *
 * Two payloads live under `$DSH_HOME/storages/dsh-privacy-protector`:
 *
 *  - toggles.json  -> plain JSON (global flag + per-session booleans). No
 *                     sensitive material, so it stays human-readable.
 *  - vault.json    -> the token<->value mapping, which CONTAINS REAL PII.
 *                     Encrypted with Electron safeStorage (DPAPI on Windows)
 *                     before it touches the disk. If safeStorage is
 *                     unavailable (plain Node, sandboxed host, encryption
 *                     disabled) the vault falls back to memory-only and a
 *                     warning is logged - PII is NEVER written in cleartext.
 *
 * Writes are atomic (tmp + rename) so a crash mid-write cannot corrupt the
 * previous good state.
 */
export declare const STORE_VERSION = 1;
export interface ToggleSnapshot {
    global: boolean;
    sessions: Record<string, boolean>;
    /** Guardian arm switch + per-session category counters (plain JSON, safe). */
    guardian?: GuardianSnapshot;
}
import type { TopicCategory } from './topics.js';
export interface GuardianSnapshot {
    armed: boolean;
    sessions: Record<string, Partial<Record<TopicCategory, number>>>;
}
export interface VaultSnapshot {
    items: Array<[string, string]>;
    counters: Record<string, number>;
}
export interface Encryptor {
    encrypt: (text: string) => string;
    decrypt: (encoded: string) => string;
}
export interface VaultFileInfo {
    readonly persistent: boolean;
    /** Presence/decrypt status, for diagnostics. */
    note: string;
}
/** Resolve `$DSH_HOME/storages/dsh-privacy-protector`, creating it on demand. */
export declare function dataDir(): string;
export interface ToggleFileStore {
    load(): ToggleSnapshot | null;
    save(snapshot: ToggleSnapshot): void;
}
export declare function createToggleFileStore(dir: string): ToggleFileStore;
export interface VaultFileStore {
    readonly persistent: boolean;
    readonly note: string;
    load(): VaultSnapshot | null;
    save(snapshot: VaultSnapshot): void;
}
/**
 * Detect Electron safeStorage in the host process. Returns null when
 * unavailable so the caller degrades to memory-only persistence.
 */
export declare function detectSafeStorage(): Encryptor | null;
export declare function createVaultFileStore(dir: string, encryptor: Encryptor | null): VaultFileStore;
