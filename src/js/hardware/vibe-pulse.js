// Pulsed vibration for Buttplug vibrate actuators (Intiface). Pure: no
// timers, no sockets; intiface.js keeps the clock and asks this module what
// the axis should be at a given moment.
//
// A vibrate axis set to Pulsed does not hold one level and it does not tick.
// It ramps up, ramps down, ramps again, then rests for a beat, and the
// lengths change so the rests do not land on one clock. The three spacings
// only change how often that rest arrives. The engine's level, under the
// axis's Max Power Cap, is the peak. The axis is never above it.

export const VIBE_MODES = Object.freeze(['constant', 'pulsed']);
export const DEFAULT_VIBE_MODE = 'pulsed';
export const PULSE_PERIODS_MS = Object.freeze([800, 1600, 2400]);
export const DEFAULT_PULSE_PERIOD_MS = 1600;
const STEP_MS = 200;

// Each row is one phrase, in fifths of the chosen spacing: rise, fall,
// rise, fall, rest. Neighbouring phrases are different lengths.
const SHAPES = Object.freeze([
    Object.freeze([4, 3, 5, 3, 2]),
    Object.freeze([6, 4, 3, 5, 3]),
    Object.freeze([3, 5, 6, 2, 2]),
    Object.freeze([5, 2, 4, 6, 4])
]);
const KINDS = Object.freeze(['rise', 'fall', 'rise', 'fall', 'rest']);

function fifthsMs(period, fifths) {
    return Math.max(STEP_MS, Math.round(period * fifths / 5));
}

// Phrase `index`: the ramps, then the rest.
export function pulsePhrase(index, periodMs = DEFAULT_PULSE_PERIOD_MS) {
    const period = readPulsePeriod(periodMs) || DEFAULT_PULSE_PERIOD_MS;
    const shape = SHAPES[Math.max(0, Math.floor(Number(index) || 0)) % SHAPES.length];
    const segments = shape.map((fifths, i) => ({ kind: KINDS[i], ms: fifthsMs(period, fifths) }));
    const rest = segments[segments.length - 1];
    return { segments, restMs: rest.ms, runMs: segments.reduce((sum, seg) => sum + seg.ms, 0) - rest.ms };
}

function gainAt(kind, along) {
    const t = Math.max(0, Math.min(1, along));
    if (kind === 'rest') return 0;
    if (kind === 'fall') return 0.12 + 0.88 * (1 - t);
    return 0.12 + 0.88 * t;
}

// Where a train started at `startedAt` stands at `now`. `gain` is 0 on a
// rest and otherwise a fraction of the peak. `changeAt` is the next step a
// ramp should be sent, or the end of a rest. A clock that went backwards
// counts as the start of the train.
export function pulsePhase(startedAt, now, periodMs = DEFAULT_PULSE_PERIOD_MS) {
    const period = readPulsePeriod(periodMs) || DEFAULT_PULSE_PERIOD_MS;
    const start = Number(startedAt) || 0;
    const elapsed = Math.max(0, (Number(now) || 0) - start);
    let cursor = 0;
    for (let index = 0; index < 100000; index += 1) {
        const phrase = pulsePhrase(index, period);
        for (const segment of phrase.segments) {
            const end = cursor + segment.ms;
            if (elapsed < end) {
                const along = segment.ms <= 0 ? 1 : (elapsed - cursor) / segment.ms;
                const gain = gainAt(segment.kind, along);
                const changeAt = segment.kind === 'rest'
                    ? start + end
                    : start + Math.min(end, cursor + Math.floor((elapsed - cursor) / STEP_MS) * STEP_MS + STEP_MS);
                return { gain, on: gain > 0.04, changeAt };
            }
            cursor = end;
        }
    }
    return { gain: 1, on: true, changeAt: start + elapsed + period };
}

// What a pulsed axis is sent: the peak times the ramp, and 0 on a rest or
// when the engine has stopped the axis.
export function pulseLevel(peak, gain) {
    const p = Number(peak);
    const g = Number(gain);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(g) || g <= 0) return 0;
    return Math.round(p * Math.min(1, g) * 1000) / 1000;
}

export function readVibeMode(value) {
    return VIBE_MODES.includes(value) ? value : null;
}

export function readPulsePeriod(value) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
    return PULSE_PERIODS_MS.includes(n) ? n : null;
}
