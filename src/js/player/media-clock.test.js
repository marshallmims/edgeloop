import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaClock, REANCHOR_MS, MAX_EXTRAPOLATE_MS, CLOCK_STATES } from './media-clock.js';

function playing() {
    const clock = createMediaClock();
    clock.setState('playing');
    return clock;
}

describe('media clock: anchors', () => {
    it('has no time before the first sample', () => {
        const clock = playing();
        assert.equal(clock.nowMs(1000), null);
        assert.equal(clock.anchor(), null);
    });

    it('anchors on the first sample and answers from it', () => {
        const clock = playing();
        assert.equal(clock.sample({ mediaMs: 5000, perfMs: 100000 }), true);
        assert.deepEqual(clock.anchor(), { mediaMs: 5000, perfMs: 100000, rate: 1, source: 'read' });
        assert.equal(clock.nowMs(100000), 5000);
    });

    it('ignores samples that are not numbers or go back in time', () => {
        const clock = playing();
        assert.equal(clock.sample({ mediaMs: NaN, perfMs: 1 }), false);
        assert.equal(clock.sample({ mediaMs: 1, perfMs: Infinity }), false);
        assert.equal(clock.sample({ mediaMs: -5, perfMs: 1 }), false);
        assert.equal(clock.sample(), false);
        clock.sample({ mediaMs: 1000, perfMs: 5000 });
        assert.equal(clock.sample({ mediaMs: 9000, perfMs: 4000 }), false, 'older than the last sample');
        assert.equal(clock.nowMs(5000), 1000);
    });
});

describe('media clock: extrapolation', () => {
    it('runs at the playback rate from the anchor', () => {
        const clock = playing();
        clock.sample({ mediaMs: 2000, perfMs: 10000 });
        assert.equal(clock.nowMs(10250), 2250);
        assert.equal(clock.nowMs(11000), 3000);
        const fast = playing();
        fast.sample({ mediaMs: 2000, perfMs: 10000, rate: 2 });
        assert.equal(fast.nowMs(10500), 3000);
    });

    it('answers nothing for a time that is not a number', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        assert.equal(clock.nowMs(NaN), null);
        assert.equal(clock.nowMs(undefined), null);
    });

    it('never extrapolates past MAX_EXTRAPOLATE_MS without a sample', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        assert.equal(clock.nowMs(MAX_EXTRAPOLATE_MS), MAX_EXTRAPOLATE_MS);
        assert.equal(clock.nowMs(MAX_EXTRAPOLATE_MS + 1), null);
        clock.sample({ mediaMs: 1490, perfMs: 1500 });
        assert.equal(clock.nowMs(2000), 2000, 'still the first anchor: the sample agreed');
        assert.notEqual(clock.nowMs(1500 + MAX_EXTRAPOLATE_MS), null, 'a fresh sample extends the reach');
    });
});

describe('media clock: the re-anchor threshold', () => {
    it('keeps the anchor for a sample within the threshold', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        const generation = clock.generation();
        assert.equal(clock.sample({ mediaMs: 1000 + REANCHOR_MS, perfMs: 1000 }), false);
        assert.equal(clock.sample({ mediaMs: 2000 - REANCHOR_MS, perfMs: 2000 }), false);
        assert.equal(clock.anchor().perfMs, 0);
        assert.equal(clock.generation(), generation);
    });

    it('re-anchors, and bumps the generation, past the threshold', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        const generation = clock.generation();
        assert.equal(clock.sample({ mediaMs: 1000 + REANCHOR_MS + 1, perfMs: 1000 }), true);
        assert.equal(clock.nowMs(1000), 1041);
        assert.equal(clock.generation(), generation + 1);
    });

    it('re-anchors on a rate change', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        assert.equal(clock.sample({ mediaMs: 1000, perfMs: 1000, rate: 0.5 }), true);
        assert.equal(clock.nowMs(2000), 1500);
    });

    it('a frame sample replaces an anchor taken from a read, without a discontinuity', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0, source: 'read' });
        const generation = clock.generation();
        assert.equal(clock.sample({ mediaMs: 1010, perfMs: 1000, source: 'frame' }), true);
        assert.equal(clock.anchor().source, 'frame');
        assert.equal(clock.nowMs(1000), 1010);
        assert.equal(clock.generation(), generation);
        assert.equal(clock.sample({ mediaMs: 1990, perfMs: 2000, source: 'read' }), false, 'a read never replaces a frame anchor it agrees with');
        assert.equal(clock.anchor().source, 'frame');
    });
});

describe('media clock: paused, seeking, waiting, ended -> null', () => {
    for (const state of ['paused', 'seeking', 'waiting', 'ended', 'idle']) {
        it(`${state}: no time, and samples are not taken`, () => {
            const clock = playing();
            clock.sample({ mediaMs: 1000, perfMs: 1000 });
            const generation = clock.generation();
            clock.setState(state);
            assert.equal(clock.state(), state);
            assert.equal(clock.nowMs(1100), null);
            assert.equal(clock.anchor(), null);
            assert.equal(clock.generation(), generation + 1);
            assert.equal(clock.sample({ mediaMs: 1200, perfMs: 1200 }), false);
            assert.equal(clock.nowMs(1200), null);
        });
    }

    it('after a seek it waits for a fresh sample, then runs from there', () => {
        const clock = playing();
        clock.sample({ mediaMs: 1000, perfMs: 1000 });
        clock.setState('seeking');
        clock.setState('playing');
        assert.equal(clock.nowMs(1500), null, 'the old anchor is gone');
        clock.sample({ mediaMs: 60000, perfMs: 1600 });
        assert.equal(clock.nowMs(1700), 60100);
    });

    it('an unknown state stops the clock', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        clock.setState('dancing');
        assert.equal(clock.state(), 'idle');
        assert.equal(clock.nowMs(10), null);
        assert.ok(CLOCK_STATES.includes('playing'));
    });

    it('starts idle with no time', () => {
        const clock = createMediaClock();
        assert.equal(clock.state(), 'idle');
        assert.equal(clock.sample({ mediaMs: 0, perfMs: 0 }), false);
        assert.equal(clock.nowMs(0), null);
    });

    it('setting the same state again is no discontinuity', () => {
        const clock = playing();
        clock.sample({ mediaMs: 0, perfMs: 0 });
        const generation = clock.generation();
        clock.setState('playing');
        assert.equal(clock.generation(), generation);
        assert.equal(clock.nowMs(10), 10);
    });
});
