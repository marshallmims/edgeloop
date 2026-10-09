// HereSphere and DeoVR timestamp packets. Both speak the DeoVR remote
// protocol: a 4-byte little-endian length, then UTF-8 JSON. A length of 0
// is a ping. The player is the server. This app connects to it.
//
// Pure. No sockets. The local app (app/host.mjs) owns the connection.

import { pairFiles } from './script-pairing.js';

const MAX_PACKET = 1_000_000;

export function encodePacket(value) {
    if (value == null) return Buffer.alloc(4);
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
}

// Pull every complete packet out of a byte buffer. `rest` is the tail that
// is still waiting for more bytes. A huge length is refused and the tail is
// dropped so one bad packet cannot stall the stream forever.
export function decodePackets(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const messages = [];
    let offset = 0;
    while (buf.length - offset >= 4) {
        const len = buf.readUInt32LE(offset);
        if (len > MAX_PACKET) return { messages, rest: Buffer.alloc(0), error: 'packet too large' };
        if (buf.length - offset < 4 + len) break;
        offset += 4;
        if (len === 0) continue;
        const text = buf.subarray(offset, offset + len).toString('utf8');
        offset += len;
        try {
            messages.push(normalizeSync(JSON.parse(text)));
        } catch (e) {
            messages.push(null);
        }
    }
    return { messages, rest: buf.subarray(offset) };
}

// One playback report, or null when it says nothing we can follow.
// playerState 0 is playing, 1 is paused (DeoVR). HereSphere also sends
// `resource` for the file path.
export function normalizeSync(json) {
    if (!json || typeof json !== 'object') return null;
    const time = Number(json.currentTime);
    if (!Number.isFinite(time)) return null;
    const speed = Number(json.playbackSpeed);
    const raw = json.playerState;
    const paused = raw === 1 || raw === '1' || raw === 'pause' || raw === 'paused';
    const path = String(json.path || json.resource || json.identifier || '');
    const duration = Number(json.duration);
    return {
        path,
        durationMs: Number.isFinite(duration) && duration >= 0 ? duration * 1000 : null,
        mediaMs: Math.max(0, time * 1000),
        rate: Number.isFinite(speed) && speed > 0 ? speed : 1,
        playing: !paused
    };
}

// Where the playhead is now, given the last report and a clock reading.
// Paused time does not advance. `anchor` is { mediaMs, at, rate, playing }.
export function extrapolateSync(anchor, nowMs) {
    if (!anchor || !Number.isFinite(anchor.mediaMs) || !Number.isFinite(anchor.at)) return null;
    if (!anchor.playing) return anchor.mediaMs;
    const rate = Number(anchor.rate) > 0 ? Number(anchor.rate) : 1;
    const dt = Math.max(0, Number(nowMs) - anchor.at);
    return anchor.mediaMs + dt * rate;
}

function xmlTag(xml, name) {
    const match = String(xml).match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
    return match ? match[1].trim() : '';
}

function xmlInfo(xml, name) {
    const match = String(xml).match(new RegExp(`<info[^>]*name=["']${name}["'][^>]*>([^<]*)</info>`, 'i'));
    return match ? match[1].trim() : '';
}

function findFilename(value) {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.filename === 'string' && value.filename) return value.filename;
    for (const child of Object.values(value)) {
        const found = findFilename(child);
        if (found) return found;
    }
    return '';
}

// VLC's web interface (status.json or status.xml). `time` is seconds.
// state is "playing", "paused", or "stopped".
export function normalizeVlc(body) {
    const text = String(body || '').trim();
    if (!text) return null;
    if (text.startsWith('{')) {
        let json;
        try { json = JSON.parse(text); } catch (e) { return null; }
        return vlcReport({
            time: Number(json.time),
            length: Number(json.length),
            rate: Number(json.rate),
            state: String(json.state || ''),
            file: findFilename(json.information) || findFilename(json)
        });
    }
    return vlcReport({
        time: Number(xmlTag(text, 'time')),
        length: Number(xmlTag(text, 'length')),
        rate: Number(xmlTag(text, 'rate')),
        state: xmlTag(text, 'state'),
        file: xmlInfo(text, 'filename')
    });
}

function vlcReport({ time, length, rate, state, file }) {
    if (!Number.isFinite(time)) return null;
    const mode = String(state || '').toLowerCase();
    return {
        path: String(file || ''),
        durationMs: Number.isFinite(length) && length >= 0 ? length * 1000 : null,
        mediaMs: Math.max(0, time * 1000),
        rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
        playing: mode === 'playing'
    };
}

export function basenameOf(filePath) {
    const text = String(filePath || '').replace(/\\/g, '/');
    const cut = text.lastIndexOf('/');
    return cut >= 0 ? text.slice(cut + 1) : text;
}

// The script files that belong to this video, matched the same way a manual
// pick is: Movie.mp4 with Movie.funscript and Movie.v0.funscript. `files`
// are { name, id }. The video only has to share the file name. It can live
// on the headset while the scripts live in the folder.
export function matchLibrary(videoPath, files) {
    const videoName = basenameOf(videoPath);
    const stem = videoName.replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem || stem === videoName.toLowerCase()) return { stroke: null, vib: null };
    const list = Array.isArray(files) ? files : [];
    const related = list.filter((file) => {
        const name = String(file && file.name || '');
        const key = name.replace(/\.[^.]+$/, '').toLowerCase();
        return key === stem || key.startsWith(`${stem}.`);
    });
    if (!related.length) return { stroke: null, vib: null };
    const pair = pairFiles([{ name: videoName }, ...related]);
    const stroke = pair.stroke && pair.stroke.id ? pair.stroke : null;
    const vib = pair.vib && pair.vib.id ? pair.vib : null;
    return { stroke, vib };
}
