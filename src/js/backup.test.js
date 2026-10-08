import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    LEGACY_VERSION,
    MAX_CONNECTION_KEY_LENGTH,
    MAX_SAVED_DEVICES,
    FILENAME_PLAIN,
    FILENAME_WITH_KEY,
    NOTE_WITH_KEY,
    NOTE_WITHOUT_KEY,
    RESERVED_SETTING_KEYS,
    sanitizeConnectionKey,
    sanitizeHandyRole,
    sanitizeMaxCap,
    sanitizeDeviceMap,
    mergeDeviceMaps,
    pruneReservedKeys,
    buildBackup,
    backupFilename,
    describeBackupExport,
    readBackup,
    describeBackupImport,
    filterSettings,
    sanitizeLearningProfile,
    MAX_LEARNED_OFFSET_BPM,
    MIN_CAP_PERCENT,
    RESTORE_PARTS,
    CAP_STEP_PERCENT,
    countDroppedOnMerge,
    backupNote,
    NOTE_KEY_NONE_SAVED,
    NOTE_KEY_UNUSABLE
} from './backup.js';
import { advancedSettings, SETTING_KEYS, SETTING_DEFAULTS } from './state.js';
import { sanitizeSetting } from './settings-schema.js';
import { sanitizeSessionLimits } from './session-rules.js';
import { normalizeEnvelope } from './hardware/handy-protocol.js';

const KEY = 'AUDITKEY-9f3c21';

const STORES = {
    settings: {
        minHr: 70, maxHr: 140, handyHwMin: 10, handyHwMax: 90,
        learningProfile: { breakthroughEvents: 2, suggestedMaxHrOffset: 6, lastBreakthroughHr: 132 }
    },
    handyRole: 'secondary',
    handyMaxCap: 65,
    handyConnectionKey: KEY,
    intifaceDevices: {
        'Lovense Nora:1': {
            name: 'Lovense Nora',
            axes: { 'scalar:0': { role: 'secondary', maxCap: 80, invert: false }, 'rotate:0': { role: 'primary', maxCap: 55, invert: true } },
            reverseOnEdge: true,
            alternateSeconds: 12,
            savedAt: 1700000000000
        }
    },
    tcodeDevices: {
        'OSR2 v3.3': {
            axes: { L0: { role: 'primary', maxCap: 90, invert: true }, V0: { role: 'secondary', maxCap: 40, invert: false } },
            savedAt: 1700000000001
        }
    },
    ageVerified: true,
    wizardSeen: true
};

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

describe('the connection key is bounded before it can reach the device API', () => {
    it('accepts a plain key and trims it', () => {
        assert.equal(sanitizeConnectionKey('  12345678 '), '12345678');
    });

    it('refuses anything that is not a string', () => {
        for (const junk of [null, undefined, 42, {}, [], true, { toString: () => 'k' }]) {
            assert.equal(sanitizeConnectionKey(junk), null);
        }
    });

    it('refuses an empty or whitespace-only key rather than saving a blank', () => {
        assert.equal(sanitizeConnectionKey(''), null);
        assert.equal(sanitizeConnectionKey('   '), null);
    });

    it('refuses a key longer than the bound instead of truncating it', () => {
        const long = 'k'.repeat(MAX_CONNECTION_KEY_LENGTH + 1);
        assert.equal(sanitizeConnectionKey(long), null);
        assert.equal(sanitizeConnectionKey('k'.repeat(MAX_CONNECTION_KEY_LENGTH)), 'k'.repeat(MAX_CONNECTION_KEY_LENGTH));
    });

    it('refuses a key carrying a newline: it is sent as an HTTP header', () => {
        assert.equal(sanitizeConnectionKey('abc\r\nX-Injected: 1'), null);
        assert.equal(sanitizeConnectionKey('abc def'), null);
        assert.equal(sanitizeConnectionKey('abc\u0000'), null);
        assert.equal(sanitizeConnectionKey('ключ'), null);
    });
});

describe('the Handy role and speed cap are clamped, never invented', () => {
    it('keeps the three real roles and nothing else', () => {
        assert.equal(sanitizeHandyRole('primary'), 'primary');
        assert.equal(sanitizeHandyRole('secondary'), 'secondary');
        assert.equal(sanitizeHandyRole('off'), 'off');
        for (const junk of ['PRIMARY', 'boss', '', null, 3, {}]) assert.equal(sanitizeHandyRole(junk), null);
    });

    it('snaps a cap onto the grid the cap slider can actually show', () => {
        // min=10 max=100 step=5 is every cap control in the app, so those
        // are the only values it can write. A restored cap off that grid
        // left the slider showing 35 while the store and the driver used 37,
        // and the next nudge of the slider committed the 35.
        assert.equal(sanitizeMaxCap(65), 65);
        assert.equal(sanitizeMaxCap('65'), 65);
        assert.equal(sanitizeMaxCap(37), 35, 'rounds DOWN: of two neighbours, the slower one');
        assert.equal(sanitizeMaxCap(64.6), 60);
        assert.equal(sanitizeMaxCap(1e9), 100);
        assert.equal(sanitizeMaxCap(-40), MIN_CAP_PERCENT);
        assert.equal(sanitizeMaxCap(3), MIN_CAP_PERCENT, 'below the grid there is nothing to round down to');
        for (let cap = MIN_CAP_PERCENT; cap <= 100; cap += CAP_STEP_PERCENT) {
            assert.equal(sanitizeMaxCap(cap), cap, `${cap} is on the grid and must survive untouched`);
        }
    });

    it('reports a missing cap as null so nothing restores a 100% cap by accident', () => {
        for (const junk of [null, undefined, 'fast', NaN, Infinity, {}]) assert.equal(sanitizeMaxCap(junk), null);
        const read = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: { minHr: 70 }, handy: { maxCap: 'fast' } });
        assert.equal(read.handy.maxCap, null);
    });
});

describe('device maps survive the round trip and hostile ones are declawed', () => {
    it('keeps the Intiface shape whole', () => {
        const map = sanitizeDeviceMap(STORES.intifaceDevices, { extras: true });
        assert.deepEqual(map['Lovense Nora:1'], {
            axes: {
                'scalar:0': { invert: false, role: 'secondary', maxCap: 80 },
                'rotate:0': { invert: true, role: 'primary', maxCap: 55 }
            },
            name: 'Lovense Nora',
            reverseOnEdge: true,
            alternateSeconds: 12,
            savedAt: 1700000000000
        });
    });

    it('keeps a pulsed vibrator and drops a period this build does not know', () => {
        const map = sanitizeDeviceMap({
            edge: {
                axes: {
                    'scalar:0': { role: 'secondary', maxCap: 80, invert: false, vibeMode: 'pulsed', pulsePeriodMs: 800 },
                    'scalar:1': { role: 'secondary', maxCap: 80, invert: false, vibeMode: 'strobe', pulsePeriodMs: 1000 }
                }
            }
        }, { extras: true });
        assert.equal(map.edge.axes['scalar:0'].vibeMode, 'pulsed');
        assert.equal(map.edge.axes['scalar:0'].pulsePeriodMs, 800);
        assert.equal(map.edge.axes['scalar:1'].vibeMode, undefined);
        assert.equal(map.edge.axes['scalar:1'].pulsePeriodMs, undefined);
    });

    it('keeps the TCode shape whole', () => {
        const map = sanitizeDeviceMap(STORES.tcodeDevices, { extras: false });
        assert.deepEqual(map['OSR2 v3.3'], {
            axes: { L0: { invert: true, role: 'primary', maxCap: 90 }, V0: { invert: false, role: 'secondary', maxCap: 40 } },
            savedAt: 1700000000001
        });
    });

    it('clamps an axis cap and drops a role the drivers do not know', () => {
        const map = sanitizeDeviceMap({ dev: { axes: { L0: { role: 'boss', maxCap: 400, invert: 'yes' } }, savedAt: 5 } });
        assert.deepEqual(map.dev.axes.L0, { invert: false, maxCap: 100 });
        assert.ok(!('role' in map.dev.axes.L0), 'an unreadable role must fall through to the driver default');
    });

    it('clamps the alternation window and keeps 0 meaning off', () => {
        const map = sanitizeDeviceMap({ d: { axes: {}, alternateSeconds: 900 }, e: { axes: {}, alternateSeconds: 0 }, f: { axes: {}, alternateSeconds: 1 } }, { extras: true });
        assert.equal(map.d.alternateSeconds, 60);
        assert.equal(map.e.alternateSeconds, 0);
        assert.equal(map.f.alternateSeconds, 5);
    });

    it('drops junk entries instead of crashing', () => {
        const map = sanitizeDeviceMap({ a: null, b: 'nope', c: [1, 2], d: { axes: 'no' } });
        assert.deepEqual(Object.keys(map), ['d']);
        assert.deepEqual(map.d.axes, {});
        assert.deepEqual(sanitizeDeviceMap(null), {});
        assert.deepEqual(sanitizeDeviceMap([1, 2, 3]), {});
    });

    it('never pushes a store past the driver cap, keeping the newest', () => {
        const huge = {};
        for (let i = 0; i < MAX_SAVED_DEVICES + 10; i++) huge[`dev${i}`] = { axes: {}, savedAt: 1000 + i };
        const map = sanitizeDeviceMap(huge);
        assert.equal(Object.keys(map).length, MAX_SAVED_DEVICES);
        assert.ok(!('dev0' in map), 'the oldest entries go first');
        assert.ok(`dev${MAX_SAVED_DEVICES + 9}` in map);
    });

    it('merges rather than replaces, so toys the file never knew stay mapped', () => {
        const existing = { keeper: { axes: {}, savedAt: 1 }, shared: { axes: { L0: { role: 'off' } }, savedAt: 1 } };
        const incoming = { shared: { axes: { L0: { role: 'primary' } }, savedAt: 9 }, fresh: { axes: {}, savedAt: 9 } };
        const merged = mergeDeviceMaps(existing, incoming);
        assert.deepEqual(Object.keys(merged).sort(), ['fresh', 'keeper', 'shared']);
        assert.equal(merged.shared.axes.L0.role, 'primary');
    });
});

describe('the export file says what it is', () => {
    it('carries every store the audit found missing', () => {
        const file = buildBackup(STORES, { includeKey: false, now: NOW });
        assert.equal(file.format, BACKUP_FORMAT);
        assert.equal(file.version, BACKUP_VERSION);
        assert.equal(file.exportedAt, '2026-01-02T03:04:05.000Z');
        assert.equal(file.settings.maxHr, 140);
        assert.deepEqual(file.handy, { role: 'secondary', maxCap: 65 });
        assert.equal(file.devices.intiface['Lovense Nora:1'].name, 'Lovense Nora');
        assert.ok(file.devices.tcode['OSR2 v3.3']);
        assert.deepEqual(file.flags, { ageVerified: true, wizardSeen: true });
    });

    it('leaves the key out by default and says so in the file', () => {
        const file = buildBackup(STORES, { now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        assert.equal(file.handyConnectionKey, null);
        assert.equal(file.note, NOTE_WITHOUT_KEY);
        assert.ok(!JSON.stringify(file).includes(KEY), 'the default file must not contain the key anywhere');
        assert.equal(backupFilename(file), FILENAME_PLAIN);
    });

    it('carries the key when it is asked for, and warns in the file and the filename', () => {
        const file = buildBackup(STORES, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, true);
        assert.equal(file.handyConnectionKey, KEY);
        assert.equal(file.note, NOTE_WITH_KEY);
        assert.equal(backupFilename(file), FILENAME_WITH_KEY);
    });

    it('cannot claim a key it does not have', () => {
        const file = buildBackup({ ...STORES, handyConnectionKey: '' }, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        assert.equal(file.handyConnectionKey, null);
        assert.equal(backupFilename(file), FILENAME_PLAIN);
        const notice = describeBackupExport(file, { requestedKey: true });
        assert.match(notice.message, /No Handy connection key is saved/);
        assert.equal(notice.carriesKey, false);
    });

    it('says a saved key was unusable rather than that none was saved', () => {
        // A key that cannot go in an HTTP header is refused, but the reason
        // the file has no key then is NOT "you never saved one" - that
        // sentence would send the user away with a silently incomplete
        // backup, which is the bug this whole file exists to close.
        const file = buildBackup({ ...STORES, handyConnectionKey: 'has a space' }, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        const notice = describeBackupExport(file, { requestedKey: true, hasSavedKey: true });
        assert.equal(notice.carriesKey, false);
        assert.equal(notice.tone, 'warn');
        assert.match(notice.message, /not a usable key/);
        assert.match(notice.message, /Re-enter it in the Handy panel/);
        assert.ok(!/No Handy connection key is saved/.test(notice.message));
    });

    it('still says nothing is saved when nothing is saved', () => {
        const file = buildBackup({ ...STORES, handyConnectionKey: '' }, { includeKey: true, now: NOW });
        const notice = describeBackupExport(file, { requestedKey: true, hasSavedKey: false });
        assert.match(notice.message, /No Handy connection key is saved/);
        assert.equal(notice.tone, 'info');
    });

    it('never writes a stray credential that an older import merged into the settings store', () => {
        const poisoned = { ...STORES, settings: { ...STORES.settings, handyConnectionKey: 'PROBE-KEY-123', version: 9 } };
        const file = buildBackup(poisoned, { now: NOW });
        assert.ok(!('handyConnectionKey' in file.settings));
        assert.ok(!('version' in file.settings));
        assert.ok(!JSON.stringify(file).includes('PROBE-KEY-123'));
    });

    it('omits a role or cap it cannot read instead of writing a default', () => {
        const file = buildBackup({ settings: {}, handyRole: 'boss', handyMaxCap: 'fast' }, { now: NOW });
        assert.deepEqual(file.handy, {});
    });

    it('describes the export in words the user can act on', () => {
        const plain = describeBackupExport(buildBackup(STORES, { now: NOW }), { requestedKey: false });
        assert.equal(plain.tone, 'info');
        assert.match(plain.message, /NOT in it/);
        assert.match(plain.message, new RegExp(FILENAME_PLAIN));
        const withKey = describeBackupExport(buildBackup(STORES, { includeKey: true, now: NOW }), { requestedKey: true });
        assert.equal(withKey.tone, 'warn');
        assert.match(withKey.message, /CONTAINS your Handy connection key/);
        assert.match(withKey.message, new RegExp(FILENAME_WITH_KEY));
    });
});

describe('the round trip the report was about', () => {
    it('brings the key back when it was included', () => {
        const file = buildBackup(STORES, { includeKey: true, now: NOW });
        const read = readBackup(JSON.parse(JSON.stringify(file)));
        assert.equal(read.ok, true);
        assert.equal(read.keyPresent, true);
        assert.equal(read.handyConnectionKey, KEY);
        assert.equal(read.version, BACKUP_VERSION);
        assert.equal(read.legacy, false);
    });

    it('brings every other store back byte for byte', () => {
        const file = buildBackup(STORES, { now: NOW });
        const read = readBackup(JSON.parse(JSON.stringify(file)));
        assert.deepEqual(read.settings, STORES.settings);
        assert.deepEqual(read.handy, { role: 'secondary', maxCap: 65 });
        assert.deepEqual(read.devices.intiface, file.devices.intiface);
        assert.deepEqual(read.devices.tcode, file.devices.tcode);
        assert.deepEqual(read.flags, { ageVerified: true, wizardSeen: true });
    });

    it('reports a key-less file as key-less rather than as an empty key', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        assert.equal(read.keyPresent, false);
        assert.equal(read.handyConnectionKey, null);
        assert.equal(read.keyRejected, false);
        assert.equal(read.keyDeclaredAbsent, true, 'a modern file states that it left the key out');
    });
});

describe('an older file still imports', () => {
    it('reads a bare advancedSettings blob as settings', () => {
        const legacy = { minHr: 66, maxHr: 96, voiceCues: { edge: ['hold'] } };
        const read = readBackup(legacy);
        assert.equal(read.ok, true);
        assert.equal(read.legacy, true);
        assert.equal(read.version, LEGACY_VERSION);
        // `requested` is the file as written; `settings` is what this app
        // will take, each value through the same sanitizer a typed one gets
        // (mergeVoiceCues fills in the banks the file did not mention).
        assert.deepEqual(read.requested, legacy);
        assert.equal(read.settings.minHr, 66);
        assert.equal(read.settings.maxHr, 96);
        assert.deepEqual(read.settings.voiceCues.edge, ['hold']);
        assert.equal(read.keyPresent, false);
        assert.equal(read.keyDeclaredAbsent, false, 'an old file has no opinion about the key');
        assert.deepEqual(read.handy, { role: null, maxCap: null });
        assert.deepEqual(read.devices, { intiface: {}, tcode: {} });
    });

    it('reads a key an older build had merged into the blob, and never leaves it in the settings', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'PROBE-KEY-123' });
        assert.equal(read.keyPresent, true);
        assert.equal(read.handyConnectionKey, 'PROBE-KEY-123');
        assert.ok(!('handyConnectionKey' in read.settings), 'the credential must never be merged into the settings store');
    });

    it('reads a file from a newer EdgeLoop and says what it skipped', () => {
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION + 1,
            settings: { minHr: 70 },
            somethingNew: { nested: true }
        });
        assert.equal(read.ok, true);
        assert.equal(read.futureVersion, true);
        assert.deepEqual(read.settings, { minHr: 70 });
        assert.match(describeBackupImport(read, {}), /newer EdgeLoop/);
    });
});

describe('a hand-edited or hostile file cannot do harm', () => {
    it('refuses anything that is not an object', () => {
        for (const junk of [null, 42, 'settings', [1, 2, 3], true]) {
            assert.equal(readBackup(junk).ok, false);
        }
    });

    it('refuses a file with nothing of ours in it', () => {
        const read = readBackup({});
        assert.equal(read.ok, false);
        assert.match(read.error, /no EdgeLoop settings/);
        assert.equal(readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {} }).ok, false);
    });

    it('never lets a file field masquerade as a setting', () => {
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: Object.fromEntries(RESERVED_SETTING_KEYS.map((name) => [name, 'sneaky'])),
            handyConnectionKey: KEY
        });
        // Every field in `settings` was a reserved name, so nothing is left
        // to merge - but the key at the top level is still read.
        assert.deepEqual(read.settings, {});
        assert.equal(read.handyConnectionKey, KEY);
    });

    it('flags a key-shaped field that is not a usable key instead of passing it on', () => {
        for (const junk of [12345678, { key: 'x' }, ['k'], 'has space', 'x'.repeat(500)]) {
            const read = readBackup({ minHr: 70, handyConnectionKey: junk });
            assert.equal(read.keyPresent, false, `junk key accepted: ${JSON.stringify(junk)}`);
            assert.equal(read.keyRejected, true);
            assert.equal(read.handyConnectionKey, null);
        }
    });

    it('cannot invert a travel envelope or raise a ceiling on its own', () => {
        // Every value is bounded on the way through, per field, by the same
        // sanitizer a typed one gets. The three PAIRS - the HR limits, the
        // duration window, the travel envelope - are reconciled against each
        // other afterwards by their owners (see CROSS_FIELD_OWNERS), because
        // only they can see both halves.
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: { handyHwMin: 900, handyHwMax: -4, maxHr: 9999 },
            handy: { maxCap: 900 },
            devices: { intiface: { d: { axes: { 'scalar:0': { maxCap: 900 } } } } }
        });
        assert.equal(read.handy.maxCap, 100);
        assert.equal(read.devices.intiface.d.axes['scalar:0'].maxCap, 100);
        // The three PAIRS are handed to their owners as written, because
        // only an owner that sees both halves can tell "clamp this end"
        // from "this pair is nonsense, use the factory one".
        assert.equal(read.settings.maxHr, 9999);
        assert.deepEqual(
            (({ minHr, maxHr }) => ({ minHr, maxHr }))(sanitizeSessionLimits(read.settings)),
            { minHr: 70, maxHr: 140 },
            'and the owner refuses the pair rather than keeping a 9999 end'
        );
        const envelope = normalizeEnvelope(read.settings.handyHwMin, read.settings.handyHwMax);
        assert.ok(envelope.min >= 0 && envelope.max <= 100 && envelope.min < envelope.max, JSON.stringify(envelope));
        assert.deepEqual(read.requested, { handyHwMin: 900, handyHwMax: -4, maxHr: 9999 }, 'what the file asked for is kept verbatim for the count');
    });

    it('drops the file fields from a live settings store that an old import polluted', () => {
        const live = { minHr: 70, handyConnectionKey: 'PROBE-KEY-123', note: 'x' };
        const removed = pruneReservedKeys(live);
        assert.deepEqual(live, { minHr: 70 });
        assert.deepEqual(removed.sort(), ['handyConnectionKey', 'note']);
        assert.deepEqual(pruneReservedKeys(null), []);
    });
});

describe('the import says what it did', () => {
    const full = readBackup(buildBackup(STORES, { includeKey: true, now: NOW }));

    it('names everything it restored', () => {
        const text = describeBackupImport(full, { hadExistingKey: false });
        assert.match(text, /5 Session Setup values/);
        // named with their values, so the reader does not have to open the
        // Handy panel to find out what the cap now is
        assert.match(text, /the Handy channel role \(now secondary\)/);
        assert.match(text, /the Handy speed cap \(now 65%\)/);
        assert.match(text, /1 Intiface device map/);
        assert.match(text, /1 T-Code device map/);
    });

    it('says the key came back, and that nothing was connected', () => {
        const text = describeBackupImport(full, { hadExistingKey: false });
        assert.match(text, /connection key was restored/);
        assert.match(text, /never connects a toy by itself/);
    });

    it('says a key-less file kept the key already saved here', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        // Our own export declares the absence, so the sentence says the file
        // was exported without one rather than that it merely lacks one.
        assert.match(describeBackupImport(read, { hadExistingKey: true }), /exported without a Handy connection key, so the one saved in this browser was kept/);
        // A legacy blob has no opinion, and gets the older wording.
        assert.match(describeBackupImport(readBackup({ minHr: 70 }), { hadExistingKey: true }), /contained no Handy connection key, so the one saved in this browser was kept/);
    });

    it('tells a user with no key at all where to get one - the wasted-restore sentence', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        assert.match(describeBackupImport(read, { hadExistingKey: false }), /Enter yours in the Handy panel/);
    });

    it('says when a key-shaped field was refused', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'has space' });
        assert.match(describeBackupImport(read, { hadExistingKey: true }), /not a usable key/);
    });

    it('always answers the history question', () => {
        assert.match(describeBackupImport(full, {}), /Session history is never carried in a backup/);
    });

    it('says an older file was read as an older file', () => {
        assert.match(describeBackupImport(readBackup({ minHr: 70 }), {}), /no version marker/);
    });

    it('refuses to describe a failed read as a success, and says which way it failed', () => {
        const named = describeBackupImport({ ok: false, error: 'the file is not a JSON object' }, {});
        assert.match(named, /not an EdgeLoop backup/);
        assert.match(named, /the file is not a JSON object/);
        assert.match(named, /Backup tab/);
        // A result with no reason still gets a sentence a user can act on.
        assert.match(describeBackupImport(null, {}), /not an EdgeLoop backup/);
        assert.ok(!/undefined/.test(describeBackupImport(null, {})));
    });

    it('gives a different reason for each way a file can be wrong', () => {
        const reason = (value) => describeBackupImport(readBackup(value), {});
        const list = reason([1, 2, 3]);
        const bare = reason('hello');
        const empty = reason({});
        const junk = reason({ someOtherApp: true, alsoNotMine: 1 });
        assert.match(list, /JSON list/);
        assert.match(bare, /not a JSON object/);
        assert.match(empty, /no EdgeLoop settings at all/);
        assert.match(junk, /2 unrecognised fields/);
        assert.equal(new Set([list, bare, empty, junk]).size, 4);
    });
});

describe('only fields this version has cross the file boundary', () => {
    it('SETTING_KEYS is the factory list, not whatever the live store grew', () => {
        // Captured at module load, so a later merge cannot widen it.
        assert.ok(SETTING_KEYS.length >= 30);
        assert.ok(SETTING_KEYS.includes('minHr') && SETTING_KEYS.includes('learningProfile'));
        assert.ok(Object.isFrozen(SETTING_KEYS));
        for (const name of RESERVED_SETTING_KEYS) {
            assert.ok(!SETTING_KEYS.includes(name), `${name} is a file field, never a setting`);
        }
        // Every default is exportable and importable; the list IS the defaults.
        assert.deepEqual([...SETTING_KEYS].sort(), Object.keys(advancedSettings).sort());
    });

    it('drops an unknown field on the way in and reports it', () => {
        const read = readBackup({
            format: 'edgeloop-backup',
            version: 2,
            settings: { minHr: 70, maxHr: 140, bogusUnknownField: 1, sneakyKey: 'STOLEN-KEY-9999' }
        });
        assert.equal(read.ok, true);
        assert.deepEqual(Object.keys(read.settings).sort(), ['maxHr', 'minHr']);
        assert.deepEqual(read.unknownSettingKeys.sort(), ['bogusUnknownField', 'sneakyKey']);
        const text = describeBackupImport(read, {});
        // The count it announces is the count it actually stored.
        assert.match(text, /2 Session Setup values/);
        assert.match(text, /2 fields in the file are not a setting this version has/);
        assert.ok(!text.includes('STOLEN-KEY-9999'));
    });

    it('drops an unknown field on the way out, so a polluted store cannot leak one', () => {
        // Exactly the shape an older build's Object.assign left behind.
        const polluted = { minHr: 70, handyConnectionKey: 'LEAKED-1234', strayFromOldBuild: 'x' };
        const file = buildBackup({ settings: polluted }, { now: NOW });
        assert.deepEqual(Object.keys(file.settings), ['minHr']);
        assert.equal(JSON.stringify(file).includes('LEAKED-1234'), false);
        assert.equal(JSON.stringify(file).includes('strayFromOldBuild'), false);
    });

    it('a legacy blob is filtered the same way as an enveloped one', () => {
        const read = readBackup({ minHr: 70, maxHr: 150, whatIsThis: true });
        assert.equal(read.legacy, true);
        assert.deepEqual(read.unknownSettingKeys, ['whatIsThis']);
        assert.equal('whatIsThis' in read.settings, false);
    });

    it('a file of nothing but unknown fields is refused rather than imported as empty', () => {
        const read = readBackup({ nothingWeKnow: 1 });
        assert.equal(read.ok, false);
        assert.match(read.error, /unrecognised field/);
    });

    it('filterSettings takes an explicit list too', () => {
        const { settings, unknown } = filterSettings({ a: 1, b: 2 }, ['a']);
        assert.deepEqual(settings, { a: 1 });
        assert.deepEqual(unknown, ['b']);
        assert.deepEqual(filterSettings(null).settings, {});
        assert.deepEqual(filterSettings('nope').unknown, []);
    });
});

describe('the learning profile is clamped like every other restored value', () => {
    it('keeps a plausible profile as it is', () => {
        assert.deepEqual(
            sanitizeLearningProfile({ breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 }),
            { breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 }
        );
    });

    it('refuses an offset that would RAISE the working ceiling', () => {
        // A negative offset is subtracted from the typed Climax HR, so a
        // hand-edited -60 would hand the toys a ceiling 60 BPM above the one
        // the user typed. It clamps to 0, not to the number in the file.
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: -60 }).suggestedMaxHrOffset, 0);
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: 999 }).suggestedMaxHrOffset, MAX_LEARNED_OFFSET_BPM);
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: 'lots' }).suggestedMaxHrOffset, 0);
    });

    it('nulls an implausible last-event HR and floors the event count', () => {
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: 9000 }).lastBreakthroughHr, null);
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: 0 }).lastBreakthroughHr, null);
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: '132' }).lastBreakthroughHr, 132);
        assert.equal(sanitizeLearningProfile({ breakthroughEvents: -4 }).breakthroughEvents, 0);
        assert.equal(sanitizeLearningProfile({ breakthroughEvents: 1e9 }).breakthroughEvents, 9999);
    });

    it('an unreadable profile becomes the zeroed one a fresh install has', () => {
        // Not dropped: a file that carries a profile field is asking for a
        // profile, and the only profile with no information in it is the
        // one a fresh install has.
        assert.deepEqual(sanitizeLearningProfile('yes'), { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null });
        assert.deepEqual(sanitizeLearningProfile([1]), { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null });
        const read = readBackup({ minHr: 70, learningProfile: 'yes' });
        assert.deepEqual(read.settings.learningProfile, { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null });
        // and the file's own words are kept, so the count can see it changed
        assert.equal(read.requested.learningProfile, 'yes');
    });

    it('clamps the profile that arrives inside a file', () => {
        const read = readBackup({ minHr: 70, learningProfile: { breakthroughEvents: 2, suggestedMaxHrOffset: -60, lastBreakthroughHr: 4000 } });
        assert.deepEqual(read.settings.learningProfile, { breakthroughEvents: 2, suggestedMaxHrOffset: 0, lastBreakthroughHr: null });
    });
});

describe('the documented backup is the backup that is written', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('### Backup & Restore'));

    it('names every store the file actually carries', () => {
        const file = buildBackup(STORES, { now: NOW });
        // Each of these is a real top-level part of the file, so the section
        // that lists what a backup holds has to mention it.
        assert.ok(Object.keys(file.devices).length === 2 && file.handy && file.flags);
        for (const phrase of [/Session Setup value/i, /Handy channel role and speed cap/i, /Intiface and T-Code device maps/i, /age \/ wizard flags/i, /connection key/i, /history is never in a backup/i]) {
            assert.match(section, phrase);
        }
    });

    it('every claim in it that this module decides is true of this module', () => {
        const file = buildBackup(STORES, { includeKey: true, now: NOW });
        const claims = [
            // claim in the docs -> what has to be true of the code
            ["the file's own second line is the warning",
                () => /"note":/.test(JSON.stringify(file, null, 2).split('\n')[1])],
            ['downloads as `edgeloop_settings_with_key.json` instead of `edgeloop_settings.json`',
                () => backupFilename(file) === FILENAME_WITH_KEY && backupFilename(buildBackup(STORES, { now: NOW })) === FILENAME_PLAIN],
            ['a file carrying a **different** key does re-pair this browser, which the import says out loud',
                () => /REPLACED/.test(describeBackupImport(readBackup({ minHr: 70, handyConnectionKey: 'X' }), { hadExistingKey: true, keyReplaced: true }))],
            ['comes back at the nearest value it accepts - a limit, or the factory setting - and is counted as refused',
                () => /came back at the nearest value it does/.test(describeBackupImport(readBackup({ minHr: 5, maxHr: 9999 }), { settingsStored: 0 }))],
            ['the import says so first and in those words',
                () => describeBackupImport(readBackup({ minHr: 70 }), { unsaved: ['settings'] }).startsWith('THIS BROWSER REFUSED TO SAVE')]
        ];
        for (const [claim, holds] of claims) {
            assert.ok(section.includes(claim), `README no longer makes the claim "${claim}" - update this guard with it`);
            assert.ok(holds(), `README claims "${claim}" and the code does not do it`);
        }
    });

    it('promises nothing the settings object does not have', () => {
        // README.md used to say a backup carried "your custom profiles".
        // advancedSettings had a customProfiles field that no screen, no
        // engine path and no driver ever read or wrote, so the sentence
        // described a feature that did not exist; the field is gone and the
        // sentence with it. A document that is wrong about something
        // checkable is not trusted about anything else.
        assert.ok(!/custom profile/i.test(section), 'the Backup section names a feature this build does not have');
        assert.ok(!SETTING_KEYS.includes('customProfiles'), 'customProfiles is dead state; do not bring it back without a screen that uses it');
    });
});

describe('the second round of findings', () => {
    it('the note is the first line of the file, and answers the box that was ticked', () => {
        const withKey = buildBackup(STORES, { includeKey: true, now: NOW });
        const lines = JSON.stringify(withKey, null, 2).split('\n');
        // README and CHANGELOG both say "the file's own second line is the
        // warning". It was line 5, behind format/version/exportedAt.
        assert.match(lines[1], /"note":/);
        assert.match(lines[1], /WARNING: this file contains your Handy connection key/);
        // Telling someone to tick a box they ticked is worse than silence.
        assert.equal(backupNote(false, true, ''), NOTE_KEY_NONE_SAVED);
        assert.equal(backupNote(false, true, 'BAD KEY'), NOTE_KEY_UNUSABLE);
        assert.equal(buildBackup({ ...STORES, handyConnectionKey: '' }, { includeKey: true, now: NOW }).note, NOTE_KEY_NONE_SAVED);
        assert.equal(buildBackup({ ...STORES, handyConnectionKey: 'BAD KEY' }, { includeKey: true, now: NOW }).note, NOTE_KEY_UNUSABLE);
        // and the note in the file agrees with what the panel just said
        const unusable = buildBackup({ ...STORES, handyConnectionKey: 'BAD KEY' }, { includeKey: true, now: NOW });
        const panel = describeBackupExport(unusable, { requestedKey: true, hasSavedKey: true });
        assert.equal(/Tick "Include my Handy connection key"/.test(unusable.note), false);
        assert.match(panel.message, /not a usable key/);
        assert.match(unusable.note, /not a usable key/);
    });

    it('a merge never trims out the maps it just restored', () => {
        const existing = {};
        for (let i = 0; i < MAX_SAVED_DEVICES; i += 1) existing[`mine${i}`] = { axes: {}, savedAt: 2_000_000_000_000 + i };
        const incoming = { fromFile: { axes: {}, savedAt: 1 } };
        const merged = mergeDeviceMaps(existing, incoming);
        assert.equal(Object.keys(merged).length, MAX_SAVED_DEVICES);
        assert.ok(merged.fromFile, 'the restored map is the one the import announced');
        assert.equal(merged.mine0, undefined, 'the oldest of my own went instead');
        assert.equal(countDroppedOnMerge(existing, incoming), 1);
        assert.equal(countDroppedOnMerge(existing, {}), 0);
    });

    it('a merge survives a store that holds junk', () => {
        // The existing store comes straight out of localStorage; a throw
        // here would surface as "this backup could not be applied" AFTER
        // the settings were already in.
        const existing = { good: { axes: {}, savedAt: 5 } };
        for (let i = 0; i < MAX_SAVED_DEVICES; i += 1) existing[`n${i}`] = null;
        assert.doesNotThrow(() => mergeDeviceMaps(existing, { fromFile: { axes: {}, savedAt: 9 } }));
        assert.ok(mergeDeviceMaps(existing, { fromFile: { axes: {}, savedAt: 9 } }).fromFile);
    });

    it('a retired field is dropped in silence, not reported as a skip', () => {
        // Every backup written by the build before this one carries
        // customProfiles, and it never meant anything.
        const read = readBackup({ minHr: 70, maxHr: 140, customProfiles: { mine: {} } });
        assert.deepEqual(read.retiredSettingKeys, ['customProfiles']);
        assert.deepEqual(read.unknownSettingKeys, []);
        assert.equal('customProfiles' in read.settings, false);
        assert.ok(!/not a setting this version has/.test(describeBackupImport(read, {})));
    });

    it('a file that says it is a backup is read as one even with a broken settings block', () => {
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: 'oops',
            handy: { role: 'off', maxCap: 20 },
            devices: { intiface: { X: { axes: {}, savedAt: 1 } } },
            flags: { ageVerified: true }
        });
        assert.equal(read.ok, true);
        assert.equal(read.legacy, false, 'it plainly carries a version marker');
        assert.equal(read.settingsUnreadable, true);
        assert.equal(read.handy.role, 'off');
        assert.equal(read.handy.maxCap, 20);
        assert.equal(Object.keys(read.devices.intiface).length, 1);
        assert.equal(read.flags.ageVerified, true);
        const text = describeBackupImport(read, {});
        assert.match(text, /Session Setup block in this file is damaged/);
        assert.ok(!/no version marker/.test(text));
    });

    it('an empty key field is an absent key, not junk in place of one', () => {
        const read = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: { minHr: 70 }, handyConnectionKeyIncluded: false, handyConnectionKey: '' });
        assert.equal(read.keyRejected, false);
        assert.equal(read.keyDeclaredAbsent, true);
        const text = describeBackupImport(read, { hadExistingKey: true });
        assert.match(text, /exported without a Handy connection key/);
        assert.ok(!/not a usable key/.test(text));
        // something that IS there and unusable is still called out
        const junk = readBackup({ minHr: 70, handyConnectionKey: 'has a space' });
        assert.equal(junk.keyRejected, true);
    });

    it('names the flags, and does not say "settings imported" over no settings', () => {
        const flagsOnly = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {}, flags: { ageVerified: true, wizardSeen: true } });
        const text = describeBackupImport(flagsOnly, {});
        assert.match(text, /your age confirmation and whether you have seen the setup guide/);
        assert.ok(!/Settings imported: 0/.test(text));
        const keyOnly = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {}, handyConnectionKey: 'KEY-1' });
        assert.match(describeBackupImport(keyOnly, {}), /Nothing in this file changed a setting here/);
        // and with something else restored, the question is still answered
        assert.match(describeBackupImport(flagsOnly, {}), /carried no Session Setup values, so nothing in Session Setup changed/);
    });

    it('reports the values that survived the clamps, not the values offered', () => {
        const read = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: { minHr: 5, maxHr: 9999 } });
        // What the caller found in the store afterwards: neither survived.
        const text = describeBackupImport(read, { settingsStored: 0 });
        assert.ok(!/Settings imported: 2 Session Setup values/.test(text));
        assert.match(text, /2 values in the file were outside what this app accepts/);
        assert.match(text, /came back at the nearest value it does - a limit, or the factory setting/);
        // one of two
        assert.match(describeBackupImport(read, { settingsStored: 1 }), /Settings imported: 1 Session Setup value\./);
        assert.match(describeBackupImport(read, { settingsStored: 1 }), /1 value in the file was outside/);
        // the honest all-good case says nothing extra
        assert.ok(!/outside what this app accepts/.test(describeBackupImport(read, { settingsStored: 2 })));
    });

    it('says when a file re-paired this browser with a different Handy', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'FROM-FILE-2' });
        const text = describeBackupImport(read, { hadExistingKey: true, keyReplaced: true });
        assert.match(text, /was REPLACED by the one in this file/);
        assert.match(text, /Nothing is connected either way/);
        // the same key twice is not a re-pairing
        assert.ok(!/REPLACED/.test(describeBackupImport(read, { hadExistingKey: true, keyReplaced: false })));
    });

    it('leads with the refused write, because it changes what every other line means', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'KEY-1' });
        const text = describeBackupImport(read, { unsaved: ['settings', 'key'] });
        assert.match(text.split('\n')[0], /THIS BROWSER REFUSED TO SAVE/);
        assert.match(text, /your Session Setup values and your Handy connection key/);
        assert.match(text, /a reload will lose it/);
        assert.ok(!/REFUSED/.test(describeBackupImport(read, { unsaved: [] })));
        // and a part named as lost is never also named as restored
        assert.ok(!/connection key was restored/.test(text), 'the key cannot be both refused and restored');
        const roleRefused = describeBackupImport(readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {}, handy: { role: 'off', maxCap: 40 } }), { unsaved: ['role'] });
        assert.match(roleRefused, /REFUSED TO SAVE the Handy channel role/);
        assert.match(roleRefused, /Settings imported: the Handy speed cap \(now 40%\)\./, 'the cap did save, so the cap alone is what was restored');
        assert.ok(!/channel role \(now/.test(roleRefused));
        // an id this version does not know is still a refusal: dropping it
        // would turn a failed write into a silently positive report
        const unnamed = describeBackupImport(read, { unsaved: ['nonsense'] });
        assert.match(unnamed, /REFUSED TO SAVE one more part of this restore/);
        assert.match(describeBackupImport(read, { unsaved: ['nonsense', 'alsoNonsense'] }), /2 more parts of this restore/);
    });

    it('says when the device-map limit displaced maps that were already here', () => {
        const read = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: { minHr: 70 }, devices: { intiface: { A: { axes: {}, savedAt: 1 } } } });
        assert.match(describeBackupImport(read, { droppedDeviceMaps: 3 }), /3 of the device maps already saved here had to be dropped/);
        assert.ok(!/had to be dropped/.test(describeBackupImport(read, { droppedDeviceMaps: 0 })));
    });
});

describe('app.js keeps its side of the second round', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

    it('checks every storage write the import makes', () => {
        // safeSet returns whether the write landed; announcing a restore a
        // reload will undo is the failure this whole change is about.
        const fn = src.slice(src.indexOf('function applyImportedBackup'), src.indexOf('function countStoredSettings'));
        const writes = fn.match(/safeSet\(/g) || [];
        const checked = fn.match(/!safeSet\(/g) || [];
        assert.equal(writes.length, checked.length, 'every safeSet in the import path must be checked');
        assert.ok(writes.length >= 6, `expected the six restore writes, found ${writes.length}`);
        assert.match(src, /const unsaved = persistSettings\(\) \? \[\] : \[/, 'the settings write is checked too');
        assert.match(src, /unsaved: \[\.\.\.unsaved, \.\.\.applied\.unsaved\]/);
    });

    it('reads an unreadable file out loud instead of doing nothing', () => {
        assert.match(src, /reader\.onerror = \(\) => alert\('That file could not be read/);
    });

    it('paints the export notice before the download starts', () => {
        const handler = src.slice(src.indexOf("getElementById('exportSettingsBtn')"));
        const paint = handler.indexOf('paintExportNotice(');
        const click = handler.indexOf('a.click()');
        assert.ok(paint >= 0 && click >= 0 && paint < click, 'the warning must be on screen before the file is written');
    });

    it('counts what the store kept, not what the file offered', () => {
        assert.match(src, /const settingsStored = countStoredSettings\(result\.requested\);/);
        // The comparison is against what the file ASKED for, so it has to
        // run after the store has been clamped, not before.
        const importer = src.slice(src.indexOf("getElementById('importConfigFile')"));
        const clamp = importer.indexOf('syncGuardSettings();');
        const count = importer.indexOf('countStoredSettings(result.requested)');
        assert.ok(clamp >= 0 && count > clamp, 'count after the clamps, not before');
    });

    it('runs every settings value through the schema, and nothing else', () => {
        // Behaviour, not spelling: a source match passes just as happily
        // over a line that no longer does anything (proven - two guards in
        // this file survived their implementation being gutted).
        assert.equal(sanitizeSetting('ceilingBehaviour', 'melt'), 'crawl');
        assert.equal(sanitizeSetting('ceilingBehaviour', 'stop'), 'stop');
        assert.equal(sanitizeSetting('stallGuard', 'no'), true, 'junk falls back to the factory value, which is ON');
        assert.equal(sanitizeSetting('voiceURI', 42), '');
        // and app.js must call it rather than clamping fields by hand
        assert.match(src, /const corrected = applySettingSchema\(advancedSettings\);/);
    });

    it('leaves both file imports reachable from the keyboard', () => {
        // A <label> around a display:none input is not in the tab order.
        const labels = html.match(/data-file-label="[^"]+"/g) || [];
        assert.equal(labels.length, 2, 'the settings import and the phrase import');
        for (const id of ['importConfigFile', 'voiceCuesImportFile']) {
            const label = html.slice(html.indexOf(`data-file-label="${id}"`) - 200, html.indexOf(`data-file-label="${id}"`) + 40);
            assert.match(label, /tabindex="0"/);
            assert.match(label, /role="button"/);
        }
        assert.match(src, /label\.dataset\.fileLabel/);
        assert.match(src, /e\.key !== 'Enter' && e\.key !== ' '/);
    });

    it('announces the export notice to a screen reader', () => {
        const notice = html.slice(html.indexOf('id="exportKeyNotice"') - 10, html.indexOf('id="exportKeyNotice"') + 120);
        assert.match(notice, /aria-live="polite"/);
        assert.match(notice, /role="status"/);
    });
});

describe('the third round: what the fixes themselves broke', () => {
    it('an unrecognised boolean falls back to the factory value, not to false', () => {
        // Coercing to `false` is the OPPOSITE of the factory value for every
        // setting that ships on - the stall guard among them, the watchdog
        // that halts the primary after too long at the edge. It was switched
        // off by a hand-edited file and reported as "the safe default".
        const booleans = SETTING_KEYS.filter((name) => typeof SETTING_DEFAULTS[name] === 'boolean');
        assert.ok(booleans.includes('stallGuard') && SETTING_DEFAULTS.stallGuard === true, 'the stall guard ships on');
        for (const name of booleans) {
            for (const junk of [1, 0, 2, -1, 'yes', 'no', 'TRUE', 'False', 'on', '1', '', null, [], {}, undefined]) {
                assert.equal(sanitizeSetting(name, junk), SETTING_DEFAULTS[name], `${name} <- ${JSON.stringify(junk)}`);
            }
            assert.equal(sanitizeSetting(name, true), true);
            assert.equal(sanitizeSetting(name, false), false);
            assert.equal(sanitizeSetting(name, 'true'), true);
            assert.equal(sanitizeSetting(name, 'false'), false, 'the string a JSON round-trip of a checkbox can produce');
        }
    });

    it('the role write is verified, so it is the eighth checked write and not the one hole', () => {
        const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const fn = APP.slice(APP.indexOf('function applyImportedBackup'), APP.indexOf('function countStoredSettings'));
        // The role is written inside the button handler, so it is verified
        // by reading it back rather than by a return value.
        assert.match(fn, /safeGet\('handy_role', ''\) !== result\.handy\.role/);
        assert.match(fn, /unsaved\.push\('role'\)/);
        // every part the import writes reports by the same names
        const ids = [...fn.matchAll(/unsaved\.push\('([a-z]+)'\)/g)].map((m) => m[1]);
        assert.deepEqual(ids.sort(), ['cap', 'flags', 'intiface', 'key', 'role', 'tcode']);
        for (const id of ids) assert.ok(RESTORE_PARTS[id], `${id} must be a known restore part`);
    });

    it('a file that only declares itself is not an envelope, and a damaged one still is', () => {
        // Either half of the test alone gets a real file wrong.
        const pollutedLegacy = readBackup({ minHr: 62, maxHr: 158, format: BACKUP_FORMAT });
        assert.equal(pollutedLegacy.ok, true, 'a legacy blob that picked up a stray format field still imports');
        // It carries a marker, so it is not described as marker-less; what
        // matters is that its settings are read from where they actually are.
        assert.equal(pollutedLegacy.legacy, false);
        assert.equal(readBackup({ minHr: 62, maxHr: 158 }).legacy, true, 'a blob with no marker at all is still legacy');
        assert.equal(pollutedLegacy.settings.minHr, 62);

        const declaredByVersion = readBackup({ version: 2, settings: 'oops', handy: { role: 'off', maxCap: 20 }, flags: { ageVerified: true, wizardSeen: false } });
        assert.equal(declaredByVersion.ok, true, 'a declared backup with a damaged settings block keeps the rest');
        assert.equal(declaredByVersion.legacy, false);
        assert.equal(declaredByVersion.settingsUnreadable, true);
        assert.equal(declaredByVersion.handy.role, 'off');
        assert.equal(declaredByVersion.handy.maxCap, 20);
        assert.equal(declaredByVersion.flags.ageVerified, true);

        // and the ordinary shapes are unchanged
        assert.equal(readBackup(buildBackup(STORES, { now: NOW })).legacy, false);
        assert.equal(readBackup({ minHr: 70 }).legacy, true);
        assert.equal(readBackup({ minHr: 61, version: 2 }).settings.minHr, 61, 'a stray version field does not hide the settings');
        assert.equal(readBackup({ format: BACKUP_FORMAT, version: '2', settings: { minHr: 61 } }).version, 2, 'a version written as a string still reads as 2');
    });

    it('a corrected value is visible as corrected, and key order is not a correction', () => {
        const read = readBackup({ minHr: 70, learningProfile: { breakthroughEvents: 99999, suggestedMaxHrOffset: 500, lastBreakthroughHr: 9 } });
        assert.deepEqual(read.settings.learningProfile, { breakthroughEvents: 9999, suggestedMaxHrOffset: MAX_LEARNED_OFFSET_BPM, lastBreakthroughHr: null });
        // The count compares the store against `requested`, so what the app
        // corrected differs and is reported as corrected - with no second
        // list to keep in step.
        assert.deepEqual(read.requested.learningProfile, { breakthroughEvents: 99999, suggestedMaxHrOffset: 500, lastBreakthroughHr: 9 });
        // A backup re-serialised by any tool (jq -S) carries the same values
        // in another key order. That is not a correction, and the count says
        // so - app.js compares canonically.
        const sorted = { lastBreakthroughHr: 141, breakthroughEvents: 3, suggestedMaxHrOffset: 9 };
        const readSorted = readBackup({ minHr: 70, learningProfile: sorted });
        assert.deepEqual(readSorted.settings.learningProfile, { breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 });
    });

    it('says a refused value came back at the nearest the app takes, not at the default', () => {
        // stallGuardSeconds 9999 comes back at the 120-second maximum, not
        // at the 20-second factory setting: "reverted to the default" would
        // send the reader looking for a number that is not there.
        const read = readBackup({ stallGuardSeconds: 9999 });
        const text = describeBackupImport(read, { settingsStored: 0 });
        assert.match(text, /came back at the nearest value it does - a limit, or the factory setting/);
        assert.ok(!/safe default/.test(text));
        assert.match(text, /open Session Setup to see where it landed/);
    });

    it('a garbage phrase list restored nothing and is not counted as a value', () => {
        const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const fn = APP.slice(APP.indexOf('function countStoredSettings'), APP.indexOf('function countStoredSettings') + 1200);
        // [].every() is true, so a non-object voiceCues counted as restored.
        assert.match(fn, /if \(!value \|\| typeof value !== 'object' \|\| Array\.isArray\(value\)\) continue;/);
    });

    it('a download that never starts leaves no claim and no leaked object URL', () => {
        const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const handler = APP.slice(APP.indexOf("getElementById('exportSettingsBtn')"), APP.indexOf("getElementById('exportSettingsBtn')") + 2500);
        assert.match(handler, /try \{\s*a\.click\(\);/);
        assert.match(handler, /The download did not start, so nothing was written/);
        assert.match(handler, /\} finally \{\s*URL\.revokeObjectURL\(url\);/);
    });
});

describe('the fourth round: the message read as a whole', () => {
    // Every earlier message test greps for one line. Nothing asserted that
    // the lines agree with each other - and three of them did not.
    const CONTRADICTIONS = [
        [/Nothing in this file changed a setting here/, /outside what this app accepts/],
        [/Nothing in this file changed a setting here/, /REFUSED TO SAVE/],
        [/carried no Session Setup values/, /Session Setup block in this file is damaged/],
        [/connection key was restored/, /REFUSED TO SAVE your Handy connection key/],
        [/Settings imported: the Handy channel role/, /REFUSED TO SAVE the Handy channel role/],
        [/Settings imported: the Handy speed cap/, /REFUSED TO SAVE the Handy speed cap/]
    ];
    const FILES = {
        'a normal backup': [buildBackup(STORES, { includeKey: true, now: NOW }), {}],
        'an older blob': [{ minHr: 66, maxHr: 158 }, {}],
        'a newer version': [{ format: BACKUP_FORMAT, version: 9, settings: { minHr: 66 } }, {}],
        'all values out of range': [{ stallGuardSeconds: 9999, trainEdges: 999, decayFloor: 5 }, { settingsStored: 0, settingsChanged: true }],
        'a damaged block': [{ format: BACKUP_FORMAT, version: 2, settings: 'oops', handy: { role: 'off', maxCap: 40 } }, {}],
        'flags only': [{ format: BACKUP_FORMAT, version: 2, settings: {}, flags: { ageVerified: true, wizardSeen: true } }, {}],
        'key only': [{ format: BACKUP_FORMAT, version: 2, settings: {}, handyConnectionKey: 'K-1' }, {}],
        'a key that replaces one': [{ minHr: 70, handyConnectionKey: 'K-2' }, { hadExistingKey: true, keyReplaced: true }],
        'nothing saved at all': [buildBackup(STORES, { includeKey: true, now: NOW }), { unsaved: ['settings', 'key', 'role', 'cap', 'intiface', 'tcode', 'flags'], settingsChanged: true }],
        'settings refused, file had none': [{ format: BACKUP_FORMAT, version: 2, settings: {}, handy: { role: 'off' } }, { unsaved: ['settings'] }],
        'a foreign file': [{ someOtherApp: true }, {}],
        'device maps displaced': [{ format: BACKUP_FORMAT, version: 2, settings: { minHr: 70 }, devices: { intiface: { a: { axes: {}, savedAt: 1 } } } }, { droppedDeviceMaps: 3 }],
        'a file this app corrected in part': [{ minHr: 66, stallGuardSeconds: 9999 }, { settingsStored: 1, settingsChanged: true }],
        'unreadable profile': [{ minHr: 70, learningProfile: 'yes' }, { settingsStored: 1, settingsChanged: true }],
        'a hostile key': [{ minHr: 70, handyConnectionKey: 'has a space' }, { hadExistingKey: true }]
    };

    for (const [label, [file, context]] of Object.entries(FILES)) {
        it(`reads coherently: ${label}`, () => {
            const text = describeBackupImport(readBackup(file), context);
            for (const [a, b] of CONTRADICTIONS) {
                assert.ok(!(a.test(text) && b.test(text)),
                    `these two lines cannot both be true:\n${a}\n${b}\n---\n${text}`);
            }
            // no placeholder, no raw id, no empty list, no double space
            assert.ok(!/undefined|NaN|\[object|null/.test(text), text);
            assert.ok(!/REFUSED TO SAVE \./.test(text), text);
            assert.ok(!/ {2}/.test(text), text);
            assert.ok(text.trim().length > 0);
            // every paragraph is a sentence
            for (const para of text.split('\n\n')) {
                assert.match(para.trim(), /[.!]$/, `paragraph does not end in a full stop: ${para}`);
            }
        });
    }

    it('says something changed only when something changed', () => {
        const read = readBackup({ stallGuardSeconds: 9999 });
        assert.match(describeBackupImport(read, { settingsStored: 0, settingsChanged: true }),
            /No value in this file could be used exactly as written, but it did change settings here/);
        assert.match(describeBackupImport(read, { settingsStored: 0, settingsChanged: false }),
            /Nothing in this file changed a setting here/);
    });

    it('does not tell a user their Session Setup is untouched over a damaged block', () => {
        const read = readBackup({ format: BACKUP_FORMAT, version: 2, settings: 'oops', flags: { ageVerified: true } });
        const text = describeBackupImport(read, {});
        assert.match(text, /damaged/);
        assert.ok(!/carried no Session Setup values/.test(text));
    });
});

describe('the fourth round: an import is not something to do mid-session', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('refuses while a session is running, before the file is even read', () => {
        const handler = src.slice(src.indexOf("getElementById('importConfigFile')"));
        const guard = handler.indexOf("state.sessionStatus !== 'IDLE'");
        const read = handler.indexOf('readAsText');
        assert.ok(guard >= 0, 'a restore reaches the motors on the tick it happens');
        assert.ok(guard < read, 'and the refusal has to come before the file is read');
        assert.match(handler.slice(guard, guard + 700), /Stop the session first/);
    });

    it('clears the picker so the same file can be imported once the session ends', () => {
        const handler = src.slice(src.indexOf("getElementById('importConfigFile')"));
        const guard = handler.indexOf("state.sessionStatus !== 'IDLE'");
        assert.match(handler.slice(guard, guard + 700), /e\.target\.value = '';/);
    });

    it('only the migration a store has never seen may run', () => {
        // A file can carry `envelopeMigrated: false`; re-running the 15/85
        // migration on it wipes the envelope the user just restored.
        assert.match(src, /hasOwnProperty\.call\(parsed, 'envelopeMigrated'\)/);
    });
});

describe('app.js routes the backup through this module', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('builds and reads the file here rather than inline', () => {
        assert.ok(/from '\.\/backup\.js'/.test(src), 'app.js must import backup.js');
        assert.ok(/buildBackup\(/.test(src));
        assert.ok(/readBackup\(/.test(src));
        assert.ok(/describeBackupImport\(/.test(src));
    });

    it('strips the file fields before merging a parsed file into the settings store', () => {
        const merge = src.indexOf('Object.assign(advancedSettings, result.settings)');
        const prune = src.indexOf('pruneReservedKeys(advancedSettings)');
        assert.ok(prune >= 0, 'app.js must prune the reserved names from the live store');
        assert.ok(merge >= 0 && prune < merge, 'the prune has to happen BEFORE the merge');
    });

    it('repaints the learning line after an import applies a restored profile', () => {
        const apply = src.indexOf('applyImportedBackup(result);');
        const paint = src.indexOf('renderLearningStatus();', apply);
        const alerted = src.indexOf('alert(describeBackupImport(result, {', apply);
        assert.ok(apply >= 0 && paint > apply && paint < alerted,
            'the panel has to be repainted before the import reports what it did');
    });

    it('tells a non-JSON file apart from an invalid backup', () => {
        assert.ok(/That file is not JSON/.test(src), 'a wrong-file pick gets its own message');
        assert.ok(!/alert\("Invalid configuration file\."\)/.test(src), 'the one-size-fits-all message is gone');
    });

    it('never writes an empty connection key over a saved one', () => {
        const write = /safeSet\('handy_connection_key'/g;
        const writes = src.match(write) || [];
        assert.equal(writes.length, 2, 'the key is written by the Connect button and by a restore, nowhere else');
        assert.ok(/if \(result\.keyPresent\)/.test(src), 'the restore writes the key only when the file carried one');
    });
});
