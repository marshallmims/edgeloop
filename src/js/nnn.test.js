import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshNnn, catchUpNnn, addMissedDay, tickNnnHold, recordNnnEdge, rollNnnOutcome, dateKey } from './nnn.js';

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
        assert.equal(next.lastDate, '2026-10-08');
        assert.equal(next.quotaToday, 6, 'one skipped day adds one day of edges');
        assert.equal(next.holdSeconds, 15);
        assert.equal(next.edgesToday, 0);
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
