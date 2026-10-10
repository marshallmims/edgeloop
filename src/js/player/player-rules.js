// The player's rules that need no DOM. player.js (the player section) and
// app.js (the session) both decide by them, and node:test checks every one.
//
// The session transport is the one source of truth (spec §1.5): in Script
// mode the video follows START, PAUSE, STOP and Reset, and what the video
// does by its own controls - a media key, iOS's native fullscreen, a
// headset's browser bar - is turned into a request to the transport. A
// pause from anywhere is always taken; a play is only ever a request, which
// the START / RESUME gate may refuse.

import { scriptSpeedCap, handySpeedCeiling, HANDY_DEFAULT_TRAVEL_MM } from './script-shaper.js';
import { VIDEO_EXTENSIONS } from './script-pairing.js';

export const VIDEO_STALL_PAUSE_MS = 30000;

// The containers the player will try to open. MP4 (H.264) and WebM play in
// the most browsers. MKV and MOV only play where that browser can decode them.
export function describeVideoFormats() {
    const names = VIDEO_EXTENSIONS.map((ext) => ext.toUpperCase());
    return {
        button: `Choose ${names.join(', ')}`,
        hint: `${names.join(', ')}, plus a .funscript for the stroker and a .v0.funscript for the other toy. MP4 (H.264) and WebM play in the most browsers. MKV and MOV only play where this browser can decode them.`
    };
}

// A second at this speed (% of the script range per second) is solid red.
// A pause is green. 200 %/s is a full stroke about twice a second.
export const HEATMAP_RED_PER_SECOND = 200;

export function heatLevel(speed) {
    const v = Number(speed);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.min(1, v / HEATMAP_RED_PER_SECOND);
}

// 0 is green (a pause), 1 is red (fast). Yellow is the middle.
export function heatColor(amount) {
    const t = Math.max(0, Math.min(1, Number(amount) || 0));
    const mix = (a, b, u) => Math.round(a + (b - a) * u);
    const green = [34, 197, 94];
    const yellow = [250, 204, 21];
    const red = [239, 68, 68];
    const [from, to, u] = t < 0.5 ? [green, yellow, t / 0.5] : [yellow, red, (t - 0.5) / 0.5];
    return `rgb(${mix(from[0], to[0], u)}, ${mix(from[1], to[1], u)}, ${mix(from[2], to[2], u)})`;
}

// A link the wearer pasted or dropped. A direct file address can be given
// to the video element. A page on a video site is not a file: those sites
// do not hand the video to another page, so the link is refused.
export function classifyVideoLink(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { kind: 'empty', message: 'Paste a direct video file address.' };
    let url;
    try {
        url = new URL(text);
    } catch (e) {
        return { kind: 'invalid', message: 'That is not a link. Paste a direct video file address, such as one ending in .mp4 or .webm.' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { kind: 'invalid', message: 'The link has to start with https://.' };
    }
    const path = decodeURIComponent(url.pathname).toLowerCase();
    const dot = path.lastIndexOf('.');
    const ext = dot > 0 ? path.slice(dot + 1) : '';
    if (VIDEO_EXTENSIONS.includes(ext)) return { kind: 'file', url: url.href, ext };
    return {
        kind: 'page',
        message: 'A page link cannot play here. Video sites do not hand the file to another page. Download the video and choose the file, or paste a direct address ending in .mp4, .m4v, .webm, .mkv, .mov, or .ogv.'
    };
}
export const HUD_HIDE_MS = 4000;
export const OFFSET_NUDGE_MS = 50;
export const CLOCK_READ_EVERY_MS = 250;
// HTMLMediaElement.HAVE_CURRENT_DATA: a frame to show at the current time.
export const VIDEO_READY_STATE = 2;
// Per script hash, in this browser only (a per-viewer convenience; never in
// the Backup, never a file name).
export const SCRIPT_OFFSETS_STORAGE_KEY = 'edgeloop_script_offsets';
export const MAX_REMEMBERED_OFFSETS = 200;
// Climax marks, per script hash, in this browser only. Same privacy rule as
// the offsets: never in the Backup, never a file name.
export const SCRIPT_CLIMAX_STORAGE_KEY = 'edgeloop_script_climaxes';
export const MAX_REMEMBERED_CLIMAXES = 200;
export const MAX_CLIMAX_MARKS = 12;
// Beat sync on The Handy: the wearer's one-time consent, and the switch.
export const BEAT_SYNC_CONSENT_KEY = 'edgeloop_beat_sync_consent';
export const BEAT_SYNC_STORAGE_KEY = 'edgeloop_beat_sync';
// How many picked files the player keeps in mind between picks (a phone
// picks the video and the script one at a time).
export const MAX_PICKED_FILES = 24;

const LIVE = ['RUNNING', 'RAMPDOWN'];

function finite(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

// "4:05", "1:20:03". Negative, missing or not a number is "0:00".
export function formatMediaTime(ms) {
    const total = finite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 40112 -> "40,112", the same in every locale.
export function formatCount(n) {
    const v = finite(n) ? Math.max(0, Math.round(n)) : 0;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The one line the player section shows when it is closed.
export function describePlayerStrip({ meta = null, hasVideo = false, refused = false } = {}) {
    if (meta && finite(meta.durationMs)) {
        return `Script loaded: ${formatMediaTime(meta.durationMs)}, ${formatCount(meta.actions)} actions${hasVideo ? '' : ' (no video yet)'}`;
    }
    if (refused) return hasVideo ? 'Video loaded; the script was refused' : 'The script was refused';
    return hasVideo ? 'Video loaded, no script yet' : 'Player: your own video and .funscript, played with your pulse as the limiter';
}

// "12% of strokes are faster than your 300 %/s limit and will be shortened."
// `share` is 0-1 (script-track stats.cappedShare).
export function describeCappedShare(share, maxSpeed) {
    const limit = finite(maxSpeed) ? Math.round(maxSpeed) : 300;
    if (!finite(share) || share <= 0) return `No stroke is faster than your ${limit} %/s limit.`;
    const pct = Math.max(1, Math.round(share * 100));
    return `${pct}% of strokes are faster than your ${limit} %/s limit and will be shortened.`;
}

// The share of the script's moving segments the speed limit caps, for a
// limit in % of full travel per second over an envelope `span`% wide (the
// script's 0-100 is mapped into it, so a script segment at v moves v * span
// / 100 of the travel per second).
export function cappedShareFor(stats, maxSpeed, span = 100) {
    if (!stats || typeof stats.cappedShare !== 'function') return 0;
    const width = finite(span) && span > 0 ? Math.min(100, span) : 100;
    const limit = finite(maxSpeed) && maxSpeed > 0 ? maxSpeed : 300;
    return stats.cappedShare((limit * 100) / width);
}

// The speed limit a toy plays the script under at a full allowance, % of
// full travel per second: the shaper's own (script-shaper.js
// scriptSpeedCap), the wearer's Max speed times the toy's speed cap, never
// above the toy's ceiling. Returns { limit, why } where `why` names what
// sets it: 'ceiling' (the toy's top speed), 'cap' (Max speed at the toy's
// cap) or 'max' (Max speed).
export function toySpeedLimit({ maxSpeed, cap = 100, ceiling } = {}) {
    const args = { maxSpeed, cap, approach: 'shorten', allowance: 100 };
    const limit = scriptSpeedCap({ ...args, ceiling });
    const asked = scriptSpeedCap({ ...args, ceiling: Number.MAX_VALUE });
    const why = limit < asked ? 'ceiling' : finite(cap) && cap < 100 ? 'cap' : 'max';
    return { limit, why };
}

// What the speed limit caps, per toy that plays each stroke (spec 3.9):
// `toys` is [{ name, ceiling, cap, span }] with the toy's ceiling (%/s),
// its speed cap (%) and the stretch of travel it is given (% of full
// travel: the envelope, or for The Handy over beat sync its stroke window).
// With no such toy connected, the line is for the Max speed alone.
export function describeSpeedCaps({ stats = null, maxSpeed = 300, span = 100, toys = [] } = {}) {
    const list = Array.isArray(toys) ? toys.filter((t) => t && t.name) : [];
    if (list.length === 0) return [describeCappedShare(cappedShareFor(stats, maxSpeed, span), maxSpeed)];
    return list.map((toy) => {
        const { limit, why } = toySpeedLimit({ maxSpeed, cap: toy.cap, ceiling: toy.ceiling });
        const rounded = Math.round(limit);
        const reason = why === 'ceiling'
            ? 'its top speed'
            : why === 'cap' ? `your Max speed at its ${Math.round(toy.cap)}% cap` : 'your Max speed';
        const share = cappedShareFor(stats, limit, toy.span);
        if (!finite(share) || share <= 0) return `${toy.name}: no stroke is faster than its ${rounded} %/s limit (${reason}).`;
        const pct = share >= 1 ? 100 : Math.min(99, Math.max(1, Math.round(share * 100)));
        return `${toy.name}: ${pct === 100 ? 'every stroke is' : `${pct}% of strokes are`} faster than its ${rounded} %/s limit (${reason}) and will be shortened.`;
    });
}

// The Max speed field's hint: what the setting means on The Handy, which
// tops out at its own speed (its x_max_speed over its travel, 400 mm/s on
// 110 mm when it has not said), and in full strokes a second (a full
// stroke is there and back, twice the travel).
export function describeMaxSpeedHint({ maxSpeed, travelMm = null, maxSpeedMmS = null } = {}) {
    const value = finite(maxSpeed) && maxSpeed > 0 ? maxSpeed : 0;
    const travel = finite(travelMm) && travelMm > 0 ? travelMm : HANDY_DEFAULT_TRAVEL_MM;
    const ceiling = handySpeedCeiling({ maxSpeedMmS, travelMm: travel });
    const strokes = Math.round((value / 200) * 10) / 10;
    if (value > ceiling) {
        const top = Math.round((ceiling * travel) / 100);
        return `≈ ${strokes} full strokes/s · The Handy (${Math.round(travel)} mm) tops out at ≈ ${top} mm/s, ${Math.round(ceiling)} %/s, and plays no faster`;
    }
    return `≈ ${Math.round((value * travel) / 100)} mm/s on a ${Math.round(travel)} mm Handy · ≈ ${strokes} full strokes/s`;
}

// The panel's lines about a loaded script: its length, the fastest
// segment, how much the speed limit will cap on each toy that plays the
// strokes (describeSpeedCaps), and what the file asked that is not played
// as written.
export function describeScriptSummary({ meta = null, stats = null, maxSpeed = 300, span = 100, toys = [], dropped = '' } = {}) {
    if (!meta) return [];
    const lines = [];
    const starts = finite(meta.firstAtMs) && meta.firstAtMs > 0 ? `, first stroke at ${formatMediaTime(meta.firstAtMs)}` : '';
    lines.push(`Length ${formatMediaTime(meta.durationMs)}, ${formatCount(meta.actions)} actions${starts}.`);
    if (stats && finite(stats.maxSpeed) && stats.maxSpeed > 0) {
        const at = finite(stats.fastestAt) ? ` at ${formatMediaTime(stats.fastestAt)}` : '';
        lines.push(`Fastest segment: ${formatCount(stats.maxSpeed)} %/s${at}.`);
        lines.push(...describeSpeedCaps({ stats, maxSpeed, span, toys }));
    }
    if (meta.inverted === true) lines.push('The file is marked inverted, so it plays upside down (Invert on the Script tab flips it back).');
    if (meta.rangeNoted === true) lines.push(`The file names a range of ${meta.range}; it is ignored, as other players do.`);
    if (meta.hasAxes === true) lines.push('The file also carries other axes; only its stroke is played.');
    if (typeof dropped === 'string' && dropped) lines.push(`Not played as written: ${dropped}.`);
    return lines;
}

// Why a video does not play, named as far as the browser lets the page
// know. `code` is MediaError.code.
export function describeMediaError(code, { typeSupported = null } = {}) {
    if (typeSupported === false) {
        return 'This browser cannot play that video file (its format or codec is not supported here; MP4 with H.264, or WebM, plays almost everywhere).';
    }
    switch (code) {
        case 1: return 'Loading the video was stopped.';
        case 2: return 'The video file could not be read from the disk.';
        case 3: return 'The video could not be decoded: the file is damaged, or this browser cannot decode its codec (some Chromium builds have no H.264 or HEVC).';
        case 4: return 'This browser cannot play that video file (its container or codec is not supported here; MP4 with H.264, or WebM, plays almost everywhere).';
        default: return 'The video stopped with an error.';
    }
}

// Why START or RESUME must wait in Script mode, or null. The script must be
// valid and the video loaded far enough to show a frame.
// Why the video's Play button did nothing. Scrubbing still works. Empty
// when the block is not a missing monitor or toy.
export function describePlayerHardwareWait(reason) {
    switch (reason) {
        case 'WAITING FOR HR SENSOR & TOY':
            return 'Connect a heart-rate monitor and a toy before this video can play. You can still scrub through it.';
        case 'WAITING FOR HR SENSOR':
            return 'Connect a heart-rate monitor before this video can play. You can still scrub through it.';
        case 'WAITING FOR TOY CONNECTION':
            return 'Connect a toy before this video can play. You can still scrub through it.';
        case 'WAITING FOR PULSE':
            return 'Waiting for a heart-rate reading before this video can play. You can still scrub through it.';
        default:
            return '';
    }
}

export function scriptWaitingReason({ activeMode, hasTrack = false, hasVideo = false, videoReady = false, videoError = false } = {}) {
    if (activeMode !== 'script') return null;
    if (!hasTrack) return 'LOAD A SCRIPT';
    if (!hasVideo) return 'LOAD THE VIDEO';
    if (videoError) return 'THE VIDEO CANNOT PLAY';
    if (!videoReady) return 'LOADING THE VIDEO';
    return null;
}

// A loaded video follows the session. A script session still needs its track.
export function videoCoupled({ activeMode, hasTrack = false, hasVideo = false } = {}) {
    if (hasVideo) return true;
    return activeMode === 'script' && Boolean(hasTrack);
}

// What a video event asks of the session (§1.5). Returns one of:
//   'none'           nothing to do
//   'pause-session'  the video paused by its own controls under a running
//                    session: PAUSE (every toy stopped)
//   'repause'        the video started while the session is not running
//                    (or an edge holds it): pause it again at once, and
//   'request-start'  ... ask the START / RESUME gate (only from IDLE/PAUSED)
//   'end-session'    the video ended under a live session
// `event` is 'play' | 'pause' | 'ended'. `edgeHold`: the governor paused
// the video for an edge (edge action Pause video) and still holds it.
export function videoEventAction({ event, coupled = false, sessionStatus = 'IDLE', ended = false, edgeHold = false } = {}) {
    if (!coupled) return 'none';
    const live = LIVE.includes(sessionStatus);
    if (event === 'ended') return live ? 'end-session' : 'none';
    if (event === 'pause') {
        // The end of the video pauses it first; 'ended' follows.
        if (ended) return 'none';
        if (!live) return 'none';
        return edgeHold ? 'none' : 'pause-session';
    }
    if (event === 'play') {
        if (live) return edgeHold ? 'repause' : 'none';
        return 'request-start';
    }
    return 'none';
}

// Whether the video is heard: a page that is hidden keeps full-rate timers
// only while it is audible (Chrome), and the hidden-and-silent rule pauses
// the session otherwise. `hasAudio` null means the browser cannot say, and
// counts as audible only when nothing else says otherwise.
export function isAudible({ paused = true, muted = false, volume = 1, hasAudio = null } = {}) {
    if (paused || muted) return false;
    if (!finite(volume) || volume <= 0) return false;
    return hasAudio !== false;
}

// The hidden-and-silent rule (§5.2): a Script-mode session that runs while
// the page is hidden and the video is not heard is paused.
export function hiddenSilentPause({ hidden = false, coupled = false, sessionStatus = 'IDLE', audible = false } = {}) {
    return Boolean(hidden) && Boolean(coupled) && LIVE.includes(sessionStatus) && !audible;
}

export function describeHiddenSilent() {
    return 'This page was hidden while the video was silent, so the browser could hold EdgeLoop back without warning. Every toy was stopped and the session paused; press RESUME when you are ready. Keep the page in view, or the video audible, while a script plays.';
}

export function describeVideoStall(seconds = 30) {
    return `The video stopped loading for ${Math.round(seconds)} s, so the script had no clock. Every toy was stopped and the session paused; press RESUME when it plays again.`;
}

export function describeVideoPlayRefused(detail = '') {
    const why = typeof detail === 'string' && detail.trim() ? ` (${detail.trim()})` : '';
    return `The video would not start${why}, so nothing may follow the script. Every toy was stopped and the session paused; press RESUME to try again.`;
}

// ---- per-script offsets ---------------------------------------------------------

function isHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// The stored offsets, cleaned: { hash: { ms, at } }, at most `limit` of
// them. Anything else in the store is dropped.
export function readOffsets(raw, { limit = MAX_REMEMBERED_OFFSETS, clamp = (v) => v } = {}) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const entries = Object.entries(raw)
        .filter(([hash, entry]) => isHash(hash) && entry && typeof entry === 'object' && finite(Number(entry.ms)))
        .map(([hash, entry]) => [hash, { ms: clamp(Number(entry.ms)), at: finite(Number(entry.at)) ? Number(entry.at) : 0 }])
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, Math.max(0, limit));
    for (const [hash, entry] of entries) out[hash] = entry;
    return out;
}

export function offsetFor(offsets, hash) {
    if (!isHash(hash) || !offsets || typeof offsets !== 'object') return 0;
    const entry = offsets[hash];
    return entry && finite(entry.ms) ? entry.ms : 0;
}

// A new map with this script's offset remembered (0 forgets it); the
// oldest entries go first past `limit`.
export function rememberOffset(offsets, hash, ms, now = 0, { limit = MAX_REMEMBERED_OFFSETS } = {}) {
    const next = readOffsets(offsets, { limit: Infinity });
    if (!isHash(hash)) return readOffsets(next, { limit });
    if (!finite(ms) || ms === 0) delete next[hash];
    else next[hash] = { ms, at: finite(now) ? now : 0 };
    return readOffsets(next, { limit });
}

// The stored climax marks, cleaned: { hash: { marks, at } }. Marks are
// milliseconds along the video, sorted, and never more than MAX_CLIMAX_MARKS.
export function readClimaxMarks(raw, { limit = MAX_REMEMBERED_CLIMAXES } = {}) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const entries = Object.entries(raw)
        .filter(([hash, entry]) => isHash(hash) && entry && typeof entry === 'object' && Array.isArray(entry.marks))
        .map(([hash, entry]) => [hash, {
            marks: cleanMarkList(entry.marks),
            at: finite(Number(entry.at)) ? Number(entry.at) : 0
        }])
        .filter(([, entry]) => entry.marks.length > 0)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, Math.max(0, limit));
    for (const [hash, entry] of entries) out[hash] = entry;
    return out;
}

export function climaxMarksFor(stored, hash) {
    if (!isHash(hash) || !stored || typeof stored !== 'object') return [];
    const entry = stored[hash];
    return entry && Array.isArray(entry.marks) ? entry.marks.slice() : [];
}

// A new map with this script's marks remembered. An empty list forgets it.
export function rememberClimaxMarks(stored, hash, marks, now = 0, { limit = MAX_REMEMBERED_CLIMAXES } = {}) {
    const next = readClimaxMarks(stored, { limit: Infinity });
    if (!isHash(hash)) return readClimaxMarks(next, { limit });
    const clean = cleanMarkList(marks);
    if (clean.length === 0) delete next[hash];
    else next[hash] = { marks: clean, at: finite(now) ? now : 0 };
    return readClimaxMarks(next, { limit });
}

function cleanMarkList(marks) {
    const list = (Array.isArray(marks) ? marks : [])
        .map((m) => Number(m))
        .filter((m) => finite(m) && m >= 0)
        .map((m) => Math.round(m))
        .sort((a, b) => a - b);
    const unique = [];
    for (const m of list) {
        if (unique.length === 0 || unique[unique.length - 1] !== m) unique.push(m);
    }
    return unique.slice(0, MAX_CLIMAX_MARKS);
}

// Click the heat map: a click on a mark removes it, a click on empty time
// adds one. `xPx` / `widthPx` are the click in the canvas; a mark within
// `hitPx` of that x is the one removed.
export function editClimaxMarks(marks, timeMs, { durationMs = 0, widthPx = 0, xPx = 0, hitPx = 14 } = {}) {
    const list = cleanMarkList(marks);
    const dur = Number(durationMs);
    if (!finite(dur) || dur <= 0) return list;
    const width = Number(widthPx);
    const x = Number(xPx);
    if (finite(width) && width > 0 && finite(x)) {
        let hit = -1;
        for (let i = 0; i < list.length; i++) {
            const mx = (list[i] / dur) * width;
            if (Math.abs(mx - x) <= hitPx) hit = i;
        }
        if (hit >= 0) return list.filter((_, i) => i !== hit);
    }
    const t = Math.round(Math.max(0, Math.min(dur, Number(timeMs) || 0)));
    return cleanMarkList(list.concat([t]));
}

// The Mark button: add the time under the playhead, or remove the mark
// already sitting on it. `nearMs` is how close counts as the same mark.
export function toggleClimaxAt(marks, timeMs, { durationMs = 0, nearMs = 1500 } = {}) {
    const list = cleanMarkList(marks);
    const dur = Number(durationMs);
    if (!finite(dur) || dur <= 0) return list;
    const t = Math.round(Math.max(0, Math.min(dur, Number(timeMs) || 0)));
    const near = finite(nearMs) && nearMs > 0 ? nearMs : 0;
    const hit = list.findIndex((m) => Math.abs(m - t) <= near);
    if (hit >= 0) return list.filter((_, i) => i !== hit);
    return cleanMarkList(list.concat([t]));
}

// "+120 ms", "0 ms", "-50 ms".
export function formatOffset(ms) {
    const v = finite(ms) ? Math.round(ms) : 0;
    return `${v > 0 ? '+' : ''}${v} ms`;
}

// ---- what each toy really does (§3.9) ---------------------------------------------

// One short line per connected toy, for the player's status. `handyRoute`
// is the route line (describeHandyRoute) or '' when The Handy is not on the
// primary channel.
export function describeToyNotes({
    handy = false,
    handyRole = 'primary',
    handyRoute = '',
    intifaceLinear = 0,
    intifaceOther = 0,
    tcode = false,
    vacuglide = false
} = {}) {
    const lines = [];
    if (handy) {
        if (handyRole === 'primary') lines.push(`The Handy: ${handyRoute || 'rhythm only'}`);
        else if (handyRole === 'secondary') lines.push('The Handy: on the secondary channel, it follows the limiter as a level.');
        else lines.push('The Handy: switched off in its panel.');
    }
    if (intifaceLinear > 0) lines.push(`Intiface: ${intifaceLinear === 1 ? 'the linear axis on the primary channel plays' : `${intifaceLinear} linear axes on the primary channel play`} each stroke of the script.`);
    if (intifaceOther > 0) lines.push('Intiface: vibrators, rotators and secondary axes follow the limiter as a level.');
    if (tcode) lines.push('T-Code: L0 on the primary channel plays each stroke; the other axes follow the limiter.');
    if (vacuglide) lines.push('VacuGlide: follows the limiter as a speed, not each stroke.');
    return lines;
}

// The privacy line, always visible in the panel (§1.2).
// The heart rate is not promised to stay here: a partner linked with Share
// Control is sent it, as it always has been.
export const PRIVACY_LINE = 'Your video and script stay on this device. EdgeLoop uploads neither. With Beat sync on The Handy switched on, The Handy is sent the next few seconds of stroke positions through Handy\'s cloud as it plays. File names and the video never leave this device; your heart rate goes only to a partner you link with Share Control.';

// The phase the status line, the strip and the HUD show in Script mode.
// `phase` is the governor's (script-governor describeScriptPhase); a video
// that waits for data or seeks stops the clock and every toy holds, so the
// line says that rather than a phase that is not playing; a video the edge
// action holds says so after the phase.
export function scriptPhaseLabel({ activeMode, sessionStatus, phase = '', videoState = '', edgeHeld = false } = {}) {
    if (activeMode !== 'script') return '';
    if (sessionStatus === 'PAUSED') return 'PAUSED';
    if (!LIVE.includes(sessionStatus)) return 'IDLE';
    if (videoState === 'waiting') return 'BUFFERING: TOYS HELD';
    if (videoState === 'seeking') return 'SEEKING: TOYS HELD';
    return edgeHeld ? `${phase} (VIDEO HELD)` : phase;
}

// The one-time question before beat sync is first switched on (§1.3).
export const BEAT_SYNC_CONSENT_TEXT = 'Beat sync plays the script on The Handy stroke for stroke.\n\nWhile it is on, the next few seconds of stroke positions and their times are sent ahead, a few seconds at a time, to Handy\'s servers (handyfeeling.com), under EdgeLoop\'s Application ID, as the video plays. Nothing else is sent: not the video, not the script file, not its name, not your heart rate.\n\nIt needs a Handy on firmware 4 or later. Without it, The Handy plays the script\'s rhythm only.\n\nSwitch beat sync on?';

export const GAMES_DISABLED_LINE = 'Games run their own speeds; they cannot be combined with a script yet.';
export const VR_LINE = 'In a headset: run EdgeLoop on a PC, tablet or phone that reads your pulse. Inside the headset this page can play the video, but it cannot read a heart-rate monitor.';
