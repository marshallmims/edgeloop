import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    shapeWindow,
    limitVelocity,
    smoothPoints,
    smoothedTrack,
    planRejoin,
    holdPoints,
    scriptSpeedCap,
    amplitudeFactor,
    effectiveInvert,
    handySpeedCeiling,
    percentToMmPerSecond,
    DEVICE_CEILINGS,
    FALLBACK_CEILING,
    REJOIN_SEARCH_MS,
    SMOOTHING_LEVELS
} from './script-shaper.js';

const trackOf = (pairs) => ({
    at: Int32Array.from(pairs.map((p) => p[0])),
    pos: Uint8Array.from(pairs.map((p) => p[1]))
});

// Full strokes 0 <-> 100 every `half` ms from `start`.
function strokes(count, half = 500, start = 0) {
    const pairs = [];
    for (let i = 0; i <= count; i += 1) pairs.push([start + i * half, i % 2 ? 100 : 0]);
    return trackOf(pairs);
}

function randomTrack(seed, n = 200) {
    let s = seed;
    const rnd = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
    const pairs = [];
    let t = Math.floor(rnd() * 2000);
    for (let i = 0; i < n; i += 1) {
        pairs.push([t, Math.floor(rnd() * 101)]);
        t += 10 + Math.floor(rnd() * 600);
    }
    return trackOf(pairs);
}

const FULL = { window: { min: 0, max: 100 }, ceiling: 600, cap: 100, minSegmentMs: 0 };
const SETTINGS = { approach: 'shorten', invert: false, smoothing: 'off', maxSpeed: 300 };
const shape = (over = {}) => shapeWindow({
    allowance: 100,
    settings: SETTINGS,
    device: FULL,
    startPos: 0,
    rejoin: false,
    ...over
});

// The fastest any segment of `points` moves, in x per ms (from `start` if given).
function fastest(points, start = null) {
    let prev = start;
    let worst = 0;
    for (const p of points) {
        if (prev && p.t > prev.t) worst = Math.max(worst, Math.abs(p.x - prev.x) / (p.t - prev.t));
        prev = p;
    }
    return worst;
}

describe('shapeWindow: determinism', () => {
    it('the same inputs always give the same points', () => {
        const track = randomTrack(11);
        const args = { track, from: 3000, to: 7000, allowance: 63, startPos: 0.4 };
        const a = shape(args);
        const b = shape({ ...args });
        const c = shape({ ...args, track: { at: Int32Array.from(track.at), pos: Uint8Array.from(track.pos) } });
        assert.deepEqual(a, b);
        assert.deepEqual(a, c);
        assert.equal(JSON.stringify(a.points), JSON.stringify(c.points));
    });

    it('a window\'s points do not depend on where an earlier window started (smoothing is per track)', () => {
        const track = randomTrack(5, 400);
        const near = shape({ track, from: 20000, to: 24000, startPos: 0.5, settings: { ...SETTINGS, smoothing: 'light' } });
        smoothedTrack(track, 'light');
        const again = shape({ track, from: 20000, to: 24000, startPos: 0.5, settings: { ...SETTINGS, smoothing: 'light' } });
        assert.deepEqual(near, again);
        const s1 = smoothedTrack(track, 'light');
        assert.equal(smoothedTrack(track, 'light'), s1, 'cached');
        assert.notEqual(smoothedTrack(track, 'off'), s1);
    });
});

describe('shapeWindow: never outside 0-1, never faster than vCap, timing never moved', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        it(`random script ${seed}`, () => {
            const track = randomTrack(seed);
            const actionTimes = new Set(track.at);
            for (const allowance of [1, 30, 75, 100]) {
                for (const approach of ['shorten', 'slow', 'both', 'none']) {
                    for (const [from, to] of [[0, 4000], [5000, 9000], [12000, 16000]]) {
                        for (const startPos of [0, 0.5, 1, null]) {
                            for (const rejoin of [false, true]) {
                                const device = { window: { min: 10, max: 70 }, ceiling: 400, cap: 80, minSegmentMs: 0 };
                                const settings = { ...SETTINGS, approach, maxSpeed: 250 };
                                const r = shapeWindow({ track, from, to, allowance, settings, device, startPos, rejoin, lead: 300 });
                                const vUnits = r.vCap / 60 / 1000;
                                assert.ok(r.vCap <= 400 && r.vCap <= 250 * 0.8 + 1e-9);
                                let prevT = -Infinity;
                                for (const p of r.points) {
                                    assert.ok(p.x >= 0 && p.x <= 1, `x ${p.x}`);
                                    assert.ok(p.t >= from && p.t <= to, `t ${p.t} outside ${from}-${to}`);
                                    assert.ok(p.t >= prevT, 'in time order');
                                    prevT = p.t;
                                    const synthetic = p.t === from || p.t === to || (r.join && p.t === r.join.t);
                                    assert.ok(actionTimes.has(p.t) || synthetic, `a point at ${p.t} the script does not have`);
                                    assert.deepEqual(Object.keys(p).sort(), ['t', 'x']);
                                }
                                const start = startPos === null || (r.points[0] && r.points[0].t === from) ? null : { t: from, x: startPos };
                                assert.ok(fastest(r.points, start) <= vUnits + 1e-9, `faster than vCap (${approach} ${allowance} ${from})`);
                            }
                        }
                    }
                }
            }
        });
    }

    it('clips a too-fast segment at its end, keeping its time, and starts the next from the clip', () => {
        // 0 -> 100 in 100 ms is 1000 %/s; the cap is 300 %/s: 30 per 100 ms.
        const track = trackOf([[0, 0], [100, 100], [1000, 0]]);
        const r = shape({ track, from: 0, to: 1000, startPos: 0 });
        assert.equal(r.vCap, 300);
        assert.deepEqual(r.points.map((p) => p.t), [100, 1000]);
        assert.ok(Math.abs(r.points[0].x - 0.3) < 1e-9);
        assert.equal(r.points[1].x, 0, 'from 0.3 back to 0 over 900 ms fits');
    });

    it('limits physical speed: the same step is slower in a narrower window', () => {
        const track = trackOf([[0, 0], [1000, 100], [2000, 0]]);
        // 100 %/s over a window of 50 is 50 %/s of full travel: under any cap.
        const narrow = shape({ track, from: 0, to: 2000, startPos: 0, device: { ...FULL, window: { min: 25, max: 75 } }, settings: { ...SETTINGS, maxSpeed: 50 } });
        assert.equal(narrow.points[0].x, 1);
        const wide = shape({ track, from: 0, to: 2000, startPos: 0, settings: { ...SETTINGS, maxSpeed: 50 } });
        assert.ok(Math.abs(wide.points[0].x - 0.5) < 1e-9);
    });
});

describe('shapeWindow: skip', () => {
    it('an allowance of 0 is no points', () => {
        const r = shape({ track: strokes(20), from: 0, to: 4000, allowance: 0 });
        assert.deepEqual(r.points, []);
        assert.equal(r.reason, 'skip');
        assert.equal(r.vCap, 0);
    });

    it('a toy cap of 0 is a skip too, and garbage allowance is 0', () => {
        assert.equal(shape({ track: strokes(20), from: 0, to: 4000, device: { ...FULL, cap: 0 } }).reason, 'skip');
        assert.equal(shape({ track: strokes(20), from: 0, to: 4000, allowance: NaN }).reason, 'skip');
        assert.equal(shape({ track: strokes(20), from: 0, to: 4000, device: { ...FULL, window: { min: 40, max: 40 } } }).reason, 'skip');
    });

    it('holdPoints holds one point a second', () => {
        assert.deepEqual(holdPoints(1000, 3500, 0.25), [{ t: 1000, x: 0.25 }, { t: 2000, x: 0.25 }, { t: 3000, x: 0.25 }]);
        assert.deepEqual(holdPoints(0, 10, 2), [{ t: 0, x: 1 }]);
        assert.deepEqual(holdPoints(5, 1, 0.5), []);
        assert.deepEqual(holdPoints(0, 1000, NaN), []);
    });
});

describe('shapeWindow: end of script, before the start', () => {
    it('after the last action there are no points', () => {
        const track = strokes(4); // ends at 2000
        for (const startPos of [0, 0.7, null]) {
            for (const rejoin of [false, true]) {
                const r = shape({ track, from: 2000, to: 6000, startPos, rejoin });
                assert.deepEqual(r.points, []);
                assert.equal(r.reason, 'after-end');
            }
        }
    });

    it('a window that runs past the end stops at the last action', () => {
        const r = shape({ track: strokes(4), from: 1000, to: 6000, startPos: 0 });
        assert.equal(r.points[r.points.length - 1].t, 2000);
    });

    it('before the first action nothing moves; the first action is joined like a rejoin', () => {
        const track = strokes(10, 500, 10000);
        const early = shape({ track, from: 0, to: 4000, startPos: 0.5 });
        assert.deepEqual(early.points, [{ t: 0, x: 0.5 }]);
        assert.equal(early.reason, 'before-start');
        const near = shape({ track, from: 9000, to: 13000, startPos: 0.5 });
        assert.equal(near.reason, 'stroke');
        assert.deepEqual(near.points[0], { t: 9000, x: 0.5 });
        assert.ok(near.points[1].t >= 10000);
    });

    it('nothing usable is empty', () => {
        assert.equal(shape({ track: trackOf([[0, 0]]), from: 0, to: 100 }).reason, 'empty');
        assert.equal(shape({ track: null, from: 0, to: 100 }).reason, 'empty');
        assert.equal(shape({ track: strokes(4), from: 500, to: 100 }).reason, 'empty');
        assert.equal(shape({ track: strokes(4), from: NaN, to: 100 }).reason, 'empty');
    });
});

describe('shapeWindow: rejoin', () => {
    it('joins at a point it can reach at half the speed limit, preferring a turning point', () => {
        // Strokes 0 <-> 100 every 500 ms: 200 %/s. Cap 300 %/s, join 150 %/s.
        const track = strokes(40);
        const r = shape({ track, from: 2100, to: 6000, startPos: 0, rejoin: true, lead: 300 });
        assert.equal(r.reason, 'stroke');
        assert.deepEqual(r.points[0], { t: 2100, x: 0 });
        const join = r.points[1];
        assert.equal(join.t, r.join.t);
        assert.equal(r.join.fallback, false);
        assert.ok(join.t >= 2400, 'not before t0 + lead');
        assert.ok(Math.abs(join.x - 0) <= r.vJoin * (join.t - 2100) + 1e-9, 'reachable at the join speed');
        assert.ok(join.x === 0 || join.x === 1, 'a turning point');
        // 2500 is a top (x 1) 400 ms away: needs 250 %/s, too fast. 3000 (x 0) is reachable at once.
        assert.equal(join.t, 3000);
    });

    it('never moves faster than the join speed from the start to the join point', () => {
        for (const seed of [21, 22, 23, 24, 25]) {
            const track = randomTrack(seed);
            for (const startPos of [0, 0.3, 1]) {
                for (const from of [1000, 7000, 15000]) {
                    const r = shape({ track, from, to: from + 4000, startPos, rejoin: true, lead: 250 });
                    if (!r.join || r.join.t > from + 4000) continue;
                    const speed = Math.abs(r.join.x - startPos) / (r.join.t - from);
                    assert.ok(speed <= r.vJoin + 1e-9, `join at ${speed} > ${r.vJoin}`);
                    assert.equal(r.points[0].t, from);
                    assert.equal(r.points[1].t, r.join.t);
                }
            }
        }
    });

    it('a position nobody knows is sized for the far end', () => {
        const track = strokes(40);
        const r = shape({ track, from: 2100, to: 6000, startPos: null, lead: 300 });
        assert.notEqual(r.points[0].t, 2100, 'no anchor at an unknown position');
        const join = r.points[0];
        assert.ok(Math.max(join.x, 1 - join.x) <= r.vJoin * (join.t - 2100) + 1e-9);
    });

    it('when nothing is reachable within 3 s it aims at the script where it can get to', () => {
        // Very fast tiny strokes between 0 and 100 that never sit still: a
        // very low cap makes every point out of reach.
        const pairs = [];
        for (let i = 0; i < 400; i += 1) pairs.push([i * 100, i % 2 ? 100 : 0]);
        const track = trackOf(pairs);
        // 50 %/s x a 10% toy cap: 5 %/s, joining at 2.5 %/s; half the travel takes 20 s.
        const r = shape({ track, from: 1000, to: 30000, startPos: 0.5, rejoin: true, settings: { ...SETTINGS, maxSpeed: 50 }, device: { ...FULL, cap: 10 } });
        assert.equal(r.join.fallback, true);
        assert.ok(r.join.t > 1000 + REJOIN_SEARCH_MS);
        assert.ok(Math.abs(r.join.x - 0.5) <= r.vJoin * (r.join.t - 1000) + 1e-9);
        assert.deepEqual(r.points[0], { t: 1000, x: 0.5 });
        assert.equal(r.points[1].t, r.join.t);
        assert.ok(fastest(r.points.slice(1), r.join) <= r.vJoin * 2 + 1e-9);
    });

    it('a join beyond the window holds at the start position', () => {
        const pairs = [[0, 0], [100, 100]];
        for (let i = 2; i < 100; i += 1) pairs.push([i * 100, i % 2 ? 100 : 0]);
        const r = shape({ track: trackOf(pairs), from: 1000, to: 1200, startPos: 0.5, rejoin: true, settings: { ...SETTINGS, maxSpeed: 50 } });
        assert.equal(r.reason, 'joining');
        assert.deepEqual(r.points, [{ t: 1000, x: 0.5 }]);
        assert.ok(r.join.t > 1200);
    });

    it('a script passing through the start position right then is joined at once, with one anchor', () => {
        const track = trackOf([[0, 0], [2000, 100], [4000, 0]]);
        const r = shape({ track, from: 1000, to: 4000, startPos: 0.5, rejoin: true, settings: { ...SETTINGS, maxSpeed: 50 }, device: { ...FULL, cap: 10 } });
        assert.equal(r.points.filter((p) => p.t === 1000).length, 1);
    });

    it('planRejoin refuses nonsense and returns null past the end', () => {
        assert.equal(planRejoin({ points: [], t0: NaN, vJoin: 1 }), null);
        assert.equal(planRejoin({ points: [], t0: 0, vJoin: 0 }), null);
        assert.equal(planRejoin({ points: [], t0: 0, p0: 0, vJoin: 0.001, positionAt: () => null }), null);
    });
});

describe('approach and amplitude', () => {
    const track = trackOf([[0, 0], [1000, 100], [2000, 0], [3000, 100]]);

    it('Shorten scales every stroke from the base, timing unchanged', () => {
        const r = shape({ track, from: 0, to: 3000, allowance: 40, startPos: 0 });
        assert.deepEqual(r.points.map((p) => p.t), [1000, 2000, 3000]);
        assert.deepEqual(r.points.map((p) => Math.round(p.x * 100) / 100), [0.4, 0, 0.4]);
        assert.equal(r.vCap, 300);
    });

    it('Slow lowers the speed limit and leaves the amplitude', () => {
        const r = shape({ track, from: 0, to: 3000, allowance: 40, startPos: 0, settings: { ...SETTINGS, approach: 'slow' } });
        assert.equal(r.vCap, 120);
        assert.ok(Math.abs(r.points[0].x - 1) < 1e-9, '100 %/s fits under 120 %/s');
        const fastTrack = trackOf([[0, 0], [250, 100], [500, 0]]);
        const fast = shape({ track: fastTrack, from: 0, to: 500, allowance: 40, startPos: 0, settings: { ...SETTINGS, approach: 'slow' } });
        assert.ok(Math.abs(fast.points[0].x - 0.3) < 1e-9, 'a fast stroke is cut short: 120 %/s x 250 ms');
    });

    it('Shorten & slow does both', () => {
        const r = shape({ track, from: 0, to: 3000, allowance: 40, startPos: 0, settings: { ...SETTINGS, approach: 'both' } });
        assert.equal(r.vCap, 120);
        assert.ok(Math.abs(r.points[0].x - 0.4) < 1e-9);
    });

    it('None applies what the governor left in the allowance as Shorten', () => {
        assert.equal(amplitudeFactor('none', 50), 0.5);
        assert.equal(amplitudeFactor('slow', 50), 1);
        assert.equal(amplitudeFactor('shorten', 50), 0.5);
        assert.equal(amplitudeFactor('both', NaN), 0);
    });

    it('invert flips the stroke; the base is still x 0', () => {
        const r = shape({ track, from: 0, to: 3000, allowance: 40, startPos: 0, settings: { ...SETTINGS, invert: true } });
        // Inverted: 100, 0, 100, 0 -> x 1, 0, 1, 0 at pos 0, 100... scaled 0.4 from the base.
        assert.deepEqual(r.points.map((p) => Math.round(p.x * 100) / 100), [0, 0.4, 0]);
        assert.equal(effectiveInvert({ inverted: true }, { scriptInvert: false }), true);
        assert.equal(effectiveInvert({ inverted: true }, { scriptInvert: true }), false);
        assert.equal(effectiveInvert({ inverted: false }, { invert: true }), true);
        assert.equal(effectiveInvert(null, null), false);
    });
});

describe('the speed limit', () => {
    it('is the Max speed x the toy cap, never above the device ceiling', () => {
        assert.equal(scriptSpeedCap({ maxSpeed: 300, cap: 100, ceiling: 600 }), 300);
        assert.equal(scriptSpeedCap({ maxSpeed: 300, cap: 50, ceiling: 600 }), 150);
        assert.equal(scriptSpeedCap({ maxSpeed: 600, cap: 100, ceiling: DEVICE_CEILINGS.handy }), DEVICE_CEILINGS.handy);
        assert.equal(scriptSpeedCap({ maxSpeed: 600 }), FALLBACK_CEILING, 'no ceiling named: the lowest known');
        assert.equal(scriptSpeedCap({ maxSpeed: 9999, ceiling: 1e6 }), 600, 'Max speed is clamped');
        assert.equal(scriptSpeedCap({ maxSpeed: 300, approach: 'slow', allowance: 50, ceiling: 600 }), 150);
    });

    it('The Handy\'s ceiling comes from its own top speed and travel', () => {
        assert.ok(Math.abs(handySpeedCeiling({ maxSpeedMmS: 400, travelMm: 110 }) - 363.636) < 0.01);
        assert.ok(Math.abs(handySpeedCeiling({ maxSpeedMmS: 400, travelMm: 108 }) - 370.37) < 0.01);
        assert.equal(handySpeedCeiling({}), DEVICE_CEILINGS.handy);
        assert.equal(handySpeedCeiling({ maxSpeedMmS: -1, travelMm: 0 }), DEVICE_CEILINGS.handy);
        assert.equal(percentToMmPerSecond(300, 110), 330);
        assert.equal(percentToMmPerSecond('x'), 0);
    });

    it('limitVelocity never moves a time and clips toward the previous point', () => {
        const out = limitVelocity([{ t: 100, x: 1 }, { t: 200, x: 0 }, { t: 1200, x: 1 }], 0.002, { t: 0, x: 0 });
        assert.deepEqual(out.map((p) => p.t), [100, 200, 1200]);
        assert.ok(Math.abs(out[0].x - 0.2) < 1e-9);
        assert.ok(Math.abs(out[1].x - 0) < 1e-9);
        assert.equal(out[2].x, 1);
        assert.deepEqual(limitVelocity([{ t: 5, x: 2 }], 0.001), [{ t: 5, x: 1 }], 'no start: the first point is taken as it is, inside 0-1');
    });
});

describe('smoothing', () => {
    it('Light drops points under 60 ms apart unless they turn, and jitter reversals under 3', () => {
        const track = trackOf([
            [0, 0], [30, 10], [80, 20], [100, 25], [300, 100], [320, 98], [340, 100], [600, 0], [650, 0], [900, 80]
        ]);
        const s = smoothPoints(track, SMOOTHING_LEVELS.light);
        const kept = Array.from(s.at);
        assert.ok(!kept.includes(30), 'a straight point 30 ms after the last kept is dropped');
        assert.ok(kept.includes(80));
        assert.ok(!kept.includes(100), '20 ms after 80');
        assert.ok(kept.includes(300), 'the top is a reversal of 75');
        assert.ok(!kept.includes(320), 'a 2-point dip is jitter');
        assert.ok(kept.includes(600) && kept.includes(650), 'a hold keeps its start and its end');
        assert.equal(kept[0], 0);
        assert.equal(kept[kept.length - 1], 900);
    });

    it('never adds or moves a point', () => {
        for (const seed of [31, 32, 33]) {
            const track = randomTrack(seed, 500);
            for (const level of Object.keys(SMOOTHING_LEVELS)) {
                const s = smoothPoints(track, SMOOTHING_LEVELS[level]);
                const original = new Map(Array.from(track.at, (t, i) => [t, track.pos[i]]));
                assert.ok(s.at.length <= track.at.length);
                for (let i = 0; i < s.at.length; i += 1) assert.equal(original.get(s.at[i]), s.pos[i]);
            }
        }
    });

    it('Off removes nothing, but the device minimum segment still applies', () => {
        const track = trackOf([[0, 0], [20, 50], [40, 100], [300, 0]]);
        assert.equal(smoothPoints(track, SMOOTHING_LEVELS.off).at.length, 4);
        const r = shape({ track, from: 0, to: 300, startPos: 0, settings: { ...SETTINGS, maxSpeed: 600 }, device: { ...FULL, minSegmentMs: 60 } });
        assert.ok(r.points.every((p, i) => i === 0 || p.t - r.points[i - 1].t >= 60));
    });
});

describe('the window end', () => {
    it('adds a point on the segment that crosses the end, so the device keeps moving', () => {
        const track = trackOf([[0, 0], [10000, 100]]);
        const r = shape({ track, from: 2000, to: 6000, startPos: 0.2 });
        assert.deepEqual(r.points, [{ t: 6000, x: 0.6 }]);
    });
});
