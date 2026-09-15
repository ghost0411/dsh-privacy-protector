/**
 * In-memory token<->value vault, isolated per session.
 * Does NOT persist across restart: a crash loses the mapping (by design,
 * same trade-off as the opencode plugin).
 */
export function createVault(onMutate) {
    const items = new Map();
    const byValue = new Map();
    const counters = new Map();
    const notify = () => {
        try {
            onMutate?.();
        }
        catch { /* persistence must never break masking */ }
    };
    return {
        register(type, value) {
            const existing = byValue.get(value);
            if (existing !== undefined)
                return existing;
            let n = counters.get(type) ?? 0;
            let token = `[PII:${type}:${n}]`;
            while (items.has(token)) {
                n += 1;
                token = `[PII:${type}:${n}]`;
            }
            items.set(token, value);
            byValue.set(value, token);
            counters.set(type, n + 1);
            notify();
            return token;
        },
        lookup(token) {
            return items.get(token);
        },
        get size() {
            return items.size;
        },
        snapshot() {
            const itemList = [];
            for (const [token, value] of items)
                itemList.push([token, value]);
            const counterObj = {};
            for (const [type, n] of counters)
                counterObj[type] = n;
            return { items: itemList, counters: counterObj };
        },
        load(snapshot) {
            if (!snapshot || typeof snapshot !== 'object')
                return;
            if (snapshot.items !== undefined && !Array.isArray(snapshot.items))
                return;
            if (snapshot.counters !== undefined && (typeof snapshot.counters !== 'object' || snapshot.counters === null || Array.isArray(snapshot.counters)))
                return;
            if (Array.isArray(snapshot.items)) {
                for (const entry of snapshot.items) {
                    if (!Array.isArray(entry) || entry.length < 2)
                        continue;
                    const [token, value] = entry;
                    if (typeof token !== 'string' || token.length === 0 || typeof value !== 'string')
                        continue;
                    items.set(token, value);
                    byValue.set(value, token);
                }
            }
            if (snapshot.counters && typeof snapshot.counters === 'object') {
                for (const [type, n] of Object.entries(snapshot.counters)) {
                    if (typeof n === 'number' && Number.isSafeInteger(n))
                        counters.set(type, n);
                }
            }
        },
    };
}
