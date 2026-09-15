/**
 * Privacy toggle registry: per-session and global.
 *
 * Per-session toggles start OFF (default off). The global toggle also
 * starts OFF: when it is ON every session is effectively ON regardless
 * of the per-session setting. State lives only in memory.
 */
export interface ToggleSnapshot {
    global: boolean;
    sessions: Record<string, boolean>;
}
export interface ToggleRegistry {
    /** Effective enable state for a session (global || per-session). */
    isEnabled(sessionId: string | undefined): boolean;
    /** Per-session value (undefined/blank ids are always off). */
    get(sessionId: string | undefined): boolean;
    /** Set a per-session value. Blank ids are ignored. */
    set(sessionId: string, enabled: boolean): void;
    /** Global toggle state. */
    getGlobal(): boolean;
    /** Set the global toggle. */
    setGlobal(enabled: boolean): void;
    /** Serializable snapshot for disk persistence. */
    snapshot(): ToggleSnapshot;
    /** Restore from a snapshot. Invalid/foreign snapshots are ignored safely. */
    load(snapshot: Partial<ToggleSnapshot> | null | undefined): void;
}
export declare function createToggleRegistry(onMutate?: () => void): ToggleRegistry;
