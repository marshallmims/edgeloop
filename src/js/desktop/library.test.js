import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchLibrary, normalizeMediaKey, scoreKeys } from './library.js';

const names = (row) => ({
    video: row.video.name,
    stroke: row.stroke && row.stroke.name,
    vib: row.vib && row.vib.name,
    match: row.match
});

describe('matchLibrary', () => {
    it('pairs a video with its stroker and its secondary in the same folder', () => {
        const result = matchLibrary([
            'share/Movie.mp4',
            'share/Movie.funscript',
            'share/Movie.v0.funscript'
        ]);
        assert.equal(result.videos.length, 1);
        assert.deepEqual(names(result.videos[0]), {
            video: 'Movie.mp4',
            stroke: 'Movie.funscript',
            vib: 'Movie.v0.funscript',
            match: 'exact'
        });
        assert.equal(result.unmatched.length, 0);
    });

    it('accepts the older .vib name as the secondary', () => {
        const result = matchLibrary(['V.mp4', 'V.funscript', 'V.vib.funscript']);
        assert.equal(result.videos[0].vib.name, 'V.vib.funscript');
        assert.equal(result.videos[0].match, 'exact');
    });

    it('pairs every video in a folder with its own scripts, not its neighbor\'s', () => {
        const result = matchLibrary([
            'lib/A.mp4',
            'lib/B.mkv',
            'lib/A.funscript',
            'lib/A.v0.funscript',
            'lib/B.funscript',
            'lib/B.v0.funscript'
        ]);
        assert.deepEqual(result.videos.map(names), [
            { video: 'A.mp4', stroke: 'A.funscript', vib: 'A.v0.funscript', match: 'exact' },
            { video: 'B.mkv', stroke: 'B.funscript', vib: 'B.v0.funscript', match: 'exact' }
        ]);
    });

    it('does not hand one stray script to every video', () => {
        const result = matchLibrary([
            'lib/A.mp4',
            'lib/B.mp4',
            'lib/SomethingElse.funscript'
        ]);
        assert.equal(result.videos[0].stroke, null);
        assert.equal(result.videos[1].stroke, null);
        assert.equal(result.videos[0].match, 'none');
        assert.equal(result.unmatched.length, 1);
    });

    it('when the folder has one video and one script, they go together', () => {
        const result = matchLibrary(['only/Clip.mp4', 'only/notes.funscript']);
        assert.equal(result.videos[0].match, 'loose');
        assert.equal(result.videos[0].stroke.name, 'notes.funscript');
    });

    it('a single video still takes the only scripts, secondary included', () => {
        const result = matchLibrary([
            'vr/Scene.Name.2160p.HEVC.mp4',
            'vr/Scene Name.funscript',
            'vr/Scene Name.v0.funscript'
        ]);
        assert.equal(result.videos[0].match, 'loose');
        assert.equal(result.videos[0].stroke.name, 'Scene Name.funscript');
        assert.equal(result.videos[0].vib.name, 'Scene Name.v0.funscript');
    });

    it('in a folder of several videos, resolution and codec still match', () => {
        const result = matchLibrary([
            'vr/Other.mp4',
            'vr/Other.funscript',
            'vr/Scene.Name.2160p.HEVC.mp4',
            'vr/Scene Name.funscript',
            'vr/Scene Name.v0.funscript'
        ]);
        const scene = result.videos.find((row) => row.video.name.startsWith('Scene'));
        assert.equal(scene.match, 'fuzzy');
        assert.equal(scene.stroke.name, 'Scene Name.funscript');
        assert.equal(scene.vib.name, 'Scene Name.v0.funscript');
        assert.equal(normalizeMediaKey('Scene.Name.2160p.HEVC.mp4'), normalizeMediaKey('Scene Name.funscript'));
        const other = result.videos.find((row) => row.video.name === 'Other.mp4');
        assert.equal(other.stroke.name, 'Other.funscript');
    });

    it('finds scripts in a scripts folder next to the video', () => {
        const result = matchLibrary([
            'lib/Movie.mp4',
            'lib/scripts/Movie.funscript',
            'lib/scripts/Movie.v0.funscript'
        ]);
        assert.equal(result.videos[0].match, 'exact');
        assert.equal(result.videos[0].stroke.path, 'lib/scripts/Movie.funscript');
        assert.equal(result.videos[0].vib.path, 'lib/scripts/Movie.v0.funscript');
    });

    it('ignores a short name that happens to sit inside a longer one', () => {
        assert.equal(scoreKeys('fun', 'funscriptcollection'), 0);
        assert.ok(scoreKeys('verylongtitle', 'verylongtitleextra') > 0);
    });

    it('keeps a File handed in with the entry', () => {
        const file = { name: 'Movie.mp4', path: 'Movie.mp4', file: { name: 'Movie.mp4' } };
        const script = { name: 'Movie.funscript', path: 'Movie.funscript' };
        const result = matchLibrary([file, script]);
        assert.equal(result.videos[0].video.file, file.file);
    });
});
