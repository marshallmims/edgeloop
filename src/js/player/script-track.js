// Reading a parsed track (funscript-parse.js): where the script is at a
// given time, what lies in a window, where it next turns, and how fast it
// is. Pure, and nothing here allocates per call beyond the answer, so the
// player can ask on every leg and every window.
//
// Times are script ms (media time plus the wearer's offset). Positions are
// the file's own 0-100. Before the first action and after the last there is
// no script, and every answer says so (null, -1, nothing): the toy is never
// handed a position the file does not give.

function count(track) {
    return track && track.at ? track.at.length : 0;
}

// The index of the last action at or before `t`, or -1 when `t` is before
// the first action (or the track is empty, or `t` is not a number).
export function indexAt(track, t) {
    const n = count(track);
    if (n === 0 || !Number.isFinite(t)) return -1;
    const at = track.at;
    if (t < at[0]) return -1;
    if (t >= at[n - 1]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    // Invariant: at[lo] <= t < at[hi].
    while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if (at[mid] <= t) lo = mid;
        else hi = mid;
    }
    return lo;
}

// The index of the first action at or after `t`, or -1 past the last one.
export function indexFrom(track, t) {
    const n = count(track);
    if (n === 0 || !Number.isFinite(t)) return -1;
    if (t <= track.at[0]) return 0;
    const i = indexAt(track, t);
    if (track.at[i] === t) return i;
    return i + 1 < n ? i + 1 : -1;
}

// The script's position (0-100, a fraction between actions) at `t`, by
// straight lines between actions; null outside the script.
export function posAt(track, t) {
    const i = indexAt(track, t);
    if (i < 0) return null;
    const n = count(track);
    if (i === n - 1) return track.at[i] === t ? track.pos[i] : null;
    const t0 = track.at[i];
    const t1 = track.at[i + 1];
    const p0 = track.pos[i];
    const p1 = track.pos[i + 1];
    return p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
}

// The actions with t0 <= at <= t1, as views into the track (no copy):
// { at, pos, start, end } where start/end are track indexes, end exclusive.
export function slice(track, t0, t1) {
    const n = count(track);
    const empty = { at: new Int32Array(0), pos: new Uint8Array(0), start: 0, end: 0 };
    if (n === 0 || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return empty;
    const start = indexFrom(track, t0);
    if (start < 0) return { ...empty, start: n, end: n };
    let end = indexAt(track, t1) + 1;
    if (end < start) end = start;
    return { at: track.at.subarray(start, end), pos: track.pos.subarray(start, end), start, end };
}

function sign(v) {
    return v > 0 ? 1 : v < 0 ? -1 : 0;
}

// Whether the action at index `i` is a turning point: the motion into it and
// the motion out of it differ in direction, counting standing still as a
// direction of its own. So a reversal is one, and so are the start and the
// end of a hold. The first and the last action are turning points: the
// motion starts and ends there.
export function isTurn(track, i) {
    const n = count(track);
    if (i <= 0 || i >= n - 1) return i === 0 || i === n - 1;
    const into = sign(track.pos[i] - track.pos[i - 1]);
    const out = sign(track.pos[i + 1] - track.pos[i]);
    return into !== out;
}

// The index of the first turning point at or after `t`, or -1.
export function nextTurnAfter(track, t) {
    const n = count(track);
    let i = indexFrom(track, t);
    if (i < 0) return -1;
    for (; i < n; i += 1) {
        if (isTurn(track, i)) return i;
    }
    return -1;
}

// The speed of every segment in %/s of the script's own range (position
// units per second). Two actions are never at one time (the parser merges
// them), so no segment divides by zero.
export function segmentSpeeds(track) {
    const n = count(track);
    const speeds = new Float32Array(Math.max(0, n - 1));
    for (let i = 0; i + 1 < n; i += 1) {
        const dt = track.at[i + 1] - track.at[i];
        speeds[i] = dt > 0 ? (Math.abs(track.pos[i + 1] - track.pos[i]) * 1000) / dt : 0;
    }
    return speeds;
}

// stats(track) -> {
//   actions, durationMs, firstAtMs
//   maxSpeed      the fastest segment, %/s of the script's range
//   fastestAt     where that segment starts (script ms), or null
//   movingSegments  segments that move at all
//   cappedShare(vCap)  the share (0-1) of moving segments faster than vCap,
//                 in the same units: "12% of strokes are faster than your
//                 limit". A caller limiting physical speed over an envelope
//                 narrower than full travel converts first (a script segment
//                 at v covers v * span/100 of the travel per second).
//   intensityPerSecond  Float32Array, one entry per started second of the
//                 script from 0: the distance travelled in that second, which
//                 is its mean speed in %/s (the heatmap, rhythm, phase 2+).
// }
export function stats(track) {
    const n = count(track);
    const speeds = segmentSpeeds(track);
    let maxSpeed = 0;
    let fastestAt = null;
    const moving = [];
    for (let i = 0; i < speeds.length; i += 1) {
        if (speeds[i] > maxSpeed) {
            maxSpeed = speeds[i];
            fastestAt = track.at[i];
        }
        if (speeds[i] > 0) moving.push(speeds[i]);
    }
    const sorted = Float32Array.from(moving).sort();
    const cappedShare = (vCap) => {
        const cap = Number(vCap);
        if (sorted.length === 0 || !Number.isFinite(cap)) return 0;
        // The first index whose speed is above the cap.
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] > cap) hi = mid;
            else lo = mid + 1;
        }
        return (sorted.length - lo) / sorted.length;
    };

    const durationMs = n > 0 ? track.at[n - 1] : 0;
    const seconds = n > 0 ? Math.ceil(durationMs / 1000) || 1 : 0;
    const intensityPerSecond = new Float32Array(seconds);
    for (let i = 0; i + 1 < n; i += 1) {
        const t0 = track.at[i];
        const t1 = track.at[i + 1];
        const distance = Math.abs(track.pos[i + 1] - track.pos[i]);
        if (distance === 0 || t1 <= t0) continue;
        // Spread the segment's distance over the seconds it spans, in
        // proportion to the time it spends in each.
        let from = t0;
        while (from < t1) {
            const bucket = Math.floor(from / 1000);
            const to = Math.min(t1, (bucket + 1) * 1000);
            if (bucket < seconds) intensityPerSecond[bucket] += (distance * (to - from)) / (t1 - t0);
            from = to;
        }
    }

    return {
        actions: n,
        durationMs,
        firstAtMs: n > 0 ? track.at[0] : null,
        maxSpeed,
        fastestAt,
        movingSegments: sorted.length,
        cappedShare,
        intensityPerSecond
    };
}
