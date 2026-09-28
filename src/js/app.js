import { state, advancedSettings, SETTING_KEYS, SETTING_DEFAULTS } from './state.js';
import {
    calculateEngineOutputs,
    resolveEngineMode,
    gameEdgeReleased,
    clampEdgeHoldPercent,
    resolveEdgeTriggerHr,
    describeEdgeHoldPreview,
    micBoostReachesMotors
} from './engine.js';
import {
    ORGASM_BOOST_CAP,
    computeEffectiveCeiling,
    sanitizeHrLimits,
    parseSessionDuration,
    oracleTiming,
    rollOracleFate,
    tickEdgeTraining,
    clampTrainHoldSeconds,
    clampTrainEdges,
    survivalDrive,
    calibrationReading,
    DEFAULT_MIN_HR,
    clampStallGuardSeconds,
    clampStallPauseSeconds,
    tickStallGuard,
    endgameKeepsOrgasmLatch,
    describeGameNotice,
    describeCutoffNotice,
    describeStallPauseNotice,
    sanitizeSessionLimits
} from './session-rules.js';
import { safeGet, safeParse, safeSet, safeRemove, saveHistoryTrimmed } from './storage.js';
import { buildBackup, backupFilename, describeBackupExport, readBackup, describeBackupImport, mergeDeviceMaps, countDroppedOnMerge, pruneReservedKeys } from './backup.js';
import { applySettingSchema } from './settings-schema.js';
import { createWriteCoalescer } from './write-coalescer.js';
import { planBannerUpdate, canClearBanner, hiddenBannerState, BANNER_OWNER_ANY } from './alert-banner.js';
import { pushSample, buildFunscripts, toFunscript } from './funscript.js';
import { drawTelemetryChart, shouldDrawPullbackLine, watchChartResize } from './chart.js';
import { connectBleHeartRate, disconnectBle, isBleConnected, isBleReconnecting } from './hardware/ble.js';
import { describeBluetoothSupport, describeBleError } from './hardware/ble-protocol.js';
import { createHrWatchdog, clampStaleSeconds } from './hr-watchdog.js';
import { connectHandy, disconnectHandy, dispatchHandy, stopHandyOnUnload, handyConnected, setHandyHandlers } from './hardware/handy.js';
import { normalizeEnvelope, applyEndMargin, clampEndMargin } from './hardware/handy-protocol.js';
import { RUIN_RIDE_SECONDS, RUIN_LOCK_SECONDS } from './patterns.js';
import { APP_VERSION, parseChangelog, GITHUB_CHANGELOG_URL, GITHUB_RELEASES_URL } from './version.js';
import {
    connectIntifaceServer,
    disconnectIntiface,
    rescanIntiface,
    dispatchIntiface,
    stopAllIntiface,
    setAxisRole,
    setAxisMaxCap,
    setAxisInvert,
    setDeviceRotation,
    reverseIntifaceRotation,
    saveIntifaceConfig,
    testSingleAxis,
    isIntifaceConnected,
    isIntifaceScanning,
    getIntifaceStatus,
    countAssignedIntifaceDevices,
    intifaceDevices,
    DEFAULT_INTIFACE_URL,
    ALTERNATE_SECONDS_MIN,
    ALTERNATE_SECONDS_MAX,
    INTIFACE_STORAGE_KEY
} from './hardware/intiface.js';
import {
    connectTCode,
    disconnectTCode,
    dispatchTCode,
    stopTCode,
    setTCodeHandlers,
    setAxisRole as setTCodeAxisRole,
    setAxisCap as setTCodeAxisCap,
    setAxisInvert as setTCodeAxisInvert,
    testAxis as testTCodeAxis,
    isTCodeConnected,
    isSerialSupported,
    getTCodeStatus,
    getTCodeDevice,
    countAssignedTCodeAxes,
    tcodeHasRole,
    TCODE_STORAGE_KEY
} from './hardware/tcode.js';
import { describeSerialSupport } from './hardware/tcode-protocol.js';
import {
    initHostPeer,
    initRemotePeer,
    broadcastPeerTelemetry,
    sendPeerCommand,
    pruneStalePeers,
    getPeerCounts,
    peerLibraryAvailable
} from './webrtc.js';
import {
    speakPrompt,
    speakNow,
    cancelSpeech,
    setMindgamePrompt,
    startMicMonitor,
    stopMicMonitor,
    sampleMicLevel,
    clearMicBoost,
    listSpeechVoices,
    clampMicGate,
    clampMicBoostBpm,
    micBoostFromLevel,
    micBoostedHr
} from './voice.js';
import {
    VOICE_CUE_CATALOG,
    mergeVoiceCues,
    resolveVoiceCue,
    applyImportedCues,
    describeImport,
    voiceImportAlert,
    parseVoiceCuesText,
    serializeVoiceCues,
    clampEncourageSeconds
} from './voice-cues.js';

// Load persisted settings. The old 15/85 default envelope is migrated to
// 0/100 exactly once (flagged), so a user who deliberately types 15/85 later
// keeps it.
const storedSettings = safeParse('edgeloop_advanced_settings', null);
if (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings)) {
    const parsed = storedSettings;
    let migrated = false;
    // Only a store that has never seen the migration runs it. A file can
    // carry `envelopeMigrated: false`, and re-running the migration on that
    // would wipe a 15/85 envelope the user had just restored - then write
    // the flag back and do it again to the next file.
    if (!Object.prototype.hasOwnProperty.call(parsed, 'envelopeMigrated')) {
        if (parsed.handyHwMin === 15 && parsed.handyHwMax === 85) {
            parsed.handyHwMin = 0;
            parsed.handyHwMax = 100;
        }
        parsed.envelopeMigrated = true;
        migrated = true;
    }
    // Before the explicit "At the ceiling" control, crawl was implied by the
    // stall guard toggle: keep whatever behaviour the user effectively had.
    if (parsed.ceilingBehaviour !== 'stop' && parsed.ceilingBehaviour !== 'crawl') {
        parsed.ceilingBehaviour = parsed.stallGuard === false ? 'stop' : 'crawl';
        migrated = true;
    }
    // Old builds stored an offset (0-15 meaning 100-115% of Climax HR).
    if (!Number.isFinite(Number(parsed.edgeHoldPercent))) {
        const old = Number(parsed.edgeOvershootPercent);
        parsed.edgeHoldPercent = (Number.isFinite(old) && old >= 0 && old <= 20)
            ? 100 + Math.round(old)
            : 100;
        migrated = true;
    }
    // The offset used to be a separate number. A file from that build gets
    // a dual-stim max of (single max minus that offset) the first time it
    // is opened, then the offset itself is dropped.
    if (parsed.dualMaxHr == null || parsed.dualMaxHr === '') {
        const max = Number(parsed.maxHr);
        const base = Number.isFinite(max) ? max : 140;
        const dampen = parsed.dualDampening === false ? 0 : (Number(parsed.dualDampeningBpm) || 15);
        parsed.dualMaxHr = Math.max(DEFAULT_MIN_HR + 1, Math.round(base - dampen));
        migrated = true;
    }
    delete parsed.dualDampening;
    delete parsed.dualDampeningBpm;
    Object.assign(advancedSettings, parsed);
    if (migrated) persistSettings();
}

// Heart-rate signal watchdog (hr-watchdog.js). Its clocks are reset on BLE
// connect and when the simulator is engaged, never on START / RESUME: a
// session may only start or resume on a fresh valid reading, so the clocks
// must tell the truth at that moment. Its settings mirror the Guards tab and
// are re-applied after load, apply and import.
const hrWatchdog = createHrWatchdog();
function syncWatchdogSettings() {
    // The two values themselves are bounded by the schema (the single place
    // every Session Setup field is checked); this only hands them to the
    // watchdog. It used to coerce them itself with `!== false`, which read
    // the string 'false' from a hand-edited file as TRUE and auto-resumed a
    // session the watchdog had paused.
    applySettingSchema(advancedSettings);
    hrWatchdog.configure({
        staleMs: advancedSettings.hrStaleSeconds * 1000,
        autoResume: advancedSettings.hrAutoResume
    });
}
// Every Session Setup field, checked the same way wherever it enters -
// typed, loaded from storage on boot, or restored from a file. One
// sanitizer per field lives in settings-schema.js, and a field with no
// sanitizer is a failing test rather than a value nothing bounds: that was
// how `gammaCurve`, which has no control at all and is read straight into
// the engine, could be set to 200 by a one-field imported file and stop the
// engine backing off as the pulse climbed.
function syncGuardSettings() {
    const corrected = applySettingSchema(advancedSettings);
    // The cross-field rules run after the per-field pass: the HR pair, the
    // duration window and the Endgame Trigger depend on each other, and a
    // stored pair is reconciled exactly as a typed one is - a hand-edited
    // store cannot raise the ceiling.
    const limits = sanitizeSessionLimits(advancedSettings);
    for (const [name, value] of Object.entries(limits)) {
        if (JSON.stringify(advancedSettings[name]) !== JSON.stringify(value) && !corrected.includes(name)) {
            corrected.push(name);
        }
        advancedSettings[name] = value;
    }
    // What the pass had to change, for the import to report honestly.
    return corrected;
}
syncWatchdogSettings();
syncGuardSettings();
hrWatchdog.reset(Date.now());

// Live funscript sample buffer: one 4 Hz timeline of { at, speed, secondary,
// strokeMin, strokeMax }. Both channel scripts are built from it on export.
let funscriptSamples = [];
let funscriptSessionStart = 0;

// Query string check for remote controller
const urlParams = new URLSearchParams(window.location.search);
const partnerRoom = urlParams.get('partner');
const viewerRoom = urlParams.get('group_sub');
// ?partner= opens a remote CONTROLLER (transport, orgasm and mode commands);
// ?group_sub= opens a read-only VIEWER. Both render the host's telemetry and
// run no engine, watchdog or hardware of their own.
export const isRemoteController = Boolean(partnerRoom);
export const isRemoteViewer = !isRemoteController && Boolean(viewerRoom);
const isRemotePage = isRemoteController || isRemoteViewer;
const remoteRoom = isRemoteController ? partnerRoom : viewerRoom;
const remoteRoleLabel = isRemoteViewer ? 'Viewer' : 'Remote Controller';
// Set when the host link died (peer close / error / silent telemetry).
let remoteLinkLost = false;

// Header badge on a remote page: "Viewer · Live", "Remote Controller · Disconnected"...
let remoteRoleSuffix = '';
function setRemoteRoleStatus(suffix) {
    remoteRoleSuffix = suffix || '';
    const role = document.getElementById('roleIndicator');
    if (role) role.textContent = suffix ? `${remoteRoleLabel} · ${suffix}` : remoteRoleLabel;
}

if (isRemotePage) {
    const role = document.getElementById('roleIndicator');
    if (role) {
        role.className = isRemoteViewer
            ? "text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-900 text-sky-200 uppercase"
            : "text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-900 text-purple-200 uppercase";
    }
    setRemoteRoleStatus('Connecting');
    const hrTag = document.getElementById('hrWarningTag');
    if (hrTag) hrTag.textContent = "WEARER TELEMETRY";
}

// Master DOM Elements
const playPauseBtn = document.getElementById('sessionPlayPauseBtn');
const playPauseText = document.getElementById('playPauseText');
const playPauseIcon = document.getElementById('playPauseIcon');
const stopBtn = document.getElementById('sessionStopBtn');
const resetBtn = document.getElementById('sessionResetBtn');
const cameEarlyBtn = document.getElementById('cameEarlyBtn');
const orgasmBtn = document.getElementById('orgasmBtn');
const orgasmBtnText = document.getElementById('orgasmBtnText');

// Age Verification Handlers
const ageOverlay = document.getElementById('ageOverlay');
if (safeGet('edgeloop_age_verified') === 'true' && ageOverlay) {
    ageOverlay.classList.add('hidden');
}
document.getElementById('ageConfirmBtn')?.addEventListener('click', () => {
    safeSet('edgeloop_age_verified', 'true');
    if (ageOverlay) ageOverlay.classList.add('hidden');
});
document.getElementById('ageDenyBtn')?.addEventListener('click', () => {
    window.location.href = 'https://www.google.com';
});

// Guide Wizard (3-step setup)
let wizardStepIndex = 0;
const wizardOverlay = document.getElementById('wizardOverlay');

function markWizardSeen() {
    safeSet('edgeloop_wizard_seen', 'true');
}

function renderWizardStep() {
    document.querySelectorAll('.wizard-pane').forEach((pane, idx) => {
        pane.classList.toggle('hidden', idx !== wizardStepIndex);
    });
    document.querySelectorAll('.wizard-dot').forEach((dot, idx) => {
        dot.className = idx === wizardStepIndex
            ? 'wizard-dot h-1.5 w-6 rounded-full bg-purple-500'
            : 'wizard-dot h-1.5 w-6 rounded-full bg-slate-700';
    });
    const backBtn = document.getElementById('wizardBackBtn');
    const nextBtn = document.getElementById('wizardNextBtn');
    if (backBtn) backBtn.classList.toggle('hidden', wizardStepIndex === 0);
    if (nextBtn) nextBtn.textContent = wizardStepIndex >= 2 ? 'Get Started' : 'Next';
    if (wizardStepIndex === 2) {
        const single = document.getElementById('wizardSingleMax');
        const dual = document.getElementById('wizardDualMax');
        const max = document.getElementById('maxHr');
        const dualMax = document.getElementById('dualMaxHr');
        if (single && max) single.value = max.value;
        if (dual && dualMax) dual.value = dualMax.value;
    }
}

function openWizard() {
    wizardStepIndex = 0;
    renderWizardStep();
    wizardOverlay?.classList.remove('hidden');
}

function closeWizard() {
    wizardOverlay?.classList.add('hidden');
    markWizardSeen();
}

window.dismissWizard = closeWizard;

document.getElementById('guideBtn')?.addEventListener('click', openWizard);
document.getElementById('wizardSkipBtn')?.addEventListener('click', closeWizard);
document.getElementById('wizardBackBtn')?.addEventListener('click', () => {
    wizardStepIndex = Math.max(0, wizardStepIndex - 1);
    renderWizardStep();
});
document.getElementById('wizardNextBtn')?.addEventListener('click', () => {
    if (wizardStepIndex >= 2) {
        closeWizard();
        return;
    }
    wizardStepIndex += 1;
    renderWizardStep();
});

function maybeShowFirstRunWizard() {
    const ageOk = safeGet('edgeloop_age_verified') === 'true';
    const seen = safeGet('edgeloop_wizard_seen') === 'true';
    if (ageOk && !seen) openWizard();
}

document.getElementById('ageConfirmBtn')?.addEventListener('click', () => {
    if (location.protocol === 'file:') return;
    // The wizard walks the host through pairing hardware; a partner or viewer
    // page has none.
    if (isRemotePage) return;
    setTimeout(maybeShowFirstRunWizard, 50);
});

// Disconnect / Watchdog Alert Banner
//
// One banner carries every report, so it is ranked (see alert-banner.js): an
// advisory can never overwrite a safety report, and a banner is only hidden
// again by whoever raised it or by the wearer.
let bannerState = hiddenBannerState();

document.getElementById('dismissBannerBtn')?.addEventListener('click', () => {
    hideAlertBanner(BANNER_OWNER_ANY);
});

function showAlertBanner(message, { severity = 'safety', source = 'device' } = {}) {
    const banner = document.getElementById('disconnectBanner');
    const msg = document.getElementById('disconnectMsg');
    bannerState = planBannerUpdate(bannerState, { message, severity, source });
    if (msg) msg.textContent = bannerState.text;
    if (banner) banner.classList.remove('hidden');
}

function hideAlertBanner(owner) {
    if (!canClearBanner(bannerState, owner)) return;
    bannerState = hiddenBannerState();
    document.getElementById('disconnectBanner')?.classList.add('hidden');
}

function triggerDisconnectAlert(message, source = 'device') {
    showAlertBanner(message, { severity: 'safety', source });

    if (pauseSession(null)) syncTelemetry();
    checkReadiness();
}

// Pause a RUNNING or RAMPDOWN session, remembering which one so RESUME goes
// back into the rampdown where it left off. Motors are stopped immediately.
// Returns false when there was nothing to pause.
function pauseSession(voiceText = 'Paused.') {
    if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'RAMPDOWN') return false;
    state.resumeStatus = state.sessionStatus;
    state.sessionStatus = 'PAUSED';
    state.pauses += 1;
    const pauseEl = document.getElementById('pauseCount');
    if (pauseEl) pauseEl.textContent = state.pauses;
    renderTransport('PAUSED');
    clearMicBoost(state);
    dispatchHardware(0, 0, 0, 100, true);
    if (voiceText) cueVoice('paused');
    return true;
}

// Put the transport button into the look for `status`. Shared by start,
// pause, stop / reset and the remote controller's telemetry renderer.
function renderTransport(status) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = false;
    if (status === 'RUNNING' || status === 'RAMPDOWN') {
        if (playPauseText) playPauseText.textContent = "PAUSE";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        playPauseBtn.className = "flex-1 bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-amber-950/40 cursor-pointer";
    } else if (status === 'PAUSED') {
        if (playPauseText) playPauseText.textContent = "RESUME";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    } else {
        if (playPauseText) playPauseText.textContent = "START SESSION";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    }
}

// Grey out the transport with a reason while the hardware is not ready.
function renderTransportWaiting(reason) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = true;
    if (playPauseText) playPauseText.textContent = reason;
    playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
}

// Flag a numeric input as invalid (red border) or restore its normal border.
function markInputValidity(input, ok) {
    if (!input) return;
    // A ring plus tinted background, so the flag is visible even on the
    // Climax HR input whose focus border is already rose.
    input.classList.toggle('border-rose-500', !ok);
    input.classList.toggle('ring-1', !ok);
    input.classList.toggle('ring-rose-500', !ok);
    input.classList.toggle('bg-rose-950/40', !ok);
    input.classList.toggle('border-slate-700', ok);
    if (ok) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
}

// Read and validate the typed Resting / Climax HR. A field that does not
// parse keeps the last known-good value and is flagged, so garbage can never
// raise the ceiling.
function readHrLimits() {
    const maxInput = document.getElementById('maxHr');
    const dualInput = document.getElementById('dualMaxHr');
    // Resting heart rate is assumed. The cockpit does not ask for it.
    const limits = sanitizeHrLimits(DEFAULT_MIN_HR, maxInput?.value, state.lastGoodHrLimits || {});
    limits.minHr = DEFAULT_MIN_HR;
    const dualRaw = parseInt(dualInput?.value, 10);
    const dualFallback = Number.isFinite(state.lastGoodHrLimits?.dualMaxHr)
        ? state.lastGoodHrLimits.dualMaxHr
        : (advancedSettings.dualMaxHr || 125);
    const dualOk = Number.isFinite(dualRaw) && dualRaw > DEFAULT_MIN_HR && dualRaw <= 250;
    limits.dualMaxHr = dualOk ? dualRaw : dualFallback;
    limits.invalid = limits.invalid.filter((name) => name !== 'min');
    if (!dualOk && dualInput && String(dualInput.value).trim() !== '') limits.invalid.push('dual');
    if (limits.valid && dualOk) {
        state.lastGoodHrLimits = { minHr: DEFAULT_MIN_HR, maxHr: limits.maxHr, dualMaxHr: limits.dualMaxHr };
    }
    markInputValidity(maxInput, !limits.invalid.includes('max'));
    markInputValidity(dualInput, !limits.invalid.includes('dual'));
    return limits;
}

function setBadgeState(type, status, nameLabel, batteryLabel = null) {
    const card = document.getElementById(`card${type}`);
    const dot = document.getElementById(`dot${type}`);
    const text = document.getElementById(`badge${type}Text`);
    const batBadge = document.getElementById(`badge${type}Battery`);

    if (text) text.textContent = nameLabel;
    if (batBadge) {
        if (batteryLabel) {
            batBadge.textContent = batteryLabel;
            batBadge.classList.remove('hidden');
        } else {
            batBadge.classList.add('hidden');
        }
    }

    if (card && dot) {
        if (status === 'connected') {
            card.className = "text-left p-2 rounded-xl bg-emerald-950/20 border border-emerald-800/80 hover:border-emerald-600 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0 mt-1";
        } else if (status === 'connecting') {
            card.className = "text-left p-2 rounded-xl bg-amber-950/20 border border-amber-800/80 hover:border-amber-600 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-amber-400 animate-ping shrink-0 mt-1";
        } else if (status === 'warning') {
            card.className = "text-left p-2 rounded-xl bg-amber-950/20 border border-amber-700 hover:border-amber-500 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-amber-400 shrink-0 mt-1";
        } else {
            card.className = "text-left p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-rose-500/30 border border-rose-500 shrink-0 mt-1";
        }
    }
    checkReadiness();
}

// Whether the host has a pulse source and a toy to drive. Sent to the remote
// controller so its transport can mirror the host's readiness.
function hardwareReadiness() {
    const hrReady = isBleConnected() || state.simEngaged;
    const toyReady = Boolean(
        handyConnected
        || (isIntifaceConnected() && intifaceDevices.size > 0)
        || (isTCodeConnected() && countAssignedTCodeAxes() > 0)
    );
    return { hrReady, toyReady };
}

// True when the pulse source has delivered a usable reading recently enough
// for the watchdog (the simulator is never stale: its value is the slider).
function pulseIsFresh(now = Date.now()) {
    if (state.simEngaged) return true;
    return hrWatchdog.isFresh(now);
}

// Stricter than pulseIsFresh(): true only while hrCurrent is a LIVE reading.
// pulseIsFresh() stays true throughout the watchdog's hold window, where the
// pulse is frozen on the last valid packet; anything that would move the
// toys on something other than a measured beat must gate on this instead.
function pulseIsLive(now = Date.now()) {
    if (state.simEngaged) return true;
    return hrWatchdog.status(now) === 'ok';
}

// Why START / RESUME must stay disabled right now, or null when the session
// may start. Shared by checkReadiness() and startOrResumeSession() so a
// remote command can never bypass what the button shows: resuming on a
// frozen heart rate would drive the toys for a full tick (or the whole
// signal-loss timeout) before the watchdog re-paused.
function transportWaitingReason(now = Date.now()) {
    const { hrReady, toyReady } = hardwareReadiness();
    if (!hrReady && !toyReady) return "WAITING FOR HR SENSOR & TOY";
    if (!hrReady) return "WAITING FOR HR SENSOR";
    if (!toyReady) return "WAITING FOR TOY CONNECTION";
    if (state.sessionStatus === 'PAUSED' && state.hrSignalPaused) return "WAITING FOR PULSE";
    if (!pulseIsFresh(now)) return "WAITING FOR PULSE";
    return null;
}

function checkReadiness() {
    if (!playPauseBtn) return;

    const active = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED' || state.sessionStatus === 'RAMPDOWN';

    if (isRemotePage) {
        // A remote page has no hardware of its own: it mirrors the host's
        // state; a controller sends commands, a viewer can only watch.
        if (remoteLinkLost) renderTransportWaiting("HOST LINK LOST");
        else if (active || state.remoteHostReady) renderTransport(state.sessionStatus);
        else renderTransportWaiting("WAITING FOR HOST HARDWARE");
        if (isRemoteViewer) {
            playPauseBtn.disabled = true;
            playPauseBtn.classList.remove('cursor-pointer');
            playPauseBtn.classList.add('cursor-not-allowed', 'opacity-70');
        }
        return;
    }

    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        playPauseBtn.disabled = false;
        return;
    }

    // IDLE and PAUSED alike: START / RESUME need a pulse source with a fresh
    // valid reading and a toy.
    const reason = transportWaitingReason();
    if (reason) renderTransportWaiting(reason);
    else renderTransport(state.sessionStatus === 'PAUSED' ? 'PAUSED' : 'IDLE');
}

// Center Intensity Slider
const intensitySlider = document.getElementById('intensitySlider');
const intensityValDisplay = document.getElementById('intensityValDisplay');
intensitySlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.intensityValue = val;
    const pct = Math.round(50 + val);
    if (intensityValDisplay) {
        intensityValDisplay.textContent = val === 50 ? "100% (Default Balanced)" : `${pct}% (${val > 50 ? 'Intense' : 'Gentle'})`;
        intensityValDisplay.className = val > 65 ? 'font-mono font-bold text-rose-400' : (val < 35 ? 'font-mono font-bold text-emerald-400' : 'font-mono font-bold text-amber-400');
    }
    updateEngine();
    syncTelemetry();
});

// The hardware travel envelope is ONE persisted setting (advancedSettings
// handyHwMin / handyHwMax) that bounds The Handy and every TCode linear axis,
// so it is edited from both the Handy and the TCode modal. Every input and
// display on the page is listed here and kept in sync.
const HW_ENVELOPE_INPUT_IDS = {
    min: ['hwMinInput', 'tcodeHwMinInput'],
    max: ['hwMaxInput', 'tcodeHwMaxInput']
};
const HW_ENVELOPE_DISPLAY_IDS = ['hwEnvelopeDisplay', 'tcodeHwEnvelopeDisplay'];

function hwEnvelopeInputs(bound) {
    return HW_ENVELOPE_INPUT_IDS[bound].map((id) => document.getElementById(id)).filter(Boolean);
}

// Update every Travel Envelope Bounds display (Handy and TCode modals)
function updateHwEnvelopeDisplay() {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    HW_ENVELOPE_DISPLAY_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = `Bounds: ${env.min}% - ${env.max}%`;
    });
    updateHandySlideDisplay();
}

// What a full-length stroke actually reaches The Handy as, once the end-stop
// margin has been applied. The wearer can see what the margin costs them
// before they decide what to type into it. Handy only; the T-Code and
// Intiface axes get the envelope unchanged.
function updateHandySlideDisplay() {
    const el = document.getElementById('handySlideDisplay');
    if (!el) return;
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    const margin = clampEndMargin(advancedSettings.handyEndMargin);
    const sent = applyEndMargin({ min: env.min, max: env.max }, margin);
    // The margin yields rather than shrink a stroke below its minimum width,
    // so an envelope only just that wide and sitting on an end keeps the end.
    // That is the one case where the number above does nothing, and the
    // wearer should not have to infer it by reading the two numbers back.
    const stillOnEnd = margin > 0 && (sent.min === 0 || sent.max === 100);
    // Only a FULL-LENGTH stroke is described here: this is the envelope with
    // the margin applied, and a warm-up tick or any mode that narrows the zone
    // sends less than this. Saying "sent to the device" flatly would be false
    // for most of a session, and a wearer reading this row is usually reading
    // it because their device did something they did not expect.
    el.textContent = `A full-length stroke reaches the device as ${sent.min}% - ${sent.max}%`
        + (stillOnEnd ? ' - this Travel Envelope is too narrow for the margin to move the stroke off the end.' : '');
}

// Validate the typed end-stop margin (0-10; 0 sends the range untouched) and
// persist it. Same shape as the envelope inputs: while typing, a half-typed
// number is left alone; on commit the corrected value is written back.
function applyHandyEndMarginInput(commit = false) {
    const el = document.getElementById('handyEndMarginInput');
    if (!el) return;
    const margin = clampEndMargin(el.value === '' ? advancedSettings.handyEndMargin : el.value);
    advancedSettings.handyEndMargin = margin;
    if (commit && String(el.value) !== String(margin)) el.value = margin;
    persistSettings();
    updateHandySlideDisplay();
    updateEngine();
}

// Normalise the persisted envelope and push it into every modal input. Used
// on boot and after a settings import, so a hand-edited or imported file can
// never produce an inverted or zero-width envelope.
function syncHwEnvelopeInputs() {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    advancedSettings.handyHwMin = env.min;
    advancedSettings.handyHwMax = env.max;
    hwEnvelopeInputs('min').forEach((el) => { el.value = env.min; });
    hwEnvelopeInputs('max').forEach((el) => { el.value = env.max; });
    // The end-stop margin sits in the same panel and is restored the same
    // way, so an imported file can never leave the input showing one number
    // while the driver uses another.
    advancedSettings.handyEndMargin = clampEndMargin(advancedSettings.handyEndMargin);
    const marginInput = document.getElementById('handyEndMarginInput');
    if (marginInput) marginInput.value = advancedSettings.handyEndMargin;
    updateHwEnvelopeDisplay();
}

// Validate the typed envelope: clamp to 0-100, keep at least a 10% stroke by
// moving the bound the user did NOT just edit, then write the corrected values
// back into every input (both modals) and the persisted settings. `changed`
// is 'min' or 'max'; `source` is the input being edited (defaults to the
// first input of that bound).
function applyHwEnvelopeInput(changed, commit = false, source = null) {
    const edited = source || hwEnvelopeInputs(changed)[0] || null;
    const typed = edited && edited.value !== '' ? edited.value : null;
    const rawMin = changed === 'min' && typed !== null ? typed : advancedSettings.handyHwMin;
    const rawMax = changed === 'max' && typed !== null ? typed : advancedSettings.handyHwMax;
    const env = normalizeEnvelope(rawMin, rawMax, changed);
    advancedSettings.handyHwMin = env.min;
    advancedSettings.handyHwMax = env.max;
    // While typing, only rewrite the inputs the user is NOT focused on so a
    // half-typed number is not yanked away; on commit, rewrite all of them.
    hwEnvelopeInputs('min').forEach((el) => {
        if ((commit || el !== edited) && String(el.value) !== String(env.min)) el.value = env.min;
    });
    hwEnvelopeInputs('max').forEach((el) => {
        if ((commit || el !== edited) && String(el.value) !== String(env.max)) el.value = env.max;
    });
    persistSettings();
    updateHwEnvelopeDisplay();
    updateEngine();
}

// The Handy Role, Speed Cap & Physical Travel Envelope Controls
function initHandyRoleUI() {
    const pBtn = document.getElementById('handyRolePrimaryBtn');
    const sBtn = document.getElementById('handyRoleSecondaryBtn');
    const oBtn = document.getElementById('handyRoleOffBtn');
    const capSlider = document.getElementById('handyCapSlider');
    const capVal = document.getElementById('handyCapVal');

    if (capSlider && capVal) {
        capSlider.value = state.handyMaxCap ?? 100;
        capVal.textContent = `${state.handyMaxCap ?? 100}%`;
        capSlider.addEventListener('input', (e) => {
            state.handyMaxCap = parseInt(e.target.value, 10);
            capVal.textContent = `${state.handyMaxCap}%`;
            safeSet('handy_max_cap', String(state.handyMaxCap));
            updateEngine();
        });
    }

    // The value itself is painted by syncHwEnvelopeInputs (below, and again
    // after every settings import).
    const marginInput = document.getElementById('handyEndMarginInput');
    if (marginInput) {
        marginInput.addEventListener('input', () => applyHandyEndMarginInput(false));
        marginInput.addEventListener('change', () => applyHandyEndMarginInput(true));
    }

    // Envelope inputs live in the Handy AND the TCode modal, all bound to the
    // same persisted setting; editing either keeps the others in sync.
    syncHwEnvelopeInputs();
    ['min', 'max'].forEach((bound) => {
        hwEnvelopeInputs(bound).forEach((el) => {
            el.addEventListener('input', () => applyHwEnvelopeInput(bound, false, el));
            el.addEventListener('change', () => applyHwEnvelopeInput(bound, true, el));
        });
    });

    const applyRole = (role) => {
        state.handyRole = role;
        safeSet('handy_role', role);
        const badge = document.getElementById('modalHandyRoleBadge');

        if (pBtn) pBtn.className = role === 'primary' ? "py-1.5 rounded-lg bg-rose-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (sBtn) sBtn.className = role === 'secondary' ? "py-1.5 rounded-lg bg-purple-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (oBtn) oBtn.className = role === 'off' ? "py-1.5 rounded-lg bg-slate-700 text-amber-300 font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";

        if (badge) {
            if (role === 'primary') { badge.textContent = "Primary (Tease)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800"; }
            else if (role === 'secondary') { badge.textContent = "Secondary (Milker)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800"; }
            else { badge.textContent = "Disabled (OFF)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-amber-400 border border-slate-700"; }
        }
        updateEngine();
    };

    pBtn?.addEventListener('click', () => applyRole('primary'));
    sBtn?.addEventListener('click', () => applyRole('secondary'));
    oBtn?.addEventListener('click', () => applyRole('off'));
    applyRole(state.handyRole || 'primary');
}

// The working ceiling: typed Climax HR minus learned / dual-stim / decay
// offsets (never raised by any of them), plus two explicit raises: Force
// Orgasm, and Survival's per-edge overdrive. Decay is off while Survival is
// on so it cannot fight that climb. One place only, so the engine, the
// cockpit badges and the Session Setup preview can never quote different
// BPM at the wearer.
// A stroker (primary) and an internal toy (secondary). The Handy counts for
// whichever role it holds; Intiface and TCode axes count for the role they
// are assigned.
function stimulationRoles() {
    const intifaceHasRole = (role) => Array.from(intifaceDevices.values()).some(d => d.axes.some(a => a.role === role));
    const serialHasRole = (role) => isTCodeConnected() && tcodeHasRole(role);
    const hasPrimary = (handyConnected && state.handyRole === 'primary') || intifaceHasRole('primary') || serialHasRole('primary');
    const hasSecondary = (handyConnected && state.handyRole === 'secondary') || intifaceHasRole('secondary') || serialHasRole('secondary');
    return { hasPrimary, hasSecondary, dual: hasPrimary && hasSecondary };
}

function isUncappedClimb(mode = state.activeMode) {
    return mode === 'survival' || mode === 'calibrate';
}

function workingCeiling(minHr, typedMaxHr) {
    const { dual } = stimulationRoles();
    return computeEffectiveCeiling({
        minHr,
        maxHr: typedMaxHr,
        dualMaxHr: readHrLimits().dualMaxHr,
        learnedOffset: advancedSettings.learningProfile?.suggestedMaxHrOffset || 0,
        dualStimActive: dual,
        // Decay lowers the ceiling as edges pile up. The uncapped climbs
        // push past the typed max, so that drop does not run during them.
        adaptiveDecay: isUncappedClimb() ? false : Boolean(advancedSettings.adaptiveDecay),
        edges: state.edges,
        decayEdgeCount: advancedSettings.decayEdgeCount,
        decayBpm: advancedSettings.decayBpm,
        decayFloor: advancedSettings.decayFloor,
        orgasmBoost: state.orgasmMode ? state.orgasmBoost : 0,
        survivalOverdrive: isUncappedClimb() ? state.survivalOverdrive : 0
    });
}

// Engine Calculation Loop
function updateEngine() {
    if (isRemotePage) return;

    const limits = readHrLimits();
    const min = limits.minHr;
    const typedMax = limits.maxHr;
    let hr = state.hrCurrent;
    if (!Number.isFinite(hr) || hr < 35) hr = min;

    const ceiling = workingCeiling(min, typedMax);
    const max = ceiling.maxHr;
    // Two heart rates from here on. `sensorHr` is what the monitor measured:
    // every guard, game, counter, the cockpit readout and the session record
    // judge THAT number. `hr` may additionally carry the microphone boost,
    // which drives the engine's falling tease curve only - never a term that
    // RISES with arousal (the two climb games' ramps, the milking modes'
    // secondary), every one of which reads the sensor alone.
    const sensorHr = hr;
    // The boost is frozen with the pulse. Inside the watchdog's hold window
    // the engine keeps the boost measured on the last fresh reading, so an
    // ordinary inter-packet gap (a watch relaying every ~5 s trips the 5 s
    // band on jitter alone) can neither grow it on room noise nor drop it
    // out - and a drop-out speeds the motors UP in every tease mode.
    const pulseFresh = pulseIsLive();
    if (pulseFresh) state.micBoostHeld = Number.isFinite(state.micBoost) ? state.micBoost : 0;
    hr = micBoostedHr({
        sensorHr,
        micBoost: state.micBoost,
        heldBoost: state.micBoostHeld,
        ceiling: max,
        micEnabled: Boolean(advancedSettings.micEnabled),
        pulseFresh
    });
    // What the boost actually added this tick. It is 0 whenever the boost is
    // suppressed (no live reading, or the pulse is already at the ceiling),
    // and the badge shows THAT, so it can never claim a push the engine is
    // not making: the big BPM number no longer moves with the boost, which
    // leaves the badge as the only signal the wearer has.
    // ...and only in a mode that feeds the boosted pulse to a motor at all:
    // the Oracle and Edge Training compute both channels from the MEASURED
    // pulse, so the boost reaches nothing there and a MIC +N badge sent the
    // wearer off to adjust a gate and a cap that change nothing.
    const micReaches = micBoostReachesMotors(state.activeMode, { edgeStrokeDepth: advancedSettings.edgeStrokeDepth });
    const micRaw = Number.isFinite(hr) && Number.isFinite(sensorHr) ? hr - sensorHr : 0;
    const micApplied = micReaches && micRaw > 0 ? micRaw : 0;
    state.micApplied = micApplied;
    const micBadge = document.getElementById('micActiveBadge');
    const micBadgeLive = Boolean(state.micAnalyser) && (Boolean(advancedSettings.micEnabled) || state.isTestingMic);
    if (micBadge && micBadgeLive) {
        if (micApplied > 0) {
            micBadge.textContent = `MIC +${micApplied}`;
            micBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-700 text-rose-300 ml-1';
        } else {
            micBadge.textContent = 'MIC LISTEN';
            micBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-700 text-emerald-300 ml-1';
        }
        micBadge.classList.remove('hidden');
    } else if (micBadge) {
        micBadge.classList.add('hidden');
    }
    state.effectiveMinHr = min;
    state.effectiveMaxHr = max;
    state.effectiveHr = hr;
    state.sensorHr = sensorHr;

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = sensorHr;
    if (!Number.isFinite(state.peakHr) || sensorHr > state.peakHr) state.peakHr = sensorHr;

    const learnBadge = document.getElementById('learnBadge');
    const learnAmount = document.getElementById('learnAmountText');
    if (learnAmount) learnAmount.textContent = ceiling.learnedOffset;
    learnBadge?.classList.toggle('hidden', !(ceiling.learnedOffset > 0));

    const dualBadge = document.getElementById('dualStimBadge');
    if (dualBadge) {
        dualBadge.textContent = `DUAL MAX ${ceiling.dualMaxHr}`;
        dualBadge.classList.toggle('hidden', !ceiling.usingDual);
    }

    const decayBadge = document.getElementById('decayBadge');
    const decayText = document.getElementById('decayAmountText');
    if (decayText) decayText.textContent = ceiling.appliedDecay;
    decayBadge?.classList.toggle('hidden', !(ceiling.totalDecay > 0));

    // Shown whenever the working ceiling differs from the typed Climax HR.
    const ceilingBadge = document.getElementById('effectiveCeilingBadge');
    const ceilingLabel = document.getElementById('effectiveCeilingLabel');
    const ceilingText = document.getElementById('effectiveCeilingText');
    if (ceilingLabel) {
        const raised = (state.orgasmMode && ceiling.orgasmBoost > 0)
            || (isUncappedClimb() && (state.survivalOverdrive || 0) > 0);
        ceilingLabel.textContent = raised ? 'OVERDRIVE CEILING' : 'CEILING';
    }
    if (ceilingText) ceilingText.textContent = max;
    ceilingBadge?.classList.toggle('hidden', max === typedMax);

    const holdPct = clampEdgeHoldPercent(advancedSettings.edgeHoldPercent);
    const triggerHr = resolveEdgeTriggerHr(max, holdPct, min);
    const holdBadge = document.getElementById('edgeHoldBadge');
    const holdText = document.getElementById('edgeHoldText');
    if (holdText) holdText.textContent = `${triggerHr}`;
    holdBadge?.classList.toggle('hidden', holdPct === 100 || triggerHr === max);
    state.edgeTriggerHr = triggerHr;

    const result = calculateEngineOutputs({
        hr,
        edgeHr: sensorHr,
        minHr: min,
        maxHr: max,
        activeMode: resolveEngineMode(state.activeMode),
        sessionStatus: state.sessionStatus,
        rampdownSecondsLeft: state.rampdownSecondsLeft,
        isEdged: state.isEdged,
        orgasmMode: state.orgasmMode,
        orgasmBoost: state.orgasmMode ? state.orgasmBoost : 0,
        gamma: advancedSettings.gammaCurve,
        intensityValue: state.intensityValue,
        edgeStrokeDepth: advancedSettings.edgeStrokeDepth,
        strokeMode: state.teaseMode,
        handyHwMin: advancedSettings.handyHwMin,
        handyHwMax: advancedSettings.handyHwMax,
        sessionSeconds: state.sessionSeconds,
        warmupMinutes: advancedSettings.warmupMinutes,
        cadenceBreathing: advancedSettings.cadenceBreathing,
        milkingWave: advancedSettings.milkingWave,
        stallGuardEngaged: state.stallGuardEngaged,
        ceilingBehaviour: advancedSettings.ceilingBehaviour,
        edgeHoldPercent: advancedSettings.edgeHoldPercent,
        ruinHoldSeconds: state.ruinHoldSeconds,
        oracleState: state.oracleState,
        survivalSpeedFloor: state.survivalSpeedFloor,
        trainingState: state.trainState
    });

    if (result.newEdgeTriggered) {
        state.edges += 1;
        const edgeEl = document.getElementById('edgeCount');
        if (edgeEl) edgeEl.textContent = state.edges;
        reverseIntifaceRotation('edge');
        cueVoice('edge');
    }

    state.isEdged = result.isEdged;
    state.strokerSpeed = result.primaryPercent;
    state.prostateSpeed = result.secondaryPercent;
    state.strokeMin = result.strokeMinPercent;
    state.strokeMax = result.strokeMaxPercent;

    const strokerVal = document.getElementById('strokerVal');
    const strokerBar = document.getElementById('strokerBar');
    const prostateVal = document.getElementById('prostateVal');
    const prostateBar = document.getElementById('prostateBar');
    const strokeBadge = document.getElementById('strokeRangeBadge');

    if (strokerVal) strokerVal.textContent = `${result.primaryPercent}%`;
    if (strokerBar) strokerBar.style.width = `${result.primaryPercent}%`;
    if (prostateVal) prostateVal.textContent = `${result.secondaryPercent}%`;
    if (prostateBar) prostateBar.style.width = `${result.secondaryPercent}%`;
    if (strokeBadge) strokeBadge.textContent = `Zone: ${result.strokeMinPercent}-${result.strokeMaxPercent}%`;

    // The banner names what each channel was really sent this tick, and is
    // silent unless the session is running: the edge flag survives a pause on
    // purpose, so it used to keep claiming an active secondary through a
    // watchdog pause with every motor stopped.
    const cutoffEl = document.getElementById('cutoffNotice');
    if (cutoffEl) {
        const cutoffText = describeCutoffNotice({
            sessionStatus: state.sessionStatus,
            isEdged: state.isEdged,
            orgasmMode: state.orgasmMode,
            stallGuardEngaged: state.stallGuardEngaged,
            primaryPercent: result.primaryPercent,
            secondaryPercent: result.secondaryPercent
        });
        cutoffEl.textContent = cutoffText;
        cutoffEl.classList.toggle('hidden', !cutoffText);
    }

    const stallNotice = document.getElementById('stallGuardNotice');
    if (stallNotice) {
        if (state.stallGuardEngaged) {
            stallNotice.textContent = describeStallPauseNotice({
                mode: state.activeMode,
                ceilingBehaviour: advancedSettings.ceilingBehaviour
            });
        } else if (stallNotice.textContent !== '') {
            // Emptied as well as hidden: a banner that is not engaged has
            // nothing true to say, and a sentence left behind display:none
            // is one paint away from being shown for the wrong mode.
            stallNotice.textContent = '';
        }
        stallNotice.classList.toggle('hidden', !state.stallGuardEngaged);
    }

    updateWarmupBadge();
    updateGameNotice();

    dispatchHardware(result.primaryPercent, result.secondaryPercent, result.strokeMinPercent, result.strokeMaxPercent);
}

// Physical stroke bounds to send to the toys. engine.js has ALREADY mapped
// strokeMin/strokeMax into the hardware envelope, so they are passed through.
function effectiveStrokeRange(strokeMin, strokeMax) {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    return { min: strokeMin, max: strokeMax, env };
}

function dispatchHardware(primarySpeed, secondarySpeed, strokeMin, strokeMax, force = false) {
    if (isRemotePage) return;

    let targetHandySpeed = 0;
    const handyCap = (state.handyMaxCap ?? 100) / 100;
    if (state.handyRole === 'primary') {
        targetHandySpeed = Math.round(primarySpeed * handyCap);
    } else if (state.handyRole === 'secondary') {
        targetHandySpeed = Math.round(secondarySpeed * handyCap);
    } else {
        targetHandySpeed = 0;
    }

    const range = effectiveStrokeRange(strokeMin, strokeMax);

    // The end-stop margin is The Handy's alone: it is a property of that
    // carriage and its firmware, not of the session, so it is applied in the
    // driver and the funscript export still records what the engine asked
    // for. A T-Code or Intiface linear axis takes a wider zone as a longer,
    // slower stroke rather than a faster one, so they keep the envelope as is.
    dispatchHandy(targetHandySpeed, range.min, range.max, force, range.env.min, range.env.max, advancedSettings.handyEndMargin);
    // Intiface linear axes run on their own per-leg timers; this call only
    // updates the planner inputs (and, with force, issues StopAllDevices).
    dispatchIntiface(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force);
    // Same for the direct T-Code serial device: a forced zero dispatch is an
    // immediate stop (every axis to rest on one line).
    dispatchTCode(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force);
}

// Queue a spoken cue (voice.js keeps a short queue, so back-to-back cues are
// all heard instead of cutting each other off). An `urgent` cue (signal
// lost, stop) jumps the queue and silences whatever was waiting.
function sessionVoiceVars() {
    return {
        hr: Math.round(Number.isFinite(state.sensorHr) ? state.sensorHr : (state.hrCurrent || 0)),
        maxHr: Math.round(Number.isFinite(state.effectiveMaxHr) ? state.effectiveMaxHr : 0),
        minHr: Math.round(Number.isFinite(state.effectiveMinHr) ? state.effectiveMinHr : 0),
        edges: state.edges || 0,
        minutes: Math.floor(Math.max(0, state.sessionSeconds || 0) / 60),
        done: state.trainEdgesDone || 0,
        need: clampTrainEdges(advancedSettings.trainEdges),
        hold: Math.max(0, clampTrainHoldSeconds(advancedSettings.trainHoldSeconds) - (state.trainHoldSeconds || 0))
    };
}

// The resting line for the dashboard. An emptied Resting prompt bank is a
// mute the wearer chose (the editor labels it so), and substituting the
// factory sentence put the exact line they had just deleted back on the
// cockpit at every idle moment. Empty means empty; paintIdlePrompt() then
// leaves the box hidden rather than inventing one.
function dashboardIdlePrompt() {
    const { text } = resolveVoiceCue(advancedSettings.voiceCues, 'idle', sessionVoiceVars());
    return text;
}

function paintIdlePrompt() {
    const text = state.lastSpokenPrompt || dashboardIdlePrompt();
    setMindgamePrompt(text, Boolean(advancedSettings.voiceEnabled && text));
}

// Queue a spoken cue. Voice guidance ON both paints the dashboard line and
// speaks it. An `urgent` cue (signal lost, stop) jumps the TTS queue.
function cueVoice(key, urgent = false) {
    const lastTemplate = state.lastCueTemplateById?.[key] || '';
    const { text, template } = resolveVoiceCue(
        advancedSettings.voiceCues,
        key,
        sessionVoiceVars(),
        { lastTemplate }
    );
    // "Muted" and "voice guidance off" are different states. An emptied
    // phrase bank resolves to '' with voice still ON: that cue simply says
    // nothing this tick, so the dashboard must keep whatever the last unmuted
    // cue wrote. Hiding the box there wiped a live edge warning one second
    // after it appeared, every encouragement interval, all session.
    if (!text) {
        if (!advancedSettings.voiceEnabled) setMindgamePrompt('', false);
        return;
    }
    if (!advancedSettings.voiceEnabled) {
        setMindgamePrompt(text, false);
        return;
    }
    const now = Date.now();
    if (!urgent && text === state.lastSpokenPrompt && (now - (state.lastSpokenAt || 0) < 7000)) return;
    state.lastSpokenPrompt = text;
    state.lastSpokenAt = now;
    if (template) {
        if (!state.lastCueTemplateById) state.lastCueTemplateById = {};
        state.lastCueTemplateById[key] = template;
    }
    setMindgamePrompt(text, true);
    if (urgent) speakNow(text, advancedSettings.voiceURI);
    else speakPrompt(true, text, advancedSettings.voiceURI);
}

function updateWarmupBadge() {
    const badge = document.getElementById('warmupBadge');
    const remainingEl = document.getElementById('warmupRemainingText');
    const warmupSeconds = Math.max(0, advancedSettings.warmupMinutes || 0) * 60;
    const active = state.sessionStatus === 'RUNNING' && warmupSeconds > 0 && state.sessionSeconds < warmupSeconds;
    if (badge) badge.classList.toggle('hidden', !active);
    if (active && remainingEl) {
        const left = warmupSeconds - state.sessionSeconds;
        remainingEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }
}

function updateGameNotice() {
    const notice = document.getElementById('gameNotice');
    if (!notice) return;
    const text = describeGameNotice({
        activeMode: state.activeMode,
        sessionStatus: state.sessionStatus,
        oracleState: state.oracleState,
        oracleTimer: state.oracleTimer,
        trainState: state.trainState,
        trainHoldSeconds: state.trainHoldSeconds,
        trainEdgesDone: state.trainEdgesDone,
        trainHoldGoal: advancedSettings.trainHoldSeconds,
        trainEdgesGoal: advancedSettings.trainEdges,
        survivalSpeedFloor: state.survivalSpeedFloor,
        survivalOverdrive: state.survivalOverdrive,
        calibrationPass: state.calibrationPass,
        sessionSeconds: state.sessionSeconds,
        minSeconds: state.durationMinSeconds,
        maxSeconds: state.durationMaxSeconds,
        targetSeconds: state.chosenTargetSeconds,
        fixedLength: state.durationFixed
    });
    notice.textContent = text || 'GAME MODE ACTIVE';
    notice.classList.toggle('hidden', !text);
    renderCameEarlyButton();
    renderCalibration();
}

// Came Early is an accidental release in the tease modes. Survival and
// Calibration are climbs that are supposed to finish you, so that same
// button changes its words while either is selected.
function renderCameEarlyButton() {
    const kicker = document.getElementById('cameEarlyKicker');
    const label = document.getElementById('cameEarlyLabel');
    if (!cameEarlyBtn || !kicker || !label) return;
    const finishing = !isRemotePage && (state.activeMode === 'survival' || state.activeMode === 'calibrate');
    const calibrating = state.activeMode === 'calibrate';
    kicker.textContent = finishing ? 'The app' : 'Accidental';
    label.textContent = finishing ? 'Finished me' : 'Came Early';
    cameEarlyBtn.title = calibrating
        ? (state.calibrationPass === 'dual'
            ? 'Both toys finished you. This sets the dual-stim offset from the gap under your primary climax.'
            : 'The primary toy finished you. This heart rate becomes your Climax HR.')
        : finishing
            ? 'Survival finished you. This ends the run. Your Climax HR stays as typed.'
            : 'Log accidental release so local learning engine tightens limits next time.';
    kicker.classList.toggle('text-rose-300', finishing);
    kicker.classList.toggle('text-amber-400', !finishing);
    cameEarlyBtn.classList.toggle('bg-rose-950/60', finishing);
    cameEarlyBtn.classList.toggle('hover:bg-rose-900', finishing);
    cameEarlyBtn.classList.toggle('border-rose-800', finishing);
    cameEarlyBtn.classList.toggle('text-rose-300', finishing);
    cameEarlyBtn.classList.toggle('bg-amber-950/60', !finishing);
    cameEarlyBtn.classList.toggle('hover:bg-amber-900', !finishing);
    cameEarlyBtn.classList.toggle('border-amber-800', !finishing);
    cameEarlyBtn.classList.toggle('text-amber-300', !finishing);
}

function calibrationHintText() {
    const saved = calibrationReading(advancedSettings.calibrationPrimaryHr);
    const live = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED';
    if (state.activeMode === 'calibrate' && state.calibrationPass === 'dual') {
        return saved
            ? `Both toys on. Finished me saves that heart rate as the dual-stim max. Single-stim max stays ${saved}.`
            : 'Both toys on. Finished me saves that heart rate as the dual-stim max.';
    }
    if (state.activeMode === 'calibrate' && state.calibrationPass === 'primary') {
        return saved && !live
            ? `Redo of the single-stim run. Leave the second toy off. Finished me replaces ${saved}.`
            : 'One toy only. Leave the second toy off. Finished me saves that heart rate as your single-stim max.';
    }
    if (saved) {
        return `Single-stim max is ${saved}. Tap Calibrate for the both-toys run, or to redo the single-stim run.`;
    }
    return 'One toy first — The Handy, or your stroker. A later run with both toys saves a separate dual-stim max. Resting heart rate is assumed at 70.';
}

function renderCalibration() {
    const btn = document.getElementById('calibrateBtn');
    const hint = document.getElementById('calibrationHint');
    if (hint) hint.textContent = calibrationHintText();
    if (!btn) return;
    const on = state.activeMode === 'calibrate';
    btn.className = on
        ? 'px-2.5 py-1 rounded-lg border text-[10px] font-bold cursor-pointer bg-purple-950/40 border-purple-600 text-purple-200'
        : 'px-2.5 py-1 rounded-lg border text-[10px] font-bold cursor-pointer bg-rose-950/60 hover:bg-rose-900 border-rose-800 text-rose-200';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// Validate the Session Setup duration fields and flag any bad one in red.
// Returns the parsed result; an invalid field means targetSeconds 0 (endless).
function validateDurationInputs() {
    const fixedInput = document.getElementById('paramFixedInput');
    const minInput = document.getElementById('paramMinInput');
    const maxInput = document.getElementById('paramMaxInput');
    const parsed = parseSessionDuration({
        mode: state.durationMode,
        fixedMinutes: fixedInput?.value,
        minMinutes: minInput?.value,
        maxMinutes: maxInput?.value
    });
    markInputValidity(fixedInput, !parsed.invalid.includes('fixed'));
    markInputValidity(minInput, !parsed.invalid.includes('min'));
    markInputValidity(maxInput, !parsed.invalid.includes('max'));
    return parsed;
}

function pickSessionTargetSeconds() {
    const parsed = validateDurationInputs();
    state.durationFallback = !parsed.valid;
    state.durationMinSeconds = parsed.minSeconds || 0;
    state.durationMaxSeconds = parsed.maxSeconds || 0;
    // Snapshotted at START: a Fixed length and a Mystery window typed with
    // the same number in both boxes hand out identical seconds, and only a
    // Fixed one opens the Oracle's window halfway. state.durationMode is
    // live and would change under a running session if the wearer tapped
    // another duration card.
    state.durationFixed = Boolean(parsed.fixedLength);
    return parsed.targetSeconds;
}

// Zero every per-session counter and its display. Called when a session
// stops, on Reset, and again on START so a new run can never inherit time,
// edges or motion samples from the previous one.
function resetSessionCounters() {
    state.sessionSeconds = 0;
    state.chosenTargetSeconds = 0;
    state.durationMinSeconds = 0;
    state.durationMaxSeconds = 0;
    state.durationFixed = false;
    state.edges = 0;
    state.pauses = 0;
    state.peakHr = Number.isFinite(state.hrCurrent) ? state.hrCurrent : 70;
    state.isEdged = false;
    state.orgasmBoost = 0;
    clearMicBoost(state);
    state.rampdownSecondsLeft = 45;
    state.resumeStatus = null;
    state.durationFallback = false;
    state.endgameFired = false;
    state.endgameHeldByOrgasm = false;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    funscriptSamples = [];
    funscriptSessionStart = 0;
    const edgeEl = document.getElementById('edgeCount');
    const pauseEl = document.getElementById('pauseCount');
    const sVal = document.getElementById('strokerVal');
    const sBar = document.getElementById('strokerBar');
    const pVal = document.getElementById('prostateVal');
    const pBar = document.getElementById('prostateBar');
    if (edgeEl) edgeEl.textContent = "0";
    if (pauseEl) pauseEl.textContent = "0";
    if (sVal) sVal.textContent = "0%";
    if (sBar) sBar.style.width = "0%";
    if (pVal) pVal.textContent = "0%";
    if (pBar) pBar.style.width = "0%";
    document.getElementById('cutoffNotice')?.classList.add('hidden');
    updateTimerDisplay();
}

function resetGameState() {
    state.oracleState = 'IDLE';
    state.oracleTimer = 0;
    state.survivalSpeedFloor = 18;
    state.survivalTimer = 0;
    state.survivalEdges = 0;
    state.survivalOverdrive = 0;
    // Edges already counted before Survival was switched on do not step it.
    state.survivalEdgesSeen = state.edges || 0;
    state.survivalBreachTicks = 0;
    state.survivalLastReadingAt = null;
    state.trainState = 'climb';
    state.calibrationPass = null;
    state.trainHoldSeconds = 0;
    state.trainEdgesDone = 0;
    state.edgeStallSeconds = 0;
    state.stallPauseElapsed = 0;
    state.stallGuardEngaged = false;
    state.ruinHoldSeconds = 0;
    state.ruinRideSeconds = 0;
    state.lastSpokenPrompt = '';
    document.getElementById('stallGuardNotice')?.classList.add('hidden');
    document.getElementById('gameNotice')?.classList.add('hidden');
}

function tickSessionGuardsAndGames() {
    if (state.sessionStatus !== 'RUNNING') return;

    // Ruin keeps stroking through the edge. The dead stop starts only after
    // the pulse has stayed on the mark long enough to be past a casual touch,
    // then holds for RUIN_LOCK_SECONDS. A game does not use this ending; it
    // only borrows Ruin's stroke when that is the selected mode.
    if (state.activeMode === 'ruin') {
        if (state.ruinHoldSeconds > 0) state.ruinHoldSeconds -= 1;
        else if (state.isEdged) {
            state.ruinRideSeconds += 1;
            if (state.ruinRideSeconds >= RUIN_RIDE_SECONDS) {
                state.ruinHoldSeconds = RUIN_LOCK_SECONDS;
                state.ruinRideSeconds = 0;
            }
        } else {
            state.ruinRideSeconds = 0;
        }
    } else if (state.ruinHoldSeconds > 0 || state.ruinRideSeconds > 0) {
        state.ruinHoldSeconds = 0;
        state.ruinRideSeconds = 0;
    }

    // Guards and games judge against the SAME ceiling the engine used on its
    // last tick (after dual-stim / decay / learned offsets), never the raw
    // typed Climax HR, and against the pulse the SENSOR reported: the
    // microphone boost moves the engine's speed, never a guard or a game.
    const ceiling = Number.isFinite(state.effectiveMaxHr) ? state.effectiveMaxHr : readHrLimits().maxHr;
    const hr = Number.isFinite(state.sensorHr) ? state.sensorHr : state.hrCurrent;
    const nearCeiling = hr >= (ceiling - 2);

    // The stall guard only has something to cut in Crawl mode: with Full
    // Stop the primary is already parked at 0% at the ceiling. Whenever its
    // preconditions are not met (guard off, Full Stop, orgasm, a game mode)
    // an engaged guard is released at once, even with the pulse still parked
    // at the ceiling.
    const crawlAtCeiling = advancedSettings.ceilingBehaviour !== 'stop';
    const guardArmed = Boolean(advancedSettings.stallGuard) && crawlAtCeiling && !state.orgasmMode
        && state.activeMode !== 'oracle' && !isUncappedClimb() && state.activeMode !== 'edgetrain';
    const guard = tickStallGuard(
        { holdSeconds: state.edgeStallSeconds, pauseSeconds: state.stallPauseElapsed, engaged: state.stallGuardEngaged },
        {
            armed: guardArmed,
            isEdged: state.isEdged,
            holdTimeoutSeconds: advancedSettings.stallGuardSeconds,
            pauseTimeoutSeconds: advancedSettings.stallPauseSeconds
        }
    );
    state.edgeStallSeconds = guard.holdSeconds;
    state.stallPauseElapsed = guard.pauseSeconds;
    state.stallGuardEngaged = guard.engaged;
    if (guard.justEngaged) cueVoice('stallHalt');
    if (guard.justResumed) cueVoice('stallResume');
    if (guard.justReleased) cueVoice('stallRecover');

    const warmupSeconds = Math.max(0, advancedSettings.warmupMinutes || 0) * 60;
    if (warmupSeconds > 0 && state.sessionSeconds === warmupSeconds) {
        cueVoice('warmupDone');
    }

    const encourageEvery = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
    if (
        advancedSettings.voiceEnabled
        && encourageEvery > 0
        && state.sessionStatus === 'RUNNING'
        && !state.orgasmMode
        && state.sessionSeconds > 0
        && state.sessionSeconds % encourageEvery === 0
    ) {
        cueVoice('encourage');
    }

    // The gate and the cap come from the APPLIED settings. Dragging a
    // Session Setup slider previews on the meter; only Apply commits it,
    // so dismissing the modal can never change the running session.
    if (advancedSettings.micEnabled && state.micAnalyser) {
        const level = sampleMicLevel(state);
        state.micBoost = micBoostFromLevel(
            level,
            clampMicGate(advancedSettings.micSensitivityThreshold),
            clampMicBoostBpm(advancedSettings.micBoostMaxBpm)
        );
        paintMicMeter(level);
    } else if (!state.isTestingMic) {
        clearMicBoost(state);
        document.getElementById('micActiveBadge')?.classList.add('hidden');
    }

    if (state.activeMode === 'oracle') {
        if (state.oracleState === 'IDLE' || state.oracleState === 'APPROACH') {
            if (state.oracleState !== 'APPROACH') {
                state.oracleState = 'APPROACH';
                cueVoice('oracleWatching');
            }
            if (state.isEdged) {
                state.oracleState = 'HOLD';
                state.oracleTimer = 15;
                cueVoice('oracleHold');
            }
        } else if (state.oracleState === 'HOLD') {
            state.oracleTimer = Math.max(0, state.oracleTimer - 1);
            if (state.oracleTimer <= 0) {
                const timing = oracleTiming({
                    sessionSeconds: state.sessionSeconds,
                    minSeconds: state.durationMinSeconds,
                    maxSeconds: state.durationMaxSeconds,
                    targetSeconds: state.chosenTargetSeconds,
                    fixedLength: state.durationFixed
                });
                const fate = rollOracleFate(timing, { endgameType: state.endgameType });
                if (fate === 'CLIMAX') {
                    state.oracleState = 'CLIMAX';
                    // Arm Force Orgasm without its own bank so Oracle climax
                    // is the one phrase the wearer hears.
                    if (!state.orgasmMode) setOrgasmMode(true);
                    cueVoice('oracleClimax');
                } else if (fate === 'DENIAL') {
                    state.oracleState = 'DENIAL';
                    stopSession('Oracle Denial', 'The Oracle chooses denial.');
                    return;
                } else if (fate === 'RAMPDOWN') {
                    // Soft Landing is the ending the wearer picked, so the
                    // Oracle hands the session to that tease-down instead of
                    // arming Force Orgasm on a coin flip.
                    state.oracleState = 'RAMPDOWN';
                    state.endgameFired = true;
                    cueVoice('oracleSoftLanding');
                    handleTargetTimeReached();
                    return;
                } else {
                    state.oracleState = 'PURGATORY';
                    state.oracleTimer = 0;
                    cueVoice(timing.canEnd ? 'oraclePurgatory' : 'oracleNotYet');
                }
            }
        } else if (state.oracleState === 'CLIMAX') {
            // app.js switched Force Orgasm on with the roll; if the wearer
            // taps it off again the climax is withdrawn and the ceiling
            // rules apply as in APPROACH (the engine cuts CLIMAX at the
            // ceiling too, this keeps the game state honest).
            if (!state.orgasmMode) {
                state.oracleState = 'APPROACH';
                cueVoice('oracleWithdrawn');
            }
        } else if (state.oracleState === 'PURGATORY') {
            // Purgatory lasts 28 s, but the edge flag is only cleared once the
            // pulse has genuinely dropped below the release band; resetting it
            // while HR still sits at the ceiling would count a phantom edge.
            state.oracleTimer += 1;
            if (state.oracleTimer >= 28 && gameEdgeReleased(hr, ceiling, state.edgeTriggerHr, { orgasmMode: state.orgasmMode })) {
                state.oracleState = 'APPROACH';
                state.oracleTimer = 0;
                state.isEdged = false;
                cueVoice('oracleReset');
            }
        }
    } else if (isUncappedClimb()) {
        // Edges counted before this game was switched on are ignored. Each
        // new one raises the mark 1 BPM and the speed a step. The clock is
        // slow on purpose: half an hour of it is still a build, not a finish.
        const seen = state.survivalEdgesSeen || 0;
        const gained = Math.max(0, (state.edges || 0) - seen);
        state.survivalEdges = (state.survivalEdges || 0) + gained;
        state.survivalEdgesSeen = state.edges || 0;
        state.survivalTimer += 1;
        const drive = survivalDrive({ seconds: state.survivalTimer, edges: state.survivalEdges });
        state.survivalSpeedFloor = drive.floor;
        state.survivalOverdrive = drive.overdriveBpm;
    } else if (state.activeMode === 'edgetrain') {
        const next = tickEdgeTraining(
            { state: state.trainState, holdSeconds: state.trainHoldSeconds, edgesDone: state.trainEdgesDone },
            {
                isEdged: state.isEdged,
                released: gameEdgeReleased(hr, ceiling, state.edgeTriggerHr, { orgasmMode: state.orgasmMode }),
                holdGoal: advancedSettings.trainHoldSeconds,
                edgesGoal: advancedSettings.trainEdges,
                orgasmMode: state.orgasmMode
            }
        );
        state.trainState = next.state;
        state.trainHoldSeconds = next.holdSeconds;
        state.trainEdgesDone = next.edgesDone;
        if (next.justHold) cueVoice('trainHold');
        if (next.justCounted && !next.justFinished) cueVoice('trainHeld');
        if (next.justDropped) cueVoice('trainDrop');
        if (next.justFinished) {
            if (!state.orgasmMode) setOrgasmMode(true);
            cueVoice('trainFinish');
        }
    }
}

// 250ms Live Funscript Sampling Loop (4Hz). Records what was really sent to
// the toys (speed plus the physical stroke zone); the buffer is capped at
// four hours, oldest dropped first.
setInterval(() => {
    if (isRemotePage) return;
    const active = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
    // A pause is part of the timeline too: the motors are stopped, so record
    // explicit zero-speed samples rather than leaving a hole the export
    // would have to guess about.
    const paused = state.sessionStatus === 'PAUSED' && funscriptSessionStart > 0;
    if (active || paused) {
        const now = Date.now();
        if (funscriptSessionStart === 0) funscriptSessionStart = now;
        const range = effectiveStrokeRange(state.strokeMin, state.strokeMax);
        pushSample(funscriptSamples, {
            at: now - funscriptSessionStart,
            speed: paused ? 0 : state.strokerSpeed,
            secondary: paused ? 0 : state.prostateSpeed,
            strokeMin: range.min,
            strokeMax: range.max
        });
    }
}, 250);

// Record one heart-rate notification from the sensor or the simulator.
// Every packet refreshes the watchdog's packet clock; only a usable BPM
// (35-250) updates the displayed pulse, the history and the engine, so a
// 0 BPM "no contact" packet holds the last value instead of dropping to 0.
function recordHrReading(bpm, sensorContact = null, now = Date.now()) {
    const valid = hrWatchdog.recordPacket(now, bpm, sensorContact);
    state.hrNoContact = !valid || sensorContact === false;
    document.getElementById('hrContactHint')?.classList.toggle('hidden', !state.hrNoContact);
    if (!valid) return false;
    state.hrCurrent = bpm;
    state.lastHrTimestamp = now;
    state.history.push(bpm);
    if (state.history.length > 60) state.history.shift();
    if (state.hrSignalPaused) handleHrSignalReturned();
    updateEngine();
    syncTelemetry();
    return true;
}

// Human message for the disconnect banner: which device, for how long, why.
function describeHrLoss(verdict) {
    const name = state.hrDeviceName || 'Heart-rate monitor';
    const secs = Math.max(1, Math.round((verdict.sinceValidMs || 0) / 1000));
    const why = verdict.sourceLost
        ? 'no heart-rate sensor is linked'
        : verdict.noContact
            ? 'the sensor is transmitting but reports no pulse; check skin contact'
            : 'no packets received';
    return `${name}: no valid heart-rate reading for ${secs} s (${why}). Motors paused for safety.`;
}

// Overlay on the chart, the "holding" hint and the "no skin contact" hint.
// `verdict` null hides everything.
function renderHrSignal(verdict) {
    const overlay = document.getElementById('staleAlert');
    const overlayText = document.getElementById('staleAlertText');
    const holdHint = document.getElementById('hrHoldHint');
    const contactHint = document.getElementById('hrContactHint');
    const status = verdict ? verdict.status : 'ok';
    const secs = verdict ? Math.round((verdict.sinceValidMs || 0) / 1000) : 0;
    overlay?.classList.toggle('hidden', status !== 'stale');
    if (overlayText && status === 'stale') {
        overlayText.textContent = `WATCHDOG: NO HEART-RATE READING FOR ${secs} S, MOTORS HALTED`;
    }
    holdHint?.classList.toggle('hidden', status !== 'holding');
    if (holdHint && status === 'holding') holdHint.textContent = `HOLDING LAST READING (${secs} s)`;
    contactHint?.classList.toggle('hidden', !(verdict && verdict.noContact));
}

let hrSignalBadgeTimer = null;
// Small badge next to the BPM. `ms` 0 keeps it until the next transport
// change; otherwise it hides itself.
function showHrSignalBadge(text, ms) {
    const badge = document.getElementById('hrSignalBadge');
    if (!badge) return;
    if (hrSignalBadgeTimer) clearTimeout(hrSignalBadgeTimer);
    hrSignalBadgeTimer = null;
    badge.textContent = text;
    badge.classList.remove('hidden');
    if (ms > 0) hrSignalBadgeTimer = setTimeout(() => badge.classList.add('hidden'), ms);
}

function hideHrSignalBadge() {
    if (hrSignalBadgeTimer) clearTimeout(hrSignalBadgeTimer);
    hrSignalBadgeTimer = null;
    document.getElementById('hrSignalBadge')?.classList.add('hidden');
}

// Forget that the watchdog paused the session (start, resume, stop, reset).
function clearHrSignalPause() {
    state.hrSignalPaused = false;
    state.hrSignalState = 'ok';
    state.hrSignalSilentMs = 0;
    hideHrSignalBadge();
    renderHrSignal(null);
}

// A usable reading arrived while the watchdog had the session paused.
function handleHrSignalReturned() {
    if (!state.hrSignalPaused) return;
    if (state.sessionStatus !== 'PAUSED') {
        state.hrSignalPaused = false;
        return;
    }
    if (advancedSettings.hrAutoResume) {
        resumeAfterSignalReturn();
        return;
    }
    holdAfterSignalReturn();
}

// The signal is back but the session stays paused: drop the overlay and
// keep a badge up until the user presses RESUME. Used when auto-resume is
// off and when the simulator is engaged during a watchdog pause (a
// synthetic source must never restart the motors by itself).
function holdAfterSignalReturn() {
    state.hrSignalPaused = false;
    state.hrSignalState = 'ok';
    state.hrSignalSilentMs = 0;
    renderHrSignal(null);
    showHrSignalBadge('SIGNAL BACK, PRESS RESUME', 0);
    checkReadiness();
}

function resumeAfterSignalReturn() {
    state.hrSignalPaused = false;
    if (!startOrResumeSession()) return;
    // Only the signal-loss banner this function raised. A standing report
    // about a device that may still be moving is not the pulse's to clear.
    hideAlertBanner('hrSignal');
    cueVoice('signalRestored');
    showHrSignalBadge('SIGNAL RESTORED, RESUMED', 6000);
    syncTelemetry();
    updateEngine();
}

// One watchdog verdict per clock tick while the session is live. The
// simulator only changes when its slider moves, so it is never stale and the
// overlay never shows for it.
function evaluateHrWatchdog(now = Date.now()) {
    if (state.simEngaged) {
        state.hrSignalState = 'ok';
        state.hrNoContact = false;
        state.hrSignalSilentMs = 0;
        renderHrSignal(null);
        return;
    }
    const verdict = hrWatchdog.evaluate(now);
    // No pulse source at all (link gone and no reconnect in flight): that is
    // a loss, whatever the clocks say, never a "holding" gap.
    if (!isBleConnected() && !isBleReconnecting()) {
        verdict.status = 'stale';
        verdict.sourceLost = true;
    }
    state.hrSignalState = verdict.status;
    state.hrNoContact = verdict.noContact;
    state.hrSignalSilentMs = verdict.sinceValidMs;
    renderHrSignal(verdict);
    // 'holding' needs nothing: hrCurrent still carries the last valid pulse.
    if (verdict.status === 'stale' && !state.hrSignalPaused) {
        state.hrSignalPaused = true;
        dispatchHardware(0, 0, 0, 100, true);
        triggerDisconnectAlert(describeHrLoss(verdict), 'hrSignal');
        cueVoice('signalLost', true);
    }
}

// The partner page only renders what the host reports: no watchdog, no
// games, no endgame, no ceiling inflation.
function renderRemoteClock() {
    updateTimerDisplay();
    checkRemoteLinkHealth();
    redrawChart();
}

// Draw the guide lines where edges really trigger: the host's WORKING
// limits after every offset (on a remote page these arrive in telemetry).
function redrawChart() {
    const chartEl = document.getElementById('hrChart');
    if (!chartEl) return;
    const triggerHr = Number.isFinite(state.edgeTriggerHr) ? state.edgeTriggerHr : undefined;
    drawTelemetryChart(chartEl, state.history, state.effectiveMinHr, state.effectiveMaxHr, triggerHr);
}

// 1-Second Master Clock
setInterval(() => {
    if (isRemotePage) {
        renderRemoteClock();
        return;
    }

    if (state.sessionStatus === 'RUNNING') {
        state.sessionSeconds += 1;
        updateTimerDisplay();
        // Refresh the engine first so the guards and games below judge THIS
        // second's HR, ceiling and edge flag, not the previous tick's.
        updateEngine();
        tickSessionGuardsAndGames();

        // The endgame fires exactly once per session: the Orgasm endgame
        // arms Force Orgasm, which stays a toggle the wearer can cancel.
        if (!state.endgameFired && state.chosenTargetSeconds > 0 && state.sessionSeconds >= state.chosenTargetSeconds) {
            const oracleResolving = state.activeMode === 'oracle'
                && (state.oracleState === 'HOLD' || state.oracleState === 'CLIMAX' || state.orgasmMode);
            // Only an orgasm actually in progress defers the endgame. The
            // training state alone must never suppress it: a cancelled Force
            // Orgasm would leave a timed session with no way to end.
            const trainResolving = state.activeMode === 'edgetrain' && state.orgasmMode;
            if (state.orgasmMode && (oracleResolving || trainResolving)) state.endgameHeldByOrgasm = true;
            if (!oracleResolving && !trainResolving) {
                state.endgameFired = true;
                // The only way to get here with the endgame still pending
                // after an orgasm held it back is that the wearer tapped
                // Force Orgasm OFF. Running the orgasm endgame now would
                // synthesise a click on that same button within a second of
                // them saying no, surging both channels back to 100%. The
                // orgasm endgame is spent; Soft Landing and Denied still run,
                // because cancelling an orgasm is not a request to skip the
                // gentle ending the wearer picked.
                const cancelled = state.endgameHeldByOrgasm && !state.orgasmMode && state.endgameType === 'orgasm';
                if (!cancelled) handleTargetTimeReached();
            }
        }
        if (state.orgasmMode) {
            // Raise the WORKING ceiling 1 BPM/s (capped) so the edge detector
            // stops firing; the typed Climax HR input is never touched.
            state.orgasmBoost = Math.min(ORGASM_BOOST_CAP, (state.orgasmBoost || 0) + 1);
        }
    } else if (state.sessionStatus === 'RAMPDOWN') {
        state.rampdownSecondsLeft -= 1;
        const timerEl = document.getElementById('sessionTimer');
        if (timerEl) timerEl.textContent = `00:${String(state.rampdownSecondsLeft).padStart(2, '0')}`;
        if (state.rampdownSecondsLeft <= 0) stopSession("Soft Landing (Edged Out)");
    }

    // The watchdog guards every state in which motors may move, and keeps
    // the overlay's counter honest while it holds the session paused.
    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        evaluateHrWatchdog();
    } else if (state.sessionStatus === 'PAUSED' && state.hrSignalPaused) {
        evaluateHrWatchdog();
    } else if (state.hrSignalState !== 'ok') {
        clearHrSignalPause();
    }

    // The START / RESUME gate depends on the age of the last valid reading,
    // so the label is refreshed every second while the session is not live.
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') checkReadiness();

    pruneStalePeers(Date.now());
    syncTelemetry();
    updateEngine();
    redrawChart();
}, 1000);

function handleTargetTimeReached() {
    // A latched Force Orgasm does not survive an ending that is not an
    // orgasm. While it is on, the motors ramp toward a high varied output
    // and the ceiling climbs, so a Soft Landing reached with the latch still
    // set - the wearer tapped it during an Oracle hold, and the roll or the
    // timer then chose the tease-down - would keep driving the toys instead
    // of the gentle ending. Denied stops the session, which clears it
    // anyway; the Orgasm endgame IS the latch and keeps it.
    if (!endgameKeepsOrgasmLatch(state.endgameType)) setOrgasmMode(false);
    if (state.endgameType === 'orgasm') {
        if (!state.orgasmMode && orgasmBtn) orgasmBtn.click();
    } else if (state.endgameType === 'rampdown') {
        state.sessionStatus = 'RAMPDOWN';
        state.rampdownSecondsLeft = 45;
        // RAMPDOWN computes both channels from the ramp factor alone and
        // never looks at the heart rate, so no boost reaches the toys. The
        // session tick that refreshes (and clears) the boost is RUNNING-only,
        // so without this the badge would show a MIC +N frozen at whatever
        // the room was when the target time arrived, for the whole 45 s.
        clearMicBoost(state);
        document.getElementById('rampdownNotice')?.classList.remove('hidden');
    } else {
        stopSession("Denied");
    }
}

function updateTimerDisplay() {
    const timerEl = document.getElementById('sessionTimer');
    const subLabelEl = document.getElementById('timerSubLabel');
    if (!timerEl || !subLabelEl) return;

    const aMins = String(Math.floor(state.sessionSeconds / 60)).padStart(2, '0');
    const aSecs = String(state.sessionSeconds % 60).padStart(2, '0');
    const activeStr = `${aMins}:${aSecs}`;

    if (state.durationMode === 'fixed' && state.chosenTargetSeconds > 0) {
        const rem = Math.max(0, state.chosenTargetSeconds - state.sessionSeconds);
        const rMins = String(Math.floor(rem / 60)).padStart(2, '0');
        const rSecs = String(rem % 60).padStart(2, '0');
        timerEl.textContent = `${rMins}:${rSecs}`;
        subLabelEl.textContent = `Elapsed ${activeStr}`;
    } else if (state.durationFallback && state.chosenTargetSeconds === 0) {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Endless (Invalid Duration)";
    } else if (state.durationMode === 'range') {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Mystery Target";
    } else {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Endless Mode";
    }
}

// Start from IDLE or resume from PAUSED. Returns false when the session was
// in neither state, or when the hardware is not ready: a pulse source with a
// fresh valid reading and a toy are required, so a resume can never run the
// motors on a frozen heart rate. The watchdog clocks are left untouched.
function startOrResumeSession() {
    if (state.sessionStatus !== 'IDLE' && state.sessionStatus !== 'PAUSED') return false;
    if (transportWaitingReason()) {
        checkReadiness();
        return false;
    }
    let resumingRampdown = false;
    if (state.sessionStatus === 'IDLE') {
        // A fresh run never inherits time, edges or samples from the last one.
        resetSessionCounters();
        setOrgasmMode(false);
        funscriptSessionStart = Date.now();
        // Play resets the climb clock. The pass was chosen before play.
        const pass = state.calibrationPass;
        resetGameState();
        state.calibrationPass = pass;
        state.chosenTargetSeconds = pickSessionTargetSeconds();
        updateTimerDisplay();
        cueVoice('sessionStart');
    } else {
        // Resume into the rampdown where it left off, not back to RUNNING.
        resumingRampdown = state.resumeStatus === 'RAMPDOWN' && state.rampdownSecondsLeft > 0;
    }
    state.sessionStatus = resumingRampdown ? 'RAMPDOWN' : 'RUNNING';
    state.resumeStatus = null;
    clearHrSignalPause();
    document.getElementById('rampdownNotice')?.classList.toggle('hidden', !resumingRampdown);
    renderTransport(state.sessionStatus);
    return true;
}

// Session Controls Handlers
playPauseBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        // Ask the host; the button re-renders from the telemetry it sends back.
        const wants = (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') ? 'RUNNING' : 'PAUSED';
        sendPeerCommand({ type: 'SESSION_STATE', status: wants });
        return;
    }
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') {
        startOrResumeSession();
    } else if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        pauseSession('Paused.');
    }
    checkReadiness();
    syncTelemetry();
    updateEngine();
});

stopBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        sendPeerCommand({ type: 'SESSION_STATE', status: 'IDLE' });
        return;
    }
    stopSession("Stopped");
});

// Put the transport back into its idle look. Shared by stop and reset.
function showIdleTransport() {
    document.getElementById('rampdownNotice')?.classList.add('hidden');
    renderTransport('IDLE');
}

// `voiceText` overrides the spoken outcome when a game or guard wants to say
// more than the history label (one cue, never two back-to-back).
function stopSession(outcome = "Stopped", voiceText = null) {
    const wasActive = state.sessionStatus !== 'IDLE';
    // Status and motors FIRST: nothing below (history, storage, voice) may
    // leave the session running if it throws.
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    dispatchHardware(0, 0, 0, 100, true);
    setOrgasmMode(false);
    clearHrSignalPause();
    try {
        if (wasActive && state.sessionSeconds >= 10 && !isRemotePage) saveSessionToHistory(outcome);
    } catch (e) {
        console.warn('Session history could not be saved', e);
    } finally {
        resetSessionCounters();
        resetGameState();
        updateWarmupBadge();
        showIdleTransport();
        // STOP silences every queued cue; the outcome is the one thing said.
        cancelSpeech();
        cueVoice(voiceText || ((outcome && outcome !== 'Stopped') ? outcome : 'sessionStop'), true);
        syncTelemetry();
        checkReadiness();
        if (!isRemotePage) updateEngine();
    }
}

resetBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        sendPeerCommand({ type: 'SESSION_RESET' });
        return;
    }
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    dispatchHardware(0, 0, 0, 100, true);
    setOrgasmMode(false);
    clearHrSignalPause();
    resetSessionCounters();
    resetGameState();
    updateWarmupBadge();
    cancelSpeech();
    setMindgamePrompt('', false);
    showIdleTransport();
    syncTelemetry();
    checkReadiness();
    if (!isRemotePage) updateEngine();
});

// Came Early & Learning Profile
function persistSettings() {
    const saved = safeSet('edgeloop_advanced_settings', advancedSettings);
    if (!saved) console.warn('Settings could not be saved (storage full or unavailable)');
    return saved;
}

// Session Setup values that used to be lost on every reload: the typed HR
// limits, the duration window and the Endgame Trigger. They are read off the
// page, sanitized exactly as a stored set is, and written to the same store
// as every other setting - so the Backup export carries them and Import
// restores them with no extra plumbing. A remote page never writes: those
// numbers belong to the host and would overwrite the partner's own store.
// The settings blob is JSON-encoded on every write, so a typed field does not
// get one write per key: the new value lands in advancedSettings on the spot
// (the engine reads it from memory on the next tick, which is what makes a
// mid-session correction take effect immediately) and the STORE write is
// coalesced into one per window. Anything that could take the page away
// flushes first, so a reload can never outrun a typed limit.
const sessionLimitsWriter = createWriteCoalescer({ write: () => persistSettings() });
window.addEventListener('pagehide', () => { sessionLimitsWriter.flush(); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sessionLimitsWriter.flush();
});

function persistSessionLimits(immediate = false) {
    if (isRemotePage) return false;
    const limits = readHrLimits();
    Object.assign(advancedSettings, sanitizeSessionLimits({
        minHr: limits.minHr,
        maxHr: limits.maxHr,
        dualMaxHr: limits.dualMaxHr,
        durationMode: state.durationMode,
        durationFixedMinutes: document.getElementById('paramFixedInput')?.value,
        durationMinMinutes: document.getElementById('paramMinInput')?.value,
        durationMaxMinutes: document.getElementById('paramMaxInput')?.value,
        endgameType: state.endgameType
    }));
    sessionLimitsWriter.schedule();
    // A single deliberate action (a button, a card, leaving a field) is not a
    // burst and is written on the spot.
    return immediate ? sessionLimitsWriter.flush() : true;
}

function renderLearningStatus() {
    const text = document.getElementById('learningStatusText');
    const p = advancedSettings.learningProfile || { breakthroughEvents: 0, suggestedMaxHrOffset: 0 };
    if (text) {
        if (p.breakthroughEvents > 0) {
            const last = p.lastBreakthroughHr ? ` Last event at ${p.lastBreakthroughHr} BPM.` : '';
            text.textContent = `Active: ${p.breakthroughEvents} premature event(s). Working climax ceiling is ${p.suggestedMaxHrOffset} BPM below your typed Climax HR on every session.${last}`;
            text.className = "p-2 bg-amber-950/40 border border-amber-800 rounded-lg text-[10px] font-mono text-amber-300";
        } else {
            text.textContent = "Zero breakthrough events recorded. Typed Climax HR is used as-is.";
            text.className = "p-2 bg-slate-900 rounded-lg text-[10px] font-mono text-purple-300";
        }
    }
    updateEngine();
}

function finishHr() {
    const now = Number.isFinite(state.sensorHr) ? state.sensorHr : state.hrCurrent;
    const peak = Number.isFinite(state.peakHr) ? state.peakHr : now;
    return calibrationReading(Math.max(Number(now) || 0, Number(peak) || 0));
}

function savePrimaryClimax(hr) {
    advancedSettings.calibrationPrimaryHr = hr;
    const input = document.getElementById('maxHr');
    if (input) {
        input.value = String(hr);
        input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        persistSettings();
    }
    const wizard = document.getElementById('wizardSingleMax');
    if (wizard) wizard.value = String(hr);
}

function saveDualClimax(hr) {
    const input = document.getElementById('dualMaxHr');
    if (input) {
        input.value = String(hr);
        input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        advancedSettings.dualMaxHr = hr;
        persistSettings();
    }
    const wizard = document.getElementById('wizardDualMax');
    if (wizard) wizard.value = String(hr);
}

function armCalibration(pass) {
    const kept = pass === 'dual' ? 'dual' : 'primary';
    resetGameState();
    state.calibrationPass = kept;
    state.gameMode = 'calibrate';
    state.activeMode = 'calibrate';
    highlightModeCard();
    renderModeDetail();
    renderCalibration();
    updateEngine();
    syncTelemetry();
}

// Returns true when a pass was armed. The wizard closes only then.
function offerCalibration() {
    if (isRemotePage || isRemoteViewer) return false;
    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED' || state.sessionStatus === 'RAMPDOWN') {
        alert('Stop the session before starting Calibration.');
        return false;
    }
    const saved = calibrationReading(advancedSettings.calibrationPrimaryHr);
    const { dual } = stimulationRoles();
    if (!saved) {
        if (dual) {
            alert('Both toys are on. The first run is the stroker alone — The Handy, or whichever device is your primary. Turn the second toy off, then tap Calibrate again.');
            return false;
        }
        const ok = confirm('First run: one toy only. Use The Handy, or whichever device is stroking, and leave the second toy off.\n\nWhen you come, tap Finished me. That heart rate becomes your single-stim max.\n\nA later Calibration run, with both toys on, saves a separate dual-stim max.\n\nArm the single-stim run? Press play when you are ready.');
        if (!ok) return false;
        armCalibration('primary');
        return true;
    }
    const dualOk = confirm(`Your single-stim max is ${saved} BPM.\n\nThis run uses both toys. Turn the second one on before you press play. Finished me saves the heart rate you finish at as the dual-stim max. The single-stim max stays ${saved}.\n\nArm the both-toys run?`);
    if (dualOk) {
        if (!dual) {
            alert('The second toy is not on yet. Turn it on, then tap Calibrate again.');
            return false;
        }
        armCalibration('dual');
        return true;
    }
    if (!confirm('Redo the primary run instead? Stroker only. The saved number stays until Finished me replaces it.')) return false;
    if (dual) {
        alert('Turn the second toy off for the primary run, then tap Calibrate again.');
        return false;
    }
    armCalibration('primary');
    return true;
}

cameEarlyBtn?.addEventListener('click', () => {
    // The learning profile and the typed max belong to the host.
    if (isRemotePage || isRemoteViewer) return;
    if (state.activeMode === 'calibrate') {
        if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'PAUSED') {
            confirm('Press play first. Finished me saves the heart rate once Calibration is running.');
            return;
        }
        const hr = finishHr();
        if (hr === null) return;
        const saved = calibrationReading(advancedSettings.calibrationPrimaryHr);
        const pass = state.calibrationPass === 'dual' && saved ? 'dual' : 'primary';
        const { dual } = stimulationRoles();
        if (pass === 'dual' && !dual) {
            const asPrimary = confirm(`The second toy is not on, so this is a single-stim reading. Save ${hr} as your single-stim max instead?`);
            if (!asPrimary) return;
            savePrimaryClimax(hr);
            stopSession('Calibration', 'Saved. That heart rate is your max.');
            return;
        }
        if (pass === 'dual') {
            const single = readHrLimits().maxHr;
            const ok = confirm(`Set the dual-stim max to ${hr}? Your single-stim max stays ${single}. The toys stop, and a both-toys session uses ${hr}.`);
            if (!ok) return;
            saveDualClimax(hr);
            stopSession('Calibration', 'Saved. That heart rate is your dual-stim max.');
            return;
        }
        const typed = readHrLimits().maxHr;
        const ok = confirm(`Set the single-stim max to ${hr}? This was one toy. Your typed max is ${typed}. The toys stop, and the next one-toy session uses ${hr}. A later Calibration run with both toys saves the dual-stim max on its own.`);
        if (!ok) return;
        savePrimaryClimax(hr);
        stopSession('Calibration', 'Saved. That heart rate is your max.');
        return;
    }
    if (state.activeMode === 'survival') {
        if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'PAUSED') {
            confirm('Start Survival first. Finished me ends the run. Your Climax HR stays as typed.');
            return;
        }
        const typed = readHrLimits().maxHr;
        if (confirm(`End the run? Your Climax HR stays ${typed}.`)) {
            stopSession('Survival');
        }
        return;
    }
    if (confirm("Log an accidental release? EdgeLoop will lower your working climax ceiling on this and future sessions.")) {
        if (!advancedSettings.learningProfile) {
            advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        }
        const profile = advancedSettings.learningProfile;
        const userMax = readHrLimits().maxHr;
        profile.breakthroughEvents += 1;
        profile.lastBreakthroughHr = state.hrCurrent;
        profile.suggestedMaxHrOffset = Math.min(30, (profile.suggestedMaxHrOffset || 0) + 3);
        if (state.hrCurrent && state.hrCurrent < userMax - 8) {
            profile.suggestedMaxHrOffset = Math.min(30, profile.suggestedMaxHrOffset + 2);
        }
        persistSettings();
        renderLearningStatus();
        stopSession("Premature Release", "cameEarly");
    }
});

document.getElementById('wipeLearningBtn')?.addEventListener('click', () => {
    if (confirm("Reset local bio-learning memory? Your typed Climax HR will be used with no offset.")) {
        advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        persistSettings();
        renderLearningStatus();
    }
});

// Force Orgasm Overdrive. The state and button look live in one place so the
// toggle, stop, reset and remote telemetry all agree. The ceiling boost
// counter restarts from zero on every change and the typed Climax HR input
// is never modified.
function setOrgasmMode(on, { voice = false } = {}) {
    const next = Boolean(on);
    const changed = next !== Boolean(state.orgasmMode);
    state.orgasmMode = next;
    state.orgasmBoost = 0;
    if (orgasmBtnText) orgasmBtnText.textContent = state.orgasmMode ? 'Forcing...' : 'Force Orgasm';
    if (orgasmBtn) {
        orgasmBtn.className = state.orgasmMode
            ? 'bg-rose-700 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center animate-pulse cursor-pointer shadow-lg shadow-rose-950/40'
            : 'bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-pointer shadow-lg shadow-amber-950/30';
    }
    if (!changed || !voice) return;
    if (next) {
        cueVoice('forceOrgasm');
        return;
    }
    // Oracle CLIMAX already has oracleWithdrawn on the next tick.
    if (state.activeMode === 'oracle' && state.oracleState === 'CLIMAX') return;
    cueVoice('forceOrgasmOff');
}

orgasmBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        // The host toggles and reports back through telemetry.
        sendPeerCommand({ type: 'ORGASM_TOGGLE' });
        return;
    }
    setOrgasmMode(!state.orgasmMode, { voice: true });
    syncTelemetry();
    updateEngine();
});

// Typed HR limits take effect immediately (and are validated) rather than on
// the next clock tick. Resting heart rate is assumed and has no field.
['maxHr', 'dualMaxHr'].forEach((id) => {
    const input = document.getElementById(id);
    // Persisted on every edit, not only on blur: a wearer who lowers the
    // ceiling mid-session and never leaves the field used to lose it on the
    // next reload. A half-typed number is refused by readHrLimits, so what
    // is stored is always the last pair the sanitiser accepted.
    const edited = (immediate) => {
        persistSessionLimits(immediate);
        updateEngine();
        syncTelemetry();
        updateEdgeHoldPreview();
    };
    input?.addEventListener('input', () => edited(false));
    input?.addEventListener('change', () => edited(true));
});

// Stroke and goal sit on the same card. A tease mode owns the stroke. A
// goal, while selected, owns the speeds and uses that stroke. Tease is the
// goal with no game. Clicking the selected goal again also turns it off.
const GAME_CARD_MODES = ['oracle', 'survival', 'edgetrain'];
const modeCards = document.querySelectorAll('.mode-card');

const MODE_DETAILS = {
    classic: 'Full strokes inside the travel range you set. Tempo and depth drift so the same pulse does not feel identical, then Crawl or Full Stop at the ceiling.',
    milker: 'The stroker eases off as you climb and the internal toy takes over. Short bursts and the on-off pulse wait until your pulse is close to the heart rate you set.',
    shortener: 'Full strokes until your pulse is close to the heart rate you set, then the stroke shortens to the base. It stays quicker than Classic. The secondary channel stays low.',
    headplay: 'Full strokes until your pulse is close to the heart rate you set, then the stroke climbs toward the head. Speed eases off with your pulse, and the stroke opens back up when your pulse drops.',
    ultimate: 'The pattern changes with your pulse: long and steady, then long-slow against short-fast. Stops and short bursts wait until your pulse is close to the heart rate you set. The internal toy follows the same chapters.',
    ruin: 'The stroker keeps moving through the edge. After about 12 seconds on the mark it stops dead for 18 seconds and the other toy drops low, so it can leak without a full orgasm. "At the ceiling" does not govern the ride or that stop.',
    oracle: 'Pulls you up and holds the edge, then decides how the session ends. Climax and denial wait for your Mystery minimum. The stroke range is the tease mode you selected.',
    survival: 'Each edge raises your max by 1 BPM and the speed a little. The climb takes about half an hour to get hard, and "At the ceiling" does not stop the toys or end the run. Tap Finished me when you come. The stroke range is the tease mode you selected.',
    calibrate: 'A climb of its own, separate from Survival. The first run is one toy, and Finished me saves that heart rate as the single-stim max. A later run with both toys saves the dual-stim max on its own. "At the ceiling" does not stop the toys or end the run.',
    edgetrain: 'Hold the edge for the time you set. Drop early and it does not count. After the set number of holds it offers to finish you. The stroke range is the tease mode you selected.'
};

// The paragraph above the cards follows the goal when one is on, including
// Calibration, and the stroke otherwise.
function renderModeDetail() {
    const el = document.getElementById('modeDetail');
    if (!el) return;
    const mode = state.gameMode || state.teaseMode;
    el.textContent = MODE_DETAILS[mode] || '';
}

function highlightModeCard() {
    modeCards.forEach(c => {
        const mode = c.getAttribute('data-mode');
        const on = mode === 'goal-off'
            ? !state.gameMode
            : (mode === state.teaseMode || mode === state.gameMode);
        const check = c.querySelector('.mode-check');
        const title = c.querySelector('.font-bold');
        if (on) {
            c.className = "mode-card text-left p-2 rounded-xl bg-purple-950/20 border border-purple-800 hover:border-purple-600 transition cursor-pointer flex flex-col justify-between";
            if (title) title.className = "font-bold text-[11px] text-purple-300 flex justify-between items-center";
            check?.classList.remove('hidden');
        } else {
            c.className = "mode-card text-left p-2 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition cursor-pointer flex flex-col justify-between";
            if (title) title.className = "font-bold text-[11px] text-slate-200 flex justify-between items-center";
            check?.classList.add('hidden');
        }
    });
}

function applyModeSelection(mode, enabled) {
    // Calibration is armed only from its own button, which explains the
    // primary run and the later both-toys run. A mode command must not
    // skip that.
    if (mode === 'calibrate') return;
    // Tease clears the goal. It is not a stroke, so it must not land in the
    // tease-mode branch (that would store a mode the engine does not run).
    if (mode === 'goal-off') {
        if (state.gameMode) {
            state.gameMode = null;
            resetGameState();
        }
        state.activeMode = state.teaseMode;
        highlightModeCard();
        renderModeDetail();
        updateEngine();
        return;
    }
    if (GAME_CARD_MODES.includes(mode)) {
        const turnOn = enabled !== undefined ? enabled : state.gameMode !== mode;
        if (!turnOn) {
            state.gameMode = null;
            resetGameState();
        } else {
            if (state.gameMode !== mode) resetGameState();
            state.gameMode = mode;
        }
    } else {
        state.teaseMode = mode;
        state.ruinHoldSeconds = 0;
        state.ruinRideSeconds = 0;
    }
    state.activeMode = state.gameMode || state.teaseMode;
    highlightModeCard();
    renderModeDetail();
    updateEngine();
}

document.getElementById('wizardCalibrateBtn')?.addEventListener('click', () => {
    if (!offerCalibration()) return;
    closeWizard();
});

['wizardSingleMax', 'wizardDualMax'].forEach((id) => {
    const from = document.getElementById(id);
    const toId = id === 'wizardDualMax' ? 'dualMaxHr' : 'maxHr';
    const push = () => {
        const to = document.getElementById(toId);
        if (!from || !to) return;
        to.value = from.value;
        to.dispatchEvent(new Event('input', { bubbles: true }));
    };
    from?.addEventListener('input', push);
    from?.addEventListener('change', () => {
        const to = document.getElementById(toId);
        if (!from || !to) return;
        to.value = from.value;
        to.dispatchEvent(new Event('change', { bubbles: true }));
    });
});

document.getElementById('calibrateBtn')?.addEventListener('click', () => {
    offerCalibration();
});

modeCards.forEach(card => {
    card.addEventListener('click', () => {
        if (isRemoteViewer) return;
        const mode = card.getAttribute('data-mode');
        const enabled = GAME_CARD_MODES.includes(mode) ? state.gameMode !== mode : true;
        applyModeSelection(mode, enabled);
        if (isRemoteController) sendPeerCommand({ type: 'MODE_CHANGE', mode, enabled });
        else syncTelemetry();
    });
});

renderModeDetail();

function persistTrainSettings() {
    advancedSettings.trainHoldSeconds = clampTrainHoldSeconds(document.getElementById('trainHoldSecondsInput')?.value);
    advancedSettings.trainEdges = clampTrainEdges(document.getElementById('trainEdgesInput')?.value);
    const holdEl = document.getElementById('trainHoldSecondsInput');
    const edgesEl = document.getElementById('trainEdgesInput');
    if (holdEl) holdEl.value = String(advancedSettings.trainHoldSeconds);
    if (edgesEl) edgesEl.value = String(advancedSettings.trainEdges);
    persistSettings();
}

// Host only. The hold length and the edge count are read from the WEARER's
// own settings, so a remote page must not collect them: they would stick on
// the partner's screen, overwrite that device's own stored training, and
// never reach the session. They are locked below like every other host-only
// control.
if (!isRemotePage) {
    ['trainHoldSecondsInput', 'trainEdgesInput'].forEach((id) => {
        const el = document.getElementById(id);
        el?.addEventListener('click', (e) => e.stopPropagation());
        el?.addEventListener('change', persistTrainSettings);
    });
}

// Pop-up Modals Router
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modals = {
    Ble: document.getElementById('modalBodyBle'),
    Handy: document.getElementById('modalBodyHandy'),
    Intiface: document.getElementById('modalBodyIntiface'),
    TCode: document.getElementById('modalBodyTCode'),
    History: document.getElementById('modalBodyHistory'),
    Params: document.getElementById('modalBodyParams'),
    Partner: document.getElementById('modalBodyPartner'),
    Legal: document.getElementById('modalBodyLegal'),
    Changelog: document.getElementById('modalBodyChangelog'),
    HrGuide: document.getElementById('modalBodyHrGuide')
};

function openModal(type) {
    Object.values(modals).forEach(m => m?.classList.add('hidden'));
    if (type === 'Ble' && modalTitle) {
        modalTitle.textContent = "Heart Rate Monitor & Simulator";
        modals.Ble?.classList.remove('hidden');
        warnBluetoothUnsupported();
    }
    else if (type === 'Handy' && modalTitle) {
        modalTitle.textContent = "The Handy (Wi-Fi API)";
        modals.Handy?.classList.remove('hidden');
        updateHwEnvelopeDisplay();
    }
    else if (type === 'Intiface' && modalTitle) { modalTitle.textContent = "Intiface Central & Toy Roles"; modals.Intiface?.classList.remove('hidden'); renderIntifaceDevices(); }
    else if (type === 'TCode' && modalTitle) {
        modalTitle.textContent = "TCode Serial (OSR2 / SR6 / OSSM)";
        modals.TCode?.classList.remove('hidden');
        renderTCodeStatus(getTCodeStatus());
        renderTCodeDevice();
        warnSerialUnsupported();
    }
    else if (type === 'History' && modalTitle) { modalTitle.textContent = "Session History & Funscripts"; modals.History?.classList.remove('hidden'); renderHistory(); }
    else if (type === 'Params' && modalTitle) { modalTitle.textContent = "Session Setup"; modals.Params?.classList.remove('hidden'); renderLearningStatus(); syncParamsUI(); }
    else if (type === 'Partner' && modalTitle) { modalTitle.textContent = "Share Control Hub"; modals.Partner?.classList.remove('hidden'); setupPartnerHost(); }
    else if (type === 'Legal' && modalTitle) { modalTitle.textContent = "Legal & Medical Disclaimer"; modals.Legal?.classList.remove('hidden'); }
    else if (type === 'Changelog' && modalTitle) {
        modalTitle.textContent = `Changelog · v${APP_VERSION}`;
        modals.Changelog?.classList.remove('hidden');
        loadChangelog();
    }
    else if (type === 'HrGuide' && modalTitle) { modalTitle.textContent = "Smartwatch Pairing Guide"; modals.HrGuide?.classList.remove('hidden'); }
    overlay?.classList.remove('hidden');
}

function closeModal() {
    overlay?.classList.add('hidden');
    if (state.isTestingMic && !advancedSettings.micEnabled) {
        stopMicMonitor(state);
        paintMicMeter(0);
    }
    state.isTestingMic = false;
}

document.getElementById('cardBle')?.addEventListener('click', () => { if (!isRemotePage) openModal('Ble'); });
document.getElementById('cardHandy')?.addEventListener('click', () => { if (!isRemotePage) openModal('Handy'); });
document.getElementById('cardIntiface')?.addEventListener('click', () => { if (!isRemotePage) openModal('Intiface'); });
document.getElementById('cardTCode')?.addEventListener('click', () => { if (!isRemotePage) openModal('TCode'); });
document.getElementById('historyBtn')?.addEventListener('click', () => openModal('History'));
document.getElementById('sessionParamsHeaderBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('openParamsBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('partnerShareBtn')?.addEventListener('click', () => { if (!isRemotePage) openModal('Partner'); });
document.getElementById('bleQuickHelpBtn')?.addEventListener('click', () => openModal('HrGuide'));
document.getElementById('footerLegalBtn')?.addEventListener('click', () => openModal('Legal'));
document.getElementById('footerChangelogBtn')?.addEventListener('click', () => openModal('Changelog'));

const versionEl = document.getElementById('appVersion');
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

function appendChangelogText(parent, text) {
    const parts = String(text).split('**');
    parts.forEach((part, index) => {
        if (!part) return;
        if (index % 2 === 1) {
            const strong = document.createElement('strong');
            strong.className = 'text-slate-200';
            strong.textContent = part;
            parent.appendChild(strong);
        } else {
            parent.appendChild(document.createTextNode(part));
        }
    });
}

function paintChangelog(markdown) {
    const body = document.getElementById('changelogBody');
    if (!body) return;
    body.replaceChildren();
    for (const section of parseChangelog(markdown)) {
        const heading = document.createElement('h4');
        heading.className = 'text-xs font-bold text-slate-200 uppercase tracking-wider pt-1';
        heading.textContent = section.title;
        body.appendChild(heading);
        let list = null;
        for (const block of section.blocks) {
            if (block.type !== 'item') list = null;
            if (block.type === 'area') {
                const area = document.createElement('div');
                area.className = 'font-semibold text-slate-300 pt-1';
                area.textContent = block.text;
                body.appendChild(area);
            } else if (block.type === 'text') {
                const paragraph = document.createElement('p');
                appendChangelogText(paragraph, block.text);
                body.appendChild(paragraph);
            } else if (block.type === 'item') {
                if (!list) {
                    list = document.createElement('ul');
                    list.className = 'list-disc list-inside space-y-1';
                    body.appendChild(list);
                }
                const item = document.createElement('li');
                appendChangelogText(item, block.text);
                list.appendChild(item);
            }
        }
    }
}

let changelogLoaded = false;
async function loadChangelog() {
    const body = document.getElementById('changelogBody');
    const github = document.getElementById('changelogGithubLink');
    const releases = document.getElementById('changelogReleasesLink');
    if (github) github.href = GITHUB_CHANGELOG_URL;
    if (releases) releases.href = GITHUB_RELEASES_URL;
    if (!body || changelogLoaded) return;
    try {
        const response = await fetch('./CHANGELOG.md', { cache: 'no-cache' });
        if (!response.ok) throw new Error(String(response.status));
        paintChangelog(await response.text());
        changelogLoaded = true;
    } catch {
        body.textContent = 'This copy could not load its changelog. It is on GitHub at the link below.';
    }
}
document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

// BLE Modal Tabs
const bleTabRealBtn = document.getElementById('bleTabRealBtn');
const bleTabSimBtn = document.getElementById('bleTabSimBtn');
const bleRealSection = document.getElementById('bleRealSection');
const bleSimSection = document.getElementById('bleSimSection');

bleTabRealBtn?.addEventListener('click', () => {
    bleTabRealBtn.className = "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (bleTabSimBtn) bleTabSimBtn.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    bleRealSection?.classList.remove('hidden');
    bleSimSection?.classList.add('hidden');
});

bleTabSimBtn?.addEventListener('click', () => {
    bleTabSimBtn.className = "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (bleTabRealBtn) bleTabRealBtn.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    bleSimSection?.classList.remove('hidden');
    bleRealSection?.classList.add('hidden');
});

// Session Setup Sub-Tabs (4 Tabs: duration, guards, audio, backup)
const paramsTabMap = {
    duration: { btn: document.getElementById('paramsTabDurationBtn'), sec: document.getElementById('paramsDurationSection') },
    guards: { btn: document.getElementById('paramsTabGuardsBtn'), sec: document.getElementById('paramsGuardsSection') },
    audio: { btn: document.getElementById('paramsTabAudioBtn'), sec: document.getElementById('paramsAudioSection') },
    backup: { btn: document.getElementById('paramsTabBackupBtn'), sec: document.getElementById('paramsBackupSection') }
};

function setParamsTab(activeKey) {
    Object.keys(paramsTabMap).forEach(key => {
        const item = paramsTabMap[key];
        if (item.btn && item.sec) {
            const isActive = (key === activeKey);
            item.sec.classList.toggle('hidden', !isActive);
            item.btn.className = isActive
            ? "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer"
            : "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
        }
    });
}

paramsTabMap.duration.btn?.addEventListener('click', () => setParamsTab('duration'));
paramsTabMap.guards.btn?.addEventListener('click', () => setParamsTab('guards'));
paramsTabMap.audio.btn?.addEventListener('click', () => setParamsTab('audio'));
paramsTabMap.backup.btn?.addEventListener('click', () => setParamsTab('backup'));

// Duration Mode Switcher
const durFixedBtn = document.getElementById('durFixedBtn');
const durRangeBtn = document.getElementById('durRangeBtn');
const durEndlessBtn = document.getElementById('durEndlessBtn');
const paramFixedContainer = document.getElementById('paramFixedContainer');
const paramRangeContainer = document.getElementById('paramRangeContainer');
const paramEndlessContainer = document.getElementById('paramEndlessContainer');

function setDurationMode(mode) {
    state.durationMode = mode;
    if (durFixedBtn) durFixedBtn.className = mode === 'fixed' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';
    if (durRangeBtn) durRangeBtn.className = mode === 'range' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';
    if (durEndlessBtn) durEndlessBtn.className = mode === 'endless' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';

    paramFixedContainer?.classList.toggle('hidden', mode !== 'fixed');
    paramRangeContainer?.classList.toggle('hidden', mode !== 'range');
    paramEndlessContainer?.classList.toggle('hidden', mode !== 'endless');
    validateDurationInputs();
    updateTimerDisplay();
}

['paramFixedInput', 'paramMinInput', 'paramMaxInput'].forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener('input', () => { validateDurationInputs(); persistSessionLimits(); });
    input?.addEventListener('change', () => { validateDurationInputs(); persistSessionLimits(true); });
});

// setDurationMode is also how the stored mode is restored, so only a real
// click writes the store.
durFixedBtn?.addEventListener('click', () => { setDurationMode('fixed'); persistSessionLimits(true); });
durRangeBtn?.addEventListener('click', () => { setDurationMode('range'); persistSessionLimits(true); });
durEndlessBtn?.addEventListener('click', () => { setDurationMode('endless'); persistSessionLimits(true); });

// Warm-up Slider Listener
const warmupInput = document.getElementById('warmupInput');
const warmupDisplay = document.getElementById('warmupValDisplay');
warmupInput?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (warmupDisplay) {
        warmupDisplay.textContent = (val === 0) ? "0 min (Instant)" : `${val} Minutes`;
    }
});

function syncParamsUI() {
    // Restore the persisted session limits into the page. advancedSettings
    // has already been through sanitizeSessionLimits (syncGuardSettings), so
    // these are values the wearer could have typed themselves. All of it is
    // host-only: every one of these numbers describes the WEARER's session,
    // and a remote page shows the host's, so none of them may be supplied
    // out of the partner's own browser.
    if (!isRemotePage) {
        // Seeded here, and only here: a remote page keeps the factory pair
        // until the host's telemetry arrives.
        state.lastGoodHrLimits = { minHr: DEFAULT_MIN_HR, maxHr: advancedSettings.maxHr, dualMaxHr: advancedSettings.dualMaxHr };
        const maxInput = document.getElementById('maxHr');
        const dualMaxInput = document.getElementById('dualMaxHr');
        if (maxInput) maxInput.value = String(advancedSettings.maxHr);
        if (dualMaxInput) dualMaxInput.value = String(advancedSettings.dualMaxHr || 125);
        const fixedInput = document.getElementById('paramFixedInput');
        const rangeMinInput = document.getElementById('paramMinInput');
        const rangeMaxInput = document.getElementById('paramMaxInput');
        if (fixedInput) fixedInput.value = String(advancedSettings.durationFixedMinutes);
        if (rangeMinInput) rangeMinInput.value = String(advancedSettings.durationMinMinutes);
        if (rangeMaxInput) rangeMaxInput.value = String(advancedSettings.durationMaxMinutes);
        // The Target Mode and the Endgame Trigger are the WEARER's: a remote
        // page is told neither over the wire, and the timer sub-label reads
        // state.durationMode, so adopting this device's stored mode would
        // have a partner's screen announce Endless while the host runs a
        // Mystery window. A remote page keeps the built-in Mystery / Climax
        // until the host says otherwise, exactly as it did before these
        // values were stored at all.
        state.endgameType = advancedSettings.endgameType;
        highlightEndgameCard(state.endgameType);
        state.durationMode = advancedSettings.durationMode;
    }
    setDurationMode(state.durationMode);
    const stallToggle = document.getElementById('stallGuardToggle');
    const stallSec = document.getElementById('stallGuardSecondsInput');
    const decayToggle = document.getElementById('adaptiveDecayToggle');
    const decayCount = document.getElementById('decayEdgeCountInput');
    const decayBpm = document.getElementById('decayBpmInput');
    const decayFloor = document.getElementById('decayFloorInput');
    const warmup = document.getElementById('warmupInput');
    const warmupDisp = document.getElementById('warmupValDisplay');

    if (stallToggle) stallToggle.checked = Boolean(advancedSettings.stallGuard);
    if (stallSec) stallSec.value = clampStallGuardSeconds(advancedSettings.stallGuardSeconds);
    const stallPause = document.getElementById('stallPauseSecondsInput');
    if (stallPause) stallPause.value = clampStallPauseSeconds(advancedSettings.stallPauseSeconds);
    const ceilingSelect = document.getElementById('ceilingBehaviourSelect');
    if (ceilingSelect) ceilingSelect.value = advancedSettings.ceilingBehaviour === 'stop' ? 'stop' : 'crawl';
    const holdInput = document.getElementById('edgeHoldPercentInput');
    if (holdInput) holdInput.value = isRemotePage ? '' : clampEdgeHoldPercent(advancedSettings.edgeHoldPercent);
    if (isRemotePage && holdInput) holdInput.placeholder = '--';
    if (!isRemotePage) updateEdgeHoldPreview();
    const trainHold = document.getElementById('trainHoldSecondsInput');
    const trainEdges = document.getElementById('trainEdgesInput');
    // On a remote page these belong to the HOST. Writing this browser's own
    // persisted values would show the partner their own Hold / edges while
    // they pace the wearer's session by them; the HTML defaults would be just
    // as wrong. They stay blank until telemetry carries the host's numbers.
    if (trainHold) trainHold.value = isRemotePage ? '' : clampTrainHoldSeconds(advancedSettings.trainHoldSeconds);
    if (trainEdges) trainEdges.value = isRemotePage ? '' : clampTrainEdges(advancedSettings.trainEdges);
    renderCalibration();
    if (isRemotePage) {
        if (trainHold) trainHold.placeholder = '--';
        if (trainEdges) trainEdges.placeholder = '--';
    }
    if (decayToggle) decayToggle.checked = Boolean(advancedSettings.adaptiveDecay);
    if (decayCount) decayCount.value = advancedSettings.decayEdgeCount || 2;
    if (decayBpm) decayBpm.value = advancedSettings.decayBpm || 2;
    if (decayFloor) decayFloor.value = advancedSettings.decayFloor || 105;

    const staleInput = document.getElementById('hrStaleSecondsInput');
    const autoResumeToggle = document.getElementById('hrAutoResumeToggle');
    if (staleInput) staleInput.value = clampStaleSeconds(advancedSettings.hrStaleSeconds);
    if (autoResumeToggle) autoResumeToggle.checked = advancedSettings.hrAutoResume !== false;

    if (warmup) warmup.value = advancedSettings.warmupMinutes ?? 5;
    if (warmupDisp) warmupDisp.textContent = (advancedSettings.warmupMinutes === 0) ? "0 min (Instant)" : `${advancedSettings.warmupMinutes ?? 5} Minutes`;

    const voiceToggle = document.getElementById('paramVoiceToggle');
    const micToggle = document.getElementById('paramMicToggle');
    if (voiceToggle) voiceToggle.checked = Boolean(advancedSettings.voiceEnabled);
    if (micToggle) micToggle.checked = Boolean(advancedSettings.micEnabled);
    const gateInput = document.getElementById('micGateInput');
    const gateValue = document.getElementById('micGateValue');
    const gate = clampMicGate(advancedSettings.micSensitivityThreshold);
    if (gateInput) gateInput.value = gate;
    if (gateValue) gateValue.textContent = String(gate);
    const boostInput = document.getElementById('micBoostBpmInput');
    const boostValue = document.getElementById('micBoostBpmValue');
    const boostCap = clampMicBoostBpm(advancedSettings.micBoostMaxBpm);
    if (boostInput) boostInput.value = boostCap;
    if (boostValue) boostValue.textContent = String(boostCap);
    populateVoiceSelect();
    renderVoiceCueEditor();
    paintIdlePrompt();
}

function populateVoiceSelect() {
    const select = document.getElementById('paramVoiceSelect');
    if (!select || !window.speechSynthesis) return;
    const voices = listSpeechVoices();
    const current = advancedSettings.voiceURI || '';
    select.innerHTML = '<option value="">Browser default</option>';
    voices.forEach((voice) => {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        if (voice.voiceURI === current) option.selected = true;
        select.appendChild(option);
    });
    if (current && !voices.some((voice) => voice.voiceURI === current)) {
        select.value = '';
    } else {
        select.value = current;
    }
}

if (window.speechSynthesis) {
    populateVoiceSelect();
    window.speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
}

document.getElementById('paramVoicePreviewBtn')?.addEventListener('click', () => {
    const select = document.getElementById('paramVoiceSelect');
    if (select) advancedSettings.voiceURI = select.value;
    const { text } = resolveVoiceCue(currentVoiceCues().cues, 'preview', sessionVoiceVars());
    if (text) speakNow(text, advancedSettings.voiceURI);
});

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderVoiceCueEditor() {
    const root = document.getElementById('voiceCuesList');
    if (!root) return;
    const merged = mergeVoiceCues(advancedSettings.voiceCues);
    let lastGroup = '';
    root.innerHTML = VOICE_CUE_CATALOG.map((cue) => {
        const lines = merged[cue.id] || cue.lines;
        const rows = Math.min(8, Math.max(3, lines.length + 1));
        const group = cue.group || '';
        const heading = group && group !== lastGroup
            ? `<p class="text-[9px] uppercase tracking-wider text-purple-400 font-bold pt-1">${escapeAttr(group)}</p>`
            : '';
        lastGroup = group;
        return `${heading}<div class="space-y-0.5">
            <div class="flex justify-between items-center gap-2">
              <label class="text-[9px] text-slate-400 font-semibold" for="voiceCue-${cue.id}">${escapeAttr(cue.label)} <span class="text-slate-600 font-mono">(${lines.length === 0 ? 'muted' : lines.length})</span></label>
              <button type="button" data-voice-preview="${cue.id}" class="text-[9px] text-purple-300 hover:underline cursor-pointer">Speak</button>
            </div>
            <textarea id="voiceCue-${cue.id}" data-voice-cue="${cue.id}" rows="${rows}" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-slate-200 outline-none focus:border-purple-500 font-mono leading-snug">${escapeAttr(lines.join('\n'))}</textarea>
        </div>`;
    }).join('');
    const interval = document.getElementById('voiceEncourageSecondsInput');
    if (interval) interval.value = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
}

// Reads the phrase editor WITHOUT committing it: Speak, Preview and both
// exports only look at what is typed. Only Apply (and Import / Reset, which
// the user confirms) writes these into advancedSettings, so closing the modal
// with the X discards phrase edits like every other control in it.
function readVoiceCuesFromForm() {
    const raw = {};
    document.querySelectorAll('[data-voice-cue]').forEach((el) => {
        raw[el.getAttribute('data-voice-cue')] = el.value;
    });
    const intervalEl = document.getElementById('voiceEncourageSecondsInput');
    return {
        cues: Object.keys(raw).length > 0 ? mergeVoiceCues(raw) : null,
        encourageSeconds: intervalEl ? clampEncourageSeconds(intervalEl.value) : null
    };
}

// The phrases as they stand right now: what is typed in the editor when it is
// on screen, otherwise what is saved.
function currentVoiceCues() {
    const form = readVoiceCuesFromForm();
    return {
        cues: form.cues || mergeVoiceCues(advancedSettings.voiceCues),
        encourageSeconds: form.encourageSeconds ?? clampEncourageSeconds(advancedSettings.voiceEncourageSeconds)
    };
}

document.getElementById('voiceCuesList')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-voice-preview]');
    if (!btn) return;
    const { text } = resolveVoiceCue(currentVoiceCues().cues, btn.getAttribute('data-voice-preview'), sessionVoiceVars());
    if (text) speakNow(text, advancedSettings.voiceURI);
});

document.getElementById('voiceCuesResetBtn')?.addEventListener('click', () => {
    if (!confirm('Restore the factory phrases for all cues? Every custom line you wrote is lost.')) return;
    advancedSettings.voiceCues = mergeVoiceCues({});
    advancedSettings.voiceEncourageSeconds = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
    renderVoiceCueEditor();
    if (!persistSettings()) alert('The phrases were reset, but the browser refused to save them (storage full or unavailable).');
});

function downloadNamedText(filename, body, mime = 'application/json') {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

document.getElementById('voiceCuesExportBtn')?.addEventListener('click', () => {
    const live = currentVoiceCues();
    const payload = {
        voiceCues: serializeVoiceCues(live.cues),
        voiceEncourageSeconds: live.encourageSeconds
    };
    downloadNamedText('edgeloop_voice_cues.json', JSON.stringify(payload, null, 2));
});

document.getElementById('voiceCuesImportFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
        alert('That file could not be read. Nothing was changed.');
    };
    reader.onload = (evt) => {
        const parsed = parseVoiceCuesText(String(evt.target.result || ''));
        if (parsed.error === 'header') {
            alert(`"${parsed.header}" is not a phrase section EdgeLoop knows, so nothing was imported. Sections are # edge, # encourage, # forceOrgasm, # cameEarly and the other cue names (upper or lower case).`);
            return;
        }
        if (parsed.error === 'preamble') {
            // Filing a title or a note as a phrase would replace a whole
            // bank with it and then speak it at the wearer, so the file is
            // refused and the offending line is named.
            alert(`"${parsed.line}" sits above the first # section, so EdgeLoop cannot tell which cue it belongs to and nothing was imported. Put every phrase under a section header (# edge, # encourage, ...), or start the file with "// " to make that line a comment.`);
            return;
        }
        if (parsed.error || !parsed.cues || Object.keys(parsed.cues).length === 0) {
            alert('That file did not look like an EdgeLoop phrase list. Use Export phrases, a settings backup, or a text file with # edge / # encourage sections.');
            return;
        }
        // Start from what is on screen so phrase edits made before the import
        // are not lost, then let the file win for the cues it carries.
        const live = currentVoiceCues();
        advancedSettings.voiceCues = applyImportedCues(live.cues, parsed.cues);
        const nextEncourage = parsed.encourageSeconds ?? live.encourageSeconds;
        const timerChanged = nextEncourage !== live.encourageSeconds;
        advancedSettings.voiceEncourageSeconds = nextEncourage;
        renderVoiceCueEditor();
        // What was really written, not how many keys the file had: a value
        // that is not a list of lines keeps the bank, so it is neither
        // imported nor muted.
        alert(voiceImportAlert(describeImport(parsed.cues), { saved: persistSettings(), timerChanged }));
    };
    reader.readAsText(file);
    e.target.value = '';
});

document.getElementById('paramVoiceSelect')?.addEventListener('change', (e) => {
    advancedSettings.voiceURI = e.target.value;
});

// Endgame selection inside Session Setup
const paramEndgameCards = document.querySelectorAll('.param-endgame-card');
// Also used to paint the restored Endgame Trigger on boot (syncParamsUI).
function highlightEndgameCard(type) {
    paramEndgameCards.forEach(c => {
        const bold = c.querySelector('.font-bold');
        if (c.getAttribute('data-endgame') === type) {
            c.className = "param-endgame-card p-1.5 rounded-lg bg-purple-950/30 border border-purple-800 text-left transition cursor-pointer";
            if (bold) bold.className = "font-bold text-[10px] text-purple-300";
        } else {
            c.className = "param-endgame-card p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-left transition cursor-pointer";
            if (bold) bold.className = "font-bold text-[10px] text-slate-300";
        }
    });
}
paramEndgameCards.forEach(card => {
    card.addEventListener('click', () => {
        state.endgameType = card.getAttribute('data-endgame');
        highlightEndgameCard(state.endgameType);
        persistSessionLimits(true);
    });
});

// Browsers only grant the microphone (and an unmuted AudioContext) inside a
// user gesture, so a persisted mic setting is never started on load: the
// cockpit shows a "Tap to re-enable microphone" control instead.
const micReenableBtn = document.getElementById('micReenableBtn');
function showMicReenable(visible) {
    micReenableBtn?.classList.toggle('hidden', !visible);
}
micReenableBtn?.addEventListener('click', () => { applyMicSetting(true); });

// Must run from a click handler (see startMicMonitor).
async function applyMicSetting(enabled) {
    advancedSettings.micEnabled = Boolean(enabled);
    const badge = document.getElementById('micActiveBadge');
    showMicReenable(false);
    if (!enabled) {
        stopMicMonitor(state);
        state.isTestingMic = false;
        badge?.classList.add('hidden');
        clearMicBoost(state);
        paintMicMeter(0);
        return;
    }
    try {
        await startMicMonitor(state, { onLost: handleMicLost });
        badge?.classList.remove('hidden');
        paintMicMeter(0);
        startMicMeterLoop();
    } catch (e) {
        advancedSettings.micEnabled = false;
        const toggle = document.getElementById('paramMicToggle');
        if (toggle) toggle.checked = false;
        badge?.classList.add('hidden');
        alert('Microphone permission denied or unavailable in this browser.');
    }
}

// Slider values are a PREVIEW for the meter and only while Session Setup
// is on screen. Dismissing the modal without Apply leaves the dragged
// value in the DOM, and the engine must never see it.
function paramsModalOpen() {
    // closeModal() hides the overlay and leaves the modal body as it was,
    // so the body's own class is not evidence that Setup is on screen.
    if (!overlay || overlay.classList.contains('hidden')) return false;
    return Boolean(modals.Params) && !modals.Params.classList.contains('hidden');
}

function liveMicGate() {
    const fromSlider = paramsModalOpen() ? document.getElementById('micGateInput')?.value : null;
    if (fromSlider !== undefined && fromSlider !== null && fromSlider !== '') {
        return clampMicGate(fromSlider);
    }
    return clampMicGate(advancedSettings.micSensitivityThreshold);
}

function liveMicBoostCap() {
    const fromSlider = paramsModalOpen() ? document.getElementById('micBoostBpmInput')?.value : null;
    if (fromSlider !== undefined && fromSlider !== null && fromSlider !== '') {
        return clampMicBoostBpm(fromSlider);
    }
    return clampMicBoostBpm(advancedSettings.micBoostMaxBpm);
}

function paintMicMeter(level) {
    const bar = document.getElementById('micLevelBar');
    const label = document.getElementById('micLevelLabel');
    const badge = document.getElementById('micActiveBadge');
    const gate = liveMicGate();
    const cap = liveMicBoostCap();
    const value = Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 0;
    const boost = micBoostFromLevel(value, gate, cap);
    const gated = value >= gate;
    if (bar) {
        bar.style.width = `${value}%`;
        bar.className = `h-full transition-[width] duration-75 ${gated ? 'bg-emerald-400' : 'bg-slate-600'}`;
    }
    if (label) {
        if (!state.micAnalyser) {
            label.textContent = 'Tap Test, then make noise. Toys should stay below the gate.';
            label.className = 'text-[9px] font-mono text-slate-500';
        } else if (boost > 0) {
            label.textContent = `Voice ${value} — +${boost} BPM toward the edge (max ${cap}).`;
            label.className = 'text-[9px] font-mono text-rose-300';
        } else if (gated) {
            label.textContent = `Voice ${value} — above gate ${gate}, extra BPM is 0.`;
            label.className = 'text-[9px] font-mono text-emerald-300';
        } else {
            label.textContent = `Level ${value} — below gate ${gate}. Toys/noise ignored.`;
            label.className = 'text-[9px] font-mono text-slate-400';
        }
    }
    // The meter only paints. state.micBoost is owned by the once-a-second
    // session tick, so a ~60 Hz animation frame can never re-enter the
    // engine or move the toys between heart-rate readings.

    // The badge reports what updateEngine actually added, never this
    // meter's own preview: the meter repaints ~60 times a second and would
    // otherwise claim a push the engine is suppressing.
    const applied = Number.isFinite(state.micApplied) ? state.micApplied : 0;
    if (badge && (advancedSettings.micEnabled || state.isTestingMic) && state.micAnalyser) {
        badge.classList.remove('hidden');
        if (applied > 0) {
            badge.textContent = `MIC +${applied}`;
            badge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-700 text-rose-300 ml-1';
        } else {
            badge.textContent = 'MIC LISTEN';
            badge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-700 text-emerald-300 ml-1';
        }
    } else if (badge) {
        // Test microphone with the toggle off used to leave MIC LISTEN lit
        // on the cockpit for the rest of the session.
        badge.classList.add('hidden');
    }
    renderMicProcessingNote();
}

// Tell the wearer when the browser refused to switch its audio processing
// off: their gate is then calibrated against a signal the browser is
// already flattening, which means something different.
function renderMicProcessingNote() {
    const note = document.getElementById('micProcessingNote');
    if (!note) return;
    const report = state.micProcessing;
    if (!state.micAnalyser || !report || report.clean) {
        note.classList.add('hidden');
        note.textContent = '';
        return;
    }
    note.textContent = report.message;
    note.classList.remove('hidden');
}

// A microphone that goes away mid-session is reported, never swallowed.
function handleMicLost(message) {
    advancedSettings.micEnabled = false;
    const toggle = document.getElementById('paramMicToggle');
    if (toggle) toggle.checked = false;
    document.getElementById('micActiveBadge')?.classList.add('hidden');
    state.isTestingMic = false;
    clearMicBoost(state);
    paintMicMeter(0);
    showMicReenable(true);
    // An advisory: nothing is moving because of this. It must never replace a
    // safety report (a motor that may still be running, a lost pulse) that is
    // already on the banner - it is appended to it instead.
    showAlertBanner(message, { severity: 'advisory', source: 'mic' });
}

function startMicMeterLoop() {
    if (state.micAnimId) cancelAnimationFrame(state.micAnimId);
    const tick = () => {
        paintMicMeter(sampleMicLevel(state));
        state.micAnimId = requestAnimationFrame(tick);
    };
    tick();
}

function updateEdgeHoldPreview() {
    const preview = document.getElementById('edgeHoldPreview');
    if (!preview) return;
    const limits = readHrLimits();
    const typedMax = limits.maxHr;
    // The percentage applies to the WORKING ceiling, which is what the
    // engine, the HOLD TO badge and the guards use. Previewing it against
    // the typed Climax HR promised a mark the session never pulls back at
    // (dual-stim dampening and decay are on by default).
    const max = workingCeiling(limits.minHr, typedMax).maxHr;
    const pct = clampEdgeHoldPercent(document.getElementById('edgeHoldPercentInput')?.value);
    preview.textContent = describeEdgeHoldPreview({
        typedMaxHr: typedMax,
        workingMaxHr: max,
        minHr: limits.minHr,
        holdPercent: pct
    });
}

document.getElementById('edgeHoldPercentInput')?.addEventListener('input', updateEdgeHoldPreview);

document.getElementById('paramMicTestBtn')?.addEventListener('click', async () => {
    try {
        state.isTestingMic = true;
        await startMicMonitor(state, { onLost: handleMicLost });
        document.getElementById('micActiveBadge')?.classList.remove('hidden');
        paintMicMeter(0);
        startMicMeterLoop();
    } catch (e) {
        state.isTestingMic = false;
        paintMicMeter(0);
        alert('Microphone permission denied or unavailable in this browser.');
    }
});

document.getElementById('micGateInput')?.addEventListener('input', (e) => {
    const gate = clampMicGate(e.target.value);
    const disp = document.getElementById('micGateValue');
    if (disp) disp.textContent = String(gate);
    paintMicMeter(sampleMicLevel(state));
});

document.getElementById('micBoostBpmInput')?.addEventListener('input', (e) => {
    const cap = clampMicBoostBpm(e.target.value);
    const disp = document.getElementById('micBoostBpmValue');
    if (disp) disp.textContent = String(cap);
    paintMicMeter(sampleMicLevel(state));
});

// Apply Session Setup
document.getElementById('applyParamsBtn')?.addEventListener('click', async () => {
    advancedSettings.stallGuard = document.getElementById('stallGuardToggle')?.checked ?? true;
    advancedSettings.stallGuardSeconds = clampStallGuardSeconds(document.getElementById('stallGuardSecondsInput')?.value);
    advancedSettings.stallPauseSeconds = clampStallPauseSeconds(document.getElementById('stallPauseSecondsInput')?.value);
    advancedSettings.ceilingBehaviour = document.getElementById('ceilingBehaviourSelect')?.value === 'stop' ? 'stop' : 'crawl';
    advancedSettings.edgeHoldPercent = clampEdgeHoldPercent(document.getElementById('edgeHoldPercentInput')?.value);
    advancedSettings.adaptiveDecay = document.getElementById('adaptiveDecayToggle')?.checked ?? true;
    advancedSettings.decayEdgeCount = parseInt(document.getElementById('decayEdgeCountInput')?.value, 10) || 2;
    advancedSettings.decayBpm = parseInt(document.getElementById('decayBpmInput')?.value, 10) || 2;
    advancedSettings.decayFloor = parseInt(document.getElementById('decayFloorInput')?.value, 10) || 105;
    advancedSettings.hrStaleSeconds = clampStaleSeconds(document.getElementById('hrStaleSecondsInput')?.value);
    advancedSettings.hrAutoResume = document.getElementById('hrAutoResumeToggle')?.checked ?? true;
    syncWatchdogSettings();
    const warmupParsed = parseInt(document.getElementById('warmupInput')?.value, 10);
    advancedSettings.warmupMinutes = Number.isFinite(warmupParsed) ? warmupParsed : 5;
    advancedSettings.voiceEnabled = document.getElementById('paramVoiceToggle')?.checked ?? false;
    advancedSettings.voiceURI = document.getElementById('paramVoiceSelect')?.value || '';
    const voiceForm = currentVoiceCues();
    advancedSettings.voiceCues = voiceForm.cues;
    advancedSettings.voiceEncourageSeconds = voiceForm.encourageSeconds;
    if (!advancedSettings.voiceEnabled) cancelSpeech();
    const micOn = document.getElementById('paramMicToggle')?.checked ?? false;
    advancedSettings.micSensitivityThreshold = clampMicGate(document.getElementById('micGateInput')?.value);
    advancedSettings.micBoostMaxBpm = clampMicBoostBpm(document.getElementById('micBoostBpmInput')?.value);
    syncGuardSettings();
    const micWasOn = Boolean(state.micAnalyser);
    // Only (re)start the monitor when the setting changed: the button click
    // that submits the form is the user gesture the microphone needs.
    if (micOn !== micWasOn) {
        await applyMicSetting(micOn);
    } else {
        advancedSettings.micEnabled = micOn;
        if (!micOn) showMicReenable(false);
    }
    paintIdlePrompt();

    persistSettings();
    closeModal();
    updateEngine();
    syncTelemetry();
});

// A <label> wrapping a display:none file input is not in the tab order and
// answers no key, so Import could only be reached with a mouse. The labels
// carry role="button" and tabindex="0" in the markup; this opens the picker
// on Enter and Space, which is what a button does.
document.querySelectorAll('[data-file-label]').forEach((label) => {
    label.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        document.getElementById(label.dataset.fileLabel)?.click();
    });
});

// Export & Import Settings. The file shape, every clamp on the way in and
// every sentence the user reads live in backup.js; this side only reads the
// stores, offers the file and routes each restored piece home.
function paintExportNotice(notice) {
    const el = document.getElementById('exportKeyNotice');
    if (!el) return;
    el.textContent = notice.message;
    el.className = `text-[9px] leading-snug ${notice.tone === 'warn' ? 'text-rose-300' : 'text-slate-400'}`;
}

document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
    // The panel promises the phrase lists, so export what the Audio & Mic tab
    // currently shows (a backup is a copy, so this commits nothing).
    const live = currentVoiceCues();
    const includeKey = document.getElementById('exportIncludeKey')?.checked === true;
    const savedKey = safeGet('handy_connection_key', '') || '';
    const file = buildBackup({
        settings: { ...advancedSettings, voiceCues: live.cues, voiceEncourageSeconds: live.encourageSeconds },
        handyRole: state.handyRole,
        handyMaxCap: state.handyMaxCap,
        handyConnectionKey: savedKey,
        intifaceDevices: safeParse(INTIFACE_STORAGE_KEY, {}),
        tcodeDevices: safeParse(TCODE_STORAGE_KEY, {}),
        ageVerified: safeGet('edgeloop_age_verified') === 'true',
        wizardSeen: safeGet('edgeloop_wizard_seen') === 'true'
    }, { includeKey });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFilename(file);
    // Painted before the download starts, so "this file CONTAINS your key"
    // is on screen (and announced, the notice is a live region) by the time
    // the save dialog asks where to put it - not after it is already on disk.
    paintExportNotice(describeBackupExport(file, { requestedKey: includeKey, hasSavedKey: savedKey.trim().length > 0 }));
    try {
        a.click();
    } catch (err) {
        // The notice is painted first so the key warning is announced
        // before the file exists; if the download never starts, the claim
        // that it did must not be left on screen.
        paintExportNotice({ tone: 'warn', message: 'The download did not start, so nothing was written. Your browser may be blocking downloads from this page.' });
    } finally {
        URL.revokeObjectURL(url);
    }
});

// Everything an import restores that does not live in advancedSettings. A
// file that carries no key never clears the one saved here: restoring
// settings on a paired machine must not break that pairing. Nothing here
// connects anything - that stays behind the user's own click.
// Returns what the browser refused to save and what the merge had to drop,
// so the import can say so instead of announcing a restore that a reload
// undoes. safeSet reports whether the write landed; a full or blocked store
// is a live condition here, since session history is what fills it.
function applyImportedBackup(result) {
    const unsaved = [];
    if (result.keyPresent) {
        if (!safeSet('handy_connection_key', result.handyConnectionKey)) unsaved.push('key');
        const input = document.getElementById('modalHandyInput');
        if (input) input.value = result.handyConnectionKey;
    }
    if (result.handy.role) {
        // The role buttons own the badge and the button painting, so the
        // restored role is applied the way a tap applies it. The write
        // itself happens inside that handler, so it is verified by reading
        // it back: the role is the setting whose loss is worst of all,
        // because boot writes `primary` over a missing one and hands back a
        // live channel the user did not choose.
        const btnId = { primary: 'handyRolePrimaryBtn', secondary: 'handyRoleSecondaryBtn', off: 'handyRoleOffBtn' }[result.handy.role];
        document.getElementById(btnId)?.click();
        if (safeGet('handy_role', '') !== result.handy.role) unsaved.push('role');
    }
    if (result.handy.maxCap !== null) {
        state.handyMaxCap = result.handy.maxCap;
        if (!safeSet('handy_max_cap', String(result.handy.maxCap))) unsaved.push('cap');
        const slider = document.getElementById('handyCapSlider');
        const capVal = document.getElementById('handyCapVal');
        if (slider) slider.value = String(result.handy.maxCap);
        if (capVal) capVal.textContent = `${result.handy.maxCap}%`;
    }
    let droppedDeviceMaps = 0;
    if (Object.keys(result.devices.intiface).length) {
        const existing = safeParse(INTIFACE_STORAGE_KEY, {});
        droppedDeviceMaps += countDroppedOnMerge(existing, result.devices.intiface);
        if (!safeSet(INTIFACE_STORAGE_KEY, mergeDeviceMaps(existing, result.devices.intiface))) unsaved.push('intiface');
    }
    if (Object.keys(result.devices.tcode).length) {
        const existing = safeParse(TCODE_STORAGE_KEY, {});
        droppedDeviceMaps += countDroppedOnMerge(existing, result.devices.tcode);
        if (!safeSet(TCODE_STORAGE_KEY, mergeDeviceMaps(existing, result.devices.tcode))) unsaved.push('tcode');
    }
    // Only ever set: a file that never passed the age gate must not put the
    // overlay back in front of someone who did.
    let flagsRefused = false;
    if (result.flags.ageVerified && !safeSet('edgeloop_age_verified', 'true')) flagsRefused = true;
    if (result.flags.wizardSeen && !safeSet('edgeloop_wizard_seen', 'true')) flagsRefused = true;
    if (flagsRefused) unsaved.push('flags');
    return { unsaved, droppedDeviceMaps };
}

// How many of the file's Session Setup values are still what the file said
// once the app's own clamps have run. A pair like minHr 5 / maxHr 9999 is
// refused by sanitizeSessionLimits and comes back at the factory numbers,
// and "2 values imported" over two defaults is a count of nothing.
// Key order is not a difference: a backup re-serialised by any tool (jq -S,
// json.dump(sort_keys=True)) has the same values in another order, and
// reporting that as "outside what this app accepts" would be nonsense.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
    }
    return value;
}
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function countStoredSettings(fileSettings) {
    let kept = 0;
    for (const [name, value] of Object.entries(fileSettings)) {
        if (name === 'voiceCues') {
            // mergeVoiceCues fills in every bank the file did not mention,
            // so only the banks the file DID carry can be compared. A
            // voiceCues that is not an object at all carries no bank and
            // restored nothing; `[].every()` is true, so it has to be
            // rejected before the comparison, not by it.
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const banks = Object.keys(value);
            // `[].every()` is true, so an empty cue object would count as a
            // restored value while restoring nothing.
            if (!banks.length) continue;
            const live = advancedSettings.voiceCues || {};
            if (banks.every((bank) => sameValue(live[bank], value[bank]))) kept += 1;
            continue;
        }
        if (sameValue(advancedSettings[name], value)) kept += 1;
    }
    return kept;
}

document.getElementById('importConfigFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // A restore reaches the motors: it writes the Handy speed cap, sets the
    // channel role, rewrites the stroke envelope and ticks the engine on the
    // same pass. Picking the file is the commit - there is no preview and no
    // undo - so it is not something to do to a session in progress. Measured
    // before this guard: importing a legitimate backup at 120 BPM took both
    // channels from 48% to 100% between one tick and the next.
    if (state.sessionStatus !== 'IDLE') {
        alert('Stop the session first. Restoring a backup changes the Handy speed cap, the channel roles and the stroke range, and those reach the toys the moment the file is read - not something to do mid-session.');
        e.target.value = '';
        return;
    }
    const reader = new FileReader();
    // A file that vanishes or loses its permission between the pick and the
    // read fires `error`, not `load`. Without this the button does nothing
    // at all, which reads as "the app ignored me".
    reader.onerror = () => alert('That file could not be read. Nothing was changed.');
    reader.onload = (evt) => {
        let parsed;
        try {
            parsed = JSON.parse(evt.target.result);
        } catch {
            // Picking the wrong file is the common mistake, so name that
            // case instead of reporting it as a bad backup.
            alert('That file is not JSON, so it is not an EdgeLoop backup. Pick the .json the Backup tab writes with Export.');
            return;
        }
        try {
            const result = readBackup(parsed);
            // describeBackupImport says which way the file is wrong.
            if (!result.ok) { alert(describeBackupImport(result)); return; }
            const existingKey = safeGet('handy_connection_key', '') || '';
            const hadExistingKey = Boolean(existingKey);
            const keyReplaced = result.keyPresent && hadExistingKey && existingKey !== result.handyConnectionKey;
            // An older build merged every unknown top-level field into the
            // settings store, so a connection key could be sitting in there
            // and ride along in every future export. Clear those names out
            // before merging, and never let the file add one back.
            pruneReservedKeys(advancedSettings);
            // What the store held before the merge, so the message can say
            // whether anything actually changed rather than inferring it
            // from how many values came through untouched.
            const settingsBefore = JSON.stringify(advancedSettings);
            Object.assign(advancedSettings, result.settings);
            syncHwEnvelopeInputs();
            syncWatchdogSettings();
            syncGuardSettings();
            // Counted after the clamps, before the write, so the number the
            // user reads is the number that is actually in the store.
            // One comparison: what the file ASKED for against what the
            // store ended up with. A value the app corrected does not match
            // and is reported as corrected, with no second list to keep in
            // step with this one.
            const settingsStored = countStoredSettings(result.requested);
            // Refusals are reported by part name (see RESTORE_PARTS), so the
            // message cannot name a part as lost and as restored at once.
            const unsaved = persistSettings() ? [] : ['settings'];
            syncParamsUI();
            // Before the engine tick, so a restored Handy speed cap reaches
            // the device on the same pass as the settings it came with.
            const applied = applyImportedBackup(result);
            // Repaints the learning line and ticks the engine, so the panel
            // agrees with the offset the engine has just been handed.
            renderLearningStatus();
            alert(describeBackupImport(result, {
                hadExistingKey,
                keyReplaced,
                settingsStored,
                settingsChanged: JSON.stringify(advancedSettings) !== settingsBefore,
                // The numbers themselves, so "the Handy speed cap" does not
                // leave the reader opening the Handy panel to find out what
                // it now is.
                handyCap: result.handy.maxCap,
                handyRole: result.handy.role,
                droppedDeviceMaps: applied.droppedDeviceMaps,
                unsaved: [...unsaved, ...applied.unsaved]
            }));
        } catch (err) {
            alert(`This backup could not be applied: ${err && err.message ? err.message : 'unknown error'}.`);
        }
    };
    reader.readAsText(file);
    // A file input fires no change event for the same file twice: clear it
    // so importing the same backup again (to revert edits) works.
    e.target.value = '';
});

// Partner Tab Switcher
const partnerTab1on1Btn = document.getElementById('partnerTab1on1Btn');
const partnerTabGroupBtn = document.getElementById('partnerTabGroupBtn');
const partner1on1Section = document.getElementById('partner1on1Section');
const partnerGroupSection = document.getElementById('partnerGroupSection');

partnerTab1on1Btn?.addEventListener('click', () => {
    partnerTab1on1Btn.className = "flex-1 py-1.5 rounded-lg bg-purple-600 text-white transition cursor-pointer";
    if (partnerTabGroupBtn) partnerTabGroupBtn.className = "flex-1 py-1.5 rounded-lg text-slate-400 hover:text-white transition cursor-pointer";
    partner1on1Section?.classList.remove('hidden');
    partnerGroupSection?.classList.add('hidden');
});

partnerTabGroupBtn?.addEventListener('click', () => {
    partnerTabGroupBtn.className = "flex-1 py-1.5 rounded-lg bg-purple-600 text-white transition cursor-pointer";
    if (partnerTab1on1Btn) partnerTab1on1Btn.className = "flex-1 py-1.5 rounded-lg text-slate-400 hover:text-white transition cursor-pointer";
    partnerGroupSection?.classList.remove('hidden');
    partner1on1Section?.classList.add('hidden');
});

// BLE modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'
function setBleStatus(text, tone = 'idle') {
    const el = document.getElementById('modalBleMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs leading-snug ${toneClass}`;
}

function bleBatteryLabel() {
    return state.bleBattery !== null && state.bleBattery !== undefined ? `🔋 ${state.bleBattery}%` : null;
}

function bleBadgeName() {
    return state.hrDeviceName ? state.hrDeviceName.split(' ')[0] : 'HR Monitor';
}

// Tell the user why Web Bluetooth is missing instead of a silent failure.
function warnBluetoothUnsupported() {
    if (navigator.bluetooth) return false;
    setBleStatus(describeBluetoothSupport(navigator.userAgent), 'error');
    // The modal status line explains it; the card keeps the source in use.
    if (!state.simEngaged) setBadgeState('Ble', 'disconnected', 'Unsupported');
    return true;
}

// BLE Hardware Scanning
document.getElementById('modalBleScanBtn')?.addEventListener('click', async () => {
    if (warnBluetoothUnsupported()) return;
    try {
        setBadgeState('Ble', 'connecting', 'Scanning...');
        setBleStatus('Pick your sensor in the browser chooser...', 'busy');
        const dev = await connectBleHeartRate({
            onHrMeasurement: (bpm, info) => {
                recordHrReading(bpm, info ? info.sensorContact : null);
            },
            onBatteryLevel: (bat) => {
                state.bleBattery = bat;
                const batEl = document.getElementById('modalBleBatteryDisplay');
                if (batEl) {
                    batEl.textContent = `Battery: ${bat}%`;
                    batEl.classList.remove('hidden');
                }
                if (isBleConnected()) setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
            },
            onReconnecting: (attempt, maxAttempts) => {
                setBadgeState('Ble', 'connecting', `Reconnecting ${attempt}/${maxAttempts}...`);
                setBleStatus(`Link dropped, reconnecting (attempt ${attempt} of ${maxAttempts})...`, 'busy');
            },
            onReconnected: () => {
                setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
                setBleStatus(`Reconnected to ${state.hrDeviceName || 'the sensor'}.`, 'ok');
            },
            onDisconnected: ({ intentional, attempts }) => {
                const name = state.hrDeviceName || 'Heart-rate monitor';
                state.bleBattery = null;
                setBadgeState('Ble', 'disconnected', intentional ? 'Disconnected' : 'Lost');
                setBleStatus(intentional ? 'Disconnected.' : `${name} dropped and did not answer ${attempts} reconnect attempts.`, intentional ? 'idle' : 'error');
                document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
                document.getElementById('modalBleBatteryDisplay')?.classList.add('hidden');
                const devName = document.getElementById('modalBleDeviceName');
                if (devName) devName.textContent = 'No device paired';
                document.getElementById('hrContactHint')?.classList.add('hidden');
                state.hrNoContact = false;
                if (!state.simEngaged) document.getElementById('hrWarningTag')?.classList.remove('hidden');
                const sessionLive = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
                if (intentional) {
                    if (sessionLive) triggerDisconnectAlert(`${name} (heart-rate monitor) was disconnected. Motors paused for safety.`);
                } else {
                    const silentMs = Math.max(0, Date.now() - (hrWatchdog.lastValidAt || Date.now()));
                    triggerDisconnectAlert(`${name} (heart-rate monitor) dropped and did not answer ${attempts} reconnect attempts; no reading for ${Math.round(silentMs / 1000)} s. Motors paused for safety.`);
                    // A drop is a signal loss too: once the sensor is paired
                    // again and readings return, the session may auto-resume.
                    if (sessionLive && state.sessionStatus === 'PAUSED') {
                        state.hrSignalPaused = true;
                        state.hrSignalState = 'stale';
                        state.hrSignalSilentMs = silentMs;
                        renderHrSignal({ status: 'stale', noContact: false, sinceValidMs: silentMs });
                    }
                }
                syncTelemetry();
            }
        });

        state.hrDeviceName = dev.name || 'Bluetooth HR Monitor';
        const devName = document.getElementById('modalBleDeviceName');
        if (devName) devName.textContent = state.hrDeviceName;
        document.getElementById('modalBleDisconnectBtn')?.classList.remove('hidden');
        setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
        setBleStatus(`Connected to ${state.hrDeviceName}.`, 'ok');
        document.getElementById('hrWarningTag')?.classList.add('hidden');
        document.getElementById('simActiveTag')?.classList.add('hidden');
        state.simEngaged = false;
        // Fresh grace window: the first packet may take a few seconds.
        hrWatchdog.reset(Date.now());
        state.hrNoContact = false;
        document.getElementById('hrContactHint')?.classList.add('hidden');
        closeModal();
        checkReadiness();
        syncTelemetry();
    } catch (e) {
        const described = describeBleError(e);
        setBleStatus(described.message, described.kind === 'cancelled' ? 'idle' : 'error');
        if (isBleConnected()) {
            // The chooser was closed before anything changed: the previous
            // sensor is still linked and keeps its badge.
            setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
        } else {
            // A re-scan drops the previous link before subscribing to the new
            // sensor, so a failure here leaves no pulse source at all, unless
            // the simulator is engaged and keeps driving the session.
            if (state.simEngaged) setBadgeState('Ble', 'connected', 'Simulator', null);
            else setBadgeState('Ble', 'disconnected', described.kind === 'cancelled' ? 'Disconnected' : 'Failed');
            document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
            document.getElementById('modalBleBatteryDisplay')?.classList.add('hidden');
            const devName = document.getElementById('modalBleDeviceName');
            if (devName) devName.textContent = 'No device paired';
            if (!state.simEngaged) {
                document.getElementById('hrWarningTag')?.classList.remove('hidden');
                if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
                    triggerDisconnectAlert(`${state.hrDeviceName || 'Heart-rate monitor'} was released for a new pairing that failed (${described.message}). Motors paused for safety.`);
                }
            }
            checkReadiness();
            syncTelemetry();
        }
    }
});
document.getElementById('modalBleDisconnectBtn')?.addEventListener('click', () => disconnectBle());

// Manual Simulation
const modalSimSlider = document.getElementById('modalSimHrSlider');
const modalSimVal = document.getElementById('modalSimHrVal');
modalSimSlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (modalSimVal) modalSimVal.textContent = `${val} BPM`;
    if (state.simEngaged) recordHrReading(val, true);
});

document.getElementById('modalEngageSimBtn')?.addEventListener('click', () => {
    // A real sensor still linked would fight the slider: drop it quietly.
    disconnectBle({ silent: true });
    state.simEngaged = true;
    state.hrDeviceName = 'Simulator';
    hrWatchdog.reset(Date.now());
    renderHrSignal(null);
    // A session the watchdog paused stays paused: the slider's first sample
    // is not a returning pulse, the user presses RESUME when ready.
    if (state.hrSignalPaused) holdAfterSignalReturn();
    recordHrReading(parseInt(modalSimSlider?.value || 70, 10), true);
    document.getElementById('simActiveTag')?.classList.remove('hidden');
    document.getElementById('hrWarningTag')?.classList.add('hidden');
    document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
    setBadgeState('Ble', 'connected', 'Simulator', null);
    closeModal();
    checkReadiness();
    updateEngine();
    syncTelemetry();
});

// The Handy Connection
const handyInput = document.getElementById('modalHandyInput');
if (handyInput) handyInput.value = safeGet('handy_connection_key', '') || '';
let handyConnectedLabel = 'The Handy';

// Modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'
function setHandyStatus(text, tone = 'idle') {
    const el = document.getElementById('modalHandyMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs ${toneClass}`;
}

function handyBatteryLabel() {
    return state.handyBattery !== null && state.handyBattery !== undefined ? `🔋 ${state.handyBattery}%` : null;
}

setHandyHandlers({
    isSessionActive: () => state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN',
    onError: (message) => {
        if (!handyConnected) return;
        if (message) {
            const short = message.length > 70 ? `${message.slice(0, 67)}...` : message;
            setHandyStatus(`API error: ${short}`, 'error');
            setBadgeState('Handy', 'warning', 'API Error', handyBatteryLabel());
        } else {
            setHandyStatus(handyConnectedLabel, 'ok');
            setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        }
    },
    onOffline: (reason) => {
        state.handyBattery = null;
        setHandyStatus('Offline', 'error');
        setBadgeState('Handy', 'disconnected', 'Offline');
        document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
        // Pauses the session and issues a stop to every other toy.
        triggerDisconnectAlert(reason || 'The Handy went offline. Motors paused for safety.');
    },
    // Something the device told us that is worth reading and is not a fault.
    onNotice: (message) => {
        if (!handyConnected || !message) return;
        setHandyStatus(message, 'busy');
    },
    // Not gated on handyConnected: the Disconnect and offline paths drop the
    // link before their stop resolves, and an unconfirmed stop there is the
    // one thing the user must hear about.
    onStopUnconfirmed: (message) => {
        setHandyStatus(message, 'error');
        setBadgeState('Handy', handyConnected ? 'warning' : 'disconnected', 'Stop unconfirmed', handyConnected ? handyBatteryLabel() : null);
        triggerDisconnectAlert(`The Handy did not confirm a stop and may still be moving: check the device. (${message})`);
    }
});

// One connect at a time; a second click while a key is being verified is ignored.
let handyConnectInFlight = false;

document.getElementById('modalHandyConnectBtn')?.addEventListener('click', async () => {
    const key = handyInput?.value.trim() || '';
    if (!key) {
        setHandyStatus('Enter your Handy Connection Key first.', 'error');
        return;
    }
    if (handyConnectInFlight) return;
    handyConnectInFlight = true;
    safeSet('handy_connection_key', key);
    // A live link is only replaced once the new key has been verified and
    // the connected device has confirmed a stop (see connectHandy); until
    // then it keeps driving, and stopping, the toy.
    const wasConnected = handyConnected;
    setHandyStatus(wasConnected ? 'Verifying the key, then stopping the connected Handy...' : 'Connecting...', 'busy');
    setBadgeState('Handy', 'connecting', wasConnected ? 'Reconnecting...' : 'Connecting...');

    try {
        const result = await connectHandy(key);
        state.handyBattery = result.battery;
        handyConnectedLabel = result.description ? `Connected (${result.description})` : 'Connected';
        setHandyStatus(handyConnectedLabel, 'ok');
        setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        document.getElementById('modalHandyDisconnectBtn')?.classList.remove('hidden');
        closeModal();
        syncTelemetry();
    } catch (e) {
        const message = e && e.message ? e.message : 'Connection failed';
        if (handyConnected) {
            // The new key was refused or the live device would not stop: the
            // previous link is untouched and still owns the toy.
            setHandyStatus(`${message} The current connection is unchanged.`, 'error');
            setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        } else {
            state.handyBattery = null;
            setHandyStatus(message, 'error');
            setBadgeState('Handy', 'disconnected', 'Offline');
            if (wasConnected) triggerDisconnectAlert('The Handy connection was lost while reconnecting. Motors paused for safety.');
        }
    } finally {
        handyConnectInFlight = false;
    }
});

document.getElementById('modalHandyDisconnectBtn')?.addEventListener('click', async () => {
    // The link drops at once; the verified stop it sends is awaited so the
    // modal can say whether the device confirmed it.
    const stopped = disconnectHandy();
    state.handyBattery = null;
    setHandyStatus('Stopping the device...', 'busy');
    setBadgeState('Handy', 'disconnected', 'Stopping...');
    document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
    triggerDisconnectAlert("The Handy disconnected.");
    const ok = await stopped.catch(() => false);
    // Reconnected meanwhile: the new link owns the modal and the badge.
    if (handyConnected) return;
    if (ok) {
        setHandyStatus('Offline', 'idle');
        setBadgeState('Handy', 'disconnected', 'Disconnected');
    } else {
        setHandyStatus('Disconnected, but the stop was not confirmed: check that The Handy is not moving.', 'error');
        setBadgeState('Handy', 'disconnected', 'Stop unconfirmed');
    }
});

// Best effort: a keepalive stop to The Handy when the page goes away or is
// frozen. The motor is driven through the cloud and cannot notice that the
// app is gone, so this is the only stop it would ever get.
window.addEventListener('pagehide', () => { stopHandyOnUnload(); });
document.addEventListener('freeze', () => { stopHandyOnUnload(); });

// Intiface Central WebSocket. The driver reports its state through
// onStatus; the modal label, the summary badge and the buttons follow it.
const intifaceStatusColors = {
    offline: 'text-rose-400',
    connecting: 'text-amber-400',
    handshake: 'text-amber-400',
    connected: 'text-emerald-400',
    error: 'text-rose-400'
};

function renderIntifaceStatus(status) {
    const label = document.getElementById('modalIntifaceStatusText');
    if (label) {
        label.textContent = status.text;
        label.className = `text-[10px] font-mono text-right max-w-[60%] break-words ${intifaceStatusColors[status.state] || 'text-slate-400'}`;
    }
    const connectBtn = document.getElementById('modalIntifaceConnectBtn');
    const disconnectBtn = document.getElementById('modalIntifaceDisconnectBtn');
    const rescanBtn = document.getElementById('modalIntifaceRescanBtn');
    const busy = status.state === 'connecting' || status.state === 'handshake';
    const connected = status.state === 'connected';
    if (connectBtn) {
        connectBtn.disabled = busy;
        connectBtn.classList.toggle('opacity-50', busy);
        connectBtn.classList.toggle('cursor-not-allowed', busy);
        connectBtn.classList.toggle('hidden', connected);
        connectBtn.textContent = busy ? 'Connecting...' : 'Connect';
    }
    disconnectBtn?.classList.toggle('hidden', !(connected || busy));
    rescanBtn?.classList.toggle('hidden', !connected);
    renderIntifaceSummaryBadge();
}

document.getElementById('modalIntifaceConnectBtn')?.addEventListener('click', () => {
    const url = document.getElementById('modalIntifaceUrl')?.value.trim() || DEFAULT_INTIFACE_URL;
    connectIntifaceServer(url, {
        onStatus: renderIntifaceStatus,
        onDevicesChanged: () => {
            renderIntifaceDevices();
            syncTelemetry();
        },
        onError: () => {
            // The status label already carries the text; a failed connect
            // attempt must not pause a session running on other hardware.
        },
        onClose: ({ wasConnected, assignedDevices, intentional }) => {
            renderIntifaceDevices();
            syncTelemetry();
            if (!wasConnected || assignedDevices === 0) return;
            const toys = `${assignedDevices} assigned toy${assignedDevices === 1 ? '' : 's'}`;
            triggerDisconnectAlert(intentional
                ? `Intiface Central disconnected with ${toys} in use. Motors paused for safety.`
                : `Intiface Central connection lost: ${toys} unreachable. Motors paused for safety.`);
        }
    });
});
document.getElementById('modalIntifaceDisconnectBtn')?.addEventListener('click', () => disconnectIntiface());
document.getElementById('modalIntifaceRescanBtn')?.addEventListener('click', () => {
    rescanIntiface();
    renderIntifaceDevices();
});
document.getElementById('modalIntifaceSaveBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('modalIntifaceSaveBtn');
    const saved = saveIntifaceConfig();
    if (btn) {
        btn.textContent = saved ? 'Saved' : 'Could not save (storage full or blocked)';
        setTimeout(() => { btn.textContent = 'Save & Apply Configuration'; }, 1500);
    }
    renderIntifaceSummaryBadge();
    syncTelemetry();
    if (saved) setTimeout(closeModal, 600);
});

// Best effort: stop every Intiface toy when the page goes away.
window.addEventListener('pagehide', () => { stopAllIntiface(); });

window.setDeviceRole = (devIdx, axisIdx, role) => {
    setAxisRole(devIdx, axisIdx, role);
    renderIntifaceDevices();
    syncTelemetry();
};

window.setDeviceCap = (devIdx, axisIdx, val) => {
    setAxisMaxCap(devIdx, axisIdx, parseInt(val, 10));
    const el = document.getElementById(`capVal_${devIdx}_${axisIdx}`);
    if (el) el.textContent = `${val}%`;
    syncTelemetry();
};

window.setDeviceInvert = (devIdx, axisIdx, checked) => {
    setAxisInvert(devIdx, axisIdx, Boolean(checked));
};

window.setDeviceReverseOnEdge = (devIdx, checked) => {
    setDeviceRotation(devIdx, { reverseOnEdge: Boolean(checked) });
};

window.setDeviceAlternate = (devIdx, val) => {
    setDeviceRotation(devIdx, { alternateSeconds: parseInt(val, 10) || 0 });
};

window.testAxis = (devIdx, axisIdx) => testSingleAxis(devIdx, axisIdx);

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderIntifaceDevices() {
    const list = document.getElementById('modalIntifaceList');
    if (!list) return;
    if (intifaceDevices.size === 0) {
        let hint = 'Connect to Intiface server to detect your toys.';
        if (isIntifaceConnected()) {
            hint = isIntifaceScanning()
                ? 'Scanning... Power on your toys.'
                : 'No toys found. Power them on and tap Re-Scan Toys.';
        }
        list.innerHTML = `<div class="p-3 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs italic text-center">${hint}</div>`;
        renderIntifaceSummaryBadge();
        return;
    }
    list.innerHTML = '';
    intifaceDevices.forEach((dev, devIdx) => {
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs';
        const batText = dev.hasBattery ? (dev.battery !== null ? `🔋 ${dev.battery}%` : '🔋 Reading...') : '🔋 N/A';

        let axisRows = '';
        dev.axes.forEach((axis, aIdx) => {
            const label = axis.descriptor ? `${escapeHtml(axis.type)} - ${escapeHtml(axis.descriptor)}` : escapeHtml(axis.type);
            const failing = axis.failing
                ? `<span class="text-[9px] font-bold text-rose-400 bg-rose-950/60 border border-rose-800 px-1 rounded" title="Intiface rejected the last 3 commands to this axis">Not responding</span>`
                : '';
            const invertRow = axis.kind === 'linear' ? `
            <label class="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-slate-800/60 cursor-pointer">
            <span>Invert direction (sleeve mounted upside down)</span>
            <input type="checkbox" ${axis.invert ? 'checked' : ''} onchange="setDeviceInvert(${devIdx}, ${aIdx}, this.checked)" class="accent-amber-500 cursor-pointer">
            </label>` : '';
            axisRows += `
            <div class="bg-slate-900 p-2 rounded-lg border ${axis.failing ? 'border-rose-800' : 'border-slate-800'} space-y-1.5 text-[10px]">
            <div class="flex justify-between items-center gap-1">
            <span class="font-bold text-slate-300 truncate">Axis ${axis.index} (${label})</span>
            <span class="flex items-center gap-1 shrink-0">${failing}
            <button onclick="testAxis(${devIdx}, ${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer">Test</button></span>
            </div>
            <div class="flex gap-1">
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'primary')" class="flex-1 py-1 rounded ${axis.role === 'primary' ? 'bg-rose-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Primary</button>
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'secondary')" class="flex-1 py-1 rounded ${axis.role === 'secondary' ? 'bg-purple-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Secondary</button>
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'off')" class="flex-1 py-1 rounded ${axis.role === 'off' ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">OFF</button>
            </div>
            <div class="space-y-0.5 pt-1 border-t border-slate-800/60">
            <div class="flex justify-between text-[9px] text-slate-400">
            <span>Max Power Cap:</span>
            <span id="capVal_${devIdx}_${aIdx}" class="font-bold font-mono text-amber-400">${axis.maxCap ?? 100}%</span>
            </div>
            <input type="range" min="10" max="100" step="5" value="${axis.maxCap ?? 100}" oninput="setDeviceCap(${devIdx}, ${aIdx}, this.value)" class="w-full accent-amber-500 h-1 bg-slate-800 rounded cursor-pointer">
            </div>
            ${invertRow}
            </div>
            `;
        });

        let rotationRow = '';
        if (dev.axes.some((a) => a.kind === 'rotate')) {
            let options = `<option value="0" ${!dev.alternateSeconds ? 'selected' : ''}>Off</option>`;
            for (let sec = ALTERNATE_SECONDS_MIN; sec <= ALTERNATE_SECONDS_MAX; sec += 5) {
                options += `<option value="${sec}" ${dev.alternateSeconds === sec ? 'selected' : ''}>${sec} s</option>`;
            }
            rotationRow = `
            <div class="bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1.5 text-[10px]">
            <div class="font-bold text-slate-300">Rotation</div>
            <label class="flex items-center justify-between text-[9px] text-slate-400 cursor-pointer">
            <span>Reverse direction on every edge</span>
            <input type="checkbox" ${dev.reverseOnEdge !== false ? 'checked' : ''} onchange="setDeviceReverseOnEdge(${devIdx}, this.checked)" class="accent-purple-500 cursor-pointer">
            </label>
            <label class="flex items-center justify-between text-[9px] text-slate-400">
            <span>Alternate direction every</span>
            <select onchange="setDeviceAlternate(${devIdx}, this.value)" class="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[9px] text-slate-200 cursor-pointer">${options}</select>
            </label>
            <p class="text-[9px] text-slate-500">Direction never changes more than once per second.</p>
            </div>`;
        }

        item.innerHTML = `
        <div class="flex justify-between items-center font-bold text-slate-200">
        <span class="truncate">${escapeHtml(dev.displayName || dev.name)}</span>
        <span class="text-[9px] font-mono text-emerald-400 shrink-0">${batText}</span>
        </div>
        <div class="space-y-1">${axisRows}${rotationRow}</div>
        `;
        list.appendChild(item);
    });
    renderIntifaceSummaryBadge();
}

function renderIntifaceSummaryBadge() {
    const status = getIntifaceStatus();
    if (!isIntifaceConnected()) {
        const busy = status.state === 'connecting' || status.state === 'handshake';
        let label = 'Disconnected';
        if (busy) label = status.state === 'handshake' ? 'Handshake...' : 'Connecting...';
        else if (status.state === 'error') label = 'Error';
        setBadgeState('Intiface', busy ? 'connecting' : 'disconnected', label, null);
        return;
    }
    if (intifaceDevices.size === 0) {
        setBadgeState('Intiface', 'connected', isIntifaceScanning() ? 'Scanning...' : '0 Toys Ready', null);
        return;
    }
    const firstToy = Array.from(intifaceDevices.values())[0];
    let nameLabel = (firstToy.displayName || firstToy.name).split(' ')[0];
    if (intifaceDevices.size > 1) nameLabel += ` +${intifaceDevices.size - 1}`;
    const assigned = countAssignedIntifaceDevices();
    if (assigned === 0) nameLabel += ' (all OFF)';
    const failing = Array.from(intifaceDevices.values()).some((d) => d.axes.some((a) => a.failing));
    setBadgeState('Intiface', failing ? 'warning' : 'connected', failing ? `${nameLabel} - errors` : nameLabel, firstToy.battery !== null ? `🔋 ${firstToy.battery}%` : null);
}

// TCode Serial (Web Serial). The driver reports its state through onStatus;
// the modal label, the summary badge and the buttons follow it.
function warnSerialUnsupported() {
    if (isSerialSupported()) return false;
    renderTCodeStatus({ state: 'error', text: describeSerialSupport(navigator.userAgent, window.isSecureContext !== false) });
    setBadgeState('TCode', 'disconnected', 'Unsupported');
    return true;
}

function renderTCodeStatus(status) {
    const label = document.getElementById('modalTCodeStatusText');
    if (label) {
        label.textContent = status.text;
        label.className = `text-[10px] font-mono text-right max-w-[70%] break-words ${intifaceStatusColors[status.state] || 'text-slate-400'}`;
    }
    const connectBtn = document.getElementById('modalTCodeConnectBtn');
    const disconnectBtn = document.getElementById('modalTCodeDisconnectBtn');
    const busy = status.state === 'connecting' || status.state === 'handshake';
    const connected = status.state === 'connected';
    if (connectBtn) {
        connectBtn.disabled = busy;
        connectBtn.classList.toggle('opacity-50', busy);
        connectBtn.classList.toggle('cursor-not-allowed', busy);
        connectBtn.classList.toggle('hidden', connected);
        connectBtn.textContent = busy ? 'Connecting...' : 'Connect';
    }
    disconnectBtn?.classList.toggle('hidden', !(connected || busy));
    renderTCodeSummaryBadge();
}

setTCodeHandlers({
    onStatus: renderTCodeStatus,
    onDevicesChanged: () => {
        renderTCodeDevice();
        syncTelemetry();
    },
    onError: () => {
        // The status label carries the text; the driver closes the port
        // itself and onClose decides whether the session must pause.
    },
    onClose: ({ wasConnected, assignedAxes, intentional }) => {
        renderTCodeDevice();
        syncTelemetry();
        if (!wasConnected || assignedAxes === 0) return;
        const axes = `${assignedAxes} assigned ax${assignedAxes === 1 ? 'is' : 'es'}`;
        triggerDisconnectAlert(intentional
            ? `TCode Serial device disconnected with ${axes} in use. Motors paused for safety.`
            : `TCode Serial device lost: ${axes} unreachable. Motors paused for safety.`);
    }
});

document.getElementById('modalTCodeConnectBtn')?.addEventListener('click', () => {
    if (warnSerialUnsupported()) return;
    // requestPort needs the click's user activation: call straight away.
    // The modal stays open so the identified axes can be checked with Test.
    connectTCode().then(() => syncTelemetry()).catch(() => {});
});
document.getElementById('modalTCodeDisconnectBtn')?.addEventListener('click', () => {
    disconnectTCode().catch(() => {});
});

// Best effort: rest every axis when the page goes away.
window.addEventListener('pagehide', () => { stopTCode(); });

window.setTCodeRole = (axisIdx, role) => {
    setTCodeAxisRole(axisIdx, role);
    renderTCodeDevice();
    syncTelemetry();
};

window.setTCodeCap = (axisIdx, val) => {
    setTCodeAxisCap(axisIdx, parseInt(val, 10));
    const el = document.getElementById(`tcodeCapVal_${axisIdx}`);
    if (el) el.textContent = `${val}%`;
};

window.setTCodeInvert = (axisIdx, checked) => {
    setTCodeAxisInvert(axisIdx, Boolean(checked));
};

window.testTCodeAxis = (axisIdx) => testTCodeAxis(axisIdx);

function renderTCodeDevice() {
    const list = document.getElementById('modalTCodeList');
    const info = document.getElementById('modalTCodeInfo');
    if (!list) return;
    const dev = isTCodeConnected() ? getTCodeDevice() : null;
    if (info) {
        if (dev) {
            info.textContent = `${dev.name}${dev.version ? ` - ${dev.version}` : ''}${dev.identified ? '' : ' (no reply to D0/D1/D2: assuming the OSR2 axis set)'}`;
            info.classList.remove('hidden');
        } else {
            info.textContent = 'No device';
            info.classList.add('hidden');
        }
    }
    if (!dev) {
        list.innerHTML = `<div class="p-3 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs italic text-center">Connect to list the device axes.</div>`;
        renderTCodeSummaryBadge();
        return;
    }
    list.innerHTML = '';
    dev.axes.forEach((axis, aIdx) => {
        const kindLabel = axis.kind === 'linear' ? 'Linear' : axis.kind === 'rotate' ? 'Rotate' : axis.kind === 'vibe' ? 'Vibe' : 'Aux';
        const invertRow = axis.kind === 'linear' ? `
        <label class="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-slate-800/60 cursor-pointer">
        <span>Invert direction (sleeve mounted upside down)</span>
        <input type="checkbox" ${axis.invert ? 'checked' : ''} onchange="setTCodeInvert(${aIdx}, this.checked)" class="accent-amber-500 cursor-pointer">
        </label>` : '';
        const item = document.createElement('div');
        item.className = 'bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1.5 text-[10px]';
        item.innerHTML = `
        <div class="flex justify-between items-center gap-1">
        <span class="font-bold text-slate-300 truncate">${escapeHtml(axis.id)} - ${escapeHtml(axis.description)} <span class="font-normal text-slate-500">(${kindLabel})</span></span>
        <button onclick="testTCodeAxis(${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer shrink-0">Test</button>
        </div>
        <div class="flex gap-1">
        <button onclick="setTCodeRole(${aIdx}, 'primary')" class="flex-1 py-1 rounded ${axis.role === 'primary' ? 'bg-rose-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Primary</button>
        <button onclick="setTCodeRole(${aIdx}, 'secondary')" class="flex-1 py-1 rounded ${axis.role === 'secondary' ? 'bg-purple-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Secondary</button>
        <button onclick="setTCodeRole(${aIdx}, 'off')" class="flex-1 py-1 rounded ${axis.role === 'off' ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">OFF</button>
        </div>
        <div class="space-y-0.5 pt-1 border-t border-slate-800/60">
        <div class="flex justify-between text-[9px] text-slate-400">
        <span>Max cap:</span>
        <span id="tcodeCapVal_${aIdx}" class="font-bold font-mono text-amber-400">${axis.maxCap ?? 100}%</span>
        </div>
        <input type="range" min="10" max="100" step="5" value="${axis.maxCap ?? 100}" oninput="setTCodeCap(${aIdx}, this.value)" class="w-full accent-amber-500 h-1 bg-slate-800 rounded cursor-pointer">
        </div>
        ${invertRow}
        `;
        list.appendChild(item);
    });
    renderTCodeSummaryBadge();
}

function renderTCodeSummaryBadge() {
    const status = getTCodeStatus();
    if (!isTCodeConnected()) {
        const busy = status.state === 'connecting' || status.state === 'handshake';
        let label = 'Disconnected';
        if (busy) label = status.state === 'handshake' ? 'Identifying...' : 'Connecting...';
        else if (status.state === 'error') label = isSerialSupported() ? 'Error' : 'Unsupported';
        setBadgeState('TCode', busy ? 'connecting' : 'disconnected', label, null);
        return;
    }
    const dev = getTCodeDevice();
    let nameLabel = dev ? dev.name.split(' ')[0] : 'TCode';
    const assigned = countAssignedTCodeAxes();
    if (assigned === 0) nameLabel += ' (all OFF)';
    setBadgeState('TCode', 'connected', nameLabel, null);
}

// Session History & Funscript Downloader Hook
function saveSessionToHistory(outcome) {
    const history = safeParse('edgeloop_history', []);
    const sessionId = Date.now();
    history.unshift({
        id: sessionId,
        date: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: state.sessionSeconds,
        edges: state.edges,
        pauses: state.pauses,
        peakHr: state.peakHr,
        outcome,
        // Raw 4 Hz timeline; both funscripts are built from it on download.
        samples: [...funscriptSamples]
    });
    while (history.length > 10) history.pop();
    const result = saveHistoryTrimmed('edgeloop_history', history);
    if (!result.saved) {
        console.warn('Session history could not be saved (storage full or unavailable)');
    } else if (result.dropped > 0 || result.stripped) {
        console.warn(`Storage quota reached: dropped ${result.dropped} oldest session(s)${result.stripped ? ' and the motion trace of this one' : ''}`);
    }
}

// Build the requested channel script for a stored session. New entries carry
// the raw sample timeline; entries written by older versions carry
// pre-built primaryActions / secondaryActions and are exported as-is.
function funscriptForSession(session, channel) {
    if (Array.isArray(session.samples) && session.samples.length > 0) {
        const both = buildFunscripts(session.samples);
        return channel === 'primary' ? both.primary : both.secondary;
    }
    const legacy = channel === 'primary' ? session.primaryActions : session.secondaryActions;
    return toFunscript(Array.isArray(legacy) ? legacy : []);
}

window.downloadFunscript = (sessionId, channel) => {
    const history = safeParse('edgeloop_history', []);
    const session = history.find(s => s.id === sessionId);
    if (!session) return alert("Session log not found.");

    const funscriptPayload = funscriptForSession(session, channel);
    if (funscriptPayload.actions.length === 0) return alert("No motion recorded for this channel during this session.");

    const blob = new Blob([JSON.stringify(funscriptPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = channel === 'primary' ? '.funscript' : '.v0.funscript';
    a.href = url;
    a.download = `edgeloop_${sessionId}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

function renderHistory() {
    const history = safeParse('edgeloop_history', []);
    const list = document.getElementById('historyList');
    if (!list) return;
    if (history.length === 0) {
        list.innerHTML = `<div class="p-4 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs text-center italic">No completed sessions recorded yet.</div>`;
        return;
    }
    list.innerHTML = '';
    history.forEach((s, idx) => {
        const mins = Math.floor(s.duration / 60);
        const secs = s.duration % 60;
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs';
        item.innerHTML = `
        <div>
        <div class="font-bold text-slate-200">#${idx + 1} — ${s.date}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">⏱ ${mins}m ${secs}s &bull; ⚡ ${s.edges} Edges &bull; 🔥 ${s.peakHr} BPM &bull; <span class="text-purple-300 font-semibold">${s.outcome}</span></div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
        <button onclick="downloadFunscript(${s.id}, 'primary')" class="px-2 py-1 bg-purple-950 hover:bg-purple-800 border border-purple-700 text-purple-200 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Primary Stroker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .funscript
        </button>
        <button onclick="downloadFunscript(${s.id}, 'secondary')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Secondary Milker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .v0.funscript
        </button>
        </div>
        `;
        list.appendChild(item);
    });
}
document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    safeRemove('edgeloop_history');
    renderHistory();
});

// Partner WebRTC Sync (host side): one controller plus any number of
// read-only viewers. Commands arrive already validated by peer-messages.js.
function setPartnerStatus(text, tone = 'wait') {
    const status = document.getElementById('partnerStatusText');
    if (!status) return;
    status.textContent = text;
    status.className = tone === 'ok' ? 'font-bold text-emerald-400'
        : tone === 'error' ? 'font-bold text-rose-400'
        : 'font-bold text-amber-400';
}

// Header badge ("1C+2V") and the Share modal's viewer list, counted apart.
function renderPeerCounts() {
    const counts = getPeerCounts();
    const badge = document.getElementById('shareControlBadge');
    if (badge) {
        const parts = [];
        if (counts.controllers > 0) parts.push(`${counts.controllers}C`);
        if (counts.viewers > 0) parts.push(`${counts.viewers}V`);
        badge.textContent = parts.join('+');
        badge.title = `${counts.controllers} controller, ${counts.viewers} viewer(s) connected`;
        badge.classList.toggle('hidden', parts.length === 0);
    }
    const viewerBadge = document.getElementById('groupViewerCountBadge');
    if (viewerBadge) viewerBadge.textContent = `${counts.viewers} Watching`;
    const viewerList = document.getElementById('groupViewersList');
    if (viewerList) {
        viewerList.textContent = counts.viewers > 0
            ? `${counts.viewers} read-only viewer(s) receiving live telemetry.`
            : 'No viewers currently connected.';
    }
}

function setupPartnerHost() {
    if (!peerLibraryAvailable()) {
        setPartnerStatus('Signalling library not loaded (CDN blocked or offline). Remote control is unavailable.', 'error');
        ['partnerShareUrl', 'groupShareUrl'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = 'Unavailable: the PeerJS library could not be loaded';
        });
        return;
    }
    initHostPeer({
        onPeerReady: (id) => {
            const share = document.getElementById('partnerShareUrl');
            const group = document.getElementById('groupShareUrl');
            if (share) share.value = `${window.location.origin}${window.location.pathname}?partner=${id}`;
            if (group) group.value = `${window.location.origin}${window.location.pathname}?group_sub=${id}`;
            // Also fires after a signalling reconnect: keep a live controller shown as such.
            if (getPeerCounts().controllers > 0) setPartnerStatus('Controller Connected', 'ok');
            else setPartnerStatus('Ready (Awaiting Controller)');
            renderPeerCounts();
        },
        onPartnerConnected: () => {
            setPartnerStatus('Controller Connected', 'ok');
            renderPeerCounts();
            syncTelemetry();
        },
        onControllerDisconnected: (reason) => {
            setPartnerStatus(reason === 'timeout' ? 'Partner disconnected (no response)' : 'Partner disconnected', 'error');
            renderPeerCounts();
        },
        onViewerConnected: () => {
            renderPeerCounts();
            syncTelemetry();
        },
        onViewerDisconnected: () => renderPeerCounts(),
        onCountsChanged: () => renderPeerCounts(),
        onSignallingLost: () => setPartnerStatus('Signalling lost, reconnecting...', 'error'),
        onPeerClosed: () => {
            setPartnerStatus('Signalling closed. Reopen Share Control to create a new room.', 'error');
            renderPeerCounts();
        },
        onPeerError: (message) => {
            setPartnerStatus(`Signalling error: ${message}`, 'error');
            renderPeerCounts();
        },
        onCommandReceived: (cmd) => {
            if (cmd.type === 'SESSION_STATE') {
                const hostActive = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
                if (cmd.status === 'RUNNING' && !hostActive) playPauseBtn?.click();
                else if (cmd.status === 'PAUSED' && hostActive) playPauseBtn?.click();
                else if (cmd.status === 'IDLE') stopBtn?.click();
            } else if (cmd.type === 'SESSION_RESET') resetBtn?.click();
            else if (cmd.type === 'ORGASM_TOGGLE') orgasmBtn?.click();
            else if (cmd.type === 'MODE_CHANGE') {
                applyModeSelection(cmd.mode, cmd.enabled);
                syncTelemetry();
            }
        }
    });
}

// ---- Remote page (controller or viewer) ----------------------------------

// A viewer page renders everything but can change nothing. Re-applied after
// every telemetry frame because some renderers reset element classes.
const VIEWER_LOCKED_IDS = [
    'sessionPlayPauseBtn', 'sessionStopBtn', 'sessionResetBtn', 'cameEarlyBtn', 'orgasmBtn',
    'intensitySlider', 'openParamsBtn', 'sessionParamsHeaderBtn',
    'partnerShareBtn', 'historyBtn', 'cardBle', 'cardHandy', 'cardIntiface', 'cardTCode',
    // Nested in the Edge Training card: a disabled ancestor does not stop a
    // browser from focusing and editing them, so they are disabled themselves.
    'trainHoldSecondsInput', 'trainEdgesInput', 'calibrateBtn'
];
function lockElement(el) {
    if (!el) return;
    el.disabled = true;
    el.setAttribute('aria-disabled', 'true');
    el.classList.remove('cursor-pointer');
    el.classList.add('opacity-60', 'cursor-not-allowed');
}
function lockViewerControls() {
    VIEWER_LOCKED_IDS.forEach((id) => lockElement(document.getElementById(id)));
    modeCards.forEach(lockElement);
}

// A controller page sends transport, Force Orgasm and mode commands only.
// Everything else is host-only (its handlers return or its state never
// leaves the page), so it is locked rather than left looking clickable.
const CONTROLLER_LOCKED_IDS = [
    'cameEarlyBtn', 'intensitySlider', 'openParamsBtn', 'sessionParamsHeaderBtn',
    'partnerShareBtn', 'cardBle', 'cardHandy', 'cardIntiface', 'cardTCode',
    // The mode cards stay live (MODE_CHANGE is a legal command), but the two
    // Edge Training numbers inside one of them are host-only settings.
    'trainHoldSecondsInput', 'trainEdgesInput', 'calibrateBtn'
];
function lockControllerControls() {
    CONTROLLER_LOCKED_IDS.forEach((id) => lockElement(document.getElementById(id)));
}

// Re-applied after every telemetry frame because some renderers reset classes.
function lockRemoteControls() {
    if (isRemoteViewer) lockViewerControls();
    else if (isRemoteController) lockControllerControls();
}

// The typed limits belong to the host: on a remote page the inputs only
// mirror what the host reports.
function lockRemoteLimitInputs() {
    ['maxHr', 'dualMaxHr'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = true;
        input.title = 'Set by the host';
        input.classList.add('opacity-70');
    });
}

let lastTelemetryAt = 0;
let remoteLinkUp = false;

function showRemoteBanner(message) {
    showAlertBanner(message, { severity: 'safety', source: 'remote' });
}

// Telemetry arrives every second; a long silence with the channel still
// nominally open means the host is gone.
const REMOTE_TELEMETRY_STALE_MS = 10000;
function checkRemoteLinkHealth(now = Date.now()) {
    if (!remoteLinkUp || remoteLinkLost || !lastTelemetryAt) return;
    if (now - lastTelemetryAt > REMOTE_TELEMETRY_STALE_MS) {
        markRemoteLinkLost(`No telemetry from the host for ${Math.round((now - lastTelemetryAt) / 1000)} s. The host may have closed the page or lost its connection.`);
    }
}

function markRemoteLinkLost(message) {
    remoteLinkLost = true;
    state.remoteHostReady = false;
    setRemoteRoleStatus('Disconnected');
    showRemoteBanner(message);
    checkReadiness();
}

function applyRemoteTelemetry(data) {
    if (!data || data.type !== 'TELEMETRY') return;
    lastTelemetryAt = Date.now();
    // Telemetry proves the data channel is alive even after a signalling
    // error, so the stale check stays armed.
    remoteLinkUp = true;
    if (remoteLinkLost || remoteRoleSuffix !== 'Live') {
        // Also clears a transient "Signalling lost" once frames keep coming.
        remoteLinkLost = false;
        setRemoteRoleStatus('Live');
        hideAlertBanner('remote');
    }
    if (data.hr !== undefined) state.hrCurrent = data.hr;
    if (data.seconds !== undefined) state.sessionSeconds = data.seconds;
    if (data.chosenTargetSeconds !== undefined) state.chosenTargetSeconds = data.chosenTargetSeconds;
    if (data.sessionStatus !== undefined) state.sessionStatus = data.sessionStatus;
    if (data.edges !== undefined) state.edges = data.edges;
    if (data.pauses !== undefined) state.pauses = data.pauses;
    if (data.strokerSpeed !== undefined) state.strokerSpeed = data.strokerSpeed;
    if (data.prostateSpeed !== undefined) state.prostateSpeed = data.prostateSpeed;
    if (data.history !== undefined) state.history = data.history;
    if (data.minHr !== undefined) state.effectiveMinHr = data.minHr;
    if (data.maxHr !== undefined) state.effectiveMaxHr = data.maxHr;
    if (data.edgeTriggerHr !== undefined) state.edgeTriggerHr = data.edgeTriggerHr;
    // The Edge Training card and the pullback input are host settings, so a
    // remote page mirrors the host rather than its own localStorage. Until a
    // frame carries them they stay blank (see syncParamsUI), never a number
    // from this browser.
    renderRemoteHostSettings(data);
    // The HOLD TO badge is written by the host's engine loop, which never
    // runs here, so a remote page labels the chart's pullback line itself.
    const remoteHoldBadge = document.getElementById('edgeHoldBadge');
    const remoteHoldText = document.getElementById('edgeHoldText');
    const showHoldBadge = shouldDrawPullbackLine(state.edgeTriggerHr, state.effectiveMaxHr);
    if (remoteHoldText && showHoldBadge) remoteHoldText.textContent = `${state.edgeTriggerHr}`;
    remoteHoldBadge?.classList.toggle('hidden', !showHoldBadge);
    if (data.teaseMode !== undefined) state.teaseMode = data.teaseMode;
    if (data.gameMode === 'off') state.gameMode = null;
    else if (data.gameMode !== undefined) state.gameMode = data.gameMode;
    if (data.activeMode !== undefined) state.activeMode = data.activeMode;
    if (data.calibrationPass === 'primary' || data.calibrationPass === 'dual') state.calibrationPass = data.calibrationPass;
    else if (data.calibrationPass === 'off') state.calibrationPass = null;
    if (data.teaseMode !== undefined || data.gameMode !== undefined || data.activeMode !== undefined || data.calibrationPass !== undefined) {
        highlightModeCard();
        renderModeDetail();
        renderCalibration();
        renderCameEarlyButton();
    }
    if (data.orgasmMode !== undefined && data.orgasmMode !== state.orgasmMode) setOrgasmMode(data.orgasmMode);
    if (data.ready !== undefined) state.remoteHostReady = data.ready;
    // Watchdog state is rendered, never evaluated, on a remote page.
    if (data.hrSignal) {
        state.hrSignalState = data.hrSignal.status;
        state.hrNoContact = data.hrSignal.noContact;
        renderHrSignal({
            status: state.hrSignalState,
            noContact: state.hrNoContact,
            sinceValidMs: data.hrSignal.silentMs
        });
    }
    checkReadiness();

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = state.hrCurrent;
    const maxInput = document.getElementById('maxHr');
    if (maxInput) maxInput.value = state.effectiveMaxHr;
    const strokerVal = document.getElementById('strokerVal');
    const strokerBar = document.getElementById('strokerBar');
    const prostateVal = document.getElementById('prostateVal');
    const prostateBar = document.getElementById('prostateBar');
    if (strokerVal) strokerVal.textContent = `${Math.round(state.strokerSpeed)}%`;
    if (strokerBar) strokerBar.style.width = `${state.strokerSpeed}%`;
    if (prostateVal) prostateVal.textContent = `${Math.round(state.prostateSpeed)}%`;
    if (prostateBar) prostateBar.style.width = `${state.prostateSpeed}%`;
    const edgeEl = document.getElementById('edgeCount');
    const pauseEl = document.getElementById('pauseCount');
    if (edgeEl) edgeEl.textContent = state.edges;
    if (pauseEl) pauseEl.textContent = state.pauses;
    updateTimerDisplay();
    redrawChart();
    lockRemoteControls();
}

// A remote page renders the host's game settings; it never computes them.
function renderRemoteHostSettings(data) {
    const trainHold = document.getElementById('trainHoldSecondsInput');
    const trainEdges = document.getElementById('trainEdgesInput');
    const holdInput = document.getElementById('edgeHoldPercentInput');
    if (trainHold && data.trainHoldSeconds !== undefined) trainHold.value = data.trainHoldSeconds;
    if (trainEdges && data.trainEdges !== undefined) trainEdges.value = data.trainEdges;
    if (holdInput && data.edgeHoldPercent !== undefined) holdInput.value = data.edgeHoldPercent;
}

function syncTelemetry() {
    if (isRemotePage) return;
    const readiness = hardwareReadiness();
    broadcastPeerTelemetry({
        type: 'TELEMETRY',
        hr: state.hrCurrent,
        seconds: state.sessionSeconds,
        chosenTargetSeconds: state.chosenTargetSeconds,
        sessionStatus: state.sessionStatus,
        edges: state.edges,
        pauses: state.pauses,
        strokerSpeed: state.strokerSpeed,
        prostateSpeed: state.prostateSpeed,
        history: state.history,
        // The WORKING limits after every offset, so remote charts draw the
        // guide lines where edges really trigger.
        minHr: state.effectiveMinHr,
        maxHr: state.effectiveMaxHr,
        edgeTriggerHr: state.edgeTriggerHr,
        activeMode: state.activeMode,
        teaseMode: state.teaseMode,
        gameMode: state.gameMode || 'off',
        calibrationPass: state.calibrationPass === 'dual' ? 'dual' : state.calibrationPass === 'primary' ? 'primary' : 'off',
        // The host's game settings. A remote page holds its own persisted
        // copies of these; without them on the wire the Edge Training card a
        // partner is reading quotes THEIR numbers for the wearer's session.
        trainHoldSeconds: clampTrainHoldSeconds(advancedSettings.trainHoldSeconds),
        trainEdges: clampTrainEdges(advancedSettings.trainEdges),
        edgeHoldPercent: clampEdgeHoldPercent(advancedSettings.edgeHoldPercent),
        orgasmMode: state.orgasmMode,
        ready: readiness.hrReady && readiness.toyReady,
        hrSignal: {
            status: state.hrSignalState,
            noContact: state.hrNoContact,
            silentMs: state.hrSignalSilentMs
        }
    });
}

// Copy a share link. navigator.clipboard only exists in secure contexts
// (https / localhost): on plain http over a LAN fall back to selecting the
// field and execCommand('copy'). Never throws; when even that fails the
// text is left selected so the user can copy it by hand.
async function copyLinkFrom(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!input || !input.value) return false;
    let copied = false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(input.value);
            copied = true;
        }
    } catch (e) {
        copied = false;
    }
    if (!copied) {
        try {
            input.focus();
            input.select();
            input.setSelectionRange(0, input.value.length);
            copied = typeof document.execCommand === 'function' && document.execCommand('copy');
        } catch (e) {
            copied = false;
        }
    }
    if (btn) {
        btn.textContent = copied ? 'Copied!' : 'Select & copy';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
    if (!copied) {
        try {
            input.focus();
            input.select();
        } catch (e) { /* nothing more to do */ }
    }
    return copied;
}

document.getElementById('copyShareUrlBtn')?.addEventListener('click', () => {
    copyLinkFrom('partnerShareUrl', 'copyShareUrlBtn').catch(() => {});
});

document.getElementById('copyGroupUrlBtn')?.addEventListener('click', () => {
    copyLinkFrom('groupShareUrl', 'copyGroupUrlBtn').catch(() => {});
});

// Boot Initialization
initHandyRoleUI();
renderLearningStatus();
syncParamsUI();
// A persisted mic setting waits for a tap (browser gesture rule).
if (advancedSettings.micEnabled && !isRemotePage) showMicReenable(true);
if (advancedSettings.voiceEnabled) paintIdlePrompt();
watchChartResize(document.getElementById('hrChart'), redrawChart);
if (isRemotePage && remoteRoom) {
    lockRemoteLimitInputs();
    lockRemoteControls();
    const started = initRemotePeer(remoteRoom, isRemoteViewer ? 'viewer' : 'controller', {
        onConnected: () => {
            remoteLinkUp = true;
            remoteLinkLost = false;
            lastTelemetryAt = Date.now();
            setRemoteRoleStatus('Live');
            hideAlertBanner('remote');
        },
        onTelemetryReceived: applyRemoteTelemetry,
        onDisconnected: () => {
            remoteLinkUp = false;
            markRemoteLinkLost('Host disconnected. Reload this link once the host has reopened Share Control.');
        },
        onSignallingLost: () => setRemoteRoleStatus(remoteLinkLost ? 'Disconnected' : 'Signalling lost'),
        onPeerClosed: () => {
            remoteLinkUp = false;
            markRemoteLinkLost('The signalling connection closed. Reload this link to reconnect.');
        },
        onPeerError: (message) => {
            remoteLinkUp = false;
            markRemoteLinkLost(`Signalling error: ${message}.`);
        }
    });
    if (!started) {
        markRemoteLinkLost('This remote link cannot start: the PeerJS signalling library could not be loaded (CDN blocked or offline).');
        setRemoteRoleStatus('Unavailable');
    }
}
checkReadiness();
updateEngine();
redrawChart();
if (!isRemotePage) maybeShowFirstRunWizard();
