import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodePacket,
    decodePackets,
    normalizeSync,
    extrapolateSync,
    matchLibrary
} from './sync-protocol.js';

describe('DeoVR / HereSphere packets', () => {
    it('round-trips a playback report and ignores a ping', () => {
        const packet = encodePacket({
            path: '/storage/Movies/Scene.mp4',
            duration: 120,
            currentTime: 10.5,
            playbackSpeed: 1,
            playerState: 0
        });
        const ping = encodePacket(null);
        const { messages, rest } = decodePackets(Buffer.concat([ping, packet]));
        assert.equal(rest.length, 0);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].playing, true);
        assert.equal(messages[0].mediaMs, 10500);
        assert.equal(messages[0].path, '/storage/Movies/Scene.mp4');
    });

    it('holds a partial packet until the rest arrives', () => {
        const packet = encodePacket({ currentTime: 1, playerState: 1, playbackSpeed: 1, path: 'A.mp4' });
        const head = decodePackets(packet.subarray(0, 6));
        assert.equal(head.messages.length, 0);
        assert.ok(head.rest.length > 0);
        const full = decodePackets(Buffer.concat([head.rest, packet.subarray(6)]));
        assert.equal(full.messages[0].playing, false);
        assert.equal(full.messages[0].mediaMs, 1000);
    });

    it('reads a HereSphere resource path', () => {
        const sync = normalizeSync({ resource: '/vids/Clip.mp4', currentTime: 3, playerState: 0 });
        assert.equal(sync.path, '/vids/Clip.mp4');
        assert.equal(sync.playing, true);
    });

    it('advances only while playing', () => {
        const playing = { mediaMs: 1000, at: 5000, rate: 2, playing: true };
        assert.equal(extrapolateSync(playing, 5500), 2000);
        const paused = { ...playing, playing: false };
        assert.equal(extrapolateSync(paused, 9000), 1000);
    });
});

describe('library match', () => {
    const files = [
        { name: 'Scene.funscript', id: 'stroke' },
        { name: 'Scene.v0.funscript', id: 'vib' },
        { name: 'Other.funscript', id: 'other' }
    ];

    it('pairs a headset path with scripts of the same name', () => {
        const match = matchLibrary('/storage/emulated/0/Movies/Scene.mp4', files);
        assert.equal(match.stroke.id, 'stroke');
        assert.equal(match.vib.id, 'vib');
    });

    it('pairs nothing when the folder has no script for that video', () => {
        const match = matchLibrary('D:\\vids\\Missing.mp4', files);
        assert.equal(match.stroke, null);
        assert.equal(match.vib, null);
    });
});
