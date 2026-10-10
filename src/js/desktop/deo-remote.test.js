import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodePing, encodeState, encodeCommand, interpretPacket, createPacketReader,
    PLAYER_PLAYING, PLAYER_PAUSED, DEO_PORT
} from './deo-remote.js';

function jsonOf(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(0, true);
    return JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + len)));
}

describe('HereSphere / DeoVR timestamp packets', () => {
    it('uses the port the headset already listens on', () => {
        assert.equal(DEO_PORT, 23554);
    });

    it('a state packet carries the path, the time, and playing as 0', () => {
        const bytes = encodeState({
            path: 'smb://nas/media/Scene.mp4',
            duration: 120.5,
            currentTime: 10.25,
            playbackSpeed: 1,
            motion: 'playing'
        });
        assert.deepEqual(jsonOf(bytes), {
            path: 'smb://nas/media/Scene.mp4',
            duration: 120.5,
            currentTime: 10.25,
            playbackSpeed: 1,
            playerState: PLAYER_PLAYING
        });
        const reader = createPacketReader();
        const [packet] = reader.push(bytes);
        assert.equal(packet.kind, 'state');
        assert.equal(packet.motion, 'playing');
        assert.equal(packet.currentTime, 10.25);
        assert.equal(packet.path, 'smb://nas/media/Scene.mp4');
    });

    it('a missing playerState still means playing', () => {
        const seen = interpretPacket({ path: 'a.mp4', currentTime: 3, duration: 9, playbackSpeed: 1 });
        assert.equal(seen.motion, 'playing');
        assert.equal(seen.playerState, PLAYER_PLAYING);
    });

    it('pause is playerState 1', () => {
        const [packet] = createPacketReader().push(encodeState({ path: 'a.mp4', currentTime: 3, motion: 'paused' }));
        assert.equal(packet.motion, 'paused');
        assert.equal(packet.playerState, PLAYER_PAUSED);
    });

    it('a zero length is a ping, and a split packet is finished on the next chunk', () => {
        const ping = encodePing();
        const state = encodeState({ path: 'a.mp4', currentTime: 1, duration: 2 });
        const reader = createPacketReader();
        assert.deepEqual(reader.push(ping).map((p) => p.kind), ['ping']);
        const split = reader.push(state.slice(0, 6));
        assert.equal(split.length, 0);
        const rest = reader.push(state.slice(6));
        assert.equal(rest.length, 1);
        assert.equal(rest[0].path, 'a.mp4');
    });

    it('two packets in one chunk both come out', () => {
        const a = encodeState({ path: 'a.mp4', currentTime: 1 });
        const b = encodeCommand({ currentTime: 40 });
        const both = new Uint8Array(a.length + b.length);
        both.set(a, 0);
        both.set(b, a.length);
        const packets = createPacketReader().push(both);
        assert.equal(packets.length, 2);
        assert.equal(packets[0].currentTime, 1);
        assert.equal(packets[1].currentTime, 40);
    });

    it('a command carries only the fields that were set', () => {
        assert.deepEqual(jsonOf(encodeCommand({ currentTime: 12 })), { currentTime: 12 });
        assert.deepEqual(jsonOf(encodeCommand({})), {});
    });

    it('refuses a length that cannot be a timestamp packet', () => {
        const bad = new Uint8Array(4);
        new DataView(bad.buffer).setUint32(0, 2_000_000, true);
        assert.throws(() => createPacketReader().push(bad), /too large/);
    });
});
