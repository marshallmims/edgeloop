// Driver tests with a mocked global fetch. No network, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_TIMINGS,
    connectHandy,
    disconnectHandy,
    dispatchHandy,
    dispatchHandyFollow,
    stopHandy,
    stopHandyOnUnload,
    pollHandyConnected,
    queryHandyBattery,
    setHandyHandlers,
    getHandyKey,
    isHandyMoving,
    isHandyMotionUnknown,
    isHandyOfflineStopPending,
    handyConnected
} from './handy.js';
import { HANDY_API_BASE, HANDY_MODE } from './handy-protocol.js';
import { HANDY_V3_BASE } from './handy-hsp-protocol.js';

const KEY = 'test-key-123';

let calls = [];
let routes = {};
let errors = [];
let offline = [];
let unconfirmed = [];
let notices = [];
let sessionActive = true;

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function pathOf(url) {
    if (url.startsWith(HANDY_V3_BASE)) return url.slice(HANDY_V3_BASE.length);
    assert.ok(url.startsWith(HANDY_API_BASE), `unexpected base url ${url}`);
    return url.slice(HANDY_API_BASE.length);
}

function installFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const path = pathOf(url);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        const key = init.headers['X-Connection-Key'];
        calls.push({ path, method, body, key, keepalive: init.keepalive === true });
        const handler = routes[`${method} ${path}`] || routes[path];
        let result;
        if (typeof handler === 'function') result = handler({ path, method, body, key });
        else if (handler === undefined) result = jsonResponse({ result: 0 });
        else result = handler;
        // Honour the abort signal like a real fetch would.
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

async function connectOk() {
    routes['/connected'] = jsonResponse({ connected: true });
    routes['/info'] = jsonResponse({ fwVersion: '3.2.3', model: 'Handy 1.1' });
    const result = await connectHandy(KEY);
    calls = [];
    return result;
}

const sent = (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method));

describe('handy driver', () => {
    beforeEach(() => {
        calls = [];
        routes = {};
        errors = [];
        offline = [];
        unconfirmed = [];
        notices = [];
        sessionActive = true;
        // Short backoffs keep the retry tests fast; the attempt counts are unchanged.
        HANDY_TIMINGS.requestTimeoutMs = 6000;
        HANDY_TIMINGS.stopRetryDelaysMs = [5, 10, 20];
        HANDY_TIMINGS.offlineStopRetryMs = 80;
        installFetch();
        setHandyHandlers({
            onError: (m) => errors.push(m),
            onOffline: (r) => offline.push(r),
            onStopUnconfirmed: (m) => unconfirmed.push(m),
            onNotice: (m) => notices.push(m),
            isSessionActive: () => sessionActive
        });
    });

    afterEach(async () => {
        routes = {};
        disconnectHandy();
        await tick(0);
    });

    it('connects in HAMP mode, stops the device and reads info', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3', model: 'Handy 1.1', battery: 77 });
        const result = await connectHandy(` ${KEY} `);

        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
            'GET /connected', 'PUT /mode', 'PUT /hamp/stop', 'GET /info'
        ]);
        assert.deepEqual(sent('/mode')[0].body, { mode: 0 });
        assert.ok(calls.every((c) => c.key === KEY));
        assert.equal(getHandyKey(), KEY);
        assert.equal(result.battery, null);
        assert.equal(result.profile.id, 'handy1');
        assert.equal(result.profile.hasBattery, false);
        assert.equal(result.description, 'fw 3.2.3, Handy 1.1');
        assert.equal(isHandyMoving(), false);
    });

    it('rejects an offline device with a readable error', async () => {
        routes['/connected'] = jsonResponse({ connected: false });
        await assert.rejects(connectHandy(KEY), /offline/i);
        assert.equal(getHandyKey(), '');
    });

    it('rejects an API error object even on HTTP 200', async () => {
        routes['/connected'] = jsonResponse({ error: { code: 1001, message: 'Invalid connection key' } });
        await assert.rejects(connectHandy(KEY), /Invalid connection key/);
    });

    it('rejects a failed mode switch', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /mode'] = jsonResponse({ result: -1 });
        await assert.rejects(connectHandy(KEY), /rejected|HAMP/);
        assert.equal(sent('/hamp/stop').length, 0);
    });

    it('rejects a failed initial stop', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /hamp/stop'] = jsonResponse(null, 503);
        await assert.rejects(connectHandy(KEY), /HTTP 503/);
    });

    it('still connects when /info is unavailable', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse(null, 404);
        const result = await connectHandy(KEY);
        assert.equal(result.battery, null);
        assert.equal(result.description, '');
    });

    it('sets slide, starts, then sends velocity using the stored key', async () => {
        await connectOk();
        dispatchHandy(55, 20, 80, true, 0, 100);
        await tick(5);

        const seq = calls.map((c) => `${c.method} ${c.path}`);
        assert.deepEqual(seq, ['PUT /slide', 'PUT /hamp/start', 'PUT /hamp/velocity']);
        assert.deepEqual(sent('/slide')[0].body, { min: 20, max: 80 });
        assert.deepEqual(sent('/hamp/velocity')[0].body, { velocity: 55 });
        assert.ok(calls.every((c) => c.key === KEY));
        assert.equal(isHandyMoving(), true);
    });

    it('re-sends the slide range when only min changes', async () => {
        await connectOk();
        dispatchHandy(40, 20, 80, true, 0, 100);
        await tick(5);
        dispatchHandy(40, 30, 80, true, 0, 100);
        await tick(5);
        const slides = sent('/slide').map((c) => c.body);
        assert.deepEqual(slides, [{ min: 20, max: 80 }, { min: 30, max: 80 }]);
    });

    it('never sends a slide narrower than 10% or outside the envelope', async () => {
        await connectOk();
        dispatchHandy(40, 84, 85, true, 15, 85);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 75, max: 85 });
        dispatchHandy(40, -20, 140, true, 15, 85);
        await tick(5);
        assert.deepEqual(sent('/slide')[1].body, { min: 15, max: 85 });
    });

    it('clamps velocity to 0-100 and skips duplicate velocity sends', async () => {
        await connectOk();
        dispatchHandy(140, 0, 100, true, 0, 100);
        await tick(5);
        dispatchHandy(140, 0, 100, true, 0, 100);
        await tick(5);
        const vel = sent('/hamp/velocity').map((c) => c.body.velocity);
        assert.deepEqual(vel, [100]);
    });

    it('throttles unforced dispatches to one per 400 ms', async () => {
        await connectOk();
        dispatchHandy(30, 0, 100, false, 0, 100);
        await tick(5);
        dispatchHandy(60, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [30]);
    });

    it('stops on zero speed and marks the device stopped only after confirmation', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);

        let release;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { release = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), true, 'must not flip to stopped before the API confirms');
        release();
        await tick(5);
        assert.equal(isHandyMoving(), false);
    });

    it('retries a failed stop with backoff and reports when it is never confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);

        let attempts = 0;
        routes['PUT /hamp/stop'] = () => {
            attempts += 1;
            return attempts < 3 ? jsonResponse(null, 500) : jsonResponse({ result: 0 });
        };
        const ok = await stopHandy();
        assert.equal(ok, true);
        assert.equal(attempts, 3);
        assert.equal(isHandyMoving(), false);
        assert.ok(errors.some((m) => m && /HTTP 500/.test(m)));
        assert.equal(errors[errors.length - 1], null, 'recovery is reported after the confirmed stop');
    });

    it('keeps the device flagged as moving when every stop attempt fails', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);

        let attempts = 0;
        routes['PUT /hamp/stop'] = () => { attempts += 1; return jsonResponse(null, 500); };
        const ok = await stopHandy();
        assert.equal(ok, false);
        assert.equal(attempts, 4);
        assert.ok(errors.some((m) => m && /Stop not confirmed/.test(m)));
    });

    it('ignores a start that resolves after a later stop and re-issues the stop', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });

        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMoving(), false);

        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);

        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false, 'stale start must not flip running=true');
        assert.equal(sent('/hamp/velocity').length, 0, 'stale start must not send velocity');
        assert.equal(sent('/hamp/stop').length, 2, 'a safety stop follows the stale start');
    });

    it('leaves running=false and reports when start fails', async () => {
        await connectOk();
        routes['PUT /hamp/start'] = jsonResponse({ error: { code: 3000, message: 'Device busy' } });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), false);
        assert.equal(sent('/hamp/velocity').length, 0);
        assert.ok(errors.some((m) => m && /Device busy/.test(m)));
    });

    it('goes offline after five consecutive failed dispatch ticks (not requests)', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse(null, 500);
        routes['PUT /hamp/start'] = jsonResponse(null, 500);
        routes['PUT /hamp/velocity'] = jsonResponse(null, 500);
        for (let i = 0; i < 4; i++) {
            dispatchHandy(50, 0, 100, true, 0, 100);
            await tick(5);
        }
        assert.equal(offline.length, 0, 'four failed ticks are not yet offline');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(offline.length, 1);
        assert.match(offline[0], /stopped responding/);
        assert.equal(handyConnected, false);
        assert.ok(sent('/hamp/stop').length >= 1, 'going offline sends a stop');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(offline.length, 1, 'offline is reported once');
    });

    it('polls /connected only while a session is active', async () => {
        await connectOk();
        sessionActive = false;
        await pollHandyConnected();
        assert.equal(sent('/connected').length, 0);
        sessionActive = true;
        routes['/connected'] = jsonResponse({ connected: true });
        await pollHandyConnected();
        assert.equal(sent('/connected').length, 1);
        assert.equal(offline.length, 0);
    });

    it('goes offline when the poll reports connected=false', async () => {
        await connectOk();
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0], /no longer connected/);
    });

    it('goes offline after three consecutive poll errors', async () => {
        await connectOk();
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await pollHandyConnected();
        await pollHandyConnected();
        assert.equal(offline.length, 0);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0], /unreachable/);
        assert.ok(errors.some((m) => m && /Network error/.test(m)));
    });

    it('disconnect sends a stop with the stored key and ignores further dispatches', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        disconnectHandy();
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        calls = [];
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0);
    });

    it('queryHandyBattery only reads /info and tolerates a missing field', async () => {
        await connectOk();
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3' });
        assert.equal(await queryHandyBattery(), null);
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3', battery: 0.5 });
        assert.equal(await queryHandyBattery(), 50);
        routes['/info'] = jsonResponse({ battery: 1 });
        assert.equal(await queryHandyBattery(), 1);
        assert.ok(calls.every((c) => c.path === '/info'));
    });
    // ---- reconnect ---------------------------------------------------------------

    it('a reconnect whose verification fails leaves the live link, and its stop path, untouched', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(connectHandy(KEY), /Network error/);
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.equal(isHandyMoving(), true, 'the running device is still owned');
        calls = [];
        assert.equal(await stopHandy(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        assert.equal(isHandyMoving(), false);
    });

    it('a reconnect brings the running device to a confirmed stop before switching keys', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        const result = await connectHandy('second-key');
        assert.equal(result.description, 'fw 3.2.3, Handy 1.1');
        assert.equal(getHandyKey(), 'second-key');
        assert.equal(isHandyMoving(), false);
        const stops = sent('/hamp/stop');
        assert.ok(stops.some((c) => c.key === 'second-key'), 'the new key is verified with a stop');
        assert.ok(stops.some((c) => c.key === KEY), 'the running device is stopped with its own key');
        const verify = calls.findIndex((c) => c.path === '/connected' && c.key === 'second-key');
        const oldStop = calls.findIndex((c) => c.path === '/hamp/stop' && c.key === KEY);
        assert.ok(verify >= 0 && verify < oldStop, 'the old device is only stopped once the new key passed');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start')[0].key, 'second-key');
    });

    it('refuses to switch keys when the running device will not confirm a stop', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(null, 503) : jsonResponse({ result: 0 }));
        await assert.rejects(connectHandy('second-key'), /did not confirm a stop/);
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.equal(isHandyMoving(), true);
        assert.equal(unconfirmed.length, 1);
    });

    // ---- stops that must still reach a device the driver no longer owns -------------

    it('a start that resolves after Disconnect is followed by a stop with the old key', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(await disconnectHandy(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(getHandyKey(), '');
        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false, 'stale start must not flip running=true');
        assert.equal(sent('/hamp/velocity').length, 0, 'stale start must not send velocity');
        assert.equal(sent('/hamp/stop').length, 2, 'a safety stop follows the stale start');
        assert.equal(sent('/hamp/stop')[1].key, KEY);
    });

    it('a start that resolves after the device went offline is followed by a stop', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        await tick(5);
        const stopsAfterOffline = sent('/hamp/stop').length;
        assert.ok(stopsAfterOffline >= 1, 'going offline sends a stop');
        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false);
        assert.equal(sent('/hamp/stop').length, stopsAfterOffline + 1, 'a safety stop follows the stale start');
        assert.equal(sent('/hamp/stop')[stopsAfterOffline].key, KEY);
    });

    it('a hanging stop for a disconnected key never masks a stop for the new device', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 60;
        // The old device is out of reach: its stop hangs until the timeout and retries.
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? new Promise(() => {}) : jsonResponse({ result: 0 }));
        const oldStop = disconnectHandy();
        await tick(5);
        await connectHandy('second-key');
        dispatchHandy(60, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        calls = [];
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').filter((c) => c.key === 'second-key').length, 1, 'STOP reaches the new device at once');
        assert.equal(isHandyMoving(), false);
        assert.equal(await oldStop, false, 'the old chain ends unconfirmed on its own');
    });

    it('keeps sending stops to an offline device until one is confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        const fail = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /slide'] = fail;
        routes['PUT /hamp/velocity'] = fail;
        routes['PUT /hamp/stop'] = fail;
        for (let i = 0; i < 5; i++) {
            dispatchHandy(50 + i, 0, 100, true, 0, 100);
            await tick(5);
        }
        assert.equal(offline.length, 1);
        assert.equal(handyConnected, false);
        // First background round: four attempts, none confirmed, reported once.
        await tick(60);
        assert.ok(sent('/hamp/stop').length >= 4);
        assert.equal(unconfirmed.length, 1);
        assert.equal(isHandyOfflineStopPending(), true);
        // The network is back: the next round confirms the stop and the job ends.
        routes['PUT /hamp/stop'] = undefined;
        const before = sent('/hamp/stop').length;
        await tick(HANDY_TIMINGS.offlineStopRetryMs + 40);
        assert.ok(sent('/hamp/stop').length > before, 'another stop round went out');
        assert.equal(sent('/hamp/stop')[sent('/hamp/stop').length - 1].key, KEY);
        assert.equal(isHandyOfflineStopPending(), false);
    });

    it('disconnect resolves false and reports when the stop is never confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = jsonResponse(null, 500);
        assert.equal(await disconnectHandy(), false);
        assert.equal(sent('/hamp/stop').length, 4);
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /Stop not confirmed/);
        assert.equal(getHandyKey(), '');
    });

    it('stopHandyOnUnload sends a keepalive stop and treats the device as stopped', async () => {
        await connectOk();
        assert.equal(stopHandyOnUnload(), false, 'nothing to stop while idle');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        assert.equal(stopHandyOnUnload(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].keepalive, true);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        assert.equal(isHandyMoving(), false);
        // A page that comes back restarts the motor on its next tick.
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
    });

    // ---- ordering and unknown states -------------------------------------------------

    it('starts the motor only after the slide range has been confirmed', async () => {
        await connectOk();
        let releaseSlide;
        routes['PUT /slide'] = () => new Promise((resolve) => { releaseSlide = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/slide').length, 1);
        assert.equal(sent('/hamp/start').length, 0, 'no start before the range landed');
        releaseSlide();
        await tick(5);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /slide', 'PUT /hamp/start', 'PUT /hamp/velocity']);
        assert.equal(isHandyMoving(), true);
    });

    it('does not start at an unknown range: a rejected slide is re-sent before any start', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse(null, 500);
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 0);
        assert.equal(isHandyMoving(), false);
        routes['PUT /slide'] = undefined;
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/slide').length, 2);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMoving(), true);
    });

    it('a start that times out after a stop is followed by a fresh stop', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        await tick(70);
        assert.equal(sent('/hamp/stop').length, 2, 'the relay may still deliver the start: stop again');
        assert.equal(isHandyMoving(), false);
    });

    it('a start that times out leaves the motion unknown, so the next zero dispatch sends a stop', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(70);
        assert.equal(isHandyMoving(), false);
        assert.equal(isHandyMotionUnknown(), true);
        assert.ok(errors.some((m) => m && /timed out/.test(m)));
        routes['PUT /hamp/start'] = undefined;
        // An unforced zero (the IDLE tick) after the throttle window.
        await tick(400);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('a success on another path does not clear a velocity error', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/velocity'] = jsonResponse({ error: { code: 3000, message: 'HampError' } });
        dispatchHandy(60, 0, 100, true, 0, 100);
        await tick(5);
        assert.match(errors[errors.length - 1], /HampError/);
        routes['/connected'] = jsonResponse({ connected: true });
        await pollHandyConnected();
        assert.match(errors[errors.length - 1], /HampError/, 'the poll must not clear it');
        dispatchHandy(70, 10, 90, true, 0, 100);
        await tick(5);
        assert.match(errors[errors.length - 1], /HampError/, 'a slide reply must not clear it');
        routes['PUT /hamp/velocity'] = undefined;
        dispatchHandy(80, 10, 90, true, 0, 100);
        await tick(5);
        assert.equal(errors[errors.length - 1], null, 'cleared once velocity succeeds again');
    });
    // The report this came from: X333's Handy 2 hit its own safety lockout
    // "as soon as warmup is over", once our /slide fix meant the full 0-100
    // range reached the device for the first time. The driver now keeps the
    // carriage off the mechanical ends unless the wearer says otherwise.
    it('keeps the stroke off the mechanical ends by default', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 5, max: 95 });
    });

    it('sends the full range when the margin is 0', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100, 0);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 0, max: 100 });
    });

    it('does not touch a range that already clears the ends', async () => {
        // Anyone who typed their own guards sees exactly what they typed.
        await connectOk();
        dispatchHandy(50, 15, 85, true, 15, 85, 5);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 15, max: 85 });
    });

    it('never leaves the envelope or the minimum stroke with a margin applied', async () => {
        await connectOk();
        // A tip-only zone at the top of a full envelope, at the widest margin.
        dispatchHandy(50, 95, 100, true, 0, 100, 10);
        await tick(5);
        const body = sent('/slide')[0].body;
        assert.ok(body.min >= 0 && body.max <= 100);
        assert.ok(body.max - body.min >= 10, `stroke was ${body.min}-${body.max}`);
        // A narrow envelope: the margin yields rather than shrink the stroke.
        dispatchHandy(50, 0, 100, true, 0, 10, 10);
        await tick(5);
        assert.deepEqual(sent('/slide')[1].body, { min: 0, max: 10 });
    });

    it('passes on a range the device rounded to its own limits, once', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse({ result: 1 });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1);
        assert.match(notices[0], /rounded down/);
        assert.match(notices[0], /5-95%/);
        dispatchHandy(50, 10, 90, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1, 'the same news every tick is not news');
    });

    it('names a HAMP fault instead of leaving a dead toy unexplained', async () => {
        await connectOk();
        routes['PUT /hamp/velocity'] = jsonResponse({ error: { code: 3000, message: 'HampError' } });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1);
        assert.match(notices[0], /HAMP error 3000/);
        assert.match(notices[0], /obstruction/i);
        // Explaining a refusal is all it does: the existing offline counter
        // is still the only thing that decides when to give up on the link.
        assert.equal(offline.length, 0);
    });

    it('follows where the finger moved during the mode switch and brakes there', async () => {
        HANDY_TIMINGS.hdspIntervalMs = 0;
        try {
            await connectOk();
            dispatchHandyFollow(0, 0, 100, 5);
            dispatchHandyFollow(80, 0, 100, 5);
            await tick(40);
            const xpt = sent('/hdsp/xpt', 'PUT');
            assert.equal(xpt.length, 1);
            assert.equal(xpt[0].body.position, 77);
            assert.equal(xpt[0].body.stopOnTarget, true);
            assert.ok(xpt[0].body.duration >= 120);
        } finally {
            HANDY_TIMINGS.hdspIntervalMs = 250;
        }
    });

    it('follows the finger back down from the top', async () => {
        HANDY_TIMINGS.hdspIntervalMs = 0;
        try {
            await connectOk();
            dispatchHandyFollow(100, 0, 100, 5);
            await tick(40);
            calls = [];
            dispatchHandyFollow(40, 0, 100, 5);
            await tick(40);
            const xpt = sent('/hdsp/xpt', 'PUT');
            assert.equal(xpt.at(-1).body.position, 41);
            assert.equal(xpt.at(-1).body.stopOnTarget, true);
            assert.equal(sent('/slide', 'PUT').length, 0);
        } finally {
            HANDY_TIMINGS.hdspIntervalMs = 250;
        }
    });

    it('firmware 4 moves to an absolute position on the v3 API and stays there', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse({ fwVersion: '4.2.2+44874492', model: 'Handy 2' });
        await connectHandy(KEY);
        calls = [];
        HANDY_TIMINGS.hdspIntervalMs = 0;
        try {
            dispatchHandyFollow(50, 0, 100, 5);
            await tick(40);
            const mode = calls.find((call) => call.path === '/mode' && call.body && call.body.mode === HANDY_MODE.HDSP);
            assert.ok(mode, 'firmware 4 must be put in HDSP');
            const xpt = calls.filter((call) => call.path === '/hdsp/xpt');
            assert.equal(xpt.length, 1);
            assert.equal(xpt[0].body.xp, 0.5);
            assert.equal(xpt[0].body.stop_on_target, true);
            assert.equal(xpt[0].body.position, undefined);
            const stroke = calls.find((call) => call.path === '/slider/stroke');
            assert.ok(stroke, 'firmware 4 opens the full travel window');
            assert.equal(stroke.body.min, 0.05);
            assert.equal(stroke.body.max, 0.95);
            assert.ok(xpt[0].body.t >= 120);
        } finally {
            HANDY_TIMINGS.hdspIntervalMs = 250;
        }
    });

    it('follows a finger in HDSP, then a speed command returns to HAMP', async () => {
        HANDY_TIMINGS.hdspIntervalMs = 0;
        try {
            await connectOk();
            dispatchHandyFollow(0, 0, 100, 5);
            await tick(40);
            assert.deepEqual(sent('/slide', 'PUT')[0].body, { min: 5, max: 95 });
            assert.equal(sent('/mode', 'PUT')[0].body.mode, HANDY_MODE.HDSP);
            const xpt = sent('/hdsp/xpt', 'PUT');
            assert.equal(xpt.length, 1);
            assert.equal(xpt[0].body.position, 5);
            assert.equal(xpt[0].body.immediateResponse, true);
            assert.equal(xpt[0].body.stopOnTarget, true);
            assert.ok(xpt[0].body.duration >= 120);
            calls = [];
            dispatchHandyFollow(100, 0, 100, 5);
            await tick(40);
            assert.equal(sent('/hdsp/xpt', 'PUT')[0].body.position, 95);
            assert.equal(sent('/mode', 'PUT').length, 0);
            calls = [];
            dispatchHandy(40, 10, 90, true, 0, 100, 0);
            await tick(50);
            assert.ok(sent('/mode', 'PUT').some((call) => call.body.mode === HANDY_MODE.HAMP));
            assert.ok(sent('/slide', 'PUT').length > 0 || sent('/hamp/start', 'PUT').length > 0);
        } finally {
            HANDY_TIMINGS.hdspIntervalMs = 250;
        }
    });

    it('stops a position follow by leaving HDSP', async () => {
        await connectOk();
        dispatchHandyFollow(50, 0, 100, 0);
        await tick(40);
        calls = [];
        assert.equal(await stopHandy(), true);
        assert.ok(sent('/mode', 'PUT').some((call) => call.body.mode === HANDY_MODE.HAMP));
        assert.ok(sent('/hamp/stop', 'PUT').length >= 1);
    });
});
