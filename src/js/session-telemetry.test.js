import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isDevTelemetryHost,
    publicDeviceName,
    createSessionLog,
    buildSessionExport
} from './session-telemetry.js';

describe('dev session log host', () => {
    it('is only the dev site', () => {
        assert.equal(isDevTelemetryHost('dev.edgeloop.app'), true);
        assert.equal(isDevTelemetryHost('DEV.EDGELOOP.APP'), true);
        assert.equal(isDevTelemetryHost('edgeloop.app'), false);
        assert.equal(isDevTelemetryHost('localhost'), false);
        assert.equal(isDevTelemetryHost(''), false);
    });
});

describe('names that can go in the log', () => {
    it('keeps a product name and drops an address, a token, and a link', () => {
        assert.equal(publicDeviceName('Polar H10'), 'Polar H10');
        assert.equal(publicDeviceName('AA:BB:CC:DD:EE:FF'), '');
        assert.equal(publicDeviceName('ab12cd34ef56ab78'), '');
        assert.equal(publicDeviceName('https://cdn.example/video.mp4'), '');
        assert.equal(publicDeviceName('someone@example.com'), '');
    });
});

describe('the one-second series', () => {
    it('keeps a point a second and an event when the session changes', () => {
        const log = createSessionLog();
        const point = (t, extra) => ({ t, hr: 80, speed: 40, secondary: 10, mode: 'classic', status: 'RUNNING', ...extra });
        log.observe(point(0));
        log.observe(point(250));
        log.observe(point(900));
        log.observe(point(1000, { edged: 1, edges: 1 }));
        log.observe(point(2000, { edged: 1, edges: 1, hr: 120 }));
        const snap = log.snapshot();
        assert.deepEqual(snap.series.map((p) => p.t), [0, 1000, 2000]);
        assert.equal(snap.series[2].hr, 120);
        assert.equal(snap.events.length, 2);
        assert.equal(snap.events[1].edged, 1);
        assert.equal(snap.events[1].edges, 1);
        log.reset();
        assert.equal(log.snapshot().series.length, 0);
    });
});

describe('buildSessionExport', () => {
    it('keeps the tuning fields and drops keys, tokens, voices, and file names', () => {
        const exported = buildSessionExport({
            appVersion: '1.1.4',
            session: { id: 5, duration: 90, edges: 2, peakHr: 128, outcome: 'Stopped', intensity: 70 },
            settings: {
                minHr: 55,
                maxHr: 140,
                scriptStrokeModel: 'keep',
                voiceURI: 'Kokoro',
                keybinds: { stop: { code: 'Escape' } },
                handyConnectionKey: 'secret-key',
                vacuglideToken: 'device-token'
            },
            devices: {
                handy: { connected: true, role: 'primary', maxCap: 80, firmware: '4.3', connectionKey: 'secret-key', beatSync: true },
                heartRate: { connected: true, name: 'Polar H10 AA:BB:CC:DD:EE:FF' },
                intiface: [{ name: 'Lovense Edge', signature: 'secret', axes: [{ kind: 'scalar', role: 'secondary', maxCap: 50 }] }],
                vacuglide: { connected: false, token: 'device-token', role: 'off' }
            },
            script: {
                loaded: true,
                actions: 10,
                durationMs: 60000,
                hash: 'a'.repeat(64),
                fileName: 'Private Scene.funscript',
                videoUrl: 'https://example.com/clip.mp4',
                climaxMarks: [12000, 40000],
                strokeModel: 'keep',
                secondary: true
            },
            trace: {
                series: [{ t: 0, hr: 70, speed: 20, status: 'RUNNING', mode: 'script' }, { t: 1000, hr: 110, speed: 80, edged: 1, status: 'RUNNING', mode: 'script' }],
                events: [{ t: 1000, edged: 1, edges: 1, status: 'RUNNING', mode: 'script' }]
            }
        });
        const text = JSON.stringify(exported);
        assert.equal(text.includes('secret'), false);
        assert.equal(text.includes('Kokoro'), false);
        assert.equal(text.includes('device-token'), false);
        assert.equal(text.includes('Private'), false);
        assert.equal(text.includes('example.com'), false);
        assert.equal(text.includes('Escape'), false);
        assert.equal(text.includes('AA:BB'), false);
        assert.equal(exported.appVersion, '1.1.4');
        assert.equal(exported.settings.minHr, 55);
        assert.equal(exported.settings.scriptStrokeModel, 'keep');
        assert.equal(exported.devices.handy.firmware, '4.3');
        assert.equal(exported.devices.handy.connected, true);
        assert.equal(exported.devices.heartRate.name, '');
        assert.equal(exported.devices.intiface[0].name, 'Lovense Edge');
        assert.equal(exported.devices.intiface[0].axes[0].role, 'secondary');
        assert.equal(exported.script.hash, 'a'.repeat(64));
        assert.deepEqual(exported.script.climaxMarks, [12000, 40000]);
        assert.equal(exported.summary.hrMax, 110);
        assert.equal(exported.summary.edgedSeconds, 1);
        assert.equal(exported.series.length, 2);
    });
});
