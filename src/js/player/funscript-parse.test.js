import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    parseFunscript,
    checkFunscriptSize,
    describeDropped,
    scriptHash,
    scriptDigestHex,
    FUNSCRIPT_MAX_BYTES,
    FUNSCRIPT_MAX_ACTIONS,
    FUNSCRIPT_MAX_AT_MS
} from './funscript-parse.js';

const file = (actions, extra = {}) => JSON.stringify({ version: '1.0', ...extra, actions });
const pairs = (track) => Array.from(track.at, (at, i) => [at, track.pos[i]]);

describe('parseFunscript: garbage and empty input', () => {
    for (const [label, text] of [
        ['not a string', 42],
        ['null', null],
        ['an empty string', ''],
        ['whitespace', '   \n'],
        ['invalid JSON', '{"actions": [ {"at": 0, "pos": 1}'],
        ['a JSON array', '[{"at":0,"pos":0},{"at":100,"pos":100}]'],
        ['JSON null', 'null'],
        ['a number', '12'],
        ['no actions key', '{"version":"1.0"}'],
        ['actions not an array', '{"actions":{"at":0,"pos":0}}'],
        ['an empty actions list', '{"actions":[]}']
    ]) {
        it(`refuses ${label} with a reason and no track`, () => {
            const result = parseFunscript(text);
            assert.equal(result.ok, false);
            assert.equal(result.track, null);
            assert.equal(typeof result.error, 'string');
            assert.ok(result.error.length > 10, result.error);
        });
    }

    it('refuses a file whose actions are all unusable, and counts them', () => {
        const result = parseFunscript(file([null, 3, 'x', [], { at: 'a', pos: 1 }, { at: 1 }, { pos: 5 }]));
        assert.equal(result.ok, false);
        assert.match(result.error, /no usable actions/);
        assert.equal(result.dropped.notAction, 4);
        assert.equal(result.dropped.badAt, 2);
        assert.equal(result.dropped.badPos, 1);
    });
});

describe('parseFunscript: a 1-action file is refused', () => {
    it('refuses one action', () => {
        const result = parseFunscript(file([{ at: 500, pos: 50 }]));
        assert.equal(result.ok, false);
        assert.match(result.error, /only one usable action/);
    });

    it('refuses two actions that collapse into one time', () => {
        const result = parseFunscript(file([{ at: 500, pos: 50 }, { at: 500, pos: 80 }]));
        assert.equal(result.ok, false);
        assert.equal(result.dropped.duplicates, 1);
    });

    it('a caller cannot lower the minimum below two', () => {
        assert.equal(parseFunscript(file([{ at: 0, pos: 0 }]), { minActions: 1 }).ok, false);
    });

    it('accepts two actions', () => {
        const result = parseFunscript(file([{ at: 0, pos: 0 }, { at: 400, pos: 100 }]));
        assert.equal(result.ok, true);
        assert.deepEqual(pairs(result.track), [[0, 0], [400, 100]]);
        assert.equal(result.error, null);
    });
});

describe('parseFunscript: huge input', () => {
    it('refuses text longer than the byte limit before parsing it', () => {
        const result = parseFunscript('x'.repeat(2049), { maxBytes: 2048 });
        assert.equal(result.ok, false);
        assert.match(result.error, /too large/);
    });

    it('refuses more actions than the limit', () => {
        const actions = Array.from({ length: 11 }, (_, i) => ({ at: i * 100, pos: i % 2 ? 100 : 0 }));
        const result = parseFunscript(file(actions), { maxActions: 10 });
        assert.equal(result.ok, false);
        assert.match(result.error, /too many actions/);
        assert.equal(parseFunscript(file(actions.slice(0, 10)), { maxActions: 10 }).ok, true);
    });

    it('has the documented default limits', () => {
        assert.equal(FUNSCRIPT_MAX_BYTES, 32 * 1024 * 1024);
        assert.equal(FUNSCRIPT_MAX_ACTIONS, 1000000);
        assert.equal(FUNSCRIPT_MAX_AT_MS, 24 * 3600 * 1000);
    });

    it('parses a four-hour script at ten actions a second quickly into typed arrays', () => {
        const n = 144000;
        const actions = Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: i % 2 ? 90 : 10 }));
        const text = file(actions);
        const started = process.hrtime.bigint();
        const result = parseFunscript(text);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(result.ok, true);
        assert.ok(result.track.at instanceof Int32Array);
        assert.ok(result.track.pos instanceof Uint8Array);
        assert.equal(result.track.at.length, n);
        assert.equal(result.meta.durationMs, (n - 1) * 100);
        assert.ok(ms < 2000, `parsing took ${ms} ms`);
    });

    it('checkFunscriptSize refuses by size before a read', () => {
        assert.equal(checkFunscriptSize(1024).ok, true);
        assert.equal(checkFunscriptSize(FUNSCRIPT_MAX_BYTES).ok, true);
        const big = checkFunscriptSize(FUNSCRIPT_MAX_BYTES + 1);
        assert.equal(big.ok, false);
        assert.match(big.error, /too large/);
        assert.equal(checkFunscriptSize(NaN).ok, false);
        assert.equal(checkFunscriptSize(-1).ok, false);
        assert.equal(checkFunscriptSize(3000, { maxBytes: 2000 }).ok, false);
    });
});

describe('parseFunscript: non-finite and out-of-range values', () => {
    it('drops actions without a finite time, clamps positions, rounds fractional times', () => {
        const text = '{"actions":['
            + '{"at":0,"pos":10},'
            + '{"at":"100","pos":20},'
            + '{"at":1e999,"pos":20},'
            + '{"at":-5,"pos":20},'
            + `{"at":${FUNSCRIPT_MAX_AT_MS + 1},"pos":20},`
            + '{"at":200,"pos":-40},'
            + '{"at":300,"pos":140},'
            + '{"at":400.4,"pos":55.6},'
            + '{"at":500,"pos":"50"},'
            + '{"at":600,"pos":null}'
            + ']}';
        const result = parseFunscript(text);
        assert.equal(result.ok, true);
        assert.deepEqual(pairs(result.track), [[0, 10], [200, 0], [300, 100], [400, 56]]);
        assert.equal(result.dropped.badAt, 2);
        assert.equal(result.dropped.outOfRange, 2);
        assert.equal(result.dropped.badPos, 2);
        assert.equal(result.dropped.clampedPos, 2);
        assert.equal(result.dropped.roundedAt, 1);
        assert.match(describeDropped(result.dropped), /6 unusable actions left out/);
        assert.match(describeDropped(result.dropped), /2 positions outside 0-100 clamped/);
    });

    it('keeps an action exactly at 0 and exactly at the time limit', () => {
        const result = parseFunscript(file([{ at: 0, pos: 0 }, { at: FUNSCRIPT_MAX_AT_MS, pos: 100 }]));
        assert.equal(result.ok, true);
        assert.equal(result.meta.durationMs, FUNSCRIPT_MAX_AT_MS);
    });
});

describe('parseFunscript: order and duplicates', () => {
    it('sorts unsorted actions by time', () => {
        const result = parseFunscript(file([
            { at: 900, pos: 90 }, { at: 100, pos: 10 }, { at: 500, pos: 50 }, { at: 300, pos: 30 }
        ]));
        assert.deepEqual(pairs(result.track), [[100, 10], [300, 30], [500, 50], [900, 90]]);
    });

    it('keeps the last of several actions at one time, in file order', () => {
        const result = parseFunscript(file([
            { at: 0, pos: 0 }, { at: 200, pos: 20 }, { at: 100, pos: 1 }, { at: 200, pos: 70 }, { at: 100, pos: 2 }
        ]));
        assert.deepEqual(pairs(result.track), [[0, 0], [100, 2], [200, 70]]);
        assert.equal(result.dropped.duplicates, 2);
        assert.match(describeDropped(result.dropped), /2 duplicate times merged/);
    });
});

describe('parseFunscript: meta', () => {
    it('reads inverted only when it is literally true', () => {
        const actions = [{ at: 0, pos: 0 }, { at: 100, pos: 100 }];
        assert.equal(parseFunscript(file(actions, { inverted: true })).meta.inverted, true);
        assert.equal(parseFunscript(file(actions, { inverted: 'true' })).meta.inverted, false);
        assert.equal(parseFunscript(file(actions)).meta.inverted, false);
    });

    it('notes a range other than 100 and never applies it', () => {
        const actions = [{ at: 0, pos: 0 }, { at: 100, pos: 100 }];
        const ranged = parseFunscript(file(actions, { range: 90 }));
        assert.equal(ranged.meta.range, 90);
        assert.equal(ranged.meta.rangeNoted, true);
        assert.deepEqual(pairs(ranged.track), [[0, 0], [100, 100]]);
        const plain = parseFunscript(file(actions));
        assert.equal(plain.meta.range, 100);
        assert.equal(plain.meta.rangeNoted, false);
        assert.equal(parseFunscript(file(actions, { range: 'big' })).meta.rangeNoted, false);
    });

    it('starts at the first action: nothing is invented before it (implicit start)', () => {
        const result = parseFunscript(file([{ at: 12000, pos: 80 }, { at: 12500, pos: 10 }]));
        assert.equal(result.ok, true);
        assert.equal(result.track.at[0], 12000);
        assert.equal(result.meta.firstAtMs, 12000);
        assert.equal(result.meta.durationMs, 12500);
        assert.equal(result.meta.actions, 2);
    });

    it('carries chapters, bounded, and flags a multi-axis file', () => {
        const chapters = [
            { name: 'Intro', startTime: '00:00:01.5', endTime: '00:01:00.000' },
            { name: 'x'.repeat(500), startTime: 61000, endTime: 1000 },
            { name: 'bad', startTime: 'soon' },
            7
        ];
        const result = parseFunscript(file([{ at: 0, pos: 0 }, { at: 100, pos: 100 }], {
            metadata: { chapters }, axes: [{ id: 'R0', actions: [] }]
        }));
        assert.deepEqual(result.meta.chapters[0], { name: 'Intro', startMs: 1500, endMs: 60000 });
        assert.equal(result.meta.chapters[1].name.length, 100);
        assert.equal(result.meta.chapters[1].endMs, null);
        assert.equal(result.meta.chapters.length, 2);
        assert.equal(result.meta.hasAxes, true);
    });
});

describe('scriptHash', () => {
    const a = parseFunscript(file([{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }])).track;

    it('is five bytes per action: time little-endian, then position', () => {
        const bytes = scriptHash(a);
        assert.equal(bytes.length, 15);
        assert.deepEqual(Array.from(bytes.slice(5, 10)), [0x90, 0x01, 0, 0, 100]);
    });

    it('depends on the actions only, not on formatting or metadata', () => {
        const b = parseFunscript(JSON.stringify({
            inverted: true,
            metadata: { title: 'another name' },
            actions: [{ pos: 0, at: 800 }, { pos: 100, at: 400 }, { pos: 0, at: 0 }]
        })).track;
        assert.deepEqual(scriptHash(b), scriptHash(a));
        const c = parseFunscript(file([{ at: 0, pos: 0 }, { at: 400, pos: 99 }, { at: 800, pos: 0 }])).track;
        assert.notDeepEqual(scriptHash(c), scriptHash(a));
    });

    it('digests to SHA-256 hex', async () => {
        const hex = await scriptDigestHex(a);
        assert.match(hex, /^[0-9a-f]{64}$/);
        assert.equal(hex, createHash('sha256').update(scriptHash(a)).digest('hex'));
        await assert.rejects(scriptDigestHex(a, null), /SHA-256/);
    });
});
