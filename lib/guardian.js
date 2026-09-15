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
export function createGuardian(onMutate) {
    const bySession = new Map();
    const induced = new Set();
    let armed = false;
    const notify = () => {
        try {
            onMutate?.();
        }
        catch { /* persistence must never break the guardian */ }
    };
    const hasId = (id) => typeof id === 'string' && id.length > 0;
    const protect = (id) => hasId(id) ? armed || induced.has(id) : armed;
    return {
        isArmed() {
            return armed;
        },
        setArmed(value) {
            armed = value;
            notify();
        },
        markInduced(sessionId) {
            if (!hasId(sessionId))
                return;
            induced.add(sessionId);
            notify();
        },
        isInduced(sessionId) {
            return hasId(sessionId) && induced.has(sessionId);
        },
        shouldProtect(sessionId) {
            return protect(sessionId);
        },
        inducedSessions() {
            return [...induced];
        },
        clearInduced(sessionId) {
            if (hasId(sessionId) && induced.delete(sessionId))
                notify();
        },
        count(sessionId, category) {
            if (!hasId(sessionId))
                return;
            const entry = bySession.get(sessionId) ?? {};
            entry[category] = (entry[category] ?? 0) + 1;
            bySession.set(sessionId, entry);
            notify();
        },
        countersOf(sessionId) {
            return hasId(sessionId) ? (bySession.get(sessionId) ?? {}) : {};
        },
        getTotal() {
            let total = 0;
            for (const entry of bySession.values()) {
                for (const n of Object.values(entry))
                    total += n;
            }
            return total;
        },
        snapshot() {
            const sessions = {};
            for (const [id, entry] of bySession)
                sessions[id] = { ...entry };
            return { armed, sessions };
        },
        load(snapshot) {
            if (!snapshot || typeof snapshot !== 'object')
                return;
            if (snapshot.armed !== undefined && typeof snapshot.armed !== 'boolean')
                return;
            if (snapshot.sessions !== undefined && (typeof snapshot.sessions !== 'object' || snapshot.sessions === null || Array.isArray(snapshot.sessions)))
                return;
            if (typeof snapshot.armed === 'boolean')
                armed = snapshot.armed;
            if (snapshot.sessions && typeof snapshot.sessions === 'object') {
                for (const [id, counters] of Object.entries(snapshot.sessions)) {
                    if (!hasId(id))
                        continue;
                    if (typeof counters !== 'object' || counters === null || Array.isArray(counters))
                        continue;
                    const clean = {};
                    for (const [category, n] of Object.entries(counters)) {
                        if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0)
                            clean[category] = n;
                    }
                    if (Object.keys(clean).length > 0)
                        bySession.set(id, clean);
                }
            }
        },
    };
}
export function categoryLabel(category) {
    switch (category) {
        case 'HEALTH': return '健康';
        case 'FINANCE': return '财务';
        case 'WORK': return '工作';
        case 'RELATIONSHIP': return '亲密关系';
        case 'IDENTITY': return '身份';
        default: return category;
    }
}
