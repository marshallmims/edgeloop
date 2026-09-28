import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    MIN_CEILING_GAP,
    ORGASM_BOOST_CAP,
    SURVIVAL_BREACH_TICKS,
    sanitizeHrLimits,
    computeEffectiveCeiling,
    parseSessionDuration,
    oracleTiming,
    rollOracleFate,
    tickEdgeTraining,
    clampTrainHoldSeconds,
    clampTrainEdges,
    DEFAULT_TRAIN_HOLD_SECONDS,
    DEFAULT_TRAIN_EDGES,
    MIN_TRAIN_HOLD_SECONDS,
    MAX_TRAIN_HOLD_SECONDS,
    MIN_TRAIN_EDGES,
    MAX_TRAIN_EDGES,
    countSurvivalBreach,
    isSurvivalDefeated,
    survivalDrive,
    calibrationReading,
    calibrationDualOffset,
    SURVIVAL_START_FLOOR,
    SURVIVAL_OVERDRIVE_CAP,
    SURVIVAL_EDGE_BPM,
    endgameKeepsOrgasmLatch,
    describeGameNotice,
    describeCutoffNotice,
    MIN_STALL_GUARD_SECONDS,
    MAX_STALL_GUARD_SECONDS,
    DEFAULT_STALL_GUARD_SECONDS,
    MIN_STALL_PAUSE_SECONDS,
    MAX_STALL_PAUSE_SECONDS,
    DEFAULT_STALL_PAUSE_SECONDS,
    clampStallGuardSeconds,
    clampStallPauseSeconds,
    tickStallGuard,
    describeStallPauseNotice,
    sanitizeStoredHrLimits,
    sanitizeStoredDuration,
    sanitizeStoredEndgame,
    sanitizeSessionLimits,
    DEFAULT_MIN_HR,
    DEFAULT_MAX_HR,
    DEFAULT_DURATION_MODE,
    DEFAULT_FIXED_MINUTES,
    DEFAULT_RANGE_MIN_MINUTES,
    DEFAULT_RANGE_MAX_MINUTES,
    DEFAULT_ENDGAME_TYPE
} from './session-rules.js';

describe('sanitizeHrLimits', () => {
    it('parses typed strings', () => {
        assert.deepEqual(sanitizeHrLimits('70', '140'), { minHr: 70, maxHr: 140, valid: true, invalid: [] });
    });

    it('falls back to the last known-good value on garbage and flags the field', () => {
        const out = sanitizeHrLimits('abc', '', { minHr: 65, maxHr: 150 });
        assert.equal(out.minHr, 65);
        assert.equal(out.maxHr, 150);
        assert.equal(out.valid, false);
        assert.deepEqual(out.invalid, ['min', 'max']);
    });

    it('never raises a typed ceiling: an inverted pair is kept but flagged', () => {
        const out = sanitizeHrLimits(140, 120);
        assert.equal(out.minHr, 140);
        assert.equal(out.maxHr, 120);
        assert.equal(out.valid, false);
    });

    it('rejects physiologically impossible numbers', () => {
        assert.equal(sanitizeHrLimits(70, 999).valid, false);
        assert.equal(sanitizeHrLimits(-5, 140).valid, false);
    });
});

describe('computeEffectiveCeiling', () => {
    const base = { minHr: 70, maxHr: 140 };

    it('returns the typed ceiling when nothing is active', () => {
        const out = computeEffectiveCeiling(base);
        assert.equal(out.maxHr, 140);
        assert.equal(out.minHr, 70);
        assert.equal(out.orgasmBoost, 0);
    });

    it('stacks learned, dual-stim and decay offsets downward', () => {
        const out = computeEffectiveCeiling({
            ...base,
            learnedOffset: 5,
            dualStimActive: true,
            dualDampening: true,
            dualDampeningBpm: 15,
            adaptiveDecay: true,
            edges: 4,
            decayEdgeCount: 2,
            decayBpm: 2,
            decayFloor: 100
        });
        assert.equal(out.learnedOffset, 5);
        assert.equal(out.dualOffset, 15);
        assert.equal(out.totalDecay, 4);
        assert.equal(out.appliedDecay, 4);
        assert.equal(out.maxHr, 140 - 5 - 15 - 4);
    });

    it('decay floor stops the decay but never raises the ceiling', () => {
        // Typed ceiling 100 with a 105 floor: the old code lifted max to 105.
        const out = computeEffectiveCeiling({
            minHr: 70,
            maxHr: 100,
            adaptiveDecay: true,
            edges: 2,
            decayEdgeCount: 2,
            decayBpm: 2,
            decayFloor: 105
        });
        assert.equal(out.maxHr, 100);
        assert.equal(out.appliedDecay, 0);
        assert.equal(out.decayFloored, true);
    });

    it('decay floor is clamped to min + gap', () => {
        const out = computeEffectiveCeiling({
            minHr: 100,
            maxHr: 140,
            adaptiveDecay: true,
            edges: 40,
            decayEdgeCount: 1,
            decayBpm: 5,
            decayFloor: 80
        });
        assert.equal(out.maxHr, 100 + MIN_CEILING_GAP);
    });

    it('offsets never pull the ceiling below min + gap', () => {
        const out = computeEffectiveCeiling({ minHr: 120, maxHr: 140, learnedOffset: 30, dualStimActive: true, dualDampening: true });
        assert.equal(out.maxHr, 120 + MIN_CEILING_GAP);
    });

    it('a typed ceiling closer than the gap is honoured, not raised', () => {
        const out = computeEffectiveCeiling({ minHr: 130, maxHr: 138, learnedOffset: 10 });
        assert.equal(out.maxHr, 138);
    });

    it('ignores non-finite offsets', () => {
        const out = computeEffectiveCeiling({ ...base, learnedOffset: NaN, adaptiveDecay: true, edges: NaN });
        assert.equal(out.maxHr, 140);
    });

    it('applies and caps the orgasm boost', () => {
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 12 }).maxHr, 152);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 500 }).maxHr, 140 + ORGASM_BOOST_CAP);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: -3 }).maxHr, 140);
    });

    it('adds Survival overdrive on top of the typed max and caps it', () => {
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: 8 }).maxHr, 148);
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: 500 }).maxHr, 140 + SURVIVAL_OVERDRIVE_CAP);
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: -4 }).maxHr, 140);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 5, survivalOverdrive: 3 }).maxHr, 148);
    });
});

describe('parseSessionDuration', () => {
    it('endless is always zero', () => {
        assert.deepEqual(parseSessionDuration({ mode: 'endless' }), {
            targetSeconds: 0, minSeconds: 0, maxSeconds: 0, fixedLength: false, valid: true, invalid: []
        });
    });

    it('fixed uses the typed minutes as both ends of the window', () => {
        const out = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        assert.equal(out.targetSeconds, 1800);
        assert.equal(out.minSeconds, 1800);
        assert.equal(out.maxSeconds, 1800);
        assert.equal(out.fixedLength, true);
    });

    it('only a Fixed length reports fixedLength, however the range was typed', () => {
        // The seconds alone cannot tell a Fixed 30 from a Mystery typed 30-30,
        // and the Oracle treats the two completely differently. This flag is
        // the only thing that carries the difference.
        const fixed = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        const collapsed = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '30' });
        assert.equal(collapsed.targetSeconds, fixed.targetSeconds);
        assert.equal(collapsed.minSeconds, fixed.minSeconds);
        assert.equal(collapsed.maxSeconds, fixed.maxSeconds);
        assert.equal(collapsed.fixedLength, false, 'a Mystery is never a Fixed length');
        for (const spread of [['30', '60'], ['5', '5'], ['90', '90']]) {
            const out = parseSessionDuration({
                mode: 'range', minMinutes: spread[0], maxMinutes: spread[1], random: () => 0
            });
            assert.equal(out.fixedLength, false);
        }
        assert.equal(parseSessionDuration({ mode: 'endless' }).fixedLength, false);
        assert.equal(parseSessionDuration({ mode: 'fixed', fixedMinutes: 'abc' }).fixedLength, false);
    });

    it('fixed rejects zero, negative and non-numeric values', () => {
        for (const bad of ['0', '-4', 'abc', '', null, undefined, NaN]) {
            const out = parseSessionDuration({ mode: 'fixed', fixedMinutes: bad });
            assert.equal(out.valid, false, `fixed ${String(bad)} should be invalid`);
            assert.equal(out.targetSeconds, 0);
            assert.deepEqual(out.invalid, ['fixed']);
        }
    });

    it('range picks inside the window inclusive', () => {
        const lo = parseSessionDuration({ mode: 'range', minMinutes: 25, maxMinutes: 45, random: () => 0 });
        const hi = parseSessionDuration({ mode: 'range', minMinutes: 25, maxMinutes: 45, random: () => 0.9999 });
        assert.equal(lo.targetSeconds, 25 * 60);
        assert.equal(hi.targetSeconds, 45 * 60);
        const same = parseSessionDuration({ mode: 'range', minMinutes: 10, maxMinutes: 10, random: () => 0.5 });
        assert.equal(same.targetSeconds, 600);
        assert.equal(lo.minSeconds, 25 * 60);
        assert.equal(hi.maxSeconds, 45 * 60);
    });

    it('range flags an inverted window and falls back to endless', () => {
        const out = parseSessionDuration({ mode: 'range', minMinutes: 45, maxMinutes: 25 });
        assert.equal(out.valid, false);
        assert.equal(out.targetSeconds, 0);
        assert.ok(out.invalid.includes('min') && out.invalid.includes('max'));
    });

    it('range flags only the broken field', () => {
        const out = parseSessionDuration({ mode: 'range', minMinutes: 'x', maxMinutes: 40 });
        assert.deepEqual(out.invalid, ['min']);
        assert.equal(out.targetSeconds, 0);
    });
});

describe('oracle timing and fate', () => {
    it('blocks climax and denial before the mystery minimum', () => {
        const early = oracleTiming({ sessionSeconds: 5 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(early.canEnd, false);
        assert.equal(early.mustEnd, false);
        assert.equal(rollOracleFate(early, { random: () => 0 }), 'PURGATORY');
        assert.equal(rollOracleFate(early, { random: () => 0.99 }), 'PURGATORY');
    });

    it('opens the window at min and forces an ending at max', () => {
        const open = oracleTiming({ sessionSeconds: 30 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(open.canEnd, true);
        assert.equal(open.mustEnd, false);
        assert.equal(rollOracleFate(open, { random: () => 0 }), 'PURGATORY');
        const late = oracleTiming({ sessionSeconds: 42 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(late.mustEnd, true);
        const stillOpen = oracleTiming({ sessionSeconds: 40 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(stillOpen.mustEnd, false);
        assert.equal(stillOpen.canEnd, true);
        assert.equal(rollOracleFate(late, { random: () => 0.9, endgameType: 'orgasm' }), 'CLIMAX');
        assert.equal(rollOracleFate(late, { random: () => 0.1, endgameType: 'denial' }), 'DENIAL');
    });

    it('endless has no clock so any hold may end', () => {
        const open = oracleTiming({ sessionSeconds: 12, minSeconds: 0, maxSeconds: 0, targetSeconds: 0 });
        assert.equal(open.canEnd, true);
        assert.equal(open.mustEnd, false);
        assert.equal(rollOracleFate(open, { random: () => 0.5 }), 'CLIMAX');
    });

    it('a Fixed length still gives the Oracle a window to roll in', () => {
        // Fixed hands min === max === target, which used to leave a
        // zero-width window: every hold of the whole session was PURGATORY
        // and the game never chose anything.
        const fixed = (t) => oracleTiming({
            sessionSeconds: t, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
        const early = fixed(5 * 60);
        assert.equal(early.canEnd, false);
        assert.equal(rollOracleFate(early, { random: () => 0.99 }), 'PURGATORY');

        const open = fixed(16 * 60);
        assert.equal(open.canEnd, true, 'the window opens inside the session');
        assert.equal(open.mustEnd, false);
        assert.equal(open.openAt, 900);
        assert.equal(open.closeAt, 1800);
        assert.ok(rollOracleFate(open, { random: () => 0.99 }) !== 'PURGATORY');

        const due = fixed(1800);
        assert.equal(due.mustEnd, true);
        assert.equal(rollOracleFate(due, { random: () => 0.9, endgameType: 'orgasm' }), 'CLIMAX');
    });

    it('a Mystery target on the minimum still honours the typed minimum', () => {
        // 1 roll in 21 lands the secret target on the wearer's minimum. The
        // window is NOT halved there: they typed 30 minutes to mean "do not
        // finish me before then", and they cannot see the roll, so climax and
        // denial stay locked until the minimum exactly as the README and the
        // mode card promise. Only a FIXED length (min === max === target)
        // opens halfway, because its window is otherwise zero-width.
        const timing = oracleTiming({ sessionSeconds: 20 * 60, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(timing.openAt, 1800);
        assert.equal(timing.canEnd, false, 'locked before the typed minimum');
        assert.equal(timing.mustEnd, false);

        const atMin = oracleTiming({ sessionSeconds: 1800, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(atMin.canEnd, true);
        assert.equal(atMin.mustEnd, true, 'the rolled target is still the latest it waits');

        // Half the typed minimum is the number the old rule unlocked at.
        const half = oracleTiming({ sessionSeconds: 901, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(half.canEnd, false, 'never at half the minimum the wearer typed');

        // A Fixed length keeps its documented halfway ramp.
        const fixedRun = oracleTiming({
            sessionSeconds: 901, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
        assert.equal(fixedRun.openAt, 900);
        assert.equal(fixedRun.canEnd, true);
    });

    it('a Mystery typed with one number in both boxes still honours that minimum', () => {
        // 30-30 hands out exactly the seconds a Fixed 30 does, and the old
        // rule read the numbers alone: it unlocked climax - which arms Force
        // Orgasm - and denial at 15 minutes, half the minimum the wearer
        // typed. A Mystery minimum is a promise whatever the spread.
        const mystery = (t) => oracleTiming({
            sessionSeconds: t, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800
        });
        const half = mystery(901);
        assert.equal(half.openAt, 1800, 'never halfway through a typed Mystery minimum');
        assert.equal(half.canEnd, false);
        assert.equal(rollOracleFate(half, { random: () => 0.99 }), 'PURGATORY');

        const due = mystery(1800);
        assert.equal(due.canEnd, true);
        assert.equal(due.mustEnd, true, 'and it ends there, the way the target says');
        assert.equal(rollOracleFate(due, { random: () => 0.9, endgameType: 'rampdown' }), 'RAMPDOWN');

        // The same numbers typed as a FIXED length keep the halfway ramp.
        const fixed = oracleTiming({
            sessionSeconds: 901, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
        assert.equal(fixed.openAt, 900);
        assert.equal(fixed.canEnd, true);
    });

    it('end to end: only the Fixed card opens the window halfway', () => {
        // The two parses that produce identical seconds, fed straight into
        // the timing the way app.js feeds them.
        const at = (parsed, t) => oracleTiming({
            sessionSeconds: t,
            minSeconds: parsed.minSeconds,
            maxSeconds: parsed.maxSeconds,
            targetSeconds: parsed.targetSeconds,
            fixedLength: parsed.fixedLength
        });
        const fixed = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        const mystery = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '30' });
        assert.equal(at(fixed, 901).canEnd, true);
        assert.equal(at(mystery, 901).canEnd, false);
        assert.equal(at(mystery, 1800).mustEnd, true);
        // A wide Mystery is unchanged by any of this.
        const wide = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '60', random: () => 0.5 });
        assert.equal(at(wide, 1799).canEnd, false);
        assert.equal(at(wide, 1800).canEnd, true);
    });

    it('later holds inside the window are likelier to end the session', () => {
        const at = (t) => oracleTiming({ sessionSeconds: t, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 45 * 60 });
        assert.equal(rollOracleFate(at(30 * 60), { random: () => 0.5 }), 'PURGATORY');
        assert.ok(rollOracleFate(at(44 * 60), { random: () => 0.5 }) !== 'PURGATORY');
        // The ramp is monotone: the purgatory share only ever shrinks.
        let previous = 100;
        for (let t = 30 * 60; t <= 45 * 60; t += 60) {
            let purgatory = 0;
            for (let r = 0; r < 100; r++) {
                if (rollOracleFate(at(t), { random: () => r / 100 }) === 'PURGATORY') purgatory++;
            }
            assert.ok(purgatory <= previous, `purgatory share rose at ${t / 60} min`);
            previous = purgatory;
        }
    });

    it('a forced ending honours Soft Landing instead of flipping a coin', () => {
        const due = oracleTiming({ sessionSeconds: 45 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 45 * 60 });
        assert.equal(due.mustEnd, true);
        // Every roll: the wearer asked for a tease-down, not a 50/50 that
        // can arm Force Orgasm on their behalf.
        for (let r = 0; r < 100; r++) {
            assert.equal(rollOracleFate(due, { random: () => r / 100, endgameType: 'rampdown' }), 'RAMPDOWN');
        }
        // An unknown endgame still resolves to an ending, never to nothing.
        assert.ok(['CLIMAX', 'DENIAL'].includes(rollOracleFate(due, { random: () => 0.2, endgameType: 'mystery-meat' })));
    });
});

describe('survival climb', () => {
    it('stays gentle for a long while and steps up on each edge', () => {
        const start = survivalDrive({ seconds: 0, edges: 0 });
        assert.equal(start.floor, SURVIVAL_START_FLOOR);
        assert.equal(start.overdriveBpm, 0);
        const fiveMin = survivalDrive({ seconds: 5 * 60, edges: 0 });
        assert.ok(fiveMin.floor < 40, `five minutes was already ${fiveMin.floor}%`);
        const halfHour = survivalDrive({ seconds: 30 * 60, edges: 0 });
        assert.ok(halfHour.floor > 50 && halfHour.floor < 80, `thirty minutes was ${halfHour.floor}%`);
        const edged = survivalDrive({ seconds: 30 * 60, edges: 12 });
        assert.equal(edged.overdriveBpm, 12 * SURVIVAL_EDGE_BPM);
        assert.ok(edged.floor > halfHour.floor);
        const capped = survivalDrive({ seconds: 90 * 60, edges: 80 });
        assert.equal(capped.floor, 100);
        assert.equal(capped.overdriveBpm, SURVIVAL_OVERDRIVE_CAP);
    });

    it('does not end the session when the pulse crosses the max', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.equal(src.includes('Survival Defeat'), false);
        assert.equal(src.includes('isSurvivalDefeated'), false);
    });

    it('saves a primary calibration from Finished me, and a both-toys gap as the offset', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.equal(html.includes('survivalCameBtn'), false);
        assert.equal(html.includes('survivalCalibrateToggle'), false);
        assert.match(html, /id="cameEarlyLabel"[^>]*>Came Early</);
        assert.match(html, /id="calibrateBtn"/);
        assert.match(html, /id="wizardCalibrateBtn"/);
        assert.match(src, /Finished me/);
        const handler = src.match(/cameEarlyBtn\?\.addEventListener\([\s\S]*?stopSession\("Premature Release"/);
        assert.ok(handler, 'Finished me has no handler on the Came Early button');
        assert.match(handler[0], /activeMode === 'calibrate'/);
        assert.match(handler[0], /activeMode === 'survival'/);
        assert.match(handler[0], /calibrationDualOffset/);
        assert.match(handler[0], /savePrimaryClimax/);
        assert.match(handler[0], /confirm\(/);
        const calibrateBranch = handler[0].split("activeMode === 'survival'")[0];
        assert.equal(calibrateBranch.includes('suggestedMaxHrOffset'), false);
        assert.match(handler[0], /isRemotePage/);
        assert.match(src, /suggestedMaxHrOffset/);
    });
});

describe('calibration readings', () => {
    it('keeps a climax heart rate and refuses anything outside 40–220', () => {
        assert.equal(calibrationReading(135.4), 135);
        assert.equal(calibrationReading(40), 40);
        assert.equal(calibrationReading(220), 220);
        assert.equal(calibrationReading(39), null);
        assert.equal(calibrationReading(221), null);
        assert.equal(calibrationReading(NaN), null);
    });

    it('turns the gap under the primary climax into a dual-stim offset', () => {
        assert.equal(calibrationDualOffset(150, 135), 15);
        assert.equal(calibrationDualOffset(160, 120), 30);
        assert.equal(calibrationDualOffset(140, 137), null);
        assert.equal(calibrationDualOffset(135, 150), null);
        assert.equal(calibrationDualOffset(null, 120), null);
    });
});

describe('survival breach counter', () => {
    it('counts consecutive ticks at or above the ceiling and resets below it', () => {
        let ticks = 0;
        ticks = countSurvivalBreach(ticks, 141, 140);
        ticks = countSurvivalBreach(ticks, 140, 140);
        assert.equal(ticks, 2);
        assert.equal(isSurvivalDefeated(ticks), false);
        ticks = countSurvivalBreach(ticks, 139, 140);
        assert.equal(ticks, 0);
    });

    it('defeats only after the configured streak', () => {
        let ticks = 0;
        for (let i = 0; i < SURVIVAL_BREACH_TICKS; i++) ticks = countSurvivalBreach(ticks, 150, 140);
        assert.equal(isSurvivalDefeated(ticks), true);
    });

    it('treats non-finite readings as no breach', () => {
        assert.equal(countSurvivalBreach(2, NaN, 140), 0);
        assert.equal(countSurvivalBreach(2, 150, NaN), 0);
    });

    it('a tick without a new reading leaves the streak untouched', () => {
        // A watch pushing every 5 s holds one spike across five ticks.
        let ticks = countSurvivalBreach(0, 141, 140);
        for (let i = 0; i < 4; i++) ticks = countSurvivalBreach(ticks, 141, 140, false);
        assert.equal(ticks, 1);
        assert.equal(isSurvivalDefeated(ticks), false);
        ticks = countSurvivalBreach(ticks, 139, 140, false);
        assert.equal(ticks, 1, 'a held value is not a new reading below the ceiling either');
        ticks = countSurvivalBreach(ticks, 139, 140, true);
        assert.equal(ticks, 0);
    });
});

describe('stall guard', () => {
    it('clamps the typed timeouts to their ranges and falls back on garbage', () => {
        assert.equal(clampStallGuardSeconds(-5), MIN_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('200'), MAX_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('12'), 12);
        assert.equal(clampStallGuardSeconds('99'), 99);
        assert.equal(clampStallGuardSeconds('abc'), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(undefined), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(NaN), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(MAX_STALL_GUARD_SECONDS, 120);
        assert.equal(DEFAULT_STALL_GUARD_SECONDS, 20);
        assert.equal(clampStallPauseSeconds(1), MIN_STALL_PAUSE_SECONDS);
        assert.equal(clampStallPauseSeconds(99), MAX_STALL_PAUSE_SECONDS);
        assert.equal(clampStallPauseSeconds('8'), 8);
        assert.equal(clampStallPauseSeconds('nope'), DEFAULT_STALL_PAUSE_SECONDS);
        assert.equal(DEFAULT_STALL_PAUSE_SECONDS, 8);
        assert.equal(MIN_STALL_PAUSE_SECONDS, 2);
        assert.equal(MAX_STALL_PAUSE_SECONDS, 60);
    });

    it('counts the hold window while armed and edged, then pauses, then resumes', () => {
        let g = { holdSeconds: 0, pauseSeconds: 0, engaged: false };
        const opts = { armed: true, isEdged: true, holdTimeoutSeconds: 3, pauseTimeoutSeconds: 2 };
        for (let i = 0; i < 2; i++) g = tickStallGuard(g, opts);
        assert.equal(g.holdSeconds, 2);
        assert.equal(g.engaged, false);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, true);
        assert.equal(g.justEngaged, true);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, true);
        assert.equal(g.pauseSeconds, 1);
        assert.equal(g.justEngaged, false);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, false);
        assert.equal(g.justResumed, true);
        assert.equal(g.holdSeconds, 0);
        // A negative hold timeout is clamped, so the guard cannot fire on the first tick.
        assert.equal(tickStallGuard({ holdSeconds: 0 }, { armed: true, isEdged: true, holdTimeoutSeconds: -5, pauseTimeoutSeconds: 8 }).engaged, false);
    });

    it('releases at once when disarmed while engaged, even with the pulse still at the ceiling', () => {
        const engaged = { holdSeconds: 9, pauseSeconds: 1, engaged: true };
        const off = tickStallGuard(engaged, { armed: false, isEdged: true, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(off.engaged, false);
        assert.equal(off.justReleased, true);
        assert.equal(off.holdSeconds, 0);
        const released = tickStallGuard(engaged, { armed: true, isEdged: false, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(released.engaged, false);
        assert.equal(released.justReleased, true);
        const idle = tickStallGuard({ holdSeconds: 0, engaged: false }, { armed: false, isEdged: true, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(idle.justReleased, false);
    });
});

describe('edge training', () => {
    it('clamps hold seconds and edge counts', () => {
        assert.equal(clampTrainHoldSeconds(15), 15);
        assert.equal(clampTrainHoldSeconds(2), MIN_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainHoldSeconds(400), MAX_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainHoldSeconds('nope'), DEFAULT_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainEdges(5), 5);
        assert.equal(clampTrainEdges(0), MIN_TRAIN_EDGES);
        assert.equal(clampTrainEdges(99), MAX_TRAIN_EDGES);
        assert.equal(clampTrainEdges('x'), DEFAULT_TRAIN_EDGES);
    });

    it('counts a full hold as one edge and finishes at the goal', () => {
        let t = { state: 'climb', holdSeconds: 0, edgesDone: 0 };
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.state, 'hold');
        assert.equal(t.justHold, true);
        assert.equal(t.holdSeconds, 1);
        for (let i = 0; i < 3; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        }
        assert.equal(t.state, 'hold');
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.justCounted, true);
        assert.equal(t.edgesDone, 1);
        assert.equal(t.state, 'recover');
        t = tickEdgeTraining(t, { isEdged: false, released: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.state, 'climb');
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        for (let i = 0; i < 4; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        }
        assert.equal(t.state, 'finish');
        assert.equal(t.justFinished, true);
        assert.equal(t.edgesDone, 2);
    });

    it('Force Orgasm suspends training instead of completing it', () => {
        // Tapping Force Orgasm is not five held edges: the counter and the
        // state must be exactly where the wearer left them.
        const fresh = tickEdgeTraining(
            { state: 'climb', holdSeconds: 0, edgesDone: 0 },
            { isEdged: false, holdGoal: 15, edgesGoal: 5, orgasmMode: true }
        );
        assert.equal(fresh.state, 'climb');
        assert.equal(fresh.edgesDone, 0);
        assert.equal(fresh.justFinished, false);

        const mid = tickEdgeTraining(
            { state: 'hold', holdSeconds: 3, edgesDone: 1 },
            { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: true }
        );
        assert.equal(mid.state, 'hold');
        assert.equal(mid.holdSeconds, 3, 'the hold clock is frozen, not advanced');
        assert.equal(mid.edgesDone, 1);

        // Cancelling it hands the game back unchanged.
        const back = tickEdgeTraining(mid, { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: false });
        assert.equal(back.state, 'hold');
        assert.equal(back.holdSeconds, 4);
        assert.equal(back.edgesDone, 1);
    });

    it('holds the finish while Force Orgasm runs and returns to the climb when it is cancelled', () => {
        const finished = { state: 'finish', holdSeconds: 0, edgesDone: 5 };
        const forcing = tickEdgeTraining(finished, { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: true });
        assert.equal(forcing.state, 'finish');
        assert.equal(forcing.edgesDone, 5);
        assert.equal(forcing.justFinished, false, 'finishing must be announced once, not every second');

        // The wearer cancels Force Orgasm: the game leaves the terminal state
        // the way the Oracle leaves CLIMAX, so the session can end normally.
        const withdrawn = tickEdgeTraining(finished, { isEdged: false, released: true, holdGoal: 15, edgesGoal: 5, orgasmMode: false });
        assert.equal(withdrawn.state, 'climb');
        assert.equal(withdrawn.justFinished, false);
        // The set is over and the wearer said no, so a NEW set starts. If the
        // counter stayed at the goal the very next hold would re-arm Force
        // Orgasm, seconds after it was deliberately cancelled.
        assert.equal(withdrawn.edgesDone, 0, 'withdrawal starts a fresh set');
    });

    it('cancelling the finish cannot re-arm Force Orgasm on the next hold', () => {
        const withdrawn = tickEdgeTraining(
            { state: 'finish', holdSeconds: 0, edgesDone: 3 },
            { isEdged: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false }
        );
        assert.equal(withdrawn.state, 'climb');
        assert.equal(withdrawn.edgesDone, 0);

        // One full hold from here counts an edge but must NOT finish again.
        let t = withdrawn;
        for (let i = 0; i < MIN_TRAIN_HOLD_SECONDS; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
        }
        assert.equal(t.edgesDone, 1);
        assert.equal(t.justFinished, false, 'one hold must never re-arm a cancelled Force Orgasm');
        assert.notEqual(t.state, 'finish');

        // The training still works: the full set finishes it again.
        while (t.edgesDone < 3 && !t.justFinished) {
            t = tickEdgeTraining(t, { isEdged: true, released: false, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
            if (t.state === 'recover') {
                t = tickEdgeTraining(t, { isEdged: false, released: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
            }
        }
        assert.equal(t.state, 'finish');
        assert.equal(t.edgesDone, 3);
        assert.equal(t.justFinished, true);
    });

    it('a dropped hold does not count', () => {
        let t = tickEdgeTraining({ state: 'climb' }, { isEdged: true, holdGoal: 8, edgesGoal: 3 });
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 8, edgesGoal: 3 });
        t = tickEdgeTraining(t, { isEdged: false, holdGoal: 8, edgesGoal: 3 });
        assert.equal(t.justDropped, true);
        assert.equal(t.edgesDone, 0);
        assert.equal(t.state, 'recover');
    });
});

describe('the endgame and a latched Force Orgasm', () => {
    it('only the Orgasm ending keeps the latch', () => {
        assert.equal(endgameKeepsOrgasmLatch('orgasm'), true);
        assert.equal(endgameKeepsOrgasmLatch('rampdown'), false, 'a Soft Landing is not run at 85-100%');
        assert.equal(endgameKeepsOrgasmLatch('denial'), false);
        for (const junk of ['', null, undefined, 'mystery-meat']) {
            assert.equal(endgameKeepsOrgasmLatch(junk), false, `an unknown ending must not keep the latch`);
        }
    });

    it('app.js clears the latch before it runs a Soft Landing', () => {
        // The helper is worthless unless the cockpit asks it on the way in:
        // Force Orgasm keeps driving the toys and raising the ceiling for as
        // long as it is latched, so a Soft Landing reached with it still on
        // would not be the gentle ending.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const fn = src.match(/function handleTargetTimeReached\(\)[\s\S]*?\n}/);
        assert.ok(fn, 'handleTargetTimeReached anchor moved');
        assert.ok(
            /endgameKeepsOrgasmLatch\(/.test(fn[0]),
            `the endgame must decide what happens to the latch: ${fn[0]}`
        );
        assert.ok(/setOrgasmMode\(false\)/.test(fn[0]), 'and actually clear it');
        const clear = fn[0].indexOf('setOrgasmMode(false)');
        const ramp = fn[0].indexOf("'rampdown'");
        assert.ok(clear >= 0 && ramp >= 0 && clear < ramp, 'the latch must be cleared before the rampdown starts');
    });
});

describe('the cockpit game banner', () => {
    const oracle = { activeMode: 'oracle', sessionStatus: 'RUNNING' };
    const train = { activeMode: 'edgetrain', sessionStatus: 'RUNNING' };

    it('says nothing outside a game or outside a live session', () => {
        assert.equal(describeGameNotice({ activeMode: 'classic', sessionStatus: 'RUNNING' }), '');
        assert.equal(describeGameNotice({ ...oracle, sessionStatus: 'PAUSED' }), '');
        assert.equal(describeGameNotice({ ...oracle, sessionStatus: 'IDLE' }), '');
        assert.equal(describeGameNotice(), '');
    });

    it('reports the Oracle state it is really in', () => {
        assert.match(describeGameNotice({ ...oracle, oracleState: 'HOLD', oracleTimer: 9 }), /HOLDING 9s/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'CLIMAX' }), /CLIMAX/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'DENIAL' }), /DENIAL/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'APPROACH' }), /APPROACHING THE CEILING/);
        const locked = describeGameNotice({
            ...oracle, oracleState: 'PURGATORY', sessionSeconds: 60, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800
        });
        assert.match(locked, /NOT YET/);
        const open = describeGameNotice({
            ...oracle, oracleState: 'PURGATORY', sessionSeconds: 2000, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 2400
        });
        assert.match(open, /PURGATORY/);
    });

    it('reports the training set it is really in', () => {
        assert.equal(
            describeGameNotice({ ...train, trainState: 'hold', trainHoldSeconds: 4, trainHoldGoal: 15, trainEdgesDone: 2, trainEdgesGoal: 5 }),
            'EDGE TRAINING: HOLD 11s — 2/5 EDGES'
        );
        assert.match(describeGameNotice({ ...train, trainState: 'recover', trainEdgesDone: 2, trainEdgesGoal: 5 }), /RECOVER — 2\/5/);
        assert.match(describeGameNotice({ ...train, trainState: 'finish' }), /COMPLETE/);
        assert.match(describeGameNotice({ ...train, trainState: 'climb', trainEdgesGoal: 5 }), /CLIMB — 0\/5/);
        assert.match(
            describeGameNotice({ activeMode: 'survival', sessionStatus: 'RUNNING', survivalSpeedFloor: 42.4 }),
            /SURVIVAL: FLOOR 42%/
        );
        assert.match(
            describeGameNotice({ activeMode: 'calibrate', sessionStatus: 'RUNNING', survivalSpeedFloor: 42.4, calibrationPass: 'primary' }),
            /CALIBRATION: PRIMARY TOY — FLOOR 42%/
        );
        assert.match(
            describeGameNotice({ activeMode: 'calibrate', sessionStatus: 'RUNNING', survivalSpeedFloor: 18, calibrationPass: 'dual', survivalOverdrive: 3 }),
            /CALIBRATION: BOTH TOYS — FLOOR 18% — \+3 BPM/
        );
    });

    it('never claims a game is still running during a Soft Landing', () => {
        // The session timer can hand ANY game to the 45 s tease-down, and it
        // leaves the game state exactly where it stood: the banner told the
        // wearer the Oracle was still deciding, or the training still
        // climbing, for the whole tease-down, while neither was true.
        const landings = [
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'APPROACH' },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'HOLD', oracleTimer: 7 },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'PURGATORY' },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'RAMPDOWN' },
            { ...train, sessionStatus: 'RAMPDOWN', trainState: 'climb', trainEdgesGoal: 5 },
            { ...train, sessionStatus: 'RAMPDOWN', trainState: 'hold', trainHoldSeconds: 3 },
            { activeMode: 'survival', sessionStatus: 'RAMPDOWN', survivalSpeedFloor: 42 },
            { activeMode: 'calibrate', sessionStatus: 'RAMPDOWN', survivalSpeedFloor: 42, calibrationPass: 'dual' }
        ];
        for (const landing of landings) {
            const text = describeGameNotice(landing);
            assert.match(text, /SOFT LANDING/, `${landing.activeMode}/${landing.oracleState || landing.trainState}`);
            for (const lie of [/HOLDING/, /APPROACHING/, /PURGATORY/, /NOT YET/, /CLIMB/, /RECOVER/, /STAY UNDER/]) {
                assert.ok(!lie.test(text), `the banner still claims the game is running: ${text}`);
            }
        }
    });
});

describe('the cockpit cutoff banner', () => {
    const edged = {
        sessionStatus: 'RUNNING',
        isEdged: true,
        orgasmMode: false,
        stallGuardEngaged: false,
        primaryPercent: 0,
        secondaryPercent: 100
    };

    it('names what each channel was really sent', () => {
        // Ultimate Milker at the mark: the primary is parked, the secondary
        // really is milking, and that is the only case the old fixed
        // sentence described.
        assert.equal(
            describeCutoffNotice(edged),
            'CLIMAX LIMIT REACHED: PRIMARY CUT \u2014 SECONDARY MILKING (100%)'
        );
        // Crawl keeps the micro-motion on both channels in Classic Tease.
        assert.equal(
            describeCutoffNotice({ ...edged, primaryPercent: 10, secondaryPercent: 10 }),
            'CLIMAX LIMIT REACHED: PRIMARY CRAWLING (10%) \u2014 SECONDARY CRAWLING (10%)'
        );
        // Survival keeps climbing through the mark; the banner used to call
        // that running primary cut.
        assert.equal(
            describeCutoffNotice({ ...edged, primaryPercent: 52, secondaryPercent: 36 }),
            'CLIMAX LIMIT REACHED: PRIMARY RUNNING (52%) \u2014 SECONDARY MILKING (36%)'
        );
    });

    it('never calls a stopped secondary milking', () => {
        // Classic Tease with Full Stop and a vibrator on the secondary: both
        // motors are at 0%, and the banner told the wearer the secondary was
        // milking them, so they went looking for a broken toy or a wrong
        // role assignment.
        const text = describeCutoffNotice({ ...edged, primaryPercent: 0, secondaryPercent: 0 });
        assert.equal(text, 'CLIMAX LIMIT REACHED: PRIMARY CUT \u2014 SECONDARY STOPPED');
        assert.ok(!/MILKING/.test(text), `a stopped secondary is not milking: ${text}`);
        // Nor a crawling one - Global Intensity scales the 10% crawl to
        // anywhere from 5% to 15%, and all of that is still a crawl.
        for (const pct of [5, 10, 15]) {
            const crawling = describeCutoffNotice({ ...edged, secondaryPercent: pct });
            assert.ok(!/MILKING/.test(crawling), `${pct}% is a crawl, not milking: ${crawling}`);
            assert.match(crawling, new RegExp(`SECONDARY CRAWLING \\(${pct}%\\)`));
        }
    });

    it('asserts nothing at all once the session is not running', () => {
        // The edge flag deliberately survives a pause (clearing it counted a
        // phantom edge on the first tick after RESUME), so the banner went on
        // claiming an active secondary through every watchdog pause with all
        // motors stopped.
        for (const sessionStatus of ['PAUSED', 'IDLE', 'STOPPED', 'RAMPDOWN', undefined]) {
            assert.equal(
                describeCutoffNotice({ ...edged, sessionStatus }),
                '',
                `the banner must be silent in ${String(sessionStatus)}`
            );
        }
        // And the cases the banner never covered: not on the mark, Force
        // Orgasm (not a cutoff) and the stall guard (its own banner).
        assert.equal(describeCutoffNotice({ ...edged, isEdged: false }), '');
        assert.equal(describeCutoffNotice({ ...edged, orgasmMode: true }), '');
        assert.equal(describeCutoffNotice({ ...edged, stallGuardEngaged: true }), '');
        assert.equal(describeCutoffNotice(), '');
    });

    it('refuses to guess at a percentage it was not given', () => {
        const text = describeCutoffNotice({ ...edged, primaryPercent: NaN, secondaryPercent: undefined });
        assert.equal(text, 'CLIMAX LIMIT REACHED: PRIMARY UNKNOWN \u2014 SECONDARY UNKNOWN');
        // Out-of-range numbers are reported inside the scale, never as a
        // negative or a 300% motor.
        assert.match(describeCutoffNotice({ ...edged, primaryPercent: -5, secondaryPercent: 300 }), /PRIMARY CUT/);
        assert.match(describeCutoffNotice({ ...edged, primaryPercent: -5, secondaryPercent: 300 }), /SECONDARY MILKING \(100%\)/);
    });

    it('is the only thing app.js paints into the cutoff banner', () => {
        // index.html no longer carries the sentence, and app.js must not
        // reinvent one: a hand-built string is how the last one drifted away
        // from what the engine was sending.
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.ok(!/SECONDARY MILKING ACTIVE/.test(html), 'the fixed banner sentence must be gone from the markup');
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/describeCutoffNotice\(/.test(src), 'app.js must ask for the text');
        assert.ok(!/CLIMAX LIMIT REACHED/.test(src), 'app.js must not build the text itself');
    });
});

describe('describeStallPauseNotice', () => {
    it('promises a crawl only where a crawl really comes back', () => {
        for (const mode of ['classic', 'milker', 'ultimate', 'shortener', 'headplay']) {
            assert.equal(
                describeStallPauseNotice({ mode, ceilingBehaviour: 'crawl' }),
                'STALL PAUSE: PRIMARY HALTED — CRAWL RESUMES AFTER THE PAUSE',
                `${mode} does come back to a crawl`
            );
        }
    });

    it('never promises a crawl in Ruin & Leak, whichever ceiling rule is set', () => {
        // The reported defect: on the defaults (Crawl, stall guard on, 20 s /
        // 8 s) a wearer parked on the pullback mark in Ruin & Leak was told a
        // crawl resumes in 8 seconds. The mode's 18 s lockout parks the
        // primary at 0% for as long as the pulse sits there, so it never did.
        for (const behaviour of ['crawl', 'stop', undefined]) {
            const text = describeStallPauseNotice({ mode: 'ruin', ceilingBehaviour: behaviour });
            assert.ok(!/CRAWL RESUMES/.test(text), `Ruin & Leak promised a crawl: ${text}`);
            assert.equal(text, 'STALL PAUSE: PRIMARY HALTED — RUIN LOCKOUT HOLDS IT AT 0%');
        }
    });

    it('never promises a crawl under Full Stop', () => {
        for (const mode of ['classic', 'milker', 'ultimate', 'oracle', 'edgetrain', undefined]) {
            const text = describeStallPauseNotice({ mode, ceilingBehaviour: 'stop' });
            assert.ok(!/CRAWL RESUMES/.test(text), `Full Stop promised a crawl in ${mode}: ${text}`);
            assert.equal(text, 'STALL PAUSE: PRIMARY HALTED — FULL STOP HOLDS IT AT 0%');
        }
    });

    it('says the speed comes back in Survival and Calibration, which never park on the mark', () => {
        // Those climbs ignore the "At the ceiling" setting the way Ruin & Leak
        // does - the speed climbs on its own clock - so Full Stop must not
        // make this sentence promise a 0% the climb is not going to give.
        for (const mode of ['survival', 'calibrate']) {
            for (const behaviour of ['crawl', 'stop', undefined]) {
                assert.equal(
                    describeStallPauseNotice({ mode, ceilingBehaviour: behaviour }),
                    'STALL PAUSE: PRIMARY HALTED — SPEED RESUMES AFTER THE PAUSE',
                    `${mode} under ${behaviour}`
                );
            }
        }
    });

    it('always reports the halt itself, whatever it is handed', () => {
        for (const args of [undefined, {}, { mode: 'nonsense', ceilingBehaviour: 'nonsense' }]) {
            assert.match(describeStallPauseNotice(args), /^STALL PAUSE: PRIMARY HALTED — /);
        }
    });

    it('leaves no stale sentence behind display:none', () => {
        // Between engagements the banner is hidden. It is emptied as well,
        // so a sentence painted for the last mode cannot be shown again by a
        // future paint that forgets to rewrite it first.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const at = src.indexOf('describeStallPauseNotice({');
        assert.ok(at >= 0, 'the stall banner is no longer painted here');
        const block = src.slice(at, at + 700);
        assert.ok(/stallNotice\.textContent = '';/.test(block),
            'the banner must be emptied when it is not engaged');
        const clearAt = block.indexOf("stallNotice.textContent = '';");
        const toggleAt = block.indexOf("classList.toggle('hidden'");
        assert.ok(clearAt >= 0 && toggleAt > clearAt, 'it must be emptied before it is hidden');
    });

    it('is the only thing app.js paints into the stall banner', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.ok(!/CRAWL RESUMES/.test(html), 'the fixed sentence must be gone from the markup');
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/describeStallPauseNotice\(/.test(src), 'app.js must ask for the text');
        assert.ok(!/CRAWL RESUMES/.test(src), 'app.js must not build the text itself');
        // And it must be handed the live mode and ceiling rule, not a guess.
        const at = src.indexOf('describeStallPauseNotice({');
        assert.ok(at >= 0, 'app.js does not call describeStallPauseNotice with arguments');
        const call = src.slice(at, at + 220);
        assert.ok(/mode: state\.activeMode/.test(call), 'the banner must be told the active mode');
        assert.ok(/ceilingBehaviour: advancedSettings\.ceilingBehaviour/.test(call), 'the banner must be told the ceiling rule');
    });
});

describe('sanitizeStoredHrLimits', () => {
    it('keeps a pair the wearer could have typed', () => {
        assert.deepEqual(sanitizeStoredHrLimits(65, 95), { minHr: 65, maxHr: 95 });
        assert.deepEqual(sanitizeStoredHrLimits('65', '95'), { minHr: 65, maxHr: 95 });
    });

    it('falls back to the factory pair on anything unusable', () => {
        const factory = { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR };
        for (const bad of [[undefined, undefined], ['', ''], ['abc', 'def'], [null, null],
            [70, 70], [140, 70], [70, 20], [70, 999], [-5, 140], [{}, []]]) {
            assert.deepEqual(sanitizeStoredHrLimits(bad[0], bad[1]), factory, `stored ${JSON.stringify(bad)}`);
        }
    });

    it('never restores a ceiling the clamp would refuse', () => {
        // A hand-edited store is the attack: every reachable result must be a
        // ceiling sanitizeHrLimits itself accepts, and never the stored one
        // when that is out of range.
        for (const raw of [999, 251, 1e9, '300', Infinity, NaN, '140abc', 29]) {
            const out = sanitizeStoredHrLimits(70, raw);
            assert.ok(out.maxHr >= 30 && out.maxHr <= 250, `ceiling out of range for ${raw}: ${out.maxHr}`);
            assert.ok(out.maxHr <= DEFAULT_MAX_HR, `a corrupt store raised the ceiling for ${raw}: ${out.maxHr}`);
        }
    });

    it('restores a narrow but legal pair exactly as it was typed', () => {
        // A pair the Session Setup fields accept must come back unchanged.
        // Repairing it - either by raising the ceiling or by dropping the
        // Resting HR to leave MIN_CEILING_GAP - would hand back limits the
        // wearer never typed, which is the very complaint this persistence
        // was added to answer. MIN_CEILING_GAP stays where it belongs, in
        // computeEffectiveCeiling, which only ever lowers the ceiling.
        assert.deepEqual(sanitizeStoredHrLimits(130, 140), { minHr: 130, maxHr: 140 });
        assert.deepEqual(sanitizeStoredHrLimits(70, 75), { minHr: 70, maxHr: 75 });
        assert.deepEqual(sanitizeStoredHrLimits(30, 31), { minHr: 30, maxHr: 31 });
        // And a narrow restored pair still cannot lift the working ceiling.
        const ceiling = computeEffectiveCeiling({ minHr: 130, maxHr: 140 });
        assert.ok(ceiling.maxHr <= 140, `narrow pair raised the working ceiling to ${ceiling.maxHr}`);
    });

    it('restores every pair the typed fields accept, byte for byte', () => {
        // The single promise of this feature: what you typed is what comes
        // back. A stored pair is clamped by sanitizeHrLimits and nothing
        // else, so the two paths can never disagree.
        for (let min = 30; min <= 250; min += 13) {
            for (let max = 30; max <= 250; max += 17) {
                const typed = sanitizeHrLimits(min, max, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR });
                const restored = sanitizeStoredHrLimits(min, max);
                if (typed.valid) {
                    assert.deepEqual(restored, { minHr: typed.minHr, maxHr: typed.maxHr }, `${min}/${max}`);
                } else {
                    assert.deepEqual(restored, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR }, `${min}/${max}`);
                }
                assert.ok(restored.maxHr <= Math.max(max, DEFAULT_MAX_HR), `${min}/${max} raised the ceiling`);
            }
        }
    });

    it('is idempotent, so a stored value survives a round trip unchanged', () => {
        for (const pair of [[70, 140], [65, 95], [70, 75], [40, 41], ['x', 'y'], [200, 250]]) {
            const once = sanitizeStoredHrLimits(pair[0], pair[1]);
            assert.deepEqual(sanitizeStoredHrLimits(once.minHr, once.maxHr), once, `pair ${pair}`);
        }
    });

    it('always leaves resting below climax', () => {
        for (let min = 25; min <= 260; min += 7) {
            for (let max = 25; max <= 260; max += 11) {
                const out = sanitizeStoredHrLimits(min, max);
                assert.ok(out.minHr < out.maxHr, `${min}/${max} restored as ${out.minHr}/${out.maxHr}`);
                assert.ok(out.maxHr <= Math.max(max, DEFAULT_MAX_HR), `${min}/${max} raised the ceiling`);
            }
        }
    });
});

describe('sanitizeStoredDuration / sanitizeStoredEndgame', () => {
    it('keeps a window the Session Setup fields would accept', () => {
        assert.deepEqual(sanitizeStoredDuration({
            durationMode: 'fixed',
            durationFixedMinutes: '42',
            durationMinMinutes: 10,
            durationMaxMinutes: 20
        }), {
            durationMode: 'fixed',
            durationFixedMinutes: 42,
            durationMinMinutes: 10,
            durationMaxMinutes: 20
        });
    });

    it('falls back per field on anything parseSessionDuration refuses', () => {
        const out = sanitizeStoredDuration({
            durationMode: 'sideways',
            durationFixedMinutes: 0,
            durationMinMinutes: 60,
            durationMaxMinutes: 30
        });
        assert.deepEqual(out, {
            durationMode: DEFAULT_DURATION_MODE,
            durationFixedMinutes: DEFAULT_FIXED_MINUTES,
            durationMinMinutes: DEFAULT_RANGE_MIN_MINUTES,
            durationMaxMinutes: DEFAULT_RANGE_MAX_MINUTES
        });
        // An empty store is the factory window.
        assert.deepEqual(sanitizeStoredDuration(), out);
        assert.deepEqual(sanitizeStoredDuration({}), out);
    });

    it('keeps the three real endgames and refuses anything else', () => {
        for (const type of ['orgasm', 'rampdown', 'denial']) {
            assert.equal(sanitizeStoredEndgame(type), type);
        }
        for (const junk of [undefined, null, '', 'ORGASM', 'finish', 42, {}]) {
            assert.equal(sanitizeStoredEndgame(junk), DEFAULT_ENDGAME_TYPE);
        }
    });
});

describe('sanitizeSessionLimits', () => {
    const factory = {
        minHr: DEFAULT_MIN_HR,
        maxHr: DEFAULT_MAX_HR,
        durationMode: DEFAULT_DURATION_MODE,
        durationFixedMinutes: DEFAULT_FIXED_MINUTES,
        durationMinMinutes: DEFAULT_RANGE_MIN_MINUTES,
        durationMaxMinutes: DEFAULT_RANGE_MAX_MINUTES,
        endgameType: DEFAULT_ENDGAME_TYPE
    };

    it('gives a brand-new install exactly the defaults index.html ships', () => {
        assert.deepEqual(sanitizeSessionLimits(), factory);
        assert.deepEqual(sanitizeSessionLimits({}), factory);
    });

    it('restores a whole typed set', () => {
        const typed = {
            minHr: 65,
            maxHr: 92,
            durationMode: 'fixed',
            durationFixedMinutes: 40,
            durationMinMinutes: 20,
            durationMaxMinutes: 50,
            endgameType: 'rampdown'
        };
        assert.deepEqual(sanitizeSessionLimits(typed), typed);
    });

    it('is idempotent and ignores the other settings around it', () => {
        const stored = { minHr: 70, maxHr: 4000, endgameType: 'whatever', stallGuard: false, voiceCues: {} };
        const once = sanitizeSessionLimits(stored);
        assert.deepEqual(sanitizeSessionLimits(once), once);
        assert.equal(once.maxHr, DEFAULT_MAX_HR);
        assert.equal(once.endgameType, DEFAULT_ENDGAME_TYPE);
        assert.ok(!('stallGuard' in once), 'it must only return the session limits');
    });
});

describe('app.js persists and restores the typed session limits', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('clamps the stored set wherever settings enter', () => {
        // load, Apply and import all run syncGuardSettings.
        const at = src.indexOf('function syncGuardSettings');
        assert.ok(at >= 0, 'syncGuardSettings not found');
        const body = src.slice(at, src.indexOf('\n}', at));
        assert.ok(/sanitizeSessionLimits\(advancedSettings\)/.test(body),
            'the stored session limits must go through the sanitiser on the way in');
    });

    it('writes them through the same sanitiser and the same store as every other setting', () => {
        const at = src.indexOf('function persistSessionLimits');
        assert.ok(at >= 0, 'persistSessionLimits not found');
        const body = src.slice(at, src.indexOf('\n}', at));
        assert.ok(/sanitizeSessionLimits\(/.test(body), 'a written value is clamped exactly as a stored one is');
        assert.ok(/readHrLimits\(\)/.test(body), 'the HR pair must come from the validated reader');
        assert.ok(/if \(isRemotePage\) return/.test(body), 'a remote page must never write the host limits');
        // The write itself is coalesced (write-coalescer.js) so a burst of
        // keystrokes does not re-encode the whole settings blob per key, but
        // it must still end in the ONE store every other setting uses.
        assert.ok(/sessionLimitsWriter\.(schedule|flush)\(/.test(body), 'it must go through the settings writer');
        assert.ok(/createWriteCoalescer\(\{ write: \(\) => persistSettings\(\) \}\)/.test(src),
            'the coalesced write must be the existing settings store');
    });

    it('is wired to every field the wearer can type', () => {
        // #minHr / #maxHr, the duration window, the three mode buttons and
        // the endgame cards. Each one used to be lost on reload.
        // persistSessionLimits(true) writes on the spot, persistSessionLimits()
        // joins the coalescing window; both count as wired. The function's own
        // declaration is not a call.
        const calls = (src.match(/persistSessionLimits\(/g) || []).length
            - (src.match(/function persistSessionLimits\(/g) || []).length;
        assert.ok(calls >= 7, `only ${calls} persist calls: a field is still unsaved`);
        // The typed HR pair, saved as it is typed rather than only on blur.
        const hrAt = src.indexOf("['minHr', 'maxHr'].forEach(");
        assert.ok(hrAt >= 0, 'the HR inputs are no longer wired in one place - move this guard with them');
        const hrBlock = src.slice(hrAt, hrAt + 700);
        assert.ok(/persistSessionLimits\(/.test(hrBlock), 'a typed HR limit must be saved');
        assert.ok(/addEventListener\('input'/.test(hrBlock), 'it must be saved while typing, not only on blur');
        assert.ok(/durFixedBtn\?\.addEventListener\('click', \(\) => \{ setDurationMode\('fixed'\); persistSessionLimits\(true\); \}\)/.test(src));
        assert.ok(/state\.endgameType = card\.getAttribute\('data-endgame'\);[\s\S]{0,120}persistSessionLimits\(true\)/.test(src),
            'the Endgame Trigger must be saved when it is picked');
        // A deliberate single action is never left sitting in the window.
        for (const click of ["setDurationMode('fixed')", "setDurationMode('range')", "setDurationMode('endless')"]) {
            const at = src.indexOf(click + '; persistSessionLimits');
            assert.ok(at >= 0 && src.slice(at, at + 60).includes('persistSessionLimits(true)'),
                `${click} must be written on the spot, not coalesced`);
        }
    });

    it('never seeds the fallback HR pair from this device on a remote page', () => {
        // ?partner= / ?group_sub= mirror the HOST's limits. The pair
        // readHrLimits falls back to before the first host reading must stay
        // the factory 70 / 140 there, not whatever this browser has stored.
        const guard = src.indexOf('function syncGuardSettings');
        const guardBody = src.slice(guard, src.indexOf('\n}', guard));
        assert.ok(!/lastGoodHrLimits/.test(guardBody),
            'syncGuardSettings runs on every page: it must not seed the fallback pair');
        const at = src.indexOf('state.lastGoodHrLimits = { minHr: advancedSettings.minHr');
        assert.ok(at >= 0, 'the fallback pair is seeded nowhere - a host page needs it');
        const before = src.slice(Math.max(0, at - 900), at);
        assert.ok(/if \(!isRemotePage\) \{/.test(before),
            'the seed must sit inside the host-only branch that paints those fields');
    });

    it('never lets a remote page restore the limits stored in this browser', () => {
        // A remote page is told the host's HR limits over the wire and
        // NOTHING about their Target Mode or Endgame Trigger. The timer
        // sub-label reads state.durationMode, so a partner whose own browser
        // had Endless stored watched their screen announce Endless Mode
        // while the wearer ran a Mystery window. The whole restore sits
        // inside the host-only branch.
        const at = src.indexOf('function syncParamsUI');
        const body = src.slice(at, src.indexOf('\n}\n', at));
        const open = body.indexOf('if (!isRemotePage) {');
        assert.ok(open >= 0, 'the host-only branch is gone');
        const close = body.indexOf('\n    }', open);
        assert.ok(close > open, 'the host-only branch never closes');
        const hostOnly = body.slice(open, close);
        for (const restored of ['minHr', 'maxHr', 'paramFixedInput', 'paramMinInput', 'paramMaxInput']) {
            assert.ok(hostOnly.includes(`getElementById('${restored}')`),
                `${restored} is restored outside the host-only branch`);
        }
        for (const seeded of ['state.durationMode = advancedSettings.durationMode',
            'state.endgameType = advancedSettings.endgameType',
            'highlightEndgameCard(state.endgameType)',
            'state.lastGoodHrLimits = {']) {
            assert.ok(hostOnly.includes(seeded), `"${seeded}" is not host-only`);
            assert.equal(body.split(seeded).length - 1, 1, `"${seeded}" also runs outside the branch`);
        }
        // And syncGuardSettings, which runs on every page including a remote
        // one, must not seed them either.
        const guard = src.indexOf('function syncGuardSettings');
        const guardBody = src.slice(guard, src.indexOf('\n}', guard));
        assert.ok(!/state\.durationMode|state\.endgameType/.test(guardBody),
            'syncGuardSettings runs on a remote page: it must not seed the wearer settings');
    });

    it('restores them into the page on boot', () => {
        const at = src.indexOf('function syncParamsUI');
        assert.ok(at >= 0, 'syncParamsUI not found');
        const body = src.slice(at, src.indexOf('\n}\n', at));
        for (const id of ['minHr', 'maxHr', 'paramFixedInput', 'paramMinInput', 'paramMaxInput']) {
            assert.ok(body.includes(`getElementById('${id}')`), `${id} is not restored on boot`);
        }
        assert.ok(/highlightEndgameCard\(/.test(body), 'the endgame trigger is not restored on boot');
        assert.ok(/isRemotePage/.test(body), 'a remote page must keep the host limits it is shown');
        assert.ok(src.lastIndexOf('syncParamsUI();') > at, 'syncParamsUI must run at boot');
    });
});
