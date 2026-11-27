// Named voice / dashboard cue templates. Each event holds a list of phrases
// (one per line in the editor). Tokens `{hr}`, `{maxHr}`, `{minHr}`,
// `{edges}` and `{minutes}` are filled from the live session when a cue fires.

export const MAX_CUE_LENGTH = 140;
export const MAX_PHRASES_PER_CUE = 120;

export const VOICE_CUE_VARS = ['hr', 'maxHr', 'minHr', 'edges', 'minutes', 'done', 'need', 'hold'];

export const MIN_ENCOURAGE_SECONDS = 0;
export const MAX_ENCOURAGE_SECONDS = 180;
export const DEFAULT_ENCOURAGE_SECONDS = 45;

export const VOICE_CUE_CATALOG = [
    {
        id: 'encourage',
        group: 'Build-up',
        label: 'Build-up encouragement',
        lines: [
            'Stay right on the edge.',
            'Breathe. You can hold this.',
            'Not yet. Keep it there.',
            'Good. Keep building.',
            'Slow and mean. Don\'t rush.',
            'You\'re doing well. Stay hungry.',
            'Climb. Don\'t finish.',
            'That\'s it. Let it stack.',
            'Still denied. Keep going.',
            '{minutes} minutes in. Hold.',
            'Edge {edges} so far. Keep it.',
            'Warm and tight. Don\'t spill.',
            'Take the pleasure. Not the finish.',
            'Steady. You are not done yet.'
        ]
    },
    {
        id: 'warmupDone',
        group: 'Build-up',
        label: 'Warm-up complete',
        lines: [
            'Warm up complete.',
            'Warm-up over. Now we climb.',
            'The easy part is done. Hold.'
        ]
    },
    {
        id: 'edge',
        group: 'Edge',
        label: 'Hit the edge',
        lines: [
            'Edge. Back off. {hr} BPM.',
            'That\'s the edge. Don\'t go over.',
            'Hold it. {hr} of {maxHr}.',
            'Back off now. Edge {edges}.',
            'Right there. Stay on it.',
            'Pulse at the line. Don\'t come.',
            'Too close. Ease off.',
            'That\'s it. Ride the edge.',
            '{hr} BPM. Hold, don\'t finish.',
            'Stop climbing. Stay edged.',
            'You\'re there. Breathe through it.',
            'On the brink. Not yet.'
        ]
    },
    { id: 'stallHalt', group: 'Edge', label: 'Stall pause starts', lines: ['Stall guard. Primary halted. Recover.', 'Too long on the edge. Halt. Recover.'] },
    { id: 'stallResume', group: 'Edge', label: 'Stall pause ends', lines: ['Hold window reset. Crawl.', 'Crawl again. Don\'t dump it.'] },
    { id: 'stallRecover', group: 'Edge', label: 'Left the edge', lines: ['Recovered. Resume.', 'Off the edge. Climb again.'] },
    {
        id: 'forceOrgasm',
        group: 'Climax',
        label: 'Force orgasm / make you come',
        lines: [
            'Force orgasm. You don\'t get to hold back.',
            'Come. Now.',
            'That\'s it. Finish.',
            'No more holding. Come for it.',
            'Over the edge. Let go.',
            'Forced. You come now.',
            'Ceiling is gone. Come.',
            '{hr} BPM. Don\'t stop until you finish.',
            'Take it. Come.',
            'This is the one. Come.',
            'You are allowed to come. Do it.',
            'No denial. Finish.'
        ]
    },
    {
        id: 'forceOrgasmOff',
        group: 'Climax',
        label: 'Force orgasm cancelled',
        lines: [
            'Force orgasm cancelled. Back to the edge.',
            'Denied again. Climb.',
            'Climax withdrawn. Hold.',
            'Not this time. Stay edged.'
        ]
    },
    { id: 'oracleWatching', group: 'Climax', label: 'Oracle approach', lines: ['The Oracle is watching. Climb.'] },
    { id: 'oracleHold', group: 'Climax', label: 'Oracle hold', lines: ['Hold. Fifteen seconds.'] },
    {
        id: 'oracleClimax',
        group: 'Climax',
        label: 'Oracle chooses climax',
        lines: [
            'The Oracle chooses climax.',
            'The Oracle says come.',
            'Oracle: you finish now.'
        ]
    },
    { id: 'oraclePurgatory', group: 'Climax', label: 'Oracle purgatory', lines: ['The Oracle chooses purgatory.'] },
    { id: 'oracleSoftLanding', group: 'Climax', label: 'Oracle soft landing', lines: ['The Oracle chooses a soft landing. Ease down.'] },
    { id: 'oracleNotYet', group: 'Climax', label: 'Oracle too early to end', lines: ['Not yet. Keep climbing.', 'Too soon. The Oracle is still watching.'] },
    { id: 'oracleWithdrawn', group: 'Climax', label: 'Oracle climax cancelled', lines: ['Climax withdrawn. Climb again.'] },
    { id: 'oracleReset', group: 'Climax', label: 'Oracle purgatory reset', lines: ['Purgatory resets. Climb again.'] },
    {
        id: 'trainHold',
        group: 'Training',
        label: 'Edge training: hold',
        lines: [
            'Hold it. {hold} seconds.',
            'Stay on the edge. Hold.',
            'Don\'t come. Hold it there.'
        ]
    },
    {
        id: 'trainHeld',
        group: 'Training',
        label: 'Edge training: edge counted',
        lines: [
            'Edge held. {done} of {need}.',
            'Good. Recover, then climb. {done} of {need}.',
            'That one counts. {done} down, keep going.'
        ]
    },
    {
        id: 'trainDrop',
        group: 'Training',
        label: 'Edge training: dropped early',
        lines: [
            'Dropped. That one does not count.',
            'Too soon. Climb and hold again.',
            'Off the edge. Try a longer hold.'
        ]
    },
    {
        id: 'trainFinish',
        group: 'Training',
        label: 'Edge training: complete, climax',
        lines: [
            'Training complete. Come.',
            '{need} edges. You can finish.',
            'You held them. Come now.'
        ]
    },
    {
        id: 'trainEase',
        group: 'Training',
        label: 'Edge training: complete, soft landing',
        lines: [
            'Training complete. Easing down.',
            '{need} edges. The toys tease down. No finish.',
            'You held them. Soft landing.'
        ]
    },
    {
        id: 'trainStop',
        group: 'Training',
        label: 'Edge training: complete, strict denial',
        lines: [
            'Training complete. Everything stops.',
            '{need} edges. Toys off. Session over.',
            'You held them. Denied.'
        ]
    },
    {
        id: 'cameEarly',
        group: 'Premature',
        label: 'Came early / premature ejaculation',
        lines: [
            'Came early. Limit tightened.',
            'Premature. Ceiling drops next time.',
            'You came too soon. Learning that.',
            'Accidental release. {hr} BPM. Limits tighter.',
            'Too soon. We\'ll keep you lower.',
            'Breakthrough logged. Hold better next time.',
            'You spilled. Working climax HR goes down.',
            'Premature ejaculation. The next session is meaner.'
        ]
    },
    { id: 'idle', group: 'Session', label: 'Resting prompt', lines: ['Calm and steady. Breathe.'] },
    { id: 'preview', group: 'Session', label: 'Voice preview', lines: ['EdgeLoop voice preview. Stay right on the edge.'] },
    { id: 'sessionStart', group: 'Session', label: 'Session start', lines: ['Session started. Breathe.'] },
    { id: 'paused', group: 'Session', label: 'Paused', lines: ['Paused.'] },
    { id: 'sessionStop', group: 'Session', label: 'Session stop', lines: ['Session stopped.'] },
    { id: 'survivalBreach', group: 'Guards', label: 'Survival mark moved', lines: ['The mark moved up.'] },
    { id: 'signalLost', group: 'Guards', label: 'Heart-rate signal lost', lines: ['Heart rate signal lost. Motors stopped.'] },
    { id: 'signalRestored', group: 'Guards', label: 'Heart-rate restored', lines: ['Signal restored. Resuming.'] }
];

export const DEFAULT_VOICE_CUES = Object.fromEntries(
    VOICE_CUE_CATALOG.map((cue) => [cue.id, [...cue.lines]])
);

const KNOWN_IDS = new Set(VOICE_CUE_CATALOG.map((cue) => cue.id));
const CATALOG_BY_ID = Object.fromEntries(VOICE_CUE_CATALOG.map((cue) => [cue.id, cue]));
const ID_BY_LOOSE_NAME = new Map(VOICE_CUE_CATALOG.map((cue) => [cue.id.toLowerCase(), cue.id]));

// A hand-written file says `# edge`, but people capitalise headings: `# Edge`,
// `[Force Orgasm]` and `# forceorgasm` all name the same cue.
export function resolveCueHeaderName(name) {
    if (typeof name !== 'string') return '';
    const key = name.trim().toLowerCase();
    if (!key) return '';
    return ID_BY_LOOSE_NAME.get(key) || ID_BY_LOOSE_NAME.get(key.replace(/[^a-z0-9]+/g, '')) || '';
}

// `null` when the line is not header-shaped; the raw name otherwise.
function headerNameOf(line) {
    if (line.startsWith('#')) return line.replace(/^#+/, '').trim();
    if (line.startsWith('[') && line.endsWith(']')) return line.slice(1, -1).trim();
    return null;
}

export function isVoiceCueId(key) {
    return KNOWN_IDS.has(key);
}

export function clampEncourageSeconds(value, fallback = DEFAULT_ENCOURAGE_SECONDS) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_ENCOURAGE_SECONDS, Math.min(MAX_ENCOURAGE_SECONDS, n));
}

export function sanitizeCueText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) return fallback;
    return trimmed.length > MAX_CUE_LENGTH ? trimmed.slice(0, MAX_CUE_LENGTH) : trimmed;
}

function linesFrom(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/\r?\n/);
    return [];
}

// Is this value something an import may WRITE at all? A string or an array is
// an answer (a list of lines, or - when it sanitises to nothing - a mute).
// Anything else (null, a number, an object from a hand-edited file) is not an
// answer, so the bank it names is left exactly as it was.
export function isWritableCueValue(value) {
    return typeof value === 'string' || Array.isArray(value);
}

export function sanitizeCueList(value, fallbackLines = [], maxLines = MAX_PHRASES_PER_CUE) {
    const fallback = linesFrom(fallbackLines).map((line) => sanitizeCueText(line, '')).filter(Boolean);
    const unique = [];
    const seen = new Set();
    for (const raw of linesFrom(value)) {
        const line = sanitizeCueText(raw, '');
        if (!line || seen.has(line)) continue;
        seen.add(line);
        unique.push(line);
        if (unique.length >= maxLines) break;
    }
    if (unique.length > 0) return unique;
    // An emptied box means "say nothing for this cue": a bank the user cleared
    // stays muted. Only an absent (or unusable) value falls back to the
    // factory lines.
    return isWritableCueValue(value) ? [] : fallback;
}

export function mergeVoiceCues(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const cue of VOICE_CUE_CATALOG) {
        out[cue.id] = sanitizeCueList(src[cue.id], cue.lines);
    }
    return out;
}

export function interpolateCue(template, vars = {}) {
    if (typeof template !== 'string' || !template) return '';
    return template.replace(/\{([a-zA-Z]+)\}/g, (full, name) => {
        if (!VOICE_CUE_VARS.includes(name)) return full;
        const value = vars[name];
        if (value === undefined || value === null || value === '') return '';
        return String(value);
    }).replace(/\s+/g, ' ').trim();
}

export function pickCueLine(lines, lastText = '', random = Math.random) {
    const list = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line) : [];
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    const roll = Number(random());
    const idxBase = Number.isFinite(roll) ? Math.abs(roll) % 1 : 0;
    const pool = lastText ? list.filter((line) => line !== lastText) : list;
    const choices = pool.length > 0 ? pool : list;
    return choices[Math.min(choices.length - 1, Math.floor(idxBase * choices.length))];
}

// `key` is a catalog id, or a literal sentence (history outcomes, one-offs).
export function resolveVoiceCue(cues, key, vars = {}, { lastTemplate = '', random = Math.random } = {}) {
    if (typeof key !== 'string' || !key) return { text: '', template: '' };
    if (!KNOWN_IDS.has(key)) {
        const template = sanitizeCueText(key, '');
        return { text: interpolateCue(template, vars), template };
    }
    const merged = mergeVoiceCues(cues);
    const template = pickCueLine(merged[key], lastTemplate, random);
    return { text: interpolateCue(template, vars), template };
}

export function serializeVoiceCues(cues) {
    return mergeVoiceCues(cues);
}

function extractCueMap(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.voiceCues && typeof parsed.voiceCues === 'object' && !Array.isArray(parsed.voiceCues)) {
        return parsed.voiceCues;
    }
    // A full settings backup keeps the phrase lists one level down, under
    // `settings`. The refusal below offers "a settings backup" by name, so
    // the shape the Backup tab actually writes has to be one of the three.
    const nested = parsed.settings;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)
        && nested.voiceCues && typeof nested.voiceCues === 'object' && !Array.isArray(nested.voiceCues)) {
        return nested.voiceCues;
    }
    const keys = Object.keys(parsed);
    if (keys.some((key) => KNOWN_IDS.has(key))) return parsed;
    return null;
}

export function applyImportedCues(current, incoming) {
    const base = mergeVoiceCues(current);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
    for (const cue of VOICE_CUE_CATALOG) {
        // Presence of the key is the whole test. An emptied bank is a real,
        // persisted state ("say nothing for this cue") and Export writes it
        // out as `[]`, so a file that mentions the cue with an empty list is
        // restoring a mute, not saying nothing. Only an unusable value (not a
        // string, not an array) falls back to what is already there.
        if (!Object.prototype.hasOwnProperty.call(incoming, cue.id)) continue;
        base[cue.id] = sanitizeCueList(incoming[cue.id], base[cue.id]);
    }
    return base;
}

// The catalog ids an import will really write, and which of them are mutes.
// The alert used to count the keys in the FILE, which could not be trusted:
// it over-reported whenever a key was dropped, and it can say nothing about
// how many banks the file silences. It must ask exactly the question
// `applyImportedCues` answers, key by key: a cue whose value is not writable
// (null, a number - hand-edited files do that) keeps the lines the user
// already had, so it is neither imported nor muted. Reporting it as a mute
// sent the wearer hunting for a silent bank that was never touched.
export function describeImport(incoming) {
    const applied = [];
    const muted = [];
    const skipped = [];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { applied, muted, skipped };
    for (const cue of VOICE_CUE_CATALOG) {
        if (!Object.prototype.hasOwnProperty.call(incoming, cue.id)) continue;
        if (!isWritableCueValue(incoming[cue.id])) {
            skipped.push(cue.id);
            continue;
        }
        applied.push(cue.id);
        if (sanitizeCueList(incoming[cue.id], []).length === 0) muted.push(cue.id);
    }
    return { applied, muted, skipped };
}

// The sentence the wearer reads after an import. It reports the three
// answers the import actually gave each bank the file names: written,
// written empty (a mute they chose), and left alone because the value was
// not a list of lines at all.
export function voiceImportAlert(
    { applied = [], muted = [], skipped = [] } = {},
    { saved = true, timerChanged = false } = {}
) {
    const lists = (n) => `${n} phrase list${n === 1 ? '' : 's'}`;
    const kept = skipped.length > 0
        ? ` ${lists(skipped.length)} in the file ${skipped.length === 1 ? 'was' : 'were'} not lines of text,`
            + ` so ${skipped.length === 1 ? 'that bank was' : 'those banks were'} left as ${skipped.length === 1 ? 'it is' : 'they are'}.`
        : '';
    if (applied.length === 0) {
        // A refused save is still reported: this same save also carries the
        // phrase edits made on screen before the import, and the build-up
        // timer the file may have moved, so "nothing was changed" would be a
        // promise the browser did not keep.
        if (!saved) {
            return 'No phrase list was imported, and the browser refused to save'
                + ' (storage full or unavailable), so anything else you changed is'
                + ` live for this session only.${kept}`;
        }
        // A file may carry no usable phrase bank and still move the build-up
        // timer, which this same save wrote: saying "nothing was changed"
        // would send the wearer away believing their timer is untouched.
        if (timerChanged) {
            return `No phrase list was imported. The build-up timer in the file was applied and saved.${kept}`;
        }
        return `Nothing was imported and nothing was changed.${kept}`.trim();
    }
    const mutedClause = muted.length > 0 ? ` (${muted.length} muted)` : '';
    if (!saved) {
        return `Imported ${lists(applied.length)}${mutedClause}, but the browser refused to save`
            + ` (storage full or unavailable). The new phrases are live for this session only.${kept}`;
    }
    return `Imported and saved ${lists(applied.length)}${mutedClause}.${kept}`;
}

function presentCueMap(src) {
    const incoming = {};
    if (!src || typeof src !== 'object' || Array.isArray(src)) return incoming;
    for (const cue of VOICE_CUE_CATALOG) {
        if (!Object.prototype.hasOwnProperty.call(src, cue.id)) continue;
        incoming[cue.id] = src[cue.id];
    }
    return incoming;
}

// Does this text open a JSON document rather than a phrase? `{` alone (the
// first line of a pretty-printed export) and `{"voiceCues": ...` both do; a
// line that begins with an interpolation token - the same `\{([a-zA-Z]+)\}`
// shape resolveCueTemplate substitutes - does not. Both the top-level shape
// decision and the headerless preamble check ask this, so a phrase file and
// a JSON export are told apart by one rule in one place.
function opensJsonDocument(line) {
    return line.startsWith('{') && !/^\{[a-zA-Z]+\}/.test(line);
}

export function parseVoiceCuesText(raw) {
    const text = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : '';
    if (!text.trim()) return { cues: {}, error: 'empty', encourageSeconds: null };

    // Blank and `//` comment lines above the content are dropped before the
    // shape is decided: a hand-annotated export ("// my backup" on line one)
    // is still JSON, and reading it as text would file the whole blob as a
    // single phrase and speak the first 140 characters of it at the wearer.
    const allLines = text.split(/\r?\n/);
    let firstIdx = 0;
    while (firstIdx < allLines.length) {
        const probe = allLines[firstIdx].trim();
        if (!probe || probe.startsWith('//')) {
            firstIdx += 1;
            continue;
        }
        break;
    }
    const body = allLines.slice(firstIdx).join('\n');

    const trimmed = body.trim();
    // The SAME question the headerless path below asks, and for the same
    // reason: a phrase may legitimately begin with an interpolation token.
    // `{hr} BPM. Hold, don't finish.` is a factory line, the tokens are
    // exactly what the editor tells the wearer to use, and a plain
    // `startsWith('{')` handed that file to JSON.parse and refused the whole
    // import as broken JSON if it happened to be the first phrase.
    if (opensJsonDocument(trimmed)) {
        try {
            const parsed = JSON.parse(trimmed);
            const map = extractCueMap(parsed);
            if (!map) return { cues: {}, error: 'json', encourageSeconds: null };
            const incoming = presentCueMap(map);
            if (Object.keys(incoming).length === 0) return { cues: {}, error: 'json', encourageSeconds: null };
            return {
                cues: incoming,
                error: null,
                encourageSeconds: clampEncourageSeconds(parsed.voiceEncourageSeconds, null)
            };
        } catch (e) {
            return { cues: {}, error: 'json', encourageSeconds: null };
        }
    }

    const buckets = {};
    const preamble = [];
    // `null`, not 'encourage': nothing has been named yet, so nothing may be
    // filed yet either.
    let current = null;
    let sawHeader = false;
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        const headerName = headerNameOf(line);
        if (headerName !== null) {
            // A header we cannot place is told to the user: it must never be
            // filed as a phrase and spoken back at them.
            const id = resolveCueHeaderName(headerName);
            if (!id) return { cues: {}, error: 'header', header: headerName, encourageSeconds: null };
            current = id;
            sawHeader = true;
            continue;
        }
        if (current === null) {
            preamble.push(line);
            continue;
        }
        if (!KNOWN_IDS.has(current)) continue;
        if (!buckets[current]) buckets[current] = [];
        buckets[current].push(line);
    }
    // Text above the first section is held back for the same reason an
    // unplaceable header is: a title, a date or a note is not a phrase, and
    // an imported bank REPLACES the wearer's own, so filing it would silently
    // swap their build-up lines for the file's letterhead and read it aloud
    // every encouragement tick. Refused, naming the line that caused it.
    if (sawHeader && preamble.length > 0) {
        return { cues: {}, error: 'preamble', line: preamble[0], encourageSeconds: null };
    }
    // A file with no sections at all stays the documented shorthand for the
    // build-up bank - unless it is really a JSON export with something in
    // front of it. A line that opens a JSON object is never a phrase, and
    // filing the blob would make it one 140-character phrase to speak aloud.
    // A phrase may legitimately START with a token, though: `{hr} BPM. Hold,
    // don't finish.` is one of the factory lines and the tokens are exactly
    // what the editor tells the wearer to use, so a bare `{token}` opening is
    // a phrase and must not cost them the whole file.
    if (!sawHeader && preamble.length > 0) {
        if (preamble.some(opensJsonDocument)) {
            return { cues: {}, error: 'json', encourageSeconds: null };
        }
        buckets.encourage = preamble;
    }
    const hasAny = Object.values(buckets).some((list) => list.length > 0);
    if (!hasAny) return { cues: {}, error: sawHeader ? 'empty' : 'format' };
    return { cues: buckets, error: null, encourageSeconds: null };
}

export function voiceCuesToText(cues) {
    const merged = mergeVoiceCues(cues);
    const parts = [];
    for (const cue of VOICE_CUE_CATALOG) {
        parts.push(`# ${cue.id}`);
        parts.push(...merged[cue.id]);
        parts.push('');
    }
    return parts.join('\n').trim() + '\n';
}

export function catalogLabel(id) {
    return CATALOG_BY_ID[id]?.label || id;
}
