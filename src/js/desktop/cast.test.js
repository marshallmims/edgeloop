import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { castMediaUrl, videoExtension } from './cast.js';

describe('a television address', () => {
    it('ends in the video extension so the player will accept it', () => {
        const built = castMediaUrl({
            host: '192.168.1.20',
            port: 17322,
            token: 'abc',
            filePath: '/media/Scene Name.mp4'
        });
        assert.equal(built.ok, true);
        assert.equal(built.url, 'http://192.168.1.20:17322/media/abc/Scene%20Name.mp4');
        assert.equal(videoExtension('/media/Scene Name.mp4'), 'mp4');
    });

    it('refuses a file that is not a video', () => {
        const built = castMediaUrl({ host: 'h', port: 1, token: 't', filePath: '/tmp/notes.txt' });
        assert.equal(built.ok, false);
    });
});
