// The paged window. Loaded only when the address has ?shell=1, which is
// what `npm run desktop` opens. A normal visit to the site never loads this
// file, and the cockpit stays the one page it already is.
//
// Loop is the heart rate, the strokes, and the goal. Video is the player.
// Session is the setup popup, shown as a page. Library is a folder or a
// share: each video is paired with a stroker script and a secondary script.
// The device cards are lifted into the bar and stay there on every page.

import { hashForPage, pageFromHash } from './pages.js';
import { matchLibrary } from './library.js';

const navButton = 'min-h-[44px] px-3 rounded-xl border text-xs font-semibold cursor-pointer';

let current = 'loop';
let mounting = false;
let paramsHome = null;
let smbId = '';
let smbFolder = '';
let hostUp = false;

function pageButtons() {
    return [
        ['loop', 'Loop'],
        ['video', 'Video'],
        ['session', 'Session'],
        ['library', 'Library']
    ];
}

function show(page) {
    const hash = hashForPage(page);
    if (location.hash !== hash) location.hash = hash;
    else apply(page);
}

function apply(page) {
    current = page;
    document.documentElement.dataset.page = page;
    const nav = document.getElementById('shellNav');
    if (nav) {
        for (const button of nav.querySelectorAll('[data-page]')) {
            const on = button.dataset.page === page;
            button.setAttribute('aria-current', on ? 'page' : 'false');
            button.className = `${navButton} ${on
                ? 'bg-slate-100 text-slate-950 border-slate-100'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'}`;
        }
    }
    if (page === 'video') document.getElementById('playerBody')?.classList.remove('hidden');
    if (page === 'session') mountSession();
    else unmountSession();
}

function mountSession() {
    const params = document.getElementById('modalBodyParams');
    const host = document.getElementById('shellSessionHost');
    const overlay = document.getElementById('modalOverlay');
    if (!params || !host) return;
    if (!paramsHome) paramsHome = params.parentElement;
    mounting = true;
    document.getElementById('sessionParamsHeaderBtn')?.click();
    mounting = false;
    host.appendChild(params);
    params.classList.remove('hidden');
    overlay?.classList.add('hidden');
}

function unmountSession() {
    const params = document.getElementById('modalBodyParams');
    if (!params || !paramsHome || params.parentElement !== document.getElementById('shellSessionHost')) return;
    params.classList.add('hidden');
    paramsHome.appendChild(params);
}

function bindPageClicks() {
    for (const id of ['openParamsBtn', 'sessionParamsHeaderBtn']) {
        document.getElementById(id)?.addEventListener('click', (event) => {
            if (mounting) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            show('session');
        }, true);
    }
    document.getElementById('playerHeaderBtn')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        show('video');
    }, true);
    document.getElementById('modalCloseBtn')?.addEventListener('click', () => {
        if (current !== 'session') return;
        setTimeout(() => document.getElementById('modalBodyParams')?.classList.remove('hidden'), 0);
    });
}

function moveDevices() {
    const devices = document.getElementById('deviceStatus');
    const slot = document.getElementById('shellDeviceSlot');
    if (devices && slot && devices.parentElement !== slot) slot.appendChild(devices);
}

function itemName(item) {
    return item && item.name ? item.name : '—';
}

function renderLibrary(result, note) {
    const list = document.getElementById('shellLibraryList');
    const summary = document.getElementById('shellLibrarySummary');
    if (summary) summary.textContent = note || '';
    if (!list) return;
    list.replaceChildren();
    if (!result || result.videos.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-xs text-slate-500';
        empty.textContent = 'No videos in this folder yet.';
        list.appendChild(empty);
        return;
    }
    for (const row of result.videos) {
        const card = document.createElement('div');
        card.className = 'flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800';
        const text = document.createElement('div');
        text.className = 'min-w-0 space-y-0.5';
        const title = document.createElement('p');
        title.className = 'text-xs font-semibold text-slate-100 break-words';
        title.textContent = itemName(row.video);
        const detail = document.createElement('p');
        detail.className = 'text-[10px] text-slate-400 break-words';
        const how = row.match === 'none' ? 'no script' : row.match;
        detail.textContent = `Stroker: ${itemName(row.stroke)} · Secondary: ${itemName(row.vib)} · ${how}`;
        text.append(title, detail);
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'min-h-[44px] px-3 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-xs font-bold cursor-pointer';
        play.textContent = 'Open in Video';
        play.addEventListener('click', () => openRow(row));
        card.append(text, play);
        list.appendChild(card);
    }
}

function filesOf(row) {
    return [row.video, row.stroke, row.vib].filter((item) => item && item.file).map((item) => item.file);
}

function giveFiles(input, files) {
    if (!input || typeof DataTransfer === 'undefined') return false;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

async function openRow(row) {
    const local = filesOf(row);
    if (local.length) {
        giveFiles(document.getElementById('playerFileInput'), local);
        show('video');
        return;
    }
    if (!row.video || !row.video.smb) {
        show('video');
        return;
    }
    const note = document.getElementById('shellLibrarySummary');
    if (note) note.textContent = 'Copying that video off the share so it can play…';
    const served = await postJson('/desktop-api/smb/serve', {
        id: smbId,
        folder: smbFolder,
        name: row.video.name
    });
    if (!served.ok) {
        if (note) note.textContent = served.error || 'The video could not be copied.';
        return;
    }
    for (const [item, inputId] of [[row.stroke, 'playerPrimaryInput'], [row.vib, 'playerSecondaryInput']]) {
        if (!item) continue;
        const fetched = await postJson('/desktop-api/smb/file', {
            id: smbId,
            folder: smbFolder,
            name: item.name
        });
        if (!fetched.ok) continue;
        const file = new File([fetched.text || ''], item.name, { type: 'application/json' });
        giveFiles(document.getElementById(inputId), [file]);
    }
    const urlInput = document.getElementById('playerVideoUrl');
    if (urlInput) urlInput.value = served.url;
    document.getElementById('playerVideoUrlBtn')?.click();
    const cast = document.getElementById('shellCastUrl');
    if (cast) cast.textContent = served.url;
    show('video');
}

async function postJson(url, body) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: 'The desktop host is not running. Start it with npm run desktop.' };
    }
}

function bindLibrary() {
    const folder = document.getElementById('shellFolderInput');
    document.getElementById('shellFolderBtn')?.addEventListener('click', () => folder?.click());
    folder?.addEventListener('change', () => {
        const files = Array.from(folder.files || []);
        const entries = files.map((file) => ({
            name: file.name,
            path: file.webkitRelativePath || file.name,
            file
        }));
        const result = matchLibrary(entries);
        const paired = result.videos.filter((row) => row.stroke).length;
        renderLibrary(result, `${result.videos.length} video${result.videos.length === 1 ? '' : 's'}, ${paired} with a stroker script.`);
    });

    document.getElementById('shellSmbBtn')?.addEventListener('click', async () => {
        const address = document.getElementById('shellSmbAddress')?.value || '';
        const username = document.getElementById('shellSmbUser')?.value || '';
        const password = document.getElementById('shellSmbPass')?.value || '';
        const opened = await postJson('/desktop-api/smb/open', { address, username, password });
        if (!opened.ok) {
            renderLibrary({ videos: [] }, opened.error || 'The share could not be opened.');
            return;
        }
        smbId = opened.id;
        smbFolder = opened.path || '';
        showShare(opened.entries || [], opened.display || address);
    });

    document.getElementById('shellCastBtn')?.addEventListener('click', async () => {
        const filePath = document.getElementById('shellCastPath')?.value || '';
        const served = await postJson('/desktop-api/media', { path: filePath });
        const line = document.getElementById('shellCastUrl');
        if (!line) return;
        line.textContent = served.ok ? served.url : (served.error || 'That file could not be served.');
    });

    document.getElementById('shellFollowBtn')?.addEventListener('click', async () => {
        const host = document.getElementById('shellFollowHost')?.value || '';
        const port = Number(document.getElementById('shellFollowPort')?.value || '23554');
        await postJson('/desktop-api/deo/follow', { host, port, enabled: true });
        poll();
    });
    document.getElementById('shellFollowStop')?.addEventListener('click', async () => {
        await postJson('/desktop-api/deo/follow', { enabled: false });
        poll();
    });
    document.getElementById('shellHostBtn')?.addEventListener('click', async () => {
        await postJson('/desktop-api/deo/host', { enabled: true, port: 23554 });
        poll();
    });
    document.getElementById('shellHostStop')?.addEventListener('click', async () => {
        await postJson('/desktop-api/deo/host', { enabled: false });
        poll();
    });
}

function showShare(entries, display) {
    const files = [];
    const folders = [];
    for (const entry of entries) {
        if (entry.directory) folders.push(entry);
        else {
            files.push({
                name: entry.name,
                path: smbFolder ? `${smbFolder}/${entry.name}` : entry.name,
                dir: smbFolder,
                smb: true
            });
        }
    }
    const result = matchLibrary(files);
    const paired = result.videos.filter((row) => row.stroke).length;
    renderLibrary(result, `${display} · ${result.videos.length} video${result.videos.length === 1 ? '' : 's'}, ${paired} with a stroker script.`);
    const list = document.getElementById('shellLibraryList');
    if (!list || folders.length === 0) return;
    const bar = document.createElement('div');
    bar.className = 'flex flex-wrap gap-2';
    if (smbFolder) {
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'min-h-[44px] px-3 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold cursor-pointer';
        up.textContent = 'Up';
        up.addEventListener('click', () => stepShare(parentFolder(smbFolder)));
        bar.appendChild(up);
    }
    for (const folder of folders) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'min-h-[44px] px-3 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold cursor-pointer';
        button.textContent = folder.name;
        button.addEventListener('click', () => {
            const next = smbFolder ? `${smbFolder}/${folder.name}` : folder.name;
            stepShare(next);
        });
        bar.appendChild(button);
    }
    list.prepend(bar);
}

function parentFolder(folder) {
    const parts = String(folder || '').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

async function stepShare(path) {
    const listed = await postJson('/desktop-api/smb/list', { id: smbId, path });
    if (!listed.ok) {
        renderLibrary({ videos: [] }, listed.error || 'That folder could not be listed.');
        return;
    }
    smbFolder = listed.path || '';
    showShare(listed.entries || [], listed.display || smbFolder);
}

function formatClock(seconds) {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function paintClock(body) {
    hostUp = true;
    const line = document.getElementById('shellClockLine');
    const hostNote = document.getElementById('shellHostNote');
    if (hostNote) {
        hostNote.textContent = body.smbclient
            ? 'Share listing is available on this computer.'
            : 'Share listing needs smbclient (the Samba client). A folder on this computer works without it.';
    }
    if (!line) return;
    const latest = body.deo && body.deo.latest;
    if (latest) {
        const name = latest.path ? latest.path.split(/[/\\]/).pop() : 'headset';
        line.textContent = `Headset ${formatClock(latest.currentTime)} ${latest.motion} · ${name}`;
        return;
    }
    if (body.deo && body.deo.followError) {
        line.textContent = body.deo.followError;
        return;
    }
    if (body.deo && body.deo.hosting) {
        line.textContent = `This app is hosting a clock on port ${body.deo.hostPort}.`;
        return;
    }
    line.textContent = 'Headset clock off';
}

async function poll() {
    try {
        const res = await fetch('/desktop-api/status');
        if (!res.ok) throw new Error('status');
        const body = await res.json();
        paintClock(body);
        const video = document.getElementById('playerVideo');
        if (body.deo && body.deo.hosting && video && video.getAttribute('src')) {
            postJson('/desktop-api/deo/state', {
                path: video.currentSrc || '',
                currentTime: Number(video.currentTime) || 0,
                duration: Number(video.duration) || 0,
                playbackSpeed: Number(video.playbackRate) || 1,
                motion: video.paused ? 'paused' : 'playing'
            });
        }
    } catch (e) {
        if (hostUp) return;
        const line = document.getElementById('shellClockLine');
        if (line) line.textContent = 'Desktop host off — folder matching still works in this page.';
    }
}

function start() {
    document.documentElement.classList.add('shell');
    moveDevices();
    bindPageClicks();
    document.getElementById('shellNav')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-page]');
        if (!button) return;
        show(button.dataset.page);
    });
    bindLibrary();
    window.addEventListener('hashchange', () => apply(pageFromHash(location.hash)));
    if (!location.hash) {
        history.replaceState(null, '', `${location.pathname}${location.search}#/loop`);
    }
    apply(pageFromHash(location.hash));
    poll();
    setInterval(poll, 1000);
}

if (document.readyState === 'complete') start();
else window.addEventListener('load', start);
