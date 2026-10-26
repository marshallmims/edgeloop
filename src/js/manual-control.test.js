import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    acceptEpoch,
    clampPatternPeriod,
    controlsForKind,
    decayFrame,
    frameFromPattern,
    frameIsStopped,
    loopFromGesture,
    mapStrokeIntoEnvelope,
    parseDeviceId,
    patternLevel,
    peaksFromValues,
    sanitizeDeviceCatalog,
    manualSplit,
    sanitizeManualFrame,
    sanitizeManualPattern
} from './manual-control.js';

describe('device catalog', () => {
    it('keeps connected toys and drops a broken entry', () => {
        const list = sanitizeDeviceCatalog([
            { id: 'handy', name: 'The Handy', connected: true, role: 'primary', kind: 'stroke' },
            { id: 'intiface:2:scalar:0', name: '  Edge  ', connected: 1, role: 'secondary', kind: 'vibrate' },
            { id: 'nope', name: 'x', connected: true, role: 'primary', kind: 'stroke' },
            { id: 'handy', name: 'again', connected: true, role: 'primary', kind: 'stroke' },
            { id: 'vacuglide', name: 'VacuGlide 2', connected: false, role: 'nope', kind: 'speed' }
        ]);
        assert.equal(list.length, 3);
        assert.equal(list[1].name, 'Edge');
        assert.equal(list[1].role, 'secondary');
        assert.equal(list[2].role, 'off');
        assert.equal(list[2].connected, false);
    });

    it('parses a per-axis id', () => {
        assert.deepEqual(parseDeviceId('intiface:3:linear:0'), { family: 'intiface', deviceIndex: 3, axisKey: 'linear:0' });
        assert.deepEqual(parseDeviceId('tcode:L0'), { family: 'tcode', axisId: 'L0' });
        assert.equal(parseDeviceId('handy<script>'), null);
    });
});

describe('manual frames', () => {
    it('clamps a frame and keeps only the first copy of an id', () => {
        const frame = sanitizeManualFrame({
            type: 'MANUAL_FRAME',
            epoch: 4,
            urgent: 1,
            devices: [
                { id: 'handy', speed: 140, strokeMin: -5, strokeMax: 80, level: 3 },
                { id: 'handy', speed: 1, strokeMin: 0, strokeMax: 1, level: 1 },
                { id: 'intiface:0:scalar:0', speed: 0, level: '60' }
            ]
        });
        assert.equal(frame.epoch, 4);
        assert.equal(frame.urgent, false);
        assert.equal(frame.devices.length, 2);
        assert.deepEqual(frame.devices[0], { id: 'handy', speed: 100, strokeMin: 0, strokeMax: 80, level: 3 });
        assert.equal(frame.devices[1].level, 60);
    });

    it('rejects an older epoch than the stop the host already took', () => {
        assert.equal(acceptEpoch(5, 5), true);
        assert.equal(acceptEpoch(5, 4), false);
        assert.equal(sanitizeManualFrame({ type: 'MANUAL_FRAME', epoch: 1.5, devices: [] }), null);
    });

    it('accepts a drawn loop and refuses a one-point scribble', () => {
        const ok = sanitizeManualPattern({
            type: 'MANUAL_PATTERN',
            epoch: 2,
            id: 'drawn',
            periodMs: 50,
            drawn: [{ t: 0.8, level: 0.2 }, { t: 0.1, level: 1 }, { t: 'no' }],
            devices: [{ id: 'handy', speed: 80, strokeMin: 10, strokeMax: 90, level: 0 }]
        });
        assert.equal(ok.periodMs, 600);
        assert.deepEqual(ok.drawn.map((point) => point.t), [0.1, 0.8]);
        assert.equal(sanitizeManualPattern({
            type: 'MANUAL_PATTERN', epoch: 2, id: 'drawn', drawn: [{ t: 0, level: 1 }], devices: []
        }), null);
        assert.equal(sanitizeManualPattern({
            type: 'MANUAL_PATTERN', epoch: 2, id: 'pulse', devices: []
        }).id, 'pulse');
        const refresh = sanitizeManualPattern({
            type: 'MANUAL_PATTERN', epoch: 2, id: 'pulse', refresh: true, devices: []
        });
        assert.equal(refresh.refresh, true);
        assert.equal(sanitizeManualPattern({
            type: 'MANUAL_PATTERN', epoch: 2, id: 'pulse', refresh: 1, devices: []
        }).refresh, false);
        const swapped = sanitizeManualFrame({
            type: 'MANUAL_FRAME',
            epoch: 1,
            devices: [{ id: 'handy', speed: 40, strokeMin: 90, strokeMax: 10, level: 0 }]
        });
        assert.equal(swapped.devices[0].strokeMin, 10);
        assert.equal(swapped.devices[0].strokeMax, 90);
    });
});

describe('patterns', () => {
    it('maps a stroke into the wearer envelope', () => {
        assert.deepEqual(mapStrokeIntoEnvelope(0, 100, 20, 80), { min: 20, max: 80 });
        assert.deepEqual(mapStrokeIntoEnvelope(0, 50, 20, 80), { min: 20, max: 50 });
    });

    it('runs a pulse, a wave, and a drawn loop', () => {
        assert.equal(patternLevel('pulse', 0, 1000), 1);
        assert.equal(patternLevel('pulse', 500, 1000), 0);
        assert.ok(patternLevel('wave', 0, 1000) < 0.01);
        assert.ok(patternLevel('wave', 500, 1000) > 0.99);
        const level = patternLevel('drawn', 500, 1000, [{ t: 0, level: 0 }, { t: 1, level: 1 }]);
        assert.ok(Math.abs(level - 0.5) < 0.001);
    });

    it('scales the saved peaks and eases a quiet link to a stop', () => {
        const frame = frameFromPattern({
            id: 'pulse',
            periodMs: 1000,
            devices: [{ id: 'handy', speed: 80, strokeMin: 10, strokeMax: 90, level: 0 }]
        }, 0);
        assert.equal(frame.devices[0].speed, 80);
        assert.equal(frame.devices[0].strokeMin, 10);
        const held = decayFrame(frame, 200);
        assert.equal(held.devices[0].speed, 80);
        const mid = decayFrame(frame, 400 + 600);
        assert.ok(mid.devices[0].speed < 80);
        assert.ok(mid.devices[0].speed > 0);
        const done = decayFrame(frame, 400 + 1200);
        assert.equal(done.devices[0].speed, 0);
        assert.equal(frameIsStopped(done), true);
    });

    it('turns a drag into a loop and gives a silent toy a peak', () => {
        const loop = loopFromGesture([{ x: 0, y: 1 }, { x: 1, y: 0 }], 1500);
        assert.equal(loop.id, 'drawn');
        assert.equal(loop.periodMs, 1500);
        assert.equal(loop.drawn[0].level, 0);
        assert.equal(loop.drawn[1].level, 1);
        const peaks = peaksFromValues([{ id: 'handy', kind: 'stroke', speed: 0, strokeMin: 0, strokeMax: 100, level: 0 }]);
        assert.equal(peaks[0].speed, 70);
        assert.deepEqual(controlsForKind('vibrate'), ['level']);
        assert.deepEqual(controlsForKind('stroke'), ['speed', 'strokeMin', 'strokeMax']);
        assert.equal(clampPatternPeriod(99999), 8000);
    });

    it('keeps one toy for the controller and leaves the other on EdgeLoop', () => {
        const catalog = [
            { id: 'hr', connected: true, kind: 'heart', role: 'off' },
            { id: 'handy', connected: true, kind: 'stroke', role: 'primary' },
            { id: 'intiface:1:vibrate:0', connected: true, kind: 'vibrate', role: 'secondary' },
            { id: 'intiface:1:vibrate:1', connected: false, kind: 'vibrate', role: 'secondary' }
        ];
        const split = manualSplit(catalog, ['handy']);
        assert.deepEqual(split.claimed, ['handy']);
        assert.deepEqual(split.released, ['intiface:1:vibrate:0']);
        assert.equal(split.engine, true);
        assert.equal(split.full, false);
        const both = manualSplit(catalog, ['handy', 'intiface:1:vibrate:0']);
        assert.equal(both.full, true);
        assert.equal(both.engine, false);
    });
});
