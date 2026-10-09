// The website and the desktop shell share index.html. This guards the
// split: the shell markup is present, and a normal page load does not
// request the shell script. dev.edgeloop.app stays the one page it is.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

describe('the desktop shell stays off the website', () => {
    it('loads the shell script only when the address asks for it', () => {
        assert.match(html, /get\('shell'\) === '1'/);
        assert.equal(html.includes('<script type="module" src="./src/js/desktop/shell.js">'), false);
    });

    it('the tabs are in the file, and hidden until the shell turns them on', () => {
        assert.match(html, /id="shellNav" class="hidden"/);
        assert.match(html, /id="shellTabs" role="tablist"/);
        assert.match(html, /role="tab" id="shellTabLoop"/);
        assert.match(html, /data-live="loop"/);
        assert.match(html, /data-live="video"/);
        assert.match(html, /id="shellLibrary" data-shell="library" class="hidden /);
        assert.match(html, /id="shellSession" data-shell="session" class="hidden"/);
        assert.match(html, /id="playerSection" data-shell="video"/);
        assert.match(html, /data-shell="loop"/);
        assert.match(html, /id="deviceStatus"/);
    });
});
