// Reading a .funscript the wearer loaded from their own disk. Pure: no DOM,
// no storage, no timers, so every rule runs under node:test.
//
// The file is the shape of every stroke the toy will make, so nothing in it
// is trusted. It is read inside a try, its size and its action count are
// bounded before anything is built from them, every action that is not a
// time and a position is dropped and counted, and a file that leaves fewer
// than two actions is refused: one point is no stroke, and a toy must never
// be asked to guess the rest.
//
// What comes out is the track the player runs on: two typed arrays, the
// times in ms (Int32Array) and the positions 0-100 (Uint8Array), sorted by
// time with one action per time. About 0.6 MB for 120,000 actions, and
// parsing takes milliseconds, so it needs no Worker.
//
// Nothing here keeps a file name or any of the file's content past the call.
// The hash below is the one thing that may be stored (a per-script offset,
// History), and it is a digest of the parsed actions, never the text.

export const FUNSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
export const FUNSCRIPT_MAX_ACTIONS = 1000000;
export const FUNSCRIPT_MAX_AT_MS = 24 * 60 * 60 * 1000;
export const FUNSCRIPT_MIN_ACTIONS = 2;
// Chapters are only carried for the panel; a file cannot make the page hold
// an unbounded list of them, or names of any length.
export const FUNSCRIPT_MAX_CHAPTERS = 500;
export const FUNSCRIPT_MAX_CHAPTER_NAME = 100;

export const DEFAULT_FUNSCRIPT_LIMITS = Object.freeze({
    maxBytes: FUNSCRIPT_MAX_BYTES,
    maxActions: FUNSCRIPT_MAX_ACTIONS,
    maxAtMs: FUNSCRIPT_MAX_AT_MS,
    minActions: FUNSCRIPT_MIN_ACTIONS
});

function resolveLimits(limits) {
    const given = limits && typeof limits === 'object' ? limits : {};
    const pick = (key) => {
        const n = Number(given[key]);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FUNSCRIPT_LIMITS[key];
    };
    return {
        maxBytes: pick('maxBytes'),
        maxActions: pick('maxActions'),
        maxAtMs: pick('maxAtMs'),
        // Never fewer than two, whatever a caller asks: one action is no stroke.
        minActions: Math.max(FUNSCRIPT_MIN_ACTIONS, pick('minActions'))
    };
}

// Whether a file of this many bytes may be read at all. The player asks
// before it reads the file into a string, so a 2 GB "script" is refused by
// its size and never loaded.
export function checkFunscriptSize(byteLength, limits) {
    const { maxBytes } = resolveLimits(limits);
    const n = Number(byteLength);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'The script file could not be read.' };
    if (n > maxBytes) {
        return { ok: false, error: `The script file is too large (${formatMb(n)}; the most is ${formatMb(maxBytes)}).` };
    }
    return { ok: true, error: null };
}

function formatMb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function emptyDropped() {
    return {
        // `at` missing, not a number, not finite.
        badAt: 0,
        // `at` below 0 or past the time limit.
        outOfRange: 0,
        // `pos` missing, not a number, not finite.
        badPos: 0,
        // An entry that is not an object at all.
        notAction: 0,
        // Earlier actions at a time a later one also names (the last one wins).
        duplicates: 0,
        // Kept, but changed: `pos` outside 0-100 clamped, `at` with a fraction
        // rounded to the millisecond.
        clampedPos: 0,
        roundedAt: 0
    };
}

function refuse(error, dropped = emptyDropped()) {
    return { ok: false, track: null, meta: null, dropped, error };
}

// "HH:MM:SS.mmm" (OpenFunscripter's chapters), or a number of ms.
function chapterTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    if (typeof value !== 'string') return null;
    const m = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!m) return null;
    const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

function readChapters(root) {
    const metadata = root.metadata && typeof root.metadata === 'object' ? root.metadata : null;
    const list = metadata && Array.isArray(metadata.chapters) ? metadata.chapters : [];
    const chapters = [];
    for (const entry of list) {
        if (chapters.length >= FUNSCRIPT_MAX_CHAPTERS) break;
        if (!entry || typeof entry !== 'object') continue;
        const startMs = chapterTime(entry.startTime);
        const endMs = chapterTime(entry.endTime);
        if (startMs === null) continue;
        const name = typeof entry.name === 'string' ? entry.name.slice(0, FUNSCRIPT_MAX_CHAPTER_NAME) : '';
        chapters.push({ name, startMs, endMs: endMs !== null && endMs >= startMs ? endMs : null });
    }
    return chapters;
}

// parseFunscript(text, limits?) -> { ok, track, meta, dropped, error }
//
//   track   { at: Int32Array, pos: Uint8Array }, sorted, one action per ms
//   meta    { inverted, range, rangeNoted, durationMs, firstAtMs, actions,
//             chapters, hasAxes }
//   dropped counts of what was left out or changed (emptyDropped)
//   error   a sentence for the panel when ok is false, else null
//
// The track starts at the file's first action. Nothing is invented before
// it: where a script starts at 0:12, the toy has no motion until 0:12 (the
// shaper joins the first action like a rejoin).
export function parseFunscript(text, limits) {
    const lim = resolveLimits(limits);
    if (typeof text !== 'string') return refuse('The script file could not be read as text.');
    // A string of N characters is at least N bytes of UTF-8, so this never
    // lets past a file the byte check would have refused for its length.
    if (text.length > lim.maxBytes) return refuse(checkFunscriptSize(text.length, lim).error);
    if (text.trim() === '') return refuse('The script file is empty.');

    let root;
    try {
        root = JSON.parse(text);
    } catch {
        return refuse('This is not a funscript: the file is not valid JSON.');
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        return refuse('This is not a funscript: it has no "actions" list.');
    }
    const actions = root.actions;
    if (!Array.isArray(actions)) return refuse('This is not a funscript: it has no "actions" list.');
    if (actions.length > lim.maxActions) {
        return refuse(`The script has too many actions (${actions.length.toLocaleString('en-US')}; `
            + `the most is ${lim.maxActions.toLocaleString('en-US')}).`);
    }

    const dropped = emptyDropped();
    // Gather the usable actions with their place in the file, so the sort
    // below can keep the LAST of several actions at one time.
    const kept = [];
    for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i];
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            dropped.notAction += 1;
            continue;
        }
        const rawAt = action.at;
        if (typeof rawAt !== 'number' || !Number.isFinite(rawAt)) {
            dropped.badAt += 1;
            continue;
        }
        const at = Math.round(rawAt);
        if (at < 0 || at > lim.maxAtMs) {
            dropped.outOfRange += 1;
            continue;
        }
        if (at !== rawAt) dropped.roundedAt += 1;
        const rawPos = action.pos;
        if (typeof rawPos !== 'number' || !Number.isFinite(rawPos)) {
            dropped.badPos += 1;
            continue;
        }
        const pos = Math.max(0, Math.min(100, Math.round(rawPos)));
        if (pos !== Math.round(rawPos)) dropped.clampedPos += 1;
        kept.push({ at, pos, order: i });
    }

    kept.sort((a, b) => a.at - b.at || a.order - b.order);
    const unique = [];
    for (const action of kept) {
        const last = unique[unique.length - 1];
        if (last && last.at === action.at) {
            unique[unique.length - 1] = action;
            dropped.duplicates += 1;
        } else {
            unique.push(action);
        }
    }

    if (unique.length < lim.minActions) {
        const what = unique.length === 0 ? 'no usable actions' : 'only one usable action';
        return refuse(`The script has ${what}; a stroke needs at least ${lim.minActions}.`, dropped);
    }

    const at = new Int32Array(unique.length);
    const pos = new Uint8Array(unique.length);
    for (let i = 0; i < unique.length; i += 1) {
        at[i] = unique[i].at;
        pos[i] = unique[i].pos;
    }

    // `range` scales positions in some old players. Others ignore it and so
    // does this one; a value other than 100 is only noted for the panel.
    const rawRange = Number(root.range);
    const range = Number.isFinite(rawRange) ? rawRange : 100;
    const meta = {
        inverted: root.inverted === true,
        range,
        rangeNoted: range !== 100,
        durationMs: at[at.length - 1],
        firstAtMs: at[0],
        actions: at.length,
        chapters: readChapters(root),
        // A single-file multi-axis script (an `axes` array). Only its main
        // `actions` are played until that format is confirmed.
        hasAxes: Array.isArray(root.axes) && root.axes.length > 0
    };
    return { ok: true, track: { at, pos }, meta, dropped, error: null };
}

// How many actions were left out or changed, for one line in the panel.
export function describeDropped(dropped) {
    if (!dropped || typeof dropped !== 'object') return '';
    const parts = [];
    const left = (dropped.badAt || 0) + (dropped.outOfRange || 0) + (dropped.badPos || 0) + (dropped.notAction || 0);
    if (left > 0) parts.push(`${left} unusable action${left === 1 ? '' : 's'} left out`);
    if (dropped.duplicates > 0) {
        parts.push(`${dropped.duplicates} duplicate time${dropped.duplicates === 1 ? '' : 's'} merged (the last one kept)`);
    }
    if (dropped.clampedPos > 0) parts.push(`${dropped.clampedPos} position${dropped.clampedPos === 1 ? '' : 's'} outside 0-100 clamped`);
    return parts.join('; ');
}

// The bytes a script's identity is computed from: each action as its time
// (4 bytes, little-endian, signed) and its position (1 byte), in order. The
// same actions always give the same bytes, whatever the file's formatting,
// key order or metadata, so an offset remembered for a script finds it again
// after the file is re-saved. SHA-256 over these is the script's hash
// (scriptDigestHex); nothing else about the file is ever stored.
export function scriptHash(track) {
    const n = track && track.at ? track.at.length : 0;
    const bytes = new Uint8Array(n * 5);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < n; i += 1) {
        view.setInt32(i * 5, track.at[i], true);
        bytes[i * 5 + 4] = track.pos[i];
    }
    return bytes;
}

// SHA-256 of scriptHash(track) as 64 hex characters. `subtle` is the Web
// Crypto SubtleCrypto (the page's crypto.subtle; node has the same).
export async function scriptDigestHex(track, subtle = globalThis.crypto && globalThis.crypto.subtle) {
    if (!subtle || typeof subtle.digest !== 'function') throw new Error('SHA-256 is not available here.');
    const digest = new Uint8Array(await subtle.digest('SHA-256', scriptHash(track)));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    return hex;
}
