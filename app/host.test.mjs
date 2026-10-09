import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppHost, scanLibrary } from './host.mjs';
import { encodePacket } from '../src/js/player/sync-protocol.js';

function readSync(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let buf = '';
            const timer = setTimeout(() => {
                req.destroy();
                reject(new Error('no sync'));
            }, 3000);
            res.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const parts = buf.split('\n\n');
                buf = parts.pop() || '';
                for (const part of parts) {
                    const line = part.split('\n').find((item) => item.startsWith('data: '));
                    if (!line) continue;
                    const data = JSON.parse(line.slice(6));
                    if (data.connected && data.stroke && data.stroke.name === 'Scene.funscript' && data.mediaMs >= 4000) {
                        clearTimeout(timer);
                        req.destroy();
                        resolve(data);
                    }
                }
            });
        });
        req.on('error', (err) => {
            if (err.code !== 'ECONNRESET') reject(err);
        });
    });
}

describe('local app host', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-app-'));
    fs.writeFileSync(path.join(dir, 'Scene.funscript'), '{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}');
    fs.writeFileSync(path.join(dir, 'Scene.v0.funscript'), '{"actions":[{"at":0,"pos":10},{"at":1000,"pos":20}]}');
    const statePath = path.join(dir, 'state.json');
    let host;
    let headset;

    after(async () => {
        if (host) await host.close();
        if (headset) headset.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('scans a folder and keeps only videos and scripts', () => {
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'nope');
        const found = scanLibrary(dir);
        const names = found.files.map((file) => file.name).sort();
        assert.deepEqual(names, ['Scene.funscript', 'Scene.v0.funscript']);
    });

    it('follows a headset timestamp server and names the matching script', async () => {
        headset = net.createServer((socket) => {
            socket.write(encodePacket({
                path: '/storage/Movies/Scene.mp4',
                duration: 30,
                currentTime: 4,
                playbackSpeed: 1,
                playerState: 0
            }));
            socket.on('data', () => {});
        });
        await new Promise((resolve) => headset.listen(0, '127.0.0.1', resolve));
        const headsetPort = headset.address().port;
        host = await createAppHost({ port: 0, openBrowser: false, statePath });
        const library = await fetch(host.url + 'app/library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir })
        });
        assert.equal((await library.json()).ok, true);
        const connect = await fetch(host.url + 'app/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: '127.0.0.1', port: headsetPort })
        });
        assert.equal((await connect.json()).ok, true);
        const seen = await readSync(host.url + 'app/events');
        assert.equal(seen.vib.name, 'Scene.v0.funscript');
        assert.equal(seen.state, 'playing');
        const script = await fetch(host.url + 'app/script?id=' + encodeURIComponent(seen.stroke.id));
        const body = await script.json();
        assert.equal(body.name, 'Scene.funscript');
        assert.match(body.text, /actions/);
    });
});
