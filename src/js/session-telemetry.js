// A Dev session log: what the session did, so a later look can tune it.
// Pure. The file it builds is an allowlist. A connection key, a device
// token, a video address, or a script file name cannot ride along, even
// when a caller hands one in.

export const TELEMETRY_VERSION = 1;
export const SERIES_INTERVAL_MS = 1000;
export const MAX_SERIES = 4 * 60 * 60;
export const MAX_EVENTS = 500;

const SETTING_KEYS = Object.freeze([
    'minHr', 'maxHr', 'dualMaxHr',
    'durationMode', 'durationFixedMinutes', 'durationMinMinutes', 'durationMaxMinutes',
    'endgameType', 'gammaCurve', 'warmupMinutes', 'orgasmSettleSeconds',
    'edgeStrokeDepth', 'cadenceBreathing', 'milkingWave',
    'handyHwMin', 'handyHwMax', 'handyEndMargin',
    'stallGuard', 'stallGuardSeconds', 'stallPauseSeconds', 'ceilingBehaviour', 'edgeHoldPercent',
    'trainHoldSeconds', 'trainEdges', 'calibrationPrimaryHr',
    'hrStaleSeconds', 'hrAutoResume',
    'speedSlowest', 'speedFastest',
    'scriptStrokeModel', 'scriptReactBpm', 'scriptFloorPercent', 'scriptApproach',
    'scriptEdgeAction', 'scriptRejoinSeconds', 'scriptMaxSpeed', 'scriptInvert',
    'scriptSecondChannel', 'scriptVideoEnd', 'scriptContinueAfterVideo',
    'vacuglideRole', 'vacuglideMaxCap', 'vacuglideValvePulseMs',
    'adaptiveDecay', 'decayEdgeCount', 'decayBpm', 'decayFloor',
    'voiceEnabled', 'micEnabled', 'micSensitivityThreshold', 'micBoostMaxBpm'
]);

const ROLES = Object.freeze(['primary', 'secondary', 'off']);
const MAC = /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i;

export function isDevTelemetryHost(hostname) {
    return String(hostname || '').toLowerCase() === 'dev.edgeloop.app';
}

function finite(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

function num(value, fallback = 0) {
    const n = Number(value);
    return finite(n) ? n : fallback;
}

function pct(value) {
    return Math.max(0, Math.min(100, Math.round(num(value, 0))));
}

function flag(value) {
    return value ? 1 : 0;
}

function shortText(value, max = 24) {
    const text = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim();
    return text.slice(0, max);
}

// A product name is useful. A Bluetooth address, a long hex token, or a
// URL is not.
export function publicDeviceName(value) {
    const text = shortText(value, 80);
    if (!text) return '';
    if (MAC.test(text)) return '';
    if (/^[0-9a-f]{16,}$/i.test(text)) return '';
    if (/^[a-z]+:\/\//i.test(text)) return '';
    if (text.includes('@')) return '';
    return text;
}

function roleOf(value) {
    const role = String(value || '');
    return ROLES.includes(role) ? role : 'off';
}

function cleanPoint(point) {
    const src = point && typeof point === 'object' ? point : {};
    return {
        t: Math.max(0, Math.round(num(src.t, 0))),
        hr: Math.round(num(src.hr, 0)),
        engineHr: Math.round(num(src.engineHr, 0)),
        mic: Math.round(num(src.mic, 0)),
        speed: pct(src.speed),
        secondary: pct(src.secondary),
        strokeMin: pct(src.strokeMin),
        strokeMax: pct(src.strokeMax),
        edged: flag(src.edged),
        orgasm: flag(src.orgasm),
        stall: flag(src.stall),
        edges: Math.max(0, Math.round(num(src.edges, 0))),
        mode: shortText(src.mode, 24),
        game: shortText(src.game, 24),
        status: shortText(src.status, 16),
        hrSignal: shortText(src.hrSignal, 16)
    };
}

function signature(point) {
    return [point.status, point.mode, point.game, point.edged, point.orgasm, point.stall, point.edges, point.hrSignal].join('|');
}

// One running session. `observe` every sample tick; the series keeps one
// point a second, and an event whenever the session changes shape.
export function createSessionLog({ intervalMs = SERIES_INTERVAL_MS, maxSeries = MAX_SERIES, maxEvents = MAX_EVENTS } = {}) {
    let series = [];
    let events = [];
    let lastAt = -Infinity;
    let lastSig = null;
    const gap = finite(intervalMs) && intervalMs > 0 ? intervalMs : SERIES_INTERVAL_MS;
    const seriesCap = finite(maxSeries) && maxSeries > 0 ? Math.floor(maxSeries) : MAX_SERIES;
    const eventCap = finite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : MAX_EVENTS;

    function pushEvent(event) {
        events.push(event);
        if (events.length > eventCap) events.splice(0, events.length - eventCap);
    }

    return {
        reset() {
            series = [];
            events = [];
            lastAt = -Infinity;
            lastSig = null;
        },
        observe(point) {
            const clean = cleanPoint(point);
            const sig = signature(clean);
            if (sig !== lastSig) {
                pushEvent({
                    t: clean.t,
                    status: clean.status,
                    mode: clean.mode,
                    game: clean.game,
                    edged: clean.edged,
                    orgasm: clean.orgasm,
                    stall: clean.stall,
                    edges: clean.edges,
                    hrSignal: clean.hrSignal
                });
                lastSig = sig;
            }
            if (series.length === 0 || clean.t - lastAt >= gap) {
                series.push(clean);
                if (series.length > seriesCap) series.splice(0, series.length - seriesCap);
                lastAt = clean.t;
            }
        },
        snapshot() {
            return {
                series: series.map((p) => ({ ...p })),
                events: events.map((e) => ({ ...e }))
            };
        }
    };
}

function pickSettings(settings) {
    const src = settings && typeof settings === 'object' ? settings : {};
    const out = {};
    for (const key of SETTING_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        const value = src[key];
        if (typeof value === 'boolean') out[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        else if (typeof value === 'string') out[key] = shortText(value, 32);
        else if (value === null) out[key] = null;
    }
    return out;
}

function cleanSession(session) {
    const src = session && typeof session === 'object' ? session : {};
    return {
        id: Math.round(num(src.id, 0)),
        date: shortText(src.date, 40),
        duration: Math.max(0, Math.round(num(src.duration, 0))),
        edges: Math.max(0, Math.round(num(src.edges, 0))),
        pauses: Math.max(0, Math.round(num(src.pauses, 0))),
        peakHr: Math.round(num(src.peakHr, 0)),
        outcome: shortText(src.outcome, 40),
        intensity: pct(src.intensity),
        targetSeconds: Math.max(0, Math.round(num(src.targetSeconds, 0))),
        videoClock: Boolean(src.videoClock)
    };
}

function cleanScript(script) {
    const src = script && typeof script === 'object' ? script : {};
    const hash = typeof src.hash === 'string' && /^[0-9a-f]{64}$/.test(src.hash) ? src.hash : '';
    const marks = (Array.isArray(src.climaxMarks) ? src.climaxMarks : [])
        .map((m) => Number(m))
        .filter((m) => Number.isFinite(m) && m >= 0)
        .map((m) => Math.round(m))
        .slice(0, 12);
    return {
        loaded: Boolean(src.loaded),
        actions: Math.max(0, Math.round(num(src.actions, 0))),
        durationMs: Math.max(0, Math.round(num(src.durationMs, 0))),
        offsetMs: Math.round(num(src.offsetMs, 0)),
        hash,
        secondary: Boolean(src.secondary),
        secondaryActions: Math.max(0, Math.round(num(src.secondaryActions, 0))),
        secondaryDurationMs: Math.max(0, Math.round(num(src.secondaryDurationMs, 0))),
        climaxMarks: marks,
        videoSeconds: Math.max(0, Math.round(num(src.videoSeconds, 0))),
        strokeModel: shortText(src.strokeModel, 16)
    };
}

function cleanAxis(axis) {
    const src = axis && typeof axis === 'object' ? axis : {};
    return {
        kind: shortText(src.kind || src.type, 24),
        role: roleOf(src.role),
        maxCap: pct(src.maxCap)
    };
}

export function deviceSnapshot(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const handy = src.handy && typeof src.handy === 'object' ? src.handy : {};
    const hr = src.heartRate && typeof src.heartRate === 'object' ? src.heartRate : {};
    const vacu = src.vacuglide && typeof src.vacuglide === 'object' ? src.vacuglide : {};
    const tcode = src.tcode && typeof src.tcode === 'object' ? src.tcode : {};
    const intiface = Array.isArray(src.intiface) ? src.intiface.slice(0, 8) : [];
    return {
        handy: {
            connected: Boolean(handy.connected),
            role: roleOf(handy.role),
            maxCap: pct(handy.maxCap),
            beatSync: Boolean(handy.beatSync),
            firmware: publicDeviceName(handy.firmware).slice(0, 24),
            model: publicDeviceName(handy.model).slice(0, 24)
        },
        heartRate: {
            connected: Boolean(hr.connected),
            simulator: Boolean(hr.simulator),
            name: publicDeviceName(hr.name)
        },
        intiface: intiface.map((dev) => {
            const d = dev && typeof dev === 'object' ? dev : {};
            const axes = Array.isArray(d.axes) ? d.axes.slice(0, 8).map(cleanAxis) : [];
            return { name: publicDeviceName(d.name), axes };
        }),
        vacuglide: {
            connected: Boolean(vacu.connected),
            role: roleOf(vacu.role),
            maxCap: pct(vacu.maxCap)
        },
        tcode: {
            connected: Boolean(tcode.connected),
            name: publicDeviceName(tcode.name),
            axes: (Array.isArray(tcode.axes) ? tcode.axes.slice(0, 12) : []).map((axis) => {
                const a = axis && typeof axis === 'object' ? axis : {};
                return { id: publicDeviceName(a.id).slice(0, 16), role: roleOf(a.role), maxCap: pct(a.maxCap) };
            })
        }
    };
}

function summarize(series) {
    if (!series.length) return { points: 0, hrMin: 0, hrMax: 0, hrMean: 0, edgedSeconds: 0, stallSeconds: 0 };
    let hrMin = Infinity;
    let hrMax = 0;
    let hrSum = 0;
    let hrCount = 0;
    let edged = 0;
    let stall = 0;
    for (const point of series) {
        if (point.hr > 0) {
            hrMin = Math.min(hrMin, point.hr);
            hrMax = Math.max(hrMax, point.hr);
            hrSum += point.hr;
            hrCount += 1;
        }
        if (point.edged) edged += 1;
        if (point.stall) stall += 1;
    }
    return {
        points: series.length,
        hrMin: hrCount ? hrMin : 0,
        hrMax,
        hrMean: hrCount ? Math.round(hrSum / hrCount) : 0,
        edgedSeconds: edged,
        stallSeconds: stall
    };
}

// The downloadable log. Anything not on the allowlist is dropped.
export function buildSessionExport(input = {}) {
    const trace = input.trace && typeof input.trace === 'object' ? input.trace : {};
    const series = (Array.isArray(trace.series) ? trace.series : []).slice(0, MAX_SERIES).map(cleanPoint);
    const events = (Array.isArray(trace.events) ? trace.events : []).slice(0, MAX_EVENTS).map((event) => {
        const clean = cleanPoint(event);
        return {
            t: clean.t,
            status: clean.status,
            mode: clean.mode,
            game: clean.game,
            edged: clean.edged,
            orgasm: clean.orgasm,
            stall: clean.stall,
            edges: clean.edges,
            hrSignal: clean.hrSignal
        };
    });
    return {
        telemetryVersion: TELEMETRY_VERSION,
        appVersion: shortText(input.appVersion, 16),
        note: 'Session log for tuning. No connection keys, tokens, file names, or video addresses.',
        session: cleanSession(input.session),
        summary: summarize(series),
        settings: pickSettings(input.settings),
        devices: deviceSnapshot(input.devices),
        script: cleanScript(input.script),
        series,
        events
    };
}
