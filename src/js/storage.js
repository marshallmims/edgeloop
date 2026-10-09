// Robust localStorage access. Every read tolerates corrupt JSON and every
// write tolerates a full or blocked store, so a storage failure can never
// leave the session engine in a half-updated state. The storage backend is a
// parameter (defaulting to window.localStorage at CALL time) so this module
// imports cleanly under node:test.

function defaultStorage() {
    try {
        return globalThis.localStorage || null;
    } catch (e) {
        return null;
    }
}

function sameShape(value, fallback) {
    if (Array.isArray(fallback)) return Array.isArray(value);
    if (fallback !== null && typeof fallback === 'object') {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    return typeof value === typeof fallback;
}

// Read a raw string. Returns `fallback` when the key is missing or the
// storage is unavailable (private mode, blocked cookies).
export function safeGet(key, fallback = null, storage = defaultStorage()) {
    if (!storage) return fallback;
    try {
        const raw = storage.getItem(key);
        return raw === null || raw === undefined ? fallback : raw;
    } catch (e) {
        return fallback;
    }
}

// JSON-parse a stored value. Returns `fallback` when the key is missing, the
// JSON is corrupt, or the parsed value is not the same shape as the fallback
// (an array where an object is expected, and so on).
export function safeParse(key, fallback, storage = defaultStorage()) {
    if (!storage) return fallback;
    let raw = null;
    try {
        raw = storage.getItem(key);
    } catch (e) {
        return fallback;
    }
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || parsed === undefined) return fallback;
        if (fallback !== undefined && !sameShape(parsed, fallback)) return fallback;
        return parsed;
    } catch (e) {
        return fallback;
    }
}

// Store a value (objects are JSON-encoded, strings go in as-is). Returns true
// on success and false on ANY failure (quota, private mode, disabled storage).
export function safeSet(key, value, storage = defaultStorage()) {
    if (!storage) return false;
    try {
        const encoded = typeof value === 'string' ? value : JSON.stringify(value);
        storage.setItem(key, encoded);
        return true;
    } catch (e) {
        return false;
    }
}

export function safeKeys(storage = defaultStorage()) {
    if (!storage) return [];
    try {
        const keys = [];
        const count = Number(storage.length) || 0;
        for (let i = 0; i < count; i++) {
            const key = storage.key(i);
            if (typeof key === 'string') keys.push(key);
        }
        return keys;
    } catch (e) {
        return [];
    }
}

export function safeRemove(key, storage = defaultStorage()) {
    if (!storage) return false;
    try {
        storage.removeItem(key);
        return true;
    } catch (e) {
        return false;
    }
}

// Persist a newest-first history list. When the store is full the OLDEST
// entries (the tail) are dropped one by one until the list fits. If even the
// newest entry alone will not fit, its motion trace is stripped so at least
// the session statistics survive. Returns what happened so the caller can
// warn the user.
export function saveHistoryTrimmed(key, history, storage = defaultStorage()) {
    const list = Array.isArray(history) ? [...history] : [];
    const total = list.length;
    while (list.length > 0) {
        if (safeSet(key, list, storage)) {
            return { saved: true, dropped: total - list.length, stripped: false };
        }
        list.pop();
    }
    if (total > 0) {
        const bare = { ...history[0], samples: [], primaryActions: [], secondaryActions: [], telemetry: null };
        if (safeSet(key, [bare], storage)) {
            return { saved: true, dropped: total - 1, stripped: true };
        }
    }
    return { saved: false, dropped: total, stripped: false };
}
