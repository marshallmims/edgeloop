import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createStrokePlanner,
    legDurationMs,
    normalizePlannerInput,
    FAST_LEG_MS,
    SLOW_LEG_MS,
    MIN_LEG_MS,
    REST_MOVE_MS
} from './stroke-planner.js';

describe('legDurationMs', () => {
    it('maps 100 % to the fast leg and 0 % to the slow leg over full travel', () => {
        assert.equal(legDurationMs(100, 1), FAST_LEG_MS);
        assert.equal(legDurationMs(0, 1), SLOW_LEG_MS);
        assert.equal(legDurationMs(50, 1), Math.round(FAST_LEG_MS + 0.5 * (SLOW_LEG_MS - FAST_LEG_MS)));
    });
    it('scales with travel and never drops below the minimum', () => {
        assert.equal(legDurationMs(0, 0.5), SLOW_LEG_MS / 2);
        assert.equal(legDurationMs(100, 0.1), MIN_LEG_MS);
        assert.equal(legDurationMs(100, 0), MIN_LEG_MS);
    });
    it('tolerates garbage', () => {
        // speed 0 over the minimum travel of 8 %: 2200 * 0.08
        assert.equal(legDurationMs('abc', NaN), 176);
        assert.equal(legDurationMs(500, 5), FAST_LEG_MS);
    });
});

describe('normalizePlannerInput', () => {
    it('clamps and orders the zone, scales speed by cap', () => {
        const n = normalizePlannerInput({ speed: 80, zoneMin: 0.9, zoneMax: 0.2, cap: 50 });
        assert.equal(n.zoneMin, 0.9);
        assert.equal(n.zoneMax, 0.9);
        assert.equal(n.effectiveSpeed, 40);
        assert.equal(n.enabled, true);
    });
    it('falls back on garbage', () => {
        const n = normalizePlannerInput({ speed: 'x', zoneMin: null, zoneMax: 'y', cap: undefined, enabled: false });
        assert.deepEqual([n.speed, n.zoneMin, n.zoneMax, n.cap, n.enabled], [0, 0, 1, 100, false]);
    });
});

describe('stroke planner', () => {
    it('alternates between zone max and zone min, one leg per call', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(1000);
        assert.deepEqual(a, { position: 0.8, durationMs: legDurationMs(100, 0.6), kind: 'stroke' });
        assert.equal(p.isInFlight(1000 + a.durationMs - 1), true);
        assert.equal(p.legEndsAt(), 1000 + a.durationMs);
        const b = p.next(1000 + a.durationMs);
        assert.equal(b.position, 0.2);
        const c = p.next(1000 + a.durationMs + b.durationMs);
        assert.equal(c.position, 0.8);
    });

    it('never re-sends while a leg is in flight', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 30, zoneMin: 0, zoneMax: 1 });
        const a = p.next(0);
        assert.ok(a);
        for (let t = 1; t < a.durationMs; t += 50) {
            assert.equal(p.next(t), null, `re-sent at t=${t}`);
        }
        assert.ok(p.next(a.durationMs));
    });

    it('applies speed and zone changes to the next leg only', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(0);
        p.setInput({ speed: 10, zoneMin: 0.4, zoneMax: 0.6 });
        assert.equal(p.next(10), null);
        assert.equal(p.legEndsAt(), a.durationMs);
        const b = p.next(a.durationMs);
        assert.equal(b.position, 0.4);
        // The sleeve sits at 0.8 after leg a: the move to 0.4 covers 0.4, not
        // the new zone's 0.2, and is timed for what it really travels.
        assert.equal(b.durationMs, legDurationMs(10, 0.4));
        const c = p.next(a.durationMs + b.durationMs);
        assert.equal(c.position, 0.6);
        assert.equal(c.durationMs, legDurationMs(10, 0.2));
    });

    it('issues a single rest move on speed 0 and then stays silent', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(0);
        p.setInput({ speed: 0 });
        // Still in flight: the running stroke is not snapped.
        assert.equal(p.next(a.durationMs - 1), null);
        const rest = p.next(a.durationMs);
        assert.deepEqual(rest, { position: 0.2, durationMs: REST_MOVE_MS, kind: 'rest' });
        assert.equal(p.isResting(), true);
        assert.equal(p.next(a.durationMs + REST_MOVE_MS), null);
        assert.equal(p.next(a.durationMs + REST_MOVE_MS + 5000), null);
        // Speed returns: the first stroke goes up from the rest position.
        p.setInput({ speed: 50 });
        const up = p.next(a.durationMs + REST_MOVE_MS + 6000);
        assert.equal(up.position, 0.8);
        assert.equal(p.isResting(), false);
    });

    it('treats role OFF (enabled: false) like speed 0', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.1, zoneMax: 0.9, enabled: false });
        const rest = p.next(0);
        assert.equal(rest.kind, 'rest');
        assert.equal(rest.position, 0.1);
        assert.equal(p.next(REST_MOVE_MS), null);
    });

    it('a rest move is sent even when the axis is idle at start', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0.3, zoneMax: 0.7 });
        assert.equal(p.next(0).position, 0.3);
        assert.equal(p.next(REST_MOVE_MS), null);
    });

    it('scales the speed by the cap', () => {
        const capped = createStrokePlanner();
        capped.setInput({ speed: 100, cap: 50, zoneMin: 0, zoneMax: 1 });
        const plain = createStrokePlanner();
        plain.setInput({ speed: 50, cap: 100, zoneMin: 0, zoneMax: 1 });
        const cappedLeg = capped.next(0);
        assert.equal(cappedLeg.durationMs, plain.next(0).durationMs);
        assert.equal(cappedLeg.durationMs > legDurationMs(100, 1), true);
    });

    it('cap 0 rests the axis', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, cap: 0, zoneMin: 0.2, zoneMax: 0.8 });
        assert.equal(p.next(0).kind, 'rest');
    });

    it('reset forgets the in-flight leg and re-issues a rest move', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0.2, zoneMax: 0.8 });
        assert.equal(p.next(0).kind, 'rest');
        assert.equal(p.next(REST_MOVE_MS), null);
        p.reset();
        assert.equal(p.next(REST_MOVE_MS).kind, 'rest');
    });
    it('sizes the first leg after a rest or zone shift by the distance really travelled', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0, zoneMax: 1 });
        assert.equal(p.next(0).position, 0, 'resting at the envelope bottom');
        p.setInput({ speed: 100, zoneMin: 0.6, zoneMax: 0.8 });
        const leg = p.next(REST_MOVE_MS);
        assert.equal(leg.position, 0.8);
        assert.equal(leg.durationMs, legDurationMs(100, 0.8), 'an 80 % move is not timed like a 20 % zone');
        const back = p.next(REST_MOVE_MS + leg.durationMs);
        assert.equal(back.position, 0.6);
        assert.equal(back.durationMs, legDurationMs(100, 0.2));
    });

    it('role OFF interrupts the leg in flight with an immediate rest move', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 5, zoneMin: 0, zoneMax: 1 });
        const leg = p.next(0);
        assert.ok(leg.durationMs > 2000);
        p.setInput({ enabled: false });
        const rest = p.next(100);
        assert.deepEqual(rest, { position: 0, durationMs: REST_MOVE_MS, kind: 'rest' });
        assert.equal(p.next(200), null);
        // Speed 0 (STOP / pause) still lets the running stroke finish.
        p.setInput({ speed: 5, enabled: true });
        const again = p.next(100 + REST_MOVE_MS);
        assert.equal(again.kind, 'stroke');
        p.setInput({ speed: 0 });
        assert.equal(p.next(100 + REST_MOVE_MS + 50), null);
    });

    it('legTravel times the leg by speed alone so a small swing is a slow swing', () => {
        const slow = createStrokePlanner();
        slow.setInput({ speed: 10, zoneMin: 0.45, zoneMax: 0.55, legTravel: 1 });
        const fast = createStrokePlanner();
        fast.setInput({ speed: 50, zoneMin: 0.25, zoneMax: 0.75, legTravel: 1 });
        const a = slow.next(0).durationMs;
        const b = fast.next(0).durationMs;
        assert.equal(a, legDurationMs(10, 1));
        assert.equal(b, legDurationMs(50, 1));
        assert.ok(a > b, 'the period falls as the speed rises');
    });
});

describe('a holding planner', () => {
    it('stops where it is instead of sending a rest move', () => {
        const p = createStrokePlanner({ hold: true });
        p.setInput({ speed: 40, zoneMin: 0.2, zoneMax: 0.8 });
        const stroke = p.next(0);
        assert.equal(stroke.kind, 'stroke');
        p.setInput({ speed: 0 });
        const held = p.next(stroke.durationMs);
        assert.equal(held.kind, 'hold');
        assert.equal(held.position, null);
        assert.equal(p.next(stroke.durationMs + 1), null);
    });
});
