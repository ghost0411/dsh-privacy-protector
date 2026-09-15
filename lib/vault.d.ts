/**
 * In-memory token<->value vault, isolated per session.
 * Does NOT persist across restart: a crash loses the mapping (by design,
 * same trade-off as the opencode plugin).
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
