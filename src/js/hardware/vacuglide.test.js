// Driver tests with a mocked global fetch standing in for Autoblow's cloud
// AND the device behind it. The simulated device applies every command the
// way the reference says the real one does and answers with its full state,
// so a test can ask what physically happened - how long a valve was open,
// whether the motor is running - and not only which calls went out. No
// network, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    VACUGLIDE_TIMINGS,
    VACUGLIDE_LIMITS,
    connectVacuglide,
    disconnectVacuglide,
    dispatchVacuglide,
    stopVacuglide,
    stopVacuglideOnUnload,
    pollVacuglideConnected,
    pulseValve,
    setVacuglideHandlers,
    isVacuglideConnected,
    getVacuglideToken,
    getVacuglideCluster,
    isVacuglideMoving,
    isVacuglideMotionUnknown,
    isVacuglideValveOpen,
    getValvePulse,
    isVacuglideOfflineStopPending,
    isVacuglideWatching,
    isVacuglideWatchPending,
    endVacuglideForTests,
    stopVacuglideAfterCrash,
    vacuglideStopChaseMs
} from './vacuglide.js';
import { createLiveSessionTracker, runCrashRecovery } from '../crash-recovery.js';
import { RATE_WINDOW_MS, RATE_CEILING, RATE_RESERVE, RATE_WATCH_RESERVE, MAX_VALVE_OPENS_PER_WINDOW, rateLogStorageKey } from './vacuglide-protocol.js';

// The timings the driver ships with, before any test shortens them.
const SHIPPED_TIMINGS = { ...VACUGLIDE_TIMINGS };

const LATENCY = 'https://latency.autoblowapi.com';
const CLUSTER = 'https://eu-central-1.autoblowapi.com';
const OTHER_CLUSTER = 'https://us-east-2.autoblowapi.com';

let TOKEN = '';
let tokenCounter = 0;
let calls = [];
let routes = {};
let device = null;
// token -> another device behind the same cloud, for the tests that need a
// second one. Empty unless a test adds one.
let otherDevices = new Map();
const deviceFor = (token) => otherDevices.get(token) || device;
let errors = [];
let offline = [];
let unconfirmed = [];
// The device each unconfirmed stop named, and each whole stop confirmed.
let unconfirmedTokens = [];
let stopConfirmed = [];
let notices = [];
let pulses = [];
// What onValves said: null for a repaint, a sentence when a valve was
// found open and closed.
let valveNotes = [];
// What onLateStop said: a device EdgeLoop had let go of was found moving
// on a command that landed late, and stopped again.
let lateStops = [];
// What onStoppedElsewhere said: the connected device was found stopped
// under the session by something other than this page.
let stoppedElsewhere = [];
// Speeds a test is holding back in the cloud (holdNextSpeed). The cleanup
// fails any still held, so no watch outlives its test.
let heldSpeeds = [];
let sessionActive = false;
// Autoblow's own limiter, when a test turns it on: this many requests per
// token and host in a fixed 60 s window that resets all at once, as
// measured against the live API. A request over it is refused with 429 and
// never reaches the device.
let serverLimit = null;
let serverWindows = new Map();

// The device behind the cloud: its state, the cluster it is on, whether it
// is online, and a timeline of everything that changed.
function makeDevice() {
    return {
        online: true,
        cluster: CLUSTER,
        clusterReply: null,
        deviceType: 'vacuglide',
        operationalMode: 'ONLINE_CONNECTED',
        targetSpeed: 0,
        strokePlusValve: false,
        strokeMinusValve: false,
        events: []
    };
}

function stateOf(d) {
    return {
        operationalMode: d.operationalMode,
        localScript: 11,
        targetSpeed: d.targetSpeed,
        strokePlusValve: d.strokePlusValve,
        strokeMinusValve: d.strokeMinusValve,
        syncScriptCurrentTime: 0,
        syncScriptOffsetTime: 0,
        syncScriptToken: '',
        syncScriptLoop: false
    };
}

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const NOT_CONNECTED = () => jsonResponse({ error: { code: 'DeviceNotConnectedError', message: 'Device not connected' } }, 502);

// What Autoblow's cloud and the device do with one request. Each token
// drives its own device: the one every test uses, or one a test added.
function deviceRoute({ host, path, method, body, token }) {
    const d = deviceFor(token);
    if (method === 'GET' && path === '/vacuglide/connected') {
        if (!d.online) return jsonResponse({ connected: false });
        return jsonResponse({ connected: true, cluster: d.clusterReply ?? d.cluster.replace('https://', ''), deviceType: d.deviceType });
    }
    if (!d.online || host !== d.cluster) return NOT_CONNECTED();
    const at = Date.now();
    if (method === 'GET' && path === '/vacuglide/info') {
        return jsonResponse({ firmwareStatus: 'UP_TO_DATE', firmwareVersion: 1.01, firmwareBranch: 'prod', hardwareVersion: 'vacuglide', mac: 'aabbccddeeff', deviceType: d.deviceType });
    }
    if (method === 'GET' && path === '/vacuglide/state') return jsonResponse(stateOf(d));
    if (method === 'PUT' && path === '/vacuglide/target-speed') {
        if (!body || typeof body.targetSpeed !== 'number' || body.targetSpeed < 0 || body.targetSpeed > 100) {
            return jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: 'body/targetSpeed must be <= 100' } }, 400);
        }
        d.operationalMode = 'TARGET_SPEED_PLAYING';
        d.targetSpeed = body.targetSpeed;
        d.events.push({ at, what: 'speed', value: body.targetSpeed });
        return jsonResponse(stateOf(d));
    }
    if (method === 'PUT' && path === '/vacuglide/target-speed/stop') {
        d.operationalMode = 'TARGET_SPEED_PAUSED';
        d.events.push({ at, what: 'stop' });
        return jsonResponse(stateOf(d));
    }
    const valve = path === '/vacuglide/valve/stroke-plus' ? 'plus' : (path === '/vacuglide/valve/stroke-minus' ? 'minus' : null);
    if (method === 'PUT' && valve) {
        if (!body || typeof body.valveState !== 'boolean') {
            return jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: 'body/valveState must be boolean' } }, 400);
        }
        if (valve === 'plus') d.strokePlusValve = body.valveState;
        else d.strokeMinusValve = body.valveState;
        d.events.push({ at, what: 'valve', valve, open: body.valveState });
        return jsonResponse(stateOf(d));
    }
    return jsonResponse({ error: { code: 'NotFound', message: 'Not found' } }, 404);
}

function overServerLimit(call) {
    if (serverLimit === null) return false;
    const key = `${call.token}|${call.host}`;
    let span = serverWindows.get(key);
    if (!span || call.at - span.start >= 60000) {
        span = { start: call.at, count: 0 };
        serverWindows.set(key, span);
    }
    span.count += 1;
    return span.count > serverLimit;
}

// window.localStorage, for the tests that need one. Every page a test loads
// shares it, as every tab of one origin does. A page that went away (goAway)
// writes nothing more to it: a document that is gone runs nothing, while
// here its promises and timers still would.
function memoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { if (!gonePages.has(callerPage())) map.set(key, String(value)); },
        removeItem: (key) => { if (!gonePages.has(callerPage())) map.delete(key); },
        map
    };
}

// Another page in the same browser: a fresh copy of the driver module, with
// its own state and its own page id, sharing fetch and localStorage with the
// first - what a reload, or a second tab, is to the driver. Loading it does
// what loading EdgeLoop does in a browser: once the handlers below are in
// place, it takes over whatever a page that went away left, as a host page
// does once app.js has attached it (`takeOver: false` is a page that loaded
// before anything was left). The tests of the page's own life attach their
// pages instead, as app.js does (openPage).
let pageCounter = 0;
// The copies a test loaded, so the cleanup can end what each still runs.
let pagesLoaded = [];
async function loadAnotherPage({ takeOver = true } = {}) {
    pageCounter += 1;
    const id = pageCounter;
    const driver = await import(`./vacuglide.js?page=${id}`);
    pagesLoaded.push(driver);
    const seen = { errors: [], offline: [], unconfirmed: [], notices: [], lateStops: [], takeovers: [] };
    driver.setVacuglideHandlers({
        onError: (m) => seen.errors.push(m),
        onOffline: (reason, label) => seen.offline.push({ reason, label }),
        onStopUnconfirmed: (m) => seen.unconfirmed.push(m),
        onNotice: (m) => seen.notices.push(m),
        onLateStop: (m) => seen.lateStops.push(m),
        onTakeover: (message, active) => seen.takeovers.push({ message, active }),
        isSessionActive: () => false
    });
    Object.assign(driver.VACUGLIDE_TIMINGS, VACUGLIDE_TIMINGS);
    Object.assign(driver.VACUGLIDE_LIMITS, VACUGLIDE_LIMITS);
    if (takeOver) driver.takeOverVacuglideHandover();
    return { id, driver, seen };
}

// Which page a request came from: the copies loadAnotherPage() makes are
// told apart by their module URL, and 0 is the copy every other test drives.
function callerPage() {
    const match = /vacuglide\.js\?page=(\d+)/.exec(new Error().stack || '');
    return match ? Number(match[1]) : 0;
}

// Pages that went away (goAway). A document that is gone runs nothing, so
// nothing it would still have sent reaches the cloud: only what it sent
// with keepalive on its way out does. Never cleared: a page gone in one test
// stays gone in the next.
const gonePages = new Set();

function installFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const page = callerPage();
        // Neither sent nor answered, and never recorded among the calls.
        if (init.keepalive !== true && gonePages.has(page)) return new Promise(() => {});
        const parsed = new URL(url);
        const host = `${parsed.protocol}//${parsed.host}`;
        const path = parsed.pathname;
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        const headers = init.headers || {};
        const call = {
            host,
            path,
            method,
            body,
            token: headers['x-device-token'],
            contentType: headers['Content-Type'],
            keepalive: init.keepalive === true,
            // The page that sent it: 0 for the copy every other test drives.
            page,
            at: Date.now()
        };
        calls.push(call);
        const handler = routes[`${method} ${path}`] || routes[path];
        let result;
        if (overServerLimit(call)) result = jsonResponse(null, 429);
        else if (typeof handler === 'function') result = handler({ ...call, next: () => deviceRoute(call) });
        else if (handler === undefined) result = deviceRoute(call);
        else result = handler;
        // The status each request was answered with, once it is.
        Promise.resolve(result).then((r) => { if (r && typeof r.status === 'number') call.status = r.status; }, () => {});
        if (init.signal) {
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (init.signal.aborted) return onAbort();
                init.signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve(result).then(resolve, reject);
            });
        }
        return result;
    };
}

function tick(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await tick(5);
    }
}

async function connectOk() {
    const result = await connectVacuglide(TOKEN);
    calls = [];
    device.events = [];
    return result;
}

const sent = (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method));
const commandCalls = () => calls.filter((c) => c.path !== '/vacuglide/connected');

// How long `valve` was open on the device, from the timeline: [openAt, closeAt] pairs.
function openSpans(valve) {
    const spans = [];
    let openedAt = null;
    for (const e of device.events) {
        if (e.what !== 'valve' || e.valve !== valve) continue;
        if (e.open && openedAt === null) openedAt = e.at;
        else if (!e.open && openedAt !== null) {
            spans.push([openedAt, e.at]);
            openedAt = null;
        }
    }
    if (openedAt !== null) spans.push([openedAt, null]);
    return spans;
}

// The order the device took `valve`'s commands in: 'open' / 'close'.
function valveTimeline(valve) {
    return device.events.filter((e) => e.what === 'valve' && e.valve === valve).map((e) => (e.open ? 'open' : 'close'));
}

// The VacuGlide panel as app.js paints it, from app.js's own text: its
// handlers for the driver, and the bookkeeping beside them, run against a
// stand-in for the page - the badge, the status line and the banner's
// reports by source. app.js itself cannot be loaded here (it needs the page),
// so the stretch of it that holds them is run as it stands.
function appVacuglidePanel({ badge = 'VacuGlide', status = 'Connected (fw 1.01)', onAlert = null } = {}) {
    const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
    const from = src.indexOf('const vacuglideStopsOwed = new Map();');
    const call = src.indexOf('setVacuglideHandlers({', from);
    const to = src.indexOf('\n});', call) + 4;
    assert.ok(from > 0 && call > from && to > call, 'the VacuGlide panel code in app.js');
    const els = {
        badgeVacuglideText: { textContent: badge },
        modalVacuglideMsg: { textContent: `Status: ${status}` }
    };
    const banner = new Map();
    let handlers = null;
    const env = {
        document: { getElementById: (id) => els[id] || null },
        state: { sessionStatus: 'IDLE' },
        vacuglideConnectedLabel: 'Connected (fw 1.01)',
        isVacuglideConnected,
        setVacuglideStatus: (text) => { els.modalVacuglideMsg.textContent = `Status: ${text}`; },
        setBadgeState: (type, tone, label) => { els.badgeVacuglideText.textContent = label; },
        paintVacuglideButtons: () => {},
        renderVacuglideValves: () => {},
        setVacuglideValveMessage: () => {},
        triggerDisconnectAlert: (text, source) => {
            banner.set(source, text);
            if (typeof onAlert === 'function') onAlert(source);
        },
        reviseAlertBanner: (text, { source }) => { if (banner.has(source)) banner.set(source, text); },
        hideAlertBanner: (source) => { banner.delete(source); },
        setVacuglideHandlers: (h) => { handlers = h; }
    };
    new Function('env', `with (env) {\n${src.slice(from, to)}\n}`)(env);
    return {
        handlers,
        badge: () => els.badgeVacuglideText.textContent,
        status: () => els.modalVacuglideMsg.textContent,
        banner
    };
}

describe('vacuglide driver', () => {
    beforeEach(() => {
        tokenCounter += 1;
        // A fresh token per test: the request budget is kept per token.
        TOKEN = `tok${tokenCounter}x${Date.now().toString(36)}`;
        calls = [];
        routes = {};
        device = makeDevice();
        otherDevices = new Map();
        errors = [];
        offline = [];
        unconfirmed = [];
        unconfirmedTokens = [];
        stopConfirmed = [];
        notices = [];
        pulses = [];
        valveNotes = [];
        lateStops = [];
        stoppedElsewhere = [];
        heldSpeeds = [];
        sessionActive = false;
        serverLimit = null;
        serverWindows = new Map();
        // Short waits keep the suite fast; every attempt count is unchanged.
        VACUGLIDE_TIMINGS.requestTimeoutMs = 6000;
        VACUGLIDE_TIMINGS.stopRetryDelaysMs = [5, 10, 20];
        VACUGLIDE_TIMINGS.offlineStopRetryMs = 60;
        VACUGLIDE_TIMINGS.pollActiveMs = 100000;
        VACUGLIDE_TIMINGS.pollIdleMs = 100000;
        VACUGLIDE_TIMINGS.steadyReadMs = 100000;
        VACUGLIDE_TIMINGS.readBeforeSpeedWaitMs = 1000;
        VACUGLIDE_TIMINGS.speedGapMs = 40;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 60;
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 1000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 200;
        VACUGLIDE_TIMINGS.stopLandsWithinMs = 1000;
        VACUGLIDE_TIMINGS.serverRefusalBackoffMs = 10000;
        VACUGLIDE_LIMITS.windowMs = RATE_WINDOW_MS;
        VACUGLIDE_LIMITS.ceiling = RATE_CEILING;
        VACUGLIDE_LIMITS.reserve = RATE_RESERVE;
        VACUGLIDE_LIMITS.watchReserve = RATE_WATCH_RESERVE;
        VACUGLIDE_LIMITS.maxOpens = MAX_VALVE_OPENS_PER_WINDOW;
        installFetch();
        setVacuglideHandlers({
            onError: (m) => errors.push(m),
            onOffline: (reason, label) => offline.push({ reason, label }),
            onStopUnconfirmed: (m, token) => {
                unconfirmed.push(m);
                unconfirmedTokens.push(token);
            },
            onStopConfirmed: (token) => stopConfirmed.push(token),
            onNotice: (m) => notices.push(m),
            onPulse: (p) => pulses.push(p),
            onValves: (m) => valveNotes.push(m),
            onLateStop: (m) => lateStops.push(m),
            onStoppedElsewhere: (m) => stoppedElsewhere.push(m),
            isSessionActive: () => sessionActive
        });
    });

    afterEach(async () => {
        // Leave nothing running into the next test: the device answers again,
        // any pulse finishes, and any background stop confirms and ends. A
        // watch runs to the end of its window whatever happens meanwhile -
        // twenty seconds and more for a speed a test held back - so it is
        // ended here, as closing the page would end it.
        delete globalThis.localStorage;
        serverLimit = null;
        routes = {};
        device.online = true;
        for (const held of heldSpeeds) held.fail();
        await waitFor(() => getValvePulse() === null, 20000, 'the pulse to finish');
        await disconnectVacuglide();
        await waitFor(() => !isVacuglideOfflineStopPending(), 5000, 'the background stop to end');
        endVacuglideForTests();
        for (const driver of pagesLoaded) driver.endVacuglideForTests();
        pagesLoaded = [];
        await tick(30);
    });

    // ---- discovery and connect ----------------------------------------------------------

    // The beat and the windows the README and the panel state: a watched
    // device is read every 2 s; a stop has one read beat to land before a
    // device seen still moving past it raises the alarm; and a command
    // EdgeLoop gave up on is watched for a minute after its request timed
    // out. Every other test runs on shorter ones.
    it('ships a 2 s read beat, a stop given one beat to land, and a minute of watching after a 6 s request timeout', () => {
        assert.equal(SHIPPED_TIMINGS.lateCommandWatchBeatMs, 2000);
        assert.equal(SHIPPED_TIMINGS.stopLandsWithinMs, SHIPPED_TIMINGS.lateCommandWatchBeatMs);
        assert.equal(SHIPPED_TIMINGS.lateCommandWatchMs, 60000);
        assert.equal(SHIPPED_TIMINGS.requestTimeoutMs, 6000);
    });

    it('finds the device through the latency router, then talks only to the cluster it named', async () => {
        const result = await connectVacuglide(`  ${TOKEN} `);
        assert.equal(calls[0].host, LATENCY);
        assert.equal(calls[0].path, '/vacuglide/connected');
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].contentType, undefined, 'a request without a body sends no Content-Type');
        assert.ok(calls.every((c) => c.token === TOKEN), 'every request carries the trimmed token in x-device-token');
        const afterDiscovery = calls.slice(1);
        assert.ok(afterDiscovery.length >= 4);
        assert.ok(afterDiscovery.every((c) => c.host === CLUSTER), JSON.stringify(afterDiscovery.map((c) => c.host)));
        assert.deepEqual(afterDiscovery.map((c) => `${c.method} ${c.path}`).sort(), [
            'GET /vacuglide/info',
            'PUT /vacuglide/target-speed/stop',
            'PUT /vacuglide/valve/stroke-minus',
            'PUT /vacuglide/valve/stroke-plus'
        ]);
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus')[0].body, { valveState: false });
        assert.deepEqual(sent('/vacuglide/valve/stroke-minus')[0].body, { valveState: false });
        assert.equal(sent('/vacuglide/target-speed/stop')[0].body, undefined);
        assert.equal(result.description, 'fw 1.01');
        assert.equal(result.battery, null, 'the API reports no battery');
        assert.equal(result.cluster, CLUSTER);
        assert.ok(!JSON.stringify(result).includes('aabbccddeeff'), 'the MAC is not kept');
        assert.equal(isVacuglideConnected(), true);
        assert.equal(getVacuglideToken(), TOKEN);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED', 'connect brings the device to rest');
    });

    it('accepts a cluster named as a full URL, as earlier replies did', async () => {
        device.clusterReply = 'https://eu-central-1.autoblowapi.com/';
        await connectOk();
        assert.equal(getVacuglideCluster(), CLUSTER);
    });

    it('refuses a device that is not online, with nothing connected and no command sent', async () => {
        device.online = false;
        await assert.rejects(connectVacuglide(TOKEN), /not online.*online mode.*mistyped token/s);
        assert.equal(isVacuglideConnected(), false);
        assert.deepEqual(calls.map((c) => c.path), ['/vacuglide/connected']);
    });

    it('never sends the token to a cluster outside autoblowapi.com', async () => {
        device.clusterReply = 'collector.evil.example';
        await assert.rejects(connectVacuglide(TOKEN), /does not recognise/);
        assert.ok(calls.every((c) => c.host === LATENCY), JSON.stringify(calls.map((c) => c.host)));
        assert.equal(isVacuglideConnected(), false);
    });

    it('refuses a token that belongs to another Autoblow device', async () => {
        device.deviceType = 'autoblow-ultra';
        await assert.rejects(connectVacuglide(TOKEN), /AI Ultra, not a VacuGlide/);
        assert.equal(isVacuglideConnected(), false);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0, 'nothing is sent to a device this driver does not drive');
    });

    it('refuses a token that cannot be one before anything is sent', async () => {
        for (const bad of ['', '   ', 'has space', 'line\nbreak', 'x'.repeat(129)]) {
            await assert.rejects(connectVacuglide(bad), /not a device token/);
        }
        assert.equal(calls.length, 0);
    });

    it('says a missing or malformed request was refused rather than that the server is unreachable', async () => {
        routes['GET /vacuglide/connected'] = jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: "headers must have required property 'x-device-token'" } }, 400);
        await assert.rejects(connectVacuglide(TOKEN), /refused the request.*x-device-token/);
    });

    it('says the server could not be reached on a network error', async () => {
        routes['GET /vacuglide/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(connectVacuglide(TOKEN), /Could not reach Autoblow's server/);
    });

    it('says the token hit its limit on a 429 at connect', async () => {
        routes['GET /vacuglide/connected'] = jsonResponse(null, 429);
        await assert.rejects(connectVacuglide(TOKEN), /request limit/);
    });

    it('still connects when /info fails, without a firmware line', async () => {
        routes['GET /vacuglide/info'] = jsonResponse(null, 500);
        const result = await connectVacuglide(TOKEN);
        assert.equal(result.description, '');
        assert.equal(isVacuglideConnected(), true);
    });

    it('refuses when the device drops out of online mode during connect', async () => {
        routes['GET /vacuglide/info'] = () => NOT_CONNECTED();
        await assert.rejects(connectVacuglide(TOKEN), /dropped out of online mode/);
        assert.equal(isVacuglideConnected(), false);
    });

    it('refuses a device that will not confirm it is at rest', async () => {
        routes['PUT /vacuglide/valve/stroke-minus'] = jsonResponse(null, 500);
        await assert.rejects(connectVacuglide(TOKEN), /did not confirm that its motor stopped and both valves closed/);
        assert.equal(isVacuglideConnected(), false);
        assert.equal(sent('/vacuglide/valve/stroke-minus').length, 4, 'four attempts before giving up');
    });

    it('refuses a device that reports a fault, and says which', async () => {
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            next();
            device.operationalMode = 'ERROR_MOTOR_STUCK';
            return jsonResponse(stateOf(device));
        };
        await assert.rejects(connectVacuglide(TOKEN), /stopped its motor because it is stuck/);
        assert.equal(isVacuglideConnected(), false);
    });

    it('connects one device at a time', async () => {
        await connectOk();
        await assert.rejects(connectVacuglide(TOKEN), /already connected/);
        assert.equal(calls.length, 0);
    });

    it('a Disconnect pressed while connecting leaves nothing connected', async () => {
        let release;
        routes['GET /vacuglide/info'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        const pending = connectVacuglide(TOKEN);
        await tick(5);
        await disconnectVacuglide();
        release();
        await assert.rejects(pending, /Disconnect was pressed/);
        assert.equal(isVacuglideConnected(), false);
    });

    // ---- speed ---------------------------------------------------------------------------

    it('sends the speed to the cluster as targetSpeed and nothing else', async () => {
        await connectOk();
        dispatchVacuglide(55);
        await tick(5);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.host}${c.path}`), [`PUT ${CLUSTER}/vacuglide/target-speed`]);
        assert.deepEqual(calls[0].body, { targetSpeed: 55 });
        assert.equal(calls[0].contentType, 'application/json');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.equal(device.targetSpeed, 55);
        assert.equal(isVacuglideMoving(), true);
        assert.ok(!calls.some((c) => /valve/.test(c.path)), 'driving the speed never touches a valve');
    });

    it('sends the speed only when it changes', async () => {
        await connectOk();
        dispatchVacuglide(55);
        await tick(60);
        dispatchVacuglide(55);
        dispatchVacuglide(55.3);
        await tick(60);
        assert.equal(sent('/vacuglide/target-speed').length, 1);
    });

    it('sends at most one speed per gap, and the last one asked for arrives', async () => {
        // A gap far longer than anything between two lines of this test, so
        // a busy machine cannot make the second speed look early.
        VACUGLIDE_TIMINGS.speedGapMs = 300;
        await connectOk();
        dispatchVacuglide(30);
        await tick(2);
        dispatchVacuglide(40);
        dispatchVacuglide(50);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [30], 'the next speed waits for the gap');
        await waitFor(() => sent('/vacuglide/target-speed').length === 2, 3000, 'the second speed');
        const speeds = sent('/vacuglide/target-speed');
        assert.deepEqual(speeds.map((c) => c.body.targetSpeed), [30, 50], 'the intermediate value is dropped, the latest is sent');
        // The driver times the gap from just before its fetch call, the mock
        // from inside it: they can straddle a millisecond boundary.
        assert.ok(speeds[1].at - speeds[0].at >= VACUGLIDE_TIMINGS.speedGapMs - 2, `gap was ${speeds[1].at - speeds[0].at} ms`);
        assert.equal(device.targetSpeed, 50);
    });

    it('never has two speeds in flight, so they cannot land out of order', async () => {
        await connectOk();
        let release;
        routes['PUT /vacuglide/target-speed'] = ({ next, body }) => (body.targetSpeed === 30
            ? new Promise((resolve) => { release = () => resolve(next()); })
            : next());
        dispatchVacuglide(30);
        await tick(60);
        dispatchVacuglide(70);
        await tick(60);
        assert.equal(sent('/vacuglide/target-speed').length, 1, 'the second speed waits for the first');
        release();
        await tick(60);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [30, 70]);
        assert.equal(device.targetSpeed, 70);
    });

    // The page keeps one banner report per device that owes a confirmed
    // stop, and takes it down when a whole stop of that device is confirmed.
    it('names the device in every unconfirmed stop, and says when a whole stop of it is confirmed', async () => {
        await connectOk();
        assert.deepEqual(stopConfirmed, [TOKEN], 'connecting confirms a whole stop');
        stopConfirmed = [];
        dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50, 1000, 'the speed');
        routes['PUT /vacuglide/target-speed/stop'] = () => jsonResponse({ error: { code: 'Error', message: 'Internal error' } }, 500);
        dispatchVacuglide(0, true);
        await waitFor(() => unconfirmed.length >= 1, 3000, 'the alarm');
        assert.equal(unconfirmedTokens[0], TOKEN);
        assert.deepEqual(stopConfirmed, [], 'nothing confirmed');
        delete routes['PUT /vacuglide/target-speed/stop'];
        dispatchVacuglide(0, true);
        await waitFor(() => stopConfirmed.length === 1, 3000, 'the confirmation');
        assert.deepEqual(stopConfirmed, [TOKEN]);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    // tick-dispatch.js sends a decision urgent when a guard engaged in its
    // tick, when it cuts a moving primary to 0, or when Force Orgasm's time
    // limit hands the run to its landing: every toy takes it in that tick.
    it('an urgent speed - a guard, a landing - goes at once instead of a gap after the last one', async () => {
        VACUGLIDE_TIMINGS.speedGapMs = 300;
        await connectOk();
        dispatchVacuglide(80);
        await waitFor(() => device.targetSpeed === 80, 1000, 'the first speed');
        dispatchVacuglide(70);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed').length, 1, 'an ordinary speed waits for the gap');
        dispatchVacuglide(18, false, { urgent: true });
        await waitFor(() => device.targetSpeed === 18, 200, 'the urgent speed');
        const speeds = sent('/vacuglide/target-speed');
        assert.deepEqual(speeds.map((c) => c.body.targetSpeed), [80, 18], 'the speed it replaced never goes');
        assert.ok(speeds[1].at - speeds[0].at < 250, `sent ${speeds[1].at - speeds[0].at} ms after the last one`);
        // It is an edge: what follows it waits a gap again.
        dispatchVacuglide(19);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed').length, 2);
        await waitFor(() => device.targetSpeed === 19, 1000, 'the next speed, a gap later');
    });

    it('an urgent speed still waits for the speed in flight, so the two cannot land out of order', async () => {
        await connectOk();
        let release;
        routes['PUT /vacuglide/target-speed'] = ({ next, body }) => (body.targetSpeed === 90
            ? new Promise((resolve) => { release = () => resolve(next()); })
            : next());
        dispatchVacuglide(90);
        await tick(20);
        dispatchVacuglide(15, false, { urgent: true });
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed').length, 1, 'one request at a time');
        release();
        await waitFor(() => device.targetSpeed === 15, 500, 'the urgent speed, the moment the one before it is answered');
        assert.deepEqual(device.events.filter((e) => e.what === 'speed').map((e) => e.value), [90, 15]);
    });

    it('an urgent speed is routine traffic: it never spends the reserve kept for a stop', async () => {
        VACUGLIDE_LIMITS.ceiling = 13;
        VACUGLIDE_LIMITS.reserve = 7;
        VACUGLIDE_LIMITS.watchReserve = 0;
        await connectOk();
        // connect spent 5, and this speed fills the routine budget.
        dispatchVacuglide(20);
        await tick(60);
        dispatchVacuglide(30, false, { urgent: true });
        await tick(60);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [20], 'held back by the budget like any speed');
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(calls.filter((c) => c.method === 'PUT' && /stop|valve/.test(c.path)).length, 3, 'the whole stop still goes, from the reserve');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('zero stops the motor AND closes both valves, and reads as stopped only once confirmed', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        let release;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        dispatchVacuglide(0);
        await tick(5);
        assert.deepEqual(calls.slice(1).map((c) => c.path).sort(), [
            '/vacuglide/target-speed/stop',
            '/vacuglide/valve/stroke-minus',
            '/vacuglide/valve/stroke-plus'
        ]);
        assert.equal(isVacuglideMoving(), true, 'not stopped before the API confirms');
        release();
        await tick(5);
        assert.equal(isVacuglideMoving(), false);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
    });

    it('an idle zero tick sends nothing, and a forced zero (STOP) always sends the whole stop', async () => {
        await connectOk();
        dispatchVacuglide(0);
        dispatchVacuglide(0);
        await tick(5);
        assert.equal(calls.length, 0);
        dispatchVacuglide(0, true);
        await tick(5);
        assert.equal(calls.length, 3);
    });

    it('re-sends the same speed after a stop, so a resumed session moves again', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        dispatchVacuglide(0, true);
        await tick(20);
        dispatchVacuglide(50);
        await tick(60);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [50, 50]);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
    });

    it('a speed asked for while a stop is out follows the stop instead of racing it', async () => {
        await connectOk();
        // A slow stop that lands within a read beat: nothing reads the device.
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 1000;
        dispatchVacuglide(50);
        await tick(60);
        let release;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        dispatchVacuglide(0, true);
        await tick(5);
        dispatchVacuglide(40);
        await tick(60);
        assert.equal(sent('/vacuglide/target-speed').length, 1, 'no speed while the stop is unanswered');
        release();
        await tick(60);
        const order = calls.filter((c) => /target-speed/.test(c.path)).map((c) => c.path);
        assert.deepEqual(order.slice(-2), ['/vacuglide/target-speed/stop', '/vacuglide/target-speed']);
        assert.equal(device.targetSpeed, 40);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
    });

    it('a speed that lands after a stop is followed by another stop', async () => {
        await connectOk();
        let release;
        routes['PUT /vacuglide/target-speed'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        dispatchVacuglide(50);
        await tick(5);
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        release();
        await tick(40);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 2, 'the relay may have delivered the speed after the stop');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(isVacuglideMoving(), false);
    });

    it('retries a stop that is not confirmed, and says so when it never is', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        let attempts = 0;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            attempts += 1;
            return attempts < 3 ? jsonResponse(null, 500) : next();
        };
        assert.equal(await stopVacuglide(), true);
        assert.equal(attempts, 3);
        assert.equal(isVacuglideMoving(), false);
        routes['PUT /vacuglide/target-speed/stop'] = jsonResponse(null, 500);
        dispatchVacuglide(60);
        await tick(60);
        assert.equal(await stopVacuglide(), false);
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /Stop not confirmed/);
        assert.equal(isVacuglideMoving(), true, 'an unconfirmed stop leaves the motor flagged');
    });

    it('does not take a 2xx that still reports the motor running as a stop', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        let lying = 2;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (lying > 0) {
                lying -= 1;
                return jsonResponse(stateOf(device));
            }
            return next();
        };
        assert.equal(await stopVacuglide(), true);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 3);
    });

    it('does not take a 2xx that still reports a valve open as a close', async () => {
        await connectOk();
        device.strokePlusValve = true;
        let lying = 1;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next }) => {
            if (lying > 0) {
                lying -= 1;
                return jsonResponse(stateOf(device));
            }
            return next();
        };
        assert.equal(await stopVacuglide(), true);
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 2);
        assert.equal(device.strokePlusValve, false);
    });

    it('a speed that timed out leaves the motor unknown, so the next idle tick stops it', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /vacuglide/target-speed'] = () => new Promise(() => {});
        dispatchVacuglide(50);
        await tick(80);
        assert.equal(isVacuglideMotionUnknown(), true);
        assert.ok(errors.some((m) => m && /timed out/.test(m)));
        routes['PUT /vacuglide/target-speed'] = undefined;
        dispatchVacuglide(0);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        assert.equal(isVacuglideMotionUnknown(), false);
    });

    // ---- valves ------------------------------------------------------------------------------

    it('a press opens one valve for the pulse and closes it, confirmed', async () => {
        await connectOk();
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, true);
        const valveCalls = calls.filter((c) => /valve/.test(c.path));
        assert.deepEqual(valveCalls.map((c) => [c.path, c.body.valveState]), [
            ['/vacuglide/valve/stroke-plus', true],
            ['/vacuglide/valve/stroke-plus', false]
        ]);
        assert.ok(valveCalls.every((c) => c.host === CLUSTER && c.token === TOKEN && c.contentType === 'application/json'));
        const spans = openSpans('plus');
        assert.equal(spans.length, 1);
        const open = spans[0][1] - spans[0][0];
        // About the pulse. The bounds leave room for a busy test machine -
        // node times a timer from a clock cached at the start of each turn of
        // its loop, so it can fire early as well as late - and still rule out
        // a close that went out at once, or one that waited for anything.
        assert.ok(open >= 200 && open < 600, `open for ${open} ms`);
        assert.equal(device.strokePlusValve, false);
        assert.equal(isVacuglideValveOpen('plus'), false);
        assert.deepEqual(pulses.map((p) => p.stage), ['opening', 'open', 'closing', 'idle']);
        assert.equal(openSpans('minus').length, 0, 'the other valve is never touched');
    });

    it('presses during a pulse are refused, and cannot stretch the open', async () => {
        await connectOk();
        // A pulse long enough that the presses below fall inside it however
        // late a busy machine runs their timers.
        const first = pulseValve('minus', 1000);
        await tick(20);
        const again = await pulseValve('minus', 300);
        const other = await pulseValve('plus', 300);
        await tick(100);
        const later = await pulseValve('minus', 2000);
        assert.equal(again.reason, 'busy');
        assert.equal(other.reason, 'busy', 'one valve at a time');
        assert.equal(later.reason, 'busy');
        assert.equal((await first).ok, true);
        const spans = openSpans('minus');
        assert.equal(spans.length, 1);
        // A press that stacked would have held it open for the 2 s one asked
        // for, from 120 ms in: more than 2.1 s in all.
        assert.ok(spans[0][1] - spans[0][0] < 1900, `open for ${spans[0][1] - spans[0][0]} ms`);
        assert.equal(sent('/vacuglide/valve/stroke-minus').filter((c) => c.body.valveState === true).length, 1);
        assert.equal(openSpans('plus').length, 0);
    });

    it('a press asking for a long open still closes within the two-second ceiling', async () => {
        await connectOk();
        const result = await pulseValve('plus', 60000);
        assert.equal(result.ok, true);
        const [[openedAt, closedAt]] = openSpans('plus');
        assert.ok(closedAt - openedAt < 2600, `open for ${closedAt - openedAt} ms`);
        assert.ok(closedAt - openedAt >= 1800, `open for ${closedAt - openedAt} ms`);
    });

    it('keeps sending the close until the device confirms it', async () => {
        await connectOk();
        let attempts = 0;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState === false) {
                attempts += 1;
                if (attempts < 3) return jsonResponse(null, 503);
            }
            return next();
        };
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, true);
        assert.equal(attempts, 3);
        assert.equal(device.strokePlusValve, false);
    });

    it('a close that is never confirmed raises the alarm, and the next idle tick sends the whole stop', async () => {
        await connectOk();
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === false ? jsonResponse(null, 503) : next());
        const result = await pulseValve('plus', 300);
        assert.equal(result.reason, 'close-unconfirmed');
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /Closing Valve \+ \(stroke plus\) not confirmed/);
        assert.equal(isVacuglideValveOpen('plus'), true, 'a close nobody confirmed is not a closed valve');
        routes['PUT /vacuglide/valve/stroke-plus'] = undefined;
        calls = [];
        dispatchVacuglide(0);
        await tick(20);
        assert.equal(calls.length, 3, 'the idle tick retries with the whole stop');
        assert.equal(device.strokePlusValve, false);
        assert.equal(isVacuglideValveOpen('plus'), false);
    });

    it('an idle tick during a pulse does not cut the pulse short', async () => {
        // Outside a session the engine ticks zero every second. The valve a
        // wearer just opened must not be shut by it.
        await connectOk();
        const pending = pulseValve('plus', 300);
        await tick(60);
        dispatchVacuglide(0);
        dispatchVacuglide(0);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0);
        await pending;
        const [[openedAt, closedAt]] = openSpans('plus');
        assert.ok(closedAt - openedAt >= 200, `open for ${closedAt - openedAt} ms`);
    });

    it('STOP during a pulse closes the valve at once', async () => {
        await connectOk();
        const pending = pulseValve('minus', 2000);
        await tick(80);
        assert.equal(device.strokeMinusValve, true);
        dispatchVacuglide(0, true);
        await tick(40);
        assert.equal(device.strokeMinusValve, false);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        const result = await pending;
        assert.equal(result.ok, true);
        const [[openedAt, closedAt]] = openSpans('minus');
        assert.ok(closedAt - openedAt < 300, `open for ${closedAt - openedAt} ms after STOP`);
        assert.equal(isVacuglideValveOpen('minus'), false);
    });

    it('Disconnect during a pulse closes the valve', async () => {
        await connectOk();
        const pending = pulseValve('plus', 2000);
        await tick(80);
        const done = await disconnectVacuglide();
        assert.equal(done.confirmed, true);
        await pending;
        assert.equal(device.strokePlusValve, false);
        const [[openedAt, closedAt]] = openSpans('plus');
        assert.ok(closedAt - openedAt < 300);
    });

    it('an open that timed out is closed, and closed again once it can no longer be in flight', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 40;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 150;
        let late = null;
        routes['PUT /vacuglide/valve/stroke-minus'] = ({ next, body }) => {
            if (body.valveState === true) {
                // The open reaches the device only after our side gave up on
                // it, and after the close that followed.
                late = setTimeout(() => next(), 90);
                return new Promise(() => {});
            }
            return next();
        };
        const result = await pulseValve('minus', 300);
        clearTimeout(late);
        assert.equal(result.reason, 'open-failed');
        assert.equal(sent('/vacuglide/valve/stroke-minus').filter((c) => c.body.valveState === false).length, 2);
        // Timers fire in the order they fall due, so this is what the device
        // saw however busy the machine is: the close at the timeout (40 ms),
        // the late open (90 ms), and the close once it could no longer be in
        // flight (40 + 150 ms).
        assert.deepEqual(valveTimeline('minus'), ['close', 'open', 'close']);
        assert.equal(device.strokeMinusValve, false, 'the late open was closed by the second close');
        assert.equal(isVacuglideValveOpen('minus'), false);
    });

    it('closes on the pulse clock when the answer to the open is slow, and again once it comes', async () => {
        await connectOk();
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            // The device opens the valve at once; the cloud answers 1.2 s later.
            const reply = next();
            return new Promise((resolve) => setTimeout(() => resolve(reply), 1200));
        };
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, true);
        const spans = openSpans('plus');
        assert.equal(spans.length, 1);
        const open = spans[0][1] - spans[0][0];
        // The pulse, not the answer: a close that waited for it would have
        // left the valve open for 1.2 s.
        assert.ok(open >= 200 && open < 700, `open for ${open} ms`);
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus').map((c) => c.body.valveState), [true, false, false], 'one close on the pulse clock, one after the answer');
        assert.deepEqual(valveTimeline('plus'), ['open', 'close', 'close']);
        assert.equal(device.strokePlusValve, false);
        assert.equal(isVacuglideValveOpen('plus'), false);
        assert.deepEqual(pulses.map((p) => p.stage), ['opening', 'closing', 'idle'], 'never shown open: nothing confirmed it before it was closed');
    });

    it('a close that overtook a slow open is followed by another once the open is answered', async () => {
        await connectOk();
        routes['PUT /vacuglide/valve/stroke-minus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            // The open reaches the device after the close sent on the pulse
            // clock did, and is answered as it lands.
            return new Promise((resolve) => setTimeout(() => resolve(next()), 600));
        };
        const result = await pulseValve('minus', 300);
        assert.equal(result.ok, true);
        assert.deepEqual(valveTimeline('minus'), ['close', 'open', 'close']);
        assert.equal(device.strokeMinusValve, false);
        const [[openedAt, closedAt]] = openSpans('minus');
        assert.ok(closedAt - openedAt < 300, `open for ${closedAt - openedAt} ms after it landed`);
        assert.equal(isVacuglideValveOpen('minus'), false);
    });

    it('the close after a late answer does not wait for the first close to be answered too', async () => {
        await connectOk();
        let closes = 0;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState === true) {
                // The open lands after the first close, and is answered as it lands.
                return new Promise((resolve) => setTimeout(() => resolve(next()), 500));
            }
            closes += 1;
            if (closes > 1) return next();
            // The first close lands at once; its answer takes 2 s.
            const reply = next();
            return new Promise((resolve) => setTimeout(() => resolve(reply), 2000));
        };
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, true);
        assert.deepEqual(valveTimeline('plus'), ['close', 'open', 'close']);
        const [[openedAt, closedAt]] = openSpans('plus');
        assert.ok(closedAt - openedAt < 300, `open for ${closedAt - openedAt} ms: not until the first close was answered`);
        assert.equal(isVacuglideValveOpen('plus'), false);
    });

    it('with the same delay each way on every valve command, the valve is open for the pulse', async () => {
        await connectOk();
        const legMs = 400;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next }) => new Promise((resolve) => {
            setTimeout(() => {
                const reply = next();
                setTimeout(() => resolve(reply), legMs);
            }, legMs);
        });
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, true);
        const [[openedAt, closedAt]] = openSpans('plus');
        const open = closedAt - openedAt;
        // Waiting for the answer (800 ms) before the close set off would have
        // left it open for 800 ms.
        assert.ok(open >= 200 && open < 600, `open for ${open} ms`);
        assert.equal(device.strokePlusValve, false);
        assert.equal(isVacuglideValveOpen('plus'), false);
    });

    it('an open the cloud holds back past the pulse, and never answers, is shut within a beat of landing', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 1500;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 1500;
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 100;
        let late = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            // The open reaches the device 600 ms after it was sent - after
            // the close on the pulse clock - and its answer never comes.
            late = setTimeout(() => next(), 600);
            return new Promise(() => {});
        };
        const result = await pulseValve('plus', 300);
        clearTimeout(late);
        assert.equal(result.reason, 'open-failed');
        const spans = openSpans('plus');
        assert.equal(spans.length, 1);
        const [openedAt, closedAt] = spans[0];
        assert.notEqual(closedAt, null, 'the late open was closed');
        // Closed only at the end of the guard, it would have been open for
        // 2.4 s: from 600 ms until the timeout (1.5 s) plus the guard (1.5 s).
        assert.ok(closedAt - openedAt < 1000, `open for ${closedAt - openedAt} ms`);
        const closes = sent('/vacuglide/valve/stroke-plus').filter((c) => c.body.valveState === false);
        assert.ok(closes.every((c) => c.host === CLUSTER && c.token === TOKEN));
        assert.ok(closes.at(-1).at >= closes[0].at + 2000, 'the confirmed close still comes once the open can no longer be in flight');
        assert.equal(device.strokePlusValve, false);
        assert.equal(isVacuglideValveOpen('plus'), false);
        assert.equal(unconfirmed.length, 0);
        assert.deepEqual(pulses.map((p) => p.stage), ['opening', 'closing', 'idle']);
    });

    it('an unanswered open that does land later is shut on the beat, then again on its answer', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 100;
        let answer = null;
        // What the cloud saw, in order: each close as it arrived, and the
        // moment the open was answered.
        const seen = [];
        routes['PUT /vacuglide/valve/stroke-minus'] = ({ next, body }) => {
            if (body.valveState !== true) {
                seen.push('close');
                return next();
            }
            // Lands at 500 ms; its answer is held back until 1.15 s.
            return new Promise((resolve) => {
                setTimeout(() => {
                    const reply = next();
                    answer = setTimeout(() => {
                        seen.push('answer');
                        resolve(reply);
                    }, 650);
                }, 500);
            });
        };
        const result = await pulseValve('minus', 300);
        clearTimeout(answer);
        assert.equal(result.ok, true);
        const spans = openSpans('minus');
        assert.equal(spans.length, 1);
        const [[openedAt, closedAt]] = spans;
        // Waiting for the answer would have left it open for 650 ms.
        assert.ok(closedAt - openedAt < 400, `open for ${closedAt - openedAt} ms`);
        const timeline = valveTimeline('minus');
        assert.equal(timeline[0], 'close', 'the close on the pulse clock reached the device before the late open');
        assert.equal(timeline.at(-1), 'close');
        // The pulse-clock close, at least one on the beat, and after the
        // answer exactly one more: the beat stops once the open is answered.
        const answered = seen.indexOf('answer');
        assert.ok(answered >= 2, JSON.stringify(seen));
        assert.deepEqual(seen.slice(answered), ['answer', 'close'], JSON.stringify(seen));
        assert.equal(device.strokeMinusValve, false);
        assert.equal(isVacuglideValveOpen('minus'), false);
    });

    it('a close on the beat is routine traffic: it never takes the slots a STOP is kept', async () => {
        // The routine budget is spent by connect (5) and this open, so no
        // beat may go out; the reserve is still whole for the confirmed
        // closes, the STOP after them and the one the cleanup sends. The
        // watch for the open nobody answered cannot read the device either,
        // and says so: a read it cannot make is a device it cannot see.
        VACUGLIDE_LIMITS.ceiling = 18;
        VACUGLIDE_LIMITS.reserve = 12;
        VACUGLIDE_LIMITS.watchReserve = 0;
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 600;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 300;
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 40;
        let late = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            // Lands after the pulse-clock close; never answered.
            late = setTimeout(() => next(), 450);
            return new Promise(() => {});
        };
        await pulseValve('plus', 300);
        clearTimeout(late);
        const closes = sent('/vacuglide/valve/stroke-plus').filter((c) => c.body.valveState === false);
        assert.equal(closes.length, 2, 'the close on the pulse clock and the confirmed one after the guard, and no beat');
        assert.equal(device.strokePlusValve, false, 'the confirmed close still shut the late open');
        calls = [];
        assert.equal(await stopVacuglide(), true, 'the STOP had its slots');
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
        assert.ok(unconfirmed.every((m) => /^EdgeLoop could not read the VacuGlide/.test(m)), JSON.stringify(unconfirmed));
    });

    it('an open refused after the pulse ran out needs no other close and raises no alarm', async () => {
        await connectOk();
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            // Autoblow's limiter answers the open, late: it never reached the valve.
            return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(null, 429)), 500));
        };
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'open-failed');
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus').map((c) => c.body.valveState), [true, false], 'the close on the pulse clock, and no other');
        assert.equal(unconfirmed.length, 0);
        assert.equal(isVacuglideValveOpen('plus'), false);
        assert.equal(device.strokePlusValve, false);
    });

    it('an open the server refused outright needs no close and raises no alarm', async () => {
        await connectOk();
        routes['PUT /vacuglide/valve/stroke-plus'] = jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: 'body/valveState must be boolean' } }, 400);
        const result = await pulseValve('plus', 300);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'open-failed');
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 1);
        assert.equal(unconfirmed.length, 0);
        assert.equal(isVacuglideValveOpen('plus'), false);
    });

    it('refuses a press before connect, and a valve that does not exist', async () => {
        assert.equal((await pulseValve('plus')).reason, 'offline');
        await connectOk();
        assert.equal((await pulseValve('both')).reason, 'invalid');
        assert.equal(calls.length, 0);
    });

    // ---- a valve open that nothing is holding -------------------------------------------------

    // An open the cloud applies once the driver has given up on it. The
    // pulse closes the valve on its own schedule for a request timeout and a
    // guard after it; nothing documented says the cloud cannot apply the open
    // later still, and when it did, the valve stayed open for as long as
    // nothing else was sent.
    function landLate(valve, afterMs) {
        const timers = [];
        routes[`PUT /vacuglide/valve/stroke-${valve}`] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            timers.push(setTimeout(() => next(), afterMs));
            return new Promise(() => {});
        };
        return () => timers.forEach(clearTimeout);
    }

    const landed = (valve) => device.events.some((e) => e.what === 'valve' && e.valve === valve && e.open);

    // The device is at rest - no speed since its last stop - so the open
    // that lands is motion after a stop, and gets the whole stop.
    it('an open the cloud applies after its pulse gave up on it is found and closed within a beat', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 100;
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1500;
        const cancel = landLate('plus', 700);
        const result = await pulseValve('plus', 300);
        const pulseEnded = Date.now();
        assert.equal(result.reason, 'open-failed');
        assert.match(result.message, /never said whether the valve opened \(Request timed out \(\/vacuglide\/valve\/stroke-plus\)\)\. EdgeLoop closed it, and reads its state every 1 s for the next 2 s/);
        assert.equal(isVacuglideValveOpen('plus'), false, 'every close so far was confirmed');
        assert.equal(isVacuglideWatching(), true, 'but the open may still land, and the device is watched for it');
        await waitFor(() => landed('plus'), 3000, 'the late open to land');
        await waitFor(() => !device.strokePlusValve, 3000, 'the late open to be closed');
        const spans = openSpans('plus');
        assert.equal(spans.length, 1);
        const [openedAt, closedAt] = spans[0];
        assert.ok(openedAt - pulseEnded > 200, `it landed ${openedAt - pulseEnded} ms after the pulse had ended`);
        // Found by the next read of the state: a beat, and the round trip.
        assert.ok(closedAt - openedAt < 400, `open for ${closedAt - openedAt} ms after it landed`);
        await waitFor(() => !isVacuglideValveOpen('plus'), 1000, 'the close to be confirmed');
        await waitFor(() => valveNotes.some(Boolean), 1000, 'the panel to be told');
        assert.match(valveNotes.find(Boolean), /^Valve \+ \(stroke plus\) was open after EdgeLoop had stopped the VacuGlide .* EdgeLoop stopped it again and closed both valves\./);
        assert.ok(device.events.some((e) => e.what === 'stop' && e.at >= openedAt), 'the whole stop, the motor stop with it');
        assert.equal(unconfirmed.length, 0);
        assert.equal(openSpans('minus').length, 0, 'the other valve is never opened');
        cancel();
    });

    it('a speed reply that shows a valve open with no press holding it gets that valve closed, and only that', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        // An open that landed long after anything could say so: the state
        // every reply carries is the only evidence of it.
        device.strokeMinusValve = true;
        device.events.push({ at: Date.now(), what: 'valve', valve: 'minus', open: true });
        let release = null;
        routes['PUT /vacuglide/valve/stroke-minus'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        dispatchVacuglide(45);
        await waitFor(() => release !== null, 1000, 'the close to go out');
        assert.equal(isVacuglideValveOpen('minus'), true, 'reported open, and flagged open until the close is confirmed');
        assert.ok(valveNotes.includes(null), 'the panel was asked to show it');
        release();
        await waitFor(() => !isVacuglideValveOpen('minus'), 1000, 'the close to be confirmed');
        assert.equal(device.strokeMinusValve, false);
        assert.deepEqual(sent('/vacuglide/valve/stroke-minus').map((c) => c.body.valveState), [false], 'one close');
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 0, 'nothing else touched');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0, 'the motor keeps the speed the session asked for');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.ok(valveNotes.some((m) => m && /^Valve - \(stroke minus\) was open with no press holding it/.test(m)));
    });

    it('a link check between sessions finds a valve open and sends the whole stop', async () => {
        await connectOk();
        device.strokePlusValve = true;
        device.events.push({ at: Date.now(), what: 'valve', valve: 'plus', open: true });
        await pollVacuglideConnected();
        assert.equal(isVacuglideValveOpen('plus'), true, 'flagged open until the stop is confirmed');
        await waitFor(() => !isVacuglideValveOpen('plus'), 1000, 'the stop to be confirmed');
        assert.equal(device.strokePlusValve, false);
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus').map((c) => c.body.valveState), [false]);
        assert.deepEqual(sent('/vacuglide/valve/stroke-minus').map((c) => c.body.valveState), [false]);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1, 'at rest since its last stop: anything moving gets the whole stop');
        assert.equal(isVacuglideConnected(), true);
    });

    it('a reply to a request sent before the last confirmed close is not taken for a new open', async () => {
        // The reply is the state at the moment the cloud took the request.
        // One taken while a press held the valve open and answered after the
        // press had closed it shows an open that is already closed.
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        let releaseSpeed = null;
        routes['PUT /vacuglide/target-speed'] = ({ next }) => new Promise((resolve) => {
            const reply = next();
            releaseSpeed = () => resolve(reply);
        });
        const pending = pulseValve('plus', 300);
        await waitFor(() => device.strokePlusValve, 1000, 'the press to open the valve');
        dispatchVacuglide(50);
        await waitFor(() => releaseSpeed !== null, 1000, 'the speed to be taken while the valve is open');
        assert.equal((await pending).ok, true);
        const valveCalls = sent('/vacuglide/valve/stroke-plus').length;
        releaseSpeed();
        await tick(80);
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, valveCalls, 'no close for an open the press already closed');
        assert.equal(isVacuglideValveOpen('plus'), false);
        assert.ok(!valveNotes.some(Boolean));
    });

    it('a reply that shows the valve a press is holding open does not cut the press short', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        const pending = pulseValve('plus', 400);
        await waitFor(() => device.strokePlusValve, 1000, 'the press to open the valve');
        dispatchVacuglide(50);
        await tick(60);
        await pollVacuglideConnected();
        assert.equal(device.strokePlusValve, true, 'still open: the wearer asked for it');
        assert.equal((await pending).ok, true);
        const [[openedAt, closedAt]] = openSpans('plus');
        assert.ok(closedAt - openedAt >= 300, `open for ${closedAt - openedAt} ms`);
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus').map((c) => c.body.valveState), [true, false]);
    });

    it('a valve found open that never confirms it closed raises the alarm, and the next idle tick sends the whole stop', async () => {
        await connectOk();
        device.strokeMinusValve = true;
        routes['PUT /vacuglide/valve/stroke-minus'] = jsonResponse(null, 503);
        await pollVacuglideConnected();
        await waitFor(() => unconfirmed.length === 1, 2000, 'the alarm');
        assert.match(unconfirmed[0], /^Stop not confirmed: .*stroke-minus/);
        assert.equal(sent('/vacuglide/valve/stroke-minus').length, 4, 'four attempts, like any close');
        assert.equal(isVacuglideValveOpen('minus'), true, 'a close nobody confirmed is not a closed valve');
        routes['PUT /vacuglide/valve/stroke-minus'] = undefined;
        calls = [];
        dispatchVacuglide(0);
        await tick(20);
        assert.equal(calls.length, 3, 'the whole stop');
        assert.equal(device.strokeMinusValve, false);
        assert.equal(isVacuglideValveOpen('minus'), false);
    });

    it('a press of a valve EdgeLoop is closing after finding it open is refused rather than raced', async () => {
        await connectOk();
        // A session drives the device, so a valve found open gets that
        // valve's close, and the session goes on.
        dispatchVacuglide(40);
        await tick(60);
        device.strokePlusValve = true;
        let release = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        await pollVacuglideConnected();
        await waitFor(() => release !== null, 1000, 'the close to go out');
        const press = await pulseValve('plus', 300);
        assert.equal(press.reason, 'busy');
        assert.match(press.message, /EdgeLoop is closing it/);
        assert.equal(sent('/vacuglide/valve/stroke-plus').filter((c) => c.body.valveState === true).length, 0, 'no open raced the close');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0, 'the session is not stopped for it');
        release();
        await waitFor(() => !isVacuglideValveOpen('plus'), 1000, 'the close to be confirmed');
        routes['PUT /vacuglide/valve/stroke-plus'] = undefined;
        assert.equal((await pulseValve('plus', 300)).ok, true, 'once it has closed, a press goes through');
    });

    it('while a whole stop is out, a reply that shows a valve open sends no second close', async () => {
        await connectOk();
        device.strokePlusValve = true;
        let release = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next }) => new Promise((resolve) => { release = () => resolve(next()); });
        const stopped = stopVacuglide();
        await tick(20);
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 1);
        release();
        assert.equal(await stopped, true);
        await tick(20);
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 1, 'the stop closes it, and confirms it');
        assert.equal(device.strokePlusValve, false);
        assert.ok(!valveNotes.some(Boolean));
    });

    it('the watch for a late open reads the state on its beat for its window, then ends', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 60;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 60;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 100;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 600;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === true ? new Promise(() => {}) : next());
        assert.equal(isVacuglideWatching(), false);
        const result = await pulseValve('plus', 300);
        assert.equal(result.reason, 'open-failed');
        assert.equal(isVacuglideWatching(), true);
        const began = Date.now();
        calls = [];
        await waitFor(() => !isVacuglideWatchPending(), 3000, 'the watch to end');
        const watchedFor = Date.now() - began;
        assert.ok(watchedFor >= 550, `watched for ${watchedFor} ms`);
        const reads = sent('/vacuglide/state');
        assert.ok(reads.length >= 3 && reads.length <= 8, `${reads.length} reads in ${watchedFor} ms`);
        assert.ok(reads.every((c) => c.method === 'GET' && c.host === CLUSTER && c.token === TOKEN));
        assert.ok(!calls.some((c) => c.method === 'PUT'), 'a watch that finds nothing changes nothing');
        assert.equal(isVacuglideWatching(), false);
        assert.ok(valveNotes.filter((m) => m === null).length >= 2, 'the panel was told when it began and when it ended');
    });

    it('a press whose open was answered, or refused outright, starts no watch', async () => {
        await connectOk();
        assert.equal((await pulseValve('plus', 300)).ok, true);
        assert.equal(isVacuglideWatchPending(), false);
        routes['PUT /vacuglide/valve/stroke-minus'] = jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: 'body/valveState must be boolean' } }, 400);
        assert.equal((await pulseValve('minus', 300)).reason, 'open-failed');
        assert.equal(isVacuglideWatchPending(), false, 'an open the server refused can never land');
    });

    it('an open that lands late on a device that was disconnected meanwhile is still found and closed', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 100;
        VACUGLIDE_TIMINGS.pendingOpenBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1500;
        const cancel = landLate('minus', 700);
        const pending = pulseValve('minus', 300);
        await tick(20);
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        await pending;
        assert.equal(isVacuglideConnected(), false);
        assert.equal(isVacuglideWatchPending(), true, 'watched although it is no longer connected');
        assert.equal(isVacuglideWatching(), false, 'nothing connected, so no panel shows the watch');
        await waitFor(() => landed('minus'), 3000, 'the late open to land');
        await waitFor(() => !device.strokeMinusValve, 3000, 'the late open to be closed');
        const spans = openSpans('minus');
        assert.equal(spans.length, 1);
        assert.ok(spans[0][1] - spans[0][0] < 400, `open for ${spans[0][1] - spans[0][0]} ms after it landed`);
        // A device EdgeLoop has let go of gets the whole stop, not only
        // that valve's close: the motor stop and the other valve with it.
        const landedAt = spans[0][0];
        assert.ok(device.events.some((e) => e.what === 'stop' && e.at >= landedAt), 'the motor stop went out with it');
        assert.ok(device.events.some((e) => e.what === 'valve' && e.valve === 'plus' && !e.open && e.at >= landedAt), 'and the other valve\'s close');
        assert.ok(sent('/vacuglide/state').every((c) => c.host === CLUSTER && c.token === TOKEN));
        assert.equal(unconfirmed.length, 0);
        assert.ok(!valveNotes.some(Boolean), 'the valve panel of a device that is not connected is not told');
        await waitFor(() => lateStops.length === 1, 1000, 'the page to be told');
        assert.match(lateStops[0], /^Valve - \(stroke minus\) was open after EdgeLoop had stopped the VacuGlide/);
        cancel();
    });

    it('a device connected again while it is watched is watched through the new link, and its panel is told', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 60;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 60;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1500;
        const cancel = landLate('plus', 700);
        await pulseValve('plus', 300);
        await disconnectVacuglide();
        routes = {};
        await connectVacuglide(TOKEN);
        assert.equal(isVacuglideWatching(), true, 'the panel of the device connected again shows the watch');
        await waitFor(() => landed('plus'), 3000, 'the late open to land');
        await waitFor(() => !device.strokePlusValve, 3000, 'the late open to be closed');
        await waitFor(() => valveNotes.some(Boolean), 1000, 'the panel to be told');
        assert.match(valveNotes.find(Boolean), /^Valve \+ \(stroke plus\) was open after EdgeLoop had stopped the VacuGlide/);
        cancel();
    });

    // ---- the request budget -------------------------------------------------------------------

    it('routine traffic stops short of the ceiling, and a stop still goes out', async () => {
        // Room under the ceiling for this stop and for the one the cleanup
        // sends, so neither has to wait out a 66 s window.
        VACUGLIDE_LIMITS.ceiling = 13;
        VACUGLIDE_LIMITS.reserve = 7;
        VACUGLIDE_LIMITS.watchReserve = 0;
        await connectOk();
        // connect spent 5: discovery, info and the three rest commands
        dispatchVacuglide(20);
        await tick(60);
        dispatchVacuglide(30);
        await tick(60);
        dispatchVacuglide(40);
        await tick(60);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [20], 'a seventh request would have eaten the reserve');
        const valve = await pulseValve('plus', 300);
        assert.equal(valve.reason, 'rate');
        assert.match(valve.message, /Try again in \d+ s/);
        assert.equal(sent('/vacuglide/valve/stroke-plus').length, 0);
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(calls.filter((c) => c.method === 'PUT' && /stop|valve/.test(c.path)).length, 3, 'the whole stop was sent from the reserve');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('a speed held back by the budget goes out once the window allows', async () => {
        VACUGLIDE_LIMITS.ceiling = 10;
        VACUGLIDE_LIMITS.reserve = 4;
        VACUGLIDE_LIMITS.watchReserve = 0;
        // Long enough that no pause of a busy machine lets it lapse between
        // the send and the check that follows it.
        VACUGLIDE_LIMITS.windowMs = 1000;
        await connectOk();
        dispatchVacuglide(20);
        await tick(60);
        dispatchVacuglide(30);
        await tick(5);
        assert.equal(sent('/vacuglide/target-speed').length, 1);
        await tick(1100);
        dispatchVacuglide(30);
        await tick(20);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [20, 30]);
    });

    it('a stop at the ceiling raises the alarm the moment it has to wait, and goes as soon as a slot frees', async () => {
        VACUGLIDE_LIMITS.ceiling = 9;
        VACUGLIDE_LIMITS.reserve = 3;
        VACUGLIDE_LIMITS.watchReserve = 0;
        VACUGLIDE_LIMITS.windowMs = 700;
        await connectOk();
        dispatchVacuglide(50);
        await tick(20);
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed').length, 1);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1, 'connect (5), the speed and this stop fill the ceiling');
        assert.deepEqual(unconfirmed, []);
        calls = [];
        dispatchVacuglide(0, true);
        await tick(100);
        assert.equal(calls.length, 0, 'nothing is sent into a refusal');
        assert.equal(unconfirmed.length, 1, 'the wearer hears of it now, not after the wait');
        // Nothing here came from Autoblow: it is EdgeLoop's own count that
        // is full, and the alarm says so rather than blame Autoblow's limit.
        assert.match(unconfirmed[0], /^A stop is held back: EdgeLoop's own count of requests for this device token is full for the minute - it counts every request it sent, answered or not, to stay under Autoblow's limit\. EdgeLoop sends it in 1 s$/);
        await waitFor(() => calls.length === 3, 3000, 'the stop, once the window lets it go');
        await tick(20);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(unconfirmed.length, 1, 'one alarm for one wait');
    });

    // The requests that filled the count failed on the way and never
    // reached Autoblow; then they did reach it, and its server refused them
    // for rate. Each held-back stop says which.
    it("a stop held back says what filled the count: requests that never reached Autoblow, or Autoblow's server refusing them", async () => {
        VACUGLIDE_LIMITS.ceiling = 9;
        VACUGLIDE_LIMITS.reserve = 3;
        VACUGLIDE_LIMITS.watchReserve = 0;
        VACUGLIDE_LIMITS.windowMs = 700;
        await connectOk();
        dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50, 1000, 'the speed');
        await tick(20);
        // Autoblow's cloud cannot be reached for a while: the stop's requests
        // fail on the way, and fill EdgeLoop's count.
        let mode = 'network';
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (mode === 'network') throw new TypeError('Failed to fetch');
            if (mode === 'refused') return jsonResponse(null, 429);
            return next();
        };
        dispatchVacuglide(0, true);
        await waitFor(() => unconfirmed.length >= 1, 2000, 'a part of the stop to wait for a slot');
        assert.match(unconfirmed[0], /^A (stop|valve close) is held back: EdgeLoop's own count of requests for this device token is full for the minute/);
        assert.doesNotMatch(unconfirmed[0], /refused/);
        mode = 'ok';
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED' && !isVacuglideMoving(), 5000, 'the stop, once slots free');
        // Now Autoblow's server refuses the stop for rate.
        await tick(750);
        dispatchVacuglide(60);
        await waitFor(() => device.targetSpeed === 60, 1000, 'the speed again');
        await tick(20);
        mode = 'refused';
        const before = unconfirmed.length;
        dispatchVacuglide(0, true);
        await waitFor(() => unconfirmed.slice(before).some((m) => /held back/.test(m)), 2000, 'a part of the stop to wait for a slot');
        assert.match(unconfirmed.slice(before).find((m) => /held back/.test(m)), /^A (stop|valve close) is held back: Autoblow's server has refused requests for this device token as over its limit, and EdgeLoop's own count of them for the minute is full\. EdgeLoop sends it in \d+ s$/);
        mode = 'ok';
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED' && !isVacuglideMoving(), 5000, 'the stop, once slots free');
    });

    it('a reloaded page counts what the last one sent, so its STOP is never refused for rate', async () => {
        // Autoblow's limit at a size a test can fill: the server takes 36 a
        // minute per token and host; EdgeLoop's ceiling is 34 over every
        // host, 16 of them kept for a stop, so routine traffic stops at 18.
        serverLimit = 36;
        Object.assign(VACUGLIDE_LIMITS, { ceiling: 34, reserve: 16, watchReserve: 0 });
        VACUGLIDE_TIMINGS.speedGapMs = 5;
        globalThis.localStorage = memoryStorage();
        const reloaded = await loadAnotherPage();
        try {
            await connectOk();
            // The first page drives until its routine budget is spent, is
            // paused, and goes away.
            for (let i = 0; i < 16; i += 1) {
                dispatchVacuglide(20 + i);
                await tick(15);
            }
            assert.equal(sent('/vacuglide/target-speed').length, 13, 'connect took 5 and 13 speeds the rest of the routine 18');
            dispatchVacuglide(0, true);
            await tick(20);
            assert.equal(stopVacuglideOnUnload(), true);
            const firstPage = calls.length;

            // The page that comes back, inside the same minute.
            const again = reloaded.driver;
            await again.connectVacuglide(TOKEN);
            assert.equal(again.isVacuglideConnected(), true, 'connecting - which stops the device - may use the reserve');
            for (let i = 0; i < 12; i += 1) {
                again.dispatchVacuglide(60 + i);
                await tick(15);
            }
            const mine = () => calls.slice(firstPage);
            assert.equal(mine().filter((c) => c.path === '/vacuglide/target-speed').length, 0, 'the routine budget of this minute was spent by the page before');
            again.dispatchVacuglide(0, true);
            await waitFor(() => mine().filter((c) => /stop|valve/.test(c.path) && c.status !== undefined).length >= 6, 2000, 'the stop to be answered');
            assert.deepEqual(calls.filter((c) => c.status === 429).map((c) => c.path), [], 'the server never refused anything for rate');
            assert.equal(again.isVacuglideMoving(), false);
            assert.equal(reloaded.seen.unconfirmed.length, 0);
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        } finally {
            // Each page counts only itself for the cleanup.
            delete globalThis.localStorage;
            await reloaded.driver.disconnectVacuglide();
        }
    });

    it('keeps the request log under a hash of the token, never the token', async () => {
        const storage = memoryStorage();
        globalThis.localStorage = storage;
        await connectOk();
        dispatchVacuglide(40);
        await tick(20);
        const keys = [...storage.map.keys()];
        assert.equal(keys.length, 1);
        assert.match(keys[0], /^vacuglide_rate_log_[0-9a-f]{8}$/);
        assert.ok(!keys[0].includes(TOKEN) && !storage.map.get(keys[0]).includes(TOKEN), 'the credential is not copied into it');
        assert.equal(JSON.parse(storage.map.get(keys[0])).e.length, 6, 'connect and the speed');
    });

    it('a connect with nothing left under the ceiling says so at once, and sends nothing', async () => {
        VACUGLIDE_LIMITS.ceiling = 8;
        VACUGLIDE_LIMITS.reserve = 3;
        VACUGLIDE_LIMITS.watchReserve = 0;
        await connectOk();
        await disconnectVacuglide();
        calls = [];
        const started = Date.now();
        await assert.rejects(connectVacuglide(TOKEN), /Too many commands to the VacuGlide.*Try again in \d+ s/);
        assert.ok(Date.now() - started < 1000, 'it did not sit waiting for the window');
        assert.equal(calls.length, 0);
        assert.equal(isVacuglideConnected(), false);
    });

    it('a 429 from the server holds routine traffic, says so once, and never holds a stop', async () => {
        await connectOk();
        routes['PUT /vacuglide/target-speed'] = jsonResponse(null, 429);
        dispatchVacuglide(40);
        await tick(60);
        routes['PUT /vacuglide/target-speed'] = undefined;
        dispatchVacuglide(45);
        await tick(60);
        assert.equal(sent('/vacuglide/target-speed').length, 1, 'held back after the server refused');
        assert.equal(notices.length, 1);
        assert.match(notices[0], /request limit/);
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
    });

    // ---- the link ------------------------------------------------------------------------------------

    it('checks the link by reading the device state on its cluster, and a device that left online mode is offline', async () => {
        await connectOk();
        await pollVacuglideConnected();
        assert.deepEqual(calls.map((c) => `${c.method} ${c.host}${c.path}`), [`GET ${CLUSTER}/vacuglide/state`]);
        assert.equal(calls[0].token, TOKEN);
        assert.equal(calls[0].contentType, undefined, 'a read sends no body and no Content-Type');
        assert.equal(offline.length, 0);
        assert.ok(!calls.some((c) => c.method === 'PUT'), 'a healthy link check changes nothing on the device');
        device.online = false;
        calls = [];
        await pollVacuglideConnected();
        // The cluster answers DeviceNotConnectedError, and the router is
        // asked at once which kind of gone it is.
        assert.deepEqual(calls.map((c) => `${c.host}${c.path}`), [`${CLUSTER}/vacuglide/state`, `${LATENCY}/vacuglide/connected`]);
        assert.equal(offline.length, 1, 'decided by the time the check resolves');
        assert.match(offline[0].reason, /no longer online/);
        assert.equal(isVacuglideConnected(), false);
        dispatchVacuglide(50);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed').length, 0, 'a lost link takes no commands');
    });

    it('polls on its own, faster in a session than out of one', async () => {
        VACUGLIDE_TIMINGS.pollIdleMs = 400;
        VACUGLIDE_TIMINGS.pollActiveMs = 30;
        sessionActive = true;
        await connectOk();
        await tick(100);
        assert.ok(sent('/vacuglide/state').length >= 2, `${sent('/vacuglide/state').length} polls in 100 ms`);
        sessionActive = false;
        await tick(60);
        const before = sent('/vacuglide/state').length;
        await tick(150);
        assert.equal(sent('/vacuglide/state').length, before, 'outside a session the gap is the idle one');
    });

    // Connect times the next check between sessions; a session started right
    // after it had its first link check only that long in, about 30 s.
    it('START brings the next link check in to the in-session interval at once', async () => {
        VACUGLIDE_TIMINGS.pollIdleMs = 5000;
        VACUGLIDE_TIMINGS.pollActiveMs = 150;
        await connectOk();
        await tick(20);
        sessionActive = true;
        const startedAt = Date.now();
        dispatchVacuglide(40);
        await waitFor(() => sent('/vacuglide/state').length >= 1, 1500, 'a link check in the session\'s pace');
        assert.ok(sent('/vacuglide/state')[0].at - startedAt < 1000, 'not at the end of the gap Connect set');
        await waitFor(() => sent('/vacuglide/state').length >= 2, 1500, 'and the next one in the same pace');
    });

    it('a device that came back through another cluster is a lost link, and its stop goes to the new cluster', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        device.cluster = OTHER_CLUSTER;
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0].reason, /another Autoblow server \(us-east-2\.autoblowapi\.com\)/);
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop');
        assert.ok(sent('/vacuglide/target-speed/stop').some((c) => c.host === OTHER_CLUSTER), 'the stop followed the device');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
    });

    it('three polls that cannot reach the server in a row take the link down', async () => {
        await connectOk();
        routes['GET /vacuglide/state'] = () => { throw new TypeError('Failed to fetch'); };
        await pollVacuglideConnected();
        await pollVacuglideConnected();
        assert.equal(offline.length, 0);
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0].reason, /unreachable/);
    });

    it('three link checks the cluster refuses in a row take the link down, whatever the router says', async () => {
        await connectOk();
        routes['GET /vacuglide/state'] = () => NOT_CONNECTED();
        await pollVacuglideConnected();
        await pollVacuglideConnected();
        assert.equal(offline.length, 0, 'the router still names this cluster, so two misses are a blip');
        assert.equal(sent('/vacuglide/connected').length, 2, 'the router was asked after each');
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0].reason, /failed three link checks in a row \(Device not connected/);
    });

    it('a poll refused for rate says nothing about the device', async () => {
        await connectOk();
        routes['GET /vacuglide/state'] = jsonResponse(null, 429);
        for (let i = 0; i < 4; i += 1) await pollVacuglideConnected();
        assert.equal(offline.length, 0);
        assert.equal(isVacuglideConnected(), true);
    });

    it('DeviceNotConnectedError on a command asks the router at once, and ends the link', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        device.online = false;
        dispatchVacuglide(60);
        await tick(60);
        assert.equal(offline.length, 1, 'no waiting for the next poll');
        assert.ok(calls.some((c) => c.host === LATENCY && c.path === '/vacuglide/connected'));
    });

    it('five failed command ticks in a row take the link down', async () => {
        await connectOk();
        routes['PUT /vacuglide/target-speed'] = jsonResponse(null, 500);
        for (let i = 0; i < 4; i += 1) {
            dispatchVacuglide(40 + i);
            await tick(60);
        }
        assert.equal(offline.length, 0);
        dispatchVacuglide(60);
        await tick(60);
        assert.equal(offline.length, 1);
        assert.match(offline[0].reason, /stopped responding/);
    });

    it('a lost device that may be running keeps being sent the whole stop until one is confirmed', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        device.online = false;
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        await tick(100);
        assert.equal(isVacuglideOfflineStopPending(), true);
        assert.equal(unconfirmed.length, 1, 'reported once, not every round');
        device.online = true;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(unconfirmed.length, 1);
    });

    // The panel as app.js paints it: the lost link's background stop could
    // not be confirmed while the device was not online, and the badge, the
    // status line and the banner said so. Once that stop is confirmed the
    // device is at rest, and all three take it back - and nothing else.
    it('once the background stop after a lost link is confirmed, the panel takes back "Stop unconfirmed", its status line and the banner (app.js)', async () => {
        const app = appVacuglidePanel();
        setVacuglideHandlers({ ...app.handlers, isSessionActive: () => sessionActive });
        await connectOk();
        sessionActive = true;
        dispatchVacuglide(50);
        await tick(5);
        device.online = false;
        await pollVacuglideConnected();
        await waitFor(() => app.badge() === 'Stop unconfirmed', 1000, 'the alarm on the panel');
        assert.equal(app.status(), 'Status: Stop not confirmed: The VacuGlide is not online');
        assert.match(app.banner.get('vacuglideStop'), /may still be running/);
        assert.match(app.banner.get('vacuglideLink'), /no longer online/);
        device.online = true;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(app.badge(), 'Offline', 'the badge the lost link left, not "Stop unconfirmed"');
        assert.equal(app.status(), "Status: Autoblow's server confirmed the stop: the motor is stopped and both valves are closed.");
        assert.equal(app.banner.has('vacuglideStop'), false, 'no "may still be running"');
        assert.match(app.banner.get('vacuglideLink'), /no longer online/, 'the link is still gone, and the banner still says so');
        // Another device's confirmed stop, or a line painted since, is not
        // taken back for it.
        app.handlers.onStopUnconfirmed('Stop not confirmed: no answer', TOKEN);
        app.handlers.onStopConfirmed(`${TOKEN}b`);
        assert.equal(app.badge(), 'Stop unconfirmed');
        app.handlers.onTakeover('An EdgeLoop page went away while the VacuGlide may have been running.', true);
        app.handlers.onStopConfirmed(TOKEN);
        assert.equal(app.status(), 'Status: An EdgeLoop page went away while the VacuGlide may have been running.');
        assert.equal(app.badge(), 'Watching');
    });

    // ---- stopped by something else under a running session ----------------------------
    //
    // Autoblow documents TARGET_SPEED_PAUSED as the answer to its stop, so
    // Autoblow's own app, or any other app using the device token, can stop
    // the device while EdgeLoop's session drives it - and so can a stop of
    // an earlier link that Autoblow delivered late. The session's next speed
    // must not start it again behind whoever stopped it: the session pauses
    // on the wearer's page, and RESUME starts it. An earlier version started
    // it again 9 s later; the released build at the session's next new speed.

    // The page as app.js runs it on the driver: its handlers, and its pause -
    // the session no longer runs, and every toy gets a forced zero.
    function appSession() {
        let pauses = 0;
        const app = appVacuglidePanel({
            onAlert: () => {
                if (!sessionActive) return;
                sessionActive = false;
                pauses += 1;
                dispatchVacuglide(0, true);
            }
        });
        setVacuglideHandlers({ ...app.handlers, isSessionActive: () => sessionActive });
        return { app, pauses: () => pauses };
    }

    // Another app on the token stops it: the cloud's state, as its stop leaves it.
    function stoppedByAnotherApp() {
        device.operationalMode = 'TARGET_SPEED_PAUSED';
        device.events.push({ at: Date.now(), what: 'stop', by: 'another app' });
        return device.events[device.events.length - 1];
    }

    // The engine's ticks: the session's speed while it runs, 0 once paused.
    async function engineTicks(speed, ms, every = 50) {
        for (const end = Date.now() + ms; Date.now() < end;) {
            dispatchVacuglide(sessionActive ? (typeof speed === 'function' ? speed() : speed) : 0);
            await tick(every);
        }
    }

    for (const [what, steadyReadMs, run] of [
        ['the session holds its speed: the read after a quiet stretch finds it', 250, async () => {
            await engineTicks(60, 600);
        }],
        ['the speed changes after a quiet stretch: the speed waits for a read, which finds it', 250, async () => {
            dispatchVacuglide(70);
            await engineTicks(70, 400);
        }],
        // No read after a quiet stretch here: the open's own answer is all.
        ['the wearer presses a valve: its answer finds it', 100000, async () => {
            const press = pulseValve('minus', 300);
            await engineTicks(60, 600);
            await press;
        }]
    ]) {
        it(`something else stops the VacuGlide under a running session - ${what}: the session pauses, and nothing starts it again until RESUME (app.js)`, async () => {
            const { app, pauses } = appSession();
            VACUGLIDE_TIMINGS.steadyReadMs = steadyReadMs;
            await connectOk();
            sessionActive = true;
            dispatchVacuglide(60);
            await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING' && device.targetSpeed === 60, 1000, 'the session');
            // A quiet stretch: nothing sent, nothing read.
            await tick(300);
            const stopped = stoppedByAnotherApp();
            await run();
            assert.equal(pauses(), 1, 'the session paused');
            assert.match(app.banner.get('vacuglidePaused'), /^The VacuGlide stopped while the session was driving it - Autoblow's app, another app using its device token, or a stop Autoblow's server delivered late\. EdgeLoop paused the session and sends it no speed until you press RESUME\.$/);
            assert.deepEqual(eventsAfter(stopped).filter((e) => e.what === 'speed'), [], 'nothing started it again');
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
            assert.equal(isVacuglideMoving(), false);
            // RESUME: the session runs again, and its speed starts it.
            sessionActive = true;
            dispatchVacuglide(60);
            await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'RESUME to start it');
            assert.deepEqual(unconfirmed, []);
        });
    }

    it('found stopped under the session, the device gets no speed from the session\'s ticks - unchanged or new - until the session has paused and runs again', async () => {
        await connectOk();
        sessionActive = true;
        dispatchVacuglide(60);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING' && device.targetSpeed === 60, 1000, 'the session');
        await tick(60);
        const stopped = stoppedByAnotherApp();
        await pollVacuglideConnected();
        assert.equal(stoppedElsewhere.length, 1, 'the page is told, once');
        // This page has not paused yet: its ticks go on, and change.
        let n = 0;
        await engineTicks(() => 60 + (n++ % 2) * 5, 400);
        assert.deepEqual(eventsAfter(stopped).filter((e) => e.what === 'speed'), []);
        assert.equal(stoppedElsewhere.length, 1);
        sessionActive = false;
        dispatchVacuglide(0, true);
        sessionActive = true;
        dispatchVacuglide(65);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING' && device.targetSpeed === 65, 1000, 'RESUME to start it');
    });

    it('a stop of this page\'s own, or a session that is not running, is not something else stopping it', async () => {
        VACUGLIDE_TIMINGS.steadyReadMs = 150;
        await connectOk();
        sessionActive = true;
        dispatchVacuglide(60);
        await waitFor(() => device.targetSpeed === 60, 1000, 'the session');
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, 'STOP');
        await pollVacuglideConnected();
        assert.deepEqual(stoppedElsewhere, []);
        dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session again');
        sessionActive = false;
        stoppedByAnotherApp();
        await pollVacuglideConnected();
        assert.deepEqual(stoppedElsewhere, [], 'no session runs');
    });

    it('a lost device that was at rest is not chased and raises no alarm', async () => {
        await connectOk();
        device.online = false;
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        assert.equal(isVacuglideOfflineStopPending(), false);
        await tick(100);
        assert.equal(unconfirmed.length, 0);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0);
    });

    it('a fault the link check reads between sessions ends the link as a device error', async () => {
        await connectOk();
        device.operationalMode = 'ERROR_MOTOR_STUCK';
        await pollVacuglideConnected();
        assert.equal(offline.length, 1);
        assert.equal(offline[0].label, 'Device error');
        assert.match(offline[0].reason, /stuck/);
        assert.equal(isVacuglideConnected(), false);
    });

    it('a speed that lands after a confirmed stop is stopped again when a reply shows the motor running', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(60);
        dispatchVacuglide(0, true);
        await tick(40);
        assert.equal(isVacuglideMoving(), false);
        // What a speed the cloud applied long after our side gave up on it
        // does: the motor runs again while the app shows it stopped.
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 50;
        calls = [];
        await pollVacuglideConnected();
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the motor to be stopped');
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        assert.equal(sent('/vacuglide/target-speed').length, 0, 'no speed goes out: nothing asked for one');
        assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)), JSON.stringify(notices));
    });

    it('a speed nobody answered that lands after STOP is stopped within a beat, not at the next link check', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1500;
        dispatchVacuglide(40);
        await tick(60);
        // The next speed reaches the device 400 ms after it was sent -
        // after the STOP below, and after our side gave up on it - and its
        // answer never comes.
        const timers = [];
        routes['PUT /vacuglide/target-speed'] = ({ next }) => {
            timers.push(setTimeout(() => next(), 400));
            return new Promise(() => {});
        };
        dispatchVacuglide(55);
        await tick(10);
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving() && sent('/vacuglide/target-speed/stop').length >= 2, 2000, 'the stop and the stop after the timeout');
        assert.equal(isVacuglideWatching(), false, 'a watch for a speed says nothing about the valves');
        assert.equal(isVacuglideWatchPending(), true);
        await waitFor(() => device.events.some((e) => e.what === 'speed' && e.value === 55), 2000, 'the late speed to land');
        const landedAt = device.events.find((e) => e.what === 'speed' && e.value === 55).at;
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 2000, 'the late speed to be stopped');
        const stoppedAt = device.events.filter((e) => e.what === 'stop').at(-1).at;
        assert.ok(stoppedAt > landedAt);
        assert.ok(stoppedAt - landedAt < 400, `the motor ran ${stoppedAt - landedAt} ms after the late speed landed`);
        assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)));
        assert.ok(!valveNotes.some(Boolean), 'the valves were never in question');
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        timers.forEach(clearTimeout);
    });

    it('the motor running on a speed the session asked for is the session, not a late command', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(60);
        await pollVacuglideConnected();
        dispatchVacuglide(60);
        await tick(60);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0);
        assert.equal(notices.length, 0);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
    });

    it('a reply sent before the last confirmed stop is not taken for a late speed', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(60);
        let releaseCheck = null;
        routes['GET /vacuglide/state'] = ({ next }) => new Promise((resolve) => {
            // Taken while the motor runs, answered after the stop.
            const reply = next();
            releaseCheck = () => resolve(reply);
        });
        const check = pollVacuglideConnected();
        await waitFor(() => releaseCheck !== null, 1000, 'the check to be taken');
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        releaseCheck();
        await check;
        await tick(40);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1, 'one stop, not a second for a reply older than it');
        assert.equal(notices.length, 0);
    });

    it('a fault reported mid-session ends the link as a device error', async () => {
        await connectOk();
        routes['PUT /vacuglide/target-speed'] = ({ next }) => {
            next();
            device.operationalMode = 'ERROR_MOTOR_OVERRUN';
            return jsonResponse(stateOf(device));
        };
        dispatchVacuglide(50);
        await tick(20);
        assert.equal(offline.length, 1);
        assert.equal(offline[0].label, 'Device error');
        assert.match(offline[0].reason, /4 hours/);
        assert.equal(isVacuglideConnected(), false);
    });

    it('connecting the same device again ends a background stop still chasing it', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        device.online = false;
        await pollVacuglideConnected();
        await tick(20);
        assert.equal(isVacuglideOfflineStopPending(), true);
        device.online = true;
        await connectVacuglide(TOKEN);
        assert.equal(isVacuglideOfflineStopPending(), false);
    });

    // ---- a command that lands late, whatever became of the link ---------------------------------------
    //
    // A speed or a valve open can be out when a stop goes, or fail without an
    // answer, and still land after the stop - Autoblow documents no bound on
    // how late. Every way a stop can come while one is out is below: STOP, an
    // idle tick, Disconnect, a lost link of each kind, a device connected
    // again through a new link, another token connected in its place, and a
    // page that went away and came back. Each late command must be undone
    // within a beat of landing, and a device that cannot be seen once nothing
    // can land any more is not taken to be at rest. The test lands each held
    // command itself, at the point its case is about, rather than on a timer
    // a busy machine could run early or late.

    // The next target speed the cloud takes is held: it lands when the test
    // calls land(), and its answer never comes - what a request the cloud
    // held back does. fail() ends the request without an answer, as a
    // timeout or a network error does: nobody can say whether it reached the
    // device, or whether it still will. Neither happens on a timer, which a
    // busy machine could run early or late; the request timeout in these
    // tests is longer than any of them.
    function holdNextSpeed() {
        VACUGLIDE_TIMINGS.requestTimeoutMs = 20000;
        const held = { apply: null, reject: null, sentAt: null };
        let armed = true;
        routes['PUT /vacuglide/target-speed'] = ({ next, at }) => {
            if (!armed) return next();
            armed = false;
            held.apply = next;
            held.sentAt = at;
            return new Promise((resolve, reject) => { held.reject = reject; });
        };
        held.land = () => {
            const apply = held.apply;
            held.apply = null;
            if (apply) apply();
        };
        held.fail = () => {
            const reject = held.reject;
            held.reject = null;
            if (reject) reject(new TypeError('Failed to fetch'));
        };
        heldSpeeds.push(held);
        return held;
    }

    const stopsOn = (d = device) => d.events.filter((e) => e.what === 'stop').length;

    // The held speed fails without an answer, and the stop the driver sends
    // again for it reaches the device and is confirmed.
    async function failAndRestop(held, d = device) {
        const before = stopsOn(d);
        held.fail();
        await waitFor(() => stopsOn(d) > before, 2000, 'the stop sent again after the speed failed');
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'nothing still chasing the device');
        await tick(20);
    }

    const speedLanded = (value, d = device) => d.events.find((e) => e.what === 'speed' && e.value === value);

    // A late command is undone within a beat of landing, and the beat here
    // is 50 ms. The bound is a second, so a busy machine that runs timers
    // late does not fail a driver that did the right thing, and it still
    // rules out what each test guards against: a motor left running until
    // the speed's own timeout, or for as long as nobody sends anything.
    const UNDONE_WITHIN_MS = 1000;

    // What the device did after `event`, in the order it did it. Two events
    // can share a millisecond, so the timeline's order is what says which
    // came first, not their times.
    const eventsAfter = (event, d = device) => d.events.slice(d.events.indexOf(event) + 1);

    // The speed a session that has just started sent, as the device took it.
    // What came after the session started is told by its place after this in
    // the timeline, not by the clock: the stop of the connect before it can
    // land in the same millisecond as the session's first speed - one the
    // test held back and then released often does - and a time taken once
    // the session ran counted that stop as one sent into the session, at
    // random.
    const sessionStarted = (value, d = device) => d.events.findLast((e) => e.what === 'speed' && e.value === value);

    // Land the held speed now and say when the motor was stopped after it.
    async function landAndStop(held, value, d = device) {
        held.land();
        const landed = speedLanded(value, d);
        assert.ok(landed, `the late speed ${value} landed`);
        await waitFor(() => eventsAfter(landed, d).some((e) => e.what === 'stop'), 3000, `the late speed ${value} to be stopped`);
        const stoppedAt = eventsAfter(landed, d).find((e) => e.what === 'stop').at;
        return { landed, stoppedAt, ran: stoppedAt - landed.at };
    }

    // While its request is still out only a watch that began at the stop can
    // find it: nothing else is looking, and no answer or timeout will come to
    // say so. Once it has failed without an answer, the stop sent again for
    // it has been confirmed first.
    const LANDINGS = [
        ['while its request is still out', { failsFirst: false }],
        ['after its request failed without an answer', { failsFirst: true }]
    ];

    for (const [when, { failsFirst }] of LANDINGS) {
        it(`a speed still out at Disconnect that lands ${when} is stopped within a beat`, async () => {
            await connectOk();
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
            dispatchVacuglide(40);
            await tick(60);
            const held = holdNextSpeed();
            dispatchVacuglide(55);
            await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
            assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED', 'Disconnect stopped it');
            if (failsFirst) await failAndRestop(held);
            const { landed, ran } = await landAndStop(held, 55);
            assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
            await waitFor(() => lateStops.length === 1, 1000, 'the panel to be told');
            assert.match(lateStops[0], /started running again after EdgeLoop had stopped it/);
            // The whole stop: the motor and both valves.
            const after = eventsAfter(landed).filter((e) => e.what === 'valve').map((e) => `${e.valve} ${e.open}`);
            assert.deepEqual(after.sort(), ['minus false', 'plus false']);
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
            assert.equal(unconfirmed.length, 0);
            assert.equal(isVacuglideConnected(), false);
            assert.ok(calls.every((c) => c.token === TOKEN && (c.host === CLUSTER || c.host === LATENCY)));
        });
    }

    // The answer says the speed landed, and nothing about what else the
    // cloud still holds: the watch reads the device on its beat for the
    // whole window the speed was given when the stop went out, answered or
    // not. It ended on the answer before, and a speed that landed after
    // Disconnect's confirmed stop then ran with nothing reading the device.
    it('a speed still out at Disconnect and answered after its stop gets the whole stop again, and the watch reads on for its whole window', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 600;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        let release = null;
        routes['PUT /vacuglide/target-speed'] = ({ next, at }) => new Promise((resolve) => { release = () => resolve(next()); release.sentAt = at; });
        dispatchVacuglide(55);
        await waitFor(() => release !== null, 1000, 'the speed to go out');
        const sentAt = release.sentAt;
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        // It lands now, after Disconnect's stop, and is answered.
        const { ran } = await landAndStop({ land: release }, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        const answeredAt = Date.now();
        await waitFor(() => !isVacuglideWatchPending(), 3000, 'the watch to end');
        const ended = Date.now();
        // Its window: the speed's request timeout, and the watch after it.
        assert.ok(ended - sentAt >= 600 + 400, `the watch ended ${ended - sentAt} ms after the speed was sent`);
        const reads = sent('/vacuglide/state').filter((c) => c.at >= answeredAt).map((c) => c.at);
        const gaps = reads.slice(1).map((t, i) => t - reads[i]);
        assert.ok(reads.length >= Math.floor((sentAt + 1000 - answeredAt) / 50) - 3, `${reads.length} reads after the answer`);
        assert.ok(Math.max(...gaps) < 300, `no gap in the reads: the longest was ${Math.max(...gaps)} ms`);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(unconfirmed.length, 0);
    });

    for (const [when, { failsFirst }] of LANDINGS) {
        it(`STOP with a speed still out: one that lands ${when} is stopped within a beat`, async () => {
            await connectOk();
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
            dispatchVacuglide(40);
            await tick(60);
            const held = holdNextSpeed();
            dispatchVacuglide(55);
            await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
            dispatchVacuglide(0, true);
            await waitFor(() => !isVacuglideMoving() && sent('/vacuglide/target-speed/stop').length === 1, 1000, 'the STOP to be confirmed');
            assert.equal(isVacuglideWatchPending(), true, 'watched from the stop, not from a failure that has not come');
            if (failsFirst) await failAndRestop(held);
            const { ran } = await landAndStop(held, 55);
            assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
            assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)), JSON.stringify(notices));
            assert.equal(unconfirmed.length, 0);
        });
    }

    it('an idle zero tick that stops a speed still out watches for it', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        // The session ended: an ordinary zero tick, not STOP.
        dispatchVacuglide(0);
        await waitFor(() => sent('/vacuglide/target-speed/stop').length === 1 && !isVacuglideMoving(), 1000, 'the stop');
        assert.equal(isVacuglideWatchPending(), true);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
    });

    // STOP goes out while a speed is still out. Its motor stop lands, but a
    // valve close of it goes unanswered; the speed is then applied, and
    // answered. It may have landed after STOP's motor stop, and the whole
    // stop goes out again at once - it used to wait for STOP to settle, and
    // the motor ran for the close's timeout: 6 s when a retry got through,
    // 26 s when none did.
    for (const [how, stalls] of [['once', 1], ['on every attempt', Infinity]]) {
        it(`a speed answered after STOP's motor stop landed, while a close of STOP's goes unanswered ${how}, gets a whole stop of its own at once`, async () => {
            await connectOk();
            VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
            // A beat long enough that only the answer can have sent the stop
            // this soon: the watch's next read is a second away.
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 1000;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
            dispatchVacuglide(40);
            await tick(60);
            let releaseSpeed = null;
            routes['PUT /vacuglide/target-speed'] = ({ next }) => new Promise((resolve) => { releaseSpeed = () => resolve(next()); });
            dispatchVacuglide(55);
            await waitFor(() => releaseSpeed !== null, 1000, 'the speed to go out');
            const stalled = [];
            routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
                if (body.valveState === false && stalled.length < stalls) return new Promise((resolve, reject) => stalled.push(reject));
                return next();
            };
            dispatchVacuglide(0, true);
            await waitFor(() => stopsOn() === 1 && stalled.length === 1, 1000, "STOP's motor stop to land, and its close to stall");
            const stalledAt = Date.now();
            const { landed, stoppedAt, ran } = await landAndStop({ land: releaseSpeed }, 55);
            assert.ok(ran < 400, `the motor ran ${ran} ms after the late speed landed`);
            assert.ok(eventsAfter(landed).some((e) => e.what === 'valve' && e.valve === 'minus' && !e.open), 'the whole stop');
            // STOP's close could not even have timed out yet: nothing waited for it.
            assert.ok(stoppedAt < stalledAt + VACUGLIDE_TIMINGS.requestTimeoutMs, 'stopped before STOP could settle');
            assert.deepEqual(unconfirmed, [], "STOP's motor stop was answered: the speed landed after it, which is no stop failing");
            assert.ok(notices.length === 0 || notices.every((m) => !/instead of/.test(m)));
            // The watch reads on for the speed's window, answered or not.
            assert.equal(isVacuglideWatchPending(), true);
            for (const reject of stalled) reject(new TypeError('Failed to fetch'));
            routes['PUT /vacuglide/valve/stroke-plus'] = undefined;
            await waitFor(() => !isVacuglideMoving(), 3000, 'every stop to settle');
        });
    }

    // The same, with Disconnect pressed after STOP: STOP's requests stall,
    // Disconnect's own stop is confirmed, and the speed lands after it. The
    // stop again goes out at once, and the device is read on the beat from
    // Disconnect on - no gap while STOP's requests are still out.
    it('STOP stalled, Disconnect confirmed, and a speed out at both lands after them: stopped at once, and read on the beat all along', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 1000;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        let releaseSpeed = null;
        routes['PUT /vacuglide/target-speed'] = ({ next }) => new Promise((resolve) => { releaseSpeed = () => resolve(next()); });
        dispatchVacuglide(55);
        await waitFor(() => releaseSpeed !== null, 1000, 'the speed to go out');
        const stalled = [];
        let stalling = true;
        const stall = ({ next, body }) => {
            if (body && body.valveState === true) return next();
            if (stalling) return new Promise((resolve, reject) => stalled.push(reject));
            return next();
        };
        for (const route of ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus']) routes[route] = stall;
        dispatchVacuglide(0, true);
        await waitFor(() => stalled.length === 3, 1000, "STOP's three requests to go out");
        stalling = false;
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        const disconnectedAt = Date.now();
        const { stoppedAt, ran } = await landAndStop({ land: releaseSpeed }, 55);
        assert.ok(ran < 400, `the motor ran ${ran} ms after the late speed landed: at once, not at the next read`);
        assert.ok(stoppedAt < disconnectedAt + VACUGLIDE_TIMINGS.requestTimeoutMs, 'stopped before STOP could settle');
        assert.deepEqual(unconfirmed, [], "Disconnect's stop was answered: the speed landed after it");
        await tick(2600 - (Date.now() - disconnectedAt));
        const reads = sent('/vacuglide/state').filter((c) => c.at >= disconnectedAt).map((c) => c.at);
        const gaps = [reads[0] - disconnectedAt, ...reads.slice(1).map((t, i) => t - reads[i])];
        assert.ok(reads.length >= 2, `${reads.length} reads since Disconnect`);
        assert.ok(Math.max(...gaps) < 1300, `read on the beat: the longest gap was ${Math.max(...gaps)} ms`);
        for (const reject of stalled) reject(new TypeError('Failed to fetch'));
        await waitFor(() => !isVacuglideOfflineStopPending(), 3000, 'nothing chasing the device');
    });

    // A reply only shows the device after a stop if its request went out
    // after that stop did. A read that does, and shows the motor running,
    // gets a whole stop of its own at once - even while that stop's motor
    // stop is still unanswered: it has not been seen to land.
    it('a read sent after STOP went out that shows the motor running gets a whole stop at once, while STOP\'s motor stop is still unanswered', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        let failStop = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (failStop) return next();
            return new Promise((resolve, reject) => { failStop = reject; });
        };
        dispatchVacuglide(0, true);
        await waitFor(() => failStop !== null, 1000, 'STOP to go out');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the held stop never reached the device');
        calls = [];
        await pollVacuglideConnected();
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1, 'sent at once, with STOP\'s motor stop still unanswered');
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the device to be stopped');
        assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)));
        failStop(new TypeError('Failed to fetch'));
        await waitFor(() => !isVacuglideMoving(), 2000, 'every stop to settle');
        assert.deepEqual(unconfirmed, []);
    });

    // A stop that is not reaching the device: its motor stop still
    // unanswered a second after it went out, and the device seen running.
    // The stop goes out again at every sighting, and the alarm goes up at
    // the first one past that second - once for that stop, not when its four
    // attempts have failed, which kept the alarm down for 26 s while a cloud
    // swallowed every stop and the motor ran.
    it('a device seen running when its stop has gone unanswered past the time a stop takes to land raises the alarm, once, and is sent the stop again', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        VACUGLIDE_TIMINGS.stopLandsWithinMs = 300;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        dispatchVacuglide(40);
        await tick(60);
        // The cloud takes every motor stop and applies none.
        const swallowed = [];
        routes['PUT /vacuglide/target-speed/stop'] = () => new Promise((resolve, reject) => swallowed.push(reject));
        dispatchVacuglide(0, true);
        await waitFor(() => swallowed.length === 1, 1000, 'STOP to go out');
        const stoppedAt = Date.now();
        // Seen running at once: too soon to say anything of the stop. It
        // goes out again, and with STOP still unanswered the device is
        // watched - and seen running on every read, and sent the stop again.
        await pollVacuglideConnected();
        assert.equal(swallowed.length, 2, 'the stop again, at once');
        assert.deepEqual(unconfirmed, []);
        await waitFor(() => unconfirmed.length === 1, 2000, 'the alarm');
        const alarmedAfter = Date.now() - stoppedAt;
        assert.ok(alarmedAfter >= 300 && alarmedAfter < 1000, `the alarm came ${alarmedAfter} ms after STOP`);
        assert.match(unconfirmed[0], /^The VacuGlide is still running 0\.\d s after EdgeLoop sent it a stop Autoblow's server has not answered; EdgeLoop keeps sending the stop$/);
        const sentBy = swallowed.length;
        await tick(400);
        assert.ok(swallowed.length > sentBy, 'the stop keeps going out at every sighting');
        assert.equal(unconfirmed.length, 1, 'one alarm while the stops it is about stay unanswered');
        routes['PUT /vacuglide/target-speed/stop'] = undefined;
        for (const reject of swallowed) reject(new TypeError('Failed to fetch'));
        await waitFor(() => !isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 3000, 'every stop to settle');
    });

    // How long a stop has had to land is taken from it going out to the
    // request that shows the device still moving going out - not to that
    // answer coming back, which on a slow link can be long after.
    it('a read sent at once after a stop that shows the motor running gets the stop again, and no alarm, however late its answer comes back', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 2000;
        VACUGLIDE_TIMINGS.stopLandsWithinMs = 300;
        dispatchVacuglide(40);
        await tick(60);
        let swallowed = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (swallowed ? next() : new Promise((resolve, reject) => { swallowed = reject; }));
        // The read shows the device as it is when it goes out, and is
        // answered 600 ms later.
        routes['GET /vacuglide/state'] = ({ next }) => {
            const reply = next();
            return new Promise((resolve) => setTimeout(() => resolve(reply), 600));
        };
        dispatchVacuglide(0, true);
        await waitFor(() => swallowed !== null, 1000, 'STOP to go out');
        await pollVacuglideConnected();
        assert.equal(sent('/vacuglide/target-speed/stop').length, 2, 'the stop again, on that answer');
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the device to be stopped');
        assert.deepEqual(unconfirmed, [], 'the read went out too soon after the stop to say it is not reaching the device');
        swallowed(new TypeError('Failed to fetch'));
        await waitFor(() => !isVacuglideMoving(), 2000, 'every stop to settle');
        assert.deepEqual(unconfirmed, []);
    });

    // A cloud that is slow but works: every request lands half a round trip
    // after it goes out and is answered a round trip after, in the order
    // sent - a round trip three times the time a stop is given to land. STOP
    // goes out just after a speed. The speed's answer comes back well past
    // that time, with the motor running in it from before the stop landed:
    // it gets the whole stop again, as any speed answered after a stop does,
    // and it is no sign that the stop is not reaching the device. It raised
    // the alarm - which pauses a running session - on a 1.2 s round trip,
    // over a stop that had landed.
    it('on a slow link that works, a speed answered after STOP gets the stop again and raises no alarm, and the device never runs after its stop', async () => {
        await connectOk();
        const RTT = 600;
        VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 200;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        VACUGLIDE_TIMINGS.stopLandsWithinMs = 200;
        const slow = ({ next }) => new Promise((resolve) => setTimeout(() => {
            const reply = next();
            setTimeout(() => resolve(reply), RTT / 2);
        }, RTT / 2));
        for (const route of ['PUT /vacuglide/target-speed', 'GET /vacuglide/state', ...STOP_ROUTES]) routes[route] = slow;
        dispatchVacuglide(40);
        await waitFor(() => isVacuglideMoving() && device.targetSpeed === 40, 2000, 'the session to run');
        const before = sent('/vacuglide/target-speed').length;
        dispatchVacuglide(45);
        await waitFor(() => sent('/vacuglide/target-speed').length > before, 1000, 'the next speed to go out');
        await tick(50);
        dispatchVacuglide(0, true);
        // The engine's idle ticks, as after STOP.
        const ticker = setInterval(() => dispatchVacuglide(0), 100);
        try {
            await waitFor(() => sent('/vacuglide/target-speed/stop').length >= 2, 2000, 'the stop again, for the speed answered after it');
            await waitFor(() => !isVacuglideMoving() && !isVacuglideWatchPending(), 8000, 'every stop to settle, and the watch to end');
        } finally {
            clearInterval(ticker);
        }
        assert.deepEqual(unconfirmed, [], 'nothing sent after the stop showed the device moving');
        const firstStop = device.events.findIndex((e) => e.what === 'stop');
        assert.ok(firstStop >= 0);
        assert.ok(!device.events.slice(firstStop).some((e) => e.what === 'speed'), 'the device never ran after its stop');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    // A device EdgeLoop has let go of, seen running while the stop it was let
    // go with is still unanswered, gets a whole stop of its own at once: that
    // stop has not been seen to land.
    it('a device let go of, seen running while its Disconnect stop is unanswered, gets a whole stop of its own at once', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        // A speed still out keeps the device watched once it is let go of.
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        // Disconnect's motor stop is taken and neither applied nor answered.
        let swallowed = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (swallowed) return next();
            return new Promise((resolve, reject) => { swallowed = reject; });
        };
        const disconnected = disconnectVacuglide();
        await waitFor(() => swallowed !== null, 1000, "Disconnect's stop to go out");
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'a stop of its own, at the first read');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 2);
        swallowed(new TypeError('Failed to fetch'));
        assert.equal((await disconnected).confirmed, true, "Disconnect's own stop, tried again, is confirmed");
        await failAndRestop(held);
    });

    // A stop's own motor stop is swallowed - never applied, never answered -
    // with nothing else of EdgeLoop's out. Its two closes come back at once
    // with the motor still running in them, sent too early to say anything.
    // A read beat after the stop went out the device is read: it shows the
    // motor running, gets the whole stop again at once, and the alarm goes
    // up, the stop having had a whole beat to land. Nothing used to read the
    // device - after Disconnect nothing at all - until the swallowed request
    // timed out, 6 s, and the alarm waited for all four attempts, 26 s.
    for (const what of ['STOP', 'Disconnect']) {
        it(`${what} whose own motor stop is swallowed, with nothing else out: read a beat later, stopped again at once, and the alarm`, async () => {
            await connectOk();
            VACUGLIDE_TIMINGS.requestTimeoutMs = 5000;
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 150;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 200;
            VACUGLIDE_TIMINGS.stopLandsWithinMs = 150;
            dispatchVacuglide(40);
            await waitFor(() => isVacuglideMoving(), 1000, 'the session to run');
            await tick(60);
            let swallowed = null;
            routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (swallowed ? next() : new Promise((resolve, reject) => { swallowed = reject; }));
            calls = [];
            const pressedAt = Date.now();
            const done = what === 'STOP' ? stopVacuglide() : disconnectVacuglide();
            await waitFor(() => swallowed !== null, 1000, 'the stop to go out');
            assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'it never arrived');
            await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1500, 'the device to be stopped');
            const firstRead = sent('/vacuglide/state')[0];
            assert.ok(firstRead, 'the device was read');
            assert.ok(firstRead.at - pressedAt >= 150, `read ${firstRead.at - pressedAt} ms after the stop went out: once it had a beat to land`);
            const stop = device.events.find((e) => e.what === 'stop');
            assert.ok(stop.at >= firstRead.at && stop.at - firstRead.at < 400, `stopped ${stop.at - firstRead.at} ms after that read`);
            assert.equal(unconfirmed.length, 1);
            assert.match(unconfirmed[0], /^The VacuGlide is still running 0\.\d s after EdgeLoop sent it a stop Autoblow's server has not answered; EdgeLoop keeps sending the stop$/);
            swallowed(new TypeError('Failed to fetch'));
            await done;
            await waitFor(() => !isVacuglideMoving() && !isVacuglideOfflineStopPending(), 2000, 'every stop to settle');
            assert.equal(unconfirmed.length, 1, 'one alarm');
        });
    }

    // A device at rest, with nothing out that could move it, stays at rest
    // whether its stop lands or not. Disconnect of it whose stop goes
    // unanswered has it read by nothing, and raises no alarm when a read
    // could not have seen it: Disconnect of a device EdgeLoop had not moved
    // is no alarm when its stop is not answered.
    it('Disconnect of a device at rest whose stop goes unanswered reads nothing, and raises no alarm', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 1000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 200;
        let swallowed = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (swallowed ? next() : new Promise((resolve, reject) => { swallowed = reject; }));
        // Any read would find nothing.
        routes['GET /vacuglide/state'] = () => jsonResponse(null, 503);
        const done = disconnectVacuglide();
        await waitFor(() => swallowed !== null, 1000, 'the stop to go out');
        await tick(300);
        assert.equal(sent('/vacuglide/state').length, 0, 'nothing reads a device at rest');
        swallowed(new TypeError('Failed to fetch'));
        assert.equal((await done).confirmed, true);
        assert.deepEqual(unconfirmed, []);
        assert.equal(isVacuglideOfflineStopPending(), false);
    });

    // A part of a stop still unanswered a read beat after it went out, to a
    // device that may be moving, may not have reached it: the device is read
    // then, at once - not a beat after that, two beats after the stop.
    it('a stop still unanswered a read beat after it went out has the device read at once, not a beat later', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 20000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 500;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 200;
        dispatchVacuglide(40);
        await waitFor(() => isVacuglideMoving() && device.targetSpeed === 40, 1000, 'the session to run');
        await tick(60);
        let answer = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (answer ? next() : new Promise((resolve) => { answer = () => resolve(next()); }));
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => answer !== null, 1000, 'STOP to go out');
        const stopAt = sent('/vacuglide/target-speed/stop')[0].at;
        await waitFor(() => sent('/vacuglide/state').length > 0, 2000, 'the first read');
        const after = sent('/vacuglide/state')[0].at - stopAt;
        assert.ok(after >= 490 && after < 900, `the first read went out ${after} ms after the stop, with a 500 ms beat`);
        answer();
        await waitFor(() => !isVacuglideMoving(), 2000, 'every stop to settle');
    });

    // A stop answered within a read beat needs no read: its own answers say
    // the device is at rest.
    it('a stop answered within a read beat reads nothing', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 150;
        dispatchVacuglide(40);
        await waitFor(() => isVacuglideMoving(), 1000, 'the session to run');
        await tick(60);
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => new Promise((resolve) => setTimeout(() => resolve(next()), 60));
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        await tick(400);
        assert.equal(sent('/vacuglide/state').length, 0);
        assert.equal(isVacuglideWatchPending(), false);
    });

    // A stop that fails says nothing about a device a whole stop sent after
    // it has confirmed at rest: STOP's requests, stalled and then refused,
    // failed long after Disconnect's stop had been confirmed, and raised the
    // "may still be running" alarm over a device that was stopped.
    it('a stop that fails after a whole stop sent after it was confirmed raises no alarm', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        let phase = 'stall';
        const stalled = [];
        const route = ({ next, body }) => {
            if (body && body.valveState === true) return next();
            if (phase === 'stall') return new Promise((resolve, reject) => stalled.push(reject));
            if (phase === 'refuse') return jsonResponse(null, 503);
            return next();
        };
        for (const r of ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus']) routes[r] = route;
        const stopped = stopVacuglide();
        await waitFor(() => stalled.length === 3, 1000, "STOP's requests to go out");
        phase = 'pass';
        const disconnected = await disconnectVacuglide();
        assert.equal(disconnected.confirmed, true);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        phase = 'refuse';
        for (const reject of stalled) reject(new TypeError('Failed to fetch'));
        assert.equal(await stopped, false, 'STOP itself failed');
        assert.deepEqual(unconfirmed, [], "Disconnect's stop was confirmed after STOP went out");
        assert.equal(isVacuglideOfflineStopPending(), false);
        phase = 'pass';
    });

    // A speed the server refused outright never reached the device, so it
    // does not make a motor found running the session's own: a speed from
    // before the stop, landing late, is still stopped.
    it('a speed refused outright after a stop does not stand for a late one found running', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, 'the STOP to be confirmed');
        // Its request fails without an answer: it may still land.
        await failAndRestop(held);
        // The session asks for a speed again, and the server refuses it.
        routes['PUT /vacuglide/target-speed'] = () => jsonResponse({ error: { code: 'FST_ERR_VALIDATION', message: 'body/targetSpeed must be <= 100' } }, 400);
        dispatchVacuglide(30);
        await waitFor(() => sent('/vacuglide/target-speed').some((c) => c.body.targetSpeed === 30 && c.status === 400), 1000, 'the refusal');
        routes['PUT /vacuglide/target-speed'] = undefined;
        dispatchVacuglide(0);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
    });

    // A speed goes out only once every whole stop still out for the link has
    // settled, not only the newest: an older stop's retry landing after the
    // speed would stop the session with nothing to say so.
    it('a speed waits for every stop still out, not only the newest', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        let releaseFirst = null;
        let first = true;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (!first) return next();
            first = false;
            return new Promise((resolve) => { releaseFirst = () => resolve(next()); });
        };
        dispatchVacuglide(0, true);
        await waitFor(() => releaseFirst !== null, 1000, 'the first stop to go out');
        // A second STOP, answered at once.
        assert.equal(await stopVacuglide(), true);
        const speeds = sent('/vacuglide/target-speed').length;
        dispatchVacuglide(35);
        await tick(100);
        assert.equal(sent('/vacuglide/target-speed').length, speeds, 'the first stop is still out');
        releaseFirst();
        await waitFor(() => sent('/vacuglide/target-speed').length === speeds + 1, 1000, 'the speed, after every stop');
        await waitFor(() => device.targetSpeed === 35 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
    });

    // What an older stop confirmed says about the device is older than what
    // a newer stop went out for: only the newest one settles it.
    it('an older stop confirmed after a newer one went out does not settle the device', async () => {
        await connectOk();
        const releases = [];
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === false
            ? new Promise((resolve) => releases.push(() => resolve(next())))
            : next());
        // STOP, with its close of Valve + held.
        dispatchVacuglide(0, true);
        await waitFor(() => releases.length === 1, 1000, 'the first stop to go out');
        // Valve + is found open after it went out: a stop of its own.
        device.strokePlusValve = true;
        await pollVacuglideConnected();
        await waitFor(() => releases.length === 2, 1000, 'the second stop to go out');
        assert.equal(isVacuglideValveOpen('plus'), true);
        releases[0]();
        await tick(40);
        assert.equal(isVacuglideValveOpen('plus'), true, 'the first stop settles nothing while the second is out');
        releases[1]();
        await waitFor(() => !isVacuglideValveOpen('plus'), 1000, 'the newest stop to settle the device');
        assert.equal(device.strokePlusValve, false);
    });

    // A whole stop's three requests go out together, and each one's reply
    // may show the device from before the other two landed. Those replies
    // are not the device moving after that stop: a stop sent for each of
    // them would have its own closes answered the same way, one stop after
    // another.
    it('a stop whose closes are answered before its motor stop lands sets off no other stop', async () => {
        await connectOk();
        // The motor stop lands within a read beat: only the stop's own
        // replies say anything about the device.
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => new Promise((resolve) => setTimeout(() => resolve(next()), 150));
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        await tick(100);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    // The same replies, read against what the stop has had confirmed. A
    // speed that lands after STOP's motor stop was confirmed, and shows in
    // the answer to one of STOP's closes, is the device running after its
    // stop reached it: the whole stop goes out again at once, not at the
    // watch's next read. Every part of that stop goes out after the
    // confirmation, so it sets off no other.
    it("a motor seen running in the answer to one of STOP's closes, once STOP's motor stop was confirmed, gets one whole stop at once", async () => {
        await connectOk();
        // A beat long enough that only that answer can have sent the stop
        // this soon: the watch's first read is a second away.
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 1000;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.apply !== null, 1000, 'the speed to go out');
        // STOP's close of Valve + is taken, and answered, when the test says.
        let release = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next }) => {
            if (release) return next();
            return new Promise((resolve) => { release = () => resolve(next()); });
        };
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => release !== null && stopsOn() === 1, 1000, "STOP's motor stop to land, and its close of Valve + to be held");
        await tick(20);
        held.land();
        const landed = speedLanded(55);
        assert.ok(landed, 'the late speed landed after STOP');
        release();
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'stop'), 1000, 'the late speed to be stopped');
        const stoppedAt = eventsAfter(landed).find((e) => e.what === 'stop').at;
        assert.ok(stoppedAt - landed.at < 400, `the motor ran ${stoppedAt - landed.at} ms after the late speed landed`);
        const again = sent('/vacuglide/target-speed/stop')[1];
        const firstRead = sent('/vacuglide/state')[0];
        assert.ok(!firstRead || firstRead.at >= again.at, 'sent on the answer, not on a read');
        await tick(200);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 2, 'one whole stop, and no stop set off by its own replies');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)));
        assert.deepEqual(unconfirmed, [], "STOP's motor stop was answered: it reached the device");
    });

    // The same for a valve: STOP's closes are confirmed, and a valve found
    // open in the answer to STOP's motor stop was opened after its close
    // reached the device - by another app with the same token, since
    // nothing of EdgeLoop's was out.
    it("a valve seen open in the answer to STOP's motor stop, once STOP's close of it was confirmed, gets one whole stop at once", async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (release) return next();
            return new Promise((resolve) => { release = () => resolve(next()); });
        };
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => release !== null && sent('/vacuglide/valve/stroke-plus').length === 1 && sent('/vacuglide/valve/stroke-minus').length === 1, 1000, "STOP's closes to go out, and its motor stop to be held");
        await tick(20);
        device.strokePlusValve = true;
        device.events.push({ at: Date.now(), what: 'valve', valve: 'plus', open: true });
        const openedAt = Date.now();
        release();
        await waitFor(() => !device.strokePlusValve, 1000, 'the valve to be closed');
        assert.ok(Date.now() - openedAt < 400, `Valve + stayed open ${Date.now() - openedAt} ms`);
        assert.equal(sent('/vacuglide/state').length, 0, 'sent on the answer: nothing read the device');
        await tick(100);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 2, 'one whole stop, and no stop set off by its own replies');
        assert.equal(openSpans('plus').length, 1, 'open once, and closed');
        await waitFor(() => !isVacuglideValveOpen('plus'), 1000, 'the panel to read Valve + closed');
        assert.ok(valveNotes.some((m) => m && /Valve \+ \(stroke plus\) was open after EdgeLoop had stopped the VacuGlide/.test(m)));
        assert.deepEqual(unconfirmed, []);
    });

    // A press can go out while a stop is out. A close of that stop's the
    // cloud takes while the press holds its valve open, and answers once the
    // press has closed it again, confirmed, shows the valve from before that
    // close: no stop for it, and no word of a valve found open.
    it("a valve a press opened and closed while one of STOP's closes was held back is not found open in that close's late answer", async () => {
        await connectOk();
        let take = null;
        let answer = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (take !== null || body.valveState !== false) return next();
            let reply = null;
            take = () => { reply = next(); };
            return new Promise((resolve) => { answer = () => resolve(reply); });
        };
        calls = [];
        dispatchVacuglide(0, true);
        await waitFor(() => take !== null && sent('/vacuglide/valve/stroke-minus').length === 1, 1000, 'STOP to go out, with its close of Valve + held');
        await tick(20);
        const press = pulseValve('minus', 300);
        await waitFor(() => device.strokeMinusValve, 1000, 'the press to open Valve -');
        take();
        assert.equal((await press).ok, true);
        assert.equal(device.strokeMinusValve, false);
        answer();
        await waitFor(() => !isVacuglideMoving() && !isVacuglideValveOpen('plus') && !isVacuglideValveOpen('minus'), 1000, 'STOP to settle');
        await tick(100);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1, 'no stop for a valve the press had closed');
        assert.ok(!valveNotes.some((m) => m && /was open after EdgeLoop had stopped/.test(m)), JSON.stringify(valveNotes));
        assert.deepEqual(unconfirmed, []);
    });

    // A stop part landing late is no harm, but a stop that goes out while
    // one is still unanswered is a stop sent to a cloud that is holding
    // requests back: the device is read for as long as that part could
    // land, like a speed or an open.
    it('a stop that goes out while a part of an earlier stop is unanswered reads the device for that part\'s window', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 300;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 200;
        let held = false;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            if (held) return next();
            held = true;
            return new Promise(() => {});
        };
        dispatchVacuglide(0, true);
        await waitFor(() => held, 1000, 'STOP to go out');
        assert.equal(isVacuglideWatchPending(), false, 'nothing was unanswered when it went out');
        const secondAt = Date.now();
        dispatchVacuglide(0, true);
        assert.equal(isVacuglideWatchPending(), true, 'the first stop\'s motor stop was');
        await waitFor(() => !isVacuglideWatchPending(), 3000, 'the watch to end');
        assert.ok(Date.now() - secondAt >= 300, `watched for ${Date.now() - secondAt} ms`);
        assert.ok(sent('/vacuglide/state').length >= 4);
        await waitFor(() => !isVacuglideMoving(), 2000, 'every stop to settle');
    });

    it('STOP pressed while an earlier stop is still out closes a valve pressed in between at once', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        // The first STOP's motor stop lands at once, and its answer is held.
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => {
            const reply = next();
            return new Promise((resolve) => { release = () => resolve(reply); });
        };
        dispatchVacuglide(0, true);
        await waitFor(() => release !== null, 1000, 'the first STOP to go out');
        routes['PUT /vacuglide/target-speed/stop'] = undefined;
        const press = pulseValve('plus', 2000);
        await waitFor(() => device.strokePlusValve, 1000, 'the press to open the valve');
        const secondAt = Date.now();
        dispatchVacuglide(0, true);
        await waitFor(() => !device.strokePlusValve, 1000, 'the valve to close');
        assert.ok(Date.now() - secondAt < 500, 'closed by the second STOP, not at the end of its 2 s pulse');
        release();
        await press;
        assert.equal(device.strokePlusValve, false);
    });

    // What the reserve is sized for: 6 whole stops in any window, however
    // much routine traffic went out in it. Past that a stop waits for a
    // slot, goes the moment one frees, and raises the alarm the moment it
    // has to wait. The ceiling and the reserve are the real ones; the window
    // is short, so the wait is.
    it('with the routine budget spent, 6 whole stops go at once, and a seventh raises the alarm and goes as soon as a slot frees', async () => {
        globalThis.localStorage = memoryStorage();
        VACUGLIDE_LIMITS.windowMs = 3000;
        await connectOk();
        // Another page spent the routine share of this window: with the five
        // requests connect sent, 130 of the 150.
        const key = rateLogStorageKey(TOKEN);
        const log = JSON.parse(globalThis.localStorage.getItem(key));
        const at = Date.now();
        for (let i = 0; i < RATE_CEILING - RATE_RESERVE - 5; i += 1) log.e.push([at, 'another page', 0]);
        globalThis.localStorage.setItem(key, JSON.stringify(log));
        assert.equal((await pulseValve('plus', 300)).reason, 'rate', 'routine traffic has nothing left');
        const stopsSent = () => calls.filter((c) => c.method === 'PUT' && c.token === TOKEN).length;
        // One after another, so none goes out while another's requests are
        // unanswered - that would have the device read, which routine
        // traffic cannot do in this window (and says so).
        for (let i = 0; i < 6; i += 1) assert.equal(await stopVacuglide(), true, `whole stop ${i + 1}`);
        assert.equal(stopsSent(), 18, 'six whole stops, none of them held back');
        assert.deepEqual(unconfirmed, []);
        dispatchVacuglide(0, true);
        await tick(20);
        assert.equal(stopsSent(), 20, 'the ceiling reached');
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /^A valve close is held back: .* EdgeLoop sends it in [1-3] s$/);
        await waitFor(() => stopsSent() === 21, 6000, 'the last close, once a slot frees');
        await waitFor(() => !isVacuglideMoving(), 1000, 'the stops to settle');
    });

    // A busy session has spent the routine share of the window when a speed
    // fails without an answer, and the watch reads the device for it. Those
    // reads were refused by EdgeLoop's own budget, and each stretch of them
    // raised the alarm and paused the session. A watch read is a safety read:
    // it has a share routine traffic cannot spend - and it never takes the
    // reserve kept for a stop.
    it('in a busy session the watch still reads the device, in a share of its own, and the reserve kept for a stop stays whole', async () => {
        globalThis.localStorage = memoryStorage();
        VACUGLIDE_LIMITS.windowMs = 3000;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 300;
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        // The rest of the routine share is spent: with connect's /info and
        // the two speeds, 96 - connect's router call and its whole stop are
        // a stop's, and count only against the ceiling.
        const key = rateLogStorageKey(TOKEN);
        const log = JSON.parse(globalThis.localStorage.getItem(key));
        const at = Date.now();
        for (let i = 0; i < RATE_CEILING - RATE_RESERVE - RATE_WATCH_RESERVE - 3; i += 1) log.e.push([at, 'another page', 0]);
        globalThis.localStorage.setItem(key, JSON.stringify(log));
        assert.equal((await pulseValve('plus', 300)).reason, 'rate', 'routine traffic has nothing left');
        calls = [];
        held.fail();
        await waitFor(() => isVacuglideWatchPending(), 1000, 'the watch for the speed');
        await waitFor(() => !isVacuglideWatchPending(), 2000, 'the watch to end');
        assert.ok(sent('/vacuglide/state').length >= 3, `the watch read the device ${sent('/vacuglide/state').length} times`);
        assert.deepEqual(unconfirmed, [], 'no alarm: every read was made');
        // Six whole stops still go at once: the watch took nothing of theirs.
        for (let i = 0; i < 6; i += 1) assert.equal(await stopVacuglide(), true, `whole stop ${i + 1}`);
        assert.deepEqual(unconfirmed, []);
    });

    it('the unload stop with a speed still out: a page that comes back watches for it', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        assert.equal(stopVacuglideOnUnload(), true);
        assert.equal(isVacuglideWatchPending(), true, 'a page that was only frozen comes back to a watch');
        // Back: the next idle tick confirms the stop nobody read.
        dispatchVacuglide(0);
        await waitFor(() => !isVacuglideMotionUnknown() && !isVacuglideMoving(), 1000, 'the stop to be confirmed');
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
    });

    it('a speed still out when the link is lost, that lands after the background stop was confirmed, is stopped again', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        // Autoblow's server stops answering everything else for a while.
        let outage = true;
        const unreachable = ({ next }) => {
            if (outage) throw new TypeError('Failed to fetch');
            return next();
        };
        for (const route of ['GET /vacuglide/state', 'GET /vacuglide/connected', 'PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus']) {
            routes[route] = unreachable;
        }
        for (let i = 0; i < 3; i += 1) await pollVacuglideConnected();
        assert.equal(offline.length, 1, 'three missed link checks lose the link');
        assert.equal(isVacuglideOfflineStopPending(), true, 'a device that may be running is chased');
        await waitFor(() => unconfirmed.length === 1, 2000, 'the alarm while nothing can be confirmed');
        outage = false;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop to be confirmed');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        // The speed's request fails without an answer, as it would time out.
        await failAndRestop(held);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        await waitFor(() => lateStops.length === 1, 1000, 'the panel to be told');
        assert.equal(unconfirmed.length, 1, 'no second alarm: the device confirmed this stop');
    });

    it('a device the background stop is chasing, seen running by the watch, gets a whole stop at once, which ends the chase, and one alarm', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
        VACUGLIDE_TIMINGS.offlineStopRetryMs = 5000;
        dispatchVacuglide(50);
        await tick(60);
        // A speed still out keeps the device watched for its motor.
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        device.online = false;
        await pollVacuglideConnected();
        assert.equal(isVacuglideConnected(), false);
        await waitFor(() => unconfirmed.length === 1, 2000, 'the alarm: the device is not online');
        assert.equal(isVacuglideOfflineStopPending(), true);
        // Back online and still running at 50, with the next round 5 s away.
        const backAt = Date.now();
        device.online = true;
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 3000, 'the device to be stopped');
        assert.ok(Date.now() - backAt < UNDONE_WITHIN_MS, 'the watch sent a stop at once instead of waiting for the next round');
        await waitFor(() => !isVacuglideOfflineStopPending(), 1000, 'the confirmed stop to end the chase, 5 s before its next round');
        assert.equal(unconfirmed.length, 1, 'one alarm, not one per sighting');
        assert.equal(lateStops.length, 0, 'it was never confirmed at rest, so it did not start again');
    });

    for (const [how, loseLink] of [
        ['three missed link checks', async () => {
            routes['GET /vacuglide/state'] = () => { throw new TypeError('Failed to fetch'); };
            for (let i = 0; i < 3; i += 1) await pollVacuglideConnected();
            routes['GET /vacuglide/state'] = undefined;
        }],
        ['a device that left online mode', async () => {
            device.online = false;
            await pollVacuglideConnected();
            device.online = true;
        }],
        ['a fault a reply reports', async () => {
            device.operationalMode = 'ERROR_MOTOR_STUCK';
            await pollVacuglideConnected();
        }],
        ['five failed command ticks', async () => {
            // The speed that is out stays out, and no other can go while it
            // is, so the ticks that fail here are zero ticks whose whole stop
            // the cloud cannot be reached for - every request of it, or the
            // tick is not a failed one.
            const stopPaths = ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus'];
            for (const route of stopPaths) routes[route] = () => { throw new TypeError('Failed to fetch'); };
            for (let i = 0; i < 5 && isVacuglideConnected(); i += 1) {
                dispatchVacuglide(0);
                await waitFor(() => !isVacuglideConnected() || unconfirmed.length > i, 2000, `failed tick ${i + 1}`);
            }
            for (const route of stopPaths) routes[route] = undefined;
        }]
    ]) {
        it(`a speed still out when the link is lost to ${how} is watched for, and stopped when it lands`, async () => {
            await connectOk();
            // It lands while its request is still out: the watch has to start
            // when the link is lost, not when the speed fails.
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 400;
            dispatchVacuglide(40);
            await tick(60);
            const held = holdNextSpeed();
            dispatchVacuglide(55);
            await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
            await loseLink();
            assert.equal(isVacuglideConnected(), false, 'the link is lost');
            assert.equal(isVacuglideWatchPending(), true, 'the speed still out is watched for');
            await waitFor(() => !isVacuglideOfflineStopPending(), 3000, 'the background stop to be confirmed');
            const { ran } = await landAndStop(held, 55);
            assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
            await waitFor(() => lateStops.length === 1, 1000, 'the panel to be told');
        });
    }

    it('the watch follows a device that dropped out and came back through another cluster, and stops it there', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        await failAndRestop(held);
        // The speed lands, unanswered, and the device then drops out and
        // joins again through another cluster - running what had landed.
        held.land();
        device.cluster = OTHER_CLUSTER;
        const landed = speedLanded(55);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'stop'), 3000, 'the late speed to be stopped where the device is now');
        const ran = eventsAfter(landed).find((e) => e.what === 'stop').at - landed.at;
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        assert.ok(calls.some((c) => c.host === LATENCY && c.path === '/vacuglide/connected'), 'the router was asked where it went');
        assert.ok(sent('/vacuglide/target-speed/stop').some((c) => c.host === OTHER_CLUSTER), 'and it was stopped there');
        await waitFor(() => sent('/vacuglide/state').some((c) => c.host === OTHER_CLUSTER), 1000, 'the watch to read where it went');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        // The read on the cluster it had left could not see it: the alarm,
        // once, and a chase that went to where the router said it was.
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it \(Device not connected/);
    });

    it('the same device connected again: a speed from the last link that lands while it is idle is stopped', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        await disconnectVacuglide();
        await connectVacuglide(TOKEN);
        // The old link's speed fails without an answer; the stop sent again
        // for it goes through the new link.
        await failAndRestop(held);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        assert.ok(notices.some((m) => /running although EdgeLoop had stopped it/.test(m)), JSON.stringify(notices));
        assert.equal(isVacuglideConnected(), true, 'the new link is untouched');
        assert.equal(lateStops.length, 0, 'the device is connected: its own panel says it');
    });

    // Disconnect's stop goes to the cluster the device was on. A device that
    // dropped out and came back through another cluster refuses it there,
    // four times over, and by the time it has failed the wearer may have
    // connected the device again on its new cluster - with a confirmed stop
    // of its own, after that one went out - and started a session on it.
    it('a stop from the last link that fails after the same device was connected again raises no alarm, and leaves the new session running', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.stopRetryDelaysMs = [200, 200, 200];
        dispatchVacuglide(40);
        await tick(60);
        device.cluster = OTHER_CLUSTER;
        const disconnected = disconnectVacuglide();
        await tick(20);
        await connectVacuglide(TOKEN);
        sessionActive = true;
        dispatchVacuglide(60);
        await waitFor(() => device.targetSpeed === 60 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session on the new link');
        const stops = stopsOn();
        assert.deepEqual(await disconnected, { confirmed: false, mayHaveMoved: true, watching: false }, 'the old stop did fail');
        await tick(300);
        assert.deepEqual(unconfirmed, [], 'no alarm: the new link confirmed the device at rest after that stop went out');
        assert.equal(isVacuglideOfflineStopPending(), false, 'and nothing chases it');
        assert.equal(stopsOn(), stops, 'the session is left running');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.equal(isVacuglideConnected(), true);
    });

    it('a press still closing on the last link, whose close fails after the same device was connected again, raises no alarm', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.stopRetryDelaysMs = [200, 200, 200];
        const pressed = pulseValve('plus', 1000);
        await waitFor(() => device.strokePlusValve === true, 1000, 'the valve to open');
        // Dropped out and back through another cluster, the valve still open.
        device.cluster = OTHER_CLUSTER;
        const disconnected = disconnectVacuglide();
        await tick(20);
        await connectVacuglide(TOKEN);
        assert.equal(device.strokePlusValve, false, 'the new link closed both valves, confirmed');
        const result = await pressed;
        await disconnected;
        await tick(300);
        assert.deepEqual(unconfirmed, []);
        assert.equal(isVacuglideOfflineStopPending(), false);
        assert.notEqual(result.reason, 'close-unconfirmed');
        assert.equal(device.strokePlusValve, false);
    });

    // A read of the watch's goes out through the cluster the device is on;
    // the device drops out and comes back through another one, and the
    // wearer connects it again there and starts a session. That read then
    // fails - DeviceNotConnectedError, from the cluster it has left - after
    // the new link confirmed the device at rest. It says nothing of the
    // device: the read is made again through the new link, and the alarm
    // goes up only when that one cannot see the device either.
    for (const [what, newLinkSees] of [['the new link reads it', true], ['the new link cannot read it either', false]]) {
        it(`a watch read that fails on the cluster the device has left, after it was connected again on its new one: ${what}`, async () => {
            await connectOk();
            VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
            VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
            dispatchVacuglide(40);
            await tick(60);
            const held = holdNextSpeed();
            dispatchVacuglide(55);
            await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
            await disconnectVacuglide();
            // The speed fails without an answer: it may land for a while yet,
            // and the device is watched for it.
            await failAndRestop(held);
            assert.equal(isVacuglideWatchPending(), true);
            let failRead = null;
            routes['GET /vacuglide/state'] = ({ host, next }) => {
                if (host !== CLUSTER || failRead) return next();
                return new Promise((resolve) => { failRead = () => resolve(NOT_CONNECTED()); });
            };
            await waitFor(() => failRead !== null, 1000, 'a read of the watch on the cluster the device is on');
            device.cluster = OTHER_CLUSTER;
            await connectVacuglide(TOKEN);
            sessionActive = true;
            dispatchVacuglide(60);
            await waitFor(() => device.targetSpeed === 60 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session on the new link');
            const stops = stopsOn();
            if (!newLinkSees) routes['GET /vacuglide/state'] = ({ host, next }) => (host === OTHER_CLUSTER ? jsonResponse(null, 503) : next());
            const before = calls.length;
            failRead();
            await tick(150);
            assert.ok(calls.slice(before).some((c) => c.path === '/vacuglide/state' && c.host === OTHER_CLUSTER), 'read again through the new link');
            if (newLinkSees) {
                assert.deepEqual(unconfirmed, [], 'no alarm: the new link confirmed it at rest, and sees it running the session');
                assert.equal(isVacuglideMotionUnknown(), false);
                assert.equal(stopsOn(), stops, 'the session runs on');
                assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
            } else {
                assert.equal(unconfirmed.length, 1, 'nothing can see it: the alarm');
                assert.match(unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it/);
                assert.equal(isVacuglideMotionUnknown(), true);
            }
        });
    }

    // Disconnect's stop is not confirmed and is being tried again when the
    // wearer connects the same device again and starts a session: those
    // retries landed in the session and stopped the motor, with nothing here
    // to say so. The new link's confirmed stop ends them.
    it('a Disconnect stop still being tried again ends once the same device is connected again here, and none of it lands in the new session', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.stopRetryDelaysMs = [200, 200, 200];
        dispatchVacuglide(40);
        await tick(60);
        let refuse = true;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (refuse ? jsonResponse({ error: { code: 'InternalServerError', message: 'Internal server error' } }, 500) : next());
        const disconnected = disconnectVacuglide();
        await waitFor(() => sent('/vacuglide/target-speed/stop').length === 1, 1000, "Disconnect's stop to go out");
        refuse = false;
        await connectVacuglide(TOKEN);
        sessionActive = true;
        dispatchVacuglide(60);
        await waitFor(() => device.targetSpeed === 60 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session on the new link');
        const started = sessionStarted(60);
        await disconnected;
        await tick(300);
        assert.deepEqual(eventsAfter(started).filter((e) => e.what === 'stop'), [], 'no stop of the last link landed in the session');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.deepEqual(unconfirmed, []);
    });

    // A stop of the last link already on its way lands in the new session
    // all the same. The device is read when its answer comes back, found
    // stopped under the session, and the session pauses: nothing here starts
    // it again behind that stop - RESUME does.
    it('a stop of the last link that lands in the new session is noticed: the device is read, the session pauses, and only RESUME starts it again', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 20000;
        // The new link watches for that stop too, but on a beat too long to
        // be what reads the device here: its answer coming back is.
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        let land = null;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (land ? next() : new Promise((resolve) => { land = () => resolve(next()); }));
        const disconnected = disconnectVacuglide();
        await waitFor(() => land !== null, 1000, "Disconnect's stop to go out");
        await connectVacuglide(TOKEN);
        sessionActive = true;
        dispatchVacuglide(60);
        await waitFor(() => device.targetSpeed === 60 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session on the new link');
        const before = calls.length;
        land();
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the old stop to land');
        await waitFor(() => calls.slice(before).some((c) => c.path === '/vacuglide/state'), 1000, 'the device to be read, at once');
        await waitFor(() => stoppedElsewhere.length === 1, 1000, 'the page told to pause the session');
        assert.match(stoppedElsewhere[0], /stopped while the session was driving it/);
        // Until the page has paused it, the session's ticks start nothing.
        dispatchVacuglide(60);
        dispatchVacuglide(65);
        await tick(100);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        // The pause, and RESUME.
        sessionActive = false;
        dispatchVacuglide(0, true);
        await waitFor(() => !isVacuglideMoving(), 1000, "the pause's stop");
        sessionActive = true;
        dispatchVacuglide(65);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING' && device.targetSpeed === 65, 1000, 'RESUME to start it');
        await disconnected;
        assert.deepEqual(unconfirmed, []);
    });

    it('the same device connected again: a speed from the last link that lands in the new session is replaced by the session\'s own', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        // Sent under the cap the wearer had then; never answered.
        const held = holdNextSpeed();
        dispatchVacuglide(90);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        await disconnectVacuglide();
        await connectVacuglide(TOKEN);
        // The old speed fails without an answer, and the stop sent again
        // for it is confirmed, before the new session starts.
        await failAndRestop(held);
        dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the new session to run');
        held.land();
        const landed = speedLanded(90);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 30), 2000, 'the session\'s speed to go out again');
        const resentAt = eventsAfter(landed).find((e) => e.what === 'speed' && e.value === 30).at;
        assert.ok(resentAt - landed.at < UNDONE_WITHIN_MS, `the device ran at the old speed for ${resentAt - landed.at} ms`);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the session is not stopped for it');
        assert.ok(!eventsAfter(landed).some((e) => e.what === 'stop'), 'nor paused');
        assert.ok(notices.some((m) => /running at 90% instead of the 30% EdgeLoop sent/.test(m)), JSON.stringify(notices));
    });

    it('a speed nobody answered that lands later in a running session is replaced by the session\'s own at once', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(90);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        held.fail();
        await waitFor(() => isVacuglideMotionUnknown(), 1000, 'the speed to fail without an answer');
        // The session carries on.
        dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50, 1000, 'the next speed');
        held.land();
        const landed = speedLanded(90);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 50), 2000, 'the session\'s speed to go out again');
        const resentAt = eventsAfter(landed).find((e) => e.what === 'speed' && e.value === 50).at;
        assert.ok(resentAt - landed.at < UNDONE_WITHIN_MS, `the device ran at the lost speed for ${resentAt - landed.at} ms`);
        assert.ok(!eventsAfter(landed).some((e) => e.what === 'stop'), 'the session is not stopped for it');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.ok(notices.some((m) => /running at 90% instead of the 50% EdgeLoop sent/.test(m)), JSON.stringify(notices));
    });

    it('another device connected since: the one let go of is still watched, quietly, and stopped when a late speed lands', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        await disconnectVacuglide();
        const otherToken = `${TOKEN}b`;
        const second = makeDevice();
        otherDevices.set(otherToken, second);
        await connectVacuglide(otherToken);
        dispatchVacuglide(30);
        await waitFor(() => second.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the second device to run');
        // The first device's speed fails without an answer, and the stop
        // sent again for it is confirmed.
        await failAndRestop(held);
        errors = [];
        const secondBefore = second.events.length;
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the first device ran ${ran} ms after the late speed landed`);
        await waitFor(() => lateStops.length === 1, 1000, 'the driver to say so');
        assert.equal(second.operationalMode, 'TARGET_SPEED_PLAYING', 'the device connected now keeps running');
        assert.equal(second.targetSpeed, 30);
        assert.ok(!second.events.slice(secondBefore).some((e) => e.what === 'stop'), 'and is not stopped for the other one');
        assert.deepEqual(errors.filter(Boolean), [], 'nothing about the first device reached the panel of the second');
        assert.ok(calls.filter((c) => c.token === TOKEN).every((c) => c.host === CLUSTER || c.host === LATENCY));
        assert.equal(getVacuglideToken(), otherToken);
    });

    // A request of a device let go of answers for that device alone. Its
    // failure after another device was connected is not that device's: it
    // paints nothing on its panel and does not count toward it going
    // offline, which four failed commands of its own have brought to the
    // brink here - the fifth of its own is what takes it offline.
    it('a request of a device let go of that fails after another device was connected neither shows on its panel nor counts toward it going offline', async () => {
        await connectOk();
        dispatchVacuglide(40);
        await tick(60);
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        await disconnectVacuglide();
        const otherToken = `${TOKEN}b`;
        otherDevices.set(otherToken, makeDevice());
        await connectVacuglide(otherToken);
        routes['PUT /vacuglide/target-speed'] = ({ token, next }) => (token === otherToken
            ? jsonResponse({ error: { code: 'InternalServerError', message: 'Internal server error' } }, 500)
            : next());
        const failedOwn = () => calls.filter((c) => c.token === otherToken && c.path === '/vacuglide/target-speed').length;
        for (let i = 1; i <= 4; i++) {
            dispatchVacuglide(30 + i);
            await waitFor(() => failedOwn() === i, 1000, `command ${i} of the device connected now to fail`);
            await tick(60);
        }
        assert.deepEqual(offline, []);
        held.fail();
        await waitFor(() => calls.some((c) => c.token === TOKEN && c.path === '/vacuglide/target-speed/stop' && c.at > held.sentAt), 1000, 'the first device to be sent the stop again');
        await tick(30);
        assert.equal(getVacuglideToken(), otherToken, 'still connected');
        assert.deepEqual(offline, [], 'the first device\'s failure counted nothing toward it');
        assert.ok(!errors.some((m) => m && /Network error/.test(m)), JSON.stringify(errors));
        dispatchVacuglide(35);
        await waitFor(() => offline.length === 1, 1000, 'its own fifth failed command to take it offline');
    });

    // A reply is read by the link the device is connected through now,
    // whichever link sent its request. A press made before Disconnect whose
    // open went unanswered is still closing its valve on the beat through
    // the old link when the device is connected again and driven: those
    // closes answer with the new session's motor running, which is not a
    // device left moving - it must not be stopped for it.
    it('a reply to a request of the old link, once the device is connected again and driven, is read by the new link', async () => {
        await connectOk();
        let rejectOpen = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true) return next();
            return new Promise((resolve, reject) => { rejectOpen = reject; });
        };
        const press = pulseValve('plus', 300);
        await waitFor(() => rejectOpen !== null, 1000, 'the open to go out');
        await tick(400);
        await disconnectVacuglide();
        await connectVacuglide(TOKEN);
        dispatchVacuglide(50);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING' && device.targetSpeed === 50, 1000, 'the new session to run');
        const driven = speedLanded(50);
        const beatCloses = () => eventsAfter(driven).filter((e) => e.what === 'valve' && e.valve === 'plus' && !e.open);
        await waitFor(() => beatCloses().length >= 1, 3000, 'the press to close its valve on the beat again');
        await tick(100);
        assert.ok(!eventsAfter(driven).some((e) => e.what === 'stop'), 'the new session was not stopped');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        assert.equal(device.targetSpeed, 50);
        assert.equal(getValvePulse() !== null, true, 'the press was still closing on the beat');
        rejectOpen(new TypeError('Failed to fetch'));
        await press;
    });

    // A read that cannot see the device, while a command EdgeLoop sent may
    // still land on it, is a device nobody can say is at rest: the alarm goes
    // up at that read - it used to wait for the window to close, a minute
    // later, while the panel said EdgeLoop would stop the device - and one
    // EdgeLoop no longer drives is chased, while the watch reads on.
    it('a device let go of that a read of its watch cannot see raises the alarm at once, and is chased while the watch reads on', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1500;
        dispatchVacuglide(40);
        await tick(60);
        // Never answered; whether it landed nobody can say.
        routes['PUT /vacuglide/target-speed'] = () => new Promise(() => {});
        dispatchVacuglide(55);
        await tick(10);
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        // Disconnect's stop and the one after the speed's timeout, both confirmed.
        await waitFor(() => stopsOn() === 2 && !isVacuglideOfflineStopPending(), 2000, 'the stop after the timeout');
        await tick(20);
        assert.equal(unconfirmed.length, 0);
        // From here the device cannot be seen: it left online mode, with more
        // than a second of its window still to run.
        const blindFrom = Date.now();
        device.online = false;
        await waitFor(() => unconfirmed.length === 1, 1000, 'the alarm');
        assert.ok(Date.now() - blindFrom < 500, `the alarm came ${Date.now() - blindFrom} ms after the device went out of sight`);
        assert.match(unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it/);
        assert.equal(isVacuglideOfflineStopPending(), true, 'it is chased');
        assert.equal(isVacuglideWatchPending(), true, 'and still watched');
        await tick(200);
        assert.equal(unconfirmed.length, 1, 'one alarm while it stays out of sight, not one per read or round');
        device.online = true;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop to be confirmed');
        assert.equal(unconfirmed.length, 1);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('the connected device a read of its watch cannot see raises the alarm, and is not taken to be at rest', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 300;
        dispatchVacuglide(40);
        await tick(60);
        routes['PUT /vacuglide/target-speed'] = () => new Promise(() => {});
        dispatchVacuglide(55);
        await waitFor(() => isVacuglideMotionUnknown(), 1000, 'the speed to time out');
        routes['PUT /vacuglide/target-speed'] = undefined;
        // The session ends; its idle tick stops the device.
        dispatchVacuglide(0);
        await waitFor(() => !isVacuglideMotionUnknown() && !isVacuglideMoving(), 1000, 'the stop');
        // From here every read of the device fails.
        routes['GET /vacuglide/state'] = jsonResponse(null, 503);
        await waitFor(() => unconfirmed.length === 1, 1000, 'the alarm at the first read that failed');
        assert.match(unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it \(HTTP 503/);
        assert.equal(isVacuglideWatchPending(), true, 'the watch reads on');
        await waitFor(() => !isVacuglideWatchPending(), 3000, 'the watch to end');
        assert.equal(unconfirmed.length, 1, 'one alarm for one stretch it could not see');
        assert.equal(isVacuglideMotionUnknown(), true, 'a device nobody could see is not taken to be at rest');
        routes['GET /vacuglide/state'] = undefined;
        calls = [];
        dispatchVacuglide(0);
        await waitFor(() => !isVacuglideMotionUnknown(), 1000, 'the whole stop');
        assert.equal(calls.length, 3, 'the next idle tick sends the whole stop');
    });

    it('a stop for a device let go of that a late speed restarted, which does not confirm, raises the alarm and keeps going', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        dispatchVacuglide(40);
        await tick(60);
        let refuseStops = false;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (refuseStops ? jsonResponse(null, 503) : next());
        const held = holdNextSpeed();
        dispatchVacuglide(55);
        await waitFor(() => held.sentAt !== null, 1000, 'the speed to go out');
        await disconnectVacuglide();
        await failAndRestop(held);
        refuseStops = true;
        held.land();
        await waitFor(() => unconfirmed.length === 1, 2000, 'the alarm');
        assert.match(unconfirmed[0], /Stop not confirmed/);
        assert.equal(isVacuglideOfflineStopPending(), true, 'the device is chased');
        refuseStops = false;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop to be confirmed');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(lateStops.length, 0, 'not reported as stopped: the alarm said it was not');
    });

    // After a stop, a device should be at rest, and while its watch reads it
    // anything running on it gets the whole stop - whatever started it: a
    // late speed of EdgeLoop's and another app using the same token look the
    // same in a reply. Once the watch has ended nothing reads a device
    // EdgeLoop has let go of, and it belongs to whoever uses it next.
    it('a device let go of that its watch finds running is stopped, whatever started it, and left alone once the watch has ended', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 60;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 60;
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 600;
        // A press whose open nobody answered keeps the device watched, but
        // no speed is out.
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === true ? new Promise(() => {}) : next());
        await pulseValve('plus', 300);
        await disconnectVacuglide();
        assert.equal(isVacuglideWatchPending(), true);
        // Something starts the motor with the same token.
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 20;
        calls = [];
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 2000, 'the watch to stop it');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        assert.equal(device.strokePlusValve, false);
        await waitFor(() => !isVacuglideWatchPending(), 3000, 'the watch to end');
        // It runs again, and nothing reads it any more.
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        calls = [];
        await tick(200);
        assert.equal(calls.length, 0, 'a device let go of, and no longer watched, is not EdgeLoop\'s');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
    });

    // ---- disconnect and unload ---------------------------------------------------------------------

    it('Disconnect sends the whole stop with the token it had, and takes no more commands', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        calls = [];
        const done = await disconnectVacuglide();
        assert.deepEqual(done, { confirmed: true, mayHaveMoved: true, watching: false });
        assert.equal(calls.length, 3);
        assert.ok(calls.every((c) => c.token === TOKEN && c.host === CLUSTER));
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        calls = [];
        dispatchVacuglide(50);
        assert.equal((await pulseValve('plus')).reason, 'offline');
        await tick(20);
        assert.equal(calls.length, 0);
    });

    it('Disconnect of an idle device that does not answer is not an alarm', async () => {
        await connectOk();
        device.online = false;
        const done = await disconnectVacuglide();
        assert.deepEqual(done, { confirmed: false, mayHaveMoved: false, watching: false });
        assert.equal(unconfirmed.length, 0);
        assert.equal(isVacuglideOfflineStopPending(), false);
    });

    it('Disconnect of a running device that does not answer is, and the stop keeps going', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        routes['PUT /vacuglide/target-speed/stop'] = jsonResponse(null, 503);
        const done = await disconnectVacuglide();
        assert.deepEqual(done, { confirmed: false, mayHaveMoved: true, watching: false });
        assert.equal(unconfirmed.length, 1);
        assert.equal(isVacuglideOfflineStopPending(), true);
        routes['PUT /vacuglide/target-speed/stop'] = undefined;
        await waitFor(() => !isVacuglideOfflineStopPending(), 2000, 'the background stop');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('the unload stop is the whole stop, with keepalive, and a page that comes back confirms it', async () => {
        await connectOk();
        dispatchVacuglide(50);
        await tick(60);
        calls = [];
        assert.equal(stopVacuglideOnUnload(), true);
        assert.deepEqual(calls.map((c) => c.path).sort(), [
            '/vacuglide/target-speed/stop',
            '/vacuglide/valve/stroke-minus',
            '/vacuglide/valve/stroke-plus'
        ]);
        assert.ok(calls.every((c) => c.keepalive && c.method === 'PUT' && c.token === TOKEN && c.host === CLUSTER));
        assert.equal(sent('/vacuglide/target-speed/stop')[0].contentType, undefined);
        assert.deepEqual(sent('/vacuglide/valve/stroke-plus')[0].body, { valveState: false });
        assert.equal(isVacuglideMoving(), true, 'a device it left running is not taken to be at rest');
        // A page that comes back idle confirms the stop nobody read ...
        calls = [];
        dispatchVacuglide(0);
        await tick(20);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
        assert.equal(isVacuglideMoving(), false);
        // ... and one whose session is still running sends its speed again.
        dispatchVacuglide(50);
        await tick(60);
        assert.deepEqual(sent('/vacuglide/target-speed').map((c) => c.body.targetSpeed), [50]);
    });

    it('the unload stop reaches the device of a valve pulse still closing after Disconnect', async () => {
        // Disconnect was confirmed, so no background stop chases the device -
        // but the pulse's open is still unanswered and may yet land, and the
        // page that would have closed it again is going away.
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 1500;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === true ? new Promise(() => {}) : next());
        const pending = pulseValve('plus', 300);
        await tick(50);
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        assert.equal(isVacuglideOfflineStopPending(), false);
        assert.notEqual(getValvePulse(), null, 'the pulse is still closing');
        calls = [];
        assert.equal(stopVacuglideOnUnload(), true);
        assert.deepEqual(calls.map((c) => c.path).sort(), [
            '/vacuglide/target-speed/stop',
            '/vacuglide/valve/stroke-minus',
            '/vacuglide/valve/stroke-plus'
        ]);
        assert.ok(calls.every((c) => c.keepalive && c.token === TOKEN && c.host === CLUSTER));
        await pending;
    });

    it('the unload stop reaches a device still watched for a late open', async () => {
        await connectOk();
        VACUGLIDE_TIMINGS.requestTimeoutMs = 60;
        VACUGLIDE_TIMINGS.staleOpenGuardMs = 60;
        VACUGLIDE_TIMINGS.lateCommandWatchMs = 1000;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === true ? new Promise(() => {}) : next());
        assert.equal((await pulseValve('plus', 300)).reason, 'open-failed');
        // Disconnect says the device may have moved: an open nobody answered
        // may still land.
        assert.deepEqual(await disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        assert.equal(isVacuglideWatchPending(), true);
        assert.equal(isVacuglideOfflineStopPending(), false);
        assert.equal(getValvePulse(), null);
        calls = [];
        assert.equal(stopVacuglideOnUnload(), true);
        assert.deepEqual(calls.map((c) => c.path).sort(), [
            '/vacuglide/target-speed/stop',
            '/vacuglide/valve/stroke-minus',
            '/vacuglide/valve/stroke-plus'
        ]);
        assert.ok(calls.every((c) => c.keepalive && c.token === TOKEN && c.host === CLUSTER));
    });

    it('the unload stop goes out even for a device that is only connected, and reaches one being chased', async () => {
        assert.equal(stopVacuglideOnUnload(), false, 'nothing connected, nothing chased');
        assert.equal(calls.length, 0);
        await connectOk();
        assert.equal(stopVacuglideOnUnload(), true, 'the page will not be here to find out what it was doing');
        await disconnectVacuglide();
        await tick(20);
        await connectOk();
        dispatchVacuglide(50);
        await tick(5);
        device.online = false;
        await pollVacuglideConnected();
        await tick(20);
        assert.equal(isVacuglideConnected(), false);
        assert.equal(isVacuglideOfflineStopPending(), true);
        calls = [];
        assert.equal(stopVacuglideOnUnload(), true);
        assert.equal(calls.filter((c) => c.keepalive).length, 3);
    });

    // A page going into the back-forward cache gets pagehide and then freeze,
    // and each sends the unload stop. A device at rest with nothing out is
    // not one to hand over after either: the first used to mark it unknown,
    // and the second then left a stop owed for it - token and all - which the
    // next EdgeLoop page to load, days later maybe, chased with the "may
    // still be running" alarm when the device was switched off.
    it('pagehide and then freeze with the device at rest leave nothing, and the page after it sends nothing', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(40);
        await waitFor(() => page.driver.isVacuglideMoving() && device.targetSpeed === 40, 1000, 'the session to run');
        page.driver.dispatchVacuglide(0, true);
        await waitFor(() => !page.driver.isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the STOP to be confirmed');
        calls = [];
        assert.equal(page.driver.stopVacuglideOnUnload(), true, 'pagehide');
        assert.equal(page.driver.stopVacuglideOnUnload(), true, 'freeze');
        assert.deepEqual(keepaliveStops(), [...WHOLE_STOP, ...WHOLE_STOP].sort(), 'the whole stop, each time');
        assert.equal(globalThis.localStorage.getItem('vacuglide_handover'), null, 'nothing in doubt, nothing left');
        // The page never comes back, and the device is switched off.
        gonePages.add(page.id);
        page.driver.endVacuglideForTests();
        device.online = false;
        calls = [];
        const next = await loadAnotherPage();
        await tick(150);
        assert.deepEqual(next.seen.takeovers, []);
        assert.deepEqual(next.seen.unconfirmed, []);
        assert.equal(calls.length, 0);
    });

    // ---- a page that goes away with a device in doubt -----------------------------------------
    //
    // A reload, a closed tab, a frozen tab the browser then discards: the page
    // sends the whole stop with keepalive and is gone, and nobody hears that
    // stop land. A speed or a valve open it had sent may land after it, and
    // the device may have been running, or had a valve open, when it went.
    // It leaves every such device in localStorage, and the next EdgeLoop page
    // to load takes it over by itself. Each test drives a page of its own
    // that goes away (goAway: from then on nothing it would send reaches the
    // cloud, as a document that is gone runs nothing), then loads the page
    // after it.

    // A document that is gone runs nothing: no timer of its fires again, and
    // it writes nothing more to storage.
    function goAway(page) {
        const sentStop = page.driver.stopVacuglideOnUnload();
        gonePages.add(page.id);
        page.driver.endVacuglideForTests();
        return sentStop;
    }

    const handoverStored = () => globalThis.localStorage.getItem('vacuglide_handover');
    const lastTakeover = (page) => page.seen.takeovers[page.seen.takeovers.length - 1];

    // Wait until a page has nothing of a takeover left running, so nothing
    // of it reaches the next test.
    async function finished(page, label = 'the page to finish with the device') {
        await waitFor(() => !page.driver.isVacuglideTakeoverPending() && !page.driver.isVacuglideWatchPending()
            && !page.driver.isVacuglideOfflineStopPending(), 5000, label);
    }

    // A page of its own, connected and running at `speed`, whose next speed
    // (`late`) the cloud holds back and never answers. The window it leaves
    // for that speed is the one it would have given it: its request timeout,
    // shortened here once the speed is out, and the watch after it.
    async function pageWithSpeedOut(speed = 40, late = 55) {
        Object.assign(VACUGLIDE_TIMINGS, { requestTimeoutMs: 20000, lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(speed);
        await waitFor(() => device.targetSpeed === speed && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        await tick(60);
        const held = holdNextSpeed();
        page.driver.dispatchVacuglide(late);
        await waitFor(() => held.sentAt !== null, 1000, 'the late speed to go out');
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        return { page, held };
    }

    // The same, but the session was stopped - confirmed - before the next
    // speed went out: the page knows the device is at rest, and what may
    // still land on it is that one speed.
    async function pageWithSpeedOutAfterStop(late = 55) {
        Object.assign(VACUGLIDE_TIMINGS, { requestTimeoutMs: 20000, lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(40);
        await waitFor(() => page.driver.isVacuglideMoving() && !page.driver.isVacuglideWatchPending(), 1000, 'the session to run');
        page.driver.dispatchVacuglide(0, true);
        await waitFor(() => !page.driver.isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the STOP');
        await tick(60);
        const held = holdNextSpeed();
        page.driver.dispatchVacuglide(late);
        await waitFor(() => held.sentAt !== null, 1000, 'the late speed to go out');
        return { page, held };
    }

    // Load the page after the one that went away and wait for it to take the
    // device over; with `stop`, until the whole stop it sends is confirmed.
    async function nextPage({ stop = false } = {}) {
        const before = stopsOn();
        const page = await loadAnotherPage();
        await waitFor(() => page.seen.takeovers.length > 0, 1000, 'the next page to take the device over');
        if (stop) {
            await waitFor(() => stopsOn() > before && !page.driver.isVacuglideOfflineStopPending(), 2000, 'the stop it takes over to be confirmed');
        }
        return page;
    }

    it('a reload in a session with a speed still out: the page after it stops the device, and the speed again when it lands', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        assert.equal(goAway(page), true);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED', 'the unload stop landed');
        assert.ok(handoverStored(), 'the page left the device to the next one');
        const [left] = JSON.parse(handoverStored()).entries;
        assert.equal(left.held, false);
        const next = await nextPage({ stop: true });
        assert.equal(next.seen.takeovers[0].active, true);
        assert.match(next.seen.takeovers[0].message, /went away while the VacuGlide may have been running, and with a command to it that Autoblow's server had not answered/);
        // Taken: what is stored now is the entry the page that took it holds
        // while it answers for the device.
        const stored = JSON.parse(handoverStored()).entries;
        assert.equal(stored.length, 1);
        assert.equal(stored[0].held, true);
        assert.notEqual(stored[0].page, left.page);
        assert.equal(next.driver.isVacuglideConnected(), false, 'nothing is connected by it');
        const { landed, ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        const closes = eventsAfter(landed).filter((e) => e.what === 'valve').map((e) => `${e.valve} ${e.open}`);
        assert.deepEqual(closes.sort(), ['minus false', 'plus false'], 'the whole stop');
        await finished(next);
        assert.equal(next.seen.lateStops.length, 1);
        assert.match(next.seen.lateStops[0], /started running again after EdgeLoop had stopped it/);
        assert.equal(lastTakeover(next).active, false);
        assert.match(lastTakeover(next).message, /reached it late, and EdgeLoop stopped it again/);
        assert.deepEqual(next.seen.unconfirmed, []);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.ok(calls.every((c) => c.token === TOKEN && (c.host === CLUSTER || c.host === LATENCY)));
        assert.equal(handoverStored(), null, 'gone once that page has finished with the device');
    });

    // A host page takes over what a page that went away left once it has
    // loaded - attachVacuglideToPage, which app.js calls, sees to that - and
    // never on the partner viewer or controller page, nor when another tab
    // leaves something. Loading the driver takes nothing over by itself.
    it('loading the driver takes nothing over by itself, and a takeover takes each entry once', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        // Room for a timer a busy machine runs late.
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 2000;
        goAway(page);
        const stored = handoverStored();
        assert.ok(stored);
        const next = await loadAnotherPage({ takeOver: false });
        await tick(100);
        assert.deepEqual(next.seen.takeovers, [], 'nothing taken over by the driver on its own');
        assert.equal(handoverStored(), stored, 'and the entry stays for the page that takes it');
        assert.equal(next.driver.takeOverVacuglideHandover(), 1);
        assert.equal(next.driver.takeOverVacuglideHandover(), 0, 'what it took is gone from storage: asked again, it finds nothing new');
        assert.equal(next.seen.takeovers.length, 1);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        await finished(next);
    });

    it('STOP with a speed still out, then a reload: the page after it watches from its first moment, and stops the speed when it lands', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.dispatchVacuglide(0, true);
        await waitFor(() => !page.driver.isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the STOP to be confirmed');
        goAway(page);
        calls = [];
        const next = await nextPage();
        // Confirmed at rest before the page went: there is nothing to stop,
        // only a speed to watch for - and the first read goes out at once.
        assert.match(next.seen.takeovers[0].message, /left a command to the VacuGlide that Autoblow's server had not answered/);
        assert.equal(next.driver.isVacuglideOfflineStopPending(), false);
        await waitFor(() => calls.length > 0, 1000, 'the first read');
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /vacuglide/state']);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        await finished(next);
        assert.match(lastTakeover(next).message, /reached it late.*The minute in which a command that page sent could still arrive is over/s);
        assert.deepEqual(next.seen.unconfirmed, []);
    });

    // Nothing has looked at the device since the page went away: the page
    // that takes it over reads it at once, not a read beat later - on a beat
    // long enough here to tell the two apart.
    it('a page that takes a device over reads it at once, not a beat later', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 2000;
        page.driver.dispatchVacuglide(0, true);
        await waitFor(() => !page.driver.isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the STOP to be confirmed');
        goAway(page);
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        calls = [];
        const takenAt = Date.now();
        await loadAnotherPage();
        await waitFor(() => sent('/vacuglide/state').length > 0, 1000, 'the first read');
        assert.ok(sent('/vacuglide/state')[0].at - takenAt < 1000, 'read at once');
        held.fail();
    });

    it('Disconnect with a speed still out, then a reload: the page after it takes the watch over, and stops the speed when it lands', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        assert.deepEqual(await page.driver.disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        goAway(page);
        const next = await nextPage();
        assert.equal(next.driver.isVacuglideWatchPending(), true);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        await finished(next);
        assert.equal(next.seen.lateStops.length, 1);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('a reload during a valve press whose open is still out: the page after it closes the valve when the open lands', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        // The open is held back by the cloud, and never answered.
        let landOpen = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => {
            if (body.valveState !== true || landOpen) return next();
            landOpen = next;
            return new Promise(() => {});
        };
        page.driver.pulseValve('plus', 1000);
        await waitFor(() => landOpen !== null, 1000, 'the open to go out');
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        goAway(page);
        assert.equal(device.strokePlusValve, false);
        const next = await nextPage({ stop: true });
        assert.match(next.seen.takeovers[0].message, /may have been running/);
        landOpen();
        assert.equal(device.strokePlusValve, true, 'the late open landed');
        await waitFor(() => openSpans('plus').every(([, closedAt]) => closedAt !== null), 3000, 'the late open to be closed');
        const [openedAt, closedAt] = openSpans('plus').pop();
        assert.ok(closedAt - openedAt < UNDONE_WITHIN_MS, `the valve was open ${closedAt - openedAt} ms after the late open landed`);
        await finished(next);
        assert.equal(next.seen.lateStops.length, 1);
        assert.match(next.seen.lateStops[0], /Valve \+ \(stroke plus\) was open after EdgeLoop had stopped the VacuGlide/);
        assert.equal(device.strokePlusValve, false);
        assert.deepEqual(next.seen.unconfirmed, []);
    });

    it('a reload while a lost device is chased: the page after it raises the alarm at once, and chases it until it confirms', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50, 1000, 'the session to run');
        device.online = false;
        await page.driver.pollVacuglideConnected();
        await waitFor(() => page.seen.unconfirmed.length === 1, 2000, 'the alarm on the page that lost it');
        assert.equal(page.driver.isVacuglideOfflineStopPending(), true);
        goAway(page);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the unload stop could not reach it either');
        const next = await loadAnotherPage();
        await waitFor(() => next.seen.unconfirmed.length === 1, 1000, 'the alarm on the page after it, at once');
        assert.match(next.seen.unconfirmed[0], /Stop not confirmed: the EdgeLoop page that went away never heard the VacuGlide confirm it/);
        assert.equal(next.driver.isVacuglideOfflineStopPending(), true, 'and it chases the device');
        await tick(200);
        assert.equal(next.seen.unconfirmed.length, 1, 'one alarm, not one per round');
        device.online = true;
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 2000, 'the device to be stopped');
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop, with both valves closed/);
        assert.equal(lastTakeover(next).active, false);
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
    });

    // The chase for a lost device ran out after its page went away, with its
    // alarm up and nobody chasing: those minutes were never tried, and the
    // window for a speed it had out closed with nobody watching. EdgeLoop is
    // opened again three hours later. The page that takes it over raises the
    // alarm at once, reads the device, and chases it from the start, not for
    // what is left of a time that has passed - here the device is not back
    // online until well after that time - and says when the page went.
    it('a device whose chase ran out while no page was open is chased again from the start, with its alarm up at once', async () => {
        globalThis.localStorage = memoryStorage();
        VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 35;
        device.online = false;
        const now = Date.now();
        const left = now - 3 * 3600000;
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'before', at: left, speedUntil: left + 66000, openUntil: 0, stopUntil: left + 300000, alarm: true }
        ] }));
        const next = await loadAnotherPage();
        assert.match(next.seen.takeovers[0].message, /^An EdgeLoop page went away 3 hours ago while the VacuGlide may have been running, and with a command to it that Autoblow's server had not answered, and no page has looked at the device since/);
        assert.equal(next.seen.unconfirmed.length, 1);
        assert.match(next.seen.unconfirmed[0], /never heard the VacuGlide confirm it/);
        assert.equal(next.driver.isVacuglideOfflineStopPending(), true, 'and it chases the device');
        // Rounds come every 60 ms here: several go by, and the chase keeps on.
        await waitFor(() => sent('/vacuglide/connected').length >= 5, 3000, 'several rounds of the chase');
        assert.equal(next.driver.isVacuglideOfflineStopPending(), true, 'a chase from the start, not one that had run out');
        assert.equal(next.seen.unconfirmed.length, 1, 'one alarm, not one per round');
        assert.ok(next.seen.takeovers.every((t) => t.active), 'nothing says it was finished with while the alarm stands');
        device.online = true;
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 3000, 'the device to be stopped once it is back');
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop, with both valves closed/);
        assert.ok(sent('/vacuglide/state').length >= 1, 'it was watched as well');
    });

    it('a reload whose unload stop never reached a running device: the page after it stops it', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(40);
        // Answered: the page knows the motor runs, and nothing is out.
        await waitFor(() => page.driver.isVacuglideMoving() && !page.driver.isVacuglideWatchPending(), 1000, 'the session to run');
        // An old browser that drops keepalive requests, or a network that
        // was down at that moment.
        for (const route of ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus']) {
            routes[route] = ({ keepalive, next }) => {
                if (keepalive) throw new TypeError('Failed to fetch');
                return next();
            };
        }
        goAway(page);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        const next = await nextPage({ stop: true });
        assert.match(next.seen.takeovers[0].message, /may have been running or had a valve open, and never heard its last stop land/);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop, with both valves closed/);
        assert.deepEqual(next.seen.unconfirmed, []);
    });

    it('a reload before the session\'s speed was answered, whose unload stop was lost: the page after it finds the device running at its first read', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        // The cloud applies the speed and never answers it, so the page never
        // learns that the motor runs.
        routes['PUT /vacuglide/target-speed'] = ({ next }) => {
            next();
            return new Promise(() => {});
        };
        page.driver.dispatchVacuglide(40);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the speed to land');
        assert.equal(page.driver.isVacuglideMoving(), false);
        for (const route of ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus']) {
            routes[route] = ({ keepalive, next }) => {
                if (keepalive) throw new TypeError('Failed to fetch');
                return next();
            };
        }
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 100;
        goAway(page);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        const running = device.events.find((e) => e.what === 'speed' && e.value === 40);
        const next = await nextPage();
        assert.match(next.seen.takeovers[0].message, /left a command to the VacuGlide that Autoblow's server had not answered/);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the page after it to stop the device');
        assert.ok(eventsAfter(running).some((e) => e.what === 'stop'));
        await finished(next);
        assert.equal(next.seen.lateStops.length, 1);
        assert.deepEqual(next.seen.unconfirmed, []);
    });

    it('a page that goes away with its device at rest and nothing out leaves nothing, and the page after it sends nothing', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(40);
        await waitFor(() => device.targetSpeed === 40, 1000, 'the session to run');
        await tick(20);
        page.driver.dispatchVacuglide(0, true);
        await waitFor(() => !page.driver.isVacuglideMoving() && device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the STOP');
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.equal(goAway(page), true, 'the unload stop still goes out');
        assert.equal(handoverStored(), null, 'nothing in doubt, nothing left');
        calls = [];
        const next = await loadAnotherPage();
        await tick(50);
        assert.deepEqual(next.seen.takeovers, []);
        assert.equal(calls.filter((c) => c.token === TOKEN).length, 0, 'the page after it sends nothing');
        assert.ok(![...globalThis.localStorage.map.values()].some((value) => value.includes(TOKEN)), 'and the token is nowhere in storage');
    });

    // The only EdgeLoop tab was closed with a speed still out, and EdgeLoop
    // was opened again only after the whole window for that speed had
    // closed. The speed landed in between, with no page open to see it, and
    // the device has no watchdog: it runs until something stops it. What the
    // page left is the last read its watch would have made, and the page
    // that loads makes it - however late.
    it('what a page leaves outlives its windows: a speed that landed while no page was open is stopped by the next page to load', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOutAfterStop(55);
        Object.assign(page.driver.VACUGLIDE_TIMINGS, { requestTimeoutMs: 1, lateCommandWatchMs: 20 });
        goAway(page);
        const left = JSON.parse(handoverStored()).entries;
        assert.equal(left.length, 1);
        assert.equal(left[0].stopUntil, 0, 'the device was at rest: all it leaves is the window for the speed');
        held.land();
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the late speed landed, and nobody saw it');
        await tick(120);
        assert.ok(Date.now() > left[0].speedUntil, 'every window in it has run out');
        calls = [];
        const next = await nextPage();
        assert.match(next.seen.takeovers[0].message, /no page was open to watch for it while it could still arrive/);
        await waitFor(() => calls.length > 0, 1000, 'the first read');
        assert.deepEqual(calls.slice(0, 1).map((c) => `${c.method} ${c.path}`), ['GET /vacuglide/state'], 'it reads the device at once');
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'the device to be stopped');
        await finished(next);
        assert.equal(next.seen.lateStops.length, 1);
        assert.match(next.seen.lateStops[0], /started running again after EdgeLoop had stopped it/);
        assert.match(lastTakeover(next).message, /reached it late, and EdgeLoop stopped it again/);
        assert.deepEqual(next.seen.unconfirmed, []);
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
        assert.equal(handoverStored(), null, 'and the token does not stay behind');
        held.fail();
    });

    it('a window that ran out while no page was open, on a device at rest: one read, and nothing sent to it', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOutAfterStop(55);
        Object.assign(page.driver.VACUGLIDE_TIMINGS, { requestTimeoutMs: 1, lateCommandWatchMs: 20 });
        goAway(page);
        held.fail();
        await tick(120);
        calls = [];
        const next = await nextPage();
        await finished(next);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /vacuglide/state'], 'the one read, and no stop');
        assert.equal(lastTakeover(next).active, false);
        assert.deepEqual(next.seen.lateStops, []);
        assert.deepEqual(next.seen.unconfirmed, []);
    });

    // The same, with the device out of reach when the page loads: nobody can
    // say the speed did not land, so the device is chased with the alarm up.
    it('a window that ran out while no page was open, on a device that cannot be reached: the alarm, and the chase', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOutAfterStop(55);
        Object.assign(page.driver.VACUGLIDE_TIMINGS, { requestTimeoutMs: 1, lateCommandWatchMs: 20 });
        goAway(page);
        held.land();
        await tick(120);
        device.online = false;
        const next = await nextPage();
        await waitFor(() => next.seen.unconfirmed.length === 1, 2000, 'the alarm');
        assert.equal(next.driver.isVacuglideOfflineStopPending(), true);
        assert.ok(next.seen.takeovers.every((t) => t.active), 'nothing said it was finished with');
        device.online = true;
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 3000, 'the device to be stopped once it is back');
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop/);
        held.fail();
    });

    it('a page that comes back takes back what it left, and watches for the late speed itself', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        // What another page left for another device, after this one loaded,
        // stays where it is.
        const theirs = { token: 'othertok9876', cluster: CLUSTER, page: 'another', at: Date.now(), speedUntil: Date.now() + 60000, openUntil: 0, stopUntil: 0, alarm: false };
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [theirs] }));
        // Frozen: the unload stop goes out, and the page is still there.
        assert.equal(page.driver.stopVacuglideOnUnload(), true);
        assert.deepEqual(JSON.parse(handoverStored()).entries.map((e) => e.token).sort(), ['othertok9876', TOKEN].sort());
        page.driver.withdrawVacuglideHandover();
        assert.deepEqual(JSON.parse(handoverStored()).entries.map((e) => e.token), ['othertok9876']);
        globalThis.localStorage.removeItem('vacuglide_handover');
        const later = await loadAnotherPage();
        await tick(50);
        assert.deepEqual(later.seen.takeovers, [], 'a page loaded since takes nothing over');
        // The page that came back confirms the stop nobody heard, and its own
        // watch undoes the late speed.
        page.driver.dispatchVacuglide(0);
        await waitFor(() => !page.driver.isVacuglideMotionUnknown(), 1000, 'the stop to be confirmed');
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        // Its request ends at last, and the watch has its window after it.
        held.fail();
        await page.driver.disconnectVacuglide();
        await finished(page, 'the page to finish its watch');
    });

    it('a page that took a device over and goes away itself leaves it to the page after it', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        goAway(page);
        const second = await nextPage({ stop: true });
        assert.equal(goAway(second), true, 'its unload stop reaches the device it took over');
        const third = await nextPage();
        assert.equal(third.driver.isVacuglideWatchPending(), true);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        await finished(third);
        assert.equal(third.seen.lateStops.length, 1);
    });

    it('connecting the device on the page that took it over ends the takeover quietly, and the new link stops the late speed', async () => {
        globalThis.localStorage = memoryStorage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        goAway(page);
        const next = await nextPage({ stop: true });
        await next.driver.connectVacuglide(TOKEN);
        assert.equal(next.driver.isVacuglideTakeoverPending(), false);
        const told = next.seen.takeovers.length;
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        assert.ok(next.seen.notices.some((m) => /running although EdgeLoop had stopped it/.test(m)), JSON.stringify(next.seen.notices));
        assert.equal(next.seen.takeovers.length, told, 'the connected panel is the device\'s own');
        assert.equal(next.seen.lateStops.length, 0);
        await next.driver.disconnectVacuglide();
        await finished(next);
    });

    it('a device taken over that a read of its watch cannot see raises the alarm on the page that took it, is chased, and is not called finished', async () => {
        globalThis.localStorage = memoryStorage();
        const { page } = await pageWithSpeedOut(40, 55);
        await page.driver.disconnectVacuglide();
        goAway(page);
        const next = await nextPage();
        // From here the device cannot be seen: it left online mode.
        device.online = false;
        await waitFor(() => next.seen.unconfirmed.length === 1, 3000, 'the alarm');
        assert.match(next.seen.unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it/);
        assert.equal(next.driver.isVacuglideOfflineStopPending(), true, 'the device is chased');
        assert.ok(next.seen.takeovers.every((t) => t.active), 'and nothing said it was finished with');
        device.online = true;
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop/);
        assert.equal(next.seen.unconfirmed.length, 1);
    });

    it('a stored entry for a host outside autoblowapi.com, or a token that cannot be one, is dropped and nothing is sent', async () => {
        globalThis.localStorage = memoryStorage();
        const now = Date.now();
        const bad = [
            { token: TOKEN, cluster: 'https://collector.evil.example', page: 'x', at: now, speedUntil: now + 60000, openUntil: 0, stopUntil: now + 60000, alarm: true },
            { token: 'has space', cluster: CLUSTER, page: 'x', at: now, speedUntil: now + 60000, openUntil: 0, stopUntil: now + 60000, alarm: false }
        ];
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: bad }));
        const next = await loadAnotherPage();
        await tick(50);
        assert.deepEqual(next.seen.takeovers, []);
        assert.deepEqual(next.seen.unconfirmed, []);
        assert.equal(calls.filter((c) => c.token === TOKEN || c.token === 'has space').length, 0);
        assert.ok(calls.every((c) => !c.host.includes('evil')));
        assert.equal(handoverStored(), null);
    });

    // ---- a page that goes away while a stop it sent is still out ------------------------------
    //
    // Disconnect drops the link at once and then sends the whole stop, which
    // is tried four times; a stop sent again for a speed that landed late,
    // or for a device a watch saw moving, goes out the same way. While such a
    // stop is out the device may still be running, and nothing else may be
    // holding it: no command is out to it for a watch to cover, and the
    // background stop begins only once that stop has failed. A page that
    // goes away then must still send it the whole stop, and leave it to the
    // page after it - pressing Disconnect first must never make leaving the
    // page less safe than leaving without it.

    const STOP_ROUTES = ['PUT /vacuglide/target-speed/stop', 'PUT /vacuglide/valve/stroke-plus', 'PUT /vacuglide/valve/stroke-minus'];

    // The next whole stop sent without keepalive is lost - never applied,
    // never answered, as on a network that is failing. `refuse` fails every
    // such stop at once instead, as a connection that is reset does, and
    // `unload` loses the keepalive stop of a page going away as well.
    function troubleForStops({ refuse = false, unload = false } = {}) {
        const trouble = { lost: 0, on: true };
        for (const route of STOP_ROUTES) {
            let once = true;
            routes[route] = ({ next, keepalive, body }) => {
                if (body && body.valveState === true) return next();
                if (!trouble.on || (keepalive && !unload)) return next();
                if (refuse && !keepalive) {
                    trouble.lost += 1;
                    throw new TypeError('Failed to fetch');
                }
                if (!keepalive && !once) return next();
                if (!keepalive) once = false;
                trouble.lost += 1;
                return new Promise(() => {});
            };
        }
        return trouble;
    }

    const keepaliveStops = () => calls.filter((c) => c.keepalive).map((c) => c.path).sort();
    const WHOLE_STOP = ['/vacuglide/target-speed/stop', '/vacuglide/valve/stroke-minus', '/vacuglide/valve/stroke-plus'];

    async function pageInSession(speed = 40) {
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(speed);
        await waitFor(() => page.driver.isVacuglideMoving() && !page.driver.isVacuglideWatchPending() && device.targetSpeed === speed, 1000, 'the session to run');
        return page;
    }

    for (const [how, refuse] of [['lost', false], ['refused at the network, and waiting to be tried again', true]]) {
        it(`Disconnect in a session, its stop ${how}, then the page goes away: the unload stop reaches the device, and it is left to the page after it`, async () => {
            globalThis.localStorage = memoryStorage();
            const page = await pageInSession(40);
            // Long enough between attempts that the page goes away while its
            // stop is still being tried, not after it has failed.
            page.driver.VACUGLIDE_TIMINGS.stopRetryDelaysMs = [5000, 5000, 5000];
            const trouble = troubleForStops({ refuse });
            page.driver.disconnectVacuglide();
            await waitFor(() => trouble.lost >= 1, 1000, "Disconnect's stop to go out");
            assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'it never arrived');
            assert.equal(page.driver.isVacuglideOfflineStopPending(), false, 'nothing chases the device yet: its stop is still being tried');
            calls = [];
            assert.equal(goAway(page), true, 'the unload stop goes out');
            assert.deepEqual(keepaliveStops(), WHOLE_STOP);
            assert.ok(calls.every((c) => c.token === TOKEN && c.host === CLUSTER && c.method === 'PUT'));
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED', 'and it reached the device');
            const left = JSON.parse(handoverStored()).entries;
            assert.equal(left.length, 1);
            assert.ok(left[0].stopUntil > Date.now(), 'the device is left to the next page with its stop');
            trouble.on = false;
            const next = await nextPage({ stop: true });
            assert.match(next.seen.takeovers[0].message, /may have been running or had a valve open, and never heard its last stop land/);
            await finished(next);
            assert.match(lastTakeover(next).message, /It confirmed the stop, with both valves closed/);
            assert.deepEqual(next.seen.unconfirmed, []);
        });
    }

    it('Disconnect in a session whose stop and unload stop are both lost: the page after it stops the device', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await pageInSession(40);
        const trouble = troubleForStops({ unload: true });
        page.driver.disconnectVacuglide();
        await waitFor(() => trouble.lost === 3, 1000, "Disconnect's stop to go out");
        goAway(page);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'neither stop reached it');
        trouble.on = false;
        const next = await nextPage({ stop: true });
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop/);
    });

    it('Disconnect of a device at rest, then the page goes away before its stop is answered: the unload stop, and nothing left behind', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        const trouble = troubleForStops();
        page.driver.disconnectVacuglide();
        await waitFor(() => trouble.lost === 3, 1000, "Disconnect's stop to go out");
        calls = [];
        goAway(page);
        assert.deepEqual(keepaliveStops(), WHOLE_STOP, 'the page will not be here to retry it');
        assert.equal(handoverStored(), null, 'EdgeLoop had not moved it: nothing for the next page');
    });

    // A speed out at Disconnect is answered after Disconnect's stop was
    // confirmed: it landed after that stop, and the whole stop goes again -
    // and is lost. Nothing is out any more, so the watch ends; that second
    // stop is all that is left holding the device.
    it('a stop sent again for a speed that landed after Disconnect, still out when the page goes away: the unload stop reaches the device, and the page after it stops it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await pageInSession(40);
        // The stop sent again is lost until its request times out, and the
        // watch reads for that long after it too.
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 1000;
        let answer = null;
        routes['PUT /vacuglide/target-speed'] = ({ next }) => new Promise((resolve) => { answer = () => resolve(next()); });
        page.driver.dispatchVacuglide(55);
        await waitFor(() => answer !== null, 1000, 'the speed to go out');
        assert.deepEqual(await page.driver.disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        const trouble = troubleForStops();
        answer();
        await waitFor(() => trouble.lost === 3, 1000, 'the late speed to land and the stop sent again for it to be lost');
        calls = [];
        assert.equal(goAway(page), true);
        assert.deepEqual(keepaliveStops(), WHOLE_STOP);
        const [left] = JSON.parse(handoverStored()).entries;
        assert.ok(left.stopUntil > Date.now(), 'left with its stop');
        assert.ok(left.speedUntil > 0, 'and with what is left of its watch');
        trouble.on = false;
        const next = await nextPage({ stop: true });
        await finished(next);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    // A page reads a device it took over, once, finds the late speed running
    // on it and sends the whole stop, which is lost - and the page goes away.
    // Its watch has made its last read and ended; the stop is still out.
    it('a page that finds a late speed on its last read, and goes away before that stop is answered, leaves the device to the page after it', async () => {
        globalThis.localStorage = memoryStorage();
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 55;
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'before', at: now - 90000, speedUntil: now - 20000, openUntil: 0, stopUntil: 0, alarm: false }
        ] }));
        const trouble = troubleForStops();
        const first = await loadAnotherPage();
        await waitFor(() => trouble.lost === 3, 1000, 'the stop it sends to be lost');
        await waitFor(() => !first.driver.isVacuglideWatchPending(), 1000, 'its one read to be over');
        assert.equal(first.driver.isVacuglideTakeoverPending(), true, 'not finished with while its stop is out');
        assert.ok(first.seen.takeovers.every((t) => t.active));
        calls = [];
        assert.equal(goAway(first), true);
        assert.deepEqual(keepaliveStops(), WHOLE_STOP);
        const [left] = JSON.parse(handoverStored()).entries;
        assert.ok(left.stopUntil > Date.now());
        trouble.on = false;
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        const second = await nextPage({ stop: true });
        await finished(second);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    // ---- a page that comes back, and a page that connects the device --------------------------------
    //
    // What a page leaves is taken over by the next page to load, by the same
    // page when it comes back from being frozen or from the back-forward
    // cache, and by a page that connects that very device - never by a page
    // that was merely open meanwhile, which could not tell when the wearer
    // drove the device again from the reloaded tab.

    it('a page that comes back with the same VacuGlide connected takes what another page left meanwhile through its own link, and stops the late speed', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const back = await loadAnotherPage();
        await back.driver.connectVacuglide(TOKEN);
        // Frozen with the device at rest: it leaves nothing.
        back.driver.stopVacuglideOnUnload();
        assert.equal(handoverStored(), null);
        // Meanwhile another page drives the device, and goes away with a
        // speed still out.
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 2000;
        goAway(page);
        assert.ok(handoverStored());
        // Back: nothing of its own to take back, and the other page's entry
        // taken over through the link it still has.
        back.driver.withdrawVacuglideHandover();
        assert.ok(handoverStored(), 'withdrawing takes back only what this page left');
        calls = [];
        assert.equal(back.driver.takeOverVacuglideHandover(), 1);
        assert.equal(handoverStored(), null);
        assert.ok(back.seen.notices.some((m) => /went away before it could vouch for it/.test(m)), JSON.stringify(back.seen.notices));
        assert.deepEqual(back.seen.takeovers, [], 'the connected panel is the device\'s own');
        assert.equal(back.driver.isVacuglideWatchPending(), true, 'the speed that page left is watched for through this link');
        await waitFor(() => calls.length > 0, 1000, 'the first read');
        assert.deepEqual(calls.slice(0, 1).map((c) => `${c.method} ${c.path}`), ['GET /vacuglide/state'], 'it reads the device at once');
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        assert.ok(back.seen.notices.some((m) => /running although EdgeLoop had stopped it/.test(m)));
        held.fail();
        await back.driver.disconnectVacuglide();
        await finished(back);
    });

    // A page that was open before another one went away took nothing over
    // then. When the wearer connects the device there, what that page left
    // is taken before the new link sends anything, and watched through that
    // link: the session it runs is the device's own, and no page that loads
    // later finds anything to stop it with.
    it('connecting the device takes over what a page that went away left, through the new link, before its first command', async () => {
        const storage = memoryStorage();
        // When the entry that page left leaves storage, as a count of the
        // requests sent by then.
        let claimedAfter = null;
        let leftBy = null;
        const noted = () => {
            const stored = storage.getItem('vacuglide_handover') || '';
            if (claimedAfter === null && leftBy !== null && !stored.includes(leftBy)) claimedAfter = calls.length;
        };
        const { setItem, removeItem } = storage;
        storage.setItem = (key, value) => {
            setItem(key, value);
            if (key === 'vacuglide_handover') noted();
        };
        storage.removeItem = (key) => {
            removeItem(key);
            if (key === 'vacuglide_handover') noted();
        };
        globalThis.localStorage = storage;
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const older = await loadAnotherPage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 2000;
        goAway(page);
        assert.ok(handoverStored());
        leftBy = JSON.parse(handoverStored()).entries[0].page;
        calls = [];
        await older.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null, 'taken, and gone from storage');
        assert.deepEqual(calls.slice(0, claimedAfter).map((c) => `${c.method} ${c.path}`), ['GET /vacuglide/connected', 'GET /vacuglide/info'],
            'taken before the link sent the device anything');
        assert.deepEqual(older.seen.takeovers, [], 'the connected panel is the device\'s own');
        assert.equal(older.driver.isVacuglideWatchPending(), true, 'the speed that page left is watched for through the new link');
        // The wearer runs a session on it, and the other page's late speed
        // lands in it: the session's own speed goes out again at once, and
        // nothing stops the session.
        sessionActive = true;
        older.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const stops = stopsOn();
        held.land();
        const landed = speedLanded(55);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 30), 2000, 'the session\'s speed to go out again');
        assert.ok(eventsAfter(landed).find((e) => e.what === 'speed' && e.value === 30).at - landed.at < UNDONE_WITHIN_MS);
        // A page that loads now has nothing to take over, and sends nothing.
        const later = await loadAnotherPage();
        await tick(300);
        assert.deepEqual(later.seen.takeovers, []);
        assert.equal(later.driver.isVacuglideWatchPending(), false);
        assert.equal(stopsOn(), stops, 'the session was never stopped');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        held.fail();
        sessionActive = false;
        await older.driver.disconnectVacuglide();
        await finished(older);
    });

    // The connect's own stop is what settles what the page that went away
    // could not. A connect that fails after taking the entry out of storage
    // must not lose it: the device is watched and stopped as a page that
    // loads would, with the alarm while its stop is refused.
    it('a connect that fails after taking over what a page left watches and chases the device as a loading page would', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const older = await loadAnotherPage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 2000;
        goAway(page);
        const [left] = JSON.parse(handoverStored()).entries;
        let refuse = true;
        routes['PUT /vacuglide/target-speed/stop'] = ({ next }) => (refuse ? jsonResponse(null, 503) : next());
        await assert.rejects(older.driver.connectVacuglide(TOKEN), /did not confirm that its motor stopped/);
        assert.equal(older.driver.isVacuglideConnected(), false);
        const stored = JSON.parse(handoverStored()).entries;
        assert.equal(stored.length, 1, 'the entry is this page\'s now');
        assert.equal(stored[0].held, true);
        assert.notEqual(stored[0].page, left.page);
        assert.equal(older.seen.takeovers.length, 1);
        assert.equal(older.seen.takeovers[0].active, true);
        await waitFor(() => older.seen.unconfirmed.length === 1, 2000, 'the alarm while its stop is refused');
        assert.equal(older.driver.isVacuglideOfflineStopPending(), true, 'it is chased');
        assert.equal(older.driver.isVacuglideWatchPending(), true, 'and watched for the speed that page left');
        refuse = false;
        await waitFor(() => !older.driver.isVacuglideOfflineStopPending(), 2000, 'the chase to confirm a stop');
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        held.fail();
        await finished(older);
    });

    // ---- the page that drives the device answers for it ------------------------------------------
    //
    // A page can answer for a device it does not drive: it took it over from
    // a page that went away, or let go of it with a command still out. It
    // holds its entry in storage for as long as it does. A page that loads
    // leaves a held entry alone; a page that connects the device, or comes
    // back with it connected, takes it - and drives the device - and the
    // page that held it lets go of the device, sending that session nothing.

    // The wearer, back in an older tab, connects the device there and starts
    // a session while a page that took the device over at load still
    // watches it. That page used to read the session as the late speed of
    // the page that went away, and send it the whole stop on every read for
    // a minute - 18 stops - until a valve press there was refused for rate.
    it('a page that took a device over lets go of it once an older tab connects it, and stops nothing of that tab\'s session', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const older = await loadAnotherPage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        goAway(page);
        const taker = await nextPage({ stop: true });
        const [kept] = JSON.parse(handoverStored()).entries;
        assert.equal(kept.held, true, 'held while the page that took it over answers for it');
        // A page that loads now leaves it alone: the page that holds it is
        // open.
        const loaded = await loadAnotherPage();
        await tick(100);
        assert.deepEqual(loaded.seen.takeovers, []);
        assert.deepEqual(JSON.parse(handoverStored()).entries, [kept]);
        // The wearer connects the device in the older tab and runs a session.
        await older.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null, 'taken by the page that drives the device');
        assert.equal(older.driver.isVacuglideWatchPending(), true, 'which watches for the late speed through its own link');
        older.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        await waitFor(() => !taker.driver.isVacuglideTakeoverPending() && !taker.driver.isVacuglideWatchPending()
            && !taker.driver.isVacuglideOfflineStopPending(), 1000, 'the page that took it over to let go of it');
        assert.equal(lastTakeover(taker).active, false);
        assert.match(lastTakeover(taker).message, /^Another EdgeLoop tab has connected this VacuGlide, or is connecting it, and answers for it from there/);
        // A press in the session lasts its pulse.
        assert.equal((await older.driver.pulseValve('plus', 300)).ok, true);
        const [openedAt, closedAt] = openSpans('plus').slice(-1)[0];
        assert.ok(closedAt - openedAt >= 280, `Valve + was open ${closedAt - openedAt} ms`);
        // The late speed lands in the session: the session's own goes out
        // again.
        held.land();
        const landed = speedLanded(55);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 30), 2000, "the session's speed to go out again");
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === taker.id && c.method === 'PUT').length, 0, 'the page that let go of it sent it nothing');
        assert.deepEqual(taker.seen.unconfirmed, []);
        assert.deepEqual(taker.seen.lateStops, []);
        held.fail();
        await older.driver.disconnectVacuglide();
        await finished(older);
    });

    // The same page coming back from the back-forward cache with its link
    // still up drives the device: it takes what a tab opened while it was
    // away took over from it, and that tab lets go of the device. It used to
    // stop the session the page came back to, 14 times.
    it('a page that comes back with the device connected takes it from a page that took it over while it was away, which lets go of it', async () => {
        globalThis.localStorage = memoryStorage();
        // Two pages read the device here, each on its own beat: a beat that
        // leaves the session's speeds room in the token's budget.
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 100, lateCommandWatchMs: 400 });
        const { page: back, held } = await pageWithSpeedOut(40, 55);
        back.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 1500;
        // Into the back-forward cache: pagehide, then freeze.
        back.driver.stopVacuglideOnUnload();
        back.driver.stopVacuglideOnUnload();
        assert.equal(JSON.parse(handoverStored()).entries[0].held, false);
        // A tab opened meanwhile takes it over.
        const other = await nextPage({ stop: true });
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true);
        // Its speed's request ends without an answer while it is away, and
        // gets the stop again for that.
        held.fail();
        await waitFor(() => !back.driver.isVacuglideMoving(), 1000, 'the stop sent again for it');
        // Back: what it left is the other page's now, and it takes that
        // over through its own link.
        back.driver.withdrawVacuglideHandover();
        assert.equal(back.driver.takeOverVacuglideHandover(), 1);
        assert.equal(handoverStored(), null);
        assert.ok(back.seen.notices.some((m) => /^Another EdgeLoop tab was watching this VacuGlide for a command that may still reach it late/.test(m)), JSON.stringify(back.seen.notices));
        back.driver.dispatchVacuglide(35);
        await waitFor(() => device.targetSpeed === 35 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run again');
        const resumedAt = Date.now();
        await waitFor(() => !other.driver.isVacuglideTakeoverPending() && !other.driver.isVacuglideWatchPending()
            && !other.driver.isVacuglideOfflineStopPending(), 1000, 'the other page to let go of it');
        assert.match(lastTakeover(other).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        await tick(300);
        assert.equal(device.events.filter((e) => e.what === 'stop' && e.at >= resumedAt).length, 0, 'the session was never stopped');
        assert.equal(calls.filter((c) => c.page === other.id && c.at >= resumedAt && c.method === 'PUT').length, 0);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
        await back.driver.disconnectVacuglide();
        await finished(back);
    });

    // The same for a page that let go of the device itself: Disconnect with
    // a speed still out leaves it watching the device, and holding it. When
    // the wearer connects the device in another tab and drives it there,
    // that tab takes what this page holds, and this page lets go of the
    // device rather than read that session as its late speed.
    it('a page that let go of a device with a speed still out lets go of it for good once another tab connects it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        assert.deepEqual(await page.driver.disconnectVacuglide(), { confirmed: true, mayHaveMoved: true, watching: true });
        const [kept] = JSON.parse(handoverStored()).entries;
        assert.equal(kept.held, true, 'held while it watches the device');
        const other = await loadAnotherPage();
        await tick(100);
        assert.deepEqual(other.seen.takeovers, [], 'a page that loads leaves it to the page that holds it');
        await other.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 1000, 'the page that let go of it to stop watching it');
        assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        held.land();
        const landed = speedLanded(55);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 30), 2000, "the session's speed to go out again");
        // Its own request for that speed fails at last: that is not the
        // device moving after a stop of this page's any more.
        held.fail();
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id && c.method === 'PUT').length, 0);
        assert.deepEqual(page.seen.unconfirmed, []);
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // The wearer connects the device again on the page that let go of it
    // while another tab connects it too. That page reads its held entry gone
    // before its own connect is through, and lets go of the device - but once
    // connected it drives it, and closing it must stop it like any other.
    it('a page connecting a device it let go of, while another tab connects it too, still stops it when it goes away', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true);
        // Its connect's motor stop is held back by the cloud for a while.
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== page.id || release) return call.next();
            return new Promise((resolve) => { release = () => resolve(call.next()); });
        };
        const connecting = page.driver.connectVacuglide(TOKEN);
        await waitFor(() => release !== null, 1000, 'its connect to be under way');
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 1000, 'the page to let go of the device');
        release();
        await connecting;
        assert.equal(page.driver.isVacuglideConnected(), true);
        held.fail();
        const before = calls.length;
        assert.equal(goAway(page), true, 'the device it drives is sent the unload stop');
        assert.ok(calls.slice(before).some((c) => c.page === page.id && c.keepalive && c.path === '/vacuglide/target-speed/stop' && c.token === TOKEN));
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // Disconnect's motor stop fails, and is tried again on a backoff. The
    // wearer connects the device in another tab meanwhile - that tab's own
    // stop confirmed - and runs a session there: none of the tries still to
    // come goes out, since each would stop that session.
    it('a stop still being tried again when another tab connects the device is tried no more', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        // A short window for the stop's own tries, which the other tab takes
        // over and watches to its end.
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 1000;
        page.driver.VACUGLIDE_TIMINGS.stopRetryDelaysMs = [300, 300, 300];
        page.driver.dispatchVacuglide(40);
        await waitFor(() => device.targetSpeed === 40 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        // The cloud refuses this page's motor stop until the other tab has
        // connected the device, and takes it from then on.
        let refusing = true;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => (call.page === page.id && refusing ? jsonResponse(null, 500) : call.next());
        const disconnected = page.driver.disconnectVacuglide();
        await waitFor(() => sent('/vacuglide/target-speed/stop').some((c) => c.page === page.id && c.status === 500), 1000, 'the first try to fail');
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true, 'held while its stop is out');
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        const connectedAt = Date.now();
        refusing = false;
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session in the other tab');
        assert.deepEqual(await disconnected, { confirmed: false, mayHaveMoved: true, watching: false, letGo: true }, 'its panel says it let go of the device, not that the stop is unconfirmed');
        assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        await tick(100);
        assert.equal(calls.filter((c) => c.page === page.id && c.at >= connectedAt).length, 0, 'nothing more from the page that let go of it');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the session runs on');
        assert.deepEqual(page.seen.unconfirmed, [], 'and no alarm there: the other tab confirmed a stop of its own');
        await other.driver.disconnectVacuglide();
        await finished(other);
        await finished(page);
    });

    // Disconnect's stop has to wait for a slot: this page has spent its
    // budget. The wearer connects the device in another tab meanwhile and
    // runs a session there. Once a slot frees, what waited is not sent into
    // it.
    it('a stop waiting for a slot when another tab connects the device is not sent', async () => {
        globalThis.localStorage = memoryStorage();
        const page = await loadAnotherPage();
        Object.assign(page.driver.VACUGLIDE_LIMITS, { ceiling: 7, reserve: 1, watchReserve: 0, windowMs: 700 });
        await page.driver.connectVacuglide(TOKEN);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 1000;
        page.driver.dispatchVacuglide(50);
        await waitFor(() => device.targetSpeed === 50 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        // Connect (5) and the speed leave one slot: Disconnect's motor stop
        // takes it, and its two closes have to wait.
        const disconnected = page.driver.disconnectVacuglide();
        await waitFor(() => page.seen.unconfirmed.length > 0, 1000, 'the alarm for the wait');
        assert.match(page.seen.unconfirmed[0], /^A valve close is held back/);
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true, 'held while its stop is out');
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        const connectedAt = Date.now();
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session in the other tab');
        assert.deepEqual(await disconnected, { confirmed: false, mayHaveMoved: true, watching: false, letGo: true });
        assert.equal(calls.filter((c) => c.page === page.id && c.at >= connectedAt).length, 0, 'the stop that waited is not sent');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'the session runs on');
        await other.driver.disconnectVacuglide();
        await finished(other);
        await finished(page);
    });

    // A press whose open the cloud never answered goes on closing its valve
    // on the beat after Disconnect. Once another tab has connected the device
    // - its connect closed both valves, and it watches for that open through
    // its own link - those closes stop: one of them would cut a press made
    // in that tab short.
    it('a page that let go of a device mid-press sends it no more closes once another tab connects it, and cuts no press there short', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400, pendingOpenBeatMs: 50, staleOpenGuardMs: 1500 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        // Its press's open is taken by the cloud and neither applied nor
        // answered.
        let heldOpen = null;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body }) => (body.valveState === true && !heldOpen
            ? new Promise((resolve, reject) => { heldOpen = reject; })
            : next());
        const press = page.driver.pulseValve('plus', 300);
        await waitFor(() => heldOpen !== null, 1000, 'the open to go out');
        await page.driver.disconnectVacuglide();
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true);
        await tick(120);
        assert.ok(calls.some((c) => c.page === page.id && c.path === '/vacuglide/valve/stroke-plus' && c.body.valveState === false && c.at > Date.now() - 100), 'still closing it on the beat');
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        const connectedAt = Date.now();
        assert.equal((await other.driver.pulseValve('plus', 300)).ok, true);
        const [openedAt, closedAt] = openSpans('plus').slice(-1)[0];
        assert.ok(closedAt - openedAt >= 280, `the press there lasted ${closedAt - openedAt} ms`);
        assert.equal(calls.filter((c) => c.page === page.id && c.at >= connectedAt && c.method === 'PUT').length, 0, 'nothing from the page that let go of it');
        heldOpen(new TypeError('Failed to fetch'));
        // Its press says the device is another tab's now, not that the valve
        // may still be open.
        const pressed = await press;
        assert.equal(pressed.reason, 'let-go');
        assert.match(pressed.message, /^Another EdgeLoop tab has connected this VacuGlide, or is connecting it, and closes both valves from there/);
        assert.deepEqual(page.seen.unconfirmed, []);
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // A read of the page that let go of the device can still be out when
    // another tab connects it, and come back with that tab's session running
    // in it: the page that let go of the device sends that session nothing.
    it('a read still out when another tab connects the device, answered with that session running, sets off no stop', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        // Its next read is taken by the cloud, and answered when the test
        // says, with the device as it is then.
        let answer = null;
        routes['GET /vacuglide/state'] = ({ next, page: from }) => {
            if (from !== page.id || answer) return next();
            return new Promise((resolve) => { answer = () => resolve(next()); });
        };
        await waitFor(() => answer !== null, 1000, 'a read to go out');
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        answer();
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id && c.method === 'PUT').length, 0);
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.deepEqual(page.seen.lateStops, []);
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // And the alarm goes with it: once another tab drives the device, a read
    // that cannot see the device raises the alarm there, on the page the
    // wearer is using - never on the page that let go of it.
    it('once another tab drives the device, a read that cannot see it raises the alarm there, and not on the page that let go of it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 1000, 'the page that let go of it to stop watching it');
        device.online = false;
        await waitFor(() => other.seen.unconfirmed.length > 0, 2000, 'the alarm on the page that drives the device');
        assert.match(other.seen.unconfirmed[0], /^EdgeLoop could not read the VacuGlide while a command it sent may still reach it/);
        await tick(200);
        assert.deepEqual(page.seen.unconfirmed, []);
        device.online = true;
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // A page that holds a device while it is frozen leaves its entry as a
    // page that goes away does. Back, it finds no page holding the device any
    // more - another tab connected it meanwhile, and drives it - and lets go
    // of it.
    it('a page frozen while it held a device that another tab connected meanwhile lets go of it when it comes back', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const other = await loadAnotherPage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        goAway(page);
        const taker = await nextPage({ stop: true });
        // Its next read a while away, so that coming back is what finds out.
        taker.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        await tick(100);
        taker.driver.stopVacuglideOnUnload();
        assert.equal(JSON.parse(handoverStored()).entries[0].held, false);
        await other.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        assert.equal(taker.driver.isVacuglideWatchPending(), true, 'nothing has told it yet');
        // Back.
        taker.driver.withdrawVacuglideHandover();
        assert.equal(taker.driver.takeOverVacuglideHandover(), 0);
        assert.equal(taker.driver.isVacuglideWatchPending(), false);
        assert.equal(taker.driver.isVacuglideTakeoverPending(), false);
        // It cannot tell a tab that connected the device from one that loaded,
        // took it over and has finished with it since, and says only what it
        // knows.
        assert.match(lastTakeover(taker).message, /^While this page was away, another EdgeLoop tab took this VacuGlide over/);
        assert.equal(handoverStored(), null, 'and nothing of it is written back');
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0);
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // Back to find its entry taken over by a page that loaded while it was
    // away - which holds the device now - it goes on answering for it as
    // well: the wearer may be on either page.
    it('a page frozen while it held a device that a page loaded meanwhile took over answers for it along with that page when it comes back', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        goAway(page);
        const first = await nextPage({ stop: true });
        first.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        await tick(100);
        first.driver.stopVacuglideOnUnload();
        const second = await nextPage();
        assert.equal(JSON.parse(handoverStored()).entries.length, 1);
        first.driver.withdrawVacuglideHandover();
        first.driver.takeOverVacuglideHandover();
        const entries = JSON.parse(handoverStored()).entries;
        assert.equal(entries.length, 2, 'held by both');
        assert.ok(entries.every((e) => e.held));
        assert.equal(first.driver.isVacuglideWatchPending(), true);
        assert.equal(second.driver.isVacuglideWatchPending(), true);
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        held.fail();
        await finished(second);
    });

    // A page that holds the device looks at its entry before it next reads,
    // stops or closes a valve - and when it goes away or is frozen. Closed or
    // frozen in the moment after the wearer connected the device in another
    // tab, before its next read, it sent the whole stop into the session
    // that tab then ran and left its entry as one that went away: the next
    // EdgeLoop page to load took it over and stopped that session on every
    // read for a minute, telling the wearer a late speed had landed, and a
    // frozen page came back holding the device and stopped the session
    // itself.
    for (const how of ['closed', 'frozen']) {
        it(`a page that holds a device another tab has just connected, ${how} before it next looks, sends it nothing and leaves nothing`, async () => {
            globalThis.localStorage = memoryStorage();
            Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
            const { page, held } = await pageWithSpeedOut(40, 55);
            page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
            await page.driver.disconnectVacuglide();
            assert.equal(JSON.parse(handoverStored()).entries[0].held, true);
            // Its next read a while away, so that going away is what finds out.
            page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
            await tick(120);
            const other = await loadAnotherPage();
            await other.driver.connectVacuglide(TOKEN);
            other.driver.dispatchVacuglide(30);
            await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
            const driven = sessionStarted(30);
            const drivenFrom = calls.length;
            assert.equal(page.driver.isVacuglideWatchPending(), true, 'nothing has told it yet');
            const before = calls.length;
            const sentStop = how === 'closed' ? goAway(page) : page.driver.stopVacuglideOnUnload();
            assert.equal(sentStop, false, 'no unload stop');
            assert.deepEqual(calls.slice(before).filter((c) => c.page === page.id), [], 'nothing from it on its way out');
            assert.equal(handoverStored(), null, 'and nothing left behind');
            assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
            if (how === 'frozen') {
                // Back: nothing of its own to take back, nothing to take over,
                // and nothing of the device left to watch.
                page.driver.withdrawVacuglideHandover();
                assert.equal(page.driver.takeOverVacuglideHandover(), 0);
                assert.equal(page.driver.isVacuglideWatchPending(), false);
                assert.equal(handoverStored(), null);
            }
            // A page that loads now finds nothing to take over.
            const later = await loadAnotherPage();
            await tick(200);
            assert.deepEqual(later.seen.takeovers, []);
            assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
            assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id).length, 0);
            assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
            held.fail();
            await other.driver.disconnectVacuglide();
            await finished(other);
        });
    }

    // A page that holds the device and is frozen leaves its entry as a page
    // that goes away does. Back with nothing taken meanwhile, what it left is
    // still its own: it holds the device again, and goes on watching it.
    it('a page frozen while it held a device, and back with nothing taken meanwhile, goes on answering for it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        page.driver.stopVacuglideOnUnload();
        assert.equal(JSON.parse(handoverStored()).entries[0].held, false);
        page.driver.withdrawVacuglideHandover();
        assert.equal(page.driver.takeOverVacuglideHandover(), 0);
        const [stored] = JSON.parse(handoverStored()).entries;
        assert.equal(stored.held, true, 'held again');
        assert.equal(page.driver.isVacuglideWatchPending(), true, 'and still watched');
        const { ran } = await landAndStop(held, 55);
        assert.ok(ran < UNDONE_WITHIN_MS, `the motor ran ${ran} ms after the late speed landed`);
        held.fail();
        await finished(page);
    });

    // A page that held the device and went away in the moment another page's
    // connect took what it held had not yet seen that write - localStorage
    // makes no tab wait for another's - and left its entry again as one that
    // went away. The connect takes that over too, before the device is
    // driven, so no page that loads later stops the session with it.
    it('a connect takes over what a page that went away left for the device while the connect ran, and no page that loads later finds it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const page = await loadAnotherPage();
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== page.id || release) return call.next();
            return new Promise((resolve) => { release = () => resolve(call.next()); });
        };
        const connecting = page.driver.connectVacuglide(TOKEN);
        await waitFor(() => release !== null, 1000, 'its connect to be under way');
        // What that page wrote on its way out, from what it had seen.
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'wentaway', at: now, speedUntil: now + 1500, openUntil: 0, stopUntil: 0, alarm: false, held: false }
        ] }));
        release();
        await connecting;
        assert.equal(handoverStored(), null, 'taken by the page that connected the device');
        assert.equal(page.driver.isVacuglideWatchPending(), true, 'and watched for through its link');
        assert.ok(page.seen.notices.some((m) => /went away before it could vouch for it/.test(m)), JSON.stringify(page.seen.notices));
        page.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const later = await loadAnotherPage();
        await tick(300);
        assert.deepEqual(later.seen.takeovers, [], 'a page that loads finds nothing to take over');
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        await page.driver.disconnectVacuglide();
        await finished(page);
    });

    // A page that holds the device lets go of it once a page that connects it
    // has taken what it held, even if another page that answered for the
    // device went away at that very moment and left what it held: that is no
    // page that took the device over at load, which the wearer might be on,
    // and the page that connected the device drives it.
    it('a page whose held entry a connecting page took lets go of the device, whatever a page that went away meanwhile left for it', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        await tick(120);
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'wentaway', at: now, speedUntil: now + 3000, openUntil: 0, stopUntil: 0, alarm: false, held: false }
        ] }));
        // Frozen now: it looks, and lets go.
        const before = calls.length;
        assert.equal(page.driver.stopVacuglideOnUnload(), false, 'no unload stop');
        assert.deepEqual(calls.slice(before).filter((c) => c.page === page.id), []);
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.deepEqual(JSON.parse(handoverStored()).entries.map((e) => e.page), ['wentaway'], 'nothing of its own left beside it');
        assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        globalThis.localStorage.removeItem('vacuglide_handover');
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // Two pages hold the device: one let go of it with a speed still out, and
    // one whose connect failed after taking that over - the first held it
    // again on finding the second's entry, as it would that of a page that
    // loaded while it was away. When the second connects the device again on
    // a slow link, what it holds while its connect runs is marked
    // connecting, and the first lets go of the device. Unmarked, that entry
    // read to the first page as a page that had loaded: it held the device
    // again, and went on stopping the session that followed - 10 stops in its
    // first 20 s.
    it('a page that holds a device lets go of it while another page that holds it too connects it on a slow link, and stops nothing of the session that follows', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        // Its reads a while apart, so that the other page's first connect
        // comes and goes between two of them.
        page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 600;
        const reads = () => calls.filter((c) => c.page === page.id && c.path === '/vacuglide/state').length;
        const seenReads = reads();
        await waitFor(() => reads() > seenReads, 1000, 'a read of the first page');
        const other = await loadAnotherPage();
        let refuse = true;
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== other.id) return call.next();
            if (refuse) return jsonResponse(null, 503);
            if (release === null) return new Promise((resolve) => { release = () => resolve(call.next()); });
            return call.next();
        };
        await assert.rejects(other.driver.connectVacuglide(TOKEN), /did not confirm that its motor stopped/);
        // The other page holds the device now, and the first holds it again
        // at its next read.
        await waitFor(() => JSON.parse(handoverStored() || '{"entries":[]}').entries.length === 2, 2000, 'both pages to hold the device');
        assert.ok(JSON.parse(handoverStored()).entries.every((e) => e.held && !e.connecting));
        assert.equal(page.driver.isVacuglideWatchPending(), true);
        // The second connect: the cloud holds its motor stop.
        refuse = false;
        const connecting = other.driver.connectVacuglide(TOKEN);
        await waitFor(() => release !== null, 1000, 'its connect to be under way');
        const stored = JSON.parse(handoverStored()).entries;
        assert.equal(stored.length, 1, 'one entry for the device: what the page connecting it holds');
        assert.equal(stored[0].connecting, true);
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 2000, 'the first page to let go of the device');
        assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        release();
        await connecting;
        assert.equal(handoverStored(), null, 'nothing held once the device is driven');
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        await tick(700);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id).length, 0, 'nothing from the page that let go of it');
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // The same for a page that comes back from being frozen while another
    // page is connecting the device it held: it finds only what that page
    // holds, marked connecting, and lets go of the device.
    it('a page that comes back while another page is connecting the device it held lets go of it, and stops nothing of the session that follows', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const other = await loadAnotherPage();
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        // Frozen, with its next read a while away.
        page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 5000;
        await tick(120);
        page.driver.stopVacuglideOnUnload();
        const [left] = JSON.parse(handoverStored()).entries;
        assert.equal(left.held, false);
        // Meanwhile the wearer connects the device in the other tab, and the
        // cloud holds that connect's motor stop.
        let release = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== other.id || release) return call.next();
            return new Promise((resolve) => { release = () => resolve(call.next()); });
        };
        const connecting = other.driver.connectVacuglide(TOKEN);
        await waitFor(() => release !== null, 1000, 'its connect to be under way');
        const [marked] = JSON.parse(handoverStored()).entries;
        assert.equal(marked.connecting, true);
        assert.notEqual(marked.page, left.page);
        // Back while that connect runs.
        page.driver.withdrawVacuglideHandover();
        assert.equal(page.driver.takeOverVacuglideHandover(), 0);
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.match(lastTakeover(page).message, /^While this page was away, another EdgeLoop tab took this VacuGlide over/);
        release();
        await connecting;
        assert.equal(handoverStored(), null);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        await tick(300);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id).length, 0);
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // The wearer presses Connect again on the page that let go of the device,
    // the cloud holds that connect's motor stop, and they connect the device
    // in another tab meanwhile - which takes what the first page holds,
    // marked connecting. The first page's connect then fails, and it lets go
    // of the device: the other tab drives it.
    it('a page whose connect fails after another tab connected the device meanwhile lets go of it, and stops nothing of that tab\'s session', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        const other = await loadAnotherPage();
        let refuse = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== page.id || call.keepalive) return call.next();
            if (refuse === null) return new Promise((resolve) => { refuse = () => resolve(jsonResponse(null, 503)); });
            return jsonResponse(null, 503);
        };
        const reconnect = page.driver.connectVacuglide(TOKEN).then(() => 'connected', (e) => e.message);
        await waitFor(() => refuse !== null, 1000, 'its connect to be under way');
        assert.equal(JSON.parse(handoverStored()).entries[0].connecting, true, 'what it holds while it connects the device');
        await other.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        refuse();
        assert.match(await reconnect, /did not confirm that its motor stopped/);
        assert.equal(page.driver.isVacuglideConnected(), false);
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.equal(page.driver.isVacuglideOfflineStopPending(), false);
        assert.equal(handoverStored(), null, 'nothing held by the page that let go of it');
        await tick(300);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id && c.method === 'PUT').length, 0, 'nothing sent by the page whose connect failed');
        held.fail();
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // A page that held nothing for the device connects it, taking what
    // another page holds; the cloud holds that connect's motor stop, and the
    // wearer connects the device in a third tab meanwhile, which takes it
    // from the connecting page - marked connecting, with the window for the
    // late speed in it. The connect that then fails does not take the device
    // back: it would read that tab's session as the late speed, and stop it.
    it('a connect that took what another page held, and fails after a third page connected the device meanwhile, does not take the device back', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { lateCommandWatchBeatMs: 50, lateCommandWatchMs: 400 });
        const { page, held } = await pageWithSpeedOut(40, 55);
        page.driver.VACUGLIDE_TIMINGS.requestTimeoutMs = 3000;
        await page.driver.disconnectVacuglide();
        const first = await loadAnotherPage();
        const third = await loadAnotherPage();
        let refuse = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== first.id) return call.next();
            if (refuse === null) return new Promise((resolve) => { refuse = () => resolve(jsonResponse(null, 503)); });
            return jsonResponse(null, 503);
        };
        const firstConnect = first.driver.connectVacuglide(TOKEN).then(() => 'connected', (e) => e.message);
        await waitFor(() => refuse !== null, 1000, 'its connect to be under way');
        const [marked] = JSON.parse(handoverStored()).entries;
        assert.equal(marked.connecting, true);
        assert.ok(marked.speedUntil > Date.now(), 'with the window for the late speed in it');
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 1000, 'the page that held the device to let go of it');
        await third.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null);
        assert.equal(third.driver.isVacuglideWatchPending(), true, 'the late speed is watched for through its link');
        third.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        refuse();
        assert.match(await firstConnect, /did not confirm that its motor stopped/);
        assert.equal(first.driver.isVacuglideWatchPending(), false);
        assert.equal(first.driver.isVacuglideOfflineStopPending(), false);
        assert.ok(!first.seen.takeovers.some((t) => t.active), 'it took nothing over');
        // The late speed lands in the session: its own speed goes out again.
        held.land();
        const landed = speedLanded(55);
        await waitFor(() => eventsAfter(landed).some((e) => e.what === 'speed' && e.value === 30), 2000, "the session's speed to go out again");
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => (c.page === first.id || c.page === page.id) && c.method === 'PUT').length, 0);
        held.fail();
        await third.driver.disconnectVacuglide();
        await finished(third);
    });

    // What a connect took over stays in storage, marked connecting, for as
    // long as the connect runs - a window that had closed with no page open,
    // which still owes its last read, as well: the device is not known to be
    // at rest until that connect's stop is confirmed. A page that connects
    // the device meanwhile takes it from there, and the connect that then
    // fails does not take the device back from that page.
    it('a connect that took over a window that had closed holds it until the connect ends, and a page that connects the device meanwhile takes it', async () => {
        globalThis.localStorage = memoryStorage();
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'before', at: now - 120000, speedUntil: now - 60000, openUntil: 0, stopUntil: 0, alarm: false }
        ] }));
        const page = await loadAnotherPage({ takeOver: false });
        const other = await loadAnotherPage({ takeOver: false });
        let refuse = null;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== page.id) return call.next();
            if (refuse === null) return new Promise((resolve) => { refuse = () => resolve(jsonResponse(null, 503)); });
            return jsonResponse(null, 503);
        };
        const connecting = page.driver.connectVacuglide(TOKEN).then(() => 'connected', (e) => e.message);
        await waitFor(() => refuse !== null, 1000, 'its connect to be under way');
        // Its closes are answered meanwhile; what it holds stays.
        await tick(100);
        const [marked] = JSON.parse(handoverStored()).entries;
        assert.equal(marked.connecting, true);
        assert.ok(marked.stopUntil > Date.now(), 'the device not known to be at rest');
        await other.driver.connectVacuglide(TOKEN);
        assert.equal(handoverStored(), null);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        refuse();
        assert.match(await connecting, /did not confirm that its motor stopped/);
        await tick(300);
        assert.ok(!page.seen.takeovers.some((t) => t.active), 'it took nothing over');
        assert.equal(page.driver.isVacuglideWatchPending(), false);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id && c.method === 'PUT').length, 0);
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // A page that let go of the device chases it when its stop is not
    // confirmed: each round asks the router where the device is, then sends
    // the whole stop there. The router can take up to a request timeout to
    // answer, and the wearer can connect the device in another tab
    // meanwhile: the round sends nothing into that tab's session.
    it('a round of a chase whose router answer comes back after another tab connected the device sends nothing', async () => {
        globalThis.localStorage = memoryStorage();
        // A part of Disconnect's stop still being tried a read beat after it
        // went out has the device watched for as long as it could still land
        // - a request timeout and the watch after it - and the other tab
        // takes that over: a short request timeout keeps it short here.
        Object.assign(VACUGLIDE_TIMINGS, { requestTimeoutMs: 2500, lateCommandWatchBeatMs: 50, lateCommandWatchMs: 200 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        page.driver.dispatchVacuglide(40);
        await waitFor(() => device.targetSpeed === 40 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session to run');
        // Disconnect's stop is refused, and so is the chase's, and the router
        // holds its answer to the chase's first round.
        let refusing = true;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => (call.page === page.id && refusing ? jsonResponse(null, 500) : call.next());
        let answer = null;
        routes['GET /vacuglide/connected'] = (call) => {
            if (call.page !== page.id || answer !== null || !page.driver.isVacuglideOfflineStopPending()) return call.next();
            return new Promise((resolve) => { answer = () => resolve(call.next()); });
        };
        await page.driver.disconnectVacuglide();
        await waitFor(() => answer !== null, 1000, 'a round of the chase to ask the router');
        assert.equal(JSON.parse(handoverStored()).entries[0].held, true);
        const other = await loadAnotherPage();
        refusing = false;
        await other.driver.connectVacuglide(TOKEN);
        other.driver.dispatchVacuglide(30);
        await waitFor(() => device.targetSpeed === 30 && device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'the session in the other tab');
        const driven = sessionStarted(30);
        const drivenFrom = calls.length;
        answer();
        await tick(200);
        assert.equal(eventsAfter(driven).filter((e) => e.what === 'stop').length, 0, 'the session was never stopped');
        assert.equal(calls.slice(drivenFrom).filter((c) => c.page === page.id && c.method === 'PUT').length, 0);
        assert.equal(page.driver.isVacuglideOfflineStopPending(), false, 'the chase has ended');
        assert.match(lastTakeover(page).message, /^Another EdgeLoop tab has connected this VacuGlide/);
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // What a connect has taken over is this page's to leave until its own
    // stop is confirmed. Closed while that stop is still out, it sends the
    // device the unload stop, and leaves the next page the whole stop owed.
    it('a page closed while its connect is still bringing the device to rest sends it the unload stop, and leaves the whole stop owed to the next page', async () => {
        globalThis.localStorage = memoryStorage();
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'before', at: now - 1000, speedUntil: 0, openUntil: 0, stopUntil: now + 300000, alarm: false }
        ] }));
        const page = await loadAnotherPage({ takeOver: false });
        let held = false;
        routes['PUT /vacuglide/target-speed/stop'] = (call) => {
            if (call.page !== page.id || call.keepalive) return call.next();
            held = true;
            return new Promise(() => {});
        };
        page.driver.connectVacuglide(TOKEN).catch(() => {});
        await waitFor(() => held, 1000, 'its connect to be under way');
        const before = calls.length;
        assert.equal(goAway(page), true, 'the unload stop');
        assert.ok(calls.slice(before).some((c) => c.page === page.id && c.keepalive && c.path === '/vacuglide/target-speed/stop' && c.token === TOKEN));
        const [left] = JSON.parse(handoverStored()).entries;
        assert.equal(left.held, false);
        assert.equal(left.connecting, false);
        assert.ok(left.stopUntil > Date.now(), 'the whole stop owed');
        // The page after it sends that stop, and has it confirmed.
        routes = {};
        const next = await nextPage({ stop: true });
        await finished(next);
        assert.match(lastTakeover(next).message, /It confirmed the stop, with both valves closed/);
    });

    // A press whose open the cloud never answered is closed on its pulse's
    // beat after Disconnect, and watched for from the end of its last close.
    // The page holds the device all that time, and writes what it holds
    // again when that window reaches further: a page that connects the
    // device then watches through its own link for as long as this one would
    // have, not for as long as the entry written at Disconnect said.
    it('a page that holds a device writes its entry again when its watch reaches further, and a page that connects the device watches that long', async () => {
        globalThis.localStorage = memoryStorage();
        Object.assign(VACUGLIDE_TIMINGS, { requestTimeoutMs: 3000, lateCommandWatchBeatMs: 50, lateCommandWatchMs: 2000, pendingOpenBeatMs: 50, staleOpenGuardMs: 100 });
        const page = await loadAnotherPage();
        await page.driver.connectVacuglide(TOKEN);
        // Its press's open fails without saying whether it landed, and the
        // closes the press sends once Disconnect has been pressed are
        // answered 600 ms late.
        let slow = false;
        routes['PUT /vacuglide/valve/stroke-plus'] = ({ next, body, page: from }) => {
            if (body.valveState === true) return Promise.reject(new TypeError('Failed to fetch'));
            if (!slow || from !== page.id) return next();
            return new Promise((resolve) => setTimeout(() => resolve(next()), 600));
        };
        const press = page.driver.pulseValve('plus', 300);
        await waitFor(() => (page.driver.getValvePulse() || {}).stage === 'closing', 1000, 'the press to be closing its valve');
        await page.driver.disconnectVacuglide();
        slow = true;
        const atDisconnect = JSON.parse(handoverStored()).entries[0].openUntil;
        // Held all the while its press closes the valve.
        let gap = false;
        const sampler = setInterval(() => { if (!handoverStored()) gap = true; }, 10);
        await press;
        clearInterval(sampler);
        assert.equal(gap, false, 'held all along');
        const [stored] = JSON.parse(handoverStored()).entries;
        assert.equal(stored.held, true);
        assert.ok(stored.openUntil >= atDisconnect + 400, `written again to reach ${stored.openUntil - atDisconnect} ms further`);
        // Past the window written at Disconnect, another tab connects the
        // device.
        await tick(Math.max(0, atDisconnect + 100 - Date.now()));
        const other = await loadAnotherPage();
        await other.driver.connectVacuglide(TOKEN);
        assert.equal(other.driver.isVacuglideWatchPending(), true, 'the open is watched for through the new link');
        assert.equal(other.driver.isVacuglideWatching(), true);
        await waitFor(() => !page.driver.isVacuglideWatchPending(), 1000, 'the page that let go of it to stop watching it');
        await other.driver.disconnectVacuglide();
        await finished(other);
    });

    // ---- the page's own life: what app.js attaches ----------------------------------------------
    //
    // app.js attaches the driver to its window and its document once, as the
    // page starts, and says only whether it is a partner page
    // (attachVacuglideToPage). Everything the page's own life does to the
    // device follows from that call: the unload stop on pagehide and freeze,
    // the takeover once the page has started and again when it comes back,
    // and nothing at all on the partner viewer and controller pages, nor on
    // another tab's storage write. The pages below start that way, each with
    // a window and a document of its own, and each test fires on them the
    // events a browser fires: nothing here calls the unload stop or a
    // takeover itself.

    // A page that starts as app.js starts one. `remote`: the partner viewer
    // or controller page.
    async function openPage({ remote = false } = {}) {
        const page = await loadAnotherPage({ takeOver: false });
        const win = new EventTarget();
        const doc = new EventTarget();
        page.driver.attachVacuglideToPage({ remote, win, doc });
        return { ...page, win, doc };
    }

    // An event as the browser fires it, with the fields of its own type:
    // persisted on pagehide and pageshow, key and values on storage.
    const fire = (target, type, fields = {}) => target.dispatchEvent(Object.assign(new Event(type), fields));

    const sentBy = (page) => calls.filter((c) => c.page === page.id);

    // What a page that went away while the device may have been running
    // leaves for it, as that page writes it: the whole stop owed, nothing
    // else. The device is running.
    function leftRunning() {
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'gone', at: now - 1000, speedUntil: 0, openUntil: 0, stopUntil: now + 300000, alarm: false }
        ] }));
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 33;
        return handoverStored();
    }

    // `page` took the device over, sent it the whole stop itself, had that
    // confirmed, and has nothing of it left running.
    async function tookOverAndStopped(page) {
        await waitFor(() => page.seen.takeovers.length > 0, 1000, 'the page to take the device over');
        assert.equal(page.seen.takeovers[0].active, true);
        await finished(page);
        assert.match(lastTakeover(page).message, /It confirmed the stop, with both valves closed/);
        assert.ok(sentBy(page).some((c) => c.path === '/vacuglide/target-speed/stop' && c.token === TOKEN), 'the stop is its own');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(handoverStored(), null, 'taken, and finished with');
    }

    // How a page goes away and comes back without being closed: frozen and
    // resumed, or kept for the back button and shown again - pagehide and
    // pageshow, both persisted.
    const COMEBACKS = [
        ['from being frozen', (page) => fire(page.doc, 'freeze'), (page) => fire(page.doc, 'resume')],
        ['from the back-forward cache', (page) => fire(page.win, 'pagehide', { persisted: true }), (page) => fire(page.win, 'pageshow', { persisted: true })]
    ];

    // Once the code that attached it has run to its end - app.js, whose
    // handlers are then there to say so - and by itself: nothing else calls
    // the takeover.
    it('a host page takes over what a page that went away left as soon as it has started', async () => {
        globalThis.localStorage = memoryStorage();
        const left = leftRunning();
        const page = await openPage();
        assert.equal(handoverStored(), left, 'not before the code that attached it has run');
        assert.deepEqual(sentBy(page), []);
        await tookOverAndStopped(page);
    });

    // The partner viewer and controller pages run no hardware of their own.
    // Open in the wearer's browser while a device a page left is running -
    // frozen, resumed, shown again from the back-forward cache, told of a
    // storage write and closed - they read nothing, stop nothing and take
    // nothing over: the entry stays for the host page that loads next.
    it('the partner viewer and controller pages never read, stop or take over a VacuGlide, whatever happens to them', async () => {
        globalThis.localStorage = memoryStorage();
        const left = leftRunning();
        for (const label of ['viewer', 'controller']) {
            const page = await openPage({ remote: true });
            await tick(30);
            fire(page.doc, 'freeze');
            fire(page.doc, 'resume');
            fire(page.win, 'pageshow', { persisted: true });
            fire(page.win, 'storage', { key: 'vacuglide_handover', oldValue: null, newValue: left });
            fire(page.win, 'pagehide', { persisted: false });
            await tick(100);
            assert.deepEqual(sentBy(page), [], `the ${label} page sent nothing`);
            assert.deepEqual(page.seen.takeovers, [], `the ${label} page took nothing over`);
            assert.equal(handoverStored(), left, `the ${label} page left the entry as it was`);
            gonePages.add(page.id);
        }
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'nothing stopped the device');
        // The host page that loads next takes it over: the entry was there
        // to take all along.
        await tookOverAndStopped(await openPage());
    });

    // The device has no watchdog, and a page that is closed, reloaded or
    // frozen runs nothing more: the whole stop goes out with keepalive as it
    // goes, and a device it may have left running is left to the next page.
    for (const [event, target] of [['pagehide', 'win'], ['freeze', 'doc']]) {
        it(`${event} sends a running device the whole stop with keepalive, and leaves it to the next page`, async () => {
            globalThis.localStorage = memoryStorage();
            const page = await openPage();
            await page.driver.connectVacuglide(TOKEN);
            page.driver.dispatchVacuglide(40);
            await waitFor(() => page.driver.isVacuglideMoving() && device.targetSpeed === 40, 1000, 'the session to run');
            calls = [];
            fire(page[target], event, event === 'pagehide' ? { persisted: false } : {});
            assert.deepEqual(keepaliveStops(), WHOLE_STOP, 'the whole stop, as the page goes');
            assert.ok(calls.every((c) => c.keepalive && c.page === page.id && c.token === TOKEN), JSON.stringify(calls));
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
            const [left] = JSON.parse(handoverStored()).entries;
            assert.equal(left.held, false, 'left for the next page');
            assert.ok(left.stopUntil > Date.now(), 'nobody heard that stop land');
            // The page never comes back.
            gonePages.add(page.id);
            page.driver.endVacuglideForTests();
            await tookOverAndStopped(await openPage());
        });
    }

    // A page frozen, or kept for the back button, sends the unload stop and
    // leaves the device like a page that goes away. Back, it drives the
    // device again, and takes back what it left: the page that loads after
    // that has nothing to take over, and sends no stop into its session.
    for (const [how, leave, comeBack] of COMEBACKS) {
        it(`a page back ${how} takes back what it left, and the page that loads next sends nothing into its session`, async () => {
            globalThis.localStorage = memoryStorage();
            const page = await openPage();
            await page.driver.connectVacuglide(TOKEN);
            page.driver.dispatchVacuglide(40);
            await waitFor(() => page.driver.isVacuglideMoving() && device.targetSpeed === 40, 1000, 'the session to run');
            leave(page);
            assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED', 'the unload stop');
            assert.ok(handoverStored(), 'the device left to the next page');
            comeBack(page);
            assert.equal(handoverStored(), null, 'taken back');
            page.driver.dispatchVacuglide(40);
            await waitFor(() => device.operationalMode === 'TARGET_SPEED_PLAYING', 1000, 'its session to run again');
            const stops = stopsOn();
            const next = await openPage();
            await tick(200);
            assert.deepEqual(next.seen.takeovers, []);
            assert.deepEqual(sentBy(next), [], 'the page that loads next sends nothing');
            assert.equal(stopsOn(), stops, 'nothing stopped the session');
            assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING');
            await page.driver.disconnectVacuglide();
            await finished(page);
        });
    }

    // Another page can go away and leave the device while this one is away:
    // back, this page takes it over, as a page that loads would.
    for (const [how, leave, comeBack] of COMEBACKS) {
        it(`a page back ${how} takes over what a page that went away meanwhile left`, async () => {
            globalThis.localStorage = memoryStorage();
            const page = await openPage();
            await tick(30);
            leave(page);
            assert.equal(handoverStored(), null, 'it had nothing to leave');
            leftRunning();
            await tick(100);
            assert.deepEqual(page.seen.takeovers, [], 'nothing while it is away');
            comeBack(page);
            await tookOverAndStopped(page);
        });
    }

    // Back, a page lets go of what it left before it takes over what others
    // left. This page was watching a device a page that went away had left a
    // speed out on; it is frozen, and a page loaded meanwhile takes over what
    // it left, then goes away in turn. Back, this page lets go of the watch
    // it had and takes the device over afresh from what that page left,
    // reading it at once: nothing has looked at the device since that page
    // went. Taken over first, that page's entry would only have joined the
    // watch this page already had, whose next read can be a beat away - here
    // a long one, so the difference shows.
    it('a page back from being frozen reads at once a device it was watching, which a page loaded meanwhile took over and left', async () => {
        globalThis.localStorage = memoryStorage();
        const now = Date.now();
        globalThis.localStorage.setItem('vacuglide_handover', JSON.stringify({ entries: [
            { token: TOKEN, cluster: CLUSTER, page: 'gone', at: now - 500, speedUntil: now + 2000, openUntil: 0, stopUntil: 0, alarm: false }
        ] }));
        const page = await openPage();
        page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 10000;
        await waitFor(() => page.seen.takeovers.length > 0 && sentBy(page).some((c) => c.path === '/vacuglide/state'), 1000, 'the page to take the device over and read it');
        fire(page.doc, 'freeze');
        const loaded = await openPage();
        await waitFor(() => loaded.seen.takeovers.length > 0 && sentBy(loaded).some((c) => c.path === '/vacuglide/state'), 1000, 'the page loaded meanwhile to take the device over');
        fire(loaded.win, 'pagehide', { persisted: false });
        gonePages.add(loaded.id);
        loaded.driver.endVacuglideForTests();
        // The speed the first page left out lands now.
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 55;
        const eventsFrom = device.events.length;
        const callsFrom = calls.length;
        const back = Date.now();
        page.driver.VACUGLIDE_TIMINGS.lateCommandWatchBeatMs = 50;
        fire(page.doc, 'resume');
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 3000, 'the device to be stopped');
        const stop = device.events.slice(eventsFrom).find((e) => e.what === 'stop');
        assert.ok(stop.at - back < UNDONE_WITHIN_MS, `stopped ${stop.at - back} ms after the page came back`);
        assert.ok(calls.slice(callsFrom).some((c) => c.page === page.id && c.path === '/vacuglide/target-speed/stop'), 'by the page that came back');
        await finished(page);
    });

    // A page that is open when another one goes away takes nothing over: it
    // could not tell when the wearer drove the device again from the
    // reloaded tab, and would stop that session on every read for a minute,
    // with its alarm in a tab nobody is looking at. The browser tells it of
    // the write with a storage event, and nothing comes of that. The page
    // that loads next takes the device over.
    it('a page that is open when another one goes away takes nothing over, whatever storage events it gets', async () => {
        globalThis.localStorage = memoryStorage();
        const open = await openPage();
        await tick(30);
        const other = await openPage();
        await other.driver.connectVacuglide(TOKEN);
        other.driver.dispatchVacuglide(40);
        await waitFor(() => other.driver.isVacuglideMoving() && device.targetSpeed === 40, 1000, 'the other page\'s session to run');
        fire(other.win, 'pagehide', { persisted: false });
        gonePages.add(other.id);
        other.driver.endVacuglideForTests();
        const left = handoverStored();
        assert.ok(left, 'the other page left the device');
        // A speed of that page's lands late: the device runs again.
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 55;
        fire(open.win, 'storage', { key: 'vacuglide_handover', oldValue: null, newValue: left });
        await tick(200);
        assert.deepEqual(sentBy(open), [], 'the open page sent nothing');
        assert.deepEqual(open.seen.takeovers, []);
        assert.equal(handoverStored(), left, 'the entry stays for the page that loads next');
        await tookOverAndStopped(await openPage());
        assert.deepEqual(sentBy(open), [], 'nor at any point after');
    });

    // ---- a page that crashed ------------------------------------------------------------------
    //
    // A crash fires no pagehide: no unload stop goes out and no handover
    // entry is left. The crash-recovery marker names the device and its
    // cluster, and the page that recovers that session sends it its whole
    // stop through stopVacuglideAfterCrash.

    // The background stop's rounds run on unref'd timers, which never keep
    // a node:test process alive by themselves: wait on a timer of our own.
    async function settled(promise) {
        const keepAlive = setInterval(() => {}, 5);
        try {
            return await promise;
        } finally {
            clearInterval(keepAlive);
        }
    }

    it('a crash stop finds the device through the router and sends it the whole stop, confirmed, without connecting it', async () => {
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 60;
        device.strokePlusValve = true;
        const updates = [];
        const result = await settled(stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER, onUpdate: (u) => updates.push(u) }));
        assert.deepEqual(result, { outcome: 'stopped', detail: '', final: true });
        assert.deepEqual(updates, [result]);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
        assert.equal(calls[0].host, LATENCY, 'the router first: the device may have moved cluster');
        assert.deepEqual(calls.slice(1).map((c) => `${c.host} ${c.method} ${c.path}`).sort(), [
            `${CLUSTER} PUT /vacuglide/target-speed/stop`,
            `${CLUSTER} PUT /vacuglide/valve/stroke-minus`,
            `${CLUSTER} PUT /vacuglide/valve/stroke-plus`
        ]);
        assert.equal(isVacuglideConnected(), false, 'nothing is connected');
        assert.deepEqual(unconfirmed, []);
        await tick(50);
        assert.equal(calls.length, 4, 'and nothing reads it after: a page connected since must not be stopped on every read');
    });

    it('a crash stop to a device that is not online raises the alarm on this page, says so, and stops it once it is back', async () => {
        device.online = false;
        const updates = [];
        const pending = stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER, onUpdate: (u) => updates.push(u) });
        await waitFor(() => updates.length >= 1, 1000, 'the first round');
        assert.deepEqual(updates[0], { outcome: 'offline', detail: 'The VacuGlide is not online', final: false });
        assert.equal(unconfirmed.length, 1, 'the alarm, where the wearer is');
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 35;
        device.online = true;
        const result = await settled(pending);
        assert.equal(result.outcome, 'stopped');
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
    });

    it('a crash stop with no cluster known asks the router, and never sends the token anywhere else', async () => {
        // Every URL the driver hands fetch, a relative one included (the
        // stand-in cloud would refuse to parse it and record nothing).
        const urls = [];
        const cloud = globalThis.fetch;
        globalThis.fetch = (url, init) => {
            urls.push(String(url));
            return cloud(url, init);
        };
        routes['GET /vacuglide/connected'] = () => Promise.reject(new TypeError('Failed to fetch'));
        const updates = [];
        const pending = stopVacuglideAfterCrash(TOKEN, { cluster: '', onUpdate: (u) => updates.push(u) });
        await waitFor(() => updates.length >= 1, 1000, 'the first round');
        assert.equal(updates[0].final, false);
        assert.ok(calls.every((c) => c.host === LATENCY), JSON.stringify(calls.map((c) => c.host)));
        delete routes['GET /vacuglide/connected'];
        const result = await settled(pending);
        assert.equal(result.outcome, 'stopped');
        assert.ok(calls.filter((c) => c.host !== LATENCY).every((c) => c.host === CLUSTER));
        assert.ok(urls.length > 2 && urls.every((url) => url.startsWith(`${LATENCY}/`) || url.startsWith(`${CLUSTER}/`)), JSON.stringify(urls));
    });

    it('a crash stop for the VacuGlide this page has connected goes through its own link, and leaves a running session to drive it', async () => {
        await connectOk();
        const idle = await stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER });
        assert.deepEqual(idle, { outcome: 'linked', detail: '', final: true });
        await waitFor(() => sent('/vacuglide/target-speed/stop').length === 1, 1000, 'outside a session, the whole stop at once');
        assert.equal(sent('/vacuglide/connected').length, 0, 'through its own link');
        sessionActive = true;
        dispatchVacuglide(40);
        await waitFor(() => device.targetSpeed === 40, 1000, 'the session');
        calls = [];
        const driving = await stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER });
        assert.equal(driving.outcome, 'linked');
        await tick(30);
        assert.equal(sent('/vacuglide/target-speed/stop').length, 0, 'the session on this page drives it, and stops it on every way out');
        assert.equal(isVacuglideMotionUnknown(), true, 'its link no longer vouches that it is at rest');
        dispatchVacuglide(0);
        await waitFor(() => device.operationalMode === 'TARGET_SPEED_PAUSED', 1000, 'its next zero sends the whole stop');
    });

    it('two passes asking for the same device share one stop', async () => {
        const first = stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER });
        const second = stopVacuglideAfterCrash(TOKEN, { cluster: CLUSTER });
        const [a, b] = await settled(Promise.all([first, second]));
        assert.equal(a.outcome, 'stopped');
        assert.equal(b.outcome, 'stopped');
        assert.equal(sent('/vacuglide/target-speed/stop').length, 1);
    });

    it('a page that crashed mid-session: the next page recovers its marker, and the VacuGlide gets its whole stop', async () => {
        // The crashed page's storage: a session drove the VacuGlide, then the
        // browser died - no pagehide, no unload stop, no handover entry.
        const store = new Map();
        const storage = {
            get length() { return store.size; },
            key: (i) => [...store.keys()][i] ?? null,
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => { store.delete(k); }
        };
        createLiveSessionTracker({ owner: 'crashed', storage }).note({ handyKey: '', intiface: false, tcode: false, vacuglide: { token: TOKEN, cluster: CLUSTER } });
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 45;
        device.strokeMinusValve = true;
        const reports = [];
        const result = await settled(runCrashRecovery({
            storage,
            locks: null,
            stopVacuglide: stopVacuglideAfterCrash,
            vacuglideRetryMinutes: vacuglideStopChaseMs() / 60000,
            onReport: (text) => reports.push(text)
        }));
        assert.equal(result.recovered, true);
        assert.equal(result.settled, true);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
        assert.match(reports[0], /did not end cleanly/);
        assert.match(reports.at(-1), /EdgeLoop sent The VacuGlide \(token ending [a-z0-9]{4}\) its whole stop - the motor stop and both valve closes\. Autoblow's server confirmed it: the motor is stopped and both valves are closed\.$/);
    });

    // The crash marker is all a crashed page leaves. A whole stop that the
    // device - not online all through its window - never confirmed is owed
    // to the next page to open, as a Handy's stop is, and sent again there.
    it('a crash stop that gave up while the device was not online is sent again by the next page to open, and stops it then', async () => {
        VACUGLIDE_TIMINGS.offlineStopRetryMs = 10;
        const store = new Map();
        const storage = {
            get length() { return store.size; },
            key: (i) => [...store.keys()][i] ?? null,
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => { store.delete(k); }
        };
        createLiveSessionTracker({ owner: 'crashed', storage }).note({ handyKey: '', intiface: false, tcode: false, vacuglide: { token: TOKEN, cluster: CLUSTER } });
        device.operationalMode = 'TARGET_SPEED_PLAYING';
        device.targetSpeed = 45;
        device.online = false;
        const pass = (reports) => settled(runCrashRecovery({
            storage,
            locks: null,
            stopVacuglide: stopVacuglideAfterCrash,
            vacuglideRetryMinutes: 5,
            onReport: (text) => reports.push(text)
        }));
        const reports = [];
        const first = await pass(reports);
        assert.equal(first.settled, false);
        assert.match(reports.at(-1), /EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PLAYING', 'nothing reached it');
        // That page closes; the device comes back online; the next page opens.
        endVacuglideForTests();
        device.online = true;
        const nextReports = [];
        const second = await pass(nextReports);
        assert.equal(second.settled, true);
        assert.match(nextReports[0], /^An earlier session did not end cleanly/);
        assert.equal(device.operationalMode, 'TARGET_SPEED_PAUSED');
        assert.equal(device.strokePlusValve, false);
        assert.equal(device.strokeMinusValve, false);
        const third = [];
        assert.equal((await pass(third)).recovered, false, 'and nothing is owed any more');
    });
});

// app.js cannot be loaded here: it needs the page. Its one call into the
// driver for the page's own life is pinned instead, as write-coalescer.test.js
// pins the session limits' flush. A merge into app.js that dropped that call,
// made it depend on anything, attached the partner pages, or put back a
// takeover by a tab that was already open would pass every test above.
describe('app.js attaches the VacuGlide to the page', () => {
    const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

    // The text of the call whose name starts at `from`, to its closing paren.
    function callAt(from) {
        const open = src.indexOf('(', from);
        let depth = 0;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '(') depth += 1;
            else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
        }
        return src.slice(from);
    }

    it('once, as the module runs, saying only whether this is a partner page', () => {
        assert.match(src, /^import \{[^}]*\battachVacuglideToPage\b[^}]*\} from '\.\/hardware\/vacuglide\.js';$/m,
            'app.js imports attachVacuglideToPage from the driver - without it the page stops at the call');
        const attached = src.match(/\battachVacuglideToPage\s*\(/g) || [];
        assert.equal(attached.length, 1, `app.js calls attachVacuglideToPage ${attached.length} times`);
        const call = /^attachVacuglideToPage\(\{([^}]*)\}\);$/m.exec(src);
        assert.ok(call, 'the call stands on its own at the top level of app.js - not in a block, a function or a condition');
        const args = Object.fromEntries(call[1].split(',').map((part) => part.split(':').map((s) => s.trim())).filter(([name]) => name));
        assert.deepEqual(args, { remote: 'isRemotePage', win: 'window', doc: 'document' });
    });

    it('reaches the unload stop and the takeover through nothing else', () => {
        for (const name of ['stopVacuglideOnUnload', 'withdrawVacuglideHandover', 'takeOverVacuglideHandover']) {
            assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `app.js uses ${name} itself, outside attachVacuglideToPage`);
        }
    });

    it('does nothing to the VacuGlide on another tab\'s storage write', () => {
        assert.ok(!/\bonstorage\b/.test(src), 'app.js sets onstorage');
        for (const match of src.matchAll(/\.addEventListener\(\s*['"`]storage['"`]/g)) {
            const listener = callAt(match.index);
            assert.doesNotMatch(listener, /vacuglide|handover/i, `a storage listener in app.js acts on the VacuGlide: ${listener}`);
        }
    });
});
