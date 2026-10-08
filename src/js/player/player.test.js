import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from './player.js';
import { createScriptFeed } from './script-feed.js';
import { VIDEO_STALL_PAUSE_MS } from './player-rules.js';

// A <video> stand-in: an EventTarget with the fields and methods the player
// uses, firing the events a browser fires for them.
class FakeVideo extends EventTarget {
    constructor() {
        super();
        this.paused = true;
        this.ended = false;
        this.currentTime = 0;
        this.duration = 3;
        this.readyState = 0;
        this.playbackRate = 1;
        this.muted = false;
        this.volume = 1;
        this.loop = false;
        this.controls = true;
        this.src = '';
        this.error = null;
        this.playRefusal = null;
    }
    fire(name) { this.dispatchEvent(new Event(name)); }
    play() {
        if (this.playRefusal) return Promise.reject(Object.assign(new Error('refused'), { name: this.playRefusal }));
        if (this.paused) {
            this.paused = false;
            this.fire('play');
            if (!this.paused) this.fire('playing');
        }
        return Promise.resolve();
    }
    pause() {
        if (!this.paused) {
            this.paused = true;
            this.fire('pause');
        }
    }
    load() { this.readyState = 0; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return 'maybe'; }
}

class FakeEl extends EventTarget {
    constructor() {
        super();
        this.textContent = '';
        this.value = '';
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.disabled = false;
        const classes = new Set();
        this.classList = {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }
        };
    }
    setAttribute() {}
    appendChild(c) { this.children.push(c); }
    replaceChildren() { this.children = []; }
    click() { this.dispatchEvent(new Event('click')); }
}

function fakeDoc() {
    const doc = new EventTarget();
    doc.createElement = () => new FakeEl();
    doc.fullscreenElement = null;
    return doc;
}

function fakeFile(name, text, type = '') {
    return { name, size: text.length, lastModified: 1, type, text: async () => text };
}

const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] });

function setup({ status = 'IDLE', coupled = true, block = null } = {}) {
    const video = new FakeVideo();
    const calls = [];
    const timers = [];
    const repeats = [];
    let t = 1000;
    const feed = createScriptFeed({ perfNow: () => t });
    const states = [];
    const realSetState = feed.setVideoState;
    feed.setVideoState = (s) => { states.push(s); return realSetState(s); };
    const samples = [];
    const realSample = feed.sample;
    feed.sample = (o) => { samples.push(o); return realSample(o); };
    const session = { status, coupled };
    const revoked = [];
    let urlCount = 0;
    const els = {
        video,
        stage: new FakeEl(),
        hud: new FakeEl(),
        offsetValue: new FakeEl(),
        error: new FakeEl(),
        pairList: new FakeEl(),
        fullscreenBtn: new FakeEl(),
        theaterBtn: new FakeEl()
    };
    const handlers = {
        transport: () => ({ coupled: session.coupled, sessionStatus: session.status }),
        canChangeFiles: () => block,
        onPlayRequest: () => calls.push('play-request'),
        onPauseRequest: () => calls.push('pause-request'),
        onEnded: () => calls.push('ended'),
        onStall: (s) => calls.push(`stall:${s}`),
        onScript: (s) => calls.push({ script: s }),
        onScriptCleared: (r) => calls.push({ cleared: r }),
        onOffset: (ms) => calls.push(`offset:${ms}`),
        onMediaError: (m) => calls.push(`error:${m}`)
    };
    const player = createPlayer({
        doc: fakeDoc(),
        win: new EventTarget(),
        els,
        feed,
        handlers,
        now: () => t,
        urls: { createObjectURL: () => `blob:${++urlCount}`, revokeObjectURL: (u) => revoked.push(u) },
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        setRepeat: (fn) => { repeats.push(fn); return repeats.length; },
        clearRepeat: () => {}
    });
    return {
        video, feed, player, calls, states, samples, session, revoked, els, repeats,
        advance(ms) { t += ms; },
        tick() { repeats.forEach((fn) => fn()); }
    };
}

describe('player: the video follows the session (spec 1.5)', () => {
    it('turns the video\'s own play into a request and never plays behind the session', () => {
        const s = setup({ status: 'PAUSED' });
        s.video.play();
        assert.equal(s.video.paused, true);
        assert.deepEqual(s.calls, ['play-request']);
        assert.ok(!s.states.includes('playing'));
    });

    it('pauses the session when the video pauses under it', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.play();
        s.video.pause();
        assert.deepEqual(s.calls, ['pause-request']);
        assert.equal(s.states.at(-1), 'paused');
    });

    it('takes the end of the video as the end, not as a pause', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.play();
        s.video.ended = true;
        s.video.pause();
        s.video.fire('ended');
        assert.deepEqual(s.calls, ['ended']);
        assert.equal(s.states.at(-1), 'ended');
    });

    it('leaves a video that is not coupled to the session alone', () => {
        const s = setup({ status: 'IDLE', coupled: false });
        s.video.play();
        assert.equal(s.video.paused, false);
        s.video.pause();
        assert.deepEqual(s.calls, []);
    });

    it('holds the video at an edge without pausing the session, and keeps it held', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.play();
        assert.equal(s.player.holdForEdge(), true);
        assert.equal(s.video.paused, true);
        assert.deepEqual(s.calls, []);
        // A media key that plays it meanwhile is undone.
        s.video.play();
        assert.equal(s.video.paused, true);
        assert.equal(s.player.edgeHeld(), true);
        return s.player.releaseEdge().then((r) => {
            assert.equal(r.ok, true);
            assert.equal(s.video.paused, false);
            assert.equal(s.player.edgeHeld(), false);
        });
    });

    it('ignores a play or a pause that the video has already overtaken', () => {
        const s = setup({ status: 'PAUSED' });
        // A START's play, then a PAUSE before its event arrived.
        s.video.paused = true;
        s.video.fire('play');
        assert.deepEqual(s.calls, [], 'a stale play must not ask to resume');
        s.session.status = 'RUNNING';
        s.video.paused = false;
        s.video.fire('pause');
        assert.deepEqual(s.calls, [], 'a stale pause must not pause the new session');
    });

    it('a session pause clears the edge hold', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.play();
        s.player.holdForEdge();
        s.player.pause();
        assert.equal(s.player.edgeHeld(), false);
    });
});

describe('player: the clock', () => {
    it('gives the feed its time only while the video plays', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.currentTime = 1.25;
        s.video.play();
        assert.equal(s.states.at(-1), 'playing');
        assert.equal(s.samples.at(-1).mediaMs, 1250);
        assert.equal(s.samples.at(-1).source, 'read');
        s.video.fire('seeking');
        assert.equal(s.states.at(-1), 'seeking');
        s.video.fire('seeked');
        assert.equal(s.states.at(-1), 'playing');
        s.video.fire('waiting');
        assert.equal(s.states.at(-1), 'waiting');
    });

    it('takes requestVideoFrameCallback frames, and reads only when no frame is fresh', () => {
        const s = setup({ status: 'RUNNING' });
        let cb = null;
        s.video.requestVideoFrameCallback = (fn) => { cb = fn; return 1; };
        s.video.play();
        assert.equal(typeof cb, 'function');
        const before = s.samples.length;
        cb(1000, { mediaTime: 2, expectedDisplayTime: 1016 });
        assert.equal(s.samples.at(-1).source, 'frame');
        assert.equal(s.samples.at(-1).mediaMs, 2000);
        assert.equal(s.samples.at(-1).perfMs, 1016);
        s.tick();
        assert.equal(s.samples.length, before + 1, 'a fresh frame makes the read unnecessary');
        s.advance(400);
        s.tick();
        assert.equal(s.samples.at(-1).source, 'read');
    });

    it('reports a buffering stall once it outlasts 30 s', () => {
        const s = setup({ status: 'RUNNING' });
        s.video.play();
        s.video.fire('waiting');
        s.advance(VIDEO_STALL_PAUSE_MS - 1);
        s.tick();
        assert.deepEqual(s.calls, []);
        s.advance(2);
        s.tick();
        s.tick();
        assert.deepEqual(s.calls, [`stall:${VIDEO_STALL_PAUSE_MS / 1000}`]);
    });

    it('puts a changed playback rate back to 1', () => {
        const s = setup();
        s.video.playbackRate = 2;
        s.video.fire('ratechange');
        assert.equal(s.video.playbackRate, 1);
    });
});

describe('player: files', () => {
    it('pairs a video with its script, parses it and hands over its hash', async () => {
        const s = setup();
        await s.player.addFiles([fakeFile('Movie.mp4', 'x', 'video/mp4'), fakeFile('Movie.funscript', SCRIPT)]);
        assert.equal(s.video.src, 'blob:1');
        assert.equal(s.player.hasVideo(), true);
        const loaded = s.calls.find((c) => c.script);
        assert.ok(loaded, JSON.stringify(s.calls));
        assert.match(loaded.script.hash, /^[0-9a-f]{64}$/);
        assert.equal(loaded.script.meta.actions, 3);
        assert.equal(loaded.script.track.at.length, 3);
        assert.equal(s.player.script().stats.maxSpeed, 200);
    });

    it('takes the video and the script from two picks, and revokes a replaced video', async () => {
        const s = setup();
        await s.player.addFiles([fakeFile('Movie.mp4', 'x')]);
        await s.player.addFiles([fakeFile('Movie.funscript', SCRIPT)]);
        assert.ok(s.calls.some((c) => c.script));
        await s.player.addFiles([fakeFile('Other.mp4', 'y'), fakeFile('Other.funscript', SCRIPT)]);
        assert.deepEqual(s.revoked, ['blob:1']);
        assert.equal(s.video.src, 'blob:2');
    });

    it('refuses a bad script with its reason and leaves no script loaded', async () => {
        const s = setup();
        await s.player.addFiles([fakeFile('Movie.mp4', 'x'), fakeFile('Movie.funscript', '{"actions":[{"at":0,"pos":5}]}')]);
        const cleared = s.calls.find((c) => c.cleared);
        assert.ok(cleared && cleared.cleared.refused, JSON.stringify(s.calls));
        assert.equal(s.player.script(), null);
        assert.equal(s.els.error.textContent, cleared.cleared.refused);
    });

    it('changes nothing while the session refuses a change of files', async () => {
        const s = setup({ block: 'Stop the session first.' });
        const ok = await s.player.addFiles([fakeFile('Movie.mp4', 'x')]);
        assert.equal(ok, false);
        assert.equal(s.player.hasVideo(), false);
        assert.equal(s.els.error.textContent, 'Stop the session first.');
    });

    it('needs a frame before the video counts as ready', async () => {
        const s = setup();
        await s.player.addFiles([fakeFile('Movie.mp4', 'x')]);
        assert.equal(s.player.videoReady(), false);
        s.video.readyState = 2;
        assert.equal(s.player.videoReady(), true);
    });

    it('reports a video the browser cannot play, and is not ready then', async () => {
        const s = setup();
        await s.player.addFiles([fakeFile('Movie.mp4', 'x')]);
        s.video.readyState = 2;
        s.video.error = { code: 4 };
        s.video.fire('error');
        assert.equal(s.player.videoReady(), false);
        assert.ok(s.calls.some((c) => typeof c === 'string' && c.startsWith('error:')));
        const r = await s.player.play();
        assert.equal(r.ok, false);
    });

    it('says why a play was refused', async () => {
        const s = setup({ status: 'RUNNING' });
        await s.player.addFiles([fakeFile('Movie.mp4', 'x')]);
        s.video.playRefusal = 'NotAllowedError';
        const r = await s.player.play();
        assert.equal(r.ok, false);
        assert.equal(r.name, 'NotAllowedError');
    });
});

describe('player: offset and theater', () => {
    it('nudges the offset inside the feed\'s bounds and reports it', () => {
        const s = setup();
        assert.equal(s.player.nudgeOffset(50), 50);
        assert.equal(s.els.offsetValue.textContent, '+50 ms');
        assert.deepEqual(s.calls, ['offset:50']);
        s.player.setOffset(5000);
        assert.equal(s.feed.offset(), 2000);
        assert.equal(s.player.nudgeOffset(50), 2000);
    });

    it('offers theater where the stage cannot go fullscreen, with the HUD on', () => {
        const s = setup();
        assert.equal(s.els.fullscreenBtn.classList.contains('hidden'), true);
        s.player.toggleFullscreen();
        assert.equal(s.player.immersive(), true);
        assert.equal(s.els.stage.dataset.theater, 'on');
        assert.equal(s.els.hud.classList.contains('hidden'), false);
        s.player.setTheater(false);
        assert.equal(s.els.hud.classList.contains('hidden'), true);
    });
});
