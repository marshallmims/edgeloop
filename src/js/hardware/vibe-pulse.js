// Pulsed vibration for Buttplug vibrate actuators (Intiface). Pure: no
// timers, no sockets; intiface.js keeps the clock and asks this module what
// the axis should be at a given moment.
//
// Forum user Umbra250 (3 Oct): constant vibration numbs - the receptors
// adapt to a steady level and both feel and report less of it. A vibrate
// axis set to Pulsed does not tick on and off like a clock. It holds the
// engine's level for a run (a few beats), drops to 0 for a short rest, then
// comes back. The run and the rest change length, so the gap is a breath
// and not a metronome. The three spacings only change how often those rests
// arrive. The engine's level, under the axis's Max Power Cap, is the peak.
// The axis is never above it. A changed level still reaches the axis at once
// while it is on (the engine ticks once a second).

export const VIBE_MODES = Object.freeze(['constant', 'pulsed']);
export const DEFAULT_VIBE_MODE = 'constant';
export const PULSE_PERIODS_MS = Object.freeze([800, 1600, 2400]);
export const DEFAULT_PULSE_PERIOD_MS = 1600;

// Run lengths and rests, in fifths of the chosen spacing. The runs are
// several times the rests, and neighbouring phrases are different lengths,
// so the axis is on most of the time and the gaps do not land on one beat.
const RUN_FIFTHS = Object.freeze([12, 16, 21, 14, 25, 18]);
const REST_FIFTHS = Object.freeze([2, 4, 2, 5, 3, 2]);

// A stored or imported mode, or null when it is not one this build knows
// (the caller then keeps its own default: Constant, today's behaviour).
export function readVibeMode(value) {
    return VIBE_MODES.includes(value) ? value : null;
}

// A stored or imported period: one of PULSE_PERIODS_MS exactly, or null.
// Nothing in between is invented - a spacing is a choice of three, not a
// number to clamp.
export function readPulsePeriod(value) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
    return PULSE_PERIODS_MS.includes(n) ? n : null;
}

function fifthsMs(period, fifths) {
    return Math.round(period * fifths / 5);
}

// Phrase `index` of a train whose spacing is `period`: how long it holds the
// peak, then how long it rests.
export function pulsePhrase(index, periodMs = DEFAULT_PULSE_PERIOD_MS) {
    const period = readPulsePeriod(periodMs) || DEFAULT_PULSE_PERIOD_MS;
    const i = Math.max(0, Math.floor(Number(index) || 0));
    return {
        runMs: fifthsMs(period, RUN_FIFTHS[i % RUN_FIFTHS.length]),
        restMs: fifthsMs(period, REST_FIFTHS[i % REST_FIFTHS.length])
    };
}

// Where a train started at `startedAt` stands at `now`: on (at the peak) or
// off (at 0), and when that next changes. A clock that went backwards counts
// as the start of the train, so it is on, never stuck.
export function pulsePhase(startedAt, now, periodMs = DEFAULT_PULSE_PERIOD_MS) {
    const period = readPulsePeriod(periodMs) || DEFAULT_PULSE_PERIOD_MS;
    const start = Number(startedAt) || 0;
    const elapsed = Math.max(0, (Number(now) || 0) - start);
    let cursor = 0;
    for (let index = 0; index < 100000; index += 1) {
        const phrase = pulsePhrase(index, period);
        const runEnd = cursor + phrase.runMs;
        if (elapsed < runEnd) return { on: true, changeAt: start + runEnd };
        const restEnd = runEnd + phrase.restMs;
        if (elapsed < restEnd) return { on: false, changeAt: start + restEnd };
        cursor = restEnd;
    }
    return { on: true, changeAt: start + elapsed + period };
}

// What a pulsed axis is sent at a moment: the peak while on, 0 while off,
// and 0 whatever the phase when there is no peak (the engine stopped it).
export function pulseLevel(peak, on) {
    const p = Number(peak);
    return on && Number.isFinite(p) && p > 0 ? p : 0;
}
