import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    scriptAllowance,
    approachFactor,
    rejoinFactor,
    scriptSecondary,
    scriptCeilingBehaviour,
    edgeActionPausesVideo,
    describeScriptPhase,
    sanitizeScriptSettings,
    clampReactBpm,
    clampFloor,
    resolveApproach,
    resolveEdgeAction,
    clampRejoinSeconds,
    clampMaxSpeed,
    resolveInvert,
    resolveSmoothing,
    resolveSecondChannel,
    resolveVideoEnd,
    clampScriptOffset,
    DEFAULT_SCRIPT_SETTINGS,
    sessionTargetForVideo,
    complementSecondary,
    scriptMotion,
    secondaryFromScript,
    climaxApproach,
    boostedAllowance,
    scriptExpand,
    CLIMAX_RAMP_MS,
    CLIMAX_PEAK_MS,
    CLIMAX_EASE_MS
} from './script-governor.js';
import { resolveEdgeTriggerHr } from '../engine.js';
import { warmupShape, orgasmFrame } from '../patterns.js';
import { stallGuardArmed } from '../session-rules.js';

const MARK = 140;
const settings = (over = {}) => ({ ...DEFAULT_SCRIPT_SETTINGS, ...over });
const run = (over = {}) => scriptAllowance({
    hr: 100,
    triggerHr: MARK,
    isEdged: false,
    sessionStatus: 'RUNNING',
    sessionSeconds: 600,
    warmupMinutes: 0,
    intensityValue: 50,
    ...over,
    settings: settings(over.settings)
});

describe('scriptAllowance: band maths', () => {
    it('is the whole script below the band', () => {
        const r = run({ hr: 129 });
        assert.equal(r.allowance, 100);
        assert.equal(r.phase, 'free');
        assert.equal(r.s, 0);
    });

    it('falls linearly through the band to the floor at the mark', () => {
        // band 10, floor 30: s = (hr - 130) / 10, approach = 1 - 0.7 s.
        assert.equal(run({ hr: 130 }).allowance, 100);
        assert.equal(run({ hr: 135 }).allowance, 65);
        assert.equal(run({ hr: 139 }).allowance, 37);
        const at = run({ hr: 135 });
        assert.equal(at.phase, 'easing');
        assert.equal(at.s, 0.5);
        assert.equal(describeScriptPhase(at), 'EASING 65%');
    });

    it('a wider band reacts earlier', () => {
        const r = run({ hr: 120, settings: { scriptReactBpm: 40 } });
        // s = (120 - 100) / 40 = 0.5
        assert.equal(r.allowance, 65);
    });

    it('a band of 0 reacts only at the mark', () => {
        assert.equal(run({ hr: 139, settings: { scriptReactBpm: 0 } }).allowance, 100);
        assert.equal(run({ hr: 140, isEdged: true, settings: { scriptReactBpm: 0 } }).allowance, 0);
    });

    it('approach None plays the full script until the mark', () => {
        assert.equal(run({ hr: 139, settings: { scriptApproach: 'none' } }).allowance, 100);
        assert.equal(run({ hr: 140, isEdged: true, settings: { scriptApproach: 'none' } }).allowance, 0);
    });

    it('every approach that reacts uses the same allowance (the shaper decides what it shortens)', () => {
        for (const scriptApproach of ['shorten', 'slow', 'both']) {
            assert.equal(run({ hr: 135, settings: { scriptApproach } }).allowance, 65);
        }
    });

    it('the mic boost on hr reacts earlier, never later', () => {
        assert.ok(run({ hr: 137 }).allowance < run({ hr: 133 }).allowance);
    });

    it('approachFactor is bounded for any pulse', () => {
        for (const hr of [-50, 0, 129, 135, 140, 200]) {
            const { s, factor } = approachFactor(hr, MARK, { reactBpm: 10, floorPercent: 30 });
            assert.ok(s >= 0 && s <= 1);
            assert.ok(factor >= 0.3 - 1e-9 && factor <= 1);
        }
    });
});

describe('scriptAllowance: the floor', () => {
    it('sets how far it backs off just below the mark', () => {
        assert.equal(run({ hr: 139.999, settings: { scriptFloorPercent: 0 } }).allowance, 1, 'a speed never rounds into a stop');
        assert.equal(run({ hr: 140, settings: { scriptFloorPercent: 0 } }).allowance, 0, 'the floor 0 at the mark is 0');
        assert.equal(run({ hr: 140, settings: { scriptFloorPercent: 50 } }).allowance, 50);
        assert.equal(run({ hr: 140, settings: { scriptFloorPercent: 100 } }).allowance, 100);
    });
});

describe('a script session and a secondary with no script of its own', () => {
    it('uses the video length unless the session should continue after it', () => {
        assert.deepEqual(sessionTargetForVideo({ videoSeconds: 125.2, configuredSeconds: 600 }), { seconds: 126, fromVideo: true });
        assert.deepEqual(sessionTargetForVideo({ continueAfter: true, videoSeconds: 125, configuredSeconds: 600 }), { seconds: 600, fromVideo: false });
        assert.deepEqual(sessionTargetForVideo({ videoSeconds: 0, configuredSeconds: 600 }), { seconds: 600, fromVideo: false });
    });

    it('stops the secondary on a hold and follows a moving stroke', () => {
        assert.equal(scriptMotion(0), 0);
        assert.equal(complementSecondary(80, 0), 0);
        assert.equal(complementSecondary(0, 1), 0);
        assert.ok(complementSecondary(100, 1) >= complementSecondary(100, 0.2));
        assert.ok(complementSecondary(100, 1) <= 100);
    });

    it('plays a secondary script as its level, scaled by the allowance', () => {
        assert.equal(secondaryFromScript(80, 50), 40);
        assert.equal(secondaryFromScript(100, 100), 100);
        assert.equal(secondaryFromScript(0, 100), 0);
        assert.equal(secondaryFromScript(40, 0), 0);
        assert.equal(secondaryFromScript(null, 80), 0);
    });
});

describe('climax marks', () => {
    it('ramps the allowance up to a mark, holds, then lets the pulse lead again', () => {
        const mark = 120000;
        assert.equal(climaxApproach(mark - 1, [mark], { rampMs: 0 }), 0, 'a zero ramp does not climb early');
        assert.equal(climaxApproach(mark, [mark], { rampMs: 0, peakMs: 1000 }), 1);
        assert.equal(climaxApproach(mark - CLIMAX_RAMP_MS - 1, [mark]), 0);
        assert.equal(climaxApproach(mark - CLIMAX_RAMP_MS, [mark]), 0);
        assert.ok(Math.abs(climaxApproach(mark - CLIMAX_RAMP_MS / 2, [mark]) - 0.5) < 1e-9);
        assert.equal(climaxApproach(mark, [mark]), 1);
        assert.equal(climaxApproach(mark + CLIMAX_PEAK_MS, [mark]), 1);
        assert.equal(climaxApproach(mark + CLIMAX_PEAK_MS + 1, [mark], { easeMs: 0 }), 0);
        assert.ok(Math.abs(climaxApproach(mark + CLIMAX_PEAK_MS + CLIMAX_EASE_MS / 2, [mark]) - 0.5) < 1e-6);
        assert.equal(climaxApproach(mark + CLIMAX_PEAK_MS + CLIMAX_EASE_MS + 1, [mark]), 0);
        assert.equal(climaxApproach(NaN, [mark]), 0);
        assert.equal(climaxApproach(mark, []), 0);
    });

    it('uses the closest mark when there are several, and a hard stop stays stopped', () => {
        assert.equal(climaxApproach(10000, [100000, 12000]), climaxApproach(10000, [12000]));
        assert.equal(boostedAllowance(40, 0), 40);
        assert.equal(boostedAllowance(40, 0.5), 70);
        assert.equal(boostedAllowance(40, 1), 100);
        assert.equal(boostedAllowance(0, 0), 0);
        assert.equal(scriptExpand({ hr: 100, minHr: 70, maxHr: 145, strokeModel: 'cactus', allowance: 100 }), 1.39);
        assert.equal(scriptExpand({ hr: 100, minHr: 70, maxHr: 145, strokeModel: 'keep', allowance: 100 }), 1);
        assert.equal(scriptExpand({ hr: 140, minHr: 70, maxHr: 145, strokeModel: 'cactus', allowance: 40 }), 1, 'a pullback is not opened further');
        assert.equal(scriptExpand({ hr: 100, minHr: 70, maxHr: 145, strokeModel: 'cactus', allowance: 100, climax: 1 }), 1.65);
        assert.equal(boostedAllowance(0, 1), 100, 'the climax itself is full even if the limiter had stopped');
        assert.equal(boostedAllowance(80, climaxApproach(0, [0])), 100);
    });
});

describe('scriptAllowance: keep the script', () => {
    it('holds the floor at the edge instead of skipping', () => {
        const r = run({ hr: 141, isEdged: true, settings: { scriptStrokeModel: 'keep', scriptFloorPercent: 30 } });
        assert.equal(r.allowance, 30);
        assert.equal(r.phase, 'intensity');
        assert.equal(describeScriptPhase(r), 'INTENSITY 30%');
    });

    it('still eases through the band before the edge', () => {
        const r = run({ hr: 135, settings: { scriptStrokeModel: 'keep' } });
        assert.equal(r.allowance, 65);
        assert.equal(r.phase, 'easing');
    });
});

describe('scriptAllowance: skip at isEdged', () => {
    it('skips from the first reading at the mark, whatever the floor', () => {
        for (const scriptFloorPercent of [0, 30, 100]) {
            const r = run({ hr: 141, isEdged: true, settings: { scriptFloorPercent } });
            assert.equal(r.allowance, 0);
            assert.equal(r.phase, 'skipping');
        }
        assert.equal(describeScriptPhase(run({ hr: 141, isEdged: true })), 'SKIPPING: EDGE');
    });

    it('stays skipped while the flag is up, even below the mark (the release band)', () => {
        assert.equal(run({ hr: 136, isEdged: true }).allowance, 0);
    });

    it('Pause video is a skip too; the video is the player\'s to pause', () => {
        const r = run({ hr: 141, isEdged: true, settings: { scriptEdgeAction: 'pause-video' } });
        assert.equal(r.allowance, 0);
        assert.equal(edgeActionPausesVideo('pause-video'), true);
        assert.equal(edgeActionPausesVideo('skip'), false);
    });

    it('Crawl is not offered yet: it resolves to a skip', () => {
        assert.equal(resolveEdgeAction('crawl'), 'skip');
        assert.equal(run({ hr: 141, isEdged: true, settings: { scriptEdgeAction: 'crawl' } }).allowance, 0);
        assert.equal(edgeActionPausesVideo('crawl'), false);
    });

    it('never arms the stall guard (it only arms for Crawl)', () => {
        for (const action of ['skip', 'pause-video', 'crawl', undefined]) {
            assert.equal(scriptCeilingBehaviour(action), 'stop');
            assert.equal(stallGuardArmed({ enabled: true, ceilingBehaviour: scriptCeilingBehaviour(action), activeMode: 'script' }), false);
        }
    });
});

describe('scriptAllowance: the rejoin ramp', () => {
    it('starts at the warm-up curve\'s slowest point when the edge clears and ramps over the rejoin seconds', () => {
        const at0 = run({ hr: 120, sinceReleaseSeconds: 0 });
        assert.equal(at0.allowance, 16);
        assert.equal(at0.phase, 'rejoining');
        assert.equal(at0.rejoinLeftSeconds, 8);
        assert.equal(describeScriptPhase(at0), 'REJOINING 8 s');
        const mid = run({ hr: 120, sinceReleaseSeconds: 4 });
        assert.equal(mid.allowance, Math.round(100 * warmupShape(4, 8 / 60).speed));
        assert.equal(mid.rejoinLeftSeconds, 4);
        const done = run({ hr: 120, sinceReleaseSeconds: 8 });
        assert.equal(done.allowance, 100);
        assert.equal(done.phase, 'free');
    });

    it('is never above the approach: the smaller of the two wins', () => {
        // Late in the ramp (factor ~0.9) but deep in the band (0.44).
        const r = run({ hr: 138, sinceReleaseSeconds: 6 });
        assert.equal(r.allowance, 44);
        assert.equal(r.phase, 'easing');
        const early = run({ hr: 138, sinceReleaseSeconds: 0 });
        assert.equal(early.allowance, 16);
        assert.equal(early.phase, 'rejoining');
    });

    it('a new pullback during the ramp skips at once', () => {
        assert.equal(run({ hr: 141, isEdged: true, sinceReleaseSeconds: 3 }).allowance, 0);
    });

    it('a ramp of 0 s rejoins at once; no ramp running is no cap', () => {
        assert.equal(run({ hr: 120, sinceReleaseSeconds: 0, settings: { scriptRejoinSeconds: 0 } }).allowance, 100);
        for (const since of [null, undefined, NaN, -1]) assert.equal(rejoinFactor(since, 8), 1);
        assert.equal(rejoinFactor(0, 8), 0.16);
        assert.equal(rejoinFactor(100, 60), 1);
    });
});

describe('scriptAllowance: warm-up speed factor only', () => {
    it('scales by the warm-up\'s speed factor, never its depth factor', () => {
        const seconds = 60;
        const warm = warmupShape(seconds, 5);
        const r = run({ hr: 100, sessionSeconds: seconds, warmupMinutes: 5 });
        assert.equal(r.allowance, Math.round(100 * warm.speed));
        assert.notEqual(r.allowance, Math.round(100 * warm.speed * warm.depth));
        assert.equal(run({ hr: 100, sessionSeconds: 0, warmupMinutes: 5 }).allowance, 16);
    });

    it('multiplies with the approach', () => {
        const warm = warmupShape(60, 5).speed;
        assert.equal(run({ hr: 135, sessionSeconds: 60, warmupMinutes: 5 }).allowance, Math.round(65 * warm));
    });
});

describe('scriptAllowance: Global Intensity, capped at 100', () => {
    it('above 50% it only delays the reaction; it never exceeds the script', () => {
        assert.equal(run({ hr: 100, intensityValue: 100 }).allowance, 100);
        // approach 0.79 x 1.5 = 1.18 -> 100: the reaction is delayed.
        assert.equal(run({ hr: 133, intensityValue: 100 }).allowance, 100);
        assert.equal(run({ hr: 139, intensityValue: 100 }).allowance, 56);
    });

    it('below 50% it calms the whole script', () => {
        assert.equal(run({ hr: 100, intensityValue: 0 }).allowance, 50);
        assert.equal(run({ hr: 135, intensityValue: 0 }).allowance, 33);
    });

    it('a skip stays 0 at any intensity', () => {
        assert.equal(run({ hr: 141, isEdged: true, intensityValue: 100 }).allowance, 0);
    });

    it('is never outside 0-100 for any inputs', () => {
        for (const hr of [0, 100, 135, 140, 300]) {
            for (const intensityValue of [-50, 0, 50, 100, 500, NaN]) {
                for (const sinceReleaseSeconds of [null, 0, 3, 50]) {
                    const { allowance } = run({ hr, intensityValue, sinceReleaseSeconds, isEdged: hr >= 140 });
                    assert.ok(Number.isInteger(allowance) && allowance >= 0 && allowance <= 100, `${hr} ${intensityValue}: ${allowance}`);
                }
            }
        }
    });
});

describe('scriptAllowance: Soft Landing', () => {
    it('is 50% x the landing factor x intensity, the video playing on', () => {
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45 }).allowance, 50);
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 22.5 }).allowance, 25);
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 0 }).allowance, 0);
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45, intensityValue: 100 }).allowance, 75);
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45 }).phase, 'landing');
    });

    it('ignores the edge flag and the band (a landing counts nothing and only eases down)', () => {
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45, hr: 145, isEdged: true }).allowance, 50);
    });

    it('eases a landing from what was sent, and otherwise from half speed', () => {
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45, landingFrom: { primary: 30 } }).allowance, 30);
        assert.equal(run({ sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 0, landingFrom: { primary: 30 } }).allowance, 0);
    });
});

describe('scriptAllowance: Force Orgasm', () => {
    it('ramps from what was sent toward the wave\'s top over the ramp', () => {
        const from = { primary: 0, secondary: 0 };
        const first = run({ orgasmMode: true, orgasmBoost: 0, orgasmFrom: from, hr: 141, isEdged: true });
        assert.equal(first.allowance, 0, 'the first tick sends what was sent');
        assert.equal(first.phase, 'orgasm');
        const top = run({ orgasmMode: true, orgasmBoost: 28, orgasmFrom: from, sessionSeconds: 600 });
        const frame = orgasmFrame(600, 28);
        assert.equal(top.allowance, Math.round(frame.primary));
        assert.ok(top.allowance >= 78 && top.allowance <= 100);
        assert.equal(describeScriptPhase(top), 'FORCE ORGASM');
    });

    it('wins over the edge flag and the stall guard, as in every mode', () => {
        const r = run({ orgasmMode: true, orgasmBoost: 14, orgasmFrom: { primary: 40 }, isEdged: true, stallGuardEngaged: true });
        assert.ok(r.allowance > 40);
    });

    it('ramps the allowance on the same orgasm wave the engine uses', () => {
        for (const orgasmBoost of [0, 1, 7, 14, 27, 28, 60]) {
            for (const sessionSeconds of [30, 600, 1234]) {
                for (const intensityValue of [0, 50, 100]) {
                    const orgasmFrom = { primary: 37, secondary: 20, strokeMin: 0, strokeMax: 100 };
                    const governor = run({ orgasmMode: true, orgasmBoost, orgasmFrom, sessionSeconds, intensityValue, isEdged: true });
                    assert.ok(governor.allowance >= 0 && governor.allowance <= 100, `${orgasmBoost} ${sessionSeconds} ${intensityValue}`);
                    assert.equal(governor.phase, 'orgasm');
                }
            }
        }
    });

    it('with no record of what was sent it ramps from its own output', () => {
        const r = run({ orgasmMode: true, orgasmBoost: 0, orgasmFrom: null, hr: 100 });
        assert.equal(r.allowance, 100);
    });
});

describe('scriptAllowance: stall guard', () => {
    it('engaged is 0, whatever the pulse', () => {
        const r = run({ hr: 100, stallGuardEngaged: true });
        assert.equal(r.allowance, 0);
        assert.equal(r.phase, 'stall');
        assert.equal(describeScriptPhase(r), 'SKIPPING: STALL GUARD');
    });
});

describe('scriptAllowance: fail safe', () => {
    it('is 0 when not running', () => {
        for (const sessionStatus of ['IDLE', 'PAUSED', undefined, 'running']) {
            const r = run({ sessionStatus });
            assert.equal(r.allowance, 0);
            assert.equal(r.phase, 'idle');
        }
    });

    it('is 0 with no pulse or no mark', () => {
        assert.equal(run({ hr: NaN }).allowance, 0);
        assert.equal(run({ hr: undefined }).allowance, 0);
        assert.equal(run({ triggerHr: NaN }).allowance, 0);
        assert.equal(run({ triggerHr: resolveEdgeTriggerHr(NaN) }).allowance, 0);
        assert.equal(scriptAllowance().allowance, 0);
    });

    it('describeScriptPhase tolerates garbage', () => {
        assert.equal(describeScriptPhase(null), 'IDLE');
        assert.equal(describeScriptPhase({ phase: 'x' }), 'IDLE');
    });
});

describe('scriptSecondary', () => {
    it('is the limiter at 60%, or nothing', () => {
        assert.equal(scriptSecondary(100), 60);
        assert.equal(scriptSecondary(50), 30);
        assert.equal(scriptSecondary(1), 1, 'a moving limiter never rounds into a stop');
        assert.equal(scriptSecondary(0), 0);
        assert.equal(scriptSecondary(NaN), 0);
        assert.equal(scriptSecondary(100, 'off'), 0);
        assert.equal(scriptSecondary(100, 'vib'), 60, 'a phase 2 value resolves to the default');
    });
});

describe('Script settings: one sanitizer per field', () => {
    it('clamps numbers into their bounds and falls back on garbage', () => {
        assert.equal(clampReactBpm(-3), 0);
        assert.equal(clampReactBpm(99), 40);
        assert.equal(clampReactBpm('12'), 12);
        assert.equal(clampReactBpm('x'), 10);
        assert.equal(clampFloor(150), 100);
        assert.equal(clampFloor(null), 30);
        assert.equal(clampRejoinSeconds(61), 60);
        assert.equal(clampRejoinSeconds(-1), 0);
        assert.equal(clampRejoinSeconds(undefined), 8);
        assert.equal(clampMaxSpeed(10), 50);
        assert.equal(clampMaxSpeed(1000), 600);
        assert.equal(clampMaxSpeed('abc'), 300);
    });

    it('accepts only the choices phase 1 offers', () => {
        assert.equal(resolveApproach('slow'), 'slow');
        assert.equal(resolveApproach('both'), 'both');
        assert.equal(resolveApproach('half-time'), 'shorten');
        assert.equal(resolveEdgeAction('pause-video'), 'pause-video');
        assert.equal(resolveEdgeAction(undefined), 'skip');
        assert.equal(resolveSmoothing('strong'), 'light');
        assert.equal(resolveSmoothing('off'), 'light');
        assert.equal(resolveSecondChannel('off'), 'off');
        assert.equal(resolveSecondChannel('script'), 'hr');
        assert.equal(resolveVideoEnd('loop'), 'loop');
        assert.equal(resolveVideoEnd('rewind'), 'stop');
        assert.equal(resolveInvert(true), true);
        assert.equal(resolveInvert('true'), true);
        assert.equal(resolveInvert(1), false);
    });

    it('steps the offset in 10 ms inside +-2 s', () => {
        assert.equal(clampScriptOffset(123), 120);
        assert.equal(clampScriptOffset(-5000), -2000);
        assert.equal(clampScriptOffset(2001), 2000);
        assert.equal(clampScriptOffset('x'), 0);
        assert.equal(clampScriptOffset(-4), 0);
        assert.ok(Object.is(clampScriptOffset(-4), 0), 'never -0');
    });

    it('sanitizes a whole object, defaults for what is missing', () => {
        assert.deepEqual(sanitizeScriptSettings(undefined), { ...DEFAULT_SCRIPT_SETTINGS });
        const out = sanitizeScriptSettings({ scriptReactBpm: 99, scriptApproach: 'slow', scriptEdgeAction: 'crawl', extra: 1 });
        assert.equal(out.scriptReactBpm, 40);
        assert.equal(out.scriptApproach, 'slow');
        assert.equal(out.scriptEdgeAction, 'skip');
        assert.equal('extra' in out, false);
        assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_SCRIPT_SETTINGS).sort());
    });

    it('the defaults are the owner\'s', () => {
        assert.deepEqual({ ...DEFAULT_SCRIPT_SETTINGS }, {
            scriptReactBpm: 10,
            scriptFloorPercent: 30,
            scriptApproach: 'shorten',
            scriptEdgeAction: 'skip',
            scriptRejoinSeconds: 8,
            scriptMaxSpeed: 300,
            scriptInvert: false,
            scriptSmoothing: 'light',
            scriptSecondChannel: 'hr',
            scriptVideoEnd: 'stop',
            scriptStrokeModel: 'cactus'
        });
    });
});
