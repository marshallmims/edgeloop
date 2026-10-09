// The live clock link. HereSphere and DeoVR listen on TCP 23554 and send
// the playback packet once a second. followTimestampServer connects there
// the way ScriptPlayer does. startTimestampServer is the other direction:
// EdgeLoop listens, and anything that already follows DeoVR can follow a
// video playing here.
//
// The packet shape lives in src/js/desktop/deo-remote.js. This file only
// owns the sockets.

import net from 'node:net';
import {
    encodePing, encodeState, createPacketReader, DEO_PORT
} from '../src/js/desktop/deo-remote.js';

const QUIET_MS = 3500;

export function startTimestampServer({ port = 0, host = '127.0.0.1' } = {}) {
    let state = { path: '', duration: 0, currentTime: 0, playbackSpeed: 1, playerState: 0 };
    let lastCommand = null;
    const server = net.createServer((socket) => {
        const reader = createPacketReader();
        let lastHeard = Date.now();
        const send = () => {
            if (socket.destroyed) return;
            try { socket.write(Buffer.from(encodeState(state))); } catch (e) { socket.destroy(); }
        };
        socket.on('data', (chunk) => {
            lastHeard = Date.now();
            let packets = [];
            try {
                packets = reader.push(chunk);
            } catch (e) {
                socket.destroy();
                return;
            }
            for (const packet of packets) {
                if (packet.kind === 'state') lastCommand = { ...packet, at: Date.now() };
            }
        });
        const timer = setInterval(() => {
            if (Date.now() - lastHeard > QUIET_MS) {
                socket.destroy();
                return;
            }
            send();
        }, 1000);
        socket.on('close', () => clearInterval(timer));
        socket.on('error', () => {});
        send();
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const address = server.address();
            resolve({
                port: address.port,
                setState(next) {
                    state = { ...state, ...next };
                },
                lastCommand() {
                    return lastCommand;
                },
                close() {
                    return new Promise((done) => server.close(() => done()));
                }
            });
        });
    });
}

export function followTimestampServer({ host, port = DEO_PORT } = {}) {
    let latest = null;
    let connected = false;
    let error = '';
    const reader = createPacketReader();
    const socket = net.connect({ host, port });
    const sendPing = () => {
        if (socket.destroyed) return;
        try { socket.write(Buffer.from(encodePing())); } catch (e) { socket.destroy(); }
    };
    socket.on('connect', () => {
        connected = true;
        error = '';
        sendPing();
    });
    socket.on('data', (chunk) => {
        let packets = [];
        try {
            packets = reader.push(chunk);
        } catch (e) {
            error = 'The headset sent a packet that is not a timestamp.';
            socket.destroy();
            return;
        }
        for (const packet of packets) {
            if (packet.kind === 'state') latest = { ...packet, at: Date.now() };
        }
    });
    socket.on('error', (err) => {
        connected = false;
        error = err && err.code === 'ECONNREFUSED'
            ? 'Nothing is listening on that address. In HereSphere or DeoVR, turn the timestamp server on and use the headset\'s IP.'
            : 'The headset clock could not be reached.';
    });
    socket.on('close', () => { connected = false; });
    const timer = setInterval(sendPing, 1000);
    return {
        latest() { return latest; },
        connected() { return connected; },
        error() { return error; },
        close() {
            clearInterval(timer);
            socket.destroy();
        }
    };
}
