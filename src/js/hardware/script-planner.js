// Per-axis script scheduler for a linear axis that plays the wearer's
// funscript (Script mode): a primary-role Intiface linear axis, or T-Code's
// L0. Pure: no timers, no sockets. It has the stroke planner's interface
// (setInput / getInput / next / retime / place / reset / isInFlight /
// legEndsAt / isResting / lastPosition, stroke-planner.js), so the drivers'
// timer chains (intiface.js pumpLinear and pumpHeld, tcode.js pumpPlanner)
// drive it unchanged but for one kind of leg, 'idle'.
//
// Where the stroke planner alternates between the zone's ends, this one asks
// the script feed (player/script-feed.js) for the next shaped point after
// the script's present, and makes that point the leg:
//   { position, durationMs = t_point - (scriptNow + latency), kind: 'stroke' }
// Every leg is computed from the media clock again, so a timing error never
// carries over into the next leg. The input's `speed` is the allowance the
// tick dispatched (the engine's primary in Script mode); the shaper applies
// it as the approach says, and the toy's `cap` scales its speed limit.
//
// Rules:
//   - A stop is the stroke planner's stop, to the letter: speed 0, a cap of
//     0 or role OFF interrupts the leg in flight, and the next thing sent is
//     one rest move to the zone's bottom over REST_MOVE_MS - or, made with
//     `hold: true`, a single { kind: 'hold' } and then silence (an OSSM in
//     Intiface's position mode stops where it is). Then silence until it
//     moves again. There is no other way to stop.
//   - No time is a stop too. The clock has none while the video is paused,
//     seeking, waiting or ended, and when nobody has confirmed it for 1.5 s;
//     a skip at the edge is the allowance at 0. Losing the clock interrupts
//     the leg in flight like any stop (a seek must not run out the old
//     timeline's stroke). Script mode switched off does not: the leg in
//     flight runs out, and the driver hands the axis back to its stroke
//     planner at its end.
//   - A pause in the script - the next point where the axis already is, the
//     script not started yet, or ended - is an IDLE leg: { position: null,
//     durationMs, kind: 'idle' }. The driver sends nothing and only arms its
//     timer: sending the position again is no option, an OSSM's firmware
//     divides by the distance (intiface.js sendLinear). An idle leg lasts at
//     most IDLE_LEG_MAX_MS, so the clock is read again soon.
//   - Every leg lasts at least SCRIPT_MIN_LEG_MS (60 ms; smoothing has
//     merged shorter segments) and at most about SCRIPT_WINDOW_MS: the window
//     asked for is that long, and the shaper ends it on the segment it
//     crosses. The one exception is the first leg from a position nobody
//     knows (below): a full travel at the join speed, 667 ms at the default
//     300 %/s and 4 s at the slowest Max speed (50 %/s).
//   - After a stop, a seek, any change of the timeline (the feed's
//     generation) or from a position nobody knows, the next legs are a
//     REJOIN: the shaper finds the first script point the axis can reach at
//     the join speed (half the speed limit), a turning point if it can, and
//     the axis goes there first. A join further away than one window is
//     approached one window at a time at the join speed.
//   - From a position nobody knows (a fresh axis, a reset, the envelope moved
//     under it) the first leg is sized for the worst case: one full travel
//     at the join speed, to where the script will be when it ends. Then the
//     axis is on the script, and known.
//   - Only a stop interrupts a leg; a new non-zero allowance applies from
//     the next leg (retime() never re-times one).
//   - A feed that throws is caught: the axis stops as above, the error goes
//     to feed.reportError (app.js pauses the session), and the axis stays
//     stopped until its input stops too (a pause) or it is reset.

import { normalizePlannerInput, REST_MOVE_MS } from './stroke-planner.js';

// The shortest leg. Equal to the shaper's PLANNER_MIN_SEGMENT_MS, which is
// what it merges shorter segments into (script-planner.test.js checks).
export const SCRIPT_MIN_LEG_MS = 60;
// How far ahead one leg is planned from.
export const SCRIPT_WINDOW_MS = 2000;
// The longest an idle leg waits before the clock is read again.
export const IDLE_LEG_MAX_MS = 500;
// Two positions closer than this (a thousandth of the travel, the finest step
// any driver sends) are the same position: no move is sent.
export const SAME_POSITION = 0.001;
// How far past the zone a known position may lie and still be on it.
const ZONE_SLACK = 1e-9;

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// Whether normalised inputs ask the axis to move at all (the stroke
// planner's own test).
function inputMoving(input) {
    return input.enabled && input.effectiveSpeed > 0;
}

// createScriptPlanner(options)
//   feed       the script feed (script-feed.js), or anything with its
//              isActive / scriptNow / generation / shape / reportError
//   restMs     the rest move's length (the stroke planner's REST_MOVE_MS)
//   hold       an axis that holds where it is on a stop (no rest move)
//   profile    the device's speed ceiling: a DEVICE_CEILINGS name
//              ('intiface', 'tcode', 'ossm') or %/s
//   latencyMs  the toy's latency: its legs are planned that much earlier
//              (phase 2; 0)
export function createScriptPlanner({ feed = null, restMs = REST_MOVE_MS, hold = false, profile = 'intiface', latencyMs = 0 } = {}) {
    let input = normalizePlannerInput({});
    let legEndsAt = 0;
    let lastPosition = null;
    let atRest = false;
    let needRejoin = true;
    let lastGeneration = null;
    let failed = false;
    // Whether the axis was moving on the clock when last looked at: the
    // input asked it to, and the script had a time. Losing either
    // interrupts the leg in flight.
    let wasRunning = false;

    function fail(error) {
        failed = true;
        try { if (feed && typeof feed.reportError === 'function') feed.reportError(error, 'script-planner'); } catch (e) {}
    }

    // The script's present plus the toy's latency, or null when there is no
    // time (or no feed, or a feed that throws).
    function scriptFrom() {
        if (!feed || failed) return null;
        try {
            const t = feed.scriptNow();
            return finite(t) ? t + (finite(latencyMs) ? latencyMs : 0) : null;
        } catch (error) {
            fail(error);
            return null;
        }
    }

    // Whether the script has a time, Script mode driving or not (a seek or
    // a pause takes it away; switching the mode off does not).
    function hasClock() {
        if (!feed || failed) return false;
        try {
            return Boolean(feed.hasTime());
        } catch (error) {
            fail(error);
            return false;
        }
    }

    function isActive() {
        if (!feed || failed) return false;
        try {
            return Boolean(feed.isActive());
        } catch (error) {
            fail(error);
            return false;
        }
    }

    function running() {
        return inputMoving(input) && hasClock();
    }

    function isInFlight(now) {
        return now < legEndsAt;
    }

    // The stroke planner's stop, to the letter.
    function stop(now) {
        needRejoin = true;
        if (atRest) return null;
        atRest = true;
        if (hold) {
            legEndsAt = now;
            return { position: null, durationMs: 0, kind: 'hold' };
        }
        lastPosition = input.zoneMin;
        legEndsAt = now + restMs;
        return { position: input.zoneMin, durationMs: restMs, kind: 'rest' };
    }

    function idle(now, durationMs) {
        const d = Math.max(SCRIPT_MIN_LEG_MS, Math.min(IDLE_LEG_MAX_MS, Math.round(finite(durationMs) ? durationMs : IDLE_LEG_MAX_MS)));
        legEndsAt = now + d;
        return { position: null, durationMs: d, kind: 'idle' };
    }

    function plan(now, from) {
        const span = input.zoneMax - input.zoneMin;
        // A zone with no width has nowhere to stroke: wait (and never send
        // the one position it has over and over).
        if (!(span > 0)) {
            needRejoin = true;
            return idle(now, IDLE_LEG_MAX_MS);
        }
        let generation = null;
        try {
            generation = feed.generation();
        } catch (error) {
            fail(error);
            return null;
        }
        const rejoin = needRejoin || generation !== lastGeneration;
        // Where the axis is, in the window's own 0-1; a position off the
        // zone (the envelope moved under it) is one nobody knows.
        let startPos = null;
        if (lastPosition !== null && span > 0
            && lastPosition >= input.zoneMin - ZONE_SLACK && lastPosition <= input.zoneMax + ZONE_SLACK) {
            startPos = clamp01((lastPosition - input.zoneMin) / span);
        }
        const known = startPos !== null;
        let answer;
        try {
            answer = feed.shape({
                from,
                to: from + SCRIPT_WINDOW_MS,
                allowance: input.speed,
                cap: input.cap,
                window: { min: input.zoneMin * 100, max: input.zoneMax * 100 },
                profile,
                minSegmentMs: SCRIPT_MIN_LEG_MS,
                startPos,
                rejoin,
                lead: SCRIPT_MIN_LEG_MS
            });
        } catch (error) {
            fail(error);
            return null;
        }
        lastGeneration = generation;
        const points = answer && Array.isArray(answer.points) ? answer.points : [];
        const reason = answer ? answer.reason : 'empty';
        const vCap = answer && finite(answer.vCap) ? answer.vCap : 0;

        if (!known) {
            // From a position nobody knows: the axis may be anywhere on the
            // travel, so one full travel at the join speed (half the limit,
            // in travel per ms) is the leg, to where the script will be when
            // it ends. Before the script starts or after it ends, wait.
            const vJoinPerMs = vCap / 100 / 1000 / 2;
            if (!(vJoinPerMs > 0)) {
                needRejoin = true;
                return idle(now, IDLE_LEG_MAX_MS);
            }
            const durationMs = Math.max(SCRIPT_MIN_LEG_MS, Math.ceil(1 / vJoinPerMs));
            let x = null;
            try {
                x = feed.positionAt(from + durationMs, input.speed);
            } catch (error) {
                fail(error);
                return null;
            }
            if (!finite(x)) {
                needRejoin = true;
                return idle(now, IDLE_LEG_MAX_MS);
            }
            needRejoin = false;
            lastPosition = input.zoneMin + clamp01(x) * span;
            legEndsAt = now + durationMs;
            return { position: lastPosition, durationMs, kind: 'stroke' };
        }

        // The first point far enough ahead to be a leg. One closer than half
        // the shortest leg is passed over - the leg to the point after it is
        // still inside the speed limit, since every segment on the way was -
        // and one closer than a whole shortest leg is reached that much
        // late, never faster: the next leg is timed from the clock again.
        let target = points.find((p) => finite(p.t) && finite(p.x) && p.t - from >= SCRIPT_MIN_LEG_MS / 2) || null;
        let joined = Boolean(target) && reason === 'stroke';
        if (!target && reason === 'joining' && answer.join && finite(answer.join.t) && answer.join.t > from) {
            // A join further than this window: go one window of the way
            // there on the straight line, at the join speed, and rejoin from
            // there next leg.
            const join = answer.join;
            if (join.t > from + SCRIPT_WINDOW_MS) {
                const share = SCRIPT_WINDOW_MS / (join.t - from);
                target = { t: from + SCRIPT_WINDOW_MS, x: startPos + (join.x - startPos) * share };
                joined = false;
            } else {
                // The leg lands on the join point at its time: joined.
                target = { t: join.t, x: join.x };
                joined = true;
            }
        }
        if (!target) {
            // Nothing to play in this window (before the script starts, after
            // it ends, or a window with no point far enough): wait.
            needRejoin = rejoin;
            return idle(now, IDLE_LEG_MAX_MS);
        }

        const position = input.zoneMin + clamp01(target.x) * span;
        if (Math.abs(position - lastPosition) < SAME_POSITION) {
            // The script holds where the axis is: nothing to send. Reaching
            // the script where it is is a rejoin done.
            needRejoin = rejoin && !joined;
            return idle(now, target.t - from);
        }
        const durationMs = Math.max(SCRIPT_MIN_LEG_MS, Math.round(target.t - from));
        needRejoin = rejoin && !joined;
        lastPosition = position;
        legEndsAt = now + durationMs;
        return { position, durationMs, kind: 'stroke' };
    }

    return {
        // Update the inputs ({ speed, cap, zoneMin, zoneMax, enabled }, the
        // stroke planner's). Takes effect on the next leg, except that a
        // stop interrupts the leg in flight so the stop goes out at once.
        setInput(next) {
            input = normalizePlannerInput({ ...input, ...next });
            // A stop the caller decided (a pause, STOP, a guard, OFF) clears
            // a failed feed: the next start tries it again.
            if (!inputMoving(input)) failed = false;
            const now = running();
            if (wasRunning && !now) legEndsAt = 0;
            wasRunning = now;
        },
        getInput() {
            return { ...input };
        },
        // Look at the clock again without new inputs (the driver calls it
        // when the feed says something changed): a clock that stopped
        // interrupts the leg in flight.
        poke() {
            const now = running();
            if (wasRunning && !now) legEndsAt = 0;
            wasRunning = now;
        },
        isInFlight,
        legEndsAt() {
            return legEndsAt;
        },
        isResting() {
            return atRest;
        },
        lastPosition() {
            return lastPosition;
        },
        // Whether this planner would move the axis now: inputs that move,
        // Script mode driving, and a clock.
        isPlaying() {
            return inputMoving(input) && isActive() && hasClock();
        },
        // The leg to send now, or null when nothing should be sent (a leg is
        // in flight, or the axis already rests).
        next(now) {
            if (isInFlight(now)) return null;
            const from = inputMoving(input) && isActive() ? scriptFrom() : null;
            wasRunning = running();
            if (from === null) return stop(now);
            const resting = atRest;
            atRest = false;
            const leg = plan(now, from);
            if (leg) return leg;
            // The feed threw while planning: this axis stops (an axis that
            // already rests is sent nothing more).
            atRest = resting;
            wasRunning = false;
            return stop(now);
        },
        // Script legs are never re-timed: a non-zero change applies from the
        // next leg, a stop interrupts the leg by itself.
        retime() {
            return null;
        },
        // Where the axis really is (a logical position), or null when nobody
        // knows. The next leg rejoins the script from there.
        place(position) {
            const n = Number(position);
            lastPosition = position === null || position === undefined || !Number.isFinite(n) ? null : clamp01(n);
            needRejoin = true;
        },
        // Forget the leg in flight and where the axis is.
        reset() {
            legEndsAt = 0;
            lastPosition = null;
            atRest = false;
            needRejoin = true;
            lastGeneration = null;
            failed = false;
            wasRunning = false;
        }
    };
}

// A feed that always asks whatever feed `getFeed()` returns now, so a driver
// can make its planners once and have app.js install (or remove) the real
// feed later. With no feed installed it has no track and no time: a planner
// on it never moves.
export function liveFeed(getFeed) {
    const current = () => {
        const feed = typeof getFeed === 'function' ? getFeed() : null;
        return feed && typeof feed === 'object' ? feed : null;
    };
    const ask = (name, fallback, ...args) => {
        const feed = current();
        if (!feed || typeof feed[name] !== 'function') return fallback;
        return feed[name](...args);
    };
    return {
        isActive: () => Boolean(ask('isActive', false)),
        hasTime: () => Boolean(ask('hasTime', false)),
        scriptNow: () => ask('scriptNow', null),
        generation: () => ask('generation', null),
        shape: (args) => ask('shape', { points: [], reason: 'empty', vCap: 0, vJoin: 0, join: null }, args),
        positionAt: (t, a) => ask('positionAt', null, t, a),
        reportError: (error, source) => {
            try { ask('reportError', undefined, error, source); } catch (e) {}
        }
    };
}
