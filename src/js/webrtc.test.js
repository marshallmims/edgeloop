import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkQualityFromStats, peerErrorCode, routeHostCommand } from './webrtc.js';

describe('Share Control stats', () => {
    it('keeps round trip and loss, and has no field for an address', () => {
        const reports = [
            {
                type: 'local-candidate',
                address: '192.168.1.20',
                port: 54400,
                url: 'stun:example'
            },
            {
                type: 'candidate-pair',
                state: 'succeeded',
                nominated: true,
                currentRoundTripTime: 0.042,
                remoteAddress: '203.0.113.8'
            },
            { type: 'inbound-rtp', packetsLost: 3, jitter: 0.008, remoteId: 'peer-secret' }
        ];
        const quality = linkQualityFromStats(reports);
        assert.deepEqual(quality, { rttMs: 42, jitterMs: 8, packetsLost: 3 });
        const text = JSON.stringify(quality);
        assert.equal(text.includes('192.168'), false);
        assert.equal(text.includes('203.0.113'), false);
        assert.equal(text.includes('peer-secret'), false);
        assert.equal(text.includes('stun:'), false);
    });

    it('still hands a manual frame to the host, and leaves it out of the log', () => {
        const frame = routeHostCommand({
            type: 'MANUAL_FRAME',
            epoch: 2,
            devices: [{ id: 'handy', speed: 40, strokeMin: 0, strokeMax: 100, level: 0 }]
        }, 'controller');
        assert.equal(frame.trace, false);
        assert.equal(frame.cmd.type, 'MANUAL_FRAME');
        assert.equal(frame.cmd.devices[0].speed, 40);
        const pattern = routeHostCommand({
            type: 'MANUAL_PATTERN',
            epoch: 3,
            id: 'pulse',
            periodMs: 2000,
            devices: [{ id: 'handy', speed: 70, strokeMin: 0, strokeMax: 100, level: 0 }]
        }, 'controller');
        assert.equal(pattern.trace, false);
        assert.equal(pattern.cmd.type, 'MANUAL_PATTERN');
        const mode = routeHostCommand({ type: 'MODE_CHANGE', mode: 'classic', enabled: true }, 'controller');
        assert.equal(mode.trace, true);
        assert.equal(mode.cmd.type, 'MODE_CHANGE');
        assert.equal(routeHostCommand({ type: 'NOPE' }, 'controller'), null);
    });

    it('names an error by its code, not by a message that may carry an id', () => {
        assert.equal(peerErrorCode({ type: 'peer-unavailable', message: 'Could not connect to peer room-secret' }), 'peer-unavailable');
        assert.equal(peerErrorCode({ type: 'something-else', message: '1.2.3.4' }), 'unknown');
        assert.equal(peerErrorCode(null), 'unknown');
    });
});
