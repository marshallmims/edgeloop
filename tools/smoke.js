// EdgeLoop browser smoke test.
//
// Drives the real app in headless Chromium: serves the repository over a local
// python http.server, walks the age gate, the setup wizard, every device modal,
// Session Setup, Guide / History / Share, the simulator HR sweep, a full
// session on a mocked Handy API (START / PAUSE / RESUME / STOP / Reset, with
// the API calls asserted), the History entry it leaves and the remote viewer /
// controller pages, and fails on any page error, console.error, failed request
// or broken assertion. Screenshots and a JSON report land in the output
// directory.
//
// It is the twin of the script used while developing the app, so a contributor
// can run the same checks before opening a pull request. It is NOT part of
// `npm test` because it needs a browser.
//
// One-time setup (Playwright is deliberately not a project dependency; the
// app itself has none). Install it next to the repository without touching
// package.json, then let it download its bundled Chromium:
//
//     npm install --no-save playwright
//     npx playwright install chromium
//
// Run:
//
//     npm run smoke                    # same as: node tools/smoke.js
//     node tools/smoke.js [repoDir] [outDir]
//
// repoDir defaults to the repository root, outDir to tools/smoke-out (ignored
// by git only if you add it to .gitignore; it holds PNG screenshots,
// snapshot.json and report.json). python3 must be on PATH. The browser fetches
// the CDN scripts (Tailwind, PeerJS) itself, so an internet connection is
// needed; the PeerJS cloud is contacted by the Share modal but its
// availability is not asserted.
//
// Exit code: 0 when every step passed and no errors were captured, 1 when a
// step failed or an error was captured, 2 when the script itself crashed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// package.json declares "type": "module", so this file is an ES module.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(__dirname, '..');
const OUT = process.argv[3] || path.join(__dirname, 'smoke-out');
const PORT = 8123 + Math.floor(Math.random() * 500);
fs.mkdirSync(OUT, { recursive: true });
const errors = [], warnings = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    window.__edgeloopSpoken = [];
    const record = (u) => {
      window.__edgeloopSpoken.push((u && typeof u.text === 'string') ? u.text : String(u || ''));
    };
    if (window.speechSynthesis && typeof window.speechSynthesis.speak === 'function') {
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = function (u) {
        record(u);
        try { origSpeak(u); } catch (e) { /* headless often has no voice backend */ }
        queueMicrotask(() => { if (u && typeof u.onend === 'function') u.onend(); });
      };
    } else {
      class FakeUtterance { constructor(text) { this.text = text; } }
      window.SpeechSynthesisUtterance = FakeUtterance;
      window.speechSynthesis = {
        getVoices() { return []; },
        speak(u) {
          record(u);
          queueMicrotask(() => { if (u && typeof u.onend === 'function') u.onend(); });
        },
        cancel() {},
        addEventListener() {},
        removeEventListener() {}
      };
    }
  });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('requestfailed', r => { if (!r.url().includes('favicon')) errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText); });
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`http ${r.status()}: ${r.url()}`); });

  // The Handy cloud API is mocked inside the browser, so the transport can be driven end to end
  // without hardware: every request is answered the way the real API v2 would, and recorded, so the
  // steps below can assert what the driver really sent (slide before start, a stop after STOP).
  const handyCalls = [];
  await page.route('**/api/handy/v2/**', async route => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^.*\/api\/handy\/v2/, '');
    handyCalls.push({ method: req.method(), path: p, key: req.headers()['x-connection-key'] || '' });
    let body = { result: 0 };
    if (p === '/connected') body = { connected: true };
    else if (p === '/info') body = { fwVersion: '3.2.3', model: 'Handy 1.1' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const steps = [];
  const step = async (name, fn) => {
    try { await fn(); steps.push({ name, ok: true }); }
    catch (e) {
      let overlays = null;
      try {
        overlays = await page.evaluate(() => Array.from(document.querySelectorAll('div')).filter(d => {
          const cs = getComputedStyle(d); return cs.position === 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden' && d.getBoundingClientRect().width > 300;
        }).map(d => (d.id || '') + '.' + d.className.split(' ').slice(0, 4).join('.')));
        await page.screenshot({ path: path.join(OUT, 'fail-' + name.replace(/[^a-z0-9]+/gi, '_') + '.png') });
      } catch (e2) {}
      steps.push({ name, ok: false, error: e.message.split('\n')[0], overlays });
    }
  };
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const setRange = (sel, v) => page.locator(sel).evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const closeModal = async () => {
    // The setup wizard is its own overlay (#wizardSkipBtn; older markup uses an inline Skip button).
    const wiz = page.locator('#wizardOverlay');
    if (await wiz.isVisible().catch(() => false)) {
      const skip = page.locator('#wizardSkipBtn');
      if (await skip.count()) await skip.click().catch(() => {});
      else await wiz.getByRole('button', { name: /skip|get started/i }).first().click().catch(() => {});
      await sleep(150);
    }
    const btn = page.locator('#modalCloseBtn');
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.keyboard.press('Escape');
    await sleep(200);
  };

  await step('load', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
    await page.locator('#ageConfirmBtn').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(800);
  });
  await step('age gate', async () => {
    await page.locator('#ageConfirmBtn').click(); await sleep(400);
    // First run: the 3-step wizard opens on top of the cockpit. Walk it once, then dismiss.
    const wiz = page.locator('#wizardOverlay');
    if (await wiz.isVisible().catch(() => false)) {
      await shot('01a-wizard');
      const next = page.locator('#wizardNextBtn');
      if (await next.count()) { for (let i = 0; i < 3; i++) { await next.click().catch(() => {}); await sleep(120); } }
      await closeModal();
    }
    await shot('01-main');
  });
  await step('open BLE modal + engage simulator', async () => {
    await page.locator('#cardBle').click(); await sleep(300); await shot('02-ble-modal');
    await page.getByRole('button', { name: /manual simulator/i }).click(); await sleep(200);
    await setRange('#modalSimHrSlider', '95');
    await page.locator('#modalEngageSimBtn').click(); await sleep(400);
  });
  await step('open Handy modal', async () => { await page.locator('#cardHandy').click(); await sleep(300); await shot('03-handy-modal'); await closeModal(); });
  await step('open Intiface modal', async () => { await page.locator('#cardIntiface').click(); await sleep(300); await shot('04-intiface-modal'); await closeModal(); });
  await step('intiface connect with a scheme-less URL shows the invalid-URL status', async () => {
    await page.locator('#cardIntiface').click(); await sleep(300);
    try {
      // Browsers resolve "localhost:12345" relative to the page; the driver must refuse it itself.
      await page.locator('#modalIntifaceUrl').fill('localhost:12345');
      await page.locator('#modalIntifaceConnectBtn').click(); await sleep(300);
      const txt = (await page.locator('#modalIntifaceStatusText').textContent() || '').trim();
      if (!/invalid websocket url/i.test(txt)) throw new Error('expected an invalid-URL status, got: ' + txt);
      if (await page.locator('#modalIntifaceConnectBtn').isDisabled()) throw new Error('Connect stayed disabled after a failed attempt');
      if (await page.locator('#modalIntifaceDisconnectBtn').isVisible()) throw new Error('Disconnect visible while offline');
      await page.locator('#modalIntifaceUrl').fill('ws://localhost:12345');
      await shot('04b-intiface-invalid-url');
    } finally { await closeModal(); }
  });
  await step('open TCode Serial modal', async () => {
    // Headless Chromium has navigator.serial but no ports: the modal must open, and Connect must end in a
    // readable status (no port selected / not supported), never a page error, and never mark the toy ready.
    await page.locator('#cardTCode').click(); await sleep(300); await shot('04c-tcode-modal');
    try {
      const body = page.locator('#modalBodyTCode');
      if (!(await body.isVisible())) throw new Error('TCode modal did not open');
      const title = (await page.locator('#modalTitle').textContent() || '').trim();
      if (!/tcode serial/i.test(title)) throw new Error('unexpected modal title: ' + title);
      let txt = (await page.locator('#modalTCodeStatusText').textContent() || '').trim();
      const supported = await page.evaluate(() => Boolean(navigator.serial && navigator.serial.requestPort));
      if (!supported && !/web serial is not available|does not implement web serial|not available on/i.test(txt)) throw new Error('expected a not-supported status, got: ' + txt);
      await page.locator('#modalTCodeConnectBtn').click().catch(() => {}); await sleep(1200);
      txt = (await page.locator('#modalTCodeStatusText').textContent() || '').trim();
      if (!/no port selected|not available|does not implement|blocked|could not open|serial error|pick the device port/i.test(txt)) throw new Error('unexpected status after Connect: ' + txt);
      const badge = (await page.locator('#badgeTCodeText').textContent() || '').trim();
      if (!/unsupported|disconnected|error|connecting/i.test(badge)) throw new Error('unexpected badge: ' + badge);
      if (await page.locator('#modalTCodeDisconnectBtn').isVisible()) {
        // A chooser that stays open in headless mode leaves the driver in 'connecting': Disconnect must be harmless.
        await page.locator('#modalTCodeDisconnectBtn').click().catch(() => {});
      }
      const playText = (await page.locator('#playPauseText').textContent() || '').trim();
      if (!/WAITING FOR TOY/i.test(playText)) throw new Error('TCode card must not make the toy ready: ' + playText);
      await shot('04d-tcode-after-connect');
    } finally { await closeModal(); }
  });
  await step('TCode modal envelope input is shared with the Handy modal', async () => {
    // The Hardware Travel Envelope is one persisted setting edited from both modals: typing a
    // lower guard in the TCode modal must show up in the Handy modal (and vice versa).
    await page.locator('#cardTCode').click(); await sleep(300);
    try {
      const tcodeMin = page.locator('#tcodeHwMinInput');
      if (!(await tcodeMin.isVisible())) throw new Error('TCode modal has no envelope min input');
      await tcodeMin.fill('25'); await tcodeMin.dispatchEvent('change'); await sleep(150);
      const disp = (await page.locator('#tcodeHwEnvelopeDisplay').textContent() || '').trim();
      if (!/25%\s*-\s*100%/.test(disp)) throw new Error('TCode envelope display did not update: ' + disp);
      await shot('04e-tcode-envelope');
    } finally { await closeModal(); }
    await page.locator('#cardHandy').click(); await sleep(300);
    try {
      const handyMin = await page.locator('#hwMinInput').inputValue();
      if (handyMin !== '25') throw new Error('Handy min input expected 25, got: ' + handyMin);
      const disp = (await page.locator('#hwEnvelopeDisplay').textContent() || '').trim();
      if (!/25%\s*-\s*100%/.test(disp)) throw new Error('Handy envelope display did not update: ' + disp);
      // Put it back through the Handy input so later steps run with the default envelope.
      const handyInput = page.locator('#hwMinInput');
      await handyInput.fill('0'); await handyInput.dispatchEvent('change'); await sleep(150);
      await shot('04f-handy-envelope-synced');
    } finally { await closeModal(); }
    await page.locator('#cardTCode').click(); await sleep(200);
    try {
      const back = await page.locator('#tcodeHwMinInput').inputValue();
      if (back !== '0') throw new Error('TCode min input expected 0 after the Handy edit, got: ' + back);
    } finally { await closeModal(); }
  });
  await step('open Session Setup', async () => {
    await page.locator('#sessionParamsHeaderBtn').click(); await sleep(300); await shot('05-session-setup');
    const tabs = page.locator('#modalOverlay button');
    const n = await tabs.count();
    for (let i = 0; i < Math.min(n, 12); i++) { const t = tabs.nth(i); const txt = (await t.textContent() || '').trim(); if (/guards|duration|motion|audio|profiles|tuning|general|backup/i.test(txt)) { await t.click().catch(() => {}); await sleep(150); } }
    await page.locator('#paramsTabGuardsBtn').click(); await sleep(150);
    if (!(await page.locator('#stallGuardToggle').count())) throw new Error('stall guard toggle missing');
    const stallMax = await page.locator('#stallGuardSecondsInput').getAttribute('max');
    if (stallMax !== '120') throw new Error('stall timeout max expected 120, got ' + stallMax);
    if (!(await page.locator('#edgeHoldPercentInput').count())) throw new Error('edge hold percent input missing');
    if (!(await page.locator('#stallPauseSecondsInput').count())) throw new Error('stall pause input missing');
    await page.locator('#paramsTabAudioBtn').click(); await sleep(150);
    if (!(await page.locator('#paramMicTestBtn').count())) throw new Error('mic test button missing');
    if (!(await page.locator('#micGateInput').count())) throw new Error('mic noise gate missing');
    if (!(await page.locator('#micBoostBpmInput').count())) throw new Error('mic extra BPM slider missing');
    if (!(await page.locator('#voiceCuesList [data-voice-cue]').count())) throw new Error('voice cue editor missing');
    if (!(await page.locator('#voiceCuesExportBtn').count())) throw new Error('voice phrase export missing');
    for (const id of ['edge', 'encourage', 'forceOrgasm', 'cameEarly']) {
      if (!(await page.locator(`[data-voice-cue="${id}"]`).count())) throw new Error('missing phrase bank ' + id);
    }
    const apply = page.locator('#applyParamsBtn');
    if (await apply.isVisible().catch(() => false)) { await apply.click(); await sleep(300); }
    await closeModal();
  });
  await step('open Guide / History / Share', async () => {
    await page.locator('#guideBtn').click(); await sleep(250); await shot('06-guide'); await closeModal();
    await page.locator('#historyBtn').click(); await sleep(250); await shot('07-history'); await closeModal();
    await page.getByText(/share control/i).first().click(); await sleep(400); await shot('08-share');
    // Copy-link buttons must never throw (clipboard may be denied; execCommand fallback).
    await page.locator('#copyShareUrlBtn').click().catch(() => {}); await sleep(150);
    const groupTab = page.locator('#partnerTabGroupBtn, button:has-text("Group"), button:has-text("Viewer")').first();
    if (await groupTab.count()) await groupTab.click().catch(() => {});
    await page.locator('#copyGroupUrlBtn').click().catch(() => {}); await sleep(150);
    await closeModal();
  });
  await step('drive HR above ceiling via simulator', async () => {
    await page.locator('#cardBle').click(); await sleep(200);
    await page.getByRole('button', { name: /manual simulator/i }).click(); await sleep(200);
    for (const v of ['120', '139', '141', '150', '130', '100']) { await setRange('#modalSimHrSlider', v); await sleep(250); }
    await closeModal(); await sleep(1200); await shot('09-after-hr-sweep');
  });
  await step('mode cards click', async () => {
    if (await page.locator('#expTabGameBtn').count()) throw new Error('modes/games tabs should be gone');
    if (!(await page.locator('#playStyleName').isVisible())) throw new Error('play style missing');
    await page.locator('#playStyleToggle').click(); await sleep(150);
    if (!(await page.locator('#bioProfilesGrid').isVisible())) throw new Error('stroke row hidden');
    await page.locator('#endgameToggle').click(); await sleep(150);
    if (!(await page.locator('#gameModesGrid').isVisible())) throw new Error('goal row hidden');
    await page.getByText(/prostate milker/i).first().click().catch(() => {}); await sleep(200);
    await page.locator('#playStyleToggle').click(); await sleep(150);
    await page.getByText(/classic tease/i).first().click().catch(() => {}); await sleep(200);
    if (!(await page.locator('[data-mode="goal-off"]').count())) throw new Error('tease goal missing');
    if (!(await page.locator('[data-mode="edgetrain"]').count())) throw new Error('edge training game missing');
    await page.locator('[data-mode="edgetrain"]').click(); await sleep(150);
    if (!(await page.locator('#trainHoldSecondsInput').isVisible())) throw new Error('edge training hold input missing');
    await page.locator('[data-mode="goal-off"]').click(); await sleep(150);
  });
  await step('connect the mocked Handy', async () => {
    await page.locator('#cardHandy').click(); await sleep(300);
    handyCalls.length = 0;
    await page.locator('#modalHandyInput').fill('SMOKE-KEY-0001');
    await page.locator('#modalHandyConnectBtn').click(); await sleep(800);
    const badge = (await page.locator('#badgeHandyText').textContent() || '').trim();
    if (!/the handy/i.test(badge)) throw new Error('Handy badge after Connect: ' + badge + ' / ' + ((await page.locator('#modalHandyMsg').textContent()) || '').trim());
    const seq = handyCalls.map(c => c.method + ' ' + c.path);
    for (const want of ['GET /connected', 'PUT /mode', 'PUT /hamp/stop']) if (!seq.includes(want)) throw new Error('connect did not send ' + want + ': ' + JSON.stringify(seq));
    const playText = (await page.locator('#playPauseText').textContent() || '').trim();
    if (!/START SESSION/i.test(playText)) throw new Error('transport not ready with simulator + Handy: ' + playText);
    await shot('10a-handy-connected');
  });
  await step('transport: START drives the Handy, PAUSE / RESUME / STOP / Reset bring it to rest', async () => {
    const play = page.locator('#sessionPlayPauseBtn');
    const playText = async () => (await page.locator('#playPauseText').textContent() || '').trim();
    if (await play.count() !== 1) throw new Error('#sessionPlayPauseBtn missing');
    if (await play.isDisabled()) throw new Error('START is disabled: ' + await playText());
    handyCalls.length = 0;
    await play.click(); await sleep(1500);
    if ((await playText()) !== 'PAUSE') throw new Error('expected PAUSE after START, got: ' + await playText());
    const cue = ((await page.locator('#mindgamePromptText').textContent()) || '').trim();
    if (!/Session started/i.test(cue)) throw new Error('dashboard cue did not say session start: ' + cue);
    if (!(await page.locator('#mindgameContainer').isVisible())) throw new Error('dashboard cue text hidden');
    const seq = handyCalls.map(c => c.method + ' ' + c.path);
    const slideAt = seq.indexOf('PUT /slide'), startAt = seq.indexOf('PUT /hamp/start');
    if (startAt < 0) throw new Error('no PUT /hamp/start after START: ' + JSON.stringify(seq));
    if (slideAt < 0 || slideAt > startAt) throw new Error('PUT /slide must precede PUT /hamp/start: ' + JSON.stringify(seq));
    // Keep the session running past the 10 s history threshold with a simulated pulse sweep.
    await page.locator('#cardBle').click(); await sleep(200);
    await page.getByRole('button', { name: /manual simulator/i }).click(); await sleep(150);
    for (const v of ['100', '115', '130', '120', '105', '95']) { await setRange('#modalSimHrSlider', v); await sleep(1700); }
    await closeModal();
    await shot('10b-session-running');
    handyCalls.length = 0;
    await play.click(); await sleep(700);
    if ((await playText()) !== 'RESUME') throw new Error('expected RESUME after PAUSE, got: ' + await playText());
    const cuePause = ((await page.locator('#mindgamePromptText').textContent()) || '').trim();
    if (!/Paused/i.test(cuePause)) throw new Error('dashboard cue did not say paused: ' + cuePause);
    if (!handyCalls.some(c => c.path === '/hamp/stop')) throw new Error('PAUSE sent no PUT /hamp/stop: ' + JSON.stringify(handyCalls));
    await play.click(); await sleep(1200);
    if ((await playText()) !== 'PAUSE') throw new Error('expected PAUSE after RESUME, got: ' + await playText());
    handyCalls.length = 0;
    await page.locator('#sessionStopBtn').click(); await sleep(700);
    if (!/START SESSION/i.test(await playText())) throw new Error('expected START SESSION after STOP, got: ' + await playText());
    const motion = handyCalls.filter(c => /^\/hamp\/(start|stop|velocity)$/.test(c.path));
    if (!motion.length || motion[motion.length - 1].path !== '/hamp/stop') throw new Error('the last motion command after STOP must be PUT /hamp/stop: ' + JSON.stringify(motion));
    await page.locator('#sessionResetBtn').click({ force: true }); await sleep(300);
    const edges = (await page.locator('#edgeCount').textContent() || '').trim();
    const timer = (await page.locator('#sessionTimer').textContent() || '').trim();
    if (edges !== '0' || !/^00:00$/.test(timer)) throw new Error('Reset did not zero the counters: edges=' + edges + ' timer=' + timer);
    await shot('10-after-controls');
  });
  await step('history holds the session with its funscript downloads', async () => {
    await page.locator('#historyBtn').click(); await sleep(300);
    try {
      const n = await page.locator('#historyList button', { hasText: /\.funscript/ }).count();
      if (n < 1) throw new Error('no .funscript button in History after a 10 s+ session');
      await shot('10c-history');
    } finally { await closeModal(); }
  });
  await step('disconnect the mocked Handy sends a stop', async () => {
    await page.locator('#cardHandy').click(); await sleep(200);
    try {
      handyCalls.length = 0;
      await page.locator('#modalHandyDisconnectBtn').click(); await sleep(500);
      if (!handyCalls.some(c => c.method === 'PUT' && c.path === '/hamp/stop')) throw new Error('Disconnect sent no PUT /hamp/stop: ' + JSON.stringify(handyCalls));
      const txt = (await page.locator('#modalHandyMsg').textContent() || '').trim();
      if (!/offline/i.test(txt)) throw new Error('expected Offline after Disconnect, got: ' + txt);
      const badge = (await page.locator('#badgeHandyText').textContent() || '').trim();
      if (!/disconnected/i.test(badge)) throw new Error('expected Disconnected badge, got: ' + badge);
    } finally { await closeModal(); }
  });
  await step('viewer page (?group_sub=) locks every control', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/?group_sub=smokeroom`, { waitUntil: 'load', timeout: 60000 });
    await sleep(1500);
    const v = await page.evaluate(() => ({
      role: document.querySelector('#roleIndicator')?.textContent?.trim() || '',
      playDisabled: document.querySelector('#sessionPlayPauseBtn')?.disabled,
      stopDisabled: document.querySelector('#sessionStopBtn')?.disabled,
      orgasmDisabled: document.querySelector('#orgasmBtn')?.disabled,
      maxHrDisabled: document.querySelector('#maxHr')?.disabled
    }));
    if (!/viewer/i.test(v.role)) throw new Error('viewer badge missing: ' + v.role);
    if (!v.playDisabled || !v.stopDisabled || !v.orgasmDisabled || !v.maxHrDisabled) throw new Error('viewer controls not locked: ' + JSON.stringify(v));
    await page.locator('#sessionStopBtn').click({ force: true }).catch(() => {});
    await page.locator('#orgasmBtn').click({ force: true }).catch(() => {});
    await shot('11-viewer');
  });
  await step('controller page (?partner=) loads', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/?partner=smokeroom`, { waitUntil: 'load', timeout: 60000 });
    await sleep(1500);
    const role = await page.evaluate(() => document.querySelector('#roleIndicator')?.textContent?.trim() || '');
    if (!/remote controller/i.test(role)) throw new Error('controller badge missing: ' + role);
    await page.locator('#stopBtn, #sessionStopBtn').first().click({ force: true }).catch(() => {});
    await page.locator('#resetBtn, #sessionResetBtn').first().click({ force: true }).catch(() => {});
    await shot('12-controller');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 }); await sleep(800);
  });
  await step('state snapshot', async () => {
    const snap = await page.evaluate(() => ({
      title: document.title,
      bpm: document.querySelector('#hrDisplay, #bpmDisplay, .bpm')?.textContent?.trim() || null,
      playText: document.querySelector('#playPauseText')?.textContent?.trim() || null,
      stroker: document.querySelector('#strokerVal')?.textContent?.trim() || null,
      prostate: document.querySelector('#prostateVal')?.textContent?.trim() || null,
      maxHr: document.querySelector('#maxHr')?.value || null,
      edges: document.querySelector('#edgeCount')?.textContent?.trim() || null,
    }));
    fs.writeFileSync(path.join(OUT, 'snapshot.json'), JSON.stringify(snap, null, 2));
  });

  await browser.close();
  server.kill();
  const report = { steps, errors, warnings: warnings.slice(0, 10) };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const failed = steps.filter(s => !s.ok);
  console.log(JSON.stringify({ stepsOk: steps.length - failed.length, stepsFailed: failed, errors }, null, 2));
  process.exit(errors.length || failed.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASHED:', e.message); process.exit(2); });
