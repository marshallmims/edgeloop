import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectBleHeartRate, disconnectBle, isBleConnected, bindBlePageLifecycle } from './ble.js';

function fakeDevice(name, { failTimes = 0, stale = false } = {}) {
    let connected = stale;
    let failsLeft = failTimes;
    const server = {
        get connected() { return connected; },
        async connect() {
            if (failsLeft > 0) {
                failsLeft -= 1;
                const error = new Error('GATT connection failed');
                error.name = 'NetworkError';
                throw error;
            }
            connected = true;
            return server;
        },
        disconnect() { connected = false; },
        async getPrimaryService() {
            return {
                async getCharacteristic() {
                    return {
                        async startNotifications() {},
                        addEventListener() {},
                        removeEventListener() {}
                    };
                }
            };
        }
    };
    return {
        name,
        forgotten: false,
        gatt: server,
        addEventListener() {},
        removeEventListener() {},
        async forget() { this.forgotten = true; }
    };
}

function installBluetooth({ devices = [], requested = null } = {}) {
    let asked = 0;
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            bluetooth: {
                async getDevices() { return devices; },
                async requestDevice() {
                    asked += 1;
                    if (!requested) {
                        const error = new Error('chooser');
                        error.name = 'NotFoundError';
                        throw error;
                    }
                    return requested;
                }
            }
        },
        configurable: true,
        writable: true
    });
    return { asks: () => asked };
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeEach(() => {
    disconnectBle({ silent: true });
});

afterEach(() => {
    disconnectBle({ silent: true });
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
});

describe('HeartCast can be paired again after a refresh', () => {
    it('reconnects a sensor this site already has permission for', async () => {
        const known = fakeDevice('HeartCast');
        const chooser = installBluetooth({ devices: [known] });
        const device = await connectBleHeartRate({});
        assert.equal(device, known);
        assert.equal(chooser.asks(), 0);
        assert.equal(isBleConnected(), true);
    });

    it('drops a stale link, and forgets the grant when the peripheral still refuses', async () => {
        const known = fakeDevice('HeartCast', { failTimes: 2, stale: true });
        let disconnected = 0;
        const realDisconnect = known.gatt.disconnect.bind(known.gatt);
        known.gatt.disconnect = () => {
            disconnected += 1;
            realDisconnect();
        };
        const fresh = fakeDevice('HeartCast');
        const chooser = installBluetooth({ devices: [known], requested: fresh });
        const device = await connectBleHeartRate({});
        assert.equal(known.forgotten, true);
        assert.ok(disconnected >= 1, 'the stale GATT link was left up');
        assert.equal(chooser.asks(), 1);
        assert.equal(device, fresh);
        assert.equal(isBleConnected(), true);
    });

    it('drops the link when the page hides or freezes', async () => {
        const known = fakeDevice('HeartCast');
        installBluetooth({ devices: [known] });
        await connectBleHeartRate({});
        assert.equal(known.gatt.connected, true);
        const target = {
            listeners: {},
            document: { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } },
            addEventListener(type, fn) { this.listeners[type] = fn; }
        };
        bindBlePageLifecycle(target);
        target.listeners.pagehide();
        assert.equal(isBleConnected(), false);
        assert.equal(known.gatt.connected, false);
        await connectBleHeartRate({});
        target.document.listeners.freeze();
        assert.equal(isBleConnected(), false);
    });

    it('the page binds that lifecycle', () => {
        const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
        assert.match(app, /bindBlePageLifecycle\(window\)/);
    });
});
