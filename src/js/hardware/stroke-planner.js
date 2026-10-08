// Per-axis stroke scheduler for Buttplug LinearCmd actuators (OSR2 / SR6 /
// OSSM through Intiface). Pure: no timers, no sockets. The driver feeds it
// the engine's inputs and asks "what should be sent now?"; the planner
// answers with at most ONE leg at a time and never re-issues a leg that is
// still in flight, which is what keeps the motion smooth.
//
// Rules:
//   - A stroke alternates between zone min and zone max; each leg is one
//     LinearCmd carrying the FULL leg duration.
//   - Speed, cap and zone changes apply to the NEXT leg only.
//   - Speed 0, pause or stop -> the leg in flight finishes, then a single
//     move to the rest position (zone min) over REST_MOVE_MS, then silence
//     until speed > 0 again.
//   - Role OFF (enabled: false) interrupts the leg in flight: the rest move
//     is the next thing sent.
//   - A leg's duration follows the distance really travelled: the first leg
//     after a rest or a zone shift that has to cross more than the zone
//     width gets proportionally longer, never a snap. `legTravel` overrides
//     the zone width as the base (rotation axes: 1, so the swing period
//     depends on the speed alone, not on the amplitude).

export const FAST_LEG_MS = 180;
export const SLOW_LEG_MS = 2200;
export const MIN_LEG_MS = 120;
export const MIN_TRAVEL = 0.08;
export const REST_MOVE_MS = 400;

function clamp01(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function clampPercent(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
}

// One leg's duration: 100 % speed ~ 180 ms per leg, 0 % ~ 2200 ms, scaled by
// the travel (a 40 % zone takes 40 % of the time), never below MIN_LEG_MS.
export function legDurationMs(speedPercent, travel) {
    const speed = clampPercent(speedPercent);
    const span = Math.max(MIN_TRAVEL, clamp01(travel));
    const duration = FAST_LEG_MS + ((100 - speed) / 100) * (SLOW_LEG_MS - FAST_LEG_MS);
    return Math.max(MIN_LEG_MS, Math.round(duration * span));
}

// Normalise the planner inputs: percentages clamped, zone ordered.
export function normalizePlannerInput({ speed = 0, zoneMin = 0, zoneMax = 1, cap = 100, enabled = true, legTravel = null } = {}) {
    const min = clamp01(zoneMin, 0);
    const max = Math.max(min, clamp01(zoneMax, 1));
    const capPct = clampPercent(cap, 100);
    const effectiveSpeed = clampPercent(speed) * (capPct / 100);
    const travelBase = legTravel === null || legTravel === undefined ? null : clamp01(legTravel, 1);
    return { speed: clampPercent(speed), cap: capPct, effectiveSpeed, zoneMin: min, zoneMax: max, enabled: enabled !== false, legTravel: travelBase };
}

export function createStrokePlanner({ restMs = REST_MOVE_MS, hold = false } = {}) {
    let input = normalizePlannerInput({});
    let legEndsAt = 0;
    let lastPosition = null;      // null: position unknown (fresh axis)
    let atRest = false;           // a rest move has been issued and nothing since
    let goingUp = true;           // direction of the next stroke leg
    let aimFromPlace = false;

    function isInFlight(now) {
        return now < legEndsAt;
    }

    return {
        // Update the inputs. Takes effect on the next leg, except that role
        // OFF (enabled false) interrupts the leg in flight so the rest move
        // goes out at once.
        setInput(next) {
            const wasEnabled = input.enabled;
            input = normalizePlannerInput({ ...input, ...next });
            if (wasEnabled && !input.enabled) legEndsAt = 0;
            if (hold && !(input.enabled && input.effectiveSpeed > 0)) legEndsAt = 0;
        },
        getInput() {
            return { ...input };
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
        // The leg to send right now, or null when nothing should be sent
        // (a leg is in flight, or the axis is already resting).
        next(now) {
            if (isInFlight(now)) return null;
            const active = input.enabled && input.effectiveSpeed > 0;
            if (!active) {
                if (atRest) return null;
                atRest = true;
                goingUp = true;
                // A holding planner (OSSM position mode) stays where it is.
                // A rest move would be another trip along the rail.
                if (hold) {
                    legEndsAt = now;
                    return { position: null, durationMs: 0, kind: 'hold' };
                }
                lastPosition = input.zoneMin;
                legEndsAt = now + restMs;
                return { position: input.zoneMin, durationMs: restMs, kind: 'rest' };
            }
            atRest = false;
            if (hold && aimFromPlace && lastPosition !== null) {
                goingUp = (input.zoneMax - lastPosition) >= (lastPosition - input.zoneMin);
            }
            aimFromPlace = false;
            const travel = input.zoneMax - input.zoneMin;
            const position = goingUp ? input.zoneMax : input.zoneMin;
            // Size the leg by what it really has to cover: the zone width
            // (or legTravel) at least, the distance from the last position
            // when that is longer (first leg after a rest or a zone shift).
            const base = input.legTravel !== null ? input.legTravel : travel;
            let distance = lastPosition === null ? 0 : Math.abs(position - lastPosition);
            if (hold && lastPosition === null) distance = Math.max(position, 1 - position);
            const durationMs = legDurationMs(input.effectiveSpeed, Math.max(base, distance));
            goingUp = !goingUp;
            lastPosition = position;
            legEndsAt = now + durationMs;
            return { position, durationMs, kind: 'stroke' };
        },
        // Where a holding axis really is, or null when nobody knows. The next
        // leg is sized from there.
        place(position) {
            const n = Number(position);
            lastPosition = position === null || position === undefined || !Number.isFinite(n) ? null : Math.max(0, Math.min(1, n));
            aimFromPlace = lastPosition !== null;
        },
        // Forget the in-flight leg (device removed, socket closed). The next
        // call to next() with speed 0 issues a fresh rest move.
        reset() {
            legEndsAt = 0;
            lastPosition = null;
            atRest = false;
            goingUp = true;
            aimFromPlace = false;
        }
    };
}
