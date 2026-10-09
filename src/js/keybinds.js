// Keyboard and gamepad bindings. Pure: no DOM, no listeners. app.js captures
// the next key or controller button and asks this module what it means.

export const KEYBIND_ACTIONS = Object.freeze([
    'toggleSession',
    'stop',
    'cameEarly',
    'forceOrgasm',
    'valvePlus',
    'valveMinus'
]);

export const KEYBIND_LABELS = Object.freeze({
    toggleSession: 'Start / Pause',
    stop: 'Stop',
    cameEarly: 'Came Early',
    forceOrgasm: 'Force Orgasm',
    valvePlus: 'VacuGlide valve +',
    valveMinus: 'VacuGlide valve −'
});

const KEY_NAMES = Object.freeze({
    Space: 'Space',
    Escape: 'Esc',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
});

export function defaultKeybinds() {
    return {
        toggleSession: { kind: 'key', code: 'Space' },
        stop: { kind: 'key', code: 'Escape' },
        cameEarly: { kind: 'key', code: 'ArrowLeft' },
        forceOrgasm: { kind: 'key', code: 'ArrowRight' },
        valvePlus: { kind: 'key', code: 'ArrowUp' },
        valveMinus: { kind: 'key', code: 'ArrowDown' }
    };
}

function cleanBind(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.kind === 'key' && typeof value.code === 'string' && value.code.length > 0 && value.code.length < 40) {
        return { kind: 'key', code: value.code };
    }
    const button = Number(value.button);
    if (value.kind === 'pad' && Number.isInteger(button) && button >= 0 && button < 32) {
        return { kind: 'pad', button };
    }
    return null;
}

export function sanitizeKeybinds(value) {
    const base = defaultKeybinds();
    if (!value || typeof value !== 'object') return base;
    const out = {};
    for (const action of KEYBIND_ACTIONS) {
        out[action] = cleanBind(value[action]) || base[action];
    }
    return out;
}

export function describeBind(bind) {
    const clean = cleanBind(bind);
    if (!clean) return 'None';
    if (clean.kind === 'pad') return `Pad ${clean.button + 1}`;
    return KEY_NAMES[clean.code] || clean.code.replace(/^Key/, '').replace(/^Digit/, '');
}

export function bindFromKey(code) {
    if (typeof code !== 'string' || !code) return null;
    return { kind: 'key', code };
}

export function bindFromPad(button) {
    const n = Number(button);
    if (!Number.isInteger(n) || n < 0 || n >= 32) return null;
    return { kind: 'pad', button: n };
}

export function actionForKey(binds, code) {
    const map = sanitizeKeybinds(binds);
    return KEYBIND_ACTIONS.find((action) => map[action].kind === 'key' && map[action].code === code) || null;
}

export function actionForPad(binds, button) {
    const map = sanitizeKeybinds(binds);
    return KEYBIND_ACTIONS.find((action) => map[action].kind === 'pad' && map[action].button === button) || null;
}

// A field the wearer is typing in must not start a session or pulse a valve.
// Space still pauses when the field is a number: that key is the session
// key, and a number box has nowhere to put a space.
export function keyEventIsTyping(target, code) {
    if (!target || typeof target !== 'object') return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
        const type = String(target.type || 'text').toLowerCase();
        const space = code === 'Space' || code === ' ';
        if (space && (type === 'number' || type === 'range')) return false;
        return true;
    }
    return target.isContentEditable === true;
}
