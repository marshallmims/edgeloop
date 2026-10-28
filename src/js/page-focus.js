// Whether this page is the window the wearer is actually using.
// A background tab, or a visible window that lost the keyboard to a video
// player, is not in front. Keys such as Space go to that other window, and
// browsers slow timers on a page that is not in front, which is what feeds
// the toys.

export const FOCUS_LOST_TEXT = 'EdgeLoop is not the focused window. Click the page to bring it back. Space and the other keys are going to the other window, and toy updates can slow down until this page is in front.';

export function pageIsInFront({ hasFocus = true, visibilityState = 'visible' } = {}) {
    return hasFocus === true && visibilityState !== 'hidden';
}
