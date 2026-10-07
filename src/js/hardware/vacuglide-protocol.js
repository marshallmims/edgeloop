// Pure helpers for the Autoblow VacuGlide 2 cloud API (HTTP API V1,
// developers.autoblow.com/reference/http-api-v1-vacuglide). No fetch, no
// DOM, no timers, so everything here runs under node:test. vacuglide.js does
// the I/O.
//
// What the device is decides what EdgeLoop may do with it. The VacuGlide is
// a pneumatic stroker behind Autoblow's cloud, and its whole control surface
// is a motor speed (0-100 %), a stop, and two valves - stroke plus and
// stroke minus - that are either open or closed. There is no stroke range
// and no suction level to set. The valves move where the receiver sits on
// the shaft by how LONG they are held open, and nothing reads back where it
// ended up. Owners were explicit that an app must never move them by itself:
// an automatic change can pop the receiver off, and the point where that
// happens shifts with the speed and with the gear fitted. So EdgeLoop drives
// the speed and nothing else, and the valves are two buttons that open one
// valve for a short, fixed pulse.

// The router Autoblow recommends for the one call that finds the device:
// GET /vacuglide/connected answers on any host, and names the cluster the
// device is connected to. Every other request must go to that cluster.
export const VACUGLIDE_DISCOVERY_BASE = 'https://latency.autoblowapi.com';

export const VACUGLIDE_PATHS = Object.freeze({
    connected: '/vacuglide/connected',
    info: '/vacuglide/info',
    // The full device state, read without changing anything. Measured
    // against the live API: a token whose device is not online on that
    // cluster gets the same 502 DeviceNotConnectedError a command does.
    state: '/vacuglide/state',
    targetSpeed: '/vacuglide/target-speed',
    stop: '/vacuglide/target-speed/stop'
});

// The two valves, by the names Autoblow's API gives them. `plus` lengthens
// the stroke and `minus` shortens it; owners describe the same thing as
// moving the receiver up or down the shaft.
export const VACUGLIDE_VALVES = Object.freeze({
    plus: '/vacuglide/valve/stroke-plus',
    minus: '/vacuglide/valve/stroke-minus'
});
export const VALVE_NAMES = Object.freeze(['plus', 'minus']);

// The error code the API sends, with HTTP 502, for a device that is not in
// online mode on the cluster that was asked. Measured against the live API:
// every device command for a token whose device is not online answers
// exactly this, and so does a device that has moved to another cluster.
export const DEVICE_NOT_CONNECTED = 'DeviceNotConnectedError';

// ---- the device token ---------------------------------------------------------

// The token is a bearer credential: whoever has the string drives that
// VacuGlide from anywhere, and nothing Autoblow publishes says it can be
// revoked. It is held to the rule the Handy connection key is held to
// (backup.sanitizeConnectionKey): printable ASCII, at most 128 characters,
// because it travels as an HTTP header (x-device-token) and a newline in a
// header value is not a token by any reading. Every token in Autoblow's
// examples is twelve lowercase letters and digits, but nothing documents
// that as the format, so a longer or mixed-case one is not refused.
export const MAX_DEVICE_TOKEN_LENGTH = 128;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// The token's own localStorage entry. It never lives inside the settings
// blob, so a backup carries it only when the user asks for it at export
// time - the rule the Handy connection key has.
export const VACUGLIDE_TOKEN_STORAGE_KEY = 'vacuglide_device_token';

// A token or null. Null means "no usable token"; a caller must then leave
// whatever is saved alone rather than store an empty string.
export function sanitizeDeviceToken(value) {
    if (typeof value !== 'string') return null;
    const token = value.trim();
    if (!token || token.length > MAX_DEVICE_TOKEN_LENGTH) return null;
    if (!PRINTABLE_ASCII.test(token)) return null;
    return token;
}

// ---- the cluster ----------------------------------------------------------------

// Autoblow's reference shows the cluster as a bare host
// ("eu-central-1.autoblowapi.com"), and earlier replies carried a full URL;
// both are accepted. Anything that is not an HTTPS host under
// autoblowapi.com is refused, because every request after this one carries
// the device token to that host: a reply that could name another domain
// would hand the token to whoever answers there. The latency router is
// refused as well - it forwards each request to whichever cluster is
// nearest the browser, which is not necessarily the one the device is on.
const CLUSTER_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.autoblowapi\.com$/;
const DISCOVERY_HOST = new URL(VACUGLIDE_DISCOVERY_BASE).hostname;

export function normalizeCluster(raw) {
    if (typeof raw !== 'string') return null;
    let text = raw.trim().toLowerCase();
    if (!text || text.length > 255) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
    let url;
    try {
        url = new URL(text);
    } catch (e) {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.port) return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    if (!CLUSTER_HOST.test(url.hostname) || url.hostname === DISCOVERY_HOST) return null;
    return `https://${url.hostname}`;
}

// What GET /vacuglide/connected said: { connected, cluster, deviceType }.
// `cluster` is null unless the device is connected AND the reply named a
// cluster this module accepts; `badCluster` says the device is connected
// but the cluster it was given is not one a token may be sent to.
export function parseConnectedReply(body) {
    const out = { connected: false, cluster: null, deviceType: null, badCluster: false };
    if (!body || typeof body !== 'object') return out;
    out.connected = body.connected === true;
    out.deviceType = typeof body.deviceType === 'string' && body.deviceType.trim() ? body.deviceType.trim() : null;
    if (out.connected) {
        out.cluster = normalizeCluster(body.cluster);
        out.badCluster = out.cluster === null;
    }
    return out;
}

// ---- replies ----------------------------------------------------------------------

// Classify one API reply. `body` is the parsed JSON, or null when the body
// was not JSON. Returns { ok, message, code, notConnected, rateLimited,
// ambiguous }:
//   - notConnected: the API said DeviceNotConnectedError. The device never
//     received the command.
//   - rateLimited: HTTP 429, the token's request limit. Not applied either.
//   - ambiguous: a 5xx that is not DeviceNotConnectedError. The cloud may
//     have passed the command on before it failed, so the device's state is
//     unknown rather than unchanged.
// Anything else that is not a 2xx - a 400 FST_ERR_VALIDATION among them -
// was refused before it reached the device.
export function classifyVacuglideResponse(httpOk, status, body, path = '') {
    const where = path ? ` (${path})` : '';
    const n = Number(status);
    const rateLimited = n === 429;
    let message = '';
    let code = null;
    if (body && typeof body === 'object' && body.error) {
        const err = body.error;
        if (typeof err === 'object' && err !== null) {
            code = typeof err.code === 'string' || typeof err.code === 'number' ? err.code : null;
            message = typeof err.message === 'string' && err.message ? err.message : (code !== null ? `error ${code}` : 'error');
        } else {
            message = String(err);
        }
    }
    const notConnected = code === DEVICE_NOT_CONNECTED;
    if (!message && httpOk) return { ok: true, message: '', code: null, notConnected: false, rateLimited: false, ambiguous: false };
    if (!message) message = rateLimited ? 'Too many requests for this device token' : `HTTP ${n || '?'}`;
    const ambiguous = !notConnected && !rateLimited && n >= 500;
    return { ok: false, message: `${message}${where}`, code: code ?? (n || null), notConnected, rateLimited, ambiguous };
}

// ---- the device state ---------------------------------------------------------------

// Every command answers with the full device state. Only the fields this
// driver reads are kept, and a field of the wrong type reads as unknown
// (null) rather than as a guess.
export function parseVacuglideState(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const mode = typeof body.operationalMode === 'string' && body.operationalMode ? body.operationalMode : null;
    const speed = Number(body.targetSpeed);
    return {
        operationalMode: mode,
        targetSpeed: typeof body.targetSpeed === 'number' && Number.isFinite(speed) ? speed : null,
        strokePlusValve: typeof body.strokePlusValve === 'boolean' ? body.strokePlusValve : null,
        strokeMinusValve: typeof body.strokeMinusValve === 'boolean' ? body.strokeMinusValve : null
    };
}

// The modes in which the motor is running something.
const PLAYING_MODES = new Set(['TARGET_SPEED_PLAYING', 'LOCAL_SCRIPT_PLAYING', 'SYNC_SCRIPT_PLAYING']);

export function isPlayingMode(mode) {
    return PLAYING_MODES.has(mode);
}

// Is the motor running a target speed - the only thing EdgeLoop ever starts
// it with? A stopped device answers TARGET_SPEED_PAUSED and keeps the last
// speed as its targetSpeed, so the mode is what says it runs; a target speed
// of 0 asks nothing of the motor. One the reply left out, or sent as
// something that is not a number, is not taken as 0: running is what the
// mode says.
export function motorRunningIn(state) {
    if (!state || state.operationalMode !== 'TARGET_SPEED_PLAYING') return false;
    return state.targetSpeed === null || state.targetSpeed > 0;
}

// The modes in which the device cannot be driven: a fault it stopped its
// motor for, or a state it is still getting into. Each gets a sentence the
// wearer can act on; any other mode, known or not, gets null.
export function describeUnusableMode(mode) {
    switch (mode) {
        case 'ERROR_MOTOR_STUCK':
            return 'The VacuGlide stopped its motor because it is stuck.';
        case 'ERROR_MOTOR_OVERRUN':
            return 'The VacuGlide stopped its motor after running for 4 hours without a pause.';
        case 'ERROR':
            return 'The VacuGlide reports an error.';
        case 'FIRMWARE_UPDATING':
            return 'The VacuGlide is installing a firmware update.';
        case 'SETUP':
        case 'LOADING_SETUP':
            return 'The VacuGlide is in Wi-Fi setup mode.';
        case 'LOADING_INTERACTIVE':
            return "The VacuGlide is still joining Wi-Fi and Autoblow's server.";
        default:
            return null;
    }
}

// Did a 2xx reply to PUT /target-speed/stop confirm a stopped motor? The
// reply is the state after the command, so a state that still names a
// playing mode is not a stop, whatever the status code said. A reply with
// no readable mode has only the status code to go on, and that is the
// API's confirmation.
export function stopConfirmedBy(state) {
    if (!state || !state.operationalMode) return true;
    return !isPlayingMode(state.operationalMode);
}

// Did a 2xx reply to closing `valve` confirm that valve closed? Same rule:
// a state that still reports it open is not a close.
export function valveClosedBy(state, valve) {
    if (!state) return true;
    const flag = valve === 'plus' ? state.strokePlusValve : state.strokeMinusValve;
    return flag !== true;
}

// The valves a state reports open, by name. Only a plain `true` counts: a
// missing or unreadable field says nothing either way, and treating it as
// open would send closes on every reply from a device that leaves it out.
export function valvesOpenIn(state) {
    if (!state) return [];
    return VALVE_NAMES.filter((valve) => (valve === 'plus' ? state.strokePlusValve : state.strokeMinusValve) === true);
}

// ---- speed, role and cap -----------------------------------------------------------

export function clampTargetSpeed(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

export const VACUGLIDE_ROLES = Object.freeze(['primary', 'secondary', 'off']);
export const VACUGLIDE_DEFAULT_ROLE = 'primary';

// A role this build does not know is OFF, not the factory `primary`: a
// damaged store or a hand-edited backup must not hand the wearer a live
// channel they did not choose. Only a real role drives the motor.
export function sanitizeVacuglideRole(value) {
    return VACUGLIDE_ROLES.includes(value) ? value : 'off';
}

// The speed cap is the same control as the Handy's: a slider of min 10,
// max 100, step 5, so those are the only values the app itself writes. A
// value off that grid is snapped DOWN onto it - of the two neighbours, the
// slower one. Anything unreadable becomes the floor, not the factory 100:
// inventing a cap would be inventing the permissive one.
export const SPEED_CAP_MIN = 10;
export const SPEED_CAP_STEP = 5;

export function clampSpeedCap(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return SPEED_CAP_MIN;
    const n = Number(value);
    if (!Number.isFinite(n)) return SPEED_CAP_MIN;
    const bounded = Math.max(SPEED_CAP_MIN, Math.min(100, n));
    return Math.floor(bounded / SPEED_CAP_STEP) * SPEED_CAP_STEP;
}

// The slowest target speed EdgeLoop sends. Autoblow's reference takes any
// whole percent from 0 to 100 and says nothing about the bottom of the
// range, so 1 is the smallest number that still asks the motor to run; the
// driver answers 0 with the whole stop, never with a target speed of 0.
export const VACUGLIDE_MIN_SPEED = 1;

// The target speed for the channel this device holds, under its cap. The
// VacuGlide takes one speed and nothing else: the stroke range and the other
// channel have nowhere to go on it, so they are not arguments here.
//
// 0 is a decision and never a rounding result. The driver answers 0 with the
// whole stop - the motor stop and both valve closes, three requests from the
// token's budget - and the next moving tick with a target speed, so under a
// cap below 50% the engine's 1% crawl (0.4 at a 40% cap) went out as a stop
// and a start every time it crawled. A speed the engine wants moving leaves
// here at VACUGLIDE_MIN_SPEED or more, and never above the cap the wearer set
// (the cap is 10% at least); only a speed of 0, the role Off, or a speed
// that is not a number give 0.
export function vacuglideSpeedFor(role, primarySpeed, secondarySpeed, maxCap) {
    const r = sanitizeVacuglideRole(role);
    if (r === 'off') return 0;
    const raw = Number(r === 'primary' ? primarySpeed : secondarySpeed);
    // Doubt - NaN, Infinity, a negative - ends in a stop.
    if (!Number.isFinite(raw) || !(raw > 0)) return 0;
    const scaled = Math.min(100, raw) * (clampSpeedCap(maxCap) / 100);
    return Math.max(VACUGLIDE_MIN_SPEED, clampTargetSpeed(scaled));
}

// ---- the valve pulse ---------------------------------------------------------------

// One press opens one valve for this long, then closes it. The default is
// the owners' own number ("a quick 1 second hold is enough adjustment").
// The floor is the shortest open a hands-on client found still registers
// (autogoon keeps a 300 ms minimum so a tap does something), and the
// ceiling is twice the default: enough for a user whose gear needs more,
// while one press can never become a long open - a long open is how a
// receiver ends up popped off.
export const VALVE_PULSE_DEFAULT_MS = 1000;
export const VALVE_PULSE_MIN_MS = 300;
export const VALVE_PULSE_MAX_MS = 2000;
export const VALVE_PULSE_STEP_MS = 100;

export function clampValvePulseMs(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return VALVE_PULSE_DEFAULT_MS;
    const n = Number(value);
    if (!Number.isFinite(n)) return VALVE_PULSE_DEFAULT_MS;
    const stepped = Math.round(n / VALVE_PULSE_STEP_MS) * VALVE_PULSE_STEP_MS;
    return Math.max(VALVE_PULSE_MIN_MS, Math.min(VALVE_PULSE_MAX_MS, stepped));
}

// The panel shows seconds; the store keeps milliseconds.
export function pulseSecondsToMs(value) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return clampValvePulseMs(value);
    const n = Number(value);
    return clampValvePulseMs(Number.isFinite(n) ? n * 1000 : NaN);
}

export function formatPulseSeconds(ms) {
    return (clampValvePulseMs(ms) / 1000).toFixed(1);
}

// ---- the request budget -------------------------------------------------------------

// Autoblow's reference says only that requests are limited per device token
// and that a 429 means "wait before retrying". Measured against the live
// API: 160 requests per 60-second window, counted per token on each cluster,
// with the latency router forwarding to a cluster and counting there too,
// so a discovery call can spend the very budget the device's commands use.
// The x-ratelimit-* headers that say how much is left are not exposed to a
// browser (no Access-Control-Expose-Headers), so this page cannot read them
// and has to count for itself.
//
// So every request sent for a token is counted here, across all hosts, over
// a window 6 s longer than the server's (a request can reach the server up
// to its timeout after it was sent), and:
//   - a STOP or a valve close ("critical") may use anything up to the
//     ceiling, which sits 10 below the measured 160 for requests this page
//     cannot see - Autoblow's own app on the same token, say;
//   - routine traffic ("normal": speed, polls, discovery, info) stops RESERVE
//     short of that ceiling, so a burst of it can never leave a stop without
//     a slot;
//   - opening a valve is routine traffic with a cap of its own, so presses
//     cannot eat the budget the speed updates need. Its close is critical;
//   - a read of the device's state that the watch for a command that may
//     land late makes ("watch") is a safety read: a read that cannot be
//     made raises the alarm, and the alarm pauses the session. Routine
//     traffic of its own - leaving out these reads, and the stops and valve
//     closes, which have the ceiling - stops WATCH_RESERVE short of where
//     these may go, so routine traffic can never leave the watch without a
//     slot; and they stop RESERVE short of the ceiling, like all routine
//     traffic, so they never take a slot a stop is kept.
// A counted window guarantees what a counter that resets on a guessed
// boundary cannot: whatever the server's window boundaries are, no 60-second
// stretch of it holds more requests than this window allowed.
//
// What the reserve pays for. A whole stop is three requests - the motor stop
// and both valve closes - and the driver sends one again, at once, whenever a
// reply or a read shows the device moving after a stop (vacuglide.js). The
// 20 requests only a stop or a valve close may spend are 6 whole stops in any
// 66 s - five and a half a minute - however much routine traffic went out in
// it, and up to 50 when none did; a part of a stop the cloud does not answer
// is tried again, and each retry spends one of them too. More than that in
// one window means the device keeps moving whatever EdgeLoop sends, or its
// stops are not getting through: a stop request that then has to wait for a
// slot is still sent the moment one frees - never dropped - and the driver
// raises the "may still be running" alarm the moment it has to wait.
//
// What the watch's share pays for. The watch reads the device once per 2 s
// beat (vacuglide.js), so 33 reads fit in a window, and a read sent through
// a cluster the device has left is made again through the link that reaches
// it: 34. Routine traffic keeps the 96 under that: a speed a second, a
// valve open for every one the cap allows, and 10 for link checks, the
// router and /info. Neither a watch read nor a stop or valve close counts
// against that share, so neither the reads a watch makes during a session
// nor the closes of the wearer's presses hold a speed back: a session with
// a press every few seconds sent 68 of 80 speeds, with a 13 s gap, when the
// presses' closes were counted in it. All of it together still stops at
// the line RESERVE short of the ceiling, and only a stop or a close goes
// past that; with the watch reading, a speed a second and every press the
// cap allows, that line is what can still refuse a watch read, and the
// alarm then goes up (vacuglide.js).
//
// The server's window does not end when this page does. A page that is
// reloaded, or the same token opened again in a new tab, would start
// counting from nothing while Autoblow still holds everything the last page
// sent in the same minute - and a page that believes it has the whole
// budget spends it, until a STOP is refused for rate while the motor runs.
// So the log is kept in localStorage as well (see the store below), and
// every page counts what earlier pages and other tabs sent for that token.
export const RATE_WINDOW_MS = 66000;
export const RATE_CEILING = 150;
export const RATE_RESERVE = 20;
export const RATE_WATCH_RESERVE = 34;
export const MAX_VALVE_OPENS_PER_WINDOW = 20;

// The stored log is named after a hash of the token, never the token
// itself: the token is a bearer credential with an entry of its own, and a
// second copy of it here would be one nobody knows to delete or keep out of
// a backup. Two tokens that happen to share a hash share a log, which can
// only make a page count more than it sent.
export const RATE_LOG_STORAGE_PREFIX = 'vacuglide_rate_log_';

export function rateLogStorageKey(token) {
    // FNV-1a, 32 bits.
    let hash = 0x811c9dc5;
    const text = String(token);
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${RATE_LOG_STORAGE_PREFIX}${hash.toString(16).padStart(8, '0')}`;
}

// A damaged store can never hold more than this many entries in memory.
// Every page stops at the ceiling, so a real log never comes near it.
const MAX_RATE_LOG_ENTRIES = 1000;
const MAX_PAGE_ID_LENGTH = 40;

// Read a stored log for the page named `page`: the requests OTHER pages
// recorded ({ t, page, open }, oldest first; this page's own are already in
// its memory) and the routine hold after a 429. Nothing in the store is
// trusted. An entry that is not a finite time is dropped, one older than
// the window no longer counts, and one in the future - a clock that went
// back since it was written - counts as sent just now: a request cannot
// have been sent later than now, and reading it as recent is the side that
// can only hold traffic back, never let too much through. The hold is
// capped at one window for the same reason.
export function decodeRateLog(raw, { now, windowMs = RATE_WINDOW_MS, page = '' } = {}) {
    const out = { entries: [], blockedUntil: 0 };
    if (typeof raw !== 'string' || !raw) return out;
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return out;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.e)) return out;
    for (const item of data.e) {
        if (!Array.isArray(item)) continue;
        const [t, from, open] = item;
        if (typeof t !== 'number' || !Number.isFinite(t)) continue;
        const who = typeof from === 'string' ? from.slice(0, MAX_PAGE_ID_LENGTH) : '';
        if (page && who === page) continue;
        if (t <= now - windowMs) continue;
        out.entries.push({ t: Math.min(t, now), page: who, open: open === 1, watch: open === 2, critical: open === 3 });
    }
    out.entries.sort((a, b) => a.t - b.t);
    if (out.entries.length > MAX_RATE_LOG_ENTRIES) out.entries = out.entries.slice(-MAX_RATE_LOG_ENTRIES);
    if (typeof data.b === 'number' && Number.isFinite(data.b) && data.b > now) {
        out.blockedUntil = Math.min(data.b, now + windowMs);
    }
    return out;
}

// The string to store for a log, or null when nothing in it still counts
// (the caller then removes the entry rather than keep an empty one).
// The third field says what a request was: 1 a valve open, 2 a watch read,
// 3 a stop or a valve close, 0 anything else. A page from before these were
// told apart reads a 2 or a 3 as routine traffic, which can only make it
// count more.
const entryClass = (e) => (e.open ? 1 : e.watch ? 2 : e.critical ? 3 : 0);

export function encodeRateLog({ own = [], others = [], page = '', blockedUntil = 0, now, windowMs = RATE_WINDOW_MS } = {}) {
    const entries = [];
    for (const e of own) if (e.t > now - windowMs) entries.push([e.t, page, entryClass(e)]);
    for (const e of others) if (e.t > now - windowMs) entries.push([e.t, e.page, entryClass(e)]);
    entries.sort((a, b) => a[0] - b[0]);
    const hold = blockedUntil > now ? blockedUntil : 0;
    if (!entries.length && !hold) return null;
    const log = { e: entries.slice(-MAX_RATE_LOG_ENTRIES) };
    if (hold) log.b = hold;
    return JSON.stringify(log);
}

// `now` is always passed in, so the budget runs on any clock a test likes.
// `store` is where the log outlives the page - { load() -> string | null,
// save(string | null) }, null removing the entry - and `page` names this
// page's own entries in it, so a page never counts its own requests twice.
// The store is read before every decision and written after every request,
// so another tab's requests count as soon as it has made them. Without a
// store, or with one that fails, the log lives in this page's memory only.
export function createRateBudget({
    windowMs = RATE_WINDOW_MS,
    ceiling = RATE_CEILING,
    reserve = RATE_RESERVE,
    watchReserve = RATE_WATCH_RESERVE,
    maxOpens = MAX_VALVE_OPENS_PER_WINDOW,
    store = null,
    page = ''
} = {}) {
    // This page's own requests, oldest first: { t, open, watch, critical }.
    let own = [];
    // What other pages recorded for the same token, as last read.
    let others = [];
    let serverBlockedUntil = 0;
    let othersBlockedUntil = 0;
    const read = (now) => {
        if (!store) return;
        let raw = null;
        try { raw = store.load(); } catch (e) { raw = null; }
        const log = decodeRateLog(raw, { now, windowMs, page });
        others = log.entries;
        othersBlockedUntil = log.blockedUntil;
        // Nothing in the stored log counts any more, this page's own entries
        // included: remove it rather than leave it behind.
        const ownCounts = own.some((e) => e.t > now - windowMs) || serverBlockedUntil > now;
        if (raw && !others.length && !othersBlockedUntil && !ownCounts) {
            try { store.save(null); } catch (e) {}
        }
    };
    const write = (now) => {
        if (!store) return;
        // Read again first, so the newest entries of another tab are kept.
        read(now);
        const text = encodeRateLog({ own, others, page, blockedUntil: Math.max(serverBlockedUntil, othersBlockedUntil), now, windowMs });
        try { store.save(text); } catch (e) {}
    };
    const prune = (now) => {
        // A clock that went back leaves entries in the future; they count
        // as sent just now, like the stored ones.
        own = own.filter((e) => e.t > now - windowMs).map((e) => (e.t > now ? { ...e, t: now } : e));
    };
    // The times of the requests `keep` picks, oldest first.
    const times = (keep = () => true) => {
        const list = [];
        for (const e of own) if (keep(e)) list.push(e.t);
        for (const e of others) if (keep(e)) list.push(e.t);
        return list.sort((a, b) => a - b);
    };
    // How long until `list` holds fewer than `limit` entries. 0 = now.
    const waitBelow = (list, limit, now) => {
        if (limit <= 0) return windowMs;
        if (list.length < limit) return 0;
        const oldest = list[list.length - limit];
        return Math.max(1, oldest + windowMs - now);
    };
    return {
        // Milliseconds until a request of `kind` ('critical' | 'watch' |
        // 'normal' | 'open') may be sent. 0 means now.
        waitMs(kind, now) {
            read(now);
            prune(now);
            const sent = times();
            if (kind === 'critical') return waitBelow(sent, ceiling, now);
            // Nothing but a stop or a valve close goes past this.
            let wait = waitBelow(sent, ceiling - reserve, now);
            // Routine traffic leaves the watch its share as well.
            if (kind !== 'watch') wait = Math.max(wait, waitBelow(times((e) => !e.watch && !e.critical), ceiling - reserve - watchReserve, now));
            const blockedUntil = Math.max(serverBlockedUntil, othersBlockedUntil);
            if (blockedUntil > now) wait = Math.max(wait, blockedUntil - now);
            if (kind === 'open') wait = Math.max(wait, waitBelow(times((e) => e.open), maxOpens, now));
            return wait;
        },
        record(kind, now) {
            prune(now);
            own.push({ t: now, open: kind === 'open', watch: kind === 'watch', critical: kind === 'critical' });
            write(now);
        },
        // The server refused a request for rate. Routine traffic waits; a
        // stop keeps its own retry schedule, because a stop that waits for
        // a quiet minute is a stop that did not happen.
        noteServerRefusal(now, ms) {
            serverBlockedUntil = Math.max(serverBlockedUntil, now + Math.max(0, ms));
            write(now);
        },
        count(now) {
            read(now);
            prune(now);
            return own.length + others.length;
        }
    };
}

// ---- the page after this one ----------------------------------------------------------

// A page that goes away - a reload, a closed tab, a frozen tab the browser
// then discards - sends the whole stop with keepalive and never reads the
// answer. A speed or a valve open it had sent may still be out, and
// Autoblow's cloud can apply one after that stop, with no page left to see
// it: a speed the cloud held back 13 s landed after a reload's unload stop
// and ran until the test ended, 90 s later, while the new page showed the
// VacuGlide as disconnected and never read it. So a page that goes away
// leaves, under this key, every device it cannot vouch for, and one page
// takes each of them over (vacuglide.js): the next EdgeLoop page to load,
// the same page when it comes back from being frozen or from the
// back-forward cache, or a page that connects that very device - before its
// new link sends the device anything. A page that was already open does not:
// one that took a reloaded tab's device over could not tell when the wearer
// drove it again from the reloaded tab, and sent the whole stop into that
// session on every read for a minute, and its alarm went up in a tab the
// wearer was not looking at while the page they were using said Offline.
// The partner viewer and controller pages never take one: they drive
// nothing.
//
// The page that drives a device answers for it. A page that answers for one
// it does not drive - it took it over, or let go of it with a command still
// out - keeps its entry here too, marked held, for as long as it does: a
// page that loads leaves a held entry alone, but a page that connects the
// device, or comes back with it connected, takes it like any other, and the
// page that held it stops watching and stopping the device as soon as it
// finds its entry gone. Without that, a page that had taken a reloaded tab's
// device over sent the whole stop into the session the wearer then ran on it
// from an older tab, 18 times in a minute, and spent the token's budget until
// a valve press there was refused for rate. A page that is connecting the
// device holds one too, marked connecting, for as long as its connect runs:
// it says a page is taking the device over to drive it, which the page that
// held it before lets go for, and it is what another page that connects the
// same device at the same moment takes from it. One entry per device:
//   token      the device token. It is not where the token is kept - that is
//              its own entry, and it is the one a backup may carry. This is
//              the only way a page can stop a device another page drove,
//              since the token saved for the Connect field may by then be
//              another device's. It is written only for a device in doubt,
//              and goes once no page is in doubt about it any more; no
//              backup reads it;
//   cluster    where the device was last reached;
//   page       the page that left it, so a page that comes back (it was only
//              frozen, or kept for the back button) takes its own back - or,
//              for a held entry, the page that holds it;
//   held       that page is open and answers for the device (see above);
//   connecting that page holds it while it connects the device (see above);
//              only a held entry can be one;
//   at         when it was left;
//   speedUntil until when a speed that page sent may still land, 0 for none;
//   openUntil  the same for a valve open;
//   stopUntil  for a device that may have been running, or had a valve open,
//              when the page went - with nobody left to hear its stop land -
//              until when the whole stop is sent to it until one is
//              confirmed; 0 for a device that was not in doubt;
//   alarm      that page had already raised the alarm for it.
// A time that has passed is kept, not dropped. The device has no watchdog,
// so a speed that landed while no page was open to see it runs until
// something stops it, however long ago its window closed: an entry is a
// debt the next page pays - its last read of the device, or its stop - not
// a watch that lapses with its window. It goes when a page takes it over;
// a held entry, when its page is done with the device, or when a page that
// drives the device takes it.
export const VACUGLIDE_HANDOVER_STORAGE_KEY = 'vacuglide_handover';

// A damaged store can hold no more than this many entries in memory. A page
// drives one VacuGlide at a time and lets go of few.
const MAX_HANDOVER_ENTRIES = 16;

// A stored time, or 0 for none. Nothing stored is trusted: anything but a
// positive finite number is none, and one reaching further than `horizon` -
// a clock that went back since it was written, or a damaged store - is cut
// to it, so it can make a page watch longer, never forever.
function storedTime(value, horizon) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, horizon) : 0;
}

// Read what earlier pages left. An entry whose token or cluster this module
// would refuse at the Connect field is dropped; its times are read by
// storedTime(), `maxAheadMs` from now being the furthest ahead one may
// reach; and an entry with nothing in it to pay - no window and no stop - is
// dropped. A window that has run out is not nothing: it owes a last read.
export function decodeHandover(raw, { now, maxAheadMs } = {}) {
    if (typeof raw !== 'string' || !raw) return [];
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return [];
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) return [];
    const horizon = now + Math.max(0, Number(maxAheadMs) || 0);
    const out = [];
    for (const item of data.entries.slice(0, MAX_HANDOVER_ENTRIES)) {
        if (!item || typeof item !== 'object') continue;
        const token = sanitizeDeviceToken(item.token);
        const cluster = normalizeCluster(item.cluster);
        if (!token || !cluster) continue;
        const entry = {
            token,
            cluster,
            page: typeof item.page === 'string' ? item.page.slice(0, MAX_PAGE_ID_LENGTH) : '',
            at: typeof item.at === 'number' && Number.isFinite(item.at) ? Math.min(item.at, now) : 0,
            speedUntil: storedTime(item.speedUntil, horizon),
            openUntil: storedTime(item.openUntil, horizon),
            stopUntil: storedTime(item.stopUntil, horizon),
            alarm: item.alarm === true,
            held: item.held === true,
            connecting: item.held === true && item.connecting === true
        };
        if (!entry.speedUntil && !entry.openUntil && !entry.stopUntil) continue;
        out.push(entry);
    }
    return out;
}

// The string to store, or null when there is nothing to leave (the caller
// then removes the entry rather than keep an empty one).
export function encodeHandover(entries) {
    const list = (Array.isArray(entries) ? entries : []).slice(0, MAX_HANDOVER_ENTRIES).map((e) => ({
        token: e.token,
        cluster: e.cluster,
        page: e.page,
        at: e.at,
        speedUntil: e.speedUntil || 0,
        openUntil: e.openUntil || 0,
        stopUntil: e.stopUntil || 0,
        alarm: e.alarm === true,
        held: e.held === true,
        connecting: e.held === true && e.connecting === true
    }));
    return list.length ? JSON.stringify({ entries: list }) : null;
}

// Several pages can leave the same device - a page reloaded twice, a page
// and a tab closed after it, a page that holds it and one that left it. What
// a page takes over is one entry per device: every window at its widest, the
// alarm if any page had raised it, the cluster the newest of them reached it
// through, held only when every one of them came from a page that is still
// open, and connecting only when every one of them came from a page that is
// connecting the device.
export function mergeHandoverByDevice(entries) {
    const byToken = new Map();
    for (const e of Array.isArray(entries) ? entries : []) {
        const seen = byToken.get(e.token);
        if (!seen) {
            byToken.set(e.token, { ...e, held: e.held === true, connecting: e.held === true && e.connecting === true });
            continue;
        }
        if (e.at > seen.at) {
            seen.cluster = e.cluster;
            seen.at = e.at;
        }
        seen.speedUntil = Math.max(seen.speedUntil, e.speedUntil);
        seen.openUntil = Math.max(seen.openUntil, e.openUntil);
        seen.stopUntil = Math.max(seen.stopUntil, e.stopUntil);
        seen.alarm = seen.alarm || e.alarm;
        seen.held = seen.held && e.held === true;
        seen.connecting = seen.connecting && e.held === true && e.connecting === true;
    }
    return [...byToken.values()];
}

// How long ago something happened, for a sentence: "moments ago", "a minute
// ago", "3 hours ago", "2 days ago". A page can take over what another left
// long before - an entry does not lapse - and the panel says when that was,
// so a wearer who switched the device off since knows what it is about.
export function describeAgo(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    if (seconds < 60) return 'moments ago';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}

// The sentence for a routine request the budget held back.
export function describeRateWait(ms) {
    const seconds = Math.max(1, Math.ceil(Number(ms) / 1000) || 1);
    return `Too many commands to the VacuGlide in the last minute: Autoblow allows each device token about 160 a minute, and EdgeLoop keeps part of that free for STOP. Try again in ${seconds} s.`;
}

// ---- /info ---------------------------------------------------------------------------

// The status-line suffix: firmware, and the firmware status when it asks
// for something. The API reports no battery level.
export function describeVacuglideInfo(info) {
    if (!info || typeof info !== 'object') return '';
    const parts = [];
    const fw = info.firmwareVersion;
    if ((typeof fw === 'number' && Number.isFinite(fw)) || (typeof fw === 'string' && fw.trim())) {
        parts.push(`fw ${String(fw).trim()}`);
    }
    if (info.firmwareStatus === 'UPDATE_AVAILABLE') parts.push('update available');
    else if (info.firmwareStatus === 'UPDATE_REQUIRED') parts.push('Autoblow says an update is required');
    return parts.join(', ');
}

// The device type /connected or /info named, when it is not a VacuGlide.
// Null when it is one, or when the reply did not say.
export function foreignDeviceType(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.trim() === 'vacuglide' ? null : value.trim();
}

export function describeForeignDevice(type) {
    const names = { 'autoblow-ultra': 'an Autoblow AI Ultra', vacupump: 'a VacuPump' };
    const name = names[type] || `a "${String(type).slice(0, 40)}"`;
    return `This token belongs to ${name}, not a VacuGlide. EdgeLoop drives the VacuGlide only.`;
}
