// Which tab of the desktop app is on screen. Pure: a hash in, a tab name
// out. The website never asks. The shell does, and only when it was opened
// on purpose (?shell=1).
//
// Loop is the cockpit you already know. Video is the player and nothing
// else. Session is the setup that used to be a popup. Library is the folder,
// the share, and the headset clock. Flipping a tab hides that panel. It does
// not unload it. The device cards are not a tab: they stay in the bar.

export const SHELL_QUERY = 'shell';
export const PAGES = Object.freeze(['loop', 'video', 'session', 'library']);

const ALIASES = Object.freeze({
    loop: 'loop',
    video: 'video',
    player: 'video',
    session: 'session',
    setup: 'session',
    library: 'library',
    files: 'library'
});

// The hash may be "#/video", "#video", or empty. Anything unknown is Loop,
// which is also the page a fresh window opens on.
export function pageFromHash(hash) {
    const raw = String(hash ?? '').replace(/^#\/?/, '').split(/[?#]/)[0].trim().toLowerCase();
    if (!raw) return 'loop';
    return ALIASES[raw] || 'loop';
}

export function hashForPage(page) {
    const name = PAGES.includes(page) ? page : 'loop';
    return `#/${name}`;
}

// True only for an explicit request. A missing flag, an empty flag, and
// "0" are all the website, so a normal visit never grows a second layout.
export function shellRequested(search) {
    const text = String(search ?? '');
    const params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
    return params.get(SHELL_QUERY) === '1';
}
