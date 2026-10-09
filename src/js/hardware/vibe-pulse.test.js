import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    VIBE_MODES,
    DEFAULT_VIBE_MODE,
    PULSE_PERIODS_MS,
    DEFAULT_PULSE_PERIOD_MS,
    readVibeMode,
    readPulsePeriod,
    pulsePhrase,
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

describe('pulsePhase: a run, then a short rest, not a clock', () => {
    it('starts on, and the first rest is a beat after a run of a few beats', () => {
        for (const period of PULSE_PERIODS_MS) {
            const start = 1_000_000;
            const first = pulsePhrase(0, period);
            assert.ok(first.runMs >= period * 2, `${period}: the run is only ${first.runMs}`);
            assert.ok(first.restMs <= period, `${period}: the rest is ${first.restMs}, longer than a beat`);
            assert.ok(first.runMs > first.restMs * 2, `${period}: the rest is half the phrase`);
            assert.deepEqual(pulsePhase(start, start, period), { on: true, changeAt: start + first.runMs });
            assert.equal(pulsePhase(start, start + first.runMs - 1, period).on, true);
            assert.deepEqual(pulsePhase(start, start + first.runMs, period), { on: false, changeAt: start + first.runMs + first.restMs });
            const back = pulsePhase(start, start + first.runMs + first.restMs, period);
            assert.equal(back.on, true);
            assert.ok(back.changeAt > start + first.runMs + first.restMs);
        }
    });

    it('does not repeat one on/off length', () => {
        const runs = [];
        const rests = [];
        for (let i = 0; i < 6; i += 1) {
            const phrase = pulsePhrase(i, 1600);
            runs.push(phrase.runMs);
            rests.push(phrase.restMs);
        }
        assert.ok(new Set(runs).size >= 4, `runs collapsed to ${runs.join(',')}`);
        assert.ok(new Set(rests).size >= 3, `rests collapsed to ${rests.join(',')}`);
    });

    it('takes an unknown period as the default and a clock that ran backwards as the start', () => {
        assert.deepEqual(pulsePhase(5000, 5000 + 900, 1234), pulsePhase(5000, 5000 + 900, DEFAULT_PULSE_PERIOD_MS));
        const first = pulsePhrase(0, 800);
        assert.deepEqual(pulsePhase(5000, 4000, 800), { on: true, changeAt: 5000 + first.runMs });
    });

    it('is on most of the time, and a shorter spacing rests more often', () => {
        const duty = (period, span) => {
            const start = 0;
            let on = 0;
            let changes = 0;
            let was = pulsePhase(start, start, period).on;
            for (let t = 1; t <= span; t += 1) {
                const now = pulsePhase(start, t, period).on;
                if (now) on += 1;
                if (now !== was) changes += 1;
                was = now;
            }
            return { on, changes };
        };
        const quick = duty(800, 60_000);
        const slow = duty(2400, 60_000);
        assert.ok(quick.on > 60_000 * 0.7, `on for only ${quick.on} ms of a minute`);
        assert.ok(quick.changes > slow.changes, `800 ms rested ${quick.changes} times, 2400 ms rested ${slow.changes}`);
        // A square wave at 0.8 s would change 150 times a minute. This must not.
        assert.ok(quick.changes < 80, `changed ${quick.changes} times, which is a clock`);
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
