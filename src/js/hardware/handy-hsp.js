// The Handy over API v3 and HSP (beat sync): the device plays a rolling
// window of about 4 s of already-governed script points on a clock synced to
// Handy's server, and every point it has not played yet can be replaced in
// one request (flush + add). The v2 HAMP driver (handy.js) is untouched and
// keeps the link, the connectivity poll and every stop it has; this driver
// owns the device only between prepare() and release(), only in Script
// mode, and while it does, dispatchHandy is not called for it (app.js).
//
// Design rules, in priority order:
//   1. Fail safe. Every forced stop (STOP, PAUSE, the watchdog, supervision,
//      the page going away, a lost link) is PUT /hsp/stop, retried four
//      times (0 / 250 / 500 / 1000 ms) until a reply says nothing is being
//      played. Not confirmed: PUT /hsp/flush, which empties the buffer. Not
//      confirmed either: the wearer is told the device runs out of script
//      within the seconds still in its buffer, and stops keep being sent in
//      the background until one is confirmed. A play that may have landed
//      after a stop is stopped again. A skip (allowance 0 at an edge) is a
//      hold replan that goes out at once, whatever else is on its way, and
//      one not confirmed within 1 s of the edge becomes a stop. A device
//      that starves (hsp_starving) was not meant to: it is re-anchored, and
//      a second time within a minute pauses the session.
//   2. The device never sees a change it cannot reach smoothly: the points
//      before deviceNow + lead are re-sent exactly as they were last sent
//      (planWindow), and the new ones are shaped from where the old plan
//      is at that moment, under the speed limit (script-shaper.js).
//   3. Bounded: the device only ever holds points up to about 4 s ahead
//      (a rejoin's far join point included: clipPlan), so
//      a dead page, a frozen tab or lost Wi-Fi ends within that window even
//      before any stop arrives [device: starving holds the slider still].
//   4. Under the rate limit: the driver counts its own requests
//      (createRequestBudget), keeps routine traffic under 150 a minute and
//      a reserve of 30 for urgent replans and flushes; a stop is never held
//      back by it.
//
// What the live API was seen to return is in handy-hsp-protocol.js. What
// cannot be known without a FW4 Handy (spec §8.2) is marked [device] where
// the driver relies on it.
//
// Everything that touches the outside world is passed in (fetch,
// EventSource, the clocks, the timers), so the tests drive it with fakes.

import {
    HANDY_V3_BASE,
    HANDY_APP_ID,
    HANDY_V3_MODE,
    HSP_PLAY_STATE,
    HSP_MIN_BUFFER_POINTS,
    HSP_WINDOW_BEHIND_MS,
    HSP_WINDOW_AHEAD_MS,
    HSP_HOLD_EVERY_MS,
    HSP_SYNC_SAMPLES,
    HSP_RESYNC_SAMPLES,
    HSP_SSE_EVENTS,
    v3Headers,
    sseUrl,
    newStreamId,
    modeBody,
    setupBody,
    toHspPoints,
    playBody,
    synctimeBody,
    strokeWindow,
    strokeBody,
    compareStroke,
    classifyHspReply,
    isHspStopConfirmed,
    isHspFlushConfirmed,
    fwSupportsHsp,
    hspNotPossible,
    capabilitiesAllowHsp,
    sliderLimits,
    estimateServerOffset,
    leadFor,
    planPositionAt,
    planWindow,
    clipPlan,
    chunkPoints,
    quantizeAllowance,
    isUrgentAllowanceChange,
    createRequestBudget,
    classifyHspEvent,
    parseSseMessage
} from './handy-hsp-protocol.js';
import { describeDeviceStop } from './handy-protocol.js';
import { holdPoints, handySpeedCeiling, PLANNER_MIN_SEGMENT_MS } from '../player/script-shaper.js';

// Mutable through createHandyHsp({ timings }) so tests can shorten them.
export const HSP_TIMINGS = Object.freeze({
    requestTimeoutMs: 6000,
    stopRetryDelaysMs: [250, 500, 1000],
    flushAttempts: 2,
    // The window loop: how often it looks, how often a non-urgent change
    // may go out, and how much must be left ahead before it refills.
    tickMs: 250,
    cadenceMs: 1000,
    refillAheadMs: 2000,
    holdEscalateMs: 1000,
    // After every anchor: synctime every 2 s for 10 s, then every 10 s.
    synctimeFastMs: 2000,
    synctimeFastForMs: 10000,
    synctimeSlowMs: 10000,
    // GET /hsp/state drift check; a gap over driftMs twice in a row re-anchors.
    stateCheckMs: 10000,
    driftMs: 150,
    // Server-time re-sync while prepared.
    resyncMs: 10 * 60 * 1000,
    // GET /hsp/state while the SSE stream is down, and when to reopen it.
    ssePollMs: 5000,
    sseReopenMs: 30000,
    // Background stops for a stop nobody confirmed.
    chaseMs: 5000,
    chaseWindowMs: 5 * 60 * 1000,
    starvingWindowMs: 60000,
    // Round trips: a warning above slowWarnMs, a pause above slowPauseMs.
    slowWarnMs: 1000,
    slowPauseMs: 2000,
    missedLeadsToPause: 3,
    failuresToOffline: 3,
    failedAnchorsToPause: 3
});

const MISSING = Symbol('missing');

function defaultPerf() {
    try {
        const p = globalThis.performance;
        if (p && typeof p.now === 'function') return p.now();
    } catch (e) {}
    return Date.now();
}

function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// createHandyHsp(options) -> the driver. Options:
//   fetch, EventSource      the browser's (or fakes)
//   now()                   wall clock, ms (server-time sync runs on it)
//   perfNow()               the clock the script feed is read with
//   setTimer, clearTimer    setTimeout / clearTimeout
//   random()                for the stream id
//   feed                    the script feed (player/script-feed.js)
//   getKey()                the connection key of the live Handy link ('' for none)
//   getAppId()              the Application ID to send
//   handlers                { onPause(reason, cause), onOffline(reason),
//                             onStopUnconfirmed(message, key, { runsOutSeconds }),
//                             onStopConfirmed(key), onNotice(message), onLog(type, data),
//                             onStatus() }
//   timings                 overrides of HSP_TIMINGS
//   base                    the API base (tests)
export function createHandyHsp({
    fetch: fetchFn = globalThis.fetch,
    EventSource: EventSourceCtor = globalThis.EventSource,
    now = Date.now,
    perfNow = defaultPerf,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    random = Math.random,
    feed = null,
    getKey = () => '',
    getAppId = () => HANDY_APP_ID,
    handlers = {},
    timings = {},
    base = HANDY_V3_BASE
} = {}) {
    const T = { ...HSP_TIMINGS, ...timings };
    const budget = createRequestBudget();

    let beatSync = false;
    // GET /connected, /info, /capabilities and /settings/slider, for one key.
    let verified = null;
    // The last check's word that beat sync is not possible on this device
    // with this Application ID ({ key, appId, code, reason }), or null.
    let notPossible = null;
    // The server-time estimate: { offset, rtdP95, rtdMedian, lead, at }.
    let sync = null;
    // From PUT /hsp/setup until release(): { key, appId, streamId,
    // maxPoints, modeSessionId, window, ceiling }.
    let session = null;
    // While a script is being played: { lastPlan, tailIndex, allowance (as
    // planned), cap, holding, join, lastSentAt, anchoredAt, generation,
    // misses, dirty, urgent, holdTimer }.
    let play = null;
    // What the device's slider may be doing: 'stopped' (confirmed, or never
    // set going), 'moving' (playing our points), 'unknown' (a stop nobody
    // confirmed, a keepalive stop, a play whose answer was lost).
    let motion = 'stopped';
    // Bumped by every stop, pause, release and offline: an answer to a
    // request sent before it acts on nothing.
    let epoch = 0;
    // Bumped whenever something is set going on the device (a play sent, a
    // play that may have landed after a stop, a play another page left): a
    // stop vouches only for what was set going before it began.
    let motionSeq = 0;
    // The allowance and cap the engine asked for last.
    let wanted = { allowance: 0, cap: 100 };
    let failures = 0;
    let failedAnchors = 0;
    let stopJob = null;
    let chase = null;
    let sse = null;
    let starvings = [];
    let driftStrikes = 0;
    let expectingMode = 0;
    let offline = false;
    let reportedUnconfirmed = new Set();
    let tickTimer = null;
    let synctimeTimer = null;
    let stateTimer = null;
    let resyncTimer = null;
    let inFlight = null;
    // Window sends (a play, an add) whose answer has not come back, and the
    // count of plans made: a newer plan supersedes an older one on its way.
    let pendingSends = 0;
    let planSeq = 0;
    let slowWarned = false;
    let unsubscribeFeed = null;
    // The stroke window on its way to the device (setWindow), and whether a
    // newer one was asked for meanwhile.
    let strokeJob = null;
    let strokeDirty = false;

    function call(name, ...args) {
        const fn = handlers && handlers[name];
        if (typeof fn !== 'function') return;
        try { fn(...args); } catch (e) {}
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimer(resolve, ms));
    }

    function perf() {
        try {
            const p = Number(perfNow());
            return finite(p) ? p : null;
        } catch (e) {
            return null;
        }
    }

    function scriptNow() {
        if (!feed || typeof feed.scriptNow !== 'function') return null;
        try {
            const t = feed.scriptNow(perf() ?? undefined);
            return finite(t) ? t : null;
        } catch (e) {
            return null;
        }
    }

    function feedGeneration() {
        try { return feed && typeof feed.generation === 'function' ? String(feed.generation()) : ''; } catch (e) { return ''; }
    }

    function serverNow() {
        return now() + (sync ? sync.offset : 0);
    }

    function clear(timer) {
        if (timer !== null && timer !== undefined) clearTimer(timer);
        return null;
    }

    // ---- requests --------------------------------------------------------------

    // One exchange: { verdict, rtd }. `kind` is the budget's ('routine',
    // 'urgent', 'stop'), or null for a request the budget does not count
    // (GET /servertime needs no key and is not a device call). A request the
    // budget refuses is not sent: { verdict: { ok: false, budget: true } }.
    async function request(path, { method = 'GET', body = MISSING, kind = 'routine', key = null, appId = null, keepalive = false, count = true } = {}) {
        const k = key ?? (session ? session.key : getKey());
        const id = appId ?? (session ? session.appId : getAppId());
        if (kind && !budget.take(kind, now())) {
            return { verdict: { ok: false, budget: true, message: `EdgeLoop held back a request to stay under the Handy API's rate limit (${path})` }, rtd: null };
        }
        const headers = path === '/servertime' ? {} : v3Headers(id, k, { json: body !== MISSING });
        const init = { method, headers };
        if (body !== MISSING) init.body = JSON.stringify(body);
        if (keepalive) init.keepalive = true;
        let abortTimer = null;
        if (typeof AbortController === 'function') {
            const controller = new AbortController();
            init.signal = controller.signal;
            abortTimer = setTimer(() => controller.abort(), T.requestTimeoutMs);
        }
        const sentAt = now();
        let reply;
        try {
            const res = await fetchFn(`${base}${path}`, init);
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            reply = { httpOk: Boolean(res.ok), status: res.status, body: data };
        } catch (e) {
            reply = { noReply: true, timedOut: Boolean(e && e.name === 'AbortError') };
        } finally {
            clear(abortTimer);
        }
        const rtd = now() - sentAt;
        const verdict = classifyHspReply(reply, path);
        if (count) noteOutcome(verdict);
        return { verdict, rtd };
    }

    // Three failed requests in a row, or the API's word that the device is
    // not connected while it is ours, take the link offline.
    function noteOutcome(verdict) {
        if (verdict.ok) {
            failures = 0;
            return;
        }
        if (verdict.budget) return;
        failures += 1;
        if (!session) return;
        if (verdict.notConnected) goOffline('The Handy is offline: the Handy API says it is not connected.');
        else if (failures >= T.failuresToOffline) goOffline(`The Handy stopped responding (${failures} failed requests): ${verdict.message}`);
    }

    // ---- server time -----------------------------------------------------------

    async function syncClock(samples = HSP_SYNC_SAMPLES) {
        const taken = [];
        for (let i = 0; i < samples; i += 1) {
            const sentAt = now();
            const { verdict } = await request('/servertime', { kind: null, count: false });
            const receivedAt = now();
            const st = verdict.ok && verdict.result ? Number(verdict.result.server_time) : NaN;
            if (finite(st)) taken.push({ sentAt, receivedAt, serverTime: st });
        }
        const est = estimateServerOffset(taken);
        if (!est) return null;
        sync = { offset: est.offset, rtdP95: est.rtdP95, rtdMedian: est.rtdMedian, lead: leadFor(est.rtdP95), at: now() };
        if (est.rtdP95 > T.slowWarnMs && !slowWarned) {
            slowWarned = true;
            call('onNotice', `The Handy's cloud link is slow: reactions arrive about ${Math.round(sync.lead / 100) / 10} s late.`);
        }
        call('onStatus');
        return sync;
    }

    // ---- connect / verify ------------------------------------------------------

    function refuse(code, reason) {
        return { ok: false, code, reason };
    }

    // Before START, never inside it: is the Handy connected now one that can
    // play HSP? GET /connected, /info (firmware 4 or later),
    // /capabilities (a slider), /settings/slider (travel and top speed, for
    // the speed ceiling), then 30 server-time samples. Resolves { ok,
    // code, reason, fw, travelMm, maxSpeedMmS, lead, rtdP95 }; a refusal's
    // reason is what the route line says ("firmware 3: update ...").
    async function verify() {
        const key = getKey();
        const appId = getAppId();
        const v = await checkDevice(key, appId);
        if (v.ok) notPossible = null;
        else if (hspNotPossible(v.code)) notPossible = { key, appId, code: v.code, reason: v.reason };
        return v;
    }

    async function checkDevice(key, appId) {
        if (!key) return refuse('no-key', 'no Handy is connected');
        const opts = { key, appId, count: false };
        const conn = await request('/connected', opts);
        if (!conn.verdict.ok) {
            if (conn.verdict.unauthenticated) return refuse('auth', "the Handy API refused EdgeLoop's Application ID");
            return refuse('network', `the Handy API could not be asked (${conn.verdict.message})`);
        }
        if (!conn.verdict.result || conn.verdict.result.connected !== true) return refuse('offline', 'the Handy API says the device is offline');
        const info = await request('/info', opts);
        if (!info.verdict.ok) return refuse('network', `the device did not say which firmware it runs (${info.verdict.message})`);
        const fw = fwSupportsHsp(info.verdict.result);
        if (!fw.ok) return refuse('firmware', fw.reason);
        const caps = await request('/capabilities', opts);
        if (!caps.verdict.ok || !capabilitiesAllowHsp(caps.verdict.result)) return refuse('capabilities', 'the device does not report a slider');
        const slider = await request('/settings/slider', opts);
        const limits = slider.verdict.ok ? sliderLimits(slider.verdict.result) : { travelMm: null, maxSpeedMmS: null };
        const est = await syncClock(HSP_SYNC_SAMPLES);
        if (!est) return refuse('sync', 'the Handy server time could not be read');
        if (est.rtdP95 > T.slowPauseMs) return refuse('slow', `the Handy's cloud link is too slow for a script (round trips up to ${Math.round(est.rtdP95)} ms)`);
        verified = {
            key,
            appId,
            fw: String(info.verdict.result.fw_version ?? ''),
            travelMm: limits.travelMm,
            maxSpeedMmS: limits.maxSpeedMmS,
            at: now()
        };
        call('onStatus');
        return { ok: true, code: '', reason: '', fw: verified.fw, travelMm: limits.travelMm, maxSpeedMmS: limits.maxSpeedMmS, lead: est.lead, rtdP95: est.rtdP95 };
    }

    // ---- setup -----------------------------------------------------------------

    // At START (and RESUME) in Script mode with beat sync on. Verifies the
    // device when this key and ID have not been, re-syncs a clock older than
    // ten minutes, puts the device in HSP mode, sets up a new HSP session
    // (max_points must be at least 50), sets the stroke window to the
    // envelope with the end margin, and opens the event stream. Nothing
    // moves: the first dispatch that has script time anchors the play.
    // Resolves { ok, code, reason }; the session does not start on a
    // refusal and the route is not switched silently (app.js).
    async function prepare({ envMin = 0, envMax = 100, endMargin = 5 } = {}) {
        if (!beatSync) return refuse('consent', 'Beat sync on The Handy is switched off');
        const key = getKey();
        const appId = getAppId();
        if (!key) return refuse('no-key', 'no Handy is connected');
        if (!verified || verified.key !== key || verified.appId !== appId) {
            const v = await verify();
            if (!v.ok) return v;
        } else if (!sync || now() - sync.at > T.resyncMs) {
            const est = await syncClock(HSP_RESYNC_SAMPLES);
            if (!est) return refuse('sync', 'the Handy server time could not be read');
        }
        if (getKey() !== key) return refuse('stale', 'the Handy connection changed while beat sync was being set up');
        const window = strokeWindow(envMin, envMax, endMargin);
        const ceiling = handySpeedCeiling({ maxSpeedMmS: verified.maxSpeedMmS, travelMm: verified.travelMm });
        if (!session || session.key !== key || session.appId !== appId) {
            const opts = { key, appId, kind: 'urgent', count: false };
            expectingMode += 1;
            let mode;
            try {
                mode = await request('/mode2', { ...opts, method: 'PUT', body: modeBody(HANDY_V3_MODE.HSP) });
            } finally {
                expectingMode -= 1;
            }
            if (!mode.verdict.ok) return refuse('mode', `The Handy did not switch to HSP mode (${mode.verdict.message})`);
            const result = mode.verdict.result;
            const modeSessionId = result && typeof result === 'object' ? result.mode_session_id ?? null : null;
            if (result && typeof result === 'object' && finite(Number(result.mode)) && Number(result.mode) !== HANDY_V3_MODE.HSP) {
                return refuse('mode', 'The Handy did not switch to HSP mode');
            }
            const streamId = newStreamId(random);
            const setup = await request('/hsp/setup', { ...opts, method: 'PUT', body: setupBody(streamId) });
            if (!setup.verdict.ok) return refuse('setup', `The Handy did not set up beat sync (${setup.verdict.message})`);
            const maxPoints = setup.verdict.state ? Number(setup.verdict.state.max_points) : NaN;
            if (finite(maxPoints) && maxPoints < HSP_MIN_BUFFER_POINTS) {
                return refuse('buffer', `The Handy's point buffer holds only ${maxPoints} points (switching its Bluetooth off may help)`);
            }
            session = { key, appId, streamId, maxPoints: finite(maxPoints) ? maxPoints : null, modeSessionId, window, deviceWindow: null, ceiling };
            failures = 0;
            offline = false;
            motion = 'stopped';
        }
        session.window = window;
        session.refusedWindow = null;
        session.ceiling = ceiling;
        const stroke = await request('/slider/stroke', { method: 'PUT', body: strokeBody(window), kind: 'urgent', count: false });
        if (!stroke.verdict.ok) return refuse('stroke', `The Handy did not take the stroke window (${stroke.verdict.message})`);
        session.deviceWindow = window;
        openSse();
        startResyncTimer();
        subscribeFeed();
        call('onStatus');
        return { ok: true, code: '', reason: '' };
    }

    // ---- the window ------------------------------------------------------------

    function currentPlanEnd() {
        if (!play || !play.lastPlan || play.lastPlan.length === 0) return null;
        return play.lastPlan[play.lastPlan.length - 1].t;
    }

    function shape(args) {
        try {
            return feed.shape({
                window: session.window,
                profile: session.ceiling,
                minSegmentMs: PLANNER_MIN_SEGMENT_MS,
                cap: wanted.cap,
                ...args
            });
        } catch (e) {
            try { feed.reportError(e, 'handy-hsp'); } catch (x) {}
            return null;
        }
    }

    // Where the slider is, 0-1 of the stroke window, from GET /slider/state
    // (position is 0-1 of the full slider), or null.
    async function readStartPosition() {
        const { verdict } = await request('/slider/state', { kind: 'urgent' });
        if (!verdict.ok || !verdict.result || !finite(Number(verdict.result.position))) return null;
        const pos = Number(verdict.result.position);
        const lo = session.window.min / 100;
        const hi = session.window.max / 100;
        if (!(hi > lo)) return null;
        const x = (pos - lo) / (hi - lo);
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    // Send `points` as the whole buffer: the first chunk flushes, inside
    // PUT /hsp/play when `anchorAt` is given. Resolves { ok, rtd, verdict,
    // landed } where `landed` is false only when the API answered that it
    // did not take the first chunk (an error reply): a lost answer may have
    // landed.
    async function sendBuffer(points, { anchorAt = null, kind = 'routine' } = {}) {
        const { bodies, tailIndex } = chunkPoints(points, { flush: true, tailIndex: play ? play.tailIndex : 0 });
        // Taken now: a hold may go out while this send is still on its way.
        if (play) play.tailIndex = tailIndex;
        pendingSends += 1;
        try {
            return await sendBodies(bodies, { anchorAt, kind, tailIndex });
        } finally {
            pendingSends -= 1;
        }
    }

    async function sendBodies(bodies, { anchorAt, kind, tailIndex }) {
        let first;
        if (anchorAt !== null) {
            const body = playBody({ startTime: anchorAt.scriptMs, serverTime: anchorAt.serverMs, add: bodies[0] });
            first = await request('/hsp/play', { method: 'PUT', body, kind });
        } else {
            first = await request('/hsp/add', { method: 'PUT', body: bodies[0], kind });
        }
        const landed = first.verdict.ok || first.verdict.noReply;
        if (!first.verdict.ok) return { ok: false, rtd: first.rtd, verdict: first.verdict, landed, tailIndex };
        for (let i = 1; i < bodies.length; i += 1) {
            const more = await request('/hsp/add', { method: 'PUT', body: bodies[i], kind });
            if (!more.verdict.ok) return { ok: false, rtd: first.rtd, verdict: more.verdict, landed: true, tailIndex };
        }
        return { ok: true, rtd: first.rtd, verdict: first.verdict, landed: true, tailIndex };
    }

    // The play from the script's present: PUT /hsp/play with an embedded
    // flushed add, the rejoin sized from where the slider is.
    function anchor() {
        if (!session || offline) return Promise.resolve(false);
        if (inFlight) return inFlight;
        const job = doAnchor();
        inFlight = job;
        job.catch(() => {}).finally(() => afterJob(job));
        return job;
    }

    // One window request at a time: what was asked for meanwhile goes next.
    // A hold is the exception (replan): it goes out at once, and one that
    // went out while an older send was still on its way vouches for nothing,
    // since that send may have landed after it. Once nothing is on its way,
    // the hold goes again, and that one's answer confirms it.
    function afterJob(job) {
        if (inFlight === job) inFlight = null;
        if (!play || inFlight) return;
        if (play.urgent) {
            play.urgent = false;
            replan({ urgent: true });
            return;
        }
        if (play.holdTimer && play.holding && pendingSends === 0) replan({ urgent: true });
    }

    // The device's buffer starts at script time 0 (HSP point times are
    // whole ms >= 0), but with a negative script offset the first seconds of
    // a video are at a negative script time. A plan that started there
    // would have its first move, the way from where the slider is, squeezed
    // into the time up to its next point or lost (toHspPoints): every plan
    // starts at 0 at the earliest, from where the device is then.
    function planStart(t) {
        return t < 0 ? 0 : t;
    }

    async function doAnchor() {
        const my = epoch;
        const startPos = await readStartPosition();
        if (my !== epoch || !session) return false;
        const t0 = scriptNow();
        if (t0 === null) return false;
        const lead = sync ? sync.lead : 1000;
        const allowance = quantizeAllowance(wanted.allowance);
        // The plan starts at script time 0 at the earliest (planStart): the
        // slider stays where it is until then, and the lead still counts
        // from now.
        const from = planStart(t0);
        let points = [];
        let join = null;
        if (allowance > 0) {
            const shaped = shape({ from, to: t0 + HSP_WINDOW_AHEAD_MS, allowance, startPos, rejoin: true, lead: Math.max(0, t0 + lead - from) });
            if (!shaped) return false;
            points = toHspPoints(shaped.points);
            if (shaped.join && shaped.join.t > t0 + HSP_WINDOW_AHEAD_MS) {
                join = { t: Math.round(shaped.join.t), x: Math.round(shaped.join.x * 100) };
                points = points.concat([join]);
            }
            // A join beyond the window is the target, not a point the
            // device holds: it gets the way there up to the window's end.
            points = clipPlan(points, t0 + HSP_WINDOW_AHEAD_MS);
        } else if (startPos !== null) {
            points = toHspPoints(holdPoints(from, t0 + HSP_WINDOW_AHEAD_MS, startPos, HSP_HOLD_EVERY_MS));
        } else {
            return false;
        }
        if (points.length === 0) return false;
        // Read again at the moment it goes: start_time and server_time name
        // the same instant.
        const tSend = scriptNow();
        if (tSend === null) return false;
        play = {
            lastPlan: points,
            tailIndex: play ? play.tailIndex : 0,
            allowance,
            cap: wanted.cap,
            holding: allowance === 0,
            holdX: allowance === 0 ? points[0].x : null,
            join,
            lastSentAt: now(),
            anchoredAt: now(),
            generation: feedGeneration(),
            misses: 0,
            dirty: false,
            urgent: false,
            holdTimer: null
        };
        motion = 'unknown';
        motionSeq += 1;
        const sent = await sendBuffer(points, { anchorAt: { scriptMs: tSend, serverMs: serverNow() }, kind: 'urgent' });
        if (my !== epoch) {
            // A stop went out while this play was on its way: it may land
            // after that stop, so the stop is sent again.
            if (sent.landed) restop();
            return false;
        }
        if (!play) return false;
        if (!sent.ok) {
            failedAnchors += 1;
            if (!sent.verdict.notConnected) stop({ reason: 'anchor' });
            if (failedAnchors >= T.failedAnchorsToPause) call('onPause', `The Handy did not take the script (${sent.verdict.message}).`, 'anchor');
            return false;
        }
        failedAnchors = 0;
        motion = 'moving';
        startLoop();
        startSyncSchedule();
        call('onStatus');
        return true;
    }

    // Replan the buffer: the old plan up to deviceNow + lead, the new one
    // after it.
    // An edge (a skip to 0) never waits behind a window request on its way:
    // the 1 s escalation to a stop is armed the moment the hold is decided,
    // and the hold goes out at once, superseding the older request.
    async function replan({ urgent = false } = {}) {
        if (!session || !play || offline) return false;
        const hold = quantizeAllowance(wanted.allowance) === 0 && !play.holding;
        if (hold) armHoldEscalation();
        if (inFlight && !hold) {
            play.dirty = true;
            if (urgent) play.urgent = true;
            return inFlight;
        }
        const job = doReplan(urgent || hold);
        inFlight = job;
        try {
            return await job;
        } finally {
            afterJob(job);
        }
    }

    async function doReplan(urgent) {
        const my = epoch;
        const t = scriptNow();
        if (t === null || !play) return false;
        const lead = sync ? sync.lead : 1000;
        const from = t - HSP_WINDOW_BEHIND_MS;
        // Never before script time 0, where the device's buffer starts.
        const splice = Math.round(planStart(t + lead));
        const to = t + HSP_WINDOW_AHEAD_MS;
        const allowance = quantizeAllowance(wanted.allowance);
        const wasHolding = play.holding;
        const at = planPositionAt(play.lastPlan, splice);
        const spliceX = at === null ? (play.holdX ?? 0) : Math.round(at);
        let newPoints = [];
        let join = null;
        if (allowance === 0) {
            newPoints = toHspPoints(holdPoints(splice + HSP_HOLD_EVERY_MS, to, spliceX / 100, HSP_HOLD_EVERY_MS));
            // Never starve on purpose: a hold point at the window's end.
            const end = Math.round(to);
            if (newPoints.length === 0 || newPoints[newPoints.length - 1].t < end) newPoints.push({ t: end, x: spliceX });
        } else if (play.join && play.join.t > splice) {
            // Still on the way to the join point: keep it, and the script
            // after it.
            join = play.join;
            const after = shape({ from: join.t, to: Math.max(to, join.t + 1), allowance, startPos: join.x / 100, rejoin: false });
            if (!after) return false;
            newPoints = [join].concat(toHspPoints(after.points).filter((p) => p.t > join.t));
        } else {
            const shaped = shape({ from: splice, to, allowance, startPos: spliceX / 100, rejoin: wasHolding, lead: 0 });
            if (!shaped) return false;
            newPoints = toHspPoints(shaped.points);
            if (shaped.join && shaped.join.t > to) {
                join = { t: Math.round(shaped.join.t), x: Math.round(shaped.join.x * 100) };
                newPoints = newPoints.concat([join]);
            }
        }
        // Never a point past the window in the device's buffer: a join
        // further out is reached across refills (play.join).
        const points = clipPlan(planWindow({ lastPlan: play.lastPlan, from, splice, newPoints }).points, to);
        if (points.length === 0) return false;
        const previous = play.lastPlan;
        const previousState = { allowance: play.allowance, holding: play.holding, holdX: play.holdX, join: play.join };
        play.lastPlan = points;
        play.allowance = allowance;
        play.cap = wanted.cap;
        play.holding = allowance === 0;
        play.holdX = allowance === 0 ? spliceX : null;
        play.join = join;
        play.lastSentAt = now();
        play.dirty = false;
        planSeq += 1;
        const mine = planSeq;
        play.planSeq = mine;
        // Nothing else on its way: this send cannot be overtaken by an older one.
        const clean = pendingSends === 0;
        const sent = await sendBuffer(points, { kind: urgent ? 'urgent' : 'routine' });
        if (my !== epoch || !play) return false;
        // A newer plan (a hold) went out while this one was on its way: its
        // answer says nothing about what the device has now.
        if (play.planSeq !== mine) return false;
        if (sent.verdict && sent.verdict.budget) {
            // Not sent at all: the device still has the previous plan.
            play.lastPlan = previous;
            Object.assign(play, previousState);
            play.dirty = true;
            if (play.holdTimer) {
                // A skip that cannot go out as a hold goes out as a stop.
                stop({ reason: 'hold' });
            }
            return false;
        }
        if (!sent.ok) {
            // An error reply: the device did not take it and still has the
            // previous plan. A lost answer may have landed: kept as sent.
            if (!sent.landed) {
                play.lastPlan = previous;
                Object.assign(play, previousState);
                play.dirty = true;
            }
            if (play.holdTimer) stop({ reason: 'hold' });
            return false;
        }
        // The device has this plan, and nothing sent before it can land
        // after it: a hold it carries is confirmed.
        if (clean) disarmHoldEscalation();
        if (finite(sent.rtd) && sent.rtd > lead) {
            play.misses += 1;
            if (play.misses >= T.missedLeadsToPause) {
                call('onPause', 'Too slow for a script: The Handy\'s cloud link missed its lead three times in a row.', 'slow');
            }
        } else {
            play.misses = 0;
        }
        return true;
    }

    // A skip's hold must be confirmed within holdEscalateMs, or it becomes
    // a stop.
    function armHoldEscalation() {
        if (!play || play.holdTimer) return;
        const my = epoch;
        play.holdTimer = setTimer(() => {
            if (my !== epoch || !play) return;
            play.holdTimer = null;
            stop({ reason: 'hold' });
        }, T.holdEscalateMs);
    }

    function disarmHoldEscalation() {
        if (play) play.holdTimer = clear(play.holdTimer);
    }

    function startLoop() {
        tickTimer = clear(tickTimer);
        const loop = () => {
            tickTimer = null;
            if (!session || !play) return;
            onTick();
            tickTimer = setTimer(loop, T.tickMs);
        };
        tickTimer = setTimer(loop, T.tickMs);
    }

    function onTick() {
        if (!play || inFlight) return;
        const t = scriptNow();
        if (t === null) return;
        const end = currentPlanEnd();
        const ahead = end === null ? 0 : end - t;
        const due = (play.dirty && now() - play.lastSentAt >= T.cadenceMs) || ahead < T.refillAheadMs;
        // Almost dry: the refill may use the reserve.
        if (due) replan({ urgent: ahead < (sync ? sync.lead : 1000) + 500 });
    }

    // ---- drift ------------------------------------------------------------------

    function startSyncSchedule() {
        synctimeTimer = clear(synctimeTimer);
        stateTimer = clear(stateTimer);
        if (!play) return;
        const anchoredAt = play.anchoredAt;
        const my = epoch;
        const syncLoop = () => {
            synctimeTimer = null;
            if (my !== epoch || !play) return;
            const t = scriptNow();
            if (t !== null && sync) {
                request('/hsp/synctime', { method: 'PUT', body: synctimeBody({ currentTime: t, serverTime: serverNow() }) });
            }
            const fast = now() - anchoredAt < T.synctimeFastForMs;
            synctimeTimer = setTimer(syncLoop, fast ? T.synctimeFastMs : T.synctimeSlowMs);
        };
        synctimeTimer = setTimer(syncLoop, T.synctimeFastMs);
        const stateLoop = async () => {
            stateTimer = null;
            if (my !== epoch || !play) return;
            await checkDrift();
            if (my !== epoch || !play) return;
            stateTimer = setTimer(stateLoop, T.stateCheckMs);
        };
        stateTimer = setTimer(stateLoop, T.stateCheckMs);
    }

    async function checkDrift() {
        const { verdict, rtd } = await request('/hsp/state');
        if (!verdict.ok || !verdict.state || !play) return;
        noteState(verdict.state);
        const t = scriptNow();
        const device = Number(verdict.state.current_time);
        if (t === null || !finite(device) || verdict.state.play_state !== HSP_PLAY_STATE.PLAYING) return;
        const estimate = t - (finite(rtd) ? rtd / 2 : 0);
        if (Math.abs(device - estimate) > T.driftMs) {
            driftStrikes += 1;
            if (driftStrikes >= 2) {
                driftStrikes = 0;
                reanchor();
            }
        } else {
            driftStrikes = 0;
        }
    }

    // A starving device (SSE hsp_starving, or the polled state) was not meant
    // to starve: re-anchor, and pause the session on the second time inside
    // a minute.
    function noteState(state) {
        if (state && state.play_state === HSP_PLAY_STATE.STARVING && play) onStarving();
    }

    function onStarving() {
        if (!session) return;
        const t = now();
        starvings = starvings.filter((at) => t - at < T.starvingWindowMs);
        starvings.push(t);
        if (starvings.length >= 2) {
            starvings = [];
            call('onPause', 'The Handy ran out of script points twice in a minute.', 'starving');
            stop({ reason: 'starving' });
            return;
        }
        reanchor();
    }

    // A new play from the script's present, once the window request on its
    // way has been answered: its flush must not land after the play's.
    function reanchor() {
        if (!session || offline) return;
        // A hold not yet confirmed is not given up for a new play: a stop.
        if (play && play.holdTimer) {
            stop({ reason: 'hold' });
            return;
        }
        stopLoops();
        play = null;
        const go = () => {
            if (!session || offline || play) return;
            if (inFlight) {
                inFlight.catch(() => {}).then(go);
                return;
            }
            anchor();
        };
        go();
    }

    // ---- the stroke window while prepared ------------------------------------------

    // The Travel Envelope or the end margin changed while this driver owns
    // the device (app.js calls this on every change, and with every
    // dispatch): the new window goes out at once as PUT /slider/stroke, one
    // at a time with the latest winning, and a play under way is re-anchored
    // on it. The envelope stays the outermost bound: a window the device did
    // not take while it may still stroke outside the new one pauses the
    // session and stops it. Resolves whether the device has the window.
    function setWindow({ envMin = 0, envMax = 100, endMargin = 5 } = {}) {
        if (!session || offline) return Promise.resolve(false);
        const window = strokeWindow(envMin, envMax, endMargin);
        const same = (a, b) => Boolean(a && b) && a.min === b.min && a.max === b.max;
        if (same(window, session.window)) return strokeJob || Promise.resolve(same(window, session.deviceWindow));
        if (!strokeJob && same(window, session.refusedWindow)) return Promise.resolve(false);
        session.refusedWindow = null;
        session.window = window;
        if (strokeJob) {
            strokeDirty = true;
            return strokeJob;
        }
        const job = sendStrokeWindow();
        strokeJob = job;
        job.catch(() => {}).finally(() => { if (strokeJob === job) strokeJob = null; });
        return job;
    }

    async function sendStrokeWindow() {
        const s = session;
        let changed = false;
        for (;;) {
            strokeDirty = false;
            const window = s.window;
            const { verdict } = await request('/slider/stroke', { method: 'PUT', body: strokeBody(window), kind: 'urgent', key: s.key, appId: s.appId });
            if (session !== s) return false;
            if (verdict.ok) {
                s.deviceWindow = window;
                changed = true;
            } else {
                const dev = s.deviceWindow;
                const outside = !dev || dev.min < s.window.min || dev.max > s.window.max;
                if (strokeDirty) continue;
                if (outside) {
                    call('onPause', `The Handy did not take the new travel envelope (${verdict.message}).`, 'stroke');
                    stop({ reason: 'stroke' });
                    return false;
                }
                // A wider window it did not take: it still strokes inside
                // the narrower one it has, and is shaped for that one until
                // the envelope changes again.
                s.refusedWindow = window;
                s.window = dev;
                if (changed && play) reanchor();
                return false;
            }
            if (!strokeDirty) break;
        }
        if (changed && play) reanchor();
        return true;
    }

    // ---- the feed --------------------------------------------------------------

    function subscribeFeed() {
        if (unsubscribeFeed || !feed || typeof feed.subscribe !== 'function') return;
        try { unsubscribeFeed = feed.subscribe(onFeedChange); } catch (e) { unsubscribeFeed = null; }
    }

    // The clock stopped (a seek, a stall, the video paused, Script mode off):
    // PUT /hsp/pause, which keeps the position; a pause nobody confirmed is
    // a stop. The clock started again, or jumped: a new play from the
    // script's present.
    function onFeedChange() {
        if (!session || offline) return;
        const t = scriptNow();
        if (t === null) {
            if (play || motion !== 'stopped') pauseDevice();
            return;
        }
        if (play && play.generation !== feedGeneration()) {
            reanchor();
            return;
        }
        if (!play && quantizeAllowance(wanted.allowance) > 0) anchor();
    }

    async function pauseDevice() {
        epoch += 1;
        const my = epoch;
        stopLoops();
        play = null;
        const { verdict } = await request('/hsp/pause', { method: 'PUT', kind: 'urgent' });
        if (my !== epoch) return;
        const s = verdict.state ? verdict.state.play_state : null;
        if (verdict.ok && (s === HSP_PLAY_STATE.PAUSED || s === HSP_PLAY_STATE.STOPPED || s === HSP_PLAY_STATE.NOT_INITIALIZED)) {
            motion = 'stopped';
            return;
        }
        stop({ reason: 'pause' });
    }

    // ---- the engine's dispatch --------------------------------------------------

    // Every dispatch while this driver owns the Handy. `allowance` is the
    // primary channel (0-100) when The Handy follows it, `cap` its speed
    // cap (it scales the speed limit). A forced zero is a verified stop. A
    // zero at an edge is a hold, urgent. A change to or from 0, a drop of 15
    // points or more, or an urgent dispatch replans at once; any other
    // change waits for the cadence, in 5-point steps.
    function dispatch({ allowance = 0, cap = 100, force = false, urgent = false } = {}) {
        const a = finite(allowance) ? Math.max(0, Math.min(100, allowance)) : 0;
        const c = finite(cap) ? Math.max(0, Math.min(100, cap)) : 100;
        const before = play ? play.allowance : wanted.allowance;
        wanted = { allowance: c > 0 ? a : 0, cap: c };
        if (force && wanted.allowance === 0) return stop({ reason: 'forced' });
        if (!session || offline) return Promise.resolve(false);
        if (!play) {
            if (wanted.allowance > 0 && scriptNow() !== null) return anchor();
            // An edge while no plan is in hand (a new play still being
            // prepared, the old buffer still playing): nothing can be held,
            // so the device is stopped.
            if (wanted.allowance === 0 && before > 0 && motion !== 'stopped') return stop({ reason: 'hold' });
            return Promise.resolve(false);
        }
        const q = quantizeAllowance(wanted.allowance);
        if (q === play.allowance && c === play.cap) return Promise.resolve(true);
        if (isUrgentAllowanceChange(play.allowance, q) || isUrgentAllowanceChange(before, wanted.allowance) || force || urgent) {
            return replan({ urgent: true });
        }
        play.dirty = true;
        return Promise.resolve(true);
    }

    // ---- stops -------------------------------------------------------------------

    function stopLoops() {
        tickTimer = clear(tickTimer);
        synctimeTimer = clear(synctimeTimer);
        stateTimer = clear(stateTimer);
        if (play) play.holdTimer = clear(play.holdTimer);
    }

    // Seconds the device may still play: the end of the last plan sent,
    // from the script's present.
    function runsOutSeconds(plan) {
        const end = plan && plan.length > 0 ? plan[plan.length - 1].t : null;
        const t = scriptNow();
        if (end === null) return 0;
        if (t === null) return HSP_WINDOW_AHEAD_MS / 1000;
        return Math.max(0, (end - t) / 1000);
    }

    // The verified stop. Shared while one is on its way, as long as nothing
    // was set going since it began. Every call ends the play at once (the
    // window loop, the refills); a play anchored after the running stop
    // began (an edge released while a slow stop was out, a RESUME) gets a
    // stop of its own, sent now, and the older one hands its answer over to
    // it: its confirmation may describe the device before that play.
    // Resolves whether the device confirmed it is not playing (a stop, or
    // failing that a flush that emptied its buffer).
    function stop({ reason = 'stop', key: forKey = null } = {}) {
        const key = forKey || (session ? session.key : getKey());
        const appId = session ? session.appId : getAppId();
        const lastPlan = play ? play.lastPlan : null;
        epoch += 1;
        stopLoops();
        play = null;
        const running = stopJob;
        if (running && running.seq === motionSeq && running.key === key) return running.promise;
        if (!key) return Promise.resolve(true);
        if (motion === 'stopped' && !chase && !inFlight) return Promise.resolve(true);
        const owedSeconds = runsOutSeconds(lastPlan);
        const job = { seq: motionSeq, key, superseded: false, next: null, promise: null };
        if (running) {
            running.superseded = true;
            running.next = job;
        }
        const handOver = () => job.next.promise;
        job.promise = (async () => {
            const opts = { method: 'PUT', kind: 'stop', key, appId };
            const delays = [0].concat(T.stopRetryDelaysMs);
            let last = null;
            for (let i = 0; i < delays.length; i += 1) {
                if (delays[i] > 0) await sleep(delays[i]);
                if (job.superseded) return handOver();
                const { verdict } = await request('/hsp/stop', opts);
                if (job.superseded) return handOver();
                last = verdict;
                if (isHspStopConfirmed(verdict)) {
                    settled(key, job.seq);
                    return true;
                }
                if (verdict.notConnected) break;
            }
            for (let i = 0; i < T.flushAttempts; i += 1) {
                const { verdict } = await request('/hsp/flush', opts);
                if (job.superseded) return handOver();
                if (isHspFlushConfirmed(verdict)) {
                    settled(key, job.seq);
                    return true;
                }
                last = verdict;
                if (verdict.notConnected) break;
            }
            motion = 'unknown';
            const message = `Stop not confirmed: ${last ? last.message : 'no answer'}`;
            reportedUnconfirmed.add(key);
            call('onStopUnconfirmed', message, key, { runsOutSeconds: owedSeconds, reason });
            beginChase(key, appId, job.seq);
            return false;
        })();
        stopJob = job;
        job.promise.finally(() => { if (stopJob === job) stopJob = null; });
        return job.promise;
    }

    // A confirmed stop. It says the device is still only when nothing was
    // set going after that stop began.
    function settled(key, seq) {
        if (seq === motionSeq) motion = 'stopped';
        endChase();
        if (reportedUnconfirmed.delete(key)) call('onStopConfirmed', key);
    }

    // A play that may have reached the device after a stop: stopped again,
    // now.
    function restop() {
        motion = 'unknown';
        motionSeq += 1;
        stop({ reason: 'restop' });
    }

    function beginChase(key, appId, seq = motionSeq) {
        endChase();
        const job = { key, appId, seq, timer: null, startedAt: now(), active: true };
        chase = job;
        const round = async () => {
            job.timer = null;
            if (!job.active) return;
            const { verdict } = await request('/hsp/stop', { method: 'PUT', kind: 'stop', key, appId, count: false });
            if (!job.active) return;
            if (isHspStopConfirmed(verdict)) {
                settled(key, job.seq);
                return;
            }
            if (now() - job.startedAt + T.chaseMs > T.chaseWindowMs) {
                endChase();
                return;
            }
            job.timer = setTimer(round, T.chaseMs);
        };
        job.timer = setTimer(round, T.chaseMs);
    }

    function endChase() {
        if (!chase) return;
        chase.active = false;
        chase.timer = clear(chase.timer);
        chase = null;
    }

    // The page is going away (pagehide / freeze): a plain request would be
    // cancelled with the document, so the stop goes with keepalive and both
    // headers. Nobody reads its answer, so the motion is unknown afterwards.
    // Returns whether a stop was sent. Never throws.
    function stopOnUnload() {
        const key = session ? session.key : getKey();
        const appId = session ? session.appId : getAppId();
        if (!key) return false;
        if (!play && motion === 'stopped' && !chase && !stopJob && !inFlight) return false;
        epoch += 1;
        stopLoops();
        play = null;
        motion = 'unknown';
        try {
            budget.take('stop', now());
            const pending = fetchFn(`${base}/hsp/stop`, { method: 'PUT', headers: v3Headers(appId, key), keepalive: true });
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch (e) {
            return false;
        }
        return true;
    }

    // ---- release -----------------------------------------------------------------

    // The session is over (STOP, Reset) or the route goes back to HAMP:
    // after a confirmed stop, the device is put back in HAMP mode for the v2
    // driver, the event stream is closed and the HSP session forgotten.
    // Resolves whether it was released; a stop nobody confirmed keeps it,
    // and the stops keep going.
    async function release() {
        if (!session) {
            if (motion !== 'stopped' || chase) return stop({ reason: 'release' });
            return true;
        }
        const ok = await stop({ reason: 'release' });
        if (!ok || !session) return Boolean(ok && !session);
        const { key, appId } = session;
        expectingMode += 1;
        try {
            await request('/mode2', { method: 'PUT', body: modeBody(HANDY_V3_MODE.HAMP), kind: 'urgent', key, appId, count: false });
        } finally {
            expectingMode -= 1;
        }
        forget();
        return true;
    }

    function forget() {
        epoch += 1;
        stopLoops();
        play = null;
        session = null;
        closeSse();
        resyncTimer = clear(resyncTimer);
        if (unsubscribeFeed) {
            try { unsubscribeFeed(); } catch (e) {}
            unsubscribeFeed = null;
        }
        call('onStatus');
    }

    // ---- offline -----------------------------------------------------------------

    function goOffline(reason) {
        if (offline || !session) return;
        offline = true;
        const key = session.key;
        const appId = session.appId;
        const wasPlaying = play !== null || motion !== 'stopped';
        epoch += 1;
        stopLoops();
        play = null;
        session = null;
        closeSse();
        resyncTimer = clear(resyncTimer);
        if (wasPlaying) {
            motion = 'unknown';
            beginChase(key, appId);
        }
        call('onOffline', reason);
        call('onStatus');
    }

    // ---- events ------------------------------------------------------------------

    function openSse() {
        if (!session) return;
        if (sse && sse.key === session.key && sse.appId === session.appId) return;
        closeSse();
        const state = { key: session.key, appId: session.appId, source: null, open: false, pollTimer: null, reopenTimer: null };
        sse = state;
        if (typeof EventSourceCtor !== 'function') {
            startPoll(state);
            return;
        }
        let source;
        try {
            source = new EventSourceCtor(sseUrl(state.appId, state.key, HSP_SSE_EVENTS, base));
        } catch (e) {
            startPoll(state);
            return;
        }
        state.source = source;
        const listen = (name) => {
            try {
                source.addEventListener(name, (ev) => onSseMessage(state, name, ev && ev.data));
            } catch (e) {}
        };
        for (const name of HSP_SSE_EVENTS) listen(name);
        listen('message');
        source.onopen = () => {
            if (sse !== state) return;
            state.open = true;
            stopPoll(state);
        };
        source.onerror = () => {
            if (sse !== state) return;
            state.open = false;
            startPoll(state);
            // CLOSED: the browser will not retry by itself.
            if (source.readyState === 2 && !state.reopenTimer) {
                state.reopenTimer = setTimer(() => {
                    state.reopenTimer = null;
                    if (sse !== state || !session) return;
                    sse = null;
                    stopPoll(state);
                    openSse();
                }, T.sseReopenMs);
            }
        };
    }

    function closeSse() {
        if (!sse) return;
        const state = sse;
        sse = null;
        stopPoll(state);
        state.reopenTimer = clear(state.reopenTimer);
        if (state.source) {
            try { state.source.close(); } catch (e) {}
        }
    }

    // Without the event stream: GET /hsp/state every 5 s.
    function startPoll(state) {
        if (state.pollTimer) return;
        const loop = async () => {
            state.pollTimer = null;
            if (sse !== state || !session || state.open) return;
            const { verdict } = await request('/hsp/state');
            if (sse !== state || !session || state.open) return;
            if (verdict.ok && verdict.state) noteState(verdict.state);
            state.pollTimer = setTimer(loop, T.ssePollMs);
        };
        state.pollTimer = setTimer(loop, T.ssePollMs);
    }

    function stopPoll(state) {
        state.pollTimer = clear(state.pollTimer);
    }

    function onSseMessage(state, name, text) {
        if (sse !== state || !session) return;
        const msg = parseSseMessage(name, text);
        if (!msg || (msg.key && msg.key !== state.key)) return;
        const what = classifyHspEvent(msg, { modeSessionId: session.modeSessionId, expectingMode: expectingMode > 0 });
        switch (what.action) {
            case 'offline':
                goOffline(what.reason);
                break;
            case 'pause':
                if (msg.type === 'mode_changed') {
                    // Another app drives it now: our points are gone with
                    // the mode, and a stop to an HSP it no longer runs could
                    // only fail.
                    epoch += 1;
                    stopLoops();
                    play = null;
                    motion = 'stopped';
                    session = null;
                    closeSse();
                    call('onPause', what.reason, msg.type);
                    call('onStatus');
                    break;
                }
                call('onPause', msg.type === 'slider_blocked' ? describeDeviceStop(what.reason) : what.reason, msg.type);
                stop({ reason: msg.type });
                break;
            case 'stroke':
                checkStroke();
                break;
            case 'starving':
                if (play) onStarving();
                break;
            case 'log':
                call('onLog', msg.type, msg.data);
                break;
            default:
                break;
        }
    }

    // The stroke changed on the device (its buttons): a range the wearer
    // narrowed is kept; one wider than the envelope gets ours again.
    async function checkStroke() {
        if (!session) return;
        const { verdict } = await request('/slider/stroke');
        if (!verdict.ok || !session) return;
        if (compareStroke(verdict.result, session.window) === 'wider') {
            await request('/slider/stroke', { method: 'PUT', body: strokeBody(session.window), kind: 'urgent' });
        }
    }

    function startResyncTimer() {
        resyncTimer = clear(resyncTimer);
        const loop = async () => {
            resyncTimer = null;
            if (!session) return;
            await syncClock(HSP_RESYNC_SAMPLES);
            if (session) resyncTimer = setTimer(loop, T.resyncMs);
        };
        resyncTimer = setTimer(loop, T.resyncMs);
    }

    // The page came back from hidden or frozen: the clock estimate is
    // renewed, and a play under way is re-anchored on it.
    async function resync() {
        if (!session) return false;
        const est = await syncClock(HSP_RESYNC_SAMPLES);
        if (est && play) reanchor();
        return Boolean(est);
    }

    // ---- what the page asks --------------------------------------------------------

    return {
        // The Beat sync toggle, after the wearer's one-time consent (app.js).
        setBeatSync(on) {
            beatSync = Boolean(on);
            call('onStatus');
            return beatSync;
        },
        beatSync() {
            return beatSync;
        },
        verify,
        // The last check's word that beat sync is not possible on the Handy
        // connected now with the Application ID in use ({ code, reason }:
        // firmware below 4, no slider, the ID refused), or null. While it
        // stands, The Handy plays the script's rhythm (app.js).
        unavailable() {
            if (!notPossible || notPossible.key !== getKey() || notPossible.appId !== getAppId()) return null;
            return { code: notPossible.code, reason: notPossible.reason };
        },
        prepare,
        setWindow,
        dispatch,
        stop,
        // A page that died drove the Handy connected here over HSP (crash
        // recovery, handy.js onLinkedCrash). Its play is not this driver's,
        // so nothing here can vouch that it ended: unless this page's own
        // session is playing on it, a verified HSP stop goes out now.
        stopForeign(key) {
            if (!key) return Promise.resolve(false);
            if (session && session.key === key && play) {
                motion = 'unknown';
                return Promise.resolve(false);
            }
            motion = 'unknown';
            motionSeq += 1;
            return stop({ reason: 'crash', key });
        },
        stopOnUnload,
        release,
        resync,
        // Whether this driver owns the Handy behind `key` (the live key when
        // left out): between prepare() and release().
        owns(key) {
            if (!session) return false;
            return key === undefined ? session.key === getKey() : session.key === key;
        },
        // True while the slider may be moving because of this driver: a
        // script being played, a stop nobody confirmed, or one still being
        // chased.
        mayBeMoving() {
            return play !== null || motion !== 'stopped' || chase !== null || stopJob !== null;
        },
        isPlaying() {
            return play !== null;
        },
        // What the Script tab and the rhythm fallback read: the device's own
        // travel and top speed (null until verified) and the link's lead.
        status() {
            return {
                beatSync,
                verified: verified ? { key: verified.key, fw: verified.fw, travelMm: verified.travelMm, maxSpeedMmS: verified.maxSpeedMmS } : null,
                prepared: session !== null,
                playing: play !== null,
                holding: Boolean(play && play.holding),
                motion,
                rtdP95: sync ? sync.rtdP95 : null,
                lead: sync ? sync.lead : null,
                offline,
                budgetUsed: budget.used(now())
            };
        },
        deviceLimits() {
            return verified ? { travelMm: verified.travelMm, maxSpeedMmS: verified.maxSpeedMmS } : { travelMm: null, maxSpeedMmS: null };
        },
        // Test hooks.
        _plan() {
            return play ? play.lastPlan.slice() : null;
        },
        _forget: forget
    };
}
