// Pure helpers for The Handy over API v3 and HSP (the Handy Streaming
// Protocol): request bodies, reply classification, the server-time
// estimate, the rolling window's plan, chunking, the firmware check and the
// request budget. No fetch, no timers, no DOM: handy-hsp.js does the I/O.
//
// What is known, and from where:
//   * The v3 OpenAPI spec (https://www.handyfeeling.com/api/handy-rest/v3/
//     docs/spec.yaml, "Handy API v3-beta" 3.0.0): every endpoint, body and
//     schema used here.
//   * The live API, probed on 2026-10-08 with this fork's Application ID and
//     a connection key that names no device (no Handy was at hand):
//       - CORS: a preflight from any origin is answered 204 with that origin
//         reflected, credentials allowed, and exactly the requested method
//         and the headers x-api-key, x-connection-key, content-type allowed.
//         Only X-Request-Id is exposed, so the X-RateLimit-* headers are
//         unreadable from a page: the driver counts its own requests.
//       - GET /servertime needs no key and answers {"server_time": <ms>},
//         NOT wrapped in "result".
//       - A device call with no X-Api-Key, or an unknown one, is HTTP 401
//         {"error":{"name":"","message":"Unauthenticated"}}: no code and no
//         `connected` flag. One with no X-Connection-Key is HTTP 400
//         {"name":"Bad request","message":"Missing connection key in
//         request"}: no "error" wrapper at all.
//       - With the Application ID: GET /connected for an unknown key is HTTP
//         200 {"result":{"connected":false}}, and every device call (/info,
//         /hsp/setup, /hsp/add, /hsp/stop, /hsp/flush, /hsp/state,
//         /settings/slider, /slider/stroke, /hamp/stop ...) is HTTP 200
//         {"error":{"code":1001,"name":"DeviceNotConnected","message":
//         "Device not connected","connected":false}}. An error is therefore
//         read from the body, never from the status alone.
//       - GET /sse?ck=&apikey=&events= streams text/event-stream with NAMED
//         events ("event: device_status" then "data: {"connection_key":...,
//         "data":{"connected":false}}"), unlike the spec's examples, which
//         put the type inside the data. An EventSource only hands named
//         events to listeners added for that name.
//   * Not verifiable without a FW4 Handy (spec §8.2): see handy-hsp.js.

import { endMarginWindow } from './handy-protocol.js';

export const HANDY_V3_BASE = 'https://www.handyfeeling.com/api/handy-rest/v3';

// The fork's Application ID, issued for the Handy REST API. Handy documents
// an Application ID as not secret and meant to be embedded in client code
// ("can be embedded directly into your web-pages"); it only reaches the
// non-privileged device endpoints. A fork that hosts its own copy registers
// its own and either edits this line or sets the override.
export const HANDY_APP_ID = 'H~_gYF5D__EbRjG6h8qoRTPBX-uErHfI';

// Where the optional override from the Handy panel is kept. A key of its
// own: the Backup is an allow-list (backup.js), so it never rides along
// unless the Backup is taught to carry it with the device keys.
export const HANDY_APP_ID_STORAGE_KEY = 'handy_app_id';
export const MAX_APP_ID_LENGTH = 128;

// An Application ID as typed: trimmed, URL-safe characters only (the live
// ID uses letters, digits, '_', '-' and '~'), 8-128 long, or null.
export function sanitizeApplicationId(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    if (id.length < 8 || id.length > MAX_APP_ID_LENGTH) return null;
    return /^[A-Za-z0-9._~-]+$/.test(id) ? id : null;
}

// The ID to send: the wearer's override when it is a usable one, else the
// built-in one.
export function resolveApplicationId(override) {
    return sanitizeApplicationId(override) || HANDY_APP_ID;
}

export const HANDY_V3_MODE = Object.freeze({ HAMP: 0, HSSP: 1, HDSP: 2, MAINTENANCE: 3, HSP: 4 });

export const HSP_PLAY_STATE = Object.freeze({
    NOT_INITIALIZED: 0,
    PLAYING: 1,
    STOPPED: 2,
    PAUSED: 3,
    STARVING: 4
});

// The spec's own limits and the driver's numbers (spec §3.2).
export const HSP_MAX_POINTS_PER_ADD = 100;
export const HSP_MIN_BUFFER_POINTS = 50;
export const HSP_WINDOW_BEHIND_MS = 200;
export const HSP_WINDOW_AHEAD_MS = 4000;
export const HSP_LEAD_MIN_MS = 250;
export const HSP_LEAD_MAX_MS = 1000;
export const HSP_LEAD_MARGIN_MS = 100;
export const HSP_HOLD_EVERY_MS = 1000;
// A non-urgent allowance change is sent in steps of this many points.
export const HSP_ALLOWANCE_STEP = 5;
// A drop of at least this many points is urgent.
export const HSP_URGENT_DROP = 15;
export const HSP_SYNC_SAMPLES = 30;
export const HSP_RESYNC_SAMPLES = 10;

function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function clampInt(v, lo, hi) {
    const n = Math.round(v);
    return n < lo ? lo : n > hi ? hi : n;
}

// ---- headers and bodies ------------------------------------------------------

// The headers of every device call: the Application ID and the connection
// key, and a JSON content type when there is a body.
export function v3Headers(appId, key, { json = false } = {}) {
    const headers = { 'X-Api-Key': String(appId || ''), 'X-Connection-Key': String(key || '') };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

// The SSE URL: EventSource cannot set headers, so the key and the ID go in
// the query (the spec's KeyOrTokenQueryParamAuth).
export const HSP_SSE_EVENTS = Object.freeze([
    'device_status',
    'device_connected',
    'device_disconnected',
    'device_error',
    'mode_changed',
    'button_event',
    'slider_blocked',
    'stroke_changed',
    'hsp_starving',
    'hsp_state_changed',
    'low_memory_warning',
    'low_memory_error',
    'temp_high'
]);

export function sseUrl(appId, key, events = HSP_SSE_EVENTS, base = HANDY_V3_BASE) {
    const q = new URLSearchParams({ ck: String(key || ''), apikey: String(appId || ''), events: events.join(',') });
    return `${base}/sse?${q.toString()}`;
}

// A stream id for PUT /hsp/setup: 1..2^32-1.
export function newStreamId(random = Math.random) {
    let r = Number(random());
    if (!finite(r) || r < 0 || r >= 1) r = 0.5;
    return 1 + Math.floor(r * 0xfffffffe);
}

export function modeBody(mode) {
    return { mode };
}

export function setupBody(streamId) {
    return { stream_id: streamId };
}

// Device points as HSP takes them: t whole ms >= 0, x whole 0-100 of the
// stroke window, times strictly increasing (the later of two at the same
// ms wins). `points` are the shaper's { t, x 0-1 }. A move before t 0
// cannot go in the buffer: the plan's points before 0 become one point at
// 0 where the plan is then, rounded toward the next point, so no segment
// that goes out is faster than the plan (the planners start at 0 or later:
// handy-hsp.js planStart).
export function toHspPoints(points) {
    const out = [];
    let before = null;
    for (const p of Array.isArray(points) ? points : []) {
        if (!p || !finite(p.t) || !finite(p.x)) continue;
        if (p.t < 0) {
            if (out.length === 0) before = p;
            continue;
        }
        const t = Math.round(p.t);
        const x = clampInt(p.x * 100, 0, 100);
        if (before) {
            if (t > 0) {
                const at = before.x * 100 + ((p.x - before.x) * 100 * (0 - before.t)) / (p.t - before.t);
                out.push({ t: 0, x: clampInt(x >= at ? Math.ceil(at) : Math.floor(at), 0, 100) });
            }
            before = null;
        }
        const last = out[out.length - 1];
        if (last && t < last.t) continue;
        if (last && t === last.t) {
            out[out.length - 1] = { t, x };
            continue;
        }
        out.push({ t, x });
    }
    if (before) out.push({ t: 0, x: clampInt(before.x * 100, 0, 100) });
    return out;
}

// One PUT /hsp/add body. `tailIndex` is the stream index of the last point
// in it (a monotonic counter over the whole stream).
export function addBody({ points, flush = false, tailIndex }) {
    const body = { points: points.map(({ t, x }) => ({ t, x })), tail_point_stream_index: tailIndex };
    if (flush) body.flush = true;
    return body;
}

// PUT /hsp/play with its embedded add: one request flushes, adds and starts.
// pause_on_starving false keeps the device clock on the video's timeline,
// so a late point is dropped rather than played late.
export function playBody({ startTime, serverTime, add = null, playbackRate = 1, pauseOnStarving = false, loop = false }) {
    const body = {
        start_time: Math.round(startTime),
        server_time: Math.round(serverTime),
        playback_rate: playbackRate,
        pause_on_starving: pauseOnStarving,
        loop
    };
    if (add) body.add = add;
    return body;
}

export function synctimeBody({ currentTime, serverTime, filter = 0.5 }) {
    return { current_time: Math.round(currentTime), server_time: Math.round(serverTime), filter };
}

// PUT /slider/stroke: the envelope with the end margin applied
// (endMarginWindow), as fractions 0-1.
export function strokeWindow(envMin, envMax, endMargin) {
    return endMarginWindow(envMin, envMax, endMargin);
}

export function strokeBody(window) {
    const round = (v) => Math.round(v * 10000) / 10000;
    return { min: round(window.min / 100), max: round(window.max / 100) };
}

// The stroke the device reports ({ min, max } fractions) against ours (%):
// 'same', 'narrower' (the wearer narrowed it with the buttons: kept),
// 'wider' (anything outside ours: ours is sent again), or 'unknown'.
export function compareStroke(reported, ours) {
    if (!reported || !finite(reported.min) || !finite(reported.max) || !ours) return 'unknown';
    const tol = 0.005;
    const lo = ours.min / 100;
    const hi = ours.max / 100;
    if (reported.min < lo - tol || reported.max > hi + tol) return 'wider';
    if (Math.abs(reported.min - lo) <= tol && Math.abs(reported.max - hi) <= tol) return 'same';
    return 'narrower';
}

// ---- replies -------------------------------------------------------------------

// The payload of a v3 reply: `result` when the reply wraps one (every device
// call), else the body itself (GET /servertime).
export function unwrapResult(body) {
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'result')) return body.result;
    return body;
}

function looksLikeHspState(v) {
    return Boolean(v) && typeof v === 'object' && finite(v.play_state);
}

// Classify one exchange. `reply` is { httpOk, status, body } when the API
// answered, { noReply: true, timedOut } when nothing came back. Returns
//   { ok, message, code, state, result, notConnected, unauthenticated,
//     rateLimited, deviceTimeout, noReply }
// where `state` is the HspState in the reply (null when there is none) and
// `notConnected` is the API's word that the device was not reached (its
// error says connected: false), the one failure that is known to have
// moved nothing.
export function classifyHspReply(reply, path = '') {
    const where = path ? ` (${path})` : '';
    const r = reply && typeof reply === 'object' ? reply : {};
    const base = { ok: false, message: '', code: null, state: null, result: null, notConnected: false, unauthenticated: false, rateLimited: false, deviceTimeout: false, noReply: false };
    if (r.noReply) {
        return { ...base, noReply: true, message: `${r.timedOut ? 'Request timed out' : 'Network error'}${where}` };
    }
    const body = r.body && typeof r.body === 'object' ? r.body : null;
    const status = Number(r.status) || 0;
    if (status === 401) return { ...base, unauthenticated: true, code: 401, message: `The Handy API refused EdgeLoop's Application ID (HTTP 401 Unauthenticated)${where}` };
    if (status === 429) return { ...base, rateLimited: true, code: 429, message: `The Handy API's rate limit was reached (HTTP 429)${where}` };
    const err = body && body.error && typeof body.error === 'object' ? body.error : null;
    if (err) {
        const code = finite(Number(err.code)) ? Number(err.code) : null;
        const name = typeof err.name === 'string' ? err.name.replace(/[^a-z]/gi, '').toLowerCase() : '';
        return {
            ...base,
            code,
            message: `${err.message || err.name || `error code ${code ?? '?'}`}${where}`,
            notConnected: err.connected === false,
            deviceTimeout: name === 'devicetimeout' || code === 1002
        };
    }
    if (!r.httpOk) {
        const said = body && typeof body.message === 'string' ? `: ${body.message}` : '';
        return { ...base, code: status || null, message: `HTTP ${status || '?'}${said}${where}` };
    }
    const result = unwrapResult(body);
    return { ...base, ok: true, result, state: looksLikeHspState(result) ? result : null };
}

// A stop the device confirmed: a reply without error whose play state says
// nothing is being played (STOPPED, or no HSP session at all).
export function isHspStopConfirmed(verdict) {
    if (!verdict || !verdict.ok || !verdict.state) return false;
    const s = verdict.state.play_state;
    return s === HSP_PLAY_STATE.STOPPED || s === HSP_PLAY_STATE.NOT_INITIALIZED;
}

// A flush the device confirmed: no error, and a buffer that holds nothing
// it could still play.
export function isHspFlushConfirmed(verdict) {
    if (!verdict || !verdict.ok || !verdict.state) return false;
    return Number(verdict.state.points) === 0 || verdict.state.play_state !== HSP_PLAY_STATE.PLAYING;
}

// ---- firmware, capabilities, slider -------------------------------------------

// Whether GET /info describes a Handy that can play HSP: firmware 4 or
// later, and a firmware status that is not "update required". Returns
// { ok, major, reason } with the wearer-facing reason when it cannot.
export function fwSupportsHsp(info) {
    if (!info || typeof info !== 'object') return { ok: false, major: null, reason: 'The Handy did not say which firmware it runs.' };
    const version = String(info.fw_version ?? info.fwVersion ?? '').trim();
    const m = /^(\d+)(?:\.(\d+))?/.exec(version);
    const major = m ? Number(m[1]) : null;
    if (major === null) return { ok: false, major: null, reason: 'The Handy did not say which firmware it runs.' };
    if (major < 4) return { ok: false, major, reason: `firmware ${version}: update The Handy to firmware 4 at handyverse.com to get beat sync` };
    if (Number(info.fw_status) === 2) return { ok: false, major, reason: `The Handy says a firmware update is required (firmware ${version}); update it at handyverse.com` };
    return { ok: true, major, reason: '' };
}

export function capabilitiesAllowHsp(caps) {
    return Boolean(caps && typeof caps === 'object' && Number(caps.slider) >= 1);
}

// Travel (mm) and top speed (mm/s) from GET /settings/slider, each null when
// the reply does not carry a believable number.
export function sliderLimits(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const start = Number(s.x_limit_start);
    const stop = Number(s.x_limit_stop);
    const travel = finite(start) && finite(stop) ? stop - start : NaN;
    const speed = Number(s.x_max_speed);
    return {
        travelMm: finite(travel) && travel >= 40 && travel <= 250 ? travel : null,
        maxSpeedMmS: finite(speed) && speed >= 50 && speed <= 1000 ? speed : null
    };
}

// ---- server time ----------------------------------------------------------------

// The vendor's estimate, per sample: offset = Ts + RTD/2 - Treceive, where
// Ts is the server's time in the reply and RTD the round trip. Samples are
// { sentAt, receivedAt, serverTime } on one local clock (Date.now()).
// Instead of the plain mean, the median offset of the lowest-RTD half is
// kept: a slow round trip is the one whose midpoint is least certain.
// Returns { offset, rtdMedian, rtdP95, used, samples } or null without a
// usable sample. Server time now ~ Date.now() + offset.
export function estimateServerOffset(samples) {
    const usable = [];
    for (const s of Array.isArray(samples) ? samples : []) {
        if (!s) continue;
        const { sentAt, receivedAt, serverTime } = s;
        if (!finite(sentAt) || !finite(receivedAt) || !finite(serverTime)) continue;
        const rtd = receivedAt - sentAt;
        if (rtd < 0 || rtd > 30000) continue;
        usable.push({ rtd, offset: serverTime + rtd / 2 - receivedAt });
    }
    if (usable.length === 0) return null;
    const byRtd = usable.slice().sort((a, b) => a.rtd - b.rtd);
    const kept = byRtd.slice(0, Math.max(1, Math.ceil(byRtd.length / 2)));
    const offsets = kept.map((s) => s.offset).sort((a, b) => a - b);
    const median = (arr) => (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
    const rtds = byRtd.map((s) => s.rtd);
    const p95 = rtds[Math.min(rtds.length - 1, Math.ceil(rtds.length * 0.95) - 1)];
    return { offset: median(offsets), rtdMedian: median(rtds), rtdP95: p95, used: kept.length, samples: usable.length };
}

// How far ahead a change lands: the round trip's p95 plus a margin, 250 ms
// to 1 s.
export function leadFor(rtdP95) {
    const p = finite(rtdP95) && rtdP95 >= 0 ? rtdP95 : HSP_LEAD_MAX_MS;
    return clampInt(p + HSP_LEAD_MARGIN_MS, HSP_LEAD_MIN_MS, HSP_LEAD_MAX_MS);
}

// ---- the rolling window ---------------------------------------------------------

// Where a plan is at time t (x 0-100, linear between its points), or null
// before its first point; after its last point, the last x (the device
// holds there).
export function planPositionAt(points, t) {
    const list = Array.isArray(points) ? points : [];
    if (list.length === 0 || !finite(t) || t < list[0].t) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const p = list[i];
        if (p.t <= t) {
            const q = list[i + 1];
            if (!q || q.t === p.t) return p.x;
            return p.x + ((q.x - p.x) * (t - p.t)) / (q.t - p.t);
        }
    }
    return null;
}

// The window to send: what the device was last sent up to the splice,
// exactly as it was sent, then the new points.
//   lastPlan  the points last sent ({ t, x } HSP integers), or null
//   from      deviceNow - 200 ms: points before it are history
//   splice    deviceNow + lead: a change lands here, never earlier
//   newPoints the freshly shaped points, HSP integers, for t > splice
// The prefix keeps the last point at or before `from` (the segment the
// device is on) and every point up to the splice, as the same objects'
// numbers; a point at the splice, on the old plan, joins old and new so the
// device never sees a jump. Returns { points, prefix (how many came from
// the last plan, the splice point included), spliceX }.
export function planWindow({ lastPlan = null, from, splice: spliceAt, newPoints = [] }) {
    const old = Array.isArray(lastPlan) ? lastPlan : [];
    const splice = Math.round(spliceAt);
    const prefix = [];
    let before = null;
    for (const p of old) {
        if (p.t <= from) {
            before = p;
            continue;
        }
        if (p.t >= splice) break;
        prefix.push({ t: p.t, x: p.x });
    }
    if (before) prefix.unshift({ t: before.t, x: before.x });
    let spliceX = null;
    if (old.length > 0) {
        const at = planPositionAt(old, splice);
        if (at !== null) {
            spliceX = clampInt(at, 0, 100);
            const exact = old.find((p) => p.t === splice);
            prefix.push({ t: splice, x: exact ? exact.x : spliceX });
            if (exact) spliceX = exact.x;
        }
    }
    const tail = (Array.isArray(newPoints) ? newPoints : []).filter((p) => p.t > splice);
    const points = prefix.concat(tail.map(({ t, x }) => ({ t, x })));
    return { points, prefix: prefix.length, spliceX };
}

// The points of a plan up to `end` (script ms), and none later: the first
// point past it is replaced by the point on its line at `end`, so the
// device moves toward it at the same speed and its buffer runs out at
// `end`. A rejoin's join point can lie a minute ahead at a low speed limit;
// it stays the driver's target, never the device's, so a page that dies
// leaves no more than the window in the buffer. Returns new { t, x } points.
export function clipPlan(points, end) {
    const list = Array.isArray(points) ? points : [];
    const limit = Math.round(end);
    const out = [];
    for (const p of list) {
        if (p.t <= limit) {
            out.push({ t: p.t, x: p.x });
            continue;
        }
        const prev = out[out.length - 1];
        if (prev && prev.t < limit) {
            // Rounded toward the point before it: never faster than the line.
            const x = prev.x + Math.trunc(((p.x - prev.x) * (limit - prev.t)) / (p.t - prev.t));
            out.push({ t: limit, x: clampInt(x, 0, 100) });
        }
        break;
    }
    return out;
}

// Split points into PUT /hsp/add bodies of at most 100 points. Only the
// first carries flush; the tail index counts on from `tailIndex` (the last
// index already used), one per point. Returns { bodies, tailIndex }.
export function chunkPoints(points, { flush = false, tailIndex = 0 } = {}) {
    const bodies = [];
    let index = Number.isSafeInteger(tailIndex) && tailIndex >= 0 ? tailIndex : 0;
    const list = Array.isArray(points) ? points : [];
    for (let i = 0; i < list.length; i += HSP_MAX_POINTS_PER_ADD) {
        const chunk = list.slice(i, i + HSP_MAX_POINTS_PER_ADD);
        index += chunk.length;
        bodies.push(addBody({ points: chunk, flush: flush && i === 0, tailIndex: index }));
    }
    if (bodies.length === 0 && flush) {
        bodies.push(addBody({ points: [], flush: true, tailIndex: Math.max(1, index) }));
    }
    return { bodies, tailIndex: index };
}

// The allowance as the window plans it: urgent changes as they are, others
// in 5-point steps (rounded down: a step never plays more than was allowed).
export function quantizeAllowance(allowance) {
    const a = finite(allowance) ? Math.max(0, Math.min(100, allowance)) : 0;
    if (a === 0) return 0;
    return Math.max(HSP_ALLOWANCE_STEP, Math.floor(a / HSP_ALLOWANCE_STEP) * HSP_ALLOWANCE_STEP);
}

// Whether a change of allowance must not wait for the cadence: to or from
// 0, or a drop of 15 points or more.
export function isUrgentAllowanceChange(previous, next) {
    const a = finite(previous) ? previous : 0;
    const b = finite(next) ? next : 0;
    if ((a === 0) !== (b === 0)) return true;
    return a - b >= HSP_URGENT_DROP;
}

// ---- the request budget ---------------------------------------------------------

// The API's documented limit is 240 a minute and its headers cannot be read
// from a page, so the driver counts. Routine traffic (window refills,
// synctime, state checks) stays under `routine` a minute; urgent replans and
// flushes may use the `reserve` on top of it; a stop is never refused here.
// Pure apart from the timestamps it keeps; `now` is passed in.
export const HSP_BUDGET = Object.freeze({ windowMs: 60000, routine: 150, reserve: 30 });

export function createRequestBudget({ windowMs = HSP_BUDGET.windowMs, routine = HSP_BUDGET.routine, reserve = HSP_BUDGET.reserve } = {}) {
    const sent = [];
    const prune = (now) => {
        while (sent.length > 0 && now - sent[0] >= windowMs) sent.shift();
    };
    return {
        // Whether a request of `kind` ('routine' | 'urgent' | 'stop') may go
        // now, and if so it is counted.
        take(kind, now) {
            prune(now);
            const used = sent.length;
            const ok = kind === 'stop'
                || (kind === 'urgent' && used < routine + reserve)
                || (kind === 'routine' && used < routine);
            if (ok) sent.push(now);
            return ok;
        },
        used(now) {
            prune(now);
            return sent.length;
        },
        remainingRoutine(now) {
            prune(now);
            return Math.max(0, routine - sent.length);
        }
    };
}

// ---- events ----------------------------------------------------------------------

// What one SSE event asks of the driver. `event` is { type, data } with
// `data` the event's own payload (already unwrapped from connection_key);
// `ctx` is { modeSessionId, expectingMode }. Returns
//   { action: 'pause' | 'offline' | 'stroke' | 'starving' | 'log' | 'ignore', reason }
export function classifyHspEvent(event, ctx = {}) {
    const type = event && typeof event.type === 'string' ? event.type : '';
    const data = event && event.data && typeof event.data === 'object' ? event.data : {};
    switch (type) {
        case 'device_disconnected':
            return { action: 'offline', reason: 'The Handy disconnected from the Handy server.' };
        case 'device_status':
        case 'device_connected':
            if (data.connected === false) return { action: 'offline', reason: 'The Handy reports it is no longer connected.' };
            return { action: 'ignore', reason: '' };
        case 'mode_changed': {
            const mode = Number(data.mode);
            const session = data.mode_session_id;
            if (ctx.expectingMode === true) return { action: 'ignore', reason: '' };
            const ours = mode === HANDY_V3_MODE.HSP && (ctx.modeSessionId === undefined || ctx.modeSessionId === null || session === undefined || session === ctx.modeSessionId);
            if (ours) return { action: 'ignore', reason: '' };
            return { action: 'pause', reason: 'Another app took control of The Handy.' };
        }
        case 'button_event':
            return { action: 'pause', reason: "The Handy's button was pressed." };
        case 'slider_blocked':
            return { action: 'pause', reason: 'The Handy reported its slider blocked.' };
        case 'temp_high':
            return { action: 'pause', reason: 'The Handy reports it is running hot.' };
        case 'stroke_changed':
            return { action: 'stroke', reason: '' };
        case 'hsp_starving':
            return { action: 'starving', reason: '' };
        case 'hsp_state_changed':
        case 'low_memory_warning':
        case 'low_memory_error':
        case 'device_error':
            return { action: 'log', reason: type };
        default:
            return { action: 'ignore', reason: '' };
    }
}

// One SSE message as it arrives: its name (the EventSource event type, or
// 'message' for an unnamed one) and its data text. The live API names its
// events and sends { connection_key, data }; the spec's examples send
// { id, type, data: { connection_key, data } } unnamed. Both are read.
// Returns { type, key, data } or null for something unreadable.
export function parseSseMessage(name, text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text));
    } catch (e) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    let type = name && name !== 'message' ? String(name) : '';
    let envelope = parsed;
    if (!type && typeof parsed.type === 'string') {
        type = parsed.type;
        envelope = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    }
    if (!type) return null;
    const key = typeof envelope.connection_key === 'string' ? envelope.connection_key : '';
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
    return { type, key, data };
}

// ---- words -----------------------------------------------------------------------

// The banner's sentence for a stop The Handy never confirmed over HSP: the
// buffer bounds what it can still play.
export function describeHspOwedStop(runsOutSeconds) {
    const n = finite(runsOutSeconds) ? Math.max(0, Math.ceil(runsOutSeconds)) : null;
    const within = n === null ? 'within a few seconds' : n === 0 ? 'now' : `within ${n} s`;
    return `The Handy did not confirm its stop. It runs out of script ${within}; check the device.`;
}

// The route line for the status: beat sync with its accuracy, or rhythm
// with why.
export function describeHandyRoute({ route, rtdP95 = null, reason = '' } = {}) {
    if (route === 'hsp') {
        const pm = finite(rtdP95) ? `, ±${Math.max(10, Math.round(rtdP95 / 2 / 10) * 10)} ms` : '';
        return `Beat sync (HSP)${pm}`;
    }
    const why = reason ? `: ${reason}` : '';
    return `Rhythm only (HAMP)${why}. The Handy follows the script's tempo and depth, not each stroke.`;
}

// Which way one dispatch reaches The Handy (app.js dispatchTheHandy):
//   'hsp'      beat sync owns it and Script mode drives: the HSP driver
//   'release'  beat sync owns it but Script mode no longer drives (or it is
//              being released): a forced stop goes to the HSP driver, the
//              device is handed back to HAMP, and the v2 driver is sent
//              nothing until it has been
//   'rhythm'   Script mode drives a HAMP Handy on the primary channel: the
//              script's rhythm through the v2 driver
//   'level'    everything else, exactly as before there was a player
export function handyScriptRoute({ scriptDrives = false, hspOwns = false, releasing = false, role = 'primary' } = {}) {
    if (hspOwns || releasing) return scriptDrives && !releasing ? 'hsp' : 'release';
    if (scriptDrives && role === 'primary') return 'rhythm';
    return 'level';
}

// The refusals that say beat sync is not possible on this Handy with this
// Application ID (spec §3.9): firmware below 4, no slider, the ID refused.
// The Handy then plays the script's rhythm and the route line says why
// before START. Every other refusal (the link, the clock, a slow cloud, the
// setup) is a failure at START (§3.2): the session does not start, and the
// route is not switched silently.
export const HSP_NOT_POSSIBLE_CODES = Object.freeze(['firmware', 'capabilities', 'auth']);

export function hspNotPossible(code) {
    return HSP_NOT_POSSIBLE_CODES.includes(code);
}

// The route line while beat sync is wanted but its last check failed for a
// reason that may pass: START checks again, and does not start without it.
export function describeBeatSyncCheckFailed(reason = '') {
    const why = typeof reason === 'string' && reason.trim() ? reason.trim() : 'it could not be checked';
    return `Beat sync could not be checked (${why}). START checks again and does not start without it; switch Beat sync off to play the script in rhythm mode.`;
}

// The banner line for a START or RESUME refused because beat sync could not
// be set up (handy-hsp.js prepare). The route is never switched behind the
// wearer's back: the line says what to do to get rhythm mode instead. When
// START itself found beat sync not possible, the route line now says rhythm
// mode, and the next press plays it.
export function describeHspStartRefusal(refusal, resuming = false) {
    const what = resuming ? 'resumed' : 'started';
    const press = resuming ? 'RESUME' : 'START';
    const reason = refusal && typeof refusal.reason === 'string' && refusal.reason.trim() ? refusal.reason.trim() : 'it could not be set up';
    if (refusal && hspNotPossible(refusal.code)) {
        return `The session was not ${what}: The Handy cannot beat sync (${reason}). It plays the script in rhythm mode: press ${press} again.`;
    }
    return `The session was not ${what}: beat sync on The Handy could not start (${reason}). Switch Beat sync off to play the script in rhythm mode, or press ${press} again.`;
}

// ---- crash recovery -------------------------------------------------------------

// What a crash stop to a Handy that the dead session drove over HSP came to.
// Both stops are sent: v3 PUT /hsp/stop with the Application ID, and v2 PUT
// /hamp/stop as for every other Handy. `hsp` is classifyHspReply's verdict
// on the first, `hamp` classifyRecoveryStop's outcome on the second
// ({ outcome, detail }, handy-protocol.js). The v2 answer "not in HAMP
// mode" (2002), conclusive for a HAMP session, is not for this one: the
// device was in HSP mode. Returns { outcome, detail } in RECOVERY_STOP's
// terms: 'stopped' when the HSP stop was confirmed (or the device answered
// that HAMP had stopped), 'offline' when the API says the device is not
// connected, else 'failed'. A confirmed HSP stop carries no detail: only a
// HAMP StateResult of 0 says the device was moving until then.
export function classifyHspRecoveryStop({ hsp = null, hamp = null } = {}) {
    if (hsp && isHspStopConfirmed(hsp)) return { outcome: 'stopped', detail: '' };
    if (hamp && (hamp.outcome === 'stopped' || hamp.outcome === 'already-stopped')) return { outcome: hamp.outcome, detail: hamp.detail || '' };
    if ((hsp && hsp.notConnected) || (hamp && hamp.outcome === 'offline')) {
        return { outcome: 'offline', detail: (hsp && hsp.message) || (hamp && hamp.detail) || 'Device not connected' };
    }
    const said = [hsp && hsp.message, hamp && hamp.detail].filter(Boolean).join('; ');
    return { outcome: 'failed', detail: said || 'the stop was not confirmed' };
}
