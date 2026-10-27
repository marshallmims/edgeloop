import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmbLocation, childPath, parentPath, displaySmb } from './smb-path.js';

describe('SMB addresses', () => {
    it('reads smb://host/share/folder', () => {
        const parsed = parseSmbLocation('smb://nas/videos/studio/scene');
        assert.equal(parsed.ok, true);
        assert.equal(parsed.location.host, 'nas');
        assert.equal(parsed.location.share, 'videos');
        assert.equal(parsed.location.path, 'studio/scene');
        assert.equal(parsed.display, 'smb://nas/videos/studio/scene');
        assert.equal(parsed.location.password, undefined);
    });

    it('reads a Windows share path', () => {
        const parsed = parseSmbLocation('\\\\nas\\videos\\studio');
        assert.equal(parsed.ok, true);
        assert.deepEqual(
            { host: parsed.location.host, share: parsed.location.share, path: parsed.location.path },
            { host: 'nas', share: 'videos', path: 'studio' }
        );
    });

    it('splits a user and a password off, and the display never shows the password', () => {
        const parsed = parseSmbLocation('smb://ada:secret@nas/videos/a');
        assert.equal(parsed.ok, true);
        assert.equal(parsed.location.username, 'ada');
        assert.equal(parsed.location.password, 'secret');
        assert.equal(parsed.display.includes('secret'), false);
        assert.equal(displaySmb(parsed.location), 'smb://ada@nas/videos/a');
    });

    it('refuses an address with no share', () => {
        const parsed = parseSmbLocation('smb://nas');
        assert.equal(parsed.ok, false);
        assert.match(parsed.error, /share/);
    });

    it('refuses a quote in the folder, which would break the listing command', () => {
        const parsed = parseSmbLocation('smb://nas/videos/a"b');
        assert.equal(parsed.ok, false);
    });

    it('steps into a child and back to the parent', () => {
        const parsed = parseSmbLocation('smb://nas/videos/studio');
        const child = childPath(parsed.location, 'Scene.mp4');
        assert.equal(child.ok, true);
        assert.equal(child.location.path, 'studio/Scene.mp4');
        const parent = parentPath(child.location);
        assert.equal(parent.path, 'studio');
        assert.equal(childPath(parsed.location, '..').ok, false);
    });
});
