import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexAt, indexFrom, posAt, slice, isTurn, nextTurnAfter, segmentSpeeds, stats } from './script-track.js';

const trackOf = (pairs) => ({
    at: Int32Array.from(pairs.map((p) => p[0])),
    pos: Uint8Array.from(pairs.map((p) => p[1]))
});

// 0 -> 100 -> 0 every half second from 1000 ms, a hold, then a short stroke.
const T = trackOf([[1000, 0], [1500, 100], [2000, 0], [3000, 0], [3200, 50], [3400, 50], [3600, 10]]);

describe('indexAt / indexFrom: binary search at the edges', () => {
    it('is -1 before the first action and the last index from the last action on', () => {
        assert.equal(indexAt(T, 999), -1);
        assert.equal(indexAt(T, 1000), 0);
        assert.equal(indexAt(T, 3600), 6);
        assert.equal(indexAt(T, 99999), 6);
    });

    it('finds the action at or before a time, exactly on and between actions', () => {
        assert.equal(indexAt(T, 1499), 0);
        assert.equal(indexAt(T, 1500), 1);
        assert.equal(indexAt(T, 2999), 2);
        assert.equal(indexAt(T, 3000), 3);
        assert.equal(indexAt(T, 3599), 5);
    });

    it('indexFrom finds the action at or after a time', () => {
        assert.equal(indexFrom(T, 0), 0);
        assert.equal(indexFrom(T, 1000), 0);
        assert.equal(indexFrom(T, 1001), 1);
        assert.equal(indexFrom(T, 3600), 6);
        assert.equal(indexFrom(T, 3601), -1);
    });

    it('agrees with a linear scan over many tracks and times', () => {
        let seed = 7;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let k = 0; k < 50; k += 1) {
            const pairs = [];
            let t = Math.floor(rnd() * 500);
            const n = 2 + Math.floor(rnd() * 40);
            for (let i = 0; i < n; i += 1) {
                pairs.push([t, Math.floor(rnd() * 101)]);
                t += 1 + Math.floor(rnd() * 300);
            }
            const track = trackOf(pairs);
            for (let q = -10; q < t + 10; q += 37) {
                let expected = -1;
                for (let i = 0; i < n; i += 1) if (pairs[i][0] <= q) expected = i;
                assert.equal(indexAt(track, q), expected);
            }
        }
    });

    it('is -1 for an empty track or a time that is not a number', () => {
        assert.equal(indexAt(trackOf([]), 5), -1);
        assert.equal(indexAt(null, 5), -1);
        assert.equal(indexAt(T, NaN), -1);
        assert.equal(indexFrom(T, Infinity), -1);
    });
});

describe('posAt: interpolation', () => {
    it('is linear between actions and exact on them', () => {
        assert.equal(posAt(T, 1000), 0);
        assert.equal(posAt(T, 1250), 50);
        assert.equal(posAt(T, 1500), 100);
        assert.equal(posAt(T, 1600), 80);
        assert.equal(posAt(T, 2500), 0);
        assert.equal(posAt(T, 3500), 30);
        assert.equal(posAt(T, 3600), 10);
    });

    it('is null before the first action and after the last', () => {
        assert.equal(posAt(T, 999), null);
        assert.equal(posAt(T, 3601), null);
        assert.equal(posAt(T, NaN), null);
    });
});

describe('slice', () => {
    it('returns the actions inside the window as views, both ends included', () => {
        const s = slice(T, 1500, 3000);
        assert.deepEqual(Array.from(s.at), [1500, 2000, 3000]);
        assert.deepEqual(Array.from(s.pos), [100, 0, 0]);
        assert.equal(s.start, 1);
        assert.equal(s.end, 4);
        assert.equal(s.at.buffer, T.at.buffer, 'a view, not a copy');
    });

    it('is empty between two actions, past the end, and for a reversed window', () => {
        assert.equal(slice(T, 1600, 1900).at.length, 0);
        assert.equal(slice(T, 4000, 5000).at.length, 0);
        assert.equal(slice(T, 3000, 1000).at.length, 0);
        assert.equal(slice(T, 0, 999).at.length, 0);
        assert.deepEqual(Array.from(slice(T, 0, 1000).at), [1000]);
    });
});

describe('turning points', () => {
    it('counts reversals, the start and end of a hold, and both ends of the script', () => {
        const turns = Array.from(T.at, (_, i) => isTurn(T, i));
        // 0: first; 1: top; 2: bottom, hold starts; 3: hold ends; 4: hold at 50
        // starts; 5: it ends; 6: last.
        assert.deepEqual(turns, [true, true, true, true, true, true, true]);
        const straight = trackOf([[0, 0], [100, 20], [200, 40], [300, 100], [400, 0]]);
        assert.deepEqual(Array.from(straight.at, (_, i) => isTurn(straight, i)), [true, false, false, true, true]);
    });

    it('nextTurnAfter finds the first turning point at or after a time', () => {
        const straight = trackOf([[0, 0], [100, 20], [200, 40], [300, 100], [400, 0]]);
        assert.equal(nextTurnAfter(straight, 50), 3);
        assert.equal(nextTurnAfter(straight, 300), 3);
        assert.equal(nextTurnAfter(straight, 301), 4);
        assert.equal(nextTurnAfter(straight, 401), -1);
        assert.equal(nextTurnAfter(straight, -100), 0);
    });
});

describe('stats on known scripts', () => {
    it('a steady 0-100 stroke every 500 ms is 200 %/s everywhere', () => {
        const pairs = [];
        for (let i = 0; i <= 20; i += 1) pairs.push([i * 500, i % 2 ? 100 : 0]);
        const s = stats(trackOf(pairs));
        assert.equal(s.actions, 21);
        assert.equal(s.durationMs, 10000);
        assert.equal(s.maxSpeed, 200);
        assert.equal(s.movingSegments, 20);
        assert.equal(s.cappedShare(300), 0);
        assert.equal(s.cappedShare(200), 0, 'exactly at the cap is not capped');
        assert.equal(s.cappedShare(199), 1);
        assert.equal(s.intensityPerSecond.length, 10);
        for (const v of s.intensityPerSecond) assert.ok(Math.abs(v - 200) < 1e-3);
    });

    it('a script with one fast stretch reports where it is and what share is capped', () => {
        // Four slow strokes (100 %/s), then four fast ones (400 %/s), with a hold between.
        const pairs = [[0, 0], [1000, 100], [2000, 0], [3000, 100], [4000, 0], [6000, 0]];
        let t = 6000;
        for (let i = 1; i <= 4; i += 1) {
            t += 250;
            pairs.push([t, i % 2 ? 100 : 0]);
        }
        const track = trackOf(pairs);
        const s = stats(track);
        assert.equal(s.maxSpeed, 400);
        assert.equal(s.fastestAt, 6000);
        assert.equal(s.movingSegments, 8, 'the hold is not a stroke');
        assert.equal(s.cappedShare(300), 0.5);
        assert.equal(s.cappedShare(50), 1);
        assert.equal(s.cappedShare(NaN), 0);
        assert.equal(s.intensityPerSecond[4], 0, 'the hold has no intensity');
        assert.equal(s.intensityPerSecond[6], 400);
        assert.deepEqual(Array.from(segmentSpeeds(track).slice(0, 5)), [100, 100, 100, 100, 0]);
    });

    it('spreads a segment over the seconds it spans', () => {
        const s = stats(trackOf([[500, 0], [1500, 100]]));
        assert.deepEqual(Array.from(s.intensityPerSecond), [50, 50]);
    });

    it('an empty track has no stats to speak of', () => {
        const s = stats(trackOf([]));
        assert.equal(s.maxSpeed, 0);
        assert.equal(s.fastestAt, null);
        assert.equal(s.cappedShare(10), 0);
        assert.equal(s.intensityPerSecond.length, 0);
    });
});
