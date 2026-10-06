import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    calculateEngineOutputs,
    ENGINE_MODES,
    resolveEngineMode,
    resolveCeilingBehaviour,
    hasReleasedEdge,
    EDGE_RELEASE_BPM,
    MIN_ZONE_WIDTH,
    CRAWL_PERCENT,
    SHORTENER_TOP_PERCENT,
    clampEdgeHoldPercent,
    resolveEdgeTriggerHr,
    describeEdgeHoldPreview,
    DEFAULT_EDGE_HOLD_PERCENT,
    MIN_EDGE_HOLD_PERCENT,
    MAX_EDGE_HOLD_PERCENT,
    gameEdgeReleased,
    micBoostReachesMotors
} from './engine.js';

const running = {
    hr: 95,
    minHr: 70,
    maxHr: 140,
    sessionStatus: 'RUNNING',
    rampdownSecondsLeft: 45,
    isEdged: false,
    orgasmMode: false,
    sessionSeconds: 20,
    warmupMinutes: 0,
    ceilingBehaviour: 'stop',
    stallGuardEngaged: false,
    oracleState: 'APPROACH',
    survivalSpeedFloor: 42
};

describe('engine modes', () => {
    it('lists every cockpit mode', () => {
        assert.deepEqual(ENGINE_MODES, [
            'classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin', 'oracle', 'survival', 'edgetrain', 'calibrate'
        ]);
    });

    it('falls unknown modes back to classic', () => {
        assert.equal(resolveEngineMode('not-a-mode'), 'classic');
        const unknown = calculateEngineOutputs({ ...running, activeMode: 'ghost' });
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic' });
        assert.equal(unknown.resolvedMode, 'classic');
        assert.equal(unknown.primaryPercent, classic.primaryPercent);
    });

    for (const mode of ENGINE_MODES) {
        it(`${mode} produces output while running mid-HR`, () => {
            const result = calculateEngineOutputs({ ...running, activeMode: mode });
            assert.equal(result.resolvedMode, mode);
            const moving = result.primaryPercent + result.secondaryPercent;
            assert.ok(moving > 0, `${mode} should not be a dead zero-output path`);
            assert.ok(result.strokeMaxPercent >= result.strokeMinPercent);
        });

        it(`${mode} is idle-safe`, () => {
            const result = calculateEngineOutputs({ ...running, activeMode: mode, sessionStatus: 'IDLE' });
            assert.equal(result.primaryPercent, 0);
            assert.equal(result.secondaryPercent, 0);
        });
    }

    it('a pause keeps the edge flag, so resuming does not count a phantom edge', () => {
        // The master clock calls the engine every second in every status and
        // writes result.isEdged straight back. Clearing the flag while paused
        // re-armed the detector, so the first RUNNING tick counted a brand
        // new edge: +1 on the counter, the 'edge' cue spoken, a connected
        // rotator reversed, and Adaptive Ceiling Decay walking the working
        // ceiling down. The heart-rate watchdog pauses and (with auto-resume,
        // the default) restarts the session by itself, so a strap that drops
        // one packet burst did this without the wearer touching anything.
        const atMark = { ...running, activeMode: 'classic', hr: 140, isEdged: true };
        const first = calculateEngineOutputs(atMark);
        assert.equal(first.isEdged, true);

        for (const status of ['PAUSED', 'IDLE', 'STOPPED']) {
            const paused = calculateEngineOutputs({ ...atMark, sessionStatus: status });
            assert.equal(paused.primaryPercent, 0, `${status} must still silence the motors`);
            assert.equal(paused.secondaryPercent, 0);
            assert.equal(paused.newEdgeTriggered, false);
            assert.equal(paused.isEdged, true, `${status} must not release the edge`);

            const resumed = calculateEngineOutputs({ ...atMark, isEdged: paused.isEdged });
            assert.equal(resumed.newEdgeTriggered, false, `resuming after ${status} must not count a new edge`);
        }

        // A session that was never edged still resumes un-edged.
        const clean = calculateEngineOutputs({ ...running, sessionStatus: 'PAUSED', isEdged: false, hr: 140 });
        assert.equal(clean.isEdged, false);
    });

    it('classic full-stops at the ceiling with Full Stop selected', () => {
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'stop'
        });
        assert.equal(result.primaryPercent, 0);
        assert.equal(result.secondaryPercent, 0);
        assert.equal(result.isEdged, true);
    });

    it('classic crawls at the ceiling with Crawl selected, then stall-halts', () => {
        const crawl = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'crawl'
        });
        const halt = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            stallGuardEngaged: true
        });
        assert.equal(CRAWL_PERCENT, 10);
        assert.equal(crawl.primaryPercent, CRAWL_PERCENT);
        assert.equal(crawl.secondaryPercent, CRAWL_PERCENT);
        assert.equal(halt.primaryPercent, 0);
        // Stall guard cuts the PRIMARY stroker only; the secondary keeps crawling.
        assert.equal(halt.secondaryPercent, CRAWL_PERCENT);
    });

    it('an unknown ceiling behaviour falls back to crawl, "stop" is honoured', () => {
        assert.equal(resolveCeilingBehaviour(undefined), 'crawl');
        assert.equal(resolveCeilingBehaviour('garbage'), 'crawl');
        assert.equal(resolveCeilingBehaviour('stop'), 'stop');
        for (const mode of ['milker', 'ultimate']) {
            const stop = calculateEngineOutputs({ ...running, activeMode: mode, hr: 140, isEdged: true, ceilingBehaviour: 'stop' });
            const crawl = calculateEngineOutputs({ ...running, activeMode: mode, hr: 140, isEdged: true, ceilingBehaviour: 'crawl' });
            assert.equal(stop.primaryPercent, 0, `${mode} primary must full-stop`);
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `${mode} primary must crawl`);
            assert.ok(stop.secondaryPercent > 0, `${mode} secondary keeps milking either way`);
        }
    });

    it('stall guard cuts primary but the secondary milker survives', () => {
        for (const mode of ['milker', 'ultimate']) {
            const halt = calculateEngineOutputs({
                ...running,
                activeMode: mode,
                hr: 140,
                isEdged: true,
                ceilingBehaviour: 'crawl',
                stallGuardEngaged: true
            });
            assert.equal(halt.primaryPercent, 0, `${mode} primary must be cut`);
            assert.ok(halt.secondaryPercent > 0, `${mode} secondary must keep running`);
        }
        const classicNoCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 100,
            ceilingBehaviour: 'crawl',
            stallGuardEngaged: true
        });
        assert.equal(classicNoCrawl.primaryPercent, 0);
        assert.ok(classicNoCrawl.secondaryPercent > 0);
    });

    it('shortener contracts the envelope toward the base once the pulse is close', () => {
        const early = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            early.push(calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 120, sessionSeconds }));
        }
        assert.ok(Math.max(...early.map((sample) => sample.strokeMaxPercent)) >= 90, 'at 120 the window is still the full range');
        assert.ok(early.every((sample) => sample.strokeMinPercent === 0));
        const close = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 136 });
        assert.ok(close.strokeMaxPercent < 70, `strokeMax ${close.strokeMaxPercent}`);
        assert.equal(close.strokeMinPercent, 0);
    });

    it('shortener runs full length at rest and lands on base micro-strokes 0-35% at the ceiling', () => {
        assert.equal(SHORTENER_TOP_PERCENT, 35);
        const rest = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            const sample = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 70, sessionSeconds });
            assert.equal(sample.strokeMinPercent, 0);
            assert.ok(sample.strokeMaxPercent <= 100);
            rest.push(sample.strokeMaxPercent);
        }
        // The allowed window at rest is the full range. The pattern uses
        // less of it some seconds and almost all of it on others.
        assert.ok(Math.max(...rest) >= 90, `rest tops ${Math.max(...rest)}`);
        assert.ok(Math.min(...rest) <= 70, `rest tops ${Math.min(...rest)}`);
        const mid = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 136 });
        assert.ok(mid.strokeMaxPercent < 100);
        assert.equal(mid.strokeMinPercent, 0);
        for (const sessionSeconds of [0, 7, 20, 33]) {
            const ceiling = calculateEngineOutputs({
                ...running, activeMode: 'shortener', hr: 140, isEdged: true,
                ceilingBehaviour: 'crawl', sessionSeconds
            });
            assert.equal(ceiling.strokeMinPercent, 0);
            assert.equal(ceiling.strokeMaxPercent, SHORTENER_TOP_PERCENT);
            const over = calculateEngineOutputs({
                ...running, activeMode: 'shortener', hr: 170, isEdged: true,
                ceilingBehaviour: 'crawl', sessionSeconds
            });
            assert.equal(over.strokeMaxPercent, SHORTENER_TOP_PERCENT);
        }
    });

    it('headplay climbs toward the glans once the pulse is close', () => {
        const early = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            early.push(calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 120, sessionSeconds }));
        }
        assert.ok(Math.min(...early.map((sample) => sample.strokeMinPercent)) <= 15, 'at 120 the stroke still starts near the base');
        assert.ok(early.every((sample) => sample.strokeMaxPercent === 100));
        const close = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 136 });
        assert.ok(close.strokeMinPercent >= 40, `strokeMin ${close.strokeMinPercent}`);
        assert.equal(close.strokeMaxPercent, 100);
    });

    it('milker cross-fades secondary up as HR rises', () => {
        const mean = (hr) => {
            let secondary = 0;
            let primary = 0;
            const n = 60;
            for (let sessionSeconds = 0; sessionSeconds < n; sessionSeconds += 1) {
                const sample = calculateEngineOutputs({ ...running, activeMode: 'milker', hr, sessionSeconds });
                secondary += sample.secondaryPercent;
                primary += sample.primaryPercent;
            }
            return { secondary: secondary / n, primary: primary / n };
        };
        const low = mean(75);
        const high = mean(125);
        assert.ok(high.secondary > low.secondary, `high ${high.secondary} low ${low.secondary}`);
        assert.ok(high.primary < low.primary, `high ${high.primary} low ${low.primary}`);
    });

    it('ruin rides the edge, then cuts the primary and drops the secondary', () => {
        const ride = calculateEngineOutputs({
            ...running,
            activeMode: 'ruin',
            hr: 140,
            isEdged: true,
            ruinHoldSeconds: 0,
            sessionSeconds: 0
        });
        assert.ok(ride.primaryPercent > 0, 'the ride keeps stroking through the edge');
        const lock = calculateEngineOutputs({
            ...running,
            activeMode: 'ruin',
            hr: 140,
            isEdged: true,
            ruinHoldSeconds: 10
        });
        assert.equal(lock.primaryPercent, 0);
        assert.equal(lock.secondaryPercent, 18);
    });

    it('milker near the ceiling pulses the secondary instead of pinning it', () => {
        const samples = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            samples.push(calculateEngineOutputs({
                ...running,
                activeMode: 'milker',
                hr: 140,
                isEdged: true,
                sessionSeconds
            }));
        }
        assert.ok(samples.some((sample) => sample.secondaryPercent < 40));
        assert.ok(samples.some((sample) => sample.secondaryPercent > 70));
    });

    it('the same heart rate does not repeat on an 8 second beat', () => {
        const at = (sessionSeconds) => calculateEngineOutputs({
            ...running, activeMode: 'classic', hr: 100, sessionSeconds
        });
        const speeds = [];
        const depths = [];
        for (let sessionSeconds = 0; sessionSeconds < 48; sessionSeconds += 1) {
            const sample = at(sessionSeconds);
            speeds.push(sample.primaryPercent);
            depths.push(sample.strokeMaxPercent);
        }
        const uniqueSpeeds = new Set(speeds);
        const uniqueDepths = new Set(depths);
        assert.ok(uniqueSpeeds.size >= 8, `only ${uniqueSpeeds.size} speeds`);
        assert.ok(uniqueDepths.size >= 4, `only ${uniqueDepths.size} stroke lengths`);
        const sameBeat = speeds.filter((speed, index) => index >= 8 && speed === speeds[index - 8]);
        assert.ok(sameBeat.length < 20, 'an 8 second loop would match almost every sample');
    });

    it('head play stays on the shaft until the pulse is close to the mark', () => {
        const mid = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 105, sessionSeconds: 0 });
        assert.ok(mid.strokeMinPercent < 20, `strokeMin ${mid.strokeMinPercent}`);
        assert.equal(mid.strokeMaxPercent, 100);
        const close = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 136, sessionSeconds: 0 });
        assert.ok(close.strokeMinPercent >= 40, `strokeMin ${close.strokeMinPercent}`);
    });

    it('oracle approach pulls instead of teasing down', () => {
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120 });
        const oracle = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            oracleState: 'APPROACH',
            hr: 120
        });
        assert.ok(oracle.primaryPercent > classic.primaryPercent);
    });

    it('oracle hold/denial/climax/purgatory are distinct', () => {
        const hold = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'HOLD', isEdged: true, hr: 140 });
        const denial = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'DENIAL', hr: 140 });
        const climax = calculateEngineOutputs({
            ...running, activeMode: 'oracle', oracleState: 'CLIMAX', orgasmMode: true, orgasmBoost: 28, hr: 140
        });
        const purgatory = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'PURGATORY', sessionSeconds: 4 });
        // HOLD is a hold AT the pullback mark, so it obeys the wearer's
        // ceiling rule; `running` selects Full Stop.
        assert.equal(hold.primaryPercent, 0);
        assert.ok(hold.secondaryPercent > 0, 'the secondary channel keeps running');
        assert.equal(denial.primaryPercent, 0);
        assert.ok(climax.primaryPercent >= 70, 'a climax that has ramped is driving, not crawling');
        assert.ok(purgatory.primaryPercent > 0);
        assert.ok(purgatory.primaryPercent < 100);
    });

    it('every Oracle state at the pullback mark obeys the ceiling rule, exactly as Edge Training does', () => {
        // HOLD, PURGATORY and an edged APPROACH are all holds at the mark:
        // app.js only enters HOLD from state.isEdged and does not clear the
        // flag until the pulse leaves the release band. The stall guard is
        // deliberately disarmed for this mode (app.js), so the ceiling rule
        // is the ONLY thing that can stop the primary here. The two games
        // must never drift apart again.
        const atMark = { ...running, hr: 140, isEdged: true, orgasmMode: false, sessionSeconds: 4 };
        const oracleStates = ['HOLD', 'PURGATORY', 'APPROACH'];
        const trainStates = ['hold', 'recover', 'climb'];
        for (const oracleState of oracleStates) {
            const stop = calculateEngineOutputs({ ...atMark, activeMode: 'oracle', oracleState, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `oracle ${oracleState} must park the primary with Full Stop`);
            const crawl = calculateEngineOutputs({ ...atMark, activeMode: 'oracle', oracleState, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `oracle ${oracleState} must crawl with Crawl`);
        }
        for (const trainingState of trainStates) {
            const stop = calculateEngineOutputs({ ...atMark, activeMode: 'edgetrain', trainingState, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `edgetrain ${trainingState} must park the primary with Full Stop`);
            // 'recover' is reached with the pulse still on the mark -
            // tickEdgeTraining only leaves it once the pulse drops out of the
            // release band - and it used to dead-stop the primary whichever
            // rule the wearer picked, so every counted hold was followed by
            // 0% for a wearer who chose Crawl to keep the edge alive.
            const crawl = calculateEngineOutputs({ ...atMark, activeMode: 'edgetrain', trainingState, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `edgetrain ${trainingState} must crawl with Crawl`);
        }
        // Force Orgasm is still the one thing that overrides it.
        const forced = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'HOLD', ceilingBehaviour: 'stop',
            orgasmMode: true, orgasmBoost: 28
        });
        assert.ok(forced.primaryPercent >= 70, 'Force Orgasm overrides Full Stop once it has ramped');
        // Global Intensity cannot smuggle motion past Full Stop either.
        const loud = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'PURGATORY', ceilingBehaviour: 'stop', intensityValue: 100
        });
        assert.equal(loud.primaryPercent, 0);
    });

    it('a cancelled Force Orgasm settles at once instead of surging to 100%', () => {
        // Oracle CLIMAX and Edge Training 'finish' are only ever entered with
        // Force Orgasm ON (app.js arms it with the roll and with the finished
        // set), so reaching either with it OFF means the wearer cancelled.
        // app.js hands the game back to the climb on the NEXT tick, and the
        // engine used to run 100/100 until it did: the click dispatched
        // 100/100 and so did the tick after it, one to two seconds of both
        // channels at full speed for someone who had just said no.
        const below = { ...running, orgasmMode: false, isEdged: false, hr: 100, edgeHr: 100 };
        const withdrawn = calculateEngineOutputs({ ...below, activeMode: 'oracle', oracleState: 'CLIMAX' });
        const approach = calculateEngineOutputs({ ...below, activeMode: 'oracle', oracleState: 'APPROACH' });
        assert.equal(withdrawn.primaryPercent, approach.primaryPercent, 'a withdrawn climax IS the approach');
        assert.equal(withdrawn.secondaryPercent, approach.secondaryPercent);
        assert.ok(withdrawn.primaryPercent < 100, 'a withdrawn climax must not surge to 100%');

        const cancelled = calculateEngineOutputs({ ...below, activeMode: 'edgetrain', trainingState: 'finish' });
        const climb = calculateEngineOutputs({ ...below, activeMode: 'edgetrain', trainingState: 'climb' });
        assert.equal(cancelled.primaryPercent, climb.primaryPercent, 'a cancelled finish IS the climb');
        assert.equal(cancelled.secondaryPercent, climb.secondaryPercent);
        assert.ok(cancelled.primaryPercent < 100, 'a cancelled finish must not surge to 100%');

        // On the mark the ceiling rule still governs the primary in both.
        const atMark = { ...running, orgasmMode: false, isEdged: true, hr: 140, edgeHr: 140 };
        for (const probe of [
            { activeMode: 'oracle', oracleState: 'CLIMAX' },
            { activeMode: 'edgetrain', trainingState: 'finish' }
        ]) {
            const where = probe.oracleState || probe.trainingState;
            const stop = calculateEngineOutputs({ ...atMark, ...probe, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `${where} must park the primary with Full Stop`);
            const crawl = calculateEngineOutputs({ ...atMark, ...probe, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `${where} must crawl with Crawl`);
        }

        // The first second stays with the game. A ramped Force Orgasm is high
        // and not a flat 100 on both channels.
        const settled = {
            oracle: approach,
            edgetrain: climb
        };
        for (const probe of [
            { activeMode: 'oracle', oracleState: 'CLIMAX' },
            { activeMode: 'edgetrain', trainingState: 'finish' }
        ]) {
            const armed = calculateEngineOutputs({ ...below, ...probe, orgasmMode: true, orgasmBoost: 0 });
            const quiet = settled[probe.activeMode];
            assert.equal(armed.primaryPercent, quiet.primaryPercent);
            assert.equal(armed.secondaryPercent, quiet.secondaryPercent);
            const forcing = calculateEngineOutputs({ ...below, ...probe, orgasmMode: true, orgasmBoost: 28, sessionSeconds: 3 });
            assert.ok(forcing.primaryPercent >= 70);
            assert.ok(forcing.secondaryPercent >= 60);
        }
    });

    it('Force Orgasm ramps with variance and can run past the typed max', () => {
        const parked = {
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 140,
            isEdged: true,
            ceilingBehaviour: 'stop',
            sessionSeconds: 4
        };
        const armed = calculateEngineOutputs({ ...parked, orgasmMode: true, orgasmBoost: 0 });
        assert.ok(armed.primaryPercent < 40, 'without a remembered speed the first second stays with the stopped mode');
        const fromWhereItWas = calculateEngineOutputs({
            ...parked,
            orgasmMode: true,
            orgasmBoost: 0,
            orgasmFromPrimary: 62,
            orgasmFromSecondary: 40,
            orgasmFromStrokeMin: 15,
            orgasmFromStrokeMax: 70
        });
        assert.equal(fromWhereItWas.primaryPercent, 62, 'the first tick sends the speed the toys were already at');
        assert.equal(fromWhereItWas.secondaryPercent, 40);
        assert.equal(fromWhereItWas.strokeMinPercent, 15);
        assert.equal(fromWhereItWas.strokeMaxPercent, 70);
        const mid = calculateEngineOutputs({ ...parked, orgasmMode: true, orgasmBoost: 14 });
        const full = [];
        for (let sessionSeconds = 0; sessionSeconds < 36; sessionSeconds += 1) {
            full.push(calculateEngineOutputs({
                ...parked, orgasmMode: true, orgasmBoost: 28, sessionSeconds, maxHr: 155
            }));
        }
        assert.ok(mid.primaryPercent > armed.primaryPercent, 'halfway up the ramp is hotter than the start');
        assert.ok(Math.min(...full.map((sample) => sample.primaryPercent)) >= 70);
        assert.ok(new Set(full.map((sample) => sample.primaryPercent)).size >= 4, 'the top of the ramp is not one flat speed');
        assert.ok(full.some((sample) => sample.secondaryPercent < 100));
        assert.ok(full.every((sample) => sample.isEdged === true), 'overdrive does not release the edge');
        assert.ok(full.every((sample) => sample.newEdgeTriggered === false));
        // Stroke still lives inside the travel window the wearer set.
        const boxed = calculateEngineOutputs({
            ...parked, orgasmMode: true, orgasmBoost: 28, handyHwMin: 15, handyHwMax: 80, sessionSeconds: 6
        });
        assert.ok(boxed.strokeMinPercent >= 15);
        assert.ok(boxed.strokeMaxPercent <= 80);
    });

    it('every tease mode keeps the stroker working until the pulse is close to the mark', () => {
        const modes = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin'];
        for (const mode of modes) {
            for (const hr of [100, 120, 125]) {
                let low = 100;
                let reach = 100;
                for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
                    const sample = calculateEngineOutputs({
                        ...running,
                        activeMode: mode,
                        hr,
                        edgeHr: hr,
                        isEdged: false,
                        ceilingBehaviour: 'crawl',
                        sessionSeconds
                    });
                    assert.equal(sample.isEdged, false, `${mode} at ${hr}`);
                    low = Math.min(low, sample.primaryPercent);
                    reach = Math.min(reach, sample.strokeMaxPercent - sample.strokeMinPercent);
                }
                assert.ok(low > 25, `${mode} at ${hr} dropped to ${low}`);
                assert.ok(reach >= 55, `${mode} at ${hr} shortest stroke was ${reach}`);
            }
            const atMark = calculateEngineOutputs({
                ...running,
                activeMode: mode,
                hr: 140,
                edgeHr: 140,
                isEdged: true,
                ceilingBehaviour: 'crawl'
            });
            if (mode === 'ruin') {
                assert.ok(atMark.primaryPercent > CRAWL_PERCENT, 'ruin keeps stroking on the mark');
            } else {
                assert.equal(atMark.primaryPercent, CRAWL_PERCENT, `${mode} crawls at the mark`);
            }
        }
    });

    it('ultimate keeps stroking until the pulse is close to the mark', () => {
        const sweep = (hr) => {
            const samples = [];
            for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
                samples.push(calculateEngineOutputs({
                    ...running,
                    activeMode: 'ultimate',
                    hr,
                    edgeHr: hr,
                    isEdged: false,
                    ceilingBehaviour: 'crawl',
                    sessionSeconds
                }));
            }
            const primary = samples.map((sample) => sample.primaryPercent);
            const reach = samples.map((sample) => sample.strokeMaxPercent - sample.strokeMinPercent);
            return {
                low: Math.min(...primary),
                mean: primary.reduce((sum, value) => sum + value, 0) / primary.length,
                reach: Math.min(...reach)
            };
        };
        // 120 BPM is nowhere near a 140 max (resting 70). The old pattern
        // was already in its stop chapter here and would park the toy.
        const at120 = sweep(120);
        assert.ok(at120.low > 20, `lowest primary at 120 was ${at120.low}`);
        assert.ok(at120.mean > 35, `mean primary at 120 was ${at120.mean}`);
        assert.ok(at120.reach >= 55, `shortest stroke at 120 was ${at120.reach}`);
        const at125 = sweep(125);
        assert.ok(at125.low > 15, `lowest primary at 125 was ${at125.low}`);
        assert.ok(at125.mean > 28, `mean primary at 125 was ${at125.mean}`);
        // Crawl is still the pullback mark, not a pattern stop in the middle.
        const early = calculateEngineOutputs({
            ...running, activeMode: 'ultimate', hr: 125, edgeHr: 125, isEdged: false, ceilingBehaviour: 'crawl'
        });
        assert.ok(early.primaryPercent > CRAWL_PERCENT);
        assert.equal(early.isEdged, false);
        const atMark = calculateEngineOutputs({
            ...running, activeMode: 'ultimate', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl'
        });
        assert.equal(atMark.primaryPercent, CRAWL_PERCENT);
    });

    it('Force Orgasm freezes the edge flag instead of releasing it', () => {
        // The overdrive raises the working ceiling 1 BPM per second, so the
        // pullback mark climbs away from a pulse that never moved. Releasing
        // the edge on that evidence meant the tick after the cancel counted a
        // brand-new edge: the counter, the spoken cue, a rotator reversal and
        // Adaptive Ceiling Decay, all for an edge that never ended.
        const edged = { ...running, activeMode: 'classic', isEdged: true, hr: 140, edgeHr: 140 };
        const forcing = calculateEngineOutputs({ ...edged, orgasmMode: true, maxHr: 160 });
        assert.equal(forcing.isEdged, true, 'an inflated ceiling is not the pulse coming down');
        assert.equal(forcing.newEdgeTriggered, false);

        // The tick after the cancel, judged against the real ceiling again.
        const cancelled = calculateEngineOutputs({ ...edged, isEdged: forcing.isEdged, orgasmMode: false });
        assert.equal(cancelled.newEdgeTriggered, false, 'cancelling must not invent an edge');
        assert.equal(cancelled.isEdged, true);

        // A pulse that really did come down still releases, on that same tick.
        const recovered = calculateEngineOutputs({ ...edged, orgasmMode: false, hr: 110, edgeHr: 110 });
        assert.equal(recovered.isEdged, false);
        // And the freeze cannot arm a new edge while the orgasm runs either.
        const climbing = calculateEngineOutputs({ ...edged, isEdged: false, orgasmMode: true, maxHr: 160 });
        assert.equal(climbing.isEdged, false);
        assert.equal(climbing.newEdgeTriggered, false);
    });

    it('survival and calibration use the accelerating floor', () => {
        const survival = calculateEngineOutputs({ ...running, activeMode: 'survival', survivalSpeedFloor: 61 });
        const calibrate = calculateEngineOutputs({ ...running, activeMode: 'calibrate', survivalSpeedFloor: 61 });
        assert.equal(survival.primaryPercent, 61);
        assert.equal(calibrate.primaryPercent, 61);
    });

    it('calibration drops decay and a stroke change does not leave the climb', () => {
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.match(app, /adaptiveDecay: isUncappedClimb\(\) \? false/);
        assert.match(app, /decayBadge\?\.classList\.toggle\('hidden', isUncappedClimb\(\) \|\| !\(ceiling\.totalDecay > 0\)\)/);
        assert.match(app, /A stroke change keeps Calibration running/);
        assert.equal(app.includes('A stroke is not a way to keep Calibration'), false);
    });

    it('edge training pulls on the climb and obeys the ceiling rule on a hold', () => {
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120 });
        const climb = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            hr: 120
        });
        assert.ok(climb.primaryPercent > classic.primaryPercent);
        // The hold sits AT the pullback mark, so the wearer's ceiling rule
        // decides what the primary does there: Full Stop parks it at 0%,
        // Crawl keeps the 10% micro-motion. Only Force Orgasm overrides it.
        const hold = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'hold',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'stop'
        });
        assert.equal(hold.primaryPercent, 0);
        assert.ok(hold.secondaryPercent > 0, 'the secondary channel keeps running');
        const holdCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'hold',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(holdCrawl.primaryPercent, CRAWL_PERCENT);
        // The climb applies the same rule the second the mark is reached.
        const climbEdged = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'stop'
        });
        assert.equal(climbEdged.primaryPercent, 0);
        const climbEdgedCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(climbEdgedCrawl.primaryPercent, CRAWL_PERCENT);
        // Recover is a hold at the mark too, so it answers to the same rule.
        const recover = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'recover',
            isEdged: true,
            hr: 140
        });
        assert.equal(recover.primaryPercent, 0);
        const recoverCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'recover',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(recoverCrawl.primaryPercent, CRAWL_PERCENT);
        assert.ok(recoverCrawl.secondaryPercent > 0, 'the secondary channel keeps running');
    });

    it('warmup starts slow and short, then opens to the full pattern', () => {
        const cold = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 5,
            sessionSeconds: 0,
            hr: 80
        });
        const open = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 0,
            sessionSeconds: 0,
            hr: 80
        });
        assert.ok(cold.primaryPercent < open.primaryPercent * 0.4, `cold ${cold.primaryPercent} open ${open.primaryPercent}`);
        assert.ok(cold.strokeMaxPercent < open.strokeMaxPercent);
        assert.ok(cold.strokeMaxPercent > cold.strokeMinPercent);
        const done = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 5,
            sessionSeconds: 300,
            hr: 80
        });
        const sameBeat = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 0,
            sessionSeconds: 300,
            hr: 80
        });
        assert.equal(done.primaryPercent, sameBeat.primaryPercent);
        assert.equal(done.strokeMaxPercent, sameBeat.strokeMaxPercent);
    });
});

describe('engine safety guards', () => {
    it('head play during warm-up stays inside the head window', () => {
        // Warm-up used to cap strokeMax at 55 while head play had already
        // lifted strokeMin to 75, which collapsed the zone.
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'headplay',
            hr: 135,
            warmupMinutes: 5,
            sessionSeconds: 0
        });
        const open = calculateEngineOutputs({
            ...running,
            activeMode: 'headplay',
            hr: 135,
            warmupMinutes: 0,
            sessionSeconds: 0
        });
        assert.ok(result.strokeMaxPercent - result.strokeMinPercent >= MIN_ZONE_WIDTH);
        assert.ok(result.strokeMinPercent >= open.strokeMinPercent);
        assert.ok(result.strokeMaxPercent <= open.strokeMaxPercent);
        assert.ok(result.primaryPercent < open.primaryPercent);
    });

    it('no mode, pattern, game, warm-up or orgasm leaves the travel envelope', () => {
        const games = ['oracle', 'survival', 'edgetrain', 'calibrate'];
        for (const mode of ENGINE_MODES) {
            for (const sessionSeconds of [0, 3, 7, 12, 20, 40]) {
                for (const hr of [70, 105, 140]) {
                    for (const orgasmMode of [false, true]) {
                        const result = calculateEngineOutputs({
                            ...running,
                            activeMode: mode,
                            strokeMode: games.includes(mode) ? 'headplay' : undefined,
                            handyHwMin: 15,
                            handyHwMax: 80,
                            hr,
                            edgeHr: hr,
                            sessionSeconds,
                            isEdged: hr >= 140,
                            orgasmMode,
                            warmupMinutes: sessionSeconds === 0 ? 5 : 0,
                            ruinHoldSeconds: sessionSeconds % 2 ? 8 : 0,
                            oracleState: 'HOLD',
                            trainingState: 'hold'
                        });
                        assert.ok(
                            result.strokeMinPercent >= 15
                                && result.strokeMaxPercent <= 80
                                && result.strokeMaxPercent > result.strokeMinPercent,
                            `${mode} t=${sessionSeconds} hr=${hr} orgasm=${orgasmMode} zone ${result.strokeMinPercent}-${result.strokeMaxPercent}`
                        );
                    }
                }
            }
        }
    });

    it('a game borrows the selected tease stroke instead of its own zone', () => {
        const held = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            strokeMode: 'shortener',
            oracleState: 'HOLD',
            hr: 140,
            isEdged: true,
            handyHwMin: 15,
            handyHwMax: 80
        });
        assert.equal(held.primaryPercent, 0);
        assert.equal(held.strokeMinPercent, 15);
        assert.equal(held.strokeMaxPercent, 15 + Math.round(0.35 * 65));
    });

    it('an inverted or narrow hardware envelope still yields an ordered zone', () => {
        const inverted = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 130, handyHwMin: 90, handyHwMax: 10 });
        assert.ok(inverted.strokeMaxPercent > inverted.strokeMinPercent);
        assert.ok(inverted.strokeMinPercent >= 10 && inverted.strokeMaxPercent <= 90);
        const narrow = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 130, handyHwMin: 50, handyHwMax: 52 });
        assert.ok(narrow.strokeMaxPercent > narrow.strokeMinPercent);
        const idle = calculateEngineOutputs({ ...running, sessionStatus: 'IDLE', handyHwMin: 80, handyHwMax: 20 });
        assert.ok(idle.strokeMaxPercent > idle.strokeMinPercent);
    });

    it('every mode keeps the zone at least MIN_ZONE_WIDTH wide across the HR band', () => {
        for (const mode of ENGINE_MODES) {
            for (let hr = 70; hr <= 150; hr += 5) {
                for (const sessionSeconds of [0, 60, 299, 400]) {
                    const r = calculateEngineOutputs({ ...running, activeMode: mode, hr, warmupMinutes: 5, sessionSeconds, isEdged: hr >= 140 });
                    assert.ok(r.strokeMaxPercent - r.strokeMinPercent >= MIN_ZONE_WIDTH, `${mode} hr=${hr} t=${sessionSeconds} zone ${r.strokeMinPercent}-${r.strokeMaxPercent}`);
                }
            }
        }
    });

    it('hysteresis: the edge only releases below ceiling minus the release band', () => {
        assert.equal(EDGE_RELEASE_BPM, 5);
        assert.equal(hasReleasedEdge(134, 140), true);
        assert.equal(hasReleasedEdge(135, 140), false);
        assert.equal(hasReleasedEdge(NaN, 140), false);
        const stillEdged = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 136, isEdged: true });
        assert.equal(stillEdged.isEdged, true);
        assert.equal(stillEdged.primaryPercent, 0);
        const boundary = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 135, isEdged: true });
        assert.equal(boundary.isEdged, true);
        const released = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 134, isEdged: true });
        assert.equal(released.isEdged, false);
        assert.ok(released.primaryPercent > 0);
    });

    it('newEdgeTriggered fires exactly once per crossing', () => {
        const first = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 141, isEdged: false });
        assert.equal(first.newEdgeTriggered, true);
        assert.equal(first.isEdged, true);
        const second = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 145, isEdged: first.isEdged });
        assert.equal(second.newEdgeTriggered, false);
        assert.equal(second.isEdged, true);
        const hovering = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 137, isEdged: second.isEdged });
        assert.equal(hovering.newEdgeTriggered, false);
        assert.equal(hovering.isEdged, true);
        const back = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120, isEdged: hovering.isEdged });
        assert.equal(back.isEdged, false);
        const again = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: back.isEdged });
        assert.equal(again.newEdgeTriggered, true);
    });

    it('clamps hold percent and maps it onto a trigger HR', () => {
        assert.equal(DEFAULT_EDGE_HOLD_PERCENT, 100);
        assert.equal(MIN_EDGE_HOLD_PERCENT, 90);
        // The typed Climax HR is a hard ceiling, so the pullback mark can
        // only ever sit AT it or below it.
        assert.equal(MAX_EDGE_HOLD_PERCENT, 100);
        assert.equal(clampEdgeHoldPercent(80), 90);
        assert.equal(clampEdgeHoldPercent(140), 100);
        assert.equal(clampEdgeHoldPercent(115), 100);
        assert.equal(clampEdgeHoldPercent('abc'), DEFAULT_EDGE_HOLD_PERCENT);
        assert.equal(resolveEdgeTriggerHr(140, 100), 140);
        assert.equal(resolveEdgeTriggerHr(140, 105), 140);
        assert.equal(resolveEdgeTriggerHr(140, 95), 133);
        assert.ok(Number.isNaN(resolveEdgeTriggerHr(NaN, 105)));
    });

    it('a stored hold percent above 100 pulls back AT the typed ceiling', () => {
        // Settings saved before the range was corrected (or a hand-edited
        // backup) may still carry 115: it must behave exactly like 100%.
        const atMax = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 115
        });
        assert.equal(atMax.isEdged, true, 'the typed max is the pullback mark');
        assert.equal(atMax.newEdgeTriggered, true);
        assert.equal(atMax.primaryPercent, CRAWL_PERCENT);

        const released = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 134,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 115,
            sessionSeconds: 0
        });
        assert.equal(released.isEdged, false);
        assert.ok(released.primaryPercent > CRAWL_PERCENT);
    });

    it('keeps the pullback mark above the resting rate on a narrow typed band', () => {
        // Resting 70 / Climax 75 is a legal pair. 90% of 75 is 68, below the
        // resting rate: the session would latch edged on the first reading
        // with a release point (63) the wearer can never reach.
        assert.equal(resolveEdgeTriggerHr(75, 90, 70), 75);
        assert.equal(resolveEdgeTriggerHr(95, 90, 70), 86);
        // Without a resting rate the mark is simply the percentage.
        assert.equal(resolveEdgeTriggerHr(95, 90), 86);

        const atRest = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 70,
            minHr: 70,
            maxHr: 75,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 90
        });
        assert.equal(atRest.isEdged, false, 'a resting pulse must not be an edge');
        assert.ok(atRest.primaryPercent > CRAWL_PERCENT);
    });

    it('sweeps every legal limit pair and hold percent for the ceiling contract', () => {
        for (let minHr = 30; minHr <= 240; minHr += 1) {
            for (const span of [1, 2, 5, 15, 40, 120]) {
                const maxHr = minHr + span;
                if (maxHr > 250) continue;
                for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct++) {
                    const trigger = resolveEdgeTriggerHr(maxHr, pct, minHr);
                    assert.ok(
                        trigger <= maxHr,
                        `trigger ${trigger} above the ceiling ${maxHr} at ${pct}%`
                    );
                    assert.ok(
                        trigger >= Math.min(maxHr, minHr + EDGE_RELEASE_BPM + 1),
                        `trigger ${trigger} too close to resting ${minHr} at ${pct}%`
                    );
                    assert.ok(trigger > minHr, `trigger ${trigger} at or under resting ${minHr}`);
                }
            }
        }
    });

    it('sweeps the hold percents for the crawl / Full Stop rule at the typed ceiling', () => {
        for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct++) {
            for (const behaviour of ['crawl', 'stop']) {
                const atCeiling = calculateEngineOutputs({
                    ...running,
                    activeMode: 'classic',
                    hr: 140,
                    isEdged: false,
                    ceilingBehaviour: behaviour,
                    edgeHoldPercent: pct
                });
                assert.equal(atCeiling.isEdged, true, `not edged at the ceiling at ${pct}%`);
                assert.equal(
                    atCeiling.primaryPercent,
                    behaviour === 'crawl' ? CRAWL_PERCENT : 0,
                    `primary still driving at the ceiling at ${pct}%`
                );
            }
        }
    });

    it('100% hold still edges at the typed climax', () => {
        const hit = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: false,
            ceilingBehaviour: 'stop',
            edgeHoldPercent: 100
        });
        assert.equal(hit.newEdgeTriggered, true);
        assert.equal(hit.primaryPercent, 0);
    });

    it('95% hold pulls back before the typed climax', () => {
        const early = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 133,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 95
        });
        assert.equal(early.newEdgeTriggered, true);
        assert.equal(early.primaryPercent, CRAWL_PERCENT);
        const below = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 132,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 95
        });
        assert.equal(below.isEdged, false);
    });

    it('does not count edges during orgasm mode or rampdown', () => {
        const orgasm = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 150, orgasmMode: true });
        assert.equal(orgasm.newEdgeTriggered, false);
        const ramp = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 150, sessionStatus: 'RAMPDOWN' });
        assert.equal(ramp.newEdgeTriggered, false);
    });

    it('an orgasm settle eases from the current speed down to the ceiling floor', () => {
        const start = calculateEngineOutputs({
            ...running,
            activeMode: 'calibrate',
            survivalSpeedFloor: 80,
            settleSecondsLeft: 45,
            settleSpan: 45,
            settleFromPrimary: 80,
            settleFromSecondary: 56,
            settleFloor: 10
        });
        assert.equal(start.primaryPercent, 80);
        assert.equal(start.secondaryPercent, 56);
        const mid = calculateEngineOutputs({
            ...running,
            settleSecondsLeft: 22.5,
            settleSpan: 45,
            settleFromPrimary: 80,
            settleFromSecondary: 40,
            settleFloor: 0
        });
        assert.equal(mid.primaryPercent, 40);
        assert.equal(mid.secondaryPercent, 20);
        const end = calculateEngineOutputs({
            ...running,
            settleSecondsLeft: 0.01,
            settleSpan: 45,
            settleFromPrimary: 80,
            settleFromSecondary: 40,
            settleFloor: 10
        });
        assert.ok(end.primaryPercent <= 11);
        assert.equal(end.newEdgeTriggered, false);
    });

    it('rampdown scales linearly from 50% to 0% over 45 seconds', () => {
        const full = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45 });
        const half = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 22.5 });
        const done = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 0 });
        assert.equal(full.primaryPercent, 50);
        assert.equal(full.secondaryPercent, 50);
        assert.equal(half.primaryPercent, 25);
        assert.equal(done.primaryPercent, 0);
        assert.equal(done.secondaryPercent, 0);
        const negative = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: -10 });
        assert.equal(negative.primaryPercent, 0);
    });

    it('intensity scales output between 0.5x and 1.5x and caps at 100', () => {
        const gentle = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 0 });
        const balanced = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 50 });
        const intense = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 100 });
        assert.ok(gentle.primaryPercent < balanced.primaryPercent);
        assert.ok(intense.primaryPercent > balanced.primaryPercent);
        assert.equal(gentle.primaryPercent, Math.round(balanced.primaryPercent * 0.5));
        assert.ok(intense.primaryPercent <= 100);
        const cut = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: true, intensityValue: 100 });
        assert.equal(cut.primaryPercent, 0, 'intensity must never revive a cut motor');
    });

    it('non-finite inputs yield zero output, never NaN', () => {
        const cases = [
            { hr: NaN },
            { hr: Infinity },
            { minHr: NaN },
            { maxHr: NaN },
            { maxHr: undefined },
            { hr: 'abc' }
        ];
        for (const patch of cases) {
            for (const mode of ENGINE_MODES) {
                const r = calculateEngineOutputs({ ...running, activeMode: mode, ...patch });
                assert.equal(r.primaryPercent, 0, `${mode} ${JSON.stringify(patch)} primary`);
                assert.equal(r.secondaryPercent, 0, `${mode} ${JSON.stringify(patch)} secondary`);
                assert.ok(Number.isFinite(r.strokeMinPercent) && Number.isFinite(r.strokeMaxPercent));
                assert.equal(r.newEdgeTriggered, false);
            }
        }
        const keepsEdge = calculateEngineOutputs({ ...running, hr: NaN, isEdged: true });
        assert.equal(keepsEdge.isEdged, true, 'bad data must not release an edge');
    });

    it('non-finite tuning values fall back instead of poisoning the output', () => {
        const r = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            gamma: NaN,
            intensityValue: NaN,
            edgeStrokeDepth: NaN,
            warmupMinutes: NaN,
            handyHwMin: NaN,
            handyHwMax: NaN
        });
        assert.ok(Number.isFinite(r.primaryPercent) && r.primaryPercent > 0);
        assert.ok(Number.isFinite(r.secondaryPercent));
        assert.ok(r.strokeMaxPercent > r.strokeMinPercent);
    });
});

describe('edge detection source', () => {
    it('judges the edge on edgeHr while the speed curve follows hr', () => {
        // The microphone boost moves `hr` (the engine's speed input) but never
        // `edgeHr` (the sensor's own pulse), so a loud room cannot latch an edge.
        const boosted = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 120,
            isEdged: false
        });
        assert.equal(boosted.newEdgeTriggered, false, 'noise must not count an edge');
        assert.equal(boosted.isEdged, false);

        const unboosted = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 120,
            edgeHr: 120,
            isEdged: false
        });
        assert.ok(
            boosted.primaryPercent < unboosted.primaryPercent,
            'the boost must still move the speed curve'
        );

        const real = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: false });
        assert.equal(real.newEdgeTriggered, true);
        assert.equal(real.isEdged, true);
    });

    it('releases an edge on the sensor pulse, not the boosted one', () => {
        const held = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 120,
            edgeHr: 138,
            isEdged: true
        });
        assert.equal(held.isEdged, true, 'a low speed input must not release the edge');

        const released = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 120,
            isEdged: true
        });
        assert.equal(released.isEdged, false, 'the sensor pulse came down, so the edge releases');
    });

    it('falls back to hr when no edgeHr is given', () => {
        const r = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: false });
        assert.equal(r.newEdgeTriggered, true);
        const bad = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, edgeHr: NaN, isEdged: false });
        assert.equal(bad.newEdgeTriggered, true);
    });
});

describe('game-side edge release', () => {
    it('is judged against the pullback mark, not the ceiling', () => {
        // Climax 140, pullback 90% -> mark 126, release 121. A game that asks
        // "has the pulse come back down?" without the mark gets 135 instead,
        // clears the edge flag while the engine still sees the pulse at or
        // above the mark, and the next engine tick counts an invented edge.
        const trigger = resolveEdgeTriggerHr(140, 90, 70);
        assert.equal(trigger, 126);
        assert.equal(hasReleasedEdge(130, 140, trigger), false, 'still on the mark');
        assert.equal(hasReleasedEdge(130, 140), true, 'what the 2-argument call wrongly answers');
        assert.equal(hasReleasedEdge(120, 140, trigger), true);

        const phantom = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            oracleState: 'PURGATORY',
            hr: 130,
            isEdged: false,
            edgeHoldPercent: 90
        });
        assert.equal(phantom.newEdgeTriggered, true, 'clearing the flag at 130 costs one phantom edge');
    });

    it('gameEdgeReleased refuses to answer without a pullback mark', () => {
        // The property, not the shape of the call. `hasReleasedEdge` falls
        // back to maxHr - 5 when it is handed no mark, and with any pullback
        // below 100% that band sits ABOVE the mark: the game clears the edge
        // flag while the engine still reads the pulse as edged, and the next
        // tick counts an invented edge that Adaptive Ceiling Decay acts on.
        const trigger = resolveEdgeTriggerHr(140, 90, 70);
        assert.equal(trigger, 126);
        assert.equal(gameEdgeReleased(130, 140, trigger), false, 'still on the mark');
        assert.equal(gameEdgeReleased(120, 140, trigger), true);

        // state.edgeTriggerHr starts as null (state.js) and is only written by
        // the engine loop. A caller that reaches this before the first tick,
        // or after a reordering, must get "not released" - never the silent
        // maxHr - 5 fallback that hasReleasedEdge would use.
        for (const noMark of [null, undefined, NaN, 'abc']) {
            assert.equal(gameEdgeReleased(130, 140, noMark), false, `no mark (${String(noMark)}) is not a release`);
            assert.equal(gameEdgeReleased(70, 140, noMark), false, 'not even far below the ceiling');
        }
        assert.equal(hasReleasedEdge(130, 140, undefined), true, 'what the unguarded call wrongly answers');
    });

    it('gameEdgeReleased says "no" for as long as Force Orgasm is on', () => {
        // The overdrive lifts the working ceiling 1 BPM per second and the
        // release band rides up with it, so a pulse parked ON the mark reads
        // as released against a ceiling that only moved because the wearer
        // armed the button. calculateEngineOutputs freezes the edge flag for
        // that reason; the games ask their own release question once a second
        // and have to get the same answer, or the Oracle's purgatory reset
        // counts an edge - and walks Adaptive Ceiling Decay - on a pulse that
        // never left the mark.
        const typed = 140;
        const mark = resolveEdgeTriggerHr(typed, 100, 70);
        assert.equal(mark, typed);
        const onTheMark = 140;
        assert.equal(gameEdgeReleased(onTheMark, typed, mark), false, 'on the mark, no overdrive');
        // Six seconds of Force Orgasm: the ceiling (and the mark with it) is
        // six BPM higher, which puts the unchanged pulse below the band.
        const boosted = typed + 6;
        const boostedMark = resolveEdgeTriggerHr(boosted, 100, 70);
        assert.equal(
            gameEdgeReleased(onTheMark, boosted, boostedMark),
            true,
            'what the inflated ceiling wrongly answers'
        );
        assert.equal(
            gameEdgeReleased(onTheMark, boosted, boostedMark, { orgasmMode: true }),
            false,
            'Force Orgasm freezes the answer, exactly as the engine freezes the flag'
        );
        // A genuine release is still a release the moment the button is off.
        assert.equal(gameEdgeReleased(120, typed, mark, { orgasmMode: false }), true);
        assert.equal(gameEdgeReleased(120, typed, mark, { orgasmMode: true }), false);
    });

    it('app.js hands both game release checks the Force Orgasm flag', () => {
        // The Oracle's purgatory reset and Edge Training's recover both ask
        // it once a second while the wearer may be holding Force Orgasm.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const sites = /gameEdgeReleased\(([^)]*)\)/g;
        let seen = 0;
        let match;
        while ((match = sites.exec(src)) !== null) {
            seen += 1;
            assert.ok(
                /orgasmMode/.test(match[1]),
                `the release check must be told about Force Orgasm: ${match[0]}`
            );
        }
        assert.ok(seen >= 2, 'expected the Oracle and Edge Training call sites');
    });

    it('app.js asks the release question only through gameEdgeReleased', () => {
        // The Oracle and Edge Training both ask it once a second. A call site
        // that reaches hasReleasedEdge directly can be handed a null mark, so
        // there must be no such call site at all.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const guarded = src.match(/gameEdgeReleased\(/g) || [];
        assert.ok(guarded.length >= 2, 'expected the Oracle and Edge Training call sites');
        const raw = src.match(/(?<![A-Za-z0-9_])hasReleasedEdge\(/g) || [];
        assert.equal(raw.length, 0, 'app.js must not call hasReleasedEdge directly');
        const sites = /gameEdgeReleased\(([^)]*)\)/g;
        let seen = 0;
        let match;
        while ((match = sites.exec(src)) !== null) {
            seen += 1;
            assert.ok(
                /edgeTriggerHr/.test(match[1]),
                `the release check must be given the pullback mark: ${match[0]}`
            );
        }
        assert.equal(seen, guarded.length, 'every call site must have been inspected');
    });
});

describe('the microphone boost can never raise either channel', () => {
    // The promise the panel, the README and the engine comment all make to
    // the wearer: a louder room may only ever ease the toys off. It held for
    // every FALLING primary, but the milking modes cross-fade a RISING
    // secondary against that primary, and that term was reading the boosted
    // pulse: with the pulse pinned at 100 BPM an injected boost took the
    // secondary from 26-30 to 52-60, so a partner talking next to the wearer
    // sped up an internal toy. Sweep every mode, every game sub-state and
    // both ceiling rules, and assert it of BOTH channels.
    const modeStates = {
        oracle: { key: 'oracleState', values: ['APPROACH', 'HOLD', 'PURGATORY', 'CLIMAX', 'DENIAL'] },
        edgetrain: { key: 'trainingState', values: ['climb', 'hold', 'recover', 'finish'] }
    };

    const sweep = (visit) => {
        for (const mode of ENGINE_MODES) {
            const sub = modeStates[mode] || { key: 'unusedState', values: [null] };
            for (const subState of sub.values) {
                for (const ceilingBehaviour of ['stop', 'crawl']) {
                    for (const isEdged of [false, true]) {
                        for (const orgasmMode of [false, true]) {
                            for (const sessionStatus of ['RUNNING', 'RAMPDOWN']) {
                                for (const edgeHoldPercent of [90, 100]) {
                                    for (const extras of [
                                        {},
                                        { warmupMinutes: 5, sessionSeconds: 60 },
                                        { cadenceBreathing: true, milkingWave: true, sessionSeconds: 7 },
                                        { stallGuardEngaged: true },
                                        { intensityValue: 100 },
                                        { edgeStrokeDepth: 40, ruinHoldSeconds: 3 }
                                    ]) {
                                        visit({
                                            ...running,
                                            activeMode: mode,
                                            [sub.key]: subState,
                                            ceilingBehaviour,
                                            isEdged,
                                            orgasmMode,
                                            sessionStatus,
                                            edgeHoldPercent,
                                            ...extras
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    it('sweeps the engine\'s real sub-states, not names it made up', () => {
        // The table above writes the state names out by hand, so a rename in
        // engine.js would quietly send every sweep down the default branch
        // and narrow this whole file's coverage without failing anything.
        // Anchor it in behaviour: a state with its own branch must NOT look
        // like an unknown one, and the two that ARE the default branch
        // (Oracle APPROACH, Edge Training climb) must look exactly like it.
        // CLIMAX and 'finish' are deliberately the SAME branch as the climb:
        // both are only ever entered with Force Orgasm on (handled before the
        // switch), so the only way into them here is a cancel, and a cancel
        // settles on the state app.js is about to move the game to.
        const defaultBranch = { oracle: ['APPROACH', 'CLIMAX'], edgetrain: ['climb', 'finish'] };
        for (const [mode, sub] of Object.entries(modeStates)) {
            const shape = (value) => {
                const out = calculateEngineOutputs({
                    ...running,
                    activeMode: mode,
                    [sub.key]: value,
                    hr: 118,
                    edgeHr: 118
                });
                return [
                    out.primaryPercent, out.secondaryPercent,
                    out.strokeMinPercent, out.strokeMaxPercent
                ].join('/');
            };
            const unknown = shape('__no_such_state__');
            for (const value of sub.values) {
                if (defaultBranch[mode].includes(value)) {
                    assert.equal(shape(value), unknown, `${mode}/${value} is meant to BE the default branch`);
                } else {
                    assert.notEqual(
                        shape(value),
                        unknown,
                        `${mode}/${value} no longer has its own branch in engine.js - if it was renamed,`
                            + ' rename it here too, or this sweep silently stops covering it'
                    );
                }
            }
        }
    });

    it('holds for every mode, every sub-state and every measured pulse', () => {
        let checked = 0;
        sweep((base) => {
            for (const sensorHr of [70, 85, 100, 118, 126, 135, 140]) {
                // The boost is clamped to the working ceiling in app.js, so
                // the loop never sees more than that.
                for (const boost of [1, 5, 8, 20]) {
                    const quiet = calculateEngineOutputs({ ...base, hr: sensorHr, edgeHr: sensorHr });
                    const loud = calculateEngineOutputs({
                        ...base,
                        hr: Math.min(base.maxHr, sensorHr + boost),
                        edgeHr: sensorHr
                    });
                    const where = `${base.activeMode}/${base.oracleState || base.trainingState || '-'}`
                        + ` ${base.sessionStatus} ${base.ceilingBehaviour}`
                        + ` edged=${base.isEdged} orgasm=${base.orgasmMode}`
                        + ` hr=${sensorHr} +${boost}`;
                    assert.ok(
                        loud.primaryPercent <= quiet.primaryPercent,
                        `${where}: boost raised the primary ${quiet.primaryPercent} -> ${loud.primaryPercent}`
                    );
                    assert.ok(
                        loud.secondaryPercent <= quiet.secondaryPercent,
                        `${where}: boost raised the secondary ${quiet.secondaryPercent} -> ${loud.secondaryPercent}`
                    );
                    // A boost must not invent an edge or release one either.
                    assert.equal(loud.isEdged, quiet.isEdged, `${where}: boost moved the edge flag`);
                    assert.equal(loud.newEdgeTriggered, quiet.newEdgeTriggered, `${where}: boost counted an edge`);
                    checked += 1;
                }
            }
        });
        assert.ok(checked > 2000, `expected a real sweep, ran ${checked} comparisons`);
    });

    it('still eases the milking secondary off, and only off', () => {
        // The measured regression, pinned: pulse 100, Prostate Milker.
        const base = { ...running, activeMode: 'milker', hr: 100, edgeHr: 100, isEdged: false };
        const quiet = calculateEngineOutputs(base);
        const loud = calculateEngineOutputs({ ...base, hr: 120 });
        assert.equal(loud.secondaryPercent, quiet.secondaryPercent, 'the rising secondary reads the sensor alone');
        assert.ok(loud.primaryPercent < quiet.primaryPercent, 'the falling primary still hears the room');
        // The depth contraction keeps reading the boosted pulse: less travel.
        const deep = { ...base, edgeStrokeDepth: 40 };
        const deepQuiet = calculateEngineOutputs(deep);
        const deepLoud = calculateEngineOutputs({ ...deep, hr: 120 });
        assert.ok(deepLoud.strokeMaxPercent < deepQuiet.strokeMaxPercent, 'the boost still shortens the stroke');
    });

    it('a rising secondary on the measured pulse is not frozen', () => {
        // Easing off must not mean "deaf": the cross-fade still follows the
        // wearer's own pulse all the way up.
        const low = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 80, edgeHr: 80 });
        const high = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 130, edgeHr: 130 });
        assert.ok(high.secondaryPercent > low.secondaryPercent);
    });
});

describe('the Guards pullback preview', () => {
    it('quotes the percentage only while the percentage is what produced the mark', () => {
        assert.equal(
            describeEdgeHoldPreview({ typedMaxHr: 140, workingMaxHr: 140, minHr: 70, holdPercent: 100 }),
            'Pullback at 140 BPM (100% of 140)'
        );
        assert.equal(
            describeEdgeHoldPreview({ typedMaxHr: 140, workingMaxHr: 125, minHr: 70, holdPercent: 95 }),
            'Pullback at 119 BPM (95% of 125, the working ceiling right now)'
        );
    });

    it('says what really happened when the resting-rate floor lifts the mark', () => {
        // A low prostate ceiling of the kind the README sends you to
        // (Climax 92-95) with a resting rate close under it: Resting 88,
        // Climax 95, Pullback 90%. The mark is lifted to 94 to leave the
        // 5 BPM release band, and 90% of 95 is 86 - the old line printed
        // both numbers side by side and one of them was fiction.
        const text = describeEdgeHoldPreview({ typedMaxHr: 95, workingMaxHr: 95, minHr: 88, holdPercent: 90 });
        assert.equal(text, 'Pullback at 94 BPM - 90% of 95 is 86, lifted to clear your Resting HR (88)');
        assert.equal(resolveEdgeTriggerHr(95, 90, 88), 94);
    });

    it('never prints a percentage that does not produce the BPM beside it', () => {
        // The property, over every pair the inputs allow: if the line reads
        // "N BPM (P% of M)" then P% of M must really be N.
        let lifted = 0;
        for (let minHr = 40; minHr <= 120; minHr += 4) {
            for (let maxHr = minHr + 1; maxHr <= 200; maxHr += 3) {
                for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct += 1) {
                    const text = describeEdgeHoldPreview({
                        typedMaxHr: maxHr, workingMaxHr: maxHr, minHr, holdPercent: pct
                    });
                    const trigger = resolveEdgeTriggerHr(maxHr, pct, minHr);
                    assert.ok(text.startsWith(`Pullback at ${trigger} BPM`), text);
                    const quoted = text.match(/\((\d+)% of (\d+)\)$/);
                    if (quoted) {
                        assert.equal(
                            Math.min(maxHr, Math.max(1, Math.round(Number(quoted[2]) * (Number(quoted[1]) / 100)))),
                            trigger,
                            `the quoted percentage must produce the mark: ${text}`
                        );
                    } else {
                        lifted += 1;
                        assert.ok(/lifted to clear your Resting HR/.test(text), text);
                        assert.ok(text.includes(`${pct}% of ${maxHr} is `), text);
                    }
                }
            }
        }
        assert.ok(lifted > 0, 'the sweep must have covered the lifted case');
    });

    it('does not fall over without usable limits', () => {
        const text = describeEdgeHoldPreview({ typedMaxHr: NaN, workingMaxHr: NaN, minHr: NaN, holdPercent: 95 });
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 0);
    });
});

describe('Survival Mode and Ruin & Leak are the documented exceptions to the ceiling rule', () => {
    it('keeps climbing whatever the At-the-ceiling setting says', () => {
        // Deliberate: the toys keep the speed floor on the mark, which is
        // why the Guards text and the README name Survival as one of the
        // two modes Full Stop / Crawl does not govern. The run does not end
        // there. Each edge raises the mark instead.
        for (const ceilingBehaviour of ['stop', 'crawl']) {
            for (const activeMode of ['survival', 'calibrate']) {
                const onTheMark = calculateEngineOutputs({
                    ...running,
                    activeMode,
                    survivalSpeedFloor: 61,
                    hr: 140,
                    isEdged: true,
                    ceilingBehaviour
                });
                assert.equal(onTheMark.primaryPercent, 61, `${activeMode} ignores ${ceilingBehaviour} by design`);
            }
        }
    });

    it('Ruin & Leak rides through the edge, then the lockout is a dead stop', () => {
        // The ride ignores Crawl and Full Stop. The lockout is a dead stop
        // on the primary either way, with the secondary dropped low.
        for (const ceilingBehaviour of ['stop', 'crawl']) {
            const ride = calculateEngineOutputs({
                ...running, activeMode: 'ruin', hr: 140, edgeHr: 140, isEdged: true,
                ruinHoldSeconds: 0, sessionSeconds: 0, ceilingBehaviour
            });
            assert.ok(ride.primaryPercent > 0, `ruin keeps stroking on ${ceilingBehaviour}`);
            const lockout = calculateEngineOutputs({
                ...running, activeMode: 'ruin', hr: 100, edgeHr: 100, isEdged: false,
                ruinHoldSeconds: 12, ceilingBehaviour
            });
            assert.equal(lockout.primaryPercent, 0, `ruin's lockout ignores ${ceilingBehaviour} by design`);
            assert.equal(lockout.secondaryPercent, 18);
        }
    });

    it('the Guards text, both mode cards and the README name BOTH exceptions', () => {
        const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
        const guards = read('index.html');
        const readme = read('README.md');
        const claims = [
            ['index.html Guards text', guards.match(/Crawl<\/strong> keeps a 10% micro-motion[\s\S]*?<\/p>/)],
            ['README Guards bullet', readme.match(/\*Crawl\* keeps a 10% micro-motion[^\n]*/)]
        ];
        for (const [where, match] of claims) {
            assert.ok(match, `${where}: anchor missing, the guard would be vacuous`);
            assert.ok(
                /Survival Mode/.test(match[0]),
                `${where} claims the ceiling rule applies everywhere without naming Survival: ${match[0]}`
            );
            assert.ok(
                /Ruin &(amp;)? Leak/.test(match[0]),
                `${where} must name Ruin & Leak too - its lockout ignores the setting: ${match[0]}`
            );
            assert.ok(
                !/The exception is/.test(match[0]),
                `${where} still calls one mode THE exception: ${match[0]}`
            );
        }
        const app = read('src/js/app.js');
        const survivalDetail = app.match(/survival: '([^']*)'/);
        const calibrateDetail = app.match(/calibrate: '([^']*)'/);
        const ruinDetail = app.match(/ruin: '([^']*)'/);
        assert.ok(survivalDetail, 'Survival detail anchor missing');
        assert.ok(calibrateDetail, 'Calibration detail anchor missing');
        assert.ok(ruinDetail, 'Ruin & Leak detail anchor missing');
        assert.ok(
            /At the ceiling/.test(survivalDetail[1]),
            `the Survival detail must say the rule does not govern it: ${survivalDetail[1]}`
        );
        assert.ok(
            /At the ceiling/.test(calibrateDetail[1]),
            `the Calibration detail must say the rule does not govern it: ${calibrateDetail[1]}`
        );
        assert.ok(
            /At the ceiling/.test(ruinDetail[1]),
            `the Ruin & Leak detail must say the rule does not govern it either: ${ruinDetail[1]}`
        );
    });
});

describe('the MIC badge only promises a push that reaches a motor', () => {
    it('names the modes the boosted pulse can reach', () => {
        for (const mode of ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin']) {
            assert.equal(micBoostReachesMotors(mode), true, `${mode} teases down on the boosted pulse`);
        }
        assert.equal(micBoostReachesMotors('oracle'), false);
        assert.equal(micBoostReachesMotors('edgetrain'), false);
        // Survival's speeds run off its own clock; the boost can only shorten
        // the stroke zone, and at full depth there is no contraction at all.
        assert.equal(micBoostReachesMotors('survival', { edgeStrokeDepth: 100 }), false);
        assert.equal(micBoostReachesMotors('survival', { edgeStrokeDepth: 40 }), true);
        assert.equal(micBoostReachesMotors('calibrate', { edgeStrokeDepth: 100 }), false);
        assert.equal(micBoostReachesMotors('calibrate', { edgeStrokeDepth: 40 }), true);
        assert.equal(micBoostReachesMotors('not-a-mode'), true, 'unknown modes are classic');
    });

    it('a mode it calls blind really does ignore the boost, in every sub-state', () => {
        // The cockpit badge is only honest if this list is the list the
        // engine computes from, so take the answer from the engine itself:
        // where the helper says nothing is reached, the outputs must be
        // identical with and without a boost.
        const probes = [
            { activeMode: 'oracle', oracleState: 'APPROACH' },
            { activeMode: 'oracle', oracleState: 'HOLD' },
            { activeMode: 'oracle', oracleState: 'PURGATORY' },
            { activeMode: 'oracle', oracleState: 'DENIAL' },
            { activeMode: 'edgetrain', trainingState: 'climb' },
            { activeMode: 'edgetrain', trainingState: 'hold' },
            { activeMode: 'edgetrain', trainingState: 'recover' },
            { activeMode: 'survival' },
            { activeMode: 'calibrate' }
        ];
        let checked = 0;
        for (const probe of probes) {
            assert.equal(
                micBoostReachesMotors(probe.activeMode, { edgeStrokeDepth: 100 }),
                false,
                `${probe.activeMode} is meant to be one of the blind modes`
            );
            for (const sensorHr of [80, 100, 120, 135, 140]) {
                for (const isEdged of [false, true]) {
                    const base = { ...running, ...probe, edgeStrokeDepth: 100, isEdged, edgeHr: sensorHr };
                    const quiet = calculateEngineOutputs({ ...base, hr: sensorHr });
                    const loud = calculateEngineOutputs({ ...base, hr: Math.min(base.maxHr, sensorHr + 8) });
                    assert.deepEqual(
                        [loud.primaryPercent, loud.secondaryPercent, loud.strokeMinPercent, loud.strokeMaxPercent],
                        [quiet.primaryPercent, quiet.secondaryPercent, quiet.strokeMinPercent, quiet.strokeMaxPercent],
                        `${probe.activeMode}/${probe.oracleState || probe.trainingState || '-'} at ${sensorHr}`
                            + ' is called blind but the boost moved its output'
                    );
                    checked += 1;
                }
            }
        }
        assert.ok(checked > 0);
        // A mode it does NOT call blind must really use the boosted pulse.
        const teaseQuiet = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120, edgeHr: 120 });
        const teaseLoud = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 128, edgeHr: 120 });
        assert.ok(teaseLoud.primaryPercent < teaseQuiet.primaryPercent, 'a tease mode must feel the boost');
    });

    it('app.js gates the badge on that helper', () => {
        // The badge text is written in app.js; the helper is worthless if the
        // cockpit does not ask it before promising MIC +N.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/micBoostReachesMotors\(/.test(src), 'app.js must ask which modes the boost reaches');
        const badge = src.match(/const micApplied = [^;]*;/);
        assert.ok(badge, 'the badge value anchor moved');
        assert.ok(
            /micReaches/.test(badge[0]),
            `the badge must report nothing in a blind mode: ${badge[0]}`
        );
    });
});
