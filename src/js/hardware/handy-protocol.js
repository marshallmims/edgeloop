// Pure helpers for The Handy REST API v2 (HAMP mode). No fetch, no DOM, so
// everything here is unit-testable under node:test. handy.js does the I/O.

export const HANDY_API_BASE = 'https://www.handyfeeling.com/api/handy/v2';

// PUT /mode body values, per the official v2 OpenAPI spec.
export const HANDY_MODE = Object.freeze({
    HAMP: 0,
    HSSP: 1,
    HDSP: 2,
    MAINTENANCE: 3,
    HBSP: 4
});

// PUT /mode result codes: -1 error, 0 mode changed, 1 mode already active.
export const HANDY_RESULT_ERROR = -1;

// The narrowest slide range the driver is allowed to send. Anything tighter
// jams the sleeve in place and gives the user no stroke at all.
export const HANDY_MIN_SLIDE_GAP = 10;

// How far (in percent of travel) the driver keeps the commanded stroke away
// from the mechanical ends at 0 and 100.
//
// The Handy's firmware stops the slider when it decides the carriage is
// blocked (ERROR_SLIDER_BLOCKED / the slider_blocked event in API v3), and a
// carriage thrown into its own end stop looks exactly like a blocked one.
// Forum user X333 hit that lockout on a Handy 2 and worked around it by
// typing guards either side of 0 and 100 by hand.
//
// 5% is 5.5 mm on the 110 mm Handy 1 slider and 6.25 mm on the 125 mm Handy 2
// Pro, so it is never smaller than the 5 mm the firmware's own documented end
// zone (x_end_zone_size, API v3 SliderSettings) reserves for slowing down.
// There is no vendor statement of a safe margin, so this is the smallest
// number derived from a published vendor constant rather than invented. It is
// a default, not a law: the Handy panel takes 0-10 and 0 sends the range
// exactly as the engine asked for it.
export const HANDY_DEFAULT_END_MARGIN = 5;
export const HANDY_MAX_END_MARGIN = 10;

function toInt(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(n);
}

export function clampPercent(value, fallback = 0) {
    const n = toInt(value, fallback);
    return Math.max(0, Math.min(100, n));
}

// Normalise a requested stroke range into a valid PUT /slide body.
// Values are clamped to 0-100 integers, ordered so min < max, and widened
// toward the hardware envelope until at least `minGap` percent of travel
// remains. The envelope itself is never exceeded unless it is narrower than
// the gap, in which case the range grows toward 0/100 as a last resort.
export function normalizeSlideRange(min, max, envMin = 0, envMax = 100, minGap = HANDY_MIN_SLIDE_GAP) {
    const env = normalizeEnvelope(envMin, envMax, 'max', minGap);
    let lo = clampPercent(min, env.min);
    let hi = clampPercent(max, env.max);
    if (lo > hi) [lo, hi] = [hi, lo];
    lo = Math.max(env.min, Math.min(env.max, lo));
    hi = Math.max(env.min, Math.min(env.max, hi));

    if (hi - lo < minGap) {
        // Prefer lengthening the stroke outward (toward the envelope max) so a
        // shallow "tip only" request still keeps the user inside the envelope.
        hi = Math.min(env.max, lo + minGap);
        if (hi - lo < minGap) lo = Math.max(env.min, hi - minGap);
        if (hi - lo < minGap) {
            hi = Math.min(100, lo + minGap);
            lo = Math.max(0, hi - minGap);
        }
    }
    return { min: lo, max: hi };
}

// Normalise the user-typed hardware envelope. `changed` names the bound the
// user just edited ('min' or 'max'); the OTHER bound is moved when the two
// collide, so the typed number is honoured wherever physically possible.
export function normalizeEnvelope(min, max, changed = 'max', minGap = HANDY_MIN_SLIDE_GAP) {
    let lo = clampPercent(min, 0);
    let hi = clampPercent(max, 100);
    if (hi - lo < minGap) {
        if (changed === 'min') {
            hi = Math.min(100, lo + minGap);
            if (hi - lo < minGap) lo = Math.max(0, hi - minGap);
        } else {
            lo = Math.max(0, hi - minGap);
            if (hi - lo < minGap) hi = Math.min(100, lo + minGap);
        }
    }
    return { min: lo, max: hi };
}

export function clampVelocity(velocity) {
    return clampPercent(velocity, 0);
}

export function clampEndMargin(value, fallback = HANDY_DEFAULT_END_MARGIN) {
    const n = toInt(value, fallback);
    return Math.max(0, Math.min(HANDY_MAX_END_MARGIN, n));
}

// Inset an already-normalised slide range away from 0 and 100 by `margin`.
//
// The result is ALWAYS a subset of the range it was handed, which is what
// makes it safe: the input is already inside the user's hardware envelope, so
// the envelope can never be exceeded, the zone can never invert, and the
// stroke can never come back wider than it went in. The margin also yields
// rather than shrink a stroke below `minGap` (or below the width it already
// had, when that is narrower) - a margin must never take the wearer's stroke
// away, only move it off the ends.
export function applyEndMargin(range, margin = HANDY_DEFAULT_END_MARGIN, minGap = HANDY_MIN_SLIDE_GAP) {
    let lo0 = clampPercent(range ? range.min : 0, 0);
    let hi0 = clampPercent(range ? range.max : 100, 100);
    if (lo0 > hi0) [lo0, hi0] = [hi0, lo0];
    const m = clampEndMargin(margin);
    if (m === 0) return { min: lo0, max: hi0 };

    const keep = Math.min(Math.max(0, toInt(minGap, HANDY_MIN_SLIDE_GAP)), hi0 - lo0);
    let lo = Math.min(hi0, Math.max(lo0, m));
    let hi = Math.max(lo0, Math.min(hi0, 100 - m));
    if (hi < lo) return { min: lo0, max: hi0 };
    if (hi - lo < keep) lo = Math.max(lo0, hi - keep);
    if (hi - lo < keep) hi = Math.min(hi0, lo + keep);
    return { min: lo, max: hi };
}

// The slide window HSP uses: the travel envelope, pulled off the mechanical
// ends by the end margin, never narrower than the minimum stroke.
export function endMarginWindow(envMin = 0, envMax = 100, margin = HANDY_DEFAULT_END_MARGIN, minGap = HANDY_MIN_SLIDE_GAP) {
    const gap = Math.max(0, toInt(minGap, HANDY_MIN_SLIDE_GAP));
    const env = normalizeEnvelope(envMin, envMax, 'max', gap);
    const keep = Math.min(gap, env.max - env.min);
    const m = clampEndMargin(margin);
    let lo = Math.max(env.min, m);
    let hi = Math.min(env.max, 100 - m);
    if (hi - lo < keep) lo = Math.max(env.min, hi - keep);
    if (hi - lo < keep) hi = Math.min(env.max, lo + keep);
    return { min: lo, max: hi };
}

// PUT /slide answers with a SlideResult: ACCEPTED(0), ACCEPTED_ROUNDED_DOWN(1)
// or ACCEPTED_ROUNDED_UP(2). A 1 or a 2 is the only way the device ever tells
// us it did not take the numbers we sent (the spec names a MIN_ALLOWED stroke
// width but never gives its value). Returns a sentence, or null when the
// device took the range as sent.
export function describeSlideAdjustment(body, range = null) {
    if (!body || typeof body !== 'object') return null;
    const n = Number(body.result);
    if (n !== 1 && n !== 2) return null;
    const asked = range ? ` EdgeLoop asked for ${clampPercent(range.min, 0)}-${clampPercent(range.max, 100)}%.` : '';
    const dir = n === 1 ? 'rounded down' : 'rounded up';
    return `The Handy ${dir} the stroke range it was sent to one its own slider settings allow.${asked}`;
}

// True for the HAMP error band (3000-3999). API v2 has exactly one code in it,
// ERROR(3000) "Unspecified HAMP error", so a HAMP fault - including a slider
// the firmware has locked out - can only ever arrive as that.
export function isHampModeError(code) {
    const n = Number(code);
    return Number.isFinite(n) && n >= 3000 && n <= 3999;
}

// The wearer-facing sentence for a device that refused a motion command.
// Over API v2 we can never name slider_blocked outright - the whole HAMP
// error set is one unspecified code - so this says what the device does and
// which setting to change, and claims nothing more. EdgeLoop never concludes
// a lockout by itself: this explains a refusal the device sent us.
export function describeDeviceStop(cause = '') {
    const lead = cause ? `${String(cause).trim()} ` : '';
    return `${lead}The Handy's firmware stops the slider when it reads as blocked, which includes being driven hard into the ends of its travel. Check the sleeve and the rails for an obstruction, then narrow the Travel Envelope or raise the End-stop margin in the Handy panel.`;
}

// Classify one API reply. `body` is the parsed JSON (or null when the body was
// not JSON). Returns { ok, message, code }. Failure is any of: non-2xx HTTP
// status, a body carrying an `error` object, or `result === -1`.
export function classifyHandyResponse(httpOk, status, body, path = '') {
    const where = path ? ` (${path})` : '';
    if (body && typeof body === 'object' && body.error) {
        const err = body.error;
        const message = (typeof err === 'object' && err !== null)
            ? (err.message || err.name || `error code ${err.code ?? '?'}`)
            : String(err);
        const code = (typeof err === 'object' && err !== null) ? (err.code ?? null) : null;
        return { ok: false, message: `${message}${where}`, code };
    }
    if (!httpOk) {
        return { ok: false, message: `HTTP ${status || '?'}${where}`, code: status || null };
    }
    if (body && typeof body === 'object' && body.result === HANDY_RESULT_ERROR) {
        return { ok: false, message: `Device rejected command${where}`, code: HANDY_RESULT_ERROR };
    }
    return { ok: true, message: '', code: null };
}

// Pull a battery percentage out of a GET /info reply. The v2 spec has no
// battery endpoint, so any of these fields is best-effort. Returns null when
// nothing usable is present. Only fractional 0-1 values are scaled to percent.
export function parseBatteryLevel(info) {
    if (!info || typeof info !== 'object') return null;
    const raw = info.battery ?? info.batteryLevel ?? info.battery_level ?? info.level ?? null;
    if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    const scaled = (n > 0 && n <= 1 && !Number.isInteger(n)) ? n * 100 : n;
    return Math.max(0, Math.min(100, Math.round(scaled)));
}

// Build the human-readable "fw x.y, model" suffix for the status line.
export function describeHandyInfo(info) {
    if (!info || typeof info !== 'object') return '';
    const parts = [];
    const fw = info.fwVersion ?? info.firmwareVersion ?? info.firmware ?? null;
    const model = info.model ?? info.hwVersion ?? null;
    if (fw) parts.push(`fw ${fw}`);
    if (model) parts.push(String(model));
    return parts.join(', ');
}

// Outcomes of a stop sent to a cloud toy after a page died. VacuGlide uses
// the same names. A conclusive outcome means the device is no longer our
// problem.
export const RECOVERY_STOP = Object.freeze({
    STOPPED: 'stopped',
    ALREADY_STOPPED: 'already-stopped',
    NOT_HAMP: 'not-hamp',
    OFFLINE: 'offline',
    FAILED: 'failed',
    CONNECTED: 'connected',
    LINKED: 'linked'
});

export function isRecoveryStopConclusive(outcome) {
    return outcome === RECOVERY_STOP.STOPPED
        || outcome === RECOVERY_STOP.ALREADY_STOPPED
        || outcome === RECOVERY_STOP.NOT_HAMP
        || outcome === RECOVERY_STOP.CONNECTED
        || outcome === RECOVERY_STOP.LINKED;
}
