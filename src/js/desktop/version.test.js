// The full application and the website do not share a version. 2.0 is
// tentative. 1.1.4 stays the site.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../version.js';
import { DESKTOP_VERSION } from './version.js';

describe('the desktop app has its own version', () => {
    it('is tentatively 2.0, and that is not the website version', () => {
        assert.equal(DESKTOP_VERSION, '2.0');
        assert.notEqual(DESKTOP_VERSION, APP_VERSION);
    });

    it('the shell is what shows 2.0, and only after it turns on', () => {
        const shell = readFileSync(new URL('./shell.js', import.meta.url), 'utf8');
        assert.match(shell, /DESKTOP_VERSION/);
        assert.match(shell, /getElementById\('appVersion'\)/);
        assert.match(shell, /getElementById\('shellEdition'\)/);
    });
});
