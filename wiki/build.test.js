import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, decorateHeadings, headingsOf, stripTags } from './build.js';

describe('wiki build', () => {
    it('gives headings stable ids and keeps an id the page already set', () => {
        const html = decorateHeadings('<h2>How often a new number arrives</h2><h2 id="kept">Kept</h2><h3>How often a new number arrives</h3>');
        const headings = headingsOf(html);
        assert.deepEqual(headings.map((heading) => heading.id), [
            'how-often-a-new-number-arrives',
            'kept',
            'how-often-a-new-number-arrives-2'
        ]);
    });

    it('builds every linked page, and the search index points at real headings', () => {
        const outDir = mkdtempSync(join(tmpdir(), 'edgeloop-wiki-'));
        try {
            const { pages, search } = buildSite({ outDir });
            const byPath = new Map(pages.map((page) => [page.path, page]));
            assert.ok(byPath.has('/'));
            assert.ok(byPath.has('/bluetooth/'));
            assert.ok(byPath.has('/heart-rate/'));
            assert.equal(readFileSync(join(outDir, '404.html'), 'utf8').includes('That page is not on the wiki'), true);

            for (const page of pages) {
                const html = readFileSync(join(outDir, page.file), 'utf8');
                if (!page.nav) continue;
                assert.match(html, new RegExp(`<title>[^<]*${page.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
                assert.match(html, /aria-current="page"/);
                for (const other of pages) {
                    if (!other.nav) continue;
                    assert.match(html, new RegExp(`href="${other.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
                }
                for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
                    const path = match[1].split('#')[0];
                    if (path === '/icon.svg' || path === '/wiki.css' || path === '/wiki.js' || path === '/search.json') continue;
                    assert.ok(byPath.has(path), `${page.path} links to ${match[1]}`);
                }
            }

            for (const hit of search) {
                const hash = hit.href.indexOf('#');
                const path = hash === -1 ? hit.href : hit.href.slice(0, hash);
                const id = hash === -1 ? '' : hit.href.slice(hash + 1);
                const page = byPath.get(path);
                assert.ok(page, hit.href);
                if (id) assert.ok(page.headings.some((heading) => heading.id === id), hit.href);
                assert.equal(hit.text, hit.text.toLowerCase());
            }

            const heart = readFileSync(join(outDir, 'heart-rate', 'index.html'), 'utf8');
            const bluetooth = readFileSync(join(outDir, 'bluetooth', 'index.html'), 'utf8');
            const control = readFileSync(join(outDir, 'control', 'index.html'), 'utf8');
            assert.match(heart, /0x180D/);
            assert.match(heart, /Polar H10/);
            assert.match(heart, /GloryFit/);
            assert.match(heart, /2 to 5 seconds|2–5 seconds/);
            assert.match(bluetooth, /Bluefy/);
            assert.match(bluetooth, /enable-experimental-web-platform-features/);
            assert.match(bluetooth, /iPad/);
            assert.match(control, /400 milliseconds/);
            assert.match(control, /180 milliseconds/);
            for (const html of [heart, bluetooth, control]) {
                assert.equal(html.includes('±'), false, stripTags(html).slice(0, 80));
                assert.equal(/percent accurate|clinically accurate/i.test(html), false);
            }
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    });

    it('is linked from the app footer and named in the changelog', () => {
        const root = join(import.meta.dirname, '..');
        const app = readFileSync(join(root, 'index.html'), 'utf8');
        const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
        assert.match(app, /https:\/\/wiki\.edgeloop\.app/);
        assert.match(changelog, /wiki\.edgeloop\.app/);
    });
});
