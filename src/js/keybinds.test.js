import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultKeybinds,
    sanitizeKeybinds,
    describeBind,
    actionForKey,
    actionForPad,
    keyEventIsTyping
} from './keybinds.js';

describe('keybinds', () => {
    it('ships space, escape, and the arrows', () => {
        const binds = defaultKeybinds();
        assert.equal(actionForKey(binds, 'Space'), 'toggleSession');
        assert.equal(actionForKey(binds, 'Escape'), 'stop');
        assert.equal(actionForKey(binds, 'ArrowLeft'), 'cameEarly');
        assert.equal(actionForKey(binds, 'ArrowRight'), 'forceOrgasm');
        assert.equal(actionForKey(binds, 'ArrowUp'), 'valvePlus');
        assert.equal(actionForKey(binds, 'ArrowDown'), 'valveMinus');
        assert.equal(actionForKey(binds, 'BracketLeft'), 'offsetEarlier');
        assert.equal(actionForKey(binds, 'BracketRight'), 'offsetLater');
        assert.equal(describeBind(binds.offsetEarlier), '[');
        assert.equal(describeBind(binds.offsetLater), ']');
    });

    it('keeps a controller button and drops a broken map', () => {
        const binds = sanitizeKeybinds({
            toggleSession: { kind: 'pad', button: 0 },
            stop: { kind: 'nope' }
        });
        assert.equal(actionForPad(binds, 0), 'toggleSession');
        assert.equal(binds.stop.code, 'Escape');
        assert.equal(describeBind(binds.toggleSession), 'Pad 1');
    });

    it('ignores keys while a field is focused', () => {
        assert.equal(keyEventIsTyping({ tagName: 'INPUT' }), true);
        assert.equal(keyEventIsTyping({ tagName: 'BUTTON' }), false);
        assert.equal(keyEventIsTyping({ tagName: 'DIV', isContentEditable: true }), true);
    });

    it('space still pauses when a number is focused', () => {
        assert.equal(keyEventIsTyping({ tagName: 'INPUT', type: 'number' }, 'Space'), false);
        assert.equal(keyEventIsTyping({ tagName: 'INPUT', type: 'range' }, 'Space'), false);
        assert.equal(keyEventIsTyping({ tagName: 'INPUT', type: 'text' }, 'Space'), true);
        assert.equal(keyEventIsTyping({ tagName: 'INPUT', type: 'url' }, 'Space'), true);
        assert.equal(keyEventIsTyping({ tagName: 'TEXTAREA' }, 'Space'), true);
    });
});
