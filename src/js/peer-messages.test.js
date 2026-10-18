import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeCommand, sanitizeTelemetry, HISTORY_LENGTH } from './peer-messages.js';

describe('sanitizeCommand', () => {
    it('accepts the transport, orgasm and mode commands the controller UI exposes', () => {
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }), { type: 'SESSION_STATE', status: 'RUNNING' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'PAUSED' }), { type: 'SESSION_STATE', status: 'PAUSED' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'IDLE' }), { type: 'SESSION_STATE', status: 'IDLE' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_RESET' }), { type: 'SESSION_RESET' });
        assert.deepEqual(sanitizeCommand({ type: 'ORGASM_TOGGLE' }), { type: 'ORGASM_TOGGLE' });
        assert.deepEqual(sanitizeCommand({ type: 'MODE_CHANGE', mode: 'milker' }), { type: 'MODE_CHANGE', mode: 'milker' });
        assert.deepEqual(
            sanitizeCommand({ type: 'MODE_CHANGE', mode: 'oracle', enabled: false }),
            { type: 'MODE_CHANGE', mode: 'oracle', enabled: false }
        );
    });

    it('strips every extra field so raw limits or speeds never reach the host', () => {
        const cmd = sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', maxHr: 999, chosenSeconds: -1, speed: 100 });
        assert.deepEqual(cmd, { type: 'SESSION_STATE', status: 'RUNNING' });
    });

    it('rejects unknown types, unknown statuses, unknown modes and garbage', () => {
        assert.equal(sanitizeCommand({ type: 'SET_LIMITS', maxHr: 200 }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RAMPDOWN' }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE' }), null);
        assert.equal(sanitizeCommand({ type: 'MODE_CHANGE', mode: '<script>' }), null);
        assert.equal(sanitizeCommand({ type: 42 }), null);
        assert.equal(sanitizeCommand('SESSION_RESET'), null);
        assert.equal(sanitizeCommand(null), null);
        assert.equal(sanitizeCommand([]), null);
    });

    it('lets a viewer ping but never command', () => {
        assert.deepEqual(sanitizeCommand({ type: 'PING' }, 'viewer'), { type: 'PING' });
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'ORGASM_TOGGLE' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_RESET' }, 'viewer'), null);
    });
});

describe('sanitizeTelemetry', () => {
    it('returns null for anything that is not telemetry', () => {
        assert.equal(sanitizeTelemetry({ type: 'SESSION_STATE', status: 'RUNNING' }), null);
        assert.equal(sanitizeTelemetry(null), null);
        assert.equal(sanitizeTelemetry('TELEMETRY'), null);
    });

    it('coerces numeric strings and clamps every number', () => {
        const t = sanitizeTelemetry({
            type: 'TELEMETRY',
            hr: '132',
            seconds: -5,
            chosenTargetSeconds: 1e12,
            edges: '3',
            pauses: 2.6,
            strokerSpeed: 250,
            prostateSpeed: -10,
            minHr: 10,
            maxHr: '150'
        });
        assert.equal(t.hr, 132);
        assert.equal(t.seconds, 0);
        assert.equal(t.chosenTargetSeconds, 48 * 3600);
        assert.equal(t.edges, 3);
        assert.equal(t.pauses, 3);
        assert.equal(t.strokerSpeed, 100);
        assert.equal(t.prostateSpeed, 0);
        assert.equal(t.minHr, 30);
        assert.equal(t.maxHr, 150);
    });

    it('carries the pullback mark so a remote chart draws the real one', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', maxHr: 140, edgeTriggerHr: '133' });
        assert.equal(t.edgeTriggerHr, 133);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', edgeTriggerHr: 999 }).edgeTriggerHr, 250);
        // Absent or unusable: undefined, never a fabricated number.
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY' }).edgeTriggerHr, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', edgeTriggerHr: 'abc' }).edgeTriggerHr, undefined);
    });

    it('leaves invalid or missing fields undefined instead of zeroing them', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hr: 'abc', seconds: NaN, sessionStatus: 'EXPLODED', activeMode: 'ghost', orgasmMode: 'yes', ready: 1 });
        assert.equal(t.hr, undefined);
        assert.equal(t.seconds, undefined);
        assert.equal(t.sessionStatus, undefined);
        assert.equal(t.activeMode, undefined);
        assert.equal(t.orgasmMode, undefined);
        assert.equal(t.ready, undefined);
        assert.equal(t.history, undefined);
        assert.equal(t.hrSignal, undefined);
        assert.equal(t.hrSeen, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', hrSeen: 'yes' }).hrSeen, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', hrSeen: false }).hrSeen, false);
    });

    it('accepts known statuses, modes and booleans', () => {
        const t = sanitizeTelemetry({
            type: 'TELEMETRY',
            sessionStatus: 'RAMPDOWN',
            activeMode: 'oracle',
            teaseMode: 'shortener',
            gameMode: 'off',
            orgasmMode: true,
            ready: false
        });
        assert.equal(t.sessionStatus, 'RAMPDOWN');
        assert.equal(t.activeMode, 'oracle');
        assert.equal(t.teaseMode, 'shortener');
        assert.equal(t.gameMode, 'off');
        assert.equal(t.orgasmMode, true);
        assert.equal(t.ready, false);
    });

    it('cleans the history and keeps only the newest 60 samples', () => {
        const history = Array.from({ length: 80 }, (_, i) => i);
        history.push('bad', null, 999, -4);
        const t = sanitizeTelemetry({ type: 'TELEMETRY', history });
        assert.equal(t.history.length, HISTORY_LENGTH);
        assert.ok(t.history.every((v) => Number.isFinite(v) && v >= 0 && v <= 250));
        assert.equal(t.history[t.history.length - 1], 0);
        assert.equal(t.history[t.history.length - 2], 250);
    });

    it('carries the host\'s Edge Training and pullback settings', () => {
        // A remote page has its own persisted copies of these. Without them
        // on the wire, the Edge Training card a partner reads while pacing
        // the wearer's session quotes the PARTNER's own numbers, right under
        // a mode name and an edge counter that ARE live telemetry.
        const t = sanitizeTelemetry({
            type: 'TELEMETRY', trainHoldSeconds: 45, trainEdges: 9, edgeHoldPercent: 95
        });
        assert.equal(t.trainHoldSeconds, 45);
        assert.equal(t.trainEdges, 9);
        assert.equal(t.edgeHoldPercent, 95);

        // Clamped to the same bounds the host's own inputs use.
        const wild = sanitizeTelemetry({
            type: 'TELEMETRY', trainHoldSeconds: 5000, trainEdges: 0, edgeHoldPercent: 400
        });
        assert.equal(wild.trainHoldSeconds, 90);
        assert.equal(wild.trainEdges, 1);
        assert.equal(wild.edgeHoldPercent, 100);

        // Absent stays absent, so a remote page keeps its previous value
        // rather than snapping to a fabricated 0.
        const bare = sanitizeTelemetry({ type: 'TELEMETRY' });
        assert.equal(bare.trainHoldSeconds, undefined);
        assert.equal(bare.trainEdges, undefined);
        assert.equal(bare.edgeHoldPercent, undefined);
        for (const junk of ['abc', null, true, {}]) {
            const t2 = sanitizeTelemetry({ type: 'TELEMETRY', trainEdges: junk });
            assert.equal(t2.trainEdges, undefined, `${String(junk)} is not a count`);
        }
    });

    it('the host really sends them, and a remote page never shows its own', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const start = src.indexOf('function syncTelemetry');
        assert.ok(start >= 0, 'syncTelemetry not found in app.js');
        const body = src.slice(start, src.length > start + 2000 ? start + 2000 : src.length);
        for (const field of ['trainHoldSeconds:', 'trainEdges:', 'edgeHoldPercent:']) {
            assert.ok(body.includes(field), `telemetry must carry ${field}`);
        }
        // syncParamsUI runs at boot on a remote page too; writing this
        // browser's persisted values (or the HTML defaults) into the Edge
        // Training card is exactly the display artefact this closes.
        const sync = src.indexOf('const trainHold = document.getElementById(\'trainHoldSecondsInput\');');
        assert.ok(sync >= 0, 'the syncParamsUI writes were not found');
        const syncBody = src.slice(sync, sync + 700);
        assert.ok(/isRemotePage \? '' :/.test(syncBody), 'a remote page must not show its own Edge Training numbers');
    });

    it('normalises the watchdog block', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'weird', noContact: 1, silentMs: '2500' } });
        assert.deepEqual(t.hrSignal, { status: 'ok', noContact: true, silentMs: 2500 });
        const stale = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'stale' } });
        assert.deepEqual(stale.hrSignal, { status: 'stale', noContact: false, silentMs: 0 });
    });
});
