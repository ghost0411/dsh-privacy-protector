/**
 * Guardian registry: per-session sensitive-disclosure counters and the global
 * guardian switch.
 *
 * The guardian is the "semantic" companion of the toggle registry: when the
 * guardian is armed (globally), free-text disclosures ("我月薪 3 万") that the
 * format-level rules could never see are masked before they reach the model,
 * and each masked disclosure increments a per-session category counter so the
 * UI can show the user what was protected.
 *
 * Persistence is plain JSON (counters are not sensitive), following the same
 * shape as the toggle store.
 */
import type { TopicCategory } from './topics.js';
export type CategoryCounters = Partial<Record<TopicCategory, number>>;
export interface GuardianSnapshot {
    /** Global arm switch (default OFF). */
    armed: boolean;
    /** Per-session category counters: sessionId -> {HEALTH: n, ...}. */
    sessions: Record<string, CategoryCounters>;
}
export interface Guardian {
    /** Effective armed state (global only for now). */
    isArmed(): boolean;
    setArmed(armed: boolean): void;
    /** Increment a category counter for a session id. Blank ids are counted globally-ish? No: ignored. */
    count(sessionId: string | undefined, category: TopicCategory): void;
    /** Per-session counters; blank/undefined session returns {}. */
    countersOf(sessionId: string | undefined): CategoryCounters;
    /** Total protected disclosures across all sessions. */
    getTotal(): number;
    snapshot(): GuardianSnapshot;
    load(snapshot: Partial<GuardianSnapshot> | null | undefined): void;
    /**
     * Mark a session as "induced": its assistant just fished for a sensitive
     * disclosure and the user then disclosed one. Once induced, the session is
     * locked — the guardian keeps protecting it even if toggled off, and the
     * API refuses to disarm it until files_end:true.
     */
    markInduced(sessionId: string | undefined): void;
    /** Whether a session is locked because an inducement vector succeeded. */
    isInduced(sessionId: string | undefined): boolean;
    /**
     * Effective protection decision for a session: the user switch or the
     * induced lock, whichever is on. Locked sessions cannot be disarmed and
     * cannot be turned off by an inducement prompt.
     */
    shouldProtect(sessionId: string | undefined): boolean;
    /** Sessions currently locked by an induced disclosure. */
    inducedSessions(): string[];
    /** Only meaningful transients; not persisted. */
    clearInduced(sessionId: string | undefined): void;
}
export declare function createGuardian(onMutate?: () => void): Guardian;
export declare function categoryLabel(category: TopicCategory): string;
