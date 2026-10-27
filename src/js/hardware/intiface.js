// Intiface Central / Buttplug v3 WebSocket driver.
//
// Design rules, in priority order:
//   1. Fail safe: any doubt (socket gone, handshake stalled, fatal server
//      error) ends with StopAllDevices where possible and motors treated as
//      stopped. Only a connection loss while toys are ASSIGNED a role pauses
//      the session (app.js decides via onClose).
//   2. Never exceed the user's limits: the stroke zone is clamped into the
//      hardware envelope and every per-axis cap scales the engine output.
//   3. Smooth motion: each linear axis is driven by a stroke planner
//      (stroke-planner.js) issuing ONE LinearCmd per leg with the full leg
//      duration, timed by a per-axis setTimeout at leg end. Engine ticks only
//      update the planner inputs. Vibrators and rotators get immediate
//      updates, deduplicated so identical values are not re-sent. A vibrate
//      axis set to Pulsed holds that level for a few beats, then rests
//      (vibe-pulse.js). The lengths change. Any 0 cuts it.
//
// Message construction and parsing live in buttplug-protocol.js (pure,
// unit-tested). Roles, caps, linear invert and the rotation settings are
// persisted per device signature through storage.js and re-applied on
// DeviceList / DeviceAdded, so a reconnect keeps the user's mapping.

import { safeParse, safeSet } from '../storage.js';
import {
    buildRequestServerInfo,
    buildPing,
    buildRequestDeviceList,
    buildStartScanning,
    buildStopAllDevices,
    buildStopDeviceCmd,
    buildScalarCmd,
    buildLinearCmd,
    buildRotateCmd,
    buildSensorReadCmd,
    encodeFrame,
    decodeFrame,
    classifyMessage,
    parseServerInfo,
    pingIntervalMs,
    describeError,
    parseDevice,
    deviceSignature,
    defaultRoleFor,
    oscillateTwins,
    rotateDuplicates,
    linearStep
} from './buttplug-protocol.js';
import { createStrokePlanner } from './stroke-planner.js';
import { createScriptPlanner, liveFeed } from './script-planner.js';
import { readVibeMode, readPulsePeriod, pulsePhase, pulseLevel, DEFAULT_VIBE_MODE, DEFAULT_PULSE_PERIOD_MS } from './vibe-pulse.js';

export const INTIFACE_STORAGE_KEY = 'edgeloop_intiface_devices';
export const DEFAULT_INTIFACE_URL = 'ws://localhost:12345';
export const ALTERNATE_SECONDS_MIN = 5;
export const ALTERNATE_SECONDS_MAX = 60;

// Mutable so tests can shorten the waits.
export const INTIFACE_TIMINGS = {
    handshakeMs: 5000,
    minDirectionChangeMs: 1000,
    failuresBeforeFlag: 3,
    testMoveMs: 450
};

// A held linear axis (OSSM position mode) is streamed in pieces this long,
// so a stop lands within one of them instead of running the rest of the leg.
export const HELD_SEGMENT_MS = 200;

export const INVALID_URL_TEXT = 'Invalid WebSocket URL: it must start with ws:// (or wss:// for a remote server with TLS), e.g. ws://localhost:12345.';
export const HANDSHAKE_TIMEOUT_TEXT = 'Handshake timed out. Make sure Intiface Central is running and its server is started; for localhost the URL must be ws://, not wss://.';
export const CONNECT_FAILED_TEXT = 'Connection failed. Make sure Intiface Central is running and its server is started; for localhost the URL must be ws://, not wss://.';

const WS_OPEN = 1;
const MAX_PENDING = 256;
const MAX_SAVED_DEVICES = 32;

// Kept exported for callers that still inspect the raw socket; prefer
// isIntifaceConnected().
export let intifaceSocket = null;
export let intifaceDevices = new Map();

let session = null;
let msgId = 1;
let scanning = false;
let status = { state: 'offline', text: 'Offline' };
let lastZone = { min: 0.2, max: 0.8 };
let lastEnvelope = { min: 0, max: 1 };
let lastSpeeds = { primary: 0, secondary: 0 };

const handlers = {
    onStatus: null,
    onDevicesChanged: null,
    onClose: null,
    onError: null
};

// app.js installs UI callbacks here:
//   onStatus({ state, text })   state: offline | connecting | handshake | connected | error
//   onDevicesChanged()          device list, battery, roles or failure flags changed
//   onClose({ wasConnected, assignedDevices, intentional, text })
//   onError(text)               a server Error message or a socket error
export function setIntifaceHandlers(next = {}) {
    Object.keys(handlers).forEach((k) => {
        if (next[k] !== undefined) handlers[k] = next[k];
    });
}

function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function nextId() {
    const id = msgId;
    msgId = msgId >= 0x7fffffff ? 1 : msgId + 1;
    return id;
}

export function isIntifaceConnected() {
    return Boolean(session && session.handshaken && session.socket && session.socket.readyState === WS_OPEN);
}

export function isIntifaceScanning() {
    return scanning;
}

export function getIntifaceStatus() {
    return { ...status };
}

export function getIntifaceServerName() {
    return session ? session.serverName : '';
}

// Devices with at least one axis that is not OFF.
export function countAssignedIntifaceDevices() {
    let n = 0;
    intifaceDevices.forEach((dev) => {
        if (dev.axes.some((a) => a.role !== 'off')) n += 1;
    });
    return n;
}

function setStatus(state, text) {
    status = { state, text };
    call('onStatus', { state, text });
}

function describeConnected(s) {
    const n = intifaceDevices.size;
    const name = s && s.serverName ? s.serverName : 'Intiface';
    let text = `Connected (${name}, ${n} device${n === 1 ? '' : 's'})`;
    if (s && s.lastError) text += ` - ${s.lastError}`;
    return text;
}

function refreshConnectedStatus() {
    if (session && session.handshaken) setStatus('connected', describeConnected(session));
}

function send(message) {
    if (!session || !session.socket || session.socket.readyState !== WS_OPEN) return false;
    try {
        session.socket.send(encodeFrame(message));
        return true;
    } catch (e) {
        return false;
    }
}

// Device commands remember which axis they were for, so an Error reply can
// be attributed and a run of failures flagged on that axis.
function sendDeviceCmd(dev, axis, message) {
    const id = message[Object.keys(message)[0]].Id;
    if (!send(message)) return false;
    if (session) {
        session.pending.set(id, { devIndex: dev.index, axisKey: axis ? axis.key : null });
        if (session.pending.size > MAX_PENDING) {
            const oldest = session.pending.keys().next().value;
            session.pending.delete(oldest);
        }
    }
    return true;
}

// ---- connection lifecycle ---------------------------------------------------

function clearSessionTimers(s) {
    if (!s) return;
    if (s.handshakeTimer) { clearTimeout(s.handshakeTimer); s.handshakeTimer = null; }
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
}

function detachSocket(socket) {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
}

function clearAxisTimers(dev) {
    dev.axes.forEach((axis) => {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
        if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
        cutPulse(axis);
    });
}

function clearAllDevices() {
    intifaceDevices.forEach((dev) => clearAxisTimers(dev));
    intifaceDevices.clear();
}

// Tear down `s` (timers, devices, socket) and report. `reason`:
//   'user'     the user pressed Disconnect (or a new connect replaced it)
//   'timeout'  ServerInfo never arrived
//   'fatal'    the server sent a handshake / ping error
//   'remote'   the socket closed on its own
//   'failed'   the socket never opened
function finishSession(s, reason, text) {
    if (!s || s.finished) return;
    s.finished = true;
    clearSessionTimers(s);
    const wasConnected = Boolean(s.handshaken);
    const assignedDevices = countAssignedIntifaceDevices();
    if (reason === 'user' && s.socket && s.socket.readyState === WS_OPEN) {
        try { s.socket.send(encodeFrame(buildStopAllDevices(nextId()))); } catch (e) {}
    }
    detachSocket(s.socket);
    try { s.socket.close(); } catch (e) {}
    if (session === s) {
        session = null;
        intifaceSocket = null;
    }
    clearAllDevices();
    scanning = false;

    let finalText = text;
    let state = 'error';
    if (reason === 'user') { state = 'offline'; finalText = 'Offline'; }
    else if (reason === 'timeout') finalText = finalText || HANDSHAKE_TIMEOUT_TEXT;
    else if (reason === 'failed' || (reason === 'remote' && !wasConnected)) finalText = finalText || CONNECT_FAILED_TEXT;
    else finalText = finalText || 'Connection lost';
    setStatus(state, finalText);
    call('onDevicesChanged');
    call('onClose', { wasConnected, assignedDevices, intentional: reason === 'user', text: finalText });
}

// Browsers resolve a scheme-less WebSocket URL ("localhost:12345") against
// the page origin instead of throwing, which ends in a confusing HTTP 404.
// Only absolute ws:// or wss:// URLs are accepted.
export function isValidIntifaceUrl(url) {
    return typeof url === 'string' && /^wss?:\/\/\S+$/i.test(url.trim());
}

// Open a socket to Intiface Central. Any previous socket is closed first
// (detached, so its close cannot wipe the new connection's device list).
// Returns false when the URL is rejected synchronously.
export function connectIntifaceServer(url, newHandlers) {
    if (newHandlers) setIntifaceHandlers(newHandlers);
    const target = typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_INTIFACE_URL;
    if (!isValidIntifaceUrl(target)) {
        setStatus('error', INVALID_URL_TEXT);
        return false;
    }

    if (session) finishSession(session, 'user');

    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
        setStatus('error', 'WebSocket is not available in this browser.');
        return false;
    }
    let socket;
    try {
        socket = new WebSocketCtor(target);
    } catch (e) {
        setStatus('error', `Invalid WebSocket URL: ${e && e.message ? e.message : target}`);
        return false;
    }

    const s = {
        socket,
        url: target,
        handshakeTimer: null,
        pingTimer: null,
        handshaken: false,
        finished: false,
        serverName: '',
        lastError: null,
        pending: new Map()
    };
    session = s;
    intifaceSocket = socket;
    setStatus('connecting', 'Connecting...');
    // The clock starts now, not at onopen: a socket that hangs in CONNECTING
    // (blackholed host) must not leave the modal on "Connecting..." forever.
    s.handshakeTimer = setTimeout(() => {
        if (s !== session || s.handshaken) return;
        finishSession(s, 'timeout');
    }, INTIFACE_TIMINGS.handshakeMs);

    socket.onopen = () => {
        if (s !== session) return;
        setStatus('handshake', 'Handshake...');
        send(buildRequestServerInfo(nextId()));
    };
    socket.onmessage = (event) => {
        if (s !== session) return;
        decodeFrame(event.data).forEach((msg) => handleMessage(s, msg));
    };
    socket.onerror = () => {
        if (s !== session) return;
        call('onError', s.handshaken ? 'WebSocket error' : CONNECT_FAILED_TEXT);
    };
    socket.onclose = () => {
        if (s !== session) return;
        finishSession(s, s.handshaken ? 'remote' : 'failed');
    };
    return true;
}

export function disconnectIntiface() {
    if (!session) return;
    finishSession(session, 'user');
}

// Best-effort StopAllDevices (page unload, or any caller that wants the
// server-side stop without touching the planners).
export function stopAllIntiface() {
    if (!isIntifaceConnected()) return false;
    return send(buildStopAllDevices(nextId()));
}

export function rescanIntiface() {
    if (!isIntifaceConnected()) return;
    scanning = true;
    send(buildStartScanning(nextId()));
    call('onDevicesChanged');
}

// ---- incoming messages ------------------------------------------------------

function handleMessage(s, msg) {
    const { type, id, body } = classifyMessage(msg);
    switch (type) {
        case 'ServerInfo': {
            const info = parseServerInfo(body);
            s.handshaken = true;
            s.serverName = info ? info.serverName : 'Intiface';
            if (s.handshakeTimer) { clearTimeout(s.handshakeTimer); s.handshakeTimer = null; }
            const every = pingIntervalMs(info ? info.maxPingTime : 0);
            if (every > 0) {
                s.pingTimer = setInterval(() => { send(buildPing(nextId())); }, every);
            }
            setStatus('connected', describeConnected(s));
            send(buildRequestDeviceList(nextId()));
            scanning = true;
            send(buildStartScanning(nextId()));
            break;
        }
        case 'Ok':
            resolvePending(s, id, true);
            break;
        case 'Error':
            handleServerError(s, id, body);
            break;
        case 'DeviceList':
            (Array.isArray(body.Devices) ? body.Devices : []).forEach((dev) => addDiscoveredDevice(dev));
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'DeviceAdded':
            addDiscoveredDevice(body);
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'DeviceRemoved':
            removeDevice(body.DeviceIndex);
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'ScanningFinished':
            scanning = false;
            call('onDevicesChanged');
            break;
        case 'SensorReading': {
            if (body.SensorType !== 'Battery') break;
            const dev = intifaceDevices.get(body.DeviceIndex);
            if (dev && Array.isArray(body.Data) && body.Data.length > 0) {
                const level = Number(body.Data[0]);
                dev.battery = Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : null;
                call('onDevicesChanged');
            }
            break;
        }
        default:
            break;
    }
}

function findAxis(devIndex, axisKey) {
    const dev = intifaceDevices.get(devIndex);
    if (!dev) return { dev: null, axis: null };
    return { dev, axis: dev.axes.find((a) => a.key === axisKey) || null };
}

function resolvePending(s, id, ok) {
    const entry = s.pending.get(id);
    if (!entry) return false;
    s.pending.delete(id);
    const { axis } = findAxis(entry.devIndex, entry.axisKey);
    if (!axis) return true;
    if (ok) {
        if (axis.failures > 0 || axis.failing) {
            axis.failures = 0;
            axis.failing = false;
            call('onDevicesChanged');
        }
        if (s.lastError) {
            s.lastError = null;
            refreshConnectedStatus();
        }
        return true;
    }
    axis.failures += 1;
    if (axis.failures >= INTIFACE_TIMINGS.failuresBeforeFlag && !axis.failing) {
        axis.failing = true;
        call('onDevicesChanged');
    }
    return true;
}

function handleServerError(s, id, body) {
    const err = describeError(body);
    s.lastError = err.message;
    call('onError', err.message);
    // A handshake failure or a ping timeout means the server is dropping us
    // (and has stopped every device): close cleanly and say why.
    if (err.fatal) {
        finishSession(s, 'fatal', err.message);
        return;
    }
    if (!s.handshaken) {
        finishSession(s, 'fatal', err.message);
        return;
    }
    resolvePending(s, id, false);
    setStatus('connected', describeConnected(s));
}

// ---- devices ------------------------------------------------------------------

function loadSavedConfig() {
    return safeParse(INTIFACE_STORAGE_KEY, {});
}

function makeAxis(kind, attr, position, parsed, saved) {
    const key = `${kind}:${attr.index}`;
    const savedAxis = saved && saved.axes && saved.axes[key] && typeof saved.axes[key] === 'object' ? saved.axes[key] : null;
    const role = savedAxis && ['primary', 'secondary', 'off'].includes(savedAxis.role)
        ? savedAxis.role
        : defaultRoleFor(parsed, kind, position);
    const cap = savedAxis ? Number(savedAxis.maxCap) : NaN;
    const axis = {
        key,
        kind,
        index: attr.index,
        type: attr.actuatorType,
        descriptor: attr.descriptor || '',
        stepCount: attr.stepCount || null,
        role: kind === 'scalar' && attr.actuatorType === 'Position' ? 'off' : role,
        maxCap: Number.isFinite(cap) ? Math.max(0, Math.min(100, Math.round(cap))) : 100,
        invert: Boolean(savedAxis && savedAxis.invert),
        // A Position scalar is the same motor as a LinearCmd. Oscillate/linear
        // twins and rotate duplicates are filled in once the device is known.
        inert: kind === 'scalar' && attr.actuatorType === 'Position',
        twin: null,
        pair: null,
        holds: false,
        segTimer: null,
        sentPos: null,
        sentStep: null,
        // Vibrate axes only: Constant (the engine's level as it is) or
        // Pulsed (vibe-pulse.js), and the pulse period. The running train
        // is { startedAt, timer }, or null.
        vibeMode: kind === 'scalar' && attr.actuatorType === 'Vibrate'
            ? (readVibeMode(savedAxis && savedAxis.vibeMode) || DEFAULT_VIBE_MODE)
            : DEFAULT_VIBE_MODE,
        pulsePeriodMs: (kind === 'scalar' && attr.actuatorType === 'Vibrate' && readPulsePeriod(savedAxis && savedAxis.pulsePeriodMs))
            || DEFAULT_PULSE_PERIOD_MS,
        pulse: null,
        planner: kind === 'linear' ? createStrokePlanner() : null,
        strokePlanner: null,
        scriptPlanner: null,
        timer: null,
        testTimer: null,
        lastSent: null,
        failures: 0,
        failing: false
    };
    if (axis.planner) axis.strokePlanner = axis.planner;
    return axis;
}

function addDiscoveredDevice(raw) {
    const parsed = parseDevice(raw);
    if (!parsed) return null;
    const existing = intifaceDevices.get(parsed.deviceIndex);
    if (existing) clearAxisTimers(existing);

    const signature = deviceSignature(parsed);
    const savedAll = loadSavedConfig();
    const saved = savedAll && typeof savedAll[signature] === 'object' ? savedAll[signature] : null;

    const axes = [];
    parsed.scalars.forEach((a, pos) => axes.push(makeAxis('scalar', a, pos, parsed, saved)));
    parsed.linears.forEach((a, pos) => axes.push(makeAxis('linear', a, pos, parsed, saved)));
    parsed.rotations.forEach((a, pos) => axes.push(makeAxis('rotate', a, pos, parsed, saved)));
    if (axes.length === 0) {
        axes.push(makeAxis('scalar', { index: 0, actuatorType: 'Vibrate', descriptor: '', stepCount: null }, 0, parsed, saved));
    }
    // Oscillate and Position are one motor. A saved map may have both on;
    // Position keeps its role, because that one stays inside the travel range.
    oscillateTwins(parsed).forEach(({ scalar, linear }) => {
        const osc = axes[scalar];
        const lin = axes[parsed.scalars.length + linear];
        if (!osc || !lin) return;
        const pair = { owner: null };
        osc.twin = lin;
        lin.twin = osc;
        osc.pair = pair;
        lin.pair = pair;
        if (osc.role !== 'off' && lin.role !== 'off') osc.role = 'off';
        lin.holds = true;
        lin.planner = createStrokePlanner({ hold: true });
        lin.strokePlanner = lin.planner;
    });
    rotateDuplicates(parsed).forEach((pos) => {
        const axis = axes[pos];
        if (!axis) return;
        axis.inert = true;
        axis.role = 'off';
    });

    const altSaved = saved ? Number(saved.alternateSeconds) : 0;
    const dev = {
        index: parsed.deviceIndex,
        name: parsed.name,
        displayName: parsed.displayName,
        signature,
        axes,
        clockwise: true,
        reverseOnEdge: saved ? saved.reverseOnEdge !== false : true,
        alternateSeconds: clampAlternateSeconds(altSaved),
        lastDirectionChangeAt: Date.now(),
        hasBattery: parsed.batterySensorIndex !== null,
        batterySensorIndex: parsed.batterySensorIndex,
        battery: null,
        canStop: parsed.canStop
    };
    intifaceDevices.set(dev.index, dev);

    if (dev.hasBattery) {
        send(buildSensorReadCmd(nextId(), dev.index, dev.batterySensorIndex, 'Battery'));
    }
    return dev;
}

function removeDevice(devIndex) {
    const dev = intifaceDevices.get(devIndex);
    if (!dev) return;
    clearAxisTimers(dev);
    intifaceDevices.delete(devIndex);
}

function clampAlternateSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(ALTERNATE_SECONDS_MIN, Math.min(ALTERNATE_SECONDS_MAX, Math.round(n)));
}

// ---- persistence ----------------------------------------------------------------

// Persist every connected device's mapping under its signature. Returns
// true when the store accepted the write.
export function saveIntifaceConfig() {
    const all = loadSavedConfig();
    const now = Date.now();
    intifaceDevices.forEach((dev) => {
        const axes = {};
        dev.axes.forEach((axis) => {
            axes[axis.key] = { role: axis.role, maxCap: axis.maxCap, invert: Boolean(axis.invert) };
            if (axis.kind === 'scalar' && axis.type === 'Vibrate') {
                axes[axis.key].vibeMode = axis.vibeMode;
                axes[axis.key].pulsePeriodMs = axis.pulsePeriodMs;
            }
        });
        all[dev.signature] = {
            name: dev.name,
            axes,
            reverseOnEdge: dev.reverseOnEdge !== false,
            alternateSeconds: dev.alternateSeconds || 0,
            savedAt: now
        };
    });
    const keys = Object.keys(all);
    if (keys.length > MAX_SAVED_DEVICES) {
        keys.sort((a, b) => (Number(all[a].savedAt) || 0) - (Number(all[b].savedAt) || 0));
        keys.slice(0, keys.length - MAX_SAVED_DEVICES).forEach((k) => { delete all[k]; });
    }
    return safeSet(INTIFACE_STORAGE_KEY, all);
}

// ---- per-axis output ----------------------------------------------------------------

function quantize(value, stepCount) {
    let v = Math.max(0, Math.min(1, Number(value) || 0));
    if (stepCount && stepCount > 0) v = Math.round(v * stepCount) / stepCount;
    return Math.round(v * 1000) / 1000;
}

function scalarFor(axis, speedPercent) {
    if (axis.role === 'off') return 0;
    const capped = Math.max(0, Math.min(100, Number(speedPercent) || 0)) * ((axis.maxCap ?? 100) / 100);
    return quantize(capped / 100, axis.stepCount);
}

function fullRail(axis) {
    return axis.kind === 'scalar' && axis.type === 'Oscillate' && Boolean(axis.twin);
}

function envelopeIsWhole(env) {
    return Boolean(env) && env.min <= 0 && env.max >= 1;
}

function noteDrove(axis, acting) {
    if (axis.pair && acting) axis.pair.owner = axis.kind;
}

// An OFF twin whose other mode holds the motor must be sent nothing. A zero
// to the idle mode tells Buttplug to switch modes, and the OSSM firmware
// runs that as an emergency stop.
function silenced(axis) {
    if (axis.inert) return true;
    return Boolean(axis.pair) && axis.role === 'off' && axis.pair.owner !== axis.kind;
}

function sendScalar(dev, axis, value) {
    if (silenced(axis)) return false;
    if (axis.lastSent === value) return false;
    if (!sendDeviceCmd(dev, axis, buildScalarCmd(nextId(), dev.index, [{ index: axis.index, scalar: value, actuatorType: axis.type }]))) return false;
    axis.lastSent = value;
    noteDrove(axis, value > 0);
    return true;
}

function speedForRole(role) {
    if (role === 'primary') return lastSpeeds.primary;
    if (role === 'secondary') return lastSpeeds.secondary;
    return 0;
}

// ---- pulsed vibration (vibe-pulse.js) -------------------------------------

function isPulsed(axis) {
    return axis.kind === 'scalar' && axis.type === 'Vibrate' && axis.vibeMode === 'pulsed';
}

// Stop a pulse train where it is. Once this returns, no later tick of that
// train can go out: its timer is cleared, and the callback checks that its
// train is still the axis's own all the same.
function cutPulse(axis) {
    if (!axis || !axis.pulse) return;
    if (axis.pulse.timer) clearTimeout(axis.pulse.timer);
    axis.pulse = null;
}

function armPulse(dev, axis, now) {
    const train = axis.pulse;
    if (!train) return;
    const { changeAt } = pulsePhase(train.startedAt, now, axis.pulsePeriodMs);
    train.timer = setTimeout(() => {
        if (axis.pulse !== train) return;
        train.timer = null;
        if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) { axis.pulse = null; return; }
        const t = Date.now();
        applyScalar(dev, axis, speedForRole(axis.role), t);
        if (axis.pulse === train) armPulse(dev, axis, t);
    }, Math.max(1, changeAt - now));
}

// A scalar axis takes the engine's speed as it is (Constant), or as the
// peak of a pulse train (Pulsed). The train starts on the first positive
// level, at the peak at once, and any 0 cuts it: a stop, a pause, OFF, or
// a cap of 0.
function applyScalar(dev, axis, speed, now) {
    const level = fullRail(axis) && !envelopeIsWhole(lastEnvelope) ? 0 : scalarFor(axis, speed);
    if (!isPulsed(axis) || level <= 0) {
        cutPulse(axis);
        sendScalar(dev, axis, level);
        return;
    }
    let fresh = false;
    if (!axis.pulse) {
        axis.pulse = { startedAt: now, timer: null };
        fresh = true;
    }
    sendScalar(dev, axis, pulseLevel(level, pulsePhase(axis.pulse.startedAt, now, axis.pulsePeriodMs).gain));
    if (fresh) armPulse(dev, axis, now);
}

function sendRotate(dev, axis, value) {
    const clockwise = dev.clockwise !== false;
    const key = `${value}|${clockwise}`;
    // A stopped rotator stays stopped whatever the direction flag does.
    if (axis.lastSent === key || (value === 0 && typeof axis.lastSent === 'string' && axis.lastSent.startsWith('0|'))) return false;
    if (!sendDeviceCmd(dev, axis, buildRotateCmd(nextId(), dev.index, [{ index: axis.index, speed: value, clockwise }]))) return false;
    axis.lastSent = key;
    return true;
}

// Invert mirrors a linear axis INSIDE the hardware envelope (min + max -
// position), not around 0.5: a 20-100 % envelope must never produce a
// physical 0-80 % move just because the sleeve is mounted upside down. The
// rest move mirrors the same way, so a stop stays inside the envelope too.
let scriptFeed = null;
let unsubscribeScriptFeed = null;
const scriptFeedNow = liveFeed(() => scriptFeed);

function wantsScript(axis) {
    if (axis.kind !== 'linear' || axis.role !== 'primary' || !scriptFeed) return false;
    try {
        return Boolean(scriptFeed.isActive());
    } catch (e) {
        return false;
    }
}

function scriptPlannerOf(axis) {
    if (!axis.scriptPlanner) {
        axis.scriptPlanner = createScriptPlanner({
            feed: scriptFeedNow,
            hold: axis.holds,
            profile: axis.holds ? 'ossm' : 'intiface'
        });
    }
    return axis.scriptPlanner;
}

function syncScriptPlanner(axis, now) {
    if (axis.kind !== 'linear' || !axis.strokePlanner) return;
    const want = wantsScript(axis) ? scriptPlannerOf(axis) : axis.strokePlanner;
    const current = axis.planner;
    if (want === current) return;
    const input = current && current.getInput ? current.getInput() : null;
    const moving = input && input.enabled && input.effectiveSpeed > 0;
    if (moving && current.isInFlight && current.isInFlight(now)) return;
    const at = current && current.lastPosition ? current.lastPosition() : null;
    want.reset();
    want.place(at);
    axis.planner = want;
}

function onScriptFeedChange() {
    if (!isIntifaceConnected()) return;
    const now = Date.now();
    intifaceDevices.forEach((dev) => dev.axes.forEach((axis) => {
        if (!axis.scriptPlanner || axis.planner !== axis.scriptPlanner) return;
        axis.scriptPlanner.poke();
        pumpLinear(dev, axis, now);
    }));
}

export function setIntifaceScriptFeed(feed) {
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    scriptFeed = feed && typeof feed === 'object' ? feed : null;
    if (scriptFeed && typeof scriptFeed.subscribe === 'function') {
        try { unsubscribeScriptFeed = scriptFeed.subscribe(onScriptFeedChange); } catch (e) {}
    }
}

function physicalPosition(axis, position) {
    if (axis.kind !== 'linear' || !axis.invert) return position;
    return lastEnvelope.min + lastEnvelope.max - position;
}

// Ask the planner for the next leg and, when it yields one, send it and
// arm a timer for its end. Never sends while a leg is in flight.
function pumpLinear(dev, axis, now = Date.now()) {
    if (!axis.planner || !isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
    if (silenced(axis)) {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
        return;
    }
    syncScriptPlanner(axis, now);
    if (axis.holds) {
        pumpHeld(dev, axis, now);
        return;
    }
    const leg = axis.planner.next(now);
    if (!leg) return;
    if (leg.kind === 'idle' || leg.kind === 'hold') {
        if (leg.kind === 'hold') holdAxis(axis);
        if (axis.timer) clearTimeout(axis.timer);
        axis.timer = setTimeout(() => {
            axis.timer = null;
            pumpLinear(dev, axis, Math.max(Date.now(), axis.planner.legEndsAt()));
        }, leg.durationMs || 0);
        return;
    }
    const position = physicalPosition(axis, leg.position);
    sendDeviceCmd(dev, axis, buildLinearCmd(nextId(), dev.index, [{ index: axis.index, position, durationMs: leg.durationMs }]));
    if (axis.timer) clearTimeout(axis.timer);
    axis.timer = setTimeout(() => {
        axis.timer = null;
        pumpLinear(dev, axis, Math.max(Date.now(), axis.planner.legEndsAt()));
    }, leg.durationMs);
}

function sendLinear(dev, axis, position, durationMs) {
    const step = linearStep(position, axis.stepCount, lastEnvelope);
    if (axis.holds && step === axis.sentStep) return false;
    const sent = sendDeviceCmd(dev, axis, buildLinearCmd(nextId(), dev.index, [{ index: axis.index, position, durationMs }]));
    if (sent) {
        axis.sentPos = position;
        axis.sentStep = step;
    }
    noteDrove(axis, sent);
    return sent;
}

function holdAxis(axis) {
    if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
    if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
    axis.planner.place(axis.sentPos === null ? null : physicalPosition(axis, axis.sentPos));
}

function pumpHeld(dev, axis, now) {
    const leg = axis.planner.next(now);
    if (!leg) return;
    if (leg.kind === 'hold') {
        holdAxis(axis);
        return;
    }
    const to = physicalPosition(axis, leg.position);
    streamLeg(dev, axis, axis.sentPos, to, leg.durationMs);
    if (axis.timer) clearTimeout(axis.timer);
    axis.timer = setTimeout(() => {
        axis.timer = null;
        pumpLinear(dev, axis, Math.max(Date.now(), axis.planner.legEndsAt()));
    }, leg.durationMs);
}

function streamLeg(dev, axis, from, to, durationMs) {
    if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
    const n = from === null ? 1 : Math.max(1, Math.ceil(durationMs / HELD_SEGMENT_MS));
    const each = durationMs / n;
    const segments = [];
    let prev = axis.sentStep;
    let carry = 0;
    for (let i = 1; i <= n; i++) {
        const pos = from === null ? to : from + (to - from) * (i / n);
        const step = linearStep(pos, axis.stepCount, lastEnvelope);
        if (step === prev) { carry += each; continue; }
        segments.push({ pos, ms: Math.round(each + carry), at: (i - 1) * each - carry });
        prev = step;
        carry = 0;
    }
    const start = Date.now();
    const next = () => {
        axis.segTimer = null;
        if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
        const seg = segments.shift();
        if (!seg) return;
        sendLinear(dev, axis, seg.pos, seg.ms);
        if (segments.length) axis.segTimer = setTimeout(next, Math.max(1, start + segments[0].at - Date.now()));
    };
    next();
}

function flipDirection(dev, now) {
    if (now - (dev.lastDirectionChangeAt || 0) < INTIFACE_TIMINGS.minDirectionChangeMs) return false;
    dev.clockwise = !(dev.clockwise !== false);
    dev.lastDirectionChangeAt = now;
    return true;
}

// Reverse every rotator that opted in (reason 'edge' honours the per-device
// "reverse on edge" switch). Rate-limited to one change per second.
export function reverseIntifaceRotation(reason = 'edge', now = Date.now()) {
    let flipped = 0;
    intifaceDevices.forEach((dev) => {
        if (!dev.axes.some((a) => a.kind === 'rotate')) return;
        if (reason === 'edge' && dev.reverseOnEdge === false) return;
        if (flipDirection(dev, now)) flipped += 1;
    });
    if (flipped > 0) applyLastSpeeds();
    return flipped;
}

function maybeAlternate(dev, now, active) {
    if (!active || !dev.alternateSeconds) return;
    if (now - (dev.lastDirectionChangeAt || 0) >= dev.alternateSeconds * 1000) flipDirection(dev, now);
}

function applyAxis(dev, axis, primary, secondary, zone, now) {
    const speed = axis.role === 'primary' ? primary : (axis.role === 'secondary' ? secondary : 0);
    if (axis.kind === 'linear') {
        axis.planner.setInput({ speed, cap: axis.maxCap, zoneMin: zone.min, zoneMax: zone.max, enabled: axis.role !== 'off' });
        pumpLinear(dev, axis, now);
    } else if (axis.kind === 'rotate') {
        const value = scalarFor(axis, speed);
        maybeAlternate(dev, now, value > 0);
        sendRotate(dev, axis, value);
    } else {
        applyScalar(dev, axis, speed, now);
    }
}

function applyLastSpeeds(now = Date.now()) {
    if (!isIntifaceConnected()) return;
    intifaceDevices.forEach((dev) => {
        dev.axes.forEach((axis) => applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, now));
    });
}

function zoneFromPercent(strokeMin, strokeMax, envMin, envMax) {
    const pct = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
    };
    const eMin = pct(envMin, 0) / 100;
    const eMax = Math.max(eMin, pct(envMax, 100) / 100);
    const min = Math.max(eMin, Math.min(eMax, pct(strokeMin, 0) / 100));
    const max = Math.max(min, Math.min(eMax, pct(strokeMax, 100) / 100));
    return { zone: { min, max }, envelope: { min: eMin, max: eMax } };
}

// Main dispatch entry point, called on every engine tick and on every
// stop / pause (force = true). strokeMin/strokeMax are physical percents
// already mapped into the hardware envelope by engine.js; the envelope is
// used only to clamp (and to mirror inverted axes) so no position can ever
// leave the user's bounds.
export function dispatchIntiface(primarySpeed, secondarySpeed, strokeMin = 0, strokeMax = 100, envMin = 0, envMax = 100, force = false) {
    const mapped = zoneFromPercent(strokeMin, strokeMax, envMin, envMax);
    lastZone = mapped.zone;
    lastEnvelope = mapped.envelope;
    lastSpeeds = {
        primary: Math.max(0, Math.min(100, Number(primarySpeed) || 0)),
        secondary: Math.max(0, Math.min(100, Number(secondarySpeed) || 0))
    };
    if (!isIntifaceConnected() || intifaceDevices.size === 0) return;
    if (force && lastSpeeds.primary === 0 && lastSpeeds.secondary === 0) {
        // STOP / pause: the server-side stop first, then the per-axis rest
        // moves and zeros (the planner finishes the leg in flight instead of
        // snapping the sleeve).
        send(buildStopAllDevices(nextId()));
    }
    applyLastSpeeds(Date.now());
}

// ---- user settings ----------------------------------------------------------------

function restAxisNow(dev, axis) {
    if (axis.kind === 'linear') {
        axis.planner.setInput({ enabled: false });
        pumpLinear(dev, axis);
    } else if (axis.kind === 'rotate') {
        sendRotate(dev, axis, 0);
    } else {
        cutPulse(axis);
        sendScalar(dev, axis, 0);
    }
}

function yieldTwin(axis) {
    axis.role = 'off';
    if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
    if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
    if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
    cutPulse(axis);
    if (axis.planner) {
        axis.planner.reset();
        axis.planner.setInput({ enabled: false });
        axis.sentPos = null;
        axis.sentStep = null;
    }
    axis.lastSent = null;
}

export function setAxisRole(devIdx, axisIdx, role, { envelope = null } = {}) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || !['primary', 'secondary', 'off'].includes(role)) return false;
    if (axis.inert && role !== 'off') return false;
    if (envelope && typeof envelope === 'object') {
        const mapped = zoneFromPercent(lastZone.min * 100, lastZone.max * 100, envelope.min, envelope.max);
        lastEnvelope = mapped.envelope;
    }
    if (role !== 'off' && fullRail(axis) && !envelopeIsWhole(lastEnvelope)) return false;
    axis.role = role;
    if (role !== 'off' && axis.twin && axis.twin.role !== 'off') yieldTwin(axis.twin);
    saveIntifaceConfig();
    if (!isIntifaceConnected()) return true;
    if (role === 'off') {
        if (dev.axes.every((a) => a.role === 'off')) send(buildStopDeviceCmd(nextId(), dev.index));
        restAxisNow(dev, axis);
    } else {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

export function setAxisMaxCap(devIdx, axisIdx, maxCap) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis) return false;
    const n = Number(maxCap);
    axis.maxCap = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100;
    saveIntifaceConfig();
    if (isIntifaceConnected() && axis.role !== 'off') {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

// Vibrate axes: Constant or Pulsed, and the pulse period (vibe-pulse.js).
// Either change starts a fresh train, at its peak, at once.
export function setAxisVibeMode(devIdx, axisIdx, { mode, periodMs } = {}) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || axis.kind !== 'scalar' || axis.type !== 'Vibrate') return false;
    const nextMode = mode === undefined ? axis.vibeMode : readVibeMode(mode);
    const nextPeriod = periodMs === undefined ? axis.pulsePeriodMs : readPulsePeriod(periodMs);
    if (!nextMode || !nextPeriod) return false;
    axis.vibeMode = nextMode;
    axis.pulsePeriodMs = nextPeriod;
    saveIntifaceConfig();
    cutPulse(axis);
    if (isIntifaceConnected() && axis.role !== 'off') {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

export function setAxisInvert(devIdx, axisIdx, invert) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || axis.kind !== 'linear') return false;
    axis.invert = Boolean(invert);
    saveIntifaceConfig();
    return true;
}

// Rotation settings per device: reverseOnEdge (boolean) and alternateSeconds
// (0 = off, else 5-60).
export function setDeviceRotation(devIdx, { reverseOnEdge, alternateSeconds } = {}) {
    const dev = intifaceDevices.get(devIdx);
    if (!dev) return false;
    if (reverseOnEdge !== undefined) dev.reverseOnEdge = Boolean(reverseOnEdge);
    if (alternateSeconds !== undefined) {
        dev.alternateSeconds = clampAlternateSeconds(alternateSeconds);
        dev.lastDirectionChangeAt = Date.now();
    }
    saveIntifaceConfig();
    return true;
}

// Short manual test of one axis so the user can see which motor it is.
// Skipped while the engine drives the axis (a session is running would
// fight the planner).
export function testSingleAxis(devIdx, axisIdx) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || !isIntifaceConnected() || axis.inert) return false;
    if (axis.twin && axis.twin.role !== 'off') return false;
    if (fullRail(axis) && !envelopeIsWhole(lastEnvelope)) return false;
    const level = quantize(0.6 * ((axis.maxCap ?? 100) / 100), axis.stepCount);
    const holdMs = 1000;

    if (axis.kind === 'linear') {
        if (axis.planner.isInFlight(Date.now()) || axis.testTimer) return false;
        const up = physicalPosition(axis, lastZone.max);
        const down = physicalPosition(axis, lastZone.min);
        const moveMs = INTIFACE_TIMINGS.testMoveMs;
        sendDeviceCmd(dev, axis, buildLinearCmd(nextId(), dev.index, [{ index: axis.index, position: up, durationMs: moveMs }]));
        axis.testTimer = setTimeout(() => {
            axis.testTimer = null;
            if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
            sendDeviceCmd(dev, axis, buildLinearCmd(nextId(), dev.index, [{ index: axis.index, position: down, durationMs: moveMs }]));
            axis.planner.reset();
        }, moveMs + 50);
        return true;
    }

    if (axis.kind === 'rotate') {
        sendDeviceCmd(dev, axis, buildRotateCmd(nextId(), dev.index, [{ index: axis.index, speed: level, clockwise: dev.clockwise !== false }]));
        axis.lastSent = null;
        if (axis.testTimer) clearTimeout(axis.testTimer);
        axis.testTimer = setTimeout(() => {
            axis.testTimer = null;
            sendRotate(dev, axis, 0);
        }, holdMs);
        return true;
    }

    // Test identifies the motor with one steady buzz. A running pulse train
    // is cut first so its timer cannot turn the axis back on during the buzz,
    // and the next engine tick starts a fresh train if the session is still going.
    cutPulse(axis);
    sendDeviceCmd(dev, axis, buildScalarCmd(nextId(), dev.index, [{ index: axis.index, scalar: level, actuatorType: axis.type }]));
    axis.lastSent = null;
    if (axis.testTimer) clearTimeout(axis.testTimer);
    axis.testTimer = setTimeout(() => {
        axis.testTimer = null;
        sendScalar(dev, axis, 0);
    }, holdMs);
    return true;
}

// Test hook: forget everything (sockets, devices, counters).
export function resetIntifaceForTests() {
    if (session) {
        const s = session;
        s.finished = true;
        clearSessionTimers(s);
        detachSocket(s.socket);
        try { s.socket.close(); } catch (e) {}
        session = null;
        intifaceSocket = null;
    }
    clearAllDevices();
    scriptFeed = null;
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    scanning = false;
    msgId = 1;
    status = { state: 'offline', text: 'Offline' };
    lastZone = { min: 0.2, max: 0.8 };
    lastEnvelope = { min: 0, max: 1 };
    lastSpeeds = { primary: 0, secondary: 0 };
    Object.keys(handlers).forEach((k) => { handlers[k] = null; });
}
