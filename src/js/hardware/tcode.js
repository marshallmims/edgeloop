// Direct T-Code driver over Web Serial (OSR2 / SR6 / OSSM and any other
// T-Code v0.3 firmware on a USB serial port), so those owners can skip
// Intiface Central, which exposes an OSR2 as a single linear axis.
//
// Design rules, in priority order:
//   1. Fail safe: a port that vanishes, a failed write or a closed stream
//      marks the device offline, every axis timer is cleared and app.js is
//      told through onClose so the session pauses. dispatch never throws.
//   2. Never exceed the user's limits: the stroke zone arrives already mapped
//      into the hardware envelope; every axis has its own cap; STOP moves
//      L0 to the bottom of the envelope, L1 / L2 and the R axes to centre,
//      V/A to 0.
//   3. Smooth motion: linear and rotation axes are driven by the shared
//      stroke planner (stroke-planner.js): ONE command per leg carrying the
//      full leg duration, timed by a per-axis setTimeout at leg end. Engine
//      ticks only update the planner inputs, nothing is re-sent mid-leg.
//
// Formatting and parsing live in tcode-protocol.js (pure, unit-tested).
// Roles, caps and the linear invert flag are persisted per device name
// through storage.js and re-applied on connect.

import { safeParse, safeSet } from '../storage.js';
import {
    TCODE_BAUD_RATE,
    axisKind,
    isCentredAxis,
    restPositionFor,
    looksLikeBootBanner,
    formatAxisCommand,
    formatLine,
    splitLines,
    parseIdentification,
    defaultAxisRoles,
    isAxisRole,
    rotationAmplitude,
    scalarLevel,
    describeSerialSupport,
    describeSerialError
} from './tcode-protocol.js';
import { createStrokePlanner } from './stroke-planner.js';
import { createScriptPlanner, liveFeed } from './script-planner.js';

export const TCODE_STORAGE_KEY = 'edgeloop_tcode_devices';

// Mutable so tests can shorten the waits.
export const TCODE_TIMINGS = {
    bootQuietMs: 300,      // after open: wait for this much silence before D0 (boot chatter)
    bootCapMs: 2000,       // ... but never longer than this
    identifyMs: 1500,      // per D0 / D1 / D2 query: give up when nothing arrives
    replyQuietMs: 200,     // a multi-line reply is complete after this silence
    restMs: 400,           // STOP: move to rest over this
    testMoveMs: 450,       // Test button: one leg up, one leg back
    testHoldMs: 1000,      // Test button on a vibe / aux axis
    closeGraceMs: 500      // how long to wait for the read loop to let go
};

const MAX_SAVED_DEVICES = 32;

let session = null;     // the open port and its streams
let device = null;      // { name, version, identified, axes: [...] }
let connectInFlight = false;
let connectGeneration = 0;   // bumped by Disconnect so a late chooser result is dropped
let status = { state: 'offline', text: 'Offline' };
let lastZone = { min: 0, max: 1 };
let lastEnvelope = { min: 0, max: 1 };
let lastSpeeds = { primary: 0, secondary: 0 };
let scriptFeed = null;
let unsubscribeScriptFeed = null;
const scriptFeedNow = liveFeed(() => scriptFeed);

const handlers = {
    onStatus: null,
    onDevicesChanged: null,
    onClose: null,
    onError: null
};

// app.js installs UI callbacks here:
//   onStatus({ state, text })   state: offline | connecting | handshake | connected | error
//   onDevicesChanged()          axis list, roles or caps changed
//   onClose({ wasConnected, assignedAxes, intentional, text })
//   onError(text)               a write / read failure (the port is then closed)
export function setTCodeHandlers(next = {}) {
    Object.keys(handlers).forEach((k) => {
        if (next[k] !== undefined) handlers[k] = next[k];
    });
}

function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function setStatus(state, text) {
    status = { state, text };
    call('onStatus', { state, text });
}

function getSerial() {
    try {
        const nav = globalThis.navigator;
        return nav && nav.serial ? nav.serial : null;
    } catch (e) {
        return null;
    }
}

export function isSerialSupported() {
    const serial = getSerial();
    return Boolean(serial && typeof serial.requestPort === 'function');
}

// A session that is closing (Disconnect pressed, rest line queued) no longer
// accepts motion: nothing may be flushed after the rest line.
export function isTCodeConnected() {
    return Boolean(session && !session.finished && !session.closing && session.identified && device);
}

export function getTCodeStatus() {
    return { ...status };
}

// The live device description for the modal (read-only for callers).
export function getTCodeDevice() {
    return device;
}

export function countAssignedTCodeAxes() {
    if (!device) return 0;
    return device.axes.filter((a) => a.role !== 'off').length;
}

export function tcodeHasRole(role) {
    return Boolean(device && device.axes.some((a) => a.role === role));
}

function describeConnected() {
    if (!device) return 'Connected';
    const version = device.version ? `, ${device.version}` : '';
    return `Connected (${device.name}${version})`;
}

// ---- writing -------------------------------------------------------------------

// Serialised, never-throwing writes. A failed write ends the session. A
// closing session refuses new writes, so the rest line stays the last one.
function queueWrite(s, text) {
    if (!s || s.finished || s.closing || !s.writer || !text) return false;
    const encoder = s.encoder;
    s.writeChain = s.writeChain
        .then(() => s.writer.write(encoder.encode(text)))
        .catch((e) => {
            if (s.finished) return;
            const why = e && e.message ? e.message : 'unknown error';
            call('onError', `Write to the serial port failed: ${why}`);
            markLost(s, 'The serial port stopped accepting commands. Motors are assumed stopped.');
        });
    return true;
}

function writeCommands(commands) {
    const line = formatLine(commands);
    if (!line) return false;
    return queueWrite(session, line);
}

// ---- reading -------------------------------------------------------------------

function handleLine(s, line) {
    if (typeof s.lineSink === 'function') {
        s.lineSink(line);
        return;
    }
    // Unsolicited output (debug prints, OK acks) is ignored.
}

async function runReadLoop(s) {
    try {
        while (!s.finished) {
            const { value, done } = await s.reader.read();
            if (done) break;
            if (!value) continue;
            s.buffer += s.decoder.decode(value, { stream: true });
            const parts = splitLines(s.buffer);
            s.buffer = parts.rest;
            parts.lines.forEach((line) => handleLine(s, line));
        }
    } catch (e) {
        if (!s.finished) {
            const why = e && e.message ? e.message : 'unknown error';
            call('onError', `Serial read failed: ${why}`);
            markLost(s, 'The serial link dropped. Motors are assumed stopped.');
        }
        return;
    }
    if (!s.finished) markLost(s, 'The serial port closed. Motors are assumed stopped.');
}

// Swallow whatever the device prints right after the port opened (opening
// toggles DTR / RTS, which resets Arduino-class boards and ESP32 dev kits;
// the bootloader takes 1-2 s and prints a banner) and resolve once the line
// has been quiet for quietMs, or after capMs at the latest.
function settle(s, { quietMs, capMs }) {
    return new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            clearTimeout(hardStop);
            if (s.lineSink === sink) s.lineSink = null;
            resolve();
        };
        const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(finish, quietMs);
        };
        const sink = () => arm();
        const hardStop = setTimeout(finish, capMs);
        s.lineSink = sink;
        arm();
    });
}

// Send one identification command and collect its reply lines: give up after
// firstMs of silence, or once a reply has gone quiet for quietMs. The total
// wait never exceeds firstMs.
function query(s, command, { firstMs, quietMs }) {
    return new Promise((resolve) => {
        const lines = [];
        let timer = null;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            clearTimeout(hardStop);
            if (s.lineSink === sink) s.lineSink = null;
            resolve(lines);
        };
        const arm = (ms) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(finish, ms);
        };
        const sink = (line) => {
            lines.push(line);
            arm(quietMs);
        };
        const hardStop = setTimeout(finish, firstMs);
        s.lineSink = sink;
        arm(firstMs);
        if (!queueWrite(s, `${command}\n`)) finish();
    });
}

// ---- connection lifecycle ----------------------------------------------------------

function clearAxisTimers() {
    if (!device) return;
    device.axes.forEach((axis) => {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
    });
}

function attachDisconnectListeners(s) {
    const onDisconnect = (event) => {
        if (s.finished) return;
        const target = event && (event.target || event.port);
        if (target && target !== s.port) return;
        markLost(s, 'The T-Code device was unplugged. Motors are assumed stopped.');
    };
    s.onDisconnect = onDisconnect;
    try { if (typeof s.port.addEventListener === 'function') s.port.addEventListener('disconnect', onDisconnect); } catch (e) {}
    const serial = getSerial();
    try { if (serial && typeof serial.addEventListener === 'function') serial.addEventListener('disconnect', onDisconnect); } catch (e) {}
}

function detachDisconnectListeners(s) {
    if (!s.onDisconnect) return;
    try { if (typeof s.port.removeEventListener === 'function') s.port.removeEventListener('disconnect', s.onDisconnect); } catch (e) {}
    const serial = getSerial();
    try { if (serial && typeof serial.removeEventListener === 'function') serial.removeEventListener('disconnect', s.onDisconnect); } catch (e) {}
    s.onDisconnect = null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Release the streams and close the port, tolerating every failure (a port
// that is already gone rejects most of these).
async function releasePort(s) {
    try { if (s.reader) s.reader.cancel().catch(() => {}); } catch (e) {}
    if (s.readLoop) {
        await Promise.race([s.readLoop.catch(() => {}), sleep(TCODE_TIMINGS.closeGraceMs)]);
    }
    try { if (s.reader) s.reader.releaseLock(); } catch (e) {}
    if (s.writer) {
        try { await Promise.race([s.writer.close(), sleep(TCODE_TIMINGS.closeGraceMs)]); } catch (e) {}
        try { s.writer.releaseLock(); } catch (e) {}
    }
    try { await Promise.race([s.port.close(), sleep(TCODE_TIMINGS.closeGraceMs)]); } catch (e) {}
}

// Tear down `s` and report. `reason`:
//   'user'    Disconnect pressed (or a new connect replaced it): rest first
//   'remote'  the port vanished, a stream closed or a write failed
//   'failed'  identification never completed
async function finishSession(s, reason, text) {
    if (!s || s.finished || s.closing) return;
    // A write failure during the final rest move must not start a second,
    // concurrent teardown (and a second onClose).
    const wasConnected = Boolean(s.identified);
    const assignedAxes = countAssignedTCodeAxes();
    // Bring every axis to rest before the port goes away; the session is
    // then closing, which refuses every later write (an engine tick landing
    // in the flush window must not queue a motor command behind the rest
    // line) and stops a second, concurrent teardown.
    if (reason === 'user' && wasConnected) stopTCode();
    s.closing = true;
    if (reason === 'user' && wasConnected) {
        try { await s.writeChain; } catch (e) {}
    }
    s.finished = true;
    s.lineSink = null;
    clearAxisTimers();
    detachDisconnectListeners(s);
    if (session === s) {
        session = null;
        device = null;
    }
    await releasePort(s);

    let finalText = text;
    let state = 'error';
    if (reason === 'user') { state = 'offline'; finalText = 'Offline'; }
    else if (!finalText) finalText = 'Connection lost';
    setStatus(state, finalText);
    call('onDevicesChanged');
    call('onClose', { wasConnected, assignedAxes, intentional: reason === 'user', text: finalText });
}

function markLost(s, text) {
    if (!s || s.finished || s.closing) return;
    finishSession(s, 'remote', text).catch(() => {});
}

function loadSavedConfig() {
    return safeParse(TCODE_STORAGE_KEY, {});
}

function makeAxis(parsedAxis, saved, defaults) {
    const id = parsedAxis.id;
    const kind = axisKind(id);
    const savedAxis = saved && saved.axes && saved.axes[id] && typeof saved.axes[id] === 'object' ? saved.axes[id] : null;
    const role = savedAxis && isAxisRole(savedAxis.role) ? savedAxis.role : (defaults[id] || 'off');
    const cap = savedAxis ? Number(savedAxis.maxCap) : NaN;
    const usesPlanner = kind === 'linear' || kind === 'rotate';
    const strokePlanner = usesPlanner ? createStrokePlanner({ restMs: TCODE_TIMINGS.restMs }) : null;
    return {
        id,
        kind,
        // Rotation axes and the surge / sway axes rest at and swing around
        // the mechanical centre; only L0 is mapped onto the stroke envelope.
        centred: isCentredAxis(id),
        description: parsedAxis.description,
        role,
        maxCap: Number.isFinite(cap) ? Math.max(0, Math.min(100, Math.round(cap))) : 100,
        invert: kind === 'linear' && Boolean(savedAxis && savedAxis.invert),
        planner: strokePlanner,
        strokePlanner,
        scriptPlanner: null,
        timer: null,
        testTimer: null,
        lastSent: null
    };
}

function buildDevice(ident) {
    const savedAll = loadSavedConfig();
    const saved = savedAll && typeof savedAll[ident.name] === 'object' ? savedAll[ident.name] : null;
    const defaults = defaultAxisRoles(ident.axes);
    return {
        name: ident.name,
        version: ident.version,
        identified: ident.identified,
        axes: ident.axes.map((axis) => makeAxis(axis, saved, defaults))
    };
}

// Ask the browser for a port, open it at 115200 8N1 and identify the
// firmware. Must be called from a user gesture (Web Serial requires one for
// requestPort). Resolves true when the device is ready, false otherwise; the
// reason is reported through onStatus. Never throws.
export async function connectTCode(newHandlers) {
    if (newHandlers) setTCodeHandlers(newHandlers);
    const serial = getSerial();
    if (!serial || typeof serial.requestPort !== 'function') {
        const ua = globalThis.navigator && globalThis.navigator.userAgent ? globalThis.navigator.userAgent : '';
        setStatus('error', describeSerialSupport(ua, globalThis.isSecureContext !== false));
        return false;
    }
    // A second click while the port chooser is open must not open another.
    if (connectInFlight) return false;
    connectInFlight = true;
    try {
        return await openAndIdentify(serial);
    } finally {
        connectInFlight = false;
    }
}

// SerialPort.getInfo() ({ usbVendorId, usbProductId } for USB ports) names
// a rig that does not answer D0. Never throws; null when unavailable.
function readPortInfo(port) {
    try {
        return port && typeof port.getInfo === 'function' ? (port.getInfo() || null) : null;
    } catch (e) {
        return null;
    }
}

async function openAndIdentify(serial) {
    if (session) await finishSession(session, 'user');
    const generation = connectGeneration;

    setStatus('connecting', 'Pick the device port in the browser dialog...');
    let port;
    try {
        port = await serial.requestPort();
    } catch (e) {
        if (generation !== connectGeneration) return false;
        setStatus('error', describeSerialError(e).message);
        return false;
    }
    if (generation !== connectGeneration) return false;   // Disconnect pressed meanwhile
    if (!port) {
        setStatus('error', describeSerialError({ name: 'NotFoundError' }).message);
        return false;
    }
    setStatus('connecting', 'Opening the port...');
    try {
        await port.open({ baudRate: TCODE_BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    } catch (e) {
        if (generation !== connectGeneration) return false;
        setStatus('error', describeSerialError(e).message);
        return false;
    }
    if (generation !== connectGeneration) {
        try { await port.close(); } catch (e) {}
        return false;
    }

    const s = {
        port,
        writer: null,
        reader: null,
        encoder: new TextEncoder(),
        decoder: new TextDecoder(),
        buffer: '',
        writeChain: Promise.resolve(),
        readLoop: null,
        lineSink: null,
        identified: false,
        finished: false,
        closing: false,
        onDisconnect: null
    };
    try {
        s.writer = port.writable.getWriter();
        s.reader = port.readable.getReader();
    } catch (e) {
        session = s;
        await finishSession(s, 'failed', `The port opened but its streams are not usable: ${e && e.message ? e.message : 'unknown error'}`);
        return false;
    }
    session = s;
    attachDisconnectListeners(s);
    s.readLoop = runReadLoop(s);

    // Let an auto-resetting board finish booting (and printing) first.
    setStatus('handshake', 'Waiting for the device to settle...');
    await settle(s, { quietMs: TCODE_TIMINGS.bootQuietMs, capMs: TCODE_TIMINGS.bootCapMs });
    if (s.finished) return false;

    setStatus('handshake', 'Identifying the device (D0 / D1 / D2)...');
    const timing = { firstMs: TCODE_TIMINGS.identifyMs, quietMs: TCODE_TIMINGS.replyQuietMs };
    let name = await query(s, 'D0', timing);
    if (s.finished) return false;
    // A board that was still booting swallows the first query (or answers
    // it with the tail of its banner): ask once more.
    if (name.filter((line) => !looksLikeBootBanner(line)).length === 0) {
        name = await query(s, 'D0', timing);
        if (s.finished) return false;
    }
    const version = await query(s, 'D1', timing);
    if (s.finished) return false;
    const axisLines = await query(s, 'D2', timing);
    if (s.finished) return false;

    const ident = parseIdentification({ name, version, axisLines, portInfo: readPortInfo(port) });
    device = buildDevice(ident);
    s.identified = true;
    setStatus('connected', describeConnected());
    call('onDevicesChanged');
    // Known state first: every axis to rest.
    stopTCode();
    return true;
}

// Disconnect from our side: rest every axis, flush, release the port. While
// the port chooser is still open it cancels that connect instead.
export async function disconnectTCode() {
    if (!session) {
        if (!connectInFlight) return false;
        connectGeneration += 1;
        setStatus('offline', 'Offline');
        return true;
    }
    await finishSession(session, 'user');
    return true;
}

// ---- persistence -------------------------------------------------------------------

export function saveTCodeConfig() {
    if (!device) return false;
    const all = loadSavedConfig();
    const axes = {};
    device.axes.forEach((axis) => {
        axes[axis.id] = { role: axis.role, maxCap: axis.maxCap, invert: Boolean(axis.invert) };
    });
    all[device.name] = { axes, savedAt: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_SAVED_DEVICES) {
        keys.sort((a, b) => (Number(all[a].savedAt) || 0) - (Number(all[b].savedAt) || 0));
        keys.slice(0, keys.length - MAX_SAVED_DEVICES).forEach((k) => { delete all[k]; });
    }
    return safeSet(TCODE_STORAGE_KEY, all);
}

// ---- per-axis output -------------------------------------------------------------------

// Invert mirrors the stroke axis INSIDE the hardware envelope (min + max -
// position), not around 0.5: a 20-100 % envelope must never produce a
// physical 0-80 % move just because the sleeve is mounted upside down. A
// centred linear axis (surge / sway) mirrors around its centre instead.
function physicalPosition(axis, position) {
    if (axis.kind !== 'linear' || !axis.invert) return position;
    if (axis.centred) return 1 - position;
    return lastEnvelope.min + lastEnvelope.max - position;
}

// L0 is the stroke axis. While Script mode is driving, it plays the funscript
// instead of oscillating the zone at the engine's allowance (that allowance
// is a limit on the file, and reading it as a speed runs the sleeve flat out).
function wantsScript(axis) {
    if (axis.kind !== 'linear' || axis.centred || axis.role !== 'primary' || !scriptFeed) return false;
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
            restMs: TCODE_TIMINGS.restMs,
            profile: 'tcode'
        });
    }
    return axis.scriptPlanner;
}

function syncScriptPlanner(axis, now) {
    if (!axis.strokePlanner) return;
    const want = wantsScript(axis) ? scriptPlannerOf(axis) : axis.strokePlanner;
    const current = axis.planner;
    if (want === current) return;
    const input = current && current.getInput ? current.getInput() : null;
    const moving = input && input.enabled && input.effectiveSpeed > 0;
    if (moving && current.isInFlight && current.isInFlight(now)) return;
    const at = current && current.lastPosition ? current.lastPosition() : null;
    want.reset();
    if (typeof want.place === 'function') want.place(at);
    if (input) want.setInput(input);
    axis.planner = want;
}

function onScriptFeedChange() {
    if (!isTCodeConnected()) return;
    const now = Date.now();
    device.axes.forEach((axis) => {
        if (!axis.scriptPlanner || axis.planner !== axis.scriptPlanner) return;
        axis.scriptPlanner.poke();
        pumpPlanner(axis, now);
    });
}

export function setTCodeScriptFeed(feed) {
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    scriptFeed = feed && typeof feed === 'object' ? feed : null;
    if (scriptFeed && typeof scriptFeed.subscribe === 'function') {
        try { unsubscribeScriptFeed = scriptFeed.subscribe(onScriptFeedChange); } catch (e) {}
    }
}

// Ask the planner for the next leg and, when it yields one, send it and arm
// a timer for its end. Never sends while a leg is in flight. An idle leg
// (the script is holding, or waiting on the clock) sends nothing: repeating
// the position is not a hold.
function pumpPlanner(axis, now = Date.now()) {
    if (!axis.planner || !isTCodeConnected() || !device.axes.includes(axis)) return;
    syncScriptPlanner(axis, now);
    if (!axis.planner) return;
    const leg = axis.planner.next(now);
    if (!leg) return;
    const quiet = leg.kind === 'idle' || leg.kind === 'hold' || leg.position === null || leg.position === undefined;
    if (!quiet) {
        writeCommands([formatAxisCommand(axis.id, physicalPosition(axis, leg.position), { intervalMs: leg.durationMs })]);
    }
    if (axis.timer) clearTimeout(axis.timer);
    const wait = Math.max(0, Number(leg.durationMs) || 0);
    if (wait === 0) return;
    axis.timer = setTimeout(() => {
        axis.timer = null;
        pumpPlanner(axis, Math.max(Date.now(), axis.planner.legEndsAt()));
    }, wait);
}

function sendScalar(axis, level) {
    if (axis.lastSent === level) return false;
    if (!writeCommands([formatAxisCommand(axis.id, level)])) return false;
    axis.lastSent = level;
    return true;
}

function speedForRole(role, primary, secondary) {
    if (role === 'primary') return primary;
    if (role === 'secondary') return secondary;
    return 0;
}

function applyAxis(axis, primary, secondary, zone, now) {
    const speed = speedForRole(axis.role, primary, secondary);
    const enabled = axis.role !== 'off';
    if (axis.kind === 'linear' && !axis.centred) {
        axis.planner.setInput({ speed, cap: axis.maxCap, zoneMin: zone.min, zoneMax: zone.max, enabled });
        pumpPlanner(axis, now);
    } else if (axis.planner) {
        // Rotation and surge / sway: swing around the centre; amplitude 0
        // (speed 0 or OFF) rests at 0.5. The leg time follows the speed
        // alone (legTravel 1), so a small swing is a slow swing, not a
        // fast twitch.
        const amp = enabled ? rotationAmplitude(speed, axis.maxCap) : 0;
        axis.planner.setInput({ speed, cap: axis.maxCap, zoneMin: 0.5 - amp, zoneMax: 0.5 + amp, enabled: enabled && amp > 0, legTravel: 1 });
        pumpPlanner(axis, now);
    } else {
        sendScalar(axis, enabled ? scalarLevel(speed, axis.maxCap) : 0);
    }
}

function applyLastSpeeds(now = Date.now()) {
    if (!isTCodeConnected()) return;
    device.axes.forEach((axis) => applyAxis(axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, now));
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
// stop / pause (force = true with both speeds 0). strokeMin/strokeMax are
// physical percents already mapped into the hardware envelope by engine.js;
// the envelope is used only to clamp so no position can leave the user's
// bounds. Never throws.
export function dispatchTCode(primarySpeed, secondarySpeed, strokeMin = 0, strokeMax = 100, envMin = 0, envMax = 100, force = false) {
    try {
        const mapped = zoneFromPercent(strokeMin, strokeMax, envMin, envMax);
        lastZone = mapped.zone;
        lastEnvelope = mapped.envelope;
        lastSpeeds = {
            primary: Math.max(0, Math.min(100, Number(primarySpeed) || 0)),
            secondary: Math.max(0, Math.min(100, Number(secondarySpeed) || 0))
        };
        if (!isTCodeConnected()) return;
        if (force && lastSpeeds.primary === 0 && lastSpeeds.secondary === 0) {
            stopTCode();
            return;
        }
        applyLastSpeeds(Date.now());
    } catch (e) {
        // A driver bug must never take the engine tick down with it.
    }
}

// Immediate stop: every in-flight leg is forgotten, L0 goes to the bottom
// of the envelope over restMs, L1 / L2 and the R axes to centre over restMs,
// V/A axes to 0. One line carries all of it. Safe to call at any time;
// returns whether a command was queued.
export function stopTCode() {
    lastSpeeds = { primary: 0, secondary: 0 };
    if (!isTCodeConnected()) return false;
    const now = Date.now();
    const commands = [];
    device.axes.forEach((axis) => {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
        if (axis.planner) {
            axis.planner.reset();
            const rest = axis.centred ? 0.5 : lastEnvelope.min;
            axis.planner.setInput({ speed: 0, zoneMin: rest, zoneMax: axis.centred ? 0.5 : lastEnvelope.max, enabled: false });
            const leg = axis.planner.next(now);
            const position = leg ? leg.position : rest;
            commands.push(formatAxisCommand(axis.id, physicalPosition(axis, position), { intervalMs: leg ? leg.durationMs : TCODE_TIMINGS.restMs }));
        } else {
            axis.lastSent = 0;
            commands.push(formatAxisCommand(axis.id, restPositionFor(axis.id)));
        }
    });
    return writeCommands(commands);
}

// ---- user settings -------------------------------------------------------------------

function findAxis(axisIdx) {
    return device && device.axes[axisIdx] ? device.axes[axisIdx] : null;
}

// Role OFF: the planner interrupts the leg in flight, so the rest move goes
// out at once instead of after the running stroke.
function restAxisNow(axis) {
    if (axis.planner) {
        axis.planner.setInput({ enabled: false, zoneMin: axis.centred ? 0.5 : lastEnvelope.min });
        pumpPlanner(axis);
    } else {
        sendScalar(axis, 0);
    }
}

export function setAxisRole(axisIdx, role) {
    const axis = findAxis(axisIdx);
    if (!axis || !isAxisRole(role)) return false;
    axis.role = role;
    saveTCodeConfig();
    if (!isTCodeConnected()) return true;
    if (role === 'off') restAxisNow(axis);
    else applyAxis(axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    return true;
}

export function setAxisCap(axisIdx, maxCap) {
    const axis = findAxis(axisIdx);
    if (!axis) return false;
    const n = Number(maxCap);
    axis.maxCap = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100;
    saveTCodeConfig();
    if (isTCodeConnected() && axis.role !== 'off') {
        applyAxis(axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

export function setAxisInvert(axisIdx, invert) {
    const axis = findAxis(axisIdx);
    if (!axis || axis.kind !== 'linear') return false;
    axis.invert = Boolean(invert);
    saveTCodeConfig();
    return true;
}

// Short manual test of one axis so the user can see which motor it is: a
// single move up and back for L / R axes, a one-second buzz for V / A.
// Refused while a planner leg is in flight (a session would fight it).
export function testAxis(axisIdx) {
    const axis = findAxis(axisIdx);
    if (!axis || !isTCodeConnected()) return false;
    const s = session;
    if (axis.planner) {
        if (axis.planner.isInFlight(Date.now()) || axis.testTimer) return false;
        const moveMs = TCODE_TIMINGS.testMoveMs;
        let up;
        let down;
        if (axis.centred) {
            up = 0.5 + rotationAmplitude(50, axis.maxCap);
            down = 0.5;
        } else {
            up = physicalPosition(axis, lastZone.max);
            down = physicalPosition(axis, lastZone.min);
        }
        writeCommands([formatAxisCommand(axis.id, up, { intervalMs: moveMs })]);
        axis.testTimer = setTimeout(() => {
            axis.testTimer = null;
            if (session !== s || !isTCodeConnected()) return;
            writeCommands([formatAxisCommand(axis.id, down, { intervalMs: moveMs })]);
            axis.planner.reset();
        }, moveMs + 50);
        return true;
    }
    const level = scalarLevel(60, axis.maxCap);
    writeCommands([formatAxisCommand(axis.id, level)]);
    axis.lastSent = null;
    if (axis.testTimer) clearTimeout(axis.testTimer);
    axis.testTimer = setTimeout(() => {
        axis.testTimer = null;
        if (session !== s || !isTCodeConnected()) return;
        sendScalar(axis, 0);
    }, TCODE_TIMINGS.testHoldMs);
    return true;
}

// Test hook: forget everything without touching a port.
export function resetTCodeForTests() {
    connectInFlight = false;
    connectGeneration += 1;
    if (session) {
        const s = session;
        s.finished = true;
        s.lineSink = null;
        clearAxisTimers();
        detachDisconnectListeners(s);
        session = null;
    }
    clearAxisTimers();
    device = null;
    status = { state: 'offline', text: 'Offline' };
    lastZone = { min: 0, max: 1 };
    lastEnvelope = { min: 0, max: 1 };
    lastSpeeds = { primary: 0, secondary: 0 };
    scriptFeed = null;
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    Object.keys(handlers).forEach((k) => { handlers[k] = null; });
}
