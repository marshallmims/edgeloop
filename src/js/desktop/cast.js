// The address a television opens. Pure. The host is what actually serves
// the file; this only builds the URL and refuses a name that is not a video
// the player can open.
//
// The path ends in the video's own extension. The player accepts a direct
// file address and refuses a page link, so the URL has to look like a file.

import { VIDEO_EXTENSIONS } from '../player/script-pairing.js';

function basename(filePath) {
    const norm = String(filePath ?? '').replace(/\\/g, '/');
    const cut = norm.lastIndexOf('/');
    return cut >= 0 ? norm.slice(cut + 1) : norm;
}

export function videoExtension(filePath) {
    const name = basename(filePath);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    return VIDEO_EXTENSIONS.includes(ext) ? ext : '';
}

// encodeURIComponent leaves the extension readable and escapes spaces.
export function castMediaUrl({ host, port, token, filePath }) {
    const ext = videoExtension(filePath);
    if (!ext) {
        return { ok: false, error: 'That file is not a video the player can open.' };
    }
    const name = basename(filePath);
    if (!host || !port || !token) {
        return { ok: false, error: 'The media address needs a host, a port, and a token.' };
    }
    const url = `http://${host}:${port}/media/${encodeURIComponent(token)}/${encodeURIComponent(name)}`;
    return { ok: true, url, name, ext };
}
