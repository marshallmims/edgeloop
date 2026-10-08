// The Autoblow VacuGlide 2 driver (Autoblow's cloud HTTP API V1).
//
// Design rules, in priority order:
//   1. Fail safe. A stop is the motor stopped AND both valves closed - the
//      API's stop leaves the valves as they are - each confirmed by the API
//      and retried until it is. The token and cluster a command went out
//      with are the ones its stop uses, so Disconnect or a lost link can
//      never orphan a running motor or an open valve, and a device lost
//      while it may have been running keeps being sent that stop in the
//      background until one is confirmed. The device has no watchdog of its
//      own - a tab that dies leaves it running at the last speed - so
//      pagehide and freeze send the same stop with keepalive, to every
//      device the page still has a stop out for or may have left moving.
//   2. A stop settles only what has already landed. A speed or a valve open
//      that is still out when a stop goes, or that failed without an answer,
//      may reach the device after the stop did - Autoblow documents no bound
//      on how late - and then nothing answers for it. Such a command is kept
//      by token, not by link, so Disconnect, a lost link or a new link
//      forgets none of them. When a stop goes out while one of them - or a
//      part of an earlier stop - is still unanswered, or when a part of a
//      stop to a device that may be moving is still unanswered a read beat
//      after it went out, the device's state is read every
//      VACUGLIDE_TIMINGS.lateCommandWatchBeatMs, connected or not, for the
//      whole window in which that command can still land, whatever answers
//      come back meanwhile (watchForLateCommand); a read that cannot see the
//      device raises the alarm. Every reply is read the same way,
//      since every command answers with the full device state. While the
//      device should be at rest - a stop has gone out and no speed since -
//      any reply or read that shows the motor running or a valve open gets
//      the whole stop again, at once, whatever stop is still out: nothing
//      waits for an earlier stop to settle (observeReply) - a reply to a
//      stop's own part included, once that stop has had the motion it shows
//      confirmed ended (observeStopReply). While a session
//      drives it, a valve found open is closed and a motor at another speed
//      is sent the session's own. A stop that is not confirmed raises the
//      alarm, as every stop does, and so does a device seen moving by a
//      request sent a read beat after a stop that is still unanswered
//      (stopNotReaching). None of this ends with the page: one that
//      goes away leaves every device it cannot vouch for, and the next
//      EdgeLoop page to load takes the watch and the stop over - or the same
//      page when it comes back, or a page that connects that very device,
//      before its new link sends it anything (leaveHandover,
//      attachVacuglideToPage, takeOverVacuglideHandover, connectVacuglide).
//      A page that was already open does not, and the alarm stays where the
//      wearer is. What was left does not lapse while no page is open: a
//      window that ran out unwatched still owes its last read, and a chase
//      nobody ran is run. The page that drives the device answers for it: a
//      page that answers for one it does not drive holds its entry in
//      storage, and lets go of the device once a page that connects it has
//      taken that entry (answersFor).
//   3. The valves are the wearer's alone. Nothing here opens one except
//      pulseValve(), which only a button press calls: it opens one valve for
//      a fixed pulse, timed from the moment the open is sent rather than from
//      its reply, closes it again on a beat for as long as a late open could
//      still land, and always ends in a confirmed close. A press while a
//      pulse is running is refused, not queued, so presses can never add up
//      to a long open. A valve any reply shows open with no press holding it
//      is closed, confirmed.
//   4. A stop is never refused for rate. Every request is counted against
//      the token's budget (vacuglide-protocol.js); routine traffic stops
//      short of the ceiling, and only a stop or a valve close may spend the
//      reserve - 6 whole stops in any 66 s however busy the rest of it was.
//      A stop that has to wait for a slot past that still goes the moment
//      one frees, and raises the alarm the moment it starts waiting. A read
//      the watch makes is a safety read: routine traffic leaves it a share of
//      its own below the reserve, so a busy session cannot leave the watch
//      unable to read the device, and the watch never takes a slot a stop is
//      kept. The count is kept in localStorage, so a reloaded page or a
//      second tab counts what was sent before it. The speed is sent only when
//      it changes, at most once a second, one request at a time and never
//      while a stop is out, so two speeds, or a speed and a stop, can never
//      reach the device in the wrong order.
//
// All fetch calls go through vgRequest(), which counts, classifies and
// reports them through the handlers app.js installs.

import {
    VACUGLIDE_DISCOVERY_BASE,
    VACUGLIDE_PATHS,
    VACUGLIDE_VALVES,
    VALVE_NAMES,
    RATE_WINDOW_MS,
    RATE_CEILING,
    RATE_RESERVE,
    RATE_WATCH_RESERVE,
    MAX_VALVE_OPENS_PER_WINDOW,
    VALVE_PULSE_DEFAULT_MS,
    sanitizeDeviceToken,
    parseConnectedReply,
    classifyVacuglideResponse,
    parseVacuglideState,
    describeUnusableMode,
    isPlayingMode,
    stopConfirmedBy,
    valveClosedBy,
    valvesOpenIn,
    motorRunningIn,
    clampTargetSpeed,
    clampValvePulseMs,
    createRateBudget,
    rateLogStorageKey,
    describeRateWait,
    describeVacuglideInfo,
    foreignDeviceType,
    describeForeignDevice,
    VACUGLIDE_HANDOVER_STORAGE_KEY,
    decodeHandover,
    encodeHandover,
    mergeHandoverByDevice,
    describeAgo,
    normalizeCluster
} from './vacuglide-protocol.js';
import { RECOVERY_STOP } from './handy-protocol.js';
import { safeGet, safeSet, safeRemove } from '../storage.js';

// Three missed polls in a row is the rule for an unreachable API, as on The
// Handy; five failed dispatch TICKS in a row (not requests: one tick may
// send a stop and two valve closes together) end the link mid-session.
const OFFLINE_POLL_FAILURES = 3;
const OFFLINE_DISPATCH_FAILURES = 5;
// How many background stop rounds a lost device gets before the job gives
// up (60 rounds at the default 5 s spacing: five minutes).
const OFFLINE_STOP_MAX_ROUNDS = 60;

// Mutable so tests can shorten the waits.
export const VACUGLIDE_TIMINGS = {
    requestTimeoutMs: 6000,
    // Backoff between the four attempts of one confirmed stop or close.
    stopRetryDelaysMs: [250, 500, 1000],
    // Pause between rounds of the background stop sent to a lost device.
    offlineStopRetryMs: 5000,
    // The link is checked for as long as a device is connected: every 10 s
    // in a session and every 30 s outside one. Between sessions nothing
    // else reaches the API, and a device that left online mode would read
    // as connected until START drove it - and a valve or a motor a late
    // command moved would go unseen. 2 checks a minute is a sliver of
    // the token's budget, and three misses in a row then take a full
    // minute and a half - the cost of never dropping a link on one blip.
    pollActiveMs: 10000,
    pollIdleMs: 30000,
    // Autoblow's own app, or any other app using the device token, can stop
    // the device while a session drives it, and the next speed EdgeLoop
    // sends would start it again before anything here had read that it was
    // stopped. So while a session holds its speed, the device is read once
    // it has gone this long without a request whose answer shows its state,
    // and a new speed after such a stretch waits for that read first - up
    // to readBeforeSpeedWaitMs - and is not sent when it finds the device
    // stopped (stoppedUnderSession). Such a read comes only after that long
    // a silence, so with the speeds it never comes to more than a request a
    // second: the share of the budget a speed a second has. A speed sent
    // less than this long after the last request still finds nothing
    // read: that is the stop EdgeLoop does not see.
    steadyReadMs: 2000,
    readBeforeSpeedWaitMs: 1000,
    // "At most once a second" for the speed. The engine ticks once a second
    // and a heart-rate packet can tick it again in between.
    speedGapMs: 1000,
    // A valve open that timed out on our side may still reach the device
    // after the close that followed it did. The close is sent again once
    // the open can no longer be in flight: after one request timeout.
    staleOpenGuardMs: 6000,
    // While a valve open may still land - it is unanswered, or it failed in
    // a way that does not say whether it landed - the valve is closed again
    // this often, so an open the cloud held back is shut within a beat of
    // landing instead of staying open until an answer that may never come.
    pendingOpenBeatMs: 1000,
    // The pulse's own beat ends with its guard, but Autoblow documents no
    // bound on how late the cloud may apply a request it never answered: an
    // open that landed 13 s after it was sent, once the pulse had given up
    // on it, stayed open for as long as nothing else was sent, and speeds
    // that landed 8 s and 20 s after they were sent restarted a motor that
    // STOP, Disconnect or the background stop after a lost link had
    // stopped. So when a stop goes out while a speed, a valve open or a
    // part of an earlier stop is still unanswered, the device's state is
    // read every 2 s, connected or not, until that command can no longer
    // land: lateCommandWatchMs after EdgeLoop gives up on it - its request
    // timeout, or for an open the end of its pulse's guard - which for a
    // speed still out at the stop is at most 66 s after it was sent. The
    // same goes for a part of a stop to a device that may be moving that is
    // still unanswered 2 s after it went out: the cloud swallowed a motor
    // stop, its two closes came back at once with the motor still running in
    // them, and after Disconnect nothing read the device while it ran on for
    // 6 s to 26 s.
    // An answer that comes back meanwhile does not end the watch: a cloud
    // that held one request back that long can hold others, and a speed
    // answered once STOP had been confirmed ran for 26 s with nothing
    // reading the device. A valve found open is closed, and a motor found
    // running stopped, at once; a read that cannot see the device raises
    // the alarm. The last read goes out once the window has closed. After
    // that the link check and every reply keep looking for as long as the
    // device is connected. Thirty-three reads in the window sit well inside
    // the routine budget, and only after a stop that went out with
    // something unanswered, or that was not answered itself.
    lateCommandWatchBeatMs: 2000,
    lateCommandWatchMs: 60000,
    // A whole stop still unanswered, while a request sent at least this long
    // after it shows the device still moving, is a stop that is not reaching
    // it: the alarm goes up then, rather than when that stop's four attempts
    // have failed - a cloud that swallowed every stop kept the motor running
    // for 26 s before that - and the whole stop goes out again beside it, as
    // at every sighting. It is measured between the two requests going out,
    // not to the moment the answer came back, and it is one read beat: round
    // trips to Autoblow's cloud measured 66-273 ms, but the hop from the
    // cloud to the device could not be measured, and on a link whose round
    // trip took over a second a stop that was merely slow must not raise
    // it. The answer to a speed sent before the stop is no such sighting:
    // it may show the device from before the stop landed, and on a 1.2 s
    // round trip it raised the alarm - and paused a running session - over
    // a stop that had landed.
    stopLandsWithinMs: 2000,
    // How long routine traffic holds off after the server itself answered
    // 429. Its reset time is in a header the browser cannot read.
    serverRefusalBackoffMs: 10000
};

// The request budget per token. Mutable for tests only: a budget takes these
// numbers when it is created, which is the first request for its token.
export const VACUGLIDE_LIMITS = {
    windowMs: RATE_WINDOW_MS,
    ceiling: RATE_CEILING,
    reserve: RATE_RESERVE,
    watchReserve: RATE_WATCH_RESERVE,
    maxOpens: MAX_VALVE_OPENS_PER_WINDOW
};

// The connected device, or null. Everything that can move it lives on this
// object, so a command, a stop or a pulse that outlives the link still
// knows which device it was for:
//   motorMayRun     a speed reached the device, or may have, and no stop has
//                   been confirmed since;
//   motionUnknown   a request whose outcome nobody could read (a timeout,
//                   the keepalive stop of a page that went away);
//   valveMayBeOpen  per valve, from the moment an open is sent until a close
//                   is confirmed - or from the moment a reply shows it open
//                   with no press holding it until a close is confirmed;
//   lastSpeedSent   the speed the device last confirmed, -1 when unknown -
//                   after any stop it is unknown, so the next speed is
//                   always sent even if it is the same number;
//   lastSpeedReported the target speed the reply to that speed reported;
//   valveSettledSeq per valve, the last request sent before a press's or a
//   speedSettledSeq stray valve's close for it was last confirmed, and the
//                   same for a speed. A reply shows the device at some
//                   moment after its request was sent, so only a request
//                   sent after that confirmation can show what happened
//                   after the close or the speed; an older one may have been
//                   answered from the moment before it landed;
//   stopSeq         the last request sent before the latest whole stop for
//                   the device went out through this link, and stopId that
//                   stop, so only the latest one's confirmation settles it;
//                   stopConfirmedId the latest one confirmed;
//   driveSeq        the last speed sent that may have reached the device. A
//                   reply to a request sent after the latest stop shows the
//                   device after that stop went out, and unless a speed has
//                   gone out since, it has no business moving then - that
//                   stop's own requests may still be unanswered, and it is
//                   stopped again at once all the same;
//   born            the order links were made in, so a watch that outlives
//                   one link keeps the newest one the device was reached
//                   through.
let live = null;
let linksMade = 0;
let connectInFlight = false;
// The token a connect has taken the handover entries of and is bringing to
// rest, until that connect ends. What this page answers for about that
// device meanwhile it holds in storage marked connecting (claimHandover,
// publishHeld).
let connecting = null;
// Bumped by Disconnect, so a connect still verifying cannot commit after it.
let connectEpoch = 0;
// Every stop, Disconnect and lost link bumps this. A speed that was already
// on its way when it changed may reach the device after the stop did, so
// its answer sends another stop at once instead of trusting the first one.
let commandGeneration = 0;
// Numbers every whole stop, for the stopId above.
let stopsIssued = 0;
// The latest confirmed stop of the connected device's own that an idle tick
// may share: { link, generation, promise }. An idle tick asks only for the
// device to be stopped, and one is on its way; STOP, a pause and a sighting
// of the device moving always send a whole stop of their own.
let stopInFlight = null;
// The running valve pulse, or null. One at a time, for either valve.
let pulse = null;

// Every request is numbered as it is sent. The order the page sent things
// in is what says whether a reply can show what came after a confirmed
// close; a clock in milliseconds cannot, when both happen in the same one.
let requestSequence = 0;

// Dispatch ticks are numbered so the offline counter advances once per
// failed tick, however many requests that tick issued.
let dispatchSequence = 0;
let lastFailedDispatch = -1;
let consecutiveDispatchFailures = 0;
let consecutivePollFailures = 0;
let pollTimer = null;
// When the link check the timer holds is due, and whether it was timed for a
// session (schedulePoll, quickenPollForSession).
let pollDueAt = 0;
let pollPaceActive = false;
// Bumped whenever polling stops, so a poll that was already out cannot
// start a second timer chain when it comes back.
let pollEpoch = 0;
// The last error shown to the user: { path, message }. Only a success on
// the SAME path clears it, so a poll cannot hide a speed that keeps failing.
let lastReportedError = null;
let rateNoticeShown = false;

// token -> the background stop job for a device this driver lost.
const safetyJobs = new Map();
// token -> the commands that can move that device and may still reach it
// (beginFlight). Kept by token, not by link: a token names a device, and
// Disconnect, a lost link or a new link changes nothing about what that
// device may still be sent.
const flights = new Map();
// token -> the watch on a device that such a command may still reach
// (watchForLateCommand). It outlives the link just the same.
const watches = new Map();
// Links the whole stop is out for, other than the connected device's own:
// Disconnect's, a lost link's, the stop sent again for a late speed or for
// a device a watch saw moving (stopForeignLink). Nothing else holds such a
// link while its stop is out: a watch covers only a device something may
// still land on, and the background stop begins only once that stop has
// failed.
// Pressing Disconnect on a running session and closing the tab while its
// stop was still being tried left the device running with no unload stop
// and nothing for the next page, while closing the same tab without
// pressing Disconnect stopped it. A page that goes away sends the whole
// stop to each of these, and leaves each one that may be moving to the
// next page, like the connected one.
const stopping = new Set();
// token -> its request budget. Autoblow counts per token, and a stop for a
// device that is no longer connected still spends that device's budget.
const budgets = new Map();
// Names this page's own entries in the stored request log, so the log it
// reads back holds everything a reloaded page, or another tab, sent for
// the same token - and not this page's own requests a second time. It names
// what this page leaves the next one the same way.
const PAGE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
// token -> a device this page took over from a page that went away
// (takeOverVacuglideHandover), until the watch and the stop it was taken
// over for have both ended: { watched, stopped, caught, gaveUp }, so the
// panel can say how it ended.
const takeovers = new Map();
// Tokens a stop request is waiting on the budget for (noteStopHeldBack).
const heldBack = new Set();
// token -> when Autoblow's server last answered a request for it with 429.
const serverRefusedAt = new Map();
// Devices this page answers for without driving them - it took one over, or
// let go of one with a command still out, or a stop, a watch or a chase is
// still running for it - and keeps a held entry in storage for, so that a
// page that connects the device can take it (publishHeld). It is only in
// here once that entry is really in storage.
const holding = new Set();
// Devices another page drives now: it took the entry this page held, and
// this page let go of them (standDown) until it connects one itself, or
// takes over what a page that went away left for it.
const released = new Set();
// The stop parts still to be looked at a read beat after they went out
// (watchIfUnanswered).
const stopChecks = new Set();

const handlers = {
    onError: null,
    onOffline: null,
    onStopUnconfirmed: null,
    onStopConfirmed: null,
    onNotice: null,
    onPulse: null,
    onValves: null,
    onLateStop: null,
    onTakeover: null,
    onStoppedElsewhere: null,
    isSessionActive: null
};

// app.js installs UI callbacks here:
//   onError(message | null)     -> non-null: show the API error; null: the failing call succeeded again
//   onOffline(reason, label)    -> the link is gone; motors must be treated as stopped (label: badge text)
//   onStopUnconfirmed(message, token)
//                               -> a stop or a valve close the device behind `token` may have needed
//                                  was never confirmed
//   onStopConfirmed(token)      -> a whole stop of the device behind `token` was confirmed - the motor
//                                  stop and both valve closes, by the newest stop sent to it - so it is
//                                  at rest as far as anything EdgeLoop sent can say
//   onNotice(message)           -> the device or the API said something worth reading; not a fault
//   onPulse({ valve, stage })   -> a valve pulse moved on: 'opening' | 'open' | 'closing' | 'idle'
//   onValves(message | null)    -> what the driver knows about the valves changed outside a pulse: one
//                                  was found open, was closed again, or a watch began or ended;
//                                  message, when given, says what happened to a valve
//   onLateStop(message)         -> a device EdgeLoop had already let go of (Disconnect, a lost link)
//                                  was found moving on a command that landed late, and stopped again
//   onTakeover(message, active) -> this page took over a device a page that went away could not
//                                  vouch for (active: true), or has finished with it (active: false);
//                                  message says what it is doing, or how it ended
//   onStoppedElsewhere(message) -> the connected device was found stopped under a running session by
//                                  something other than this page; the page pauses the session, and
//                                  the driver sends it no speed until the session has been paused and
//                                  runs again
//   isSessionActive()           -> true while a session is RUNNING or RAMPDOWN
export function setVacuglideHandlers({ onError, onOffline, onStopUnconfirmed, onStopConfirmed, onNotice, onPulse, onValves, onLateStop, onTakeover, onStoppedElsewhere, isSessionActive } = {}) {
    if (onError !== undefined) handlers.onError = onError;
    if (onOffline !== undefined) handlers.onOffline = onOffline;
    if (onStopUnconfirmed !== undefined) handlers.onStopUnconfirmed = onStopUnconfirmed;
    if (onStopConfirmed !== undefined) handlers.onStopConfirmed = onStopConfirmed;
    if (onNotice !== undefined) handlers.onNotice = onNotice;
    if (onPulse !== undefined) handlers.onPulse = onPulse;
    if (onValves !== undefined) handlers.onValves = onValves;
    if (onLateStop !== undefined) handlers.onLateStop = onLateStop;
    if (onTakeover !== undefined) handlers.onTakeover = onTakeover;
    if (onStoppedElsewhere !== undefined) handlers.onStoppedElsewhere = onStoppedElsewhere;
    if (isSessionActive !== undefined) handlers.isSessionActive = isSessionActive;
}

export function isVacuglideConnected() {
    return live !== null;
}

export function getVacuglideToken() {
    return live ? live.token : '';
}

export function getVacuglideCluster() {
    return live ? live.cluster : '';
}

export function getVacuglideInfo() {
    return live ? live.info : null;
}

export function isVacuglideMoving() {
    return Boolean(live && live.motorMayRun);
}

// True while the driver cannot vouch for the motor being stopped.
export function isVacuglideMotionUnknown() {
    return Boolean(live && live.motionUnknown);
}

// True from the moment an open for `valve` is sent until a close for it is
// confirmed.
export function isVacuglideValveOpen(valve) {
    return Boolean(live && live.valveMayBeOpen[valve]);
}

// { valve, stage } of the running pulse, or null.
export function getValvePulse() {
    return pulse ? { valve: pulse.valve, stage: pulse.stage } : null;
}

// True while a background stop for a lost device is still unconfirmed.
export function isVacuglideOfflineStopPending() {
    for (const job of safetyJobs.values()) if (job.active) return true;
    return false;
}

// True while the connected device is being watched for a valve open that
// was never answered and may still land. A watch for a speed alone is not
// a reason to say anything about the valves.
export function isVacuglideWatching() {
    if (!live) return false;
    const job = watches.get(live.token);
    return Boolean(job && job.active && job.opens);
}

// True while any device is being watched that way, connected or not.
export function isVacuglideWatchPending() {
    for (const job of watches.values()) if (job.active) return true;
    return false;
}

// True while this page is still watching or stopping a device it took over
// from a page that went away.
export function isVacuglideTakeoverPending() {
    return takeovers.size > 0;
}

function makeLink(token, cluster, info) {
    const now = requestSequence;
    linksMade += 1;
    return {
        token,
        cluster,
        info,
        born: linksMade,
        motorMayRun: false,
        motionUnknown: false,
        valveMayBeOpen: { plus: false, minus: false },
        valveSettledSeq: { plus: now, minus: now },
        speedSettledSeq: now,
        // A link is made for a device nothing here has told to move: the
        // connect's own stop goes out next, and a device taken over from a
        // page that went away is watched and stopped, never driven. What a
        // reply shows the device doing from here on is read against that.
        stopSeq: now,
        stopId: 0,
        stopConfirmedId: 0,
        // The whole stops whose motor stop, or whose close of each valve, is
        // still unanswered, oldest first (stopNotReaching).
        unanswered: { motor: [], plus: [], minus: [] },
        driveSeq: 0,
        lastSpeedReported: null,
        // A close for a valve a reply showed open, while it is out.
        strayClosing: { plus: false, minus: false },
        // How many whole stops are out for this link. A speed waits for
        // every one of them, so none can land after it.
        stopsInFlight: 0,
        // How many of those hold it in `stopping`.
        stoppingHolds: 0,
        lastSpeedSent: -1,
        lastSpeedSentAt: 0,
        speedInFlight: null,
        pendingSpeed: null,
        forceSpeed: false,
        // The pending speed is a decision the page sent urgent (a cut, a
        // guard, Force Orgasm's landing): it does not wait out speedGapMs.
        urgentSpeed: false,
        speedTimer: null,
        // The router check a DeviceNotConnectedError started, while it is out.
        checking: null,
        // When the latest request whose answer shows the device's state went
        // out through this link, and the read a steady session, or a speed
        // after such a stretch, is waiting on (steadyReadMs).
        lastSentAt: 0,
        steadyRead: null,
        // The device was found stopped under the session by something else
        // (stoppedUnderSession): 'held' until the session has been paused,
        // 'resumable' once it has, and null again when it runs once more. No
        // speed goes out while it is set.
        stoppedElsewhere: null
    };
}

// The token's request log in localStorage, read and written at every
// request, so Autoblow's minute is counted across a reload and across tabs
// (vacuglide-protocol.js says why). Where storage is blocked it reads as
// empty and the budget counts this page alone.
function rateStoreFor(token) {
    const key = rateLogStorageKey(token);
    return {
        load: () => safeGet(key, null),
        save: (text) => {
            if (text === null) safeRemove(key);
            else safeSet(key, text);
        }
    };
}

function budgetFor(token) {
    let budget = budgets.get(token);
    if (!budget) {
        budget = createRateBudget({ ...VACUGLIDE_LIMITS, store: rateStoreFor(token), page: PAGE_ID });
        budgets.set(token, budget);
    }
    return budget;
}

function callHandler(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function reportError(path, message) {
    lastReportedError = { path, message };
    callHandler('onError', message);
}

function reportRecovered(path) {
    if (lastReportedError === null || lastReportedError.path !== path) return;
    lastReportedError = null;
    callHandler('onError', null);
}

// `token` names the device the stop or the close was for, so the page can
// tell which device still owes a confirmed stop (onStopConfirmed ends it).
function reportStopUnconfirmed(path, error, what = 'Stop', token = '') {
    const message = `${what} not confirmed: ${error && error.message ? error.message : 'unknown error'}`;
    reportError(path, message);
    callHandler('onStopUnconfirmed', message, token);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves once Date.now() has reached `time`. A timer can fire a
// millisecond early by that clock, and this is used where the time itself
// is the rule.
async function sleepUntil(time) {
    for (let left = time - Date.now(); left > 0; left = time - Date.now()) await sleep(left);
}

// Runs `fn` once Date.now() has reached `time`, on the same terms.
function atTime(time, fn) {
    unref(setTimeout(() => {
        if (Date.now() < time) atTime(time, fn);
        else fn();
    }, Math.max(0, time - Date.now())));
}

// Resolves after `ms`, or as soon as `early` settles, whichever is first.
function pauseUnless(ms, early) {
    let timer = null;
    const elapsed = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([elapsed, early]).finally(() => clearTimeout(timer));
}

function unref(timer) {
    // Never keep a node:test process alive; a no-op in browsers.
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

// One API call. Resolves with the parsed body on success, throws an Error
// with a readable message on any failure. The error carries what the caller
// needs to decide: `local` (our own budget held it back - nothing was
// sent), `ambiguous` (a timeout, a network error or a 5xx: it may still
// have reached the device), `notConnected`, `rateLimited`.
//
// `kind` is the budget class: 'critical' for a stop or a valve close, which
// is delayed until a slot frees and never refused; 'open' for a valve open;
// 'watch' for a read of the device's state that makes sure of it (the
// watch's, and one after a stop of an earlier link came back), which has a
// share of its own; 'normal' for everything else. The refusal of a routine
// request happens before the first await, so a caller that checked the
// budget and then called this cannot be overtaken in between.
//
// A request made for `link` has the device state its reply carries read
// by observeReply before the caller sees it, whatever the caller wanted
// the request for - except a part of a whole stop (`stopPart`). Its three
// requests go out together, so each one's reply may show the device from
// before the other two landed: a close answered while the motor stop was
// still on its way shows the motor running, and a stop sent again for that
// would have its own closes answered the same way, one stop after another.
// The whole stop reads those replies itself, against what it has had
// confirmed so far (observeStopReply).
// A request whose link has been let go of by the time it comes back -
// Disconnect, a lost link, another device connected in its place - answers
// for that device alone: its failure must not paint an error onto the panel
// of whatever is connected now, nor count toward that link going offline,
// and its success must not clear an error that link reported. `onSent`
// hears the number the request went out with, and when it went out.
async function vgRequest(base, path, { method = 'GET', body = undefined, token, kind = 'normal', link = null, countFailure = false, quiet = false, stopPart = false, onSent = null } = {}) {
    if (!token) throw new Error('No VacuGlide device token');
    const detached = () => Boolean(link && live !== link);
    const tick = dispatchSequence;
    const budget = budgetFor(token);
    let wait = budget.waitMs(kind, Date.now());
    if (wait > 0 && kind !== 'critical') {
        const err = new Error(describeRateWait(wait));
        err.local = true;
        err.waitMs = wait;
        throw err;
    }
    if (wait > 0) {
        noteStopHeldBack(token, path, wait);
        while (wait > 0) {
            await sleep(wait);
            wait = budget.waitMs('critical', Date.now());
        }
        heldBack.delete(token);
        // Let go of while it waited for a slot: the device is another
        // page's now, and this is not sent into what that page runs.
        if (!answersFor(token)) {
            const err = new Error('Another EdgeLoop tab drives the VacuGlide now');
            err.local = true;
            throw err;
        }
    }
    const sentAt = Date.now();
    budget.record(kind, sentAt);
    const seq = ++requestSequence;
    if (link) link.lastSentAt = sentAt;
    if (typeof onSent === 'function') onSent(seq, sentAt);

    const headers = { 'x-device-token': token };
    const init = { method, headers };
    // Autoblow: a request with a body is JSON; one without sends no
    // Content-Type at all.
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    let abortTimer = null;
    if (typeof AbortController === 'function') {
        const controller = new AbortController();
        init.signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), VACUGLIDE_TIMINGS.requestTimeoutMs);
    }

    let res;
    let data = null;
    try {
        res = await fetch(`${base}${path}`, init);
        try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
        const msg = (e && e.name === 'AbortError') ? `Request timed out (${path})` : `Network error (${path})`;
        noteFailure(path, msg, countFailure && !detached(), tick, quiet || detached());
        const err = new Error(msg);
        err.ambiguous = true;
        throw err;
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    const verdict = classifyVacuglideResponse(res.ok, res.status, data, path);
    if (!verdict.ok) {
        if (verdict.rateLimited) {
            serverRefusedAt.set(token, Date.now());
            budget.noteServerRefusal(Date.now(), VACUGLIDE_TIMINGS.serverRefusalBackoffMs);
            noteServerRefusal(link);
        }
        noteFailure(path, verdict.message, countFailure && !detached(), tick, quiet || detached());
        const err = new Error(verdict.message);
        err.status = res.status;
        err.code = verdict.code;
        err.notConnected = verdict.notConnected;
        err.rateLimited = verdict.rateLimited;
        err.ambiguous = verdict.ambiguous;
        // The server says the device is not on this cluster. That is either
        // a device that left online mode or one that came back on another
        // cluster; either way the link as we know it is gone, and one
        // discovery call says which.
        if (verdict.notConnected && link && live === link) checkLink(link);
        throw err;
    }
    if (countFailure && !detached()) consecutiveDispatchFailures = 0;
    if (!quiet && !detached()) reportRecovered(path);
    if (link && !stopPart) observeReply(link, data, seq, sentAt);
    return data;
}

// A stop request, or a valve close, that has to wait for a slot: the token
// has spent its budget to the ceiling, which the reserve leaves room for 6
// whole stops in. More than that in one window is a device that keeps
// moving whatever EdgeLoop sends, or stops that do not get through. The
// request still goes the moment a slot frees - it is never dropped - but
// until then the device may be moving with nothing on its way to stop it,
// and the wearer hears that now, not after the wait. Once per token until
// a stop gets through again. What holds it is EdgeLoop's own count, which
// stays under Autoblow's limit and counts every request sent, answered or
// not - one that failed on the way may never have reached Autoblow at all -
// so that is what it says; Autoblow's limit only when its server did refuse
// this token for rate within the window.
function noteStopHeldBack(token, path, wait) {
    if (heldBack.has(token)) return;
    heldBack.add(token);
    const seconds = Math.max(1, Math.ceil(wait / 1000));
    const what = path === VACUGLIDE_VALVES.plus || path === VACUGLIDE_VALVES.minus ? 'valve close' : 'stop';
    const refused = serverRefusedAt.has(token) && serverRefusedAt.get(token) > Date.now() - VACUGLIDE_LIMITS.windowMs;
    const why = refused
        ? "Autoblow's server has refused requests for this device token as over its limit, and EdgeLoop's own count of them for the minute is full"
        : "EdgeLoop's own count of requests for this device token is full for the minute - it counts every request it sent, answered or not, to stay under Autoblow's limit";
    const message = `A ${what} is held back: ${why}. EdgeLoop sends it in ${seconds} s`;
    if (live && live.token === token) reportError(path, message);
    callHandler('onStopUnconfirmed', message, token);
}

// `quiet` is the background stop for a device that is no longer the one
// connected: its failures are its own, reported once as an unconfirmed
// stop, and must not paint an API error onto the status line of whatever
// is connected now.
function noteFailure(path, message, countFailure, tick, quiet = false) {
    if (!quiet) reportError(path, message);
    if (!countFailure) return;
    // One failed tick counts once, however many of its requests failed.
    if (tick === lastFailedDispatch) return;
    lastFailedDispatch = tick;
    consecutiveDispatchFailures += 1;
    if (live && consecutiveDispatchFailures >= OFFLINE_DISPATCH_FAILURES) {
        markOffline(live, `The VacuGlide stopped responding (${consecutiveDispatchFailures} failed commands).`);
    }
}

// Said once per connection: the same news every tick afterwards is noise,
// and the failure itself is already on the status line.
function noteServerRefusal(link) {
    if (!link || live !== link || rateNoticeShown) return;
    rateNoticeShown = true;
    callHandler('onNotice', "Autoblow's server refused a command because this device token hit its request limit. Another app driving the same VacuGlide can cause that. EdgeLoop keeps retrying a stop until it is confirmed.");
}

// A reply that shows the device in a fault, or in a state it cannot be
// driven in, ends the link exactly as losing it would: the session pauses
// and the device is brought to a confirmed stop.
function noteDeviceState(link, state) {
    if (!link || live !== link || !state) return;
    const unusable = describeUnusableMode(state.operationalMode);
    if (unusable) markOffline(link, `${unusable} EdgeLoop stopped driving it. Check the device, then press Connect again.`, 'Device error');
}

// Is a press holding `valve` on the device this token drives? Then the
// valve is the pulse's: open because the wearer asked, or being closed by
// the pulse itself, which confirms its own close.
function pulseHolds(token, valve) {
    return Boolean(pulse && pulse.valve === valve && pulse.link.token === token);
}

// Has a speed gone out through `link` since its latest whole stop - one that
// may have reached the device, answered or still on its way? Then the motor
// running is the session's. Otherwise the device should be at rest.
function drivenSinceStop(link) {
    return link.driveSeq > link.stopSeq;
}

// What a reply to request `seq` shows moving on the device behind `link`
// that nothing EdgeLoop sent since its latest stop explains: 'motor', a
// valve, or null. Only a request sent after that stop went out can show the
// device after it; an older one may have been answered from the moment
// before the stop landed, and that stop answers for it. A valve a press
// holds is the wearer's, and one whose press's close was confirmed after
// the request was sent was open before that close.
function motionAfterStop(link, state, seq) {
    if (!(seq > link.stopSeq)) return null;
    if (motorRunningIn(state) && !drivenSinceStop(link)) return 'motor';
    return strayValvesIn(link, state, seq)[0] || null;
}

function strayValvesIn(link, state, seq) {
    return valvesOpenIn(state).filter((valve) => !pulseHolds(link.token, valve)
        && seq > link.valveSettledSeq[valve] && seq > link.stopSeq);
}

// The device is seen moving by the answer to a request sent at `sentAt`,
// while the part of a whole stop that would end it - the motor stop for a
// running motor, that valve's close for an open valve - went out at least
// VACUGLIDE_TIMINGS.stopLandsWithinMs before that request and is still
// unanswered, with none sent since answered either. Stops are not reaching
// the device, whatever their retries may do later: the alarm goes up now,
// once for the oldest of them, and the whole stop goes out again beside it.
// The oldest, not the newest: a stop goes out at every sighting, so the
// newest is never older than a read beat. Only a request that went out
// after the stop can show that - the answer to one sent before it may show
// the device from before the stop landed - and the time is taken between
// the two going out, so an answer that is merely slow to come back says
// nothing of the stop.
function stopNotReaching(link, cause, sentAt) {
    const out = link.unanswered[cause].find((e) => e.sentAt > 0);
    if (!out || out.alarmed) return;
    if (!(sentAt - out.sentAt >= VACUGLIDE_TIMINGS.stopLandsWithinMs)) return;
    out.alarmed = true;
    const waited = Date.now() - out.sentAt;
    const what = cause === 'motor' ? 'The VacuGlide is still running' : `${VALVE_WORDS[cause]} is still open`;
    const message = `${what} ${Math.round(waited / 100) / 10} s after EdgeLoop sent it a stop Autoblow's server has not answered; EdgeLoop keeps sending the stop`;
    if (live === link) reportError(VACUGLIDE_PATHS.stop, message);
    callHandler('onStopUnconfirmed', message, link.token);
}

// Every command answers with the full device state, and that state is the
// only evidence the driver ever gets of a request the cloud applied after
// giving up on it. An open that landed once its pulse had closed the valve
// for the last time stayed open for as long as nothing else was sent: 13 s
// after it was sent, every later reply reported the valve open while the
// panel said both were closed. And a speed that landed after STOP's motor
// stop, while one of STOP's valve closes was still unanswered, ran for 6 s -
// 26 s once Disconnect had been pressed as well - because every reply was
// set aside while a stop was out, and the stop sent again for it waited for
// STOP to settle first. So every reply is read, whatever stop is out, and a
// device that should be at rest and is not gets the whole stop again at
// once (observeDriven, observeLeft). A token names a device, so whichever
// link a reply came back through, the device's link now decides what it
// means - the connected one, when the device is connected again. `sentAt`
// is when the request went out. Never throws - it runs inside a request
// that succeeded.
function observeReply(link, data, seq, sentAt) {
    try {
        const state = parseVacuglideState(data);
        if (!state) return;
        const owner = live && live.token === link.token ? live : link;
        if (owner === live) observeDriven(owner, state, seq, sentAt);
        else observeLeft(owner, state, seq, sentAt);
    } catch (e) {}
}

// The device EdgeLoop drives. Between a stop and the next speed it should be
// at rest, motor stopped and both valves closed - a press held open by the
// wearer aside - and a reply sent after that stop that shows it otherwise
// gets a whole stop of its own, at once: the motor stop and both valve
// closes. While a session drives it, a valve open with no press holding it
// is closed; and while a speed of its own may still land late, a running
// motor at a target speed other than the one EdgeLoop last had confirmed is
// that older speed - sent before a Disconnect and a reconnect, maybe under a
// higher cap - and the session's own speed goes out again at once rather
// than at its next change. A motor found stopped under the session by
// something else is never started again from here: the session pauses
// (stoppedUnderSession).
function observeDriven(link, state, seq, sentAt) {
    const moving = motionAfterStop(link, state, seq);
    if (moving && !drivenSinceStop(link)) {
        stopDrivenDevice(link, moving, sentAt);
        return;
    }
    for (const valve of strayValvesIn(link, state, seq)) closeStrayValve(link, valve);
    if (!motorRunningIn(state)) {
        if (stoppedUnderSession(link, state, seq)) noteStoppedElsewhere(link);
        return;
    }
    if (watchCoversSpeed(link.token) && link.lastSpeedSent > 0 && !link.speedInFlight
        && link.pendingSpeed === null && link.lastSpeedReported !== null && state.targetSpeed !== null
        && state.targetSpeed !== link.lastSpeedReported && seq > link.speedSettledSeq) {
        const speed = link.lastSpeedSent;
        callHandler('onNotice', `The VacuGlide was running at ${state.targetSpeed}% instead of the ${speed}% EdgeLoop sent - a speed Autoblow's server delivered late. EdgeLoop sent ${speed}% again.`);
        link.pendingSpeed = speed;
        link.forceSpeed = true;
        pumpSpeed(link);
    }
}

// The device a running session drives at a speed it confirmed, found by a
// request sent after that confirmation in a mode that runs nothing - paused,
// as Autoblow documents the answer to a stop - with no stop of this page's
// since: something else stopped it. Autoblow's own app, any other app using
// the device token, or a stop an earlier link of this page's sent that
// Autoblow's server delivered late. The session's next speed would start the
// motor again behind whoever stopped it: an earlier version of this driver
// did, 9 s after Autoblow's app had stopped it. A speed sent before anything
// has read the stop still does, unseen (steadyReadMs). A mode the device
// cannot be driven in is a fault, and ends the link (noteDeviceState).
function stoppedUnderSession(link, state, seq) {
    const mode = state.operationalMode;
    return Boolean(mode) && !isPlayingMode(mode) && !describeUnusableMode(mode)
        && sessionActive() && drivenSinceStop(link) && link.lastSpeedSent > 0 && seq > link.speedSettledSeq;
}

// What this page believed the device was doing is over: no speed of the
// session's is taken to be running on it, none is sent until the session
// has been paused and runs again (dispatchVacuglide), and the page pauses the
// session where the wearer is. The pause sends the whole stop, which a device
// already stopped takes as such; RESUME's speed is what starts it again.
function noteStoppedElsewhere(link) {
    if (link.stoppedElsewhere) return;
    link.stoppedElsewhere = 'held';
    cancelSpeed(link);
    link.lastSpeedSent = -1;
    link.lastSpeedReported = null;
    // A speed still out may yet land on it, and run it.
    if (!link.speedInFlight) link.motorMayRun = false;
    callHandler('onStoppedElsewhere', "The VacuGlide stopped while the session was driving it - Autoblow's app, another app using its device token, or a stop Autoblow's server delivered late. EdgeLoop paused the session and sends it no speed until you press RESUME.");
}

// A read of the driven device after a stretch with no request whose answer
// shows its state (steadyReadMs), while the session holds its speed, and
// before a new speed after such a stretch. Its answer is read like any other
// (observeDriven); a speed waits for it for up to readBeforeSpeedWaitMs,
// and then goes - unless that answer found the device stopped under the
// session. One that fails says nothing more than the link check that comes
// after it will. Never throws.
function readSteady(link) {
    if (link.steadyRead) return;
    const read = { at: Date.now() };
    link.steadyRead = read;
    const answered = vgRequest(link.cluster, VACUGLIDE_PATHS.state, { token: link.token, kind: 'normal', link, quiet: true }).catch(() => {});
    pauseUnless(VACUGLIDE_TIMINGS.readBeforeSpeedWaitMs, answered).then(() => {
        if (link.steadyRead !== read) return;
        link.steadyRead = null;
        // Read or not, the next one waits for the next stretch.
        link.lastSentAt = Math.max(link.lastSentAt, read.at);
        pumpSpeed(link);
    });
}

// Whether the session holds its speed on a device nothing has read for
// steadyReadMs: then it is read now.
function readWhileSteady(link) {
    if (link.speedInFlight || link.stopsInFlight > 0 || link.stoppedElsewhere) return;
    if (!(link.lastSpeedSent > 0) || !drivenSinceStop(link) || !sessionActive()) return;
    if (Date.now() - link.lastSentAt < VACUGLIDE_TIMINGS.steadyReadMs) return;
    readSteady(link);
}

// A device EdgeLoop no longer drives - disconnected, lost, left for another
// token, or taken over from a page that went away. Nothing here sends it a
// speed, so from its latest stop on it should be at rest, and a reply sent
// after that stop that shows the motor running or a valve open with no press
// holding it gets the whole stop again, at once. Such a reply only comes
// while something still reads it: the watch after a stop that went out with
// a command unanswered, for as long as that command can land. Once that has
// ended, a device that was let go belongs to whoever uses it next.
function observeLeft(link, state, seq, sentAt) {
    const moving = motionAfterStop(link, state, seq);
    if (moving) stopLeftDevice(link, moving, sentAt);
}

// The connected device, seen moving after its latest stop with no speed
// sent since by the answer to a request sent at `sentAt`: the whole stop
// again, at once, whatever stop is still out.
function stopDrivenDevice(link, moving, sentAt) {
    stopNotReaching(link, moving, sentAt);
    if (moving === 'motor') {
        link.motorMayRun = true;
        callHandler('onNotice', "The VacuGlide was running although EdgeLoop had stopped it - a speed Autoblow's server delivered late, or another app using this device token. EdgeLoop stopped it again.");
    } else {
        link.valveMayBeOpen[moving] = true;
        callHandler('onValves', null);
    }
    stopLinkWithRetry(link, { fresh: true }).then((ok) => {
        if (ok && moving !== 'motor' && live === link) callHandler('onValves', describeLateStop(moving));
    }, () => {});
}

// A reply to request `seq`, a part of whole stop `id`, which has had the
// parts in `confirmed` confirmed so far. On its own such a reply says
// nothing about a part still out - it may show the device from before that
// part landed. But a motion the stop has already had confirmed ended - the
// motor stopped, or that valve closed - showing again in a reply that came
// back after that confirmation is the device moving after its stop reached
// it, and it gets the whole stop again at once, as any other reply would
// get it (observeDriven, observeLeft): a speed that landed after STOP's
// motor stop and showed in the answer to one of STOP's closes ran on until
// the watch's next read. At most one such stop goes out for nothing - for a
// part the cloud answered after the confirmation but took before it - and
// the parts of that one all go out after the confirmation, so none of their
// replies can show the device from before it. No speed goes out while a
// stop is, but a press can: a valve a press holds is the wearer's, and one
// whose press's close was confirmed after this request went out was open
// before that close. Once a newer stop has gone out, its replies are the
// ones read this way; and a device connected again since answers through
// its new link. `sentAt` is when the request went out.
function observeStopReply(link, state, seq, confirmed, id, sentAt) {
    if (!state || link.stopId !== id || connectedAgain(link)) return;
    const moving = confirmed.motor && motorRunningIn(state) && !drivenSinceStop(link)
        ? 'motor'
        : valvesOpenIn(state).find((valve) => confirmed[valve] && !pulseHolds(link.token, valve)
            && seq > link.valveSettledSeq[valve]);
    if (!moving) return;
    if (live === link) stopDrivenDevice(link, moving, sentAt);
    else stopLeftDevice(link, moving, sentAt);
}

const VALVE_WORDS = { plus: 'Valve + (stroke plus)', minus: 'Valve - (stroke minus)' };

// Close a valve a reply showed open with no press holding it while a
// session drives the device: an open the cloud applied after its pulse had
// ended, or one another app sent with the same token. The session goes on;
// the close is confirmed and retried like any other, and one
// that never confirms raises the alarm - the pause that follows sends the
// whole stop again, and a device no longer connected gets the background
// stop. One close per valve at a time: the replies that land while it is
// out all show the same open.
function closeStrayValve(link, valve) {
    if (link.strayClosing[valve]) return;
    link.strayClosing[valve] = true;
    link.valveMayBeOpen[valve] = true;
    const connected = live === link;
    const startedAfterStop = stopsIssued;
    callHandler('onValves', null);
    closeValve(link, valve, { quiet: !connected }).then((closed) => {
        if (!closed.ok) {
            // A whole stop sent since this close set out, and confirmed, has
            // closed the valve already - this link's, or the stop of the link
            // the device was connected again through, here or on the page
            // that drives it now; that is not a close that failed.
            if (link.stopConfirmedId > startedAfterStop || connectedAgain(link) || !answersFor(link.token)) return;
            reportStopUnconfirmed(VACUGLIDE_VALVES[valve], closed.error, `Closing ${VALVE_WORDS[valve]}`, link.token);
            if (live !== link) beginSafetyJob(link);
            return;
        }
        // A press that began meanwhile owns the valve now; its own
        // confirmed close is the one that settles it.
        if (!pulseHolds(link.token, valve)) {
            link.valveMayBeOpen[valve] = false;
            link.valveSettledSeq[valve] = requestSequence;
        }
        if (connected && live === link) {
            callHandler('onValves', `${VALVE_WORDS[valve]} was open with no press holding it, so EdgeLoop closed it. A press Autoblow's server delivered late can do that, and so can another app using this device token.`);
        }
    }).catch(() => {}).finally(() => {
        link.strayClosing[valve] = false;
        callHandler('onValves', null);
    });
}

// PUT `path` with `body` until the reply confirms it, up to four attempts
// with backoff - and no more of them once another page drives the device
// (answersFor), or once this page has connected it again through a newer
// link (connectedAgain), whose connect confirmed a stop after anything this
// link sent: they would stop the session that page or that link runs, or
// cut a press there short. A motor stop of this link's answered after that,
// while the newer link drives the device, may have landed in its session,
// and the device is read at once (readAfterStaleStop). `isConfirmed(state)`
// reads the device state the reply carries, `onSent(seq, sentAt)` hears each
// attempt go out, and `onReply(state, confirmed, seq, sentAt)` hears every
// reply that comes back, with the number its request went out with and
// when. A part of a whole stop (`stopPart`) is in flight while each of its
// attempts is unanswered, so a stop that goes out after it watches the
// device for as long as it could still land (watchForLateCommand). Never
// throws. Resolves { ok, state, error }.
async function attemptCommand(target, path, body, isConfirmed, { link = null, countFailure = false, quiet = false, stopPart = false, onSent = null, onReply = null } = {}) {
    const delays = VACUGLIDE_TIMINGS.stopRetryDelaysMs;
    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (attempt > 0 && (!answersFor(target.token) || connectedAgain(target))) break;
        const flight = stopPart ? beginFlight(target, 'stop') : null;
        let seq = 0;
        let sentAt = 0;
        const sent = (number, when) => {
            seq = number;
            sentAt = when;
            if (typeof onSent === 'function') onSent(number, when);
        };
        try {
            const data = await vgRequest(target.cluster, path, { method: 'PUT', body, token: target.token, kind: 'critical', link, countFailure, quiet, stopPart, onSent: sent });
            if (path === VACUGLIDE_PATHS.stop) readAfterStaleStop(target);
            const state = parseVacuglideState(data);
            noteDeviceState(link, state);
            const confirmed = isConfirmed(state);
            if (typeof onReply === 'function') onReply(state, confirmed, seq, sentAt);
            if (confirmed) return { ok: true, state, error: null };
            lastErr = new Error(`The VacuGlide answered but did not report the change (${path})`);
            if (!quiet) reportError(path, lastErr.message);
        } catch (e) {
            lastErr = e;
        } finally {
            // A stop that lands late stops the device, which is no harm:
            // only a later stop's window is about it, and only while it is
            // still out.
            if (flight) dropFlight(flight);
        }
        if (attempt < delays.length) await sleep(delays[attempt]);
    }
    return { ok: false, state: null, error: lastErr };
}

// The three requests of a whole stop, by the name `unanswered` keeps them
// under.
const STOP_PARTS = ['motor', ...VALVE_NAMES];

// A part of a whole stop that is answered lands within a round trip. One
// still unanswered a read beat after it went out, to a device that may be
// moving, may not have reached it at all - the cloud swallowed a motor
// stop, and the two closes that went with it came back at once with the
// motor still running in them, which they were sent too early to say
// anything about - and nothing else need be reading the device: after
// Disconnect nothing did, and the motor ran on for 6 s, or for 26 s while
// every attempt was swallowed. So the device is watched from then on as for
// any command still out (watchForLateCommand): read at once, and on every
// beat until that part can no longer land, and stopped again at once when a
// read shows it moving. A part answered by then needs no read: the stop's
// own answer says what the device is doing.
function watchIfUnanswered(link, target, name, part) {
    const check = { link };
    stopChecks.add(check);
    atTime(part.sentAt + VACUGLIDE_TIMINGS.lateCommandWatchBeatMs, () => {
        if (!stopChecks.delete(check)) return;
        if (target.unanswered[name].includes(part)) watchForLateCommand(link, 0);
    });
}

// The whole stop: the motor, and both valves - Autoblow's stop leaves a
// valve as it was. The three go out together and each is confirmed on its
// own. From here on a reply to any other request shows the device after
// this stop went out (stopSeq), and a reply to one of its own parts is read
// against the parts it has had confirmed (observeStopReply). One sent
// through a link to a device that may be moving watches the device when a
// part of it is still unanswered a read beat after it went out
// (watchIfUnanswered). Never throws. Resolves
// { ok, error, states, latest, superseded }: `latest` says no whole stop for
// the link went out after this one, so what it confirmed is the last word
// on the device; `superseded`, that one sent after it was confirmed - the
// device was at rest after this stop went out, and this one failing says
// nothing more.
async function attemptFullStop(target, options = {}) {
    const id = ++stopsIssued;
    target.stopSeq = requestSequence;
    target.stopId = id;
    target.stopsInFlight = (target.stopsInFlight || 0) + 1;
    const confirmed = { motor: false, plus: false, minus: false };
    // Each part is unanswered until it settles, and `sentAt` says when its
    // first attempt went out - a request the budget holds back has not. One
    // confirmed settles every older stop's same part as well: the device was
    // at rest after them all.
    const out = {};
    for (const name of STOP_PARTS) {
        out[name] = { id, sentAt: 0, alarmed: false };
        target.unanswered[name].push(out[name]);
    }
    // A device at rest with nothing out that could move it stays at rest
    // whether this stop lands or not: reading it would only raise the alarm
    // over a device that was never moving, whenever a read failed.
    const watchParts = Boolean(options.link) && linkMayMove(options.link);
    const parts = (name) => ({
        ...options,
        stopPart: true,
        onSent: (seq, sentAt) => {
            if (out[name].sentAt) return;
            out[name].sentAt = sentAt;
            if (watchParts) watchIfUnanswered(options.link, target, name, out[name]);
        },
        onReply: (state, ok, seq, sentAt) => {
            if (ok) confirmed[name] = true;
            if (options.link) observeStopReply(options.link, state, seq, confirmed, id, sentAt);
        }
    });
    const part = (name, promise) => promise.then((result) => {
        target.unanswered[name] = target.unanswered[name].filter((e) => (result.ok ? e.id > id : e.id !== id));
        return result;
    });
    try {
        const results = await Promise.all([
            part('motor', attemptCommand(target, VACUGLIDE_PATHS.stop, undefined, stopConfirmedBy, parts('motor'))),
            part('plus', attemptCommand(target, VACUGLIDE_VALVES.plus, { valveState: false }, (state) => valveClosedBy(state, 'plus'), parts('plus'))),
            part('minus', attemptCommand(target, VACUGLIDE_VALVES.minus, { valveState: false }, (state) => valveClosedBy(state, 'minus'), parts('minus')))
        ]);
        const failed = results.find((r) => !r.ok);
        if (!failed) target.stopConfirmedId = Math.max(target.stopConfirmedId, id);
        return {
            ok: !failed,
            error: failed ? failed.error : null,
            states: results.map((r) => r.state),
            latest: target.stopId === id,
            superseded: target.stopConfirmedId > id
        };
    } finally {
        target.stopsInFlight -= 1;
    }
}

// Everything the device might still be doing because of this link - an
// open nobody answered, which may yet land, included.
function linkMayMove(link) {
    const watch = watches.get(link.token);
    return Boolean(link.motorMayRun || link.motionUnknown || link.speedInFlight
        || link.valveMayBeOpen.plus || link.valveMayBeOpen.minus
        || (pulse && pulse.link === link)
        || (watch && watch.active));
}

// What an ordinary zero-speed tick must stop. A valve held open by the
// pulse that is running right now is not a reason: the wearer pressed it a
// moment ago, and the engine ticks zero every second outside a session. A
// valve flagged open with no pulse behind it is one whose close was never
// confirmed, and that is exactly what the tick has to retry.
function linkNeedsStop(link) {
    if (link.motorMayRun || link.motionUnknown || link.speedInFlight) return true;
    return VALVE_NAMES.some((valve) => link.valveMayBeOpen[valve]
        && !(pulse && pulse.link === link && pulse.valve === valve));
}

// The latest whole stop, confirmed, settles what the device is doing. A
// valve with a pulse still running stays flagged whatever this close said:
// its open may not have been answered yet and can land after this close, or
// the wearer pressed it after the stop went out - either way the pulse's own
// close is the one that settles it. The panel's valve line is painted again:
// a close refused until the alarm went up, then confirmed by the next whole
// stop, left it saying the valve might still be open.
function settleStopped(link, clearMotor) {
    if (clearMotor) {
        link.motorMayRun = false;
        link.motionUnknown = false;
    }
    link.lastSpeedSent = -1;
    for (const valve of VALVE_NAMES) {
        if (pulse && pulse.link === link && pulse.valve === valve) continue;
        link.valveMayBeOpen[valve] = false;
    }
    callHandler('onValves', null);
    // The motor and both valves confirmed at rest by the newest stop: what
    // an unconfirmed stop of this device warned about is over.
    if (clearMotor) callHandler('onStopConfirmed', link.token);
}

function cancelSpeed(link) {
    link.pendingSpeed = null;
    link.forceSpeed = false;
    link.urgentSpeed = false;
    if (link.speedTimer !== null) {
        clearTimeout(link.speedTimer);
        link.speedTimer = null;
    }
}

// The confirmed stop for the connected device. Resolves true only when the
// motor and both valves were confirmed; the flags that say the device may
// be moving are cleared on that path alone, and only by the latest stop. An
// idle tick shares the stop already on its way when nothing has been sent
// since (`fresh` false): it only asks for the device to be at rest. STOP, a
// pause, a device seen moving after a stop and a speed answered after one
// each send a whole stop of their own at once, whatever stop is still out -
// one that is out has not been confirmed to have landed, and waiting for it
// to settle left a late speed running for as long as one of its closes went
// unanswered. A press made since the stop that is out ends with this one.
function stopLinkWithRetry(link, { fresh = false } = {}) {
    if (!fresh && stopInFlight && stopInFlight.link === link && stopInFlight.generation === commandGeneration) {
        return stopInFlight.promise;
    }
    const generation = ++commandGeneration;
    cancelSpeed(link);
    // From here the device's speed is unknown to us, so the next speed goes
    // out even if it is the number that was sent before.
    link.lastSpeedSent = -1;
    wakePulse(link);
    watchForLateCommand(link);
    const promise = (async () => {
        const result = await attemptFullStop(link, { link, countFailure: live === link });
        if (result.ok) {
            if (result.latest) settleStopped(link, generation === commandGeneration);
            return true;
        }
        // A whole stop sent after this one was confirmed - this link's, or
        // the connect's of the link the device was connected again through.
        if (!result.superseded && !connectedAgain(link)) reportStopUnconfirmed(VACUGLIDE_PATHS.stop, result.error, 'Stop', link.token);
        return false;
    })();
    const record = { link, generation, promise };
    stopInFlight = record;
    promise.catch(() => {}).finally(() => {
        if (stopInFlight === record) stopInFlight = null;
        // A speed that arrived while the stop was out goes now, after it.
        if (live === link) pumpSpeed(link);
    });
    return promise;
}

// Is the device behind `link` connected again, through a link made since?
// Then it is that link's to stop. Its connect's confirmed stop came after
// anything this link sent, its replies and its link check read the device
// from then on, and a command of this link's that lands late is watched for
// through it (watchForLateCommand). A stop or a close of this link's that
// fails after that is no alarm, and no reason to chase a device the wearer
// is driving again: Disconnect's stop, refused on a cluster the device had
// left, failed after the device was connected again on its new one - the
// alarm paused the session that had just started, and the chase stopped the
// device while the new link ran it.
function connectedAgain(link) {
    return Boolean(live && live !== link && live.token === link.token);
}

// A motor stop of `link`'s that Autoblow's server answered once the device
// had been connected again through a newer link, and driven since that
// link's own stop: it reached the device, maybe after the session's speed,
// and its answer is not read for the new link (observeStopReply). The
// device is read at once through the link that drives it, which then finds
// the motor stopped under it (observeDriven) rather than take it to run.
function readAfterStaleStop(link) {
    const now = live;
    if (!connectedAgain(link) || !drivenSinceStop(now)) return;
    vgRequest(now.cluster, VACUGLIDE_PATHS.state, { token: now.token, kind: 'watch', link: now }).catch(() => {});
}

function holdStopping(link) {
    link.stoppingHolds += 1;
    stopping.add(link);
    noteAnswering(link.token);
}

function releaseStopping(link) {
    link.stoppingHolds = Math.max(0, link.stoppingHolds - 1);
    if (link.stoppingHolds === 0) stopping.delete(link);
}

function describeLateStop(cause) {
    return cause === 'motor'
        ? "The VacuGlide started running again after EdgeLoop had stopped it - a speed Autoblow's server delivered late, or another app using this device token. EdgeLoop stopped it again and closed both valves."
        : `${VALVE_WORDS[cause]} was open after EdgeLoop had stopped the VacuGlide - a press Autoblow's server delivered late, or another app using this device token. EdgeLoop stopped it again and closed both valves.`;
}

// The confirmed stop for a device this driver no longer owns (Disconnect, a
// replaced or a lost link, a device a watch saw moving). A device that may
// have been running and does not confirm is reported and handed to the
// background job; one that was at rest is not an alarm, and Disconnect's own
// line says it did not answer. A confirmed one is all a background stop
// still chasing the device was for. Its requests never paint the panel of a
// device connected since (vgRequest). The link is in `stopping` from the
// first request to the last answer, so a page that goes away meanwhile still
// stops it and leaves it to the next page. `restarted` names what a watch
// saw move on a device a confirmed stop had brought to rest - 'motor' or a
// valve - which a confirmed stop then tells the panel about.
async function stopForeignLink(link, restarted = null) {
    watchForLateCommand(link);
    const mayMove = linkMayMove(link);
    holdStopping(link);
    let result;
    try {
        result = await attemptFullStop(link, { link });
    } finally {
        releaseStopping(link);
    }
    if (result.ok) {
        if (result.latest) settleStopped(link, true);
        cancelSafetyJob(link.token);
        noteTakeover(link.token, 'stopped');
        // What a page that has let go of the device since saw move may well
        // have been the session of the page that drives it now.
        if (restarted && answersFor(link.token)) {
            noteTakeover(link.token, 'caught');
            callHandler('onLateStop', describeLateStop(restarted));
        }
    } else if (mayMove && !result.superseded && !connectedAgain(link) && answersFor(link.token)) {
        // One alarm per device in doubt: a chase already running for it has
        // raised its own.
        const chase = safetyJobs.get(link.token);
        if (!(chase && chase.active && chase.reported)) reportStopUnconfirmed(VACUGLIDE_PATHS.stop, result.error, 'Stop', link.token);
        beginSafetyJob(link, { reported: true });
    }
    // A device taken over is finished with once this stop, and anything
    // else still running for it, has ended.
    settleTakeover(link.token);
    return result.ok;
}

// Public confirmed stop; safe to call at any time.
export async function stopVacuglide() {
    if (!live) return false;
    return stopLinkWithRetry(live, { fresh: true });
}

// A speed that was on its way when a stop was issued, and is answered after
// it, may have landed after that stop did - whether or not the stop has been
// answered yet. The whole stop goes out again at once. Waiting for the stop
// that was out to settle first left the speed running for 6 s when one of
// STOP's closes went unanswered once, and for 26 s when it kept going
// unanswered. That answer is no sign the stop is not reaching the device,
// though: it may show the device from before the stop landed, and on a link
// whose round trip took over a second it raised the alarm - which pauses a
// running session - over a stop that had landed. A read that goes out after
// the stop says whether it did (stopNotReaching). A device that has since
// been connected again under a new link is stopped through that link, so
// its bookkeeping stays true; one another page drives now is that page's.
function restopAfterStaleSpeed(link) {
    if (live && live.token === link.token) {
        stopLinkWithRetry(live, { fresh: true }).catch(() => {});
        return;
    }
    if (!answersFor(link.token)) return;
    stopForeignLink(link).catch(() => {});
}

// Send the pending speed if the rules allow it now: nothing unchanged, one
// request at a time, never while any whole stop for this link is out (the
// speed follows every stop, so none of them can land after it and stop the
// session unseen), at most once per VACUGLIDE_TIMINGS.speedGapMs, and only
// within the routine budget. From the moment it is sent, the device running
// is the session's: it may already have landed (driveSeq).
function pumpSpeed(link) {
    if (live !== link) return;
    if (link.speedInFlight) return;
    if (link.stopsInFlight > 0) return;
    // Stopped under the session by something else: nothing starts it again
    // but the session running again after its pause.
    if (link.stoppedElsewhere) return;
    // A read of the device is out: the speed waits for its answer - an
    // urgent one does not.
    if (link.steadyRead && !link.urgentSpeed) return;
    const speed = link.pendingSpeed;
    if (speed === null || speed <= 0) return;
    if (speed === link.lastSpeedSent && !link.forceSpeed && !link.motionUnknown) {
        link.pendingSpeed = null;
        link.urgentSpeed = false;
        return;
    }
    const now = Date.now();
    // An urgent speed goes now, not at the end of the gap: it is the speed a
    // guard or a landing decided in this tick, and every toy takes that in
    // the tick (tick-dispatch.js). It is still one request at a time, and
    // still routine traffic in the budget below, so it can never take a slot
    // the reserve keeps for a stop. Urgent decisions are edges - the tick a
    // guard engages, a landing begins - so they cannot raise the rate.
    const gap = link.urgentSpeed ? 0 : link.lastSpeedSentAt + VACUGLIDE_TIMINGS.speedGapMs - now;
    if (gap > 0) {
        if (link.speedTimer === null) {
            link.speedTimer = setTimeout(() => {
                link.speedTimer = null;
                pumpSpeed(link);
            }, gap);
            unref(link.speedTimer);
        }
        return;
    }
    // Held back by the budget: the engine asks again on its next tick.
    if (budgetFor(link.token).waitMs('normal', now) > 0) return;
    // After a stretch nothing has read the device in, it is read first. A
    // speed a tick sent urgent - a guard, a landing - does not wait for it.
    if (link.lastSpeedSent > 0 && !link.urgentSpeed && now - link.lastSentAt >= VACUGLIDE_TIMINGS.steadyReadMs) {
        readSteady(link);
        return;
    }
    link.pendingSpeed = null;
    link.forceSpeed = false;
    link.urgentSpeed = false;
    if (link.speedTimer !== null) {
        clearTimeout(link.speedTimer);
        link.speedTimer = null;
    }
    link.lastSpeedSentAt = now;
    const generation = commandGeneration;
    const flight = { speed, generation, seq: 0, droveBefore: link.driveSeq };
    link.speedInFlight = flight;
    const late = beginFlight(link, 'speed');
    vgRequest(link.cluster, VACUGLIDE_PATHS.targetSpeed, {
        method: 'PUT',
        body: { targetSpeed: speed },
        token: link.token,
        kind: 'normal',
        link,
        countFailure: true,
        onSent: (seq) => {
            flight.seq = seq;
            link.driveSeq = seq;
        }
    }).then((data) => {
        endFlight(link, late, 'answered');
        link.motorMayRun = true;
        if (generation !== commandGeneration) {
            restopAfterStaleSpeed(link);
            return;
        }
        const state = parseVacuglideState(data);
        link.lastSpeedSent = speed;
        link.lastSpeedReported = state ? state.targetSpeed : null;
        link.speedSettledSeq = requestSequence;
        link.motionUnknown = false;
        noteDeviceState(link, state);
    }, (e) => {
        // A timeout or a 5xx may still have reached the device - now, or
        // after a stop that nothing will follow up once this speed is
        // forgotten: the device is watched for it. Anything else never
        // reached it.
        endFlight(link, late, e && e.ambiguous ? 'unknown' : 'refused');
        if (e && e.local) {
            // Nothing was sent. Keep the number for the next attempt unless
            // a newer one, or a stop, has taken its place.
            if (generation === commandGeneration && link.pendingSpeed === null) link.pendingSpeed = speed;
            return;
        }
        if (e && e.ambiguous) link.motorMayRun = true;
        // Refused outright, it never reached the device: a motor found
        // running is not this speed.
        else if (flight.seq && link.driveSeq === flight.seq) link.driveSeq = flight.droveBefore;
        if (generation !== commandGeneration) {
            if (e && e.ambiguous) restopAfterStaleSpeed(link);
            return;
        }
        // Force a resend: a lost speed must not leave the device at the old one.
        link.lastSpeedSent = -1;
        if (e && e.ambiguous) link.motionUnknown = true;
    }).finally(() => {
        if (link.speedInFlight === flight) link.speedInFlight = null;
        pumpSpeed(link);
    });
}

// Main dispatch entry point: the target speed (0-100) app.js computed for
// the channel this device holds, under its cap. `force` is the STOP /
// Pause / Reset path: a zero with force always sends the whole stop.
// `urgent` (tick-dispatch.js: a cut, a guard's decision, Force Orgasm's
// landing) lets a speed past the gap between speeds - not past the one
// request in flight, nor past the routine budget - so it reaches the device
// as soon as the request before it has been answered. A zero needs no such
// pass: it is the whole stop, which goes at once and may spend the reserve.
export function dispatchVacuglide(speed, force = false, { urgent = false } = {}) {
    const link = live;
    if (!link) return;
    quickenPollForSession();
    dispatchSequence += 1;
    // Stopped under the session by something else: held until the session
    // has been paused - the pause the wearer was told of - and runs again.
    // RESUME, or a new START, starts the motor again; no tick of the session
    // it was stopped under does.
    if (link.stoppedElsewhere) {
        if (!sessionActive()) link.stoppedElsewhere = 'resumable';
        else if (link.stoppedElsewhere === 'resumable') link.stoppedElsewhere = null;
    }
    const target = clampTargetSpeed(speed);
    if (target === 0) {
        cancelSpeed(link);
        if (force || linkNeedsStop(link)) stopLinkWithRetry(link, { fresh: force }).catch(() => {});
        return;
    }
    link.pendingSpeed = target;
    if (force) link.forceSpeed = true;
    if (urgent) link.urgentSpeed = true;
    pumpSpeed(link);
    readWhileSteady(link);
}

// ---- valves ------------------------------------------------------------------------

function notifyPulse() {
    callHandler('onPulse', pulse ? { valve: pulse.valve, stage: pulse.stage } : { valve: null, stage: 'idle' });
}

// Ends a pulse's open time at once; the pulse then closes its valve itself.
function endHold(job) {
    job.holdEnded = true;
    if (typeof job.wake === 'function') job.wake();
}

// A stop, Disconnect or a lost link ends the running pulse's open time.
function wakePulse(link = null) {
    if (!pulse || (link && pulse.link !== link)) return;
    endHold(pulse);
}

function holdOpen(job, ms) {
    if (!(ms > 0) || job.holdEnded) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            job.wake = null;
            resolve();
        }, ms);
        job.wake = () => {
            clearTimeout(timer);
            job.wake = null;
            resolve();
        };
    });
}

// Close `valve` and confirm it: the reply must not still report it open.
// Not sent for a device another page drives now: its connect closed both
// valves after anything this page sent, it watches through its own link for
// an open of this page's landing late, and a close from here could cut a
// press made there short.
function closeValve(link, valve, { quiet = false } = {}) {
    if (!answersFor(link.token)) return Promise.resolve({ ok: false, state: null, error: new Error('Another EdgeLoop tab drives the VacuGlide now') });
    return attemptCommand(link, VACUGLIDE_VALVES[valve], { valveState: false }, (state) => valveClosedBy(state, valve), { link, quiet });
}

// One close on the beat, while the pulse's open may still land. It is
// routine traffic, not a confirmed close: it is not retried, and a minute
// that has spent its routine budget skips it rather than let it take a slot
// the reserve keeps for a STOP. Every pulse still ends in a confirmed close.
function closeValveOnBeat(link, valve) {
    if (!answersFor(link.token)) return Promise.resolve();
    return vgRequest(link.cluster, VACUGLIDE_VALVES[valve], { method: 'PUT', body: { valveState: false }, token: link.token, kind: 'normal', link })
        .then(() => {}, () => {});
}

// Was the open refused before it could reach the valve - by our own budget,
// a 4xx, a 429, or a DeviceNotConnectedError? Anything else that failed (a
// timeout, a network error, another 5xx) may still have reached it.
function openRefused(open) {
    return open.settled && !open.opened && !(open.error && open.error.ambiguous);
}

// One press of a valve button: open `valve` ('plus' | 'minus') for
// `durationMs` (clamped to the safe range), then close it and confirm the
// close. The pulse runs on its own clock from the moment the open is sent,
// and the close goes out when that clock runs out, answered or not. A close
// that waited for the reply would hold the valve open for as long as the
// cloud took to answer - up to the request timeout, three times the longest
// pulse the panel offers - and a long open is how a receiver pops off. A
// close sent before the open was answered may reach the device first, so an
// open answered after it is followed by another close, which cannot overtake
// an open the device has already applied. For as long as the open is
// unanswered it may still land, after every close sent so far, and its
// answer may never come: so the valve is closed again on every beat of
// VACUGLIDE_TIMINGS.pendingOpenBeatMs until it is answered, and an open
// nobody answered keeps being closed on the beat until our request for it
// has timed out and a guard after that, then once more, confirmed. The
// pulse ends there, so the buttons are not locked for a minute, but nothing
// says the cloud cannot apply the open later still: from then on the device
// is watched for it (watchForLateCommand), and any reply that shows the valve
// open gets it closed (observeReply). Resolves { ok, reason, message };
// `reason` is one of 'done', 'busy', 'offline', 'rate', 'invalid',
// 'open-failed', 'close-unconfirmed', 'let-go' - another tab connected the
// device while this press was still closing it, and drives it now.
export async function pulseValve(valve, durationMs = VALVE_PULSE_DEFAULT_MS) {
    const path = VACUGLIDE_VALVES[valve];
    if (!path) return { ok: false, reason: 'invalid', message: 'There is no such valve.' };
    const link = live;
    if (!link) return { ok: false, reason: 'offline', message: 'Connect the VacuGlide first.' };
    // Refused, not queued: presses must never add up to a long open.
    if (pulse) return { ok: false, reason: 'busy', message: 'The last valve press is still running. Wait for it to close.' };
    // The close already out for this valve could land after this press's
    // open and cut it short.
    if (link.strayClosing[valve]) {
        return { ok: false, reason: 'busy', message: `${VALVE_WORDS[valve]} was found open with no press holding it, and EdgeLoop is closing it. Press again once it has closed.` };
    }
    const wait = budgetFor(link.token).waitMs('open', Date.now());
    if (wait > 0) return { ok: false, reason: 'rate', message: describeRateWait(wait) };

    const job = { valve, link, ms: clampValvePulseMs(durationMs), stage: 'opening', holdEnded: false, wake: null };
    pulse = job;
    // An earlier close that was never confirmed leaves the flag set; this
    // press must not be what clears it.
    const wasFlagged = link.valveMayBeOpen[valve];
    link.valveMayBeOpen[valve] = true;
    notifyPulse();
    const open = { settled: false, opened: false, error: null };
    const finish = () => {
        if (pulse === job) pulse = null;
        notifyPulse();
    };
    // The open never reached the valve and no earlier open is outstanding:
    // there is nothing to close.
    const refused = () => {
        link.valveMayBeOpen[valve] = false;
        finish();
        return {
            ok: false,
            reason: open.error && open.error.local ? 'rate' : 'open-failed',
            message: open.error && open.error.message ? open.error.message : 'The valve did not open.'
        };
    };

    const sentAt = Date.now();
    const late = beginFlight(link, 'open');
    const answered = vgRequest(link.cluster, path, { method: 'PUT', body: { valveState: true }, token: link.token, kind: 'open', link })
        .then((data) => {
            endFlight(link, late, 'answered');
            open.settled = true;
            open.opened = true;
            noteDeviceState(link, parseVacuglideState(data));
            if (job.stage === 'opening' && !job.holdEnded) {
                job.stage = 'open';
                notifyPulse();
            }
        }, (e) => {
            endFlight(link, late, e && e.ambiguous ? 'unknown' : 'refused');
            open.settled = true;
            open.error = e;
            // Nothing to hold open: close now, if a close is needed at all.
            endHold(job);
        })
        // A pulse that never finished would leave both buttons locked.
        .catch(() => {});
    await holdOpen(job, sentAt + job.ms - Date.now());
    if (openRefused(open) && !wasFlagged) return refused();

    job.stage = 'closing';
    notifyPulse();
    const closedBeforeAnswer = !open.settled;
    const first = closeValve(link, valve);
    // The closes sent on the beat. Each is waited for before the pulse
    // ends, so none of them can land on the next press.
    const beats = [];
    const beat = VACUGLIDE_TIMINGS.pendingOpenBeatMs;
    let nextBeat = Date.now() + beat;
    // Settled within the request timeout; until then, closed on the beat.
    while (!open.settled) {
        await pauseUnless(nextBeat - Date.now(), answered);
        if (open.settled || Date.now() < nextBeat) continue;
        beats.push(closeValveOnBeat(link, valve));
        nextBeat += beat;
    }
    let closed;
    if (openRefused(open) && !wasFlagged) {
        // A refusal that came back after the close went out: that close
        // changes nothing, and its failure is no alarm.
        await Promise.all([first, ...beats]);
        return refused();
    }
    if (open.opened && closedBeforeAnswer) {
        // The close that settles it goes out on the answer, not once the
        // first close has been answered as well: a first close that reached
        // the device before the open leaves the valve open until this one
        // lands.
        [, closed] = await Promise.all([first, closeValve(link, valve), ...beats]);
    } else if (!open.opened && open.error && open.error.ambiguous) {
        // Nobody can say whether it landed, or whether it still will: it is
        // closed on the same beat until it can no longer be in flight, and
        // then once more, confirmed.
        const guardEnds = Date.now() + VACUGLIDE_TIMINGS.staleOpenGuardMs;
        for (; nextBeat < guardEnds; nextBeat += beat) {
            await sleepUntil(nextBeat);
            beats.push(closeValveOnBeat(link, valve));
        }
        await sleepUntil(guardEnds);
        [, closed] = await Promise.all([first, closeValve(link, valve), ...beats]);
    } else {
        [closed] = await Promise.all([first, ...beats]);
    }
    if (closed.ok) {
        link.valveMayBeOpen[valve] = false;
        link.valveSettledSeq[valve] = requestSequence;
    }
    // The guard is where this pulse stops closing the valve on its own, not
    // where the open stops being able to land: the device is watched for
    // it for the whole window from here, whether or not it is still
    // connected.
    const mayStillLand = !open.opened && Boolean(open.error && open.error.ambiguous);
    if (mayStillLand) extendFlight(link, late, Date.now() + VACUGLIDE_TIMINGS.lateCommandWatchMs);
    finish();

    // A device another page has connected since, or is connecting, is that
    // page's: its connect closes both valves, confirmed, after this press's
    // open was sent - or, failing to, answers for the device from there with
    // the alarm up - and it watches through its own link for that open
    // landing late. This page says so, rather than that the valve may still
    // be open.
    if ((!closed.ok || mayStillLand) && !connectedAgain(link) && !answersFor(link.token)) {
        return { ok: false, reason: 'let-go', message: 'Another EdgeLoop tab has connected this VacuGlide, or is connecting it, and closes both valves from there. This tab has let go of it.' };
    }
    // A device connected again meanwhile had both valves closed, confirmed,
    // by its new link's connect, after this press's open was sent.
    if (!closed.ok && !connectedAgain(link)) {
        // The alarm pauses the session, and the pause sends the whole stop
        // again; a device already lost gets the background job instead.
        reportStopUnconfirmed(path, closed.error, `Closing ${VALVE_WORDS[valve]}`, link.token);
        if (live !== link) beginSafetyJob(link);
        return { ok: false, reason: 'close-unconfirmed', message: `${VALVE_WORDS[valve]} did not confirm it closed.` };
    }
    if (mayStillLand) {
        const every = Math.max(1, Math.round(VACUGLIDE_TIMINGS.lateCommandWatchBeatMs / 1000));
        const seconds = Math.max(1, Math.round(VACUGLIDE_TIMINGS.lateCommandWatchMs / 1000));
        return {
            ok: false,
            reason: 'open-failed',
            message: `Autoblow's server never said whether the valve opened (${open.error.message}). EdgeLoop closed it, and reads its state every ${every} s for the next ${seconds} s in case the open still arrives.`
        };
    }
    if (!open.opened) {
        return { ok: false, reason: 'open-failed', message: open.error && open.error.message ? open.error.message : 'The valve did not open.' };
    }
    return { ok: true, reason: 'done', message: '' };
}

// ---- the link ---------------------------------------------------------------------

// Drop the link from our side and tell app.js. The session pauses there;
// a device that may still be running, or may have a valve open, keeps
// being sent the whole stop in the background until one is confirmed, and
// a command still out to it keeps it watched after that stop too.
function markOffline(link, reason, label = 'Offline') {
    if (!link || live !== link) return;
    live = null;
    commandGeneration += 1;
    stopPolling();
    cancelSpeed(link);
    wakePulse(link);
    // The device is to stop from here, whenever the stop reaches it: a read
    // that shows it running after this moment gets the whole stop at once,
    // not at the background stop's next round.
    link.stopSeq = requestSequence;
    link.stopId = ++stopsIssued;
    watchForLateCommand(link);
    if (linkMayMove(link)) beginSafetyJob(link);
    // This page answers for it now without driving it.
    publishHeld();
    callHandler('onOffline', reason, label);
}

// What the latency router says about the link. False when the link is
// gone: the device left online mode, or came back through another cluster -
// which means it dropped out for a while, and the session is paused for it
// like any other lost link rather than carried across as if nothing had
// happened.
function judgeDiscovery(link, reply) {
    if (!reply.connected) {
        markOffline(link, "The VacuGlide is no longer online: it left online mode or lost its connection to Autoblow's server.");
        return false;
    }
    if (reply.badCluster) {
        markOffline(link, "Autoblow's server now names a server EdgeLoop does not send tokens to.");
        return false;
    }
    if (reply.cluster !== link.cluster) {
        markOffline(link, `The VacuGlide dropped out and came back through another Autoblow server (${reply.cluster.replace('https://', '')}). Press Connect to take it back.`);
        return false;
    }
    return true;
}

// One discovery call after the cluster said DeviceNotConnectedError.
// Resolves once the router's answer has been acted on; never rejects.
function checkLink(link) {
    if (link.checking) return link.checking;
    const check = vgRequest(VACUGLIDE_DISCOVERY_BASE, VACUGLIDE_PATHS.connected, { token: link.token, kind: 'normal' })
        .then((data) => {
            if (live === link) judgeDiscovery(link, parseConnectedReply(data));
        })
        // Unreachable or held back: the ordinary failure counters decide.
        .catch(() => {})
        .finally(() => {
            if (link.checking === check) link.checking = null;
        });
    link.checking = check;
    return check;
}

function startPolling() {
    stopPolling();
    consecutivePollFailures = 0;
    schedulePoll();
}

function sessionActive() {
    return typeof handlers.isSessionActive === 'function' && Boolean(handlers.isSessionActive());
}

// The next link check, in a session's pace or in the pace between sessions -
// or `wait` from now when it is given.
function schedulePoll(wait = null) {
    const epoch = pollEpoch;
    pollPaceActive = sessionActive();
    const delay = wait !== null ? wait : (pollPaceActive ? VACUGLIDE_TIMINGS.pollActiveMs : VACUGLIDE_TIMINGS.pollIdleMs);
    pollDueAt = Date.now() + delay;
    pollTimer = unref(setTimeout(async () => {
        pollTimer = null;
        await pollVacuglideConnected();
        if (epoch === pollEpoch && live) schedulePoll();
    }, delay));
}

// A session has started while the next link check was timed between
// sessions: it comes within the session's pace from now, not at the end of
// the gap a Connect just before START set - the first check of such a
// session came about 30 s in. Every dispatch asks, so START does at once.
function quickenPollForSession() {
    if (pollTimer === null || pollPaceActive || !sessionActive()) return;
    const wait = Math.max(0, Math.min(pollDueAt - Date.now(), VACUGLIDE_TIMINGS.pollActiveMs));
    clearTimeout(pollTimer);
    pollTimer = null;
    schedulePoll(wait);
}

function stopPolling() {
    pollEpoch += 1;
    if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    consecutivePollFailures = 0;
}

// One link check: the device's state, read from the cluster it is on. It
// asks the same question the latency router would - a device that left
// online mode, or came back through another cluster, answers
// DeviceNotConnectedError there, and the router is then asked at once
// which it is - and it also shows the valves and the motor. Between
// sessions nothing else is sent, and a valve an open landing late left
// open was found by nothing at all. Exported so the timer logic stays
// testable.
export async function pollVacuglideConnected() {
    const link = live;
    if (!link) return;
    let data;
    try {
        data = await vgRequest(link.cluster, VACUGLIDE_PATHS.state, { token: link.token, kind: 'normal', link });
    } catch (e) {
        // The router's answer is the verdict on a DeviceNotConnectedError.
        if (e && e.notConnected && link.checking) await link.checking;
        if (live !== link) return;
        // Held back by our own budget, or refused for rate by a server that
        // plainly answered: neither says anything about the device.
        if (e && (e.local || e.rateLimited)) return;
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= OFFLINE_POLL_FAILURES) {
            markOffline(link, e && e.status
                ? `Autoblow's server failed three link checks in a row (${e.message}).`
                : "Autoblow's server is unreachable.");
        }
        return;
    }
    if (live !== link) return;
    consecutivePollFailures = 0;
    noteDeviceState(link, parseVacuglideState(data));
}

// ---- the background stop -------------------------------------------------------------

function finishSafetyJob(job) {
    job.active = false;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (safetyJobs.get(job.token) === job) safetyJobs.delete(job.token);
    settleTakeover(job.token);
}

function cancelSafetyJob(token) {
    const job = safetyJobs.get(token);
    if (job) finishSafetyJob(job);
}

// One round: ask the latency router where the device is now - it may have
// come back through another cluster - and send the whole stop there. A
// device that is not online cannot take it; the next round asks again. The
// link the device was lost from follows it, so the watch for a command
// still out to it reads where it is, and a reply that lands while this
// stop is out is not taken for a new move.
async function safetyRound(job) {
    const quiet = Boolean(live && live.token !== job.token);
    let reply = null;
    try {
        reply = parseConnectedReply(await vgRequest(VACUGLIDE_DISCOVERY_BASE, VACUGLIDE_PATHS.connected, { token: job.token, kind: 'critical', quiet }));
    } catch (e) {
        reply = null;
    }
    // Let go of while the router was asked, or connected in another tab
    // meanwhile - the round looked before it asked, and the router can take
    // up to a request timeout to answer: no stop from here into what that
    // tab runs.
    if (!job.active || !answersFor(job.token)) return { ok: false, error: null };
    if (reply && !reply.connected) {
        const error = new Error('The VacuGlide is not online');
        error.notOnline = true;
        return { ok: false, error };
    }
    if (reply && reply.cluster) {
        job.cluster = reply.cluster;
        if (live !== job.link) job.link.cluster = reply.cluster;
    }
    // A token only ever goes to a cluster the router named: a device the
    // router has not placed yet is asked again on the next round.
    if (!normalizeCluster(job.link.cluster)) return { ok: false, error: new Error("Autoblow's server could not say where the VacuGlide is") };
    return attemptFullStop(job.link, { link: job.link, quiet });
}

// Keep sending the whole stop to a device this driver lost while it may
// have been running, one round per VACUGLIDE_TIMINGS.offlineStopRetryMs,
// until one is confirmed, the same token is connected again (its connect
// stops the device itself), or the round cap is reached. A device that was
// merely slow, or comes back online, is brought to rest by this even
// though the app already gave up on it. One taken over from a page that
// went away gets what was left of that page's chase (`until`), and
// `reported` says that page had already raised the alarm for it. A device
// already being chased keeps its chase, run to the later of the two ends,
// with one alarm between them. A device another page drives now is that
// page's to stop: its connect confirmed a stop after this one went out.
function beginSafetyJob(link, { until = 0, reported = false } = {}) {
    if (connectedAgain(link) || !answersFor(link.token)) return;
    const existing = safetyJobs.get(link.token);
    if (existing && existing.active) {
        existing.reported = existing.reported || reported;
        if (existing.until) existing.until = until ? Math.max(existing.until, until) : 0;
        return;
    }
    const job = { token: link.token, cluster: link.cluster, link, rounds: 0, until, active: true, timer: null, reported, round: null };
    safetyJobs.set(link.token, job);
    noteAnswering(link.token);
    job.round = async () => {
        if (!job.active) return;
        job.timer = null;
        // Let go of, and with it this chase, once another page drives it.
        if (!answersFor(job.token)) return;
        job.rounds += 1;
        const result = await safetyRound(job);
        if (!job.active) return;
        if (result.ok) {
            if (result.latest) settleStopped(job.link, true);
            noteTakeover(job.token, 'stopped');
            finishSafetyJob(job);
            return;
        }
        // Before the cap: a chase taken over with little of it left may end
        // on its first round, and it must not end without the alarm.
        if (!job.reported) {
            job.reported = true;
            reportStopUnconfirmed(VACUGLIDE_PATHS.stop, result.error, 'Stop', job.token);
        }
        // A round let go of (another tab drives the device) says nothing.
        if (result.error) noteTakeover(job.token, 'failed', result.error);
        if (job.rounds >= OFFLINE_STOP_MAX_ROUNDS || (job.until && Date.now() >= job.until)) {
            noteTakeover(job.token, 'gaveUp');
            finishSafetyJob(job);
            return;
        }
        job.timer = unref(setTimeout(() => job.round(), VACUGLIDE_TIMINGS.offlineStopRetryMs));
    };
    job.round();
}

// What is left of a chase, for a page that goes away while it runs: the
// rounds it has not used yet, at the spacing they would have come at.
function safetyJobUntil(job, now) {
    if (job.until) return job.until;
    return now + Math.max(1, OFFLINE_STOP_MAX_ROUNDS - job.rounds) * VACUGLIDE_TIMINGS.offlineStopRetryMs;
}

// ---- commands that may land late, and the watch for them ----------------------------------

// A speed or a valve open is in flight from the moment it is sent until its
// answer comes back - the reply is the device's state after it, so it has
// landed - or until the API refuses it in a way that says it never reached
// the device: a 4xx, a 429, DeviceNotConnectedError, or our own budget,
// which sends nothing. One that fails without saying - a timeout, a network
// error, another 5xx - may land at any moment after that, and its answer
// will never come. It is kept until VACUGLIDE_TIMINGS.lateCommandWatchMs
// after EdgeLoop gave up on it (endFlight, extendFlight).
function beginFlight(link, what) {
    let set = flights.get(link.token);
    if (!set) {
        set = new Set();
        flights.set(link.token, set);
    }
    const flight = { token: link.token, cluster: link.cluster, what, pending: true, sentAt: Date.now(), landsUntil: Infinity };
    set.add(flight);
    return flight;
}

// A command a page that went away had sent, which may land until `until`
// (takeOver): nobody will answer it now, so it is one that failed without
// an answer.
function restoreFlight(link, what, until) {
    const flight = beginFlight(link, what);
    flight.pending = false;
    flight.landsUntil = until;
}

// Until when a command still out when its page goes away may land: the
// window the page that sent it would have given it. Its request would have
// timed out - an open is then closed on its pulse's beat until the guard -
// and it may land for lateCommandWatchMs after that. A page that goes away
// takes its request with it, which says no more about the cloud than a
// timeout does, so it is never less than that from now.
function landsUntil(flight, now) {
    if (!flight.pending) return flight.landsUntil;
    const gaveUp = flight.sentAt + VACUGLIDE_TIMINGS.requestTimeoutMs + (flight.what === 'open' ? VACUGLIDE_TIMINGS.staleOpenGuardMs : 0);
    return Math.max(now, gaveUp) + VACUGLIDE_TIMINGS.lateCommandWatchMs;
}

// `outcome` is 'answered', 'refused', or 'unknown': it may still land.
function endFlight(link, flight, outcome) {
    if (!flight.pending) return;
    flight.pending = false;
    if (outcome === 'unknown') {
        flight.landsUntil = Date.now() + VACUGLIDE_TIMINGS.lateCommandWatchMs;
        watchForLateCommand(link);
        return;
    }
    dropFlight(flight);
}

// A valve open nobody answered is closed on its pulse's beat until the
// pulse's guard ends, and the window it may still land in runs from there.
function extendFlight(link, flight, until) {
    flight.landsUntil = Math.max(flight.landsUntil, until);
    let set = flights.get(flight.token);
    if (!set) {
        set = new Set();
        flights.set(flight.token, set);
    }
    set.add(flight);
    watchForLateCommand(link);
}

function dropFlight(flight) {
    const set = flights.get(flight.token);
    if (!set) return;
    set.delete(flight);
    if (!set.size) flights.delete(flight.token);
}

// The end of the window in which a command sent with `token` may still
// land (landsUntil) - for one still out, the window its request timeout
// gives it - or 0 when none may. One whose window has closed is forgotten.
function lateWindow(token, now = Date.now()) {
    const set = flights.get(token);
    if (!set) return 0;
    let until = 0;
    for (const flight of set) {
        const end = landsUntil(flight, now);
        if (!flight.pending && end <= now) {
            set.delete(flight);
            continue;
        }
        until = Math.max(until, end);
    }
    if (!set.size) flights.delete(token);
    return until;
}

// Is the device behind `token` watched for a speed of EdgeLoop's own that
// may still land, or that did not long ago?
function watchCoversSpeed(token) {
    const job = watches.get(token);
    return Boolean(job && job.active && job.speed);
}

function isWatched(token) {
    const job = watches.get(token);
    return Boolean(job && job.active);
}

// Watch the device a command may still reach, from the first stop sent
// while one is out - a speed, a valve open, or a part of an earlier stop -
// or from the moment one fails without an answer: its state is read every
// VACUGLIDE_TIMINGS.lateCommandWatchBeatMs until the end of the window in
// which any of them can land, and each read goes through observeReply like
// any other reply. That end is fixed when the watch begins and only moves
// later: an answer that comes back meanwhile does not end the watch. A
// speed that lands after a stop is then stopped, and an open that lands
// after its pulse gave up on it is closed, within a beat of landing -
// instead of running on until something else happens to be sent, and
// between sessions nothing is. The watch runs whether or not the device is
// still connected, and through whichever link it is connected by now: a
// cloud slow enough to lose a command is slow enough to lose the link too,
// so a dropped link is where one is likeliest to land late. Another command
// extends the watch rather than starting a second one. Safe to call at any
// time: with nothing that may land, it does nothing. `speed` says a speed of
// EdgeLoop's own may land; `opens` says a valve open nobody answered may
// land, which the panel says it is watching for. The first read comes a
// beat after the stop that began the watch; `firstReadMs` brings it forward
// for a device taken over from a page that went away, whose last reads
// nobody made. `owed` ({ speed, opens }) is a window that ran out while no
// page was open to watch it: nothing can land any more, but what may have
// landed unseen still owes a read, and the watch makes at least that one.
// A device another page drives now is that page's to watch.
function watchForLateCommand(link, firstReadMs = VACUGLIDE_TIMINGS.lateCommandWatchBeatMs, owed = null) {
    if (!link || !answersFor(link.token)) return;
    const now = Date.now();
    const until = Math.max(lateWindow(link.token, now), owed ? now : 0);
    if (!(until > now) && !owed) return;
    let job = watches.get(link.token);
    const begins = !job || !job.active;
    let reaches = begins;
    if (begins) {
        job = { token: link.token, link, timer: null, active: true, until, speed: false, opens: false, blind: false };
        watches.set(link.token, job);
        scheduleWatch(job, firstReadMs);
    } else {
        reaches = until > job.until;
        job.until = Math.max(job.until, until);
        if (link.born > job.link.born) job.link = link;
    }
    const hadOpens = job.opens;
    const hadSpeed = job.speed;
    if (owed && owed.speed) job.speed = true;
    if (owed && owed.opens) job.opens = true;
    for (const flight of flights.get(link.token) || []) {
        if (flight.what === 'speed') job.speed = true;
        if (flight.what === 'open' && !flight.pending) job.opens = true;
    }
    if (job.opens && !hadOpens) callHandler('onValves', null);
    if (reaches || job.opens !== hadOpens || job.speed !== hadSpeed) noteAnswering(link.token);
}

function scheduleWatch(job, delay = VACUGLIDE_TIMINGS.lateCommandWatchBeatMs) {
    job.timer = unref(setTimeout(() => {
        job.timer = null;
        watchRound(job);
    }, delay));
}

// One read: through the connected link when the device is connected (again)
// - its cluster, and the bookkeeping the panel reads - and otherwise through
// the newest link it was reached through, quietly, so a device that is no
// longer connected paints no error onto the panel of whatever is. A read
// that cannot see the device raises the alarm (cannotSee). The last read
// goes out once the window has closed. A read is a safety read, made in the
// watch's own share of the budget, which a busy session's routine traffic
// cannot spend. One sent through a link the device has been connected again
// past since - to the cluster it has left, as often as not - that fails
// says nothing of the device: the newer link confirmed it at rest after
// that read went out. The read is made again through that link at once,
// and only when that one cannot see the device either is the alarm raised.
async function watchRound(job) {
    if (!job.active) return;
    // Let go of, and with it this watch, once another page drives it.
    if (!answersFor(job.token)) return;
    if (live && live.token === job.token) job.link = live;
    let link = job.link;
    const last = !(job.until > Date.now());
    let failure = await watchRead(job, link);
    if (failure && job.active && answersFor(job.token) && connectedAgain(link)) {
        job.link = live;
        link = live;
        failure = await watchRead(job, link);
    }
    if (!job.active) return;
    if (!failure) {
        job.blind = false;
    } else if (!job.blind) {
        job.blind = true;
        cannotSee(link, failure);
    }
    if (!last || job.until > Date.now()) {
        scheduleWatch(job);
        return;
    }
    finishWatch(job);
}

// One read of the watch's through `link`. Resolves null, or what it failed
// with.
async function watchRead(job, link) {
    try {
        const data = await vgRequest(link.cluster, VACUGLIDE_PATHS.state, { token: job.token, kind: 'watch', link, quiet: live !== link });
        noteDeviceState(link, parseVacuglideState(data));
        return null;
    } catch (e) {
        // A device that is not on this cluster any more may have dropped
        // out and come back through another one, still running what landed
        // before it dropped: the next read looks where it is now - unless
        // it has been connected again here, through its new link.
        if (e && e.notConnected && live !== link && !connectedAgain(link)) await followDevice(link);
        return e || new Error('no answer');
    }
}

// Ask the router where a device EdgeLoop no longer drives is now, and send
// the watch's reads - and the stop, when it needs one - there. Never throws.
async function followDevice(link) {
    try {
        const reply = parseConnectedReply(await vgRequest(VACUGLIDE_DISCOVERY_BASE, VACUGLIDE_PATHS.connected, { token: link.token, kind: 'normal', quiet: true }));
        if (reply.connected && reply.cluster && live !== link) link.cluster = reply.cluster;
    } catch (e) {}
}

// A read the watch made could not see the device - unreachable, not
// online, refused for rate, or held back by our own budget - while a
// command EdgeLoop sent may still land on it, or may have landed with nobody
// told: nobody can say it is at rest. The alarm goes up now, not when the
// window closes a minute later, and on this page: the one that drives the
// device, last drove it, or took it over. The connected device is flagged
// as moving for all EdgeLoop knows - the next idle tick sends it the whole
// stop, a running session its speed again - and one EdgeLoop no longer
// drives is chased: the whole stop, until one is confirmed. Once for each
// stretch of reads that cannot see it.
function cannotSee(link, failure) {
    const message = `EdgeLoop could not read the VacuGlide while a command it sent may still reach it (${failure && failure.message ? failure.message : 'no answer'})`;
    if (live && live.token === link.token) {
        live.motionUnknown = true;
        reportError(VACUGLIDE_PATHS.state, message);
        callHandler('onStopUnconfirmed', message, link.token);
        return;
    }
    if (!answersFor(link.token)) return;
    const chase = safetyJobs.get(link.token);
    if (!(chase && chase.active && chase.reported)) callHandler('onStopUnconfirmed', message, link.token);
    beginSafetyJob(link, { reported: true });
}

// Is anything still running here for the device behind `token`: its chase,
// its watch, or a whole stop out for a link to it?
function doubtRunning(token) {
    const job = safetyJobs.get(token);
    if (job && job.active) return true;
    if (isWatched(token)) return true;
    for (const link of stopping) if (link.token === token) return true;
    return false;
}

function finishWatch(job) {
    job.active = false;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (watches.get(job.token) === job) watches.delete(job.token);
    if (job.opens) callHandler('onValves', null);
    settleTakeover(job.token);
}

// The whole stop, again, at once, for a device EdgeLoop no longer drives
// that the answer to a request sent at `sentAt` showed moving after its
// latest stop (observeLeft) - whatever stop is still out for it, a
// background stop's round among them: that one went out before this reply's
// request did, and the device moved after it. The motor is flagged as maybe
// running, or the valve as maybe open, until a stop is confirmed, so one
// that does not confirm raises the alarm and is chased (stopForeignLink).
// Only a device a confirmed stop had brought to rest is said to have
// started again. A device another page drives now is running that page's
// session, and is left to it.
function stopLeftDevice(link, cause, sentAt) {
    if (!answersFor(link.token)) return;
    stopNotReaching(link, cause, sentAt);
    const restarted = cause === 'motor' ? !link.motorMayRun : !link.valveMayBeOpen[cause];
    if (cause === 'motor') link.motorMayRun = true;
    else link.valveMayBeOpen[cause] = true;
    stopForeignLink(link, restarted ? cause : null).catch(() => {});
}

// ---- connect / disconnect ------------------------------------------------------------

// Where the device is: the latency router answers for any token, and names
// the cluster every later request must go to. Throws a sentence the wearer
// can act on.
//
// Connecting is also how a device that was left running gets stopped - a
// page that crashed took its stop with it, and the device has no watchdog -
// and the page before this one may have spent the routine budget in the
// same minute. So this one call may use the reserve a stop may use. It
// never waits for a slot: a budget spent to the ceiling says so at once,
// rather than leave the panel on "Finding..." for up to a minute.
async function discover(token) {
    const wait = budgetFor(token).waitMs('critical', Date.now());
    if (wait > 0) {
        const err = new Error(describeRateWait(wait));
        err.local = true;
        throw err;
    }
    let data;
    try {
        data = await vgRequest(VACUGLIDE_DISCOVERY_BASE, VACUGLIDE_PATHS.connected, { token, kind: 'critical' });
    } catch (e) {
        if (e && e.local) throw e;
        if (e && e.rateLimited) {
            throw new Error("Autoblow's server refused the request: this device token hit its request limit. Close any other app using this VacuGlide, wait a minute and try again.");
        }
        if (e && e.status) throw new Error(`Autoblow's server refused the request. (${e.message})`);
        throw new Error(`Could not reach Autoblow's server. (${e && e.message ? e.message : 'network error'})`);
    }
    const reply = parseConnectedReply(data);
    if (!reply.connected) {
        throw new Error("Autoblow's server says this VacuGlide is not online. Turn on its online mode (hold the mode button for about 2.5 seconds) and check the token - a mistyped token looks exactly like a device that is offline.");
    }
    if (reply.badCluster) {
        throw new Error("Autoblow's server pointed EdgeLoop at a server it does not recognise, so the token was not sent there.");
    }
    const foreign = foreignDeviceType(reply.deviceType);
    if (foreign) throw new Error(describeForeignDevice(foreign));
    return reply;
}

// GET /info, for the status line. Only what the panel shows is kept - the
// reply also carries the device's MAC, which nothing here needs. Null when
// the call fails: the firmware line is not a reason to refuse a device.
async function readInfo(token, cluster) {
    let info;
    try {
        info = await vgRequest(cluster, VACUGLIDE_PATHS.info, { token, kind: 'normal' });
    } catch (e) {
        if (e && e.notConnected) {
            throw new Error('The VacuGlide dropped out of online mode while connecting. Turn online mode back on and try again.');
        }
        return null;
    }
    if (!info || typeof info !== 'object') return null;
    const foreign = foreignDeviceType(info.deviceType);
    if (foreign) throw new Error(describeForeignDevice(foreign));
    const keep = {};
    for (const name of ['firmwareVersion', 'firmwareStatus', 'firmwareBranch', 'hardwareVersion', 'deviceType']) {
        if (info[name] !== undefined) keep[name] = info[name];
    }
    return keep;
}

// Connect: find the device, read its firmware, and bring it to rest - motor
// stopped and both valves closed, each confirmed - before it is handed to
// the engine. What a page that went away left for this device is taken over
// through the new link first, before that stop, which is the link's first
// command: whatever may still land from that page is watched for through
// this link, and this stop settles what that page could not. A page that
// was open before the other one went away - the wearer back in an older tab
// - leaves nothing behind for the next page to load, which would otherwise
// watch the device and stop this session on every read for a minute. Until
// the connect ends, what it took is held in storage marked connecting
// (claimHandover): a page that held the device lets go of it, and another
// page that connects the same device meanwhile takes it from this one. If the
// connect fails after that, the device is watched and stopped as a page that
// loads would (takeOver), and nothing that page left is lost - unless another
// page has connected the device meanwhile and taken it: that page answers for
// it, and this one lets go of it. A page that goes away before that stop is
// confirmed sends the device the unload stop, and leaves what it took for the
// next page, as it would a device it drives. One device at a time: a
// connected VacuGlide is disconnected first (its panel shows Disconnect in
// place of Connect), so a connect never has a live device to take over from.
// Resolves { info, description, cluster, battery }; throws a readable Error
// on any failure, with nothing connected.
export async function connectVacuglide(rawToken) {
    const token = sanitizeDeviceToken(rawToken);
    if (!token) {
        throw new Error('That is not a device token. Paste it exactly as Autoblow shows it: plain letters and digits, no spaces, at most 128 characters.');
    }
    if (live) throw new Error('A VacuGlide is already connected. Disconnect it first.');
    if (connectInFlight) throw new Error('A connection attempt is already running.');
    connectInFlight = true;
    const epoch = connectEpoch;
    try {
        const reply = await discover(token);
        const info = await readInfo(token, reply.cluster);
        const candidate = makeLink(token, reply.cluster, info);
        // This page answers for the device from here, whatever it had let
        // go of before, and takes what other pages left or hold for it.
        released.delete(token);
        connecting = token;
        const left = claimHandover(token);
        let connected = false;
        try {
            if (left) {
                restoreLeftCommands(candidate, left, Date.now());
                // What another page could not vouch for is this page's until
                // the stop below is confirmed: a speed of its may have landed
                // already, even one whose window has closed. So what this
                // page holds for the device while it connects it - and what
                // it leaves, should it go away first - owes the whole stop.
                candidate.motionUnknown = true;
            }
            // A command an earlier link, or a page that went away, sent this
            // device may still be out, and may land after this stop as well
            // as before it.
            watchForLateCommand(candidate);
            let rest;
            holdStopping(candidate);
            try {
                rest = await attemptFullStop(candidate);
            } finally {
                releaseStopping(candidate);
            }
            if (!rest.ok) {
                throw new Error(`The VacuGlide did not confirm that its motor stopped and both valves closed, so it was not connected. (${rest.error && rest.error.message ? rest.error.message : 'no answer'})`);
            }
            const unusable = rest.states.map((state) => state && describeUnusableMode(state.operationalMode)).find(Boolean);
            if (unusable) throw new Error(`${unusable} Check the device, then connect again.`);
            if (epoch !== connectEpoch) throw new Error('Disconnect was pressed while connecting, so nothing was connected.');
            connected = true;
        } finally {
            // Not when another page has taken what this connect held while it
            // ran: it connected the device meanwhile, and answers for it.
            if (left && !connected && answersFor(token)) takeOver(left, Date.now());
        }
        // The device is this link's from here, and its panel says so: one
        // taken over from a page that went away is not reported on as well.
        // A watch still running for it carries on through this link. A
        // crash stop it carried is answered by this connect's own stop.
        dropTakeover(token, { outcome: RECOVERY_STOP.CONNECTED, detail: 'here', final: true });
        // Its own confirmed stop covers any background stop still running
        // for this token.
        cancelSafetyJob(token);
        // That stop is the last word on the valves and the motor until a
        // reply sent after it says otherwise.
        settleStopped(candidate, true);
        live = candidate;
        // Whatever another page did while this one was connecting it, the
        // device this page drives is its own to answer for - and to stop
        // when the page goes away.
        released.delete(token);
        commandGeneration += 1;
        consecutiveDispatchFailures = 0;
        lastFailedDispatch = -1;
        lastReportedError = null;
        rateNoticeShown = false;
        // What another page stored for the device while this connect ran is
        // taken over through this link as well, before the device is driven.
        // A page that held the device and went away in the moment this
        // connect took what it held - before that write had reached it:
        // localStorage makes no tab wait for another's - left it again as one
        // that went away, and the next EdgeLoop page to load would have taken
        // it over and stopped the session this page then ran.
        const late = claimHandover(token);
        if (late) takeOver(late, Date.now());
        startPolling();
        return {
            info,
            description: describeVacuglideInfo(info),
            cluster: candidate.cluster,
            battery: null
        };
    } finally {
        connectInFlight = false;
        connecting = null;
        // Driven here now, the device needs no held entry of this page's; a
        // connect that failed holds what this page still answers for, no
        // longer marked connecting.
        publishHeld();
    }
}

// Disconnect from our side. The link drops at once; the whole stop it
// sends is awaited, and resolves { confirmed, mayHaveMoved, watching } so
// the panel can say whether the device confirmed it - and whether that
// matters - and whether a command EdgeLoop sent it may still land after
// that stop, which the device is then watched for (watchForLateCommand).
// `letGo: true` joins them when another tab connected the device before
// that stop was through: that tab drives it now, its connect confirmed a
// stop of its own, and this page has let go of the device and says so.
export function disconnectVacuglide() {
    connectEpoch += 1;
    const link = live;
    stopPolling();
    live = null;
    commandGeneration += 1;
    rateNoticeShown = false;
    if (!link) return Promise.resolve({ confirmed: true, mayHaveMoved: false, watching: false });
    cancelSpeed(link);
    wakePulse(link);
    const mayHaveMoved = linkMayMove(link);
    const stopped = stopForeignLink(link);
    // This page answers for the device now without driving it: a page that
    // connects it takes that over.
    publishHeld();
    return stopped.then((confirmed) => {
        const letGo = !answersFor(link.token);
        return { confirmed, mayHaveMoved, watching: isWatched(link.token), ...(letGo ? { letGo } : {}) };
    });
}

// Last-resort stop when the page goes away (pagehide / freeze). A plain
// request would be cancelled with the document, so the whole stop is sent
// with keepalive - fetch, because sendBeacon can neither PUT nor set the
// x-device-token header. It goes to the connected device, to any device a
// background stop is still chasing, to any device a whole stop is still
// out for - Disconnect's among them - to the device of a valve pulse that
// is still closing after its link was dropped, and to any device still
// watched for a command that may land late - whatever they were doing:
// the page will not be here to find out, nor to retry a stop, send the
// pulse's own closes or read what the watch would have read - except a
// device another page drives now. Nobody reads the answers, so a page that
// comes back re-sends its speed if its session is still running, confirms
// with a real stop a device it may have left moving, and reads anything it
// sees moving before that as moving after a stop; a page that does not come
// back leaves every device it cannot vouch for to the page that takes it
// over (leaveHandover). Returns whether a stop was sent. Never throws.
export function stopVacuglideOnUnload() {
    // What this page holds is looked at first, and a device another tab has
    // connected since this page last looked is let go of here (answersFor):
    // this page sends it nothing and leaves nothing of it. A page that
    // looked only at its next read, stop or alarm, and was closed in the
    // two seconds after the wearer connected the device in another tab,
    // sent the whole stop into the session that tab then ran, and left its
    // entry as one that went away; the next EdgeLoop page to load took it
    // over and stopped that session on every read for a minute, 14 times,
    // telling the wearer a late speed had landed. Frozen instead, the page
    // came back holding the device and stopped the session itself.
    for (const token of [...holding]) answersFor(token);
    // A page that is only frozen comes back, and a command still out may
    // land after this stop like after any other.
    if (live) watchForLateCommand(live);
    if (pulse) watchForLateCommand(pulse.link);
    leaveHandover(Date.now());
    const targets = [];
    const seen = new Set();
    const reached = new Set();
    // A device another page drives now is running that page's session.
    const add = (link, token = link.token, cluster = link.cluster) => {
        if (released.has(token)) return;
        if (link) reached.add(link);
        const id = `${token}\n${cluster}`;
        if (!token || !cluster || seen.has(id)) return;
        seen.add(id);
        targets.push({ token, cluster });
    };
    if (live) add(live);
    for (const job of safetyJobs.values()) if (job.active) add(job.link, job.token, job.cluster);
    for (const link of stopping) add(link);
    if (pulse) add(pulse.link);
    for (const job of watches.values()) {
        if (!job.active) continue;
        add(live && live.token === job.token ? live : job.link);
    }
    if (!targets.length) return false;

    // The connected device's speed is unknown from here, so a page that
    // comes back sends its session's speed again. What it may be doing is
    // not: the stop can only have stopped it, and a device EdgeLoop may have
    // left moving is flagged so already - a page that comes back sends it a
    // stop of its own on the next idle tick. A device that was at rest stays
    // one: marking it unknown here left a freeze right after a pagehide - a
    // page going into the back-forward cache gets both - writing a stop
    // owed for a device at rest, which the next EdgeLoop page to load, days
    // later, chased with the "may still be running" alarm.
    if (live) {
        commandGeneration += 1;
        cancelSpeed(live);
        live.lastSpeedSent = -1;
    }
    // A whole stop goes out to each of them now, and a stop any other goes
    // out after this one is not the last word on the device. Nobody will read
    // its answers, so nothing can be said later of how fast it landed.
    for (const link of reached) {
        link.stopSeq = requestSequence;
        link.stopId = ++stopsIssued;
        link.unanswered = { motor: [], plus: [], minus: [] };
    }
    const requests = [
        [VACUGLIDE_PATHS.stop, undefined],
        [VACUGLIDE_VALVES.plus, { valveState: false }],
        [VACUGLIDE_VALVES.minus, { valveState: false }]
    ];
    let sent = false;
    for (const target of targets) {
        for (const [path, body] of requests) {
            try {
                const headers = { 'x-device-token': target.token };
                const init = { method: 'PUT', headers, keepalive: true };
                if (body !== undefined) {
                    headers['Content-Type'] = 'application/json';
                    init.body = JSON.stringify(body);
                }
                budgetFor(target.token).record('critical', Date.now());
                const pending = fetch(`${target.cluster}${path}`, init);
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
                sent = true;
            } catch (e) {}
        }
    }
    return sent;
}

// ---- the page that goes away, and the page after it ------------------------------------

// How far ahead a window taken over may reach: the longest this driver gives
// a device - the chase for one lost while it may have been running, or a
// command still out and the window after it. A stored time beyond that is a
// clock that went back, or a damaged store (decodeHandover).
function handoverHorizonMs() {
    const t = VACUGLIDE_TIMINGS;
    return Math.max(OFFLINE_STOP_MAX_ROUNDS * t.offlineStopRetryMs, t.requestTimeoutMs + t.staleOpenGuardMs + t.lateCommandWatchMs);
}

// Where a device was last reached, by whatever still knows it.
function clusterFor(token) {
    if (live && live.token === token) return live.cluster;
    const job = safetyJobs.get(token);
    if (job && job.active) return job.cluster;
    const watch = watches.get(token);
    if (watch && watch.active) return watch.link.cluster;
    if (pulse && pulse.link.token === token) return pulse.link.cluster;
    for (const link of stopping) if (link.token === token) return link.cluster;
    for (const flight of flights.get(token) || []) if (flight.cluster) return flight.cluster;
    return '';
}

// Could the device behind `link` be moving right now on something EdgeLoop
// sent it: a speed that reached it, or may have, with no stop confirmed
// since; a request whose outcome nobody read; a valve not confirmed closed;
// a press still running on it?
function linkUnsettled(link) {
    return Boolean(link.motorMayRun || link.motionUnknown || link.valveMayBeOpen.plus || link.valveMayBeOpen.minus
        || (pulse && pulse.link === link));
}

// What this page leaves: one entry per device it cannot vouch for. Every
// window in which a speed or a valve open it sent may still land goes in,
// and so does the rest of every watch still running - a watch never ends
// early, and one whose window has closed with its last read still to make
// goes in as a window that closed now, which the page that takes it over
// reads at once. So does the whole stop, until one is confirmed, for a
// device that may be moving now - its unload stop is one nobody will hear
// land - or that a background stop is still chasing, with what is left of
// that chase and whether its alarm is up. That is the connected device, a
// pulse's, a watched one, and one a whole stop is still out for. The
// connected device at rest, with nothing out, is not in it: the unload stop
// is all it needs. Nor is a device another page drives now (standDown).
function handoverEntries(now) {
    const entries = new Map();
    const entryFor = (token) => {
        let entry = entries.get(token);
        if (!entry) {
            entry = { token, cluster: clusterFor(token), page: PAGE_ID, at: now, speedUntil: 0, openUntil: 0, stopUntil: 0, alarm: false };
            entries.set(token, entry);
        }
        return entry;
    };
    for (const [token, set] of flights) {
        for (const flight of set) {
            // A stop that lands late only stops the device: the watch below
            // carries the window it gave a stop that went out after it.
            if (flight.what === 'stop') continue;
            const until = landsUntil(flight, now);
            if (!(until > now)) continue;
            const entry = entryFor(token);
            if (flight.what === 'speed') entry.speedUntil = Math.max(entry.speedUntil, until);
            else entry.openUntil = Math.max(entry.openUntil, until);
        }
    }
    for (const job of watches.values()) {
        if (!job.active) continue;
        const entry = entryFor(job.token);
        const until = Math.max(job.until, now);
        if (job.opens) entry.openUntil = Math.max(entry.openUntil, until);
        if (job.speed || !job.opens) entry.speedUntil = Math.max(entry.speedUntil, until);
    }
    const chase = now + OFFLINE_STOP_MAX_ROUNDS * VACUGLIDE_TIMINGS.offlineStopRetryMs;
    const links = [...stopping];
    if (live) links.push(live);
    if (pulse) links.push(pulse.link);
    for (const job of watches.values()) if (job.active) links.push(job.link);
    for (const link of links) {
        if (!linkUnsettled(link)) continue;
        const entry = entryFor(link.token);
        entry.stopUntil = Math.max(entry.stopUntil, chase);
    }
    for (const job of safetyJobs.values()) {
        if (!job.active) continue;
        const entry = entryFor(job.token);
        entry.stopUntil = Math.max(entry.stopUntil, safetyJobUntil(job, now));
        entry.alarm = entry.alarm || job.reported;
    }
    return [...entries.values()].filter((entry) => entry.cluster && !released.has(entry.token));
}

function readHandoverStore(now) {
    const raw = safeGet(VACUGLIDE_HANDOVER_STORAGE_KEY, null);
    return { raw, entries: decodeHandover(raw, { now, maxAheadMs: handoverHorizonMs() }) };
}

function writeHandover(entries) {
    const text = encodeHandover(entries);
    if (text === null) safeRemove(VACUGLIDE_HANDOVER_STORAGE_KEY);
    else safeSet(VACUGLIDE_HANDOVER_STORAGE_KEY, text);
}

// Leave what this page cannot finish (stopVacuglideOnUnload), beside what
// other pages left, and in place of what this page left before - a freeze,
// then a pagehide. Where storage is blocked nothing is left, and this
// page's unload stop is all there is, as on The Handy.
function leaveHandover(now) {
    try {
        const mine = handoverEntries(now);
        if (!mine.length && safeGet(VACUGLIDE_HANDOVER_STORAGE_KEY, null) === null) return;
        const store = readHandoverStore(now);
        writeHandover([...store.entries.filter((entry) => entry.page !== PAGE_ID), ...mine]);
    } catch (e) {}
}

// ---- the page that drives the device answers for it -------------------------------------
//
// A page can answer for a device it does not drive: one it took over from a
// page that went away, or one it let go of - Disconnect, a lost link - while
// a command to it was still out, a stop still unanswered, or a chase still
// running. Another EdgeLoop tab can meanwhile connect that device and drive
// it, and from then on this page cannot tell that session from a command of
// its own landing late: a page that had taken a reloaded tab's device over
// read the session the wearer then ran from an older tab as a late speed,
// and sent it the whole stop every 2 s for a minute - 18 stops, the device
// paused at 25 of 40 samples, a valve press there refused for rate - and the
// page that came back from the back-forward cache to its own session had it
// stopped 14 times by a tab opened while it was away. The page that drives
// the device answers for it. So a page answering for one it does not drive
// keeps its entry in storage, held, and writes it again whenever what it
// answers for reaches further; a page that connects the device, or comes
// back with it connected, takes that entry like any other, and watches
// through its own link for whatever this page was watching for; and this
// page lets go of the device the next time it would read it, stop it, close
// a valve on it or raise the alarm for it, and when it goes away or is
// frozen (answersFor). A page that loads leaves a held entry alone: the page
// that holds it is still open and answers for the device. A page that is
// connecting the device holds what it answers for marked connecting until
// the connect ends: a page that holds the device lets go of it for that as
// for no entry at all, and another page connecting it at the same moment
// takes that entry, and with it the device.

// Is an entry of this page's for `token` still in storage? One this page
// left on its way out counts: it is this page's, and nobody took it yet.
function ownEntryFor(entries, token) {
    return entries.some((entry) => entry.page === PAGE_ID && entry.token === token);
}

// Has a page that drives the device taken what this page held for it? Such a
// page takes every entry for the device, and holds what it answers for itself
// marked connecting until it drives it (claimHandover). This page's entry can
// also be gone because a page that loaded while this one was frozen, or kept
// for the back button, took it over as one that went away - that page holds
// it now, unmarked, and this one goes on answering for the device as well,
// since the wearer may be on either. Only such an entry keeps this page
// answering: not the entry of a page that is connecting the device, and not
// one another page left on its way out - that page answers for nothing any
// more, and what it left is for the next page to take over.
function takenByDriver(entries, token) {
    return !entries.some((entry) => entry.token === token
        && (entry.page === PAGE_ID || (entry.held && !entry.connecting)));
}

// Write, as held, the entry this page would leave now for every device it
// answers for without driving it, in place of what it held before - marked
// connecting for the device it is connecting. A device a page that drives it
// has taken is let go of rather than written back, and the device this page
// drives is held by nobody.
function publishHeld() {
    try {
        const now = Date.now();
        const store = readHandoverStore(now);
        for (const token of [...holding]) {
            if (takenByDriver(store.entries, token)) standDown(token);
        }
        const mine = handoverEntries(now)
            .filter((entry) => !(live && live.token === entry.token))
            .map((entry) => ({ ...entry, held: true, connecting: entry.token === connecting }));
        if (!mine.length && store.raw === null) {
            holding.clear();
            return;
        }
        writeHandover([...store.entries.filter((entry) => entry.page !== PAGE_ID), ...mine]);
        // Only an entry that is really in storage can be taken from it:
        // where storage is blocked this page answers for the device as if
        // no other page could.
        const written = readHandoverStore(now).entries;
        holding.clear();
        for (const entry of mine) if (ownEntryFor(written, entry.token)) holding.add(entry.token);
    } catch (e) {}
}

// A device this page has just begun to answer for without driving it, or
// one it holds whose watch now reaches further: its held entry is written
// again. A page that connects the device watches through its own link for
// as long as that entry says, and an entry written once, when this page
// began to answer for the device, would end that watch before this page's
// own - a press whose open was never answered, still closing after
// Disconnect, is watched for from the end of its close.
function noteAnswering(token) {
    if ((live && live.token === token) || released.has(token)) return;
    publishHeld();
}

// Nothing runs here for the device any more: its held entry goes.
function dropHeld(token) {
    if (!holding.has(token)) return;
    holding.delete(token);
    try {
        const store = readHandoverStore(Date.now());
        const rest = store.entries.filter((entry) => !(entry.page === PAGE_ID && entry.token === token));
        if (rest.length !== store.entries.length) writeHandover(rest);
    } catch (e) {}
}

// Does this page still answer for the device behind `token`? Always while it
// drives it; otherwise until a page that drives it has taken the entry this
// page holds for it, and then never again - until this page connects it, or
// takes over what a page that went away left for it.
function answersFor(token) {
    if (live && live.token === token) return true;
    if (released.has(token)) return false;
    if (!holding.has(token)) return true;
    const entries = readHandoverStore(Date.now()).entries;
    if (ownEntryFor(entries, token)) return true;
    if (!takenByDriver(entries, token)) {
        // Taken over by a page that loaded while this one was away: held
        // here again, so a page that connects the device takes both.
        publishHeld();
        return true;
    }
    standDown(token);
    return false;
}

// Let go of a device another page drives now, or is connecting. What this
// page still runs for it ends - its watch, its chase, what may still land -
// and the panel says why (`message`). A whole stop of this page's already out
// for it runs its course, a stop being no harm, but it is no longer this
// page's to finish: nothing is sent to the device when this page goes away,
// nothing is left for the next page, and no alarm is raised when it fails -
// the page that connects the device confirms a stop of its own, or, when its
// connect fails, answers for the device from there with the alarm up.
function standDown(token, message = 'Another EdgeLoop tab has connected this VacuGlide, or is connecting it, and answers for it from there. This tab has let go of it.') {
    holding.delete(token);
    released.add(token);
    dropTakeover(token, { outcome: RECOVERY_STOP.CONNECTED, detail: 'elsewhere', final: true });
    heldBack.delete(token);
    flights.delete(token);
    for (const link of [...stopping]) if (link.token === token) stopping.delete(link);
    const watch = watches.get(token);
    if (watch) finishWatch(watch);
    const chase = safetyJobs.get(token);
    if (chase) finishSafetyJob(chase);
    callHandler('onTakeover', message, false);
}

// A page that comes back - it was only frozen, or kept for the back button -
// still holds everything it left in memory, and carries on with it itself.
// It takes back what it left, so that no page loaded from here on watches
// and stops a device this one may be driving again, and holds again what it
// answers for without driving it. A device it answered for that has no
// entry left at all was taken by a page that connected it meanwhile - or by
// one that loaded, took it over and has finished with it since, which this
// page cannot tell apart - and is let go of; one a page that loaded
// meanwhile took over is held by that page now, and both answer for it - the
// wearer may be on either. Called on pageshow (persisted) and resume, before
// the page takes over what other pages left meanwhile (attachVacuglideToPage).
export function withdrawVacuglideHandover() {
    try {
        const store = readHandoverStore(Date.now());
        for (const token of [...holding]) {
            if (live && live.token === token) continue;
            if (takenByDriver(store.entries, token)) standDown(token, 'While this page was away, another EdgeLoop tab took this VacuGlide over. This tab has let go of it.');
        }
        // Everything this page left goes, and what it still answers for
        // without driving it is held here again: publishHeld writes this
        // page's entries anew.
        holding.clear();
        publishHeld();
    } catch (e) {}
}

// `windowOpen`: a command that page sent can still arrive. Otherwise every
// window closed while no page was open to watch it, and the device is read
// once to see whether one arrived. `awayMs`: how long ago that page went -
// said when it is more than a minute, since what it left may be about a
// session long over.
function describeTakeover(stop, watch, windowOpen, awayMs) {
    const went = awayMs >= 60000 ? `went away ${describeAgo(awayMs)}` : 'went away';
    if (stop && watch) {
        return windowOpen
            ? `An EdgeLoop page ${went} while the VacuGlide may have been running, and with a command to it that Autoblow's server had not answered. EdgeLoop is stopping it and closing both valves, and watches it until that command can no longer arrive.`
            : `An EdgeLoop page ${went} while the VacuGlide may have been running, and with a command to it that Autoblow's server had not answered, and no page has looked at the device since. EdgeLoop is stopping it and closing both valves.`;
    }
    if (stop) {
        return `An EdgeLoop page ${went} while the VacuGlide may have been running or had a valve open, and never heard its last stop land. EdgeLoop is stopping it and closing both valves.`;
    }
    return windowOpen
        ? `An EdgeLoop page that ${went} left a command to the VacuGlide that Autoblow's server had not answered. EdgeLoop watches the device until it can no longer arrive, and stops it and closes both valves if it does.`
        : `An EdgeLoop page that ${went} left a command to the VacuGlide that Autoblow's server had not answered, and no page was open to watch for it while it could still arrive. EdgeLoop reads the device now, and stops it and closes both valves if that command reached it.`;
}

function describeTakeoverDone(takeover) {
    const parts = ['EdgeLoop has finished with the VacuGlide it took over from an EdgeLoop page that went away.'];
    if (takeover.caught) parts.push('A command that page had sent reached it late, and EdgeLoop stopped it again and closed both valves.');
    else if (takeover.stopped) parts.push('It confirmed the stop, with both valves closed.');
    if (takeover.watched) parts.push('The minute in which a command that page sent could still arrive is over.');
    return parts.join(' ');
}

function noteTakeover(token, outcome, error = null) {
    const takeover = takeovers.get(token);
    if (!takeover) return;
    if (outcome === 'stopped') {
        takeover.stopped = true;
        takeover.gaveUp = false;
    } else if (outcome === 'caught') {
        takeover.caught = true;
    } else if (outcome === 'gaveUp') {
        takeover.gaveUp = true;
    }
    if (takeover.crash) tellCrashStop(takeover.crash, outcome, error);
}

// A takeover ends without settling (connectVacuglide, standDown): the crash
// stop it carried hears how.
function dropTakeover(token, update) {
    const takeover = takeovers.get(token);
    takeovers.delete(token);
    if (takeover && takeover.crash) endCrashStop(takeover.crash, update);
}

// A device this page answers for without driving it is finished with once
// nothing is running for it any more: its watch, its chase, and any whole
// stop still out for it. Its held entry goes then, and a device taken over
// from a page that went away says how it ended. One the background stop gave
// up on has the alarm up already, and that is what the panel keeps saying.
function settleTakeover(token) {
    if (doubtRunning(token)) return;
    dropHeld(token);
    const takeover = takeovers.get(token);
    if (!takeover) return;
    takeovers.delete(token);
    if (takeover.crash) {
        // Nothing runs for it any more. Its chase said how it ended
        // (tellCrashStop); one that never ran was not this page's to run.
        endCrashStop(takeover.crash, takeover.stopped
            ? { outcome: RECOVERY_STOP.STOPPED, detail: '', final: true }
            : { outcome: RECOVERY_STOP.CONNECTED, detail: answersFor(token) ? 'here' : 'elsewhere', final: true });
    }
    if (takeover.gaveUp) return;
    callHandler('onTakeover', describeTakeoverDone(takeover), false);
}

// Take one device over, from a page that went away. Nothing here drives it:
// it is watched and stopped the way a device let go of by Disconnect or a
// lost link is. A speed of that page's that lands is stopped, and so is a
// valve found open, with the whole stop; a device a read cannot see is
// chased, with the alarm up; a stop that is not confirmed raises the alarm.
// What ran out while no page was open is paid now, in full: a window that
// closed unwatched gets its last read at once - a speed that landed in it is
// running still, the device has no watchdog - and a chase nobody ran is run
// from the start. A second page's entry for a device already taken over
// here adds to what is running for it.
function takeOver(entry, now, crash = null) {
    const stop = entry.stopUntil > 0 || entry.alarm;
    const watch = entry.speedUntil > 0 || entry.openUntil > 0;
    if (!stop && !watch) return;
    // This page answers for it again, even if it had let go of it before.
    released.delete(entry.token);
    const windowOpen = entry.speedUntil > now || entry.openUntil > now;
    // Whatever may have landed is read for at least once, even if the last
    // of its window runs out between here and the watch: the read it owes
    // then is the last one.
    const owes = watch ? { speed: entry.speedUntil > 0, opens: entry.openUntil > 0 } : null;
    if (live && live.token === entry.token) {
        takeOverOnLink(entry, now, stop, owes);
        return;
    }
    let takeover = takeovers.get(entry.token);
    if (!takeover) {
        takeover = { watched: false, stopped: false, caught: false, gaveUp: false, crash: null };
        takeovers.set(entry.token, takeover);
    }
    takeover.watched = takeover.watched || watch;
    if (crash) {
        // One crash stop per device: a second one joins it.
        if (takeover.crash && takeover.crash !== crash && !takeover.crash.done) {
            takeover.crash.listeners.push(...crash.listeners);
            takeover.crash.promise.then(crash.resolve);
            crashStops.set(entry.token, takeover.crash);
        } else {
            takeover.crash = crash;
        }
    }
    const link = makeLink(entry.token, entry.cluster, null);
    restoreLeftCommands(link, entry, now);
    if (stop) {
        // Not known to be at rest: a later sighting is not a restart.
        link.motorMayRun = true;
        link.valveMayBeOpen.plus = true;
        link.valveMayBeOpen.minus = true;
    }
    callHandler('onTakeover', describeTakeover(stop, watch, windowOpen, entry.at > 0 ? now - entry.at : 0), true);
    if (entry.alarm) reportStopUnconfirmed(VACUGLIDE_PATHS.stop, new Error('the EdgeLoop page that went away never heard the VacuGlide confirm it'), 'Stop', entry.token);
    if (stop) beginSafetyJob(link, { until: entry.stopUntil > now ? entry.stopUntil : 0, reported: entry.alarm });
    // The first read at once: nothing has looked at the device since the
    // page went away.
    if (watch) watchForLateCommand(link, 0, owes);
    // A window that ran out in the moments since it was read, and a watch
    // this page already had for the device, start nothing new, and must not
    // leave the takeover open for good.
    settleTakeover(entry.token);
}

// The speeds and valve opens a page that went away left, which may still
// land until the windows it gave them.
function restoreLeftCommands(link, entry, now) {
    if (entry.speedUntil > now) restoreFlight(link, 'speed', entry.speedUntil);
    if (entry.openUntil > now) restoreFlight(link, 'open', entry.openUntil);
}

// A device taken over that this page has connected - it came back from
// being frozen or from the back-forward cache with its link still up: its
// own link watches it and stops it. What may land from the page that went
// away is watched for through that link, and a device that page may have
// left moving is not taken to be at rest - the next idle tick sends it the
// whole stop, a running session its speed again. An entry another tab held
// is that tab's watch, which this page carries on - often for its own
// commands, which that tab took over while this page was away.
function takeOverOnLink(entry, now, stop, owes) {
    const link = live;
    restoreLeftCommands(link, entry, now);
    if (stop) link.motionUnknown = true;
    callHandler('onNotice', entry.held
        ? 'Another EdgeLoop tab was watching this VacuGlide for a command that may still reach it late. This page watches it from here, and stops it again if one does.'
        : 'Another EdgeLoop page that was driving this VacuGlide went away before it could vouch for it. EdgeLoop checks the device, and stops it again if a command that page sent reaches it late.');
    watchForLateCommand(link, 0, owes);
}

// What other pages left for `token`, or hold for it, taken out of storage
// for the page that is connecting that device and will drive it: one entry,
// every window at its widest, or null. In the same write this page holds, in
// their place, what it now answers for about the device - what it took and
// what it held itself - marked connecting, as it goes on doing until the
// connect ends (publishHeld). A page that held the device lets go of it on
// finding that (takenByDriver); another page that connects the device before
// this connect ends takes it from this one, which then lets go of the device
// in turn - and a connect of this page's that fails does not take the device
// back from it (connectVacuglide). Left unmarked, this page's own held entry
// read, to a page that held the device as well, as that of a page that had
// taken it over at load: on a slow link that page held the device again
// while this connect ran, and went on stopping the session that followed -
// 10 stops in its first 20 s.
function claimHandover(token) {
    try {
        if (safeGet(VACUGLIDE_HANDOVER_STORAGE_KEY, null) === null) return null;
        const now = Date.now();
        const store = readHandoverStore(now);
        const stored = store.entries.filter((entry) => entry.token === token);
        if (!stored.length) return null;
        const [held] = mergeHandoverByDevice(stored);
        writeHandover([
            ...store.entries.filter((entry) => entry.token !== token),
            { ...held, page: PAGE_ID, at: now, held: true, connecting: true }
        ]);
        if (ownEntryFor(readHandoverStore(now).entries, token)) holding.add(token);
        const theirs = stored.filter((entry) => entry.page !== PAGE_ID);
        return theirs.length ? mergeHandoverByDevice(theirs)[0] : null;
    } catch (e) {
        return null;
    }
}

// Take over what pages that went away left (leaveHandover). A host page
// calls this - never the partner viewer or controller pages, which drive
// nothing - once it has loaded, and again when the page comes back from
// being frozen or from the back-forward cache, after it has taken back what
// it left itself (attachVacuglideToPage). Not when another tab leaves
// something: a page that was already open learns nothing of the wearer
// driving the device again from the reloaded tab, or connecting it there,
// and would stop that session on every read for a minute, with its alarm in
// a tab nobody is looking at. An entry another page holds stays where it is
// - that page is open and answers for the device - unless this page has that
// very device connected: a page that comes back with its link up drives it,
// and takes every entry for it. What this page takes is removed from storage
// as it is read, and what it goes on answering for without driving it is
// held here again under its own name (publishHeld); one this page left or
// holds itself is this page's already. Returns how many devices it took
// over.
export function takeOverVacuglideHandover() {
    try {
        if (safeGet(VACUGLIDE_HANDOVER_STORAGE_KEY, null) === null) return 0;
        const now = Date.now();
        const store = readHandoverStore(now);
        const driven = live ? live.token : null;
        const theirs = store.entries.filter((entry) => entry.page !== PAGE_ID && (!entry.held || entry.token === driven));
        const kept = store.entries.filter((entry) => !theirs.includes(entry));
        // Anything else stored goes - taken over here, or not an entry any
        // page could use.
        if (encodeHandover(kept) !== store.raw) writeHandover(kept);
        const devices = mergeHandoverByDevice(theirs);
        for (const entry of devices) takeOver(entry, now);
        if (devices.length) publishHeld();
        return devices.length;
    } catch (e) {
        return 0;
    }
}

// ---- a page that crashed -----------------------------------------------------------------
//
// A page that crashes - the browser or the tab, a force-quit, a phone that
// kills it - fires no pagehide: it sends no unload stop and leaves no
// handover entry, and the device has no watchdog. What is left is the
// crash-recovery marker (crash-recovery.js), which names each VacuGlide the
// session drove and the cluster it was reached through. The next host page
// that recovers that session sends each of them the whole stop through here,
// and the crash banner reports how it went.
//
// A device that may be moving with nobody to vouch for it is what a page
// that went away leaves (takeOver), and it is stopped the same way: the
// whole stop - the motor stop and both valve closes, each confirmed - sent
// at once through the router's current cluster and again every
// offlineStopRetryMs until one is confirmed, for the five minutes of the
// background stop, with the alarm on this page when a round cannot confirm
// it. It is not then watched for a minute, as a device a page left with a
// command in flight is: nothing says when the page died or what it had out,
// and a page that has connected the device since - this one or another tab
// - would have its own session stopped on every read. A device this page
// has connected answers through its own link (LINKED): the link can no
// longer vouch that it is at rest, and outside a session its whole stop goes
// out now. A device another tab connects meanwhile is that tab's
// (CONNECTED). Resolves the last update, { outcome, detail, final: true },
// with RECOVERY_STOP's outcomes; `onUpdate` hears every update first. A
// second call for a device already being stopped joins that stop. Never
// throws.
const crashStops = new Map();

// How long the background stop chases a device before it gives up: what the
// crash banner says it keeps trying for.
export function vacuglideStopChaseMs() {
    return OFFLINE_STOP_MAX_ROUNDS * VACUGLIDE_TIMINGS.offlineStopRetryMs;
}

function tellCrashStop(job, outcome, error) {
    if (outcome === 'stopped') {
        endCrashStop(job, { outcome: RECOVERY_STOP.STOPPED, detail: '', final: true });
    } else if (outcome === 'failed') {
        const update = {
            outcome: error && error.notOnline ? RECOVERY_STOP.OFFLINE : RECOVERY_STOP.FAILED,
            detail: error && error.message ? error.message : '',
            final: false
        };
        job.failure = update;
        sendCrashUpdate(job, update);
    } else if (outcome === 'gaveUp') {
        const last = job.failure || { outcome: RECOVERY_STOP.FAILED, detail: '' };
        endCrashStop(job, { outcome: last.outcome, detail: last.detail, final: true });
    }
}

function sendCrashUpdate(job, update) {
    job.last = update;
    for (const listener of job.listeners) {
        try { listener(update); } catch (e) {}
    }
}

function endCrashStop(job, update) {
    if (job.done) return;
    job.done = true;
    if (crashStops.get(job.token) === job) crashStops.delete(job.token);
    sendCrashUpdate(job, update);
    job.resolve(update);
}

export function stopVacuglideAfterCrash(rawToken, { cluster = '', onUpdate } = {}) {
    const token = sanitizeDeviceToken(rawToken);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = { token, listeners: typeof onUpdate === 'function' ? [onUpdate] : [], last: null, failure: null, done: false, resolve, promise };
    if (!token) {
        endCrashStop(job, { outcome: RECOVERY_STOP.FAILED, detail: 'no device token', final: true });
        return promise;
    }
    if (live && live.token === token) {
        // This page drives the device: its link can no longer say it is at
        // rest, so a running session's next tick sends its speed again and
        // every way out of the session stops it, and outside a session the
        // whole stop goes now.
        live.motionUnknown = true;
        live.motorMayRun = true;
        const active = typeof handlers.isSessionActive === 'function' && Boolean(handlers.isSessionActive());
        if (!active) stopLinkWithRetry(live, { fresh: true }).catch(() => {});
        endCrashStop(job, { outcome: RECOVERY_STOP.LINKED, detail: '', final: true });
        return promise;
    }
    const running = crashStops.get(token);
    if (running) {
        if (typeof onUpdate === 'function') {
            running.listeners.push(onUpdate);
            if (running.last) {
                try { onUpdate(running.last); } catch (e) {}
            }
        }
        return running.promise;
    }
    crashStops.set(token, job);
    const now = Date.now();
    takeOver({
        token,
        cluster: normalizeCluster(cluster) || '',
        page: '',
        at: 0,
        speedUntil: 0,
        openUntil: 0,
        stopUntil: now + OFFLINE_STOP_MAX_ROUNDS * VACUGLIDE_TIMINGS.offlineStopRetryMs,
        alarm: false,
        held: false
    }, now, job);
    if (!job.done && !takeovers.has(token)) {
        endCrashStop(job, { outcome: RECOVERY_STOP.CONNECTED, detail: answersFor(token) ? 'here' : 'elsewhere', final: true });
    }
    return promise;
}

// What the page's own life does to the device: app.js calls this once, as
// it starts, with its window and document. The device has no watchdog: if
// this page dies, it keeps running at its last speed with its valves as they
// were. So the whole stop goes out with keepalive when the page goes away or
// is frozen - pagehide on the window, freeze on the document, as The Handy's
// does - and a device the page cannot vouch for is left in localStorage for
// the next page (stopVacuglideOnUnload). That page takes it over as soon as
// it has loaded, and this one does when it comes back - from the
// back-forward cache, or from being frozen - once it has taken back what it
// left itself; connecting that device takes it over as well
// (connectVacuglide). A page that was already open does not, so nothing here
// listens for another tab's storage writes: it could not tell when the
// wearer drove the device again from the reloaded tab, stopped that session
// on every read for a minute, and raised its alarm in a tab the wearer was
// not looking at. The partner viewer and controller pages (`remote`) run no
// hardware of their own, and never read, stop or take over a VacuGlide:
// nothing is attached to them.
export function attachVacuglideToPage({ remote, win, doc }) {
    if (remote) return;
    win.addEventListener('pagehide', () => { stopVacuglideOnUnload(); });
    doc.addEventListener('freeze', () => { stopVacuglideOnUnload(); });
    const comeBack = () => {
        withdrawVacuglideHandover();
        takeOverVacuglideHandover();
    };
    win.addEventListener('pageshow', (e) => { if (e.persisted) comeBack(); });
    doc.addEventListener('resume', comeBack);
    // Once app.js has run, so the handlers it installs can paint the panel,
    // and before anything later in the page's start can hold it up: a device
    // a page left running does not wait on the rest of it.
    setTimeout(() => { takeOverVacuglideHandover(); }, 0);
}

// Test hook: end everything this page still runs for a device it is not
// driving - every watch and background stop, what may land, what it took
// over - as a page that closes does. A watch runs for its whole window
// whatever answers come back, and in node every test shares one fetch: a
// watch or a chase left over from one test would read, and stop, the
// device of the next.
export function endVacuglideForTests() {
    // Storage is left as it is: what a page that closes leaves there is what
    // its pagehide wrote.
    holding.clear();
    released.clear();
    stopChecks.clear();
    for (const job of [...safetyJobs.values()]) finishSafetyJob(job);
    for (const job of [...watches.values()]) finishWatch(job);
    flights.clear();
    for (const token of [...takeovers.keys()]) dropTakeover(token, { outcome: RECOVERY_STOP.FAILED, detail: 'the page closed', final: true });
    for (const job of [...crashStops.values()]) endCrashStop(job, { outcome: RECOVERY_STOP.FAILED, detail: 'the page closed', final: true });
}
