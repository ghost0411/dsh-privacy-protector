/**
 * Token<->value vault.
 *
 * ONE GLOBAL INSTANCE, shared by every session in the process: `index.ts`
 * creates it once in `apply()` and hands the same object to every hook. Tokens
 * are namespaced by TYPE only (`[PII:EMAIL:0]`), never by session, so two
 * sessions that disclose the same value share one token (and one vault entry).
 * Session isolation lives in the *toggle* (`toggle.ts`), not here.
 *
 * It DOES survive a restart. Since v0.3.0 `index.ts` persists
 * `snapshot()` through `createVaultFileStore`, which encrypts it with Electron
 * `safeStorage` (DPAPI on Windows) before writing `vault.json`. When
 * safeStorage is unavailable the store degrades to memory-only and PII is never
 * written in cleartext — so "does not persist" is true only on that fallback
 * path, not unconditionally as this comment used to claim.
 */
export interface VaultSnapshot {
    items: Array<[string, string]>;
    counters: Record<string, number>;
}
export interface Vault {
    register(type: string, value: string): string;
    lookup(token: string): string | undefined;
    readonly size: number;
    /** Serializable snapshot for encrypted disk persistence. */
    snapshot(): VaultSnapshot;
    /** Restore from a snapshot. Invalid data is ignored safely. */
    load(snapshot: Partial<VaultSnapshot> | null | undefined): void;
}
export declare function createVault(onMutate?: () => void): Vault;
