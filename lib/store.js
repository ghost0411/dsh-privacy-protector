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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
export const STORE_VERSION = 1;
/** Atomic write: tmp file then rename, so readers never see a torn file. */
function writeJsonAtomic(file, obj) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    try {
        renameSync(tmp, file);
    }
    catch (err) {
        try {
            writeFileSync(file, JSON.stringify(obj), 'utf8');
        }
        catch { /* last resort */ }
        const cause = err instanceof Error ? err.message : String(err);
        // On Windows an existing destination can make rename fail (share violation);
        // retrying the rename after a tick usually clears it.
        setImmediate(() => { try {
            renameSync(tmp, file);
        }
        catch {
            try {
                renameSync(tmp, file);
            }
            catch { /* give up */ }
        } });
        void cause;
    }
}
/** Resolve `$DSH_HOME/storages/dsh-privacy-protector`, creating it on demand. */
export function dataDir() {
    const env = process.env.DSH_HOME;
    const home = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh');
    const dir = join(home, 'storages', 'dsh-privacy-protector');
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch { /* best effort */ }
    return dir;
}
/** Try to load a JSON file; any failure yields { parsed: null }. */
function readJson(file) {
    try {
        const raw = readFileSync(file, 'utf8');
        if (raw.trim().length === 0)
            return { parsed: null };
        return { parsed: JSON.parse(raw) };
    }
    catch {
        return null;
    }
}
export function createToggleFileStore(dir) {
    const file = join(dir, 'toggles.json');
    return {
        load() {
            const read = readJson(file);
            if (!read)
                return null;
            const obj = read.parsed ?? {};
            if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
                return null;
            const o = obj;
            const global = o.global === true;
            const sessionsRaw = typeof o.sessions === 'object' && o.sessions !== null ? o.sessions : {};
            const sessions = {};
            for (const [k, v] of Object.entries(sessionsRaw))
                sessions[k] = v === true;
            const guardianRaw = typeof o.guardian === 'object' && o.guardian !== null ? o.guardian : null;
            let guardian;
            if (guardianRaw) {
                const armed = guardianRaw.armed === true;
                const gSessionsRaw = typeof guardianRaw.sessions === 'object' && guardianRaw.sessions !== null ? guardianRaw.sessions : {};
                const gSessions = {};
                for (const [k, v] of Object.entries(gSessionsRaw)) {
                    if (typeof v !== 'object' || v === null || Array.isArray(v))
                        continue;
                    const clean = {};
                    for (const [cat, n] of Object.entries(v)) {
                        if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0)
                            clean[cat] = n;
                    }
                    if (Object.keys(clean).length > 0)
                        gSessions[k] = clean;
                }
                guardian = { armed, sessions: gSessions };
            }
            return { global, sessions, guardian };
        },
        save(snapshot) {
            writeJsonAtomic(file, { version: STORE_VERSION, global: snapshot.global, sessions: snapshot.sessions, guardian: snapshot.guardian });
        },
    };
}
/**
 * Detect Electron safeStorage in the host process. Returns null when
 * unavailable so the caller degrades to memory-only persistence.
 */
export function detectSafeStorage() {
    try {
        const require = createRequire(import.meta.url);
        const electron = require('electron');
        const backend = electron?.safeStorage;
        if (!backend || typeof backend.encryptString !== 'function' || typeof backend.decryptString !== 'function')
            return null;
        const available = backend.isEncryptionAvailable?.();
        if (available instanceof Promise)
            return null;
        if (available === false)
            return null;
        return {
            encrypt: (text) => backend.encryptString(text).toString('base64'),
            decrypt: (encoded) => backend.decryptString(Buffer.from(encoded, 'base64')),
        };
    }
    catch {
        return null;
    }
}
export function createVaultFileStore(dir, encryptor) {
    const file = join(dir, 'vault.json');
    if (!encryptor) {
        return {
            persistent: false,
            note: 'safeStorage unavailable - vault is memory-only; tokens from before a restart cannot be restored',
            load() { return null; },
            save() { },
        };
    }
    return {
        persistent: true,
        note: 'safeStorage ready',
        load() {
            const read = readJson(file);
            if (!read)
                return null;
            const obj = read.parsed ?? {};
            if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
                return null;
            const o = obj;
            if (o.alg !== 'safeStorage' || typeof o.data !== 'string')
                return null;
            let text;
            try {
                text = encryptor.decrypt(o.data);
            }
            catch {
                return null; // key changed / foreign machine: start fresh
            }
            let payload;
            try {
                payload = JSON.parse(text);
            }
            catch {
                return null;
            }
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
                return null;
            const p = payload;
            const itemsRaw = Array.isArray(p.items) ? p.items : [];
            const items = [];
            for (const entry of itemsRaw) {
                if (!Array.isArray(entry) || entry.length < 2)
                    continue;
                const [token, value] = entry;
                if (typeof token !== 'string' || typeof value !== 'string')
                    continue;
                items.push([token, value]);
            }
            const countersRaw = typeof p.counters === 'object' && p.counters !== null ? p.counters : {};
            const counters = {};
            for (const [k, v] of Object.entries(countersRaw))
                if (typeof v === 'number' && Number.isSafeInteger(v))
                    counters[k] = v;
            return { items, counters };
        },
        save(snapshot) {
            const body = { version: STORE_VERSION, items: snapshot.items, counters: snapshot.counters };
            let encoded;
            try {
                encoded = encryptor.encrypt(JSON.stringify(body));
            }
            catch {
                return; // encryption failed: never persist partial/cleartext PII
            }
            writeJsonAtomic(file, { version: STORE_VERSION, alg: 'safeStorage', data: encoded });
        },
    };
}
