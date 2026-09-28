// Validation of everything that arrives over the WebRTC data channel.
//
// Both directions are untrusted: a controller page may only issue the
// transport / orgasm / mode commands its UI exposes (never limits or raw
// speeds), a viewer may only ping, and the host's telemetry is coerced and
// clamped before it touches the remote page's state. Anything else is
// dropped, never partially applied.
import { ENGINE_MODES, TEASE_MODES, GAME_MODES, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT } from './engine.js';
import {
    MIN_TRAIN_HOLD_SECONDS,
    MAX_TRAIN_HOLD_SECONDS,
    MIN_TRAIN_EDGES,
    MAX_TRAIN_EDGES
} from './session-rules.js';

export const PEER_ROLES = ['controller', 'viewer'];

// Statuses a controller may ASK for. RAMPDOWN is host-internal.
export const COMMAND_STATUSES = ['IDLE', 'RUNNING', 'PAUSED'];

// Statuses the host may REPORT.
export const REMOTE_STATUSES = ['IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN'];

const SIGNAL_STATES = ['ok', 'holding', 'stale'];

export const HISTORY_LENGTH = 60;
export const HR_MAX_BPM = 250;
const SECONDS_MAX = 48 * 3600;
const COUNT_MAX = 100000;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Number() coercion plus range clamp; `undefined` when the value is not a
// finite number at all, so a missing field is never turned into 0.
function clampNumber(value, lo, hi, integer = false) {
    if (value === undefined || value === null || value === '' || typeof value === 'boolean') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const clamped = Math.max(lo, Math.min(hi, n));
    return integer ? Math.round(clamped) : clamped;
}

function oneOf(value, allowed) {
    return allowed.includes(value) ? value : undefined;
}

// Controller / viewer -> host. Returns the sanitized command or null.
export function sanitizeCommand(raw, role = 'controller') {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
    if (raw.type === 'PING') return { type: 'PING' };
    if (role !== 'controller') return null;
    switch (raw.type) {
        case 'SESSION_STATE': {
            const status = oneOf(raw.status, COMMAND_STATUSES);
            return status ? { type: 'SESSION_STATE', status } : null;
        }
        case 'SESSION_RESET':
            return { type: 'SESSION_RESET' };
        case 'ORGASM_TOGGLE':
            return { type: 'ORGASM_TOGGLE' };
        case 'MODE_CHANGE': {
            const mode = oneOf(raw.mode, ENGINE_MODES);
            if (!mode) return null;
            const command = { type: 'MODE_CHANGE', mode };
            // Present only when the sender said so. A game click carries
            // whether that game should be on, so the host does not toggle twice.
            if (typeof raw.enabled === 'boolean') command.enabled = raw.enabled;
            return command;
        }
        default:
            return null;
    }
}

// Host -> controller / viewer. Returns an object holding only the fields
// that were present AND valid (absent fields stay undefined so the remote
// page keeps its previous value), or null when it is not telemetry at all.
export function sanitizeTelemetry(raw) {
    if (!isPlainObject(raw) || raw.type !== 'TELEMETRY') return null;
    const out = { type: 'TELEMETRY' };

    out.hr = clampNumber(raw.hr, 0, HR_MAX_BPM, true);
    out.seconds = clampNumber(raw.seconds, 0, SECONDS_MAX, true);
    out.chosenTargetSeconds = clampNumber(raw.chosenTargetSeconds, 0, SECONDS_MAX, true);
    out.sessionStatus = oneOf(raw.sessionStatus, REMOTE_STATUSES);
    out.edges = clampNumber(raw.edges, 0, COUNT_MAX, true);
    out.pauses = clampNumber(raw.pauses, 0, COUNT_MAX, true);
    out.strokerSpeed = clampNumber(raw.strokerSpeed, 0, 100);
    out.prostateSpeed = clampNumber(raw.prostateSpeed, 0, 100);
    out.minHr = clampNumber(raw.minHr, 30, HR_MAX_BPM, true);
    out.maxHr = clampNumber(raw.maxHr, 30, HR_MAX_BPM, true);
    // The pullback mark, so a remote chart draws the host's line
    // instead of one of its own.
    out.edgeTriggerHr = clampNumber(raw.edgeTriggerHr, 30, HR_MAX_BPM, true);
    out.activeMode = oneOf(raw.activeMode, ENGINE_MODES);
    out.teaseMode = oneOf(raw.teaseMode, TEASE_MODES);
    out.gameMode = raw.gameMode === 'off' ? 'off' : oneOf(raw.gameMode, GAME_MODES);
    out.calibrationPass = raw.calibrationPass === 'dual' ? 'dual' : raw.calibrationPass === 'primary' ? 'primary' : 'off';
    // The host's own game settings. A remote page has its own persisted
    // copies of these, and showing those would quote the PARTNER's numbers
    // back at them while they pace the wearer's session by them.
    out.trainHoldSeconds = clampNumber(raw.trainHoldSeconds, MIN_TRAIN_HOLD_SECONDS, MAX_TRAIN_HOLD_SECONDS, true);
    out.trainEdges = clampNumber(raw.trainEdges, MIN_TRAIN_EDGES, MAX_TRAIN_EDGES, true);
    out.edgeHoldPercent = clampNumber(raw.edgeHoldPercent, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT, true);
    out.orgasmMode = typeof raw.orgasmMode === 'boolean' ? raw.orgasmMode : undefined;
    out.ready = typeof raw.ready === 'boolean' ? raw.ready : undefined;

    if (Array.isArray(raw.history)) {
        const cleaned = [];
        for (const sample of raw.history) {
            const bpm = clampNumber(sample, 0, HR_MAX_BPM, true);
            if (bpm !== undefined) cleaned.push(bpm);
        }
        out.history = cleaned.slice(-HISTORY_LENGTH);
    }

    if (isPlainObject(raw.hrSignal)) {
        out.hrSignal = {
            status: oneOf(raw.hrSignal.status, SIGNAL_STATES) || 'ok',
            noContact: Boolean(raw.hrSignal.noContact),
            silentMs: clampNumber(raw.hrSignal.silentMs, 0, SECONDS_MAX * 1000, true) ?? 0
        };
    }

    return out;
}
