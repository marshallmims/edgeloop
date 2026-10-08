// The Handy in rhythm mode: the fallback when beat sync (HSP) is off or not
// possible. Pure. HAMP cannot play a stroke at a given time; it strokes at a
// velocity between two ends. So at each dispatch the script's next few
// seconds are read for their rhythm - where the strokes sit and how fast
// they cover ground - and The Handy is given that range and that velocity.
// It follows the script's tempo and depth, not each stroke, and the UI says
// so.
//
// The allowance scales both (velocity x a, the range x a from the base, as
// the shaper's Shorten does), so the stroke rate stays on the script's tempo
// while the strokes shorten. The speed cap and the HAMP floor of 1 are
// applied by the existing dispatch (handyTargetSpeed), and the end margin by
// the existing /slide path, exactly as for every other mode. Allowance 0 ->
// speed 0 -> the verified /hamp/stop.
//
// The velocity mapping assumes HAMP % is linear in mm/s up to the device's
// top speed, which is not documented [device].

import { indexAt, posAt } from './script-track.js';
import { clampMaxSpeed, resolveApproach } from './script-governor.js';
import { HANDY_DEFAULT_TRAVEL_MM, HANDY_DEFAULT_MAX_SPEED_MM_S } from './script-shaper.js';

export const RHYTHM_WINDOW_MS = 3000;

function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// The p-th percentile (0-1) of sorted numbers, linear between ranks.
function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const rank = (sorted.length - 1) * p;
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

// rhythmAt(track, t, { windowMs, invert }) -> {
//   lo, hi        the 10th / 90th percentile of the positions in [t, t + window]
//                 (0-100, after the invert)
//   meanSpeed     the distance covered in the window / the window, %/s of the
//                 script's range
//   ended         true when the script has ended (or `t` is no time)
// }
// Positions are the actions inside the window plus the script's position at
// both ends of it, where the script is there. Before the first action the
// window only counts from the first action on: there is no motion before it.
export function rhythmAt(track, t, { windowMs = RHYTHM_WINDOW_MS, invert = false } = {}) {
    const none = { lo: 0, hi: 0, meanSpeed: 0, ended: true };
    const n = track && track.at ? track.at.length : 0;
    if (n < 2 || !finite(t)) return none;
    const span = finite(windowMs) && windowMs > 0 ? windowMs : RHYTHM_WINDOW_MS;
    const first = track.at[0];
    const last = track.at[n - 1];
    if (t >= last) return none;
    const end = t + span;
    const from = Math.max(t, first);
    if (from >= end) return { lo: 0, hi: 0, meanSpeed: 0, ended: false };

    const flip = (p) => (invert ? 100 - p : p);
    const positions = [];
    let distance = 0;
    let prev = posAt(track, from);
    positions.push(flip(prev));
    let i = indexAt(track, from) + 1;
    for (; i < n && track.at[i] <= end; i += 1) {
        const p = track.pos[i];
        distance += Math.abs(p - prev);
        positions.push(flip(p));
        prev = p;
    }
    if (end < last) {
        const p = posAt(track, end);
        if (p !== null) {
            distance += Math.abs(p - prev);
            positions.push(flip(p));
        }
    }
    positions.sort((a, b) => a - b);
    return {
        lo: percentile(positions, 0.1),
        hi: percentile(positions, 0.9),
        meanSpeed: (distance * 1000) / span,
        ended: false
    };
}

// hampTarget(rhythm, allowance, device) -> { speed, strokeMin, strokeMax }
// in the units dispatchHardware takes: speed the HAMP velocity % (before the
// toy's cap and the HAMP floor, which the dispatch applies), the stroke as
// whole % of full travel inside the envelope.
//
// device: { envMin, envMax (the travel envelope, %), travelMm, maxSpeedMmS
//           (from the device, else 110 mm and 400 mm/s), maxSpeed (the
//           Script tab's limit, %/s of full travel), approach }
export function hampTarget(rhythm, allowance, device = {}) {
    const envMin = finite(device.envMin) ? Math.max(0, Math.min(100, device.envMin)) : 0;
    const envMax = finite(device.envMax) ? Math.max(envMin, Math.min(100, device.envMax)) : 100;
    const envSpan = envMax - envMin;
    const stop = { speed: 0, strokeMin: envMin, strokeMax: envMax };
    const a = Math.max(0, Math.min(100, finite(allowance) ? allowance : 0)) / 100;
    if (!rhythm || rhythm.ended || a === 0 || !(rhythm.meanSpeed > 0) || envSpan <= 0) return stop;

    const approach = resolveApproach(device.approach);
    const amp = approach === 'slow' ? 1 : a;
    const travelMm = finite(device.travelMm) && device.travelMm > 0 ? device.travelMm : HANDY_DEFAULT_TRAVEL_MM;
    const topMmS = finite(device.maxSpeedMmS) && device.maxSpeedMmS > 0 ? device.maxSpeedMmS : HANDY_DEFAULT_MAX_SPEED_MM_S;

    // The range: the rhythm's percentiles scaled from the base, in the envelope.
    const lo = Math.max(0, Math.min(100, rhythm.lo)) * amp;
    const hi = Math.max(0, Math.min(100, rhythm.hi)) * amp;
    const strokeMin = Math.round(envMin + (lo / 100) * envSpan);
    const strokeMax = Math.max(strokeMin, Math.round(envMin + (hi / 100) * envSpan));

    // The velocity: the script's mean speed in mm/s over the envelope, as a
    // share of the device's top speed, x a (Shorten keeps the tempo by
    // slowing with the shorter stroke), never above the Max speed limit
    // (x a again when the approach includes Slow).
    const meanMmS = (rhythm.meanSpeed / 100) * (envSpan / 100) * travelMm;
    let velocity = (meanMmS / topMmS) * 100 * amp;
    const slow = approach === 'slow' || approach === 'both' ? a : 1;
    const limitMmS = (clampMaxSpeed(device.maxSpeed) / 100) * travelMm * slow;
    velocity = Math.min(velocity, (limitMmS / topMmS) * 100, 100);
    // A rhythm that moves is never rounded into a stop.
    const speed = velocity > 0 ? Math.max(1, Math.round(velocity)) : 0;
    return { speed, strokeMin, strokeMax };
}
