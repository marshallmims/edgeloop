import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatLiveHr } from './hr-readout.js';

describe('formatLiveHr', () => {
    it('stays blank until a monitor has delivered a reading', () => {
        assert.equal(formatLiveHr({ bpm: 70, linked: false, seen: false }), '--');
        assert.equal(formatLiveHr({ bpm: 70, linked: false, seen: true }), '--');
        assert.equal(formatLiveHr({ bpm: 70, linked: true, seen: false }), '--');
        assert.equal(formatLiveHr({ bpm: 90, linked: true, seen: true }), '90');
        assert.equal(formatLiveHr({ bpm: 90.6, linked: true, seen: true }), '91');
    });

    it('shows the simulator value, including a resting 70', () => {
        assert.equal(formatLiveHr({ bpm: 70, simulated: true }), '70');
        assert.equal(formatLiveHr({ bpm: 140, simulated: true, linked: false, seen: false }), '140');
    });

    it('rejects a number that is not a pulse', () => {
        assert.equal(formatLiveHr({ bpm: 0, linked: true, seen: true }), '--');
        assert.equal(formatLiveHr({ bpm: NaN, linked: true, seen: true }), '--');
        assert.equal(formatLiveHr({ bpm: 34, linked: true, seen: true }), '--');
    });
});

describe('the cockpit pulse', () => {
    it('starts blank and is painted from the live readout', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.match(html, /id="hrDisplay">--</);
        assert.equal(html.includes('id="hrDisplay">70<'), false);
        assert.match(app, /paintLiveHr\(sensorHr\)/);
        assert.equal(app.includes('hrDisplay.textContent = sensorHr'), false);
        assert.equal(app.includes('hrDisplay.textContent = state.hrCurrent'), false);
    });
});
