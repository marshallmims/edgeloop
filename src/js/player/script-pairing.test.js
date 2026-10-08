import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pairFiles, AXIS_SUFFIXES, VIDEO_EXTENSIONS } from './script-pairing.js';

const reasonOf = (result, name) => {
    const hit = result.unused.find((u) => (typeof u.item === 'string' ? u.item : u.item.name) === name);
    return hit ? hit.reason : null;
};

describe('pairFiles: the suffix table', () => {
    it('pairs a video with its stroke script', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.funscript']);
        assert.equal(r.video, 'Movie.mp4');
        assert.equal(r.stroke, 'Movie.funscript');
        assert.deepEqual(r.packs, [{ name: null, item: 'Movie.funscript' }]);
        assert.equal(r.loose, false);
        assert.deepEqual(r.unused, []);
    });

    it('sorts vibration and every axis into its channel', () => {
        const r = pairFiles([
            'Movie.mp4', 'Movie.funscript', 'Movie.vib.funscript', 'Movie.surge.funscript', 'Movie.sway.funscript',
            'Movie.twist.funscript', 'Movie.roll.funscript', 'Movie.pitch.funscript'
        ]);
        assert.equal(r.vib, 'Movie.vib.funscript');
        assert.deepEqual(r.axes, {
            L1: 'Movie.surge.funscript',
            L2: 'Movie.sway.funscript',
            R0: 'Movie.twist.funscript',
            R1: 'Movie.roll.funscript',
            R2: 'Movie.pitch.funscript'
        });
        assert.equal(r.stroke, 'Movie.funscript');
        assert.deepEqual(r.unused, []);
        assert.deepEqual(Object.values(AXIS_SUFFIXES), ['L1', 'L2', 'R0', 'R1', 'R2']);
    });

    it('lists files that are neither video nor script as unused', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.funscript', 'notes.txt', 'Movie.srt']);
        assert.equal(reasonOf(r, 'notes.txt'), 'not a video or a .funscript');
        assert.equal(reasonOf(r, 'Movie.srt'), 'not a video or a .funscript');
    });

    it('knows the common browser video containers', () => {
        for (const ext of VIDEO_EXTENSIONS) {
            assert.equal(pairFiles([`a.${ext}`, 'a.funscript']).video, `a.${ext}`);
        }
    });

    it('keeps dots inside a base name', () => {
        const r = pairFiles(['My.Movie.Part.2.mp4', 'My.Movie.Part.2.funscript', 'My.Movie.Part.2.twist.funscript']);
        assert.equal(r.stroke, 'My.Movie.Part.2.funscript');
        assert.equal(r.axes.R0, 'My.Movie.Part.2.twist.funscript');
    });
});

describe('pairFiles: packs', () => {
    it('offers alternate stroke scripts, the plain one first', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.Soft.funscript', 'Movie.funscript', 'Movie.Hard.funscript']);
        assert.equal(r.stroke, 'Movie.funscript');
        assert.deepEqual(r.packs.map((p) => p.name), [null, 'Hard', 'Soft']);
    });

    it('takes the first pack when there is no plain stroke script', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.Soft.funscript', 'Movie.Hard.funscript']);
        assert.equal(r.stroke, 'Movie.Hard.funscript');
        assert.equal(r.packs.length, 2);
    });

    it('leaves a pack\'s own axis file unused for now', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.funscript', 'Movie.Hard.twist.funscript']);
        assert.match(reasonOf(r, 'Movie.Hard.twist.funscript'), /alternate pack/);
        assert.equal(r.axes.R0, null);
    });
});

describe('pairFiles: case', () => {
    it('matches names without regard to case and hands back the items as given', () => {
        const video = { name: 'MOVIE.MP4', size: 1 };
        const script = { name: 'movie.FunScript', size: 2 };
        const vib = { name: 'Movie.VIB.funscript', size: 3 };
        const r = pairFiles([script, video, vib]);
        assert.equal(r.video, video);
        assert.equal(r.stroke, script);
        assert.equal(r.vib, vib);
    });

    it('a pack keeps the spelling of its file', () => {
        const r = pairFiles(['movie.mp4', 'MOVIE.HardCore.funscript']);
        assert.equal(r.packs[0].name, 'HardCore');
    });
});

describe('pairFiles: no video', () => {
    it('takes a lone stroke script and its axes, with no video', () => {
        const r = pairFiles(['Movie.funscript', 'Movie.twist.funscript']);
        assert.equal(r.video, null);
        assert.equal(r.stroke, 'Movie.funscript');
        assert.equal(r.axes.R0, 'Movie.twist.funscript');
        assert.equal(r.videos, 0);
    });

    it('chooses no script when several could be the one', () => {
        const r = pairFiles(['A.funscript', 'B.funscript']);
        assert.equal(r.stroke, null);
        assert.equal(reasonOf(r, 'A.funscript'), 'pick the video it belongs to');
    });

    it('an axis file alone is no stroke script', () => {
        const r = pairFiles(['Movie.twist.funscript']);
        assert.equal(r.stroke, null);
        assert.equal(reasonOf(r, 'Movie.twist.funscript'), 'no stroke script with this name');
    });

    it('nothing at all', () => {
        for (const input of [[], null, undefined]) {
            const r = pairFiles(input);
            assert.equal(r.video, null);
            assert.equal(r.stroke, null);
            assert.deepEqual(r.unused, []);
        }
    });

    it('a video alone has no stroke', () => {
        const r = pairFiles(['Movie.mp4']);
        assert.equal(r.video, 'Movie.mp4');
        assert.equal(r.stroke, null);
    });
});

describe('pairFiles: two videos', () => {
    it('plays the one that has a script and lists the other as unused', () => {
        const r = pairFiles(['Other.mp4', 'Movie.webm', 'Movie.funscript']);
        assert.equal(r.video, 'Movie.webm');
        assert.equal(r.stroke, 'Movie.funscript');
        assert.equal(r.videos, 2);
        assert.match(reasonOf(r, 'Other.mp4'), /one video plays at a time/);
    });

    it('with scripts for both, the first picked wins and the rest are unused', () => {
        const r = pairFiles(['B.mp4', 'A.mp4', 'A.funscript', 'B.funscript']);
        assert.equal(r.video, 'B.mp4');
        assert.equal(r.stroke, 'B.funscript');
        assert.match(reasonOf(r, 'A.mp4'), /one video/);
        assert.match(reasonOf(r, 'A.funscript'), /does not match the video/);
    });

    it('never pairs loosely when there are two videos', () => {
        const r = pairFiles(['A.mp4', 'B.mp4', 'C.funscript']);
        assert.equal(r.stroke, null);
        assert.equal(r.loose, false);
    });
});

describe('pairFiles: names that differ', () => {
    it('pairs one video with one stroke script loosely, and says so', () => {
        const r = pairFiles(['VID_2024.mp4', 'Scene 3.funscript', 'Scene 3.twist.funscript']);
        assert.equal(r.stroke, 'Scene 3.funscript');
        assert.equal(r.loose, true);
        assert.equal(r.axes.R0, 'Scene 3.twist.funscript');
    });

    it('does not pair loosely when there are two stroke scripts to choose from', () => {
        const r = pairFiles(['VID.mp4', 'A.funscript', 'B.funscript']);
        assert.equal(r.stroke, null);
        assert.equal(r.loose, false);
        assert.match(reasonOf(r, 'A.funscript'), /does not match/);
    });

    it('a matching name always beats a loose pairing', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.funscript', 'Other.funscript']);
        assert.equal(r.stroke, 'Movie.funscript');
        assert.equal(r.loose, false);
        assert.match(reasonOf(r, 'Other.funscript'), /does not match/);
    });

    it('the same script twice is used once', () => {
        const r = pairFiles(['Movie.mp4', 'Movie.funscript', 'movie.funscript']);
        assert.equal(r.stroke, 'Movie.funscript');
        assert.equal(reasonOf(r, 'movie.funscript'), 'the same script twice');
    });
});
