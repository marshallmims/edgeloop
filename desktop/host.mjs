// The desktop host. It serves this repository on 127.0.0.1 and opens the
// paged shell. The website deploy never runs this file.
//
// Three jobs sit beside the pages:
//   the share listing (smbclient, when the machine has it)
//   the headset clock (connect to HereSphere / DeoVR, or listen so a tool
//   that follows DeoVR can follow a video playing here)
//   a file address on the local network, so a television can open a video
//
// The API stays on localhost. The file address is the only thing that
// listens for the television, and only for a file you asked to serve.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { castMediaUrl } from '../src/js/desktop/cast.js';
import { parseSmbLocation, childPath } from '../src/js/desktop/smb-path.js';
import { startTimestampServer, followTimestampServer } from './deo-link.mjs';
import { smbclientAvailable, listShare, fetchShareFile } from './smb-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 17321;
const MEDIA_PORT = 17322;
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.ogv': 'video/ogg',
    '.md': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

function lanIPv4() {
    for (const list of Object.values(networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return '127.0.0.1';
}

function insideRoot(root, urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch (e) { return null; }
    const full = path.resolve(root, `.${decoded}`);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (full !== root && !full.startsWith(prefix)) return null;
    if (full.split(path.sep).includes('.git')) return null;
    return full;
}

function contentType(filePath) {
    return TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveRange(req, res, filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) {
        res.writeHead(404);
        res.end();
        return;
    }
    if (!stat.isFile()) {
        res.writeHead(404);
        res.end();
        return;
    }
    const total = stat.size;
    const type = contentType(filePath);
    const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
    };
        const range = req.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (match[1] === '' && match[2] === '')) {
                res.writeHead(416, headers);
                res.end();
                return;
            }
            let start;
            let end;
            if (match[1] === '') {
                const suffix = Number(match[2]);
                start = Math.max(0, total - suffix);
                end = total - 1;
            } else {
                start = Number(match[1]);
                end = match[2] === '' ? total - 1 : Number(match[2]);
            }
            if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start < 0) {
            res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
            res.end();
            return;
        }
        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': end - start + 1
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': total });
    fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1_000_000) {
                reject(Object.assign(new Error('That request is too large.'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(Object.assign(new Error('That was not JSON.'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-store'
    });
    res.end(data);
}

export async function startDesktopHost({ appPort = 0, mediaPort = 0, root = ROOT } = {}) {
    const media = new Map();
    const sessions = new Map();
    const temps = [];
    let deoServer = null;
    let deoFollow = null;
    const smbOk = await smbclientAvailable();

    function publicState() {
        const latest = deoFollow ? deoFollow.latest() : null;
        return {
            ok: true,
            smbclient: smbOk,
            lanHost: lanIPv4(),
            mediaPort: mediaServer.address().port,
            deo: {
                following: Boolean(deoFollow && deoFollow.connected()),
                followError: deoFollow ? deoFollow.error() : '',
                latest: latest ? {
                    path: latest.path,
                    duration: latest.duration,
                    currentTime: latest.currentTime,
                    playbackSpeed: latest.playbackSpeed,
                    motion: latest.motion,
                    at: latest.at
                } : null,
                hosting: Boolean(deoServer),
                hostPort: deoServer ? deoServer.port : 0,
                lastCommand: deoServer ? deoServer.lastCommand() : null
            }
        };
    }

    async function handleApi(req, res, url) {
        try {
            if (req.method === 'GET' && url.pathname === '/desktop-api/status') {
                sendJson(res, 200, publicState());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/media') {
                const body = await readJson(req);
                const filePath = path.resolve(String(body.path || ''));
                let stat;
                try { stat = fs.statSync(filePath); } catch (e) { stat = null; }
                if (!stat || !stat.isFile()) {
                    sendJson(res, 404, { ok: false, error: 'That file is not on this computer.' });
                    return;
                }
                const built = castMediaUrl({
                    host: lanIPv4(),
                    port: mediaServer.address().port,
                    token: 'pending',
                    filePath
                });
                if (!built.ok) {
                    sendJson(res, 400, { ok: false, error: built.error });
                    return;
                }
                const token = randomBytes(16).toString('hex');
                media.set(token, filePath);
                const urlBuilt = castMediaUrl({
                    host: lanIPv4(),
                    port: mediaServer.address().port,
                    token,
                    filePath
                });
                sendJson(res, 200, { ok: true, url: urlBuilt.url, name: urlBuilt.name });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/deo/follow') {
                const body = await readJson(req);
                if (deoFollow) deoFollow.close();
                deoFollow = null;
                if (body.enabled === false) {
                    sendJson(res, 200, publicState());
                    return;
                }
                const host = String(body.host || '').trim();
                const port = body.port == null || body.port === '' ? 23554 : Number(body.port);
                if (!host || !Number.isFinite(port)) {
                    sendJson(res, 400, { ok: false, error: 'Enter the headset\'s IP address.' });
                    return;
                }
                deoFollow = followTimestampServer({ host, port });
                sendJson(res, 200, publicState());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/deo/host') {
                const body = await readJson(req);
                if (body.enabled === false) {
                    if (deoServer) await deoServer.close();
                    deoServer = null;
                    sendJson(res, 200, publicState());
                    return;
                }
                if (!deoServer) {
                    const port = body.port == null || body.port === '' ? 23554 : Number(body.port);
                    deoServer = await startTimestampServer({ port, host: '0.0.0.0' });
                }
                sendJson(res, 200, publicState());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/deo/state') {
                const body = await readJson(req);
                if (deoServer) {
                    deoServer.setState({
                        path: body.path,
                        duration: Number(body.duration) || 0,
                        currentTime: Number(body.currentTime) || 0,
                        playbackSpeed: Number(body.playbackSpeed) || 1,
                        playerState: body.playerState,
                        motion: body.motion
                    });
                }
                sendJson(res, 200, publicState());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/smb/open') {
                const body = await readJson(req);
                const parsed = parseSmbLocation(String(body.address || ''));
                if (!parsed.ok) {
                    sendJson(res, 400, { ok: false, error: parsed.error });
                    return;
                }
                const location = {
                    ...parsed.location,
                    username: body.username ? String(body.username) : parsed.location.username,
                    password: body.password ? String(body.password) : (parsed.location.password || '')
                };
                const entries = await listShare(location);
                const id = randomBytes(16).toString('hex');
                sessions.set(id, location);
                sendJson(res, 200, { ok: true, id, display: parsed.display, path: location.path, entries });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/smb/list') {
                const body = await readJson(req);
                const saved = sessions.get(String(body.id || ''));
                if (!saved) {
                    sendJson(res, 404, { ok: false, error: 'Open the share again.' });
                    return;
                }
                const next = { ...saved, path: String(body.path ?? saved.path ?? '') };
                const entries = await listShare(next);
                sessions.set(body.id, next);
                sendJson(res, 200, { ok: true, path: next.path, display: `smb://${next.host}/${next.share}${next.path ? `/${next.path}` : ''}`, entries });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/smb/serve') {
                const body = await readJson(req);
                const saved = sessions.get(String(body.id || ''));
                if (!saved) {
                    sendJson(res, 404, { ok: false, error: 'Open the share again.' });
                    return;
                }
                const stepped = childPath({ ...saved, path: String(body.folder || '') }, body.name);
                if (!stepped.ok) {
                    sendJson(res, 400, { ok: false, error: stepped.error });
                    return;
                }
                const dir = await mkdtemp(path.join(tmpdir(), 'edgeloop-smb-video-'));
                temps.push(dir);
                const dest = path.join(dir, path.basename(String(body.name)));
                await fetchShareFile({ ...saved, path: stepped.location.path }, dest);
                const token = randomBytes(16).toString('hex');
                media.set(token, dest);
                const built = castMediaUrl({
                    host: lanIPv4(),
                    port: mediaServer.address().port,
                    token,
                    filePath: dest
                });
                if (!built.ok) {
                    sendJson(res, 400, { ok: false, error: built.error });
                    return;
                }
                sendJson(res, 200, { ok: true, url: built.url, name: built.name });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/desktop-api/smb/file') {
                const body = await readJson(req);
                const saved = sessions.get(String(body.id || ''));
                if (!saved) {
                    sendJson(res, 404, { ok: false, error: 'Open the share again.' });
                    return;
                }
                const stepped = childPath({ ...saved, path: String(body.folder || '') }, body.name);
                if (!stepped.ok) {
                    sendJson(res, 400, { ok: false, error: stepped.error });
                    return;
                }
                const dir = await mkdtemp(path.join(tmpdir(), 'edgeloop-smb-file-'));
                const dest = path.join(dir, 'file');
                try {
                    await fetchShareFile({ ...saved, path: stepped.location.path }, dest);
                    const data = fs.readFileSync(dest);
                    if (data.length > 8_000_000) {
                        sendJson(res, 413, { ok: false, error: 'That script is larger than this copy will take.' });
                        return;
                    }
                    sendJson(res, 200, { ok: true, name: body.name, text: data.toString('utf8') });
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
                return;
            }
            sendJson(res, 404, { ok: false, error: 'No such desktop request.' });
        } catch (err) {
            const status = err.status || (err.code === 'NO_SMBCLIENT' ? 501 : 500);
            sendJson(res, status, { ok: false, error: err.message || 'The desktop host failed.' });
        }
    }

    const mediaServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] !== 'media' || !parts[1]) {
            res.writeHead(404);
            res.end();
            return;
        }
        let token;
        try { token = decodeURIComponent(parts[1]); } catch (e) { token = ''; }
        const filePath = media.get(token);
        if (!filePath) {
            res.writeHead(404);
            res.end();
            return;
        }
        serveRange(req, res, filePath);
    });

    const appServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname.startsWith('/desktop-api/')) {
            handleApi(req, res, url);
            return;
        }
        let filePath = insideRoot(root, url.pathname);
        if (!filePath) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        serveRange(req, res, filePath);
    });

    await listen(mediaServer, mediaPort, '0.0.0.0');
    await listen(appServer, appPort, '127.0.0.1');

    return {
        appPort: appServer.address().port,
        mediaPort: mediaServer.address().port,
        url: `http://127.0.0.1:${appServer.address().port}/?shell=1#/loop`,
        async close() {
            if (deoFollow) deoFollow.close();
            if (deoServer) await deoServer.close();
            await closeServer(appServer);
            await closeServer(mediaServer);
            for (const dir of temps) {
                await rm(dir, { recursive: true, force: true });
            }
        }
    };
}

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const host = await startDesktopHost({ appPort: APP_PORT, mediaPort: MEDIA_PORT });
    console.log(`EdgeLoop desktop  ${host.url}`);
    console.log('The site is unchanged. This window is the paged shell only.');
}
