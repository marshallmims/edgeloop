import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startDesktopHost } from './host.mjs';
import { followTimestampServer } from './deo-link.mjs';

const host = await startDesktopHost({ appPort: 0, mediaPort: 0 });
after(() => host.close());

function get(url, headers) {
    return fetch(url, { headers });
}

describe('desktop host', () => {
    it('serves the app and says whether smbclient is present', async () => {
        const page = await get(host.url);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /id="shellNav"/);
        const status = await (await get(`http://127.0.0.1:${host.appPort}/desktop-api/status`)).json();
        assert.equal(status.ok, true);
        assert.equal(typeof status.smbclient, 'boolean');
        assert.equal(status.deo.hosting, false);
    });

    it('serves a video with a range, at an address that ends in the file name', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'edgeloop-media-'));
        const filePath = path.join(dir, 'Scene.mp4');
        try {
            writeFileSync(filePath, Buffer.from('0123456789abcdef'));
            const posted = await fetch(`http://127.0.0.1:${host.appPort}/desktop-api/media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath })
            });
            const body = await posted.json();
            assert.equal(body.ok, true);
            assert.match(body.url, /\/Scene\.mp4$/);
            const part = await get(body.url, { Range: 'bytes=0-3' });
            assert.equal(part.status, 206);
            assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('hosts a timestamp clock another tool can follow', async () => {
        const opened = await fetch(`http://127.0.0.1:${host.appPort}/desktop-api/deo/host`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, port: 0 })
        });
        const openedBody = await opened.json();
        assert.equal(openedBody.ok, true);
        assert.ok(openedBody.deo.hostPort > 0);
        await fetch(`http://127.0.0.1:${host.appPort}/desktop-api/deo/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'Scene.mp4', currentTime: 8.5, duration: 90, motion: 'playing' })
        });
        const follow = followTimestampServer({ host: '127.0.0.1', port: openedBody.deo.hostPort });
        try {
            const seen = await waitFor(() => follow.latest());
            assert.equal(seen.path, 'Scene.mp4');
            assert.equal(seen.currentTime, 8.5);
            assert.equal(seen.motion, 'playing');
        } finally {
            follow.close();
            await fetch(`http://127.0.0.1:${host.appPort}/desktop-api/deo/host`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            });
        }
    });
});

async function waitFor(read) {
    const start = Date.now();
    for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() - start > 2000) throw new Error('the timestamp clock did not answer');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
