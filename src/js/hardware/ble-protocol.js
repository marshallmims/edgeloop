// Pure helpers for the Bluetooth GATT Heart Rate Service (0x180D). No
// navigator, no DOM, so everything here runs under node:test. ble.js does
// the I/O.

// Reconnect schedule after an unexpected GATT drop: three attempts with
// exponential backoff before the app is told the sensor is gone.
export const BLE_RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

// Delay before reconnect attempt `attempt` (1-based); null once the schedule
// is exhausted.
export function reconnectDelayMs(attempt, delays = BLE_RECONNECT_DELAYS_MS) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > delays.length) return null;
    return delays[attempt - 1];
}

// Decode one Heart Rate Measurement characteristic value (HRS spec 3.1).
//   flags bit 0    : 0 = uint8 BPM, 1 = uint16 little-endian BPM
//   flags bits 1-2 : 0b00 / 0b01 = contact detection not supported
//                    0b10 = supported, contact NOT detected
//                    0b11 = supported, contact detected
//   flags bit 3    : energy expended (uint16) present
//   flags bit 4    : RR intervals (uint16 each, 1/1024 s) present
// Returns null when the value is too short to hold a BPM at all; a truncated
// tail (RR intervals cut off by an MTU limit) is tolerated.
export function parseHeartRateMeasurement(view) {
    if (!view || typeof view.getUint8 !== 'function' || !Number.isFinite(view.byteLength)) return null;
    if (view.byteLength < 2) return null;
    const flags = view.getUint8(0);
    const wideBpm = (flags & 0x01) === 0x01;
    if (wideBpm && view.byteLength < 3) return null;
    const bpm = wideBpm ? view.getUint16(1, true) : view.getUint8(1);
    let offset = wideBpm ? 3 : 2;

    const contactBits = (flags >> 1) & 0x03;
    // null = the sensor does not report contact; true / false otherwise.
    const sensorContact = contactBits === 0b11 ? true : (contactBits === 0b10 ? false : null);

    let energyExpended = null;
    if (flags & 0x08) {
        if (view.byteLength >= offset + 2) energyExpended = view.getUint16(offset, true);
        offset += 2;
    }

    const rrIntervalsMs = [];
    if (flags & 0x10) {
        while (view.byteLength >= offset + 2) {
            rrIntervalsMs.push(Math.round(view.getUint16(offset, true) * 1000 / 1024));
            offset += 2;
        }
    }

    return { bpm, sensorContact, energyExpended, rrIntervalsMs };
}

// The flag Chrome on Linux desktop needs before Web Bluetooth exists.
// chrome:// cannot be opened from an https page, so the BLE modal copies it.
export const CHROME_BLUETOOTH_FLAG = 'chrome://flags/#enable-experimental-web-platform-features';

export function linuxDesktop(userAgent = '') {
    const ua = String(userAgent || '');
    return /Linux/i.test(ua) && !/Android/i.test(ua) && !/CrOS/i.test(ua);
}

// Human explanation of why Web Bluetooth is unavailable, for the BLE modal.
// `userAgent` is passed in so the message can be unit-tested.
export function describeBluetoothSupport(userAgent = '') {
    const ua = String(userAgent || '');
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg/i.test(ua);

    let message = 'Web Bluetooth is not available in this browser. Use Chrome or Edge on desktop or Android';
    if (isIOS) {
        message = 'Safari and every iOS browser lack Web Bluetooth. On iPhone or iPad install the Bluefy browser and open EdgeLoop there';
    } else if (isFirefox) {
        message = 'Firefox does not implement Web Bluetooth. Use Chrome or Edge on desktop or Android';
    } else if (isSafari) {
        message = 'Safari does not implement Web Bluetooth. Use Chrome or Edge on desktop or Android';
    }
    if (linuxDesktop(ua)) {
        message += `. On Linux, Chrome also needs ${CHROME_BLUETOOTH_FLAG} switched on`;
    } else if (!isIOS) {
        message += ' (Bluefy on iOS)';
    }
    return `${message}.`;
}

// Map a requestDevice / connect failure to a short, honest status line.
export function describeBleError(error) {
    const name = error && error.name ? String(error.name) : '';
    const message = error && error.message ? String(error.message) : '';
    if (name === 'NotFoundError') {
        return { kind: 'cancelled', message: 'No sensor selected. Pick your monitor in the browser chooser; it must be powered on and advertising the Heart Rate service.' };
    }
    if (name === 'SecurityError') {
        return { kind: 'security', message: 'Web Bluetooth is blocked here: the page must be served over https:// (or localhost) and Bluetooth must be allowed for this site.' };
    }
    if (name === 'NetworkError') {
        return { kind: 'network', message: `Could not connect to the sensor (${message || 'GATT connection failed'}). Move closer, make sure no other app holds the connection, then try again.` };
    }
    if (name === 'NotSupportedError') {
        return { kind: 'unsupported', message: `The selected device does not expose the Heart Rate service (${message || 'GATT operation not supported'}).` };
    }
    return { kind: 'error', message: message || 'Bluetooth pairing failed.' };
}
