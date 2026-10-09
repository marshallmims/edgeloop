// Stroke and speed patterns for the tease modes.
//
// Heart rate sets how hard the mode is allowed to push. Overlapping waves
// then move speed, length and the secondary channel so a steady pulse does
// not become a beat you can count.
// Nothing here knows about the hardware envelope: every stroke number is a
// percent of the range the wearer already set, and placeStroke() can only
// shrink inside the window it was given.

export const RUIN_RIDE_SECONDS = 12;
export const RUIN_LOCK_SECONDS = 18;
export const RUIN_LOCK_SECONDARY = 18;
const MIN_WIDTH = 10;

// Overlapping waves whose lengths do not divide into each other. A session
// never settles on one tempo you can count. `salt` gives each mode its own
// phase so two modes at the same second do not move together.
function wobble(seconds, period, phase) {
    const t = ((Number(seconds) || 0) + phase) / period;
    return 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
}

// How close the measured pulse is to the pullback mark before a mode is
// allowed to shorten, climb off the shaft, or really drop the toys.
// 0.80 of a 70–140 band is about 126 BPM. Below that, every mode rides the
// same heart-rate curve on a long stroke.
const CHARACTER_START = 0.80;
// The last few BPM, where a weave may actually dip. 0.94 is about 136 BPM.
const CLOSE_START = 0.94;

function bandCharacter(nearness) {
    return clamp((clamp(nearness, 0, 1) - CHARACTER_START) / (1 - CHARACTER_START), 0, 1);
}

function edgeClose(nearness) {
    return clamp((clamp(nearness, 0, 1) - CLOSE_START) / (1 - CLOSE_START), 0, 1);
}

// A beat of rest, then the stroke comes back. Only in the last stretch
// before the mark (`close` from edgeClose), and only when two waves that do
// not share a period both sit in a trough, so the rest is a beat or two and
// not a tick you can count. Below that stretch it is never a rest: a stop
// in the middle of the band is what used to hold a session under the max.
function phraseRest(seconds, salt, close) {
    if (!(close > 0.2)) return false;
    const a = wobble(seconds, 5.9, salt);
    const b = wobble(seconds, 9.4, salt + 3.3);
    return a < 0.2 && b < 0.3;
}

export function motion(seconds, salt = 0, nearness = 0) {
    const a = wobble(seconds, 5.3, salt);
    const b = wobble(seconds, 8.7, salt + 2.2);
    const c = wobble(seconds, 13.1, salt + 5.5);
    const d = wobble(seconds, 19.4, salt + 1.1);
    const close = edgeClose(nearness);
    const weave = 0.5 * a + 0.3 * b + 0.2 * c;
    // High floor through the band. A real dip, including two waves lining up
    // into a brief stop, opens only in the last stretch before the mark.
    const speedFloor = 0.8 - 0.52 * close;
    let speed = speedFloor + (1 - speedFloor) * weave;
    if (close > 0.55 && a < 0.16 && b < 0.22) speed *= 0.28;
    const depthWeave = 0.55 * wobble(seconds, 7.1, salt + 4) + 0.45 * d;
    const depthFloor = 0.6 - 0.32 * close;
    let depth = depthFloor + (1 - depthFloor) * depthWeave;
    if (close > 0.4 && speed > 0.72) depth = Math.min(depth, 0.48);
    else if (speed < 0.4) depth = Math.max(depth, 0.72);
    const secondaryFloor = 0.62 - 0.5 * close;
    const secondary = secondaryFloor + (1 - secondaryFloor) * (
        0.4 * c + 0.35 * wobble(seconds, 6.4, salt + 8) + 0.25 * a
    );
    return {
        speed: clamp(speed, 0, 1),
        depth: clamp(depth, 0.28, 1),
        secondary: clamp(secondary, 0, 1)
    };
}

// Force Orgasm. `boost` is seconds since the button (the same 1 BPM/s the
// ceiling already climbs). The motors ease up over ORGASM_RAMP_SECONDS and
// keep a wave at the top, instead of slamming every channel to a flat max.
export const ORGASM_RAMP_SECONDS = 28;

export function orgasmFrame(seconds, boost = 0) {
    const ramp = clamp((Number(boost) || 0) / ORGASM_RAMP_SECONDS, 0, 1);
    // Linear, so the first seconds are already hotter. A smoothstep sits
    // flat at the start and the button feels like it did nothing.
    const ease = ramp;
    const a = wobble(seconds, 4.7, 1.2);
    const b = wobble(seconds, 7.9, 3.4);
    const c = wobble(seconds, 11.3, 0.6);
    return {
        ease,
        primary: 78 + 22 * a,
        secondary: 70 + 30 * (0.6 * c + 0.4 * b),
        depth: clamp(1 - ease * 0.34 * (1 - b), 0.66, 1)
    };
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// Shrink `depth` (1 = the whole window) inside [min, max]. The result stays
// inside that window. `align: 'high'` keeps the top (head play); the default
// keeps the bottom (a short stroke that does not reach the tip).
export function placeStroke(min, max, depth, align = 'low') {
    let lo = clamp(Math.round(min), 0, 100);
    let hi = clamp(Math.round(max), 0, 100);
    if (hi < lo) [lo, hi] = [hi, lo];
    const span = hi - lo;
    const wanted = span * clamp(depth, 0, 1);
    const width = span <= MIN_WIDTH ? span : Math.max(MIN_WIDTH, Math.min(span, wanted));
    if (align === 'high') {
        return { min: Math.max(lo, hi - width), max: hi };
    }
    return { min: lo, max: Math.min(hi, lo + width) };
}

// Session-start wake-up. Speed and stroke length ease in over the warm-up
// the wearer already set. Zero minutes means no ramp.
export function warmupShape(seconds, warmupMinutes) {
    const mins = Number(warmupMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return { speed: 1, depth: 1 };
    const t = clamp((Number(seconds) || 0) / (mins * 60), 0, 1);
    const ease = t * t * (3 - 2 * t);
    return { speed: 0.16 + 0.84 * ease, depth: 0.28 + 0.72 * ease };
}

// A speed in whole percent that cannot round away to a stop. Only a speed
// that really is 0 stays 0.
export const MIN_MOVING_PERCENT = 1;
export function roundSpeed(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return clamp(Math.max(MIN_MOVING_PERCENT, Math.round(n)), 0, 100);
}

function roundPct(value) {
    return clamp(Math.round(value), 0, 100);
}

function atCeiling(crawlPercent) {
    return crawlPercent;
}

// Speeds and a stroke window, in percent of the wearer's travel envelope.
// `rawProgress` / `shapedProgress` may include the microphone boost (they
// only feed falling speeds and stroke contraction). `sensorRaw` is the
// measured pulse and is the only input to anything that rises.
export function teaseFrame({
    mode,
    rawProgress = 0,
    shapedProgress = 0,
    sensorRaw = 0,
    climbProgress = 0,
    atPeak = false,
    crawlPercent = 0,
    stallGuardEngaged = false,
    seconds = 0,
    ruinHoldSeconds = 0
}) {
    const raw = clamp(rawProgress, 0, 1);
    const shaped = clamp(shapedProgress, 0, 1);
    const sensor = clamp(sensorRaw, 0, 1);
    const climb = clamp(climbProgress, 0, 1);
    if (mode === 'shortener') {
        const beat = motion(seconds, 1.4, sensor);
        // Quicker than the shared curve, and never slower than it, so the
        // shorter stroke does not arrive as a stall in the middle of the band.
        const shared = (1 - shaped) * 100;
        const quicker = (1 - raw * 0.5) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(Math.max(shared, quicker) * beat.speed);
        // The window stays the full range until the pulse is close, then
        // closes on the base. At the mark it is the bottom 35%.
        const bite = atPeak ? 1 : bandCharacter(sensor);
        const top = Math.max(35, Math.round(100 - bite * 65));
        const stroke = placeStroke(0, top, atPeak ? 1 : beat.depth, 'low');
        const secondary = roundPct(6 + beat.secondary * 16);
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'headplay') {
        const beat = motion(seconds, 3.1, sensor);
        // Same backoff as the other modes. A linear drop used to leave this
        // one at a crawl around 120 BPM, while the stroke had already climbed
        // off the shaft.
        const falling = (1 - shaped) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * beat.speed);
        const bite = atPeak ? 1 : bandCharacter(sensor);
        // Until the climb starts, a short weave would pin the stroke at the
        // head (high align keeps the top). Hold the length open so it still
        // covers the shaft.
        const depth = bite > 0 ? beat.depth : Math.max(beat.depth, 0.85);
        const stroke = placeStroke(Math.round(bite * 75), 100, atPeak ? 1 : depth, 'high');
        const secondary = atPeak ? primary : roundPct(primary * (0.45 + 0.55 * beat.secondary));
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'milker') {
        // Short bursts wait until the pulse is actually near the mark. The
        // cross-fade (stroker down, internal toy up) still runs the whole band.
        // Near the mark the stroker does a few short strokes and then stops
        // for a beat. The internal toy rests on a different phrase, so one of
        // them is usually still moving, and neither ticks like a clock.
        const milking = sensor >= CLOSE_START;
        const close = edgeClose(sensor);
        const beat = motion(seconds, milking ? 9.2 : 2.4, sensor);
        const strokerRest = milking && !atPeak && phraseRest(seconds, 8.2, close);
        const vibeRest = milking && !atPeak && phraseRest(seconds, 2.6, close);
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 80;
        // The falling curve is nearly stopped by the time the bursts open.
        // A burst here is a few real strokes, then the beat of rest, not
        // another shade of that fade.
        const burst = roundPct(52 + 28 * beat.speed);
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : (strokerRest ? 0 : roundPct(milking ? burst : basePrimary * beat.speed));
        const secondaryGain = milking ? beat.secondary : (0.35 + 0.65 * beat.secondary);
        const secondary = vibeRest ? 0 : roundPct((atPeak ? 100 : baseSecondary) * secondaryGain);
        const depth = milking && !atPeak ? Math.min(beat.depth, strokerRest ? 0.5 : 0.45) : beat.depth;
        const stroke = placeStroke(0, 100, depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ultimate') {
        // Stop-go is the last chapter, right against the pullback mark.
        // Opening it at 0.72 put a 70/140 session into stops around 120 BPM,
        // and the toy would hold the pulse there instead of at the max.
        // In that last chapter the stroker runs a few short strokes, stops
        // for a beat, and starts again. The internal toy takes the same
        // breath, a little softer, so the pause is shared.
        const chapter = sensor < 0.45 ? 0 : sensor < CLOSE_START ? 1 : 2;
        const close = edgeClose(sensor);
        const beat = motion(seconds, 4 + chapter * 3.7, sensor);
        const resting = chapter === 2 && !atPeak && phraseRest(seconds, 4.4, close);
        const bursting = chapter === 2 && !atPeak && !resting;
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 70;
        // Same as the milker: the last chapter is a few real strokes and a
        // beat of rest. The fade has already done its job by then.
        const burst = roundPct(64 + 26 * beat.speed);
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : (resting ? 0 : roundPct(bursting ? burst : basePrimary * beat.speed));
        let secondary = roundPct((atPeak ? 100 : baseSecondary) * beat.secondary);
        if (resting) secondary = roundPct(secondary * 0.3);
        let depth = beat.depth;
        if (chapter === 0) depth = Math.max(depth, 0.82);
        else if (bursting) depth = Math.min(depth, 0.42);
        else if (resting) depth = Math.min(depth, 0.45);
        const stroke = placeStroke(0, 100, depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ruin') {
        if (ruinHoldSeconds > 0) {
            return { primary: 0, secondary: RUIN_LOCK_SECONDARY, strokeMin: 0, strokeMax: 100 };
        }
        // The ride keeps a real stroke on the mark. The near-stop weave is
        // for the tease modes; this one cuts later, on its own lockout.
        const beat = motion(seconds, 6.6, 0);
        const base = atPeak ? 74 : 48 + (1 - shaped) * 52;
        const secondaryBase = 28 + climb * 42;
        const stroke = placeStroke(0, 100, beat.depth, 'low');
        return {
            primary: roundPct(base * beat.speed),
            secondary: roundPct(secondaryBase * beat.secondary),
            strokeMin: stroke.min,
            strokeMax: stroke.max
        };
    }

    if (mode === 'finisher') {
        // The climb reads the measured pulse, never the microphone boost.
        // On the mark the stroke stays at full speed: Crawl and Full Stop
        // are for the modes that ease off, and this one is here to carry
        // the wearer over.
        const beat = motion(seconds, 2.2, sensor);
        const rising = 18 + climb * 82;
        const primary = atPeak ? 100 : roundPct(rising * beat.speed);
        const secondary = atPeak ? 100 : roundPct((18 + climb * 70) * beat.secondary);
        const stroke = placeStroke(0, 100, atPeak ? 1 : beat.depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    const beat = motion(seconds, 0.6, sensor);
    const falling = (1 - shaped) * 100;
    // A rare breath, only once the pulse is close. The stroker stops for a
    // beat and the other toy eases; the rest of the band stays a continuous
    // stroke, so the stop is the surprise and not the tempo.
    const stroked = roundPct(falling * beat.speed);
    const close = edgeClose(sensor);
    const breath = !atPeak && close > 0.55 && phraseRest(seconds, 1.7, close) && wobble(seconds, 17.3, 4.4) < 0.18;
    const primary = atPeak ? atCeiling(crawlPercent) : (breath ? 0 : stroked);
    const followed = roundPct(stroked * (0.5 + 0.5 * beat.secondary));
    const secondary = atPeak ? primary : (breath ? roundPct(followed * 0.4) : followed);
    const stroke = placeStroke(0, 100, atPeak ? 1 : beat.depth, 'low');
    return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
}
