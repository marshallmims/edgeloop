// The shaper: the raw script in, device points out, for one window of script
// time. Pure and deterministic - the same inputs always give the same points,
// which the Handy's rolling window relies on when it re-sends a plan - with no
// clock of its own: every window is asked for in script ms (media time plus
// the wearer's offset), so timing errors never build up.
//
// Output points are { t, x }: t in script ms, x from 0 to 1 inside the
// DEVICE WINDOW, the stretch of travel the toy is given:
//   - The Handy over HSP: the /slider/stroke window (the envelope with the
//     end margin applied). x is sent as 0-100 of it and the device keeps
//     every point inside it.
//   - Intiface / T-Code linear axes: the travel envelope. The driver maps x
//     to envMin + x * (envMax - envMin), then the axis invert as today.
// The window matters here because the speed limit is physical: a % of full
// travel per second, so the same x-step is faster in a wider window.
//
// The steps, in order (spec §2.7):
//   1. Clock. Before the first action: no motion; the first action is joined
//      like a rejoin. After the last action: no points, which is zero speed,
//      never a hold at speed and never a guess.
//   2. Orientation. x = pos/100, flipped once if the file is inverted and
//      once more if the wearer's Invert is on (effectiveInvert).
//   3. Smoothing. It only removes points, never adds or moves one. Done on
//      the whole track once per level (smoothedTrack, cached), so a window's
//      points never depend on where the window starts.
//   4. Amplitude. Shorten (and Shorten & slow, and None for everything but
//      the approach band, which the governor leaves out): x' = x * a,
//      anchored at the base of the window.
//   5. Device minimum segment: a point closer than that to the last kept one
//      is dropped.
//   6. Speed limit. From the device's start position, a segment that needs
//      more than vCap has its end pulled back toward its start until it
//      fits. Timing never changes; the next segment starts from the clipped
//      point.
//   7. Skip. An allowance of 0 is no points at all (holdPoints gives the
//      Handy its one hold point a second; a planner's speed 0 is its stop).
//   8. Rejoin (after a skip, a seek, at START, before the first action, or
//      from a position nobody knows): from p0 at t0, the first script point
//      at or after t0 + lead it can reach at the join speed (half the speed
//      limit), a turning point if one can be reached within 3 s; else the
//      script position at t0 + lead + distance / join speed. A scrub or a
//      skip can never produce a full-travel slam.

import { indexAt, posAt } from './script-track.js';
import { clampMaxSpeed, resolveApproach, resolveStrokeModel } from './script-governor.js';

export const REJOIN_SEARCH_MS = 3000;
export const SMOOTHING_LEVELS = Object.freeze({
    off: Object.freeze({ minGapMs: 0, minExcursion: 0 }),
    light: Object.freeze({ minGapMs: 60, minExcursion: 3 }),
    strong: Object.freeze({ minGapMs: 120, minExcursion: 6 })
});

// Speed ceilings per device, % of full travel per second (spec §3.8). The
// wearer's Max speed can only go lower. The Handy's comes from its own
// x_max_speed and travel when it reports them (handySpeedCeiling).
export const HANDY_DEFAULT_TRAVEL_MM = 110;
export const HANDY_DEFAULT_MAX_SPEED_MM_S = 400;
export const DEVICE_CEILINGS = Object.freeze({
    handy: (HANDY_DEFAULT_MAX_SPEED_MM_S / HANDY_DEFAULT_TRAVEL_MM) * 100,
    tcode: 600,
    ossm: 600,
    intiface: 500
});
// A device that names no ceiling gets the lowest one known.
export const FALLBACK_CEILING = Math.min(...Object.values(DEVICE_CEILINGS));

// The planner's shortest leg; shorter segments are merged by smoothing.
export const PLANNER_MIN_SEGMENT_MS = 60;

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// The Handy's ceiling in %/s from its reported top speed (mm/s) and travel
// (mm); either missing or unreadable falls back to the published figures.
export function handySpeedCeiling({ maxSpeedMmS, travelMm } = {}) {
    const speed = finite(maxSpeedMmS) && maxSpeedMmS > 0 ? maxSpeedMmS : HANDY_DEFAULT_MAX_SPEED_MM_S;
    const travel = finite(travelMm) && travelMm > 0 ? travelMm : HANDY_DEFAULT_TRAVEL_MM;
    return (speed / travel) * 100;
}

// %/s of full travel as mm/s, for the Script tab's readout on a Handy.
export function percentToMmPerSecond(percent, travelMm = HANDY_DEFAULT_TRAVEL_MM) {
    const p = Number(percent);
    const travel = finite(travelMm) && travelMm > 0 ? travelMm : HANDY_DEFAULT_TRAVEL_MM;
    return finite(p) ? (p * travel) / 100 : 0;
}

// The file's `inverted` and the wearer's Invert each flip the stroke once.
export function effectiveInvert(meta, settings) {
    const file = Boolean(meta && meta.inverted === true);
    const wearer = Boolean(settings && (settings.invert === true || settings.scriptInvert === true));
    return file !== wearer;
}

// The speed limit for this window, % of full travel per second:
//   min(Max speed x toy cap x (a, when the approach includes Slow), ceiling)
export function scriptSpeedCap({ maxSpeed, cap = 100, approach, allowance = 100, ceiling, strokeModel } = {}) {
    const a = Math.max(0, Math.min(100, finite(allowance) ? allowance : 0)) / 100;
    const capShare = Math.max(0, Math.min(100, finite(cap) ? cap : 100)) / 100;
    const mode = resolveApproach(approach);
    const keep = resolveStrokeModel(strokeModel) === 'keep';
    const slow = keep || mode === 'slow' || mode === 'both' ? a : 1;
    const top = finite(ceiling) && ceiling > 0 ? ceiling : FALLBACK_CEILING;
    return Math.min(clampMaxSpeed(maxSpeed) * capShare * slow, top);
}

// The amplitude factor the approach applies: a for Shorten, Shorten & slow,
// and None (whose band the governor left out, so a here is only the
// warm-up, a landing and the like); 1 for Slow, which limits speed instead.
export function amplitudeFactor(approach, allowance, strokeModel) {
    if (resolveStrokeModel(strokeModel) === 'keep') return 1;
    const a = Math.max(0, Math.min(100, finite(allowance) ? allowance : 0)) / 100;
    return resolveApproach(approach) === 'slow' ? 1 : a;
}

// ---- 3. Smoothing ------------------------------------------------------------

function sign(v) {
    return v > 0 ? 1 : v < 0 ? -1 : 0;
}

// Which actions survive smoothing, as a new track. Never adds or moves one.
//   - a point less than minGapMs after the last kept point is dropped,
//     unless it is a turning point;
//   - a reversal whose excursion from the last kept point is less than
//     minExcursion (position units) is jitter, and dropped;
//   - where the motion starts or stops (a hold begins or ends), the point
//     is kept: it carries the timing of the hold;
//   - the first and the last action are always kept.
export function smoothPoints(track, { minGapMs = 0, minExcursion = 0 } = {}) {
    const n = track && track.at ? track.at.length : 0;
    if (n <= 2 || (minGapMs <= 0 && minExcursion <= 0)) {
        return { at: Int32Array.from(track ? track.at : []), pos: Uint8Array.from(track ? track.pos : []) };
    }
    const at = track.at;
    const pos = track.pos;
    const keep = [0];
    let last = 0;
    for (let i = 1; i < n - 1; i += 1) {
        const into = sign(pos[i] - pos[last]);
        const out = sign(pos[i + 1] - pos[i]);
        const reversal = into !== 0 && out !== 0 && into !== out;
        const holdEdge = (into === 0) !== (out === 0);
        if (reversal) {
            if (Math.abs(pos[i] - pos[last]) < minExcursion) continue;
        } else if (!holdEdge) {
            if (at[i] - at[last] < minGapMs) continue;
            // A point on a straight run that adds nothing is still kept when
            // it is far enough apart: it carries the run's speed changes.
        }
        keep.push(i);
        last = i;
    }
    keep.push(n - 1);
    return {
        at: Int32Array.from(keep, (i) => at[i]),
        pos: Uint8Array.from(keep, (i) => pos[i])
    };
}

const smoothCache = new WeakMap();

// The track smoothed at a level ('off' | 'light' | 'strong'; anything else is
// 'light'), computed once per track and level.
export function smoothedTrack(track, level = 'light') {
    const key = Object.prototype.hasOwnProperty.call(SMOOTHING_LEVELS, level) ? level : 'light';
    if (!track || typeof track !== 'object') return { at: new Int32Array(0), pos: new Uint8Array(0) };
    let byLevel = smoothCache.get(track);
    if (!byLevel) {
        byLevel = new Map();
        smoothCache.set(track, byLevel);
    }
    if (!byLevel.has(key)) byLevel.set(key, smoothPoints(track, SMOOTHING_LEVELS[key]));
    return byLevel.get(key);
}

// ---- 6. Speed limit ------------------------------------------------------------

// Walk `points` in order from `start` ({ t, x }, or null to start at the first
// point) and pull back the end of every segment faster than `vMax` (x per
// ms) toward its start. Times are never changed.
export function limitVelocity(points, vMax, start = null) {
    const out = [];
    let prev = start && finite(start.t) && finite(start.x) ? { t: start.t, x: clamp01(start.x) } : null;
    const v = finite(vMax) && vMax > 0 ? vMax : 0;
    for (const p of points) {
        if (!prev) {
            prev = { t: p.t, x: clamp01(p.x) };
            out.push(prev);
            continue;
        }
        const dt = p.t - prev.t;
        if (dt < 0) continue;
        const reach = v * dt;
        const d = p.x - prev.x;
        const x = Math.abs(d) > reach ? prev.x + Math.sign(d) * reach : p.x;
        const q = { t: p.t, x: clamp01(x) };
        out.push(q);
        prev = q;
    }
    return out;
}

// ---- 8. Rejoin -------------------------------------------------------------

// Whether point i of a list is a turning point. A point may say so itself
// (`turn`, which shapeWindow sets from the whole track, so the first point
// of a window is not mistaken for one); otherwise its neighbours in the list
// decide, the ends of the list counting as turns.
function isTurnIn(list, i) {
    const p = list[i];
    if (typeof p.turn === 'boolean') return p.turn;
    const before = list[i - 1];
    const after = list[i + 1];
    if (!before || !after) return true;
    return sign(p.x - before.x) !== sign(after.x - p.x);
}

// The join point: { t, x, fallback } or null when the script ends before
// any join. `points` are the shaped candidates in order; `positionAt(t)` is
// the shaped script position at any time (null outside the script). A
// position nobody knows (p0 null) is sized for the worst case: the far end.
export function planRejoin({ points, t0, p0 = null, vJoin, lead = 0, positionAt }) {
    if (!finite(t0) || !finite(vJoin) || vJoin <= 0) return null;
    const known = finite(p0);
    const distance = (x) => (known ? Math.abs(x - p0) : Math.max(x, 1 - x));
    const reachable = (p) => p.t > t0 && distance(p.x) <= vJoin * (p.t - t0) + 1e-9;
    const start = t0 + Math.max(0, finite(lead) ? lead : 0);
    const limit = start + REJOIN_SEARCH_MS;
    const list = Array.isArray(points) ? points : [];

    let firstReachable = null;
    for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        if (p.t < start) continue;
        if (p.t > limit) break;
        if (!reachable(p)) continue;
        if (!firstReachable) firstReachable = p;
        if (isTurnIn(list, i)) return { t: p.t, x: p.x, fallback: false };
    }
    if (firstReachable) return { t: firstReachable.t, x: firstReachable.x, fallback: false };

    // Nothing reachable within 3 s: aim at where the script will be once the
    // toy can get there at the join speed.
    const here = typeof positionAt === 'function' ? positionAt(start) : null;
    if (!finite(here)) return null;
    // Unknown start: a full travel at the join speed always gets there.
    const T = Math.ceil(start + (known ? Math.abs(here - p0) : 1) / vJoin);
    let x = positionAt(T);
    if (!finite(x)) return null;
    if (known) {
        const reach = vJoin * (T - t0);
        if (Math.abs(x - p0) > reach) x = p0 + Math.sign(x - p0) * reach;
    }
    return { t: T, x: clamp01(x), fallback: true };
}

// ---- Holding ------------------------------------------------------------------

// One hold point a second at `x` over [from, to] (The Handy over HSP during a
// skip: the device never starves on purpose).
export function holdPoints(from, to, x, everyMs = 1000) {
    if (!finite(from) || !finite(to) || !finite(x) || to < from) return [];
    const step = finite(everyMs) && everyMs > 0 ? everyMs : 1000;
    const out = [];
    for (let t = from; t <= to; t += step) out.push({ t: Math.round(t), x: clamp01(x) });
    return out;
}

// ---- The window ---------------------------------------------------------------

function normalizeWindow(window) {
    const lo = window && finite(window.min) ? window.min : 0;
    const hi = window && finite(window.max) ? window.max : 100;
    const min = Math.max(0, Math.min(100, Math.min(lo, hi)));
    const max = Math.max(0, Math.min(100, Math.max(lo, hi)));
    return { min, max };
}

// shapeWindow(args) -> { points, reason, vCap, vJoin, join }
//
//   track      the parsed track ({ at, pos })
//   from, to   the window, script ms
//   allowance  0-100 (script-governor.js)
//   settings   { approach, invert (already effectiveInvert), smoothing, maxSpeed }
//   device     { window: { min, max } in % of full travel, ceiling (%/s),
//                cap (the toy's speed cap, %), minSegmentMs }
//   startPos   where the device is at `from` (0-1 of the window), or null
//              when nobody knows
//   rejoin     true after a skip, a seek, a stall or at START
//   lead       for a rejoin: how far after `from` the join may start
//
// `points` are in time order, t in script ms, x in 0-1. A rejoin with a known
// start begins with { t: from, x: startPos }: the device stays there until
// it moves toward the join point. `reason` says why there are none, or few:
//   'stroke'        playing the script
//   'joining'       a rejoin whose join point lies beyond `to`
//   'skip'          the allowance (or the toy's cap) is 0
//   'before-start'  the window ends before the script starts
//   'after-end'     the script has ended
//   'empty'         no usable track or window
// vCap is the speed limit in %/s of full travel; vJoin the join speed in x
// per ms; join the join point of a rejoin (or null).
export function shapeWindow({
    track,
    from,
    to,
    allowance = 0,
    settings = {},
    device = {},
    startPos = null,
    rejoin = false,
    lead = 0
} = {}) {
    const win = normalizeWindow(device.window);
    const span = win.max - win.min;
    const a = Math.max(0, Math.min(100, finite(allowance) ? allowance : 0));
    const vCap = a > 0 ? scriptSpeedCap({
        maxSpeed: settings.maxSpeed,
        cap: device.cap,
        approach: settings.approach,
        allowance: a,
        ceiling: device.ceiling,
        strokeModel: settings.strokeModel
    }) : 0;
    const vUnits = span > 0 ? vCap / span / 1000 : 0;
    const vJoin = vUnits / 2;
    const answer = (points, reason, join = null) => ({ points, reason, vCap, vJoin, join });

    const n = track && track.at ? track.at.length : 0;
    if (n < 2 || !finite(from) || !finite(to) || to < from) return answer([], 'empty');
    if (a === 0 || vUnits <= 0) return answer([], 'skip');

    const smoothed = smoothedTrack(track, settings.smoothing);
    const count = smoothed.at.length;
    const first = smoothed.at[0];
    const last = smoothed.at[count - 1];
    if (from >= last) return answer([], 'after-end');

    const flip = settings.invert === true;
    const rawExpand = Number(settings.expand);
    const expand = resolveStrokeModel(settings.strokeModel) === 'keep' || !finite(rawExpand) || rawExpand < 1
        ? 1
        : Math.min(2, rawExpand);
    const amp = amplitudeFactor(settings.approach, a, settings.strokeModel) * expand;
    const shape = (pos) => {
        const x = flip ? 1 - pos / 100 : pos / 100;
        return clamp01(x * amp);
    };
    const positionAt = (t) => {
        const p = posAt(smoothed, t);
        return p === null ? null : shape(p);
    };

    const known = finite(startPos);
    const p0 = known ? clamp01(startPos) : null;
    const needRejoin = Boolean(rejoin) || !known || from < first;
    const leadMs = needRejoin ? Math.max(0, finite(lead) ? lead : 0) : 0;
    const horizon = needRejoin ? Math.max(to, from + leadMs + REJOIN_SEARCH_MS) : to;

    // The candidates: every kept action in [from, horizon], shaped, with the
    // device's minimum segment applied.
    const minSeg = finite(device.minSegmentMs) && device.minSegmentMs > 0 ? device.minSegmentMs : 0;
    const candidates = [];
    // Strictly after `from`: at `from` the device is where it is (startPos).
    let i = Math.max(0, indexAt(smoothed, from));
    if (smoothed.at[i] <= from) i += 1;
    for (; i < count && smoothed.at[i] <= horizon; i += 1) {
        const t = smoothed.at[i];
        const prev = candidates[candidates.length - 1];
        if (prev && t - prev.t < minSeg) continue;
        const into = i > 0 ? sign(smoothed.pos[i] - smoothed.pos[i - 1]) : 0;
        const out = i + 1 < count ? sign(smoothed.pos[i + 1] - smoothed.pos[i]) : 0;
        const turn = i === 0 || i === count - 1 || into !== out;
        candidates.push({ t, x: shape(smoothed.pos[i]), turn });
    }

    // Where `to` falls inside a segment, a point on that segment at `to`, so
    // the device keeps moving along it to the window's end instead of holding
    // at the last action inside the window.
    const withEnd = (points) => {
        const tail = points[points.length - 1];
        if (to > first && to < last && (!tail || tail.t < to)) {
            const x = positionAt(to);
            if (x !== null) return [...points, { t: to, x }];
        }
        return points;
    };

    if (!needRejoin) {
        const inside = candidates.filter((p) => p.t <= to).map(({ t, x }) => ({ t, x }));
        const points = limitVelocity(withEnd(inside), vUnits, { t: from, x: p0 });
        return answer(points, 'stroke');
    }

    const join = planRejoin({ points: candidates, t0: from, p0, vJoin, lead: leadMs, positionAt });
    // A join that starts at `from` (the script passes through the start
    // position right then) is its own anchor.
    const anchor = known && !(join && join.t <= from) ? [{ t: from, x: p0 }] : [];
    if (!join) {
        return answer(anchor, to < first ? 'before-start' : 'after-end');
    }
    if (join.t > to) {
        return answer(anchor, to < first ? 'before-start' : 'joining', join);
    }
    const after = candidates.filter((p) => p.t > join.t && p.t <= to).map(({ t, x }) => ({ t, x }));
    const rest = limitVelocity(withEnd(after), vUnits, join);
    return answer([...anchor, { t: join.t, x: join.x }, ...rest], 'stroke', join);
}
