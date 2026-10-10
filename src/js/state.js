// localStorage can throw on access itself (blocked cookies / private mode);
// boot must survive that with defaults rather than a blank page, so every
// read goes through storage.js.
import { safeGet } from './storage.js';
import { HANDY_DEFAULT_END_MARGIN } from './hardware/handy-protocol.js';

export const state = {
    sessionStatus: 'IDLE',
    sessionSeconds: 0,
    chosenTargetSeconds: 0,
    durationMinSeconds: 0,
    durationMaxSeconds: 0,
    // Was the running session started on a FIXED length? Snapshotted at
    // START, because durationMode can change under a running session and a
    // Mystery window typed 30-30 is numerically identical to a Fixed 30.
    durationFixed: false,
    durationMode: 'range',
    endgameType: 'orgasm',
    rampdownSecondsLeft: 45,
    hrCurrent: 70,
    edges: 0,
    pauses: 0,
    peakHr: 70,
    isEdged: false,
    orgasmMode: false,
    // Force Orgasm raises the WORKING ceiling by 1 BPM/s (capped) instead of
    // rewriting the typed Climax HR input; cleared by stop/reset.
    orgasmBoost: 0,
    // What the toys were last sent when Force Orgasm was armed. The ramp
    // starts there. Null until the button is on.
    orgasmFromPrimary: null,
    orgasmFromSecondary: null,
    orgasmFromStrokeMin: null,
    orgasmFromStrokeMax: null,
    // Post-orgasm ease-down. 0 means it is not running. The from-speeds are
    // what the toys were doing when it started; the floor is Crawl or 0.
    settleSecondsLeft: 0,
    settleSpan: 45,
    settleRestartsSurvival: false,
    // Seconds already on the session clock when warm-up last started. Survival
    // sets this after an orgasm so the warm-up runs again without zeroing the timer.
    warmupOriginSeconds: 0,
    settleFromPrimary: 0,
    settleFromSecondary: 0,
    settleFromStrokeMin: null,
    settleFromStrokeMax: null,
    settleFloor: 0,
    settleEndsSession: false,
    settleOutcome: null,
    settleVoice: null,
    // Ceiling and HR the engine actually used on the last tick, after every
    // offset; guards and games compare against these, never the raw input.
    effectiveMinHr: 70,
    effectiveMaxHr: 140,
    // Diagnostic only: the heart rate the ENGINE last ran on, microphone
    // boost included. Nothing reads it, and nothing should - it is not the
    // wearer's pulse. Read sensorHr instead.
    effectiveHr: 70,
    // The pulse the sensor reported, with no microphone boost: what every
    // guard, game, counter, the cockpit readout and the record judge.
    sensorHr: 70,
    lastGoodHrLimits: { minHr: 70, maxHr: 140 },
    // Status to resume into after PAUSED ('RUNNING' or 'RAMPDOWN').
    resumeStatus: null,
    // True when the typed duration was invalid and the session fell back to endless.
    durationFallback: false,
    // The endgame (orgasm / soft landing / denied) fires once per session.
    endgameFired: false,
    // True once the target time has passed while Force Orgasm was already
    // running, so the endgame was held back by it. The wearer cancelling
    // that orgasm must not make the endgame re-arm it a second later.
    endgameHeldByOrgasm: false,
    activeMode: 'classic',
    // The tease mode owns the stroke. A game, when set, owns the speeds
    // and borrows this stroke. Neither is restored on reload on purpose.
    teaseMode: 'classic',
    scriptReleasedAt: null,
    scriptVideoClock: false,
    configuredTargetSeconds: 0,
    gameMode: null,
    lastHrTimestamp: Date.now(),
    // Heart-rate watchdog (hr-watchdog.js): last verdict, whether packets
    // arrive without a usable pulse, how long since the last valid reading,
    // and whether the watchdog (not the user) paused the session so it can
    // auto-resume when the signal returns.
    hrSignalState: 'ok',
    hrNoContact: false,
    hrSignalSilentMs: 0,
    hrSignalPaused: false,
    hrDeviceName: '',
    // Remote controller page only: the host reports whether it has a pulse
    // source and a toy, so the partner's START button can mirror it.
    remoteHostReady: false,
    strokerSpeed: 0,
    prostateSpeed: 0,
    strokeMin: 0,
    strokeMax: 100,
    ruinHoldSeconds: 0,
    ruinRideSeconds: 0,
    edgeStallSeconds: 0,
    stallPauseElapsed: 0,
    stallGuardEngaged: false,
    intensityValue: 50,
    history: [70],
    bleBattery: null,
    handyBattery: null,
    intifaceBattery: null,
    simEngaged: false,
    handyRole: safeGet('handy_role', 'primary') || 'primary',
    handyMaxCap: (() => {
        const cap = parseInt(safeGet('handy_max_cap', '100') || '100', 10);
        return Number.isFinite(cap) ? Math.max(0, Math.min(100, cap)) : 100;
    })(),
    oracleState: 'IDLE',
    oracleTimer: 0,
    survivalSpeedFloor: 18,
    survivalTimer: 0,
    survivalEdges: 0,
    survivalOverdrive: 0,
    survivalEdgesSeen: 0,
    survivalBreachTicks: 0,
    // Timestamp of the reading the last Survival tick judged, so a value held
    // across ticks by a slow source counts as one breach reading.
    survivalLastReadingAt: null,
    trainState: 'climb',
    // Which Calibration run is armed: 'primary', 'dual', or null.
    calibrationPass: null,
    trainHoldSeconds: 0,
    trainEdgesDone: 0,
    lastSpokenPrompt: '',
    lastCueTemplateById: {},
    lastSpokenAt: 0,
    isTestingMic: false,
    micStream: null,
    micAudioCtx: null,
    micAnalyser: null,
    micAnimId: null,
    micBoost: 0,
    // The boost measured on the last FRESH reading. During the watchdog's
    // hold window the pulse is frozen and the engine runs on this instead,
    // so a missed packet can neither grow the boost on room noise nor drop
    // it and step the motors up. Cleared by every stop path.
    micBoostHeld: 0,
    // What updateEngine last actually added to the engine's heart rate (0
    // when the boost was suppressed). The cockpit badge reads THIS, never
    // the meter's own preview.
    micApplied: 0,
    // Last measured voice-band level, held while the app itself is speaking.
    micLastLevel: 0,
    micSpeechAt: 0,
    // When the current hold started, so a speech flag that never clears
    // cannot latch one level forever.
    micHoldSince: 0,
    // What the browser actually did with the capture constraints.
    micProcessing: null,
    // The pullback mark. Null until the engine computes it (host) or
    // telemetry carries it (remote page): a default would draw a chart
    // line for a threshold nobody set.
    edgeTriggerHr: null
};

export const advancedSettings = {
    // Session Setup values that used to live only in the DOM and were lost on
    // every reload. They are sanitized by session-rules.sanitizeSessionLimits
    // wherever they enter (load, Apply, import) and wherever they are written,
    // so a stored ceiling is clamped exactly as a typed one is. The numbers
    // here are the factory defaults a brand-new install sees and match the
    // values index.html ships in the inputs.
    minHr: 70,
    maxHr: 140,
    durationMode: 'range',
    durationFixedMinutes: 30,
    durationMinMinutes: 25,
    durationMaxMinutes: 45,
    endgameType: 'orgasm',
    gammaCurve: 2.0,
    warmupMinutes: 5,
    warmupEnabled: true,
    orgasmSettleSeconds: 45,
    edgeStrokeDepth: 100,
    cadenceBreathing: true,
    milkingWave: true,
    handyHwMin: 0,
    handyHwMax: 100,
    // Fresh installs need no legacy 15/85 envelope migration (see app.js).
    envelopeMigrated: true,
    // How far The Handy's driver keeps the stroke off the mechanical ends at
    // 0 and 100 (percent of travel, 0-10; 0 sends the range untouched). The
    // Handy 2 firmware can read a carriage driven into its end stop as a
    // blocked slider and lock itself out. Handy only: the T-Code and Intiface
    // linear axes are servo position targets and never gain carriage speed
    // from a wider zone, so they share the envelope but not this.
    handyEndMargin: HANDY_DEFAULT_END_MARGIN,
    stallGuard: true,
    stallGuardSeconds: 20,
    stallPauseSeconds: 8,
    // What the primary does while parked at the pullback trigger: 'stop'
    // (0%) or 'crawl' (CRAWL_PERCENT). The stall guard only matters in crawl.
    ceilingBehaviour: 'crawl',
    // Pullback as a percent of typed Climax HR (90-100, default 100).
    edgeHoldPercent: 100,
    trainHoldSeconds: 15,
    trainEdges: 5,
    // The single-stim climax Calibration saved. Null until that run is saved.
    calibrationPrimaryHr: null,
    // Heart-rate signal-loss timeout (seconds, 3-20) and whether a session
    // the watchdog paused resumes by itself once readings return.
    hrStaleSeconds: 8,
    hrAutoResume: true,
    // Both-toys climax. Independent of the single-stim max.
    dualMaxHr: 125,
    keybinds: {
        toggleSession: { kind: 'key', code: 'Space' },
        stop: { kind: 'key', code: 'Escape' },
        cameEarly: { kind: 'key', code: 'ArrowLeft' },
        forceOrgasm: { kind: 'key', code: 'ArrowRight' },
        valvePlus: { kind: 'key', code: 'ArrowUp' },
        valveMinus: { kind: 'key', code: 'ArrowDown' },
        offsetEarlier: { kind: 'key', code: 'BracketLeft' },
        offsetLater: { kind: 'key', code: 'BracketRight' }
    },
    // Session speed window. 0 and 100 leave the pattern alone. A stop is
    // still 0; everything above 0 is scaled into this pair.
    speedSlowest: 0,
    speedFastest: 100,
    scriptStrokeModel: 'cactus',
    scriptReactBpm: 10,
    scriptFloorPercent: 30,
    scriptApproach: 'shorten',
    scriptEdgeAction: 'skip',
    scriptRejoinSeconds: 8,
    scriptMaxSpeed: 300,
    scriptInvert: false,
    scriptSecondChannel: 'hr',
    scriptVideoEnd: 'stop',
    scriptContinueAfterVideo: false,
    // Theater and fullscreen: the top readout stays while the bottom bar hides.
    playerHudPin: true,
    // A marked climax: climb into the dot, hold at full, then ease back into the script.
    scriptClimaxRampSeconds: 45,
    scriptClimaxSeconds: 20,
    scriptClimaxEaseSeconds: 15,
    // Autoblow VacuGlide 2. Speed only. The token lives in its own store.
    vacuglideRole: 'primary',
    vacuglideMaxCap: 100,
    vacuglideValvePulseMs: 1000,
    adaptiveDecay: true,
    decayEdgeCount: 2,
    decayBpm: 2,
    decayFloor: 105,
    voiceEnabled: false,
    voiceURI: '',
    voiceCues: {},
    voiceEncourageSeconds: 45,
    micEnabled: false,
    micSensitivityThreshold: 40,
    micBoostMaxBpm: 8,
    learningProfile: {
        breakthroughEvents: 0,
        suggestedMaxHrOffset: 0,
        lastBreakthroughHr: null
    }
};

// The field names a factory-fresh install has, captured here - before boot
// loads the stored blob, before an import merges a file - so the list is the
// pristine one. backup.js filters both the export and the import against it.
// It has to be taken at module load: a build older than that filter merged
// every unknown top-level field of an imported file straight into the
// settings store, so the live object can carry names this version never
// wrote, and a list read off it later would bless exactly the junk the
// filter exists to keep out.
const deepFreeze = (value) => {
    if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
};
export const SETTING_DEFAULTS = deepFreeze(JSON.parse(JSON.stringify(advancedSettings)));
export const SETTING_KEYS = Object.freeze(Object.keys(SETTING_DEFAULTS));
