import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScriptFeed, resolveCeiling } from './script-feed.js';
import { createMediaClock } from './media-clock.js';
import { shapeWindow, DEVICE_CEILINGS, FALLBACK_CEILING, effectiveInvert } from './script-shaper.js';
import { DEFAULT_SCRIPT_SETTINGS } from './script-governor.js';

function trackOf(actions) {
    return {
        at: Int32Array.from(actions.map(([t]) => t)),
        pos: Uint8Array.from(actions.map(([, p]) => p))
    };
}

const TRACK = trackOf([[0, 0], [500, 100], [1000, 0], [1500, 100], [2000, 0], [2500, 100], [3000, 0]]);

function playing({ perf = { t: 0 }, track = TRACK, meta = {} } = {}) {
    const clock = createMediaClock({ maxExtrapolateMs: Infinity });
    const feed = createScriptFeed({ clock, perfNow: () => perf.t });
    feed.setTrack(track, meta);
    feed.setVideoState('playing');
    feed.sample({ mediaMs: 0, perfMs: 0, source: 'frame' });
    feed.setActive(true);
    return { feed, perf, clock };
}

describe('script feed: time', () => {
    it('script time is media time plus the offset, only while Script mode drives a loaded track', () => {
        const { feed, perf } = playing();
        perf.t = 1234;
        assert.equal(feed.scriptNow(), 1234);
        assert.equal(feed.setOffset(250), 250);
        assert.equal(feed.scriptNow(), 1484);
        assert.equal(feed.scriptNow(2000), 2250, 'a given performance time');
        feed.setActive(false);
        assert.equal(feed.scriptNow(), null);
        assert.equal(feed.hasTime(), true, 'the clock still runs: a leg in flight may run out');
        feed.setActive(true);
        feed.setTrack(null);
        assert.equal(feed.isActive(), false);
        assert.equal(feed.scriptNow(), null);
        assert.equal(feed.hasTime(), false);
    });

    it('has no time while the video is paused, seeking, waiting or ended, or before any sample', () => {
        for (const state of ['paused', 'seeking', 'waiting', 'ended', 'idle', 'nonsense']) {
            const { feed } = playing();
            feed.setVideoState(state);
            assert.equal(feed.scriptNow(), null, state);
            assert.equal(feed.hasTime(), false, state);
            // The status line reads it (player-rules scriptPhaseLabel).
            assert.equal(feed.videoState(), state === 'nonsense' ? 'idle' : state);
        }
        const clock = createMediaClock();
        const feed = createScriptFeed({ clock, perfNow: () => 0 });
        feed.setTrack(TRACK);
        feed.setActive(true);
        feed.setVideoState('playing');
        assert.equal(feed.scriptNow(), null, 'playing, but nothing has said where');
    });

    it('a clock nobody has confirmed for 1.5 s is no time (the default clock)', () => {
        const perf = { t: 0 };
        const feed = createScriptFeed({ perfNow: () => perf.t });
        feed.setTrack(TRACK);
        feed.setActive(true);
        feed.setVideoState('playing');
        feed.sample({ mediaMs: 100, perfMs: 0 });
        perf.t = 1000;
        assert.equal(feed.scriptNow(), 1100);
        perf.t = 1600;
        assert.equal(feed.scriptNow(), null);
    });

    it('a broken performance clock is no time, and never throws', () => {
        const feed = createScriptFeed({ clock: createMediaClock(), perfNow: () => { throw new Error('no clock'); } });
        feed.setTrack(TRACK);
        feed.setActive(true);
        feed.setVideoState('playing');
        assert.equal(feed.scriptNow(), null);
        assert.equal(feed.hasTime(), false);
        const nan = createScriptFeed({ perfNow: () => NaN });
        nan.setTrack(TRACK);
        nan.setActive(true);
        assert.equal(nan.scriptNow(), null);
    });

    it('the generation moves on every discontinuity a driver must rejoin after', () => {
        const { feed, perf } = playing();
        const seen = new Set([feed.generation()]);
        const step = (what, fn) => {
            fn();
            const g = feed.generation();
            assert.ok(!seen.has(g), what);
            seen.add(g);
        };
        step('offset', () => feed.setOffset(100));
        step('seek', () => feed.setVideoState('seeking'));
        step('playing again', () => feed.setVideoState('playing'));
        step('first sample', () => feed.sample({ mediaMs: 9000, perfMs: perf.t }));
        step('a jump the clock re-anchors on', () => feed.sample({ mediaMs: 20000, perfMs: perf.t + 10 }));
        step('track', () => feed.setTrack(TRACK));
        step('Script mode off', () => feed.setActive(false));
        step('and on', () => feed.setActive(true));
        const g = feed.generation();
        feed.setOffset(100);
        feed.setActive(true);
        assert.equal(feed.generation(), g, 'no change, no new generation');
    });

    it('clamps the offset to +-2 s in 10 ms steps', () => {
        const { feed } = playing();
        assert.equal(feed.setOffset(5000), 2000);
        assert.equal(feed.setOffset(-123), -120);
        assert.equal(feed.setOffset('junk'), 0);
        assert.equal(feed.offset(), 0);
    });
});

describe('script feed: shaping', () => {
    it('shapes with its own track and settings, exactly as shapeWindow does', () => {
        const meta = { inverted: true };
        const { feed } = playing({ meta });
        feed.setSettings({ scriptApproach: 'both', scriptMaxSpeed: 200, scriptInvert: false });
        const args = { from: 200, to: 2600, allowance: 70, cap: 80, window: { min: 10, max: 90 }, profile: 'tcode', minSegmentMs: 60, startPos: 0.5, rejoin: false, lead: 0 };
        const got = feed.shape(args);
        const settings = feed.settings();
        const want = shapeWindow({
            track: TRACK,
            from: 200,
            to: 2600,
            allowance: 70,
            settings: { approach: 'both', invert: effectiveInvert(meta, settings), smoothing: 'light', maxSpeed: 200 },
            device: { window: { min: 10, max: 90 }, ceiling: DEVICE_CEILINGS.tcode, cap: 80, minSegmentMs: 60 },
            startPos: 0.5,
            rejoin: false,
            lead: 0
        });
        assert.deepEqual(got, want);
        assert.ok(got.points.length > 0);
        // Deterministic: the same question twice is the same answer.
        assert.deepEqual(feed.shape(args), got);
    });

    it('no track: no points', () => {
        const feed = createScriptFeed();
        assert.deepEqual(feed.shape({ from: 0, to: 1000, allowance: 100 }).points, []);
        assert.equal(feed.shape({ from: 0, to: 1000, allowance: 100 }).reason, 'empty');
        assert.equal(feed.setTrack({ at: new Int32Array(1), pos: new Uint8Array(1) }), false, 'one action is no track');
        assert.equal(feed.setTrack({ at: new Int32Array(3), pos: new Uint8Array(2) }), false, 'mismatched arrays are no track');
        assert.equal(feed.hasTrack(), false);
    });

    it('sanitizes its settings and knows each device\'s ceiling', () => {
        const feed = createScriptFeed();
        assert.deepEqual(feed.settings(), { ...DEFAULT_SCRIPT_SETTINGS });
        assert.equal(feed.setSettings({ scriptMaxSpeed: 9999, scriptApproach: 'warp' }).scriptMaxSpeed, 600);
        assert.equal(feed.settings().scriptApproach, 'shorten');
        assert.equal(resolveCeiling('tcode'), 600);
        assert.equal(resolveCeiling('intiface'), 500);
        assert.equal(resolveCeiling('ossm'), 600);
        assert.equal(resolveCeiling(250), 250);
        assert.equal(resolveCeiling('toaster'), FALLBACK_CEILING);
        assert.equal(resolveCeiling(-5), FALLBACK_CEILING);
        assert.equal(resolveCeiling('constructor'), FALLBACK_CEILING);
    });

    it('holds the allowance the engine decided last, 0-100', () => {
        const feed = createScriptFeed();
        assert.equal(feed.allowance(), 0);
        assert.equal(feed.setAllowance(64), 64);
        assert.equal(feed.setAllowance(140), 100);
        assert.equal(feed.setAllowance(NaN), 0);
    });
});

describe('script feed: listeners', () => {
    it('tells every listener about a clock change, Script mode on or off and a new track', () => {
        const { feed } = playing();
        const heard = [];
        const off = feed.subscribe((reason) => heard.push(reason));
        feed.subscribe(() => { throw new Error('a broken listener is ignored'); });
        feed.setVideoState('seeking');
        feed.setVideoState('seeking');
        feed.setActive(false);
        feed.setTrack(TRACK);
        feed.setOffset(50);
        feed.setVideoState('playing');
        // The first sample after it gives the clock its time back; one that
        // agrees with it changes nothing.
        feed.sample({ mediaMs: 5000, perfMs: 10 });
        feed.sample({ mediaMs: 5010, perfMs: 20 });
        assert.deepEqual(heard, ['clock', 'active', 'track', 'clock', 'clock']);
        off();
        feed.setVideoState('paused');
        assert.equal(heard.length, 5);
        assert.equal(typeof feed.subscribe('not a function'), 'function');
    });

    it('passes a driver\'s error to the page, and never throws back', () => {
        const feed = createScriptFeed();
        const errors = [];
        feed.onError((error, source) => errors.push([error.message, source]));
        feed.onError(() => { throw new Error('ignored'); });
        feed.reportError(new Error('leg pump'), 'script-planner');
        assert.deepEqual(errors, [['leg pump', 'script-planner']]);
    });
});
