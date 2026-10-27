import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLE_RECONNECT_DELAYS_MS,
    reconnectDelayMs,
    parseHeartRateMeasurement,
    describeBluetoothSupport,
    linuxDesktop,
    CHROME_BLUETOOTH_FLAG,
    describeBleError
} from './ble-protocol.js';

function view(bytes) {
    return new DataView(Uint8Array.from(bytes).buffer);
}

describe('reconnectDelayMs', () => {
    it('follows the 1 s / 2 s / 4 s schedule and then gives up', () => {
        assert.deepEqual([...BLE_RECONNECT_DELAYS_MS], [1000, 2000, 4000]);
        assert.equal(reconnectDelayMs(1), 1000);
        assert.equal(reconnectDelayMs(2), 2000);
        assert.equal(reconnectDelayMs(3), 4000);
        assert.equal(reconnectDelayMs(4), null);
        assert.equal(reconnectDelayMs(0), null);
        assert.equal(reconnectDelayMs('x'), null);
    });
});

describe('parseHeartRateMeasurement', () => {
    it('decodes an 8-bit BPM without contact support', () => {
        const out = parseHeartRateMeasurement(view([0x00, 72]));
        assert.equal(out.bpm, 72);
        assert.equal(out.sensorContact, null);
        assert.equal(out.energyExpended, null);
        assert.deepEqual(out.rrIntervalsMs, []);
    });

    it('decodes a 16-bit little-endian BPM', () => {
        const out = parseHeartRateMeasurement(view([0x01, 0x2C, 0x01]));
        assert.equal(out.bpm, 300);
    });

    it('reads the sensor-contact bits', () => {
        assert.equal(parseHeartRateMeasurement(view([0b110, 80])).sensorContact, true);
        assert.equal(parseHeartRateMeasurement(view([0b100, 0])).sensorContact, false);
        assert.equal(parseHeartRateMeasurement(view([0b010, 80])).sensorContact, null);
    });

    it('reports a 0 BPM packet as a packet, not as garbage', () => {
        const out = parseHeartRateMeasurement(view([0b100, 0]));
        assert.equal(out.bpm, 0);
        assert.equal(out.sensorContact, false);
    });

    it('skips energy expended and collects RR intervals', () => {
        // flags: uint8 BPM, contact detected, energy present, RR present.
        const out = parseHeartRateMeasurement(view([0b11110, 90, 0x10, 0x00, 0x00, 0x04, 0x00, 0x03]));
        assert.equal(out.bpm, 90);
        assert.equal(out.energyExpended, 16);
        // 0x0400 = 1024 units = 1000 ms, 0x0300 = 768 units = 750 ms.
        assert.deepEqual(out.rrIntervalsMs, [1000, 750]);
    });

    it('tolerates a truncated RR tail', () => {
        const out = parseHeartRateMeasurement(view([0b10000, 88, 0x00]));
        assert.equal(out.bpm, 88);
        assert.deepEqual(out.rrIntervalsMs, []);
    });

    it('ignores values too short to carry a BPM', () => {
        assert.equal(parseHeartRateMeasurement(view([])), null);
        assert.equal(parseHeartRateMeasurement(view([0x00])), null);
        assert.equal(parseHeartRateMeasurement(view([0x01, 0x50])), null);
        assert.equal(parseHeartRateMeasurement(null), null);
        assert.equal(parseHeartRateMeasurement({}), null);
    });
});

describe('linuxDesktop', () => {
    it('is Linux desktop only', () => {
        assert.equal(linuxDesktop('Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0'), true);
        assert.equal(linuxDesktop('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0'), false);
        assert.equal(linuxDesktop('Mozilla/5.0 (X11; CrOS x86_64) Chrome/120.0'), false);
        assert.equal(linuxDesktop('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0'), false);
        assert.equal(CHROME_BLUETOOTH_FLAG, 'chrome://flags/#enable-experimental-web-platform-features');
    });
});

describe('describeBluetoothSupport', () => {
    it('names Chrome/Edge and Bluefy on a generic desktop', () => {
        const msg = describeBluetoothSupport('Mozilla/5.0 (Windows NT 10.0) Firefox/120.0');
        assert.match(msg, /Chrome or Edge/);
        assert.match(msg, /Bluefy/);
        assert.doesNotMatch(msg, /chrome:\/\/flags/);
    });

    it('mentions the experimental flag on Linux only', () => {
        const linux = describeBluetoothSupport('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0');
        assert.match(linux, /chrome:\/\/flags\/#enable-experimental-web-platform-features/);
        const android = describeBluetoothSupport('Mozilla/5.0 (Linux; Android 14; Pixel 8) Firefox/120.0');
        assert.doesNotMatch(android, /chrome:\/\/flags/);
    });

    it('points iOS users at Bluefy', () => {
        const ios = describeBluetoothSupport('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
        assert.match(ios, /Bluefy/);
        assert.match(ios, /iOS/);
    });
});

describe('describeBleError', () => {
    it('distinguishes a closed chooser from real failures', () => {
        const cancelled = describeBleError({ name: 'NotFoundError', message: 'User cancelled the requestDevice() chooser.' });
        assert.equal(cancelled.kind, 'cancelled');
        assert.match(cancelled.message, /No sensor selected/);
        const other = describeBleError({ name: 'NetworkError', message: 'GATT Server is disconnected.' });
        assert.equal(other.kind, 'network');
        assert.match(other.message, /GATT Server is disconnected/);
        const plain = describeBleError(new Error('boom'));
        assert.equal(plain.kind, 'error');
        assert.equal(plain.message, 'boom');
        assert.equal(describeBleError(null).message, 'Bluetooth pairing failed.');
    });
});
