import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHandyHsp } from './handy-hsp.js';
import { HANDY_APP_ID, HSP_PLAY_STATE } from './handy-hsp-protocol.js';
import { createScriptFeed } from '../player/script-feed.js';

const KEY = 'TestKey0001';
const SERVER_OFFSET = 123456;
const EPOCH = 1_700_000_000_000;

// A clock and timers the test moves by hand.
function createScheduler() {
    let t = 0;
    let id = 0;
    let timers = [];
    const flush = async () => {
        for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
    };
    return {
        now: () => EPOCH + t,
        perf: () => t,
        get t() { return t; },
        setTimer(fn, ms) {
            const h = { id: ++id, at: t + Math.max(0, Number(ms) || 0), fn };
            timers.push(h);
            return h.id;
        },
        clearTimer(handle) {
            timers = timers.filter((h) => h.id !== handle);
        },
        flush,
        async advance(ms) {
            const end = t + ms;
            await flush();
            for (;;) {
                timers.sort((a, b) => a.at - b.at || a.id - b.id);
                const next = timers[0];
                if (!next || next.at > end) break;
                timers.shift();
                t = next.at;
                next.fn();
                await flush();
            }
            t = end;
            await flush();
        }
    };
}

// A Handy behind a fake v3 API. `over[path]` replaces a route: it gets the
// call and returns { status, body }, 'network' for a lost answer, or
// { delay, then } to answer later.
function createFakeApi(sched, over = {}) {
    const calls = [];
    const device = { mode: 0, modeSession: 41, play: HSP_PLAY_STATE.NOT_INITIALIZED, points: 0, fw: '4.0.16', fwStatus: 0, maxPoints: 4000, position: 0.5 };
    const st = () => ({ play_state: device.play, points: device.points, max_points: device.maxPoints, current_time: 0, current_point: 0, loop: false, playback_rate: 1, first_point_time: 0, last_point_time: 0, stream_id: 1, tail_point_stream_index: 0, tail_point_stream_index_threshold: 0, pause_on_starving: false });
    const ok = (result) => ({ status: 200, body: { result } });
    const routes = {
        'GET /servertime': () => ({ status: 200, body: { server_time: sched.now() + SERVER_OFFSET } }),
        'GET /connected': () => ok({ connected: true }),
        'GET /info': () => ok({ fw_status: device.fwStatus, fw_version: device.fw, hw_model_name: 'H01', session_id: 'S' }),
        'GET /capabilities': () => ok({ slider: 1 }),
        'GET /settings/slider': () => ok({ x_limit_start: 0, x_limit_stop: 110, x_max_speed: 400 }),
        'PUT /mode2': (c) => {
            device.mode = c.body.mode;
            device.modeSession += 1;
            return ok({ mode: device.mode, mode_session_id: device.modeSession });
        },
        'PUT /hsp/setup': () => {
            device.play = HSP_PLAY_STATE.STOPPED;
            device.points = 0;
            return ok(st());
        },
        'PUT /slider/stroke': (c) => ok({ min: c.body.min, max: c.body.max }),
        'GET /slider/stroke': () => ok({ min: 0.05, max: 0.95 }),
        'GET /slider/state': () => ok({ position: device.position, position_absolute: 55, motor_temp: 30, speed_absolute: 0, dir: true, motor_position: 0 }),
        'PUT /hsp/play': (c) => {
            device.play = HSP_PLAY_STATE.PLAYING;
            device.points = c.body.add ? c.body.add.points.length : device.points;
            return ok(st());
        },
        'PUT /hsp/add': (c) => {
            device.points = (c.body.flush ? 0 : device.points) + c.body.points.length;
            return ok(st());
        },
        'PUT /hsp/stop': () => {
            device.play = HSP_PLAY_STATE.STOPPED;
            return ok(st());
        },
        'PUT /hsp/flush': () => {
            device.points = 0;
            return ok(st());
        },
        'PUT /hsp/pause': () => {
            device.play = HSP_PLAY_STATE.PAUSED;
            return ok(st());
        },
        'PUT /hsp/synctime': () => ok(st()),
        'GET /hsp/state': () => ok(st())
    };
    async function fetch(url, init = {}) {
        const u = new URL(url);
        const path = u.pathname.replace('/api/handy-rest/v3', '');
        const method = init.method || 'GET';
        const call = { path, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, keepalive: init.keepalive === true, at: sched.t };
        calls.push(call);
        const name = `${method} ${path}`;
        const route = over[name] || over[path] || routes[name];
        if (!route) return { ok: false, status: 404, json: async () => ({ message: 'no route' }) };
        let answer = route(call, device);
        if (answer && answer.delay) {
            await new Promise((r) => sched.setTimer(r, answer.delay));
            answer = typeof answer.then === 'function' ? answer.then(call, device) : answer.then;
        }
        if (answer === 'network') throw new TypeError('Failed to fetch');
        const { status, body } = answer;
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    }
    return { fetch, calls, device, routes, of: (name) => calls.filter((c) => `${c.method} ${c.path}` === name) };
}

class FakeEventSource {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        this.closed = false;
        FakeEventSource.instances.push(this);
    }
    addEventListener(name, fn) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
    }
    close() {
        this.closed = true;
        this.readyState = 2;
    }
    emit(name, data) {
        for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(data) });
    }
}

// A steady script: 10 <-> 90 every 250 ms for two minutes.
function strokeTrack() {
    const at = [];
    const pos = [];
    for (let i = 0; i <= 480; i += 1) {
        at.push(i * 250);
        pos.push(i % 2 === 0 ? 10 : 90);
    }
    return { at: Int32Array.from(at), pos: Uint8Array.from(pos) };
}

// A feed whose clock the test controls: script time = perf - origin while
// running, null otherwise; shaping is the real feed's.
function createFakeFeed(sched) {
    const real = createScriptFeed();
    real.setTrack(strokeTrack(), { inverted: false });
    const listeners = new Set();
    const f = {
        real,
        running: true,
        origin: -5000,
        gen: 1,
        errors: [],
        isActive: () => true,
        hasTime: () => f.running,
        scriptNow: (p) => (f.running ? (p ?? sched.perf()) - f.origin : null),
        generation: () => String(f.gen),
        shape: (args) => real.shape(args),
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        reportError(e) { f.errors.push(e); },
        emit(reason = 'clock') {
            for (const fn of [...listeners]) fn(reason);
        }
    };
    return f;
}

function setup(over = {}, { beatSync = true, timings = {} } = {}) {
    FakeEventSource.instances = [];
    const sched = createScheduler();
    const api = createFakeApi(sched, over);
    const feed = createFakeFeed(sched);
    const events = { pauses: [], offline: [], unconfirmed: [], confirmed: [], notices: [], logs: [] };
    const hsp = createHandyHsp({
        fetch: api.fetch,
        EventSource: FakeEventSource,
        now: sched.now,
        perfNow: sched.perf,
        setTimer: (fn, ms) => sched.setTimer(fn, ms),
        clearTimer: (h) => sched.clearTimer(h),
        random: () => 0.25,
        feed,
        getKey: () => KEY,
        handlers: {
            onPause: (reason, cause) => events.pauses.push({ reason, cause }),
            onOffline: (reason) => events.offline.push(reason),
            onStopUnconfirmed: (message, key, info) => events.unconfirmed.push({ message, key, info }),
            onStopConfirmed: (key) => events.confirmed.push(key),
            onNotice: (m) => events.notices.push(m),
            onLog: (type) => events.logs.push(type)
        },
        timings
    });
    hsp.setBeatSync(beatSync);
    return { sched, api, feed, hsp, events, sse: () => FakeEventSource.instances[FakeEventSource.instances.length - 1] };
}

async function playing(over = {}, opts = {}) {
    const h = setup(over, opts);
    const ready = await h.hsp.prepare({ envMin: 0, envMax: 100, endMargin: 5 });
    assert.equal(ready.ok, true, ready.reason);
    h.hsp.dispatch({ allowance: 100, cap: 100 });
    await h.sched.advance(0);
    assert.equal(h.hsp.isPlaying(), true);
    return h;
}

describe('connect and verify', () => {
    it('checks the link, the firmware, the slider and syncs the clock, with the Application ID on every device call', async () => {
        const { hsp, api } = setup();
        const v = await hsp.verify();
        assert.equal(v.ok, true, v.reason);
        assert.equal(v.fw, '4.0.16');
        assert.equal(v.travelMm, 110);
        assert.equal(v.maxSpeedMmS, 400);
        assert.equal(api.of('GET /servertime').length, 30);
        for (const c of api.calls) {
            if (c.path === '/servertime') {
                assert.deepEqual(c.headers, {}, 'the server time needs no key');
            } else {
                assert.equal(c.headers['X-Api-Key'], HANDY_APP_ID);
                assert.equal(c.headers['X-Connection-Key'], KEY);
            }
        }
        assert.deepEqual(api.calls.filter((c) => c.path !== '/servertime').map((c) => c.path), ['/connected', '/info', '/capabilities', '/settings/slider']);
    });

    it('says firmware 3 gets rhythm mode, and why', async () => {
        const { hsp, api } = setup();
        api.device.fw = '3.2.3';
        const v = await hsp.verify();
        assert.equal(v.ok, false);
        assert.equal(v.code, 'firmware');
        assert.match(v.reason, /^firmware 3\.2\.3: update The Handy to firmware 4 at handyverse\.com/);
    });

    it('remembers that beat sync is not possible on a firmware 3 Handy, for that key only, until a check passes', async () => {
        let key = KEY;
        const h = setup();
        const hsp = createHandyHsp({ fetch: h.api.fetch, EventSource: FakeEventSource, now: h.sched.now, perfNow: h.sched.perf, setTimer: (fn, ms) => h.sched.setTimer(fn, ms), clearTimer: (x) => h.sched.clearTimer(x), feed: h.feed, getKey: () => key });
        hsp.setBeatSync(true);
        assert.equal(hsp.unavailable(), null);
        h.api.device.fw = '3.2.3';
        await hsp.verify();
        assert.equal(hsp.unavailable().code, 'firmware');
        assert.match(hsp.unavailable().reason, /^firmware 3\.2\.3: update The Handy to firmware 4/);
        key = 'OtherKey02';
        assert.equal(hsp.unavailable(), null, 'another Handy is checked afresh');
        key = KEY;
        h.api.device.fw = '4.0.16';
        assert.equal((await hsp.verify()).ok, true);
        assert.equal(hsp.unavailable(), null);
    });

    it('does not take a failed link for beat sync being impossible', async () => {
        const { hsp } = setup({ 'GET /connected': () => 'network' });
        assert.equal((await hsp.verify()).code, 'network');
        assert.equal(hsp.unavailable(), null);
    });

    it('names a refused Application ID and an offline device', async () => {
        const refused = setup({ 'GET /connected': () => ({ status: 401, body: { error: { name: '', message: 'Unauthenticated' } } }) });
        assert.equal((await refused.hsp.verify()).code, 'auth');
        const off = setup({ 'GET /connected': () => ({ status: 200, body: { result: { connected: false } } }) });
        assert.equal((await off.hsp.verify()).code, 'offline');
    });
});

describe('setup', () => {
    it('refuses without the wearer\'s consent, and sends nothing', async () => {
        const { hsp, api } = setup({}, { beatSync: false });
        const r = await hsp.prepare({});
        assert.equal(r.ok, false);
        assert.equal(r.code, 'consent');
        assert.equal(api.calls.length, 0);
    });

    it('puts the device in HSP mode, sets up a session, sets the stroke window and opens the event stream', async () => {
        const { hsp, api, sse } = setup();
        const r = await hsp.prepare({ envMin: 0, envMax: 100, endMargin: 5 });
        assert.equal(r.ok, true);
        assert.deepEqual(api.of('PUT /mode2')[0].body, { mode: 4 });
        assert.ok(api.of('PUT /hsp/setup')[0].body.stream_id >= 1);
        assert.deepEqual(api.of('PUT /slider/stroke')[0].body, { min: 0.05, max: 0.95 });
        const url = new URL(sse().url);
        assert.equal(url.searchParams.get('apikey'), HANDY_APP_ID);
        assert.equal(url.searchParams.get('ck'), KEY);
        assert.match(url.searchParams.get('events'), /mode_changed/);
        assert.equal(hsp.owns(KEY), true);
        assert.equal(hsp.mayBeMoving(), false, 'nothing moves before the first dispatch');
        assert.equal(api.of('PUT /hsp/play').length, 0);
    });

    it('refuses a buffer under 50 points', async () => {
        const { hsp, api } = setup();
        api.device.maxPoints = 30;
        const r = await hsp.prepare({});
        assert.equal(r.code, 'buffer');
        assert.equal(hsp.owns(KEY), false);
    });
});

describe('the play and the rolling window', () => {
    it('starts with one play that carries a flushed add, on the synced clock', async () => {
        const { api, sched, feed } = await playing();
        const [play] = api.of('PUT /hsp/play');
        assert.ok(play, 'a play went out');
        assert.equal(play.body.add.flush, true);
        assert.equal(play.body.pause_on_starving, false);
        assert.equal(play.body.playback_rate, 1);
        assert.equal(play.body.loop, false);
        assert.equal(play.body.start_time, Math.round(feed.scriptNow(sched.perf())));
        assert.ok(Math.abs(play.body.server_time - (sched.now() + SERVER_OFFSET)) <= 1);
        assert.ok(play.body.add.points.length > 0 && play.body.add.points.length <= 100);
        for (const p of play.body.add.points) {
            assert.ok(Number.isInteger(p.x) && p.x >= 0 && p.x <= 100);
            assert.ok(Number.isInteger(p.t) && p.t >= 0);
        }
        // The rejoin starts from where the slider was read to be.
        assert.ok(api.of('GET /slider/state').length === 1);
    });

    it('refills before the buffer runs low, every add flushed, re-sending the old plan up to the splice exactly', async () => {
        const { api, sched } = await playing();
        await sched.advance(8000);
        const sends = api.calls.filter((c) => c.path === '/hsp/play' || c.path === '/hsp/add');
        assert.ok(sends.length >= 4, `${sends.length} sends`);
        for (const s of sends.slice(1)) assert.equal(s.body.flush, true);
        // Tail indexes only grow.
        const tails = sends.map((s) => (s.body.add || s.body).tail_point_stream_index);
        for (let i = 1; i < tails.length; i += 1) assert.ok(tails[i] > tails[i - 1]);
        // Every point of a send that lies before its splice is a point of
        // the send before it, or lies on that plan's line (the splice point).
        for (let i = 1; i < sends.length; i += 1) {
            const prev = (sends[i - 1].body.add || sends[i - 1].body).points;
            const cur = sends[i].body.points;
            const spliceAt = sends[i].at + 5000 + 250; // script time + the smallest lead
            const before = cur.filter((p) => p.t < spliceAt);
            const shared = before.filter((p) => prev.some((q) => q.t === p.t));
            for (const p of shared) assert.deepEqual(p, prev.find((q) => q.t === p.t), 'a re-sent point changed');
            assert.ok(shared.length >= before.length - 1, 'at most the splice point is new before the splice');
        }
        // Never more than 4.2 s ahead of the script's present.
        for (const s of sends) {
            const pts = (s.body.add || s.body).points;
            assert.ok(pts[pts.length - 1].t <= s.at + 5000 + 4000 + 1);
        }
    });

    it('skips at an edge with a hold, urgently, and sends no stop', async () => {
        const { api, sched, hsp } = await playing();
        await sched.advance(1500);
        const before = api.calls.length;
        hsp.dispatch({ allowance: 0, cap: 100 });
        await sched.advance(0);
        const hold = api.calls.slice(before).find((c) => c.path === '/hsp/add');
        assert.ok(hold, 'the skip went out at once');
        const spliceAt = hold.at + 5000 + 250;
        const after = hold.body.points.filter((p) => p.t > spliceAt);
        assert.ok(after.length >= 2);
        assert.equal(new Set(after.map((p) => p.x)).size, 1, 'one position held');
        for (let i = 1; i < after.length; i += 1) assert.ok(after[i].t - after[i - 1].t <= 1000);
        assert.equal(api.of('PUT /hsp/stop').length, 0);
        await sched.advance(3000);
        assert.equal(api.of('PUT /hsp/stop').length, 0, 'a confirmed hold is no stop');
        assert.equal(hsp.status().holding, true);
        // Back from the edge: the rejoin goes out at once too.
        const n = api.of('PUT /hsp/add').length;
        hsp.dispatch({ allowance: 40, cap: 100 });
        await sched.advance(0);
        assert.equal(api.of('PUT /hsp/add').length, n + 1);
        assert.equal(hsp.status().holding, false);
    });

    it('turns a hold nobody confirms within a second into a stop', async () => {
        let holdNow = false;
        const { api, sched, hsp } = await playing({
            'PUT /hsp/add': (c, d) => (holdNow ? { delay: 5000, then: { status: 200, body: { result: { play_state: 1, points: 3 } } } } : { status: 200, body: { result: { play_state: d.play, points: c.body.points.length } } })
        });
        await sched.advance(500);
        holdNow = true;
        hsp.dispatch({ allowance: 0 });
        await sched.advance(900);
        assert.equal(api.of('PUT /hsp/stop').length, 0);
        await sched.advance(200);
        assert.equal(api.of('PUT /hsp/stop').length, 1, 'escalated after 1 s');
        assert.equal(hsp.isPlaying(), false);
    });

    for (const slow of [4000, 6000]) {
        it(`skips at once while a refill is still on its way (adds answered after ${slow / 1000} s), and stops within a second when the hold is not confirmed`, async () => {
            let slowOn = false;
            const { api, sched, hsp } = await playing({
                'PUT /hsp/add': (c, d) => {
                    const answer = () => {
                        d.points = (c.body.flush ? 0 : d.points) + c.body.points.length;
                        return { status: 200, body: { result: { play_state: d.play, points: d.points, max_points: 4000 } } };
                    };
                    return slowOn ? { delay: slow, then: answer } : answer();
                }
            });
            slowOn = true;
            let refill = null;
            for (let i = 0; i < 40 && !refill; i += 1) {
                await sched.advance(100);
                refill = api.of('PUT /hsp/add')[0];
            }
            assert.ok(refill, 'a refill is on its way');
            await sched.advance(100);
            const edge = sched.t;
            hsp.dispatch({ allowance: 0, cap: 100 });
            await sched.advance(0);
            const hold = api.of('PUT /hsp/add').find((c) => c.at >= edge);
            assert.ok(hold, 'the hold did not wait for the refill');
            assert.equal(hold.at, edge);
            const held = hold.body.points.filter((p) => p.t > edge + 5000 + 1000);
            assert.ok(held.length >= 2);
            assert.equal(new Set(held.map((p) => p.x)).size, 1, 'one position held');
            assert.ok(hold.body.tail_point_stream_index > refill.body.tail_point_stream_index, 'tail indexes still only grow');
            await sched.advance(900);
            assert.equal(api.of('PUT /hsp/stop').length, 0);
            await sched.advance(200);
            const [stop] = api.of('PUT /hsp/stop');
            assert.ok(stop, 'the hold nobody confirmed became a stop');
            assert.ok(stop.at - edge <= 1000, `stop ${stop.at - edge} ms after the edge`);
            assert.equal(hsp.isPlaying(), false);
            // The slow answers that come back later set nothing going again.
            await sched.advance(slow + 1000);
            assert.equal(api.calls.filter((c) => (c.path === '/hsp/add' || c.path === '/hsp/play') && c.at >= edge).length, 1);
        });
    }

    it('confirms a hold sent past an older refill only with a hold sent after that refill was answered', async () => {
        let slowOn = false;
        const { api, sched, hsp } = await playing({
            'PUT /hsp/add': (c, d) => {
                const answer = () => ({ status: 200, body: { result: { play_state: d.play, points: c.body.points.length, max_points: 4000 } } });
                return slowOn ? { delay: 300, then: answer } : answer();
            }
        });
        slowOn = true;
        let refill = null;
        for (let i = 0; i < 100 && !refill; i += 1) {
            await sched.advance(50);
            refill = api.of('PUT /hsp/add')[0];
        }
        assert.ok(refill, 'a refill is on its way');
        const edge = sched.t;
        hsp.dispatch({ allowance: 0, cap: 100 });
        await sched.advance(0);
        const sinceEdge = () => api.of('PUT /hsp/add').filter((c) => c !== refill && c.at >= edge);
        assert.equal(sinceEdge().length, 1, 'the hold went out at once');
        // The refill was answered after the hold went out: it may have landed
        // after it, so the hold goes again once nothing else is on its way.
        await sched.advance(700);
        const holds = sinceEdge();
        assert.equal(holds.length, 2, 'a second hold');
        assert.ok(holds[1].at >= refill.at + 300);
        await sched.advance(3000);
        assert.equal(api.of('PUT /hsp/stop').length, 0, 'the second hold was confirmed in time');
        assert.equal(hsp.status().holding, true);
    });

    it('stops at an edge that comes while a new play is still being prepared', async () => {
        let slowState = false;
        const { api, sched, hsp, sse } = await playing({
            'GET /slider/state': () => (slowState ? { delay: 4000, then: { status: 200, body: { result: { position: 0.5 } } } } : { status: 200, body: { result: { position: 0.5 } } })
        });
        await sched.advance(500);
        slowState = true;
        // The device starves once: a new play is prepared from where the
        // slider is, which takes 4 s to read on this link.
        sse().emit('hsp_starving', { connection_key: KEY, data: { play_state: 4 } });
        await sched.advance(100);
        assert.equal(hsp.isPlaying(), false);
        const edge = sched.t;
        hsp.dispatch({ allowance: 0, cap: 100 });
        await sched.advance(0);
        const stop = api.of('PUT /hsp/stop').find((c) => c.at >= edge);
        assert.ok(stop && stop.at === edge, 'a stop at once, with no plan to hold');
        await sched.advance(5000);
        assert.equal(api.of('PUT /hsp/play').length, 1, 'the play being prepared was dropped');
    });

    it('does not trade a hold still waiting for its answer for a new play: it stops', async () => {
        let holdNow = false;
        const { api, sched, hsp, sse } = await playing({
            'PUT /hsp/add': (c, d) => (holdNow ? { delay: 5000, then: { status: 200, body: { result: { play_state: 1, points: 3 } } } } : { status: 200, body: { result: { play_state: d.play, points: c.body.points.length } } })
        });
        await sched.advance(500);
        holdNow = true;
        hsp.dispatch({ allowance: 0 });
        await sched.advance(300);
        const edgeAt = sched.t;
        sse().emit('hsp_starving', { connection_key: KEY, data: { play_state: 4 } });
        await sched.advance(0);
        assert.equal(api.of('PUT /hsp/play').length, 1, 'no new play');
        assert.ok(api.of('PUT /hsp/stop').some((c) => c.at === edgeAt), 'a stop at once');
    });

    it('never puts a far join point in the buffer: every send ends inside the window, and refills carry the way there', async () => {
        // The device's clock agrees with the script's, so nothing re-anchors.
        const h = setup({ 'GET /hsp/state': (c, d) => ({ status: 200, body: { result: { play_state: d.play, points: 3, max_points: 4000, current_time: c.at + 5000 } } }) });
        h.feed.real.setSettings({ scriptMaxSpeed: 50 });
        h.api.device.position = 0;
        await h.hsp.prepare({ envMin: 0, envMax: 100, endMargin: 5 });
        h.hsp.dispatch({ allowance: 100, cap: 5 });
        await h.sched.advance(0);
        await h.sched.advance(30000);
        const sends = h.api.calls.filter((c) => c.path === '/hsp/play' || c.path === '/hsp/add');
        assert.ok(sends.length >= 10, `${sends.length} sends`);
        let lastX = -1;
        for (const s of sends) {
            const pts = (s.body.add || s.body).points;
            const end = pts[pts.length - 1];
            assert.ok(end.t <= s.at + 5000 + 4000, `a point ${end.t - s.at - 5000} ms ahead`);
            for (let i = 1; i < pts.length; i += 1) {
                const v = (Math.abs(pts[i].x - pts[i - 1].x) / (pts[i].t - pts[i - 1].t)) * 1000;
                assert.ok(v <= 50 * 0.05 + 1e-9, `${v} %/s`);
            }
            assert.ok(end.x >= lastX, 'still on the way to the join');
            lastX = end.x;
        }
        assert.ok(lastX >= 5, `got to ${lastX} after 30 s`);
    });

    it('plans from script time 0 when a negative offset puts the present before it: the way from the slider stays in the buffer, under the limit', async () => {
        // Script time = media time + offset (down to -2000 ms), so the first
        // seconds of a video can be at a negative script time; HSP point
        // times start at 0. The slider is at the top of the window.
        const speeds = (pts) => pts.slice(1).map((p, i) => (Math.abs(p.x - pts[i].x) * 0.9 * 1000) / (p.t - pts[i].t));
        for (const { scriptNow, maxSpeed, cap } of [
            { scriptNow: -1900, maxSpeed: 100, cap: 10 },
            { scriptNow: -1000, maxSpeed: 300, cap: 100 }
        ]) {
            const label = `script time ${scriptNow}, Max ${maxSpeed}, cap ${cap}`;
            const limit = (maxSpeed * cap) / 100;
            const h = setup();
            h.feed.real.setSettings({ scriptMaxSpeed: maxSpeed });
            h.api.device.position = 0.97;
            h.feed.origin = h.sched.t - scriptNow;
            await h.hsp.prepare({ envMin: 0, envMax: 100, endMargin: 5 });
            h.hsp.dispatch({ allowance: 100, cap });
            await h.sched.advance(0);
            const [play] = h.api.of('PUT /hsp/play');
            assert.equal(play.body.start_time, scriptNow, label);
            const pts = play.body.add.points;
            // The buffer starts where the slider is: nothing left to the firmware.
            assert.deepEqual(pts[0], { t: 0, x: 100 }, label);
            // The way to the script at the join speed (half the limit), the rest under the limit.
            assert.ok(speeds(pts)[0] <= limit / 2 + 1e-9, `${label}: join leg ${speeds(pts)[0]} %/s`);
            for (const v of speeds(pts)) assert.ok(v <= limit + 1e-9, `${label}: ${v} %/s`);
            // A replan still before 0 splices at 0, from where the plan is then.
            await h.sched.advance(50);
            const n = h.api.of('PUT /hsp/add').length;
            h.hsp.dispatch({ allowance: 60, cap });
            await h.sched.advance(10);
            const add = h.api.of('PUT /hsp/add')[n];
            assert.ok(add, `${label}: a replan`);
            assert.deepEqual(add.body.points[0], { t: 0, x: 100 }, label);
            for (const v of speeds(add.body.points)) assert.ok(v <= limit + 1e-9, `${label}: replan ${v} %/s`);
            await h.hsp.release();
        }
    });

    it('waits for the cadence with a small change, and plans it in 5-point steps', async () => {
        const { api, sched, hsp } = await playing();
        await sched.advance(300);
        const n = api.of('PUT /hsp/add').length;
        hsp.dispatch({ allowance: 93 });
        hsp.dispatch({ allowance: 92 });
        await sched.advance(0);
        assert.equal(api.of('PUT /hsp/add').length, n, 'not urgent');
        await sched.advance(1300);
        assert.ok(api.of('PUT /hsp/add').length > n);
    });

    it('pauses the device on a seek and starts a new play when the clock is back', async () => {
        const { api, sched, feed } = await playing();
        await sched.advance(500);
        feed.running = false;
        feed.emit('clock');
        await sched.advance(0);
        assert.equal(api.of('PUT /hsp/pause').length, 1);
        feed.running = true;
        feed.origin = sched.perf() - 60000;
        feed.gen += 1;
        feed.emit('clock');
        await sched.advance(0);
        const plays = api.of('PUT /hsp/play');
        assert.equal(plays.length, 2);
        assert.ok(Math.abs(plays[1].body.start_time - 60000) <= 1);
    });

    it('re-anchors once when the device starves, and pauses the session the second time in a minute', async () => {
        const { api, sched, sse, events } = await playing();
        await sched.advance(500);
        sse().emit('hsp_starving', { connection_key: KEY, data: { play_state: 4 } });
        await sched.advance(0);
        assert.equal(api.of('PUT /hsp/play').length, 2);
        assert.equal(events.pauses.length, 0);
        await sched.advance(5000);
        sse().emit('hsp_starving', { connection_key: KEY, data: { play_state: 4 } });
        await sched.advance(0);
        assert.equal(events.pauses.length, 1);
        assert.match(events.pauses[0].reason, /ran out of script points twice/);
        assert.ok(api.of('PUT /hsp/stop').length >= 1);
    });

    it('stops again when a play lands after a stop', async () => {
        const h = setup({ 'PUT /hsp/play': () => ({ delay: 800, then: { status: 200, body: { result: { play_state: 1, points: 5 } } } }) });
        await h.hsp.prepare({});
        h.hsp.dispatch({ allowance: 100 });
        await h.sched.advance(100);
        h.hsp.stop();
        await h.sched.advance(100);
        const first = h.api.of('PUT /hsp/stop').length;
        assert.ok(first >= 1);
        await h.sched.advance(1000);
        assert.ok(h.api.of('PUT /hsp/stop').length > first, 'the late play was stopped again');
    });
});

describe('the stroke window during a session', () => {
    it('sends a narrowed envelope at once and re-anchors the play on it', async () => {
        const { api, sched, hsp } = await playing();
        await sched.advance(1000);
        const plays = api.of('PUT /hsp/play').length;
        const done = hsp.setWindow({ envMin: 0, envMax: 50, endMargin: 5 });
        await sched.advance(0);
        assert.equal(await done, true);
        const strokes = api.of('PUT /slider/stroke');
        assert.deepEqual(strokes[strokes.length - 1].body, { min: 0.05, max: 0.5 });
        assert.equal(api.of('PUT /hsp/play').length, plays + 1, 'the play is re-anchored on the new window');
        assert.equal(hsp.isPlaying(), true);
    });

    it('sends a raised end margin, and nothing when the window is the same', async () => {
        const { api, sched, hsp } = await playing();
        const n = api.of('PUT /slider/stroke').length;
        await hsp.setWindow({ envMin: 0, envMax: 100, endMargin: 5 });
        assert.equal(api.of('PUT /slider/stroke').length, n, 'the same window is not sent again');
        await hsp.setWindow({ envMin: 0, envMax: 100, endMargin: 10 });
        await sched.advance(0);
        assert.equal(api.of('PUT /slider/stroke').length, n + 1);
        assert.deepEqual(api.of('PUT /slider/stroke')[n].body, { min: 0.1, max: 0.9 });
    });

    it('sends one window at a time, the latest last', async () => {
        let slow = false;
        const { api, sched, hsp } = await playing({
            'PUT /slider/stroke': (c) => {
                const answer = { status: 200, body: { result: { min: c.body.min, max: c.body.max } } };
                return slow ? { delay: 300, then: answer } : answer;
            }
        });
        slow = true;
        const n = api.of('PUT /slider/stroke').length;
        hsp.setWindow({ envMin: 0, envMax: 80, endMargin: 5 });
        hsp.setWindow({ envMin: 0, envMax: 70, endMargin: 5 });
        hsp.setWindow({ envMin: 0, envMax: 60, endMargin: 5 });
        await sched.advance(1000);
        const sent = api.of('PUT /slider/stroke').slice(n).map((c) => c.body.max);
        assert.deepEqual(sent, [0.8, 0.6]);
    });

    it('pauses and stops when the device does not take a narrower window', async () => {
        let refuse = false;
        const { api, sched, hsp, events } = await playing({ 'PUT /slider/stroke': (c) => (refuse ? { status: 502, body: null } : { status: 200, body: { result: { min: c.body.min, max: c.body.max } } }) });
        refuse = true;
        await hsp.setWindow({ envMin: 0, envMax: 50, endMargin: 5 });
        await sched.advance(0);
        assert.equal(events.pauses.length, 1);
        assert.match(events.pauses[0].reason, /did not take the new travel envelope/);
        assert.ok(api.of('PUT /hsp/stop').length >= 1);
        assert.equal(hsp.isPlaying(), false);
    });

    it('keeps playing inside the narrower window it has when a wider one is refused, and does not ask again until the envelope changes', async () => {
        let refuse = false;
        const { api, sched, hsp, events } = await playing({ 'PUT /slider/stroke': (c) => (refuse ? { status: 502, body: null } : { status: 200, body: { result: { min: c.body.min, max: c.body.max } } }) });
        await hsp.setWindow({ envMin: 0, envMax: 50, endMargin: 5 });
        await sched.advance(0);
        refuse = true;
        const n = api.of('PUT /slider/stroke').length;
        assert.equal(await hsp.setWindow({ envMin: 0, envMax: 100, endMargin: 5 }), false);
        await hsp.setWindow({ envMin: 0, envMax: 100, endMargin: 5 });
        await sched.advance(0);
        assert.equal(api.of('PUT /slider/stroke').length, n + 1);
        assert.equal(events.pauses.length, 0);
        assert.equal(hsp.isPlaying(), true);
    });
});

describe('stops', () => {
    it('retries a stop and is satisfied by a confirmed one', async () => {
        let n = 0;
        const { api, sched, hsp, events } = await playing({
            'PUT /hsp/stop': (c, d) => {
                n += 1;
                if (n < 3) return 'network';
                d.play = HSP_PLAY_STATE.STOPPED;
                return { status: 200, body: { result: { play_state: 2, points: 0 } } };
            }
        });
        const done = hsp.dispatch({ allowance: 0, force: true });
        await sched.advance(2000);
        assert.equal(await done, true);
        const stops = api.of('PUT /hsp/stop');
        assert.equal(stops.length, 3);
        assert.deepEqual(stops.map((s) => s.at - stops[0].at), [0, 250, 750]);
        assert.equal(api.of('PUT /hsp/flush').length, 0);
        assert.equal(events.unconfirmed.length, 0);
        assert.equal(hsp.mayBeMoving(), false);
    });

    it('falls back to a flush, and reports the stop owed with how long the buffer lasts', async () => {
        const { api, sched, hsp, events } = await playing({
            'PUT /hsp/stop': () => 'network',
            'PUT /hsp/flush': () => ({ status: 503, body: null })
        });
        const done = hsp.stop();
        await sched.advance(3000);
        assert.equal(await done, false);
        assert.equal(api.of('PUT /hsp/stop').length >= 4, true);
        assert.equal(api.of('PUT /hsp/flush').length, 2);
        assert.equal(events.unconfirmed.length, 1);
        assert.equal(events.unconfirmed[0].key, KEY);
        assert.match(events.unconfirmed[0].message, /^Stop not confirmed: HTTP 503 \(\/hsp\/flush\)$/);
        assert.ok(events.unconfirmed[0].info.runsOutSeconds <= 4.2);
        assert.equal(hsp.mayBeMoving(), true);
        // And the stops go on in the background.
        const before = api.of('PUT /hsp/stop').length;
        await sched.advance(5000);
        assert.ok(api.of('PUT /hsp/stop').length > before);
    });

    it('takes a confirmed flush for the stop when the stop is not confirmed', async () => {
        const { api, sched, hsp, events } = await playing({ 'PUT /hsp/stop': () => 'network' });
        const done = hsp.stop();
        await sched.advance(3000);
        assert.equal(await done, true);
        assert.equal(api.of('PUT /hsp/flush').length, 1);
        assert.equal(events.unconfirmed.length, 0);
    });

    it('settles an owed stop when a background stop is confirmed, and says so', async () => {
        let fail = true;
        const { sched, hsp, events } = await playing({
            'PUT /hsp/stop': () => (fail ? 'network' : { status: 200, body: { result: { play_state: 2, points: 0 } } }),
            'PUT /hsp/flush': () => 'network'
        });
        hsp.stop();
        await sched.advance(3000);
        assert.equal(events.unconfirmed.length, 1);
        fail = false;
        await sched.advance(5000);
        assert.deepEqual(events.confirmed, [KEY]);
        assert.equal(hsp.mayBeMoving(), false);
    });

    it('a forced stop while an older, slow stop is out ends a play anchored after it, and is not taken in by the old answer', async () => {
        // A slow cloud: the edge's hold is not answered within 1 s and
        // escalates to a stop whose answer is slow too. The edge releases
        // meanwhile and a new play goes out; then the wearer presses PAUSE.
        const flags = { slowAdd: false, slowStop: false };
        const st = (play, device) => ({ play_state: play, points: device.points, max_points: 4000, current_time: 0 });
        const { api, sched, hsp, events } = await playing({
            'PUT /hsp/add': (c, d) => {
                d.points = (c.body.flush ? 0 : d.points) + c.body.points.length;
                const answer = { status: 200, body: { result: st(d.play, d) } };
                return flags.slowAdd ? { delay: 1500, then: answer } : answer;
            },
            'PUT /hsp/stop': (c, d) => {
                // The server acts when the request arrives.
                d.play = HSP_PLAY_STATE.STOPPED;
                const answer = { status: 200, body: { result: st(HSP_PLAY_STATE.STOPPED, d) } };
                return flags.slowStop ? { delay: 3000, then: answer } : answer;
            }
        });
        await sched.advance(500);
        flags.slowAdd = true;
        flags.slowStop = true;
        hsp.dispatch({ allowance: 0 });
        await sched.advance(1100);
        assert.equal(api.of('PUT /hsp/stop').length, 1, 'the hold escalated to a stop');
        flags.slowAdd = false;
        hsp.dispatch({ allowance: 60 });
        await sched.advance(600);
        hsp.dispatch({ allowance: 65 });
        await sched.advance(300);
        assert.equal(api.of('PUT /hsp/play').length, 2, 'the release anchored a new play');
        assert.equal(api.device.play, HSP_PLAY_STATE.PLAYING);
        assert.equal(hsp.isPlaying(), true);
        const stops = api.of('PUT /hsp/stop').length;
        const pausedAt = sched.t;
        const done = hsp.dispatch({ allowance: 0, force: true });
        await sched.advance(0);
        assert.equal(hsp.isPlaying(), false, 'the play ends with the PAUSE');
        assert.equal(api.of('PUT /hsp/stop').length, stops + 1, 'a stop of its own goes out at once');
        await sched.advance(8000);
        assert.equal(await done, true);
        assert.equal(api.calls.filter((c) => c.at > pausedAt && (c.path === '/hsp/add' || c.path === '/hsp/play')).length, 0, 'nothing refills after the PAUSE');
        assert.equal(api.device.play, HSP_PLAY_STATE.STOPPED);
        assert.equal(hsp.status().motion, 'stopped');
        assert.equal(events.unconfirmed.length, 0);
    });

    it('an old stop\'s confirmation does not say the device is still when a play went out after that stop began', async () => {
        let slow = false;
        const { api, sched, hsp } = await playing({
            'PUT /hsp/stop': (c, d) => {
                const answer = { status: 200, body: { result: { play_state: HSP_PLAY_STATE.STOPPED, points: 0 } } };
                if (!slow) {
                    d.play = HSP_PLAY_STATE.STOPPED;
                    return answer;
                }
                // Received before the play below; answered after it.
                d.play = HSP_PLAY_STATE.STOPPED;
                return { delay: 3000, then: answer };
            }
        });
        await sched.advance(500);
        slow = true;
        hsp.stop({ reason: 'hold' });
        await sched.advance(100);
        hsp.dispatch({ allowance: 80 });
        await sched.advance(100);
        assert.equal(api.device.play, HSP_PLAY_STATE.PLAYING);
        await sched.advance(3000);
        assert.notEqual(hsp.status().motion, 'stopped', 'the play after the stop is still going');
        slow = false;
        const stops = api.of('PUT /hsp/stop').length;
        assert.equal(await hsp.dispatch({ allowance: 0, force: true }), true);
        assert.equal(api.of('PUT /hsp/stop').length, stops + 1, 'STOP sends a stop');
        assert.equal(api.device.play, HSP_PLAY_STATE.STOPPED);
    });

    it('sends a keepalive stop with both headers when the page goes away', async () => {
        const { api, hsp } = await playing();
        assert.equal(hsp.stopOnUnload(), true);
        const last = api.calls[api.calls.length - 1];
        assert.equal(last.path, '/hsp/stop');
        assert.equal(last.method, 'PUT');
        assert.equal(last.keepalive, true);
        assert.equal(last.headers['X-Api-Key'], HANDY_APP_ID);
        assert.equal(last.headers['X-Connection-Key'], KEY);
        assert.equal(hsp.isPlaying(), false);
        assert.equal(hsp.mayBeMoving(), true, 'nobody reads a keepalive answer');
    });

    it('sends nothing on the way out when nothing was set going', async () => {
        const { hsp, api } = setup();
        await hsp.prepare({});
        const n = api.calls.length;
        assert.equal(hsp.stopOnUnload(), false);
        assert.equal(api.calls.length, n);
    });

    it('releases: a confirmed stop, then HAMP mode again for the v2 driver, and the stream closed', async () => {
        const { api, sched, hsp, sse } = await playing();
        const source = sse();
        const done = hsp.release();
        await sched.advance(100);
        assert.equal(await done, true);
        const stopAt = api.calls.findIndex((c) => c.path === '/hsp/stop');
        const modes = api.calls.map((c, i) => [c, i]).filter(([c]) => c.path === '/mode2');
        assert.deepEqual(modes[modes.length - 1][0].body, { mode: 0 });
        assert.ok(modes[modes.length - 1][1] > stopAt, 'the mode changes only after the stop');
        assert.equal(source.closed, true);
        assert.equal(hsp.owns(KEY), false);
    });
});

describe('events and the link', () => {
    it('pauses when another app takes the device, and sends it no stop', async () => {
        const { sched, sse, events, api, hsp } = await playing();
        sse().emit('mode_changed', { connection_key: KEY, data: { mode: 0, mode_session_id: 99 } });
        await sched.advance(0);
        assert.equal(events.pauses.length, 1);
        assert.match(events.pauses[0].reason, /Another app took control of The Handy/);
        assert.equal(api.of('PUT /hsp/stop').length, 0);
        assert.equal(hsp.owns(KEY), false);
    });

    it('ignores the mode change it made itself', async () => {
        const h = setup({
            'PUT /mode2': (c, d) => {
                // The event arrives while the request is still out.
                const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
                if (source) source.emit('mode_changed', { connection_key: KEY, data: { mode: c.body.mode, mode_session_id: 77 } });
                d.mode = c.body.mode;
                return { status: 200, body: { result: { mode: d.mode, mode_session_id: 77 } } };
            }
        });
        await h.hsp.prepare({});
        h.hsp.dispatch({ allowance: 100 });
        await h.sched.advance(0);
        await h.hsp.release();
        assert.equal(h.events.pauses.length, 0);
    });

    it('pauses and stops on the device button, a blocked slider or heat', async () => {
        for (const [type, re] of [['button_event', /button was pressed/], ['slider_blocked', /slider blocked/], ['temp_high', /running hot/]]) {
            const { sched, sse, events, api } = await playing();
            sse().emit(type, { connection_key: KEY, data: { button: 0, event: 2 } });
            await sched.advance(0);
            assert.equal(events.pauses.length, 1, type);
            assert.match(events.pauses[0].reason, re);
            assert.equal(api.of('PUT /hsp/stop').length, 1, type);
        }
    });

    it('ignores events about another key', async () => {
        const { sched, sse, events } = await playing();
        sse().emit('button_event', { connection_key: 'Other', data: { button: 0, event: 2 } });
        await sched.advance(0);
        assert.equal(events.pauses.length, 0);
    });

    it('goes offline on a disconnect event, and keeps sending stops to a device that may be playing', async () => {
        const { sched, sse, events, api, hsp } = await playing();
        sse().emit('device_disconnected', { connection_key: KEY, data: { reason: 'io error' } });
        await sched.advance(0);
        assert.equal(events.offline.length, 1);
        assert.equal(hsp.owns(KEY), false);
        await sched.advance(5000);
        assert.ok(api.of('PUT /hsp/stop').length >= 1);
    });

    it('goes offline after three failed requests in a row', async () => {
        const { sched, events } = await playing({ 'PUT /hsp/add': () => 'network', 'PUT /hsp/synctime': () => 'network' });
        await sched.advance(10000);
        assert.equal(events.offline.length, 1);
        assert.match(events.offline[0], /stopped responding \(3 failed requests\)/);
    });

    it('sends the stroke window again when the device widened it, and keeps a narrower one', async () => {
        const wide = await playing({ 'GET /slider/stroke': () => ({ status: 200, body: { result: { min: 0, max: 1 } } }) });
        const n = wide.api.of('PUT /slider/stroke').length;
        wide.sse().emit('stroke_changed', { connection_key: KEY, data: { min: 0, max: 1 } });
        await wide.sched.advance(0);
        assert.equal(wide.api.of('PUT /slider/stroke').length, n + 1);
        const narrow = await playing({ 'GET /slider/stroke': () => ({ status: 200, body: { result: { min: 0.3, max: 0.7 } } }) });
        const m = narrow.api.of('PUT /slider/stroke').length;
        narrow.sse().emit('stroke_changed', { connection_key: KEY, data: { min: 0.3, max: 0.7 } });
        await narrow.sched.advance(0);
        assert.equal(narrow.api.of('PUT /slider/stroke').length, m);
    });

    it('polls the state while the event stream is down', async () => {
        const { sched, sse, api } = await playing();
        const source = sse();
        source.readyState = 0;
        source.onerror();
        const n = api.of('GET /hsp/state').length;
        await sched.advance(5100);
        assert.ok(api.of('GET /hsp/state').length > n);
    });

    it('keeps its routine traffic inside the budget over a minute of play', async () => {
        const { sched, hsp } = await playing();
        await sched.advance(60000);
        assert.ok(hsp.status().budgetUsed <= 150, `${hsp.status().budgetUsed} requests`);
        assert.ok(hsp.status().budgetUsed >= 30, `${hsp.status().budgetUsed} requests`);
    });
});
