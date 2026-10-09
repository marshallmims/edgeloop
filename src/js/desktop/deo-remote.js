// The timestamp protocol HereSphere and DeoVR speak, and that ScriptPlayer
// connects to. HereSphere hosts it (the "timestamp server" in its settings,
// port 23554). A program that wants the headset's clock connects to that
// port. The same bytes can be hosted here, so a tool that already knows how
// to follow DeoVR can follow a video playing in EdgeLoop.
//
// A packet is a 4-byte little-endian length, then that many bytes of UTF-8
// JSON. A length of 0 is a ping. The player sends one packet a second, and
// the other side must answer about once a second or the link is dropped.
//
// playerState: 0 playing, 1 paused, 2 finished. A playing packet often omits
// playerState, because 0 is the zero value on the other end. Missing means
// playing. duration and currentTime are seconds.

export const DEO_PORT = 23554;
export const PLAYER_PLAYING = 0;
export const PLAYER_PAUSED = 1;
export const PLAYER_FINISHED = 2;
export const MAX_PACKET_BYTES = 1_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(a, b) {
    if (a.length === 0) return b instanceof Uint8Array ? b : Uint8Array.from(b);
    const next = b instanceof Uint8Array ? b : Uint8Array.from(b);
    const out = new Uint8Array(a.length + next.length);
    out.set(a, 0);
    out.set(next, a.length);
    return out;
}

function encodeJson(obj) {
    const json = encoder.encode(JSON.stringify(obj));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length, true);
    out.set(json, 4);
    return out;
}

export function encodePing() {
    return new Uint8Array(4);
}

// The clock, as the headset sends it: every field present, including zeros,
// so a client at the start of a file can tell "time is 0" from "no packet".
export function encodeState(state = {}) {
    const playerState = normalizePlayerState(state.playerState ?? state.motion);
    return encodeJson({
        path: typeof state.path === 'string' ? state.path : '',
        duration: finite(state.duration) ? state.duration : 0,
        currentTime: finite(state.currentTime) ? state.currentTime : 0,
        playbackSpeed: finite(state.playbackSpeed) ? state.playbackSpeed : 1,
        playerState
    });
}

// A command to the headset. Only the fields you set are sent. Sending
// playerState 0 on every ping would be "start playing" to a strict reader,
// so a seek does not also force a state.
export function encodeCommand(fields = {}) {
    const body = {};
    if (typeof fields.path === 'string') body.path = fields.path;
    if (finite(fields.currentTime)) body.currentTime = fields.currentTime;
    if (finite(fields.playbackSpeed)) body.playbackSpeed = fields.playbackSpeed;
    if (fields.playerState != null || fields.motion != null) {
        body.playerState = normalizePlayerState(fields.playerState ?? fields.motion);
    }
    return encodeJson(body);
}

function finite(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

function normalizePlayerState(value) {
    if (value === 'paused' || value === PLAYER_PAUSED) return PLAYER_PAUSED;
    if (value === 'finished' || value === PLAYER_FINISHED) return PLAYER_FINISHED;
    if (value === 'playing' || value === PLAYER_PLAYING) return PLAYER_PLAYING;
    const n = Number(value);
    if (n === PLAYER_PAUSED || n === PLAYER_FINISHED) return n;
    return PLAYER_PLAYING;
}

// One JSON object, after the length prefix has been removed. An empty
// object is a ping. Anything that is not an object is invalid.
export function interpretPacket(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        return { kind: 'invalid' };
    }
    if (Object.keys(packet).length === 0) return { kind: 'ping' };
    const playerState = packet.playerState == null ? PLAYER_PLAYING : normalizePlayerState(packet.playerState);
    let motion = 'playing';
    if (playerState === PLAYER_PAUSED) motion = 'paused';
    else if (playerState === PLAYER_FINISHED) motion = 'finished';
    return {
        kind: 'state',
        path: typeof packet.path === 'string' ? packet.path : '',
        duration: finite(packet.duration) ? packet.duration : 0,
        currentTime: finite(packet.currentTime) ? packet.currentTime : 0,
        playbackSpeed: finite(packet.playbackSpeed) ? packet.playbackSpeed : 1,
        playerState,
        motion
    };
}

// Bytes from a TCP stream, which may split a packet or deliver two at once.
// push() returns the packets completed by this chunk. A length above
// MAX_PACKET_BYTES throws: that is not a timestamp packet.
export function createPacketReader() {
    let buf = new Uint8Array(0);
    return {
        push(chunk) {
            buf = concat(buf, chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk));
            const packets = [];
            for (;;) {
                if (buf.length < 4) break;
                const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
                if (len > MAX_PACKET_BYTES) {
                    buf = new Uint8Array(0);
                    throw new Error('timestamp packet is too large');
                }
                if (buf.length < 4 + len) break;
                const body = buf.slice(4, 4 + len);
                buf = buf.slice(4 + len);
                if (len === 0) {
                    packets.push({ kind: 'ping' });
                    continue;
                }
                let json;
                try {
                    json = JSON.parse(decoder.decode(body));
                } catch (e) {
                    packets.push({ kind: 'invalid' });
                    continue;
                }
                packets.push(interpretPacket(json));
            }
            return packets;
        }
    };
}
