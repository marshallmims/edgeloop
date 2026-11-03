import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    agentDocument,
    agentControlSocketUrl,
    agentHttpUrl,
    agentSocketUrl,
    buildAgentState,
    isAgentToken,
    mintAgentToken,
    offlineAgentDocument
} from './agent-api.js';

describe('agent control document', () => {
    it('names the menu and the commands without any device secret', () => {
        const doc = offlineAgentDocument();
        const text = JSON.stringify(doc);
        assert.equal(doc.protocol, 'edgeloop-control');
        assert.equal(doc.online, false);
        assert.equal(doc.state, null);
        assert.ok(doc.menu.playStyles.some((item) => item.id === 'milker'));
        assert.ok(doc.menu.endgames.some((item) => item.id === 'rampdown' && item.label === 'Soft landing'));
        assert.ok(doc.menu.durationModes.some((item) => item.id === 'endless'));
        assert.ok(doc.commands.some((item) => item.type === 'MODE_CHANGE'));
        assert.ok(doc.commands.some((item) => item.type === 'DURATION'));
        assert.equal(/\b(connection key|peer id|password|ice candidate)\b/i.test(text), false);
    });

    it('keeps the live feedback and drops a broken toy row', () => {
        const state = buildAgentState({
            sessionStatus: 'RUNNING',
            elapsedSeconds: 90,
            targetSeconds: 1800,
            durationMode: 'fixed',
            fixedMinutes: 30,
            bpm: 118,
            heartSeen: true,
            resting: 70,
            ceiling: 140,
            pullback: 133,
            signal: 'ok',
            edged: true,
            edges: 2,
            playStyle: 'milker',
            game: 'off',
            endgame: 'orgasm',
            primaryPercent: 40,
            secondaryPercent: 70,
            devices: [
                { id: 'handy', name: 'Handy 2 Pro', connected: true, role: 'primary', kind: 'stroke' },
                { id: 'not a toy', name: 'nope', kind: 'stroke', role: 'primary' }
            ],
            history: [70, 118, 'nope']
        });
        assert.equal(state.heart.bpm, 118);
        assert.equal(state.edged, true);
        assert.equal(state.playStyle, 'milker');
        assert.equal(state.devices.length, 1);
        assert.equal(state.devices[0].name, 'Handy 2 Pro');
        assert.deepEqual(state.history, [70, 118]);
        const doc = agentDocument(state, true);
        assert.equal(doc.online, true);
        assert.equal(doc.state.primaryPercent, 40);
    });

    it('hides a heart rate until a monitor has reported one', () => {
        const state = buildAgentState({ bpm: 70, heartSeen: false });
        assert.equal(state.heart.bpm, null);
    });
});

describe('agent link', () => {
    it('mints a token and builds the http and socket urls', () => {
        const token = mintAgentToken((bytes) => bytes.fill(7));
        assert.equal(isAgentToken(token), true);
        assert.equal(agentHttpUrl('https://dev.edgeloop.app/', token), `https://dev.edgeloop.app/api/agent/${token}`);
        assert.equal(agentSocketUrl('https://dev.edgeloop.app', token), `wss://dev.edgeloop.app/api/agent/${token}/host`);
        assert.equal(agentControlSocketUrl('https://dev.edgeloop.app', token), `wss://dev.edgeloop.app/api/agent/${token}/control`);
        assert.equal(agentSocketUrl('http://127.0.0.1:8000', token), `ws://127.0.0.1:8000/api/agent/${token}/host`);
    });

    it('is left out of the service worker cache', () => {
        const worker = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
        assert.match(worker, /\/api\/agent/);
    });
});
