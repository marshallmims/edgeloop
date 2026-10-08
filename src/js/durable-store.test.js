// The durable copy of the crash-recovery records. openDurableStore runs
// against a fake IndexedDB that behaves like the real one where it matters
// here: readwrite transactions run one at a time and commit in the order
// they were made, a request's success event can make more requests in the
// same transaction, a transaction can abort, a connection can be closing.
// The mirror runs against a fake durable store whose commits the tests hand
// out one at a time. The crash-recovery flows on top of both are in
// crash-recovery.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DURABLE_DB_STORE,
    DURABLE_WRITE_TIMEOUT_MS,
    openDurableStore,
    createDurableMirror
} from './durable-store.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// The mirror's timers are unref'd, so they never keep a node:test process
// alive by themselves: wait on a timer of our own.
async function alive(promise) {
    const keep = setInterval(() => {}, 5);
    try {
        return await promise;
    } finally {
        clearInterval(keep);
    }
}

// Just enough of indexedDB for openDurableStore. Transactions settle one at
// a time, in the order they were made, like readwrite transactions on one
// object store do. Each runs its requests in order against what the ones
// before it committed, and a request made from a success event joins the
// same transaction; `disk` is what a committed transaction has written.
function fakeIndexedDB({ disk = new Map() } = {}) {
    const f = { disk, opens: 0, created: false, stores: new Set(), transactions: [], failOpen: false, throwOnOpen: false, abortWrites: false, closingTransactions: 0, dbs: [] };
    let chain = Promise.resolve();
    f.open = (name, version) => {
        if (f.throwOnOpen) {
            const err = new Error('The operation is insecure.');
            err.name = 'SecurityError';
            throw err;
        }
        f.opens += 1;
        const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        setTimeout(() => {
            if (f.failOpen) {
                request.error = new Error('UnknownError');
                if (request.onerror) request.onerror();
                return;
            }
            const db = {
                name,
                version,
                closed: false,
                onversionchange: null,
                onclose: null,
                objectStoreNames: { contains: (store) => f.stores.has(store) },
                createObjectStore: (store) => { f.stores.add(store); return {}; },
                close() { db.closed = true; },
                transaction(store, mode, options) {
                    if (f.closingTransactions > 0) {
                        f.closingTransactions -= 1;
                        const err = new Error('The database connection is closing.');
                        err.name = 'InvalidStateError';
                        throw err;
                    }
                    if (!f.stores.has(store)) {
                        const err = new Error('One of the specified object stores was not found.');
                        err.name = 'NotFoundError';
                        throw err;
                    }
                    const tx = { db, mode, durability: options ? options.durability : undefined, ops: [], requests: [], explicitCommit: false, aborted: false, oncomplete: null, onabort: null };
                    const request = (run) => {
                        if (tx.explicitCommit && tx.started) {
                            const err = new Error('The transaction has finished.');
                            err.name = 'TransactionInactiveError';
                            throw err;
                        }
                        const r = { result: undefined, onsuccess: null };
                        tx.requests.push({ r, run });
                        return r;
                    };
                    tx.objectStore = () => ({
                        put: (value, key) => { tx.ops.push({ key, value }); return request((work) => { work.set(key, value); return key; }); },
                        delete: (key) => { tx.ops.push({ key, value: null }); return request((work) => { work.delete(key); }); },
                        get: (key) => request((work) => work.get(key)),
                        getAllKeys: () => request((work) => Array.from(work.keys()).sort()),
                        getAll: () => request((work) => Array.from(work.keys()).sort().map((k) => work.get(k)))
                    });
                    tx.commit = () => { tx.explicitCommit = true; };
                    tx.abort = () => { tx.aborted = true; };
                    f.transactions.push(tx);
                    chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
                        tx.started = true;
                        if (tx.aborted || (mode === 'readwrite' && f.abortWrites)) {
                            if (tx.onabort) tx.onabort();
                            resolve();
                            return;
                        }
                        const work = new Map(f.disk);
                        // Requests made from a success event are run too.
                        for (let i = 0; i < tx.requests.length && !tx.aborted; i++) {
                            const { r, run } = tx.requests[i];
                            r.result = run(work);
                            if (r.onsuccess) r.onsuccess();
                        }
                        if (tx.aborted) {
                            if (tx.onabort) tx.onabort();
                            resolve();
                            return;
                        }
                        f.disk.clear();
                        for (const [k, v] of work) f.disk.set(k, v);
                        if (tx.oncomplete) tx.oncomplete();
                        resolve();
                    }, 0)));
                    return tx;
                }
            };
            f.dbs.push(db);
            request.result = db;
            if (!f.created) {
                f.created = true;
                if (request.onupgradeneeded) request.onupgradeneeded();
            }
            if (request.onsuccess) request.onsuccess();
        }, 0);
        return request;
    };
    return f;
}

describe('openDurableStore', () => {
    it('is no store at all without IndexedDB', () => {
        assert.equal(openDurableStore({ indexedDB: undefined }), null);
        assert.equal(openDurableStore({ indexedDB: {} }), null);
    });

    it('writes a batch in one transaction with durability strict, asked to commit at once, and reads every record back', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        assert.equal(await store.write([['a', '1'], ['b', '2']]), true);
        assert.equal(idb.transactions.length, 1);
        const [tx] = idb.transactions;
        assert.equal(tx.mode, 'readwrite');
        assert.equal(tx.durability, 'strict');
        assert.equal(tx.explicitCommit, true);
        assert.deepEqual(tx.ops, [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
        assert.ok(idb.stores.has(DURABLE_DB_STORE), 'the object store is made on first open');
        assert.equal(await store.write([['a', null]]), true, 'null removes');
        assert.deepEqual(Array.from((await store.readAll()).entries()), [['b', '2']]);
        assert.equal(idb.opens, 1, 'one connection for all of it');
    });

    it('with a connection open, makes the transaction before write() returns, so it commits while the task goes on', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        assert.equal(await store.write([['a', '1']]), true);
        const before = idb.transactions.length;
        const writing = store.write([['b', '2']]);
        assert.equal(idb.transactions.length, before + 1, 'made at once');
        assert.equal(idb.transactions.at(-1).explicitCommit, true, 'and asked to commit at once');
        assert.equal(await writing, true);
        // Writes asked for while the connection opens keep their order.
        const fresh = fakeIndexedDB();
        const other = openDurableStore({ indexedDB: fresh });
        const first = other.write([['k', 'one']]);
        const second = other.write([['k', 'two']]);
        assert.deepEqual([await first, await second], [true, true]);
        assert.equal(fresh.disk.get('k'), 'two');
    });

    it('a transaction the browser aborts is a write that failed', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        idb.abortWrites = true;
        assert.equal(await store.write([['a', '1']]), false);
        assert.equal(idb.disk.size, 0);
        idb.abortWrites = false;
        assert.equal(await store.write([['a', '1']]), true);
    });

    it('a store that cannot be opened can be neither written nor read, and is opened again by the next call', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        idb.failOpen = true;
        assert.equal(await store.write([['a', '1']]), false);
        assert.equal(await store.readAll(), null);
        idb.failOpen = false;
        assert.equal(await store.write([['a', '1']]), true);
        assert.equal(idb.disk.get('a'), '1');
        // An opaque origin, or site data blocked: open() itself throws.
        const blocked = fakeIndexedDB();
        blocked.throwOnOpen = true;
        const none = openDurableStore({ indexedDB: blocked });
        assert.equal(await none.write([['a', '1']]), false);
        assert.equal(await none.readAll(), null);
    });

    it('a connection the browser is closing is replaced once, not forever', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        assert.equal(await store.write([['a', '1']]), true);
        idb.closingTransactions = 1;
        assert.equal(await store.write([['b', '2']]), true);
        assert.equal(idb.opens, 2);
        idb.closingTransactions = 2;
        assert.equal(await store.write([['c', '3']]), false);
        assert.equal(idb.disk.has('c'), false);
    });

    it('a connection the browser closed, or that a newer version asked to close, is replaced by the next call', async () => {
        const idb = fakeIndexedDB();
        const store = openDurableStore({ indexedDB: idb });
        await store.write([['a', '1']]);
        idb.dbs[0].onclose();
        assert.equal(await store.write([['b', '2']]), true);
        assert.equal(idb.opens, 2);
        idb.dbs[1].onversionchange();
        assert.equal(idb.dbs[1].closed, true, 'it lets the newer version in');
        assert.equal(await store.write([['c', '3']]), true);
        assert.equal(idb.opens, 3);
    });

    it('reads only text records', async () => {
        const idb = fakeIndexedDB({ disk: new Map([['a', '1'], ['b', 2], ['c', { x: 1 }]]) });
        const store = openDurableStore({ indexedDB: idb });
        assert.deepEqual(Array.from((await store.readAll()).entries()), [['a', '1']]);
    });

    it('swap changes a record only while it still holds what the caller read, in one strict transaction', async () => {
        const idb = fakeIndexedDB({ disk: new Map([['ended', 'old end'], ['gone', 'old end'], ['kept', 'x']]) });
        const store = openDurableStore({ indexedDB: idb });
        const applied = await store.swap([
            ['ended', 'old end', 'new end'],
            ['gone', 'old end', null],
            ['kept', 'something else', null],
            ['missing', 'anything', 'y']
        ]);
        assert.deepEqual(applied, [true, true, false, false]);
        assert.deepEqual(Array.from(idb.disk.entries()).sort(), [['ended', 'new end'], ['kept', 'x']]);
        assert.equal(idb.transactions.length, 1);
        assert.equal(idb.transactions[0].mode, 'readwrite');
        assert.equal(idb.transactions[0].durability, 'strict');
        // Its writes are made from the reads' success events: a commit()
        // asked for before them would have closed the transaction to them.
        assert.equal(idb.transactions[0].explicitCommit, false);
        assert.deepEqual(await store.swap([]), []);
    });

    it('a swap made after a write reads what that write committed, whoever is quicker', async () => {
        const idb = fakeIndexedDB({ disk: new Map([['m', 'end of session 1']]) });
        const store = openDurableStore({ indexedDB: idb });
        await store.readAll();
        // A page starts its next session while another page sweeps the old
        // end away: the sweep must not remove the new marker.
        const writing = store.write([['m', 'marker of session 2']]);
        const sweeping = store.swap([['m', 'end of session 1', null]]);
        assert.equal(await writing, true);
        assert.deepEqual(await sweeping, [false]);
        assert.equal(idb.disk.get('m'), 'marker of session 2');
    });

    it('a swap the browser aborts applies nothing, and one that cannot open reports nothing applied', async () => {
        const idb = fakeIndexedDB({ disk: new Map([['m', 'a']]) });
        const store = openDurableStore({ indexedDB: idb });
        idb.abortWrites = true;
        assert.deepEqual(await store.swap([['m', 'a', null]]), [false]);
        assert.equal(idb.disk.get('m'), 'a');
        const blocked = fakeIndexedDB();
        blocked.throwOnOpen = true;
        assert.deepEqual(await openDurableStore({ indexedDB: blocked }).swap([['m', 'a', null]]), [false]);
    });
});

// A durable store whose writes commit, fail or hang as the test says, one
// transaction at a time and in order, the way IndexedDB commits them. In
// 'manual' mode a write waits for commit(); `disk` is what has committed.
function fakeDurable({ disk = new Map(), mode = 'ok' } = {}) {
    const d = { disk, mode, writes: [], waiting: [], readMode: 'ok', readDelayMs: 0 };
    let chain = Promise.resolve();
    d.write = (changes) => {
        const entry = { changes: changes.map(([key, value]) => [key, value]), result: null };
        d.writes.push(entry);
        const commit = () => {
            for (const [key, value] of entry.changes) {
                if (value === null) d.disk.delete(key);
                else d.disk.set(key, value);
            }
            entry.result = true;
            return true;
        };
        const run = chain.then(() => new Promise((resolve) => {
            if (d.mode === 'fail') {
                entry.result = false;
                resolve(false);
            } else if (d.mode === 'hang') {
                d.waiting.push(() => resolve(commit()));
            } else if (d.mode === 'manual') {
                d.waiting.push(() => resolve(commit()));
            } else {
                setTimeout(() => resolve(commit()), 0);
            }
        }));
        chain = run;
        return run;
    };
    // Compare-and-set, queued with the writes like IndexedDB queues it.
    d.swaps = [];
    d.swap = (entries) => {
        const entry = { entries: entries.map((e) => e.slice()), result: null };
        d.swaps.push(entry);
        const apply = () => {
            entry.result = entries.map(([key, expected, next]) => {
                if (d.disk.get(key) !== expected) return false;
                if (next === null) d.disk.delete(key);
                else d.disk.set(key, next);
                return true;
            });
            return entry.result;
        };
        const run = chain.then(() => new Promise((resolve) => {
            if (d.mode === 'fail') resolve(entries.map(() => false));
            else if (d.mode === 'hang' || d.mode === 'manual') d.waiting.push(() => resolve(apply()));
            else setTimeout(() => resolve(apply()), 0);
        }));
        chain = run;
        return run;
    };
    // Commits the oldest write still waiting.
    d.commit = async () => {
        for (let i = 0; i < 50 && d.waiting.length === 0; i++) await tick(1);
        const next = d.waiting.shift();
        if (next) next();
        await tick(1);
    };
    d.readAll = () => {
        if (d.readMode === 'fail') return Promise.resolve(null);
        if (d.readMode === 'hang') return new Promise(() => {});
        return tick(d.readDelayMs).then(() => new Map(d.disk));
    };
    return d;
}

function fakeLocal() {
    const map = new Map();
    const store = {
        map,
        refuse: false,
        get length() { return map.size; },
        key: (i) => Array.from(map.keys())[i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => {
            if (store.refuse) {
                const err = new Error('QuotaExceededError');
                err.name = 'QuotaExceededError';
                throw err;
            }
            map.set(k, String(v));
        },
        removeItem: (k) => { map.delete(k); }
    };
    return store;
}

describe('createDurableMirror', () => {
    it('writes localStorage at once, and every change of one task to the durable store in one transaction, in order', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('a', '1');
        mirror.setItem('b', '2');
        mirror.removeItem('c');
        mirror.setItem('a', '3');
        assert.equal(local.getItem('a'), '3', 'localStorage at once');
        assert.equal(durable.writes.length, 0, 'the durable store once the task is over');
        await mirror.settled();
        assert.equal(durable.writes.length, 1);
        assert.deepEqual(durable.writes[0].changes, [['a', '3'], ['b', '2'], ['c', null]]);
        assert.deepEqual(Array.from(durable.disk.entries()), [['a', '3'], ['b', '2']]);
        // Storage as storage.js reads it.
        assert.equal(mirror.length, 2);
        assert.deepEqual([mirror.key(0), mirror.key(1)], ['a', 'b']);
        assert.equal(mirror.getItem('b'), '2');
    });

    it('knows which change is on disk: pending until it commits, and a removal made since leaves nothing named', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'manual' });
        const mirror = createDurableMirror({ local, durable });
        assert.equal(mirror.state('m'), null, 'a key this page never changed');
        mirror.setItem('m', 'one');
        assert.deepEqual(mirror.state('m'), { status: 'pending', committed: null, settled: null });
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'one', settled: 'one' });
        mirror.setItem('m', 'two');
        assert.deepEqual(mirror.state('m'), { status: 'pending', committed: 'one', settled: 'one' }, 'the older value is still on disk');
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'two', settled: 'two' });
        // STOP, then START at once: the removal comes first, so the old value
        // names nothing while the new one is on its way.
        mirror.retire('m', 'ended');
        mirror.setItem('m', 'three');
        assert.deepEqual(mirror.state('m'), { status: 'pending', committed: null, settled: null });
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'three', settled: 'three' });
        assert.equal(durable.writes.length, 3, 'removal and write of one task in one transaction');
    });

    it('a change whose wait is over is settled, whatever newer change is still pending: each waits for its own commit or timeout', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'hang' });
        const mirror = createDurableMirror({ local, durable, timeoutMs: 40 });
        // What each listener call saw, from inside the timer that called it:
        // the second change's timer was made after the first one's, so it
        // cannot have fired yet when the first one's does.
        const told = [];
        mirror.subscribe(() => told.push(mirror.state('m')));
        mirror.setItem('m', 'one');
        await tick(0);
        // A newer change, in a transaction of its own, before the first one
        // has answered.
        mirror.setItem('m', 'two');
        await alive(mirror.settled());
        assert.deepEqual(told, [
            { status: 'pending', committed: null, settled: 'one' },
            { status: 'failed', committed: null, settled: 'two' }
        ], 'the first one timed out on its own clock while the second was still waiting, and whoever waits was told each time');
        assert.equal(durable.writes.length, 2);
        // A late commit of both: nothing goes back.
        await durable.commit();
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'two', settled: 'two' });
        // And a removal made since leaves nothing settled either.
        mirror.retire('m', 'ended');
        await alive(mirror.settled());
        assert.equal(mirror.state('m').settled, null);
    });

    it('a change the durable store refused counts as failed until a later change of it commits, and nothing is written beside it', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'fail' });
        const mirror = createDurableMirror({ local, durable });
        const changes = [];
        mirror.subscribe(() => changes.push(mirror.state('m').status));
        mirror.setItem('m', 'one');
        await mirror.settled();
        assert.deepEqual(mirror.state('m'), { status: 'failed', committed: null, settled: 'one' });
        // No flag: localStorage can write a record to disk without anything
        // written after it, so a flag could never be relied on.
        assert.deepEqual(Array.from(local.map.keys()), ['m']);
        durable.mode = 'ok';
        mirror.setItem('m', 'two');
        await mirror.settled();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'two', settled: 'two' });
        assert.deepEqual(changes, ['failed', 'ok'], 'told of each');
    });

    it('a change slower than the timeout counts as failed, and its late commit still counts', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'hang' });
        const mirror = createDurableMirror({ local, durable, timeoutMs: 30 });
        let told = 0;
        mirror.subscribe(() => { told += 1; });
        mirror.setItem('m', 'one');
        const start = Date.now();
        await alive(mirror.settled());
        assert.ok(Date.now() - start >= 25, 'settled only at the timeout');
        assert.equal(mirror.state('m').status, 'failed');
        assert.equal(told, 1, 'told at the timeout');
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'one', settled: 'one' });
        assert.equal(told, 2, 'and when the late commit lands');
        assert.ok(DURABLE_WRITE_TIMEOUT_MS >= 250 && DURABLE_WRITE_TIMEOUT_MS <= 2000, 'long enough for a slow disk, short enough to start a session');
    });

    it('retire() puts another text in the record\'s place in both stores', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'manual' });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('m', 'marker');
        await durable.commit();
        mirror.retire('m', 'ended');
        assert.equal(local.getItem('m'), 'ended', 'in localStorage at once: a page that goes now takes the transaction with it');
        assert.deepEqual(mirror.state('m'), { status: 'pending', committed: null, settled: null }, 'the marker names nothing once its end is on its way');
        await durable.commit();
        assert.equal(durable.disk.get('m'), 'ended');
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: null, settled: null }, 'an end is no marker');
        mirror.setItem('m', 'marker two');
        await durable.commit();
        assert.deepEqual(mirror.state('m'), { status: 'ok', committed: 'marker two', settled: 'marker two' });
        // A failed end is sent again; one on disk is not.
        durable.mode = 'fail';
        mirror.retire('m', 'ended two');
        await mirror.settled();
        assert.equal(mirror.state('m').status, 'failed');
        durable.mode = 'ok';
        mirror.retire('m', 'ended two');
        await mirror.settled();
        assert.equal(durable.disk.get('m'), 'ended two');
        const writes = durable.writes.length;
        mirror.retire('m', 'ended two');
        await mirror.settled();
        assert.equal(durable.writes.length, writes);
        // A localStorage that refuses the end has the record removed: kept,
        // it would say the record is not over.
        mirror.setItem('m', 'marker three');
        await mirror.settled();
        local.refuse = true;
        mirror.retire('m', 'ended three');
        assert.equal(local.getItem('m'), null);
        await mirror.settled();
        assert.equal(durable.disk.get('m'), 'ended three');
        // null removes it from both.
        local.refuse = false;
        mirror.retire('m', null);
        await mirror.settled();
        assert.equal(local.getItem('m'), null);
        assert.equal(durable.disk.has('m'), false);
    });

    it('retire() in a page that has not read the durable store yet: localStorage at once, the durable store once the read answers', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['m', 'marker']]) });
        const mirror = createDurableMirror({ local, durable, readFirst: true });
        local.setItem('m', 'marker');
        mirror.retire('m', 'ended');
        assert.equal(local.getItem('m'), 'ended');
        await tick(5);
        assert.equal(durable.writes.length, 0, 'held');
        await mirror.read();
        await mirror.settled();
        assert.equal(durable.disk.get('m'), 'ended');
    });

    it('replaceLocal() leaves the durable store alone', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['m', 'ended']]) });
        const mirror = createDurableMirror({ local, durable });
        local.setItem('m', 'stale copy');
        mirror.replaceLocal('m', 'ended here');
        await mirror.settled();
        assert.equal(local.getItem('m'), 'ended here');
        mirror.replaceLocal('m', null);
        await mirror.settled();
        assert.equal(local.getItem('m'), null);
        assert.equal(durable.disk.get('m'), 'ended');
        assert.equal(durable.writes.length, 0);
        assert.equal(mirror.state('m'), null, 'no change of this page\'s');
    });

    it('swap() goes out after every change made before it, and applies nothing while nothing can be sent', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['m', 'ended']]) });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('m', 'marker');
        assert.deepEqual(await mirror.swap([['m', 'ended', null]]), [false], 'the marker written first is what it finds');
        assert.equal(durable.disk.get('m'), 'marker');
        assert.deepEqual(await mirror.swap([['m', 'marker', 'x']]), [true]);
        assert.equal(durable.disk.get('m'), 'x');
        const unread = createDurableMirror({ local: fakeLocal(), durable: fakeDurable({ disk: new Map([['m', 'x']]) }), readFirst: true });
        assert.deepEqual(await unread.swap([['m', 'x', null]]), [false], 'not before this page has read the store');
        const none = createDurableMirror({ local: fakeLocal(), durable: null });
        assert.deepEqual(await none.swap([['m', 'x', null]]), [false]);
    });

    it('sends only what the durable store keeps: a change of the rest alone is no disk write', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        const project = (key, text) => text.split('|')[0];
        const mirror = createDurableMirror({ local, durable, project });
        mirror.setItem('m', 'kept|a');
        await mirror.settled();
        mirror.setItem('m', 'kept|b');
        mirror.setItem('m', 'kept|c');
        await mirror.settled();
        assert.equal(durable.writes.length, 1);
        assert.equal(durable.disk.get('m'), 'kept');
        assert.equal(local.getItem('m'), 'kept|c', 'localStorage keeps all of it');
        mirror.setItem('m', 'new|c');
        await mirror.settled();
        assert.equal(durable.disk.get('m'), 'new');
    });

    it('a record localStorage refuses still reaches the disk, and only once', async () => {
        const local = fakeLocal();
        local.refuse = true;
        const durable = fakeDurable();
        const mirror = createDurableMirror({ local, durable });
        for (let i = 0; i < 20; i++) assert.throws(() => mirror.setItem('m', 'one'), /QuotaExceededError/);
        await mirror.settled();
        assert.equal(durable.writes.length, 1, 'not a disk write on every engine tick');
        assert.equal(durable.disk.get('m'), 'one');
        // And its removal reaches the disk although localStorage has none.
        mirror.removeItem('m');
        await mirror.settled();
        assert.equal(durable.disk.has('m'), false);
        mirror.removeItem('m');
        await mirror.settled();
        assert.equal(durable.writes.length, 2, 'a removal already made is not sent again');
    });

    it('a failed change is not sent again with the same value, and is with a new one', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'fail' });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('m', 'one');
        await mirror.settled();
        local.refuse = true;
        for (let i = 0; i < 5; i++) assert.throws(() => mirror.setItem('m', 'one'));
        await mirror.settled();
        assert.equal(durable.writes.length, 1);
        local.refuse = false;
        durable.mode = 'ok';
        mirror.setItem('m', 'two');
        await mirror.settled();
        assert.equal(durable.writes.length, 2);
        assert.equal(durable.disk.get('m'), 'two');
    });

    it('flush() sends what has been changed so far at once, rather than once the running code is over', () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'manual' });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('a', '1');
        assert.equal(durable.writes.length, 0);
        mirror.flush();
        assert.equal(durable.writes.length, 1, 'sent before this code has finished');
        mirror.flush();
        assert.equal(durable.writes.length, 1, 'nothing more to send');
    });

    it('settled() waits for every change made so far, and no longer', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'manual' });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('a', '1');
        let done = false;
        mirror.settled().then(() => { done = true; });
        await tick(5);
        assert.equal(done, false);
        await durable.commit();
        await tick(1);
        assert.equal(done, true);
    });

    it('read() takes the records once this page\'s changes have settled, and stamps them', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ mode: 'manual', disk: new Map([['other', 'x']]) });
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('a', '1');
        const reading = mirror.read();
        // Long enough for a read that did not wait to have taken the records.
        await tick(20);
        // Written once the read was asked for, in a task of its own.
        mirror.setItem('b', '2');
        await durable.commit();
        const snapshot = await reading;
        assert.deepEqual(Array.from(snapshot.records.keys()).sort(), ['a', 'other'], 'what was written before the read');
        assert.equal(mirror.changedSince('a', snapshot.seq), false);
        assert.equal(mirror.changedSince('b', snapshot.seq), true, 'written after the read: localStorage is newer');
        assert.equal(mirror.changedSince('other', snapshot.seq), false);
        await durable.commit();
        // A change made in the task that asks for the read goes out with the
        // batch before it, and still counts as newer than the snapshot.
        mirror.setItem('c', '3');
        const again = mirror.read();
        mirror.setItem('d', '4');
        await durable.commit();
        const later = await again;
        assert.equal(later.records.get('d'), '4');
        assert.equal(mirror.changedSince('d', later.seq), true);
        assert.equal(mirror.changedSince('c', later.seq), false);
    });

    it('a change that did not reach the disk leaves localStorage the newer copy, whatever a snapshot says', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        const mirror = createDurableMirror({ local, durable });
        mirror.setItem('owed', 'one');
        await mirror.settled();
        durable.mode = 'fail';
        mirror.removeItem('owed');
        await mirror.settled();
        durable.mode = 'ok';
        const snapshot = await mirror.read();
        assert.equal(snapshot.records.get('owed'), 'one', 'the removal failed: the disk still has it');
        assert.equal(mirror.changedSince('owed', snapshot.seq), true);
        mirror.setItem('owed', 'two');
        await mirror.settled();
        assert.equal(mirror.changedSince('owed', (await mirror.read()).seq), false, 'until a change of it commits');
    });

    it('read() gives up at its timeout, and a read that answers late is handed on', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['m', 'x']]) });
        durable.readDelayMs = 60;
        const mirror = createDurableMirror({ local, durable });
        let late = null;
        assert.equal(await alive(mirror.read({ timeoutMs: 10, onLate: (snapshot) => { late = snapshot; } })), null);
        for (let i = 0; i < 100 && !late; i++) await tick(5);
        assert.deepEqual(Array.from(late.records.entries()), [['m', 'x']]);
        durable.readMode = 'fail';
        assert.equal(await mirror.read(), null, 'a store that cannot be read');
    });

    it('with readFirst, sends nothing before a read has answered, then what it held, with what onAttach merged, in one transaction', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['owed', 'on disk']]) });
        let attached = null;
        const mirror = createDurableMirror({
            local,
            durable,
            readFirst: true,
            onAttach: (snapshot) => {
                attached = snapshot;
                // The reader merges before the held changes go out.
                mirror.setItem('owed', `merged with ${snapshot.records.get('owed')}`);
            }
        });
        mirror.setItem('owed', 'from localStorage');
        mirror.setItem('mine', 'marker');
        mirror.flush();
        await mirror.settled();
        await tick(5);
        assert.equal(durable.writes.length, 0, 'held');
        assert.equal(mirror.state('mine').status, 'pending');
        const snapshot = await mirror.read();
        assert.equal(snapshot.records.get('owed'), 'on disk', 'what the disk had, untouched');
        assert.equal(attached, snapshot, 'handed to onAttach');
        assert.equal(mirror.changedSince('owed', snapshot.seq), true, 'a change held back is newer than the snapshot');
        await mirror.settled();
        assert.equal(durable.writes.length, 1, 'in one transaction');
        assert.deepEqual(Array.from(durable.disk.entries()).sort(), [['mine', 'marker'], ['owed', 'merged with on disk']]);
        assert.equal(mirror.state('mine').status, 'ok');
        // Only the first answer attaches.
        await mirror.read();
        assert.equal(durable.writes.length, 1);
    });

    it('with readFirst, a held change counts as failed at the timeout, and a read that answers late still sends it', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        durable.readDelayMs = 80;
        const mirror = createDurableMirror({ local, durable, readFirst: true, timeoutMs: 20 });
        let told = 0;
        mirror.subscribe(() => { told += 1; });
        mirror.setItem('mine', 'marker');
        let late = null;
        assert.equal(await alive(mirror.read({ timeoutMs: 10, onLate: (snapshot) => { late = snapshot; } })), null, 'gave up');
        await alive(tick(30));
        assert.equal(mirror.state('mine').status, 'failed', 'nothing waits on the read for longer');
        assert.ok(told >= 1);
        assert.equal(durable.writes.length, 0, 'still held');
        for (let i = 0; i < 60 && !late; i++) await alive(tick(5));
        assert.ok(late, 'the late answer is handed on');
        await mirror.settled();
        assert.equal(durable.disk.get('mine'), 'marker', 'and what was held went out with it');
        assert.equal(mirror.state('mine').status, 'ok');
    });

    it('with readFirst, a read that fails leaves every change held, and the next read that answers sends them', async () => {
        const local = fakeLocal();
        const durable = fakeDurable({ disk: new Map([['owed', 'on disk']]) });
        durable.readMode = 'fail';
        const mirror = createDurableMirror({ local, durable, readFirst: true, timeoutMs: 20 });
        mirror.setItem('mine', 'marker');
        assert.equal(await mirror.read(), null);
        mirror.setItem('owed', 'from localStorage');
        mirror.removeItem('gone');
        mirror.flush();
        await mirror.settled();
        await alive(tick(30));
        assert.equal(durable.writes.length, 0, 'nothing written to a store this page has not read');
        assert.equal(mirror.state('mine').status, 'failed');
        durable.readMode = 'ok';
        const snapshot = await mirror.read();
        assert.equal(snapshot.records.get('owed'), 'on disk');
        await mirror.settled();
        assert.equal(durable.writes.length, 1);
        assert.deepEqual(Array.from(durable.disk.entries()).sort(), [['mine', 'marker'], ['owed', 'from localStorage']]);
    });

    it('with readFirst, a read that finds the store cannot be read fails what it holds at once, and every change made until a read answers', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        durable.readMode = 'fail';
        const mirror = createDurableMirror({ local, durable, readFirst: true, timeoutMs: 60000 });
        let told = 0;
        mirror.subscribe(() => { told += 1; });
        mirror.setItem('mine', 'marker');
        assert.equal(mirror.state('mine').status, 'pending', 'held while the store may still answer');
        assert.equal(await mirror.read(), null);
        assert.deepEqual(mirror.state('mine'), { status: 'failed', committed: null, settled: 'marker' }, 'at once, not at the timeout a minute from now');
        assert.equal(told, 1, 'and whoever waits on it is told');
        mirror.setItem('mine', 'marker two');
        assert.deepEqual(mirror.state('mine'), { status: 'failed', committed: null, settled: 'marker two' }, 'nor does a change made since wait');
        await mirror.settled();
        assert.equal(durable.writes.length, 0, 'still held: nothing written to a store this page has not read');
        // The store can be read again: what was held goes out, and a change
        // waits for its commit again.
        durable.readMode = 'ok';
        assert.ok(await mirror.read());
        await mirror.settled();
        assert.equal(durable.disk.get('mine'), 'marker two');
        assert.deepEqual(mirror.state('mine'), { status: 'ok', committed: 'marker two', settled: 'marker two' });
        durable.mode = 'manual';
        mirror.setItem('mine', 'marker three');
        assert.equal(mirror.state('mine').status, 'pending');
        await durable.commit();
        assert.equal(mirror.state('mine').status, 'ok');
    });

    it('with readFirst, a read that does not answer leaves what it holds to its timeout: the store may still answer', async () => {
        const local = fakeLocal();
        const durable = fakeDurable();
        durable.readMode = 'hang';
        const mirror = createDurableMirror({ local, durable, readFirst: true, timeoutMs: 40 });
        mirror.setItem('mine', 'marker');
        assert.equal(await alive(mirror.read({ timeoutMs: 10 })), null, 'gave up on the read');
        assert.equal(mirror.state('mine').status, 'pending', 'but not on the change');
        mirror.setItem('other', 'x');
        assert.equal(mirror.state('other').status, 'pending');
        for (let i = 0; i < 200 && mirror.state('mine').status === 'pending'; i++) await alive(tick(2));
        assert.equal(mirror.state('mine').status, 'failed', 'at its timeout');
    });

    it('without a durable store it is localStorage alone', async () => {
        const local = fakeLocal();
        const mirror = createDurableMirror({ local, durable: null });
        mirror.setItem('m', 'one');
        mirror.removeItem('m');
        mirror.setItem('n', 'two');
        mirror.retire('n', 'ended');
        mirror.setItem('o', 'three');
        assert.equal(local.getItem('n'), null);
        assert.equal(local.getItem('o'), 'three');
        assert.equal(mirror.state('o'), null, 'nothing to wait for');
        assert.equal(await mirror.read(), null);
        await mirror.settled();
        assert.deepEqual(Array.from(local.map.keys()), ['o']);
        // And without localStorage every write throws, as storage.js expects.
        const none = createDurableMirror({ local: null, durable: fakeDurable() });
        assert.throws(() => none.setItem('m', 'one'));
        assert.equal(none.getItem('m'), null);
        assert.equal(none.length, 0);
    });
});
