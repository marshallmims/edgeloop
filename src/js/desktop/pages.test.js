import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageFromHash, hashForPage, shellRequested, PAGES } from './pages.js';

describe('desktop pages', () => {
    it('opens on Loop when the hash is empty or unknown', () => {
        assert.equal(pageFromHash(''), 'loop');
        assert.equal(pageFromHash('#'), 'loop');
        assert.equal(pageFromHash('#/nope'), 'loop');
    });

    it('reads the four pages, and the short names people will type', () => {
        assert.equal(pageFromHash('#/loop'), 'loop');
        assert.equal(pageFromHash('#/video'), 'video');
        assert.equal(pageFromHash('#player'), 'video');
        assert.equal(pageFromHash('#/session'), 'session');
        assert.equal(pageFromHash('#setup'), 'session');
        assert.equal(pageFromHash('#/library'), 'library');
        assert.equal(pageFromHash('#files'), 'library');
        assert.deepEqual(PAGES, ['loop', 'video', 'session', 'library']);
    });

    it('writes a hash the same reader accepts', () => {
        for (const page of PAGES) {
            assert.equal(pageFromHash(hashForPage(page)), page);
        }
        assert.equal(hashForPage('nope'), '#/loop');
    });

    it('the shell is on only when the address asks for it', () => {
        assert.equal(shellRequested(''), false);
        assert.equal(shellRequested('?'), false);
        assert.equal(shellRequested('?shell=0'), false);
        assert.equal(shellRequested('?shell='), false);
        assert.equal(shellRequested('?other=1'), false);
        assert.equal(shellRequested('?shell=1'), true);
        assert.equal(shellRequested('?shell=1&x=2'), true);
    });
});
