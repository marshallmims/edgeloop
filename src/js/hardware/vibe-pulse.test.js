import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    VIBE_MODES,
    DEFAULT_VIBE_MODE,
    PULSE_PERIODS_MS,
    DEFAULT_PULSE_PERIOD_MS,
    readVibeMode,
    readPulsePeriod,
    pulsePhase,
    pulseLevel
} from './vibe-pulse.js';

describe('the pulse settings are a choice, never a number to invent', () => {
    it('knows Constant (the default) and Pulsed, and nothing else', () => {
        assert.deepEqual([...VIBE_MODES], ['constant', 'pulsed']);
        assert.equal(DEFAULT_VIBE_MODE, 'constant');
        assert.equal(readVibeMode('pulsed'), 'pulsed');
        assert.equal(readVibeMode('constant'), 'constant');
        for (const junk of ['Pulsed', 'strobe', '', null, undefined, 1, {}]) assert.equal(readVibeMode(junk), null);
    });

    it('knows the three periods the forum report tried, and nothing in between', () => {
        assert.deepEqual([...PULSE_PERIODS_MS], [800, 1600, 2400]);
        assert.equal(DEFAULT_PULSE_PERIOD_MS, 1600);
        assert.equal(readPulsePeriod(800), 800);
        assert.equal(readPulsePeriod('2400'), 2400);
        for (const junk of [0, 100, 799, 1000, 1600.5, -800, '1.6', '800ms', null, undefined, NaN, Infinity]) {
            assert.equal(readPulsePeriod(junk), null, `${String(junk)} is not a period`);
        }
    });
});

describe('pulsePhase: a square wave from the start of the train', () => {
    it('is on for the first half of every period and off for the second', () => {
        for (const period of PULSE_PERIODS_MS) {
            const half = period / 2;
            const start = 1_000_000;
            assert.deepEqual(pulsePhase(start, start, period), { on: true, changeAt: start + half });
            assert.deepEqual(pulsePhase(start, start + half - 1, period), { on: true, changeAt: start + half });
            assert.deepEqual(pulsePhase(start, start + half, period), { on: false, changeAt: start + period });
            assert.deepEqual(pulsePhase(start, start + period - 1, period), { on: false, changeAt: start + period });
            assert.deepEqual(pulsePhase(start, start + period, period), { on: true, changeAt: start + period + half });
            assert.deepEqual(pulsePhase(start, start + 7 * period + half + 3, period), { on: false, changeAt: start + 8 * period });
        }
    });

    it('takes an unknown period as the default and a clock that ran backwards as the start', () => {
        assert.deepEqual(pulsePhase(5000, 5000 + 900, 1234), pulsePhase(5000, 5000 + 900, DEFAULT_PULSE_PERIOD_MS));
        assert.deepEqual(pulsePhase(5000, 4000, 800), { on: true, changeAt: 5400 });
    });

    it('changes phase twice a period: 2.5 commands a second at the fastest, never a stream', () => {
        const start = 0;
        let changes = 0;
        let on = pulsePhase(start, start, 800).on;
        for (let t = 1; t <= 10_000; t++) {
            const now = pulsePhase(start, t, 800).on;
            if (now !== on) changes += 1;
            on = now;
        }
        assert.equal(changes, 25);
    });
});

describe('pulseLevel', () => {
    it('is the peak while on and 0 while off', () => {
        assert.equal(pulseLevel(0.5, true), 0.5);
        assert.equal(pulseLevel(0.5, false), 0);
    });

    it('is 0 whatever the phase once there is no peak', () => {
        for (const peak of [0, -0.2, NaN, null, undefined, 'x']) assert.equal(pulseLevel(peak, true), 0);
    });
});
