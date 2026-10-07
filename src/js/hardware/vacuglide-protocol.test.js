import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    VACUGLIDE_DISCOVERY_BASE,
    VACUGLIDE_PATHS,
    VACUGLIDE_VALVES,
    DEVICE_NOT_CONNECTED,
    MAX_DEVICE_TOKEN_LENGTH,
    VACUGLIDE_TOKEN_STORAGE_KEY,
    sanitizeDeviceToken,
    normalizeCluster,
    parseConnectedReply,
    classifyVacuglideResponse,
    parseVacuglideState,
    isPlayingMode,
    motorRunningIn,
    describeUnusableMode,
    stopConfirmedBy,
    valveClosedBy,
    valvesOpenIn,
    clampTargetSpeed,
    VACUGLIDE_ROLES,
    VACUGLIDE_DEFAULT_ROLE,
    sanitizeVacuglideRole,
    SPEED_CAP_MIN,
    SPEED_CAP_STEP,
    clampSpeedCap,
    VACUGLIDE_MIN_SPEED,
    vacuglideSpeedFor,
    VALVE_PULSE_DEFAULT_MS,
    VALVE_PULSE_MIN_MS,
    VALVE_PULSE_MAX_MS,
    clampValvePulseMs,
    pulseSecondsToMs,
    formatPulseSeconds,
    RATE_WINDOW_MS,
    RATE_CEILING,
    RATE_RESERVE,
    RATE_WATCH_RESERVE,
    MAX_VALVE_OPENS_PER_WINDOW,
    RATE_LOG_STORAGE_PREFIX,
    createRateBudget,
    rateLogStorageKey,
    decodeRateLog,
    encodeRateLog,
    describeRateWait,
    describeVacuglideInfo,
    foreignDeviceType,
    describeForeignDevice,
    VACUGLIDE_HANDOVER_STORAGE_KEY,
    decodeHandover,
    encodeHandover,
    mergeHandoverByDevice,
    describeAgo
} from './vacuglide-protocol.js';
import { sanitizeConnectionKey } from '../backup.js';
import { sanitizeSetting } from '../settings-schema.js';
import { SETTING_DEFAULTS } from '../state.js';

describe('the documented surface', () => {
    it('matches the VacuGlide reference: discovery on the latency router, commands on the cluster', () => {
        assert.equal(VACUGLIDE_DISCOVERY_BASE, 'https://latency.autoblowapi.com');
        assert.equal(VACUGLIDE_PATHS.connected, '/vacuglide/connected');
        assert.equal(VACUGLIDE_PATHS.info, '/vacuglide/info');
        assert.equal(VACUGLIDE_PATHS.state, '/vacuglide/state');
        assert.equal(VACUGLIDE_PATHS.targetSpeed, '/vacuglide/target-speed');
        assert.equal(VACUGLIDE_PATHS.stop, '/vacuglide/target-speed/stop');
        assert.equal(VACUGLIDE_VALVES.plus, '/vacuglide/valve/stroke-plus');
        assert.equal(VACUGLIDE_VALVES.minus, '/vacuglide/valve/stroke-minus');
    });

    it('never names the event stream, which takes the token in its URL', () => {
        // GET /events/stream?deviceToken=... puts the credential into a URL -
        // browser history, proxy logs, Referer. Nothing here may build one.
        const src = readFileSync(new URL('./vacuglide-protocol.js', import.meta.url), 'utf8')
            + readFileSync(new URL('./vacuglide.js', import.meta.url), 'utf8');
        assert.ok(!/events\/stream|deviceToken=|EventSource/.test(src));
    });
});

describe('the device token is held to the connection-key rule', () => {
    it('accepts a plain token and trims it', () => {
        assert.equal(sanitizeDeviceToken('  jya6vksq08q3 '), 'jya6vksq08q3');
        assert.equal(sanitizeDeviceToken('MixedCase-Token_1'), 'MixedCase-Token_1', 'the documented examples are not a documented format');
    });

    it('refuses what cannot travel as an HTTP header', () => {
        for (const bad of ['', '   ', 'has space', 'line\nbreak', 'tab\tbed', 'café', 'x'.repeat(MAX_DEVICE_TOKEN_LENGTH + 1), null, undefined, 42, {}, []]) {
            assert.equal(sanitizeDeviceToken(bad), null, JSON.stringify(bad));
        }
        assert.equal(sanitizeDeviceToken('x'.repeat(MAX_DEVICE_TOKEN_LENGTH)), 'x'.repeat(MAX_DEVICE_TOKEN_LENGTH));
    });

    it('agrees with the Handy key sanitizer on every input, so "the same way" stays true', () => {
        const inputs = ['abc', ' abc ', '', ' ', 'a b', 'a\nb', 'ÿ', 'x'.repeat(128), 'x'.repeat(129), '!~', null, undefined, 7, true, {}, []];
        for (const value of inputs) {
            assert.equal(sanitizeDeviceToken(value), sanitizeConnectionKey(value), JSON.stringify(value));
        }
    });

    it('has its own storage entry, outside the settings blob', () => {
        assert.equal(VACUGLIDE_TOKEN_STORAGE_KEY, 'vacuglide_device_token');
        assert.ok(!Object.keys(SETTING_DEFAULTS).some((name) => /token/i.test(name)), 'no setting may hold a credential');
    });
});

describe('the cluster the token is sent to', () => {
    it('accepts the bare host the reference shows and the URL older replies carried', () => {
        assert.equal(normalizeCluster('eu-central-1.autoblowapi.com'), 'https://eu-central-1.autoblowapi.com');
        assert.equal(normalizeCluster('https://us-east-1.autoblowapi.com'), 'https://us-east-1.autoblowapi.com');
        assert.equal(normalizeCluster('https://us-east-1.autoblowapi.com/'), 'https://us-east-1.autoblowapi.com');
        assert.equal(normalizeCluster(' AP-SOUTHEAST-2.AUTOBLOWAPI.COM '), 'https://ap-southeast-2.autoblowapi.com');
    });

    it('refuses anything that would send the token somewhere else', () => {
        const hostile = [
            'evil.example',
            'https://evil.example',
            'autoblowapi.com.evil.example',
            'https://eu-central-1.autoblowapi.com.evil.example',
            'http://eu-central-1.autoblowapi.com',
            'https://user:pw@eu-central-1.autoblowapi.com',
            'https://eu-central-1.autoblowapi.com:8443',
            'https://eu-central-1.autoblowapi.com/steal',
            'https://eu-central-1.autoblowapi.com/?x=1',
            'https://evil.example#.autoblowapi.com',
            'a.b.autoblowapi.com',
            'autoblowapi.com',
            'javascript:alert(1)',
            '',
            null,
            42
        ];
        for (const raw of hostile) assert.equal(normalizeCluster(raw), null, String(raw));
    });

    it('refuses the latency router as a cluster: it forwards to whichever cluster is nearest the browser', () => {
        assert.equal(normalizeCluster('latency.autoblowapi.com'), null);
        assert.equal(normalizeCluster(VACUGLIDE_DISCOVERY_BASE), null);
    });

    it('reads a discovery reply, and flags a cluster it will not use', () => {
        assert.deepEqual(parseConnectedReply({ connected: true, cluster: 'eu-central-1.autoblowapi.com', deviceType: 'vacuglide' }),
            { connected: true, cluster: 'https://eu-central-1.autoblowapi.com', deviceType: 'vacuglide', badCluster: false });
        assert.deepEqual(parseConnectedReply({ connected: false }), { connected: false, cluster: null, deviceType: null, badCluster: false });
        assert.equal(parseConnectedReply({ connected: true, cluster: 'evil.example' }).badCluster, true);
        assert.equal(parseConnectedReply({ connected: 'true', cluster: 'eu-central-1.autoblowapi.com' }).connected, false, 'only a real true counts');
        assert.equal(parseConnectedReply(null).connected, false);
    });
});

describe('classifying a reply', () => {
    it('passes a 2xx with a state through', () => {
        const v = classifyVacuglideResponse(true, 200, { operationalMode: 'TARGET_SPEED_PLAYING' }, '/vacuglide/target-speed');
        assert.equal(v.ok, true);
    });

    it('names the device that is not online - the live API answers exactly this, with 502', () => {
        const body = { error: { code: DEVICE_NOT_CONNECTED, message: 'Device not connected' } };
        const v = classifyVacuglideResponse(false, 502, body, '/vacuglide/target-speed');
        assert.equal(v.ok, false);
        assert.equal(v.notConnected, true);
        assert.equal(v.ambiguous, false, 'the device never received it');
        assert.equal(v.message, 'Device not connected (/vacuglide/target-speed)');
    });

    it('treats a 502 without that code as a cloud failure the command may have survived', () => {
        const v = classifyVacuglideResponse(false, 502, null, '/p');
        assert.equal(v.notConnected, false);
        assert.equal(v.ambiguous, true);
        assert.equal(v.message, 'HTTP 502 (/p)');
    });

    it('reads a validation refusal as refused before any device lookup', () => {
        const body = { error: { code: 'FST_ERR_VALIDATION', message: 'body/targetSpeed must be <= 100' } };
        const v = classifyVacuglideResponse(false, 400, body, '/vacuglide/target-speed');
        assert.equal(v.ok, false);
        assert.equal(v.ambiguous, false);
        assert.equal(v.code, 'FST_ERR_VALIDATION');
        assert.match(v.message, /must be <= 100/);
    });

    it('reads 429 as the rate limit, with or without a body', () => {
        assert.equal(classifyVacuglideResponse(false, 429, null).rateLimited, true);
        assert.equal(classifyVacuglideResponse(false, 429, null).ambiguous, false);
        assert.match(classifyVacuglideResponse(false, 429, null).message, /Too many requests/);
        assert.equal(classifyVacuglideResponse(false, 429, { error: { message: 'slow down' } }).rateLimited, true);
    });

    it('reads the 429 the live API sends: the 161st request of a minute, a STOP among them', () => {
        // Captured from a cluster with a made-up token: 160 requests went
        // through, the next GET and the next PUT /target-speed/stop were both
        // refused with exactly this body (and access-control-allow-origin: *,
        // so a page sees it; its retry-after header it cannot read).
        const body = { error: { code: 'Error', message: 'Rate limit exceeded, retry in 52 seconds' } };
        const v = classifyVacuglideResponse(false, 429, body, '/vacuglide/target-speed/stop');
        assert.equal(v.rateLimited, true);
        assert.equal(v.notConnected, false);
        assert.equal(v.ambiguous, false, 'refused before it reached the device');
        assert.equal(v.message, 'Rate limit exceeded, retry in 52 seconds (/vacuglide/target-speed/stop)');
    });

    it('refuses an error object even on HTTP 200', () => {
        const v = classifyVacuglideResponse(true, 200, { error: 'broken' }, '/p');
        assert.equal(v.ok, false);
        assert.equal(v.message, 'broken (/p)');
    });
});

describe('the device state every command answers with', () => {
    it('keeps the fields the driver reads and nulls a field of the wrong type', () => {
        assert.deepEqual(parseVacuglideState({ operationalMode: 'TARGET_SPEED_PAUSED', targetSpeed: 40, strokePlusValve: false, strokeMinusValve: true, localScript: 3 }),
            { operationalMode: 'TARGET_SPEED_PAUSED', targetSpeed: 40, strokePlusValve: false, strokeMinusValve: true });
        assert.deepEqual(parseVacuglideState({ operationalMode: 5, targetSpeed: '40', strokePlusValve: 'false' }),
            { operationalMode: null, targetSpeed: null, strokePlusValve: null, strokeMinusValve: null });
        assert.equal(parseVacuglideState(null), null);
        assert.equal(parseVacuglideState([1]), null);
    });

    it('a stop is confirmed by any mode that is not playing, and by a reply that says nothing', () => {
        for (const mode of ['TARGET_SPEED_PLAYING', 'LOCAL_SCRIPT_PLAYING', 'SYNC_SCRIPT_PLAYING']) {
            assert.equal(isPlayingMode(mode), true);
            assert.equal(stopConfirmedBy({ operationalMode: mode }), false, mode);
        }
        for (const mode of ['TARGET_SPEED_PAUSED', 'ONLINE_CONNECTED', 'ERROR_MOTOR_STUCK', 'LOCAL_SCRIPT_PAUSED']) {
            assert.equal(stopConfirmedBy({ operationalMode: mode }), true, mode);
        }
        assert.equal(stopConfirmedBy(null), true);
        assert.equal(stopConfirmedBy({ operationalMode: null }), true);
    });

    it('a close is confirmed unless the reply still reports that valve open', () => {
        assert.equal(valveClosedBy({ strokePlusValve: true, strokeMinusValve: false }, 'plus'), false);
        assert.equal(valveClosedBy({ strokePlusValve: true, strokeMinusValve: false }, 'minus'), true, 'the other valve is not this one');
        assert.equal(valveClosedBy({ strokePlusValve: false, strokeMinusValve: true }, 'minus'), false);
        assert.equal(valveClosedBy({ strokePlusValve: null, strokeMinusValve: null }, 'plus'), true);
        assert.equal(valveClosedBy(null, 'minus'), true);
    });

    it('names the valves a state reports open, and only a plain true counts as open', () => {
        assert.deepEqual(valvesOpenIn({ strokePlusValve: true, strokeMinusValve: false }), ['plus']);
        assert.deepEqual(valvesOpenIn({ strokePlusValve: false, strokeMinusValve: true }), ['minus']);
        assert.deepEqual(valvesOpenIn({ strokePlusValve: true, strokeMinusValve: true }), ['plus', 'minus']);
        assert.deepEqual(valvesOpenIn({ strokePlusValve: false, strokeMinusValve: false }), []);
        // Unreadable is not open: a device that leaves the field out must
        // not be sent a close on every reply.
        assert.deepEqual(valvesOpenIn(parseVacuglideState({ strokePlusValve: 'true', strokeMinusValve: 1 })), []);
        assert.deepEqual(valvesOpenIn({ strokePlusValve: null, strokeMinusValve: null }), []);
        assert.deepEqual(valvesOpenIn(null), []);
    });

    it('reads the motor as running only in target-speed play, at a speed above 0 or one the reply left out', () => {
        const running = (body) => motorRunningIn(parseVacuglideState(body));
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PLAYING', targetSpeed: 40 }), true);
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PLAYING', targetSpeed: 1 }), true);
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PLAYING', targetSpeed: 0 }), false, 'a target of 0 asks nothing of the motor');
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PLAYING' }), true, 'a speed the reply left out is not taken as 0');
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PLAYING', targetSpeed: 'fast' }), true, 'nor one that is not a number');
        assert.equal(running({ operationalMode: 'TARGET_SPEED_PAUSED', targetSpeed: 55 }), false, 'a stopped device keeps its last target speed');
        assert.equal(running({ operationalMode: 'ONLINE_CONNECTED', targetSpeed: 55 }), false);
        assert.equal(running({ operationalMode: 'LOCAL_SCRIPT_PLAYING', targetSpeed: 55 }), false, 'EdgeLoop never starts a script');
        assert.equal(motorRunningIn(null), false);
    });

    it('names every mode the device cannot be driven in, and only those', () => {
        for (const mode of ['ERROR', 'ERROR_MOTOR_STUCK', 'ERROR_MOTOR_OVERRUN', 'FIRMWARE_UPDATING', 'SETUP', 'LOADING_SETUP', 'LOADING_INTERACTIVE']) {
            assert.match(describeUnusableMode(mode) || '', /^The VacuGlide /, mode);
        }
        for (const mode of ['ONLINE_CONNECTED', 'TARGET_SPEED_PLAYING', 'TARGET_SPEED_PAUSED', 'LOCAL_SCRIPT_PLAYING', 'SYNC_SCRIPT_PAUSED', 'SOMETHING_NEW', null]) {
            assert.equal(describeUnusableMode(mode), null, String(mode));
        }
        assert.match(describeUnusableMode('ERROR_MOTOR_OVERRUN'), /4 hours/);
    });
});

describe('speed only, for the channel the device holds', () => {
    it('clamps a target speed to a whole 0-100', () => {
        assert.equal(clampTargetSpeed(55.4), 55);
        assert.equal(clampTargetSpeed(-3), 0);
        assert.equal(clampTargetSpeed(140), 100);
        assert.equal(clampTargetSpeed('37'), 37);
        for (const junk of [NaN, 'fast', null, undefined, '', true, {}]) assert.equal(clampTargetSpeed(junk), 0);
    });

    it('follows the primary, the secondary, or nothing', () => {
        assert.equal(vacuglideSpeedFor('primary', 80, 20, 100), 80);
        assert.equal(vacuglideSpeedFor('secondary', 80, 20, 100), 20);
        assert.equal(vacuglideSpeedFor('off', 80, 20, 100), 0);
    });

    it('applies the cap to whichever channel it follows', () => {
        assert.equal(vacuglideSpeedFor('primary', 80, 20, 50), 40);
        assert.equal(vacuglideSpeedFor('secondary', 90, 90, 55), 50);
        assert.equal(vacuglideSpeedFor('primary', 100, 0, 10), 10);
    });

    it('can never exceed 100 or go negative, whatever it is handed', () => {
        assert.equal(vacuglideSpeedFor('primary', 250, 0, 100), 100);
        assert.equal(vacuglideSpeedFor('primary', -40, 0, 100), 0);
        assert.equal(vacuglideSpeedFor('primary', NaN, 0, 100), 0);
        assert.equal(vacuglideSpeedFor('primary', 100, 0, 'fast'), SPEED_CAP_MIN, 'an unreadable cap is the floor, not 100');
    });

    // The driver answers 0 with the whole stop and the next moving tick with
    // a target speed, so this is where a speed the engine wants moving must
    // not be rounded into a stop by the wearer's cap.
    it('sends a slow speed under a low cap as the slowest crawl, never as a stop', () => {
        assert.equal(VACUGLIDE_MIN_SPEED, 1);
        // The cases that used to leave as 0, and so as the whole stop.
        assert.equal(vacuglideSpeedFor('primary', 1, 1, 40), VACUGLIDE_MIN_SPEED);
        assert.equal(vacuglideSpeedFor('primary', 4, 0, 10), VACUGLIDE_MIN_SPEED);
        assert.equal(vacuglideSpeedFor('secondary', 0, 2, 20), VACUGLIDE_MIN_SPEED);
        assert.equal(vacuglideSpeedFor('primary', 0.3, 0, 100), VACUGLIDE_MIN_SPEED, 'a fraction the engine did not round is still moving');
        for (let cap = SPEED_CAP_MIN; cap <= 100; cap += SPEED_CAP_STEP) {
            for (let speed = 1; speed <= 100; speed += 1) {
                const primary = vacuglideSpeedFor('primary', speed, 0, cap);
                const secondary = vacuglideSpeedFor('secondary', 0, speed, cap);
                assert.ok(primary >= VACUGLIDE_MIN_SPEED && secondary >= VACUGLIDE_MIN_SPEED, `${speed}% at cap ${cap}% stopped the VacuGlide`);
                // The floor never lifts the device past the cap the wearer set.
                assert.ok(primary <= cap && secondary <= cap, `${speed}% at cap ${cap}% went past the cap`);
                // Wherever the plain arithmetic already gave a moving speed,
                // the answer is that number.
                const before = Math.round(speed * (cap / 100));
                if (before >= 1) assert.equal(primary, before, `${speed}% at cap ${cap}%`);
            }
        }
    });

    it('is 0 only for a stop, the role Off, or a speed that is not a number', () => {
        assert.equal(vacuglideSpeedFor('primary', 0, 50, 100), 0);
        assert.equal(vacuglideSpeedFor('secondary', 50, 0, 10), 0);
        assert.equal(vacuglideSpeedFor('off', 50, 50, 100), 0);
        assert.equal(vacuglideSpeedFor('primary', -5, 50, 100), 0);
        // Doubt ends in a stop.
        for (const junk of [NaN, Infinity, -Infinity, 'fast', undefined, null, '']) {
            assert.equal(vacuglideSpeedFor('primary', junk, 50, 100), 0, String(junk));
        }
    });

    it('a role nobody can pick drives nothing', () => {
        assert.deepEqual([...VACUGLIDE_ROLES], ['primary', 'secondary', 'off']);
        assert.equal(VACUGLIDE_DEFAULT_ROLE, 'primary');
        for (const junk of ['boss', '', null, undefined, 1, 'PRIMARY']) {
            assert.equal(sanitizeVacuglideRole(junk), 'off', String(junk));
            assert.equal(vacuglideSpeedFor(junk, 90, 90, 100), 0, String(junk));
        }
    });

    it('snaps a cap down onto the slider grid, and never invents the permissive one', () => {
        assert.equal(clampSpeedCap(100), 100);
        assert.equal(clampSpeedCap(37), 35);
        assert.equal(clampSpeedCap(3), 10);
        assert.equal(clampSpeedCap(900), 100);
        for (const junk of ['fast', null, undefined, '', true, NaN, {}]) assert.equal(clampSpeedCap(junk), SPEED_CAP_MIN, String(junk));
    });
});

describe('the valve pulse', () => {
    it('defaults to the owners\' one second and stays inside 0.3-2.0 s', () => {
        assert.equal(VALVE_PULSE_DEFAULT_MS, 1000);
        assert.equal(VALVE_PULSE_MIN_MS, 300);
        assert.equal(VALVE_PULSE_MAX_MS, 2000);
        assert.equal(clampValvePulseMs(1000), 1000);
        assert.equal(clampValvePulseMs(100), 300);
        assert.equal(clampValvePulseMs(60000), 2000, 'one press can never become a long open');
        assert.equal(clampValvePulseMs(1234), 1200);
        for (const junk of ['long', null, undefined, '', true, NaN, Infinity]) assert.equal(clampValvePulseMs(junk), VALVE_PULSE_DEFAULT_MS, String(junk));
    });

    it('converts the seconds the panel shows', () => {
        assert.equal(pulseSecondsToMs('1.5'), 1500);
        assert.equal(pulseSecondsToMs(0.3), 300);
        assert.equal(pulseSecondsToMs('9'), 2000);
        assert.equal(pulseSecondsToMs('abc'), VALVE_PULSE_DEFAULT_MS);
        assert.equal(pulseSecondsToMs(''), VALVE_PULSE_DEFAULT_MS);
        assert.equal(formatPulseSeconds(1000), '1.0');
        assert.equal(formatPulseSeconds(1500), '1.5');
        assert.equal(formatPulseSeconds(99999), '2.0');
    });
});

describe('the request budget', () => {
    it('keeps a reserve that only a stop or a valve close may spend', () => {
        const budget = createRateBudget({ windowMs: 60000, ceiling: 10, reserve: 3, watchReserve: 0, maxOpens: 5 });
        for (let i = 0; i < 7; i += 1) {
            assert.equal(budget.waitMs('normal', 1000), 0, `normal request ${i + 1}`);
            budget.record('normal', 1000);
        }
        assert.ok(budget.waitMs('normal', 1000) > 0, 'routine traffic stops at ceiling minus reserve');
        assert.ok(budget.waitMs('watch', 1000) > 0, 'and so does a watch read');
        for (let i = 0; i < 3; i += 1) {
            assert.equal(budget.waitMs('critical', 1000), 0, `stop ${i + 1} still goes`);
            budget.record('critical', 1000);
        }
        assert.ok(budget.waitMs('critical', 1000) > 0, 'nothing goes past the ceiling');
    });

    // A read the watch makes is a safety read: routine traffic, however
    // busy, leaves it a share of its own - and that share ends where the
    // reserve kept for a stop begins.
    it('keeps the watch a share routine traffic cannot spend, below the reserve kept for a stop', () => {
        const budget = createRateBudget({ windowMs: 60000, ceiling: 12, reserve: 3, watchReserve: 4, maxOpens: 5 });
        for (let i = 0; i < 5; i += 1) {
            assert.equal(budget.waitMs('normal', 1000), 0, `routine request ${i + 1}`);
            budget.record(i === 0 ? 'open' : 'normal', 1000);
        }
        assert.ok(budget.waitMs('normal', 1000) > 0, 'routine traffic stops short of the watch\'s share');
        assert.ok(budget.waitMs('open', 1000) > 0);
        for (let i = 0; i < 4; i += 1) {
            assert.equal(budget.waitMs('watch', 1000), 0, `watch read ${i + 1}`);
            budget.record('watch', 1000);
        }
        assert.ok(budget.waitMs('watch', 1000) > 0, 'a watch read never takes a slot kept for a stop');
        assert.ok(budget.waitMs('normal', 1000) > 0);
        for (let i = 0; i < 3; i += 1) {
            assert.equal(budget.waitMs('critical', 1000), 0, `stop ${i + 1} still goes`);
            budget.record('critical', 1000);
        }
        assert.ok(budget.waitMs('critical', 1000) > 0);
        // Neither watch reads nor stops and valve closes count against
        // routine traffic's share: a watch that reads while a session runs,
        // or the closes of the wearer's presses, hold none of its speeds
        // back. The line all routine traffic stops at still counts them.
        const session = createRateBudget({ windowMs: 60000, ceiling: 14, reserve: 3, watchReserve: 4, maxOpens: 5 });
        for (let i = 0; i < 4; i += 1) session.record('watch', 1000);
        for (let i = 0; i < 2; i += 1) session.record('critical', 1000);
        for (let i = 0; i < 5; i += 1) {
            assert.equal(session.waitMs('normal', 1000), 0, `speed ${i + 1} beside the watch and two closes`);
            session.record('normal', 1000);
        }
        assert.ok(session.waitMs('normal', 1000) > 0, 'the routine share is spent');
        // Three presses' closes leave the routine share whole: all 13 of it.
        const presses = createRateBudget({ windowMs: 60000, ceiling: 20, reserve: 3, watchReserve: 4, maxOpens: 5 });
        for (let i = 0; i < 3; i += 1) presses.record('critical', 1000);
        for (let i = 0; i < 13; i += 1) {
            assert.equal(presses.waitMs('normal', 1000), 0, `speed ${i + 1} beside three closes`);
            presses.record('normal', 1000);
        }
        assert.ok(presses.waitMs('normal', 1000) > 0);
        const closes = createRateBudget({ windowMs: 60000, ceiling: 14, reserve: 3, watchReserve: 0, maxOpens: 5 });
        for (let i = 0; i < 8; i += 1) closes.record('critical', 1000);
        for (let i = 0; i < 3; i += 1) closes.record('normal', 1000);
        assert.ok(closes.waitMs('normal', 1000) > 0, 'closes still count against the line routine traffic stops at');
        assert.equal(closes.waitMs('critical', 1000), 0);
        // And a watch read stays one across a reload; a page that cannot tell
        // counts it as routine traffic, which only holds more back.
        const text = encodeRateLog({ own: [{ t: 1000, open: false, watch: true }, { t: 1001, open: false, critical: true }], page: 'me', now: 1001, windowMs: 60000 });
        assert.deepEqual(JSON.parse(text).e, [[1000, 'me', 2], [1001, 'me', 3]]);
        assert.deepEqual(decodeRateLog(text, { now: 1001, windowMs: 60000 }).entries, [
            { t: 1000, page: 'me', open: false, watch: true, critical: false },
            { t: 1001, page: 'me', open: false, watch: false, critical: true }
        ]);
    });

    it('says how long until the oldest request leaves the window', () => {
        const budget = createRateBudget({ windowMs: 60000, ceiling: 3, reserve: 1, watchReserve: 0, maxOpens: 5 });
        budget.record('normal', 1000);
        budget.record('normal', 5000);
        assert.equal(budget.waitMs('normal', 6000), 55000, 'the 1000 ms entry leaves at 61000');
        assert.equal(budget.waitMs('normal', 61000), 0);
        assert.equal(budget.count(61000), 1);
    });

    it('never lets any window of the server hold more than the ceiling', () => {
        // Whatever the server's fixed-window boundaries are, a sliding count
        // bounded at the ceiling bounds every one of them.
        const ceiling = 12;
        const budget = createRateBudget({ windowMs: 60000, ceiling, reserve: 4, watchReserve: 0, maxOpens: 100 });
        const sent = [];
        for (let t = 0; t < 300000; t += 250) {
            const kind = t % 1000 === 0 ? 'critical' : 'normal';
            if (budget.waitMs(kind, t) === 0) {
                budget.record(kind, t);
                sent.push(t);
            }
        }
        for (let start = -60000; start < 300000; start += 250) {
            const inWindow = sent.filter((t) => t >= start && t < start + 60000).length;
            assert.ok(inWindow <= ceiling, `window at ${start} held ${inWindow}`);
        }
        assert.ok(sent.length > ceiling, 'and it does let traffic through');
    });

    it('caps valve opens on their own, so presses cannot eat the speed budget', () => {
        const budget = createRateBudget({ windowMs: 60000, ceiling: 100, reserve: 10, maxOpens: 2 });
        budget.record('open', 0);
        budget.record('open', 10);
        assert.ok(budget.waitMs('open', 20) > 0);
        assert.equal(budget.waitMs('normal', 20), 0, 'the speed is not held back by the valve cap');
    });

    it('holds routine traffic after the server itself said 429, but never a stop', () => {
        const budget = createRateBudget();
        budget.noteServerRefusal(1000, 10000);
        assert.equal(budget.waitMs('normal', 2000), 9000);
        assert.equal(budget.waitMs('open', 2000), 9000);
        assert.equal(budget.waitMs('critical', 2000), 0);
        assert.equal(budget.waitMs('normal', 11000), 0);
    });

    it('sits below the measured 160 a minute, over a window that allows for delivery time', () => {
        assert.ok(RATE_CEILING < 160);
        assert.ok(RATE_WINDOW_MS > 60000);
        assert.ok(RATE_RESERVE >= 12, 'at least one full stop with every retry: 3 requests x 4 attempts');
        // A session sends one speed a second at most, with room to spare:
        // every valve open the cap allows and its close fit under the line
        // all routine traffic stops at, and the routine share - which counts
        // neither the closes nor the watch's reads - holds the speeds, the
        // opens and the link checks.
        const perWindow = Math.ceil(RATE_WINDOW_MS / 1000);
        assert.ok(perWindow + MAX_VALVE_OPENS_PER_WINDOW * 2 + 10 <= RATE_CEILING - RATE_RESERVE);
        assert.ok(perWindow + MAX_VALVE_OPENS_PER_WINDOW + 10 <= RATE_CEILING - RATE_RESERVE - RATE_WATCH_RESERVE);
        // The watch reads once per 2 s beat for a whole window, and once more
        // through the link a device was connected again through.
        assert.ok(RATE_WATCH_RESERVE >= Math.ceil(RATE_WINDOW_MS / 2000) + 1);
    });

    // A whole stop is three requests: the motor stop and both valve closes.
    it('keeps 6 whole stops for a window routine traffic and the watch have filled, and holds the request after them', () => {
        const budget = createRateBudget();
        for (let i = 0; i < RATE_CEILING - RATE_RESERVE - RATE_WATCH_RESERVE; i += 1) {
            assert.equal(budget.waitMs('normal', 1000), 0, `routine request ${i + 1}`);
            budget.record('normal', 1000);
        }
        assert.ok(budget.waitMs('normal', 1000) > 0, 'routine traffic has used its share');
        for (let i = 0; i < RATE_WATCH_RESERVE; i += 1) {
            assert.equal(budget.waitMs('watch', 1000), 0, `watch read ${i + 1}`);
            budget.record('watch', 1000);
        }
        assert.ok(budget.waitMs('watch', 1000) > 0, 'the watch has used its share');
        for (let stop = 0; stop < 6; stop += 1) {
            for (let part = 0; part < 3; part += 1) {
                assert.equal(budget.waitMs('critical', 1000), 0, `whole stop ${stop + 1}, request ${part + 1}`);
                budget.record('critical', 1000);
            }
        }
        budget.record('critical', 1000);
        budget.record('critical', 1000);
        assert.equal(budget.waitMs('critical', 1000), RATE_WINDOW_MS, 'a seventh does not fit whole: its last request waits for the window');
    });

    it('explains a held-back request in whole seconds', () => {
        assert.match(describeRateWait(12001), /Try again in 13 s\./);
        assert.match(describeRateWait(0), /Try again in 1 s\./);
    });
});

describe('the request log outlives the page', () => {
    // localStorage as the driver uses it: one string, shared by every page.
    const memoryStore = () => {
        let text = null;
        return { load: () => text, save: (value) => { text = value; }, peek: () => text };
    };
    const limits = { windowMs: 60000, ceiling: 10, reserve: 3, watchReserve: 0, maxOpens: 5 };

    it('a reloaded page counts what the page before it sent, and so does that page', () => {
        const store = memoryStore();
        const first = createRateBudget({ ...limits, store, page: 'first' });
        for (let i = 0; i < 7; i += 1) first.record('normal', 1000 + i);
        const reloaded = createRateBudget({ ...limits, store, page: 'reloaded' });
        assert.equal(reloaded.count(2000), 7);
        assert.ok(reloaded.waitMs('normal', 2000) > 0, 'routine traffic waits: the first page spent it');
        for (let i = 0; i < 3; i += 1) {
            assert.equal(reloaded.waitMs('critical', 2000), 0, `stop ${i + 1} still has the reserve`);
            reloaded.record('critical', 2000);
        }
        assert.ok(reloaded.waitMs('critical', 2000) > 0, 'nothing goes past the ceiling, whichever page sent what');
        assert.ok(first.waitMs('critical', 2000) > 0, 'a page still open counts the reloaded one too');
        assert.equal(first.count(2000), 10, 'and neither counts its own requests twice');
        assert.equal(reloaded.count(2000), 10);
    });

    it('keeps every page\'s entries when two tabs write in turn', () => {
        const store = memoryStore();
        const a = createRateBudget({ ...limits, store, page: 'a' });
        const b = createRateBudget({ ...limits, store, page: 'b' });
        a.record('normal', 1000);
        b.record('normal', 1001);
        a.record('open', 1002);
        b.record('critical', 1003);
        const third = createRateBudget({ ...limits, store, page: 'c' });
        assert.equal(third.count(1004), 4);
        assert.equal(decodeRateLog(store.peek(), { now: 1004, windowMs: 60000 }).entries.filter((e) => e.open).length, 1, 'a valve open is still one after the trip');
    });

    it('never lets any window of the server hold more than the ceiling, across a reload', () => {
        const store = memoryStore();
        const ceiling = 12;
        const opts = { windowMs: 60000, ceiling, reserve: 4, watchReserve: 0, maxOpens: 100, store };
        let budget = createRateBudget({ ...opts, page: 'p0' });
        const sent = [];
        for (let t = 0; t < 300000; t += 250) {
            // A reload every 37 s, mid-window.
            if (t > 0 && t % 37000 === 0) budget = createRateBudget({ ...opts, page: `p${t}` });
            const kind = t % 1000 === 0 ? 'critical' : 'normal';
            if (budget.waitMs(kind, t) === 0) {
                budget.record(kind, t);
                sent.push(t);
            }
        }
        for (let start = -60000; start < 300000; start += 250) {
            const inWindow = sent.filter((t) => t >= start && t < start + 60000).length;
            assert.ok(inWindow <= ceiling, `window at ${start} held ${inWindow}`);
        }
    });

    it('lets old requests go when they leave the window, and then removes the entry', () => {
        const store = memoryStore();
        const first = createRateBudget({ ...limits, store, page: 'first' });
        first.record('normal', 1000);
        const reloaded = createRateBudget({ ...limits, store, page: 'reloaded' });
        assert.equal(reloaded.count(60999), 1);
        assert.equal(reloaded.count(61000), 0);
        assert.equal(store.peek(), null, 'nothing in it counts, so nothing is left behind');
    });

    it('carries the hold after a 429 across a reload, but never onto a stop and never past a window', () => {
        const store = memoryStore();
        const first = createRateBudget({ ...limits, store, page: 'first' });
        first.noteServerRefusal(1000, 10000);
        const reloaded = createRateBudget({ ...limits, store, page: 'reloaded' });
        assert.equal(reloaded.waitMs('normal', 2000), 9000);
        assert.equal(reloaded.waitMs('critical', 2000), 0);
        const damaged = decodeRateLog(JSON.stringify({ e: [], b: 1e15 }), { now: 5000, windowMs: 60000 });
        assert.equal(damaged.blockedUntil, 65000);
    });

    it('reads a damaged store as holding traffic back, never as a free minute that is not there', () => {
        const now = 100000;
        const read = (raw) => decodeRateLog(raw, { now, windowMs: 60000, page: 'me' });
        for (const junk of [null, '', 'not json', '[]', '{}', '{"e":5}', JSON.stringify({ e: [null, 'x', [NaN], ['99'], [Infinity, 'a', 0]] })]) {
            assert.deepEqual(read(junk), { entries: [], blockedUntil: 0 }, String(junk));
        }
        const log = read(JSON.stringify({ e: [[now - 70000, 'old', 0], [now - 1000, 'other', 1], [now - 500, 'me', 0], [now + 3600000, 'fast clock', 0], [now - 10, 42, 0]] }));
        assert.deepEqual(log.entries, [
            { t: now - 1000, page: 'other', open: true, watch: false, critical: false },
            { t: now - 10, page: '', open: false, watch: false, critical: false },
            { t: now, page: 'fast clock', open: false, watch: false, critical: false }
        ], 'the expired one is gone, this page\'s own is skipped, and one from the future counts as now');
    });

    it('a clock that went back holds a stop for one window at most', () => {
        // Written an hour "ahead" of the clock that reads it: read as sent
        // now, so the wait is one window - never an hour and a window.
        const store = memoryStore();
        const ahead = createRateBudget({ windowMs: 60000, ceiling: 3, reserve: 1, maxOpens: 5, store, page: 'ahead' });
        for (let i = 0; i < 3; i += 1) ahead.record('critical', 3600000);
        const now = createRateBudget({ windowMs: 60000, ceiling: 3, reserve: 1, maxOpens: 5, store, page: 'now' });
        assert.equal(now.waitMs('critical', 1000), 60000);
        const own = createRateBudget({ windowMs: 60000, ceiling: 1, reserve: 0, maxOpens: 5 });
        own.record('critical', 3600000);
        assert.equal(own.waitMs('critical', 1000), 60000, 'the same for a page\'s own entries');
    });

    it('a store that cannot be read or written leaves the page counting for itself', () => {
        const broken = { load: () => { throw new Error('SecurityError'); }, save: () => { throw new Error('QuotaExceededError'); } };
        const budget = createRateBudget({ ...limits, store: broken, page: 'p' });
        for (let i = 0; i < 7; i += 1) budget.record('normal', 1000);
        assert.ok(budget.waitMs('normal', 1000) > 0);
        assert.equal(budget.waitMs('critical', 1000), 0);
    });

    it('writes only what still counts', () => {
        assert.equal(encodeRateLog({ own: [{ t: 1, open: false }], now: 70000, windowMs: 60000 }), null);
        const text = encodeRateLog({ own: [{ t: 69000, open: true }], others: [{ t: 68000, page: 'x', open: false }], page: 'me', blockedUntil: 75000, now: 70000, windowMs: 60000 });
        assert.deepEqual(JSON.parse(text), { e: [[68000, 'x', 0], [69000, 'me', 1]], b: 75000 });
    });

    it('names the entry by a hash of the token, never the token', () => {
        const key = rateLogStorageKey('jya6vksq08q3');
        assert.ok(key.startsWith(RATE_LOG_STORAGE_PREFIX));
        assert.match(key, /^vacuglide_rate_log_[0-9a-f]{8}$/);
        assert.ok(!key.includes('jya6vksq08q3'));
        assert.equal(key, rateLogStorageKey('jya6vksq08q3'), 'a reloaded page finds the same log');
        assert.notEqual(key, rateLogStorageKey('m3ztyf7bxgoi'));
    });
});

describe('what a page that goes away leaves the next one', () => {
    const NOW = 1_000_000;
    const CLUSTER = 'https://eu-central-1.autoblowapi.com';
    const entry = (over = {}) => ({
        token: 'a1b2c3d4e5f6',
        cluster: CLUSTER,
        page: 'first',
        at: NOW - 100,
        speedUntil: NOW + 60000,
        openUntil: 0,
        stopUntil: NOW + 300000,
        alarm: false,
        held: false,
        connecting: false,
        ...over
    });
    const read = (list, maxAheadMs = 300000) => decodeHandover(JSON.stringify({ entries: list }), { now: NOW, maxAheadMs });

    it('has a key of its own, beside the token\'s and the request log\'s', () => {
        assert.equal(VACUGLIDE_HANDOVER_STORAGE_KEY, 'vacuglide_handover');
        assert.notEqual(VACUGLIDE_HANDOVER_STORAGE_KEY, VACUGLIDE_TOKEN_STORAGE_KEY);
        assert.ok(!VACUGLIDE_HANDOVER_STORAGE_KEY.startsWith(RATE_LOG_STORAGE_PREFIX));
    });

    it('reads back what was written, and nothing else', () => {
        const written = [
            entry(),
            entry({ token: 'zz99yy88xx77', page: 'second', speedUntil: 0, openUntil: NOW + 5000, stopUntil: 0, alarm: true }),
            entry({ token: 'held12345678', page: 'third', held: true }),
            entry({ token: 'conn12345678', page: 'fourth', held: true, connecting: true })
        ];
        const raw = encodeHandover(written);
        assert.deepEqual(decodeHandover(raw, { now: NOW, maxAheadMs: 300000 }), written);
        assert.deepEqual(Object.keys(JSON.parse(raw)), ['entries'], 'no record of pages that came back: a page takes back only what it left');
        const [extra] = read([{ ...entry(), origins: [['elsewhere', NOW]], back: 1 }]);
        assert.deepEqual(Object.keys(extra).sort(), ['alarm', 'at', 'cluster', 'connecting', 'held', 'openUntil', 'page', 'speedUntil', 'stopUntil', 'token'], 'fields no page writes are not read');
        // Only a plain true says a page that is still open holds it: anything
        // else is what a page that went away left, which the next one takes.
        for (const value of ['true', 1, {}, null]) assert.equal(read([entry({ held: value })])[0].held, false, JSON.stringify(value));
        // And only a page that holds it can be connecting it: a page that went
        // away is connecting nothing, and what it left is taken like any other.
        for (const value of ['true', 1, {}, null]) assert.equal(read([entry({ held: true, connecting: value })])[0].connecting, false, JSON.stringify(value));
        assert.equal(read([entry({ held: false, connecting: true })])[0].connecting, false);
        assert.equal(JSON.parse(encodeHandover([entry({ held: false, connecting: true })])).entries[0].connecting, false);
    });

    it('stores nothing when there is nothing to leave', () => {
        assert.equal(encodeHandover([]), null);
        assert.equal(encodeHandover(undefined), null);
    });

    it('drops an entry whose token or cluster the Connect field would refuse', () => {
        for (const bad of [
            { token: 'has space' },
            { token: '' },
            { token: 'x'.repeat(129) },
            { token: 42 },
            { cluster: 'https://collector.evil.example' },
            { cluster: 'http://eu-central-1.autoblowapi.com' },
            { cluster: 'https://latency.autoblowapi.com' },
            { cluster: null }
        ]) {
            assert.deepEqual(read([entry(bad)]), [], JSON.stringify(bad));
        }
        // A bare host is the form Autoblow's reference shows.
        assert.equal(read([entry({ cluster: 'eu-central-1.autoblowapi.com' })])[0].cluster, CLUSTER);
    });

    // A speed that landed while no page was open keeps the motor running
    // however long ago its window closed - the device has no watchdog - so
    // an entry whose windows have all run out is still a read, or a stop,
    // that some page owes.
    it('keeps a window that has run out, which still owes a last read, and counts a time that is not one as none', () => {
        const [kept] = read([entry({ speedUntil: NOW - 1, openUntil: 'soon', stopUntil: NOW - 250000 })]);
        assert.equal(kept.speedUntil, NOW - 1);
        assert.equal(kept.openUntil, 0);
        assert.equal(kept.stopUntil, NOW - 250000);
        const dayLater = decodeHandover(JSON.stringify({ entries: [entry({ stopUntil: 0 })] }), { now: NOW + 86400000, maxAheadMs: 300000 });
        assert.equal(dayLater[0].speedUntil, NOW + 60000, 'a day later it is still owed');
        assert.deepEqual(read([entry({ speedUntil: -5, openUntil: NaN, stopUntil: Infinity })]), [], 'neither a negative time nor Infinity is one');
        assert.deepEqual(read([entry({ speedUntil: 0, openUntil: 0, stopUntil: 0, alarm: true })]), [], 'an alarm alone is nothing to take over');
    });

    it('never lets a window reach further ahead than the longest one the driver gives', () => {
        // A clock that went back since it was written, or a damaged store:
        // it can make a page watch longer, never forever.
        const [kept] = read([entry({ speedUntil: NOW + 10 * 3600000, stopUntil: NOW + 10 * 3600000 })], 300000);
        assert.equal(kept.speedUntil, NOW + 300000);
        assert.equal(kept.stopUntil, NOW + 300000);
        const [early] = read([entry({ at: NOW + 5000 })]);
        assert.equal(early.at, NOW, 'a hand-over time in the future is now');
    });

    it('reads nothing out of a damaged store, and at most a few entries out of a huge one', () => {
        for (const raw of [null, '', 'not json', '[]', '{"entries":"x"}', '{"entries":[null, 3, "x", []]}', JSON.stringify({ entries: [{}] })]) {
            assert.deepEqual(decodeHandover(raw, { now: NOW, maxAheadMs: 300000 }), [], String(raw));
        }
        const many = Array.from({ length: 500 }, (_, i) => entry({ token: `tok${i}xx` }));
        assert.ok(read(many).length <= 16);
    });

    it('takes one device over once, however many pages left it: every window at its widest, and the alarm if any raised it', () => {
        for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0]]) {
            const left = [
                entry({ page: 'first', at: NOW - 900, cluster: 'https://us-east-2.autoblowapi.com', speedUntil: NOW + 1000, openUntil: 0, stopUntil: 0 }),
                entry({ page: 'second', at: NOW - 100, speedUntil: NOW + 400, openUntil: NOW + 7000, stopUntil: NOW + 3000, alarm: true }),
                entry({ token: 'other1234567', page: 'second', speedUntil: NOW + 50, stopUntil: 0 })
            ];
            const merged = mergeHandoverByDevice(order.map((i) => left[i]));
            assert.equal(merged.length, 2);
            const one = merged.find((e) => e.token === 'a1b2c3d4e5f6');
            assert.equal(one.speedUntil, NOW + 1000, `the widest speed window, whichever page came first (${order})`);
            assert.equal(one.openUntil, NOW + 7000);
            assert.equal(one.stopUntil, NOW + 3000);
            assert.equal(one.alarm, true);
            assert.equal(one.cluster, CLUSTER, 'where the newest of them reached it');
            assert.equal(one.at, NOW - 100);
            assert.equal(one.held, false);
        }
        // Held only when every page it came from is still open.
        const held = [entry({ page: 'a', held: true }), entry({ page: 'b', held: true })];
        assert.equal(mergeHandoverByDevice(held)[0].held, true);
        assert.equal(mergeHandoverByDevice([...held, entry({ page: 'c' })])[0].held, false);
        assert.equal(mergeHandoverByDevice([entry({ page: 'c' }), ...held])[0].held, false);
        // Connecting only when every page it came from is connecting it.
        const connecting = [entry({ page: 'a', held: true, connecting: true }), entry({ page: 'b', held: true, connecting: true })];
        assert.equal(mergeHandoverByDevice(connecting)[0].connecting, true);
        assert.equal(mergeHandoverByDevice([...connecting, entry({ page: 'c', held: true })])[0].connecting, false);
        assert.equal(mergeHandoverByDevice([entry({ page: 'c', held: true }), ...connecting])[0].connecting, false);
        assert.equal(mergeHandoverByDevice([entry({ page: 'd', held: false, connecting: true })])[0].connecting, false);
    });
});

describe('how long ago a page went away', () => {
    it('says it in words, to the nearest unit that reads naturally', () => {
        assert.equal(describeAgo(0), 'moments ago');
        assert.equal(describeAgo(59000), 'moments ago');
        assert.equal(describeAgo(60000), 'a minute ago');
        assert.equal(describeAgo(5 * 60000), '5 minutes ago');
        assert.equal(describeAgo(59.6 * 60000), 'an hour ago');
        assert.equal(describeAgo(3 * 3600000), '3 hours ago');
        assert.equal(describeAgo(47 * 3600000), '47 hours ago');
        assert.equal(describeAgo(3 * 86400000), '3 days ago');
    });

    it('reads anything that is not a length of time as none', () => {
        for (const junk of [-5000, NaN, undefined, null, 'soon']) assert.equal(describeAgo(junk), 'moments ago', String(junk));
    });
});

describe('what /info and /connected say about the device', () => {
    it('reports the firmware, and a firmware status that asks for something', () => {
        assert.equal(describeVacuglideInfo({ firmwareVersion: 1.01, firmwareStatus: 'UP_TO_DATE', mac: 'aabbccddeeff' }), 'fw 1.01');
        assert.equal(describeVacuglideInfo({ firmwareVersion: 1.01, firmwareStatus: 'UPDATE_AVAILABLE' }), 'fw 1.01, update available');
        assert.match(describeVacuglideInfo({ firmwareVersion: 2, firmwareStatus: 'UPDATE_REQUIRED' }), /update is required/);
        assert.equal(describeVacuglideInfo(null), '');
        assert.ok(!/aabbcc/.test(describeVacuglideInfo({ firmwareVersion: 1, mac: 'aabbccddeeff' })), 'the MAC is never shown');
    });

    it('recognises a token that belongs to another Autoblow device', () => {
        assert.equal(foreignDeviceType('vacuglide'), null);
        assert.equal(foreignDeviceType(undefined), null, 'an older reply that does not say is not refused');
        assert.equal(foreignDeviceType('autoblow-ultra'), 'autoblow-ultra');
        assert.match(describeForeignDevice('autoblow-ultra'), /AI Ultra, not a VacuGlide/);
        assert.match(describeForeignDevice('vacupump'), /VacuPump/);
    });
});

describe('the settings schema bounds the VacuGlide values like every other', () => {
    it('ships a live primary channel, no cap, and the one-second pulse', () => {
        assert.equal(SETTING_DEFAULTS.vacuglideRole, 'primary');
        assert.equal(SETTING_DEFAULTS.vacuglideMaxCap, 100);
        assert.equal(SETTING_DEFAULTS.vacuglideValvePulseMs, 1000);
    });

    it('falls back to the safe side, not the factory side, for the two values that decide how hard it runs', () => {
        assert.equal(sanitizeSetting('vacuglideRole', 'boss'), 'off');
        assert.equal(sanitizeSetting('vacuglideRole', 'secondary'), 'secondary');
        assert.equal(sanitizeSetting('vacuglideMaxCap', 'fast'), 10);
        assert.equal(sanitizeSetting('vacuglideMaxCap', 67), 65);
        assert.equal(sanitizeSetting('vacuglideValvePulseMs', 99999), 2000);
    });

    it('matches what index.html offers for each control', () => {
        const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
        const tag = (id) => html.slice(html.lastIndexOf('<', html.indexOf(`id="${id}"`)), html.indexOf('>', html.indexOf(`id="${id}"`)) + 1);
        const cap = tag('vacuglideCapSlider');
        assert.match(cap, /min="10"/);
        assert.match(cap, /max="100"/);
        assert.match(cap, /step="5"/);
        const pulse = tag('vacuglidePulseInput');
        assert.match(pulse, /min="0\.3"/);
        assert.match(pulse, /max="2"/);
        assert.match(pulse, /step="0\.1"/);
        assert.equal(pulseSecondsToMs('0.3'), VALVE_PULSE_MIN_MS);
        assert.equal(pulseSecondsToMs('2'), VALVE_PULSE_MAX_MS);
    });
});
