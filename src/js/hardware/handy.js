// The Handy Wi-Fi driver (REST API v2, HAMP mode).
//
// Design rules, in priority order:
//   1. Fail safe: any doubt about the device state ends in a verified stop.
//      A stop is retried with backoff until the API confirms it; a device
//      that went offline keeps being sent stops in the background until one
//      is confirmed; a start that may have reached the device after a stop
//      is followed by another stop; the key the start was issued with is the
//      key that stop uses, so Disconnect or a reconnect can never orphan a
//      moving device.
//   2. Never exceed the user's hardware envelope; the stroke range sent to
//      PUT /slide is always normalised through handy-protocol.js, then inset
//      from the mechanical ends by the end-stop margin (a subset of the
//      normalised range, so the envelope still bounds it), and the range is
//      confirmed by the API before the motor is started.
//   3. Stay under the API rate limit: velocity is throttled to one call per
//      400 ms and the slide range to one call per second unless it changed.
//
// All fetch calls go through handyRequest(), which classifies the reply and
// reports failures through the error handler installed by app.js.

import { HANDY_V3_BASE, resolveApplicationId, v3Headers } from './handy-hsp-protocol.js';
import {
    HANDY_API_BASE,
    HANDY_MODE,
    HANDY_DEFAULT_END_MARGIN,
    applyEndMargin,
    classifyHandyDevice,
    classifyHandyResponse,
    clampVelocity,
    describeDeviceStop,
    describeSlideAdjustment,
    endMarginWindow,
    followPosition,
    firmwareMajor,
    hdspBody,
    hdspMove,
    hdspTimingFor,
    hdspEstimatedPosition,
    isHampModeError,
    normalizeSlideRange,
    describeHandyInfo
} from './handy-protocol.js';

export let handyConnected = false;

const VELOCITY_THROTTLE_MS = 400;
const STROKE_THROTTLE_MS = 1000;
const OFFLINE_POLL_MS = 10000;
const OFFLINE_POLL_FAILURES = 3;
// Consecutive dispatch TICKS (not requests: one tick may send /slide and
// /hamp/velocity together) that must fail before the device is offline.
const OFFLINE_DISPATCH_FAILURES = 5;
// How many background stop rounds an offline device gets before giving up
// (60 rounds at the default 5 s spacing: five minutes).
const OFFLINE_STOP_MAX_ROUNDS = 60;

// Mutable so tests can shorten the waits.
export const HANDY_TIMINGS = {
    requestTimeoutMs: 6000,
    // PUT /hamp/stop backoff between the four attempts of one verified stop.
    stopRetryDelaysMs: [250, 500, 1000],
    // Pause between rounds of the background stop sent to an offline device.
    offlineStopRetryMs: 5000,
    // How soon the next finger position may go out. A background host tab
    // clamps timers to about a second, so the stream is driven by the
    // controller's messages. This is only the gap between those sends.
    hdspIntervalMs: 70
};

let handyKey = '';
let handyInfo = null;
let handyProfile = null;
let handyTiming = null;
let handyIsHampRunning = false;
// 'hamp' oscillates a stroke window. 'hdsp' moves to a position (Loop).
let handyDrive = 'hamp';
let hdspPending = null;
let hdspTimer = null;
let hdspBusy = false;
let hdspLastSend = 0;
let hdspLastCommandAt = 0;
let hdspLastPosition = -1;
// The move that is in flight. The next duration is timed from where this
// says the carriage is, not from the target it has not reached yet.
let hdspLeg = null;
let hdspSlide = { min: -1, max: -1 };
let hdspSettled = false;
let hdspFailed = false;
let hdspGapMs = 70;
let handyMotionError = '';
const handyTrace = [];
let handyStartInFlight = false;
// True while the driver cannot tell whether the device is moving (a start
// timed out on our side but may still have reached the device): the next
// zero-speed dispatch then sends a verified stop instead of nothing.
let handyMotionUnknown = false;
// True while a reconnect has stopped the old device and is about to swap
// keys: engine ticks must not restart the old device in that window.
let handySwitching = false;
// The in-flight verified stop for the CURRENT device: { key, generation,
// promise }. Only reused by a caller that asks for the same key with no
// command issued in between; a stop for an old key never masks a new one.
let stopInFlight = null;
let handyLastSend = 0;
let handyLastStrokeSend = 0;
let handyLastStrokeSent = { min: -1, max: -1 };
let handyLastVelocitySent = -1;
let handyPendingVelocity = 0;
// One notice per connection each: the device's own HAMP error band, and a
// PUT /slide the device rounded to numbers of its own.
let hampFaultNotified = false;
let slideAdjustNotified = false;

// Every start/stop bumps this. A start promise that resolves after a later
// command sees a different generation and must not touch the running flag.
let commandGeneration = 0;
// Bumped by every start so a stale start's cleanup cannot clear the
// in-flight flag of a newer start.
let startSequence = 0;

// Dispatch ticks are numbered so the offline counter advances once per
// failed tick, however many requests that tick issued.
let dispatchSequence = 0;
let lastFailedDispatch = -1;
let consecutiveDispatchFailures = 0;
let consecutivePollFailures = 0;
let offlinePollTimer = null;
// The background stop job for a device that went offline: { key, timer,
// rounds, active }. Cancelled by Connect and Disconnect.
let offlineStop = null;
// The last error shown to the user: { path, message }. Only a success on
// the SAME path clears it, so a /connected poll or a slide reply cannot
// hide a velocity call that keeps failing.
let lastReportedError = null;

const handlers = {
    onError: null,
    onOffline: null,
    onStopUnconfirmed: null,
    onNotice: null,
    isSessionActive: null
};

// app.js installs UI callbacks here:
//   onError(message | null)     -> non-null: show the API error; null: the failing call succeeded again
//   onOffline(reason)           -> the device stopped answering; motors must be treated as stopped
//   onStopUnconfirmed(message)  -> a stop the device may have needed was never confirmed by the API
//   onNotice(message)           -> the device said something worth reading; not an error, not a fault
//   isSessionActive()           -> true while a session is RUNNING or RAMPDOWN
export function setHandyHandlers({ onError, onOffline, onStopUnconfirmed, onNotice, isSessionActive } = {}) {
    if (onError !== undefined) handlers.onError = onError;
    if (onOffline !== undefined) handlers.onOffline = onOffline;
    if (onStopUnconfirmed !== undefined) handlers.onStopUnconfirmed = onStopUnconfirmed;
    if (onNotice !== undefined) handlers.onNotice = onNotice;
    if (isSessionActive !== undefined) handlers.isSessionActive = isSessionActive;
}

export function getHandyKey() {
    return handyKey;
}

export function getHandyInfo() {
    return handyInfo;
}

export function getHandyProfile() {
    return handyProfile;
}

function rememberHandyMove(move, error = '') {
    const row = {
        t: Date.now(),
        drive: 'hdsp',
        position: move.position,
        duration: move.duration,
        stop: move.stopOnTarget ? 1 : 0,
        error: error ? String(error).slice(0, 32) : ''
    };
    handyTrace.push(row);
    if (handyTrace.length > 48) handyTrace.splice(0, handyTrace.length - 48);
    return row;
}

function handyFaultLabel(err) {
    const code = err && err.code;
    if (typeof code === 'number' && Number.isFinite(code)) return `hdsp ${code}`;
    if (code === 'timeout' || (err && err.name === 'AbortError')) return 'timeout';
    return 'hdsp failed';
}

// The last position command and the recent ones. No connection key.
export function getHandyMotion() {
    const last = handyTrace.length ? handyTrace[handyTrace.length - 1] : null;
    return {
        drive: handyDrive,
        position: last ? last.position : -1,
        duration: last ? last.duration : 0,
        stop: last ? last.stop : 0,
        error: handyMotionError
    };
}

export function getHandyTrace() {
    return handyTrace.map((item) => ({ ...item }));
}

export function isHandyMoving() {
    return handyIsHampRunning || handyDrive === 'hdsp';
}

// True while the driver cannot vouch for the device being stopped.
export function isHandyMotionUnknown() {
    return handyMotionUnknown;
}

// Every "once per connection" latch, cleared when the link changes.
function resetDeviceNotices() {
    hampFaultNotified = false;
    slideAdjustNotified = false;
    hdspFailed = false;
    hdspGapMs = HANDY_TIMINGS.hdspIntervalMs;
}

function clearHdspQueue() {
    hdspPending = null;
    hdspBusy = false;
    hdspSettled = false;
    hdspLastPosition = -1;
    hdspLeg = null;
    if (hdspTimer) {
        clearTimeout(hdspTimer);
        hdspTimer = null;
    }
}

function useHandyV3() {
    return firmwareMajor(handyInfo) >= 4;
}

async function handyV3Get(path, key) {
    const res = await fetch(`${HANDY_V3_BASE}${path}`, {
        method: 'GET',
        headers: v3Headers(resolveApplicationId(), key, { json: false })
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    const verdict = classifyHandyResponse(res.ok, res.status, data, path);
    if (!verdict.ok) return null;
    return data && data.result && typeof data.result === 'object' ? data.result : data;
}

async function readHandyProfile(key, info) {
    let next = info;
    let capabilities = null;
    let slider = null;
    if (firmwareMajor(info) >= 4) {
        const fresh = await handyV3Get('/info', key).catch(() => null);
        if (fresh) next = { ...info, ...fresh };
        capabilities = await handyV3Get('/capabilities', key).catch(() => null);
        slider = await handyV3Get('/settings/slider', key).catch(() => null);
    }
    return { info: next, profile: classifyHandyDevice({ info: next, capabilities, slider }) };
}

async function handyV3(path, body, key = handyKey) {
    const res = await fetch(`${HANDY_V3_BASE}${path}`, {
        method: 'PUT',
        headers: v3Headers(resolveApplicationId(), key, { json: true }),
        body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    const verdict = classifyHandyResponse(res.ok, res.status, data, path);
    if (!verdict.ok) {
        const err = new Error(verdict.message);
        err.code = verdict.code;
        throw err;
    }
    return data;
}

async function putHandyMode(mode, key = handyKey) {
    if (useHandyV3()) return handyV3('/mode', { mode }, key);
    return handyRequest('/mode', { method: 'PUT', body: { mode }, key });
}

function callHandler(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function reportError(path, message) {
    lastReportedError = { path, message };
    callHandler('onError', message);
}

function reportRecovered(path) {
    if (lastReportedError === null || lastReportedError.path !== path) return;
    lastReportedError = null;
    callHandler('onError', null);
}

function reportStopUnconfirmed(path, error) {
    const message = `Stop not confirmed: ${error && error.message ? error.message : 'unknown error'}`;
    reportError(path, message);
    callHandler('onStopUnconfirmed', message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function unref(timer) {
    // Never keep a node:test process alive; a no-op in browsers.
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

// One API call. Resolves with the parsed body on success, throws an Error with
// a human-readable message on any failure (network, HTTP status, error object,
// result -1). A timeout or network error is flagged `ambiguous`: the request
// may still have reached the device. Tracks the consecutive-failure counter
// that drives offline detection while connected.
async function handyRequest(path, { method = 'GET', body = undefined, key = handyKey, countFailure = true } = {}) {
    if (!key) throw new Error('No Handy connection key');
    const headers = { 'X-Connection-Key': key };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const tick = dispatchSequence;
    let abortTimer = null;
    if (typeof AbortController === 'function') {
        const controller = new AbortController();
        init.signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), HANDY_TIMINGS.requestTimeoutMs);
    }

    let res;
    let data = null;
    try {
        res = await fetch(`${HANDY_API_BASE}${path}`, init);
        try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
        const msg = (e && e.name === 'AbortError') ? `Request timed out (${path})` : `Network error (${path})`;
        noteFailure(path, msg, countFailure, tick);
        const err = new Error(msg);
        err.ambiguous = true;
        if (e && e.name === 'AbortError') err.code = 'timeout';
        throw err;
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    const verdict = classifyHandyResponse(res.ok, res.status, data, path);
    if (!verdict.ok) {
        noteFailure(path, verdict.message, countFailure, tick);
        // Every call the driver makes is one the session asked for, so a HAMP
        // refusal of it is worth explaining to the wearer.
        noteHampFault(verdict.code);
        const err = new Error(verdict.message);
        err.code = verdict.code;
        throw err;
    }
    if (countFailure) consecutiveDispatchFailures = 0;
    reportRecovered(path);
    return data;
}

function noteFailure(path, message, countFailure, tick) {
    reportError(path, message);
    if (!countFailure) return;
    // One failed tick counts once, however many of its requests failed.
    if (tick === lastFailedDispatch) return;
    lastFailedDispatch = tick;
    consecutiveDispatchFailures += 1;
    if (handyConnected && consecutiveDispatchFailures >= OFFLINE_DISPATCH_FAILURES) {
        markOffline(`The Handy stopped responding (${consecutiveDispatchFailures} failed commands).`);
    }
}

// API v2 has exactly one HAMP error code, ERROR(3000) "Unspecified HAMP
// error", so a slider the firmware has locked out arrives - if it arrives at
// all - as that and nothing else. We cannot claim which fault it was, only
// say what the device does and what the wearer can change. Once per
// connection: a device that keeps refusing would otherwise repeat it every
// tick, and the failure itself is already on the status line.
function noteHampFault(code) {
    if (!isHampModeError(code) || hampFaultNotified) return;
    hampFaultNotified = true;
    callHandler('onNotice', describeDeviceStop(`The Handy refused a motion command (HAMP error ${code}).`));
}

// The retry loop behind every verified stop: PUT /hamp/stop for `key`, up
// to four attempts with backoff. Pure I/O, touches no driver state, never
// throws. Resolves { ok, error }.
async function attemptStop(key, { countFailure = true, fromHdsp = false } = {}) {
    const delays = HANDY_TIMINGS.stopRetryDelaysMs;
    let lastErr = null;
    // HAMP stop is refused while the device is in HDSP. Put it back first.
    if (fromHdsp) {
        try {
            await putHandyMode(HANDY_MODE.HAMP, key);
        } catch (e) {
            lastErr = e;
        }
    }
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            await handyRequest('/hamp/stop', { method: 'PUT', key, countFailure });
            return { ok: true, error: null };
        } catch (e) {
            lastErr = e;
            if (attempt < delays.length) await sleep(delays[attempt]);
        }
    }
    return { ok: false, error: lastErr };
}

// Verified stop for a device this driver no longer owns (the key of a
// disconnected, replaced or stale link). Reports when it is never confirmed.
async function stopForeignDevice(key, fromHdsp = false) {
    const result = await attemptStop(key, { fromHdsp });
    if (!result.ok) reportStopUnconfirmed('/hamp/stop', result.error);
    return result.ok;
}

// Drop the connection from our side and tell app.js. Motors are assumed to be
// in an unknown state, so the UI path pauses the session and the device
// keeps receiving stops in the background until one is confirmed.
function markOffline(reason) {
    if (!handyConnected) return;
    const key = handyKey;
    const fromHdsp = handyDrive === 'hdsp';
    handyConnected = false;
    handyIsHampRunning = false;
    handyDrive = 'hamp';
    clearHdspQueue();
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    stopOfflinePolling();
    if (key) beginOfflineStop(key, fromHdsp);
    callHandler('onOffline', reason);
}

// Keep sending PUT /hamp/stop to an offline device (one verified-stop round
// per HANDY_TIMINGS.offlineStopRetryMs) until the API confirms one, the job
// is cancelled by Connect / Disconnect, or the round cap is reached. A device
// that was merely slow, or comes back after a Wi-Fi blip, is brought to rest
// by this even though the app already gave up on it.
function beginOfflineStop(key, fromHdsp = false) {
    cancelOfflineStop();
    const job = { key, timer: null, rounds: 0, active: true, fromHdsp };
    offlineStop = job;
    const round = async () => {
        if (!job.active) return;
        job.rounds += 1;
        const result = await attemptStop(key, { countFailure: false, fromHdsp: job.fromHdsp && job.rounds === 1 });
        if (!job.active) return;
        if (result.ok || job.rounds >= OFFLINE_STOP_MAX_ROUNDS) {
            job.active = false;
            if (offlineStop === job) offlineStop = null;
            return;
        }
        if (job.rounds === 1) reportStopUnconfirmed('/hamp/stop', result.error);
        job.timer = unref(setTimeout(round, HANDY_TIMINGS.offlineStopRetryMs));
    };
    round();
}

function cancelOfflineStop() {
    if (!offlineStop) return;
    offlineStop.active = false;
    if (offlineStop.timer) clearTimeout(offlineStop.timer);
    offlineStop = null;
}

// True while a background stop for an offline device is still unconfirmed.
export function isHandyOfflineStopPending() {
    return Boolean(offlineStop && offlineStop.active);
}

function startOfflinePolling() {
    stopOfflinePolling();
    consecutivePollFailures = 0;
    offlinePollTimer = unref(setInterval(pollHandyConnected, OFFLINE_POLL_MS));
}

function stopOfflinePolling() {
    if (offlinePollTimer !== null) {
        clearInterval(offlinePollTimer);
        offlinePollTimer = null;
    }
    consecutivePollFailures = 0;
}

// One offline-check tick. Exported so the timer logic stays testable.
export async function pollHandyConnected() {
    if (!handyConnected) { stopOfflinePolling(); return; }
    const active = typeof handlers.isSessionActive === 'function' ? Boolean(handlers.isSessionActive()) : false;
    if (!active) { consecutivePollFailures = 0; return; }
    try {
        const data = await handyRequest('/connected', { countFailure: false });
        if (!data || data.connected !== true) {
            markOffline('The Handy reports it is no longer connected to Wi-Fi.');
            return;
        }
        consecutivePollFailures = 0;
    } catch (e) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= OFFLINE_POLL_FAILURES) {
            markOffline('The Handy API is unreachable.');
        }
    }
}

// Verify a key without touching the live state: the device must be online,
// switch to HAMP mode and accept a stop. Resolves the /info body (null when
// unavailable); throws a descriptive Error on any failure.
async function verifyKey(key) {
    const conn = await handyRequest('/connected', { key, countFailure: false });
    if (!conn || conn.connected !== true) {
        throw new Error('The Handy is offline. Check its Wi-Fi status on the device.');
    }

    const mode = await handyRequest('/mode', { method: 'PUT', body: { mode: HANDY_MODE.HAMP }, key, countFailure: false });
    if (!mode || typeof mode.result !== 'number' || mode.result < 0) {
        throw new Error('Could not switch The Handy into HAMP mode.');
    }

    await handyRequest('/hamp/stop', { method: 'PUT', key, countFailure: false });

    try {
        return await handyRequest('/info', { key, countFailure: false });
    } catch (e) {
        return null;
    }
}

// Connect: verify the new key first (online, HAMP mode, stopped, info), and
// only then replace the current link. A live device is brought to a
// confirmed stop before its key is dropped; if that stop is never confirmed
// the current link is left exactly as it was and the error says so, so
// STOP keeps reaching the device that is moving. Resolves with { info,
// profile, description }; throws a descriptive Error on any failure.
export async function connectHandy(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) throw new Error('Connection key is empty');

    // Nothing below touches the live link until the new key has passed.
    const info = await verifyKey(trimmed);

    if (handyConnected && handyKey) {
        const oldKey = handyKey;
        const oldMayMove = handyIsHampRunning || handyStartInFlight || handyMotionUnknown || handyDrive === 'hdsp';
        if (oldMayMove) {
            // Freeze the engine's motion commands to the old device while it
            // is stopped; zero-speed dispatches still go through.
            handySwitching = true;
            let confirmed = false;
            try {
                confirmed = await stopWithRetry(oldKey);
            } finally {
                handySwitching = false;
            }
            if (!confirmed) {
                throw new Error('The connected Handy did not confirm a stop; the connection was left unchanged.');
            }
        }
    }

    cancelOfflineStop();
    stopOfflinePolling();
    handyKey = trimmed;
    const loaded = await readHandyProfile(trimmed, info);
    handyInfo = loaded.info || info;
    handyProfile = loaded.profile;
    handyTiming = hdspTimingFor(handyProfile);
    handyConnected = true;
    handyIsHampRunning = false;
    handyDrive = 'hamp';
    clearHdspQueue();
    hdspLastSend = 0;
    hdspLastCommandAt = 0;
    hdspLastPosition = -1;
    hdspSlide = { min: -1, max: -1 };
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    startSequence += 1;
    consecutiveDispatchFailures = 0;
    lastFailedDispatch = -1;
    lastReportedError = null;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
    handyLastSend = 0;
    handyLastStrokeSend = 0;
    resetDeviceNotices();
    startOfflinePolling();

    return {
        info,
        profile: handyProfile,
        description: describeHandyInfo(info)
    };
}

// Disconnect from our side. Sends a verified stop with the stored key first
// so the device is never left moving, and resolves with whether the API
// confirmed it (true when there was nothing to stop). The link is dropped
// immediately; further dispatches are ignored.
export function disconnectHandy() {
    const wasConnected = handyConnected;
    const key = handyKey;
    const fromHdsp = handyDrive === 'hdsp';
    cancelOfflineStop();
    stopOfflinePolling();
    handyConnected = false;
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    startSequence += 1;
    handyIsHampRunning = false;
    handyDrive = 'hamp';
    clearHdspQueue();
    handyKey = '';
    handyInfo = null;
    handyProfile = null;
    handyTiming = null;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
    resetDeviceNotices();
    if (!wasConnected || !key) return Promise.resolve(true);
    return stopForeignDevice(key, fromHdsp);
}

// PUT /hamp/stop with up to three retries (250 / 500 / 1000 ms backoff).
// Resolves true only when the API confirmed the stop; running=false is set
// exclusively on that path. Concurrent callers asking for the same key with
// no command in between share the in-flight promise.
function stopWithRetry(key = handyKey) {
    if (stopInFlight && stopInFlight.key === key && stopInFlight.generation === commandGeneration) {
        return stopInFlight.promise;
    }
    const fromHdsp = handyDrive === 'hdsp';
    handyDrive = 'hamp';
    clearHdspQueue();
    const generation = ++commandGeneration;
    const promise = (async () => {
        const result = await attemptStop(key, { fromHdsp });
        if (result.ok) {
            if (generation === commandGeneration) {
                handyIsHampRunning = false;
                handyMotionUnknown = false;
                handyLastVelocitySent = -1;
            }
            return true;
        }
        reportStopUnconfirmed('/hamp/stop', result.error);
        return false;
    })();
    const record = { key, generation, promise };
    stopInFlight = record;
    promise.catch(() => {}).finally(() => {
        if (stopInFlight === record) stopInFlight = null;
    });
    return promise;
}

// Public verified stop. Used by app.js STOP paths; safe to call at any time.
export async function stopHandy() {
    if (!handyConnected || !handyKey) return false;
    return stopWithRetry(handyKey);
}

// A stop or disconnect happened while a start was in flight. The device may
// now be moving even though we asked it to stop, so wait for any stop that
// is still in flight for that key (it may have reached the device before
// this start did) and then send a fresh verified stop rather than trusting
// the earlier one. The key is the one the start was issued with, so this
// still reaches a device that has since been disconnected or replaced.
function restopAfterStaleStart(key) {
    const pending = stopInFlight && stopInFlight.key === key ? stopInFlight.promise : Promise.resolve();
    pending.catch(() => {}).then(() => {
        if (handyConnected && handyKey === key) return stopWithRetry(key);
        return stopForeignDevice(key);
    }).catch(() => {});
}

// Start HAMP motion. `rangeConfirmed` resolves once PUT /slide for the
// current range has been answered (true on success): the motor is only
// started after the range landed, so the first strokes can never run at a
// stale range the device still holds.
async function startHamp(velocity, rangeConfirmed = Promise.resolve(true)) {
    if (handyStartInFlight) {
        handyPendingVelocity = velocity;
        return;
    }
    handyStartInFlight = true;
    handyPendingVelocity = velocity;
    const key = handyKey;
    const generation = ++commandGeneration;
    const sequence = ++startSequence;
    try {
        const rangeOk = await rangeConfirmed.then((ok) => ok !== false, () => false);
        // A stop or disconnect while the range was in flight: nothing has been
        // started, so there is nothing to undo.
        if (generation !== commandGeneration) return;
        // The range never reached the device: do not move at an unknown
        // range; the next tick re-sends it and tries again.
        if (!rangeOk) return;
        await handyRequest('/hamp/start', { method: 'PUT', key });
        if (generation !== commandGeneration) {
            restopAfterStaleStart(key);
            return;
        }
        handyIsHampRunning = true;
        handyMotionUnknown = false;
        sendVelocity(handyPendingVelocity);
    } catch (e) {
        if (generation !== commandGeneration) {
            // The start failed on our side after a stop had been issued; a
            // timed-out or lost request may still be delivered by the relay.
            if (e && e.ambiguous) restopAfterStaleStart(key);
            return;
        }
        handyIsHampRunning = false;
        // A timeout leaves the device state unknown: the next zero-speed
        // dispatch sends a verified stop rather than nothing.
        if (e && e.ambiguous) handyMotionUnknown = true;
    } finally {
        if (sequence === startSequence) handyStartInFlight = false;
    }
}

function sendVelocity(velocity) {
    const v = clampVelocity(velocity);
    if (v === handyLastVelocitySent) return;
    handyLastVelocitySent = v;
    handyRequest('/hamp/velocity', { method: 'PUT', body: { velocity: v } }).catch(() => {
        // Force a resend on the next tick; a lost velocity update must not
        // leave the device stuck at the previous speed.
        handyLastVelocitySent = -1;
    });
}

// PUT /slide. Resolves true when the API accepted the range, false when it
// did not (the range is then re-sent on the next tick).
function sendSlide(range) {
    handyLastStrokeSent = { min: range.min, max: range.max };
    return handyRequest('/slide', { method: 'PUT', body: { min: range.min, max: range.max } })
        .then((body) => {
            // The device reports when it did not take our numbers. Said once
            // per connection: it is the same news every tick afterwards.
            const adjusted = describeSlideAdjustment(body, range);
            if (adjusted && !slideAdjustNotified) {
                slideAdjustNotified = true;
                callHandler('onNotice', adjusted);
            }
            return true;
        })
        .catch(() => {
            handyLastStrokeSent = { min: -1, max: -1 };
            return false;
        });
}

// Main dispatch entry point. strokeMin/strokeMax are physical sleeve percents
// that app.js has ALREADY mapped into the hardware envelope (engine.js does
// the mapping); the envelope arguments are used only to widen a too-narrow
// range in the right direction without leaving the user's bounds.
// `endMargin` is the wearer's end-stop margin in percent of travel (0 = off):
// it can only inset the normalised range, never widen it, so the envelope
// still bounds everything that reaches the device.
// Move the slider to a finger position. `percent` is 0 at the bottom of the
// wearer's travel window and 100 at the top. The v2 HDSP command is
// PUT /hdsp/xpt { position, duration } after PUT /mode { mode: HDSP }.
// position is a percent of the full stroke. The slide is opened to that
// same window first so a firmware that still clips to the slide stays
// inside the travel the wearer allowed.
export function dispatchHandyFollow(percent, envMin = 0, envMax = 100, endMargin = HANDY_DEFAULT_END_MARGIN) {
    if (!handyConnected || !handyKey || handySwitching) return;
    const bounds = endMarginWindow(envMin, envMax, endMargin);
    const position = followPosition(percent, envMin, envMax, endMargin);
    const now = Date.now();
    // The latest finger position wins, in either direction. Keeping the
    // farthest point made a drag to the top stick there when the next
    // downward move was inside that same window.
    hdspPending = { position, slide: bounds, at: now };
    pumpHdsp();
}

function pumpHdsp() {
    if (hdspBusy || !hdspPending || !handyConnected || !handyKey || handySwitching) return;
    const now = Date.now();
    const wait = hdspGapMs - (now - hdspLastSend);
    // A timer in a background tab is clamped to about a second, which is
    // why a smooth drag arrived as one position per second. The next finger
    // message sends as soon as the gap has passed. The timer only covers a
    // finger that has already stopped.
    if (hdspLastSend && wait > 0) {
        if (!hdspTimer) {
            hdspTimer = setTimeout(() => {
                hdspTimer = null;
                pumpHdsp();
            }, wait);
            unref(hdspTimer);
        }
        return;
    }
    if (hdspTimer) {
        clearTimeout(hdspTimer);
        hdspTimer = null;
    }
    const pending = hdspPending;
    const slide = pending.slide;
    hdspLastSend = now;
    hdspBusy = true;
    const key = handyKey;
    const generation = commandGeneration;
    const run = async () => {
        if (generation !== commandGeneration || !handyConnected) return;
        if (handyDrive !== 'hdsp') {
            await putHandyMode(HANDY_MODE.HDSP, key);
            if (generation !== commandGeneration || !handyConnected) return;
            handyDrive = 'hdsp';
            handyIsHampRunning = false;
            handyLastVelocitySent = -1;
        }
        // Open the whole travel window once. A stroke left over from
        // EdgeLoop is often a short slice, and position commands stay
        // inside it. Firmware 4 takes that window as a fraction of the rail.
        if (slide.min !== hdspSlide.min || slide.max !== hdspSlide.max) {
            if (useHandyV3()) {
                await handyV3('/slider/stroke', { min: slide.min / 100, max: slide.max / 100 }, key);
            } else {
                await handyRequest('/slide', { method: 'PUT', body: { min: slide.min, max: slide.max }, key });
            }
            hdspSlide = { min: slide.min, max: slide.max };
            handyLastStrokeSent = { min: slide.min, max: slide.max };
        }
        if (generation !== commandGeneration || !handyConnected) return;
        // The finger can move while the mode switch is in flight. Send where
        // it is now. stop_on_target makes the carriage stay there.
        const target = hdspPending ? hdspPending.position : pending.position;
        const same = hdspLastPosition >= 0 && Math.abs(target - hdspLastPosition) < 1;
        if (same && hdspSettled) return;
        const sentAt = Date.now();
        const estimated = hdspEstimatedPosition(hdspLeg, sentAt);
        const origin = estimated >= 0 ? estimated : hdspLastPosition;
        const pace = hdspLastCommandAt ? sentAt - hdspLastCommandAt : 0;
        const move = hdspMove(target, origin, handyTiming, pace);
        hdspLastCommandAt = sentAt;
        const row = rememberHandyMove(move);
        hdspLeg = {
            from: origin >= 0 ? origin : move.position,
            to: move.position,
            duration: move.duration,
            sentAt
        };
        hdspLastPosition = move.position;
        if (useHandyV3()) {
            await handyV3('/hdsp/xpt', {
                xp: Math.round(move.position) / 100,
                t: move.duration,
                stop_on_target: true,
                immediate_rsp: true
            }, key);
        } else {
            await handyRequest('/hdsp/xpt', { method: 'PUT', key, body: hdspBody(move) });
        }
        hdspSettled = same || move.stopOnTarget;
        handyMotionError = '';
        row.error = '';
        if (hdspGapMs > HANDY_TIMINGS.hdspIntervalMs) {
            hdspGapMs = Math.max(HANDY_TIMINGS.hdspIntervalMs, hdspGapMs - 10);
        }
    };
    run().catch((err) => {
        // A rate limit is a reason to wait, not to abandon position mode.
        if (err && (err.code === 429 || /rate limit/i.test(String(err.message || '')))) {
            hdspGapMs = Math.min(1000, hdspGapMs + 40);
            hdspLastPosition = -1;
            hdspLeg = null;
            hdspSettled = false;
            return;
        }
        hdspLastPosition = -1;
        hdspLeg = null;
        hdspSettled = false;
        handyMotionError = handyFaultLabel(err);
        const row = handyTrace.length ? handyTrace[handyTrace.length - 1] : null;
        if (row) row.error = handyMotionError;
        if (!hdspFailed) {
            hdspFailed = true;
            callHandler('onNotice', 'The Handy did not accept a position command. Loop needs the HDSP mode in its firmware.');
        }
        if (handyDrive === 'hdsp') handyDrive = 'hamp';
    }).finally(() => {
        hdspBusy = false;
        if (generation !== commandGeneration || !hdspPending) return;
        const pendingNow = hdspPending.position;
        if (hdspLastPosition < 0 || Math.abs(pendingNow - hdspLastPosition) >= 1 || handyDrive !== 'hdsp') pumpHdsp();
    });
}

export function dispatchHandy(primarySpeed, strokeMin, strokeMax, force = false, envMin = 0, envMax = 100, endMargin = HANDY_DEFAULT_END_MARGIN) {
    if (!handyConnected || !handyKey) return;
    if (handyDrive === 'hdsp') {
        const generation = ++commandGeneration;
        handyDrive = 'hamp';
        clearHdspQueue();
        putHandyMode(HANDY_MODE.HAMP).catch(() => {}).then(() => {
            if (generation !== commandGeneration || !handyConnected || handyDrive !== 'hamp') return;
            dispatchHandy(primarySpeed, strokeMin, strokeMax, true, envMin, envMax, endMargin);
        });
        return;
    }
    const now = Date.now();
    if (!force && (now - handyLastSend < VELOCITY_THROTTLE_MS)) return;
    handyLastSend = now;
    dispatchSequence += 1;

    const velocity = clampVelocity(primarySpeed);

    if (velocity === 0) {
        if (handyIsHampRunning || force || handyStartInFlight || handyMotionUnknown) {
            stopWithRetry(handyKey).catch(() => {});
            handyLastStrokeSent = { min: -1, max: -1 };
        }
        return;
    }

    // A reconnect is stopping this device before replacing it: no motion.
    if (handySwitching) return;

    const range = applyEndMargin(normalizeSlideRange(strokeMin, strokeMax, envMin, envMax), endMargin);
    const rangeChanged = range.min !== handyLastStrokeSent.min || range.max !== handyLastStrokeSent.max;
    let rangeConfirmed = Promise.resolve(true);
    if (force || rangeChanged || (now - handyLastStrokeSend > STROKE_THROTTLE_MS)) {
        handyLastStrokeSend = now;
        rangeConfirmed = sendSlide(range);
    }

    if (!handyIsHampRunning) {
        startHamp(velocity, rangeConfirmed);
    } else {
        sendVelocity(velocity);
    }
}

// Last-resort stop when the page goes away (pagehide / freeze): a plain
// request would be cancelled with the document, so the stop is sent with
// keepalive. The device is then treated as stopped so a page that comes
// back re-sends /hamp/start on its next tick. Returns whether a stop was
// sent. Never throws.
export function stopHandyOnUnload() {
    if (!handyConnected || !handyKey) return false;
    const fromHdsp = handyDrive === 'hdsp';
    if (!(handyIsHampRunning || handyStartInFlight || handyMotionUnknown || fromHdsp)) return false;
    const key = handyKey;
    commandGeneration += 1;
    handyIsHampRunning = false;
    handyDrive = 'hamp';
    clearHdspQueue();
    handyMotionUnknown = false;
    handyLastVelocitySent = -1;
    handyLastStrokeSent = { min: -1, max: -1 };
    try {
        if (fromHdsp) {
            const mode = fetch(`${HANDY_API_BASE}/mode`, {
                method: 'PUT',
                headers: { 'X-Connection-Key': key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: HANDY_MODE.HAMP }),
                keepalive: true
            });
            if (mode && typeof mode.catch === 'function') mode.catch(() => {});
        }
        const pending = fetch(`${HANDY_API_BASE}/hamp/stop`, {
            method: 'PUT',
            headers: { 'X-Connection-Key': key },
            keepalive: true
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (e) {
        return false;
    }
    return true;
}
