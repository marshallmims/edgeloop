import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkQualityFromStats, peerErrorCode } from './webrtc.js';

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

    it('names an error by its code, not by a message that may carry an id', () => {
        assert.equal(peerErrorCode({ type: 'peer-unavailable', message: 'Could not connect to peer room-secret' }), 'peer-unavailable');
        assert.equal(peerErrorCode({ type: 'something-else', message: '1.2.3.4' }), 'unknown');
        assert.equal(peerErrorCode(null), 'unknown');
    });
});
