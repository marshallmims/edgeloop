import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    isDevTelemetryHost,
    publicDeviceName,
    pauseReasonFromSource,
    createSessionLog,
    buildSessionExport
} from './session-telemetry.js';

describe('dev session log host', () => {
    it('is every host except the live site', () => {
        assert.equal(isDevTelemetryHost('dev.edgeloop.app'), true);
        assert.equal(isDevTelemetryHost('DEV.EDGELOOP.APP'), true);
        assert.equal(isDevTelemetryHost('marshallmims.github.io'), true);
        assert.equal(isDevTelemetryHost('localhost'), true);
        assert.equal(isDevTelemetryHost('127.0.0.1'), true);
        assert.equal(isDevTelemetryHost('edgeloop.app'), false);
        assert.equal(isDevTelemetryHost('www.edgeloop.app'), false);
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

    it('records why a pause happened, and the intensity, and drops anything else', () => {
        const log = createSessionLog();
        log.observe({ t: 0, hr: 90, speed: 40, status: 'RUNNING', mode: 'classic', intensity: 19, pauseReason: 'button' });
        log.observe({ t: 1000, hr: 92, speed: 0, status: 'PAUSED', mode: 'classic', intensity: 19, pauseReason: 'hrSignal' });
        log.observe({ t: 2000, hr: 95, speed: 0, status: 'PAUSED', mode: 'classic', intensity: 100, pauseReason: 'https://handy.local/key' });
        const snap = log.snapshot();
        assert.equal(snap.series[0].intensity, 19);
        assert.equal(snap.series[0].pauseReason, '');
        assert.equal(snap.series[1].pauseReason, 'hr-signal');
        assert.equal(snap.series[1].intensity, 19);
        assert.equal(snap.series[2].pauseReason, '');
        assert.equal(snap.series[2].intensity, 100);
        assert.equal(snap.events[1].pauseReason, 'hr-signal');
        assert.equal(snap.events[1].intensity, 19);
        assert.equal(JSON.stringify(snap).includes('handy.local'), false);
        const exported = buildSessionExport({ trace: snap });
        assert.equal(exported.events[1].pauseReason, 'hr-signal');
        assert.equal(exported.series[2].intensity, 100);
        assert.equal(exported.telemetryVersion, 5);
    });
});

describe('pause reasons', () => {
    it('keeps a known reason and maps the banner sources', () => {
        assert.equal(pauseReasonFromSource('button'), 'button');
        assert.equal(pauseReasonFromSource('hrSignal'), 'hr-signal');
        assert.equal(pauseReasonFromSource('vacuglideStop'), 'vacuglide');
        assert.equal(pauseReasonFromSource('handy-stop'), 'handy-stop');
        assert.equal(pauseReasonFromSource('The Handy connection key'), '');
        assert.equal(pauseReasonFromSource('edged'), 'edged');
        assert.equal(pauseReasonFromSource(''), '');
    });

    it('names a reason on every safety pause in the app', () => {
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.match(app, /pauseSession\(null, reason\)/);
        assert.match(app, /pauseSession\('Paused\.', pendingPauseReason \|\| 'button'\)/);
        assert.match(app, /pauseSession\('Paused\.', 'player'\)/);
        assert.match(app, /function countManualEdge/);
        assert.match(app, /function markCalibrationEdge/);
        assert.doesNotMatch(app, /classList\.toggle\('hidden', !live\)/);
        assert.match(app, /state\.pauseReason !== 'edged'/);
        for (const source of ["'hr-link'", "'handy'", "'handy-stop'", "'beat-sync'", "'intiface'", "'tcode'", "'video'", "'remote'", "'edged'"]) {
            assert.ok(app.includes(source), `missing pause source ${source}`);
        }
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
        assert.equal(exported.devices.intiface[0].axes[0].vibeMode, undefined);
        assert.equal(exported.script.hash, 'a'.repeat(64));
        assert.deepEqual(exported.script.climaxMarks, [12000, 40000]);
        assert.equal(exported.summary.hrMax, 110);
        assert.equal(exported.summary.edgedSeconds, 1);
        assert.equal(exported.series.length, 2);
        assert.match(exported.note, /stays on your device/);
        assert.match(exported.note, /Bluetooth address/);
    });

    it('keeps a vibrate mode and a product name, and drops an address', () => {
        const exported = buildSessionExport({
            devices: {
                heartRate: { connected: true, name: 'HeartCast' },
                intiface: [{
                    name: 'Lovense Edge',
                    axes: [{ kind: 'Vibrate', role: 'secondary', maxCap: 80, vibeMode: 'pulsed', pulsePeriodMs: 800, address: 'AA:BB:CC:DD:EE:FF' }]
                }],
                tcode: { connected: true, name: 'FUNSR Pro', axes: [{ id: 'L0', role: 'primary', maxCap: 100 }] }
            }
        });
        const text = JSON.stringify(exported);
        assert.equal(exported.devices.heartRate.name, 'HeartCast');
        assert.equal(exported.devices.intiface[0].axes[0].vibeMode, 'pulsed');
        assert.equal(exported.devices.intiface[0].axes[0].pulsePeriodMs, 800);
        assert.equal(exported.devices.tcode.name, 'FUNSR Pro');
        assert.equal(text.includes('AA:BB'), false);
        const junk = buildSessionExport({
            devices: { intiface: [{ name: 'Edge', axes: [{ kind: 'Vibrate', role: 'secondary', vibeMode: 'strobe', pulsePeriodMs: 1000 }] }] }
        });
        assert.equal(junk.devices.intiface[0].axes[0].vibeMode, undefined);
        assert.equal(junk.devices.intiface[0].axes[0].pulsePeriodMs, undefined);
    });
});

describe('handy position commands in the log', () => {
    it('keeps the move and drops a connection key', () => {
        const exported = buildSessionExport({
            devices: { handy: { connected: true, drive: 'hdsp', position: 40, duration: 480, stop: 1, error: 'hdsp 5000' } },
            handyTrace: [
                { t: 10, drive: 'hdsp', position: 5, duration: 480, stop: 1, error: '' },
                { t: 20, drive: 'hdsp', position: 70, duration: 330, stop: 0, error: 'key abcdef' }
            ]
        });
        assert.equal(exported.devices.handy.drive, 'hdsp');
        assert.equal(exported.devices.handy.position, 40);
        assert.equal(exported.devices.handy.error, 'hdsp 5000');
        assert.equal(exported.handyTrace.length, 2);
        assert.equal(exported.handyTrace[0].position, 5);
        assert.equal(exported.handyTrace[1].error, '');
        assert.equal(JSON.stringify(exported).includes('abcdef'), false);
    });
});

describe('Share Control events in the log', () => {
    it('keeps the link measurements and drops an address, a room, and a peer id', () => {
        const exported = buildSessionExport({
            shareTrace: [
                {
                    t: 50,
                    side: 'host',
                    who: 'controller',
                    kind: 'quality',
                    rttMs: 42,
                    jitterMs: 8,
                    packetsLost: 1,
                    ip: '203.0.113.8',
                    address: '203.0.113.8',
                    candidate: 'candidate:1 1 udp 1.2.3.4 54400',
                    peerId: 'room-secret-abc',
                    url: 'https://dev.edgeloop.app/?partner=room-secret-abc'
                },
                {
                    t: 80,
                    side: 'host',
                    who: 'controller',
                    kind: 'link-down',
                    reason: 'timeout',
                    code: 'not-a-real-code',
                    cmd: 'SESSION_STATE'
                },
                { t: 90, kind: 'gossip', message: 'user@example.com' }
            ]
        });
        const text = JSON.stringify(exported);
        assert.equal(exported.shareTrace.length, 2);
        assert.equal(exported.shareTrace[0].rttMs, 42);
        assert.equal(exported.shareTrace[0].jitterMs, 8);
        assert.equal(exported.shareTrace[0].packetsLost, 1);
        assert.equal(exported.shareTrace[1].reason, 'timeout');
        assert.equal(exported.shareTrace[1].code, '');
        assert.equal(exported.shareTrace[1].cmd, 'SESSION_STATE');
        assert.equal(text.includes('203.0.113.8'), false);
        assert.equal(text.includes('room-secret'), false);
        assert.equal(text.includes('partner='), false);
        assert.equal(text.includes('example.com'), false);
        assert.equal(text.includes('candidate'), false);
    });
});

describe('the history opt-in', () => {
    it('is a switch on the history screen, off until the page turns recording on', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.match(html, /id="sessionLogPanel"/);
        assert.match(html, /id="sessionLogOptIn"/);
        assert.match(html, /does not upload it/);
        assert.match(html, /Bluetooth addresses/);
        assert.match(app, /sessionLogWanted\(\)/);
        assert.match(app, /edgeloop_session_log/);
        assert.match(app, /safeParse\(SESSION_LOG_KEY, false\) === true/);
        assert.match(html, /id="sessionLogDownload"/);
        assert.doesNotMatch(html, /id="manualTraditionalBtn"/);
        assert.match(app, /data-toy-mode/);
        assert.match(app, /return !isRemotePage && sessionLogOptIn/);
    });
});
