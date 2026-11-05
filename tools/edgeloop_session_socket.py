#!/usr/bin/env python3
"""Hold the EdgeLoop agent session socket.

The agent link from Share Control is an https URL. This opens the same link
as a WebSocket with /session on the end. Each state message is the control
document. A command is one JSON object, the same object a POST would send.

Closing this program does not stop the session.

    python3 tools/edgeloop_session_socket.py https://dev.edgeloop.app/api/agent/TOKEN
    python3 tools/edgeloop_session_socket.py URL --command '{"type":"MODE_CHANGE","mode":"milker"}'
    python3 tools/edgeloop_session_socket.py --self-test
"""

import argparse
import base64
import json
import os
import socket
import ssl
import sys
from urllib.parse import urlsplit


def session_target(link):
    text = (link or '').strip().split()[0]
    if text.startswith('ws://') or text.startswith('wss://'):
        parts = urlsplit(text)
    elif text.startswith('http://') or text.startswith('https://'):
        parts = urlsplit(text)
    else:
        raise ValueError('Paste the full agent link from the EdgeLoop page.')
    path = parts.path.rstrip('/')
    if path.endswith('/session'):
        path = path[: -len('/session')]
    token = path.rsplit('/', 1)[-1]
    if len(token) != 22 or any(ch not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' for ch in token):
        raise ValueError('That link does not contain an agent token.')
    secure = parts.scheme in ('https', 'wss')
    host = parts.hostname
    if not host:
        raise ValueError('Paste the full agent link from the EdgeLoop page.')
    port = parts.port or (443 if secure else 80)
    return host, port, f'/api/agent/{token}/session', secure


def encode_client_frame(opcode, payload, mask):
    data = payload if isinstance(payload, bytes) else payload.encode('utf-8')
    header = bytearray([0x80 | opcode])
    length = len(data)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(length.to_bytes(2, 'big'))
    else:
        header.append(0x80 | 127)
        header.extend(length.to_bytes(8, 'big'))
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    return bytes(header) + mask + masked


def pop_frames(buffer):
    frames = []
    index = 0
    while index + 2 <= len(buffer):
        first, second = buffer[index], buffer[index + 1]
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        cursor = index + 2
        if length == 126:
            if cursor + 2 > len(buffer):
                break
            length = int.from_bytes(buffer[cursor:cursor + 2], 'big')
            cursor += 2
        elif length == 127:
            if cursor + 8 > len(buffer):
                break
            length = int.from_bytes(buffer[cursor:cursor + 8], 'big')
            cursor += 8
        mask = b''
        if masked:
            if cursor + 4 > len(buffer):
                break
            mask = buffer[cursor:cursor + 4]
            cursor += 4
        if cursor + length > len(buffer):
            break
        payload = buffer[cursor:cursor + length]
        if mask:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        frames.append((opcode, payload))
        index = cursor + length
    return frames, buffer[index:]


def describe(message):
    kind = message.get('type')
    if kind == 'hello':
        return f"hello online={message.get('online')}"
    if kind == 'state':
        document = message.get('document') or {}
        state = document.get('state') or {}
        heart = state.get('heart') or {}
        companion = document.get('companion') or {}
        return (
            f"state {state.get('sessionStatus')} "
            f"hr={heart.get('bpm')} "
            f"style={state.get('playStyle')} "
            f"goal={companion.get('goal')} "
            f"primary={state.get('primaryPercent')}"
        )
    if kind == 'command-ack':
        if message.get('ok'):
            return 'command accepted'
        return f"command refused: {message.get('error') or 'not accepted'}"
    if kind == 'host-left':
        return 'the EdgeLoop page closed Share Control'
    return kind or 'message'


def run(link, command):
    host, port, path, secure = session_target(link)
    raw = socket.create_connection((host, port), timeout=15)
    if secure:
        raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode('ascii')
    request = (
        f'GET {path} HTTP/1.1\r\n'
        f'Host: {host}\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n'
    )
    raw.sendall(request.encode('ascii'))
    opening = b''
    while b'\r\n\r\n' not in opening:
        chunk = raw.recv(4096)
        if not chunk:
            raise ConnectionError('The session socket did not open.')
        opening += chunk
    head, _, rest = opening.partition(b'\r\n\r\n')
    if b' 101 ' not in head.split(b'\r\n', 1)[0]:
        raise ConnectionError('The session socket did not open.')
    if command:
        raw.sendall(encode_client_frame(1, json.dumps({'type': 'command', 'command': command}), os.urandom(4)))
    buffer = rest
    raw.settimeout(30)
    while True:
        frames, buffer = pop_frames(buffer)
        for opcode, payload in frames:
            if opcode == 0x9:
                raw.sendall(encode_client_frame(0xA, payload, os.urandom(4)))
                continue
            if opcode == 0x8:
                return
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            print(describe(message), flush=True)
            if command and message.get('type') == 'command-ack':
                return
        chunk = raw.recv(4096)
        if not chunk:
            return
        buffer += chunk


def self_test():
    host, port, path, secure = session_target('https://dev.edgeloop.app/api/agent/abcdefghijklmnopqrstuv')
    assert (host, port, path, secure) == ('dev.edgeloop.app', 443, '/api/agent/abcdefghijklmnopqrstuv/session', True)
    session_target('wss://dev.edgeloop.app/api/agent/abcdefghijklmnopqrstuv/session')
    try:
        session_target('https://dev.edgeloop.app/api/agent/short')
    except ValueError:
        pass
    else:
        raise AssertionError('a short token should be refused')
    mask = b'\x01\x02\x03\x04'
    encoded = encode_client_frame(1, '{"type":"hello"}', mask)
    frames, rest = pop_frames(encoded)
    assert rest == b''
    assert frames[0][0] == 1
    assert frames[0][1] == b'{"type":"hello"}'
    server = bytes([0x81, 2]) + b'{}'
    frames, rest = pop_frames(server)
    assert frames == [(1, b'{}')] and rest == b''
    print('ok')


def main():
    parser = argparse.ArgumentParser(description='Hold an EdgeLoop agent session socket.')
    parser.add_argument('link', nargs='?')
    parser.add_argument('--command', help='One command object, as JSON.')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.link:
        parser.error('Paste the agent link.')
    command = None
    if args.command:
        command = json.loads(args.command)
        if not isinstance(command, dict) or not isinstance(command.get('type'), str):
            raise SystemExit('command must be a JSON object with a type.')
    try:
        run(args.link, command)
    except (OSError, ValueError, ConnectionError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == '__main__':
    main()
