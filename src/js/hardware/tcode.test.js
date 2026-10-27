// Driver tests with a fake Web Serial port built on the standard streams
// (ReadableStream / WritableStream). No real hardware, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    TCODE_TIMINGS,
    TCODE_STORAGE_KEY,
    connectTCode,
    disconnectTCode,
    dispatchTCode,
    stopTCode,
    setAxisRole,
    setAxisCap,
    setAxisInvert,
    testAxis,
    saveTCodeConfig,
    isTCodeConnected,
    isSerialSupported,
    getTCodeStatus,
    getTCodeDevice,
    countAssignedTCodeAxes,
    tcodeHasRole,
    resetTCodeForTests,
    setTCodeScriptFeed
} from './tcode.js';
import { REST_MOVE_MS, FAST_LEG_MS, legDurationMs } from './stroke-planner.js';

const OSR_REPLIES = {
    D0: ['OSR2 Test Rig'],
    D1: ['TCode v0.3'],
    D2: ['L0 stroke', 'R0 twist', 'R1 roll', 'V0 vibe']
};
const SR6_REPLIES = {
    D0: ['SR6'],
    D1: ['TCode v0.3'],
    D2: ['L0 stroke', 'L1 surge', 'L2 sway', 'R0 twist', 'R1 roll', 'R2 pitch', 'V0 vibe']
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Writes go through a promise chain: let them land on the fake port.
function flush() {
    return sleep(3);
}

// A SerialPort stand-in. Writes are decoded and, when they match a reply
// table, answered on the readable side; the test can also push bytes,
// close or error the readable stream and fire 'disconnect'.
function makeFakePort(replies = OSR_REPLIES) {
    const written = [];
    const listeners = {};
    let enqueue = null;
    let closeReadable = null;
    let errorReadable = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const readable = new ReadableStream({
        start(controller) {
            enqueue = (text) => { try { controller.enqueue(encoder.encode(text)); } catch (e) {} };
            closeReadable = () => { try { controller.close(); } catch (e) {} };
            errorReadable = (err) => { try { controller.error(err); } catch (e) {} };
        }
    });
    const port = {
        readable: null,
        writable: null,
        opened: false,
        closed: false,
        openOptions: null,
        failWrites: false,
        written,
        async open(options) {
            this.openOptions = options;
            this.opened = true;
        },
        async close() {
            this.closed = true;
        },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
        fire(type) { (listeners[type] || []).forEach((fn) => fn({ target: port })); },
        listenerCount(type) { return (listeners[type] || []).length; },
        push(text) { enqueue(text); },
        closeReadable() { closeReadable(); },
        errorReadable(err) { errorReadable(err); }
    };
    port.readable = readable;
    port.writable = new WritableStream({
        write(chunk) {
            if (port.failWrites) throw new Error('device gone');
            const text = decoder.decode(chunk);
            written.push(text);
            const cmd = text.trim();
            // A reply table entry may be a function (answers can differ per query).
            const reply = replies && typeof replies[cmd] === 'function' ? replies[cmd]() : (replies ? replies[cmd] : null);
            if (reply) reply.forEach((line) => enqueue(`${line}\n`));
        }
    });
    return port;
}

let port = null;
let serialListeners = {};
let requestPortImpl = null;
let store = {};
let events = { status: [], changed: 0, close: [], errors: [] };

function installNavigator({ serial = true, userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128' } = {}) {
    const value = { userAgent };
    if (serial) {
        value.serial = {
            requestPort: () => requestPortImpl(),
            addEventListener(type, fn) { (serialListeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) { serialListeners[type] = (serialListeners[type] || []).filter((f) => f !== fn); }
        };
    }
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function installStorage() {
    store = {};
    globalThis.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    };
}

function handlers() {
    return {
        onStatus: (s) => events.status.push(s),
        onDevicesChanged: () => { events.changed += 1; },
        onClose: (info) => events.close.push(info),
        onError: (text) => events.errors.push(text)
    };
}

function lines() {
    return port.written.map((w) => w.trim());
}

function lastLine() {
    const all = lines();
    return all[all.length - 1];
}

// Connect and wait for the post-connect rest move to finish, so every axis
// is free for the next command.
async function connect(replies = OSR_REPLIES) {
    port = makeFakePort(replies);
    requestPortImpl = async () => port;
    const ok = await connectTCode(handlers());
    await sleep(TCODE_TIMINGS.restMs + 5);
    return ok;
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalStorage = globalThis.localStorage;

beforeEach(() => {
    resetTCodeForTests();
    TCODE_TIMINGS.bootQuietMs = 10;
    TCODE_TIMINGS.bootCapMs = 40;
    TCODE_TIMINGS.identifyMs = 40;
    TCODE_TIMINGS.replyQuietMs = 15;
    TCODE_TIMINGS.restMs = 30;
    TCODE_TIMINGS.testMoveMs = 20;
    TCODE_TIMINGS.testHoldMs = 20;
    TCODE_TIMINGS.closeGraceMs = 50;
    serialListeners = {};
    events = { status: [], changed: 0, close: [], errors: [] };
    installNavigator();
    installStorage();
});

afterEach(async () => {
    await disconnectTCode();
    resetTCodeForTests();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    globalThis.localStorage = originalStorage;
});

describe('feature detection', () => {
    it('reports the supporting browsers when Web Serial is missing', async () => {
        installNavigator({ serial: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0' });
        assert.equal(isSerialSupported(), false);
        const ok = await connectTCode(handlers());
        assert.equal(ok, false);
        assert.equal(getTCodeStatus().state, 'error');
        assert.match(getTCodeStatus().text, /Firefox does not implement Web Serial/);
        assert.match(getTCodeStatus().text, /Chrome and Edge on a desktop/);
        assert.equal(isTCodeConnected(), false);
    });
    it('turns a cancelled chooser and a busy port into readable status text', async () => {
        requestPortImpl = async () => { const e = new Error('no port'); e.name = 'NotFoundError'; throw e; };
        assert.equal(await connectTCode(handlers()), false);
        assert.match(getTCodeStatus().text, /No port selected/);

        port = makeFakePort();
        port.open = async () => { const e = new Error('Failed to open serial port.'); e.name = 'NetworkError'; throw e; };
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), false);
        assert.match(getTCodeStatus().text, /Close Intiface Central/);
        assert.match(getTCodeStatus().text, /dialout/);
        assert.equal(isTCodeConnected(), false);
    });
});

describe('connect and identify', () => {
    it('opens at 115200 8N1, identifies the device and rests every axis', async () => {
        assert.equal(await connect(), true);
        assert.deepEqual(port.openOptions, { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
        assert.equal(isTCodeConnected(), true);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'OSR2 Test Rig');
        assert.equal(dev.version, 'TCode v0.3');
        assert.equal(dev.identified, true);
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'R0', 'R1', 'V0']);
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'off', 'off', 'secondary']);
        assert.deepEqual(dev.axes.map((a) => a.kind), ['linear', 'rotate', 'rotate', 'vibe']);
        assert.equal(countAssignedTCodeAxes(), 2);
        assert.equal(tcodeHasRole('primary'), true);
        assert.equal(tcodeHasRole('secondary'), true);
        assert.deepEqual(lines().slice(0, 3), ['D0', 'D1', 'D2']);
        // The first motion line is the rest move on one line.
        assert.equal(lines()[3], `L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        assert.equal(getTCodeStatus().state, 'connected');
        assert.match(getTCodeStatus().text, /OSR2 Test Rig, TCode v0\.3/);
        assert.deepEqual(events.status.map((s) => s.state), ['connecting', 'connecting', 'handshake', 'handshake', 'connected']);
        assert.equal(port.listenerCount('disconnect'), 1);
    });
    it('falls back to the OSR2 axis set when the device stays silent', async () => {
        const started = Date.now();
        assert.equal(await connect({}), true);
        const elapsed = Date.now() - started;
        // Settle, then D0 twice (a silent first query is retried), D1, D2.
        assert.ok(elapsed < 4 * TCODE_TIMINGS.identifyMs + TCODE_TIMINGS.bootCapMs + 200, `identification took ${elapsed} ms`);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'TCode device');
        assert.equal(dev.version, '');
        assert.equal(dev.identified, false);
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'R0', 'R1', 'R2', 'V0']);
        assert.equal(isTCodeConnected(), true);
    });
    it('names a silent device after its USB ids and keeps its settings apart', async () => {
        port = makeFakePort({});
        port.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'TCode device 1a86:7523');
        assert.equal(dev.identified, false);
        assert.match(getTCodeStatus().text, /TCode device 1a86:7523/);
        setAxisCap(0, 40);
        const saved = JSON.parse(store[TCODE_STORAGE_KEY]);
        assert.equal(saved['TCode device 1a86:7523'].axes.L0.maxCap, 40);
        assert.equal(saved['TCode device'], undefined);
        // A port whose getInfo() throws still connects under the plain name.
        await disconnectTCode();
        port = makeFakePort({});
        port.getInfo = () => { throw new Error('no info'); };
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        assert.equal(getTCodeDevice().name, 'TCode device');
    });
    it('ignores a command echo and unsolicited chatter', async () => {
        assert.equal(await connect({ D0: ['D0', 'SR6'], D1: ['D1', 'v0.3'], D2: ['D2', 'L0 stroke', 'L1 surge', 'OK'] }), true);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'SR6');
        assert.equal(dev.version, 'v0.3');
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'L1']);
        port.push('debug: hello\nnoise\n');
        await sleep(5);
        assert.equal(isTCodeConnected(), true);
    });
});

describe('dispatch', () => {
    it('drives L0 one leg at a time and never re-sends mid-leg', async () => {
        await connect();
        const before = port.written.length;
        dispatchTCode(100, 0, 20, 80, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
        // From the rest position (0) to the zone top: an 80 % move, timed as such.
        const duration = legDurationMs(100, 0.8);
        assert.equal(lastLine(), `L08000I${duration}`);
        // Ticks while the leg is in flight change nothing.
        dispatchTCode(100, 0, 20, 80, 0, 100);
        dispatchTCode(90, 0, 20, 80, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
        await sleep(duration + 20);
        // The timer issued the return leg with the NEW speed applied.
        assert.equal(port.written.length, before + 2);
        assert.equal(lastLine(), `L02000I${legDurationMs(90, 0.6)}`);
    });
    it('feeds the secondary channel to V0 and deduplicates', async () => {
        await connect();
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.ok(lines().includes('V05000'), lines().join(' | '));
        const count = port.written.length;
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.equal(port.written.length, count, 'identical scalar was re-sent');
        dispatchTCode(0, 0, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V00000');
    });
    it('swings a rotation axis around the centre by speed and cap', async () => {
        await connect();
        assert.equal(setAxisRole(1, 'primary'), true);
        setAxisCap(1, 50);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await flush();
        // amplitude 0.5 * 1.0 * 0.5 = 0.25 -> zone 0.25..0.75; effective speed
        // 50 %; the swing period follows the speed alone, not the amplitude
        const rot = lines().filter((l) => l.startsWith('R0'));
        assert.equal(rot[rot.length - 1], `R07500I${legDurationMs(50, 1)}`);
    });
    it('applies the cap and the invert flag to linear axes', async () => {
        await connect();
        setAxisCap(0, 50);
        setAxisInvert(0, true);
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await flush();
        // effective speed 50 % over full travel; inverted: 1 - 1 = 0
        assert.equal(lastLine(), `L00000I${legDurationMs(50, 1)}`);
    });
    it('invert mirrors inside the hardware envelope, never below its lower guard', async () => {
        await connect();
        setAxisInvert(0, true);
        dispatchTCode(100, 0, 20, 90, 20, 90);
        await flush();
        // zone max 0.9 mirrored inside 0.2..0.9 -> 0.2, never 0.1 (from rest 0: a 90 % move)
        assert.equal(lastLine(), `L02000I${legDurationMs(100, 0.9)}`);
        stopTCode();
        await flush();
        // rest = envelope min 0.2 mirrored -> 0.9
        assert.match(lastLine(), new RegExp(`^L09000I${TCODE_TIMINGS.restMs} `));
    });
    it('clamps the zone into the hardware envelope', async () => {
        await connect();
        dispatchTCode(100, 0, 0, 100, 10, 90);
        await flush();
        assert.equal(lastLine(), `L09000I${legDurationMs(100, 0.9)}`);
    });
    it('a rotation axis swings slower, not faster, at a low speed', async () => {
        await connect();
        assert.equal(setAxisRole(1, 'primary'), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(10, 0, 0, 100, 0, 100);
        await flush();
        const rot = lines().filter((l) => l.startsWith('R0'));
        const slow = Number(rot[rot.length - 1].split('I')[1]);
        assert.equal(slow, legDurationMs(10, 1));
        assert.ok(slow > legDurationMs(50, 1));
    });
    it('role OFF mid-leg rests the axis at once instead of after the running stroke', async () => {
        await connect();
        dispatchTCode(5, 0, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), `L09999I${legDurationMs(5, 1)}`);
        const before = port.written.length;
        setAxisRole(0, 'off');
        await flush();
        assert.equal(port.written.length, before + 1, 'the rest line is written without waiting for the leg');
        assert.equal(lastLine(), `L00000I${TCODE_TIMINGS.restMs}`);
        await sleep(TCODE_TIMINGS.restMs + 10);
        assert.equal(port.written.length, before + 1, 'and nothing after it');
    });
    it('rests an axis whose role is switched OFF', async () => {
        await connect();
        dispatchTCode(0, 60, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V06000');
        setAxisRole(3, 'off');
        await flush();
        assert.equal(lastLine(), 'V00000');
        assert.equal(countAssignedTCodeAxes(), 1);
    });
    it('never throws when nothing is connected', () => {
        assert.doesNotThrow(() => dispatchTCode(100, 100, 0, 100, 0, 100));
        assert.doesNotThrow(() => dispatchTCode('x', null, undefined, NaN));
        assert.equal(stopTCode(), false);
        assert.equal(setAxisRole(0, 'primary'), false);
        assert.equal(testAxis(0), false);
    });
});

describe('surge and sway', () => {
    it('rest at the mechanical centre on connect and on STOP, never in a corner', async () => {
        assert.equal(await connect(SR6_REPLIES), true);
        const r = TCODE_TIMINGS.restMs;
        assert.deepEqual(getTCodeDevice().axes.map((a) => a.role), ['primary', 'off', 'off', 'off', 'off', 'off', 'secondary']);
        assert.equal(lines()[3], `L00000I${r} L15000I${r} L25000I${r} R05000I${r} R15000I${r} R25000I${r} V00000`);
        dispatchTCode(100, 0, 0, 100, 20, 90);
        await flush();
        stopTCode();
        await flush();
        assert.equal(lastLine(), `L02000I${r} L15000I${r} L25000I${r} R05000I${r} R15000I${r} R25000I${r} V00000`);
    });
    it('an assigned surge axis swings around the centre like a rotation axis', async () => {
        assert.equal(await connect(SR6_REPLIES), true);
        assert.equal(setAxisRole(1, 'primary'), true);
        setAxisCap(1, 50);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(100, 0, 20, 80, 0, 100);
        await flush();
        const surge = lines().filter((l) => l.startsWith('L1'));
        // amplitude 0.25 around 0.5, timed by the speed alone; L0 still strokes the zone
        assert.equal(surge[surge.length - 1], `L17500I${legDurationMs(50, 1)}`);
        const stroke = lines().filter((l) => l.startsWith('L0'));
        assert.match(stroke[stroke.length - 1], /^L08000I/);
    });
});

describe('stop', () => {
    it('a forced zero dispatch rests every axis on one line, inside the envelope', async () => {
        await connect();
        dispatchTCode(100, 80, 20, 80, 10, 90);
        await flush();
        const before = port.written.length;
        dispatchTCode(0, 0, 0, 100, 10, 90, true);
        await flush();
        assert.equal(port.written.length, before + 1);
        assert.equal(lastLine(), `L01000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        // STOP interrupts the leg in flight: the very next tick may move again.
        await sleep(TCODE_TIMINGS.restMs + 10);
        dispatchTCode(100, 0, 20, 80, 10, 90);
        await flush();
        assert.match(lastLine(), /^L08000I\d+$/);
    });
    it('honours invert on the rest move', async () => {
        await connect();
        setAxisInvert(0, true);
        stopTCode();
        await flush();
        assert.match(lastLine(), new RegExp(`^L09999I${TCODE_TIMINGS.restMs} `));
    });
});

describe('loss of the device', () => {
    it('a disconnect event marks the device offline and reports the assigned axes', async () => {
        await connect();
        dispatchTCode(100, 50, 0, 100, 0, 100);
        port.fire('disconnect');
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeDevice(), null);
        assert.equal(getTCodeStatus().state, 'error');
        assert.match(getTCodeStatus().text, /unplugged/);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, false);
        assert.equal(events.close[0].wasConnected, true);
        assert.equal(events.close[0].assignedAxes, 2);
        assert.equal(port.listenerCount('disconnect'), 0);
        assert.doesNotThrow(() => dispatchTCode(100, 0, 0, 100, 0, 100));
    });
    it('a failed write ends the session exactly once', async () => {
        await connect();
        port.failWrites = true;
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await sleep(30);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, false);
        assert.ok(events.errors.some((t) => /Write to the serial port failed/.test(t)));
    });
    it('a closed readable stream is treated as a lost device', async () => {
        await connect();
        port.closeReadable();
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.match(events.close[0].text, /closed/);
    });
    it('a read error is reported and closes the session', async () => {
        await connect();
        port.errorReadable(new Error('bus error'));
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.ok(events.errors.some((t) => /Serial read failed: bus error/.test(t)));
        assert.equal(events.close.length, 1);
    });
    it('losing the port during identification fails the connect', async () => {
        port = makeFakePort({});
        requestPortImpl = async () => port;
        const pending = connectTCode(handlers());
        await sleep(10);
        port.fire('disconnect');
        assert.equal(await pending, false);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].wasConnected, false);
    });
});

describe('disconnect', () => {
    it('rests every axis, flushes and releases the port', async () => {
        await connect();
        dispatchTCode(100, 50, 0, 100, 0, 100);
        assert.equal(await disconnectTCode(), true);
        assert.equal(port.closed, true);
        assert.match(lastLine(), new RegExp(`^L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000$`));
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeStatus().state, 'offline');
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, true);
        assert.equal(events.close[0].assignedAxes, 2);
        assert.equal(await disconnectTCode(), false);
        assert.equal(events.close.length, 1);
    });
    it('refuses motion while the rest line is being flushed', async () => {
        await connect();
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V05000');
        const closing = disconnectTCode();
        assert.equal(isTCodeConnected(), false, 'a closing session is not connected');
        // An engine tick landing in the flush window must not reach the port.
        dispatchTCode(0, 60, 0, 100, 0, 100);
        assert.equal(testAxis(3), false);
        assert.equal(await closing, true);
        assert.equal(port.closed, true);
        assert.equal(lastLine(), `L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        assert.ok(!lines().includes('V06000'), lines().join(' | '));
    });
    it('a second Connect while the chooser is open is ignored', async () => {
        port = makeFakePort();
        let release = null;
        requestPortImpl = () => new Promise((resolve) => { release = () => resolve(port); });
        const first = connectTCode(handlers());
        await sleep(5);
        assert.equal(await connectTCode(handlers()), false);
        release();
        assert.equal(await first, true);
        assert.equal(isTCodeConnected(), true);
    });
    it('Disconnect while the chooser is open cancels the connect', async () => {
        port = makeFakePort();
        let release = null;
        requestPortImpl = () => new Promise((resolve) => { release = () => resolve(port); });
        const pending = connectTCode(handlers());
        await sleep(5);
        assert.equal(getTCodeStatus().state, 'connecting');
        assert.equal(await disconnectTCode(), true);
        assert.equal(getTCodeStatus().state, 'offline');
        release();
        assert.equal(await pending, false);
        assert.equal(port.opened, false, 'a port picked after Disconnect must not be opened');
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeStatus().state, 'offline');
        // The driver is usable again straight away.
        await connect();
        assert.equal(isTCodeConnected(), true);
    });
    it('a second connect replaces the first port', async () => {
        await connect();
        const first = port;
        await connect();
        assert.equal(first.closed, true);
        assert.equal(port.closed, false);
        assert.equal(isTCodeConnected(), true);
        assert.equal(events.close.length, 1);
    });
});

describe('persistence', () => {
    it('remembers roles, caps and invert per device name', async () => {
        await connect();
        setAxisRole(1, 'secondary');
        setAxisCap(0, 65);
        setAxisInvert(0, true);
        setAxisRole(3, 'off');
        const saved = JSON.parse(store[TCODE_STORAGE_KEY]);
        assert.deepEqual(saved['OSR2 Test Rig'].axes.L0, { role: 'primary', maxCap: 65, invert: true });
        assert.deepEqual(saved['OSR2 Test Rig'].axes.R0, { role: 'secondary', maxCap: 100, invert: false });
        assert.deepEqual(saved['OSR2 Test Rig'].axes.V0, { role: 'off', maxCap: 100, invert: false });
        await disconnectTCode();
        await connect();
        const dev = getTCodeDevice();
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'secondary', 'off', 'off']);
        assert.equal(dev.axes[0].maxCap, 65);
        assert.equal(dev.axes[0].invert, true);
        assert.equal(saveTCodeConfig(), true);
    });
    it('ignores corrupt saved data and refuses bad roles', async () => {
        store[TCODE_STORAGE_KEY] = '{"OSR2 Test Rig": {"axes": {"L0": {"role": "sideways", "maxCap": "lots", "invert": 1}}}}';
        await connect();
        const axis = getTCodeDevice().axes[0];
        assert.equal(axis.role, 'primary');
        assert.equal(axis.maxCap, 100);
        assert.equal(axis.invert, true);
        assert.equal(setAxisRole(0, 'sideways'), false);
        assert.equal(setAxisInvert(1, true), false, 'invert is linear-only');
    });
});

describe('test button', () => {
    it('moves a linear axis up and back', async () => {
        await connect();
        dispatchTCode(0, 0, 20, 80, 0, 100);
        await flush();
        const before = port.written.length;
        assert.equal(testAxis(0), true);
        await flush();
        assert.equal(lastLine(), `L08000I${TCODE_TIMINGS.testMoveMs}`);
        assert.equal(testAxis(0), false, 'a second test while one runs is refused');
        await sleep(TCODE_TIMINGS.testMoveMs + 70);
        assert.equal(port.written.length, before + 2);
        assert.equal(lastLine(), `L02000I${TCODE_TIMINGS.testMoveMs}`);
    });
    it('buzzes a vibe axis briefly at 60 % of its cap', async () => {
        await connect();
        setAxisCap(3, 50);
        assert.equal(testAxis(3), true);
        await flush();
        assert.equal(lastLine(), 'V03000');
        await sleep(TCODE_TIMINGS.testHoldMs + 20);
        assert.equal(lastLine(), 'V00000');
    });
    it('turns a rotation axis a quarter turn and back', async () => {
        await connect();
        assert.equal(testAxis(1), true);
        await flush();
        assert.equal(lastLine(), `R07500I${TCODE_TIMINGS.testMoveMs}`);
        await sleep(TCODE_TIMINGS.testMoveMs + 70);
        assert.equal(lastLine(), `R05000I${TCODE_TIMINGS.testMoveMs}`);
    });
});

describe('auto-resetting boards', () => {
    it('drains boot chatter before D0 and never takes the banner for a name', async () => {
        port = makeFakePort(OSR_REPLIES);
        const open = port.open.bind(port);
        port.open = async (options) => {
            await open(options);
            // An ESP32 prints its ROM banner right after the DTR toggle.
            setTimeout(() => port.push('ets Jul 29 2019 12:21:46\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'), 2);
        };
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        assert.equal(getTCodeDevice().name, 'OSR2 Test Rig');
        assert.equal(getTCodeDevice().version, 'TCode v0.3');
        assert.equal(lines()[0], 'D0');
        assert.ok(events.status.some((s) => /settle/i.test(s.text)));
    });
    it('asks D0 again when the first query was swallowed by the reboot', async () => {
        let queries = 0;
        const replies = {
            ...OSR_REPLIES,
            D0: () => (queries++ === 0 ? ['ets Jul 29 2019 12:21:46'] : ['OSR2 Test Rig'])
        };
        assert.equal(await connect(replies), true);
        assert.equal(lines().filter((l) => l === 'D0').length, 2);
        assert.equal(getTCodeDevice().name, 'OSR2 Test Rig');
        assert.equal(getTCodeDevice().identified, true);
    });
    it('a silent device gets one D0 retry and then the fallback', async () => {
        assert.equal(await connect({}), true);
        assert.equal(lines().filter((l) => l === 'D0').length, 2);
        assert.equal(lines().filter((l) => l === 'D1').length, 1);
        assert.equal(getTCodeDevice().name, 'TCode device');
    });
});

describe('secure origin', () => {
    it('tells desktop Chrome on a plain http origin about the secure-origin rule', async () => {
        installNavigator({ serial: false });
        globalThis.isSecureContext = false;
        try {
            assert.equal(await connectTCode(handlers()), false);
            assert.match(getTCodeStatus().text, /secure origin/);
            assert.match(getTCodeStatus().text, /https:\/\/ or http:\/\/localhost/);
        } finally {
            delete globalThis.isSecureContext;
        }
    });
});

describe('a funscript on L0', () => {
    function feedAt(t, x) {
        return {
            isActive: () => true,
            hasTime: () => true,
            scriptNow: () => t,
            generation: () => 1,
            shape: () => ({ points: [{ t: t + 400, x }], reason: 'stroke', vCap: 400, vJoin: 0.002, join: null }),
            positionAt: () => x,
            reportError() {}
        };
    }

    it('plays the script position instead of oscillating the allowance', async () => {
        await connect();
        setTCodeScriptFeed(feedAt(1000, 0.42));
        const before = lines().length;
        dispatchTCode(100, 40, 0, 100, 0, 100);
        await flush();
        const sent = lines().slice(before);
        assert.ok(sent.some((line) => line.startsWith('L04200I')), sent.join(' | '));
        assert.ok(!sent.some((line) => /^L0(0000|9999|10000)/.test(line)), sent.join(' | '));
        assert.ok(sent.some((line) => line.startsWith('V04000')), sent.join(' | '));
    });

    it('leaves L0 on the stroke planner when the script is not driving', async () => {
        await connect();
        setTCodeScriptFeed({ ...feedAt(1000, 0.42), isActive: () => false });
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), `L09999I${legDurationMs(100, 1)}`);
    });
});

describe('planner constants', () => {
    it('rest defaults match the shared planner', () => {
        assert.equal(REST_MOVE_MS, 400);
        assert.equal(FAST_LEG_MS, 180);
    });
});
