// Driver tests with a mocked global WebSocket and an in-memory localStorage.
// No network, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    connectIntifaceServer,
    disconnectIntiface,
    dispatchIntiface,
    setAxisRole,
    setAxisMaxCap,
    setAxisInvert,
    setDeviceRotation,
    setAxisVibeMode,
    reverseIntifaceRotation,
    saveIntifaceConfig,
    stopAllIntiface,
    isIntifaceConnected,
    isIntifaceScanning,
    isValidIntifaceUrl,
    getIntifaceStatus,
    countAssignedIntifaceDevices,
    resetIntifaceForTests,
    intifaceDevices,
    INTIFACE_TIMINGS,
    INTIFACE_STORAGE_KEY,
    HANDSHAKE_TIMEOUT_TEXT
} from './intiface.js';
import { REST_MOVE_MS } from './stroke-planner.js';

const sockets = [];

class FakeSocket {
    constructor(url) {
        if (!/^wss?:\/\//.test(url)) throw new SyntaxError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`);
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
    }
    send(data) {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.closed = true;
        this.readyState = 3;
    }
    // test helpers
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    receive(msgs) { if (this.onmessage) this.onmessage({ data: JSON.stringify(Array.isArray(msgs) ? msgs : [msgs]) }); }
    dropped() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    messages(type) { return this.sent.flat().filter((m) => m[type]).map((m) => m[type]); }
}

const memory = new Map();
const fakeStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); }
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const OSR2 = {
    DeviceIndex: 1,
    DeviceName: 'TCode v0.3 (Single Linear Axis)',
    DeviceMessages: { LinearCmd: [{ StepCount: 1000, FeatureDescriptor: 'L0', ActuatorType: 'Position' }], StopDeviceCmd: {} }
};
const EDGE = {
    DeviceIndex: 0,
    DeviceName: 'Lovense Edge',
    DeviceMessages: {
        ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Vibrate' }],
        SensorReadCmd: [{ SensorType: 'RSSI' }, { SensorType: 'Battery' }],
        StopDeviceCmd: {}
    }
};
const VORZE = {
    DeviceIndex: 2,
    DeviceName: 'Vorze A10 Cyclone',
    DeviceMessages: { RotateCmd: [{ StepCount: 100, ActuatorType: 'Rotate' }], StopDeviceCmd: {} }
};
const SR6 = {
    DeviceIndex: 3,
    DeviceName: 'TCode v0.3 (SR6)',
    DeviceMessages: {
        LinearCmd: [
            { StepCount: 1000, FeatureDescriptor: 'L0', ActuatorType: 'Position' },
            { StepCount: 1000, FeatureDescriptor: 'L1', ActuatorType: 'Position' }
        ],
        StopDeviceCmd: {}
    }
};

let events;
function handlersRecorder() {
    events = { status: [], closes: [], errors: [], changes: 0 };
    return {
        onStatus: (s) => events.status.push(s),
        onClose: (c) => events.closes.push(c),
        onError: (e) => events.errors.push(e),
        onDevicesChanged: () => { events.changes += 1; }
    };
}

function handshake(ws, { maxPing = 0, devices = [] } = {}) {
    ws.open();
    ws.receive({ ServerInfo: { Id: 1, ServerName: 'Intiface Central', MessageVersion: 3, MaxPingTime: maxPing } });
    ws.receive({ DeviceList: { Id: 2, Devices: devices } });
}

function connectWith(devices, opts = {}) {
    connectIntifaceServer('ws://localhost:12345', handlersRecorder());
    const ws = sockets[sockets.length - 1];
    handshake(ws, { ...opts, devices });
    return ws;
}

beforeEach(() => {
    sockets.length = 0;
    memory.clear();
    globalThis.WebSocket = FakeSocket;
    globalThis.localStorage = fakeStorage;
    INTIFACE_TIMINGS.handshakeMs = 60;
    INTIFACE_TIMINGS.minDirectionChangeMs = 1000;
    resetIntifaceForTests();
});

afterEach(() => {
    resetIntifaceForTests();
    delete globalThis.localStorage;
});

describe('connection lifecycle', () => {
    it('walks Offline -> Connecting -> Handshake -> Connected and enumerates', () => {
        const ws = connectWith([EDGE]);
        assert.deepEqual(events.status.map((s) => s.state), ['connecting', 'handshake', 'connected', 'connected']);
        assert.equal(getIntifaceStatus().text, 'Connected (Intiface Central, 1 device)');
        assert.equal(isIntifaceConnected(), true);
        assert.equal(isIntifaceScanning(), true);
        const rsi = ws.messages('RequestServerInfo');
        assert.equal(rsi.length, 1);
        assert.equal(rsi[0].MessageVersion, 3);
        assert.ok(rsi[0].Id >= 1);
        assert.equal(ws.messages('RequestDeviceList').length, 1);
        assert.equal(ws.messages('StartScanning').length, 1);
        // Battery read uses the real sensor index (1), not 0.
        const battery = ws.messages('SensorReadCmd');
        assert.equal(battery.length, 1);
        assert.equal(battery[0].SensorIndex, 1);
        ws.receive({ ScanningFinished: { Id: 0 } });
        assert.equal(isIntifaceScanning(), false);
        ws.receive({ SensorReading: { Id: battery[0].Id, DeviceIndex: 0, SensorIndex: 1, SensorType: 'Battery', Data: [77] } });
        assert.equal(intifaceDevices.get(0).battery, 77);
    });

    it('rejects an invalid URL synchronously without throwing', () => {
        const ok = connectIntifaceServer('localhost:12345', handlersRecorder());
        assert.equal(ok, false);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.match(getIntifaceStatus().text, /Invalid WebSocket URL/);
        assert.equal(sockets.length, 0);
    });

    it('rejects scheme-less and http URLs before touching the socket (browsers resolve them relatively)', () => {
        // A permissive socket, like a real browser: no throw on odd URLs.
        const Permissive = class extends FakeSocket { constructor(url) { super('ws://x'); this.url = url; } };
        globalThis.WebSocket = Permissive;
        for (const bad of ['127.0.0.1:12345', 'not a websocket url', 'http://localhost:12345', 'ws://', '']) {
            const ok = connectIntifaceServer(bad, handlersRecorder());
            if (bad === '') {
                assert.equal(ok, true, 'empty falls back to the default URL');
                disconnectIntiface();
                continue;
            }
            assert.equal(ok, false, bad);
            assert.match(getIntifaceStatus().text, /Invalid WebSocket URL/, bad);
        }
        assert.equal(sockets.length, 1);
        assert.equal(isValidIntifaceUrl('WSS://intiface.example.org:12345/'), true);
    });

    it('times out the handshake and closes the socket', async () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        ws.open();
        await sleep(INTIFACE_TIMINGS.handshakeMs + 30);
        assert.equal(ws.closed, true);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.equal(getIntifaceStatus().text, HANDSHAKE_TIMEOUT_TEXT);
        assert.equal(events.closes.length, 1);
        assert.equal(events.closes[0].wasConnected, false);
        assert.equal(events.closes[0].assignedDevices, 0);
    });

    it('a refused connection reports an error without a session pause flag', () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        if (ws.onerror) ws.onerror({});
        ws.dropped();
        assert.equal(getIntifaceStatus().state, 'error');
        assert.match(getIntifaceStatus().text, /Intiface Central is running/);
        assert.deepEqual(events.closes[0].wasConnected, false);
        assert.deepEqual(events.closes[0].assignedDevices, 0);
    });

    it('closes a previous socket before connecting again, detached', () => {
        const first = connectWith([EDGE]);
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        assert.equal(first.closed, true);
        assert.equal(first.messages('StopAllDevices').length, 1);
        const second = sockets[1];
        handshake(second, { devices: [OSR2] });
        // The old socket's late close must not wipe the new device list.
        if (first.onclose) first.onclose({});
        assert.equal(intifaceDevices.size, 1);
        assert.equal(intifaceDevices.get(1).name, OSR2.DeviceName);
        assert.equal(isIntifaceConnected(), true);
    });

    it('reports a lost connection with the assigned device count', () => {
        const ws = connectWith([EDGE, OSR2]);
        setAxisRole(0, 0, 'off');
        setAxisRole(0, 1, 'off');
        assert.equal(countAssignedIntifaceDevices(), 1);
        ws.dropped();
        assert.equal(events.closes.length, 1);
        assert.equal(events.closes[0].wasConnected, true);
        assert.equal(events.closes[0].assignedDevices, 1);
        assert.equal(events.closes[0].intentional, false);
        assert.equal(intifaceDevices.size, 0);
        assert.equal(isIntifaceConnected(), false);
    });

    it('sends StopAllDevices on disconnect and reports Offline', () => {
        const ws = connectWith([EDGE]);
        disconnectIntiface();
        assert.equal(ws.messages('StopAllDevices').length, 1);
        assert.equal(getIntifaceStatus().state, 'offline');
        assert.equal(events.closes[0].intentional, true);
    });
});

describe('protocol details', () => {
    it('pings at half MaxPingTime and stops on close', async () => {
        // MaxPingTime 200 -> a Ping every 100 ms.
        const ws = connectWith([], { maxPing: 200 });
        await sleep(260);
        const pings = ws.messages('Ping').length;
        assert.ok(pings >= 2, `expected pings, got ${pings}`);
        disconnectIntiface();
        await sleep(50);
        assert.equal(ws.messages('Ping').length, pings);
    });

    it('does not ping when MaxPingTime is 0', async () => {
        const ws = connectWith([]);
        await sleep(40);
        assert.equal(ws.messages('Ping').length, 0);
    });

    it('closes on a handshake error and surfaces the message', () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        ws.open();
        ws.receive({ Error: { Id: 1, ErrorMessage: 'Unsupported message version', ErrorCode: 1 } });
        assert.equal(ws.closed, true);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.equal(getIntifaceStatus().text, 'Unsupported message version');
    });

    it('flags an axis after three consecutive command errors and clears it on Ok', () => {
        const ws = connectWith([EDGE]);
        dispatchIntiface(50, 50, 0, 100);
        const first = ws.messages('ScalarCmd');
        assert.equal(first.length, 2);
        const axis = intifaceDevices.get(0).axes[0];
        const fail = (id) => ws.receive({ Error: { Id: id, ErrorMessage: 'Device write failed', ErrorCode: 4 } });
        fail(first[0].Id);
        assert.equal(axis.failing, false);
        assert.match(getIntifaceStatus().text, /Device write failed/);
        dispatchIntiface(60, 60, 0, 100);
        fail(ws.messages('ScalarCmd')[2].Id);
        dispatchIntiface(70, 70, 0, 100);
        fail(ws.messages('ScalarCmd')[4].Id);
        assert.equal(axis.failing, true);
        assert.equal(isIntifaceConnected(), true);
        dispatchIntiface(80, 80, 0, 100);
        ws.receive({ Ok: { Id: ws.messages('ScalarCmd')[6].Id } });
        assert.equal(axis.failing, false);
        assert.equal(getIntifaceStatus().text, 'Connected (Intiface Central, 1 device)');
    });
});

describe('dispatch', () => {
    it('deduplicates identical scalar values', () => {
        const ws = connectWith([EDGE]);
        dispatchIntiface(50, 50, 0, 100);
        dispatchIntiface(50, 50, 0, 100);
        dispatchIntiface(50, 50, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 2);
        // Both axes of an internal toy are secondary: a primary change is
        // ignored, a secondary change re-sends both.
        dispatchIntiface(55, 50, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 2);
        dispatchIntiface(55, 60, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 4);
    });

    it('sends one LinearCmd per leg with the full duration and no re-send in flight', async () => {
        const ws = connectWith([OSR2]);
        dispatchIntiface(100, 0, 20, 80);
        let legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 1);
        assert.equal(legs[0].Vectors[0].Position, 0.8);
        const duration = legs[0].Vectors[0].Duration;
        assert.ok(duration >= 120);
        // Engine ticks during the leg do not re-send.
        dispatchIntiface(100, 0, 20, 80);
        dispatchIntiface(90, 0, 20, 80);
        assert.equal(ws.messages('LinearCmd').length, 1);
        await sleep(duration + 30);
        legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Position, 0.2);
        await sleep(legs[1].Vectors[0].Duration + 30);
        assert.equal(ws.messages('LinearCmd').length, 3);
        assert.equal(ws.messages('LinearCmd')[2].Vectors[0].Position, 0.8);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('stop sends StopAllDevices then a single 400 ms rest move and goes quiet', async () => {
        const ws = connectWith([OSR2]);
        dispatchIntiface(0, 0, 0, 100, 10, 90, true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 1);
        assert.equal(legs[0].Vectors[0].Duration, REST_MOVE_MS);
        // Rest position is clamped into the hardware envelope (10 %).
        assert.equal(legs[0].Vectors[0].Position, 0.1);
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(0, 0, 0, 100, 10, 90, true);
        dispatchIntiface(0, 0, 0, 100, 10, 90);
        assert.equal(ws.messages('LinearCmd').length, 1);
    });

    it('OFF sends a single rest / zero and then nothing, plus StopDeviceCmd when the device is all OFF', async () => {
        const ws = connectWith([OSR2, EDGE]);
        dispatchIntiface(80, 80, 20, 80);
        const linearBefore = ws.messages('LinearCmd').length;
        assert.equal(linearBefore, 1);
        const firstLeg = ws.messages('LinearCmd')[0].Vectors[0].Duration;
        setAxisRole(1, 0, 'off');
        assert.equal(ws.messages('StopDeviceCmd').filter((m) => m.DeviceIndex === 1).length, 1);
        await sleep(firstLeg + 40);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(legs[1].Vectors[0].Position, 0.2);
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(80, 80, 20, 80);
        dispatchIntiface(90, 90, 20, 80);
        assert.equal(ws.messages('LinearCmd').length, 2);

        // Scalar OFF: one zero, then silence.
        const scalarsBefore = ws.messages('ScalarCmd').length;
        setAxisRole(0, 0, 'off');
        const zero = ws.messages('ScalarCmd')[scalarsBefore];
        assert.equal(zero.Scalars[0].Scalar, 0);
        dispatchIntiface(95, 95, 20, 80);
        const after = ws.messages('ScalarCmd').slice(scalarsBefore + 1);
        assert.ok(after.every((m) => m.Scalars[0].Index !== 0));
    });

    it('one axis OFF mid-leg on a multi-axis stroker rests that axis at once', async () => {
        const ws = connectWith([SR6]);
        const dev = intifaceDevices.get(3);
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'secondary']);
        dispatchIntiface(5, 5, 0, 100);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.ok(legs.every((m) => m.Vectors[0].Duration > 2000), 'slow legs are in flight');
        setAxisRole(3, 1, 'off');
        const after = ws.messages('LinearCmd');
        assert.equal(after.length, 3, 'the rest move goes out immediately, not after the leg');
        assert.equal(after[2].Vectors[0].Index, 1);
        assert.equal(after[2].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(after[2].Vectors[0].Position, 0);
        assert.equal(ws.messages('StopDeviceCmd').length, 0, 'the other axis keeps its leg');
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(5, 5, 0, 100);
        assert.equal(ws.messages('LinearCmd').length, 3, 'nothing more for the OFF axis');
    });

    it('applies the cap to scalars and honours linear invert', async () => {
        const ws = connectWith([EDGE, OSR2]);
        setAxisMaxCap(0, 1, 50);
        setAxisInvert(1, 0, true);
        dispatchIntiface(100, 100, 20, 80);
        const scalars = ws.messages('ScalarCmd').filter((m) => m.Scalars[0].Index === 1);
        assert.equal(scalars[scalars.length - 1].Scalars[0].Scalar, 0.5);
        const leg = ws.messages('LinearCmd')[0];
        assert.equal(leg.Vectors[0].Position, 0.2);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        await sleep(leg.Vectors[0].Duration + REST_MOVE_MS + 60);
    });

    it('invert mirrors inside the hardware envelope, never below its lower guard', async () => {
        const ws = connectWith([OSR2]);
        setAxisInvert(1, 0, true);
        dispatchIntiface(100, 0, 20, 90, 20, 90);
        const leg = ws.messages('LinearCmd')[0];
        // zone max 0.9 mirrored inside 0.2..0.9 -> 0.2, never 0.1
        assert.equal(leg.Vectors[0].Position, 0.2);
        // STOP: the rest move (envelope min 0.2) mirrors to 0.9, still inside.
        dispatchIntiface(0, 0, 0, 100, 20, 90, true);
        await sleep(leg.Vectors[0].Duration + 30);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(legs[1].Vectors[0].Position, 0.9);
        assert.ok(legs.every((m) => m.Vectors[0].Position >= 0.2 && m.Vectors[0].Position <= 0.9));
    });

    it('stopAllIntiface is a best-effort StopAllDevices', () => {
        const ws = connectWith([EDGE]);
        assert.equal(stopAllIntiface(), true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        disconnectIntiface();
        assert.equal(stopAllIntiface(), false);
    });
});

describe('rotation', () => {
    it('reverses on edge at most once per second and re-sends the new direction', () => {
        const ws = connectWith([VORZE]);
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        assert.equal(ws.messages('RotateCmd')[0].Rotations[0].Clockwise, true);
        const t0 = intifaceDevices.get(2).lastDirectionChangeAt;
        assert.equal(reverseIntifaceRotation('edge', t0 + 500), 0);
        assert.equal(reverseIntifaceRotation('edge', t0 + 1000), 1);
        const rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 2);
        assert.equal(rot[1].Rotations[0].Clockwise, false);
        assert.equal(reverseIntifaceRotation('edge', t0 + 1500), 0);
        setDeviceRotation(2, { reverseOnEdge: false });
        assert.equal(reverseIntifaceRotation('edge', t0 + 5000), 0);
    });

    it('alternates direction every N seconds while spinning', () => {
        const ws = connectWith([VORZE]);
        setDeviceRotation(2, { alternateSeconds: 5 });
        const dev = intifaceDevices.get(2);
        dev.lastDirectionChangeAt = Date.now() - 6000;
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        assert.equal(ws.messages('RotateCmd')[0].Rotations[0].Clockwise, false);
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        // Stopped rotator: no direction churn, one zero only.
        dispatchIntiface(0, 0, 0, 100);
        dev.lastDirectionChangeAt = Date.now() - 6000;
        dispatchIntiface(0, 0, 0, 100);
        const rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 2);
        assert.equal(rot[1].Rotations[0].Speed, 0);
        assert.equal(setDeviceRotation(2, { alternateSeconds: 999 }), true);
        assert.equal(dev.alternateSeconds, 60);
        setDeviceRotation(2, { alternateSeconds: 0 });
        assert.equal(dev.alternateSeconds, 0);
    });
});

describe('pulsed vibration', () => {
    function levels(ws, index) {
        return ws.messages('ScalarCmd').flatMap((cmd) => cmd.Scalars).filter((s) => s.Index === index).map((s) => s.Scalar);
    }

    it('holds the engine level for half the period, then rests, and a stop ends the train', async () => {
        const ws = connectWith([EDGE]);
        assert.equal(setAxisVibeMode(0, 0, { mode: 'pulsed', periodMs: 800 }), true);
        assert.equal(setAxisVibeMode(0, 0, { mode: 'nope' }), false);
        // Arming Pulsed while the engine is still at 0 sends that 0 once.
        // The first positive level is the peak, at once.
        dispatchIntiface(0, 50, 0, 100);
        assert.deepEqual(levels(ws, 0), [0, 0.5]);
        await sleep(420);
        assert.deepEqual(levels(ws, 0), [0, 0.5, 0]);
        await sleep(400);
        assert.deepEqual(levels(ws, 0), [0, 0.5, 0, 0.5]);
        const beforeStop = levels(ws, 0).length;
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        assert.equal(levels(ws, 0).at(-1), 0);
        await sleep(500);
        assert.equal(levels(ws, 0).length, beforeStop + 1, 'a stop cuts the train');
    });

    it('remembers Constant or Pulsed with the toy', () => {
        connectWith([EDGE]);
        setAxisVibeMode(0, 1, { mode: 'pulsed', periodMs: 2400 });
        const stored = JSON.parse(memory.get(INTIFACE_STORAGE_KEY));
        const axes = stored['Lovense Edge|S:Vibrate,Vibrate|L:|R:'].axes;
        assert.equal(axes['scalar:0'].vibeMode, 'constant');
        assert.equal(axes['scalar:0'].pulsePeriodMs, 1600);
        assert.equal(axes['scalar:1'].vibeMode, 'pulsed');
        assert.equal(axes['scalar:1'].pulsePeriodMs, 2400);
        disconnectIntiface();
        connectWith([{ ...EDGE, DeviceIndex: 4 }]);
        const edge = intifaceDevices.get(4);
        assert.equal(edge.axes[0].vibeMode, 'constant');
        assert.equal(edge.axes[1].vibeMode, 'pulsed');
        assert.equal(edge.axes[1].pulsePeriodMs, 2400);
    });
});

describe('persistence', () => {
    it('stores roles, caps, invert and rotation per device signature and reapplies them on reconnect', () => {
        connectWith([EDGE, OSR2, VORZE]);
        setAxisRole(0, 0, 'off');
        setAxisMaxCap(0, 1, 35);
        setAxisInvert(1, 0, true);
        setAxisRole(1, 0, 'secondary');
        setDeviceRotation(2, { reverseOnEdge: false, alternateSeconds: 12 });
        assert.equal(saveIntifaceConfig(), true);
        const stored = JSON.parse(memory.get(INTIFACE_STORAGE_KEY));
        assert.equal(stored['Lovense Edge|S:Vibrate,Vibrate|L:|R:'].axes['scalar:0'].role, 'off');
        assert.equal(stored['Lovense Edge|S:Vibrate,Vibrate|L:|R:'].axes['scalar:1'].maxCap, 35);
        disconnectIntiface();
        assert.equal(intifaceDevices.size, 0);

        // Re-enumerated with different DeviceIndex values: the mapping follows the signature.
        connectWith([
            { ...OSR2, DeviceIndex: 7 },
            { ...EDGE, DeviceIndex: 8 },
            { ...VORZE, DeviceIndex: 9 }
        ]);
        const edge = intifaceDevices.get(8);
        assert.equal(edge.axes[0].role, 'off');
        assert.equal(edge.axes[1].maxCap, 35);
        const osr = intifaceDevices.get(7);
        assert.equal(osr.axes[0].invert, true);
        assert.equal(osr.axes[0].role, 'secondary');
        const vorze = intifaceDevices.get(9);
        assert.equal(vorze.reverseOnEdge, false);
        assert.equal(vorze.alternateSeconds, 12);
    });

    it('survives corrupt storage', () => {
        memory.set(INTIFACE_STORAGE_KEY, '{not json');
        connectWith([OSR2]);
        assert.equal(intifaceDevices.get(1).axes[0].role, 'primary');
        assert.equal(saveIntifaceConfig(), true);
    });
});
