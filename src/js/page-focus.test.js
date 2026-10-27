import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOCUS_LOST_TEXT, pageIsInFront } from './page-focus.js';

describe('the page is in front', () => {
    it('only while it is focused and visible', () => {
        assert.equal(pageIsInFront({ hasFocus: true, visibilityState: 'visible' }), true);
        assert.equal(pageIsInFront({ hasFocus: false, visibilityState: 'visible' }), false);
        assert.equal(pageIsInFront({ hasFocus: true, visibilityState: 'hidden' }), false);
        assert.equal(pageIsInFront({ hasFocus: false, visibilityState: 'hidden' }), false);
        assert.equal(pageIsInFront({}), true);
    });
});

describe('the lost-focus banner', () => {
    it('is on the page, blurs what is behind it, and uses the same words as the module', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.match(html, /id="focusLostOverlay"/);
        assert.match(html, /backdrop-blur/);
        assert.ok(html.includes(FOCUS_LOST_TEXT));
        assert.match(app, /pageIsInFront/);
        assert.match(app, /focusLostOverlay/);
        assert.match(FOCUS_LOST_TEXT, /not the focused window/);
        assert.match(FOCUS_LOST_TEXT, /toy updates can slow down/);
    });
});
