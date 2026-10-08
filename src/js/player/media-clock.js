// The clock the script runs on: the video element's own time. Pure: the
// player (player.js) feeds it samples and state changes, and the drivers ask
// it what time it is.
//
// It keeps one anchor - a media time, the performance.now() it belongs to,
// and the playback rate - and answers nowMs(perf) by extrapolating from it.
// Samples come from requestVideoFrameCallback (metadata.mediaTime with its
// expectedDisplayTime, source 'frame') while the page is composited, and
// from a read of video.currentTime (source 'read') on every leg and every
// 250 ms. A sample that disagrees with the extrapolation by more than
// REANCHOR_MS resets the anchor; one that agrees leaves it alone, so the
// small jitter of a read never moves the strokes. A frame sample is the more
// exact of the two, so the first one after an anchor taken from a read
// replaces it.
//
// The script is never run on a free clock. While the video is paused,
// seeking, waiting or ended there is no time (null), and the feed answers
// "no motion". Nor is a time made up from an anchor nobody has confirmed
// lately: with no sample for MAX_EXTRAPOLATE_MS (a frozen tab, a decoder
// that stopped without a `waiting`), nowMs is null too. Every discontinuity
// - a new anchor that moved the time, a seek, a state change - bumps
// `generation`, so a driver can tell that the timeline it planned on is gone
// and has to rejoin.

export const REANCHOR_MS = 40;
export const MAX_EXTRAPOLATE_MS = 1500;
export const CLOCK_STATES = Object.freeze(['idle', 'playing', 'paused', 'seeking', 'waiting', 'ended']);

const SOURCE_RANK = { read: 0, frame: 1 };

export function createMediaClock({ reanchorMs = REANCHOR_MS, maxExtrapolateMs = MAX_EXTRAPOLATE_MS } = {}) {
    let state = 'idle';
    let anchor = null; // { mediaMs, perfMs, rate, source }
    let lastSamplePerf = null;
    let generation = 0;

    function extrapolate(perf) {
        return anchor.mediaMs + (perf - anchor.perfMs) * anchor.rate;
    }

    function setAnchor(sample, moved) {
        anchor = sample;
        if (moved) generation += 1;
    }

    return {
        // One observation of the video: { mediaMs, perfMs, rate = 1, source }.
        // Only counted while the video plays; a sample that is not finite is
        // ignored. Returns true when it re-anchored the clock.
        sample({ mediaMs, perfMs, rate = 1, source = 'read' } = {}) {
            if (state !== 'playing') return false;
            const m = Number(mediaMs);
            const p = Number(perfMs);
            const r = Number(rate);
            if (!Number.isFinite(m) || !Number.isFinite(p) || m < 0) return false;
            const next = {
                mediaMs: m,
                perfMs: p,
                rate: Number.isFinite(r) && r > 0 ? r : 1,
                source: source === 'frame' ? 'frame' : 'read'
            };
            // A sample older than the newest one already taken adds nothing.
            if (lastSamplePerf !== null && p < lastSamplePerf) return false;
            lastSamplePerf = p;
            if (!anchor) {
                setAnchor(next, true);
                return true;
            }
            const error = Math.abs(extrapolate(p) - m);
            if (error > reanchorMs || next.rate !== anchor.rate) {
                setAnchor(next, true);
                return true;
            }
            if (SOURCE_RANK[next.source] > SOURCE_RANK[anchor.source]) {
                setAnchor(next, false);
                return true;
            }
            return false;
        },

        // The media time in ms at performance time `perf`, or null when there
        // is no running clock to answer from.
        nowMs(perf) {
            if (state !== 'playing' || !anchor) return null;
            const p = Number(perf);
            if (!Number.isFinite(p)) return null;
            if (lastSamplePerf !== null && p - lastSamplePerf > maxExtrapolateMs) return null;
            const now = extrapolate(p);
            return Number.isFinite(now) && now >= 0 ? now : null;
        },

        // The video's state, from its events: 'playing' (the `playing`
        // event), 'paused', 'seeking', 'waiting' (also `stalled`), 'ended',
        // 'idle' (no video). Anything but 'playing' drops the anchor: after a
        // seek, a stall or a pause the clock waits for a fresh sample. An
        // unknown state is taken as 'idle', so a mistake stops the script.
        setState(next) {
            const resolved = CLOCK_STATES.includes(next) ? next : 'idle';
            if (resolved === state) return;
            state = resolved;
            if (resolved !== 'playing') {
                anchor = null;
                lastSamplePerf = null;
            }
            generation += 1;
        },

        state() {
            return state;
        },

        // A copy of the anchor, or null.
        anchor() {
            return anchor ? { ...anchor } : null;
        },

        // Bumped on every discontinuity of the timeline.
        generation() {
            return generation;
        }
    };
}
