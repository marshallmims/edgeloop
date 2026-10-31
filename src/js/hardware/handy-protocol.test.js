import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_MODE,
    HANDY_MIN_SLIDE_GAP,
    HANDY_DEFAULT_END_MARGIN,
    HANDY_MAX_END_MARGIN,
    clampPercent,
    clampVelocity,
    clampEndMargin,
    applyEndMargin,
    followPosition,
    firmwareMajor,
    hdspBody,
    HANDY_DEVICES,
    hdspMove,
    hdspTimingFor,
    hdspEstimatedPosition,
    HDSP_MS_PER_PERCENT,
    HDSP_MIN_DURATION_MS,
    normalizeSlideRange,
    normalizeEnvelope,
    classifyHandyDevice,
    classifyHandyResponse,
    describeSlideAdjustment,
    isHampModeError,
    describeDeviceStop,
    parseBatteryLevel,
    describeHandyInfo
} from './handy-protocol.js';

describe('handy mode constants', () => {
    it('matches the v2 spec numbering', () => {
        assert.equal(HANDY_MODE.HAMP, 0);
        assert.equal(HANDY_MODE.HSSP, 1);
        assert.equal(HANDY_MODE.HDSP, 2);
        assert.equal(HANDY_MODE.MAINTENANCE, 3);
        assert.equal(HANDY_MODE.HBSP, 4);
    });
});

describe('clampPercent / clampVelocity', () => {
    it('clamps and rounds to integer percent', () => {
        assert.equal(clampPercent(-5), 0);
        assert.equal(clampPercent(105), 100);
        assert.equal(clampPercent(42.6), 43);
        assert.equal(clampPercent('37'), 37);
    });
    it('falls back on garbage', () => {
        assert.equal(clampPercent('abc', 55), 55);
        assert.equal(clampPercent(undefined, 12), 12);
        assert.equal(clampVelocity(NaN), 0);
        assert.equal(clampVelocity(250), 100);
    });
});

describe('normalizeSlideRange', () => {
    it('passes a valid range through', () => {
        assert.deepEqual(normalizeSlideRange(20, 80), { min: 20, max: 80 });
    });
    it('clamps to 0-100 and orders min < max', () => {
        assert.deepEqual(normalizeSlideRange(-10, 130), { min: 0, max: 100 });
        assert.deepEqual(normalizeSlideRange(80, 20), { min: 20, max: 80 });
    });
    it('enforces the minimum gap by widening toward the envelope max', () => {
        assert.deepEqual(normalizeSlideRange(50, 50), { min: 50, max: 50 + HANDY_MIN_SLIDE_GAP });
        assert.deepEqual(normalizeSlideRange(30, 33, 0, 100), { min: 30, max: 40 });
    });
    it('widens downward when the envelope top is already reached', () => {
        assert.deepEqual(normalizeSlideRange(100, 100, 0, 100), { min: 90, max: 100 });
        assert.deepEqual(normalizeSlideRange(78, 80, 20, 80), { min: 70, max: 80 });
    });
    it('never leaves the hardware envelope', () => {
        assert.deepEqual(normalizeSlideRange(0, 100, 15, 85), { min: 15, max: 85 });
        assert.deepEqual(normalizeSlideRange(5, 10, 15, 85), { min: 15, max: 25 });
        assert.deepEqual(normalizeSlideRange(90, 99, 15, 85), { min: 75, max: 85 });
    });
    it('grows past a too-narrow envelope only as a last resort', () => {
        const out = normalizeSlideRange(50, 52, 50, 52);
        assert.ok(out.max - out.min >= HANDY_MIN_SLIDE_GAP);
        assert.ok(out.min >= 0 && out.max <= 100);
    });
    it('rounds fractional input to integers', () => {
        const out = normalizeSlideRange(10.4, 60.6);
        assert.deepEqual(out, { min: 10, max: 61 });
        assert.ok(Number.isInteger(out.min) && Number.isInteger(out.max));
    });
});

describe('normalizeEnvelope', () => {
    it('keeps a sane envelope untouched', () => {
        assert.deepEqual(normalizeEnvelope(15, 85), { min: 15, max: 85 });
    });
    it('clamps to 0-100', () => {
        assert.deepEqual(normalizeEnvelope(-20, 140), { min: 0, max: 100 });
    });
    it('moves max when min was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(85, 80, 'min'), { min: 85, max: 95 });
        assert.deepEqual(normalizeEnvelope(60, 65, 'min'), { min: 60, max: 70 });
        // min 95 cannot hold a 10% stroke below 100, so min itself is pulled back.
        assert.deepEqual(normalizeEnvelope(95, 90, 'min'), { min: 90, max: 100 });
    });
    it('moves min when max was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(60, 65, 'max'), { min: 55, max: 65 });
        assert.deepEqual(normalizeEnvelope(5, 5, 'max'), { min: 0, max: 10 });
    });
    it('falls back when the edited bound sits at the hard limit', () => {
        assert.deepEqual(normalizeEnvelope(100, 100, 'min'), { min: 90, max: 100 });
        assert.deepEqual(normalizeEnvelope(0, 0, 'max'), { min: 0, max: 10 });
    });
    it('uses defaults for empty input', () => {
        assert.deepEqual(normalizeEnvelope('', ''), { min: 0, max: 100 });
    });
});

describe('classifyHandyResponse', () => {
    it('accepts a plain 200 with a result code', () => {
        assert.deepEqual(classifyHandyResponse(true, 200, { result: 0 }), { ok: true, message: '', code: null });
        assert.equal(classifyHandyResponse(true, 200, { result: 1 }).ok, true);
        assert.equal(classifyHandyResponse(true, 200, { connected: true }).ok, true);
    });
    it('rejects a non-ok HTTP status', () => {
        const out = classifyHandyResponse(false, 401, null, '/connected');
        assert.equal(out.ok, false);
        assert.match(out.message, /HTTP 401/);
        assert.match(out.message, /\/connected/);
    });
    it('rejects an error object even with HTTP 200', () => {
        const out = classifyHandyResponse(true, 200, { error: { code: 1001, message: 'Invalid connection key' } }, '/mode');
        assert.equal(out.ok, false);
        assert.equal(out.code, 1001);
        assert.match(out.message, /Invalid connection key/);
    });
    it('rejects result -1', () => {
        const out = classifyHandyResponse(true, 200, { result: -1 });
        assert.equal(out.ok, false);
        assert.equal(out.code, -1);
    });
    it('handles a non-JSON body', () => {
        assert.equal(classifyHandyResponse(true, 200, null).ok, true);
        assert.equal(classifyHandyResponse(false, 502, null).ok, false);
    });
});

describe('parseBatteryLevel', () => {
    it('returns null when the field is absent', () => {
        assert.equal(parseBatteryLevel({}), null);
        assert.equal(parseBatteryLevel(null), null);
        assert.equal(parseBatteryLevel({ battery: 'n/a' }), null);
    });
    it('does not scale integer percentages', () => {
        assert.equal(parseBatteryLevel({ battery: 1 }), 1);
        assert.equal(parseBatteryLevel({ battery: 85 }), 85);
        assert.equal(parseBatteryLevel({ batteryLevel: 100 }), 100);
    });
    it('scales fractional 0-1 values', () => {
        assert.equal(parseBatteryLevel({ battery: 0.42 }), 42);
        assert.equal(parseBatteryLevel({ battery: 0.999 }), 100);
    });
    it('clamps out-of-range values', () => {
        assert.equal(parseBatteryLevel({ battery: 140 }), 100);
        assert.equal(parseBatteryLevel({ battery: -3 }), null);
    });
});

describe('describeHandyInfo', () => {
    it('formats firmware and model', () => {
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3', model: 'Handy 1.1' }), 'fw 3.2.3, Handy 1.1');
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3' }), 'fw 3.2.3');
        assert.equal(describeHandyInfo({ hwVersion: '1.1' }), '1.1');
        assert.equal(describeHandyInfo({}), '');
        assert.equal(describeHandyInfo(null), '');
    });
});

// X333, on the public build, after the range started reaching the device for
// the first time: "new version triggers the safety lockout on the handy 2
// (hitting too hard against the sides) as soon as warmup is over. i had to
// set guards around the 0 and 100%." The margin is that guard, applied by the
// driver so it reaches the people who never typed one.
describe('clampEndMargin', () => {
    it('keeps 0-10 whole percent', () => {
        assert.equal(clampEndMargin(0), 0);
        assert.equal(clampEndMargin(5), 5);
        assert.equal(clampEndMargin(10), 10);
        assert.equal(clampEndMargin('3'), 3);
        assert.equal(clampEndMargin(4.4), 4);
    });
    it('clamps out of range and falls back on garbage', () => {
        assert.equal(clampEndMargin(-5), 0);
        assert.equal(clampEndMargin(40), HANDY_MAX_END_MARGIN);
        assert.equal(clampEndMargin('abc'), HANDY_DEFAULT_END_MARGIN);
        assert.equal(clampEndMargin(undefined), HANDY_DEFAULT_END_MARGIN);
        assert.equal(clampEndMargin(null), HANDY_DEFAULT_END_MARGIN);
        // A corrupt stored value protects the wearer rather than disabling
        // the guard silently; only a typed 0 turns it off.
        assert.equal(clampEndMargin(NaN), HANDY_DEFAULT_END_MARGIN);
    });
});

describe('which Handy answered', () => {
    it('treats firmware 3 as a Handy 1, which has no battery', () => {
        const device = classifyHandyDevice({ info: { fwVersion: '3.2.3', model: 'Handy 1.1' } });
        assert.equal(device.id, 'handy1');
        assert.equal(device.hasBattery, false);
        assert.equal(device.maxMmPerSec, 400);
        assert.equal(hdspTimingFor(device).maxDurationMs, 275);
    });

    it('treats a firmware 4 device that says it has no battery as a Handy 1', () => {
        const device = classifyHandyDevice({
            info: { fw_version: '4.1.0', hw_model_name: 'H01' },
            capabilities: { battery: false, slider: 1 }
        });
        assert.equal(device, HANDY_DEVICES.handy1);
    });

    it('treats a battery device whose rated ceiling is 400 as a Handy 2', () => {
        const device = classifyHandyDevice({
            info: { fw_version: '4.2.0', hw_model_name: 'H02' },
            capabilities: { battery: true },
            slider: { x_stroke_max: 125, x_max_speed_theoretical: 400, x_max_speed: 400, overclock_enabled: false }
        });
        assert.equal(device.id, 'handy2');
        assert.equal(device.hasBattery, true);
        assert.equal(hdspTimingFor(device).maxDurationMs, 313);
    });

    it('uses the Pro rated 450 and ignores an 800 overclock', () => {
        const device = classifyHandyDevice({
            info: { fw_version: '4.2.2', hw_model_name: 'H02' },
            capabilities: { battery: true },
            slider: { x_stroke_max: 125, x_max_speed_theoretical: 450, x_max_speed: 800, overclock_enabled: true }
        });
        assert.equal(device.id, 'handy2pro');
        assert.equal(device.maxMmPerSec, 450);
        assert.equal(hdspTimingFor(device).maxDurationMs, 278);
    });

    it('does not guess when firmware 4 says nothing about a battery or a stroke', () => {
        assert.equal(classifyHandyDevice({ info: { fw_version: '4.0.0' } }), null);
        assert.equal(hdspTimingFor(null), null);
    });
});

describe('hdspMove', () => {
    it('brakes at the finger, and gives a full stroke one quick trip', () => {
        const first = hdspMove(5, -1);
        assert.equal(first.position, 5);
        assert.equal(first.stopOnTarget, true);
        assert.equal(first.duration, 100 * HDSP_MS_PER_PERCENT);
        assert.ok(first.duration > HDSP_MIN_DURATION_MS);
        const down = hdspMove(20, 95);
        assert.equal(down.position, 20);
        assert.equal(down.stopOnTarget, true);
        assert.equal(down.duration, 75 * HDSP_MS_PER_PERCENT);
        const held = hdspMove(50, 50);
        assert.equal(held.duration, HDSP_MIN_DURATION_MS);
        const body = hdspBody(down);
        assert.equal(body.position, 20);
        assert.equal(body.xp, 20);
        assert.equal(body.t, body.duration);
        assert.equal(body.stopOnTarget, true);
        assert.equal(body.stop_on_target, true);
        assert.equal(firmwareMajor({ fwVersion: '4.2.2+44874492' }), 4);
        assert.equal(firmwareMajor({ fwVersion: '3.2.3' }), 3);
    });

    it('times the next move from where the carriage is, not from the last target', () => {
        const leg = { from: 10, to: 90, duration: 320, sentAt: 1000 };
        assert.equal(hdspEstimatedPosition(leg, 1000), 10);
        assert.equal(hdspEstimatedPosition(leg, 1160), 50);
        assert.equal(hdspEstimatedPosition(leg, 1400), 90);
        assert.equal(hdspEstimatedPosition(null, 1160), -1);
        // Halfway along that trip the finger is already at 20. The remaining
        // distance is 30 percent, not the 70 between the two targets.
        const caught = hdspMove(20, hdspEstimatedPosition(leg, 1160));
        assert.equal(caught.duration, 30 * HDSP_MS_PER_PERCENT);
    });
});

describe('followPosition', () => {
    it('maps a finger onto the travel window', () => {
        assert.equal(followPosition(0, 0, 100, 5), 5);
        assert.equal(followPosition(100, 0, 100, 5), 95);
        assert.equal(followPosition(50, 0, 100, 5), 50);
        assert.equal(followPosition(0, 0, 100, 0), 0);
        assert.equal(followPosition(100, 20, 80, 0), 80);
    });
});

describe('applyEndMargin', () => {
    it('insets a full-travel stroke by the margin', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 3), { min: 3, max: 97 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 10), { min: 10, max: 90 });
    });
    it('leaves a range that already clears the ends exactly as it was', () => {
        // The property the report asks for: a wearer who already typed a
        // guard sees no change at all, at any margin up to the maximum.
        for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
            assert.deepEqual(applyEndMargin({ min: 15, max: 85 }, m), { min: 15, max: 85 });
        }
        assert.deepEqual(applyEndMargin({ min: 5, max: 95 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 20, max: 80 }, 5), { min: 20, max: 80 });
    });
    it('only moves the end that is actually against the stop', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 90 }, 5), { min: 5, max: 90 });
        assert.deepEqual(applyEndMargin({ min: 10, max: 100 }, 5), { min: 10, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 35 }, 5), { min: 5, max: 35 });
        assert.deepEqual(applyEndMargin({ min: 75, max: 100 }, 5), { min: 75, max: 95 });
    });
    it('sends the range untouched at margin 0', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 0), { min: 0, max: 100 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 0), { min: 0, max: 12 });
    });
    it('yields rather than take the wearer\'s stroke away', () => {
        // A minimum-width stroke against the bottom stop keeps its width: the
        // margin gives up entirely rather than leave a jammed sleeve.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5), { min: 0, max: 10 });
        // A stroke with room to spare gives up only as much as it can.
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 5), { min: 2, max: 12 });
        // Already narrower than the minimum gap (a hand-narrowed envelope):
        // the width it had is the width it keeps.
        assert.deepEqual(applyEndMargin({ min: 96, max: 100 }, 5), { min: 96, max: 100 });
    });
    it('is a subset of its input for every range and margin', () => {
        // The whole safety argument in one property: the input is already
        // inside the user's envelope, so a subset of it cannot leave the
        // envelope, cannot invert, and cannot come back wider.
        let checked = 0;
        for (let lo = 0; lo <= 100; lo += 1) {
            for (let hi = lo; hi <= 100; hi += 1) {
                for (let m = 0; m <= HANDY_MAX_END_MARGIN; m += 1) {
                    const out = applyEndMargin({ min: lo, max: hi }, m);
                    assert.ok(out.min >= lo && out.max <= hi, `escaped input ${lo}-${hi} margin ${m}: ${out.min}-${out.max}`);
                    assert.ok(out.max >= out.min, `inverted at ${lo}-${hi} margin ${m}`);
                    const keep = Math.min(HANDY_MIN_SLIDE_GAP, hi - lo);
                    assert.ok(out.max - out.min >= keep, `lost stroke at ${lo}-${hi} margin ${m}: ${out.min}-${out.max}`);
                    checked += 1;
                }
            }
        }
        assert.ok(checked > 50000);
    });
    it('survives a hand-edited or missing range', () => {
        assert.deepEqual(applyEndMargin({ min: 80, max: 20 }, 5), { min: 20, max: 80 });
        assert.deepEqual(applyEndMargin({ min: -10, max: 140 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin(null, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({}, 0), { min: 0, max: 100 });
    });
    it('defaults to the shipped margin', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }), { min: HANDY_DEFAULT_END_MARGIN, max: 100 - HANDY_DEFAULT_END_MARGIN });
    });
});

describe('describeSlideAdjustment', () => {
    it('says nothing when the device took the range as sent', () => {
        assert.equal(describeSlideAdjustment({ result: 0 }), null);
        assert.equal(describeSlideAdjustment({}), null);
        assert.equal(describeSlideAdjustment(null), null);
    });
    it('names a rounded range and what we asked for', () => {
        const down = describeSlideAdjustment({ result: 1 }, { min: 5, max: 95 });
        assert.match(down, /rounded down/);
        assert.match(down, /5-95%/);
        assert.match(describeSlideAdjustment({ result: 2 }, { min: 0, max: 10 }), /rounded up/);
        assert.match(describeSlideAdjustment({ result: 1 }), /rounded down/);
    });
});

describe('isHampModeError / describeDeviceStop', () => {
    it('recognises the HAMP error band and nothing else', () => {
        assert.equal(isHampModeError(3000), true);
        assert.equal(isHampModeError(3999), true);
        assert.equal(isHampModeError(2999), false);
        assert.equal(isHampModeError(1001), false);
        assert.equal(isHampModeError(-1), false);
        assert.equal(isHampModeError(null), false);
        assert.equal(isHampModeError('x'), false);
    });
    it('tells the wearer what the device did and what to change', () => {
        const msg = describeDeviceStop('The Handy refused a motion command (HAMP error 3000).');
        assert.match(msg, /^The Handy refused a motion command \(HAMP error 3000\)\./);
        assert.match(msg, /obstruction/i);
        assert.match(msg, /End-stop margin/);
        assert.match(msg, /Travel Envelope/);
        // It never claims a fault code the v2 API cannot give us.
        assert.ok(!/slider_blocked/.test(msg));
        assert.match(describeDeviceStop(), /^The Handy's firmware/);
    });
});
