// Point at a folder and pair each video with its scripts. Pure: names and
// paths in, pairings out. Nothing is opened.
//
// Same-folder exact names are decided by the player (script-pairing.js):
// Movie.mp4 + Movie.funscript is the stroker, Movie.v0.funscript (or the
// older Movie.vib.funscript) is the other toy. A folder full of videos
// cannot use the player's "only one of each, pair them anyway" rule, or
// every video would claim the one script that belongs to none of them.
// That rule is kept only when the folder really does hold one video and
// one stroke script.
//
// When the names are not exact, the folder is still searched the way a
// headset player does: ignore case, punctuation, a resolution (1080p, 4k)
// and a codec (h264, hevc), and look in a scripts folder next to the video.
// The stroker and the secondary are chosen separately. A second stroker
// whose name is the video plus a pack (Movie.Hard.funscript) stays a pack.

import { pairFiles, VIDEO_EXTENSIONS, VIB_SUFFIXES, AXIS_SUFFIXES } from '../player/script-pairing.js';

const SCRIPT_EXT = 'funscript';
const SCRIPT_DIRS = new Set(['scripts', 'funscripts', 'script']);
const AXIS_OR_VIB = new Set([...VIB_SUFFIXES, ...Object.keys(AXIS_SUFFIXES)]);
// A key shorter than this never matches by "one name contains the other".
// Short names collide too easily (a scene called "fun" is not every script).
const MIN_CONTAIN_KEY = 8;
const MIN_CONTAIN_RATIO = 0.62;

function extensionOf(name) {
    const base = basename(name);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function basename(path) {
    const norm = String(path ?? '').replace(/\\/g, '/');
    const cut = norm.lastIndexOf('/');
    return cut >= 0 ? norm.slice(cut + 1) : norm;
}

function dirname(path) {
    const norm = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const cut = norm.lastIndexOf('/');
    return cut >= 0 ? norm.slice(0, cut) : '';
}

// A listing entry. A string is a path. An object keeps whatever else it
// carried (a File, a size) and is handed back the same way.
export function asEntry(item) {
    if (typeof item === 'string') {
        const path = item.replace(/\\/g, '/');
        return { name: basename(path), path, dir: dirname(path) };
    }
    if (!item || typeof item.name !== 'string' || !item.name) return null;
    const path = typeof item.path === 'string' && item.path
        ? item.path.replace(/\\/g, '/')
        : item.name;
    return { ...item, name: basename(item.name), path, dir: item.dir != null ? String(item.dir).replace(/\\/g, '/') : dirname(path) };
}

function isVideoName(name) {
    return VIDEO_EXTENSIONS.includes(extensionOf(name));
}

function isScriptName(name) {
    return extensionOf(name) === SCRIPT_EXT;
}

// "Scene.v0.funscript" -> { base: "Scene", suffix: "v0" }.
// "Scene.funscript" -> { base: "Scene", suffix: null }.
function scriptParts(name) {
    let stem = basename(name);
    const dot = stem.lastIndexOf('.');
    if (dot > 0) stem = stem.slice(0, dot);
    const cut = stem.lastIndexOf('.');
    if (cut > 0) {
        const suffix = stem.slice(cut + 1).toLowerCase();
        if (AXIS_OR_VIB.has(suffix)) return { base: stem.slice(0, cut), suffix };
    }
    return { base: stem, suffix: null };
}

// The comparison key: lower case, no brackets, no resolution or codec, no
// punctuation. "Scene.Name.1080p.HEVC" and "scene name" share a key.
export function normalizeMediaKey(name) {
    const { base } = isScriptName(name) ? scriptParts(name) : { base: stripExt(basename(name)) };
    let s = base.toLowerCase();
    s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
    s = s.replace(/\b(1080p|2160p|720p|1440p|4320p|4k|8k|uhd|hdr|60fps|30fps|h\.?264|h\.?265|hevc|x264|x265|av1)\b/g, ' ');
    s = s.replace(/[^a-z0-9]+/g, '');
    return s;
}

function stripExt(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

// 100 is the same key. A contained key scores lower, and only when the
// shorter one is long enough to be a real title.
export function scoreKeys(videoKey, scriptKey) {
    if (!videoKey || !scriptKey) return 0;
    if (videoKey === scriptKey) return 100;
    const shorter = videoKey.length <= scriptKey.length ? videoKey : scriptKey;
    const longer = videoKey.length <= scriptKey.length ? scriptKey : videoKey;
    if (shorter.length < MIN_CONTAIN_KEY) return 0;
    if (!longer.includes(shorter)) return 0;
    const ratio = shorter.length / longer.length;
    if (ratio < MIN_CONTAIN_RATIO) return 0;
    return Math.round(70 * ratio);
}

function emptyAxes() {
    return { L1: null, L2: null, R0: null, R1: null, R2: null };
}

function parentDir(dir) {
    return dirname(dir);
}

function dirName(dir) {
    return basename(dir).toLowerCase();
}

// Scripts that sit on the video, plus a scripts / funscripts folder beside
// it or one level down.
function scriptsNear(video, scripts) {
    const dir = video.dir;
    const child = new Set([...SCRIPT_DIRS].map((name) => (dir ? `${dir}/${name}` : name)));
    const inScriptFolder = SCRIPT_DIRS.has(dirName(dir));
    const sibling = inScriptFolder ? parentDir(dir) : null;
    return scripts.filter((script) => {
        if (script.dir === dir) return true;
        if (child.has(script.dir)) return true;
        if (sibling !== null && script.dir === sibling) return true;
        return false;
    });
}

function pickBest(candidates) {
    let best = null;
    let ties = 0;
    for (const candidate of candidates) {
        if (!best || candidate.score > best.score) {
            best = candidate;
            ties = 1;
        } else if (candidate.score === best.score) {
            ties += 1;
            const bestGap = Math.abs(best.key.length - best.videoKey.length);
            const gap = Math.abs(candidate.key.length - candidate.videoKey.length);
            if (gap < bestGap || (gap === bestGap && candidate.item.name.localeCompare(best.item.name) < 0)) {
                best = candidate;
            }
        }
    }
    return { best, ambiguous: ties > 1 };
}

function roleOf(suffix) {
    if (!suffix) return { kind: 'stroke' };
    if (VIB_SUFFIXES.includes(suffix)) return { kind: 'vib' };
    if (Object.prototype.hasOwnProperty.call(AXIS_SUFFIXES, suffix)) return { kind: 'axis', axis: AXIS_SUFFIXES[suffix] };
    return null;
}

// One video, the scripts that were already judged to belong to it.
function assign(video, scripts, match, score) {
    const strokes = [];
    const result = {
        video,
        stroke: null,
        vib: null,
        axes: emptyAxes(),
        packs: [],
        match,
        score,
        ambiguous: false
    };
    for (const script of scripts) {
        const { suffix } = scriptParts(script.name);
        const role = roleOf(suffix);
        if (!role) continue;
        if (role.kind === 'stroke') strokes.push(script);
        else if (role.kind === 'vib') {
            if (!result.vib) result.vib = script;
        } else if (!result.axes[role.axis]) result.axes[role.axis] = script;
    }
    strokes.sort((a, b) => a.name.localeCompare(b.name));
    result.stroke = strokes[0] || null;
    result.packs = strokes.map((item) => ({
        name: scriptParts(item.name).base.toLowerCase() === scriptParts(video.name).base.toLowerCase() ? null : scriptParts(item.name).base,
        item
    }));
    return result;
}

function exactPair(video, nearby, videoCount) {
    const pair = pairFiles([video, ...nearby]);
    if (!pair.stroke) return null;
    if (pair.loose && videoCount !== 1) return null;
    const used = new Set([pair.stroke, pair.vib, ...Object.values(pair.axes)].filter(Boolean));
    return {
        video,
        stroke: pair.stroke,
        vib: pair.vib,
        axes: pair.axes,
        packs: pair.packs,
        match: pair.loose ? 'loose' : 'exact',
        score: pair.loose ? 50 : 100,
        ambiguous: false,
        used
    };
}

function fuzzyPair(video, nearby) {
    const videoKey = normalizeMediaKey(video.name);
    const ranked = [];
    for (const script of nearby) {
        const parts = scriptParts(script.name);
        const key = normalizeMediaKey(parts.base);
        const score = scoreKeys(videoKey, key);
        if (score <= 0) continue;
        ranked.push({ item: script, score, key, videoKey, suffix: parts.suffix });
    }
    const strokes = ranked.filter((r) => !r.suffix);
    const { best, ambiguous } = pickBest(strokes);
    if (!best) return null;
    const chosenKey = best.key;
    const belong = ranked.filter((r) => r.key === chosenKey).map((r) => r.item);
    // A vib file whose own key matches the video, even if the stroker's key
    // was the contained one, still belongs to this video.
    for (const r of ranked) {
        if (r.suffix && VIB_SUFFIXES.includes(r.suffix) && r.key === videoKey && !belong.includes(r.item)) {
            belong.push(r.item);
        }
    }
    const assigned = assign(video, belong, 'fuzzy', best.score);
    assigned.ambiguous = ambiguous;
    assigned.used = new Set([assigned.stroke, assigned.vib, ...Object.values(assigned.axes)].filter(Boolean));
    return assigned;
}

// matchLibrary(entries) -> {
//   videos: [{ video, stroke, vib, axes, packs, match, score, ambiguous }]
//   unmatched: scripts no video took
// }
// match is "exact", "loose", "fuzzy", or "none".
export function matchLibrary(entries) {
    const list = (Array.isArray(entries) ? entries : []).map(asEntry).filter(Boolean);
    const videos = list.filter((item) => isVideoName(item.name));
    const scripts = list.filter((item) => isScriptName(item.name));
    const byDir = new Map();
    for (const video of videos) {
        const key = video.dir;
        if (!byDir.has(key)) byDir.set(key, []);
        byDir.get(key).push(video);
    }
    const rows = [];
    const used = new Set();
    for (const group of byDir.values()) {
        group.sort((a, b) => String(a.path).localeCompare(String(b.path)));
        for (const video of group) {
            const nearby = scriptsNear(video, scripts).filter((script) => !used.has(script));
            const exact = exactPair(video, nearby, group.length);
            const pair = exact || fuzzyPair(video, nearby);
            if (pair) {
                for (const item of pair.used) used.add(item);
                rows.push({
                    video: pair.video,
                    stroke: pair.stroke,
                    vib: pair.vib,
                    axes: pair.axes,
                    packs: pair.packs,
                    match: pair.match,
                    score: pair.score,
                    ambiguous: pair.ambiguous
                });
            } else {
                rows.push({
                    video,
                    stroke: null,
                    vib: null,
                    axes: emptyAxes(),
                    packs: [],
                    match: 'none',
                    score: 0,
                    ambiguous: false
                });
            }
        }
    }
    rows.sort((a, b) => String(a.video.path).localeCompare(String(b.video.path)));
    const unmatched = scripts.filter((script) => !used.has(script));
    return { videos: rows, unmatched };
}
