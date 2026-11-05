// The control document an AI or another app reads from an agent link.
//
// Pure. The browser fills in the live numbers. The worker stores the
// document and hands it back. Nothing here knows a connection key, a peer
// id, or an address.

import { TEASE_MODES, GAME_MODES } from './engine.js';
import { ENDGAME_TYPES, DURATION_MODES } from './session-rules.js';
import { sanitizeDeviceCatalog, PATTERN_IDS } from './manual-control.js';

export const AGENT_PROTOCOL = 'edgeloop-control';
export const AGENT_VERSION = 1;

const PLAY_LABELS = Object.freeze({
    classic: 'Simple Ramp',
    finisher: 'Finisher',
    milker: 'Prostate Milker',
    shortener: 'Glans Protector',
    headplay: 'Head Play',
    ultimate: 'Ultimate Milker',
    bratty: 'Bratty Tease',
    ruin: 'Ruin & Leak',
    script: 'Script (video player)'
});

const GAME_LABELS = Object.freeze({
    oracle: 'The Oracle',
    survival: 'Survival',
    edgetrain: 'Edge Training',
    calibrate: 'Calibration',
    nnn: 'No Nut November',
    'goal-off': 'Clear the game'
});

// Names a companion snapshot accepts. nnn is a goal, not an engine mode.
const COMPANION_GOALS = new Set(['tease', 'survival', 'edgetrain', 'oracle', 'calibrate', 'nnn']);
const COMPANION_ACTIVE = new Set([...TEASE_MODES, 'script', 'survival', 'oracle', 'edgetrain', 'calibrate']);
const DEVICE_FLAGS = Object.freeze(['simulated_hr', 'hr_ready', 'toy_ready', 'ble', 'handy', 'intiface', 'tcode', 'vacuglide']);

// Closed pause categories from the companion observation. Anything else is
// null, so a device name cannot ride along.
const PAUSE_CATEGORIES = Object.freeze({
    button: 'user',
    edged: 'edged',
    relube: 'relube',
    player: 'player',
    video: 'player',
    'beat-sync': 'player',
    remote: 'remote',
    'hr-signal': 'hr_signal',
    'hr-link': 'hr_signal',
    handy: 'device',
    'handy-stop': 'device',
    vacuglide: 'device',
    intiface: 'device',
    tcode: 'device',
    device: 'device'
});

const ENDGAME_LABELS = Object.freeze({
    orgasm: 'Orgasm',
    rampdown: 'Soft landing',
    denial: 'Denial'
});

export const AGENT_INSTRUCTIONS = [
    'You control an EdgeLoop session through this URL. You do not talk to the toys.',
    'GET this URL to see the menu and the live heart rate, speeds, and toys.',
    'POST one command object to this same URL to change the session.',
    'Or open the same link as a WebSocket with /session on the end. Each state message is this document. Send {"type":"command","command":{...}} on that socket. Closing the socket does not stop the session.',
    'companion uses the names a local companion reads: status, experience, goal, active_mode, hr, movement, devices, safety, and details. goal tease means no game. intensity there is 50 plus the slider.',
    'experience and active_mode include bratty and script. Script applies only when a funscript is already loaded.',
    'details.pause_reason is set while the session is paused: user, edged, relube, player, remote, hr_signal, or device. It is null at any other time.',
    'details.selection_source is media when loading or clearing a funscript changed the play style, and selection when a person chose it.',
    'A play style or a game keeps moving the toys from his heart rate. You do not stream slider positions.',
    'Duration changes apply only before the session starts.',
    'Heart rate is feedback. You cannot change his climax heart rate.',
    'If he says stop, or the heart-rate signal is stale, send SESSION_STATE IDLE.'
].join(' ');

function labeled(ids, labels) {
    return ids.map((id) => ({ id, label: labels[id] || id }));
}

export function agentMenu() {
    return {
        playStyles: labeled([...TEASE_MODES, 'script'], PLAY_LABELS),
        games: labeled([...GAME_MODES, 'nnn', 'goal-off'], GAME_LABELS),
        endgames: labeled(ENDGAME_TYPES, ENDGAME_LABELS),
        durationModes: [
            { id: 'endless', label: 'Endless' },
            { id: 'fixed', label: 'Fixed minutes', minutes: '1-1440' },
            { id: 'range', label: 'Mystery range', minMinutes: '1-1440', maxMinutes: '1-1440' }
        ].filter((item) => DURATION_MODES.includes(item.id)),
        loops: PATTERN_IDS.filter((id) => id !== 'drawn')
    };
}

export function agentCommands() {
    return [
        { type: 'SESSION_STATE', status: ['RUNNING', 'PAUSED', 'IDLE'] },
        { type: 'SESSION_RESET' },
        { type: 'MODE_CHANGE', mode: 'a play style (including bratty or script), a game, or goal-off', enabled: 'boolean, for a game', device: 'optional toy id' },
        { type: 'ENDGAME', endgame: ENDGAME_TYPES },
        { type: 'DURATION', mode: DURATION_MODES, minutes: 'fixed only', minMinutes: 'range only', maxMinutes: 'range only' },
        { type: 'INTENSITY', value: '0-100' },
        { type: 'SPEED_WINDOW', slowest: '0-100', fastest: '0-100' },
        { type: 'ORGASM_TOGGLE' },
        { type: 'EDGE_MARK' },
        { type: 'MANUAL_PATTERN', id: agentMenu().loops, epoch: 'integer, raise it to replace the loop', devices: 'toy ids from state.devices' }
    ];
}

function whole(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
}

function bpm(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(250, Math.round(n)));
}

// Live feedback. Absent or garbage fields become safe defaults. Device rows
// go through the same catalog cleaner the human controller uses.
export function buildAgentState(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const history = [];
    if (Array.isArray(src.history)) {
        for (const sample of src.history) {
            const beat = bpm(sample);
            if (beat !== null) history.push(beat);
        }
    }
    return {
        sessionStatus: ['IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN'].includes(src.sessionStatus) ? src.sessionStatus : 'IDLE',
        elapsedSeconds: Math.max(0, whole(src.elapsedSeconds)),
        targetSeconds: Math.max(0, whole(src.targetSeconds)),
        duration: {
            mode: DURATION_MODES.includes(src.durationMode) ? src.durationMode : 'range',
            fixedMinutes: Math.max(0, whole(src.fixedMinutes)),
            minMinutes: Math.max(0, whole(src.minMinutes)),
            maxMinutes: Math.max(0, whole(src.maxMinutes))
        },
        heart: {
            bpm: src.heartSeen ? bpm(src.bpm) : null,
            resting: bpm(src.resting),
            ceiling: bpm(src.ceiling),
            pullback: bpm(src.pullback),
            signal: ['ok', 'holding', 'stale'].includes(src.signal) ? src.signal : 'ok',
            noContact: Boolean(src.noContact)
        },
        edged: Boolean(src.edged),
        edges: Math.max(0, whole(src.edges)),
        pauses: Math.max(0, whole(src.pauses)),
        playStyle: PLAY_LABELS[src.playStyle] ? src.playStyle : 'classic',
        game: src.game === 'off' || src.game === 'goal-off' ? 'off' : (GAME_LABELS[src.game] ? src.game : 'off'),
        endgame: ENDGAME_LABELS[src.endgame] ? src.endgame : 'orgasm',
        intensity: Math.max(0, Math.min(100, whole(src.intensity, 50))),
        speedSlowest: Math.max(0, Math.min(100, whole(src.speedSlowest))),
        speedFastest: Math.max(0, Math.min(100, whole(src.speedFastest, 100))),
        primaryPercent: Math.max(0, Math.min(100, whole(src.primaryPercent))),
        secondaryPercent: Math.max(0, Math.min(100, whole(src.secondaryPercent))),
        strokeMin: Math.max(0, Math.min(100, whole(src.strokeMin))),
        strokeMax: Math.max(0, Math.min(100, whole(src.strokeMax, 100))),
        orgasm: Boolean(src.orgasm),
        ready: Boolean(src.ready),
        devices: sanitizeDeviceCatalog(src.devices) || [],
        oracle: {
            state: typeof src.oracleState === 'string' ? src.oracleState.slice(0, 24) : 'IDLE',
            timer: Math.max(0, whole(src.oracleTimer))
        },
        training: {
            state: typeof src.trainState === 'string' ? src.trainState.slice(0, 24) : 'climb',
            holdSeconds: Math.max(0, whole(src.trainHoldSeconds)),
            edgesDone: Math.max(0, whole(src.trainEdgesDone)),
            holdGoal: Math.max(0, whole(src.trainHoldGoal)),
            edgesGoal: Math.max(0, whole(src.trainEdgesGoal))
        },
        survival: {
            speedFloor: Math.max(0, Math.min(100, whole(src.survivalSpeedFloor))),
            overdriveBpm: Math.max(0, whole(src.survivalOverdrive))
        },
        activeMode: COMPANION_ACTIVE.has(src.activeMode) ? src.activeMode : '',
        pauseReason: typeof src.pauseReason === 'string' ? src.pauseReason.slice(0, 32) : '',
        selectionSource: src.selectionSource === 'media' ? 'media' : 'selection',
        watchdogPaused: Boolean(src.watchdogPaused),
        links: src.links == null ? null : deviceFlags(src.links),
        calibrationPass: src.calibrationPass === 'primary' || src.calibrationPass === 'dual' ? src.calibrationPass : 'none',
        history: history.slice(-60)
    };
}

function deviceFlags(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const flags = {};
    for (const key of DEVICE_FLAGS) flags[key] = Boolean(src[key]);
    return flags;
}

// The same facts, named the way a local companion snapshot names them.
// goal "tease" means no game is selected. intensity is 50 plus the slider.
// active_mode is the engine mode. nnn stays a goal. bratty and script are
// experiences the companion now accepts.
export function companionSnapshot(state) {
    if (!state || typeof state !== 'object') return null;
    const experience = PLAY_LABELS[state.playStyle] ? state.playStyle : 'classic';
    const goal = COMPANION_GOALS.has(state.game) ? state.game : 'tease';
    const active = COMPANION_ACTIVE.has(state.activeMode)
        ? state.activeMode
        : (COMPANION_ACTIVE.has(goal) ? goal : experience);
    const links = deviceFlags(state.links);
    const rawSignal = state.heart && state.heart.signal;
    const knownSignal = rawSignal === 'ok' || rawSignal === 'holding' || rawSignal === 'stale' ? rawSignal : 'missing';
    let signal = knownSignal;
    if (state.links != null) {
        if (!links.hr_ready) signal = 'missing';
        else if (links.simulated_hr) signal = 'ok';
        else signal = knownSignal;
    }
    const noContact = Boolean(state.heart && state.heart.noContact);
    const fault = noContact
        ? 'no_contact'
        : signal === 'stale'
            ? 'signal_lost'
            : state.links != null && !links.toy_ready
                ? 'device_unready'
                : 'none';
    const hr = state.heart ? state.heart.bpm : null;
    return {
        status: state.sessionStatus,
        seconds: state.elapsedSeconds,
        experience,
        goal,
        active_mode: active,
        hr: state.links != null && !links.hr_ready ? null : hr,
        effective_max: state.heart ? state.heart.ceiling : null,
        pullback: state.heart ? state.heart.pullback : null,
        edges: state.edges,
        intensity: Math.max(50, Math.min(150, 50 + whole(state.intensity, 50))),
        movement: {
            primary: state.primaryPercent,
            secondary: state.secondaryPercent,
            stroke_min: state.strokeMin,
            stroke_max: state.strokeMax
        },
        devices: links,
        safety: {
            signal,
            no_contact: noContact,
            watchdog_paused: Boolean(state.watchdogPaused),
            fault
        },
        details: {
            pause_reason: state.sessionStatus === 'PAUSED' ? (PAUSE_CATEGORIES[state.pauseReason] || null) : null,
            selection_source: state.selectionSource === 'media' ? 'media' : 'selection',
            pauses: Math.max(0, whole(state.pauses)),
            calibration_pass: state.calibrationPass === 'primary' || state.calibrationPass === 'dual' ? state.calibrationPass : 'none'
        }
    };
}

export function agentDocument(state, online = false) {
    return {
        protocol: AGENT_PROTOCOL,
        version: AGENT_VERSION,
        online: Boolean(online),
        instructions: AGENT_INSTRUCTIONS,
        menu: agentMenu(),
        commands: agentCommands(),
        state: state || null,
        companion: companionSnapshot(state)
    };
}

// The first message on the session socket. The token stays in the URL.
export function agentSocketHello(online = false) {
    return {
        type: 'hello',
        protocol: AGENT_PROTOCOL,
        version: AGENT_VERSION,
        socket: 'session',
        online: Boolean(online),
        command: { type: 'command', command: { type: 'SESSION_STATE', status: 'IDLE' } }
    };
}

export function offlineAgentDocument() {
    return agentDocument(null, false);
}

export function mintAgentToken(fill = (bytes) => crypto.getRandomValues(bytes)) {
    const bytes = new Uint8Array(16);
    fill(bytes);
    let text = '';
    if (typeof Buffer !== 'undefined') text = Buffer.from(bytes).toString('base64');
    else text = btoa(String.fromCharCode(...bytes));
    return text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function isAgentToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function agentHttpUrl(origin, token) {
    return `${String(origin || '').replace(/\/$/, '')}/api/agent/${token}`;
}

function agentSocketBase(origin) {
    return String(origin || '').replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export function agentSocketUrl(origin, token) {
    return `${agentSocketBase(origin)}/api/agent/${token}/host`;
}

export function agentControlSocketUrl(origin, token) {
    return `${agentSocketBase(origin)}/api/agent/${token}/control`;
}

export function agentSessionSocketUrl(origin, token) {
    return `${agentSocketBase(origin)}/api/agent/${token}/session`;
}

// Which agent route a path is. Null when it is not an agent link.
export function agentRoute(pathname) {
    const match = String(pathname || '').match(/^\/api\/agent\/([A-Za-z0-9_-]{22})(?:\/(host|control|telemetry|session))?$/);
    if (!match || !isAgentToken(match[1])) return null;
    return { token: match[1], role: match[2] || 'http' };
}
