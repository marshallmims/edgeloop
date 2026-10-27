import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createScriptPlanner,
    liveFeed,
    SCRIPT_MIN_LEG_MS,
    SCRIPT_WINDOW_MS,
    IDLE_LEG_MAX_MS
} from './script-planner.js';
import { createStrokePlanner, REST_MOVE_MS } from './stroke-planner.js';
import { createScriptFeed } from '../player/script-feed.js';
import { createMediaClock } from '../player/media-clock.js';
import { PLANNER_MIN_SEGMENT_MS, DEVICE_CEILINGS } from '../player/script-shaper.js';

function trackOf(actions) {
    return {
        at: Int32Array.from(actions.map(([t]) => t)),
        pos: Uint8Array.from(actions.map(([, p]) => p))
    };
}

// A stroke every 500 ms between 10 and 90 from 1 s to 60 s.
function strokes({ from = 1000, to = 60000, every = 500, lo = 10, hi = 90 } = {}) {
    const actions = [];
    let up = false;
    for (let t = from; t <= to; t += every) {
        actions.push([t, up ? hi : lo]);
        up = !up;
    }
    return trackOf(actions);
}

// A feed on a clock the test moves: the media time is `clock.t` ms, playing.
function rig(track = strokes(), { settings = {}, offset = 0 } = {}) {
    const time = { t: 0 };
    const clock = createMediaClock({ maxExtrapolateMs: Infinity });
    const feed = createScriptFeed({ clock, perfNow: () => time.t });
    feed.setTrack(track, { inverted: false });
    feed.setSettings(settings);
    feed.setOffset(offset);
    feed.setVideoState('playing');
    feed.sample({ mediaMs: 0, perfMs: 0, source: 'frame' });
    feed.setActive(true);
    return { feed, time };
}

const MOVING = { speed: 100, cap: 100, zoneMin: 0, zoneMax: 1, enabled: true };

// Run a planner the way a driver's timer chain does: ask at every leg's end.
function runLegs(planner, time, untilMs) {
    const legs = [];
    while (time.t < untilMs) {
        const leg = planner.next(time.t);
        if (!leg) break;
        legs.push({ at: time.t, ...leg });
        time.t += Math.max(1, leg.durationMs);
    }
    return legs;
}

describe('script planner: constants', () => {
    it('the shortest leg is the shaper\'s planner segment, and a window is about two strokes', () => {
        assert.equal(SCRIPT_MIN_LEG_MS, PLANNER_MIN_SEGMENT_MS);
        assert.ok(SCRIPT_WINDOW_MS <= 2200, 'a leg never outlasts the stroke planner\'s slowest');
        assert.ok(IDLE_LEG_MAX_MS <= SCRIPT_WINDOW_MS);
    });
});

describe('script planner: a stop is the stroke planner\'s stop', () => {
    for (const hold of [false, true]) {
        it(`speed 0, a cap of 0 and OFF give exactly the stroke planner's ${hold ? 'hold' : 'rest move'}, then silence`, () => {
            for (const stopInput of [{ speed: 0 }, { cap: 0 }, { enabled: false }]) {
                const { feed, time } = rig();
                time.t = 2000;
                const script = createScriptPlanner({ feed, hold });
                const stroke = createStrokePlanner({ hold });
                const zone = { zoneMin: 0.2, zoneMax: 0.8 };
                script.setInput({ ...MOVING, ...zone });
                stroke.setInput({ ...MOVING, ...zone });
                const first = script.next(time.t);
                stroke.next(time.t);
                assert.equal(first.kind, 'stroke');
                assert.ok(script.isInFlight(time.t + 1) && stroke.isInFlight(time.t + 1));
                // The stop interrupts the leg in flight in both.
                time.t += 10;
                script.setInput(stopInput);
                stroke.setInput(stopInput);
                assert.equal(script.isInFlight(time.t), false, JSON.stringify(stopInput));
                // The stroke planner cuts a leg in flight only when the axis
                // is turned OFF. A speed of 0 waits for that leg. The script
                // planner cuts immediately, so a skip at the edge does not
                // finish the stroke it was on.
                if (stopInput.enabled === false) assert.equal(stroke.isInFlight(time.t), false);
                const a = script.next(time.t);
                assert.equal(a.kind, hold ? 'hold' : 'rest');
                if (!hold) assert.deepEqual(a, { position: 0.2, durationMs: REST_MOVE_MS, kind: 'rest' });
                assert.equal(script.isResting(), true);
                if (stopInput.enabled === false) {
                    const b = stroke.next(time.t);
                    assert.deepEqual(a, b, JSON.stringify(stopInput));
                    assert.equal(script.legEndsAt(), stroke.legEndsAt());
                    if (!hold) assert.equal(script.lastPosition(), stroke.lastPosition());
                }
                // Then nothing, however often it is asked.
                for (let i = 0; i < 5; i += 1) {
                    time.t += 500;
                    assert.equal(script.next(time.t), null);
                    if (stopInput.enabled === false) assert.equal(stroke.next(time.t), null);
                }
            }
        });
    }

    it('a stop before anything moved is the same first stop the stroke planner gives', () => {
        for (const hold of [false, true]) {
            const { feed } = rig();
            const script = createScriptPlanner({ feed, hold });
            const stroke = createStrokePlanner({ hold });
            script.setInput({ speed: 0, zoneMin: 0.1, zoneMax: 0.9 });
            stroke.setInput({ speed: 0, zoneMin: 0.1, zoneMax: 0.9 });
            assert.deepEqual(script.next(0), stroke.next(0));
            assert.equal(script.next(1000), null);
        }
    });

    it('custom rest length, as the T-Code driver passes it', () => {
        const { feed } = rig();
        const script = createScriptPlanner({ feed, restMs: 250 });
        script.setInput({ speed: 0, zoneMin: 0.3 });
        assert.deepEqual(script.next(0), { position: 0.3, durationMs: 250, kind: 'rest' });
    });

    it('no clock is a stop: a seek or a pause interrupts the leg in flight; Script mode switched off does not', () => {
        for (const cut of ['seeking', 'paused', 'waiting', 'ended']) {
            const { feed, time } = rig();
            time.t = 2000;
            const planner = createScriptPlanner({ feed });
            planner.setInput(MOVING);
            assert.equal(planner.next(time.t).kind, 'stroke');
            feed.setVideoState(cut);
            planner.poke();
            assert.equal(planner.isInFlight(time.t + 1), false, cut);
            assert.equal(planner.next(time.t + 1).kind, 'rest', cut);
        }
        // The same through setInput, which is what a driver calls.
        const { feed, time } = rig();
        time.t = 2000;
        const planner = createScriptPlanner({ feed });
        planner.setInput(MOVING);
        planner.next(time.t);
        feed.setVideoState('seeking');
        planner.setInput(MOVING);
        assert.equal(planner.isInFlight(time.t + 1), false);
        // Deactivation lets the leg run out (the driver swaps planners at
        // its end).
        const other = rig();
        other.time.t = 2000;
        const p2 = createScriptPlanner({ feed: other.feed });
        p2.setInput(MOVING);
        const leg = p2.next(other.time.t);
        other.feed.setActive(false);
        p2.setInput(MOVING);
        assert.equal(p2.isInFlight(other.time.t + 1), true);
        assert.equal(p2.next(other.time.t + leg.durationMs).kind, 'rest', 'and it would rest if asked again');
    });

    it('a skip at the edge (allowance 0) is the stop, and the video plays on', () => {
        const { feed, time } = rig();
        time.t = 3000;
        const planner = createScriptPlanner({ feed, hold: true });
        planner.setInput(MOVING);
        planner.next(time.t);
        planner.setInput({ speed: 0 });
        assert.equal(planner.next(time.t + 5).kind, 'hold');
        assert.equal(feed.hasTime(), true);
    });
});

describe('script planner: legs from the script', () => {
    it('each leg goes to the next script point, timed from the clock', () => {
        const { feed, time } = rig(strokes({ every: 500 }));
        time.t = 5000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.9); // where the script is at 5000 (hi)
        const legs = runLegs(planner, time, 9000);
        // After the rejoin from a known position, the legs land on the beat.
        const steady = legs.filter((l) => l.at >= 6000);
        assert.ok(steady.length >= 6);
        for (const leg of steady) {
            assert.equal(leg.kind, 'stroke');
            assert.equal((leg.at + leg.durationMs) % 500, 0, `lands on a script point: ${JSON.stringify(leg)}`);
            assert.ok([0.1, 0.9].some((x) => Math.abs(leg.position - x) < 1e-9), `${leg.position}`);
        }
    });

    it('a late timer never carries over: the next leg ends on the script point all the same', () => {
        const { feed, time } = rig(strokes({ every: 400 }));
        time.t = 4000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.1);
        runLegs(planner, time, 6000);
        // The driver's timer fires 37 ms late.
        const end = planner.legEndsAt();
        time.t = end + 37;
        const leg = planner.next(time.t);
        assert.equal((time.t + leg.durationMs - 1000) % 400, 0, `${time.t} + ${leg.durationMs}`);
    });

    it('maps the script into the zone it is given (the travel envelope)', () => {
        const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 1000 }));
        time.t = 3000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput({ ...MOVING, zoneMin: 0.2, zoneMax: 0.6 });
        planner.place(0.2);
        const legs = runLegs(planner, time, 12000).filter((l) => l.kind === 'stroke');
        assert.ok(legs.length > 4);
        assert.ok(legs.every((l) => l.position >= 0.2 - 1e-9 && l.position <= 0.6 + 1e-9));
        assert.ok(legs.some((l) => Math.abs(l.position - 0.6) < 1e-9), 'the script\'s top is the envelope\'s top');
    });

    it('Shorten: the allowance scales every stroke from the base of the envelope', () => {
        const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 1000 }));
        time.t = 3000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput({ ...MOVING, speed: 50 });
        planner.place(0);
        const legs = runLegs(planner, time, 12000).filter((l) => l.kind === 'stroke');
        const top = Math.max(...legs.map((l) => l.position));
        assert.ok(Math.abs(top - 0.5) < 1e-9, `${top}`);
    });

    it('never moves faster than the speed limit, the toy cap included', () => {
        // 0 -> 100 every 80 ms: far beyond any device.
        for (const [profile, cap] of [['tcode', 100], ['intiface', 100], ['ossm', 50], ['intiface', 30]]) {
            const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 80, from: 1000, to: 20000 }));
            time.t = 2000;
            const planner = createScriptPlanner({ feed, profile });
            planner.setInput({ ...MOVING, cap });
            planner.place(0);
            let at = 0;
            const legs = runLegs(planner, time, 8000);
            const limit = Math.min(300 * cap / 100, DEVICE_CEILINGS[profile]) / 100 / 1000;
            for (const leg of legs) {
                if (leg.kind !== 'stroke') continue;
                const v = Math.abs(leg.position - at) / leg.durationMs;
                assert.ok(v <= limit + 1e-9, `${profile} cap ${cap}: ${v} > ${limit}`);
                assert.ok(leg.durationMs >= SCRIPT_MIN_LEG_MS);
                at = leg.position;
            }
        }
    });

    it('every leg lasts at least the shortest leg, whatever the script density', () => {
        // A point every 25 ms (smoothing and the minimum segment merge them).
        const actions = [];
        for (let t = 1000, i = 0; t < 10000; t += 25, i += 1) actions.push([t, i % 2 ? 60 : 40]);
        const { feed, time } = rig(trackOf(actions), { settings: { scriptMaxSpeed: 600 } });
        time.t = 2000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.4);
        const legs = runLegs(planner, time, 6000);
        assert.ok(legs.length > 10);
        assert.ok(legs.every((l) => l.durationMs >= SCRIPT_MIN_LEG_MS), legs.map((l) => l.durationMs).join(' '));
    });

    it('a hold in the script is idle legs: nothing to send, the clock read again soon', () => {
        // Up at 1 s, held at 80 until 6 s, then down.
        const { feed, time } = rig(trackOf([[0, 10], [1000, 80], [6000, 80], [7000, 10], [8000, 80]]));
        time.t = 1500;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.8);
        const legs = runLegs(planner, time, 6000);
        assert.ok(legs.length >= 9);
        for (const leg of legs) {
            assert.equal(leg.kind, 'idle', JSON.stringify(leg));
            assert.equal(leg.position, null);
            assert.ok(leg.durationMs <= IDLE_LEG_MAX_MS && leg.durationMs >= SCRIPT_MIN_LEG_MS);
        }
        // And the stroke after the hold goes out on time.
        const after = runLegs(planner, time, 7100).filter((l) => l.kind === 'stroke');
        assert.ok(after.some((l) => l.at + l.durationMs === 7000 && Math.abs(l.position - 0.1) < 1e-9), JSON.stringify(after));
    });

    it('before the script starts and after it ends: idle, never a guess', () => {
        const { feed, time } = rig(strokes({ from: 20000, to: 30000 }));
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.1);
        time.t = 1000;
        const early = runLegs(planner, time, 10000);
        assert.ok(early.length > 0 && early.every((l) => l.kind === 'idle'));
        time.t = 31000;
        const late = runLegs(planner, time, 34000);
        assert.ok(late.length > 0 && late.every((l) => l.kind === 'idle'));
    });

    it('latency plans every leg that much earlier', () => {
        const a = rig(strokes({ every: 500 }));
        const b = rig(strokes({ every: 500 }));
        a.time.t = 5000;
        b.time.t = 5000;
        const plain = createScriptPlanner({ feed: a.feed, profile: 'tcode' });
        const early = createScriptPlanner({ feed: b.feed, profile: 'tcode', latencyMs: 120 });
        for (const p of [plain, early]) {
            p.setInput(MOVING);
            p.place(0.9);
        }
        runLegs(plain, a.time, 6500);
        runLegs(early, b.time, 6500);
        a.time.t = 7000;
        b.time.t = 7000;
        const one = plain.next(a.time.t);
        const two = early.next(b.time.t);
        assert.equal(one.durationMs, 500);
        assert.equal(two.durationMs, 380, 'the point at 7500 is 380 ms after 7000 + 120');
    });

    it('retime() never re-times a script leg', () => {
        const { feed, time } = rig();
        time.t = 2000;
        const planner = createScriptPlanner({ feed });
        planner.setInput(MOVING);
        planner.next(time.t);
        planner.setInput({ speed: 40 });
        assert.equal(planner.retime(time.t + 10), null);
        assert.equal(planner.isInFlight(time.t + 10), true, 'a non-zero change waits for the next leg');
    });
});

describe('script planner: rejoin', () => {
    it('from a position nobody knows, the first leg is sized for the farthest it could have to go', () => {
        for (const [zoneMin, zoneMax] of [[0, 1], [0.2, 0.6], [0.5, 0.9]]) {
            const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 300 }));
            time.t = 5000;
            const planner = createScriptPlanner({ feed, profile: 'tcode' });
            planner.setInput({ ...MOVING, zoneMin, zoneMax });
            const leg = planner.next(time.t);
            assert.equal(leg.kind, 'stroke');
            const mirrored = zoneMin + zoneMax - leg.position;
            const worst = Math.max(leg.position, 1 - leg.position, mirrored, 1 - mirrored);
            const vJoin = 300 / 100 / 1000 / 2; // half the default 300 %/s
            assert.ok(leg.durationMs >= worst / vJoin - 1, `${zoneMin}-${zoneMax}: ${leg.durationMs} ms for ${worst}`);
        }
    });

    it('after a rest, rejoins at the join speed (half the limit) before playing on', () => {
        const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 200 }));
        time.t = 5000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0.5);
        runLegs(planner, time, 7000);
        planner.setInput({ speed: 0 });
        const rest = planner.next(time.t);
        assert.equal(rest.kind, 'rest');
        time.t += rest.durationMs + 1000;
        planner.setInput(MOVING);
        const join = planner.next(time.t);
        const vJoin = 300 / 100 / 1000 / 2;
        assert.ok(Math.abs(join.position - 0) / join.durationMs <= vJoin + 1e-9, JSON.stringify(join));
    });

    it('a seek is a rejoin from where the axis is: no slam', () => {
        const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 250, to: 600000 }));
        time.t = 5000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0);
        runLegs(planner, time, 6100);
        // The wearer scrubs to 5 minutes: seeking, then playing at 300 s.
        feed.setVideoState('seeking');
        planner.setInput(MOVING);
        const rest = planner.next(time.t);
        assert.equal(rest.kind, 'rest');
        time.t += rest.durationMs;
        feed.setVideoState('playing');
        feed.sample({ mediaMs: 300000, perfMs: time.t, source: 'frame' });
        planner.setInput(MOVING);
        // The script is at the bottom there too, where the rest left the
        // axis: it waits for the beat (idle), then plays on, and nothing on
        // the way is faster than the limit.
        const legs = runLegs(planner, time, time.t + 3000);
        assert.equal(legs[0].kind, 'idle');
        let at = 0;
        for (const leg of legs) {
            if (leg.kind !== 'stroke') continue;
            assert.ok(Math.abs(leg.position - at) / leg.durationMs <= 300 / 100 / 1000 + 1e-9, JSON.stringify(leg));
            at = leg.position;
        }
        assert.ok(legs.some((l) => l.kind === 'stroke'));
    });

    it('a seek to where the script is far from the axis joins it at the join speed', () => {
        // Held at the top from 100 s on.
        const { feed, time } = rig(trackOf([[0, 0], [1000, 0], [100000, 100], [200000, 100], [200200, 0]]));
        time.t = 2000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0);
        runLegs(planner, time, 2500);
        feed.setVideoState('seeking');
        planner.setInput(MOVING);
        time.t += planner.next(time.t).durationMs;
        feed.setVideoState('playing');
        feed.sample({ mediaMs: 150000, perfMs: time.t, source: 'frame' });
        planner.setInput(MOVING);
        const join = planner.next(time.t);
        assert.equal(join.kind, 'stroke');
        assert.ok(join.position > 0);
        assert.ok(join.position / join.durationMs <= 300 / 100 / 1000 / 2 + 1e-9, JSON.stringify(join));
    });

    it('a new offset, or a clock that jumped, is a rejoin as well', () => {
        const { feed, time } = rig(strokes({ lo: 0, hi: 100, every: 200 }));
        time.t = 5000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(0);
        runLegs(planner, time, 6000);
        const before = feed.generation();
        feed.setOffset(500);
        assert.notEqual(feed.generation(), before);
        time.t = planner.legEndsAt();
        const from = planner.lastPosition();
        const leg = planner.next(time.t);
        assert.equal(leg.kind, 'stroke');
        // Joined at no more than the join speed from where it was.
        assert.ok(Math.abs(leg.position - from) / leg.durationMs <= 300 / 100 / 1000 / 2 + 1e-9, JSON.stringify(leg));
    });

    it('a join further than one window is approached a window at a time', () => {
        // One slow full-travel stroke a minute: the join from 0 to the top
        // is far away in time and in distance.
        const { feed, time } = rig(trackOf([[0, 100], [60000, 0], [120000, 100]]), { settings: { scriptMaxSpeed: 50 } });
        time.t = 30000;
        const planner = createScriptPlanner({ feed, profile: 'tcode' });
        planner.setInput(MOVING);
        planner.place(1);
        const legs = runLegs(planner, time, 40000);
        assert.ok(legs.every((l) => l.durationMs <= SCRIPT_WINDOW_MS + 1), legs.map((l) => l.durationMs).join(' '));
    });
});

describe('script planner: a feed that fails', () => {
    it('stops the axis, reports once, and stays stopped until a stop is dispatched', () => {
        const errors = [];
        const boom = {
            isActive: () => true,
            hasTime: () => true,
            scriptNow: () => 1000,
            generation: () => 1,
            shape: () => { throw new Error('shaper bug'); },
            reportError: (e, source) => errors.push([e.message, source])
        };
        const planner = createScriptPlanner({ feed: boom });
        planner.setInput(MOVING);
        assert.equal(planner.next(0).kind, 'rest');
        assert.deepEqual(errors, [['shaper bug', 'script-planner']]);
        assert.equal(planner.next(1000), null);
        planner.setInput(MOVING);
        assert.equal(planner.next(2000), null);
        assert.equal(errors.length, 1);
        // A pause (a stop) clears it; the next start tries again, and fails
        // safe again.
        planner.setInput({ speed: 0 });
        planner.setInput(MOVING);
        assert.equal(planner.next(3000), null, 'still resting');
        assert.equal(errors.length, 2);
        assert.equal(planner.isResting(), true);
    });

    it('a feed whose clock throws is no clock', () => {
        const planner = createScriptPlanner({
            feed: { isActive: () => true, hasTime: () => { throw new Error('x'); }, scriptNow: () => { throw new Error('x'); }, generation: () => 0, shape: () => ({ points: [] }) }
        });
        planner.setInput(MOVING);
        assert.equal(planner.next(0).kind, 'rest');
    });

    it('no feed at all never moves', () => {
        const planner = createScriptPlanner();
        planner.setInput(MOVING);
        assert.equal(planner.next(0).kind, 'rest');
        assert.equal(planner.next(1000), null);
    });
});

describe('liveFeed', () => {
    it('asks whatever feed is installed now, and with none has no time', () => {
        let installed = null;
        const live = liveFeed(() => installed);
        assert.equal(live.isActive(), false);
        assert.equal(live.hasTime(), false);
        assert.equal(live.scriptNow(), null);
        assert.deepEqual(live.shape({}).points, []);
        live.reportError(new Error('nobody listens'));
        const { feed } = rig();
        installed = feed;
        assert.equal(live.isActive(), true);
        assert.equal(live.scriptNow(), 0);
        const planner = createScriptPlanner({ feed: live });
        planner.setInput(MOVING);
        // From nowhere, a full travel at the join speed would end before the
        // script starts: wait.
        assert.equal(planner.next(0).kind, 'idle');
    });
});
