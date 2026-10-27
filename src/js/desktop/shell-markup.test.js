// desktop-alpha tracks the website. The page is one layout. The shell tab
// split is not in index.html, and a normal load does not request shell.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

describe('the page keeps the website layout', () => {
    it('does not load the desktop shell', () => {
        assert.equal(html.includes('src/js/desktop/shell.js'), false);
        assert.equal(html.includes('id="shellNav"'), false);
        assert.equal(html.includes('data-shell'), false);
    });

    it('keeps the player visible and the session bundle inside it', () => {
        const player = html.indexOf('id="playerSection" aria-label="Player" class="space-y-3"');
        const bundle = html.indexOf('id="sessionBundle"');
        const manual = html.indexOf('id="manualModeBtn"');
        const cockpit = html.indexOf('id="cockpit" class="space-y-3"');
        assert.ok(player > 0 && player < bundle && bundle < manual && manual < cockpit);
        assert.match(html, /id="partnerShareBtn" aria-pressed="false" aria-label="Share Control"/);
        assert.match(html, /id="deviceBar"/);
        assert.doesNotMatch(html, /id="playerSection"[^>]*\bhidden\b/);
        assert.doesNotMatch(html, /grid-cols-12/);
    });
});
