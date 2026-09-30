/**
 * Core Biofeedback calculation engine.
 * Every cockpit data-mode must exist in ENGINE_MODES or it falls back to classic.
 *
 * Pure: no DOM, no I/O. Fail-safe by construction: any non-finite input
 * yields zero motor output, the stroke zone can never invert or collapse,
 * and an edge is only released once the pulse has clearly come back down.
 */
import { normalizeEnvelope } from './hardware/handy-protocol.js';
import { teaseFrame, warmupShape, placeStroke, orgasmFrame } from './patterns.js';

export const TEASE_MODES = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin'];
export const GAME_MODES = ['oracle', 'survival', 'edgetrain', 'calibrate'];

export function resolveTeaseMode(strokeMode, activeMode) {
    if (TEASE_MODES.includes(strokeMode)) return strokeMode;
    if (TEASE_MODES.includes(activeMode)) return activeMode;
    return 'classic';
}

export const ENGINE_MODES = [
    'classic',
    'milker',
    'shortener',
    'headplay',
    'ultimate',
    'ruin',
    'oracle',
    'survival',
    'edgetrain',
    'calibrate'
];

function isUncappedClimb(mode) {
    return mode === 'survival' || mode === 'calibrate';
}

// Hysteresis: once edged, the flag only clears when HR drops MORE than this
// many BPM below the typed climax ceiling, so a reading hovering at the
// limit cannot flap the motors on and off or count phantom edges.
export const EDGE_RELEASE_BPM = 5;

// Pullback as a percent of the working Climax HR. 100% is that ceiling; 95%
// pulls back early. It can never be more than 100%: the typed Climax HR is a
// hard ceiling, so the crawl / Full Stop rule and the stall guard must fire
// at it or below it, never above it.
export const MIN_EDGE_HOLD_PERCENT = 90;
export const MAX_EDGE_HOLD_PERCENT = 100;
export const DEFAULT_EDGE_HOLD_PERCENT = 100;

export function clampEdgeHoldPercent(value, fallback = DEFAULT_EDGE_HOLD_PERCENT) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT);
}

// The pullback mark. It is bounded at both ends: never above the working
// ceiling, and never so low that its release band (EDGE_RELEASE_BPM below it)
// falls to the resting rate, which would latch the session edged from the
// first reading with a release point the wearer can never reach. With a typed
// band too narrow for that margin the mark simply sits at the ceiling.
export function resolveEdgeTriggerHr(maxHr, holdPercent = DEFAULT_EDGE_HOLD_PERCENT, minHr) {
    if (!Number.isFinite(maxHr)) return maxHr;
    const pct = clampEdgeHoldPercent(holdPercent, DEFAULT_EDGE_HOLD_PERCENT);
    const raw = Math.max(1, Math.round(maxHr * (pct / 100)));
    const capped = Math.min(maxHr, raw);
    if (!Number.isFinite(minHr)) return capped;
    const lowest = Math.min(maxHr, minHr + EDGE_RELEASE_BPM + 1);
    return Math.max(capped, lowest);
}

// The Guards preview line. The pullback mark is NOT always the percentage
// of the ceiling: `resolveEdgeTriggerHr` lifts it whenever that percentage
// would land inside the release band above the resting rate, and a preview
// that still quoted the percentage described a number it was no longer
// producing ("Pullback at 94 BPM (90% of 95)" for a Resting 88 / Climax 95
// pair, where 90% of 95 is 86 - a resting rate sitting close under the low
// Climax HR the README sends prostate users to). It now says what actually
// happened instead.
export function describeEdgeHoldPreview({ typedMaxHr, workingMaxHr, minHr, holdPercent } = {}) {
    const pct = clampEdgeHoldPercent(holdPercent, DEFAULT_EDGE_HOLD_PERCENT);
    const max = Number.isFinite(workingMaxHr) ? workingMaxHr : typedMaxHr;
    if (!Number.isFinite(max)) return 'Pullback mark: type a Resting and a Climax HR first.';
    const trigger = resolveEdgeTriggerHr(max, pct, minHr);
    const base = max === typedMaxHr ? `${typedMaxHr}` : `${max}, the working ceiling right now`;
    // The mark the percentage alone would give, before the resting-rate floor.
    const fromPercent = Math.min(max, Math.max(1, Math.round(max * (pct / 100))));
    if (trigger === fromPercent) {
        return `Pullback at ${trigger} BPM (${pct}% of ${base})`;
    }
    const baseMid = max === typedMaxHr ? `${typedMaxHr}` : `${max}, the working ceiling right now,`;
    return `Pullback at ${trigger} BPM - ${pct}% of ${baseMid} is ${fromPercent}, `
        + `lifted to clear your Resting HR (${minHr})`;
}

export function edgeReleaseHr(maxHr, triggerHr) {
    if (!Number.isFinite(maxHr)) return maxHr;
    const top = Number.isFinite(triggerHr) ? Math.min(maxHr, triggerHr) : maxHr;
    return top - EDGE_RELEASE_BPM;
}

// The narrowest stroke zone (percent of the hardware envelope) the engine
// will ever emit. Anything tighter jams the sleeve in place.
export const MIN_ZONE_WIDTH = 10;

// Primary / secondary speed while parked at the ceiling in Crawl mode
// (ceilingBehaviour 'crawl'); Full Stop ('stop') parks at 0%.
export const CRAWL_PERCENT = 10;
export const CEILING_BEHAVIOURS = ['stop', 'crawl'];

// Glans Protector: the stroke zone contracts from the full range at rest
// toward 0-SHORTENER_TOP_PERCENT (base micro-strokes) at the ceiling.
export const SHORTENER_TOP_PERCENT = 35;

export function resolveCeilingBehaviour(value) {
    return value === 'stop' ? 'stop' : 'crawl';
}

export function resolveEngineMode(mode) {
    return ENGINE_MODES.includes(mode) ? mode : 'classic';
}

// Does the microphone boost reach a motor in this mode? The boost rides on
// `hr`, which drives the falling tease curve and the stroke-depth
// contraction that shares it; every term that RISES with arousal reads the
// measured pulse (`edgeHr`) instead. The two climb games compute BOTH
// channels from the measured pulse and fix their stroke zone per game state,
// so there the boosted pulse reaches nothing at all and a cockpit badge
// promising "MIC +N" promises a push nothing is making - the wearer goes off
// and adjusts the gate and the cap, and nothing changes. Survival runs its
// speeds off its own clock and lets the boost contract the stroke zone only,
// which is a no-op at full depth.
export function micBoostReachesMotors(activeMode, { edgeStrokeDepth = 100 } = {}) {
    const mode = resolveEngineMode(activeMode);
    if (mode === 'oracle' || mode === 'edgetrain') return false;
    if (isUncappedClimb(mode)) return clamp(finiteOr(Number(edgeStrokeDepth), 100), 0, 100) < 100;
    return true;
}

export function hasReleasedEdge(hr, maxHr, triggerHr) {
    const release = edgeReleaseHr(maxHr, triggerHr);
    return Number.isFinite(hr) && Number.isFinite(release) && hr < release;
}

// The release question the Oracle and Edge Training ask once a second, and
// the ONLY way they may ask it. `hasReleasedEdge` falls back to `maxHr - 5`
// when it is handed no pullback mark, and with any pullback below 100% that
// band sits ABOVE the mark: the game would clear the edge flag while the
// engine still reads the pulse as edged, and the next tick counts an invented
// edge that Adaptive Ceiling Decay then acts on. A mark that is not a finite
// number is not an answer, so this refuses to say "released" rather than
// guessing one - `state.edgeTriggerHr` starts as null, and a caller that
// reaches this before the engine's first tick must get "no", not a fallback.
//
// Force Orgasm is the same answer here as it is inside the engine: no. The
// overdrive raises the working ceiling 1 BPM per second and the release band
// rides up with it, so after a few seconds a pulse parked ON the mark reads
// as "released" against a ceiling that only moved because the wearer armed
// the button. calculateEngineOutputs freezes the edge flag for exactly that
// reason; a game asking its own release question has to get the same answer,
// or cancelling Force Orgasm counts an edge the pulse never gave.
export function gameEdgeReleased(hr, maxHr, triggerHr, { orgasmMode = false } = {}) {
    if (orgasmMode) return false;
    if (!Number.isFinite(triggerHr)) return false;
    return hasReleasedEdge(hr, maxHr, triggerHr);
}

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// Order, clamp and widen the hardware envelope. An inverted pair is swapped
// (not collapsed) so a hand-edited 90/10 still yields 10-90 of travel.
function safeEnvelope(hwMin, hwMax) {
    const a = Number(hwMin);
    const b = Number(hwMax);
    const lo = Number.isFinite(a) ? a : 0;
    const hi = Number.isFinite(b) ? b : 100;
    return normalizeEnvelope(Math.min(lo, hi), Math.max(lo, hi));
}

export function calculateEngineOutputs({
    hr,
    // The sensor's own pulse. `hr` may carry the microphone boost, which
    // drives the FALLING tease curve and the stroke-depth contraction that
    // shares it (`strokeMax` everywhere, plus `strokeMin` in Glans Protector
    // and Head Play): more progress there means less motion, so the boost can
    // only ever back the toys off. The edge flag, every guard, game and
    // counter, the two climb games' rising ramps and every RISING secondary
    // (milker) term all judge `edgeHr`, the pulse that was actually measured.
    edgeHr,
    minHr,
    maxHr,
    activeMode,
    sessionStatus,
    rampdownSecondsLeft,
    isEdged,
    orgasmMode,
    // Seconds since Force Orgasm was armed. The ceiling already climbs 1 BPM
    // per second from this; the motors ramp on the same clock.
    orgasmBoost = 0,
    gamma = 2.0,
    intensityValue = 50,
    edgeStrokeDepth = 100,
    handyHwMin = 0,
    handyHwMax = 100,
    sessionSeconds = 0,
    warmupMinutes = 0,
    cadenceBreathing = false,
    milkingWave = false,
    stallGuardEngaged = false,
    ceilingBehaviour = 'crawl',
    edgeHoldPercent = DEFAULT_EDGE_HOLD_PERCENT,
    ruinHoldSeconds = 0,
    strokeMode,
    oracleState = 'IDLE',
    survivalSpeedFloor = 30,
    trainingState = 'climb'
}) {
    const mode = resolveEngineMode(activeMode);
    const teaseMode = resolveTeaseMode(strokeMode, mode);
    // The hardware envelope is normalised here so an inverted, narrow or
    // garbage envelope (hand-edited settings) can never invert the zone.
    const env = safeEnvelope(handyHwMin, handyHwMax);
    const silent = {
        primaryPercent: 0,
        secondaryPercent: 0,
        strokeMinPercent: env.min,
        strokeMaxPercent: env.max,
        isEdged: false,
        newEdgeTriggered: false,
        resolvedMode: mode
    };

    // Motors are silent in every other status, but the edge flag is state,
    // not output: clearing it here would re-arm the detector, so the first
    // RUNNING tick after a pause (including every watchdog auto-resume) would
    // count the edge the wearer is still sitting on as a brand-new one.
    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') {
        return { ...silent, isEdged: Boolean(isEdged) };
    }

    // Fail safe: a NaN heart rate or limit stops the motors and keeps the
    // edge flag as it was (bad data must never release an edge either).
    if (!Number.isFinite(hr) || !Number.isFinite(minHr) || !Number.isFinite(maxHr)) {
        return { ...silent, isEdged: Boolean(isEdged) };
    }

    const gammaSafe = Number.isFinite(gamma) && gamma > 0 ? gamma : 2.0;
    const intensitySafe = clamp(finiteOr(intensityValue, 50), 0, 100);
    const depthSafe = clamp(finiteOr(edgeStrokeDepth, 100), 0, 100);
    const rampLeft = clamp(finiteOr(rampdownSecondsLeft, 0), 0, 45);
    const seconds = Math.max(0, finiteOr(sessionSeconds, 0));

    let nextIsEdged = Boolean(isEdged);
    let newEdgeTriggered = false;

    const triggerHr = resolveEdgeTriggerHr(maxHr, edgeHoldPercent, minHr);
    const edgeSource = Number.isFinite(edgeHr) ? edgeHr : hr;

    // Force Orgasm FREEZES the edge flag; it never clears it. The overdrive
    // raises the working ceiling 1 BPM per second, and the pullback mark
    // rides up with it, so after a few seconds a pulse parked ON the mark
    // sits below the release band of a ceiling that only moved because the
    // wearer armed the button. Releasing the edge on that evidence counted a
    // phantom edge the moment they cancelled - the counter, the edge cue, a
    // rotator reversal and Adaptive Ceiling Decay - while the pulse had
    // never left the mark. New edges were already suppressed here; releases
    // are too, so the flag stays whatever the pulse last really said and the
    // first tick after a cancel judges it against the real ceiling again.
    if (edgeSource >= triggerHr) {
        if (!isEdged && !orgasmMode && sessionStatus !== 'RAMPDOWN') {
            newEdgeTriggered = true;
            nextIsEdged = true;
        }
    } else if (!orgasmMode && hasReleasedEdge(edgeSource, maxHr, triggerHr)) {
        nextIsEdged = false;
    }

    // The tease band runs from the resting rate to the pullback mark, so the
    // curve reaches 0% exactly where crawl / Full Stop takes over. The mark is
    // never above the working ceiling, so neither is the band.
    const span = Math.max(1, triggerHr - minHr);
    const rawProgress = clamp((hr - minHr) / span, 0, 1);
    const progress = Math.pow(rawProgress, gammaSafe);
    // The same curve on the MEASURED pulse, for every term that RISES with
    // progress. Each tease mode maps progress onto a falling primary, so the
    // boost can only ever back that channel off. But the climb games invert
    // it (`48 + progress * 52`), and the milking modes cross-fade a rising
    // secondary against that falling primary (`20 + progress * 80`): fed the
    // boosted pulse, both drive a motor UP on nothing but room noise - the
    // primary to 100% for the last BPM of the approach, the internal toy from
    // a measured 26-30 to 52-60. Every rising term reads the sensor alone, so
    // the microphone can only ever ease the toys off, on either channel.
    const sensorRawProgress = clamp((edgeSource - minHr) / span, 0, 1);
    const climbProgress = Math.pow(sensorRawProgress, gammaSafe);

    let primaryPercent = 0;
    let secondaryPercent = 0;
    let strokeMinPercent = 0;
    let strokeMaxPercent = 100;

    const depthContractAmount = 100 - depthSafe;
    // At the ceiling the user chooses Full Stop (0%) or Crawl (CRAWL_PERCENT).
    const crawl = resolveCeilingBehaviour(ceilingBehaviour) === 'crawl';
    const crawlPercent = crawl ? CRAWL_PERCENT : 0;

    // Stall guard only ever cuts the PRIMARY stroker: the secondary
    // channel keeps whatever the mode gives it at the ceiling.
    const teaseArgs = {
        mode: teaseMode,
        rawProgress: clamp((hr - minHr) / span, 0, 1),
        shapedProgress: progress,
        sensorRaw: sensorRawProgress,
        climbProgress,
        atPeak: nextIsEdged && !orgasmMode,
        crawlPercent,
        stallGuardEngaged,
        seconds,
        ruinHoldSeconds
    };
    const stroke = teaseFrame(teaseArgs);
    const isGame = mode === 'oracle' || mode === 'edgetrain' || isUncappedClimb(mode);

    if (sessionStatus === 'RAMPDOWN') {
        const rampFactor = Math.max(0, rampLeft / 45);
        primaryPercent = Math.round(50 * rampFactor);
        secondaryPercent = Math.round(50 * rampFactor);
    } else if (mode === 'oracle') {
        const oracle = applyOracle(oracleState, climbProgress, nextIsEdged, orgasmMode, seconds, crawlPercent);
        primaryPercent = oracle.primary;
        secondaryPercent = oracle.secondary;
    } else if (isUncappedClimb(mode)) {
        const floor = clamp(finiteOr(survivalSpeedFloor, 30), 5, 100);
        // Force Orgasm ramps from this floor; it does not replace it with a flat 100.
        primaryPercent = floor;
        secondaryPercent = Math.round(floor * 0.7);
    } else if (mode === 'edgetrain') {
        const train = applyEdgeTrain(trainingState, climbProgress, nextIsEdged, orgasmMode, crawlPercent);
        primaryPercent = train.primary;
        secondaryPercent = train.secondary;
    } else {
        const tease = isGame ? stroke : teaseFrame({ ...teaseArgs, mode });
        primaryPercent = tease.primary;
        secondaryPercent = tease.secondary;
    }

    // Games keep their own speeds. The stroke always comes from the tease
    // mode the wearer selected, then the warm-up and the envelope below
    // can only shrink it further. A game used to substitute its own zone.
    strokeMinPercent = stroke.strokeMin;
    strokeMaxPercent = stroke.strokeMax;
    // Calibration is measuring a climax, so the stroke must not shorten as
    // the pulse climbs the way a tease mode does. Survival still borrows
    // the selected stroke.
    if (mode === 'calibrate') {
        strokeMinPercent = 0;
        strokeMaxPercent = 100;
    }

    // Force Orgasm eases both channels up from whatever the mode was doing
    // and keeps a wave at the top. It never drops a toy that was already
    // hotter, and the stroke opens toward the full travel window. The
    // working ceiling climbs on the same clock (app.js), so the pulse is
    // allowed past the typed max until the wearer finishes.
    if (orgasmMode && sessionStatus === 'RUNNING') {
        const frame = orgasmFrame(seconds, orgasmBoost);
        const ease = frame.ease;
        primaryPercent = Math.round(primaryPercent * (1 - ease) + frame.primary * ease);
        secondaryPercent = Math.round(secondaryPercent * (1 - ease) + frame.secondary * ease);
        const openMin = strokeMinPercent * (1 - ease);
        const openMax = strokeMaxPercent + (100 - strokeMaxPercent) * ease;
        const opened = placeStroke(openMin, openMax, frame.depth, 'low');
        strokeMinPercent = opened.min;
        strokeMaxPercent = opened.max;
    }

    if (stallGuardEngaged && !orgasmMode && sessionStatus === 'RUNNING') {
        primaryPercent = 0;
    }

    // Wake-up: a resting pulse used to mean full speed on the first tick.
    // Over the warm-up the wearer set, speed and stroke length ease in from
    // a short slow stroke. The stroke still starts at the bottom of whatever
    // window the mode asked for, which is already inside the travel envelope.
    // Warm-up eases a normal session in. Calibration's own clock is that
    // ease; stacking the warm-up on it holds the toys down for minutes.
    if (!orgasmMode && sessionStatus === 'RUNNING' && mode !== 'calibrate') {
        const wake = warmupShape(seconds, warmupMinutes);
        if (wake.depth < 1 || wake.speed < 1) {
            const woken = placeStroke(strokeMinPercent, strokeMaxPercent, wake.depth, 'low');
            strokeMinPercent = woken.min;
            strokeMaxPercent = woken.max;
            primaryPercent = Math.round(primaryPercent * wake.speed);
            secondaryPercent = Math.round(secondaryPercent * wake.speed);
        }
    }

    // Optional stored stroke-depth contraction. Default depth is the full
    // window, so this is a no-op until a backup carries a smaller value.
    // It reads the boosted curve, so a louder room can only shorten travel.
    if (depthContractAmount > 0) {
        const cut = progress * depthContractAmount;
        strokeMaxPercent = Math.max(strokeMinPercent, Math.round(strokeMaxPercent - cut));
    }

    const intensityScale = 0.5 + (intensitySafe / 100);
    if (primaryPercent > 0) {
        primaryPercent = Math.min(100, Math.round(primaryPercent * intensityScale));
    }
    if (secondaryPercent > 0) {
        secondaryPercent = Math.min(100, Math.round(secondaryPercent * intensityScale));
    }

    // Zone sanity: whatever the mode and warm-up cap did, the zone must stay
    // ordered and at least MIN_ZONE_WIDTH wide. The cap (upper bound) wins,
    // so the lower bound is pulled down first; only when the cap itself sits
    // below the minimum width is it raised.
    strokeMinPercent = clamp(Math.round(finiteOr(strokeMinPercent, 0)), 0, 100);
    strokeMaxPercent = clamp(Math.round(finiteOr(strokeMaxPercent, 100)), 0, 100);
    if (strokeMaxPercent - strokeMinPercent < MIN_ZONE_WIDTH) {
        strokeMinPercent = Math.max(0, strokeMaxPercent - MIN_ZONE_WIDTH);
        if (strokeMaxPercent - strokeMinPercent < MIN_ZONE_WIDTH) {
            strokeMaxPercent = Math.min(100, strokeMinPercent + MIN_ZONE_WIDTH);
        }
    }

    const envSpan = env.max - env.min;
    // The wearer's travel limits are the last word. A mode, a pattern, a
    // game, warm-up, or Force Orgasm can use less of that range. None of
    // them can stroke past it.
    let physicalMin = clamp(Math.round(env.min + (strokeMinPercent / 100) * envSpan), env.min, env.max);
    let physicalMax = clamp(Math.round(env.min + (strokeMaxPercent / 100) * envSpan), env.min, env.max);
    if (physicalMax < physicalMin) [physicalMin, physicalMax] = [physicalMax, physicalMin];

    return {
        primaryPercent: clamp(finiteOr(primaryPercent, 0), 0, 100),
        secondaryPercent: clamp(finiteOr(secondaryPercent, 0), 0, 100),
        strokeMinPercent: physicalMin,
        strokeMaxPercent: Math.max(physicalMin, physicalMax),
        isEdged: nextIsEdged,
        newEdgeTriggered,
        resolvedMode: mode
    };
}

function applyOracle(oracleState, progress, nextIsEdged, orgasmMode, sessionSeconds, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    // Force Orgasm is applied once, after this, so a climax ramps instead of
    // replacing the game with a flat 100. `orgasmMode` stays on the signature
    // so a caller cannot forget the flag exists; the ramp reads it.
    void orgasmMode;
    // Every Oracle state below HOLD is reached with the wearer parked at the
    // pullback mark (app.js only enters HOLD from `state.isEdged`, and the
    // flag is not cleared until the pulse drops out of the release band), so
    // the wearer's "At the ceiling" rule decides the primary there exactly as
    // it does in Edge Training and every tease mode: Full Stop parks it at
    // 0%, Crawl keeps the micro-motion. Force Orgasm ramps over that after
    // this function returns. The stall guard is disarmed for this mode, so
    // nothing else would.
    // The secondary channel keeps the game's own level.
    switch (oracleState) {
        case 'HOLD':
            out.primary = crawlPercent;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'DENIAL':
            out.primary = 0;
            out.secondary = 0;
            out.strokeMax = 40;
            break;
        case 'PURGATORY': {
            const swing = 28 + Math.round(32 * (0.5 + 0.5 * Math.sin(sessionSeconds * 1.3)));
            out.primary = nextIsEdged ? crawlPercent : swing;
            out.secondary = 40 + Math.round(30 * (0.5 + 0.5 * Math.sin(sessionSeconds * 0.8)));
            out.strokeMax = 80;
            break;
        }
        // CLIMAX is reached with Force Orgasm ON (app.js arms it with the
        // roll). The ramp above lifts that. Reaching CLIMAX with it OFF
        // means the wearer cancelled: app.js hands the game back to APPROACH
        // on the very next tick. A withdrawn climax IS the approach, so it
        // settles there immediately instead of surging.
        case 'CLIMAX':
        case 'APPROACH':
        default: {
            const pull = Math.round(48 + progress * 52);
            out.primary = nextIsEdged ? crawlPercent : pull;
            out.secondary = nextIsEdged ? 40 : Math.round(30 + progress * 50);
            out.strokeMax = 100;
        }
    }
    return out;
}

function applyEdgeTrain(trainingState, progress, nextIsEdged, orgasmMode, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    // Same as Oracle: Force Orgasm ramps after the game picks a speed.
    void orgasmMode;
    // 'finish' is the completed set, and app.js arms Force Orgasm with it.
    // The ramp lifts that. Reaching 'finish' with Force Orgasm OFF means the
    // wearer cancelled. tickEdgeTraining hands the game back to the climb on
    // the next tick; the switch below sends 'finish' down the climb branch,
    // so the cancel settles immediately instead of surging.
    //
    // A training hold is a hold AT the pullback mark, so the wearer's
    // ceiling rule decides the primary there exactly as it does in every
    // other mode: Full Stop parks it at 0%, Crawl keeps the micro-motion.
    // Force Orgasm ramps over that after this function returns. The secondary channel is not
    // governed by that rule and keeps the game's own level.
    switch (trainingState) {
        case 'hold':
            out.primary = crawlPercent;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'recover':
            // Recover is still a hold at the mark: tickEdgeTraining only
            // leaves it once the pulse has dropped out of the release band,
            // so the ceiling rule governs the primary here exactly as it
            // does in the hold. A dead stop is the premise of Ruin & Leak,
            // not of recover - a wearer who picked Crawl because a full stop
            // kills their edge was given 0% after every counted hold.
            out.primary = crawlPercent;
            out.secondary = 35;
            out.strokeMax = 55;
            break;
        default: {
            const pull = Math.round(48 + progress * 52);
            out.primary = nextIsEdged ? crawlPercent : pull;
            out.secondary = nextIsEdged ? 40 : Math.round(30 + progress * 50);
            out.strokeMax = 100;
        }
    }
    return out;
}
