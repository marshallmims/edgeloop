import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_APP_ID,
    HANDY_V3_BASE,
    HSP_PLAY_STATE,
    HSP_MAX_POINTS_PER_ADD,
    sanitizeApplicationId,
    resolveApplicationId,
    v3Headers,
    sseUrl,
    newStreamId,
    toHspPoints,
    addBody,
    playBody,
    synctimeBody,
    strokeWindow,
    strokeBody,
    compareStroke,
    unwrapResult,
    classifyHspReply,
    isHspStopConfirmed,
    isHspFlushConfirmed,
    fwSupportsHsp,
    capabilitiesAllowHsp,
    sliderLimits,
    estimateServerOffset,
    leadFor,
    planPositionAt,
    planWindow,
    clipPlan,
    chunkPoints,
    quantizeAllowance,
    isUrgentAllowanceChange,
    createRequestBudget,
    classifyHspEvent,
    parseSseMessage,
    describeHspOwedStop,
    describeHandyRoute,
    describeHspStartRefusal,
    describeBeatSyncCheckFailed,
    hspNotPossible,
    handyScriptRoute,
    classifyHspRecoveryStop
} from './handy-hsp-protocol.js';

const state = (play_state, extra = {}) => ({ play_state, points: 10, max_points: 4000, current_time: 0, ...extra });

describe('the Application ID', () => {
    it('is the fork\'s, embedded, and an override is used only when it is a usable ID', () => {
        assert.equal(HANDY_APP_ID, 'H~_gYF5D__EbRjG6h8qoRTPBX-uErHfI');
        assert.equal(resolveApplicationId(''), HANDY_APP_ID);
        assert.equal(resolveApplicationId(null), HANDY_APP_ID);
        assert.equal(resolveApplicationId('  short '), HANDY_APP_ID);
        assert.equal(resolveApplicationId('has spaces in it'), HANDY_APP_ID);
        assert.equal(resolveApplicationId('<script>alert(1)</script>'), HANDY_APP_ID);
        assert.equal(resolveApplicationId(' My-Own_App~ID.123 '), 'My-Own_App~ID.123');
        assert.equal(sanitizeApplicationId('x'.repeat(129)), null);
        assert.equal(sanitizeApplicationId(12345678), null);
    });

    it('goes in X-Api-Key next to the connection key on every device call, and in the SSE query', () => {
        assert.deepEqual(v3Headers('APP', 'KEY'), { 'X-Api-Key': 'APP', 'X-Connection-Key': 'KEY' });
        assert.deepEqual(v3Headers('APP', 'KEY', { json: true }), { 'X-Api-Key': 'APP', 'X-Connection-Key': 'KEY', 'Content-Type': 'application/json' });
        const url = new URL(sseUrl('H~_a b', 'k&y', ['mode_changed', 'button_event']));
        assert.equal(url.origin + url.pathname, `${HANDY_V3_BASE}/sse`);
        assert.equal(url.searchParams.get('apikey'), 'H~_a b');
        assert.equal(url.searchParams.get('ck'), 'k&y');
        assert.equal(url.searchParams.get('events'), 'mode_changed,button_event');
    });

    it('draws a stream id in 1..2^32-1', () => {
        assert.equal(newStreamId(() => 0), 1);
        assert.equal(newStreamId(() => 0.999999999999), 0xfffffffe);
        assert.ok(newStreamId(() => NaN) >= 1);
    });
});

describe('points and bodies', () => {
    it('sends whole ms >= 0 and whole x 0-100, in time order, the later of two at one ms winning', () => {
        const out = toHspPoints([
            { t: -5, x: 0.5 },
            { t: 10.4, x: 1.7 },
            { t: 10.2, x: -1 },
            { t: 5, x: 0.2 },
            { t: 20, x: NaN },
            { t: 30, x: 0.333 }
        ]);
        // -5 ms at 50 to 10.4 ms at 100: at 0 the line is at 88.96, rounded toward 100.
        assert.deepEqual(out, [{ t: 0, x: 89 }, { t: 10, x: 0 }, { t: 30, x: 33 }]);
        for (const p of out) {
            assert.ok(Number.isInteger(p.t) && p.t >= 0);
            assert.ok(Number.isInteger(p.x) && p.x >= 0 && p.x <= 100);
        }
    });

    it('puts a plan that starts before 0 in the buffer from 0, where the plan is then, never faster than the plan', () => {
        // A long, slow move from -1900 ms: the part from 0 on keeps its speed,
        // where clamping its start to 0 would squeeze all of it into 250 ms.
        const plan = [{ t: -1900, x: 1 }, { t: 250, x: 0.9 }, { t: 500, x: 0.87 }];
        const out = toHspPoints(plan);
        // At 0 the line is at 91.16, rounded toward 90.
        assert.deepEqual(out, [{ t: 0, x: 91 }, { t: 250, x: 90 }, { t: 500, x: 87 }]);
        assert.ok((out[0].x - out[1].x) / 250 <= 10 / 2150);
        // A point at 0 after one before it is the plan's own point at 0, kept.
        assert.deepEqual(toHspPoints([{ t: -1000, x: 1 }, { t: 0, x: 0.1 }, { t: 250, x: 0.9 }]), [{ t: 0, x: 10 }, { t: 250, x: 90 }]);
        // Rounded toward the next point (1.5 and 48.5): up when it is higher, down when lower.
        assert.deepEqual(toHspPoints([{ t: -100, x: 0 }, { t: 100, x: 0.03 }]), [{ t: 0, x: 2 }, { t: 100, x: 3 }]);
        assert.deepEqual(toHspPoints([{ t: -100, x: 0.5 }, { t: 100, x: 0.47 }]), [{ t: 0, x: 48 }, { t: 100, x: 47 }]);
        // Only points before 0: where the plan ends, held at 0.
        assert.deepEqual(toHspPoints([{ t: -300, x: 0.2 }, { t: -100, x: 0.4 }]), [{ t: 0, x: 40 }]);
    });

    it('builds play with its add embedded, flush on, pause_on_starving off', () => {
        const add = addBody({ points: [{ t: 1, x: 2 }], flush: true, tailIndex: 1 });
        assert.deepEqual(add, { points: [{ t: 1, x: 2 }], tail_point_stream_index: 1, flush: true });
        assert.deepEqual(addBody({ points: [], tailIndex: 3 }), { points: [], tail_point_stream_index: 3 });
        const play = playBody({ startTime: 1234.6, serverTime: 99.2, add });
        assert.deepEqual(play, { start_time: 1235, server_time: 99, playback_rate: 1, pause_on_starving: false, loop: false, add });
        assert.deepEqual(synctimeBody({ currentTime: 10.5, serverTime: 20.4 }), { current_time: 11, server_time: 20, filter: 0.5 });
    });

    it('sets the stroke window to the envelope less the end margin, as fractions', () => {
        assert.deepEqual(strokeWindow(0, 100, 5), { min: 5, max: 95 });
        assert.deepEqual(strokeWindow(20, 80, 5), { min: 20, max: 80 });
        assert.deepEqual(strokeBody({ min: 5, max: 95 }), { min: 0.05, max: 0.95 });
    });

    it('keeps a stroke the wearer narrowed and sends ours again over a wider one', () => {
        const ours = { min: 10, max: 90 };
        assert.equal(compareStroke({ min: 0.1, max: 0.9 }, ours), 'same');
        assert.equal(compareStroke({ min: 0.2, max: 0.8 }, ours), 'narrower');
        assert.equal(compareStroke({ min: 0.05, max: 0.9 }, ours), 'wider');
        assert.equal(compareStroke({ min: 0.1, max: 1 }, ours), 'wider');
        assert.equal(compareStroke(null, ours), 'unknown');
    });
});

describe('replies, as the live API gives them', () => {
    it('reads an unknown connection key as not connected (HTTP 200 with an error)', () => {
        const v = classifyHspReply({ httpOk: true, status: 200, body: { error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } } }, '/hsp/stop');
        assert.equal(v.ok, false);
        assert.equal(v.notConnected, true);
        assert.equal(v.code, 1001);
        assert.equal(v.message, 'Device not connected (/hsp/stop)');
    });

    it('reads a refused Application ID (HTTP 401, no code, no connected flag)', () => {
        const v = classifyHspReply({ httpOk: false, status: 401, body: { error: { name: '', message: 'Unauthenticated' } } });
        assert.equal(v.ok, false);
        assert.equal(v.unauthenticated, true);
        assert.equal(v.notConnected, false);
    });

    it('reads a missing connection key (HTTP 400, no error wrapper)', () => {
        const v = classifyHspReply({ httpOk: false, status: 400, body: { name: 'Bad request', message: 'Missing connection key in request' } }, '/connected');
        assert.equal(v.ok, false);
        assert.match(v.message, /HTTP 400: Missing connection key in request \(\/connected\)/);
    });

    it('unwraps result, and takes /servertime as it comes', () => {
        const conn = classifyHspReply({ httpOk: true, status: 200, body: { result: { connected: false } } });
        assert.equal(conn.ok, true);
        assert.deepEqual(conn.result, { connected: false });
        const time = classifyHspReply({ httpOk: true, status: 200, body: { server_time: 1791455308468 } });
        assert.equal(time.result.server_time, 1791455308468);
        assert.equal(unwrapResult({ result: 0 }), 0);
    });

    it('names a device timeout, a rate limit and a lost answer', () => {
        assert.equal(classifyHspReply({ httpOk: true, status: 200, body: { error: { code: 1002, name: 'DeviceTimeout', message: 'Device timeout', connected: true } } }).deviceTimeout, true);
        assert.equal(classifyHspReply({ httpOk: false, status: 429, body: null }).rateLimited, true);
        const lost = classifyHspReply({ noReply: true, timedOut: true }, '/hsp/add');
        assert.equal(lost.noReply, true);
        assert.equal(lost.message, 'Request timed out (/hsp/add)');
    });

    it('confirms a stop only from a reply whose play state plays nothing', () => {
        const ok = (s) => classifyHspReply({ httpOk: true, status: 200, body: { result: s } });
        assert.equal(isHspStopConfirmed(ok(state(HSP_PLAY_STATE.STOPPED))), true);
        assert.equal(isHspStopConfirmed(ok(state(HSP_PLAY_STATE.NOT_INITIALIZED))), true);
        assert.equal(isHspStopConfirmed(ok(state(HSP_PLAY_STATE.PLAYING))), false);
        assert.equal(isHspStopConfirmed(ok(state(HSP_PLAY_STATE.PAUSED))), false);
        assert.equal(isHspStopConfirmed(ok('ok')), false, 'a reply without a state proves nothing');
        assert.equal(isHspStopConfirmed(classifyHspReply({ noReply: true })), false);
        assert.equal(isHspFlushConfirmed(ok(state(HSP_PLAY_STATE.PLAYING, { points: 0 }))), true);
        assert.equal(isHspFlushConfirmed(ok(state(HSP_PLAY_STATE.PLAYING, { points: 4 }))), false);
    });
});

describe('the firmware, the slider and the clock', () => {
    it('needs firmware 4, and says why not', () => {
        assert.deepEqual(fwSupportsHsp({ fw_status: 0, fw_version: '4.0.16' }), { ok: true, major: 4, reason: '' });
        const fw3 = fwSupportsHsp({ fw_status: 1, fw_version: '3.2.0' });
        assert.equal(fw3.ok, false);
        assert.match(fw3.reason, /^firmware 3\.2\.0: update The Handy to firmware 4/);
        assert.equal(fwSupportsHsp({ fw_status: 2, fw_version: '4.1.0' }).ok, false);
        assert.equal(fwSupportsHsp({ fw_status: 1, fw_version: '4.1.0' }).ok, true);
        assert.equal(fwSupportsHsp({}).ok, false);
        assert.equal(fwSupportsHsp(null).ok, false);
        assert.equal(capabilitiesAllowHsp({ slider: 1 }), true);
        assert.equal(capabilitiesAllowHsp({ slider: 0 }), false);
        assert.equal(capabilitiesAllowHsp(null), false);
    });

    it('reads travel and top speed from the slider settings, and nothing unbelievable', () => {
        assert.deepEqual(sliderLimits({ x_limit_start: 0, x_limit_stop: 110, x_max_speed: 400 }), { travelMm: 110, maxSpeedMmS: 400 });
        assert.deepEqual(sliderLimits({ x_limit_start: 0, x_limit_stop: 5, x_max_speed: 5000 }), { travelMm: null, maxSpeedMmS: null });
        assert.deepEqual(sliderLimits(null), { travelMm: null, maxSpeedMmS: null });
    });

    it('estimates the server offset from the lowest-RTD half, so outliers do not move it', () => {
        const trueOffset = 5000;
        const samples = [];
        let local = 1000;
        for (let i = 0; i < 30; i += 1) {
            // Mostly 40-60 ms round trips, every fifth one a 900 ms outlier
            // whose answer left the server late.
            const rtd = i % 5 === 0 ? 900 : 40 + (i % 3) * 10;
            const serverStamp = local + trueOffset + (i % 5 === 0 ? 800 : rtd / 2);
            samples.push({ sentAt: local, receivedAt: local + rtd, serverTime: serverStamp });
            local += rtd + 5;
        }
        const est = estimateServerOffset(samples);
        assert.ok(Math.abs(est.offset - trueOffset) <= 1, `offset ${est.offset}`);
        assert.equal(est.used, 15);
        assert.equal(est.rtdP95, 900);
        // The plain mean would be off by tens of ms.
        const mean = samples.reduce((sum, s) => sum + s.serverTime + (s.receivedAt - s.sentAt) / 2 - s.receivedAt, 0) / samples.length;
        assert.ok(Math.abs(mean - trueOffset) > 50);
    });

    it('ignores unusable samples and gives nothing without one', () => {
        assert.equal(estimateServerOffset([]), null);
        assert.equal(estimateServerOffset([{ sentAt: 10, receivedAt: 5, serverTime: 1 }, { sentAt: NaN, receivedAt: 1, serverTime: 1 }]), null);
        assert.equal(estimateServerOffset([{ sentAt: 0, receivedAt: 100, serverTime: 1050 }]).offset, 1000);
    });

    it('leads by the p95 round trip plus 100 ms, 250 ms to 1 s', () => {
        assert.equal(leadFor(50), 250);
        assert.equal(leadFor(300), 400);
        assert.equal(leadFor(5000), 1000);
        assert.equal(leadFor(null), 1000);
    });
});

describe('the rolling window', () => {
    it('clips a plan at the window end, on the line toward the first point past it, never faster', () => {
        const far = [{ t: 5000, x: 0 }, { t: 70050, x: 26 }];
        assert.deepEqual(clipPlan(far, 9000), [{ t: 5000, x: 0 }, { t: 9000, x: 1 }]);
        const down = [{ t: 0, x: 90 }, { t: 1000, x: 90 }, { t: 11000, x: 10 }];
        assert.deepEqual(clipPlan(down, 4000), [{ t: 0, x: 90 }, { t: 1000, x: 90 }, { t: 4000, x: 66 }]);
        // Inside the window: unchanged, as new objects.
        const inside = [{ t: 0, x: 10 }, { t: 250, x: 90 }];
        const same = clipPlan(inside, 4000);
        assert.deepEqual(same, inside);
        assert.notEqual(same[0], inside[0]);
        // A point exactly at the end is kept; nothing before the first point.
        assert.deepEqual(clipPlan([{ t: 100, x: 5 }, { t: 4000, x: 9 }, { t: 5000, x: 50 }], 4000), [{ t: 100, x: 5 }, { t: 4000, x: 9 }]);
        assert.deepEqual(clipPlan([{ t: 5000, x: 50 }], 4000), []);
    });

    const lastPlan = [
        { t: 900, x: 10 },
        { t: 1100, x: 90 },
        { t: 1300, x: 10 },
        { t: 1500, x: 90 },
        { t: 1700, x: 10 },
        { t: 1900, x: 90 }
    ];

    it('re-sends the plan up to the splice exactly as it was sent', () => {
        const fresh = [{ t: 1600, x: 50 }, { t: 1800, x: 40 }];
        const { points, prefix } = planWindow({ lastPlan, from: 1000, splice: 1400, newPoints: fresh });
        // The point before `from` (the segment the device is on), every
        // point up to the splice, the splice point on the old line.
        assert.deepEqual(points.slice(0, prefix), [{ t: 900, x: 10 }, { t: 1100, x: 90 }, { t: 1300, x: 10 }, { t: 1400, x: 50 }]);
        assert.deepEqual(points.slice(prefix), fresh);
        // The same plan replanned again with other new points: the prefix
        // does not change by a byte.
        const again = planWindow({ lastPlan, from: 1000, splice: 1400, newPoints: [{ t: 1450, x: 0 }] });
        assert.equal(JSON.stringify(again.points.slice(0, again.prefix)), JSON.stringify(points.slice(0, prefix)));
        // And the prefix is the old plan's own numbers.
        for (const p of points.slice(0, prefix - 1)) assert.ok(lastPlan.some((q) => q.t === p.t && q.x === p.x));
    });

    it('splices on the old line, so the device never sees a jump', () => {
        const { spliceX } = planWindow({ lastPlan, from: 1000, splice: 1150, newPoints: [] });
        assert.equal(spliceX, 70);
        assert.equal(planPositionAt(lastPlan, 1150), 70);
        assert.equal(planPositionAt(lastPlan, 5000), 90, 'after its last point a plan holds there');
        assert.equal(planPositionAt(lastPlan, 100), null);
        // A splice on an old point keeps that point.
        const exact = planWindow({ lastPlan, from: 1000, splice: 1300, newPoints: [] });
        assert.deepEqual(exact.points[exact.points.length - 1], { t: 1300, x: 10 });
    });

    it('drops new points at or before the splice, and starts clean without a plan', () => {
        const { points, prefix } = planWindow({ lastPlan: null, from: 0, splice: 300, newPoints: [{ t: 300, x: 5 }, { t: 400, x: 6 }] });
        assert.equal(prefix, 0);
        assert.deepEqual(points, [{ t: 400, x: 6 }]);
    });

    it('chunks at most 100 points a request, flush on the first only, the tail index counting on', () => {
        const pts = Array.from({ length: 250 }, (_, i) => ({ t: i * 10, x: i % 101 }));
        const { bodies, tailIndex } = chunkPoints(pts, { flush: true, tailIndex: 40 });
        assert.equal(bodies.length, 3);
        assert.deepEqual(bodies.map((b) => b.points.length), [100, 100, 50]);
        assert.ok(bodies.every((b) => b.points.length <= HSP_MAX_POINTS_PER_ADD));
        assert.deepEqual(bodies.map((b) => b.flush === true), [true, false, false]);
        assert.ok(!('flush' in bodies[1]) && !('flush' in bodies[2]));
        assert.deepEqual(bodies.map((b) => b.tail_point_stream_index), [140, 240, 290]);
        assert.equal(tailIndex, 290);
        assert.deepEqual(bodies.flatMap((b) => b.points), pts);
    });

    it('steps a routine allowance in fives, and calls a cut, a restart or a big drop urgent', () => {
        assert.equal(quantizeAllowance(0), 0);
        assert.equal(quantizeAllowance(3), 5);
        assert.equal(quantizeAllowance(64), 60);
        assert.equal(quantizeAllowance(100), 100);
        assert.equal(quantizeAllowance(NaN), 0);
        assert.equal(isUrgentAllowanceChange(60, 0), true);
        assert.equal(isUrgentAllowanceChange(0, 40), true);
        assert.equal(isUrgentAllowanceChange(80, 65), true);
        assert.equal(isUrgentAllowanceChange(80, 70), false);
        assert.equal(isUrgentAllowanceChange(40, 90), false);
    });
});

describe('the request budget', () => {
    it('keeps routine traffic under 150 a minute, lets urgent ones into a reserve of 30, and never refuses a stop', () => {
        const b = createRequestBudget();
        for (let i = 0; i < 150; i += 1) assert.equal(b.take('routine', 1000 + i), true);
        assert.equal(b.take('routine', 2000), false);
        for (let i = 0; i < 30; i += 1) assert.equal(b.take('urgent', 2000 + i), true);
        assert.equal(b.take('urgent', 3000), false);
        for (let i = 0; i < 20; i += 1) assert.equal(b.take('stop', 3000 + i), true);
        assert.equal(b.used(3100), 200);
        // A minute later the window has slid.
        assert.equal(b.take('routine', 61200), true);
        assert.equal(b.remainingRoutine(61200) > 0, true);
    });

    it('always has room for stops, however busy the minute was', () => {
        const b = createRequestBudget({ routine: 5, reserve: 0 });
        for (let i = 0; i < 5; i += 1) b.take('routine', i);
        assert.equal(b.take('urgent', 10), false);
        assert.equal(b.take('stop', 10), true);
    });
});

describe('events', () => {
    it('reads the live API\'s named events and the spec\'s unnamed ones', () => {
        assert.deepEqual(parseSseMessage('device_status', '{"connection_key":"K","data":{"connected":false}}'), { type: 'device_status', key: 'K', data: { connected: false } });
        assert.deepEqual(parseSseMessage('message', '{"id":"1","type":"mode_changed","data":{"connection_key":"K","data":{"mode":1,"mode_session_id":7}}}'), { type: 'mode_changed', key: 'K', data: { mode: 1, mode_session_id: 7 } });
        assert.equal(parseSseMessage('message', 'not json'), null);
        assert.equal(parseSseMessage('message', '{"x":1}'), null);
    });

    it('pauses for another app, the button, a blocked slider and heat; goes offline on a disconnect', () => {
        assert.equal(classifyHspEvent({ type: 'mode_changed', data: { mode: 0, mode_session_id: 9 } }, { modeSessionId: 8 }).action, 'pause');
        assert.match(classifyHspEvent({ type: 'mode_changed', data: { mode: 0 } }).reason, /Another app took control/);
        assert.equal(classifyHspEvent({ type: 'mode_changed', data: { mode: 4, mode_session_id: 8 } }, { modeSessionId: 8 }).action, 'ignore');
        assert.equal(classifyHspEvent({ type: 'mode_changed', data: { mode: 0 } }, { expectingMode: true }).action, 'ignore', 'a change we made ourselves');
        assert.equal(classifyHspEvent({ type: 'button_event', data: { button: 0, event: 2 } }).action, 'pause');
        assert.equal(classifyHspEvent({ type: 'slider_blocked', data: {} }).action, 'pause');
        assert.equal(classifyHspEvent({ type: 'temp_high', data: {} }).action, 'pause');
        assert.equal(classifyHspEvent({ type: 'device_disconnected', data: {} }).action, 'offline');
        assert.equal(classifyHspEvent({ type: 'device_status', data: { connected: false } }).action, 'offline');
        assert.equal(classifyHspEvent({ type: 'device_status', data: { connected: true } }).action, 'ignore');
        assert.equal(classifyHspEvent({ type: 'stroke_changed', data: {} }).action, 'stroke');
        assert.equal(classifyHspEvent({ type: 'hsp_starving', data: {} }).action, 'starving');
        assert.equal(classifyHspEvent({ type: 'low_memory_warning', data: {} }).action, 'log');
        assert.equal(classifyHspEvent({ type: 'battery_changed', data: {} }).action, 'ignore');
    });
});

describe('words', () => {
    it('bounds an unconfirmed stop by what is left in the buffer', () => {
        assert.equal(describeHspOwedStop(3.2), 'The Handy did not confirm its stop. It runs out of script within 4 s; check the device.');
        assert.equal(describeHspOwedStop(0), 'The Handy did not confirm its stop. It runs out of script now; check the device.');
        assert.match(describeHspOwedStop(null), /within a few seconds/);
    });

    it('names the route and why', () => {
        assert.equal(describeHandyRoute({ route: 'hsp', rtdP95: 80 }), 'Beat sync (HSP), ±40 ms');
        assert.match(describeHandyRoute({ route: 'hamp', reason: 'firmware 3' }), /^Rhythm only \(HAMP\): firmware 3\. The Handy follows the script's tempo and depth, not each stroke\.$/);
    });
});

describe('the crash stop of a Handy driven over HSP', () => {
    const v = (body) => classifyHspReply({ httpOk: true, status: 200, body });
    it('is settled by a confirmed HSP stop, or by HAMP saying it stopped', () => {
        assert.equal(classifyHspRecoveryStop({ hsp: v({ result: state(2) }), hamp: { outcome: 'not-hamp', detail: '' } }).outcome, 'stopped');
        assert.equal(classifyHspRecoveryStop({ hsp: v({ error: { code: 9, message: 'x', connected: true } }), hamp: { outcome: 'already-stopped', detail: 'result 1' } }).outcome, 'already-stopped');
    });

    it('is not settled by "not in HAMP mode" alone: that device was in HSP mode', () => {
        const r = classifyHspRecoveryStop({ hsp: classifyHspReply({ noReply: true }), hamp: { outcome: 'not-hamp', detail: 'error 2002' } });
        assert.equal(r.outcome, 'failed');
        assert.match(r.detail, /error 2002/);
    });

    it('says offline when the API says the device is not connected', () => {
        const r = classifyHspRecoveryStop({ hsp: v({ error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } }), hamp: { outcome: 'offline', detail: '' } });
        assert.equal(r.outcome, 'offline');
    });
});

describe('which way a dispatch reaches The Handy', () => {
    it('is what it always was outside Script mode, and on the secondary channel', () => {
        assert.equal(handyScriptRoute({ scriptDrives: false, role: 'primary' }), 'level');
        assert.equal(handyScriptRoute({ scriptDrives: true, role: 'secondary' }), 'level');
        assert.equal(handyScriptRoute({ scriptDrives: true, role: 'off' }), 'level');
    });

    it('plays the rhythm on a HAMP Handy, and beat sync once it owns the device', () => {
        assert.equal(handyScriptRoute({ scriptDrives: true, role: 'primary' }), 'rhythm');
        assert.equal(handyScriptRoute({ scriptDrives: true, hspOwns: true, role: 'primary' }), 'hsp');
        assert.equal(handyScriptRoute({ scriptDrives: true, hspOwns: true, role: 'secondary' }), 'hsp', 'the HSP driver gets 0 and holds');
    });

    it('never lets the v2 driver near a device beat sync still owns or is handing back', () => {
        assert.equal(handyScriptRoute({ scriptDrives: false, hspOwns: true }), 'release');
        assert.equal(handyScriptRoute({ scriptDrives: true, releasing: true }), 'release');
        assert.equal(handyScriptRoute({ scriptDrives: false, releasing: true }), 'release');
    });

    it('refuses a start in words that name the way to rhythm mode', () => {
        assert.equal(describeHspStartRefusal({ reason: 'firmware 3.2.0: update The Handy' }), 'The session was not started: beat sync on The Handy could not start (firmware 3.2.0: update The Handy). Switch Beat sync off to play the script in rhythm mode, or press START again.');
        assert.match(describeHspStartRefusal(null, true), /^The session was not resumed: .*press RESUME again\.$/);
    });

    it('tells beat sync that is not possible (firmware, slider, Application ID) from a check that may pass next time', () => {
        for (const code of ['firmware', 'capabilities', 'auth']) assert.equal(hspNotPossible(code), true, code);
        for (const code of ['network', 'offline', 'sync', 'slow', 'mode', 'setup', 'buffer', 'stroke', 'consent', 'no-key', 'stale', '', undefined]) assert.equal(hspNotPossible(code), false, String(code));
        assert.equal(
            describeHspStartRefusal({ code: 'firmware', reason: 'firmware 3.2.3: update The Handy to firmware 4 at handyverse.com to get beat sync' }),
            'The session was not started: The Handy cannot beat sync (firmware 3.2.3: update The Handy to firmware 4 at handyverse.com to get beat sync). It plays the script in rhythm mode: press START again.'
        );
        assert.match(describeHspStartRefusal({ code: 'network', reason: 'x' }), /Switch Beat sync off to play the script in rhythm mode, or press START again\.$/);
        assert.equal(describeBeatSyncCheckFailed('the Handy API could not be asked (HTTP 502)'), 'Beat sync could not be checked (the Handy API could not be asked (HTTP 502)). START checks again and does not start without it; switch Beat sync off to play the script in rhythm mode.');
        assert.match(describeBeatSyncCheckFailed(), /^Beat sync could not be checked \(it could not be checked\)\./);
    });
});
