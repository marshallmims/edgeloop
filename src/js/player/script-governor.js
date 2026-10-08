// The governor: in Script mode the primary channel (0-100) means "how much of
// the script the toy may play" - the allowance. Pure, no DOM, no timers; the
// engine's `script` branch calls scriptAllowance() every tick with what it
// has already worked out, and the shaper (script-shaper.js) turns the
// allowance into points.
//
// Every rule that sets the primary keeps its meaning here:
//   - 0 is a decided stop, which in Script mode means skip: the video and
//     the script clock run on and the toy sits out the strokes.
//   - The pullback starts on the first reading at the mark (`isEdged`, from
//     the engine's unchanged edge logic) and the allowance is 0 from that
//     tick. The edge COUNT waits for the pulse to hold (edge-confirm.js) and
//     is not read here: a count must never delay a skip.
//   - Inside the approach band (scriptReactBpm below the mark) the allowance
//     falls continuously from 1 to the floor, so it needs no hysteresis; the
//     edge flag has the engine's 5 BPM release band, which is what keeps
//     skip and rejoin from flapping.
//   - After the edge clears, the rejoin ramp (the session warm-up's speed
//     curve, 0.16 -> 1, over scriptRejoinSeconds) caps it. A new pullback
//     during the ramp skips at once.
//   - The warm-up applies only its speed factor: its depth factor would
//     shorten the stroke twice, once here and once in the shaper.
//   - Global Intensity scales by 0.5-1.5x and the result is capped at 100:
//     above 50% it can only delay the reaction, because the script itself is
//     the ceiling.
//   - The stall guard engaged is 0; a Soft Landing is today's 50% x the
//     landing factor (eased from what was sent when it took over from a
//     Force Orgasm run); Force Orgasm ramps from what was sent toward its
//     78-100% wave over ORGASM_RAMP_SECONDS. These mirror the engine's own
//     rules number for number (script-governor.test.js checks them against
//     calculateEngineOutputs), so a guard means the same in every mode.
//
// The Script tab's settings, their bounds and their sanitizers live here too:
// one sanitizer per field, for settings-schema.js to use.

import { warmupShape, orgasmFrame, roundSpeed } from '../patterns.js';

// ---- Settings ---------------------------------------------------------------

export const MIN_REACT_BPM = 0;
export const MAX_REACT_BPM = 40;
export const DEFAULT_REACT_BPM = 10;

export const MIN_FLOOR_PERCENT = 0;
export const MAX_FLOOR_PERCENT = 100;
export const DEFAULT_FLOOR_PERCENT = 30;

// What the toy does inside the approach band (script-shaper.js applies it).
//   shorten  every stroke's amplitude x a, from the base; timing unchanged
//   slow     the speed limit x a: fast strokes are cut short, slow ones kept
//   both     both of the above
//   none     the full script until the mark (the band is not used)
export const SCRIPT_APPROACHES = Object.freeze(['shorten', 'slow', 'both', 'none']);
export const DEFAULT_APPROACH = 'shorten';

// At the edge. `crawl` is a phase 2 action and is not offered yet: anything
// that is not one of these is a skip, the safest of them.
export const SCRIPT_EDGE_ACTIONS = Object.freeze(['skip', 'pause-video']);
export const DEFAULT_EDGE_ACTION = 'skip';

export const MIN_REJOIN_SECONDS = 0;
export const MAX_REJOIN_SECONDS = 60;
export const DEFAULT_REJOIN_SECONDS = 8;

// Max speed, % of full travel per second. 300 is about 330 mm/s on a 110 mm
// Handy, under its 400 mm/s firmware cap; a device's own ceiling can only
// lower it further (script-shaper.js).
export const MIN_SCRIPT_SPEED = 50;
export const MAX_SCRIPT_SPEED = 600;
export const DEFAULT_SCRIPT_SPEED = 300;

// Smoothing: only Light ships in phase 1 (Off and Strong are phase 2).
export const SCRIPT_SMOOTHINGS = Object.freeze(['light']);
export const DEFAULT_SMOOTHING = 'light';

// The second channel: the limiter at 60% (heart rate), or nothing.
export const SCRIPT_SECOND_CHANNELS = Object.freeze(['hr', 'off']);
export const DEFAULT_SECOND_CHANNEL = 'hr';
export const SECONDARY_SHARE = 0.6;

export const SCRIPT_VIDEO_ENDS = Object.freeze(['stop', 'loop']);
export const DEFAULT_VIDEO_END = 'stop';

// How the pulse changes the script.
//   cactus  Purple Palm's limiter: strokes shorten (or slow) as you climb,
//           and at the edge the toy skips strokes while the video continues.
//   keep    The script's shape stays. The pulse only scales intensity. A
//           hold in the script is a real stop, and the next stroke starts
//           at whatever intensity the pulse allows.
export const SCRIPT_STROKE_MODELS = Object.freeze(['cactus', 'keep']);
export const DEFAULT_STROKE_MODEL = 'cactus';

// The per-script offset (player panel; remembered per script hash, not in
// Settings or the Backup). Positive plays the strokes later.
export const MIN_SCRIPT_OFFSET_MS = -2000;
export const MAX_SCRIPT_OFFSET_MS = 2000;
export const SCRIPT_OFFSET_STEP_MS = 10;

export const DEFAULT_SCRIPT_SETTINGS = Object.freeze({
    scriptReactBpm: DEFAULT_REACT_BPM,
    scriptFloorPercent: DEFAULT_FLOOR_PERCENT,
    scriptApproach: DEFAULT_APPROACH,
    scriptEdgeAction: DEFAULT_EDGE_ACTION,
    scriptRejoinSeconds: DEFAULT_REJOIN_SECONDS,
    scriptMaxSpeed: DEFAULT_SCRIPT_SPEED,
    scriptInvert: false,
    scriptSmoothing: DEFAULT_SMOOTHING,
    scriptSecondChannel: DEFAULT_SECOND_CHANNEL,
    scriptVideoEnd: DEFAULT_VIDEO_END,
    scriptStrokeModel: DEFAULT_STROKE_MODEL
});

function wholeIn(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

export function clampReactBpm(value, fallback = DEFAULT_REACT_BPM) {
    return wholeIn(value, MIN_REACT_BPM, MAX_REACT_BPM, fallback);
}

export function clampFloor(value, fallback = DEFAULT_FLOOR_PERCENT) {
    return wholeIn(value, MIN_FLOOR_PERCENT, MAX_FLOOR_PERCENT, fallback);
}

export function resolveApproach(value) {
    return SCRIPT_APPROACHES.includes(value) ? value : DEFAULT_APPROACH;
}

export function resolveEdgeAction(value) {
    return SCRIPT_EDGE_ACTIONS.includes(value) ? value : DEFAULT_EDGE_ACTION;
}

export function clampRejoinSeconds(value, fallback = DEFAULT_REJOIN_SECONDS) {
    return wholeIn(value, MIN_REJOIN_SECONDS, MAX_REJOIN_SECONDS, fallback);
}

export function clampMaxSpeed(value, fallback = DEFAULT_SCRIPT_SPEED) {
    return wholeIn(value, MIN_SCRIPT_SPEED, MAX_SCRIPT_SPEED, fallback);
}

export function resolveInvert(value) {
    return value === true || value === 'true';
}

export function resolveSmoothing(value) {
    return SCRIPT_SMOOTHINGS.includes(value) ? value : DEFAULT_SMOOTHING;
}

export function resolveSecondChannel(value) {
    return SCRIPT_SECOND_CHANNELS.includes(value) ? value : DEFAULT_SECOND_CHANNEL;
}

export function resolveVideoEnd(value) {
    return SCRIPT_VIDEO_ENDS.includes(value) ? value : DEFAULT_VIDEO_END;
}

export function resolveStrokeModel(value) {
    return value === 'keep' ? 'keep' : 'cactus';
}

// The offset in whole steps of 10 ms inside +-2 s; unreadable is 0.
export function clampScriptOffset(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const stepped = Math.round(n / SCRIPT_OFFSET_STEP_MS) * SCRIPT_OFFSET_STEP_MS;
    return Math.max(MIN_SCRIPT_OFFSET_MS, Math.min(MAX_SCRIPT_OFFSET_MS, stepped)) || 0;
}

// Every Script setting at once, each through its own sanitizer; a field that
// is missing takes its default.
export function sanitizeScriptSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        scriptReactBpm: clampReactBpm(s.scriptReactBpm),
        scriptFloorPercent: clampFloor(s.scriptFloorPercent),
        scriptApproach: resolveApproach(s.scriptApproach),
        scriptEdgeAction: resolveEdgeAction(s.scriptEdgeAction),
        scriptRejoinSeconds: clampRejoinSeconds(s.scriptRejoinSeconds),
        scriptMaxSpeed: clampMaxSpeed(s.scriptMaxSpeed),
        scriptInvert: resolveInvert(s.scriptInvert),
        scriptSmoothing: resolveSmoothing(s.scriptSmoothing),
        scriptSecondChannel: resolveSecondChannel(s.scriptSecondChannel),
        scriptVideoEnd: resolveVideoEnd(s.scriptVideoEnd),
        scriptStrokeModel: resolveStrokeModel(s.scriptStrokeModel)
    };
}

// The Guards tab's "At the ceiling" the stall guard is armed from, in Script
// mode: the Script edge action replaces it. Skip and Pause video are both a
// full stop at the edge, so the guard (which only arms for Crawl) is never
// armed by a script in phase 1.
export function scriptCeilingBehaviour(edgeAction) {
    return resolveEdgeAction(edgeAction) === 'crawl' ? 'crawl' : 'stop';
}

// Whether the governor also pauses the video at an edge.
export function edgeActionPausesVideo(edgeAction) {
    return resolveEdgeAction(edgeAction) === 'pause-video';
}

// The engine's secondary in Script mode: the limiter at 60%, or nothing.
export function scriptSecondary(allowance, secondChannel = DEFAULT_SECOND_CHANNEL) {
    if (resolveSecondChannel(secondChannel) === 'off') return 0;
    return roundSpeed(clampPercent(allowance) * SECONDARY_SHARE);
}

// ---- The allowance ----------------------------------------------------------

function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

// The approach factor (0-1): 1 below the band, falling linearly to the
// floor at the mark. `s` is how far into the band the pulse is (0-1). A band
// of 0 means "only at the mark", and approach 'none' ignores the band.
export function approachFactor(hr, triggerHr, { reactBpm, floorPercent, approach } = {}) {
    const band = clampReactBpm(reactBpm);
    const floor = clampFloor(floorPercent) / 100;
    if (resolveApproach(approach) === 'none' || band === 0) return { s: 0, factor: 1 };
    const s = Math.max(0, Math.min(1, (hr - (triggerHr - band)) / band));
    return { s, factor: 1 - s * (1 - floor) };
}

// The rejoin ramp's factor (0-1) `sinceRelease` seconds after the edge
// cleared: the session warm-up's speed curve run over `rejoinSeconds`. No
// ramp running (null, not a number, negative) or a length of 0 is 1.
export function rejoinFactor(sinceRelease, rejoinSeconds) {
    const length = clampRejoinSeconds(rejoinSeconds);
    if (sinceRelease === null || sinceRelease === undefined) return 1;
    const t = Number(sinceRelease);
    if (!Number.isFinite(t) || t < 0 || length === 0) return 1;
    return warmupShape(t, length / 60).speed;
}

// The most a landing that took over from Force Orgasm may send this second:
// what was sent when it began, eased by the landing's own factor (engine.js
// landingCap, the same arithmetic).
function landingCap(sent, rampLeft) {
    if (!Number.isFinite(sent)) return Infinity;
    const steps = Math.round(50 * Math.max(0, rampLeft / 45));
    return roundSpeed((steps * roundSpeed(sent)) / 50);
}

// scriptAllowance(inputs) -> { allowance, phase, s, approach, rejoin, rejoinLeftSeconds }
//
// Inputs (all already computed by the engine for this tick):
//   hr                 the engine pulse, mic boost included (can only raise s)
//   triggerHr          the pullback mark (resolveEdgeTriggerHr)
//   isEdged            the edge flag as decided THIS tick (the engine's
//                      next flag), so the first reading at the mark skips
//   sessionStatus      'RUNNING' | 'RAMPDOWN' | anything else (silent)
//   sessionSeconds, warmupMinutes      the session warm-up
//   stallGuardEngaged  the stall guard holding the primary off
//   orgasmMode, orgasmBoost, orgasmFrom    Force Orgasm (engine.js)
//   rampdownSecondsLeft, landingFrom       the Soft Landing (engine.js)
//   intensityValue     Global Intensity, 0-100 (50 = 1x)
//   sinceReleaseSeconds  seconds since the edge flag last cleared, or null
//                      when no rejoin ramp is running
//   settings           the Script settings (sanitizeScriptSettings keys)
//
// `allowance` is a whole percent 0-100. `phase` is for the status line:
//   'idle'      not running
//   'free'      the whole script
//   'easing'    inside the approach band (s > 0)
//   'skipping'  at the edge, or stopped by the stall guard ('stall')
//   'rejoining' the ramp after an edge is holding it back
//   'landing'   the Soft Landing
//   'orgasm'    Force Orgasm
export function scriptAllowance(inputs = {}) {
    const {
        hr,
        triggerHr,
        isEdged = false,
        sessionStatus,
        sessionSeconds = 0,
        warmupMinutes = 0,
        stallGuardEngaged = false,
        orgasmMode = false,
        orgasmBoost = 0,
        orgasmFrom = null,
        rampdownSecondsLeft = 0,
        landingFrom = null,
        intensityValue = 50,
        sinceReleaseSeconds = null,
        settings = {}
    } = inputs;
    const quiet = (phase) => ({ allowance: 0, phase, s: 0, approach: 0, rejoin: 1, rejoinLeftSeconds: 0 });

    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') return quiet('idle');
    // Fail safe: no pulse or no mark is no motion.
    if (!Number.isFinite(hr) || !Number.isFinite(triggerHr)) return quiet('idle');

    const intensityScale = 0.5 + Math.max(0, Math.min(100, finiteOr(Number(intensityValue), 50))) / 100;
    const seconds = Math.max(0, finiteOr(Number(sessionSeconds), 0));

    if (sessionStatus === 'RAMPDOWN') {
        const rampLeft = Math.max(0, Math.min(45, finiteOr(Number(rampdownSecondsLeft), 0)));
        let allowance = roundSpeed(Math.round(50 * (rampLeft / 45)) * intensityScale);
        if (landingFrom && typeof landingFrom === 'object') {
            allowance = Math.min(allowance, landingCap(landingFrom.primary, rampLeft));
        }
        return { allowance: Math.min(100, allowance), phase: 'landing', s: 0, approach: 0, rejoin: 1, rejoinLeftSeconds: 0 };
    }

    const { s, factor } = approachFactor(hr, triggerHr, {
        reactBpm: settings.scriptReactBpm,
        floorPercent: settings.scriptFloorPercent,
        approach: settings.scriptApproach
    });
    const rejoinSeconds = clampRejoinSeconds(settings.scriptRejoinSeconds);
    const rejoin = rejoinFactor(sinceReleaseSeconds, rejoinSeconds);

    let base;
    let phase;
    const strokeModel = resolveStrokeModel(settings.scriptStrokeModel);
    if (isEdged && strokeModel !== 'keep') {
        // Skip and Pause video are both 0 here; the video is the player's.
        base = 0;
        phase = 'skipping';
    } else if (isEdged) {
        // Keep the script: the shape stays, and the pulse holds intensity
        // at the floor instead of skipping the strokes.
        const floor = clampFloor(settings.scriptFloorPercent) / 100;
        base = Math.min(factor, floor);
        phase = 'intensity';
    } else {
        base = factor;
        phase = s > 0 ? 'easing' : 'free';
        if (rejoin < base) {
            base = rejoin;
            phase = 'rejoining';
        }
    }
    if (stallGuardEngaged) {
        base = 0;
        phase = 'stall';
    }

    const warm = warmupShape(seconds, warmupMinutes).speed;
    let allowance = Math.min(100, roundSpeed(100 * base * warm * intensityScale));

    if (orgasmMode) {
        // The engine's Force Orgasm ramp, on the allowance: from what was
        // last sent toward the wave's top, one ORGASM_RAMP_SECONDS-th of the
        // way a second. It wins over the edge and the stall guard, as it does
        // in every mode; the speed limit still bounds every stroke.
        const frame = orgasmFrame(seconds, orgasmBoost);
        const sent = orgasmFrom && typeof orgasmFrom === 'object' ? orgasmFrom.primary : undefined;
        const from = Number.isFinite(sent) ? Math.max(0, Math.min(100, roundSpeed(sent))) : allowance;
        const top = roundSpeed(frame.primary * intensityScale);
        allowance = Math.min(100, roundSpeed(from + (top - from) * frame.ease));
        phase = 'orgasm';
    }

    const rejoinLeftSeconds = rejoin < 1 && Number.isFinite(Number(sinceReleaseSeconds))
        ? Math.max(0, Math.ceil(rejoinSeconds - Number(sinceReleaseSeconds)))
        : 0;
    return { allowance, phase, s, approach: factor, rejoin, rejoinLeftSeconds };
}

// The status line's phase text: FREE / EASING 64% / SKIPPING: EDGE /
// REJOINING 5 s / LANDING / FORCE ORGASM. PAUSED and IDLE are the session's.
export function describeScriptPhase(result) {
    if (!result || typeof result !== 'object') return 'IDLE';
    switch (result.phase) {
        case 'free': return 'FREE';
        case 'easing': return `EASING ${Math.round(result.allowance)}%`;
        case 'skipping': return 'SKIPPING: EDGE';
        case 'intensity': return `INTENSITY ${Math.round(result.allowance)}%`;
        case 'stall': return 'SKIPPING: STALL GUARD';
        case 'rejoining': return `REJOINING ${Math.max(1, result.rejoinLeftSeconds || 0)} s`;
        case 'landing': return 'LANDING';
        case 'orgasm': return 'FORCE ORGASM';
        default: return 'IDLE';
    }
}
