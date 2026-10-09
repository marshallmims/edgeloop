// Web Bluetooth driver for GATT Heart Rate monitors. All navigator access
// stays inside functions so the module can be imported under node.
import { BLE_RECONNECT_DELAYS_MS, reconnectDelayMs, parseHeartRateMeasurement } from './ble-protocol.js';

// The device the app is currently linked to (null while disconnected or
// while a reconnect is still being attempted after a drop).
export let bleDeviceRef = null;

// The single live link. A re-scan tears the previous one down (listeners
// removed, GATT dropped) so handlers are never stacked on an old device.
let link = null;

export function isBleConnected() {
    return Boolean(bleDeviceRef && bleDeviceRef.gatt && bleDeviceRef.gatt.connected);
}

export function isBleReconnecting() {
    return Boolean(link && link.reconnecting);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function bluetoothApi() {
    try {
        const nav = globalThis.navigator;
        return nav && nav.bluetooth ? nav.bluetooth : null;
    } catch (e) {
        return null;
    }
}

// Devices this origin was already allowed to use. A refresh does not clear
// that grant, and HeartCast will not take a second connection while the
// browser still holds the first.
async function permittedDevices(bluetooth) {
    if (!bluetooth || typeof bluetooth.getDevices !== 'function') return [];
    try {
        const list = await bluetooth.getDevices();
        return Array.isArray(list) ? list.filter((device) => device && device.gatt) : [];
    } catch (e) {
        return [];
    }
}

function releaseGatt(device) {
    try {
        if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    } catch (e) {
        // Already gone.
    }
}

// Connect the GATT server and (re)subscribe to heart-rate notifications.
// Throws on any failure; nothing is registered on the device until it
// succeeds. A reconnect may hand back a new characteristic object, so the
// previous value listener is always removed first.
async function subscribeHeartRate(theLink) {
    const server = await theLink.device.gatt.connect();
    try {
        const hrService = await server.getPrimaryService('heart_rate');
        const char = await hrService.getCharacteristic('heart_rate_measurement');
        await char.startNotifications();
        if (theLink.char) theLink.char.removeEventListener('characteristicvaluechanged', theLink.onValue);
        theLink.char = char;
        char.addEventListener('characteristicvaluechanged', theLink.onValue);
        return server;
    } catch (e) {
        // A half-open GATT with no notifications is worse than none.
        try { if (server.connected) server.disconnect(); } catch (ignored) {}
        throw e;
    }
}

async function readBattery(server, onBatteryLevel) {
    if (!onBatteryLevel) return;
    try {
        const batService = await server.getPrimaryService('battery_service');
        const batChar = await batService.getCharacteristic('battery_level');
        const batVal = await batChar.readValue();
        if (batVal && batVal.byteLength >= 1) onBatteryLevel(batVal.getUint8(0));
    } catch (e) {
        // Battery service is optional.
    }
}

// Mark a link dead and detach every listener it installed. Safe to call twice.
function finishLink(theLink) {
    if (theLink.closed) return;
    theLink.closed = true;
    theLink.reconnecting = false;
    if (theLink.device && theLink.onGattDropped) {
        theLink.device.removeEventListener('gattserverdisconnected', theLink.onGattDropped);
    }
    if (theLink.char && theLink.onValue) {
        theLink.char.removeEventListener('characteristicvaluechanged', theLink.onValue);
    }
    theLink.char = null;
    if (link === theLink) {
        link = null;
        bleDeviceRef = null;
    }
}

// Unexpected GATT drop: try to get the sensor back before telling the app
// it is gone. Chrome only fires this event for real drops, not for a failed
// connect(), so a drop during an attempt is caught by the attempt itself.
async function handleGattDropped(theLink) {
    if (theLink.closed || theLink.reconnecting) return;
    theLink.reconnecting = true;
    // Not connected any more: readiness checks must see that immediately.
    bleDeviceRef = null;
    const maxAttempts = BLE_RECONNECT_DELAYS_MS.length;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const delay = reconnectDelayMs(attempt);
        if (delay === null) break;
        if (theLink.handlers.onReconnecting) theLink.handlers.onReconnecting(attempt, maxAttempts, delay);
        await sleep(delay);
        if (theLink.closed) return;
        try {
            const server = await subscribeHeartRate(theLink);
            if (theLink.closed) return;
            // Dropped again while subscribing: that event was swallowed by the
            // reconnecting flag, so count this attempt as failed.
            if (!theLink.device.gatt || !theLink.device.gatt.connected) throw new Error('Sensor dropped again during reconnect');
            theLink.reconnecting = false;
            bleDeviceRef = theLink.device;
            if (theLink.handlers.onReconnected) theLink.handlers.onReconnected(attempt);
            readBattery(server, theLink.handlers.onBatteryLevel);
            return;
        } catch (e) {
            lastError = e;
        }
    }
    if (theLink.closed) return;
    const handlers = theLink.handlers;
    finishLink(theLink);
    try { if (theLink.device.gatt && theLink.device.gatt.connected) theLink.device.gatt.disconnect(); } catch (ignored) {}
    if (handlers.onDisconnected) {
        handlers.onDisconnected({ intentional: false, attempts: maxAttempts, error: lastError });
    }
}

// Pair and subscribe. Callbacks:
//   onHrMeasurement(bpm, { sensorContact, rrIntervalsMs, energyExpended })
//       for EVERY notification, including 0 BPM ones; the app decides what
//       counts as a usable reading.
//   onBatteryLevel(percent)     optional, after connect and after a reconnect.
//   onReconnecting(attempt, maxAttempts, delayMs)  before each retry.
//   onReconnected(attempt)      the sensor came back on its own.
//   onDisconnected({ intentional, attempts, error })  link is gone for good.
async function openLink(device, handlers) {
    const { onHrMeasurement, onBatteryLevel, onDisconnected, onReconnecting, onReconnected } = handlers;
    // The user picked a sensor: whatever was linked before is replaced.
    disconnectBle({ silent: true });
    // A refresh can leave the browser holding the peripheral. Drop that link
    // before opening another, or HeartCast stays paired to a page that is gone.
    releaseGatt(device);

    const theLink = {
        device,
        char: null,
        closed: false,
        reconnecting: false,
        handlers: { onHrMeasurement, onBatteryLevel, onDisconnected, onReconnecting, onReconnected },
        onValue: null,
        onGattDropped: null
    };
    theLink.onValue = (event) => {
        if (theLink.closed) return;
        const parsed = parseHeartRateMeasurement(event.target && event.target.value);
        if (!parsed) return;
        if (onHrMeasurement) onHrMeasurement(parsed.bpm, parsed);
    };
    theLink.onGattDropped = () => { handleGattDropped(theLink); };

    // Only a fully subscribed link is published: a failed connect leaves no
    // device reference and no disconnect listener behind.
    const server = await subscribeHeartRate(theLink);
    link = theLink;
    bleDeviceRef = device;
    device.addEventListener('gattserverdisconnected', theLink.onGattDropped);

    await readBattery(server, onBatteryLevel);
    return device;
}

// Pair and subscribe. A sensor this site already has permission for is tried
// first, after any stale link is dropped. If that still fails, the grant is
// forgotten and the chooser opens, so a refresh does not leave HeartCast
// stuck until the computer's Bluetooth list is cleared by hand.
export async function connectBleHeartRate(handlers = {}) {
    const bluetooth = bluetoothApi();
    if (!bluetooth || typeof bluetooth.requestDevice !== 'function') throw new Error('Web Bluetooth not supported');

    if (!isBleConnected()) {
        const known = await permittedDevices(bluetooth);
        for (const device of known) {
            try {
                return await openLink(device, handlers);
            } catch (e) {
                releaseGatt(device);
                try {
                    return await openLink(device, handlers);
                } catch (again) {
                    if (typeof device.forget === 'function') {
                        try { await device.forget(); } catch (ignored) {}
                    }
                }
            }
        }
    }

    const device = await bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['battery_service']
    });
    return openLink(device, handlers);
}

// Drop the GATT link when the page goes away (refresh, close, freeze) so the
// peripheral can accept the next one. Silent: unloading is not the wearer
// pressing Disconnect.
export function bindBlePageLifecycle(target = globalThis) {
    const drop = () => disconnectBle({ silent: true });
    if (target && typeof target.addEventListener === 'function') target.addEventListener('pagehide', drop);
    const doc = target && target.document;
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('freeze', drop);
}

// Drop the current link on purpose. No reconnect is attempted and, unless
// `silent`, onDisconnected fires with intentional: true.
export function disconnectBle({ silent = false } = {}) {
    const current = link;
    if (!current) {
        bleDeviceRef = null;
        return;
    }
    const handlers = current.handlers;
    finishLink(current);
    try {
        if (current.device.gatt && current.device.gatt.connected) current.device.gatt.disconnect();
    } catch (e) {
        // Already gone.
    }
    if (!silent && handlers.onDisconnected) handlers.onDisconnected({ intentional: true, attempts: 0, error: null });
}
