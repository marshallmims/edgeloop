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
    it('knows Constant and Pulsed, and Pulsed is the default', () => {
        assert.deepEqual([...VIBE_MODES], ['constant', 'pulsed']);
        assert.equal(DEFAULT_VIBE_MODE, 'pulsed');
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

describe('pulsePhase: ramps, then a rest, not a clock', () => {
    it('starts on a rise, and the first rest comes after more than one ramp', () => {
        for (const period of PULSE_PERIODS_MS) {
            const start = 1_000_000;
            const first = pulsePhrase(0, period);
            const rises = first.segments.filter((segment) => segment.kind === 'rise').length;
            assert.ok(rises >= 2, `${period}: only ${rises} rises`);
            assert.ok(first.runMs > first.restMs * 2, `${period}: the rest is most of the phrase`);
            const opened = pulsePhase(start, start, period);
            assert.ok(opened.gain > 0 && opened.gain < 0.5, `opened at ${opened.gain}, which is not the start of a rise`);
            assert.ok(opened.changeAt > start);
            let cursor = start;
            let sawFall = false;
            let restAt = 0;
            for (let step = 0; step < 40; step += 1) {
                const phase = pulsePhase(start, cursor, period);
                if (phase.gain > 0.8) sawFall = true;
                if (phase.gain === 0) {
                    restAt = cursor;
                    break;
                }
                cursor = phase.changeAt;
            }
            assert.ok(sawFall, `${period}: the phrase never reached a peak`);
            assert.ok(restAt > start + first.runMs - 1, `${period}: the rest arrived before the ramps finished`);
        }
    });

    it('does not repeat one phrase length', () => {
        const runs = [];
        const rests = [];
        for (let i = 0; i < 4; i += 1) {
            const phrase = pulsePhrase(i, 1600);
            runs.push(phrase.runMs);
            rests.push(phrase.restMs);
        }
        assert.ok(new Set(runs).size >= 3, `runs collapsed to ${runs.join(',')}`);
        assert.ok(new Set(rests).size >= 2, `rests collapsed to ${rests.join(',')}`);
    });

    it('takes an unknown period as the default and a clock that ran backwards as the start', () => {
        assert.deepEqual(pulsePhase(5000, 5000 + 900, 1234), pulsePhase(5000, 5000 + 900, DEFAULT_PULSE_PERIOD_MS));
        const opened = pulsePhase(5000, 4000, 800);
        assert.ok(opened.gain > 0);
        assert.equal(opened.changeAt, 5000 + 200);
    });

    it('is moving most of the time, and a shorter spacing rests more often', () => {
        const duty = (period, span) => {
            const start = 0;
            let on = 0;
            let rests = 0;
            let was = pulsePhase(start, start, period).on;
            for (let t = 1; t <= span; t += 1) {
                const now = pulsePhase(start, t, period).on;
                if (now) on += 1;
                if (was && !now) rests += 1;
                was = now;
            }
            return { on, rests };
        };
        const quick = duty(800, 60_000);
        const slow = duty(2400, 60_000);
        assert.ok(quick.on > 60_000 * 0.7, `on for only ${quick.on} ms of a minute`);
        assert.ok(quick.rests > slow.rests, `800 ms rested ${quick.rests} times, 2400 ms rested ${slow.rests}`);
        assert.ok(quick.rests < 40, `rested ${quick.rests} times, which is a clock`);
    });
});

describe('pulseLevel', () => {
    it('is the peak times the ramp, and 0 on a rest', () => {
        assert.equal(pulseLevel(0.5, 1), 0.5);
        assert.equal(pulseLevel(0.5, 0.5), 0.25);
        assert.equal(pulseLevel(0.5, 0), 0);
    });

    it('is 0 whatever the phase once there is no peak', () => {
        for (const peak of [0, -0.2, NaN, null, undefined, 'x']) assert.equal(pulseLevel(peak, 1), 0);
    });
});
