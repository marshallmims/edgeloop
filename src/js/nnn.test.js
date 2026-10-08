import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshNnn, catchUpNnn, addMissedDay, tickNnnHold, recordNnnEdge, rollNnnOutcome, dateKey, describeNnn } from './nnn.js';

describe('NNN practice', () => {
    it('starts at the daily quota with no hold', () => {
        const state = freshNnn(new Date('2026-10-08T12:00:00'), { dailyEdges: 3, denialPercent: 40 });
        assert.equal(state.quotaToday, 3);
        assert.equal(state.holdSeconds, 0);
        assert.equal(state.denialPercent, 40);
    });

    it('adds skipped days onto the next day and asks for a longer hold', () => {
        const state = freshNnn(new Date('2026-10-06T12:00:00'), { dailyEdges: 3 });
        const next = catchUpNnn(state, new Date('2026-10-08T12:00:00'));
        assert.equal(next.lastOpened, '2026-10-08');
        assert.equal(next.quotaToday, 6, 'one skipped day adds one day of edges');
        assert.equal(next.holdSeconds, 15);
        assert.equal(next.edgesToday, 0);
    });

    it('counts days before the first open, and waits when the start date is still ahead', () => {
        const started = freshNnn(new Date('2026-11-01T12:00:00'), { dailyEdges: 3, startDate: '2026-11-01', endDate: '2026-11-30' });
        const late = catchUpNnn({ ...started, lastOpened: null }, new Date('2026-11-04T12:00:00'));
        assert.equal(late.quotaToday, 12, 'Nov 1, 2, and 3 were missed, plus today');
        assert.equal(late.holdSeconds, 45);
        const early = catchUpNnn(started, new Date('2026-10-08T12:00:00'));
        assert.equal(early.holdSeconds, 0);
        assert.match(describeNnn(early, new Date('2026-10-08T12:00:00')), /Starts 2026-11-01/);
        const during = catchUpNnn(freshNnn(new Date('2026-11-01T12:00:00'), { startDate: '2026-11-01', endDate: '2026-11-30' }), new Date('2026-11-01T12:00:00'));
        assert.match(describeNnn(during, new Date('2026-11-01T12:00:00')), /Day 1 of 30/);
    });

    it('does not punish a day you already opened', () => {
        const state = { ...freshNnn(new Date('2026-10-07T12:00:00')), edgesToday: 2 };
        const same = catchUpNnn(state, new Date('2026-10-07T18:00:00'));
        assert.equal(same.edgesToday, 2);
        assert.equal(dateKey(new Date('2026-10-07T18:00:00')), '2026-10-07');
    });

    it('counts a held edge only after the hold', () => {
        let state = addMissedDay(freshNnn(new Date('2026-10-08T12:00:00'), { dailyEdges: 1 }));
        assert.equal(state.holdSeconds, 15);
        let counted = false;
        for (let i = 0; i < 14; i += 1) {
            const tick = tickNnnHold(state, true);
            state = tick.state;
            counted = counted || tick.counted;
        }
        assert.equal(counted, false);
        const done = tickNnnHold(state, true);
        assert.equal(done.counted, true);
    });

    it('finishes the quota and can deny or permit', () => {
        const recorded = recordNnnEdge(freshNnn(new Date('2026-10-08T12:00:00'), { dailyEdges: 1 }));
        assert.equal(recorded.justFinished, true);
        assert.equal(rollNnnOutcome(100, () => 0.2), 'denied');
        assert.equal(rollNnnOutcome(0, () => 0.2), 'permitted');
    });
});
