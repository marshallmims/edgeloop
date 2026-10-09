// Local EdgeLoop. Serves this repo, connects to a HereSphere or DeoVR
// timestamp server, and tells the page the playhead and which script in
// the library matches the video.
//
// Run from the repository directory: node app/host.mjs
// The saved headset address and library folder live in app/app-state.json,
// next to this file, so a copy of the folder keeps its own settings.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
    encodePacket,
    decodePackets,
    extrapolateSync,
    matchLibrary,
    basenameOf,
    normalizeVlc
} from '../src/js/player/sync-protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'app', 'app-state.json');
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv']);
const MAX_LIBRARY = 8000;
const SKIP_DIR = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.funscript': 'application/json; charset=utf-8'
};

function readState(file = STATE_PATH) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
        return {};
    }
}

function writeState(next, file = STATE_PATH) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

function safeId(name, index) {
    return `${index}-${String(name).replace(/[^a-z0-9.]+/gi, '_').slice(0, 80)}`;
}

// Every video and .funscript under `dir`, as { id, name, file }. Names are
// the file names, which is all the matcher needs. The file path stays here.
export function scanLibrary(dir, { max = MAX_LIBRARY } = {}) {
    const root = path.resolve(String(dir || ''));
    const found = [];
    const stack = [root];
    while (stack.length && found.length < max) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (found.length >= max) break;
            if (entry.name.startsWith('.')) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIR.has(entry.name)) stack.push(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).slice(1).toLowerCase();
            if (ext !== 'funscript' && !VIDEO_EXT.has(ext)) continue;
            found.push({ id: safeId(entry.name, found.length), name: entry.name, file: full });
        }
    }
    return { root, files: found };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1_000_000) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve(text ? JSON.parse(text) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(raw)
    });
    res.end(raw);
}

export function createAppHost({ port = 8787, root = ROOT, openBrowser = false, statePath = STATE_PATH, onQuit = null } = {}) {
    const clients = new Set();
    let library = { root: '', files: [] };
    let socket = null;
    let ping = null;
    let push = null;
    let buffer = Buffer.alloc(0);
    let anchor = null;
    let headset = { host: '', port: 23554, connected: false, error: '', kind: 'headset', password: '' };
    let pollTimer = null;
    let lastMatchKey = '';

    function broadcast(event) {
        const line = `data: ${JSON.stringify(event)}\n\n`;
        for (const res of clients) {
            try { res.write(line); } catch (e) { clients.delete(res); }
        }
    }

    function snapshot() {
        const mediaMs = anchor ? extrapolateSync(anchor, Date.now()) : null;
        const videoPath = anchor ? anchor.path : '';
        const scripts = library.files.filter((file) => file.name.toLowerCase().endsWith('.funscript'));
        const match = videoPath ? matchLibrary(videoPath, scripts) : { stroke: null, vib: null };
        return {
            type: 'sync',
            connected: headset.connected,
            error: headset.error,
            source: headset.kind || 'headset',
            host: headset.host,
            port: headset.port,
            library: library.root,
            libraryCount: scripts.length,
            path: videoPath,
            name: basenameOf(videoPath),
            state: anchor && anchor.playing ? 'playing' : (anchor ? 'paused' : 'idle'),
            mediaMs,
            rate: anchor ? anchor.rate : 1,
            stroke: match.stroke ? { id: match.stroke.id, name: match.stroke.name } : null,
            vib: match.vib ? { id: match.vib.id, name: match.vib.name } : null
        };
    }

    function publish() {
        const event = snapshot();
        const key = `${event.path}|${event.stroke && event.stroke.id}|${event.vib && event.vib.id}`;
        event.scriptChanged = key !== lastMatchKey;
        lastMatchKey = key;
        broadcast(event);
    }

    function closeHeadset() {
        headset.connected = false;
        if (ping) clearInterval(ping);
        if (push) clearInterval(push);
        if (pollTimer) clearInterval(pollTimer);
        ping = null;
        push = null;
        pollTimer = null;
        buffer = Buffer.alloc(0);
        if (socket) {
            socket.removeAllListeners();
            socket.destroy();
            socket = null;
        }
    }

    function noteSync(message) {
        if (!message) return;
        anchor = {
            mediaMs: message.mediaMs,
            at: Date.now(),
            rate: message.rate,
            playing: message.playing,
            path: message.path || (anchor ? anchor.path : '')
        };
    }

    async function pollVlc() {
        const target = headset;
        const password = target.password || '';
        const headers = { Authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` };
        const base = `http://${target.host}:${target.port}/requests/status`;
        try {
            let response = await fetch(`${base}.json`, { headers });
            if (response.status === 404) response = await fetch(`${base}.xml`, { headers });
            if (socket) return;
            if (response.status === 401) {
                headset.connected = false;
                headset.error = 'VLC refused the password. Set the Web interface password in VLC, or leave it empty here when VLC has none.';
                publish();
                return;
            }
            if (!response.ok) {
                headset.connected = false;
                headset.error = 'VLC did not answer. Turn on the Web interface.';
                publish();
                return;
            }
            const sync = normalizeVlc(await response.text());
            if (!sync) {
                headset.connected = false;
                headset.error = 'VLC answered, but not with a playback status.';
                publish();
                return;
            }
            headset.connected = true;
            headset.error = '';
            noteSync(sync);
            publish();
        } catch (e) {
            if (socket) return;
            headset.connected = false;
            headset.error = 'VLC is not answering. Enable the Web interface and use port 8080.';
            publish();
        }
    }

    function connectVlc(host, portNumber, password) {
        closeHeadset();
        headset = { host, port: portNumber, connected: false, error: '', kind: 'vlc', password: password || '' };
        pollTimer = setInterval(pollVlc, 400);
        push = setInterval(publish, 200);
        pollVlc();
    }

    function connectHeadset(host, portNumber) {
        closeHeadset();
        headset = { host: String(host || '').trim(), port: portNumber, connected: false, error: '', kind: 'headset', password: '' };
        if (!headset.host) {
            headset.error = 'Type the headset address.';
            publish();
            return;
        }
        const next = net.connect({ host: headset.host, port: headset.port });
        socket = next;
        next.on('connect', () => {
            if (socket !== next) return;
            headset.connected = true;
            headset.error = '';
            ping = setInterval(() => {
                if (socket === next) next.write(encodePacket(null));
            }, 1000);
            push = setInterval(publish, 200);
            publish();
        });
        next.on('data', (chunk) => {
            if (socket !== next) return;
            buffer = Buffer.concat([buffer, chunk]);
            const decoded = decodePackets(buffer);
            buffer = decoded.rest;
            if (decoded.error) headset.error = 'The headset sent a packet this app could not read.';
            for (const message of decoded.messages) {
                if (!message) continue;
                noteSync(message);
            }
            publish();
        });
        next.on('error', (err) => {
            if (socket !== next) return;
            headset.connected = false;
            headset.error = err && err.code === 'ECONNREFUSED'
                ? 'Nothing is listening at that address. Turn on the timestamp server in the headset.'
                : 'Could not reach the headset.';
            publish();
        });
        next.on('close', () => {
            if (socket !== next) return;
            headset.connected = false;
            closeHeadset();
            publish();
        });
    }

    function fileById(id) {
        return library.files.find((file) => file.id === id) || null;
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        try {
            if (req.method === 'GET' && url.pathname === '/edgeloop-app.json') {
                sendJson(res, 200, { app: true, version: 1 });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/app/events') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-store',
                    'Connection': 'keep-alive'
                });
                res.write('\n');
                clients.add(res);
                res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
                req.on('close', () => clients.delete(res));
                return;
            }
            if (req.method === 'POST' && url.pathname === '/app/connect') {
                const body = await readBody(req);
                const host = String(body.host || '').trim();
                const kind = body.kind === 'vlc' ? 'vlc' : 'headset';
                const portNumber = Math.round(Number(body.port) || (kind === 'vlc' ? 8080 : 23554));
                const password = String(body.password || '');
                if (!host || host.length > 200 || portNumber < 1 || portNumber > 65535) {
                    sendJson(res, 400, { ok: false, error: 'Type the player address.' });
                    return;
                }
                const saved = readState(statePath);
                saved.headsetHost = host;
                saved.headsetPort = portNumber;
                saved.source = kind;
                if (kind === 'vlc') saved.vlcPassword = password;
                writeState(saved, statePath);
                if (kind === 'vlc') connectVlc(host, portNumber, password);
                else connectHeadset(host, portNumber);
                sendJson(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/app/disconnect') {
                closeHeadset();
                anchor = null;
                publish();
                sendJson(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/app/quit') {
                sendJson(res, 200, { ok: true });
                setImmediate(() => { if (typeof onQuit === 'function') onQuit(); });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/app/library') {
                const body = await readBody(req);
                const dir = String(body.path || '').trim();
                if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
                    sendJson(res, 400, { ok: false, error: 'That folder does not exist on this computer.' });
                    return;
                }
                library = scanLibrary(dir);
                const saved = readState(statePath);
                saved.libraryPath = library.root;
                writeState(saved, statePath);
                lastMatchKey = '';
                publish();
                sendJson(res, 200, { ok: true, count: library.files.length, path: library.root });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/app/script') {
                const file = fileById(url.searchParams.get('id') || '');
                const rel = file && library.root ? path.relative(library.root, file.file) : '..';
                if (!file || !library.root || rel.startsWith('..') || path.isAbsolute(rel)) {
                    sendJson(res, 404, { ok: false });
                    return;
                }
                const text = fs.readFileSync(file.file, 'utf8');
                sendJson(res, 200, { ok: true, name: file.name, text });
                return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { ok: false });
                return;
            }
            let rel = decodeURIComponent(url.pathname);
            if (rel === '/') rel = '/index.html';
            const filePath = path.resolve(root, '.' + rel);
            if (!filePath.startsWith(root)) {
                res.writeHead(403).end();
                return;
            }
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                res.writeHead(404).end('not found');
                return;
            }
            const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            if (req.method === 'HEAD') res.end();
            else fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'The local app hit an error.' });
        }
    });

    const saved = readState(statePath);
    if (saved.libraryPath && fs.existsSync(saved.libraryPath)) library = scanLibrary(saved.libraryPath);

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const actual = address && address.port ? address.port : port;
            const url = `http://127.0.0.1:${actual}/`;
            if (saved.headsetHost && saved.source === 'vlc') connectVlc(saved.headsetHost, saved.headsetPort || 8080, saved.vlcPassword || '');
            else if (saved.headsetHost) connectHeadset(saved.headsetHost, saved.headsetPort || 23554);
            if (openBrowser) openPage(url);
            let closed = false;
            resolve({
                url,
                port: actual,
                close() {
                    if (closed) return Promise.resolve();
                    closed = true;
                    closeHeadset();
                    anchor = null;
                    for (const res of clients) {
                        try { res.end(); } catch (e) {}
                    }
                    clients.clear();
                    return new Promise((done) => server.close(() => done()));
                }
            });
        });
    });
}

function openPage(url) {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.unref();
    } catch (e) {}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const port = Math.round(Number(process.env.EDGELOOP_PORT) || 8787);
    let appHost = null;
    let stopping = false;
    const shutdown = () => {
        if (stopping) return;
        stopping = true;
        console.log('Stopping. The player connection closes with this window.');
        const done = appHost ? appHost.close() : Promise.resolve();
        done.then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    createAppHost({ port, openBrowser: true, onQuit: shutdown }).then((host) => {
        appHost = host;
        console.log(`EdgeLoop app: ${host.url}`);
        console.log('This window is the program. Leave it open while you play.');
        console.log('It listens only on this computer, for its own page.');
        console.log('Quit in the page, or close this window, and the VLC / headset connection closes too.');
    });
}
