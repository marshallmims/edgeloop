// Agent link relay. The EdgeLoop page pushes a control document over a
// WebSocket. An AI or another app GETs that document and POSTs one command.
// The token in the path is the only credential. This worker does not read
// or store an address, a connection key, or a peer id.

import { isAgentToken, offlineAgentDocument } from '../src/js/agent-api.js';

const MAX_BODY = 8000;
const MAX_COMMANDS = 20;
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
        this.commands = [];
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
        if (request.headers.get('Upgrade') === 'websocket' && url.pathname.endsWith('/host')) {
            const pair = new WebSocketPair();
            const server = pair[1];
            server.accept();
            if (this.host) {
                try { this.host.close(4000, 'replaced'); } catch (e) { /* the old page is already gone */ }
            }
            this.host = server;
            server.addEventListener('message', (event) => {
                let msg = null;
                try { msg = JSON.parse(event.data); } catch (e) { return; }
                if (!msg || msg.type !== 'state' || !msg.document || typeof msg.document !== 'object') return;
                this.document = msg.document;
            });
            server.addEventListener('close', () => {
                if (this.host === server) this.host = null;
            });
            return new Response(null, { status: 101, webSocket: pair[0] });
        }

        if (request.method === 'OPTIONS') return json({ ok: true });

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
    const match = pathname.match(/^\/api\/agent\/([A-Za-z0-9_-]{22})(?:\/host)?$/);
    return match && isAgentToken(match[1]) ? match[1] : '';
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const token = agentToken(url.pathname);
        if (token) {
            if (!env.AGENT_ROOMS) return json({ ok: false, error: 'Agent link is not available on this server.' }, 503);
            const room = env.AGENT_ROOMS.get(env.AGENT_ROOMS.idFromName(token));
            return room.fetch(request);
        }
        if (url.pathname === '/api/agent' || url.pathname === '/api/agent/') {
            return json(offlineAgentDocument());
        }
        return env.ASSETS.fetch(request);
    }
};
