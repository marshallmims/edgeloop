// Agent link relay. The EdgeLoop page pushes a control document over a
// WebSocket. An AI or another app GETs that document, POSTs one command,
// or holds /session open and receives the document as it changes.
// The token in the path is the only credential. This worker does not read
// or store an address, a connection key, or a peer id.

import { agentRoute, agentSocketHello, isAgentToken, offlineAgentDocument } from '../src/js/agent-api.js';

const MAX_BODY = 8000;
const MAX_COMMANDS = 400;
const COMMAND_WINDOW_MS = 10000;

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

export class AgentRoom {
    constructor(state) {
        this.state = state;
        this.host = null;
        this.document = null;
        this.telemetry = null;
        this.controls = new Set();
        this.sessions = new Set();
        this.commands = [];
    }

    sendTo(sockets, text) {
        for (const socket of sockets) {
            try { socket.send(text); } catch (e) { sockets.delete(socket); }
        }
    }

    sendControl(text) {
        this.sendTo(this.controls, text);
    }

    sendSession(text) {
        this.sendTo(this.sessions, text);
    }

    greetSession(socket) {
        const online = this.hostOpen();
        try { socket.send(JSON.stringify(agentSocketHello(online))); } catch (e) { /* the next host push retries */ }
        if (this.document) {
            try { socket.send(JSON.stringify({ type: 'state', document: { ...this.document, online } })); } catch (e) { /* the next host push retries */ }
        }
    }

    acceptSessionCommand(socket, msg) {
        const command = msg && msg.command;
        const reject = (error) => {
            try { socket.send(JSON.stringify({ type: 'command-ack', ok: false, error })); } catch (e) { /* the caller already left */ }
        };
        if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string') {
            reject('Command must be a JSON object with a type.');
            return;
        }
        if (!this.hostOpen()) {
            reject('The EdgeLoop page is not connected.');
            return;
        }
        if (!this.allowCommand(Date.now())) {
            reject('Too many commands. Wait a moment.');
            return;
        }
        try {
            this.host.send(JSON.stringify({ type: 'command', command }));
            socket.send(JSON.stringify({ type: 'command-ack', ok: true }));
        } catch (e) {
            reject('The EdgeLoop page is not connected.');
        }
    }

    hostOpen() {
        return Boolean(this.host && this.host.readyState === 1);
    }

    allowCommand(now) {
        this.commands = this.commands.filter((at) => now - at < COMMAND_WINDOW_MS);
        if (this.commands.length >= MAX_COMMANDS) return false;
        this.commands.push(now);
        return true;
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get('Upgrade') === 'websocket' && (url.pathname.endsWith('/host') || url.pathname.endsWith('/control') || url.pathname.endsWith('/session'))) {
            const pair = new WebSocketPair();
            const server = pair[1];
            server.accept();
            if (url.pathname.endsWith('/session')) {
                // An AI holds this socket. It is not the human controller, so
                // closing it does not stop the toys.
                this.sessions.add(server);
                this.greetSession(server);
                server.addEventListener('message', (event) => {
                    let msg = null;
                    try { msg = JSON.parse(String(event.data || '').slice(0, MAX_BODY)); } catch (e) {
                        try { server.send(JSON.stringify({ type: 'command-ack', ok: false, error: 'Command must be a JSON object.' })); } catch (err) { /* already gone */ }
                        return;
                    }
                    if (!msg || msg.type !== 'command') return;
                    this.acceptSessionCommand(server, msg);
                });
                server.addEventListener('close', () => {
                    this.sessions.delete(server);
                });
                return new Response(null, { status: 101, webSocket: pair[0] });
            }
            if (url.pathname.endsWith('/control')) {
                this.controls.add(server);
                if (this.telemetry) {
                    try { server.send(JSON.stringify({ type: 'telemetry', telemetry: this.telemetry })); } catch (e) { /* the next host push retries */ }
                }
                server.addEventListener('message', (event) => {
                    let msg = null;
                    try { msg = JSON.parse(String(event.data || '').slice(0, 32000)); } catch (e) { return; }
                    if (!msg || msg.type !== 'command' || !msg.command || typeof msg.command !== 'object') return;
                    if (!this.hostOpen()) return;
                    try { this.host.send(JSON.stringify({ type: 'command', command: msg.command })); } catch (e) { /* host socket is closing */ }
                });
                server.addEventListener('close', () => {
                    this.controls.delete(server);
                    if (this.controls.size === 0 && this.hostOpen()) {
                        try { this.host.send(JSON.stringify({ type: 'controller-left' })); } catch (e) { /* host is already gone */ }
                    }
                });
                return new Response(null, { status: 101, webSocket: pair[0] });
            }
            if (this.host) {
                try { this.host.close(4000, 'replaced'); } catch (e) { /* the old page is already gone */ }
            }
            this.host = server;
            server.addEventListener('message', (event) => {
                let msg = null;
                try { msg = JSON.parse(event.data); } catch (e) { return; }
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'state' && msg.document && typeof msg.document === 'object') {
                    this.document = msg.document;
                    this.sendSession(JSON.stringify({ type: 'state', document: msg.document }));
                    return;
                }
                if (msg.type === 'telemetry' && msg.telemetry && typeof msg.telemetry === 'object') {
                    this.telemetry = msg.telemetry;
                    this.sendControl(JSON.stringify({ type: 'telemetry', telemetry: msg.telemetry }));
                }
            });
            server.addEventListener('close', () => {
                if (this.host === server) this.host = null;
                const left = JSON.stringify({ type: 'host-left' });
                this.sendControl(left);
                this.sendSession(left);
            });
            return new Response(null, { status: 101, webSocket: pair[0] });
        }

        if (url.pathname.startsWith('/api/room/')) {
            if (request.method === 'PUT') {
                let body = null;
                try { body = await request.json(); } catch (e) { body = null; }
                if (!body || !isAgentToken(body.token)) return json({ ok: false }, 400);
                await this.state.storage.put('token', body.token);
                return json({ ok: true });
            }
            if (request.method === 'GET') {
                const token = await this.state.storage.get('token');
                if (!isAgentToken(token)) return json({ ok: false }, 404);
                return json({ token });
            }
            return json({ ok: false }, 405);
        }

        if (request.method === 'OPTIONS') return json({ ok: true });

        if (request.method === 'GET' && url.pathname.endsWith('/telemetry')) {
            if (!this.telemetry) return json({ online: this.hostOpen() });
            return json(this.telemetry);
        }

        if (request.method === 'GET') {
            const doc = this.document || offlineAgentDocument();
            return json({ ...doc, online: this.hostOpen() && Boolean(this.document) });
        }

        if (request.method === 'POST') {
            if (!this.hostOpen()) return json({ ok: false, error: 'The EdgeLoop page is not connected.' }, 409);
            const now = Date.now();
            if (!this.allowCommand(now)) return json({ ok: false, error: 'Too many commands. Wait a moment.' }, 429);
            let command = null;
            try {
                const text = await request.text();
                if (text.length > MAX_BODY) return json({ ok: false, error: 'Command is too large.' }, 413);
                command = JSON.parse(text);
            } catch (e) {
                return json({ ok: false, error: 'Command must be a JSON object.' }, 400);
            }
            if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string') {
                return json({ ok: false, error: 'Command must be a JSON object with a type.' }, 400);
            }
            try {
                this.host.send(JSON.stringify({ type: 'command', command }));
            } catch (e) {
                return json({ ok: false, error: 'The EdgeLoop page is not connected.' }, 409);
            }
            return json({ ok: true });
        }

        return json({ ok: false, error: 'Use GET to read the session and POST to send a command.' }, 405);
    }
}

function agentToken(pathname) {
    const route = agentRoute(pathname);
    return route ? route.token : '';
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const roomName = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_-]{4,64})$/);
        if (roomName) {
            if (!env.AGENT_ROOMS) return json({ ok: false, error: 'Agent link is not available on this server.' }, 503);
            const room = env.AGENT_ROOMS.get(env.AGENT_ROOMS.idFromName(`peer:${roomName[1]}`));
            return room.fetch(request);
        }
        const token = agentToken(url.pathname);
        if (token) {
            if (!env.AGENT_ROOMS) return json({ ok: false, error: 'Agent link is not available on this server.' }, 503);
            const room = env.AGENT_ROOMS.get(env.AGENT_ROOMS.idFromName(token));
            return room.fetch(request);
        }
        if (url.pathname === '/api/agent' || url.pathname === '/api/agent/') {
            return json(offlineAgentDocument());
        }
        const asset = await env.ASSETS.fetch(request);
        const type = asset.headers.get('content-type') || '';
        if (!type.includes('text/html') && !type.includes('javascript') && !url.pathname.endsWith('.js')) return asset;
        const headers = new Headers(asset.headers);
        headers.set('Cache-Control', 'no-cache');
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }
};
