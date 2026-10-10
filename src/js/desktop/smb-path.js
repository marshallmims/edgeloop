// SMB addresses, as a person pastes them. Pure. Nothing is connected.
//
// Accepted:
//   smb://host/share/folder/file.mp4
//   smb://user@host/share/folder
//   smb://user:password@host/share/folder   the password is split off and
//                                           never put back into the display
//   \\host\share\folder
//   //host/share/folder
//
// A password with a reserved character must already be percent-encoded in
// an smb:// URL, which is how URLs work. The display form never includes it.

const BAD = /[\r\n"]/;

function reject(reason) {
    return { ok: false, error: reason };
}

function clean(value) {
    return String(value ?? '').trim();
}

// Host, share, and path segments cannot carry a quote or a line break.
// Those would break the listing command the host runs later.
function unsafe(label, value) {
    if (BAD.test(value)) return `${label} cannot contain quotes or line breaks`;
    return '';
}

export function parseSmbLocation(input) {
    const raw = clean(input);
    if (!raw) return reject('Enter the share address.');

    let username = '';
    let password = '';
    let rest = raw;

    if (/^smb:\/\//i.test(rest)) {
        let url;
        try {
            url = new URL(rest);
        } catch (e) {
            return reject('That share address could not be read.');
        }
        if (url.protocol !== 'smb:') return reject('A share address starts with smb:// or \\\\.');
        username = decodeURIComponent(url.username || '');
        password = decodeURIComponent(url.password || '');
        const host = url.hostname;
        const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeURIComponent);
        const share = parts.shift() || '';
        const path = parts.join('/');
        return finish({ host, share, path, username, password });
    }

    rest = rest.replace(/^[/\\]+/, '');
    rest = rest.replace(/\\/g, '/');
    const parts = rest.split('/').filter((part) => part.length > 0);
    const host = parts.shift() || '';
    const share = parts.shift() || '';
    const path = parts.join('/');
    return finish({ host, share, path, username, password });
}

function finish({ host, share, path, username, password }) {
    host = clean(host);
    share = clean(share);
    path = clean(path).replace(/^\/+|\/+$/g, '');
    username = clean(username);
    if (!host) return reject('The address needs a computer name or an IP.');
    if (!share) return reject('The address needs a share name after the computer.');
    const problem = unsafe('The computer name', host)
        || unsafe('The share name', share)
        || unsafe('The folder', path)
        || unsafe('The user name', username)
        || unsafe('The password', password);
    if (problem) return reject(problem);
    const location = { host, share, path, username };
    if (password) location.password = password;
    return { ok: true, location, display: displaySmb(location) };
}

export function displaySmb(location) {
    const path = location.path ? `/${location.path}` : '';
    const user = location.username ? `${location.username}@` : '';
    return `smb://${user}${location.host}/${location.share}${path}`;
}

// Child of a folder listing. ".." is refused. A name with a slash is a path,
// not a single entry, and is refused too.
export function childPath(location, name) {
    const entry = clean(name);
    if (!entry || entry === '.' || entry === '..') return reject('That is not a file in this folder.');
    if (/[/\\]/.test(entry)) return reject('Open one folder at a time.');
    const problem = unsafe('The name', entry);
    if (problem) return reject(problem);
    const path = location.path ? `${location.path}/${entry}` : entry;
    return { ok: true, location: { ...location, path }, display: displaySmb({ ...location, path }) };
}

export function parentPath(location) {
    const parts = String(location.path || '').split('/').filter(Boolean);
    parts.pop();
    const path = parts.join('/');
    return { ...location, path, display: displaySmb({ ...location, path }) };
}
