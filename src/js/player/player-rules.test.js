import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatMediaTime,
    formatCount,
    describePlayerStrip,
    describeCappedShare,
    cappedShareFor,
    describeScriptSummary,
    describeSpeedCaps,
    describeMaxSpeedHint,
    toySpeedLimit,
    describeMediaError,
    scriptWaitingReason,
    describePlayerHardwareWait,
    videoCoupled,
    videoEventAction,
    isAudible,
    hiddenSilentPause,
    readOffsets,
    offsetFor,
    rememberOffset,
    formatOffset,
    readClimaxMarks,
    climaxMarksFor,
    rememberClimaxMarks,
    editClimaxMarks,
    toggleClimaxAt,
    describeToyNotes,
    describeVideoPlayRefused,
    scriptPhaseLabel,
    PRIVACY_LINE,
    BEAT_SYNC_CONSENT_TEXT,
    MAX_REMEMBERED_OFFSETS,
    describeVideoFormats,
    classifyVideoLink,
    heatColor
} from './player-rules.js';
import { stats } from './script-track.js';
import { clampScriptOffset } from './script-governor.js';
import { DEVICE_CEILINGS, handySpeedCeiling, scriptSpeedCap } from './script-shaper.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const track = (at, pos) => ({ at: Int32Array.from(at), pos: Uint8Array.from(pos) });

describe('formatMediaTime and formatCount', () => {
    it('formats minutes and hours', () => {
        assert.equal(formatMediaTime(0), '0:00');
        assert.equal(formatMediaTime(65000), '1:05');
        assert.equal(formatMediaTime(4803000), '1:20:03');
        assert.equal(formatMediaTime(-5), '0:00');
        assert.equal(formatMediaTime(NaN), '0:00');
        assert.equal(formatMediaTime(undefined), '0:00');
    });

    it('groups thousands the same way in every locale', () => {
        assert.equal(formatCount(40112), '40,112');
        assert.equal(formatCount(1000000), '1,000,000');
        assert.equal(formatCount(12), '12');
        assert.equal(formatCount(-3), '0');
        assert.equal(formatCount('x'), '0');
    });
});

describe('describePlayerStrip', () => {
    it('says what is loaded in one line', () => {
        assert.equal(describePlayerStrip({ meta: { durationMs: 4803000, actions: 40112 }, hasVideo: true }), 'Script loaded: 1:20:03, 40,112 actions');
        assert.match(describePlayerStrip({ meta: { durationMs: 1000, actions: 2 }, hasVideo: false }), /no video yet/);
        assert.match(describePlayerStrip({ hasVideo: true }), /no script yet/);
        assert.match(describePlayerStrip({ refused: true }), /refused/);
        assert.match(describePlayerStrip({}), /^Player: /);
    });
});

describe('the speed-limit line', () => {
    it('names the share capped, never 0% when something is', () => {
        assert.equal(describeCappedShare(0.12, 300), '12% of strokes are faster than your 300 %/s limit and will be shortened.');
        assert.equal(describeCappedShare(0.001, 300), '1% of strokes are faster than your 300 %/s limit and will be shortened.');
        assert.equal(describeCappedShare(0, 250), 'No stroke is faster than your 250 %/s limit.');
        assert.equal(describeCappedShare(NaN, 250), 'No stroke is faster than your 250 %/s limit.');
    });

    it('converts the physical limit to script units over a narrower envelope', () => {
        // Segments at 100, 200 and 400 script units per second.
        const s = stats(track([0, 1000, 1500, 1750], [0, 100, 0, 100]));
        assert.equal(cappedShareFor(s, 300, 100), 1 / 3);
        // Over a 50% envelope a 300 %/s physical limit is 600 script units/s.
        assert.equal(cappedShareFor(s, 300, 50), 0);
        // Over a 50% envelope a 100 %/s physical limit is 200 script units/s.
        assert.equal(cappedShareFor(s, 100, 50), 1 / 3);
        assert.equal(cappedShareFor(null, 300), 0);
    });
});

describe('describeScriptSummary', () => {
    it('lists the length, the fastest segment and the cap', () => {
        const t = track([2000, 3000, 3500], [0, 100, 0]);
        const lines = describeScriptSummary({
            meta: { durationMs: 3500, actions: 3, firstAtMs: 2000, inverted: true, rangeNoted: true, range: 90, hasAxes: false },
            stats: stats(t),
            maxSpeed: 300,
            dropped: '1 unusable action left out'
        });
        assert.equal(lines[0], 'Length 0:03, 3 actions, first stroke at 0:02.');
        assert.equal(lines[1], 'Fastest segment: 200 %/s at 0:03.');
        assert.equal(lines[2], 'No stroke is faster than your 300 %/s limit.');
        assert.ok(lines.some((l) => /inverted/.test(l)));
        assert.ok(lines.some((l) => /range of 90/.test(l)));
        assert.ok(lines.some((l) => /Not played as written: 1 unusable action left out\./.test(l)));
        assert.deepEqual(describeScriptSummary({}), []);
    });
});

describe('the speed limit per toy', () => {
    // 0 <-> 100 every 180 ms: 556 %/s, every stroke.
    const fast = () => {
        const at = [];
        const pos = [];
        for (let i = 0; i < 40; i += 1) {
            at.push(i * 180);
            pos.push(i % 2 === 0 ? 0 : 100);
        }
        return stats(track(at, pos));
    };

    it('is the shaper\'s own: Max speed times the toy\'s cap, never above its ceiling, and says which', () => {
        assert.deepEqual(toySpeedLimit({ maxSpeed: 600, cap: 100, ceiling: DEVICE_CEILINGS.intiface }), { limit: 500, why: 'ceiling' });
        assert.deepEqual(toySpeedLimit({ maxSpeed: 300, cap: 50, ceiling: DEVICE_CEILINGS.intiface }), { limit: 150, why: 'cap' });
        assert.deepEqual(toySpeedLimit({ maxSpeed: 300, cap: 100, ceiling: DEVICE_CEILINGS.tcode }), { limit: 300, why: 'max' });
        for (const [maxSpeed, cap, ceiling] of [[600, 100, 500], [600, 70, 500], [450, 100, handySpeedCeiling({})], [80, 30, 600]]) {
            assert.equal(toySpeedLimit({ maxSpeed, cap, ceiling }).limit, scriptSpeedCap({ maxSpeed, cap, approach: 'shorten', allowance: 100, ceiling }));
        }
    });

    it('says every stroke is capped when the toy\'s ceiling caps every stroke, though Max speed would not', () => {
        const lines = describeSpeedCaps({
            stats: fast(),
            maxSpeed: 600,
            span: 100,
            toys: [
                { name: 'The Handy', ceiling: handySpeedCeiling({}), cap: 100, span: 90 },
                { name: 'StandIn Stroker', ceiling: DEVICE_CEILINGS.intiface, cap: 100, span: 100 },
                { name: 'T-Code L0', ceiling: DEVICE_CEILINGS.tcode, cap: 100, span: 100 }
            ]
        });
        assert.deepEqual(lines, [
            'The Handy: every stroke is faster than its 364 %/s limit (its top speed) and will be shortened.',
            'StandIn Stroker: every stroke is faster than its 500 %/s limit (its top speed) and will be shortened.',
            'T-Code L0: no stroke is faster than its 600 %/s limit (your Max speed).'
        ]);
    });

    it('counts a toy\'s speed cap, over the stretch of travel the toy is given', () => {
        const [capped] = describeSpeedCaps({ stats: fast(), maxSpeed: 600, toys: [{ name: 'T-Code L0', ceiling: 600, cap: 50, span: 100 }] });
        assert.equal(capped, 'T-Code L0: every stroke is faster than its 300 %/s limit (your Max speed at its 50% cap) and will be shortened.');
        // In a 50% envelope a 556 %/s script stroke moves 278 %/s of travel.
        const [narrow] = describeSpeedCaps({ stats: fast(), maxSpeed: 600, toys: [{ name: 'T-Code L0', ceiling: 600, cap: 50, span: 50 }] });
        assert.equal(narrow, 'T-Code L0: no stroke is faster than its 300 %/s limit (your Max speed at its 50% cap).');
    });

    it('with no toy that plays strokes, speaks of the Max speed alone', () => {
        assert.deepEqual(describeSpeedCaps({ stats: fast(), maxSpeed: 600 }), ['No stroke is faster than your 600 %/s limit.']);
        const lines = describeScriptSummary({ meta: { durationMs: 7020, actions: 40 }, stats: fast(), maxSpeed: 600, toys: [{ name: 'StandIn', ceiling: 500, cap: 100, span: 100 }] });
        assert.equal(lines[2], 'StandIn: every stroke is faster than its 500 %/s limit (its top speed) and will be shortened.');
    });

    it('the Max speed hint never claims more than The Handy can do', () => {
        assert.equal(describeMaxSpeedHint({ maxSpeed: 300 }), '≈ 330 mm/s on a 110 mm Handy · ≈ 1.5 full strokes/s');
        assert.equal(describeMaxSpeedHint({ maxSpeed: 600 }), '≈ 3 full strokes/s · The Handy (110 mm) tops out at ≈ 400 mm/s, 364 %/s, and plays no faster');
        assert.match(describeMaxSpeedHint({ maxSpeed: 300, travelMm: 110, maxSpeedMmS: 250 }), /tops out at ≈ 250 mm\/s, 227 %\/s/);
        assert.ok(!/660 mm\/s/.test(describeMaxSpeedHint({ maxSpeed: 600 })));
    });
});

describe('describeMediaError', () => {
    it('names the likely cause', () => {
        assert.match(describeMediaError(3), /decoded/);
        assert.match(describeMediaError(4), /cannot play/);
        assert.match(describeMediaError(2), /disk/);
        assert.match(describeMediaError(99), /error/);
        assert.match(describeMediaError(null, { typeSupported: false }), /not supported/);
    });
});

describe('the player says why Play did nothing', () => {
    it('names the monitor, the toy, or both, and stays quiet otherwise', () => {
        assert.match(describePlayerHardwareWait('WAITING FOR HR SENSOR & TOY'), /heart-rate monitor and a toy/);
        assert.match(describePlayerHardwareWait('WAITING FOR HR SENSOR'), /heart-rate monitor/);
        assert.doesNotMatch(describePlayerHardwareWait('WAITING FOR HR SENSOR'), /and a toy/);
        assert.match(describePlayerHardwareWait('WAITING FOR TOY CONNECTION'), /Connect a toy/);
        assert.match(describePlayerHardwareWait('WAITING FOR PULSE'), /heart-rate reading/);
        assert.equal(describePlayerHardwareWait('WAITING FOR A SCRIPT'), '');
        assert.equal(describePlayerHardwareWait(null), '');
    });
});

describe('scriptWaitingReason: START needs a valid script and a ready video', () => {
    it('only ever speaks in Script mode', () => {
        assert.equal(scriptWaitingReason({ activeMode: 'classic' }), null);
    });

    it('names what is missing first', () => {
        assert.equal(scriptWaitingReason({ activeMode: 'script' }), 'LOAD A SCRIPT');
        assert.equal(scriptWaitingReason({ activeMode: 'script', hasTrack: true }), 'LOAD THE VIDEO');
        assert.equal(scriptWaitingReason({ activeMode: 'script', hasTrack: true, hasVideo: true, videoError: true }), 'THE VIDEO CANNOT PLAY');
        assert.equal(scriptWaitingReason({ activeMode: 'script', hasTrack: true, hasVideo: true }), 'LOADING THE VIDEO');
        assert.equal(scriptWaitingReason({ activeMode: 'script', hasTrack: true, hasVideo: true, videoReady: true }), null);
    });
});

describe('videoCoupled', () => {
    it('couples the video to the transport only in Script mode with a script', () => {
        assert.equal(videoCoupled({ activeMode: 'script', hasTrack: true }), true);
        assert.equal(videoCoupled({ activeMode: 'script', hasTrack: false }), false);
        assert.equal(videoCoupled({ activeMode: 'classic', hasTrack: true }), false);
    });
});

describe('videoEventAction: the video\'s own controls become transport requests', () => {
    const live = { coupled: true, sessionStatus: 'RUNNING' };

    it('leaves a video that is not coupled alone', () => {
        for (const event of ['play', 'pause', 'ended']) {
            assert.equal(videoEventAction({ event, coupled: false, sessionStatus: 'RUNNING' }), 'none');
        }
    });

    it('pauses the session when the video pauses under it', () => {
        assert.equal(videoEventAction({ event: 'pause', ...live }), 'pause-session');
        assert.equal(videoEventAction({ event: 'pause', coupled: true, sessionStatus: 'RAMPDOWN' }), 'pause-session');
    });

    it('does not count the pause that comes with the end, nor an edge hold', () => {
        assert.equal(videoEventAction({ event: 'pause', ...live, ended: true }), 'none');
        assert.equal(videoEventAction({ event: 'pause', ...live, edgeHold: true }), 'none');
        assert.equal(videoEventAction({ event: 'pause', coupled: true, sessionStatus: 'PAUSED' }), 'none');
    });

    it('ends a live session when the video ends, and nothing else', () => {
        assert.equal(videoEventAction({ event: 'ended', ...live }), 'end-session');
        assert.equal(videoEventAction({ event: 'ended', coupled: true, sessionStatus: 'IDLE' }), 'none');
    });

    it('turns a play while the session is not running into a request, never a start', () => {
        assert.equal(videoEventAction({ event: 'play', coupled: true, sessionStatus: 'IDLE' }), 'request-start');
        assert.equal(videoEventAction({ event: 'play', coupled: true, sessionStatus: 'PAUSED' }), 'request-start');
        assert.equal(videoEventAction({ event: 'play', ...live }), 'none');
        assert.equal(videoEventAction({ event: 'play', ...live, edgeHold: true }), 'repause');
    });
});

describe('the hidden-and-silent rule', () => {
    it('hears only a playing, unmuted video with volume and sound', () => {
        assert.equal(isAudible({ paused: false, muted: false, volume: 1, hasAudio: true }), true);
        assert.equal(isAudible({ paused: false, muted: false, volume: 1, hasAudio: null }), true);
        assert.equal(isAudible({ paused: true, volume: 1 }), false);
        assert.equal(isAudible({ paused: false, muted: true }), false);
        assert.equal(isAudible({ paused: false, volume: 0 }), false);
        assert.equal(isAudible({ paused: false, volume: 1, hasAudio: false }), false);
    });

    it('pauses a live Script session on a hidden page with a silent video', () => {
        assert.equal(hiddenSilentPause({ hidden: true, coupled: true, sessionStatus: 'RUNNING', audible: false }), true);
        assert.equal(hiddenSilentPause({ hidden: true, coupled: true, sessionStatus: 'RAMPDOWN', audible: false }), true);
        assert.equal(hiddenSilentPause({ hidden: true, coupled: true, sessionStatus: 'RUNNING', audible: true }), false);
        assert.equal(hiddenSilentPause({ hidden: false, coupled: true, sessionStatus: 'RUNNING', audible: false }), false);
        assert.equal(hiddenSilentPause({ hidden: true, coupled: false, sessionStatus: 'RUNNING', audible: false }), false);
        assert.equal(hiddenSilentPause({ hidden: true, coupled: true, sessionStatus: 'PAUSED', audible: false }), false);
    });
});

describe('per-script offsets', () => {
    it('keeps only well-formed entries, newest first, within the limit', () => {
        const raw = {
            [HASH_A]: { ms: 120, at: 5 },
            [HASH_B]: { ms: -40, at: 9 },
            'Movie.funscript': { ms: 10, at: 1 },
            ['c'.repeat(64)]: { ms: 'x', at: 1 }
        };
        const read = readOffsets(raw);
        assert.deepEqual(Object.keys(read), [HASH_B, HASH_A]);
        assert.equal(offsetFor(read, HASH_A), 120);
        assert.equal(offsetFor(read, 'nope'), 0);
        assert.deepEqual(readOffsets(null), {});
        assert.deepEqual(readOffsets([1, 2]), {});
        assert.deepEqual(Object.keys(readOffsets(raw, { limit: 1 })), [HASH_B]);
    });

    it('clamps what it reads', () => {
        const read = readOffsets({ [HASH_A]: { ms: 99999, at: 1 } }, { clamp: clampScriptOffset });
        assert.equal(offsetFor(read, HASH_A), 2000);
    });

    it('remembers, forgets at 0 and drops the oldest past the limit', () => {
        let map = rememberOffset({}, HASH_A, 50, 1);
        assert.equal(offsetFor(map, HASH_A), 50);
        map = rememberOffset(map, HASH_A, 0, 2);
        assert.equal(HASH_A in map, false);
        let many = {};
        for (let i = 0; i < MAX_REMEMBERED_OFFSETS + 5; i += 1) {
            many = rememberOffset(many, i.toString(16).padStart(64, '0'), 10, i);
        }
        assert.equal(Object.keys(many).length, MAX_REMEMBERED_OFFSETS);
        assert.equal('0'.repeat(64) in many, false);
        assert.deepEqual(rememberOffset({}, 'not-a-hash', 10, 1), {});
    });

    it('remembers climax marks per script and edits them from a click', () => {
        const stored = rememberClimaxMarks({}, HASH_A, [5000, 1000, 1000], 1);
        assert.deepEqual(climaxMarksFor(stored, HASH_A), [1000, 5000]);
        assert.deepEqual(climaxMarksFor(rememberClimaxMarks(stored, HASH_A, [], 2), HASH_A), []);
        assert.deepEqual(readClimaxMarks(null), {});
        const added = editClimaxMarks([], 2500, { durationMs: 10000, widthPx: 100, xPx: 25 });
        assert.deepEqual(added, [2500]);
        const removed = editClimaxMarks(added, 2500, { durationMs: 10000, widthPx: 100, xPx: 26 });
        assert.deepEqual(removed, []);
        const two = editClimaxMarks([1000], 8000, { durationMs: 10000, widthPx: 200, xPx: 160 });
        assert.deepEqual(two, [1000, 8000]);
        assert.deepEqual(toggleClimaxAt([], 2500, { durationMs: 10000 }), [2500]);
        assert.deepEqual(toggleClimaxAt([2500], 3000, { durationMs: 10000, nearMs: 1500 }), []);
        assert.deepEqual(toggleClimaxAt([2500], 5000, { durationMs: 10000, nearMs: 1500 }), [2500, 5000]);
    });

    it('formats the offset with its sign', () => {
        assert.equal(formatOffset(120), '+120 ms');
        assert.equal(formatOffset(-50), '-50 ms');
        assert.equal(formatOffset(0), '0 ms');
    });
});

describe('describeToyNotes', () => {
    it('says what each connected toy really does', () => {
        const lines = describeToyNotes({ handy: true, handyRoute: 'Beat sync (HSP), ±40 ms', intifaceLinear: 1, intifaceOther: 2, tcode: true, vacuglide: true });
        assert.equal(lines[0], 'The Handy: Beat sync (HSP), ±40 ms');
        assert.ok(lines.some((l) => /plays each stroke/.test(l)));
        assert.ok(lines.some((l) => /follow the limiter as a level/.test(l)));
        assert.ok(lines.some((l) => /^T-Code: L0/.test(l)));
        assert.ok(lines.some((l) => /^VacuGlide: follows the limiter/.test(l)));
        assert.match(describeToyNotes({ handy: true, handyRole: 'secondary' })[0], /secondary channel/);
        assert.deepEqual(describeToyNotes({}), []);
    });
});

describe('scriptPhaseLabel', () => {
    const live = { activeMode: 'script', sessionStatus: 'RUNNING', phase: 'FREE', videoState: 'playing' };
    it('names the governor\'s phase while the video plays', () => {
        assert.equal(scriptPhaseLabel(live), 'FREE');
        assert.equal(scriptPhaseLabel({ ...live, sessionStatus: 'RAMPDOWN', phase: 'LANDING' }), 'LANDING');
        assert.equal(scriptPhaseLabel({ ...live, phase: 'SKIPPING: EDGE', videoState: 'paused', edgeHeld: true }), 'SKIPPING: EDGE (VIDEO HELD)');
    });

    it('never reads FREE while the video buffers or seeks: the toys hold', () => {
        assert.equal(scriptPhaseLabel({ ...live, videoState: 'waiting' }), 'BUFFERING: TOYS HELD');
        assert.equal(scriptPhaseLabel({ ...live, videoState: 'seeking' }), 'SEEKING: TOYS HELD');
    });

    it('says PAUSED, IDLE, or nothing outside Script mode', () => {
        assert.equal(scriptPhaseLabel({ ...live, sessionStatus: 'PAUSED', videoState: 'waiting' }), 'PAUSED');
        assert.equal(scriptPhaseLabel({ ...live, sessionStatus: 'IDLE' }), 'IDLE');
        assert.equal(scriptPhaseLabel({ ...live, activeMode: 'classic' }), '');
    });
});

describe('the words', () => {
    it('promise what leaves the machine and nothing more', () => {
        assert.match(PRIVACY_LINE, /stay on this device/);
        assert.match(PRIVACY_LINE, /never leave this device/);
        // A partner linked with Share Control is sent the heart rate.
        assert.doesNotMatch(PRIVACY_LINE, /heart rate[^.;]*never leave/i);
        assert.match(PRIVACY_LINE, /your heart rate goes only to a partner you link with Share Control\.$/);
        assert.match(BEAT_SYNC_CONSENT_TEXT, /firmware 4/);
        assert.match(BEAT_SYNC_CONSENT_TEXT, /Application ID/);
        assert.match(describeVideoPlayRefused('NotAllowedError'), /\(NotAllowedError\)/);
        assert.doesNotMatch(describeVideoPlayRefused(''), /\(\)/);
    });
});

describe('video files and links', () => {
    it('names the containers the chooser accepts', () => {
        const formats = describeVideoFormats();
        for (const name of ['MP4', 'M4V', 'WEBM', 'MKV', 'MOV', 'OGV']) {
            assert.match(formats.button, new RegExp(name));
            assert.match(formats.hint, new RegExp(name));
        }
        assert.match(formats.hint, /funscript/);
        assert.equal(heatColor(0), 'rgb(34, 197, 94)');
        assert.equal(heatColor(0.5), 'rgb(250, 204, 21)');
        assert.equal(heatColor(1), 'rgb(239, 68, 68)');
        assert.match(formats.hint, /MP4 \(H\.264\) and WebM/);
    });

    it('accepts a direct file address and refuses a page', () => {
        assert.equal(classifyVideoLink('https://cdn.example.com/clip.mp4').kind, 'file');
        assert.equal(classifyVideoLink('https://cdn.example.com/clip.webm?token=1').kind, 'file');
        const page = classifyVideoLink('https://www.pornhub.com/view_video.php?viewkey=abc');
        assert.equal(page.kind, 'page');
        assert.match(page.message, /page link cannot play/);
        assert.equal(classifyVideoLink('not a link').kind, 'invalid');
        assert.equal(classifyVideoLink('').kind, 'empty');
    });
});
