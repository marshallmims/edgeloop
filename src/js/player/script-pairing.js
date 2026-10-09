// Which of the files the wearer picked belong together. Pure: it reads names
// only, never contents, and keeps nothing.
//
// Pairing is by base name, the way every script player does it:
//   Movie.mp4 + Movie.funscript           the stroke script
//   Movie.<pack>.funscript                an alternate stroke script (a pack)
//   Movie.v0.funscript                    the secondary toy (EdgeLoop's own export)
//   Movie.vib.funscript                   the same channel, under the older name
//   Movie.surge|sway|twist|roll|pitch.funscript   the other axes (phase 3)
// Names are compared without regard to case. A pick can hold File objects or
// plain names: whatever has a `name` (or is a string) is handed back as it
// came, so the player gets its File objects back and the tests can use
// strings.
//
// On a phone a video and its script usually sit in different folders, so
// they come in two picks, and the player pairs everything picked so far
// again. When the names do not match but there is exactly one video and
// exactly one stroke script, the two are paired anyway and `loose` says so,
// so the panel can tell the wearer which script plays with the video.

export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv']);
export const SCRIPT_EXTENSION = 'funscript';

// Suffix -> channel. `v0` is the second channel's file (what EdgeLoop writes
// on export). `vib` is the same channel under the name other players use.
// The rest are the T-Code axes they drive.
export const AXIS_SUFFIXES = Object.freeze({
    surge: 'L1',
    sway: 'L2',
    twist: 'R0',
    roll: 'R1',
    pitch: 'R2'
});
export const VIB_SUFFIX = 'vib';
export const VIB_SUFFIXES = Object.freeze(['v0', 'vib']);
export const AXIS_IDS = Object.freeze(['L1', 'L2', 'R0', 'R1', 'R2']);

function nameOf(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item.name === 'string') return item.name;
    return '';
}

// { item, name, ext, stem } with ext lowercased and stem the name before it.
function describe(item) {
    const name = nameOf(item);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return { item, name, ext, stem, key: stem.toLowerCase() };
}

function isVideo(entry) {
    return VIDEO_EXTENSIONS.includes(entry.ext);
}

function isScript(entry) {
    return entry.ext === SCRIPT_EXTENSION;
}

// What a script's stem says it is, relative to a video base `base`
// (lowercase). Null when it does not belong to that base at all.
function scriptRole(scriptKey, base) {
    if (scriptKey === base) return { kind: 'stroke', pack: null };
    if (!scriptKey.startsWith(`${base}.`)) return null;
    const rest = scriptKey.slice(base.length + 1);
    if (VIB_SUFFIXES.includes(rest)) return { kind: 'vib' };
    if (Object.prototype.hasOwnProperty.call(AXIS_SUFFIXES, rest)) return { kind: 'axis', axis: AXIS_SUFFIXES[rest] };
    // `Movie.pack.twist`: a pack's own axis file. Packs of axes come with the
    // axes (phase 3); until then such a file is listed as unused.
    if (rest.includes('.')) return { kind: 'pack-axis' };
    return { kind: 'stroke', pack: rest };
}

// The suffix a script's own name ends in, with no video to compare against.
function ownSuffix(scriptKey) {
    const dot = scriptKey.lastIndexOf('.');
    if (dot <= 0) return null;
    const last = scriptKey.slice(dot + 1);
    if (VIB_SUFFIXES.includes(last) || Object.prototype.hasOwnProperty.call(AXIS_SUFFIXES, last)) {
        return { suffix: last, base: scriptKey.slice(0, dot) };
    }
    return null;
}

function emptyAxes() {
    return { L1: null, L2: null, R0: null, R1: null, R2: null };
}

// pairFiles(items) -> {
//   video     the video to play, or null
//   stroke    the stroke script to play with it, or null
//   vib       the vibration script, or null
//   axes      { L1, L2, R0, R1, R2 }: each an item or null
//   packs     every stroke script that fits, [{ name, item }], the plain one
//             first with name null; more than one means the panel offers a
//             picker. `stroke` is packs[0].item.
//   unused    [{ item, reason }]: everything not used, with why
//   loose     true when video and stroke were paired although their names
//             differ (one video and one stroke script)
//   videos    how many videos were picked
// }
export function pairFiles(items) {
    const list = Array.isArray(items) ? items : Array.from(items || []);
    const entries = list.map(describe);
    const videos = entries.filter(isVideo);
    const scripts = entries.filter(isScript);
    const unused = [];
    for (const entry of entries) {
        if (!isVideo(entry) && !isScript(entry)) {
            unused.push({ item: entry.item, reason: 'not a video or a .funscript' });
        }
    }

    const result = {
        video: null,
        stroke: null,
        vib: null,
        axes: emptyAxes(),
        packs: [],
        unused,
        loose: false,
        videos: videos.length
    };

    // The video: the first one (in the order picked) that has a stroke
    // script of its own; else the first one. One video plays at a time.
    let video = null;
    for (const candidate of videos) {
        const hasStroke = scripts.some((s) => {
            const role = scriptRole(s.key, candidate.key);
            return role && role.kind === 'stroke';
        });
        if (hasStroke) {
            video = candidate;
            break;
        }
    }
    if (!video && videos.length > 0) video = videos[0];
    for (const other of videos) {
        if (other !== video) unused.push({ item: other.item, reason: 'another video: one video plays at a time' });
    }
    result.video = video ? video.item : null;

    const strokes = [];
    const place = (entry, role) => {
        if (role.kind === 'stroke') {
            if (strokes.some((s) => s.pack === role.pack)) {
                unused.push({ item: entry.item, reason: 'the same script twice' });
            } else {
                strokes.push({ entry, pack: role.pack });
            }
        } else if (role.kind === 'vib') {
            if (result.vib) unused.push({ item: entry.item, reason: 'the same script twice' });
            else result.vib = entry.item;
        } else if (role.kind === 'axis') {
            if (result.axes[role.axis]) unused.push({ item: entry.item, reason: 'the same script twice' });
            else result.axes[role.axis] = entry.item;
        } else {
            unused.push({ item: entry.item, reason: 'an axis of an alternate pack: not supported yet' });
        }
    };

    if (video) {
        const rest = [];
        for (const script of scripts) {
            const role = scriptRole(script.key, video.key);
            if (role) place(script, role);
            else rest.push(script);
        }
        // One video, no script of its name, and exactly one stroke script
        // among the rest: pair them, and say so.
        const plainRest = rest.filter((s) => !ownSuffix(s.key));
        if (strokes.length === 0 && videos.length === 1 && plainRest.length === 1) {
            strokes.push({ entry: plainRest[0], pack: null });
            result.loose = true;
            const base = plainRest[0].key;
            for (const script of rest) {
                if (script === plainRest[0]) continue;
                const role = scriptRole(script.key, base);
                if (role && role.kind !== 'stroke') place(script, role);
                else unused.push({ item: script.item, reason: 'its name does not match the video' });
            }
        } else {
            for (const script of rest) unused.push({ item: script.item, reason: 'its name does not match the video' });
        }
    } else {
        // No video yet: the scripts are grouped by their own names. A single
        // stroke script is taken as the one to play; with several, none is
        // chosen until the video says which.
        const plain = scripts.filter((s) => !ownSuffix(s.key));
        if (plain.length === 1) {
            const base = plain[0].key;
            for (const script of scripts) {
                const role = scriptRole(script.key, base);
                if (role) place(script, role);
                else unused.push({ item: script.item, reason: 'its name does not match the script' });
            }
        } else {
            for (const script of scripts) {
                unused.push({
                    item: script.item,
                    reason: plain.length > 1 ? 'pick the video it belongs to' : 'no stroke script with this name'
                });
            }
        }
    }

    strokes.sort((a, b) => {
        if (a.pack === null) return -1;
        if (b.pack === null) return 1;
        return a.pack.localeCompare(b.pack);
    });
    result.packs = strokes.map((s) => ({ name: s.pack === null ? null : packLabel(s.entry, s.pack), item: s.entry.item }));
    result.stroke = result.packs.length > 0 ? result.packs[0].item : null;
    return result;
}

// The pack's name as the file spells it (`Movie.Hard.funscript` -> "Hard").
function packLabel(entry, packKey) {
    return entry.stem.slice(entry.stem.length - packKey.length);
}
