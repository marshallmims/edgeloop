/**
 * PeerJS wrapper for remote control.
 *
 * Roles: the HOST owns the session and accepts ONE controller (transport,
 * orgasm and mode commands) plus any number of read-only VIEWERS. A remote
 * page is either a controller (?partner=) or a viewer (?group_sub=). Every
 * inbound message is validated in peer-messages.js before a callback sees
 * it. Peer and DataConnection errors, closes and silences are all surfaced
 * so nobody is ever shown as "connected" while the link is dead.
 *
 * Nothing here touches window.Peer at import time, so the module loads
 * under node:test; the library is looked up when a peer is created.
 */
import { sanitizeCommand, sanitizeTelemetry } from './peer-messages.js';

// A remote page pings every PING_MS; the host drops a link that has been
// silent for STALE_PEER_MS (pruneStalePeers is called from its clock).
export const PING_MS = 5000;
export const STALE_PEER_MS = 20000;

let peer = null;
let localRole = null;          // 'host' | 'controller' | 'viewer'
let handlers = {};
let controllerConn = null;     // host: the one live controller
const viewerConns = new Set(); // host: live viewers
const lastSeen = new Map();    // host: DataConnection -> last inbound timestamp
let hostConn = null;           // remote page: the link to the host
let pingTimer = null;
let qualityTimer = null;

// Recent Share Control events for the session log. No peer id, room link,
// ICE candidate, or address is stored. The export allowlist drops anything
// that is not one of these fields anyway.
const SHARE_TRACE_MAX = 64;
const shareTrace = [];
const PEER_ERROR_CODES = new Set([
    'library-missing', 'browser-incompatible', 'peer-unavailable',
    'network', 'socket-error', 'socket-closed', 'server-error', 'disconnected',
    'unavailable-id', 'invalid-id', 'invalid-key', 'ssl-unavailable', 'webrtc'
]);
const LINK_REASONS = new Set(['closed', 'ice', 'timeout', 'error', 'replaced']);
const QUIET_COMMANDS = new Set(['MANUAL_FRAME', 'MANUAL_PATTERN', 'PING']);

export function peerErrorCode(err) {
    const type = err && typeof err === 'object' ? err.type : '';
    return PEER_ERROR_CODES.has(type) ? type : 'unknown';
}

// Numbers from a stats report. Candidate lines carry IP addresses, so this
// returns only the three measurements and nothing else.
export function linkQualityFromStats(reports) {
    const out = { rttMs: -1, jitterMs: -1, packetsLost: -1 };
    if (!reports || typeof reports.forEach !== 'function') return out;
    reports.forEach((report) => {
        if (!report || typeof report !== 'object') return;
        if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated === true)) {
            const rtt = Number(report.currentRoundTripTime);
            if (Number.isFinite(rtt) && rtt >= 0) out.rttMs = Math.round(rtt * 1000);
        }
        if (report.type === 'inbound-rtp') {
            const lost = Number(report.packetsLost);
            const jitter = Number(report.jitter);
            if (Number.isFinite(lost) && lost >= 0) out.packetsLost = Math.round(lost);
            if (Number.isFinite(jitter) && jitter >= 0) out.jitterMs = Math.round(jitter * 1000);
        }
    });
    return out;
}

function noteShare(fields) {
    const counts = getPeerCounts();
    shareTrace.push({
        t: Date.now(),
        side: localRole || '',
        who: fields.who || '',
        kind: fields.kind || '',
        reason: fields.reason || '',
        ice: fields.ice || '',
        code: fields.code || '',
        cmd: fields.cmd || '',
        controllers: counts.controllers,
        viewers: counts.viewers,
        rttMs: fields.rttMs,
        jitterMs: fields.jitterMs,
        packetsLost: fields.packetsLost,
        gapMs: fields.gapMs
    });
    if (shareTrace.length > SHARE_TRACE_MAX) shareTrace.splice(0, shareTrace.length - SHARE_TRACE_MAX);
    refreshQualityTimer();
}

export function getShareLinkTrace() {
    return shareTrace.map((item) => ({ ...item }));
}

export function resetShareLinkTrace() {
    shareTrace.length = 0;
}

function refreshQualityTimer() {
    const live = isPeerLinkOpen();
    if (live && !qualityTimer) {
        qualityTimer = setInterval(() => { sampleOpenLinks(); }, PING_MS);
        if (typeof qualityTimer.unref === 'function') qualityTimer.unref();
    } else if (!live && qualityTimer) {
        clearInterval(qualityTimer);
        qualityTimer = null;
    }
}

async function sampleOne(conn, who) {
    const pc = conn && conn.peerConnection;
    if (!pc || typeof pc.getStats !== 'function') return;
    let stats = null;
    try {
        stats = await pc.getStats();
    } catch (e) {
        return;
    }
    const quality = linkQualityFromStats(stats);
    if (quality.rttMs < 0 && quality.jitterMs < 0 && quality.packetsLost < 0) return;
    noteShare({ kind: 'quality', who, ...quality });
}

function sampleOpenLinks() {
    if (localRole === 'host') {
        if (controllerConn && controllerConn.open) sampleOne(controllerConn, 'controller');
        let seen = 0;
        for (const conn of viewerConns) {
            if (seen >= 3) break;
            if (conn.open) {
                sampleOne(conn, 'viewer');
                seen += 1;
            }
        }
    } else if (hostConn && hostConn.open) {
        sampleOne(hostConn, 'host');
    }
    refreshQualityTimer();
}

export function peerLibraryAvailable() {
    return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

// Human text for a PeerJS error object (err.type) or a plain Error.
export function describePeerError(err) {
    const type = err && typeof err === 'object' ? err.type : null;
    switch (type) {
        case 'library-missing':
            return 'the PeerJS signalling library could not be loaded (CDN blocked or offline)';
        case 'browser-incompatible':
            return 'this browser does not support WebRTC data channels';
        case 'peer-unavailable':
            return 'the host room was not found; ask the host to reopen Share Control and send a fresh link';
        case 'network':
        case 'socket-error':
        case 'socket-closed':
        case 'server-error':
            return 'the signalling server could not be reached';
        case 'disconnected':
            return 'the signalling connection was lost';
        case 'unavailable-id':
        case 'invalid-id':
        case 'invalid-key':
        case 'ssl-unavailable':
            return 'the signalling server rejected the room';
        case 'webrtc':
            return 'the WebRTC connection failed';
        default: {
            const message = err && err.message ? String(err.message) : '';
            return message || 'unknown signalling error';
        }
    }
}

function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn === 'function') {
        try {
            fn(...args);
        } catch (e) {
            console.warn(`webrtc handler ${name} failed`, e);
        }
    }
}

function safeClose(conn) {
    try {
        conn.close();
    } catch (e) { /* already gone */ }
}

export function getPeerCounts() {
    return {
        controllers: controllerConn ? 1 : 0,
        viewers: viewerConns.size
    };
}

// Lifecycle shared by host and remote peers.
function wirePeerLifecycle() {
    peer.on('open', (id) => {
        noteShare({ kind: 'signalling-up', who: 'signalling' });
        call('onPeerReady', id);
    });
    peer.on('disconnected', () => {
        // Signalling only: existing data channels may survive. Try to get
        // the signalling link back so new remotes can still join.
        noteShare({ kind: 'signalling-lost', who: 'signalling' });
        call('onSignallingLost');
        if (peer && !peer.destroyed) {
            try {
                peer.reconnect();
            } catch (e) { /* surfaced through the error event */ }
        }
    });
    peer.on('close', () => {
        // The peer was destroyed: every connection is dead with it.
        noteShare({ kind: 'signalling-closed', who: 'signalling', reason: 'closed' });
        if (localRole === 'host') {
            for (const conn of [...viewerConns]) dropHostConn(conn, 'closed');
            if (controllerConn) dropHostConn(controllerConn, 'closed');
        } else {
            dropRemoteLink('closed');
        }
        call('onPeerClosed');
    });
    peer.on('error', (err) => {
        noteShare({ kind: 'error', who: 'signalling', code: peerErrorCode(err) });
        call('onPeerError', describePeerError(err), err);
    });
}

// ---------------------------------------------------------------- host

// A controller or viewer link is gone. Fires the matching disconnect
// callback only for a link that had actually opened.
function dropHostConn(conn, reason, err = null) {
    const wasController = conn === controllerConn;
    const wasViewer = viewerConns.has(conn);
    lastSeen.delete(conn);
    if (wasController) controllerConn = null;
    viewerConns.delete(conn);
    safeClose(conn);
    if (!wasController && !wasViewer) return;
    noteShare({
        kind: 'link-down',
        who: wasController ? 'controller' : 'viewer',
        reason: LINK_REASONS.has(reason) ? reason : 'error',
        code: err ? peerErrorCode(err) : ''
    });
    if (wasController) call('onControllerDisconnected', reason, err);
    if (wasViewer) call('onViewerDisconnected', reason, err);
    call('onCountsChanged', getPeerCounts());
}

function acceptHostConnection(conn) {
    const role = conn.metadata && conn.metadata.role === 'viewer' ? 'viewer' : 'controller';
    conn.on('open', () => {
        lastSeen.set(conn, Date.now());
        if (role === 'controller') {
            // A new controller replaces the old one; the old link is closed
            // quietly (it is not a "disconnect", the seat is simply taken).
            const previous = controllerConn;
            controllerConn = conn;
            if (previous && previous !== conn) {
                lastSeen.delete(previous);
                noteShare({ kind: 'link-down', who: 'controller', reason: 'replaced' });
                safeClose(previous);
            }
            noteShare({ kind: 'link-up', who: 'controller' });
            call('onPartnerConnected');
        } else {
            viewerConns.add(conn);
            noteShare({ kind: 'link-up', who: 'viewer' });
            call('onViewerConnected');
        }
        call('onCountsChanged', getPeerCounts());
    });
    conn.on('data', (raw) => {
        const now = Date.now();
        const prev = lastSeen.get(conn) || 0;
        lastSeen.set(conn, now);
        if (prev && now - prev >= 8000) noteShare({ kind: 'gap', who: role, gapMs: now - prev });
        const cmd = sanitizeCommand(raw, role);
        if (!cmd || QUIET_COMMANDS.has(cmd.type)) return;
        noteShare({ kind: 'command', who: role, cmd: cmd.type });
        call('onCommandReceived', cmd);
    });
    conn.on('close', () => dropHostConn(conn, 'closed'));
    conn.on('error', (err) => dropHostConn(conn, 'error', err));
    conn.on('iceStateChanged', (iceState) => {
        noteShare({ kind: 'ice', who: role, ice: iceState });
        if (iceState === 'failed' || iceState === 'closed') dropHostConn(conn, 'ice');
    });
}

// Returns false when the signalling library is missing (onPeerError is
// called with a message the Share modal can show).
export function initHostPeer(h) {
    handlers = h || {};
    if (!peerLibraryAvailable()) {
        noteShare({ kind: 'error', who: 'signalling', code: 'library-missing' });
        call('onPeerError', describePeerError({ type: 'library-missing' }), { type: 'library-missing' });
        return false;
    }
    if (peer && !peer.destroyed) {
        // Modal reopened: nothing to create, just repeat the room id.
        if (peer.id && !peer.disconnected) call('onPeerReady', peer.id);
        return true;
    }
    localRole = 'host';
    controllerConn = null;
    viewerConns.clear();
    lastSeen.clear();
    peer = new window.Peer();
    wirePeerLifecycle();
    peer.on('connection', acceptHostConnection);
    return true;
}

// Host clock hook: drop every link that has sent nothing (not even a ping)
// for STALE_PEER_MS. Returns how many were dropped.
export function pruneStalePeers(now = Date.now()) {
    if (localRole !== 'host') return 0;
    let dropped = 0;
    for (const [conn, seen] of [...lastSeen.entries()]) {
        if (now - seen > STALE_PEER_MS) {
            dropHostConn(conn, 'timeout');
            dropped += 1;
        }
    }
    return dropped;
}

// Host -> every remote. A send that throws marks that link dead.
export function broadcastPeerTelemetry(payload) {
    if (localRole !== 'host') return;
    const targets = controllerConn ? [controllerConn, ...viewerConns] : [...viewerConns];
    for (const conn of targets) {
        if (!conn.open) continue;
        try {
            conn.send(payload);
        } catch (e) {
            dropHostConn(conn, 'error', e);
        }
    }
}

// -------------------------------------------------------------- remote

function stopPing() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
        if (hostConn && hostConn.open) {
            try {
                hostConn.send({ type: 'PING' });
            } catch (e) {
                dropRemoteLink('error', e);
            }
        }
    }, PING_MS);
}

function dropRemoteLink(reason, err = null) {
    stopPing();
    const conn = hostConn;
    if (!conn) return;
    hostConn = null;
    noteShare({
        kind: 'link-down',
        who: 'host',
        reason: LINK_REASONS.has(reason) ? reason : 'error',
        code: err ? peerErrorCode(err) : ''
    });
    safeClose(conn);
    call('onDisconnected', reason, err);
}

// role: 'controller' | 'viewer'. Returns false when the signalling library
// is missing (onPeerError is called with the message to show).
export function initRemotePeer(room, role, h) {
    handlers = h || {};
    if (!peerLibraryAvailable()) {
        noteShare({ kind: 'error', who: 'signalling', code: 'library-missing' });
        call('onPeerError', describePeerError({ type: 'library-missing' }), { type: 'library-missing' });
        return false;
    }
    localRole = role === 'viewer' ? 'viewer' : 'controller';
    peer = new window.Peer();
    wirePeerLifecycle();
    peer.on('open', () => {
        if (hostConn) return;
        const conn = peer.connect(room, { reliable: true, metadata: { app: 'edgeloop', role: localRole } });
        hostConn = conn;
        conn.on('open', () => {
            startPing();
            noteShare({ kind: 'link-up', who: 'host' });
            call('onConnected');
        });
        conn.on('data', (raw) => {
            const telemetry = sanitizeTelemetry(raw);
            if (telemetry) call('onTelemetryReceived', telemetry);
        });
        conn.on('close', () => dropRemoteLink('closed'));
        conn.on('error', (err) => dropRemoteLink('error', err));
        conn.on('iceStateChanged', (iceState) => {
            noteShare({ kind: 'ice', who: 'host', ice: iceState });
            if (iceState === 'failed' || iceState === 'closed') dropRemoteLink('ice');
        });
    });
    return true;
}

// Controller -> host. A viewer (or the host itself) never sends commands.
export function sendPeerCommand(cmd) {
    if (localRole !== 'controller' || !hostConn || !hostConn.open) return false;
    try {
        hostConn.send(cmd);
        return true;
    } catch (e) {
        dropRemoteLink('error', e);
        return false;
    }
}

// The host is done sharing. Connections close without a "partner
// disconnected" callback: the page that asked to stop already knows.
export function closeHostPeer() {
    if (localRole !== 'host' && !peer) return;
    if (controllerConn) noteShare({ kind: 'link-down', who: 'controller', reason: 'closed' });
    if (viewerConns.size) noteShare({ kind: 'link-down', who: 'viewer', reason: 'closed' });
    const closing = [controllerConn, ...viewerConns].filter(Boolean);
    controllerConn = null;
    viewerConns.clear();
    lastSeen.clear();
    handlers = {};
    localRole = null;
    stopPing();
    for (const conn of closing) safeClose(conn);
    const current = peer;
    peer = null;
    hostConn = null;
    if (current && !current.destroyed) {
        try { current.destroy(); } catch (e) { /* already gone */ }
    }
}

export function isPeerLinkOpen() {
    if (localRole === 'host') return Boolean(controllerConn) || viewerConns.size > 0;
    return Boolean(hostConn && hostConn.open);
}
