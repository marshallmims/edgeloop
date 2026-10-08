// The script feed: the one runtime object every script driver asks "where
// should the toy be next?". It holds the loaded track, the media clock the
// video feeds, the Script settings, the wearer's offset and the allowance the
// engine decided last, and answers through the shaper (script-shaper.js).
// No DOM and no timers of its own: player.js feeds the clock and the video's
// state, app.js says whether Script mode is driving and hands over each
// tick's allowance, and the drivers (hardware/script-planner.js for the
// Intiface and T-Code linear axes; the Handy over HSP later) ask.
//
// Fail-safe direction: no track, Script mode not driving, or no running
// clock (paused, seeking, waiting, ended, a clock nobody has confirmed for
// 1.5 s) is "no time", and a driver that has no time does not move. Every
// question that cannot be answered is answered with null or no points, never
// with a guess.
//
// Listeners (subscribe) hear every change a driver must act on at once
// rather than at the end of its leg in flight: the clock starting, stopping
// or jumping, Script mode switched on or off, a new track. A listener that
// throws is ignored; the feed never throws into the code that changed it.

import { createMediaClock } from './media-clock.js';
import {
    shapeWindow,
    smoothedTrack,
    amplitudeFactor,
    effectiveInvert,
    DEVICE_CEILINGS,
    FALLBACK_CEILING,
    PLANNER_MIN_SEGMENT_MS
} from './script-shaper.js';
import { posAt } from './script-track.js';
import { sanitizeScriptSettings, clampScriptOffset } from './script-governor.js';

function defaultPerfNow() {
    try {
        const perf = globalThis.performance;
        if (perf && typeof perf.now === 'function') return perf.now();
    } catch (e) {}
    return Date.now();
}

function usableTrack(track) {
    return Boolean(track && typeof track === 'object' && track.at && track.pos
        && typeof track.at.length === 'number' && track.at.length >= 2 && track.pos.length === track.at.length);
}

// A device profile's speed ceiling, % of full travel per second: a number is
// taken as it is when it is positive; a name is looked up in DEVICE_CEILINGS;
// anything else gets the lowest ceiling known.
export function resolveCeiling(profile) {
    if (typeof profile === 'number' && Number.isFinite(profile) && profile > 0) return profile;
    if (typeof profile === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_CEILINGS, profile)) {
        return DEVICE_CEILINGS[profile];
    }
    return FALLBACK_CEILING;
}

export function createScriptFeed({ clock = createMediaClock(), perfNow = defaultPerfNow } = {}) {
    let track = null;
    let meta = null;
    let settings = sanitizeScriptSettings({});
    let offset = 0;
    let active = false;
    let allowance = 0;
    // Bumped on every change that moves the timeline under a driver without
    // the clock seeing it: a new track, a new offset, Script mode switched on.
    let localGeneration = 0;
    const listeners = new Set();
    const errorListeners = new Set();

    function notify(reason) {
        for (const fn of [...listeners]) {
            try { fn(reason); } catch (e) {}
        }
    }

    function now() {
        try {
            const p = Number(perfNow());
            return Number.isFinite(p) ? p : null;
        } catch (e) {
            return null;
        }
    }

    const feed = {
        clock,

        // The parsed track ({ at, pos }) and its meta, or null to unload.
        // A track the shaper cannot use is no track.
        setTrack(nextTrack, nextMeta = null) {
            const usable = usableTrack(nextTrack);
            track = usable ? nextTrack : null;
            meta = usable && nextMeta && typeof nextMeta === 'object' ? nextMeta : null;
            localGeneration += 1;
            notify('track');
            return usable;
        },
        track() {
            return track;
        },
        meta() {
            return meta;
        },
        hasTrack() {
            return track !== null;
        },

        // The Script tab's settings, each through its sanitizer.
        setSettings(next) {
            settings = sanitizeScriptSettings(next);
            return { ...settings };
        },
        settings() {
            return { ...settings };
        },

        // The wearer's offset in ms (positive plays the strokes later):
        // script time = media time + offset.
        setOffset(ms) {
            const next = clampScriptOffset(ms);
            if (next !== offset) {
                offset = next;
                localGeneration += 1;
            }
            return offset;
        },
        offset() {
            return offset;
        },

        // Whether Script mode is driving: the mode selected and a session
        // that may move. app.js sets it; loading files alone never does.
        setActive(on) {
            const next = Boolean(on);
            if (next === active) return active;
            active = next;
            localGeneration += 1;
            notify('active');
            return active;
        },
        isActive() {
            return active && track !== null;
        },

        // The allowance the engine decided last (0-100), for the drivers that
        // do not take it through dispatch (HSP) and for the status line.
        setAllowance(value) {
            const n = Number(value);
            allowance = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
            return allowance;
        },
        allowance() {
            return allowance;
        },

        // The video's state, from its events (media-clock.js setState). A
        // state change is a discontinuity every driver hears at once.
        setVideoState(state) {
            const before = clock.generation();
            clock.setState(state);
            if (clock.generation() !== before) notify('clock');
            return clock.state();
        },
        // The video's state as last set ('playing', 'waiting', ...): the
        // status line says BUFFERING, not the governor's phase, while the
        // clock waits for data.
        videoState() {
            return clock.state();
        },
        // One observation of the video (media-clock.js sample). The first
        // one after a seek or a pause gives the script its time back, and a
        // re-anchor moves the timeline: both are told to the listeners.
        sample(observation) {
            const before = clock.generation();
            const anchored = clock.sample(observation);
            if (clock.generation() !== before) notify('clock');
            return anchored;
        },

        // Script ms now (media time + offset), or null when there is no time:
        // no track, Script mode not driving, or no running clock. `perf` is a
        // performance.now() reading; it defaults to the feed's own.
        scriptNow(perf) {
            if (!feed.isActive()) return null;
            const p = perf === undefined ? now() : Number(perf);
            if (!Number.isFinite(p)) return null;
            const media = clock.nowMs(p);
            if (media === null || !Number.isFinite(media)) return null;
            return media + offset;
        },

        // Whether the script has a time at all, Script mode driving or not:
        // a track and a running clock. A driver's leg in flight is cut when
        // this goes false (a seek, a pause), not when Script mode is
        // switched off, which lets it run out.
        hasTime(perf) {
            if (!track) return false;
            const p = perf === undefined ? now() : Number(perf);
            if (!Number.isFinite(p)) return false;
            const media = clock.nowMs(p);
            return media !== null && Number.isFinite(media);
        },

        // Changes whenever the timeline a driver planned on is gone: a seek,
        // a pause, a clock re-anchor that moved the time, a new offset, a new
        // track, Script mode switched on. A driver that sees a new value
        // rejoins instead of carrying on.
        generation() {
            return `${clock.generation()}:${localGeneration}`;
        },

        // One window of shaped device points (script-shaper.js shapeWindow)
        // with the feed's track and settings:
        //   from, to     script ms
        //   allowance    0-100; the caller's own (a planner takes the one its
        //                dispatch carried, so a stop and its points agree)
        //   cap          the toy's speed cap, % (scales its speed limit)
        //   window       the device window, { min, max } in % of full travel
        //   profile      a DEVICE_CEILINGS name, or a ceiling in %/s
        //   minSegmentMs the device's shortest segment
        //   startPos, rejoin, lead   as shapeWindow takes them
        // No track: { points: [], reason: 'empty' }.
        shape({
            from,
            to,
            allowance: a = allowance,
            cap = 100,
            window = { min: 0, max: 100 },
            profile = null,
            minSegmentMs = PLANNER_MIN_SEGMENT_MS,
            startPos = null,
            rejoin = false,
            lead = 0
        } = {}) {
            if (!track) return { points: [], reason: 'empty', vCap: 0, vJoin: 0, join: null };
            return shapeWindow({
                track,
                from,
                to,
                allowance: a,
                settings: {
                    approach: settings.scriptApproach,
                    invert: effectiveInvert(meta, settings),
                    smoothing: settings.scriptSmoothing,
                    maxSpeed: settings.scriptMaxSpeed,
                    strokeModel: settings.scriptStrokeModel
                },
                device: { window, ceiling: resolveCeiling(profile), cap, minSegmentMs },
                startPos,
                rejoin,
                lead
            });
        },

        // Where the shaped script is at script ms `t`, 0-1 of the device
        // window, under allowance `a`: the same smoothing, invert and
        // amplitude shapeWindow applies (before any speed limit), or null
        // outside the script.
        positionAt(t, a = allowance) {
            if (!track || !Number.isFinite(t)) return null;
            const p = posAt(smoothedTrack(track, settings.scriptSmoothing), t);
            if (p === null || !Number.isFinite(p)) return null;
            const x = effectiveInvert(meta, settings) ? 1 - p / 100 : p / 100;
            const shaped = x * amplitudeFactor(settings.scriptApproach, a, settings.scriptStrokeModel);
            return shaped < 0 ? 0 : shaped > 1 ? 1 : shaped;
        },

        // Change listeners: fn(reason), reason 'clock' | 'active' | 'track'.
        // Returns the function that removes it.
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        // A driver that caught an error from the feed reports it here; app.js
        // listens (onError) and pauses the session with a banner.
        onError(fn) {
            if (typeof fn !== 'function') return () => {};
            errorListeners.add(fn);
            return () => errorListeners.delete(fn);
        },
        reportError(error, source = 'script') {
            for (const fn of [...errorListeners]) {
                try { fn(error, source); } catch (e) {}
            }
        }
    };
    return feed;
}
