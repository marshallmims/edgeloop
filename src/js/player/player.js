// The player section (DOM): the wearer's own video and .funscript, picked
// from the local disk, played in a plain <video> element. It holds no
// session state and decides nothing about the toys: it feeds the script
// feed's clock from the video (requestVideoFrameCallback while frames are
// painted, a read of currentTime otherwise), tells app.js what the video
// and the files did, and does what app.js asks of the video. Every rule it
// follows is in player-rules.js, where node:test checks it.
//
// Nothing here is uploaded or stored. The video plays from a blob: URL,
// streamed from disk and revoked when the file is replaced or the page goes
// away. The script is parsed in the page; its SHA-256 (of the parsed
// actions, never the text) is the only thing app.js may keep. File names
// are shown in the panel and never written anywhere.
//
// The video plays through the element itself and never through a Web Audio
// graph: the microphone monitor relies on the browser's echo canceller
// referencing official playback paths.

import { pairFiles, VIDEO_EXTENSIONS, VIB_SUFFIXES, AXIS_SUFFIXES } from './script-pairing.js';
import { parseFunscript, checkFunscriptSize, describeDropped, scriptDigestHex } from './funscript-parse.js';
import { stats as trackStats } from './script-track.js';
import {
    VIDEO_STALL_PAUSE_MS,
    HUD_HIDE_MS,
    OFFSET_NUDGE_MS,
    describeVideoFormats,
    classifyVideoLink,
    CLOCK_READ_EVERY_MS,
    VIDEO_READY_STATE,
    MAX_PICKED_FILES,
    formatMediaTime,
    formatOffset,
    editClimaxMarks,
    toggleClimaxAt,
    heatColor,
    heatLevel,
    describeMediaError,
    videoEventAction,
    isAudible
} from './player-rules.js';

// A frame sample this recent makes a read of currentTime unnecessary: the
// frame callback is the more exact of the two, and two sources that differ
// by a few ms would only move the anchor back and forth.
const FRAME_FRESH_MS = 300;
// HTMLMediaElement.HAVE_FUTURE_DATA: playback can go on.
const HAVE_FUTURE_DATA = 3;

function call(handlers, name, ...args) {
    const fn = handlers && handlers[name];
    if (typeof fn !== 'function') return undefined;
    try {
        return fn(...args);
    } catch (e) {
        try { console.error(`player: ${name} failed`, e); } catch (x) {}
        return undefined;
    }
}

function fileKey(file) {
    return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// The name without its extension, lowercased (how pairFiles compares).
function stemOf(name) {
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

export function createPlayer({
    doc = globalThis.document,
    win = globalThis.window,
    els = {},
    feed,
    handlers = {},
    now = () => globalThis.performance.now(),
    urls = globalThis.URL,
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
    setRepeat = (fn, ms) => globalThis.setInterval(fn, ms),
    clearRepeat = (id) => globalThis.clearInterval(id)
} = {}) {
    const video = els.video || null;
    let picked = [];
    let videoFile = null;
    let remoteVideo = false;
    let videoUrl = null;
    let videoError = '';
    let scriptFile = null;
    let packName = null;
    let loadToken = 0;
    let script = null; // { track, meta, hash, stats, dropped }
    let secondaryFile = null;
    let secondary = null; // { track, meta, hash, stats, dropped }
    let secondaryToken = 0;
    let secondaryPinned = false;
    let climaxMarks = [];
    let heatmapView = 'primary';
    let refused = '';
    let edgeHold = false;
    let waitingSince = null;
    let stallReported = false;
    let lastFrameAt = -Infinity;
    let frameHandle = null;
    let readTimer = null;
    let watchTimer = null;
    let theater = false;
    let hudTimer = null;
    let seeking = false;

    // ---- the clock -----------------------------------------------------------------

    function transport() {
        const t = call(handlers, 'transport') || {};
        return { coupled: Boolean(t.coupled), sessionStatus: t.sessionStatus || 'IDLE' };
    }

    function readSample(force = false) {
        if (!video || video.paused || !feed) return;
        const t = now();
        if (!force && t - lastFrameAt < FRAME_FRESH_MS) return;
        const mediaMs = Number(video.currentTime) * 1000;
        if (!Number.isFinite(mediaMs)) return;
        feed.sample({ mediaMs, perfMs: t, rate: Number(video.playbackRate) || 1, source: 'read' });
    }

    function onFrame(nowTs, metadata) {
        frameHandle = null;
        if (!video || video.paused) return;
        if (metadata && Number.isFinite(metadata.mediaTime)) {
            const perfMs = Number.isFinite(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime : nowTs;
            lastFrameAt = now();
            feed?.sample({ mediaMs: metadata.mediaTime * 1000, perfMs, rate: Number(video.playbackRate) || 1, source: 'frame' });
        }
        requestFrame();
    }

    function requestFrame() {
        if (!video || frameHandle !== null || typeof video.requestVideoFrameCallback !== 'function') return;
        try {
            frameHandle = video.requestVideoFrameCallback(onFrame);
        } catch (e) {
            frameHandle = null;
        }
    }

    function stopFrames() {
        if (frameHandle !== null && video && typeof video.cancelVideoFrameCallback === 'function') {
            try { video.cancelVideoFrameCallback(frameHandle); } catch (e) {}
        }
        frameHandle = null;
    }

    function startClock() {
        requestFrame();
        if (readTimer === null) readTimer = setRepeat(() => readSample(false), CLOCK_READ_EVERY_MS);
    }

    function stopClock() {
        stopFrames();
        if (readTimer !== null) clearRepeat(readTimer);
        readTimer = null;
        lastFrameAt = -Infinity;
    }

    let externalClock = false;

    // The headset is the video. Samples are the same shape the <video>
    // element feeds the clock, so the script follows HereSphere or DeoVR.
    function followExternal({ state, mediaMs, rate } = {}) {
        externalClock = true;
        const next = state === 'playing' || state === 'paused' || state === 'seeking' || state === 'ended' ? state : 'paused';
        setVideoState(next);
        if (next === 'playing' && Number.isFinite(Number(mediaMs))) {
            try {
                feed?.sample({
                    mediaMs: Number(mediaMs),
                    perfMs: now(),
                    rate: Number(rate) > 0 ? Number(rate) : 1,
                    source: 'read'
                });
            } catch (e) {}
        }
        return true;
    }

    function setVideoState(state) {
        try { feed?.setVideoState(state); } catch (e) {}
    }

    // ---- the video's events --------------------------------------------------------

    function decide(event) {
        const t = transport();
        return videoEventAction({
            event,
            coupled: t.coupled,
            sessionStatus: t.sessionStatus,
            ended: Boolean(video && video.ended),
            edgeHold
        });
    }

    function renderTime() {
        if (!video) return;
        const dur = Number(video.duration);
        const cur = Number(video.currentTime);
        if (els.time) els.time.textContent = `${formatMediaTime(cur * 1000)} / ${formatMediaTime(Number.isFinite(dur) ? dur * 1000 : 0)}`;
        if (els.seek && !seeking) {
            if (Number.isFinite(dur) && dur > 0) {
                els.seek.max = String(Math.round(dur * 10) / 10);
                els.seek.disabled = false;
            } else {
                els.seek.disabled = true;
            }
            if (Number.isFinite(cur)) els.seek.value = String(Math.round(cur * 10) / 10);
        }
        if (els.seekThumb) {
            const bar = barDurationMs();
            const at = seeking && els.seek && Number.isFinite(Number(els.seek.value)) ? Number(els.seek.value) * 1000 : (Number.isFinite(cur) ? cur * 1000 : 0);
            const pct = bar > 0 ? Math.max(0, Math.min(100, (at / bar) * 100)) : 0;
            els.seekThumb.style.left = `${pct}%`;
        }
        if (els.playBtn) {
            const playing = !video.paused;
            els.playBtn.textContent = playing ? 'Pause' : 'Play';
            els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        }
        if (els.hudPause) {
            const playing = !video.paused;
            els.hudPause.textContent = playing ? 'Pause' : 'Play';
        }
        if (els.hudSeek && !seeking) {
            if (Number.isFinite(dur) && dur > 0) {
                els.hudSeek.max = String(Math.round(dur * 10) / 10);
                els.hudSeek.value = String(Math.round((Number.isFinite(cur) ? cur : 0) * 10) / 10);
            }
        }
        if (els.hudMute) els.hudMute.textContent = video.muted ? 'Unmute' : 'Mute';
        drawHeatmap();
        updateMarkButton();
    }

    function readinessChanged() {
        renderTime();
        call(handlers, 'onReadiness');
        const dur = video ? Number(video.duration) : NaN;
        if (Number.isFinite(dur) && dur > 0) call(handlers, 'onDuration', dur);
    }

    function bindVideo() {
        if (!video) return;
        video.controls = false;
        const on = (name, fn) => video.addEventListener(name, fn);
        // `play` and `pause` arrive a task after the call that caused them.
        // One that the video's state has already overtaken (a STOP and a
        // START in quick succession, an edge hold let go at once) is stale
        // and decides nothing: acted on, a START's late `pause` would pause
        // the new session, and a PAUSE's late `play` would ask to resume.
        on('play', () => {
            if (video.paused) {
                renderTime();
                return;
            }
            const action = decide('play');
            if (action === 'repause' || action === 'request-start') {
                // Never playing behind the session's back: paused again at
                // once, and a request is only a request (the START / RESUME
                // gate may refuse it).
                try { video.pause(); } catch (e) {}
                if (action === 'request-start') call(handlers, 'onPlayRequest');
            }
            renderTime();
        });
        on('playing', () => {
            waitingSince = null;
            stallReported = false;
            setVideoState('playing');
            readSample(true);
            startClock();
            renderTime();
        });
        on('pause', () => {
            if (!video.paused) return;
            stopClock();
            setVideoState(video.ended ? 'ended' : 'paused');
            waitingSince = null;
            if (video.paused && decide('pause') === 'pause-session') call(handlers, 'onPauseRequest');
            renderTime();
        });
        on('waiting', () => {
            stopClock();
            setVideoState('waiting');
            if (waitingSince === null) waitingSince = now();
        });
        on('stalled', () => {
            // `stalled` also fires while the buffer still plays; only a
            // video that cannot go on is waiting.
            if (video.paused || Number(video.readyState) >= HAVE_FUTURE_DATA) return;
            stopClock();
            setVideoState('waiting');
            if (waitingSince === null) waitingSince = now();
        });
        on('seeking', () => {
            stopClock();
            setVideoState('seeking');
        });
        on('seeked', () => {
            waitingSince = null;
            if (!video.paused) {
                setVideoState('playing');
                readSample(true);
                startClock();
            }
            renderTime();
        });
        on('ended', () => {
            stopClock();
            setVideoState('ended');
            edgeHold = false;
            if (decide('ended') === 'end-session') call(handlers, 'onEnded');
            renderTime();
        });
        on('ratechange', () => {
            // Phase 1 plays at 1x only: the speed limit runs on real time.
            if (Number(video.playbackRate) !== 1) {
                video.playbackRate = 1;
                call(handlers, 'onNotice', 'This version plays the video at normal speed only.');
            }
        });
        on('error', () => {
            stopClock();
            setVideoState('idle');
            const type = videoFile && typeof videoFile.type === 'string' ? videoFile.type : '';
            const support = type && typeof video.canPlayType === 'function' ? video.canPlayType(type) : null;
            videoError = describeMediaError(video.error ? video.error.code : null, { typeSupported: support === '' ? false : null });
            renderPanel();
            call(handlers, 'onMediaError', videoError);
            readinessChanged();
        });
        on('emptied', () => {
            stopClock();
            setVideoState('idle');
            readinessChanged();
        });
        for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'durationchange']) on(name, readinessChanged);
        on('timeupdate', () => {
            readSample(false);
            renderTime();
        });
        on('volumechange', renderTime);
    }

    // A buffering stall that outlasts VIDEO_STALL_PAUSE_MS is reported once.
    function watch() {
        if (waitingSince === null || stallReported || !video || video.paused) return;
        if (now() - waitingSince >= VIDEO_STALL_PAUSE_MS) {
            stallReported = true;
            call(handlers, 'onStall', VIDEO_STALL_PAUSE_MS / 1000);
        }
    }

    // ---- files -----------------------------------------------------------------------

    function setError(text) {
        if (els.error) {
            els.error.textContent = text || '';
            els.error.classList?.toggle('hidden', !text);
        }
    }

    function sameVideo(a, b) {
        if (!a || !b) return false;
        if (a.remote || b.remote) return Boolean(a.remote && b.remote && a.name === b.name);
        return fileKey(a) === fileKey(b);
    }

    function unloadScripts() {
        heatmapView = 'primary';
        if (scriptFile || script) clearScript('');
        if (secondaryFile || secondary) clearSecondary('');
        renderHeatmapModes();
    }

    function forgetScripts() {
        picked = picked.filter((f) => extensionOf(f.name) !== 'funscript');
        packName = null;
        unloadScripts();
    }

    function setVideoFile(file) {
        if (file === videoFile) return;
        const replacing = Boolean(videoFile) && Boolean(file) && !sameVideo(videoFile, file);
        if (replacing) unloadScripts();
        stopClock();
        edgeHold = false;
        if (videoUrl) {
            try { urls.revokeObjectURL(videoUrl); } catch (e) {}
            videoUrl = null;
        }
        videoFile = file || null;
        remoteVideo = false;
        videoError = '';
        if (!video) return;
        if (!videoFile) {
            try { video.pause(); } catch (e) {}
            video.removeAttribute('src');
            try { video.load(); } catch (e) {}
            setVideoState('idle');
        } else {
            videoUrl = urls.createObjectURL(videoFile);
            video.preload = 'auto';
            video.src = videoUrl;
            try { video.load(); } catch (e) {}
        }
        call(handlers, 'onVideo', { hasVideo: Boolean(videoFile) });
        readinessChanged();
        paintStageEmpty();
    }

    function setVideoAddress(href) {
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        const replacing = Boolean(videoFile) && !(videoFile.remote && videoFile.name === href);
        stopClock();
        edgeHold = false;
        if (videoUrl) {
            try { urls.revokeObjectURL(videoUrl); } catch (e) {}
            videoUrl = null;
        }
        if (replacing) {
            forgetScripts();
            renderPairing(pairFiles(picked));
        }
        remoteVideo = true;
        videoFile = { name: href, remote: true };
        videoError = '';
        if (!video) return false;
        video.preload = 'auto';
        video.src = href;
        try { video.load(); } catch (e) {}
        setError('');
        call(handlers, 'onVideo', { hasVideo: true });
        readinessChanged();
        paintStageEmpty();
        return true;
    }

    function paintStageEmpty() {
        const empty = !videoFile;
        if (els.stage) els.stage.dataset.empty = empty ? 'on' : 'off';
        if (els.stageEmpty) els.stageEmpty.classList.toggle('hidden', !empty);
    }

    function useVideoLink(raw) {
        const link = classifyVideoLink(raw);
        if (link.kind !== 'file') {
            setError(link.message || '');
            return false;
        }
        return setVideoAddress(link.url);
    }

    function clearScript(reason = '') {
        loadToken += 1;
        scriptFile = null;
        const had = script !== null;
        script = null;
        climaxMarks = [];
        refused = reason;
        if (had || reason) call(handlers, 'onScriptCleared', { refused: reason });
    }

    async function loadScript(file) {
        const token = ++loadToken;
        scriptFile = file;
        const size = checkFunscriptSize(file.size);
        if (!size.ok) return refuse(token, size.error);
        let text;
        try {
            text = await file.text();
        } catch (e) {
            return refuse(token, 'The script file could not be read from the disk.');
        }
        if (token !== loadToken) return false;
        const parsed = parseFunscript(text);
        text = null;
        if (!parsed.ok) return refuse(token, parsed.error);
        let hash = null;
        try {
            hash = await scriptDigestHex(parsed.track);
        } catch (e) {
            // No Web Crypto on a page served over plain http on a LAN: the
            // script still plays; only its offset is not remembered.
            hash = null;
        }
        if (token !== loadToken) return false;
        script = {
            track: parsed.track,
            meta: parsed.meta,
            hash,
            stats: trackStats(parsed.track),
            dropped: describeDropped(parsed.dropped)
        };
        climaxMarks = [];
        refused = '';
        setError('');
        call(handlers, 'onScript', { ...script });
        renderPanel();
        drawHeatmap();
        return true;
    }

    function clearSecondary(reason = '') {
        secondaryToken += 1;
        secondaryFile = null;
        secondaryPinned = false;
        const had = secondary !== null;
        secondary = null;
        if (had || reason) call(handlers, 'onSecondaryCleared', { refused: reason });
        drawHeatmap();
    }

    async function loadSecondary(file, { pinned = false } = {}) {
        const token = ++secondaryToken;
        secondaryFile = file;
        secondaryPinned = pinned || secondaryPinned;
        const size = checkFunscriptSize(file.size);
        if (!size.ok) return refuseSecondary(token, size.error);
        let text;
        try {
            text = await file.text();
        } catch (e) {
            return refuseSecondary(token, 'The secondary script could not be read from the disk.');
        }
        if (token !== secondaryToken) return false;
        const parsed = parseFunscript(text);
        text = null;
        if (!parsed.ok) return refuseSecondary(token, parsed.error);
        let hash = null;
        try {
            hash = await scriptDigestHex(parsed.track);
        } catch (e) {
            hash = null;
        }
        if (token !== secondaryToken) return false;
        secondary = {
            track: parsed.track,
            meta: parsed.meta,
            hash,
            stats: trackStats(parsed.track),
            dropped: describeDropped(parsed.dropped)
        };
        setError('');
        call(handlers, 'onSecondary', { ...secondary, name: file.name });
        renderHeatmapModes();
        renderPanel();
        drawHeatmap();
        return true;
    }

    function refuseSecondary(token, error) {
        if (token !== secondaryToken) return false;
        const had = secondary !== null;
        secondary = null;
        secondaryFile = null;
        secondaryPinned = false;
        setError(error);
        call(handlers, 'onSecondaryCleared', { refused: error, had });
        renderPanel();
        return false;
    }

    function channelSuffix(name) {
        const stem = stemOf(name);
        const dot = stem.lastIndexOf('.');
        if (dot <= 0) return null;
        const last = stem.slice(dot + 1);
        if (VIB_SUFFIXES.includes(last)) return last;
        if (Object.prototype.hasOwnProperty.call(AXIS_SUFFIXES, last)) return last;
        return null;
    }

    function isPlainStrokeName(name) {
        return extensionOf(name) === 'funscript' && !channelSuffix(name);
    }

    function refuse(token, error) {
        if (token !== loadToken) return false;
        const had = script !== null;
        script = null;
        climaxMarks = [];
        refused = error;
        setError(error);
        call(handlers, 'onScriptCleared', { refused: error, had });
        renderPanel();
        return false;
    }

    function chosenPack(pair) {
        if (!pair.packs.length) return null;
        const hit = pair.packs.find((p) => p.name === packName);
        return (hit || pair.packs[0]).item;
    }

    function itemName(item) {
        return item && typeof item.name === 'string' ? item.name : String(item || '');
    }

    function renderPairing(pair) {
        if (els.packRow && els.packSelect) {
            const several = pair.packs.length > 1;
            els.packRow.classList?.toggle('hidden', !several);
            if (several) {
                els.packSelect.replaceChildren?.();
                for (const pack of pair.packs) {
                    const opt = doc.createElement('option');
                    opt.value = pack.name === null ? '' : pack.name;
                    opt.textContent = pack.name === null ? 'The plain script' : pack.name;
                    els.packSelect.appendChild(opt);
                }
                els.packSelect.value = packName === null ? '' : packName;
            }
        }
        if (!els.pairList) return;
        const lines = [];
        if (pair.video) lines.push(`Video: ${itemName(pair.video)}`);
        if (pair.stroke) lines.push(`Script: ${itemName(chosenPack(pair))}${pair.loose ? ' (its name differs from the video\'s; it plays with it because it is the only one)' : ''}`);
        const secondaryItem = pair.vib || (secondaryFile && secondaryPinned ? secondaryFile : null);
        if (secondaryItem) lines.push(`Secondary: ${itemName(secondaryItem)}`);
        for (const [axis, item] of Object.entries(pair.axes)) {
            if (item) lines.push(`${itemName(item)} - the ${axis} axis is played in a later version`);
        }
        for (const u of pair.unused) lines.push(`${itemName(u.item)} - not used: ${u.reason}`);
        els.pairList.replaceChildren?.();
        for (const line of lines) {
            const li = doc.createElement('li');
            li.textContent = line;
            els.pairList.appendChild(li);
        }
    }

    async function applyPairing() {
        const pair = pairFiles(picked);
        setVideoFile(pair.video);
        renderPairing(pair);
        const next = chosenPack(pair);
        if (next !== scriptFile) {
            if (next) await loadScript(next);
            else if (scriptFile || script) clearScript('');
        }
        if (pair.vib && pair.vib !== secondaryFile) {
            secondaryPinned = false;
            await loadSecondary(pair.vib, { pinned: false });
        } else if (!pair.vib && !secondaryPinned && (secondaryFile || secondary)) {
            clearSecondary('');
        }
        renderPanel();
        drawHeatmap();
    }

    async function choosePrimary(file) {
        if (!file || typeof file.name !== 'string') return false;
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        setError('');
        picked = picked.filter((f) => !isPlainStrokeName(f.name));
        picked.push(file);
        packName = null;
        await applyPairing();
        if (scriptFile !== file) await loadScript(file);
        heatmapView = 'primary';
        renderHeatmapModes();
        drawHeatmap();
        return true;
    }

    async function chooseSecondary(file) {
        if (!file || typeof file.name !== 'string') return false;
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        setError('');
        secondaryPinned = true;
        const ok = await loadSecondary(file, { pinned: true });
        if (ok) heatmapView = 'secondary';
        renderPairing(pairFiles(picked));
        renderHeatmapModes();
        renderPanel();
        drawHeatmap();
        return ok;
    }

    function seriesOf(which) {
        const loaded = which === 'secondary' ? secondary : script;
        const series = loaded && loaded.stats ? loaded.stats.intensityPerSecond : null;
        return series && series.length ? series : null;
    }

    function renderHeatmapModes() {
        const hasPrimary = Boolean(script);
        const hasSecondary = Boolean(secondary);
        if (!hasSecondary && heatmapView === 'secondary') heatmapView = 'primary';
        if (!(hasPrimary && hasSecondary) && heatmapView === 'both') heatmapView = hasSecondary ? 'secondary' : 'primary';
        const press = (btn, on) => {
            if (!btn) return;
            btn.classList?.toggle('bg-slate-800', !on);
            btn.classList?.toggle('bg-sky-800', on);
            btn.classList?.toggle('border', on);
            btn.classList?.toggle('border-sky-400', on);
            btn.setAttribute?.('aria-pressed', on ? 'true' : 'false');
        };
        if (els.primaryBtn) els.primaryBtn.textContent = hasPrimary ? 'Primary' : 'Primary script';
        if (els.secondaryBtn) els.secondaryBtn.textContent = hasSecondary ? 'Secondary' : 'Secondary script';
        press(els.primaryBtn, hasPrimary && (heatmapView === 'primary' || heatmapView === 'both'));
        press(els.secondaryBtn, hasSecondary && (heatmapView === 'secondary' || heatmapView === 'both'));
        press(els.bothBtn, heatmapView === 'both');
        els.bothBtn?.classList?.toggle('hidden', !(hasPrimary && hasSecondary));
        if (els.clearScriptsBtn) els.clearScriptsBtn.disabled = false;
        if (els.heatmapHint && (videoFile || script || secondary)) {
            const lead = !script && !secondary
                ? 'Video only.'
                : heatmapView === 'both'
                    ? 'Both scripts. The color is the primary and the white line is the secondary.'
                    : heatmapView === 'secondary'
                        ? 'Secondary script.'
                        : 'Primary script.';
            const color = (script || secondary) ? ' Green is a pause, red is fast.' : '';
            const saved = script && climaxMarks.length ? ` ${climaxMarks.length} climax${climaxMarks.length === 1 ? '' : 'es'} saved on this device for this script.` : '';
            els.heatmapHint.textContent = `${lead}${color} A marked climax uses Pre-Climax Ramp Up, then Climax Duration, then Post Climax Ramp Down.${saved}`;
        }
    }

    function clearScripts() {
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        forgetScripts();
        setError('');
        renderPairing(pairFiles(picked));
        renderPanel();
        drawHeatmap();
        return true;
    }

    function barDurationMs() {
        const videoMs = video && Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? Number(video.duration) * 1000 : 0;
        if (videoMs > 0) return videoMs;
        return mapDurationMs();
    }

    function mapDurationMs() {
        const videoMs = video && Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? Number(video.duration) * 1000 : 0;
        const scriptMs = script && script.meta && Number.isFinite(script.meta.durationMs) ? script.meta.durationMs : 0;
        const secondaryMs = secondary && secondary.meta && Number.isFinite(secondary.meta.durationMs) ? secondary.meta.durationMs : 0;
        return Math.max(videoMs, scriptMs, secondaryMs);
    }

    function drawHeatmap() {
        const dur = mapDurationMs();
        const show = dur > 0 && Boolean(videoFile || script);
        els.heatmapHint?.classList?.toggle('hidden', !show);
        els.markBtn?.classList?.toggle('hidden', !show);
        paintHeatCanvas(els.seekHeat, { show, dur: barDurationMs(), playhead: false, fallbackH: 44 });
        renderClimaxList();
        if (show) renderHeatmapModes();
        updateMarkButton();
    }

    function paintHeatCanvas(canvas, { show, dur, playhead, fallbackH }) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        canvas.classList?.toggle('hidden', !show);
        if (!show) return;
        const dpr = (win && win.devicePixelRatio) || 1;
        const cssW = canvas.clientWidth || 320;
        const cssH = canvas.clientHeight || fallbackH;
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, w, h);
        const showSecondary = heatmapView === 'secondary' || heatmapView === 'both';
        const showPrimary = heatmapView !== 'secondary';
        if (showPrimary) paintSeries(ctx, seriesOf('primary'), dur, w, h, 'bars');
        if (showSecondary) paintSeries(ctx, seriesOf('secondary'), dur, w, h, heatmapView === 'both' ? 'line' : 'bars');
        for (const mark of climaxMarks) {
            const x = (mark / dur) * w;
            ctx.fillStyle = '#fbbf24';
            ctx.fillRect(Math.round(x) - (3 * dpr), 0, Math.max(6, dpr * 6), h);
            ctx.fillStyle = '#fffbeb';
            ctx.beginPath();
            ctx.moveTo(x, 2 * dpr);
            ctx.lineTo(x - 8 * dpr, 2 * dpr);
            ctx.lineTo(x, 16 * dpr);
            ctx.closePath();
            ctx.fill();
        }
        renderClimaxList();
        if (playhead && video && Number.isFinite(Number(video.currentTime))) {
            const x = (Number(video.currentTime) * 1000 / dur) * w;
            ctx.fillStyle = '#38bdf8';
            ctx.fillRect(Math.round(x), 0, Math.max(1, dpr), h);
        }
    }

    function mediaNowMs() {
        if (seeking && els.seek && Number.isFinite(Number(els.seek.value))) return Number(els.seek.value) * 1000;
        if (video && Number.isFinite(Number(video.currentTime))) return Number(video.currentTime) * 1000;
        if (els.seek && Number.isFinite(Number(els.seek.value))) return Number(els.seek.value) * 1000;
        return 0;
    }

    function updateMarkButton() {
        const btn = els.markBtn;
        if (!btn) return;
        const dur = mapDurationMs();
        const show = dur > 0 && Boolean(videoFile || script);
        if (!show) return;
        const t = mediaNowMs();
        const near = climaxMarks.some((m) => Math.abs(m - t) <= 1500);
        const label = near ? 'Remove climax' : 'Climax here';
        if (btn.textContent !== label) btn.textContent = label;
    }

    function markHere() {
        const dur = barDurationMs();
        if (!(dur > 0)) return false;
        climaxMarks = toggleClimaxAt(climaxMarks, mediaNowMs(), { durationMs: dur, nearMs: 1500 });
        drawHeatmap();
        call(handlers, 'onClimax', climaxMarks.slice());
        return true;
    }

    function seekToMs(ms) {
        if (!video) return;
        const seconds = Math.max(0, Number(ms) || 0) / 1000;
        const videoDur = Number(video.duration);
        const capped = Number.isFinite(videoDur) && videoDur > 0 ? Math.min(seconds, videoDur) : seconds;
        try { video.currentTime = capped; } catch (e) {}
        if (els.seek) els.seek.value = String(Math.round(capped * 10) / 10);
        renderTime();
    }

    function removeClimax(ms) {
        climaxMarks = climaxMarks.filter((m) => m !== ms);
        drawHeatmap();
        call(handlers, 'onClimax', climaxMarks.slice());
    }

    function renderClimaxList() {
        const list = els.climaxList;
        if (!list || typeof list.replaceChildren !== 'function') return;
        list.classList?.toggle('hidden', climaxMarks.length === 0);
        list.replaceChildren();
        for (const ms of climaxMarks) {
            const chip = doc.createElement('span');
            chip.className = 'inline-flex items-center gap-1 rounded-lg border border-amber-500 bg-amber-950/80 text-amber-100 text-[10px] font-semibold';
            const jump = doc.createElement('button');
            jump.type = 'button';
            jump.className = 'min-h-[2.25rem] pl-2 pr-1 cursor-pointer';
            jump.textContent = formatMediaTime(ms);
            jump.addEventListener('click', () => seekToMs(ms));
            const remove = doc.createElement('button');
            remove.type = 'button';
            remove.className = 'min-h-[2.25rem] min-w-[2.25rem] pr-2 cursor-pointer text-amber-200';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Remove climax at ${formatMediaTime(ms)}`);
            remove.addEventListener('click', () => removeClimax(ms));
            chip.append(jump, remove);
            list.appendChild(chip);
        }
    }

    function onHeatmapPointer(e) {
        const canvas = els.heatmap;
        const dur = mapDurationMs();
        if (!canvas || dur <= 0 || !canvas.getBoundingClientRect) return;
        const rect = canvas.getBoundingClientRect();
        const width = rect.width || 1;
        const x = (e.clientX ?? 0) - rect.left;
        const time = (x / width) * dur;
        climaxMarks = editClimaxMarks(climaxMarks, time, { durationMs: dur, widthPx: width, xPx: x });
        drawHeatmap();
        call(handlers, 'onClimax', climaxMarks.slice());
    }

    // One column per pixel, colored by how fast that moment is. Scaling to
    // the file's own peak made a busy script one color. A fixed scale does
    // not: a pause is green, a fast stroke is red.
    function paintSeries(ctx, series, dur, w, h, mode) {
        if (!series || !series.length || !(dur > 0) || w < 1 || h < 1) return;
        const cols = Math.max(1, Math.floor(w));
        const values = new Float32Array(cols);
        const seen = new Uint8Array(cols);
        for (let i = 0; i < series.length; i++) {
            const start = Math.max(0, Math.min(cols - 1, Math.floor((i * 1000 / dur) * cols)));
            const end = Math.max(start + 1, Math.min(cols, Math.ceil(((i + 1) * 1000 / dur) * cols)));
            for (let c = start; c < end; c++) {
                if (!seen[c] || series[i] > values[c]) values[c] = series[i];
                seen[c] = 1;
            }
        }
        if (mode === 'line') {
            ctx.beginPath();
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = Math.max(2, Math.round(h * 0.06));
            let moved = false;
            for (let c = 0; c < cols; c++) {
                if (!seen[c]) {
                    moved = false;
                    continue;
                }
                const x = c + 0.5;
                const y = (h - 2) - heatLevel(values[c]) * (h - 4);
                if (!moved) {
                    ctx.moveTo(x, y);
                    moved = true;
                } else ctx.lineTo(x, y);
            }
            ctx.stroke();
            return;
        }
        for (let c = 0; c < cols; c++) {
            if (!seen[c]) continue;
            ctx.fillStyle = heatColor(heatLevel(values[c]));
            ctx.fillRect(c, 0, 1, h);
        }
    }

    async function addFiles(list) {
        const incoming = Array.from(list || []).filter((f) => f && typeof f.name === 'string');
        if (!incoming.length) return false;
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        setError('');
        // A file of the same name replaces the one picked before it. A new
        // video replaces the one before it and drops the scripts already
        // picked: one video plays at a time. Scripts in this same drop stay.
        const names = new Set(incoming.map((f) => f.name.toLowerCase()));
        const known = new Set(incoming.map(fileKey));
        const isVideoName = (name) => VIDEO_EXTENSIONS.includes(extensionOf(name));
        const incomingVideo = incoming.some((f) => isVideoName(f.name));
        // A different video starts clean: the scripts already picked belonged
        // to the video before it. Scripts in this same drop stay, because
        // they are concatenated after this filter.
        const belongsToOld = (f) => incomingVideo && (isVideoName(f.name) || extensionOf(f.name) === 'funscript');
        picked = picked
            .filter((f) => !names.has(f.name.toLowerCase()) && !known.has(fileKey(f)) && !belongsToOld(f))
            .concat(incoming)
            .slice(-MAX_PICKED_FILES);
        await applyPairing();
        return true;
    }

    function clearFiles() {
        const block = call(handlers, 'canChangeFiles');
        if (typeof block === 'string' && block) {
            setError(block);
            return false;
        }
        picked = [];
        packName = null;
        setVideoFile(null);
        clearScript('');
        clearSecondary('');
        climaxMarks = [];
        refused = '';
        setError('');
        renderPairing(pairFiles([]));
        renderPanel();
        drawHeatmap();
        return true;
    }

    function renderPanel() {
        call(handlers, 'onPanel');
    }

    // ---- theater, fullscreen and the HUD -----------------------------------------------

    function fullscreenElement() {
        return doc ? (doc.fullscreenElement || doc.webkitFullscreenElement || null) : null;
    }

    function canFullscreen() {
        const stage = els.stage;
        return Boolean(stage && (typeof stage.requestFullscreen === 'function' || typeof stage.webkitRequestFullscreen === 'function'));
    }

    function immersive() {
        return theater || (Boolean(els.stage) && fullscreenElement() === els.stage);
    }

    function renderImmersive() {
        const on = immersive();
        if (els.stage) {
            els.stage.dataset.theater = theater ? 'on' : 'off';
            els.stage.dataset.immersive = on ? 'on' : 'off';
            els.stage.dataset.fullscreen = fullscreenElement() === els.stage ? 'on' : 'off';
        }
        els.hud?.classList?.toggle('hidden', !on);
        if (els.theaterBtn) els.theaterBtn.textContent = theater ? 'Exit theater' : 'Theater';
        if (els.fullscreenBtn) els.fullscreenBtn.textContent = fullscreenElement() === els.stage && els.stage ? 'Exit fullscreen' : 'Fullscreen';
        if (els.hudExit) els.hudExit.textContent = fullscreenElement() === els.stage ? 'Exit fullscreen' : 'Exit theater';
        if (on) showHud();
    }

    function leaveImmersive() {
        const onStage = fullscreenElement() === els.stage;
        if (onStage || fullscreenElement()) {
            try {
                const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
                const p = exit && exit.call(doc);
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
        }
        if (theater) setTheater(false);
        else renderImmersive();
    }

    function layoutTheater() {
        const stage = els.stage;
        if (!stage || !stage.style) return;
        if (!theater) {
            stage.style.width = '';
            stage.style.height = '';
            stage.style.marginLeft = '';
            stage.style.flex = '';
            return;
        }
        // flex-1 would collapse this box: the video is taken out of flow.
        stage.style.flex = 'none';
        if (typeof stage.getBoundingClientRect !== 'function') {
            stage.style.width = '100vw';
            stage.style.height = 'calc(100vh - 7rem)';
            return;
        }
        const view = win && win.innerHeight ? win.innerHeight : 0;
        let top = stage.getBoundingClientRect().top;
        if (view && top > view * 0.35 && typeof stage.scrollIntoView === 'function') {
            stage.scrollIntoView({ block: 'start' });
            top = stage.getBoundingClientRect().top;
        }
        const left = stage.getBoundingClientRect().left - (parseFloat(stage.style.marginLeft) || 0);
        stage.style.width = '100vw';
        stage.style.marginLeft = `${-Math.round(left)}px`;
        if (view) stage.style.height = `${Math.max(240, Math.round(view - Math.max(0, top)))}px`;
    }

    function setTheater(on) {
        theater = Boolean(on);
        renderImmersive();
        layoutTheater();
    }

    function toggleFullscreen() {
        if (fullscreenElement()) {
            try {
                const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
                const p = exit && exit.call(doc);
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
            return;
        }
        const stage = els.stage;
        if (!canFullscreen()) {
            // An iPhone lets only a <video> go fullscreen, which would hide
            // the HUD: theater instead.
            setTheater(true);
            return;
        }
        try {
            const p = typeof stage.requestFullscreen === 'function' ? stage.requestFullscreen() : stage.webkitRequestFullscreen();
            if (p && typeof p.catch === 'function') p.catch(() => setTheater(true));
        } catch (e) {
            setTheater(true);
        }
    }

    // The HUD's readouts hide after HUD_HIDE_MS; a tap or a mouse move shows
    // them again. Its PAUSE and STOP never hide: they only fade, and take a
    // press at any time.
    function showHud() {
        if (!els.hud) return;
        els.hud.dataset.idle = 'off';
        if (hudTimer !== null) clearTimer(hudTimer);
        hudTimer = setTimer(() => {
            hudTimer = null;
            if (els.hud) els.hud.dataset.idle = 'on';
        }, HUD_HIDE_MS);
    }

    function bindControls() {
        els.fileInput?.addEventListener('change', (e) => {
            const files = e.target && e.target.files ? Array.from(e.target.files) : [];
            addFiles(files);
            try { e.target.value = ''; } catch (x) {}
        });
        const formats = describeVideoFormats();
        if (els.chooseBtn) els.chooseBtn.textContent = formats.button;
        if (els.formatHint) els.formatHint.textContent = formats.hint;
        els.chooseBtn?.addEventListener('click', () => els.fileInput?.click());
        els.primaryBtn?.addEventListener('click', () => {
            if (!script) els.primaryInput?.click();
            else {
                heatmapView = 'primary';
                drawHeatmap();
            }
        });
        els.secondaryBtn?.addEventListener('click', () => {
            if (!secondary) els.secondaryInput?.click();
            else {
                heatmapView = 'secondary';
                drawHeatmap();
            }
        });
        els.bothBtn?.addEventListener('click', () => {
            if (!script || !secondary) return;
            heatmapView = 'both';
            drawHeatmap();
        });
        els.clearScriptsBtn?.addEventListener('click', () => clearScripts());
        els.primaryInput?.addEventListener('change', (e) => {
            const file = e.target && e.target.files && e.target.files[0];
            if (file) choosePrimary(file);
            try { e.target.value = ''; } catch (x) {}
        });
        els.secondaryInput?.addEventListener('change', (e) => {
            const file = e.target && e.target.files && e.target.files[0];
            if (file) chooseSecondary(file);
            try { e.target.value = ''; } catch (x) {}
        });
        els.markBtn?.addEventListener('click', () => markHere());
        bindScrub();

    function bindScrub() {
        const bar = els.scrub;
        if (!bar) return;
        const place = (e) => {
            if (!video) return;
            const durMs = barDurationMs();
            if (!(durMs > 0)) return;
            const rect = bar.getBoundingClientRect();
            const width = rect.width || 1;
            const x = Math.max(0, Math.min(width, (e.clientX ?? 0) - rect.left));
            const seconds = (x / width) * (durMs / 1000);
            seeking = true;
            if (els.seek) els.seek.value = String(Math.round(seconds * 10) / 10);
            const videoDur = Number(video.duration);
            const capped = Number.isFinite(videoDur) && videoDur > 0 ? Math.min(seconds, videoDur) : seconds;
            try { video.currentTime = capped; } catch (err) {}
            renderTime();
        };
        bar.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            try { bar.setPointerCapture(e.pointerId); } catch (err) {}
            place(e);
        });
        bar.addEventListener('pointermove', (e) => {
            const captured = typeof bar.hasPointerCapture === 'function' && bar.hasPointerCapture(e.pointerId);
            if (!captured) return;
            place(e);
        });
        const release = () => { seeking = false; };
        bar.addEventListener('pointerup', release);
        bar.addEventListener('pointercancel', release);
    }
        if (els.seekHeat && typeof globalThis.ResizeObserver === 'function') {
            const observer = new globalThis.ResizeObserver(() => drawHeatmap());
            observer.observe(els.seekHeat);
        }
        els.heatmap?.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            onHeatmapPointer(e);
        });
        if (els.heatmap && typeof globalThis.ResizeObserver === 'function') {
            const observer = new globalThis.ResizeObserver(() => drawHeatmap());
            observer.observe(els.heatmap);
        }
        els.videoUrlBtn?.addEventListener('click', () => useVideoLink(els.videoUrl?.value));
        els.videoUrl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                useVideoLink(els.videoUrl.value);
            }
        });
        els.clearBtn?.addEventListener('click', () => clearFiles());
        const drop = els.dropZone;
        if (drop) {
            drop.addEventListener('dragover', (e) => {
                e.preventDefault();
                drop.dataset.over = 'on';
            });
            drop.addEventListener('dragleave', () => { drop.dataset.over = 'off'; });
            drop.addEventListener('drop', (e) => {
                e.preventDefault();
                drop.dataset.over = 'off';
                const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
                if (files.length) addFiles(files);
                else {
                    const text = e.dataTransfer ? (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')) : '';
                    const first = String(text || '').split(/\s+/)[0];
                    if (first) useVideoLink(first);
                }
            });
        }
        els.packSelect?.addEventListener('change', () => {
            packName = els.packSelect.value === '' ? null : els.packSelect.value;
            applyPairing();
        });
        els.playBtn?.addEventListener('click', () => call(handlers, 'onPlayButton', { playing: Boolean(video && !video.paused) }));
        els.muteBtn?.addEventListener('click', () => {
            if (!video) return;
            video.muted = !video.muted;
            renderTime();
        });
        els.seek?.addEventListener('input', () => {
            seeking = true;
            if (els.time && video) {
                const dur = Number(video.duration);
                els.time.textContent = `${formatMediaTime(Number(els.seek.value) * 1000)} / ${formatMediaTime(Number.isFinite(dur) ? dur * 1000 : 0)}`;
            }
        });
        els.seek?.addEventListener('change', () => {
            seeking = false;
            if (!video) return;
            const t = Number(els.seek.value);
            if (Number.isFinite(t)) {
                try { video.currentTime = t; } catch (e) {}
            }
        });
        els.offsetMinus?.addEventListener('click', () => nudgeOffset(-OFFSET_NUDGE_MS));
        els.offsetPlus?.addEventListener('click', () => nudgeOffset(OFFSET_NUDGE_MS));
        els.theaterBtn?.addEventListener('click', () => setTheater(!theater));
        els.fullscreenBtn?.addEventListener('click', () => toggleFullscreen());
        if (els.fullscreenBtn && !canFullscreen()) els.fullscreenBtn.classList?.add('hidden');
        els.hudPause?.addEventListener('click', (e) => {
            e.stopPropagation?.();
            call(handlers, 'onPlayButton', { playing: Boolean(video && !video.paused) });
            showHud();
        });
        els.hudSeek?.addEventListener('input', () => {
            seeking = true;
            const t = Number(els.hudSeek.value);
            if (video && Number.isFinite(t)) {
                try { video.currentTime = t; } catch (err) {}
            }
            renderTime();
        });
        els.hudSeek?.addEventListener('change', () => { seeking = false; });
        els.hudVolume?.addEventListener('input', () => {
            if (!video) return;
            const level = Number(els.hudVolume.value);
            if (!Number.isFinite(level)) return;
            video.volume = Math.max(0, Math.min(1, level / 100));
            if (video.volume > 0) video.muted = false;
            renderTime();
        });
        els.hudExit?.addEventListener('click', (e) => {
            e.stopPropagation?.();
            leaveImmersive();
            showHud();
        });
        els.hudMute?.addEventListener('click', (e) => {
            e.stopPropagation?.();
            if (!video) return;
            video.muted = !video.muted;
            renderTime();
            showHud();
        });
        video?.addEventListener('click', () => {
            if (immersive()) call(handlers, 'onPlayButton', { playing: Boolean(video && !video.paused) });
        });
        els.hudStop?.addEventListener('click', (e) => {
            e.stopPropagation?.();
            call(handlers, 'onHudStop');
            showHud();
        });
        if (els.stage) {
            els.stage.addEventListener('pointermove', () => { if (immersive()) showHud(); });
            els.stage.addEventListener('pointerdown', () => { if (immersive()) showHud(); });
        }
        doc?.addEventListener?.('fullscreenchange', renderImmersive);
        doc?.addEventListener?.('webkitfullscreenchange', renderImmersive);
        win?.addEventListener?.('resize', () => { if (theater) layoutTheater(); });
        // Escape leaves theater the way the browser lets it leave fullscreen,
        // unless something else (a modal) took the key first.
        doc?.addEventListener?.('keydown', (e) => {
            if (e.key === 'Escape' && theater && !e.defaultPrevented) setTheater(false);
        });
        // The blob URL dies with the page.
        win?.addEventListener?.('pagehide', (e) => {
            if (e && e.persisted) return;
            if (videoUrl) {
                try { urls.revokeObjectURL(videoUrl); } catch (x) {}
            }
        });
    }

    function nudgeOffset(delta) {
        if (!feed) return 0;
        return setOffset(feed.offset() + delta, { user: true });
    }

    function setOffset(ms, { user = false } = {}) {
        const applied = feed ? feed.setOffset(ms) : 0;
        if (els.offsetValue) els.offsetValue.textContent = formatOffset(applied);
        if (user) call(handlers, 'onOffset', applied);
        return applied;
    }

    function hasAudio() {
        if (!video) return null;
        if (video.audioTracks && typeof video.audioTracks.length === 'number') return video.audioTracks.length > 0;
        if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
        if (typeof video.webkitAudioDecodedByteCount === 'number' && Number(video.currentTime) > 1) {
            return video.webkitAudioDecodedByteCount > 0;
        }
        return null;
    }

    bindVideo();
    bindControls();
    if (watchTimer === null) watchTimer = setRepeat(watch, 1000);
    renderImmersive();
    renderTime();

    return {
        addFiles,
        choosePrimary,
        chooseSecondary,
        clearScripts,
        heatmapView() {
            return heatmapView;
        },
        clearFiles,
        // The video follows the session. play() resolves { ok, reason }.
        async play() {
            if (!video || !videoFile) return { ok: false, reason: 'no video is loaded' };
            if (videoError) return { ok: false, reason: videoError };
            edgeHold = false;
            if (video.ended) {
                try { video.currentTime = 0; } catch (e) {}
            }
            try {
                await video.play();
                return { ok: true, reason: '' };
            } catch (e) {
                return { ok: false, reason: (e && (e.name || e.message)) || 'refused', name: e && e.name };
            }
        },
        pause() {
            edgeHold = false;
            if (video && !video.paused) {
                try { video.pause(); } catch (e) {}
            }
        },
        // Edge action Pause video: the governor holds the video at an edge
        // and lets it go at the release. The session runs on meanwhile.
        holdForEdge() {
            if (!video || video.paused) return false;
            edgeHold = true;
            try { video.pause(); } catch (e) {}
            return true;
        },
        releaseEdge() {
            if (!edgeHold) return Promise.resolve({ ok: false, reason: 'not held' });
            edgeHold = false;
            if (!video) return Promise.resolve({ ok: false, reason: 'no video' });
            return video.play().then(() => ({ ok: true, reason: '' }), (e) => ({ ok: false, reason: (e && e.name) || 'refused' }));
        },
        edgeHeld() {
            return edgeHold;
        },
        setLoop(on) {
            if (video) video.loop = Boolean(on);
        },
        hasVideo() {
            return Boolean(videoFile);
        },
        followExternal,
        usingExternalClock() {
            return externalClock;
        },
        clearExternalClock() {
            externalClock = false;
            setVideoState(videoFile ? 'paused' : 'idle');
        },
        duration() {
            const d = video ? Number(video.duration) : NaN;
            return Number.isFinite(d) ? d : 0;
        },
        videoReady() {
            return Boolean(video && videoFile && !videoError && Number(video.readyState) >= VIDEO_READY_STATE);
        },
        videoError() {
            return videoError;
        },
        isPlaying() {
            return Boolean(video && !video.paused && !video.ended);
        },
        audible() {
            if (!video) return false;
            return isAudible({ paused: video.paused, muted: video.muted, volume: Number(video.volume), hasAudio: hasAudio() });
        },
        script() {
            return script ? { ...script } : null;
        },
        secondary() {
            return secondary ? { ...secondary, name: secondaryFile ? secondaryFile.name : '' } : null;
        },
        setClimaxMarks(marks) {
            climaxMarks = editClimaxMarks(Array.isArray(marks) ? marks : [], 0, { durationMs: 0 });
            drawHeatmap();
        },
        climaxMarks() {
            return climaxMarks.slice();
        },
        refused() {
            return refused;
        },
        setOffset,
        nudgeOffset,
        setTheater,
        toggleFullscreen,
        leaveImmersive,
        immersive,
        showHud,
        // Readouts the HUD shows; app.js fills them.
        renderHud(values = {}) {
            const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
            set(els.hudHr, values.hr ?? '--');
            set(els.hudMark, values.mark ?? '--');
            set(els.hudPhase, values.phase ?? '');
            set(els.hudEdges, values.edges ?? '0');
            set(els.hudTimer, values.timer ?? '00:00');
            set(els.hudPrimary, values.primary ?? '0%');
            set(els.hudSecondary, values.secondary ?? '0%');
            set(els.hudNotice, values.notice ?? '');
            els.hudNotice?.classList?.toggle('hidden', !values.notice);
            if (els.hudBar) els.hudBar.style.width = `${Math.max(0, Math.min(100, Number(values.allowance) || 0))}%`;
        },
        // For tests and the smoke run.
        _picked() {
            return picked.slice();
        }
    };
}
