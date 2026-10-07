// Pulsed vibration for Buttplug vibrate actuators (Intiface). Pure: no
// timers, no sockets; intiface.js keeps the clock and asks this module what
// the axis should be at a given moment. The square wave is the schedule from
// Purple Palm's fork.
//
// Forum user Umbra250 (3 Oct): constant vibration numbs - the receptors
// adapt to a steady level and both feel and report less of it - and pulsing
// a prostate vibrator from 0 to 50% every 0.8, 1.6 or 2.4 s kept him more
// sensitive. A vibrate axis set to Pulsed runs a square wave: at the peak for
// the first half of each period, at 0 for the second, counted from the
// moment the train starts. The engine's level for the axis, under the axis's
// Max Power Cap, is the peak; the axis is never above it and never between
// it and 0. That is two ScalarCmds a period, 2.5 a second at 0.8 s, plus a
// changed level reaching the axis at once while it is on (the engine ticks
// once a second): Intiface and the toy's radio see a few messages a second,
// never a stream.

export const VIBE_MODES = Object.freeze(['constant', 'pulsed']);
export const DEFAULT_VIBE_MODE = 'constant';
export const PULSE_PERIODS_MS = Object.freeze([800, 1600, 2400]);
export const DEFAULT_PULSE_PERIOD_MS = 1600;

// A stored or imported mode, or null when it is not one this build knows
// (the caller then keeps its own default: Constant, today's behaviour).
export function readVibeMode(value) {
    return VIBE_MODES.includes(value) ? value : null;
}

// A stored or imported period: one of PULSE_PERIODS_MS exactly, or null.
// Nothing in between is invented - a period is a choice of three, not a
// number to clamp.
export function readPulsePeriod(value) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
    return PULSE_PERIODS_MS.includes(n) ? n : null;
}

// Where a train started at `startedAt` stands at `now`: on (at the peak) or
// off (at 0), and when that next changes. A clock that went backwards counts
// as the start of the train, so it is on, never stuck.
export function pulsePhase(startedAt, now, periodMs = DEFAULT_PULSE_PERIOD_MS) {
    const period = readPulsePeriod(periodMs) || DEFAULT_PULSE_PERIOD_MS;
    const half = period / 2;
    const start = Number(startedAt) || 0;
    const elapsed = Math.max(0, (Number(now) || 0) - start);
    const n = Math.floor(elapsed / half);
    return { on: n % 2 === 0, changeAt: start + (n + 1) * half };
}

// What a pulsed axis is sent at a moment: the peak while on, 0 while off,
// and 0 whatever the phase when there is no peak (the engine stopped it).
export function pulseLevel(peak, on) {
    const p = Number(peak);
    return on && Number.isFinite(p) && p > 0 ? p : 0;
}
