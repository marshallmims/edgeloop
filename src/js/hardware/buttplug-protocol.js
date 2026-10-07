// Buttplug protocol v3 message helpers (Intiface Central). Pure: builders,
// parsers and classifiers only, so the driver's wire format is unit-tested
// without a socket. Facts checked against the spec at docs.buttplug.io:
//   - every frame is a JSON array of message objects;
//   - client Ids are >= 1, the server uses Id 0 for what it initiates;
//   - MaxPingTime > 0 means the client must Ping at least that often;
//   - DeviceMessages attribute arrays carry NO Index: the index is the
//     array position.

export const BUTTPLUG_MESSAGE_VERSION = 3;
export const CLIENT_NAME = 'EdgeLoop';

export const ERROR_CODES = {
    0: 'unknown',
    1: 'handshake',
    2: 'ping',
    3: 'message',
    4: 'device',
    5: 'unknown'
};

export const SCALAR_TYPES = ['Vibrate', 'Oscillate', 'Inflate', 'Constrict', 'Position'];

export function isScalarActuator(type) {
    return SCALAR_TYPES.includes(type);
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

// ---- builders -------------------------------------------------------------

export function buildRequestServerInfo(id, clientName = CLIENT_NAME) {
    return { RequestServerInfo: { Id: id, ClientName: clientName, MessageVersion: BUTTPLUG_MESSAGE_VERSION } };
}

export function buildPing(id) {
    return { Ping: { Id: id } };
}

export function buildRequestDeviceList(id) {
    return { RequestDeviceList: { Id: id } };
}

export function buildStartScanning(id) {
    return { StartScanning: { Id: id } };
}

export function buildStopScanning(id) {
    return { StopScanning: { Id: id } };
}

export function buildStopAllDevices(id) {
    return { StopAllDevices: { Id: id } };
}

export function buildStopDeviceCmd(id, deviceIndex) {
    return { StopDeviceCmd: { Id: id, DeviceIndex: deviceIndex } };
}

export function buildScalarCmd(id, deviceIndex, scalars) {
    return {
        ScalarCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Scalars: scalars.map((s) => ({ Index: s.index, Scalar: clamp01(s.scalar), ActuatorType: s.actuatorType }))
        }
    };
}

export function buildLinearCmd(id, deviceIndex, vectors) {
    return {
        LinearCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Vectors: vectors.map((v) => ({
                Index: v.index,
                Duration: Math.max(0, Math.round(Number(v.durationMs) || 0)),
                // 3 decimals: a 0..999-step TCode axis cannot resolve more,
                // and it keeps 1 - 0.8 from becoming 0.19999999999999996.
                Position: Math.round(clamp01(v.position) * 1000) / 1000
            }))
        }
    };
}

export function buildRotateCmd(id, deviceIndex, rotations) {
    return {
        RotateCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Rotations: rotations.map((r) => ({ Index: r.index, Speed: clamp01(r.speed), Clockwise: r.clockwise !== false }))
        }
    };
}

export function buildSensorReadCmd(id, deviceIndex, sensorIndex, sensorType = 'Battery') {
    return { SensorReadCmd: { Id: id, DeviceIndex: deviceIndex, SensorIndex: sensorIndex, SensorType: sensorType } };
}

// Wire encoding of one or more messages: always a JSON array.
export function encodeFrame(messages) {
    return JSON.stringify(Array.isArray(messages) ? messages : [messages]);
}

// ---- parsers --------------------------------------------------------------

// Decode one frame into an array of message objects. Corrupt JSON, a bare
// object instead of an array, or non-object entries yield [] / are skipped.
export function decodeFrame(data) {
    let parsed;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
        return [];
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') parsed = [parsed];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => m && typeof m === 'object' && !Array.isArray(m));
}

// { type, id, body } for one message object; type 'unknown' when the object
// is not a single-key Buttplug message.
export function classifyMessage(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'unknown', id: 0, body: null };
    const keys = Object.keys(msg);
    if (keys.length !== 1) return { type: 'unknown', id: 0, body: null };
    const type = keys[0];
    const body = msg[type] && typeof msg[type] === 'object' ? msg[type] : {};
    const id = Number.isInteger(body.Id) ? body.Id : 0;
    return { type, id, body };
}

export function parseServerInfo(body) {
    if (!body || typeof body !== 'object') return null;
    const version = Number(body.MessageVersion);
    const maxPing = Number(body.MaxPingTime);
    return {
        serverName: typeof body.ServerName === 'string' && body.ServerName ? body.ServerName : 'Intiface',
        messageVersion: Number.isFinite(version) ? version : 0,
        maxPingTime: Number.isFinite(maxPing) && maxPing > 0 ? maxPing : 0
    };
}

// Ping cadence for a given MaxPingTime: half the server's limit, never
// below 100 ms; 0 means the server does not require pings.
export function pingIntervalMs(maxPingTime) {
    const max = Number(maxPingTime);
    if (!Number.isFinite(max) || max <= 0) return 0;
    return Math.max(100, Math.floor(max / 2));
}

export function describeError(body) {
    const code = Number(body && body.ErrorCode);
    const kind = ERROR_CODES[code] || 'unknown';
    const message = body && typeof body.ErrorMessage === 'string' && body.ErrorMessage
        ? body.ErrorMessage
        : `Intiface error (code ${Number.isFinite(code) ? code : '?'})`;
    return {
        code: Number.isFinite(code) ? code : 0,
        kind,
        message,
        // A handshake failure or a ping timeout ends the connection on the
        // server side; the client should close and report, not retry blindly.
        fatal: kind === 'handshake' || kind === 'ping',
        unsolicited: !(body && Number.isInteger(body.Id) && body.Id > 0)
    };
}

// One attribute list of a v3 DeviceMessages entry. The v3 spec uses arrays
// without Index (position = index); the v2-era object form {FeatureCount,
// ActuatorType} is still tolerated.
function attributeList(cmd, defaultType, typeKey) {
    if (!cmd) return [];
    if (Array.isArray(cmd)) {
        return cmd.map((attr, i) => ({
            index: Number.isInteger(attr && attr.Index) ? attr.Index : i,
            actuatorType: (attr && attr[typeKey]) || defaultType,
            stepCount: Number.isFinite(Number(attr && attr.StepCount)) ? Number(attr.StepCount) : null,
            descriptor: (attr && attr.FeatureDescriptor) || '',
            sensorRange: (attr && attr.SensorRange) || null
        }));
    }
    if (typeof cmd === 'object') {
        const count = Math.max(1, Number(cmd.FeatureCount) || 1);
        return Array.from({ length: count }, (_, i) => ({
            index: i,
            actuatorType: cmd[typeKey] || defaultType,
            stepCount: null,
            descriptor: '',
            sensorRange: null
        }));
    }
    return [];
}

// Normalise a DeviceList / DeviceAdded device entry.
export function parseDevice(dev) {
    if (!dev || typeof dev !== 'object') return null;
    const deviceIndex = Number(dev.DeviceIndex);
    if (!Number.isInteger(deviceIndex)) return null;
    const messages = dev.DeviceMessages && typeof dev.DeviceMessages === 'object' ? dev.DeviceMessages : {};
    const scalars = attributeList(messages.ScalarCmd, 'Vibrate', 'ActuatorType');
    const linears = attributeList(messages.LinearCmd, 'Position', 'ActuatorType');
    const rotations = attributeList(messages.RotateCmd, 'Rotate', 'ActuatorType');
    const sensors = attributeList(messages.SensorReadCmd, 'Battery', 'SensorType')
        .map((s) => ({ index: s.index, sensorType: s.actuatorType, descriptor: s.descriptor, sensorRange: s.sensorRange }));
    const battery = sensors.find((s) => s.sensorType === 'Battery');
    const name = typeof dev.DeviceName === 'string' && dev.DeviceName ? dev.DeviceName : `Device ${deviceIndex}`;
    return {
        deviceIndex,
        name,
        displayName: typeof dev.DeviceDisplayName === 'string' && dev.DeviceDisplayName ? dev.DeviceDisplayName : name,
        timingGapMs: Number(dev.DeviceMessageTimingGap) > 0 ? Number(dev.DeviceMessageTimingGap) : 0,
        scalars,
        linears,
        rotations,
        sensors,
        batterySensorIndex: battery ? battery.index : null,
        canStop: Boolean(messages.StopDeviceCmd)
    };
}

// Stable key for persisting a device's mapping: the name plus the actuator
// layout, so a re-enumerated device (new DeviceIndex) still finds its roles
// while a differently-configured device with the same name does not.
export function deviceSignature(parsed) {
    if (!parsed) return '';
    const sig = (list) => list.map((a) => a.actuatorType).join(',');
    return `${parsed.name}|S:${sig(parsed.scalars)}|L:${sig(parsed.linears)}|R:${sig(parsed.rotations)}`;
}

// Default role for each actuator on a freshly discovered device: the first
// stroke-capable axis is primary, the rest secondary; an internal toy
// (prostate massager / Lovense Edge) defaults to secondary everywhere.
export function defaultRoleFor(parsed, kind, position) {
    const lower = (parsed && parsed.name ? parsed.name : '').toLowerCase();
    const looksInternal = lower.includes('prostate') || lower.includes('edge') || lower.includes('hush');
    if (looksInternal) return 'secondary';
    if (kind === 'linear') return position === 0 ? 'primary' : 'secondary';
    if (kind === 'rotate') return (position === 0 && parsed.linears.length === 0) ? 'primary' : 'secondary';
    return (position === 0 && parsed.linears.length === 0 && parsed.rotations.length === 0) ? 'primary' : 'secondary';
}

function stepsOf(stepCount) {
    const n = Math.round(Number(stepCount));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// The step a LinearCmd for `position` (0..1) lands on. 1000 when the axis
// lists no step count. Used so a held OSSM is never sent the same step twice.
export function linearStep(position, stepCount, bounds = { min: 0, max: 1 }) {
    const n = stepsOf(stepCount) || 1000;
    const lo = Math.ceil(clamp01(bounds && bounds.min) * n - 1e-9);
    const hi = Math.floor(clamp01(bounds && bounds.max !== undefined ? bounds.max : 1) * n + 1e-9);
    let step = Math.round(clamp01(position) * n);
    if (lo <= hi) step = Math.max(lo, Math.min(hi, step));
    return step;
}

// Which Oscillate scalar and which linear axis are one motor. Buttplug lists
// an OSSM (and a Lovense Solace Pro) twice: ScalarCmd Oscillate and LinearCmd
// Position. Driving both sends the machine to its menu, and the OSSM firmware
// runs that as an emergency stop.
export function oscillateTwins(parsed) {
    if (!parsed || !Array.isArray(parsed.scalars) || !Array.isArray(parsed.linears)) return [];
    return pairByFeature(parsed.scalars, 'Oscillate', parsed.linears).map(({ scalar, other }) => ({ scalar, linear: other }));
}

// ScalarCmd Rotate entries that repeat a RotateCmd motor. The RotateCmd one,
// which has the direction, is the one EdgeLoop drives.
export function rotateDuplicates(parsed) {
    if (!parsed || !Array.isArray(parsed.scalars) || !Array.isArray(parsed.rotations)) return [];
    return pairByFeature(parsed.scalars, 'Rotate', parsed.rotations).map(({ scalar }) => scalar);
}

function pairByFeature(scalars, type, others) {
    const mine = scalars.map((a, pos) => ({ a, pos })).filter(({ a }) => a.actuatorType === type);
    const theirs = others.map((a, pos) => ({ a, pos }));
    if (mine.length === 0 || theirs.length === 0) return [];
    if (mine.length === theirs.length && mine.every((o, i) => o.a.descriptor === theirs[i].a.descriptor)) {
        return mine.map((o, i) => ({ scalar: o.pos, other: theirs[i].pos }));
    }
    const pairs = [];
    mine.forEach((o) => {
        const d = o.a.descriptor;
        if (!d) return;
        const sameTheirs = theirs.filter((l) => l.a.descriptor === d);
        const sameMine = mine.filter((x) => x.a.descriptor === d);
        if (sameTheirs.length === 1 && sameMine.length === 1) pairs.push({ scalar: o.pos, other: sameTheirs[0].pos });
    });
    return pairs;
}
