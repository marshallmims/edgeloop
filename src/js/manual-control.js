// Manual control for a shared session.
//
// The controller names a speed, a stroke window, or a single level. The host
// is the only side that touches hardware, and it clamps every number into the
// wearer's own travel envelope before a toy sees it. A drawn loop and the
// built-in loops are just levels over time. Nothing here talks to a device
// or to the network.

export const DEVICE_KINDS = Object.freeze([
    'heart', 'stroke', 'vibrate', 'rotate', 'oscillate', 'inflate', 'constrict', 'position', 'speed'
]);

export const PATTERN_IDS = Object.freeze(['pulse', 'wave', 'ramp', 'edge', 'climb', 'drawn']);

export const PATTERN_CHOICES = Object.freeze([
    Object.freeze({ id: 'pulse', label: 'Pulse' }),
    Object.freeze({ id: 'wave', label: 'Wave' }),
    Object.freeze({ id: 'ramp', label: 'Ramp' }),
    Object.freeze({ id: 'edge', label: 'Edge' }),
    Object.freeze({ id: 'climb', label: 'Climb' })
]);

// A live slider can go quiet for this long (a packet gap) and the toys hold.
// After that they ease to a stop instead of running on forever. The controller
// repeats a held slider well inside this window, so a finger that stays put
// does not fade. A loop has no slider packets; this is how long it may run
// after the controller goes silent before the host cuts it.
export const MANUAL_HOLD_MS = 400;
export const MANUAL_FADE_MS = 1200;
export const MANUAL_LINK_MS = 1200;

export const MIN_PATTERN_MS = 600;
export const MAX_PATTERN_MS = 8000;
export const DEFAULT_PATTERN_MS = 2000;

export const MAX_DEVICES = 24;
export const MAX_DRAWN_POINTS = 64;
export const MAX_NAME_LENGTH = 48;

const ID_RE = /^[A-Za-z0-9:._-]{1,48}$/;

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

export function clampPct(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(clamp(n, 0, 100));
}

function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, 0, 1);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function controlsForKind(kind) {
    if (kind === 'stroke') return ['speed', 'strokeMin', 'strokeMax'];
    if (kind === 'rotate' || kind === 'speed') return ['speed'];
    if (kind === 'heart') return [];
    return ['level'];
}

export function controlLabel(kind) {
    if (kind === 'stroke') return 'Stroke';
    if (kind === 'rotate') return 'Rotation';
    if (kind === 'speed') return 'Speed';
    if (kind === 'oscillate') return 'Oscillate';
    if (kind === 'inflate') return 'Inflate';
    if (kind === 'constrict') return 'Constrict';
    if (kind === 'position') return 'Position';
    if (kind === 'vibrate') return 'Vibration';
    return 'Level';
}

// Controller stroke 0–100 is a fraction of the wearer's travel envelope,
// never a raw position that can walk past the end stops they already set.
export function mapStrokeIntoEnvelope(strokeMin, strokeMax, envMin = 0, envMax = 100) {
    const lo = clampPct(envMin, 0);
    const hi = Math.max(lo, clampPct(envMax, 100));
    const a = clampPct(strokeMin, 0);
    const b = clampPct(strokeMax, 100);
    const span = hi - lo;
    const min = Math.round(lo + span * (Math.min(a, b) / 100));
    const max = Math.round(lo + span * (Math.max(a, b) / 100));
    return { min, max };
}

export function parseDeviceId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (id === 'handy' || id === 'vacuglide' || id === 'hr' || id === 'intiface' || id === 'tcode') {
        return { family: id };
    }
    if (id.startsWith('intiface:')) {
        const rest = id.slice('intiface:'.length);
        const cut = rest.indexOf(':');
        if (cut < 0) {
            const deviceIndex = Number(rest);
            return Number.isInteger(deviceIndex) ? { family: 'intiface', deviceIndex, axisKey: '' } : null;
        }
        const deviceIndex = Number(rest.slice(0, cut));
        const axisKey = rest.slice(cut + 1);
        if (!Number.isInteger(deviceIndex) || !axisKey) return null;
        return { family: 'intiface', deviceIndex, axisKey };
    }
    if (id.startsWith('tcode:')) {
        const axisId = id.slice('tcode:'.length);
        return axisId ? { family: 'tcode', axisId } : null;
    }
    return null;
}

function cleanName(value, fallback) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    const name = text || fallback;
    return name.slice(0, MAX_NAME_LENGTH);
}

// Host -> controller. Unknown kinds and broken ids are dropped. The list is
// capped so a noisy catalog cannot flood the data channel.
export function sanitizeDeviceCatalog(raw) {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!isPlainObject(item)) continue;
        const parsed = parseDeviceId(item.id);
        if (!parsed || seen.has(item.id)) continue;
        const kind = DEVICE_KINDS.includes(item.kind) ? item.kind : null;
        if (!kind) continue;
        const role = item.role === 'primary' || item.role === 'secondary' ? item.role : 'off';
        seen.add(item.id);
        out.push({
            id: item.id,
            name: cleanName(item.name, item.id),
            connected: Boolean(item.connected),
            role,
            kind
        });
        if (out.length >= MAX_DEVICES) break;
    }
    return out;
}

function sanitizeOutput(raw) {
    if (!isPlainObject(raw) || !parseDeviceId(raw.id)) return null;
    let strokeMin = clampPct(raw.strokeMin, 0);
    let strokeMax = clampPct(raw.strokeMax, 100);
    if (strokeMin > strokeMax) {
        const swap = strokeMin;
        strokeMin = strokeMax;
        strokeMax = swap;
    }
    const output = {
        id: raw.id,
        speed: clampPct(raw.speed, 0),
        strokeMin,
        strokeMax,
        level: clampPct(raw.level, 0)
    };
    // Present only while a finger is placing the toy. Absent means the
    // stroker keeps oscillating its stroke window.
    if (raw.position !== undefined && raw.position !== null && raw.position !== '') {
        output.position = clampPct(raw.position, 0);
    }
    return output;
}

// Keep the two stroke dots ordered. `which` is 'min' or 'max'.
export function orderStroke(min, max, which, value) {
    let lo = clampPct(min, 0);
    let hi = clampPct(max, 100);
    if (lo > hi) [lo, hi] = [hi, lo];
    const next = clampPct(value, which === 'min' ? lo : hi);
    if (which === 'min') lo = Math.min(next, hi);
    else hi = Math.max(next, lo);
    return { strokeMin: lo, strokeMax: hi };
}

function sanitizeOutputs(raw) {
    if (!Array.isArray(raw)) return null;
    const devices = [];
    const seen = new Set();
    for (const item of raw) {
        const output = sanitizeOutput(item);
        if (!output || seen.has(output.id)) continue;
        seen.add(output.id);
        devices.push(output);
        if (devices.length >= MAX_DEVICES) break;
    }
    return devices;
}

export function sanitizeEpoch(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 1e9) return null;
    return n;
}

// A stop bumps the epoch. Anything older than the last accepted epoch is a
// frame that was already in flight and must not restart the toys.
export function acceptEpoch(current, incoming) {
    return Number.isInteger(incoming) && incoming >= current;
}

export function sanitizeManualFrame(raw) {
    if (!isPlainObject(raw) || raw.type !== 'MANUAL_FRAME') return null;
    const epoch = sanitizeEpoch(raw.epoch);
    const devices = sanitizeOutputs(raw.devices);
    if (epoch === null || !devices) return null;
    return {
        type: 'MANUAL_FRAME',
        epoch,
        urgent: raw.urgent === true,
        devices
    };
}

function sanitizeDrawn(raw) {
    if (!Array.isArray(raw)) return null;
    const points = [];
    for (const item of raw) {
        if (!isPlainObject(item)) continue;
        const t = Number(item.t);
        const level = Number(item.level);
        if (!Number.isFinite(t) || !Number.isFinite(level)) continue;
        points.push({ t: clamp(t, 0, 1), level: clamp(level, 0, 1) });
        if (points.length >= MAX_DRAWN_POINTS) break;
    }
    if (points.length < 2) return null;
    points.sort((a, b) => a.t - b.t);
    return points;
}

export function clampPatternPeriod(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PATTERN_MS;
    return Math.round(clamp(n, MIN_PATTERN_MS, MAX_PATTERN_MS));
}

// A finger loop can be a short stroke. The built-in patterns stay on the
// longer floor so a pulse cannot buzz.
const MIN_TRACK_MS = 120;

export function clampTrackPeriod(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PATTERN_MS;
    return Math.round(clamp(n, MIN_TRACK_MS, MAX_PATTERN_MS));
}

export function sanitizeManualPattern(raw) {
    if (!isPlainObject(raw) || raw.type !== 'MANUAL_PATTERN') return null;
    const epoch = sanitizeEpoch(raw.epoch);
    const devices = sanitizeOutputs(raw.devices);
    if (epoch === null || !devices) return null;
    if (!PATTERN_IDS.includes(raw.id)) return null;
    const tracks = raw.id === 'drawn' ? sanitizeTracks(raw.tracks) : null;
    const pattern = {
        type: 'MANUAL_PATTERN',
        epoch,
        id: raw.id,
        periodMs: tracks ? clampTrackPeriod(raw.periodMs) : clampPatternPeriod(raw.periodMs),
        // A refresh says the controller is still there. It must not restart
        // the loop the host is already playing.
        refresh: raw.refresh === true,
        devices
    };
    if (raw.id === 'drawn') {
        const drawn = raw.drawn === undefined ? null : sanitizeDrawn(raw.drawn);
        if (!tracks && !drawn) return null;
        if (drawn) pattern.drawn = drawn;
        if (tracks) pattern.tracks = tracks;
    }
    return pattern;
}

function trackPoint(raw) {
    if (!isPlainObject(raw)) return null;
    const t = Number(raw.t);
    if (!Number.isFinite(t)) return null;
    const point = { t: clamp(t, 0, 1) };
    if (Number.isFinite(Number(raw.position))) point.position = clampPct(raw.position, 0);
    if (Number.isFinite(Number(raw.level))) point.level = clampPct(raw.level, 0);
    if (Number.isFinite(Number(raw.speed))) point.speed = clampPct(raw.speed, 0);
    if (point.position === undefined && point.level === undefined && point.speed === undefined) return null;
    return point;
}

function sanitizeTracks(raw) {
    if (!Array.isArray(raw)) return null;
    const tracks = [];
    const seen = new Set();
    for (const item of raw) {
        if (!isPlainObject(item) || !parseDeviceId(item.id) || seen.has(item.id) || !Array.isArray(item.points)) continue;
        const points = [];
        for (const entry of item.points) {
            const point = trackPoint(entry);
            if (!point) continue;
            points.push(point);
            if (points.length >= MAX_DRAWN_POINTS) break;
        }
        if (points.length < 2) continue;
        points.sort((a, b) => a.t - b.t);
        seen.add(item.id);
        tracks.push({ id: item.id, points });
        if (tracks.length >= MAX_DEVICES) break;
    }
    return tracks.length ? tracks : null;
}

function pointMagnitude(point) {
    if (!point) return null;
    if (Number.isFinite(point.position)) return point.position;
    if (Number.isFinite(point.level)) return point.level;
    if (Number.isFinite(point.speed)) return point.speed;
    return null;
}

function thinPoints(points, max) {
    if (points.length <= max) return points.slice();
    const keep = new Set([0, points.length - 1]);
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = pointMagnitude(points[i - 1]);
        const cur = pointMagnitude(points[i]);
        const next = pointMagnitude(points[i + 1]);
        if (prev === null || cur === null || next === null) continue;
        if ((cur >= prev && cur >= next) || (cur <= prev && cur <= next)) keep.add(i);
    }
    let indexes = [...keep].sort((a, b) => a - b);
    if (indexes.length > max) {
        const picked = [indexes[0]];
        const step = (indexes.length - 1) / (max - 1);
        for (let i = 1; i < max - 1; i += 1) picked.push(indexes[Math.round(i * step)]);
        picked.push(indexes[indexes.length - 1]);
        indexes = [...new Set(picked)].sort((a, b) => a - b);
    }
    return indexes.map((index) => points[index]);
}

// Samples taken while a finger held a dot. `samples` is
// [{ t: milliseconds from the start, devices: [{ id, position|level|speed }] }].
// The time it took becomes the loop length. Each toy gets its own track.
export function loopFromTracks(samples, elapsedMs) {
    if (!Array.isArray(samples) || samples.length < 2) return null;
    const span = Math.max(1, Number(elapsedMs) || 0);
    const byId = new Map();
    for (const sample of samples) {
        if (!isPlainObject(sample) || !Array.isArray(sample.devices)) continue;
        const t = Number(sample.t);
        if (!Number.isFinite(t)) continue;
        for (const device of sample.devices) {
            if (!isPlainObject(device) || !parseDeviceId(device.id)) continue;
            const point = { t };
            if (Number.isFinite(Number(device.position))) point.position = clampPct(device.position, 0);
            if (Number.isFinite(Number(device.level))) point.level = clampPct(device.level, 0);
            if (Number.isFinite(Number(device.speed))) point.speed = clampPct(device.speed, 0);
            if (point.position === undefined && point.level === undefined && point.speed === undefined) continue;
            if (!byId.has(device.id)) byId.set(device.id, []);
            byId.get(device.id).push(point);
        }
    }
    const tracks = [];
    for (const [id, points] of byId) {
        const thinned = thinPoints(points, MAX_DRAWN_POINTS);
        if (thinned.length < 2) continue;
        tracks.push({
            id,
            points: thinned.map((point) => ({ ...point, t: clamp(point.t / span, 0, 1) }))
        });
        if (tracks.length >= MAX_DEVICES) break;
    }
    if (!tracks.length) return null;
    return {
        id: 'drawn',
        periodMs: clampTrackPeriod(elapsedMs),
        tracks
    };
}

export function patternLevel(id, elapsedMs, periodMs = DEFAULT_PATTERN_MS, drawn = null) {
    const period = clampPatternPeriod(periodMs);
    const elapsed = Number(elapsedMs);
    const t = (Number.isFinite(elapsed) && elapsed > 0 ? elapsed % period : 0) / period;
    if (id === 'drawn') return drawnLevel(drawn, t);
    if (id === 'pulse') return t < 0.35 ? 1 : 0;
    if (id === 'wave') return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
    if (id === 'ramp' || id === 'climb') return t;
    if (id === 'edge') {
        const window = 0.62;
        if (t >= window) return 0;
        const frac = ((t / window) * 3) % 1;
        return frac < 0.42 ? 1 : 0.12;
    }
    return 0;
}

function drawnLevel(drawn, t) {
    if (!Array.isArray(drawn) || drawn.length < 2) return 0;
    if (t <= drawn[0].t) return drawn[0].level;
    for (let i = 1; i < drawn.length; i += 1) {
        const b = drawn[i];
        const a = drawn[i - 1];
        if (t <= b.t) {
            const span = b.t - a.t;
            const k = span <= 0 ? 1 : (t - a.t) / span;
            return a.level + (b.level - a.level) * k;
        }
    }
    return drawn[drawn.length - 1].level;
}

export function scaleDevice(device, level) {
    const k = clamp01(level, 0);
    const output = {
        id: device.id,
        speed: Math.round(clampPct(device.speed, 0) * k),
        strokeMin: clampPct(device.strokeMin, 0),
        strokeMax: clampPct(device.strokeMax, 100),
        level: Math.round(clampPct(device.level, 0) * k)
    };
    if (Number.isFinite(Number(device.position))) output.position = clampPct(device.position, 0);
    return output;
}

function interpolateField(points, t, field) {
    let seen = false;
    let last = 0;
    if (t <= points[0].t && Number.isFinite(points[0][field])) return points[0][field];
    for (let i = 1; i < points.length; i += 1) {
        const b = points[i];
        const a = points[i - 1];
        if (!Number.isFinite(a[field]) || !Number.isFinite(b[field])) continue;
        seen = true;
        last = b[field];
        if (t <= b.t) {
            const span = b.t - a.t;
            const k = span <= 0 ? 1 : (t - a.t) / span;
            return Math.round(a[field] + (b[field] - a[field]) * k);
        }
    }
    return seen ? last : null;
}

function frameFromTracks(pattern, elapsedMs) {
    const period = clampTrackPeriod(pattern.periodMs);
    const elapsed = Number(elapsedMs);
    const t = (Number.isFinite(elapsed) && elapsed > 0 ? elapsed % period : 0) / period;
    const byId = new Map(pattern.tracks.map((track) => [track.id, track]));
    return {
        devices: (pattern.devices || []).map((device) => {
            const track = byId.get(device.id);
            const output = scaleDevice(device, 1);
            if (!track) return output;
            const position = interpolateField(track.points, t, 'position');
            const level = interpolateField(track.points, t, 'level');
            const speed = interpolateField(track.points, t, 'speed');
            if (position !== null) output.position = position;
            if (level !== null) output.level = level;
            if (speed !== null) output.speed = speed;
            return output;
        })
    };
}

export function frameFromPattern(pattern, elapsedMs) {
    if (pattern && Array.isArray(pattern.tracks) && pattern.tracks.length) return frameFromTracks(pattern, elapsedMs);
    const level = patternLevel(pattern.id, elapsedMs, pattern.periodMs, pattern.drawn);
    return {
        devices: (pattern.devices || []).map((device) => scaleDevice(device, level))
    };
}

export function decayFrame(frame, ageMs, holdMs = MANUAL_HOLD_MS, fadeMs = MANUAL_FADE_MS) {
    const devices = frame && Array.isArray(frame.devices) ? frame.devices : [];
    const age = Number(ageMs);
    if (!Number.isFinite(age) || age <= holdMs) return { devices };
    const span = fadeMs > 0 ? fadeMs : 1;
    const scale = Math.max(0, 1 - (age - holdMs) / span);
    return {
        devices: devices.map((device) => {
            const scaled = scaleDevice(device, scale);
            delete scaled.position;
            return scaled;
        })
    };
}

// What a finger-up does. Float keeps the dot. Loop keeps a still dot and
// repeats a dot that actually moved. No mode returns it to nothing.
export function touchRelease(mode, moved) {
    if (mode === 'float') return 'hold';
    if (mode === 'loop') return moved ? 'loop' : 'hold';
    return 'spring';
}

export function frameIsStopped(frame) {
    const devices = frame && Array.isArray(frame.devices) ? frame.devices : [];
    return devices.every((device) => {
        if (Number.isFinite(Number(device.position))) return false;
        return clampPct(device.speed, 0) === 0 && clampPct(device.level, 0) === 0;
    });
}

// Toys named in `ownedIds` are the controller's. The rest stay on the pulse.
// `full` means the engine must not touch a toy. `engine` means at least one
// connected toy is still EdgeLoop's.
export function manualSplit(catalog, ownedIds) {
    const owned = ownedIds instanceof Set ? ownedIds : new Set(ownedIds || []);
    const claimed = [];
    const released = [];
    for (const item of catalog || []) {
        if (!item || !item.id || !item.connected || item.kind === 'heart' || item.role === 'off') continue;
        if (owned.has(item.id)) claimed.push(item.id);
        else released.push(item.id);
    }
    return {
        claimed,
        released,
        engine: released.length > 0,
        full: claimed.length > 0 && released.length === 0
    };
}

// Resample a finger-drawn stroke into a loop. x and y are 0–1 across the pad
// (y grows downward, so the top of the pad is full power). The time it took
// to draw becomes the loop length.
export function loopFromGesture(points, elapsedMs) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const cleaned = [];
    for (const point of points) {
        if (!isPlainObject(point)) continue;
        const x = Number(point.x);
        const y = Number(point.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        cleaned.push({ t: clamp(x, 0, 1), level: clamp(1 - y, 0, 1) });
    }
    if (cleaned.length < 2) return null;
    cleaned.sort((a, b) => a.t - b.t);
    const drawn = [];
    const step = Math.max(1, Math.ceil(cleaned.length / MAX_DRAWN_POINTS));
    for (let i = 0; i < cleaned.length; i += step) drawn.push(cleaned[i]);
    const last = cleaned[cleaned.length - 1];
    if (drawn[drawn.length - 1] !== last) drawn.push(last);
    return {
        id: 'drawn',
        periodMs: clampPatternPeriod(elapsedMs),
        drawn
    };
}

export function peaksFromValues(values, floor = 70) {
    return (values || []).map((device) => {
        const speed = clampPct(device.speed, 0);
        const level = clampPct(device.level, 0);
        const kind = device.kind;
        const usesLevel = controlsForKind(kind).includes('level');
        return {
            id: device.id,
            speed: !usesLevel && speed === 0 ? floor : speed,
            strokeMin: clampPct(device.strokeMin, 0),
            strokeMax: clampPct(device.strokeMax, 100),
            level: usesLevel && level === 0 ? floor : level
        };
    });
}
