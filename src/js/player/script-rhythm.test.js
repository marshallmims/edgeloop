import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rhythmAt, hampTarget, RHYTHM_WINDOW_MS } from './script-rhythm.js';

const trackOf = (pairs) => ({
    at: Int32Array.from(pairs.map((p) => p[0])),
    pos: Uint8Array.from(pairs.map((p) => p[1]))
});

function strokes(count, half, lo = 0, hi = 100, start = 0) {
    const pairs = [];
    for (let i = 0; i <= count; i += 1) pairs.push([start + i * half, i % 2 ? hi : lo]);
    return trackOf(pairs);
}

const HANDY = { envMin: 0, envMax: 100, travelMm: 110, maxSpeedMmS: 400, maxSpeed: 600, approach: 'shorten' };

describe('rhythmAt: flat sections', () => {
    it('a hold has no speed and a single position', () => {
        const track = trackOf([[0, 40], [10000, 40], [11000, 90]]);
        const r = rhythmAt(track, 1000);
        assert.equal(r.meanSpeed, 0);
        assert.equal(r.lo, 40);
        assert.equal(r.hi, 40);
        assert.equal(r.ended, false);
        assert.equal(hampTarget(r, 100, HANDY).speed, 0, 'a hold stops The Handy');
    });

    it('a window that starts in a hold and reaches the next stroke sees it', () => {
        const track = trackOf([[0, 40], [10000, 40], [11000, 90], [12000, 40]]);
        const r = rhythmAt(track, 9000);
        assert.ok(r.meanSpeed > 0);
        assert.ok(r.hi > 40);
    });
});

describe('rhythmAt: fast sections', () => {
    it('full strokes every 250 ms are 400 %/s over 10-90 percentiles of 0 and 100', () => {
        const r = rhythmAt(strokes(100, 250), 1000);
        assert.equal(r.meanSpeed, 400);
        assert.equal(r.lo, 0);
        assert.equal(r.hi, 100);
    });

    it('strokes in the middle of the range give a range in the middle', () => {
        const r = rhythmAt(strokes(100, 500, 30, 70), 1000);
        assert.equal(r.lo, 30);
        assert.equal(r.hi, 70);
        assert.equal(r.meanSpeed, 80);
    });

    it('invert flips the positions', () => {
        const r = rhythmAt(strokes(100, 500, 30, 60), 1000, { invert: true });
        assert.equal(r.lo, 40);
        assert.equal(r.hi, 70);
    });

    it('becomes a HAMP velocity from the mean speed in mm/s', () => {
        // 200 %/s over 110 mm is 220 mm/s; 220 / 400 = 55%.
        const r = rhythmAt(strokes(100, 500), 1000);
        assert.deepEqual(hampTarget(r, 100, HANDY), { speed: 55, strokeMin: 0, strokeMax: 100 });
    });

    it('is capped by the Max speed limit and by 100', () => {
        const r = rhythmAt(strokes(200, 100), 1000); // 1000 %/s
        assert.equal(hampTarget(r, 100, HANDY).speed, 100);
        // 300 %/s over 110 mm is 330 mm/s: 82.5% of 400.
        assert.equal(hampTarget(r, 100, { ...HANDY, maxSpeed: 300 }).speed, 83);
    });
});

describe('hampTarget: the allowance', () => {
    const r = rhythmAt(strokes(100, 500), 1000);

    it('keeps the script range and scales only the velocity', () => {
        assert.deepEqual(hampTarget(r, 50, HANDY), { speed: 28, strokeMin: 0, strokeMax: 100 });
    });

    it('Slow keeps the range and lowers only the limit', () => {
        const slow = hampTarget(r, 50, { ...HANDY, approach: 'slow', maxSpeed: 300 });
        assert.equal(slow.strokeMax, 100);
        // 300 x 0.5 = 150 %/s = 165 mm/s = 41%.
        assert.equal(slow.speed, 41);
    });

    it('maps the range inside the envelope', () => {
        const t = hampTarget(rhythmAt(strokes(100, 500, 20, 80), 1000), 100, { ...HANDY, envMin: 10, envMax: 60 });
        assert.equal(t.strokeMin, 20);
        assert.equal(t.strokeMax, 50);
    });

    it('allowance 0 is a stop over the whole envelope', () => {
        assert.deepEqual(hampTarget(r, 0, { ...HANDY, envMin: 10, envMax: 90 }), { speed: 0, strokeMin: 10, strokeMax: 90 });
        assert.equal(hampTarget(r, NaN, HANDY).speed, 0);
    });

    it('a rhythm that moves is never rounded into a stop', () => {
        const slowTrack = trackOf([[0, 0], [100000, 100]]);
        const t = hampTarget(rhythmAt(slowTrack, 1000), 1, HANDY);
        assert.equal(t.speed, 1);
    });
});

describe('end of script -> 0', () => {
    it('after the last action there is no rhythm and no speed', () => {
        const track = strokes(10, 500);
        for (const t of [5000, 6000, 1e9]) {
            const r = rhythmAt(track, t);
            assert.equal(r.ended, true);
            assert.equal(hampTarget(r, 100, HANDY).speed, 0);
        }
    });

    it('the last seconds only count what is left of the script', () => {
        const track = strokes(10, 500); // ends at 5000
        const r = rhythmAt(track, 4000);
        // 1000 ms of strokes at 200 %/s over a 3 s window.
        assert.ok(Math.abs(r.meanSpeed - (200 * 1000) / RHYTHM_WINDOW_MS) < 1e-9);
    });

    it('before the first action only the part from the first action counts', () => {
        const track = strokes(10, 500, 0, 100, 10000);
        assert.equal(rhythmAt(track, 0).meanSpeed, 0);
        assert.equal(rhythmAt(track, 0).ended, false);
        assert.ok(rhythmAt(track, 8000).meanSpeed > 0);
    });

    it('garbage is no rhythm', () => {
        assert.equal(rhythmAt(null, 0).ended, true);
        assert.equal(rhythmAt(strokes(4, 500), NaN).ended, true);
        assert.equal(hampTarget(null, 100, HANDY).speed, 0);
    });
});
