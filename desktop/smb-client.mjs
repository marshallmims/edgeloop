// List a share with the Samba `smbclient` program, when this machine has it.
// Linux has it from the samba-client package. Windows and Android do not,
// unless someone installed it. The password is written to a file the command
// reads, not placed on the command line where other programs can see it.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSmbListing } from '../src/js/desktop/smb-list.js';

export function smbclientAvailable() {
    return new Promise((resolve) => {
        const child = spawn('smbclient', ['-V'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

function quote(value) {
    return `"${String(value).replace(/"/g, '')}"`;
}

async function runSmb(location, command) {
    const available = await smbclientAvailable();
    if (!available) {
        const error = new Error('This computer has no smbclient. On Linux that is the samba client. Windows and Android need a later build that talks to the share itself.');
        error.code = 'NO_SMBCLIENT';
        throw error;
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'edgeloop-smb-'));
    const auth = path.join(dir, 'auth');
    const username = location.username || 'guest';
    const password = location.password || '';
    try {
        await writeFile(auth, `username = ${username}\npassword = ${password}\n`, { mode: 0o600 });
        const args = [`//${location.host}/${location.share}`, '-A', auth, '-c', command];
        if (!location.username) args.push('-N');
        const { code, stdout, stderr } = await spawnText('smbclient', args);
        if (code !== 0) {
            const detail = (stderr || stdout || '').replace(password, '').trim();
            const error = new Error(detail || 'The share could not be listed.');
            error.code = 'SMB_FAILED';
            throw error;
        }
        return stdout;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function spawnText(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        child.stdout.on('data', (chunk) => out.push(chunk));
        child.stderr.on('data', (chunk) => err.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({
                code,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8')
            });
        });
    });
}

export async function listShare(location) {
    const command = location.path ? `cd ${quote(location.path)}; ls` : 'ls';
    const text = await runSmb(location, command);
    return parseSmbListing(text);
}

// Copy one file off the share into destPath. The caller picks destPath.
export async function fetchShareFile(location, destPath) {
    if (!location.path) {
        const error = new Error('Name the file on the share.');
        error.code = 'SMB_FAILED';
        throw error;
    }
    await runSmb(location, `get ${quote(location.path)} ${quote(destPath)}`);
}
