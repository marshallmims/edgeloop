// The durable copy of the crash-recovery records (crash-recovery.js): what
// the next page to open has to find even when the whole browser was killed.
//
// A page keeps a marker in localStorage while its session drives hardware,
// and the stops still owed after a crash. localStorage survives a crashed
// tab, because the browser process holds every change, but not a browser
// that is force-quit or killed by the phone. Chromium writes localStorage to
// disk only when a commit timer fires: no sooner than 5 s after the first
// change since the last commit, and no more than 60 commits and 10 MiB of
// changed data an hour, counted from when the origin's storage was opened
// (components/services/storage/dom_storage/local_storage_impl.cc,
// kCommitDefaultDelaySecs, kMaxCommitsPerHour and kMaxBytesPerHour;
// storage_area_impl.cc, ComputeCommitDelay takes the largest of the three).
// Every MiB committed spends six minutes of that budget, and every STOP
// rewrites EdgeLoop's session history, which can be several MiB: the next
// commit can come tens of minutes late. And a commit writes what the storage
// holds at that moment, in one batch with every other origin's pending
// changes, at whatever moment any origin's timer fires
// (async_dom_storage_database.cc, InitiateCommit collects every area's
// batch): what a killed browser leaves on disk is the storage as it was at
// some past instant, and no page can tell which. After an ordinary setting
// change in the minute before START, a force-quit up to a minute into the
// session lost the marker, and the next open sent The Handy nothing while it
// kept stroking. A force-quit within a minute of a clean STOP kept the
// marker STOP had removed, and the next open reported a crash that had not
// happened.
//
// IndexedDB fires 'complete' only once a transaction has committed, and with
// durability 'strict' the spec lets the browser call it committed "only
// after verifying that all outstanding changes have been successfully
// written to a persistent storage medium". Chromium syncs such a commit to
// disk before it reports it (the LevelDB backend's ShouldSyncOnCommit, the
// SQLite backend's PRAGMA synchronous=FULL), so a committed record outlives
// a killed browser and a power cut alike. 'relaxed', Chromium's default
// since Chrome 121, only reaches the operating system's buffers.
//
// So every change to a crash-recovery record goes to both. It goes to
// localStorage at once, where the page and every other tab read it
// synchronously as before. It goes to IndexedDB in one strict transaction per
// batch, in the order the changes were made (createDurableMirror). The
// mirror knows which change has reached the disk, which is what lets a page
// hold the first command of a session until its marker has
// (crash-recovery.js, waitingForDisk). Which of the two copies is the newer
// one is never read from anything kept beside a record, such as a flag
// written once IndexedDB failed: localStorage can reach the disk with the
// record and without the flag. Each record carries its own order instead (a
// generation, a version), and a removal is kept as a record of its own, in
// both stores (retire, and crash-recovery.js), so that no copy is ever taken
// for removed merely because the other store does not have it.
//
// Nor is a copy ever taken for lost merely because localStorage does not
// have it. A transaction is made at once but runs only after every
// transaction already queued on the store, and Chromium rolls back every
// transaction of a page that goes away before it has committed (the page's
// connection is destroyed: ~Connection, AbortTransactionsAndClose). A
// reload or a closed tab takes such a transaction with it, and loses
// nothing it wrote to localStorage, which the browser process holds. With a
// STOP written to localStorage only as a removal, the next page found the
// marker on disk and not in localStorage - what a killed browser leaves -
// and reported a crash that had not happened, after a clean STOP and a
// reload while another page had the store busy.
//
// No DOM: the IndexedDB factory and the storage are handed in, so all of it
// runs under node:test.

export const DURABLE_DB_NAME = 'edgeloop-crash-recovery';
export const DURABLE_DB_STORE = 'records';

// How long a change may take to reach the disk before it counts as failed.
// The first command of a session waits for its marker, so this bounds that
// wait when IndexedDB hangs. A healthy commit takes milliseconds.
export const DURABLE_WRITE_TIMEOUT_MS = 1000;

// How long a recovery pass waits for the durable records before it goes on
// with localStorage alone.
export const DURABLE_READ_TIMEOUT_MS = 2000;

const STRICT = Object.freeze({ durability: 'strict' });

// Never what keeps a process (a test run) alive.
function unref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

// The IndexedDB database: one object store of text records, each under the
// localStorage key it copies. Returns null when the browser has no IndexedDB.
//   write(changes)  [[key, text or null], ...] in one readwrite transaction
//                   with durability 'strict'; null removes the key. Resolves
//                   true once it has committed, false when it has not. Never
//                   rejects.
//   swap(entries)   [[key, expected, next], ...] in one readwrite transaction
//                   with durability 'strict': each record is set to `next`
//                   (null removes it) only if it still holds exactly
//                   `expected`. Resolves one boolean per entry, whether it
//                   was applied; all false when the transaction did not
//                   commit. Never rejects. Readwrite transactions on one
//                   store run one at a time, in the order they were made, so
//                   no other page's write can land between the read and the
//                   write of an entry.
//   readAll()       every record, as a Map, from one transaction; null when
//                   the store cannot be read. Never rejects.
export function openDurableStore({ indexedDB: factory = globalThis.indexedDB, name = DURABLE_DB_NAME } = {}) {
    if (!factory || typeof factory.open !== 'function') return null;
    let connecting = null;
    let current = null;

    // A connection the browser closes (site data cleared) or that a newer
    // version asks to close is dropped, and the next call opens a new one.
    function drop(db) {
        if (current !== db) return;
        current = null;
        connecting = null;
    }

    function connect() {
        if (connecting) return connecting;
        const attempt = new Promise((resolve) => {
            let request;
            try {
                request = factory.open(name, 1);
            } catch (e) {
                // An opaque origin, or site data blocked for this site.
                resolve(null);
                return;
            }
            request.onupgradeneeded = () => {
                try {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(DURABLE_DB_STORE)) db.createObjectStore(DURABLE_DB_STORE);
                } catch (e) {
                    // The open then fails, and resolves null below.
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                current = db;
                db.onversionchange = () => {
                    drop(db);
                    try { db.close(); } catch (e) {}
                };
                db.onclose = () => drop(db);
                resolve(db);
            };
            request.onerror = () => resolve(null);
        });
        connecting = attempt;
        // An open that failed is tried again by the next call.
        attempt.then((db) => {
            if (!db && connecting === attempt) connecting = null;
        });
        return attempt;
    }

    // A connection the browser is closing throws: it is dropped, and the
    // caller opens a new one.
    function begin(db, mode, options) {
        try {
            return options ? db.transaction(DURABLE_DB_STORE, mode, options) : db.transaction(DURABLE_DB_STORE, mode);
        } catch (e) {
            drop(db);
            return null;
        }
    }

    async function openTransaction(mode, options, attempts = 2) {
        // Twice at most, counting a try made at once by write(): a new
        // connection is opened once.
        for (let tries = 0; tries < attempts; tries++) {
            const db = await connect();
            if (!db) return null;
            const tx = begin(db, mode, options);
            if (tx) return tx;
        }
        return null;
    }

    // With a connection open, the transaction is made at once, so a write
    // asked for in the middle of a task starts committing then, not once the
    // task is over: the first command of a session waits for this commit and
    // for nothing else. Transactions are still made in the order they were
    // asked for: the ones that wait for the connection make theirs, in
    // order, in the microtasks that run as soon as it opens, before any other
    // code can ask for another.
    function readwrite(run, failed) {
        let attempts = 2;
        if (current) {
            const tx = begin(current, 'readwrite', STRICT);
            if (tx) return run(tx);
            attempts = 1;
        }
        return openTransaction('readwrite', STRICT, attempts).then((later) => (later ? run(later) : failed()), failed);
    }

    function write(changes) {
        return readwrite((tx) => apply(tx, changes), () => false);
    }

    function apply(tx, changes) {
        return new Promise((resolve) => {
            tx.oncomplete = () => resolve(true);
            tx.onabort = () => resolve(false);
            try {
                const store = tx.objectStore(DURABLE_DB_STORE);
                for (const [key, value] of changes) {
                    if (value === null) store.delete(key);
                    else store.put(value, key);
                }
                // Asked to commit now, not once this page has run the
                // requests' success events: a page frozen right after this
                // task runs none of them until it is resumed.
                if (typeof tx.commit === 'function') tx.commit();
            } catch (e) {
                try { tx.abort(); } catch (err) {}
                resolve(false);
            }
        });
    }

    function swap(entries) {
        const list = Array.isArray(entries) ? entries : [];
        const none = () => list.map(() => false);
        if (list.length === 0) return Promise.resolve([]);
        const run = (tx) => new Promise((resolve) => {
            const applied = none();
            tx.oncomplete = () => resolve(applied);
            tx.onabort = () => resolve(none());
            try {
                const store = tx.objectStore(DURABLE_DB_STORE);
                list.forEach(([key, expected, next], i) => {
                    const request = store.get(key);
                    // The write is made from the read's success event, so
                    // the transaction commits once no request is left: an
                    // explicit commit() would close it to that write.
                    request.onsuccess = () => {
                        if (request.result !== expected) return;
                        try {
                            if (next === null) store.delete(key);
                            else store.put(next, key);
                            applied[i] = true;
                        } catch (e) {
                            try { tx.abort(); } catch (err) {}
                        }
                    };
                });
            } catch (e) {
                try { tx.abort(); } catch (err) {}
                resolve(none());
            }
        });
        return readwrite(run, none);
    }

    async function readAll() {
        const tx = await openTransaction('readonly');
        if (!tx) return null;
        return new Promise((resolve) => {
            let keys = null;
            let values = null;
            tx.oncomplete = () => {
                const records = new Map();
                const k = keys && Array.isArray(keys.result) ? keys.result : [];
                const v = values && Array.isArray(values.result) ? values.result : [];
                // Only text is ever written here; anything else is not a record.
                k.forEach((key, i) => {
                    if (typeof key === 'string' && typeof v[i] === 'string') records.set(key, v[i]);
                });
                resolve(records);
            };
            tx.onabort = () => resolve(null);
            try {
                const store = tx.objectStore(DURABLE_DB_STORE);
                keys = store.getAllKeys();
                values = store.getAll();
            } catch (e) {
                try { tx.abort(); } catch (err) {}
                resolve(null);
            }
        });
    }

    return { write, swap, readAll };
}

// A Storage for the crash-recovery records, which storage.js's safe* helpers
// take like localStorage. It reads and writes localStorage at once, as
// before, and sends each change of a record to the durable store as well.
//   local        localStorage (null: none, and every write throws)
//   durable      openDurableStore(), or null: then this is localStorage alone
//   project      (key, text) -> what the durable store keeps of a record;
//                all of it unless told otherwise. A change of what it leaves
//                out is then no disk write
//   timeoutMs    how long a change may take to reach the disk before it
//                counts as failed
//   readFirst    send nothing until a read() has answered (see below)
//   onAttach(snapshot)
//                told, with readFirst, the first records read, before
//                anything this page held back is sent: the reader merges
//                what the page wrote meanwhile with what the disk kept
// Beyond the Storage methods:
//   retire(key, value)  puts `value`, a record that says the one it replaces
//                       is over, in the record's place in both stores (null
//                       removes it from both). Not a removal from
//                       localStorage: a page that goes away takes its
//                       transaction with it when that has not run yet, and
//                       the next page must still find, in localStorage, what
//                       it would have written. A localStorage that refuses
//                       it has the record removed instead. Without a durable
//                       store there is nothing for the two to disagree about,
//                       and the record is removed, as before there was one
//   replaceLocal(key, value)
//                       puts `value` in the record's place in localStorage
//                       alone, leaving the durable store as it is (null
//                       removes it)
//   swap(entries)       the durable store's swap(), made after every change
//                       made so far; all false while nothing can be sent
//   state(key)          what became of this page's last change of `key`, or
//                       null for a key it has not changed:
//                       { status, committed, settled }. `status` is
//                       'pending', 'ok' or 'failed' (a change not on disk
//                       within timeoutMs counts as failed until a late commit
//                       says otherwise). `committed` is the newest value
//                       known to be on disk, and `settled` the value of the
//                       newest change whose wait is over - it committed,
//                       failed or timed out - whether or not a newer change
//                       is still pending. Both are null once a retire() has
//                       been made since, or while there is none
//   flush()             sends the changes made so far at once, instead of once
//                       the code running now has finished
//   settled()           resolves once every change sent so far has committed,
//                       failed or timed out
//   subscribe(fn)       fn() whenever a change commits, fails or times out;
//                       returns the unsubscribe function
//   read({ timeoutMs, onLate })
//                       the durable records, { records: Map, seq }, read once
//                       this page's changes sent so far have settled; null
//                       when the store cannot be read in time. `onLate(snapshot)`
//                       is told when a read that timed out answers after all
//   changedSince(key, seq)
//                       whether this page has changed `key` since the snapshot
//                       stamped `seq`, or its last change of it has not reached
//                       the disk: localStorage is then the newer copy
// A change is sent only when what the durable store keeps of the record
// changes. A change the browser refused to localStorage still goes to the
// durable store, and once: localStorage full of session history must neither
// lose the marker nor put a disk write on every engine tick.
// With `readFirst`, a page sends the durable store nothing before it has
// read it once. After a force-quit, the durable store can hold what
// localStorage lost - a stop still owed that was handed over in the minute
// before - and a record written from localStorage's copy before that read
// would overwrite it: the stop, owed to a Handy that may be moving, would be
// gone. The changes made meanwhile are held. The first read that answers,
// however late, hands its records to onAttach and then sends them; a read
// that fails or does not answer leaves them held, and the next read tries
// again. A held change counts as failed once timeoutMs has passed, like a
// commit that does not come, so that nothing waits on a read for longer -
// and at once when a read finds that the store cannot be read at all (it
// cannot be opened, or its transaction aborts), as does every change made
// until a read answers: nothing held can reach the store then. With
// IndexedDB blocked or broken, the first command of every session waited a
// full timeout for a commit that could not come.
export function createDurableMirror({
    local,
    durable = null,
    project = (key, text) => text,
    timeoutMs = DURABLE_WRITE_TIMEOUT_MS,
    readFirst = false,
    onAttach = null
} = {}) {
    // Where changes go: 'attached' to the durable store; 'unread' nowhere
    // yet, held until a read answers; 'none' without a durable store.
    let phase = !durable ? 'none' : readFirst ? 'unread' : 'attached';
    // By key: { sent, seq, status, committed, committedSeq, settled,
    // settledSeq, removedSeq } for the last change queued, what became of
    // it, what is known to be on disk, the newest change whose wait is over,
    // and when the last retire() was made.
    const records = new Map();
    const listeners = new Set();
    let batch = null;
    let seq = 0;
    let inFlight = Promise.resolve();
    // Set while nothing has been read and the last read found that the
    // durable store cannot be read at all: what is held back for it cannot
    // reach it now.
    let unreadable = false;

    function notify() {
        for (const listener of Array.from(listeners)) {
            try { listener(); } catch (e) {}
        }
    }

    const readLocal = (key) => {
        try {
            const value = local ? local.getItem(key) : null;
            return value === undefined ? null : value;
        } catch (e) {
            return null;
        }
    };

    // The wait for the change `changeSeq` of a record is over: it committed,
    // failed or timed out. Returns whether that made it the newest such
    // change.
    function settledChange(record, value, changeSeq) {
        if (changeSeq <= record.settledSeq) return false;
        record.settled = value;
        record.settledSeq = changeSeq;
        return true;
    }

    function settle(key, change, ok) {
        const record = records.get(key);
        if (!record) return;
        // One page's transactions commit in the order they were made, so the
        // change that committed last is what the disk holds.
        if (ok) {
            record.committed = change.value;
            record.committedSeq = change.seq;
        }
        settledChange(record, change.value, change.seq);
        // A newer change of the record decides its status once it settles.
        if (record.seq !== change.seq) return;
        record.status = ok ? 'ok' : 'failed';
    }

    function flush() {
        // Held until a read has answered.
        if (phase !== 'attached' || !batch) return;
        const changes = batch;
        batch = null;
        if (changes.size === 0) return;
        const list = Array.from(changes, ([key, change]) => ({ key, value: change.value, seq: change.seq }));
        let writing;
        try {
            writing = Promise.resolve(durable.write(list.map((change) => [change.key, change.value])));
        } catch (e) {
            writing = Promise.resolve(false);
        }
        const done = writing
            .catch(() => false)
            .then((ok) => {
                for (const change of list) settle(change.key, change, ok === true);
                notify();
            });
        // settled() waits for a commit no longer than the timeout: a hung
        // IndexedDB must not keep a page's lock, or a read, forever.
        const bounded = Promise.race([done, new Promise((resolve) => { unref(setTimeout(resolve, timeoutMs)); })]);
        inFlight = Promise.all([inFlight, bounded]).then(() => {});
    }

    // Every change made in one run of code goes into one transaction, so a
    // crash stop handed over and its marker retired reach the disk together
    // or not at all. flush() sends them sooner.
    function queue(key, value, retiring = false) {
        seq += 1;
        const record = records.get(key) || { sent: undefined, seq: 0, status: 'ok', committed: null, committedSeq: 0, settled: null, settledSeq: 0, removedSeq: 0 };
        record.sent = value;
        record.seq = seq;
        record.status = 'pending';
        if (retiring) record.removedSeq = seq;
        records.set(key, record);
        // Slower than a healthy disk ever is, or held by a read that has not
        // answered: counts as failed, and a late commit still counts when it
        // comes. Each change's wait ends at its own timeout, even with a
        // newer change of the record still pending: what waits on this one
        // must not wait on the next one too.
        const mine = seq;
        unref(setTimeout(() => {
            const latest = records.get(key);
            if (!latest) return;
            let changed = settledChange(latest, value, mine);
            if (latest.seq === mine && latest.status === 'pending') {
                latest.status = 'failed';
                changed = true;
            }
            if (changed) notify();
        }, timeoutMs));
        if (!batch) {
            batch = new Map();
            queueMicrotask(flush);
        }
        batch.set(key, { value, seq });
        // Held for a store known to be unreadable: failed at once, and sent
        // if a later read answers. Whoever made the change reads its state
        // next; nobody else can be waiting on it yet.
        if (phase === 'unread' && unreadable) {
            settledChange(record, value, seq);
            record.status = 'failed';
        }
    }

    // A read found that the durable store cannot be read at all: every
    // change held for it counts as failed now, rather than once its timeout
    // has passed. They stay held, and go out if a later read answers.
    function failHeld() {
        let changed = false;
        for (const [key, change] of batch || []) {
            const record = records.get(key);
            if (!record) continue;
            if (settledChange(record, change.value, change.seq)) changed = true;
            if (record.seq === change.seq && record.status === 'pending') {
                record.status = 'failed';
                changed = true;
            }
        }
        if (changed) notify();
    }

    // The first read has answered: the reader merges what this page wrote
    // meanwhile with what was read, and then what was held goes out, in one
    // transaction with the merge.
    function attach(snapshot) {
        if (phase !== 'unread') return;
        phase = 'attached';
        if (typeof onAttach === 'function') {
            try { onAttach(snapshot); } catch (e) {}
        }
        flush();
    }

    const mirror = {
        get length() {
            return local ? local.length : 0;
        },
        key(index) {
            return local ? local.key(index) : null;
        },
        getItem(key) {
            return local ? local.getItem(key) : null;
        },
        setItem(key, value) {
            const text = String(value);
            if (phase !== 'none') {
                const record = records.get(key);
                const kept = project(key, text);
                if (!record || record.sent !== kept) queue(key, kept);
            }
            if (!local) throw new Error('localStorage is unavailable');
            local.setItem(key, text);
        },
        removeItem(key) {
            if (phase !== 'none') {
                const record = records.get(key);
                // Sent unless this page has already removed it from the
                // durable store: another page's copy may be there.
                if (!record || record.sent !== null || record.status === 'failed' || readLocal(key) !== null) queue(key, null, true);
            }
            if (local) local.removeItem(key);
        },
        retire(key, value = null) {
            if (phase !== 'none') {
                const record = records.get(key);
                // Sent unless the durable store already has it from this
                // page: a failed one is tried again.
                if (!record || record.sent !== value || record.status === 'failed') queue(key, value, true);
            }
            if (!local) return;
            if (value !== null && phase !== 'none') {
                try {
                    local.setItem(key, value);
                    return;
                } catch (e) {
                    // Refused: removed instead, below. A localStorage that
                    // kept what it replaces would tell the next page that
                    // the record is not over.
                }
            }
            local.removeItem(key);
        },
        replaceLocal(key, value = null) {
            if (!local) return;
            if (value === null) local.removeItem(key);
            else local.setItem(key, value);
        },
        swap(entries) {
            const list = Array.isArray(entries) ? entries : [];
            const none = () => list.map(() => false);
            if (phase !== 'attached' || list.length === 0 || typeof durable.swap !== 'function') return Promise.resolve(none());
            // Its transaction comes after the one of every change made so far.
            flush();
            let result;
            try {
                result = Promise.resolve(durable.swap(list));
            } catch (e) {
                result = Promise.resolve(none());
            }
            return result.then((applied) => (Array.isArray(applied) ? list.map((_, i) => applied[i] === true) : none()), none);
        },
        state(key) {
            const record = records.get(key);
            if (!record) return null;
            return {
                status: record.status,
                committed: record.committedSeq > record.removedSeq ? record.committed : null,
                settled: record.settledSeq > record.removedSeq ? record.settled : null
            };
        },
        // Sends the changes made so far now, rather than once the code
        // running now has finished: a marker that names a toy about to be
        // held back is on its way to disk at once.
        flush() {
            flush();
        },
        settled() {
            // After the batch this task may still be filling.
            return Promise.resolve().then(() => inFlight);
        },
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        read({ timeoutMs: limit = DURABLE_READ_TIMEOUT_MS, onLate = null } = {}) {
            if (!durable) return Promise.resolve(null);
            const stamp = seq;
            const reading = mirror.settled()
                .then(() => durable.readAll())
                .then((found) => (found instanceof Map ? { records: found, seq: stamp } : null), () => null)
                .then((snapshot) => {
                    if (snapshot) {
                        unreadable = false;
                        attach(snapshot);
                    } else if (phase === 'unread') {
                        unreadable = true;
                        failHeld();
                    }
                    return snapshot;
                });
            let late = false;
            let timer = null;
            const gaveUp = new Promise((resolve) => {
                timer = unref(setTimeout(() => {
                    late = true;
                    resolve(null);
                }, limit));
            });
            reading.then((snapshot) => {
                clearTimeout(timer);
                if (late && snapshot && typeof onLate === 'function') {
                    try { onLate(snapshot); } catch (e) {}
                }
            });
            return Promise.race([reading, gaveUp]);
        },
        changedSince(key, stamp) {
            const record = records.get(key);
            // So has a change that did not reach the disk: the snapshot may
            // still hold what it replaced.
            return Boolean(record) && (record.seq > stamp || record.status !== 'ok');
        }
    };
    return mirror;
}
