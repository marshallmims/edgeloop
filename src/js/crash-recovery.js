// Crash recovery: what a page that died mid-session leaves behind, and what
// the next page to open does about it.
//
// A page that crashes, is force-quit or is killed by the phone sends no
// stop. pagehide and freeze only fire on a graceful close, and even then the
// stop they send is unconfirmed. The Handy is the dangerous case: HAMP motion
// runs on the device, driven through the cloud, so it keeps stroking at the
// last speed it was given for as long as nothing tells it otherwise.
//
// So a host page keeps a small marker in storage for as long as its session
// may drive hardware - written before the first command of a session reaches
// a toy, removed by STOP, by every other ending of the session and by Reset -
// and a page that boots, or starts a session, and finds one whose page is
// gone knows that session did not end cleanly. It sends The Handy a stop
// with the key that session was driving and with the key saved here, and
// says on a banner that the session did not end cleanly and what each stop
// returned. A stop that does not get through in its five minutes is sent
// again the next time EdgeLoop opens, whatever sessions run in between, and
// the banner says so. Intiface Central and a T-Code serial device cannot be
// reached without a new connection (a websocket, a port the wearer picks
// again), so for those the banner says what the device does by itself and
// what the wearer can do.
//
// The Autoblow VacuGlide 2 is driven through a cloud too, and has no
// watchdog either: it keeps running at the last speed with its valves as
// they were. A page that goes away gracefully sends it the whole stop and
// leaves the next page what it could not vouch for (vacuglide.js); a page
// that crashes does neither, and the marker is all that is left. So the
// marker names each VacuGlide the session drove, by its device token and the
// cluster it was reached through, and the recovery sends each of them the
// whole stop - the motor stop and both valve closes - through
// stopVacuglideAfterCrash, and reports what came of it on the same banner.
// A whole stop that is not confirmed in its window is owed to the next page
// to open, and sent again there, exactly as a Handy's stop is.
//
// Rules:
//   * Nothing is started, connected or changed: the one command ever sent is
//     PUT /hamp/stop (handy.js, stopHandyAfterCrash), and to a VacuGlide its
//     whole stop.
//   * A remote controller or viewer page neither writes nor reads the marker
//     or the stops still owed (app.js never calls this module there).
//   * Every page keeps a marker of its own, under a key named after its id
//     (liveSessionKey), and never writes or removes another page's. With one
//     marker for the whole browser, taken by whichever page started a
//     session last, a session started in a tab that was already open wrote
//     over the marker of a tab that had crashed meanwhile, and its STOP then
//     removed it: every page opened after that found nothing, and the Handy
//     the crashed tab left moving was never stopped.
//   * A marker whose page is still open is not a crash. Tabs share one
//     storage, and a second tab opened mid-session must not stop the first
//     tab's Handy or report a crash that did not happen. A page holds a Web
//     Lock named after its own id while it owns a marker; the browser drops
//     the lock with the page, crash included, so a held lock means "open".
//   * A Handy that a session in a page still open is driving right now is
//     that page's to stop, even when a page that died drove it too: a stop
//     from here would land behind its driver's back. "Right now" is a second
//     Web Lock that page holds for as long as its session drives that Handy
//     (drivingLockName, drivesHandyNow): running, with a link to that Handy
//     whose driver cannot vouch that it is stopped - the one state in which
//     that page stops it itself on every way out. It is never read from the
//     Handys a marker names, which are every Handy the session has driven: a
//     tab whose session was only paused, or had lost its link to that Handy,
//     was taken to be driving it, and the Handy that a tab that died had
//     left moving was sent nothing by anyone. Nor is it ever stored. It
//     changes at every start and stop of the Handy, several times a minute,
//     and a marker rewritten that often used up Chromium's localStorage
//     commit budget of 60 commits an hour (durable-store.js): everything
//     else EdgeLoop saves - a Climax HR lowered mid-session, a Came Early,
//     the session log at STOP - then reached the disk up to a minute late
//     instead of five seconds, and a browser killed in that minute lost it.
//     A lock is no storage write, the browser drops it with the page, crash
//     included, and one snapshot of the lock manager says both which pages
//     are open and what each of them drives (openPages).
//   * A page that was open when another one died does not boot again, and
//     the wearer may carry on in it. So a page recovers every marker whose
//     page is gone when it boots, and again when a session of its own starts
//     (createCrashRecovery), before that session can run for an hour next to
//     a Handy the dead page left moving. A session start does not send the
//     stops still owed from an earlier recovery: those are promised to the
//     next page to open, and this page may be the one that promised them.
//     A page that boots while the page it replaces in its own tab is still
//     being torn down (Chrome shows a prerendered page before the old one is
//     gone) finds that page's lock still held, so it looks once more a few
//     seconds later (BOOT_RECHECK_MS).
//   * Nothing of the recovery runs in a page Chrome is prerendering, before
//     the wearer opens it (whenActivated). Chrome prerenders a page it
//     expects to be opened - from the address bar, while a URL it predicts
//     is typed - and runs its scripts hidden, but holds back every Web Locks
//     call until activation. Such a page could not see that a marker's page
//     is open: it would stop a running session's Handy from a page nobody
//     opened, remove that session's marker, and report a crash that did not
//     happen; and a prerender that is never shown would use up the report of
//     a real one.
//   * A page whose marker is gone mid-session writes it again at its next
//     dispatch. Only a page that took it for crashed (one with no lock
//     manager, or whose lock query did not answer in time) or the wearer
//     clearing site data removes the marker of a live page, and that page's
//     session is still driving hardware.
//   * A marker says that a page died mid-session, not which stops are still
//     owed. The banner promises a stop that never got through (a phone whose
//     network is not up yet, a Handy that is offline) to the next page to
//     open, whatever sessions the wearer runs in between. Before its first
//     stop goes out, the recovery hands the keys the session drove over to a
//     record of their own, the stops still owed (PENDING_CRASH_STOPS_KEY),
//     and removes the marker. No session writes that record, and every host
//     page that opens sends each key in it a stop. A browser that refuses to
//     store the record keeps the marker instead, until the stops the marker
//     asks for are settled, and the banner then promises no other try.
//   * A key leaves the stops still owed once a stop to it is settled -
//     confirmed, already stopped, not in HAMP mode, or taken over by Connect
//     - or once a Connect with that key has confirmed a stop of its own
//     (app.js; a stop of this page's that gave up hears of it, handy.js, and
//     the banner takes back its promise). Otherwise it leaves once the one
//     try the banner promised has been made: the first page whose stop gives
//     up promises the next page to open another try and notes the promise
//     under a token of its own, and a page that found that promise before it
//     sent anything is the try; when its stop gives up too, the key is
//     dropped and its banner promises nothing more. Not "until it answers":
//     a Handy that has been switched off comes back up offline until its
//     Wi-Fi button is pressed, so that would put the report and five minutes
//     of stops on every start for as long as the wearer leaves it that way -
//     after being told twice to switch it off if it is moving. A page opened
//     before the promise was made (another tab) did not find it, so it does
//     not use it up, and no clock decides that: a clock set back cannot make
//     an earlier page look like a later one.
//   * The report is about a Handy of a session that is over, and it keeps
//     changing for minutes while the wearer may already run a new session
//     with another Handy. So it is a source of its own on the alert banner
//     (app.js, 'crashRecovery'), where no report of the new session takes
//     its sentence down and it takes down none of theirs (alert-banner.js),
//     and every Handy in it is named by the end of its key. It leaves when
//     what it is about is over: no Handy it names may still be moving, and
//     the wearer has carried on from it by starting or resuming a session
//     (createCrashRecovery).
//   * The markers and the stops still owed have to outlive a browser that
//     is force-quit or killed by the phone, and localStorage does not:
//     Chromium writes its changes to disk a minute or more late, and a
//     killed browser leaves it as it was at some past instant no page can
//     tell (durable-store.js). So each change of them is also committed to
//     IndexedDB (createCrashRecoveryStorage), and a pass reads both. The
//     first command of a session, and the first to a toy that joins one,
//     waits until the durable copy of the marker names that toy
//     (waitingForDisk) - or until IndexedDB has had DURABLE_WRITE_TIMEOUT_MS
//     to commit it, after which the marker lives in localStorage alone, as
//     it did before there was a durable copy. A page writes nothing to
//     IndexedDB before it has read it once: a record written from
//     localStorage's copy could overwrite a stop that only the durable store
//     kept.
//   * Which copy is the newer one is read from the records themselves,
//     never from one store lacking what the other has. A localStorage marker
//     that IndexedDB has no record of is a session whose durable copy was
//     never written (IndexedDB failed, or did not answer in time): with a
//     marker taken for removed merely because IndexedDB did not have it, a
//     browser killed after localStorage had written that marker to disk left
//     the Handy moving, and the next open deleted the marker. Nor is a
//     marker that only IndexedDB has always one that localStorage lost with
//     a killed browser. A page reloaded or closed right after STOP, while
//     another page had the store busy, took the transaction that ended its
//     marker there with it (durable-store.js), and the next page, with
//     localStorage intact and no marker in it, reported a crash that had
//     not happened. So a marker carries a generation, which grows with each
//     session of its page, with each toy that joins it, and each time the
//     marker has to be written again because another page removed it. STOP
//     and Reset delete it from neither store: they write in its place, in
//     both, that the session ended at that generation (endedRecord), and so
//     does a page that takes a dead page's session over. At the next start
//     the newer record of the two is believed: a marker newer than any end
//     is a session that may have died; one that either store records as
//     ended is an end the other had not written yet, and no crash. The stops
//     still owed carry a version and are never removed, only emptied: the
//     newer version is believed, and two copies that each hold a change the
//     other lacks are merged (reconcilePendingCrashStops). A page lets go of
//     its lock once its marker's end has reached the disk, failed or timed
//     out, and the ends are kept for as long as a stale copy of the marker
//     might still come back from localStorage's disk (ENDED_RECORD_KEEP_MS).
//
// Pure apart from the storage, lock manager, document and stop function it
// is handed, so all of it runs under node:test.

import { safeGet, safeSet, safeRemove, safeKeys } from './storage.js';
import { sanitizeConnectionKey } from './backup.js';
import { sanitizeDeviceToken, normalizeCluster } from './hardware/vacuglide-protocol.js';
import { RECOVERY_STOP, isRecoveryStopConclusive } from './hardware/handy-protocol.js';
import { DURABLE_READ_TIMEOUT_MS, createDurableMirror } from './durable-store.js';

// A page's marker is stored under this prefix plus the page's id, so no page
// ever writes over another's (liveSessionKey).
export const LIVE_SESSION_PREFIX = 'edgeloop_live_session:';
export const LIVE_SESSION_LOCK_PREFIX = 'edgeloop-live-session:';
// The lock a page holds while its session drives a Handy right now: this
// prefix, the page's id, ':' and that Handy's connection key
// (drivingLockName).
export const DRIVING_LOCK_PREFIX = 'edgeloop-drives-handy:';
// The lock a page holds for as long as it has a VacuGlide connected: this
// prefix, the page's id, ':' and that device's token
// (vacuglideLinkLockName). A VacuGlide another open page has connected is
// that page's to answer for: its driver stops it on every way out of its
// session and stops it again whenever it is seen moving after a stop, and a
// stop or a watch from here would land in whatever session it runs.
export const VACUGLIDE_LINK_LOCK_PREFIX = 'edgeloop-vacuglide-link:';

// The Handy keys of sessions that did not end cleanly whose stop is still
// owed, oldest first: { handy: [{ key, promised }], version }, and the
// VacuGlides whose whole stop is, the same way, beside them: vacuglide:
// [{ token, cluster, promised }] - left out while there are none, so a
// record of Handys alone reads as it always has. `promised` is the token of
// the last page whose stop gave up and promised the next page to open
// another try; '' while none has. `version` grows with every change, so
// that of two copies the newer can be told (reconcilePendingCrashStops).
export const PENDING_CRASH_STOPS_KEY = 'edgeloop_pending_crash_stops';

// How long the record that a session ended is kept, in both stores, after
// the last time either store was given it. localStorage can write a change
// to disk tens of minutes late (durable-store.js), and a browser killed
// before that brings the marker the end replaced back: without the record
// that the session ended, the next open would take it for a crash. A week is
// far past any such delay, and the records are a few dozen bytes each.
export const ENDED_RECORD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// A session that switched Handy keys mid-run drove each of them; the old one
// was brought to a confirmed stop before the switch, so a handful is plenty.
export const MAX_MARKER_HANDY_KEYS = 4;

// The same for the VacuGlides a session drove.
export const MAX_MARKER_VACUGLIDES = 4;

// Stops still owed can come from more than one crash, each bringing up to
// MAX_MARKER_HANDY_KEYS keys. Nobody owns more Handys than this; the cap only
// keeps the record from growing without end, and the oldest key goes first:
// the newest crash is the likeliest to have left a device moving.
export const MAX_PENDING_CRASH_STOPS = 8;

export const CRASH_HEADLINE = 'The last session did not end cleanly: EdgeLoop closed, crashed or was reloaded before the session was stopped.';

// For a page that died while this one was open, found when a session
// starts here: "EdgeLoop closed" would read as this very page.
export const OTHER_PAGE_CRASH_HEADLINE = 'A session in another EdgeLoop tab or window did not end cleanly: that page was closed, crashed or was reloaded before the session was stopped.';

// For a key an earlier recovery could not settle. "Earlier", not "last":
// the wearer may have run and stopped sessions since, cleanly.
export const EARLIER_CRASH_HEADLINE = 'An earlier session did not end cleanly, and EdgeLoop has not been able to confirm a stop since.';

// Buttplug's own design: a server whose client disconnects stops the devices
// that client was controlling, and Intiface Engine does exactly that when the
// websocket closes (a StopCmd to every device). Intiface Central's Stop button
// stops the engine, "which disconnects all app/game connections and stops
// and disconnects all hardware devices".
export const INTIFACE_CRASH_ADVICE = 'Intiface Central: EdgeLoop sent nothing, because it can only reach those toys over a new connection. Intiface Central stops its toys by itself when it sees EdgeLoop\'s connection close; if one is still running, press Stop in Intiface Central, which stops every toy, or switch the toy off.';

// The T-Code spec has no timeout: a channel "continues at that level until
// given further instructions". EdgeLoop moves a stroke or rotation axis one
// leg at a time, so that axis holds where its last leg ended, but a vibration
// or auxiliary channel keeps its last level. Connecting again puts every axis
// at rest (tcode.js, stopTCode after identification).
export const TCODE_CRASH_ADVICE = 'T-Code serial device: EdgeLoop sent nothing, because it can only reach it through a port you pick again. It keeps the last command it was sent: a stroke axis holds where its last move ended, but a vibration axis keeps its last level, so it may still be running. If it is, unplug it, or open the TCode panel and press Connect, which puts every axis at rest.';

export const UNKNOWN_HARDWARE_NOTE = 'EdgeLoop could not read which toys that session was driving.';

// A page id as this module stores it: what newPageId makes (hex, or base 36
// without crypto), and the plain names the tests give their pages. Anything
// else is not one, and a marker under such a key has no owner to ask after.
function cleanOwner(value) {
    return typeof value === 'string' && /^[0-9a-z_-]{1,64}$/i.test(value) ? value : null;
}

export function liveSessionLockName(owner) {
    return `${LIVE_SESSION_LOCK_PREFIX}${owner}`;
}

// The lock the page `owner` holds while its session drives the Handy
// `handyKey` right now (drivesHandyNow). A page id has no ':' in it, so the
// key, which may, is everything after the first one.
export function drivingLockName(owner, handyKey) {
    return `${DRIVING_LOCK_PREFIX}${owner}:${handyKey}`;
}

// { owner, key } of a lock drivingLockName named, or null for any other
// lock, and for one whose page id or key no page could have written.
function parseDrivingLockName(name) {
    if (typeof name !== 'string' || !name.startsWith(DRIVING_LOCK_PREFIX)) return null;
    const rest = name.slice(DRIVING_LOCK_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const owner = cleanOwner(rest.slice(0, colon));
    const key = rest.slice(colon + 1);
    if (!owner || sanitizeConnectionKey(key) !== key) return null;
    return { owner, key };
}

// The lock the page `owner` holds while it has the VacuGlide `token`
// connected.
export function vacuglideLinkLockName(owner, token) {
    return `${VACUGLIDE_LINK_LOCK_PREFIX}${owner}:${token}`;
}

// { owner, token } of a lock vacuglideLinkLockName named, or null for any
// other lock, and for one whose page id or token no page could have written.
function parseVacuglideLinkLockName(name) {
    if (typeof name !== 'string' || !name.startsWith(VACUGLIDE_LINK_LOCK_PREFIX)) return null;
    const rest = name.slice(VACUGLIDE_LINK_LOCK_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const owner = cleanOwner(rest.slice(0, colon));
    const token = rest.slice(colon + 1);
    if (!owner || sanitizeDeviceToken(token) !== token) return null;
    return { owner, token };
}

// Where the page `owner` keeps its marker.
export function liveSessionKey(owner) {
    return `${LIVE_SESSION_PREFIX}${owner}`;
}

// This page's id: names the marker it writes and the lock it holds.
export function newPageId(source = globalThis.crypto) {
    try {
        if (source && typeof source.getRandomValues === 'function') {
            const bytes = source.getRandomValues(new Uint8Array(12));
            return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) {
        // A missing or throwing crypto falls through to the clock.
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// The VacuGlides a marker names: [{ token, cluster }], each token once (the
// last cluster it names wins), never more than MAX_MARKER_VACUGLIDES. A
// token the Connect field would refuse is none, and a cluster it would not
// send a token to is '' (the stop then asks Autoblow's router first).
function cleanVacuglides(value) {
    const out = [];
    if (!Array.isArray(value)) return out;
    for (const item of value) {
        const token = sanitizeDeviceToken(item && typeof item === 'object' ? item.token : null);
        if (!token) continue;
        const cluster = normalizeCluster(item.cluster) || '';
        const seen = out.find((entry) => entry.token === token);
        if (seen) seen.cluster = cluster;
        else out.push({ token, cluster });
        if (out.length >= MAX_MARKER_VACUGLIDES) break;
    }
    return out;
}

function sameVacuglides(a, b) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((entry, i) => entry.token === y[i].token && entry.cluster === y[i].cluster);
}

function cleanHandyKeys(value, cap = MAX_MARKER_HANDY_KEYS) {
    const keys = [];
    if (!Array.isArray(value)) return keys;
    for (const item of value) {
        const key = sanitizeConnectionKey(item);
        if (key && !keys.includes(key)) keys.push(key);
        if (keys.length >= cap) break;
    }
    return keys;
}

// The storage a host page keeps its crash-recovery records in: localStorage,
// with every change of a record committed to the durable store as well
// (durable-store.js). `durable` is openDurableStore(); without one this is
// localStorage alone, as before. `timeoutMs` as in createDurableMirror.
// Nothing is sent to the durable store before the page has read it once
// (readFirst). The first read that answers brings the stops still owed that
// localStorage and the durable store hold into line, before anything this
// page held back goes out with them (reconcilePendingCrashStops).
export function createCrashRecoveryStorage({ local, durable = null, timeoutMs } = {}) {
    let storage = null;
    storage = createDurableMirror({
        local,
        durable,
        readFirst: true,
        onAttach: (snapshot) => reconcilePendingCrashStops(storage, snapshot),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    return storage;
}

// What a page's marker is replaced with, in both stores, once its session is
// over: that it ended at generation `gen`, and when that was written (`at`,
// for ENDED_RECORD_KEEP_MS). Every copy of the marker of a generation up to
// `gen`, in either store, is one the end had not replaced there yet; a
// newer one is a session started since.
export function endedRecord(gen, at) {
    const clean = cleanGeneration(gen);
    return JSON.stringify({ ended: clean === null ? 0 : clean, at: Number.isFinite(at) ? at : 0 });
}

// A generation as a marker stores it: a whole number, 0 or more. Anything
// else is none, and a marker without one is never taken for ended.
function cleanGeneration(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The durable records of a snapshot (the storage's read()), or null.
function durableRecords(durable) {
    return durable && durable.records instanceof Map ? durable.records : null;
}

// Whether this page has changed `key` since the snapshot `durable` was taken:
// then its localStorage copy is the newer one.
function changedHere(storage, key, durable) {
    return Boolean(storage) && typeof storage.changedSince === 'function'
        && Boolean(durable) && storage.changedSince(key, durable.seq);
}

// Replaces a crash-recovery record with `text`, a record that says it is
// over, in localStorage and in the durable store (the storage's retire()). A
// plain Storage, with no durable store beside it, just removes it. Returns
// false only when the browser refused.
function retireRecord(key, text, storage) {
    if (storage && typeof storage.retire === 'function') {
        try {
            storage.retire(key, text);
            return true;
        } catch (e) {
            return false;
        }
    }
    return safeRemove(key, storage);
}

// Replaces a record in localStorage alone with `text` (null removes it), and
// leaves the durable store as it is. A plain Storage has no durable store to
// leave alone. Returns false only when the browser refused.
function replaceLocalRecord(key, text, storage) {
    if (storage && typeof storage.replaceLocal === 'function') {
        try {
            storage.replaceLocal(key, text);
            return true;
        } catch (e) {
            return false;
        }
    }
    return text === null ? safeRemove(key, storage) : safeSet(key, text, storage);
}

function sameHardware(a, b) {
    return a.readable === b.readable
        && a.intiface === b.intiface
        && a.tcode === b.tcode
        && a.handyKeys.length === b.handyKeys.length
        && a.handyKeys.every((key) => b.handyKeys.includes(key))
        && sameVacuglides(a.vacuglides, b.vacuglides);
}

// The keys every page's records are kept under: localStorage's, in its own
// order, then those only the durable records `records` have.
function recordKeys(storage, records) {
    const keys = safeKeys(storage).filter((key) => key.startsWith(LIVE_SESSION_PREFIX));
    if (records) {
        const seen = new Set(keys);
        for (const key of records.keys()) if (key.startsWith(LIVE_SESSION_PREFIX) && !seen.has(key)) keys.push(key);
    }
    return keys;
}

// Every marker stored, one per page that has a session driving hardware or
// died with one: [{ key, owner, raw, handyKeys, intiface, tcode, gen,
// readable, top }]. `key` is where it is stored and `owner` the page's id,
// read from that key, so even a marker whose text cannot be read names a
// page whose lock can be asked after. A marker that cannot be read still
// says a session was driving something: it comes back with `readable:
// false` rather than as nothing. `raw` is what localStorage holds under the
// key (null for nothing), so the recovery replaces exactly the record it
// read and never a newer one. `gen` is its generation (null when it does not
// say), and `top` the newest generation any record of that page names, in
// either store: what an end written in its place must name.
// `durable` is a snapshot of the durable store (the storage's read()). With
// one, what each store holds under a page's key is set against the other,
// and the newer record is believed:
//   * a marker that the other store has no record of counts. One only
//     localStorage has is a session whose durable copy was never written -
//     IndexedDB failed or did not answer in time. Taking it for a removal
//     left a Handy moving whenever localStorage had written the marker to
//     disk and IndexedDB had not. One only the durable store has is a
//     session whose marker localStorage lost with a killed browser;
//   * a marker that the other store records as ended (endedRecord), at its
//     generation or a newer one, is an end that store had not written yet,
//     and no crash: after a force-quit within a minute of STOP, localStorage's
//     disk still had the marker (staleLiveSessions); after a clean STOP and
//     a reload while another page had the store busy, the durable store
//     still had it, since the page took the transaction that ended it with
//     it (unwrittenEnds);
//   * a marker newer than an end is a session started since. It counts;
//   * two markers: the newer generation of the two is believed, and both
//     count when they cannot be told apart.
// Which Handy a session drives right now is in no marker: it is a lock its
// page holds (openPages).
export function readLiveSessions(storage, durable = null) {
    const records = durableRecords(durable);
    const markers = [];
    for (const key of recordKeys(storage, records)) {
        const raw = safeGet(key, null, storage);
        const text = records && records.has(key) ? records.get(key) : null;
        const local = parseLiveSession(key, raw);
        const copy = records ? parseLiveSession(key, text, { raw }) : null;
        const ends = [parseEndedRecord(key, raw), parseEndedRecord(key, text)].filter(Boolean);
        const top = Math.max(0, ...[local, copy].concat(ends).map((record) => (record && record.gen !== null ? record.gen : 0)));
        const live = [local, copy].filter((marker) => marker && !ends.some((end) => endedBy(marker, end)));
        for (const marker of live) marker.top = top;
        if (live.length < 2) {
            markers.push(...live);
            continue;
        }
        const order = newerGeneration(local, copy);
        if (order === null || order >= 0) markers.push(local);
        if (order !== null && order < 0) markers.push(copy);
        else if (order !== 1 && !sameHardware(local, copy)) markers.push(copy);
    }
    return markers;
}

// The localStorage copies of markers whose end the durable snapshot
// `durable` records at their generation or a newer one - an end localStorage
// had not written to disk yet, after a force-quit within a minute of STOP:
// [{ key, owner, raw, gen }], with `gen` the generation of that end. None of
// them is a crash.
export function staleLiveSessions(storage, durable) {
    const records = durableRecords(durable);
    if (!records) return [];
    const stale = [];
    for (const key of safeKeys(storage)) {
        if (!key.startsWith(LIVE_SESSION_PREFIX)) continue;
        const end = parseEndedRecord(key, records.get(key));
        if (!end) continue;
        const marker = parseLiveSession(key, safeGet(key, null, storage));
        if (!marker || !endedBy(marker, end)) continue;
        stale.push({ key, owner: marker.owner, raw: marker.raw, gen: end.gen });
    }
    return stale;
}

// The durable copies of markers whose end localStorage records at their
// generation or a newer one: a STOP whose page went - reloaded, closed -
// before the store was free to run the transaction that ended the marker
// there, and took that transaction with it (durable-store.js):
// [{ key, owner, durable, local }], the text each store holds. None of them
// is a crash.
export function unwrittenEnds(storage, durable) {
    const records = durableRecords(durable);
    if (!records) return [];
    const unwritten = [];
    for (const [key, text] of records) {
        if (!key.startsWith(LIVE_SESSION_PREFIX)) continue;
        const copy = parseLiveSession(key, text);
        if (!copy) continue;
        const local = safeGet(key, null, storage);
        const end = parseEndedRecord(key, local);
        if (!end || !endedBy(copy, end)) continue;
        unwritten.push({ key, owner: copy.owner, durable: text, local });
    }
    return unwritten;
}

// The records of ended sessions that can go, from both stores: neither holds
// anything under the page's key but an end (endedRecord), and every end
// there was written `keepMs` or more before `now` (ENDED_RECORD_KEEP_MS):
// [{ key, owner, local, durable }], the text each store holds (null for
// none). Only with a durable snapshot: without one, an end in localStorage
// may be all that tells the next page that a marker the durable store still
// holds is over. A record written at a time still to come (a clock set back)
// is kept.
export function expiredEndedRecords(storage, durable, now = Date.now(), keepMs = ENDED_RECORD_KEEP_MS) {
    const records = durableRecords(durable);
    if (!records) return [];
    const expired = [];
    for (const key of recordKeys(storage, records)) {
        const local = safeGet(key, null, storage);
        const text = records.has(key) ? records.get(key) : null;
        const ends = [local, text].filter((held) => held !== null).map((held) => parseEndedRecord(key, held));
        // A marker, or anything that is not an end, keeps the page's records.
        if (ends.length === 0 || ends.some((end) => !end || !(now - end.at >= keepMs))) continue;
        expired.push({ key, owner: ends[0].owner, local, durable: text });
    }
    return expired;
}

// The marker of the page `owner`, or null when it has none.
export function readLiveSession(storage, owner) {
    const id = cleanOwner(owner);
    if (!id) return null;
    const key = liveSessionKey(id);
    return parseLiveSession(key, safeGet(key, null, storage));
}

// Whether `marker` is a copy of a session that `end` records as over: its
// generation is known and no newer than the end's. A copy that cannot be
// read, or that names no generation, never is.
function endedBy(marker, end) {
    return marker.readable === true && marker.gen !== null && marker.gen <= end.gen;
}

// Which of two copies of one page's marker is the newer: 1 for `a`, -1 for
// `b`, 0 for the same generation, null when one of them does not say.
function newerGeneration(a, b) {
    if (a.gen === null || b.gen === null) return null;
    return Math.sign(a.gen - b.gen);
}

// A record the durable store keeps in place of a marker (endedRecord), or
// null for anything else - a marker, no record, or an end that names no
// generation, which no page writes.
function parseEndedRecord(key, text) {
    if (typeof text !== 'string') return null;
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'ended')) return null;
    const gen = cleanGeneration(parsed.ended);
    if (gen === null) return null;
    const at = Number(parsed.at);
    return { key, owner: cleanOwner(key.slice(LIVE_SESSION_PREFIX.length)), gen, at: Number.isFinite(at) ? at : 0, text };
}

// `text` is a stored marker, and `raw` what localStorage holds under its key.
// An end (endedRecord), in either store, is no marker.
function parseLiveSession(key, text, { raw = text } = {}) {
    if (typeof text !== 'string') return null;
    const owner = cleanOwner(key.slice(LIVE_SESSION_PREFIX.length));
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { key, owner, raw, handyKeys: [], intiface: false, tcode: false, vacuglides: [], gen: null, readable: false };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'ended')) return null;
    return {
        key,
        owner,
        raw,
        handyKeys: cleanHandyKeys(parsed.handy),
        intiface: parsed.intiface === true,
        tcode: parsed.tcode === true,
        vacuglides: cleanVacuglides(parsed.vacuglide),
        gen: cleanGeneration(parsed.gen),
        readable: true
    };
}

// Whether a session drives its Handy right now, in the sense another page
// needs before it leaves that Handy to it (the lock drivingLockName names,
// held for as long as this holds): the session is running or ramping down,
// its driver cannot vouch that the Handy is stopped - it is moving, a start
// is on its way, or a start may have landed unconfirmed (handy.js,
// handyMayBeMoving) - and the page is not frozen. In that state the page
// stops that Handy itself on every way out: a pause, STOP, Reset, a
// zero-speed tick, a role switched off, Disconnect, another key, a lost
// link, the page closed. And a stop from another page would land behind the
// back of a driver that believes it is moving, whose session then runs on
// with a device that does not. Anything else is not driving it: a paused
// session, a link that is down, a Handy whose stop its driver has seen
// confirmed, a frozen page, which runs nothing until it is resumed. A stop
// from another page takes nothing from those, and may be the only one the
// device gets.
export function drivesHandyNow({ sessionStatus, handyKey, mayBeMoving, frozen = false } = {}) {
    return (sessionStatus === 'RUNNING' || sessionStatus === 'RAMPDOWN')
        && Boolean(sanitizeConnectionKey(handyKey))
        && mayBeMoving === true
        && frozen !== true;
}

const NOTHING_CONNECTED = Object.freeze({ handyKey: '', intiface: false, tcode: false, vacuglideToken: '' });

// The marker a host page keeps while its session may drive hardware.
//   note({ handyKey, driving, intiface, tcode, vacuglide })
//                                        what is connected right now, and
//                                        whether the session drives that
//                                        Handy right now (drivesHandyNow);
//                                        `vacuglide` is { token, cluster } of
//                                        the VacuGlide connected now, or
//                                        null; called around every dispatch
//                                        of a live session
//   clear()                              the session ended cleanly
// Hardware only ever joins a session's marker: a Handy that dropped offline
// mid-session may still be moving, so losing its link does not take it off.
// Whether the session drives that Handy right now is the one thing note() is
// told that comes and goes: another page leaves a Handy to this one only
// while it does (runCrashRecovery), so a session that has paused, or lost
// its link, must not keep that page from stopping a Handy a dead page left
// moving. It is never written to storage: this page holds the lock
// drivingLockName names for as long as its session drives that Handy, and
// lets go of it the moment it does not. So the marker's text changes only
// when what a later page needs to know of the session changes - it starts,
// a toy joins it, something else removed the marker, it ends - and never at
// a dispatch: a start or a stop of the Handy, a zero-speed beat, a pause, a
// freeze. A marker rewritten at every start and stop of the Handy spent
// Chromium's localStorage commit budget, and the rest of what EdgeLoop saves
// reached the disk up to a minute late (see the rules at the top).
// Nothing is written while the stored marker is already this one, so note()
// is cheap enough to run on every engine tick, and a marker that is gone or
// cannot be read is written again. The marker is this page's alone: no other
// page's is ever read, written or removed here. note() returns whether the
// stored marker is this session's, up to date. `onSessionStart()` is called
// by the first note() of each session, once its marker is written.
// The marker's generation (`gen`) grows when a session starts, when a toy
// joins it, and when the marker has to be written again because something
// else removed or changed it - another page that took this one for crashed
// and handed its session over, or the wearer clearing site data. The end
// clear() puts in the marker's place names the generation it ends, so it
// can never pass for the end of a session started, or of a toy that joined,
// after it (readLiveSessions). A pause or resume is no new generation, and no
// write to either store.
//   waitingForDisk()   which of the toys connected now must not be sent a
//                      command yet: { handy, intiface, tcode, vacuglide },
//                      see below
// `onDurable()` is called whenever a change of a record commits, fails or
// times out, which is when waitingForDisk() may have changed. `now()` is the
// clock the end of a session is stamped with (ENDED_RECORD_KEEP_MS).
export function createLiveSessionTracker({ owner, storage, locks, onSessionStart, onDurable, now = Date.now } = {}) {
    const id = cleanOwner(owner) || newPageId();
    const key = liveSessionKey(id);
    let live = null;
    // What the last note() was told is connected now.
    let connected = NOTHING_CONNECTED;
    let releaseLock = null;
    // Set once the lock manager refused a request: asking again on every
    // tick would not change the answer.
    let lockRefused = false;
    // The Handy whose driving lock this page holds ('' for none), and what
    // lets go of that lock.
    let drivingKey = '';
    let releaseDriving = null;
    // The VacuGlide this page has connected ('' for none), and what lets go
    // of the lock that says so (vacuglideLinkLockName).
    let linkedToken = '';
    let releaseLinked = null;
    let generation = 0;
    // The text this page last stored under its key - its marker, or the end
    // clear() put in its place - and null while localStorage holds nothing
    // of this page's: anything else found there was put there by someone
    // else.
    let stored = null;
    if (typeof onDurable === 'function' && storage && typeof storage.subscribe === 'function') {
        storage.subscribe(() => {
            try { onDurable(); } catch (e) {}
        });
    }

    // Held until clear(); the browser drops it with the page, crash included.
    function holdLock() {
        if (releaseLock || lockRefused || !locks || typeof locks.request !== 'function') return;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        releaseLock = release;
        try {
            const granted = locks.request(liveSessionLockName(id), () => held);
            if (granted && typeof granted.catch === 'function') granted.catch(() => {});
        } catch (e) {
            releaseLock = null;
            lockRefused = true;
        }
    }

    // Holds the lock that tells every other page that this session drives
    // the Handy `handyKey` right now, and lets go of the one held for any
    // other ('' for none). Asking for it, or letting go, writes nothing to
    // storage, and the browser drops it with the page, crash included.
    function holdDriving(handyKey) {
        if (handyKey === drivingKey) return;
        if (releaseDriving) {
            const release = releaseDriving;
            releaseDriving = null;
            release();
        }
        drivingKey = '';
        if (!handyKey || lockRefused || !locks || typeof locks.request !== 'function') return;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        try {
            const granted = locks.request(drivingLockName(id, handyKey), () => held);
            if (granted && typeof granted.catch === 'function') granted.catch(() => {});
        } catch (e) {
            lockRefused = true;
            return;
        }
        releaseDriving = release;
        drivingKey = handyKey;
    }

    // Holds the lock that tells every other page that this page has the
    // VacuGlide `token` connected, and lets go of the one held for any other
    // ('' for none). It is about the link, not the session: a page that has
    // the device connected answers for it in or out of a session. Asking for
    // it writes nothing to storage, and the browser drops it with the page,
    // crash included.
    function holdVacuglideLink(token) {
        const clean = sanitizeDeviceToken(token) || '';
        if (clean === linkedToken) return;
        if (releaseLinked) {
            const release = releaseLinked;
            releaseLinked = null;
            release();
        }
        linkedToken = '';
        if (!clean || !locks || typeof locks.request !== 'function') return;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        try {
            const granted = locks.request(vacuglideLinkLockName(id, clean), () => held);
            if (granted && typeof granted.catch === 'function') granted.catch(() => {});
        } catch (e) {
            return;
        }
        releaseLinked = release;
        linkedToken = clean;
    }

    function note(hardware = {}) {
        const starting = live === null;
        const keys = live ? live.handyKeys.slice() : [];
        const handyKey = sanitizeConnectionKey(hardware.handyKey);
        if (handyKey && !keys.includes(handyKey)) {
            keys.push(handyKey);
            if (keys.length > MAX_MARKER_HANDY_KEYS) keys.shift();
        }
        // A VacuGlide joins like a Handy key, with the cluster it is reached
        // through: the stop a recovery sends it goes there when Autoblow's
        // router cannot be asked. One that has moved cluster since is named
        // with the new one.
        const vacuglides = live ? live.vacuglides.map((entry) => ({ ...entry })) : [];
        const vacuglide = hardware.vacuglide && typeof hardware.vacuglide === 'object' ? cleanVacuglides([hardware.vacuglide])[0] || null : null;
        if (vacuglide) {
            const seen = vacuglides.find((entry) => entry.token === vacuglide.token);
            if (seen) {
                if (vacuglide.cluster) seen.cluster = vacuglide.cluster;
            } else {
                vacuglides.push(vacuglide);
                if (vacuglides.length > MAX_MARKER_VACUGLIDES) vacuglides.shift();
            }
        }
        const next = {
            handyKeys: keys,
            intiface: Boolean(live && live.intiface) || hardware.intiface === true,
            tcode: Boolean(live && live.tcode) || hardware.tcode === true,
            vacuglides
        };
        // A new generation for what an end already written could otherwise
        // pass for the end of: a session that starts, a toy that joins, and
        // a marker that another page removed when it took this one's
        // session over (see above).
        const joined = starting
            || next.intiface !== live.intiface
            || next.tcode !== live.tcode
            || next.handyKeys.length !== live.handyKeys.length
            || next.handyKeys.some((k, i) => live.handyKeys[i] !== k)
            || !sameVacuglides(next.vacuglides, live.vacuglides);
        const found = safeGet(key, null, storage);
        const displaced = stored !== null && found !== stored;
        if (joined || displaced) generation += 1;
        live = next;
        connected = { handyKey, intiface: hardware.intiface === true, tcode: hardware.tcode === true, vacuglideToken: vacuglide ? vacuglide.token : '' };
        // The lock is asked for before the marker exists, so no page can find
        // this marker while its owner looks closed.
        holdLock();
        // A session that never drove a VacuGlide writes the marker it always
        // has, byte for byte.
        const text = live.vacuglides.length > 0
            ? JSON.stringify({ handy: live.handyKeys, intiface: live.intiface, tcode: live.tcode, vacuglide: live.vacuglides, gen: generation })
            : JSON.stringify({ handy: live.handyKeys, intiface: live.intiface, tcode: live.tcode, gen: generation });
        const current = found === text || safeSet(key, text, storage);
        stored = current ? text : null;
        // On its way to disk now, not once the dispatch that noted it is
        // over: the commands it holds back wait for this commit alone.
        if (storage && typeof storage.flush === 'function') storage.flush();
        // Once the marker names that Handy: whether the session drives it
        // right now goes to the lock alone.
        holdDriving(handyKey && hardware.driving === true ? handyKey : '');
        if (starting && typeof onSessionStart === 'function') {
            try { onSessionStart(); } catch (e) {}
        }
        return current;
    }

    // Which of the toys connected now must not be sent a command yet, as
    // { handy, intiface, tcode }: those that no change of this session's
    // marker whose wait is over has named, while the change that names them
    // is still on its way to disk. A force-quit up to a minute into a
    // session lost a marker that was only in localStorage, and the next open
    // sent nothing to a Handy that kept stroking: a command sent before its
    // toy is on disk is a toy nobody stops. The wait is the commit,
    // milliseconds, and never more than the mirror's timeout: a change that
    // failed or did not commit within it leaves its toys nothing to wait
    // for. The marker then lives in localStorage alone, as it did before
    // there was a durable copy, and the next page believes it over a durable
    // store that has no record of that session (readLiveSessions). A toy
    // that a change whose wait is over has named is never held again in the
    // session, whatever change is on its way after it: it has had its
    // commands since, it may be moving, and holding it back could only delay
    // what the engine asks of it, a stop included. With IndexedDB hung, a
    // toy that joined mid-session held back the Full Stop at the ceiling of
    // a Handy that had been stroking for seconds, for the whole timeout. A
    // session started before the page has read the durable store waits no
    // longer than the timeout either, and not at all once a read has found
    // that the store cannot be read (durable-store.js): its marker is held
    // until a read answers, and sent then. The last session's marker names
    // nothing once its end has been written (a STOP just before this START):
    // that end reaches the disk first. Nothing waits without a durable store.
    function waitingForDisk() {
        const none = { handy: false, intiface: false, tcode: false, vacuglide: false };
        if (!live || !storage || typeof storage.state !== 'function') return none;
        const record = storage.state(key);
        if (!record || record.status !== 'pending') return none;
        const disk = typeof record.settled === 'string' ? parseLiveSession(key, record.settled) : null;
        const named = disk && disk.readable ? disk : null;
        return {
            handy: Boolean(connected.handyKey) && !(named && named.handyKeys.includes(connected.handyKey)),
            intiface: connected.intiface && !(named && named.intiface),
            tcode: connected.tcode && !(named && named.tcode),
            vacuglide: Boolean(connected.vacuglideToken) && !(named && named.vacuglides.some((entry) => entry.token === connected.vacuglideToken))
        };
    }

    // Puts in this page's marker's place, in localStorage and in the durable
    // store, that the session ended at its generation (endedRecord). Returns
    // false only when the browser refused. The end is written even when
    // localStorage has no marker (localStorage refused it: the durable store
    // may still hold it). Not a deletion, from either store. A durable store
    // without a record of the session would leave the next page unable to
    // tell a marker localStorage had not replaced on disk yet from one whose
    // durable copy was never written. And a localStorage without one would
    // leave it unable to tell a marker the durable store still has because
    // this page went before its transaction ran - a reload or a closed tab
    // right after STOP, while another page had the store busy - from one
    // that localStorage lost with a killed browser. The lock is held until
    // the end has reached the disk, failed or timed out: until then another
    // page whose copy of localStorage is a moment behind this one's could
    // find the marker in both stores, and with the lock gone take it for a
    // crash.
    function clear() {
        const wasLive = live !== null;
        live = null;
        connected = NOTHING_CONNECTED;
        // The session is over: it drives nothing.
        holdDriving('');
        // A page with no session since its last clear() has nothing to
        // end, unless that end never reached the disk or something else has
        // been put in its place since: STOP or Reset pressed while idle is
        // no disk write.
        const record = storage && typeof storage.state === 'function' ? storage.state(key) : null;
        const owed = wasLive || safeGet(key, null, storage) !== stored || Boolean(record && record.status === 'failed');
        const removed = !owed || retireRecord(key, endedRecord(generation, now()), storage);
        // The end, or nothing where localStorage refused it (a plain Storage
        // removes the marker).
        stored = safeGet(key, null, storage);
        // On its way to disk at once: until it lands, a force-quit brings
        // the marker back as a crash.
        if (owed && storage && typeof storage.flush === 'function') storage.flush();
        if (releaseLock) {
            const release = releaseLock;
            // Not if a new session has started meanwhile: it holds the same
            // lock, since holdLock() asks for none while this one is held.
            const letGo = () => {
                if (live !== null || releaseLock !== release) return;
                releaseLock = null;
                release();
            };
            if (storage && typeof storage.settled === 'function') storage.settled().then(letGo, letGo);
            else letGo();
        }
        return removed;
    }

    return { owner: id, note, clear, waitingForDisk, holdVacuglideLink };
}

// How long the lock manager gets to say whether a marker's page is open. The
// stop waits on the answer, so an answer that never comes cannot be allowed
// to hold it back.
export const OWNER_QUERY_TIMEOUT_MS = 2000;

// Which of the pages `owners` are still open, and which Handy each of those
// drives right now: one snapshot of the lock manager, since a page holds or
// asks for its lock for as long as it owns a marker, and the lock
// drivingLockName names for as long as its session drives that Handy.
// Resolves { alive, driving, vacuglideLinked }: the owners that are open, by
// owner the Handy keys it drives - only for a page that is open, and only a
// key a page could have written - and by owner the VacuGlide tokens it has
// connected, for any page that holds that lock: the browser drops it with
// the page, so a page that holds it is open whether or not it has a session. Without a lock manager (an http:// origin that is not
// localhost has none), or without an answer from it in time, nothing can
// tell, and every one of them is treated as gone, driving nothing: stopping
// a Handy that turns out to be in use in another tab is the safe way to be
// wrong. With no owners to ask about, the lock manager is asked only for
// the VacuGlides other pages have connected (`linked`): a VacuGlide stop
// still owed is sent with no marker anywhere.
export async function openPages(owners, locks, timeoutMs = OWNER_QUERY_TIMEOUT_MS, { linked = false } = {}) {
    const none = { alive: new Set(), driving: new Map(), vacuglideLinked: new Map() };
    const asked = (Array.isArray(owners) ? owners : []).filter((owner) => cleanOwner(owner));
    if ((asked.length === 0 && !linked) || !locks || typeof locks.query !== 'function') return none;
    let timer = null;
    try {
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const snapshot = await Promise.race([locks.query(), late]);
        const names = new Set();
        for (const list of [snapshot && snapshot.held, snapshot && snapshot.pending]) {
            if (!Array.isArray(list)) continue;
            for (const lock of list) if (lock && typeof lock.name === 'string') names.add(lock.name);
        }
        const alive = new Set(asked.filter((owner) => names.has(liveSessionLockName(owner))));
        const driving = new Map();
        const vacuglideLinked = new Map();
        for (const name of names) {
            const linked = parseVacuglideLinkLockName(name);
            if (linked) {
                const tokens = vacuglideLinked.get(linked.owner) || [];
                if (!tokens.includes(linked.token)) tokens.push(linked.token);
                vacuglideLinked.set(linked.owner, tokens);
                continue;
            }
            const lock = parseDrivingLockName(name);
            if (!lock || !alive.has(lock.owner)) continue;
            const keys = driving.get(lock.owner) || [];
            if (!keys.includes(lock.key)) keys.push(lock.key);
            driving.set(lock.owner, keys);
        }
        return { alive, driving, vacuglideLinked };
    } catch (e) {
        // Cannot tell: every one of them counts as gone.
        return none;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

// Which of the pages `owners` are still open (openPages).
export async function aliveOwners(owners, locks, timeoutMs = OWNER_QUERY_TIMEOUT_MS) {
    return (await openPages(owners, locks, timeoutMs)).alive;
}

// Is the page `owner` still open? aliveOwners for one page.
export async function isOwnerAlive(owner, locks, timeoutMs = OWNER_QUERY_TIMEOUT_MS) {
    return (await aliveOwners([owner], locks, timeoutMs)).has(owner);
}

// The stops still owed, as stored: { handy: [{ key, promised }], vacuglide:
// [{ token, cluster, promised }], version }, each list oldest first. Only
// this module writes the record, and always as JSON, so one that cannot be
// read was not written here and names nothing to stop.
function readPending(storage) {
    return parsePending(safeGet(PENDING_CRASH_STOPS_KEY, null, storage)) || { handy: [], vacuglide: [], version: 0 };
}

function readPendingEntries(storage) {
    return readPending(storage).handy;
}

// How each list of the record names a device.
const PENDING_LISTS = {
    handy: { id: (entry) => entry.key, clean: (value) => sanitizeConnectionKey(value) },
    vacuglide: { id: (entry) => entry.token, clean: (value) => sanitizeDeviceToken(value) }
};

// Brings the stops still owed in localStorage into line with the durable
// snapshot `durable`, when this page first reads the durable store and
// before anything it held back goes there (createCrashRecoveryStorage). The
// copy with the newer version is believed. A stop handed over, or one
// settled, in the minute before the browser was killed is on disk in the
// durable store and may not be in localStorage: believing localStorage would
// drop a stop owed to a Handy that may be moving, or report again, as still
// owed, a stop the Handy API had confirmed. And a change whose durable copy
// was never written (IndexedDB failed, or did not answer in time) leaves
// localStorage the newer copy, which is kept - never taken for older merely
// because the durable store has another. Two copies that each hold a change
// the other lacks are merged, and the union is written to both: this page
// changed the record before it had read the durable store (a Connect, or a
// pass that could not wait for the read), or two pages wrote the same
// version. A key settled meanwhile may come back, and is only sent a stop
// again; a key dropped could be a Handy still moving.
export function reconcilePendingCrashStops(storage, durable) {
    const records = durableRecords(durable);
    if (!records) return;
    const localText = safeGet(PENDING_CRASH_STOPS_KEY, null, storage);
    const durableText = records.has(PENDING_CRASH_STOPS_KEY) ? records.get(PENDING_CRASH_STOPS_KEY) : null;
    if (localText === durableText) return;
    const onDisk = parsePending(durableText);
    // Nothing the durable store knows: localStorage's copy is all there is.
    if (!onDisk) return;
    const here = parsePending(localText);
    const mine = changedHere(storage, PENDING_CRASH_STOPS_KEY, durable);
    if (!here || (!mine && onDisk.version > here.version)) {
        safeSet(PENDING_CRASH_STOPS_KEY, durableText, storage);
        return;
    }
    if (!mine && here.version > onDisk.version) return;
    const [newer, older] = here.version >= onDisk.version ? [here, onDisk] : [onDisk, here];
    const merge = (list) => {
        const id = PENDING_LISTS[list].id;
        return older[list].filter((entry) => !newer[list].some((item) => id(item) === id(entry))).concat(newer[list]).slice(-MAX_PENDING_CRASH_STOPS);
    };
    writePending({ handy: merge('handy'), vacuglide: merge('vacuglide') }, storage, Math.max(here.version, onDisk.version));
}

// { handy, vacuglide, version } as stored, or null for no record, or one
// this module did not write. A record without a version is older than any
// with one.
function parsePending(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.handy)) return null;
    const handy = [];
    for (const item of parsed.handy) {
        const key = sanitizeConnectionKey(item && typeof item === 'object' ? item.key : null);
        if (!key || handy.some((entry) => entry.key === key)) continue;
        handy.push({ key, promised: cleanPromise(item.promised) });
        if (handy.length >= MAX_PENDING_CRASH_STOPS) break;
    }
    // A token the Connect field would refuse is none, and a cluster it would
    // not send a token to is '' (the stop then asks Autoblow's router).
    const vacuglide = [];
    for (const item of Array.isArray(parsed.vacuglide) ? parsed.vacuglide : []) {
        const token = sanitizeDeviceToken(item && typeof item === 'object' ? item.token : null);
        if (!token || vacuglide.some((entry) => entry.token === token)) continue;
        vacuglide.push({ token, cluster: normalizeCluster(item.cluster) || '', promised: cleanPromise(item.promised) });
        if (vacuglide.length >= MAX_PENDING_CRASH_STOPS) break;
    }
    const version = cleanGeneration(parsed.version);
    return { handy, vacuglide, version: version === null ? 0 : version };
}

// A promise as stored: the token of the page that made it (a newPageId), or
// '' for none. Anything else reads as no promise, which only adds a try.
function cleanPromise(value) {
    return typeof value === 'string' && /^[0-9a-z]{1,64}$/i.test(value) ? value : '';
}

// Writes the stops still owed under a version newer than the one stored and
// than `after`. An empty list is written too, never removed: a durable store
// that has no record would leave the next page unable to tell stops settled
// from stops whose durable copy was never written.
function writePending({ handy = [], vacuglide = [] }, storage, after = 0) {
    const current = parsePending(safeGet(PENDING_CRASH_STOPS_KEY, null, storage));
    const version = Math.max(after, current ? current.version : 0) + 1;
    const record = { handy, version };
    if (vacuglide.length > 0) record.vacuglide = vacuglide;
    return safeSet(PENDING_CRASH_STOPS_KEY, JSON.stringify(record), storage);
}

// The Handys' list replaced by `entries`, the VacuGlides' kept as stored.
function writePendingEntries(entries, storage, after = 0) {
    return writePending({ ...readPending(storage), handy: entries }, storage, after);
}

// The device `id` leaves `list` of the stops still owed (clearPendingCrashStop).
function clearPending(list, id, storage) {
    const { id: idOf, clean: cleanId } = PENDING_LISTS[list];
    const clean = cleanId(id);
    const record = readPending(storage);
    if (!clean || !record[list].some((entry) => idOf(entry) === clean)) return true;
    return writePending({ ...record, [list]: record[list].filter((entry) => idOf(entry) !== clean) }, storage);
}

// The stop owed to the device `id` in `list` gave up (notePendingCrashStopGaveUp).
function notePendingGaveUp(list, id, { seen = '', token = newPageId() } = {}, storage) {
    const { id: idOf, clean: cleanId } = PENDING_LISTS[list];
    const clean = cleanId(id);
    const record = readPending(storage);
    const entry = clean ? record[list].find((item) => idOf(item) === clean) : null;
    if (!entry) return false;
    if (entry.promised !== '' && entry.promised === cleanPromise(seen)) {
        return !writePending({ ...record, [list]: record[list].filter((item) => item !== entry) }, storage);
    }
    const first = entry.promised === '';
    // Never the token being replaced: a page that found that one would take
    // this promise for the one it already keeps.
    let mine = cleanPromise(token);
    if (mine === '' || mine === entry.promised) mine = newPageId();
    entry.promised = mine;
    // If the browser refuses the write, a first promise still holds: with
    // none noted, no page can count as the try, so the device stays owed,
    // and the next page to open sends it and promises in its turn. A refused
    // renewal leaves the older promise in place, which a page that found it
    // could count as its try and so end: then promise nothing.
    return writePending(record, storage) || first;
}

// The keys still owed a stop, oldest first; [] when there are none.
export function readPendingCrashStops(storage) {
    return readPendingEntries(storage).map((entry) => entry.key);
}

// The promise each owed key carries, by key ('' for none yet): what a page
// finds before it sends anything, and hands back to
// notePendingCrashStopGaveUp as `seen` if its own stop gives up.
export function readPendingCrashStopPromises(storage) {
    return new Map(readPendingEntries(storage).map((entry) => [entry.key, entry.promised]));
}

// Hands the keys a crashed session drove over to the stops still owed. A
// key that is owed already starts over: this is a new crash, and the page
// recovering from it owes the next page to open a try of its own. Returns
// the keys owed afterwards, as stored: a key the browser refused to store is
// not among them.
export function addPendingCrashStops(keys, storage) {
    const adding = cleanHandyKeys(keys, MAX_PENDING_CRASH_STOPS);
    const current = readPendingEntries(storage);
    if (adding.length === 0) return current.map((entry) => entry.key);
    const next = current
        .filter((entry) => !adding.includes(entry.key))
        .concat(adding.map((key) => ({ key, promised: '' })))
        .slice(-MAX_PENDING_CRASH_STOPS);
    return (writePendingEntries(next, storage) ? next : current).map((entry) => entry.key);
}

// The stop owed to `key` is settled: a stop to it was confirmed, or it is
// not in HAMP mode, or Connect has confirmed a stop of its own. Returns
// false only when the key was owed and the browser refused to drop it.
export function clearPendingCrashStop(key, storage) {
    return clearPending('handy', key, storage);
}

// This page's stop to an owed `key` gave up at the end of its window with
// nothing that settles it. `seen` is the promise this page found on the key
// before it sent anything ('' for none; readPendingCrashStopPromises), and
// `token` the one it notes if it promises. The first page to give up
// promises the next page to open another try. A page that found that very
// promise is the try - every stop it sent came after the promise - so once
// it gives up as well the key is owed no more. A page that did not - another
// tab, opened while the first was still sending - is not that try: it tells
// the wearer the same, and so notes the promise under its own token, which
// only a page opened after it can find. Every promise the banner has shown
// is then kept by the first page to open after it. No clock is read, so a
// clock set back or forward between two pages cannot make one opened before
// a promise count as its try. Returns whether the key is still owed, which
// is the one thing the banner may then promise: a key the browser refused to
// drop is still owed, and the next page to open does send it.
export function notePendingCrashStopGaveUp(key, { seen = '', token = newPageId() } = {}, storage) {
    return notePendingGaveUp('handy', key, { seen, token }, storage);
}

// The VacuGlides still owed their whole stop, as for The Handy above:
// [{ token, cluster }], oldest first, with the cluster each was last reached
// through ('' when none is known: the stop asks Autoblow's router). A
// VacuGlide crash stop that is not confirmed in its window is sent again the
// next time EdgeLoop opens, the one try the banner promises, exactly as a
// Handy's is - it has no watchdog either, and runs on at its last speed.
export function readPendingVacuglideStops(storage) {
    return readPending(storage).vacuglide.map(({ token, cluster }) => ({ token, cluster }));
}

export function readPendingVacuglideStopPromises(storage) {
    return new Map(readPending(storage).vacuglide.map((entry) => [entry.token, entry.promised]));
}

// Hands the VacuGlides a crashed session drove ([{ token, cluster }]) over
// to the stops still owed. One already owed starts over, with the cluster
// named now. Returns the tokens owed afterwards, as stored.
export function addPendingVacuglideStops(devices, storage) {
    const adding = cleanVacuglides(devices);
    const record = readPending(storage);
    if (adding.length === 0) return record.vacuglide.map((entry) => entry.token);
    const next = record.vacuglide
        .filter((entry) => !adding.some((item) => item.token === entry.token))
        .concat(adding.map(({ token, cluster }) => ({ token, cluster, promised: '' })))
        .slice(-MAX_PENDING_CRASH_STOPS);
    return (writePending({ ...record, vacuglide: next }, storage) ? next : record.vacuglide).map((entry) => entry.token);
}

// The whole stop owed to `token` is settled: confirmed, or the device has
// been connected - here or in another tab - and its connect confirmed a
// whole stop of its own.
export function clearPendingVacuglideStop(token, storage) {
    return clearPending('vacuglide', token, storage);
}

// As notePendingCrashStopGaveUp, for a VacuGlide's whole stop.
export function notePendingVacuglideStopGaveUp(token, { seen = '', token: promise = newPageId() } = {}, storage) {
    return notePendingGaveUp('vacuglide', token, { seen, token: promise }, storage);
}

// What to do about the markers whose pages are gone (`markers`, the last
// session; `marker` for just one) and about the stops still owed from
// earlier ones (`pending`, their keys). Every Handy key the last session was
// driving gets the stop - not always the key saved now: a failed Connect
// with a new key saves it while the old link keeps driving. The saved key
// gets it as well, whatever the markers say: any doubt about a Handy ends in
// a stop (handy.js, rule 1), and a stop is the one command that cannot hurt.
// Only a key a session drove is owed the stop, so a Handy that session never
// touched, switched off in a drawer, cannot make the next boot repeat the
// report. A marker that says nothing usable counts the saved key as driven,
// and brings the advice for every other kind of toy. Each owed key is sent
// the stop once, in the group of the session it belongs to; without a marker
// the saved key is not, since the last session ended cleanly. `inUse` are
// the keys of Handys that a session in a page still open drives right now
// (drivesHandyNow): they are that page's to stop, and none of them is sent
// anything from here. `earlier: false` leaves the stops still owed out (a
// session start: they are promised to the next page to open), and
// `otherPage` says the markers were found by a page that was open while
// theirs died. Every VacuGlide a dead session drove gets its whole stop
// (`vacuglide`, [{ token, cluster, driven }]), except one another page still
// open has connected (`vacuglideInUse`): that page answers for it, and the
// banner says so (`vacuglideLeftInUse`). A marker that says nothing usable
// sends the token saved here (`savedVacuglideToken`) the whole stop too,
// through Autoblow's router, since nothing says where it was reached. The
// stop is chased for five minutes with the alarm up, as the driver chases
// any device it lost, and a page that goes away meanwhile leaves the chase
// to the next one (vacuglide.js). A VacuGlide a session drove whose whole
// stop is still owed (`pendingVacuglide`, [{ token, cluster }]) is sent it
// again with the stops earlier sessions owe (`earlierVacuglide`), as a
// Handy key is - unless the last session drove it too, or another page
// still open has it connected. Returns null when there is nothing to do.
export function planCrashRecovery({
    marker = null,
    markers = marker ? [marker] : [],
    savedHandyKey,
    pending = [],
    inUse = [],
    earlier: withEarlier = true,
    otherPage = false,
    savedVacuglideToken = '',
    vacuglideInUse = [],
    pendingVacuglide = []
} = {}) {
    const busy = new Set(cleanHandyKeys(inUse, 64));
    const linkedElsewhere = new Set((Array.isArray(vacuglideInUse) ? vacuglideInUse : []).map((token) => sanitizeDeviceToken(token)).filter(Boolean));
    const saved = sanitizeConnectionKey(savedHandyKey);
    const owed = cleanHandyKeys(pending, MAX_PENDING_CRASH_STOPS).filter((key) => !busy.has(key));
    const found = (Array.isArray(markers) ? markers : []).filter(Boolean);
    let handy = [];
    // Keys the dead sessions drove, or the saved key, that a session in a
    // page still open drives right now: nothing is sent to them, and the
    // banner says why.
    const leftInUse = [];
    let known = true;
    let intiface = false;
    let tcode = false;
    const vacuglide = [];
    const vacuglideLeftInUse = [];
    if (found.length > 0) {
        const driven = [];
        const addVacuglide = (token, cluster, wasDriven) => {
            if (linkedElsewhere.has(token)) {
                if (!vacuglideLeftInUse.includes(token)) vacuglideLeftInUse.push(token);
                return;
            }
            const seen = vacuglide.find((entry) => entry.token === token);
            if (seen) {
                if (!seen.cluster && cluster) seen.cluster = cluster;
                seen.driven = seen.driven || wasDriven;
                return;
            }
            vacuglide.push({ token, cluster, driven: wasDriven });
        };
        for (const m of found) {
            const vacuglides = Array.isArray(m.vacuglides) ? m.vacuglides : [];
            const usable = m.readable === true
                && (m.handyKeys.length > 0 || m.intiface === true || m.tcode === true || vacuglides.length > 0);
            if (!usable) {
                known = false;
                continue;
            }
            for (const key of m.handyKeys) if (!busy.has(key) && !driven.includes(key)) driven.push(key);
            if (m.intiface === true) intiface = true;
            if (m.tcode === true) tcode = true;
            for (const entry of vacuglides) addVacuglide(entry.token, entry.cluster, true);
        }
        const savedToken = sanitizeDeviceToken(savedVacuglideToken);
        if (!known && savedToken) addVacuglide(savedToken, '', false);
        handy = driven.map((key) => ({ key, saved: key === saved, driven: true }));
        // A saved key an earlier session still owes a stop is that
        // session's, not one this session left alone.
        if (saved && !busy.has(saved) && !driven.includes(saved) && !(known && owed.includes(saved))) {
            handy.push({ key: saved, saved: true, driven: !known });
        }
        for (const key of found.flatMap((m) => m.handyKeys).concat(saved ? [saved] : [])) {
            if (busy.has(key) && !leftInUse.includes(key)) leftInUse.push(key);
        }
        if (!known) {
            intiface = true;
            tcode = true;
        }
    }
    const inLastSession = handy.map((entry) => entry.key);
    const earlier = withEarlier
        ? owed.filter((key) => !inLastSession.includes(key)).map((key) => ({ key, saved: key === saved, driven: true }))
        : [];
    const earlierVacuglide = [];
    for (const item of withEarlier && Array.isArray(pendingVacuglide) ? pendingVacuglide : []) {
        const token = sanitizeDeviceToken(item && typeof item === 'object' ? item.token : null);
        if (!token || linkedElsewhere.has(token) || vacuglide.some((entry) => entry.token === token)) continue;
        if (vacuglideLeftInUse.includes(token) || earlierVacuglide.some((entry) => entry.token === token)) continue;
        earlierVacuglide.push({ token, cluster: normalizeCluster(item.cluster) || '', driven: true });
    }
    if (found.length === 0 && earlier.length === 0 && earlierVacuglide.length === 0) return null;
    return { lastSession: found.length > 0, otherPage: otherPage === true, handy, leftInUse, intiface, tcode, known, earlier, vacuglide, vacuglideLeftInUse, earlierVacuglide };
}

function retryWindow(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 1) return 'a few minutes';
    const whole = Math.round(n);
    return `${whole} minute${whole === 1 ? '' : 's'}`;
}

// What one Handy key was sent and what came back. `update` is null while
// the first answer is still out. `kept`: the key is still owed the stop, so
// the next page to open sends it again - the one thing the banner may
// promise about a stop that did not get through.
export function describeHandyCrashStop(update, { saved = true, driven = true, kept = driven, label = '', retryMinutes = 5 } = {}) {
    const who = label ? `The Handy (key ending ${label})` : 'The Handy';
    // "Found": the report stays up while the wearer may save another key,
    // and "the key saved here" would then name that one.
    let how = saved ? 'with the connection key it found saved here' : 'with the connection key that session used';
    if (!driven) how += ' (that session was not driving it)';
    const sent = `EdgeLoop sent ${who} a stop ${how}`;
    const detail = update && update.detail ? ` (${update.detail})` : '';
    if (!update) return `EdgeLoop is sending ${who} a stop ${how}...`;
    switch (update.outcome) {
        case RECOVERY_STOP.STOPPED:
            // Only a StateResult of 0 says the device was moving until now.
            return update.detail
                ? `${sent}. The Handy API confirmed it${detail}: it was still moving and has stopped.`
                : `${sent}. The Handy API confirmed the stop.`;
        case RECOVERY_STOP.ALREADY_STOPPED:
            return `${sent}. The Handy API answered that it was already stopped${detail}.`;
        case RECOVERY_STOP.NOT_HAMP:
            return `${sent}. The Handy API answered that it is not in HAMP mode${detail}, so the motion EdgeLoop drives is not running on it; another app may have taken it over.`;
        case RECOVERY_STOP.CONNECTED:
            return `${who} has been connected again, and connecting it confirmed that it is stopped.`;
        case RECOVERY_STOP.LINKED:
            // Nothing was sent from here, and that connection may have been
            // made before the dead page last moved it: no stop is claimed.
            return `${who} is connected on this page: EdgeLoop stops it through that connection, unless the session on this page is driving it.`;
        default: {
            const why = update.outcome === RECOVERY_STOP.OFFLINE
                ? `, but the Handy API answered that the device is offline${detail}, so the stop could not reach it`
                : `, but the stop was not confirmed${detail}`;
            const next = update.final
                ? `EdgeLoop stopped sending it after ${retryWindow(retryMinutes)}${kept ? ' and sends it again the next time it opens' : ''}.`
                : `EdgeLoop keeps sending the stop for ${retryWindow(retryMinutes)}.`;
            return `${sent}${why}. If ${who} is moving, switch it off. ${next}`;
        }
    }
}

// A Handy the dead session drove, or the key saved here, that a session
// running in another page drives right now. A stop from here would land
// behind that session's driver. That session stops it when it pauses or
// stops, and if its page dies too, its own marker names it.
export function describeHandyLeftInUse(key) {
    return `The Handy (key ending ${String(key).slice(-4)}) is being driven by a session running in another EdgeLoop tab or window, so EdgeLoop sent it nothing and left it to that session: pausing or stopping that session stops it.`;
}

// What one VacuGlide was sent and what came back: its whole stop - the motor
// stop and both valve closes - which the driver chases until Autoblow's
// server confirms it (vacuglide.js, stopVacuglideAfterCrash). `update` is
// null while nothing has come back yet. `driven: false` is the token saved
// here, sent the stop because the marker could not be read. `kept`: the
// whole stop is still owed, and the next page to open sends it again.
export function describeVacuglideCrashStop(update, { label = '', driven = true, kept = false, retryMinutes = 5 } = {}) {
    const who = label ? `The VacuGlide (token ending ${label})` : 'The VacuGlide';
    const how = driven ? '' : ' (the token saved here: EdgeLoop could not read whether that session drove it)';
    const sent = `EdgeLoop sent ${who}${how} its whole stop - the motor stop and both valve closes`;
    if (!update) return `EdgeLoop is sending ${who}${how} its whole stop - the motor stop and both valve closes...`;
    const detail = update.detail ? ` (${update.detail})` : '';
    switch (update.outcome) {
        case RECOVERY_STOP.STOPPED:
            return `${sent}. Autoblow's server confirmed it: the motor is stopped and both valves are closed.`;
        case RECOVERY_STOP.LINKED:
            return `${who} is connected on this page: EdgeLoop stops it and closes both valves through that connection, unless the session on this page is driving it.`;
        case RECOVERY_STOP.CONNECTED:
            return update.detail === 'elsewhere'
                ? `Another EdgeLoop tab or window has connected ${who.replace(/^The /, 'the ')}, or is connecting it, and answers for it from there.`
                : `${who} has been connected again, and connecting it stopped it and closed both valves.`;
        default: {
            const why = update.outcome === RECOVERY_STOP.OFFLINE
                ? `, but Autoblow's server answered that the device is not online${detail}, so the stop could not reach it`
                : `, but the stop was not confirmed${detail}`;
            const next = update.final
                ? `EdgeLoop stopped sending it after ${retryWindow(retryMinutes)}${kept ? ' and sends it again the next time it opens' : ''}.`
                : `EdgeLoop keeps sending it for ${retryWindow(retryMinutes)}.`;
            return `${sent}${why}. If ${who} is running or a valve is open, switch it off with its power button. ${next}`;
        }
    }
}

// A VacuGlide the dead session drove that another page still open has
// connected: that page answers for it, and nothing was sent from here.
export function describeVacuglideLeftInUse(token) {
    return `The VacuGlide (token ending ${String(token).slice(-4)}) is connected in another EdgeLoop tab or window, so EdgeLoop sent it nothing and left it to that page, which stops it on every way out of its session and whenever it sees it moving after a stop.`;
}

// The whole banner. `updates` maps each Handy key to its latest update, and
// `owed` lists the keys still owed a stop right now (null: every key a
// session drove); `vacuglideUpdates` and `owedVacuglide` are the same for
// the VacuGlides, by token. The last session comes first, with its advice - under a
// headline that names another tab or window when a page found it at the
// start of a session of its own; then the keys earlier sessions still owe,
// under a headline of their own, so "that session" in each line names the
// right one. Every Handy is named by the
// end of its key, even when it is the only one: the wearer may connect
// another Handy while this report is still changing, and next to that
// link's own warnings a bare "The Handy has stopped" would read as news
// about the device connected now.
export function describeCrashRecovery(plan, updates = new Map(), { retryMinutes = 5, owed = null, vacuglideUpdates = new Map(), vacuglideRetryMinutes = 5, owedVacuglide = null } = {}) {
    if (!plan) return '';
    const line = ({ key, saved, driven }) => describeHandyCrashStop(
        updates && typeof updates.get === 'function' ? updates.get(key) || null : null,
        {
            saved,
            driven,
            kept: driven && (!Array.isArray(owed) || owed.includes(key)),
            label: key.slice(-4),
            retryMinutes
        }
    );
    const vacuglideLine = (entry) => describeVacuglideCrashStop(
        vacuglideUpdates && typeof vacuglideUpdates.get === 'function' ? vacuglideUpdates.get(entry.token) || null : null,
        {
            label: entry.token.slice(-4),
            driven: entry.driven !== false,
            kept: entry.driven !== false && (!Array.isArray(owedVacuglide) || owedVacuglide.includes(entry.token)),
            retryMinutes: vacuglideRetryMinutes
        }
    );
    const parts = [];
    if (plan.lastSession) {
        parts.push(plan.otherPage ? OTHER_PAGE_CRASH_HEADLINE : CRASH_HEADLINE);
        if (!plan.known) parts.push(UNKNOWN_HARDWARE_NOTE);
        for (const entry of plan.handy) parts.push(line(entry));
        for (const key of Array.isArray(plan.leftInUse) ? plan.leftInUse : []) parts.push(describeHandyLeftInUse(key));
        for (const entry of Array.isArray(plan.vacuglide) ? plan.vacuglide : []) parts.push(vacuglideLine(entry));
        for (const token of Array.isArray(plan.vacuglideLeftInUse) ? plan.vacuglideLeftInUse : []) parts.push(describeVacuglideLeftInUse(token));
        if (plan.intiface) parts.push(INTIFACE_CRASH_ADVICE);
        if (plan.tcode) parts.push(TCODE_CRASH_ADVICE);
    }
    const earlier = Array.isArray(plan.earlier) ? plan.earlier : [];
    const earlierVacuglide = Array.isArray(plan.earlierVacuglide) ? plan.earlierVacuglide : [];
    if (earlier.length > 0 || earlierVacuglide.length > 0) {
        parts.push(EARLIER_CRASH_HEADLINE);
        for (const entry of earlier) parts.push(line(entry));
        for (const entry of earlierVacuglide) parts.push(vacuglideLine(entry));
    }
    return parts.join(' ');
}

function isSettled(update) {
    return Boolean(update) && isRecoveryStopConclusive(update.outcome);
}

// Runs `start` once `doc` is a page the wearer has opened: at once, or - in a
// page Chrome is prerendering - when it is activated, and never if it is
// thrown away unseen. Chrome prerenders a page it expects to be opened (from
// the address bar, while a URL it predicts from history is typed, or from
// speculation rules) and runs its scripts hidden. The prerendering spec puts
// [DelayWhilePrerendering] on navigator.locks.query(): the call waits for
// activation, so the recovery would give the owner of a live session's
// marker up for dead after OWNER_QUERY_TIMEOUT_MS, stop that session's Handy
// and remove its marker. Activation fires 'prerenderingchange' once
// document.prerendering is false, and it never turns true again. Returns
// whether `start` ran now.
export function whenActivated(doc, start) {
    if (!doc || doc.prerendering !== true) {
        start();
        return true;
    }
    if (typeof doc.addEventListener !== 'function') return false;
    const activated = () => {
        if (doc.prerendering === true) {
            doc.addEventListener('prerenderingchange', activated, { once: true });
            return;
        }
        start();
    };
    doc.addEventListener('prerenderingchange', activated, { once: true });
    return false;
}

// One recovery pass. Reads the markers and the stops still owed. Hands the
// keys each session whose page is gone drove over to the stops still owed
// and removes its marker; reports through onReport(text) at once; sends
// every Handy key the stop and reports again whenever an answer changes;
// drops each key from the stops still owed as soon as its stop is settled;
// and when a stop gives up, notes the promise of another try or, when this
// page was that try, drops the key. `stopHandy(key, { onUpdate })` is
// handy.js's stopHandyAfterCrash; an answer it gives after the stop is over
// (Connect confirming a stop for that Handy) is reported like any other.
//   owner         this page's id: its own marker is never recovered here
//   claimed       the storage keys of markers this page's passes have taken
//                 on, shared between them, so no marker is recovered twice
//   earlier       false leaves the stops still owed out (planCrashRecovery)
//   otherPage     the markers are of pages that died while this one was open
//   only          the storage keys of the markers to look at, and no other
//   onOpen(keys)  told the storage keys of the markers whose pages are open
//   liveHandyKey  the Handy this page has a link to: never "the saved key"
//                 of a session that died elsewhere. One a dead session drove
//                 is still asked for; its driver answers for it (handy.js)
//   snapshot      the durable records to merge with localStorage; left out,
//                 the storage's own read() is waited for, up to
//                 readTimeoutMs, and `onLate(snapshot)` is told when a read
//                 that timed out answers after all
//   sentOwed      the stops still owed that this page's passes have sent,
//                 shared between them, so no pass sends or reports one that
//                 another is already sending
//   sweep         removes from both stores the ends of sessions they no
//                 longer need (expiredEndedRecords)
//   now()         the clock the ends it writes are stamped with
//   stopVacuglide(token, { cluster, onUpdate })
//                 vacuglide.js's stopVacuglideAfterCrash: the whole stop of
//                 each VacuGlide the dead sessions drove, reported like a
//                 Handy's stop
//   savedVacuglideToken, liveVacuglideToken
//                 the VacuGlide token saved here, and the one this page has
//                 connected, as for The Handy
// Resolves { recovered, plan, finals, vacuglideFinals, settled } once every
// stop is over, and what it tidied in the durable store with it.
// In a page, createCrashRecovery runs it.
export async function runCrashRecovery({
    storage,
    locks,
    owner = null,
    claimed = null,
    earlier = true,
    otherPage = false,
    only = null,
    onOpen = null,
    savedHandyKey = '',
    liveHandyKey = '',
    stopHandy,
    onReport,
    retryMinutes = 5,
    ownerQueryTimeoutMs = OWNER_QUERY_TIMEOUT_MS,
    snapshot = undefined,
    onLate = null,
    readTimeoutMs = DURABLE_READ_TIMEOUT_MS,
    sentOwed = null,
    sweep = false,
    now = Date.now,
    stopVacuglide,
    savedVacuglideToken = '',
    liveVacuglideToken = '',
    vacuglideRetryMinutes = 5
} = {}) {
    const self = cleanOwner(owner);
    const taken = (marker) => Boolean(claimed) && claimed.has(marker.key);
    // What the durable store holds, when the storage has one: a marker, or a
    // stop still owed, that localStorage lost with a killed browser is there.
    // A store that cannot be read in time leaves localStorage alone to go by,
    // as before there was one.
    let durable = snapshot === undefined ? null : snapshot;
    if (snapshot === undefined && storage && typeof storage.read === 'function') {
        durable = await storage.read({ timeoutMs: readTimeoutMs, onLate });
    }
    // What this page held back until the durable store had been read has
    // gone out with that read, merged with what it found (the storage's
    // onAttach); whatever is left goes now.
    if (storage && typeof storage.flush === 'function') storage.flush();
    const wanted = (marker) => !(self && marker.owner === self) && (!only || only.has(marker.key));
    const found = readLiveSessions(storage, durable).filter((marker) => wanted(marker) && !taken(marker));
    const stale = staleLiveSessions(storage, durable).filter(wanted);
    const unwritten = unwrittenEnds(storage, durable).filter(wanted);
    // Kept apart from the stops, which never wait for it.
    const tidying = [];
    if (sweep) {
        const expired = expiredEndedRecords(storage, durable, now()).filter((record) => !(self && record.owner === self));
        if (expired.length > 0) tidying.push(sweepEnded(storage, expired));
    }
    const tidied = () => Promise.all(tidying).then(() => {});
    const nothingOwed = () => readPendingCrashStops(storage).length === 0 && readPendingVacuglideStops(storage).length === 0;
    if (found.length === 0 && stale.length === 0 && unwritten.length === 0 && (!earlier || nothingOwed())) {
        await tidied();
        return { recovered: false, alive: 0 };
    }
    // A VacuGlide stop still owed asks which VacuGlides other pages have
    // connected even when no marker is left to ask about: one of them is
    // that page's to answer for, whether or not a session runs there.
    const vacuglideOwed = earlier && readPendingVacuglideStops(storage).length > 0;
    const { alive, driving, vacuglideLinked } = await openPages(found.concat(stale, unwritten).map((marker) => marker.owner), locks, ownerQueryTimeoutMs, { linked: vacuglideOwed });
    // A copy of a marker that the other store records as ended is no crash,
    // and once its page is gone the store that is behind is given the end:
    // a later pass that cannot read the durable store must not take a stale
    // copy in localStorage for one, nor a browser killed before localStorage
    // has written its end to disk leave the next page two copies of the
    // marker and none of its end. localStorage gets an end stamped with the
    // time it is written, so that both ends are kept until localStorage has
    // surely written it to disk (ENDED_RECORD_KEEP_MS): swept with the end
    // written at STOP, a week old already, it could go with the marker still
    // on disk, and the next open would report a crash that had not happened.
    const at = now();
    for (const marker of stale) {
        if (alive.has(marker.owner) || safeGet(marker.key, null, storage) !== marker.raw) continue;
        replaceLocalRecord(marker.key, endedRecord(marker.gen, at), storage);
    }
    const behind = unwritten.filter((record) => !alive.has(record.owner));
    if (behind.length > 0) tidying.push(swapDurable(storage, behind.map((record) => [record.key, record.durable, record.local])));
    // A marker whose page is still open is that page's session, not a crash.
    // Another pass of this page may have taken on a marker while this one
    // waited.
    const open = found.filter((marker) => alive.has(marker.owner));
    if (typeof onOpen === 'function') {
        const openKeys = open.concat(stale, unwritten).filter((marker) => alive.has(marker.owner)).map((marker) => marker.key);
        try { onOpen(Array.from(new Set(openKeys))); } catch (e) {}
    }
    const dead = found.filter((marker) => !alive.has(marker.owner) && !taken(marker));
    if (claimed) for (const marker of dead) claimed.add(marker.key);
    // The Handy each open session drives right now is that session's to
    // stop: the one its page holds the driving lock of, read in the same
    // snapshot that found the page open. Not every Handy its marker names:
    // those are every Handy it has driven, and a session that is paused, or
    // has lost its link to one of them, is not driving it - the Handy a dead
    // page left moving would be sent nothing by anyone.
    const inUse = open.flatMap((marker) => driving.get(marker.owner) || []);
    const live = sanitizeConnectionKey(liveHandyKey);
    const saved = sanitizeConnectionKey(savedHandyKey);
    // A VacuGlide another open page has connected is that page's; this
    // page's own is stopped through its own link (stopVacuglideAfterCrash).
    const vacuglideInUse = [...(vacuglideLinked || new Map())].filter(([page]) => page !== self).flatMap(([, tokens]) => tokens);
    const liveToken = sanitizeDeviceToken(liveVacuglideToken);
    const savedToken = sanitizeDeviceToken(savedVacuglideToken);
    let plan = planCrashRecovery({
        markers: dead,
        savedHandyKey: saved && saved !== live ? saved : '',
        pending: readPendingCrashStops(storage),
        inUse,
        earlier,
        otherPage,
        savedVacuglideToken: savedToken && savedToken !== liveToken ? savedToken : '',
        vacuglideInUse,
        pendingVacuglide: readPendingVacuglideStops(storage)
    });
    // A stop still owed that another pass of this page is sending is left to
    // it: the boot pass and the one a late durable read brings both send them.
    // A VacuGlide is noted under its token in the same set, marked as one.
    const owedVacuglideId = (token) => `vacuglide:${token}`;
    if (plan && sentOwed) {
        plan = {
            ...plan,
            earlier: plan.earlier.filter((entry) => !sentOwed.has(entry.key)),
            earlierVacuglide: plan.earlierVacuglide.filter((entry) => !sentOwed.has(owedVacuglideId(entry.token)))
        };
        if (!plan.lastSession && plan.earlier.length === 0 && plan.earlierVacuglide.length === 0) plan = null;
    }
    if (!plan) {
        await tidied();
        return { recovered: false, alive: open.length };
    }
    if (sentOwed) {
        for (const entry of plan.earlier) sentOwed.add(entry.key);
        for (const entry of plan.earlierVacuglide) sentOwed.add(owedVacuglideId(entry.token));
    }

    // Before any stop goes out. From here on the stops still owed answer for
    // the keys the dead sessions drove, so neither a session run after this,
    // nor this page dying mid-stop, can lose one. Only the markers that were
    // read are replaced, in both stores, by the end of their session at the
    // newest generation any record of their page names: what was handed
    // over. The stops still owed are written first and the markers replaced
    // after, in one task, so localStorage writes them to disk together or
    // the stops first, and the durable store in one transaction: a browser
    // killed at any point loses neither. Should the browser refuse the
    // record, the markers stay until the stops they ask for are settled, as
    // they did before there was one.
    const drivenKeys = plan.handy.filter((entry) => entry.driven).map((entry) => entry.key);
    const owedNow = addPendingCrashStops(drivenKeys, storage);
    const drivenVacuglides = plan.vacuglide.filter((entry) => entry.driven);
    const owedVacuglidesNow = addPendingVacuglideStops(drivenVacuglides, storage);
    const handedOver = drivenKeys.every((key) => owedNow.includes(key))
        && drivenVacuglides.every((entry) => owedVacuglidesNow.includes(entry.token));
    const removeMarkers = () => {
        const ends = new Map();
        for (const marker of dead) {
            const gen = Number.isSafeInteger(marker.top) ? marker.top : marker.gen === null ? 0 : marker.gen;
            const seen = ends.get(marker.key);
            if (!seen) ends.set(marker.key, { raw: marker.raw, gen });
            else seen.gen = Math.max(seen.gen, gen);
        }
        const at = now();
        for (const [key, { raw, gen }] of ends) {
            if (safeGet(key, null, storage) === raw) retireRecord(key, endedRecord(gen, at), storage);
        }
    };
    if (handedOver) removeMarkers();
    // What each owed key was promised before this page sends anything: every
    // stop this page sends comes after such a promise, so this page is the
    // try it promised. And the token under which this page promises.
    const seen = readPendingCrashStopPromises(storage);
    const seenVacuglide = readPendingVacuglideStopPromises(storage);
    const token = newPageId();

    const updates = new Map();
    const vacuglideUpdates = new Map();
    // Per key whose stop gave up: whether the next page to open is sure to
    // send it again (notePendingCrashStopGaveUp).
    const promised = new Map();
    const promisedVacuglide = new Map();
    const entries = plan.handy.concat(plan.earlier);
    const vacuglides = plan.vacuglide.concat(plan.earlierVacuglide);
    // The banner promises another try only for a key that is still owed,
    // read back from storage each time after the record has been brought up
    // to date, and that this page could promise. `fresh`: the report is news
    // that a Handy may still be moving - its first word, and every answer
    // that settles nothing - rather than a stop that settled, which only
    // rewords it. `open`: some Handy it names has no settled stop yet.
    const report = (fresh) => {
        if (typeof onReport !== 'function') return;
        try {
            const owed = readPendingCrashStops(storage).filter((key) => promised.get(key) !== false);
            const owedVacuglide = readPendingVacuglideStops(storage).map((entry) => entry.token).filter((device) => promisedVacuglide.get(device) !== false);
            const open = entries.some(({ key }) => !isSettled(updates.get(key)))
                || vacuglides.some(({ token }) => !isSettled(vacuglideUpdates.get(token)));
            onReport(describeCrashRecovery(plan, updates, { retryMinutes, owed, vacuglideUpdates, vacuglideRetryMinutes, owedVacuglide }), { fresh, open });
        } catch (e) {}
    };
    report(true);

    const stops = entries.map(({ key }) => {
        const onUpdate = (update) => {
            // A settled stop is owed no longer, whoever it was owed to. One
            // that gave up is the promise of another try, or the end of it.
            if (isSettled(update)) clearPendingCrashStop(key, storage);
            else if (update && update.final) promised.set(key, notePendingCrashStopGaveUp(key, { seen: seen.get(key) || '', token }, storage));
            updates.set(key, update);
            report(!isSettled(update));
        };
        return Promise.resolve()
            .then(() => (typeof stopHandy === 'function'
                ? stopHandy(key, { onUpdate })
                : { outcome: RECOVERY_STOP.FAILED, detail: 'no stop available', final: true }))
            .catch((e) => ({ outcome: RECOVERY_STOP.FAILED, detail: e && e.message ? e.message : 'unknown error', final: true }))
            .then((update) => {
                if (updates.get(key) !== update) onUpdate(update);
                return update;
            });
    });

    // Each VacuGlide's whole stop, reported the same way: news while nothing
    // has settled it, a rewording once something has - and owed, and
    // promised to the next page to open, the same way as well.
    const vacuglideStops = vacuglides.map(({ token: device, cluster }) => {
        const onUpdate = (update) => {
            if (isSettled(update)) clearPendingVacuglideStop(device, storage);
            else if (update && update.final) promisedVacuglide.set(device, notePendingVacuglideStopGaveUp(device, { seen: seenVacuglide.get(device) || '', token }, storage));
            vacuglideUpdates.set(device, update);
            report(!isSettled(update));
        };
        return Promise.resolve()
            .then(() => (typeof stopVacuglide === 'function'
                ? stopVacuglide(device, { cluster, onUpdate })
                : { outcome: RECOVERY_STOP.FAILED, detail: 'no stop available', final: true }))
            .catch((e) => ({ outcome: RECOVERY_STOP.FAILED, detail: e && e.message ? e.message : 'unknown error', final: true }))
            .then((update) => {
                if (vacuglideUpdates.get(device) !== update) onUpdate(update);
                return update;
            });
    });

    if (!handedOver) {
        // A key the session never drove does not hold the markers, nor keep
        // them waiting while its own stop is still being retried.
        const lastDriven = await Promise.all(stops.filter((_, i) => i < plan.handy.length && plan.handy[i].driven)
            .concat(vacuglideStops.filter((_, i) => i < plan.vacuglide.length && plan.vacuglide[i].driven)));
        if (lastDriven.every(isSettled)) removeMarkers();
    }
    const finals = await Promise.all(stops);
    const vacuglideFinals = await Promise.all(vacuglideStops);
    const settled = entries.every((entry, i) => !entry.driven || isSettled(finals[i]))
        && vacuglides.every((entry, i) => !entry.driven || isSettled(vacuglideFinals[i]));
    await tidied();
    return { recovered: true, plan, finals, vacuglideFinals, settled, alive: open.length };
}

// The storage's swap() (durable-store.js), or nothing applied without one.
function swapDurable(storage, entries) {
    if (entries.length === 0) return Promise.resolve([]);
    if (!storage || typeof storage.swap !== 'function') return Promise.resolve(entries.map(() => false));
    return Promise.resolve()
        .then(() => storage.swap(entries))
        .then((applied) => entries.map((_, i) => Array.isArray(applied) && applied[i] === true), () => entries.map(() => false));
}

// Removes the ends of sessions no longer needed (expiredEndedRecords) from
// both stores, each only while it still holds exactly what was read, so a
// session its page has started since is never removed with them: from the
// durable store first, and from localStorage once that is done, or where
// the durable store had nothing.
function sweepEnded(storage, expired) {
    const onDisk = expired.filter((record) => record.durable !== null);
    return swapDurable(storage, onDisk.map((record) => [record.key, record.durable, null])).then((applied) => {
        for (const record of expired) {
            const i = onDisk.indexOf(record);
            if ((i >= 0 && !applied[i]) || record.local === null) continue;
            if (safeGet(record.key, null, storage) === record.local) replaceLocalRecord(record.key, null, storage);
        }
    });
}

// How long after its boot pass a page looks once more at the markers whose
// pages were still open then. A page opened in the tab of a running session
// replaces that session's page, and a page Chrome prerendered is shown the
// moment it replaces it: its boot pass asks while the page it replaces is
// still being torn down and still holds its lock. That page is gone a moment
// later, its unload stop unconfirmed, and without a second look nothing
// would recover it until a session starts here or another page opens.
export const BOOT_RECHECK_MS = 3000;

// Crash recovery for one host page: its own marker, and the passes that
// recover the markers of pages that are gone.
//   note(hardware), clear()  the marker (createLiveSessionTracker)
//   atBoot()                 the pass a page runs when it is opened (app.js
//                            starts it through whenActivated): every marker
//                            whose page is gone, the stops still owed, and
//                            the key saved here; and bootRecheckMs later,
//                            once more for the markers only
//   (a session start)        the first note() of each session runs a pass of
//                            its own over the markers whose pages are gone,
//                            and only those
//   sessionResumed()         the same pass, for a session of this page that
//                            resumes: RESUME after a pause, the pulse coming
//                            back, a controller's RUNNING
// A page that was open when another one died never boots again, and the
// wearer may carry on in it: without the pass at a session start, the dead
// page's Handy would keep moving for as long as the new session runs, and
// be stopped only by the next page to open. A session paused here while
// another tab drove a Handy and died is no different: resumed without a
// pass, it ran on next to that Handy, and not even its STOP stopped it
// unless it had a link to it. Each pass's report goes under
// the reports the page already shows, never over them: they keep changing
// for minutes, and each is about another Handy. `onReport(text, { fresh })`
// is given every report that is not over, in that order: `fresh` when the
// change is news that a Handy may still be moving - a pass's first word, or
// an answer that settles nothing - and not when a stop settled, which only
// rewords it. A report is over once every stop it reports is settled and a
// session of this page then starts or resumes (carryOn): the wearer has
// carried on from it, and nothing it names may still be moving. One that
// still has a stop out, or one that gave up, stays through the session.
// When none is left, the text is ''. `savedHandyKey()` and
// `liveHandyKey()` (this page's own connected Handy) are read when a pass
// starts, and so are `savedVacuglideToken()` and `liveVacuglideToken()`;
// `stopVacuglide` sends a VacuGlide its whole stop (stopVacuglideAfterCrash),
// and holdVacuglideLink(token) holds, for as long as this page has that
// VacuGlide connected ('' lets go), the lock that keeps every other page's
// recovery from sending it anything. `storage` is createCrashRecoveryStorage()'s, and with it
//   waitingForDisk()         which toys the session must not command yet
//                            (createLiveSessionTracker), and `onDurable()`
//                            is told whenever that may have changed
// The passes that send the stops still owed (the boot pass, and the one a
// late durable read brings) also remove from both stores the ends of
// sessions they no longer need. `now()` is the clock the ends are stamped
// with.
export function createCrashRecovery({
    owner,
    storage,
    locks,
    savedHandyKey = () => '',
    liveHandyKey = () => '',
    stopHandy,
    savedVacuglideToken = () => '',
    liveVacuglideToken = () => '',
    stopVacuglide,
    vacuglideRetryMinutes = 5,
    onReport,
    onDurable,
    retryMinutes = 5,
    ownerQueryTimeoutMs = OWNER_QUERY_TIMEOUT_MS,
    readTimeoutMs = DURABLE_READ_TIMEOUT_MS,
    bootRecheckMs = BOOT_RECHECK_MS,
    now = Date.now
} = {}) {
    const claimed = new Set();
    const sentOwed = new Set();
    // One report per pass, in the order the passes first reported: { text,
    // open, over } (see carryOn).
    const reports = [];
    // What the banner shows: every report not over yet, in order, and ''
    // once none is left. `fresh` as runCrashRecovery says it.
    function emit(fresh) {
        if (typeof onReport !== 'function') return;
        const text = reports.filter((r) => !r.over && r.text).map((r) => r.text).join(' ');
        try { onReport(text, { fresh }); } catch (e) {}
    }
    // A session of this page starts or resumes: the wearer carries on with
    // every report standing now in view. What a report is about is over once
    // no Handy it names may still be moving - every stop it reports is
    // settled - and the wearer has carried on from it: so a report that is
    // settled now leaves. One with a stop still being sent, or one that gave
    // up, stays through the session: that Handy may still be moving. When its
    // last stop settles it says so in place, and the next session that
    // starts or resumes ends it.
    function carryOn() {
        let ended = false;
        for (const r of reports) {
            if (r.over || r.open) continue;
            r.over = true;
            ended = true;
        }
        if (ended) emit(false);
    }
    // A key that cannot be read is no key: the pass still runs without it.
    const read = (get) => {
        try {
            return typeof get === 'function' ? get() : get;
        } catch (e) {
            return '';
        }
    };
    // `earlier`: the stops still owed are sent too (the boot pass alone).
    // `otherPage`: the markers are of pages that died while this one was
    // open, which only a session start can tell. `only`, `onOpen`,
    // `snapshot` and `onLate` as in runCrashRecovery.
    function recover({ earlier, otherPage, only = null, onOpen = null, snapshot = undefined, onLate = null }) {
        let slot = null;
        return runCrashRecovery({
            storage,
            locks,
            owner: tracker.owner,
            claimed,
            earlier,
            otherPage,
            only,
            onOpen,
            snapshot,
            onLate,
            sentOwed,
            sweep: earlier === true,
            now,
            savedHandyKey: read(savedHandyKey),
            liveHandyKey: read(liveHandyKey),
            stopHandy,
            savedVacuglideToken: read(savedVacuglideToken),
            liveVacuglideToken: read(liveVacuglideToken),
            stopVacuglide,
            vacuglideRetryMinutes,
            retryMinutes,
            ownerQueryTimeoutMs,
            readTimeoutMs,
            onReport: (text, { fresh = true, open = true } = {}) => {
                if (!slot) {
                    slot = { text: '', open: true, over: false };
                    reports.push(slot);
                }
                // A report that is over has had its last word: every stop
                // in it had settled, and a settled stop answers no more.
                if (slot.over) return;
                slot.text = text || '';
                slot.open = open !== false;
                emit(fresh !== false);
            }
        }).catch(() => ({ recovered: false }));
    }
    const tracker = createLiveSessionTracker({
        owner,
        storage,
        locks,
        onDurable,
        now,
        onSessionStart: () => {
            carryOn();
            recover({ earlier: false, otherPage: true });
        }
    });
    // The second look is at the markers whose pages were open at boot, and
    // no others: without a lock manager every marker already counted as a
    // crash at boot, and one written since is a page's that is running now.
    // A bootRecheckMs that is not a number leaves it out.
    // A durable store that answers only after the boot pass stopped waiting
    // for it is still read: the markers and stops only it knows - those
    // localStorage lost with a killed browser - get a pass of their own.
    function atBoot() {
        const onOpen = (keys) => {
            if (keys.length === 0 || typeof bootRecheckMs !== 'number' || !Number.isFinite(bootRecheckMs)) return;
            const only = new Set(keys);
            const timer = setTimeout(() => { recover({ earlier: false, otherPage: false, only }); }, bootRecheckMs);
            // Never what keeps a process (a test run) alive.
            if (timer && typeof timer.unref === 'function') timer.unref();
        };
        const onLate = (snapshot) => { recover({ earlier: true, otherPage: false, snapshot }); };
        return recover({ earlier: true, otherPage: false, onOpen, onLate });
    }
    function sessionResumed() {
        carryOn();
        return recover({ earlier: false, otherPage: true });
    }
    return {
        owner: tracker.owner,
        note: tracker.note,
        clear: tracker.clear,
        waitingForDisk: tracker.waitingForDisk,
        holdVacuglideLink: tracker.holdVacuglideLink,
        atBoot,
        sessionResumed
    };
}
