// The guard that would have caught the hole: every Session Setup field has
// a sanitizer, and a field with none fails here rather than reaching the
// engine unchecked.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTING_KEYS, SETTING_DEFAULTS } from './state.js';
import { sanitizeSessionLimits } from './session-rules.js';
import { normalizeEnvelope } from './hardware/handy-protocol.js';
import {
    SETTING_SANITIZERS,
    CROSS_FIELD_OWNERS,
    applySettingSchema,
    sanitizeSetting,
    sanitizeLearningProfile,
    MAX_SESSION_MINUTES,
    MAX_LEARNED_OFFSET_BPM
} from './settings-schema.js';

const INDEX = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// Values no control can produce, offered to every field in turn.
const JUNK = [undefined, null, '', 'yes', 'melt', -1e9, 1e9, NaN, Infinity, -0.5, [], {}, true, false, '9e99'];

describe('every setting has a bound', () => {
    it('no field in SETTING_KEYS is without a sanitizer', () => {
        const missing = SETTING_KEYS.filter((name) => typeof SETTING_SANITIZERS[name] !== 'function');
        assert.deepEqual(missing, [],
            `these fields reach the engine with whatever a file says: add a sanitizer in settings-schema.js. This is the test that would have caught gammaCurve, which had no control, no clamp, and set the exponent on the curve both motors follow.`);
    });

    it('and no sanitizer is for a field that no longer exists', () => {
        const extra = Object.keys(SETTING_SANITIZERS).filter((name) => !SETTING_KEYS.includes(name));
        assert.deepEqual(extra, []);
    });

    it('every sanitizer survives junk and returns something the factory would recognise', () => {
        for (const name of SETTING_KEYS) {
            // A pair field is passed to its owner untouched on purpose, so
            // it is the owner's job to make sense of junk (asserted below).
            if (CROSS_FIELD_OWNERS[name] && SETTING_SANITIZERS[name].length === 1 && sanitizeSetting(name, '@@') === '@@') continue;
            const factoryType = typeof SETTING_DEFAULTS[name];
            for (const junk of JUNK) {
                const out = sanitizeSetting(name, junk);
                assert.equal(typeof out, factoryType, `${name} <- ${JSON.stringify(junk)} produced a ${typeof out}`);
                if (factoryType === 'number') {
                    assert.ok(Number.isFinite(out), `${name} <- ${JSON.stringify(junk)} produced ${out}`);
                }
            }
        }
    });

    it('a factory settings object passes through unchanged', () => {
        // Whatever the bounds are, they have to admit the values the app
        // ships with, or a fresh install would be corrected on every boot.
        const fresh = JSON.parse(JSON.stringify(SETTING_DEFAULTS));
        const corrected = applySettingSchema(fresh);
        assert.deepEqual(corrected.filter((name) => name !== 'voiceCues'), [],
            'the factory values must be inside their own bounds');
    });

    it('names an owner for every field a single value cannot decide', () => {
        // The pairs - the HR limits, the duration window, the envelope -
        // are bounded here and reconciled by the owner named here.
        for (const [name, owner] of Object.entries(CROSS_FIELD_OWNERS)) {
            assert.ok(SETTING_KEYS.includes(name), `${name} is not a setting`);
            assert.ok(typeof owner === 'string' && owner.includes('.'), `${name} needs a real owner`);
        }
        assert.ok(CROSS_FIELD_OWNERS.minHr && CROSS_FIELD_OWNERS.handyHwMax);
    });
});

describe('the fields with no control at all', () => {
    // gammaCurve is the exponent on the progress term that drives BOTH
    // channels. A one-field imported file set it to 200, and with
    // pow(progress, 200) collapsing to zero the engine stops backing off as
    // the pulse climbs: measured live, both channels went from 48% to 100%
    // at 120 BPM against a typed ceiling of 140. It has no control, so
    // nothing but the factory value can be meant by it.
    const PINNED = ['gammaCurve', 'edgeStrokeDepth'];

    it('are pinned to the factory value', () => {
        for (const name of PINNED) {
            for (const attempt of [200, 0.001, -5, '3', 100, 2]) {
                assert.equal(sanitizeSetting(name, attempt), SETTING_DEFAULTS[name], `${name} must ignore ${attempt}`);
            }
        }
    });

    it('and this test fails the day one of them gets a control', () => {
        // A pinned field with a control would silently ignore what the user
        // typed. If this fails, the field has a UI now: give it the bounds
        // of that control in settings-schema.js and take it off this list.
        for (const name of PINNED) {
            assert.ok(!INDEX.includes(name), `index.html now references ${name} - give it real bounds`);
            const writes = new RegExp(`advancedSettings\\.${name}\\s*=`).test(APP);
            assert.ok(!writes, `app.js now writes ${name} - give it real bounds`);
        }
    });
});

describe('the bounds are the ones the controls carry', () => {
    const cases = [
        ['warmupMinutes', 99, 10], ['warmupMinutes', -4, 0],
        ['decayEdgeCount', 99, 10], ['decayEdgeCount', 0, 1],
        ['decayBpm', 99, 5], ['decayBpm', 0, 1],
        ['decayFloor', 999, 130], ['decayFloor', 9, 80],
    ];
    for (const [name, input, expected] of cases) {
        it(`${name} ${input} -> ${expected}`, () => {
            assert.equal(sanitizeSetting(name, input), expected);
        });
    }

    it('matches what index.html says for the inputs that have one', () => {
        // If a control's own min/max changes, the clamp has to change with
        // it or the panel and the store disagree.
        const bounds = {
            warmupInput: ['warmupMinutes', 0, 10],
            orgasmSettleSecondsInput: ['orgasmSettleSeconds', 0, 180],
            speedSlowestInput: ['speedSlowest', 0, 100],
            speedFastestInput: ['speedFastest', 0, 100],
            decayEdgeCountInput: ['decayEdgeCount', 1, 10],
            decayBpmInput: ['decayBpm', 1, 5],
            decayFloorInput: ['decayFloor', 80, 130]
        };
        for (const [id, [name, min, max]] of Object.entries(bounds)) {
            const tag = INDEX.slice(INDEX.indexOf(`id="${id}"`) - 120, INDEX.indexOf(`id="${id}"`) + 160);
            assert.match(tag, new RegExp(`min="${min}"`), `${id} should carry min="${min}"`);
            assert.match(tag, new RegExp(`max="${max}"`), `${id} should carry max="${max}"`);
            assert.equal(sanitizeSetting(name, min), min);
            assert.equal(sanitizeSetting(name, max), max);
            assert.equal(sanitizeSetting(name, max + 1000), max);
        }
    });
});

describe('the fields a single value cannot decide', () => {
    it('a length outside the window is refused, not clamped to the nearest minute', () => {
        // Clamping -3 to 1 here would hand the owner a "valid" one-minute
        // session the user never asked for; the owner refuses the length
        // and falls back to the factory one. The smoke run caught exactly
        // this, which is why the duration fields are passed through.
        assert.equal(sanitizeSetting('durationFixedMinutes', -3), -3, 'passed through, not clamped');
        for (const bad of [-3, 0, 99999, MAX_SESSION_MINUTES + 1]) {
            assert.equal(sanitizeSessionLimits({ durationMode: 'fixed', durationFixedMinutes: bad }).durationFixedMinutes,
                SETTING_DEFAULTS.durationFixedMinutes, `${bad} must fall back to the factory length`);
        }
        assert.equal(sanitizeSessionLimits({ durationMode: 'fixed', durationFixedMinutes: MAX_SESSION_MINUTES }).durationFixedMinutes, MAX_SESSION_MINUTES);
        assert.equal(sanitizeSessionLimits({ durationMode: 'fixed', durationFixedMinutes: 42 }).durationFixedMinutes, 42);
    });

    it('are handed to their owner untouched, and the owner refuses the pair', () => {
        // Clamping each end first would turn "this pair is nonsense, use
        // the factory 70/140" into "30 and 250 are both in range, keep
        // them" - a Climax HR of 250 restored from a file that asked for
        // 9999. Proven end to end through the owner.
        assert.equal(sanitizeSetting('minHr', 9), 9, 'passed through, not clamped');
        assert.deepEqual(
            (({ minHr, maxHr }) => ({ minHr, maxHr }))(sanitizeSessionLimits({ minHr: 5, maxHr: 9999 })),
            { minHr: SETTING_DEFAULTS.minHr, maxHr: SETTING_DEFAULTS.maxHr },
            'a nonsense pair falls back to the factory pair, as the README says'
        );
        // a pair that is merely extreme, but legal, is the user's to choose
        const wide = sanitizeSessionLimits({ minHr: 30, maxHr: 250 });
        assert.equal(wide.maxHr, 250);
    });

    it('the envelope pair is ordered and spaced by its owner', () => {
        const env = normalizeEnvelope(900, -4);
        assert.ok(env.min >= 0 && env.max <= 100 && env.min < env.max, JSON.stringify(env));
        assert.equal(sanitizeSetting('handyHwMax', 900), 900, 'passed through to the owner');
    });
});

describe('the learning profile', () => {
    it('cannot raise the working ceiling', () => {
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: -60 }).suggestedMaxHrOffset, 0);
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: 999 }).suggestedMaxHrOffset, MAX_LEARNED_OFFSET_BPM);
    });

    it('keeps a plausible one and zeroes an unreadable one', () => {
        assert.deepEqual(sanitizeLearningProfile({ breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 }),
            { breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 });
        assert.deepEqual(sanitizeLearningProfile('nope'), SETTING_DEFAULTS.learningProfile);
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: 9000 }).lastBreakthroughHr, null);
    });
});

describe('applySettingSchema', () => {
    it('reports exactly what it changed', () => {
        const settings = { minHr: 70, decayFloor: 9999, stallGuard: 1, gammaCurve: 200 };
        const corrected = applySettingSchema(settings).sort();
        assert.deepEqual(corrected, ['decayFloor', 'gammaCurve', 'stallGuard']);
        assert.equal(settings.minHr, 70);
        assert.equal(settings.decayFloor, 130);
        assert.equal(settings.stallGuard, SETTING_DEFAULTS.stallGuard);
        assert.equal(settings.gammaCurve, SETTING_DEFAULTS.gammaCurve);
    });

    it('is idempotent, so running it twice never reports a second correction', () => {
        const settings = { maxHr: 9999, decayFloor: 5, voiceCues: { edge: ['One.'] } };
        applySettingSchema(settings);
        assert.deepEqual(applySettingSchema(settings), []);
    });

    it('touches only the fields the object actually has', () => {
        const settings = { minHr: 70 };
        applySettingSchema(settings);
        assert.deepEqual(Object.keys(settings), ['minHr']);
    });

    it('survives a non-object', () => {
        assert.deepEqual(applySettingSchema(null), []);
        assert.deepEqual(applySettingSchema('x'), []);
    });
});
