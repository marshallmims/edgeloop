// Build portable test folders: unzip, then run EdgeLoop.sh or EdgeLoop.bat.
// Each zip carries its own Node, so the tester does not install Node first.
//
//   node packaging/pack-portable.mjs
//
// Writes dist/edgeloop-app-linux-x64.zip and dist/edgeloop-app-windows-x64.zip

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(os.tmpdir(), 'edgeloop-node-cache');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'tools']);

function run(cmd, args, cwd) {
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

async function nodeVersion() {
    const index = await fetch('https://nodejs.org/dist/index.json').then((r) => r.json());
    const found = index.find((item) => item.lts && String(item.version).startsWith('v22.'));
    if (!found) throw new Error('No Node 22 LTS build was listed.');
    return found.version;
}

async function download(url, dest) {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(dest, bytes);
}

function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        if (entry.name === 'app-state.json') continue;
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) copyTree(src, dest);
        else if (entry.isFile()) fs.copyFileSync(src, dest);
    }
}

const LINUX_LAUNCH = `#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec ./node app/host.mjs
`;

const WINDOWS_LAUNCH = `@echo off
cd /d "%~dp0"
"%~dp0node.exe" app\\host.mjs
if errorlevel 1 pause
`;

async function main() {
    const version = await nodeVersion();
    console.log('Node', version);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.mkdirSync(DIST, { recursive: true });

    const linuxArchive = path.join(CACHE, `node-${version}-linux-x64.tar.xz`);
    const windowsArchive = path.join(CACHE, `node-${version}-win-x64.zip`);
    await download(`https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.xz`, linuxArchive);
    await download(`https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`, windowsArchive);

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'el-pack-'));
    const linuxDir = path.join(stage, 'edgeloop-app-linux-x64');
    const windowsDir = path.join(stage, 'edgeloop-app-windows-x64');
    copyTree(ROOT, linuxDir);
    copyTree(ROOT, windowsDir);

    const linuxNode = path.join(stage, 'node-linux');
    fs.mkdirSync(linuxNode, { recursive: true });
    run('tar', ['-xJf', linuxArchive, '-C', linuxNode]);
    const unpacked = fs.readdirSync(linuxNode).find((name) => name.startsWith('node-'));
    fs.copyFileSync(path.join(linuxNode, unpacked, 'bin', 'node'), path.join(linuxDir, 'node'));
    fs.chmodSync(path.join(linuxDir, 'node'), 0o755);
    fs.writeFileSync(path.join(linuxDir, 'EdgeLoop.sh'), LINUX_LAUNCH);
    fs.chmodSync(path.join(linuxDir, 'EdgeLoop.sh'), 0o755);

    const windowsNode = path.join(stage, 'node-win');
    fs.mkdirSync(windowsNode, { recursive: true });
    run('unzip', ['-q', windowsArchive, '-d', windowsNode]);
    const winUnpacked = fs.readdirSync(windowsNode).find((name) => name.startsWith('node-'));
    fs.copyFileSync(path.join(windowsNode, winUnpacked, 'node.exe'), path.join(windowsDir, 'node.exe'));
    fs.writeFileSync(path.join(windowsDir, 'EdgeLoop.bat'), WINDOWS_LAUNCH);

    const linuxZip = path.join(DIST, 'edgeloop-app-linux-x64.zip');
    const windowsZip = path.join(DIST, 'edgeloop-app-windows-x64.zip');
    if (fs.existsSync(linuxZip)) fs.rmSync(linuxZip);
    if (fs.existsSync(windowsZip)) fs.rmSync(windowsZip);
    run('zip', ['-r', '-q', linuxZip, 'edgeloop-app-linux-x64'], stage);
    run('zip', ['-r', '-q', windowsZip, 'edgeloop-app-windows-x64'], stage);
    fs.rmSync(stage, { recursive: true, force: true });
    for (const file of [linuxZip, windowsZip]) {
        const mb = (fs.statSync(file).size / (1024 * 1024)).toFixed(1);
        console.log(`${file}  ${mb} MB`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
