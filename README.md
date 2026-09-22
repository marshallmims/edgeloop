# EdgeLoop: Autonomous Biofeedback Edging System

EdgeLoop is an open-source, client-side biofeedback edging engine that links Bluetooth heart rate monitors to teledildonic hardware, automatically modulating stimulation in real time to keep you balanced right on the edge.

---

## Why I Built EdgeLoop

I built EdgeLoop because I constantly found long videos I wanted to experience with my Handy, but most of them had no funscripts—and the hand-coded scripts that did exist rarely worked for my body. Everyone’s physical sensitivity, threshold, and anatomy are different. With static scripts tailored to someone else, I constantly ran into two extremes: either the script moved too fast and I couldn't last through the video, or it moved too slow and couldn't even keep me erect.

Trying to manually adjust speed sliders while kicking back in my recliner watching a screen on my TV or inside a VR headset completely shatters the immersion. I wanted something that would drive my toys without needing hand-coded scripts, while still introducing an element of surprise. Having the toy react unpredictably to my real-time heart rate turned out to be just as exciting as a hand-crafted script. Because an automated biofeedback loop never gets tired and never stops paying attention, it became the only reliable way I could last as long as I wanted.

Most importantly, **this isn't just for people using The Handy.** I wanted EdgeLoop to work with and for everyone—supporting all toys across all anatomies and sexes.

I also see a ton of different ways people can use this app beyond solo play. If you have a partner online or in real life, you can dial in the session settings for your subject's specific body and toys. That frees up the partner to split their attention—carrying on a conversation, teasing, or handling other play—while EdgeLoop autonomously manages the physical edging threshold in the background.

---

## Special Thanks & Credits

A massive shoutout and credit goes to **@zflippz** on the Handy Discord / Control server. Testing his early implementation of heart-rate biofeedback gave me the inspiration and confidence to dive in and take this concept in my own direction. EdgeLoop truly would not have happened without his initial work and encouragement.

---

## What the App Does Today

EdgeLoop runs 100% locally in your web browser with zero accounts, zero subscriptions, and zero cloud tracking:

* **Adaptive Biofeedback Core:** Uses a convex power curve that keeps speeds active and engaging during mid-arousal, only backing off sharply in the final heart rate window before your climax ceiling. Includes a 5 BPM recovery buffer (hysteresis) and a selectable peak behavior (Full Stop or a gentle Crawl).
* **Session Guards:** Signal watchdog, stall guard, dual-stimulation dampening and adaptive ceiling decay. They are described one by one in [Session guards](#session-guards) below.
* **Experience Modes & Games:** Selectable profiles like Classic Tease, Prostate Milker (cross-fader), Glans Protector, and Ultimate Milker, alongside interactive challenges like *The Oracle* (decision gate), *Survival Mode*, and *Edge Training* (hold at the ceiling for a set time, N times, then finish; the hold and the recover after it both obey your *At the ceiling* setting; tapping Force Orgasm yourself suspends the training rather than completing it, and cancelling it after the finish starts a fresh set). The Oracle uses your Duration tab: with Mystery (e.g. 30–60 min) it will not climax or deny before the minimum you typed — including on the one roll in N that lands the hidden target on that minimum, and including a Mystery whose two boxes hold the same number — and with a Fixed length (which has no window of its own) not before halfway; after that each 15 s hold can end you, more often as you near the target, and at the target it ends the session the way your Endgame Trigger says (a Soft Landing is teased down, never forced); Endless has no minimum. Every Oracle state you reach while parked on the pullback mark — the hold, purgatory and the climb — obeys your *At the ceiling* setting, so Full Stop really does park the primary there.
* **Session Telemetry & Funscript Export:** Automatically logs session metrics and exports dual-channel `.funscript` (primary stroker) and `.v0.funscript` (secondary vibrator) files directly to your machine for replay in external players like ScriptPlayer or HereSphere.
* **Remote Partner Control & Viewers:** Peer-to-peer WebRTC room links let one partner anywhere in the world manage the session remotely (transport, Force Orgasm, mode), while any number of read-only viewers watch the live heart-rate telemetry. Every inbound message is validated; a dropped link is shown as disconnected, never as connected. Host-only settings — the Edge Training hold length and edge count, and the pullback percent — are read from the host's telemetry, never from the remote device's own saved settings, so a partner never paces the session by numbers out of their own browser. The same goes for everything a remote page shows about the session itself: the Resting / Climax pair, the Target Mode and the Endgame Trigger are the wearer's, so a partner page never fills them in from its own storage.
* **Broad Protocol Support:** Direct connection to BLE heart rate monitors (standard 0x180D GATT service), The Handy (Wi-Fi HAMP API), T-Code strokers (OSR2, SR6, OSSM) straight over their USB serial port via Web Serial, and Buttplug.io / Intiface Central for vibrators, reciprocating sex machines, and rotational devices.

### What changed since v1.0

Everything that landed after the v1.0 write-up, from the Handy protocol fix to the direct T-Code driver, the smooth Intiface strokes and the heart-rate watchdog, is listed in [CHANGELOG.md](CHANGELOG.md), grouped by area and credited to the forum reports that prompted each change.

---

## Hardware Reality & My Personal Daily Setup

There are far more toys, heart rate monitors, and device combinations than any single person could possibly own or test.

For transparency, **my personal daily-driver setup** is:

* **Viewing Environment & Media:** Kicking back in my recliner in the living room, watching videos directly on my TV or immersed in my VR headset.
* **Host Device:** Google Pixel Tablet set up in horizontal/landscape mode next to me, running EdgeLoop in Chrome and Intiface Central directly on the tablet to manage Bluetooth toys.
* **Primary Stroker:** The Handy connected over Wi-Fi.
* **Heart Rate Monitor:** Google Pixel Watch 2 broadcasting live heart rate over Bluetooth.
* **Development Environment:** EdgeLoop was coded and tested on Google Chrome across both Fedora 44 KDE Linux and Windows.

Because I don't own every commercial toy, chest strap, or operating system variant (macOS, iOS, Android, Linux, Windows), I can't guarantee out-of-the-box behavior for every edge case alone. As an open-source community, we can test and expand device coverage together. Future game and app integrations are on the long-term roadmap, but right now the focus is keeping the core engine dialed in, stable, and ready to grow.

---

## Heart-rate sources

EdgeLoop reads any device that advertises the standard Bluetooth **Heart Rate** service (GATT 0x180D). The table collects what people on the forum have reported so far; add your own findings through an issue or PR.

| Device | How it reaches EdgeLoop | Notes |
| --- | --- | --- |
| Google Pixel Watch / Pixel Watch 2 | Broadcasts heart rate over BLE natively | The author's setup. Turn on heart-rate broadcasting on the watch, then pair it from the EdgeLoop BLE modal. |
| Samsung Galaxy Watch | No native broadcast. The Wear OS app **Heart for Bluetooth** (recommended by forum user AtagoWTS) re-broadcasts the pulse as a standard HR service | One user got it working with EdgeLoop on a phone but not on a desktop; try the phone first. |
| Apple Watch | **HeartCast** or **Echo** can broadcast the pulse | iOS forbids a BLE central (the Bluefy browser) on the *same* iPhone from seeing a peripheral advertised by another app on that iPhone. Run EdgeLoop on a second device (PC, Mac or tablet), or pair a chest strap directly to Bluefy instead. |
| Chest straps: Polar H10, Coospo H6M, Cycplus H2 Pro, Garmin HRM, Wahoo TICKR | Standard BLE Heart Rate broadcast, pair straight from the BLE modal | The most reliable option. Polar H10 has the best cadence; the Cycplus H2 Pro costs around 30 USD. Wet the electrodes before a session. |
| Budget watches paired through the GloryFit / Da Fit apps | Not possible | These watches do not expose the standard Heart Rate service and cannot work with EdgeLoop (or any other BLE HR app). |
| No monitor yet | The **Manual Simulator** slider in the BLE modal | Lets you explore the engine and every mode without hardware. |

Browser requirements for the Bluetooth link:

* **Chrome, Edge or another Chromium browser** on Windows, macOS, Android or Linux. Firefox and Safari have no Web Bluetooth.
* **Linux:** enable `chrome://flags/#enable-experimental-web-platform-features` and use a native (non-Flatpak) browser install; Flatpak builds do not see the Bluetooth adapter.
* **iOS / iPadOS:** use the **Bluefy** browser; Safari cannot pair. Remember the same-iPhone limitation above.
* The page must be served over **https or localhost**; Web Bluetooth is refused on plain `http://`.

Watches and relay apps often update only every 2-5 seconds, so leave the signal-loss timeout (see [Session guards](#session-guards)) at 8 s or more for them. Chest straps update every second.

A note on limits: prostate-heavy sessions reach the edge at far lower heart rates than penile stroking, often in the 80s-90s. For those, set a tighter profile such as **Resting 65 / Climax 92-95** instead of the defaults.

---

## Connecting toys

Every toy has its own card on the cockpit; tap the card to open its modal. A toy needs a **role** (Primary, Secondary or OFF) before the session can start: Primary follows the stroke curve and the stroke zone, Secondary follows the vibration channel, OFF is ignored. Any number of toys can share a role.

### The Handy (Wi-Fi)

1. Put your **Connection Key** from handyfeeling.com into the Handy modal and press **Connect Handy**. The driver talks to the official API v2 in **HAMP** mode and checks every reply, so a wrong key, a sleeping Handy or an API error is shown in the modal status line and on the connection badge instead of failing silently.
2. Set the **Hardware Travel Envelope** (Min 0-90%, Max 10-100%) to the physical range your sleeve allows. Every stroke zone, including Head Play, Glans Protector, warm-up and Full Length Strokes, is scaled inside these bounds, so the sleeve can never slip out or jam at the base.
3. Under it, the **End-Stop Margin** (0-10% of travel, 5% by default) keeps the carriage off the mechanical ends of the slider. The Handy's firmware stops the slider when it reads as blocked, and a carriage driven hard into its end stop can read exactly like that — forum user X333 hit that lockout on a Handy 2 and had to type guards around 0 and 100% himself. The margin does that for you: only a stroke that reaches within the margin of 0% or 100% is moved, so an envelope you narrowed yourself is sent untouched, and full travel leaves as 5-95%. It can only narrow what the engine asked for, never widen it, and it gives way rather than shrink a stroke below its minimum width. Set it to **0** to send the full range, exactly as older builds did; the modal shows what a full-length stroke is really sent as. It applies to The Handy only — a T-Code or Intiface linear axis takes a wider zone as a longer, slower stroke rather than a faster one. Two things the device says back are now read out in the modal instead of being thrown away: the result code `PUT /slide` returns when it rounded your stroke range to limits of its own, and the one HAMP error code API v2 has, which is explained rather than shown as “Unspecified HAMP error”. Both only inform — what decides that a Handy has to be given up on is still the offline detection, unchanged.
4. Pick the role and the **Max Speed Cap**. STOP is confirmed and retried, and an offline Handy is detected mid-session, which pauses the session; the device then keeps receiving stops in the background until one is confirmed, so a Wi-Fi blip cannot leave the motor running. Pressing **Connect Handy** again (a new key, or the same one after an API error) verifies the new key first and brings the connected device to a confirmed stop before the link is switched; if either fails the current connection is left as it was. **Disconnect** reports whether its stop was confirmed, and closing the tab sends a last stop.

### Intiface Central (Buttplug.io)

Intiface Central is the bridge for Bluetooth vibrators, rotators, reciprocating machines and (through its serial support) T-Code strokers.

1. Start Intiface Central and **start its server**. Add and connect your toys there first.
2. In the EdgeLoop Intiface modal, keep the URL at `ws://localhost:12345` (plain `ws://`, not `wss://`, for a local server) and press **Connect**. The status walks Offline, Connecting, Handshake and Connected (server name, N devices); an invalid URL, a stopped server or a stalled handshake is reported in the same line.
3. Every actuator is listed with an **axis role** (Primary / Secondary / OFF), a cap and a **Test** button. Stroke maps to Linear axes, twist and roll map to Rotate axes; assign leftover axes Secondary or OFF. Linear axes have an invert switch.
4. **Rotation options:** a rotator can **reverse on every edge** and/or **alternate direction every N seconds** (5-60).
5. Press **Save & Apply**. Roles, caps, invert and the rotation settings are **remembered per toy**, so a reconnect restores your mapping.

Linear axes are driven by a stroke planner that sends exactly one command per stroke leg, which is what makes OSR-class strokers move smoothly instead of in bursts. `StopAllDevices` is sent on STOP, pause, disconnect and when the page closes.

### TCode Serial (OSR2 / SR6 / OSSM without Intiface)

The TCode Serial card drives any T-Code v0.3 stroker straight over its USB serial port (115200 8N1), which gives you every axis rather than the single linear axis Intiface exposes.

* **Chrome or Edge on a desktop only** (Windows, macOS, Linux): Web Serial does not exist on phones, in Firefox or in Safari. Browsers without it get a clear message.
* **Close any other app that holds the COM port first:** Intiface Central, MultiFunPlayer, a serial monitor. Then press **Connect** and pick the port in the browser dialog.
* **Linux:** your user must be in the `dialout` group (`sudo usermod -aG dialout $USER`, then log out and back in).
* The device is identified with `D0` / `D1` / `D2`; a firmware that stays silent falls back to the common `L0 / R0 / R1 / R2 / V0` set. Every axis gets a **Primary / Secondary / OFF** role, a cap, a **Test** button and (linear axes) an invert switch. `L0` (stroke) is Primary and `V0` Secondary by default, everything else OFF. Rotation axes swing around centre by the engine speed. Settings are remembered per device name.
* STOP, pause, Reset and every disconnect alert bring all axes to rest on one line; an unplugged device or a failed write pauses the session.

---

## What is remembered between sessions

Everything you type into Session Setup is saved in this browser and restored on the next load: **Resting HR** and **Climax HR**, the **Target Mode** (Fixed / Mystery / Endless) with its lengths, the **Endgame Trigger**, the warm-up, every guard, the voice phrases and the microphone settings. Lowering your ceiling by hand halfway through a session is kept, so a reload does not hand the toys back a limit you had already decided was too high.

Typing into one of those fields updates the running session on the keystroke; the write to storage is batched over a short window rather than done once per key, and is flushed whenever the page could go away (a reload included), so nothing you typed is lost.

**Not** remembered, on purpose: Global Intensity, Full Stroke and the selected mode or game card. Those are cockpit "right now" values - a fresh page that restored 150% intensity or Ruin & Leak would be making a motor-affecting decision you did not. The Intiface server URL is not remembered either; that one is an open request rather than a deliberate refusal.

Stored limits are validated on the way out of storage exactly as typed ones are on the way in: a corrupt or hand-edited store cannot restore a Climax HR outside 30-250 BPM, or one at or below your Resting HR. A pair that fails that check falls back to the factory 70 / 140. A pair that passes comes back exactly as you typed it, a narrow Resting/Climax band included - the pullback mark simply sits at the ceiling there, as it always has - so a reload can never hand you limits you did not choose, and never a working ceiling above the Climax HR you typed. All of it rides in the **Backup** export and comes back on import.

### Backup & Restore

Import is a **between-sessions** action: it writes the Handy speed cap, sets the channel role and rewrites the stroke range, and those reach the toys on the tick the file is read, so a restore during a running session is refused with a note to stop the session first. **Export (.json)** on the Backup tab writes one file with everything this browser remembers: every Session Setup value and voice-phrase list, the learned biometric offset, the Handy channel role and speed cap, your saved Intiface and T-Code device maps (per-axis role, cap and invert) and the age / wizard flags. Import puts all of it back and then tells you in words what it restored, each part by name and with its value - "the Handy speed cap (now 55%)", not just "the speed cap". Both Import buttons are reachable from the keyboard.

Your **Handy connection key is left out unless you tick the box** beside the button. That key is a bearer credential: whoever holds the string can drive your Handy from anywhere, with no password, and the app cannot revoke it. A backup file, meanwhile, is exactly the sort of thing people mail to themselves, drop in cloud storage or paste into a thread when somebody asks what their settings are. So the file you get without thinking about it is safe to send, and the file with the key in it is one you chose: it downloads as `edgeloop_settings_with_key.json` instead of `edgeloop_settings.json`, the panel tells you which you just wrote - before the download starts, not after - and the file's own second line is the warning. A file without the key says so too, so an export is never silently incomplete; if you tick the box and there is no usable key saved here, both the panel and the file say that, rather than telling you to tick a box you already ticked.

An import never connects a toy by itself - press Connect when you want it - and it never breaks a pairing silently: a file with no key leaves the key saved in this browser exactly where it was, and a file carrying a **different** key does re-pair this browser, which the import says out loud so you can put your own key back if you picked the wrong file. A toy that is connected while you import keeps the axis map it is running; reconnect it to pick up the restored one. Every Session Setup field has one sanitizer, and every value that reaches the settings store goes through it - typed, loaded from storage on boot, or restored from a file - so a hand-edited or hostile file cannot restore an out-of-range ceiling, an inverted envelope, a disabled guard or a 400% axis cap, and a key that is not a plain printable string within a sane length is refused rather than handed to The Handy's API. A field with no sanitizer fails the test suite rather than reaching the engine unchecked. Where a value only makes sense beside another one - the Resting/Climax pair, the session length, the travel envelope - the rule that owns the pair decides, and it refuses a nonsensical pair outright rather than clamping each half into something you never chose. Older backups (a bare settings blob, written before the file had a version marker) still import. A field this version does not have is skipped rather than stored, in both directions - the import says how many it skipped, and the count of restored values it reports is the count it actually stored - and a file that turns out not to be a backup at all says which way it is wrong (not JSON, a JSON list, empty, or nothing in it this version knows) instead of one flat "invalid file". A value the app itself would refuse comes back at the nearest value it accepts - a limit, or the factory setting - and is counted as refused, not as a restore. If the browser refuses to save - a full store, or blocked site data - the import says so first and in those words, instead of reporting a restore that the next reload undoes.

**Session history is never in a backup**, deliberately, and the panel says so. It is a health and sexual-activity record - peak heart rate, outcome, timestamps and a 4 Hz trace of the whole session - it is the bulkiest thing in storage, and a backup that quietly mails that to your own inbox is a worse surprise than the gap it would close. The per-session `.funscript` download already exists for getting a session out of the app.

## Session guards

The **Guards** tab of Session Setup holds every safety rule. They are independent of the selected mode.

* **At the ceiling: Full Stop vs Crawl.** What the strokers do once your pulse crosses the pullback trigger. *Full Stop* parks the primary at 0%; *Crawl* keeps a 10% micro-motion so the edge stays alive. It applies in every mode that teases you down, including every Edge Training and Oracle state reached while on the mark (the training hold and the recover after it alike). Two modes it does not govern: *Survival Mode*, where the speed climbs on its own clock whatever your pulse does and the run ends when you breach the working ceiling on three consecutive readings, so the strokers never park on the mark; and *Ruin & Leak*, whose premise is cutting penile input cold while the secondary surges, so its 18 s lockout halts the primary whichever you picked. Force Orgasm overrides both.
* **Pullback at % of Climax HR (90-100, default 100).** 100% is the number you typed; 95% pulls back early. It cannot be set above 100%: the typed Climax HR is a hard ceiling, so Crawl / Full Stop and the stall timers always start at it or below it. The percentage is taken from the working ceiling, so dual-stim dampening, decay and the learned offset move the mark down with it; the Guards preview and the cockpit HOLD TO badge always show the same number. The mark is also kept far enough above your Resting HR to leave a release band, so a very narrow Resting/Climax pair simply pulls back at the ceiling. The edge releases 5 BPM below the mark. The cockpit shows a HOLD TO badge and a purple chart line when this is not 100%.
* **Prolonged Edge Auto-Cutoff (Stall Guard).** Optional, Crawl only. Two timers: **Allow on the edge** (3-120 s, default 20) is how long pulse may sit at the pullback mark before the primary is cut. **Pause the primary** (2-60 s, default 8) is how long that halt lasts; then crawl resumes and the allow window starts again. Turn it off to stay on crawl until you recover, Force Orgasm, or STOP. The secondary channel keeps running. The amber banner during the halt names what the mode you are actually in will do when the pause ends, so it never promises a crawl where none is coming back: in *Ruin & Leak* the lockout keeps the primary at 0% whatever the pause does.
* **Heart-Rate Signal Watchdog (always on).** A short gap holds the last valid reading instead of dropping to 0, because watches and relay apps often update only every 2-5 s. When no usable pulse has arrived for the **signal-loss timeout** (3-20 s, default 8 s) every motor stops and the session pauses. Readings below 35 BPM are ignored rather than treated as silence, poor electrode contact is flagged, and a dropped Bluetooth link is retried three times (1 s, 2 s, 4 s) before it is reported as lost. START and RESUME (from the cockpit or a remote controller) need a usable reading younger than the timeout, so the transport reads WAITING FOR PULSE instead of driving the toys on a frozen heart rate; engaging the simulator during a watchdog pause keeps the session paused until you press RESUME.
* **Auto-resume when signal returns.** On by default: the session resumes by itself once readings are back. Off: it stays paused until you press RESUME.
* **Dual Stimulation Dampening.** When a secondary (prostate) toy is active alongside a stroker, the climax ceiling is offset down (5-30 BPM, default 15) to balance nerve summation. The cockpit shows a DUAL STIM badge while it applies.
* **Adaptive Ceiling Decay.** Every X edges (1-10, default 2) the ceiling drops by Y BPM (1-5, default 2) to counteract fatigue over a long session, down to a **floor** (80-130, default 105). The floor can *stop* the decay but can never *raise* the ceiling: if you typed a Climax HR below the floor, your value wins. No offset can push the working ceiling below Resting HR + 15 BPM or above the Climax HR you typed. The DECAY badge shows the amount currently applied.
* **Force Orgasm** is a temporary boost on the working ceiling; STOP and Reset always clear it and the typed Climax HR is never rewritten. While it is on, the edge you are sitting on is frozen: the overdrive lifts the mark with the ceiling, so neither the engine nor a game may read the unchanged pulse as released, and cancelling it can never count an edge you did not have.

The **Audio & Mic** tab has spoken voice guidance (local browser TTS, with a voice picker and Preview). When it is on, each cue is shown on the dashboard **and** spoken. Phrase banks are grouped: **Build-up** encouragement on a timer (default every 45 s, 0 = off), **Edge** when pulse hits the pullback mark, **Climax** when you tap Force Orgasm (or the orgasm endgame arms it; Oracle climax uses its own lines), and **Premature** when you tap Came Early. Every event can hold many phrases (one per line; a random line is picked each time). Tokens `{hr}`, `{maxHr}`, `{minHr}`, `{edges}`, `{minutes}` fill in live session values. **Export phrases** / **Import phrases** save or load a JSON (or a `# edge` / `# encourage` / `# forceOrgasm` / `# cameEarly` text file; section names are matched whatever their case). Anything EdgeLoop cannot place is refused rather than read back at you as a phrase: an unknown section name, and any text above the first section header — a title, a date, a note — which the alert then quotes so you can fix or comment it out with `//`. A file with no headers at all is taken as build-up encouragement. The full Backup export includes the same lists. Empty a box to mute that cue: it then says nothing and paints nothing, and the mute is exported and imported like any other phrase list, so your own backup restores it instead of bringing the factory lines back. **Reset defaults** (it asks first) brings the factory phrases back.

The microphone monitor (optional) is a second arousal datapoint: louder voice/panting above the noise gate adds extra BPM to the heart rate the **engine** runs on, so the tease modes treat you as closer to the edge and slow down sooner. It never goes past the effective Climax HR, and it can only ever ease the toys off, on the primary and the secondary channel alike — everything that rises with arousal, the climb in Edge Training and The Oracle and the rising secondary of the milking modes, is driven by the pulse your monitor measured alone, so a loud room (a TV, a headset, a partner) can never push a toy harder. In *The Oracle* and *Edge Training* every motor term is one of those, so the boost reaches nothing at all there and the cockpit badge stays on **MIC LISTEN** rather than promising a push nothing is making. While the signal watchdog is holding a reading the boost is frozen at its last measured value rather than dropped: it cannot grow on sound while no pulse is arriving, and a single missed packet cannot make the toys jump. It moves the toys and nothing else: the BPM readout, the edge counter, the games (Oracle, Survival, Edge Training), the guards and the saved session peak all judge the pulse your monitor measured, so room noise can never count an edge, finish Edge Training, arm Force Orgasm or end a Survival run. **Louder → closer (max extra BPM)** (0–20, default 8) is how hard that push is; 0 listens without changing the toys. The cockpit shows **MIC +N** while a boost is really reaching the toys, and **MIC LISTEN** when it is suppressed or silent.

---

## Hosting your own copy

EdgeLoop is static files: no build step, no server code, no database. Any static host works.

* **Requirements:** the page must be served over **https** (or from `localhost` / `127.0.0.1` while developing). Web Bluetooth, Web Serial and the service worker all refuse a plain `http://` origin. The Tailwind and PeerJS scripts load from a CDN, so the first visit needs internet access; afterwards the service worker (network-first, cache fallback) lets the cockpit open offline.
* **Locally:** `npm start` (or `python3 -m http.server 8000`) in the repository root, then open `http://localhost:8000`.
* **GitHub Pages:** fork the repository, then *Settings > Pages > Build and deployment > Source: Deploy from a branch*, branch `main`, folder `/ (root)`. The manifest and service worker use relative paths, so the app works under the `https://<you>.github.io/edgeloop/` sub-path.
* **Cloudflare Workers:** the repository ships a `wrangler.jsonc` that serves the root directory as static assets with single-page-application fallback. `npx wrangler deploy` publishes it; connecting the repository to Cloudflare deploys every push to `main` automatically, which is how `edgeloop.app` is hosted.
* Anything else (Netlify, Vercel, nginx, a NAS): upload the repository as-is and make sure `index.html` is the root document.

Remember that the AGPL-3.0 (below) requires a modified copy that you host to publish its source under the same license.

---

## Open Source, Licensing, and How Forks Work

EdgeLoop is fully open source under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

**GitHub Repository:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)

**What the AGPL-3.0 license means for forks and credit:**

* **You are encouraged to build:** Anyone is welcome to fork the project, experiment, add new toy drivers, or build custom integrations.
* **Credit must be preserved:** Any forks or derivative works must retain the original copyright notice and credit the work that went into EdgeLoop.
* **Copyleft (No Privatization):** The AGPL-3.0 license prevents anyone from taking this code, modifying it, and turning it into a closed-source, proprietary, or paid product. Even if someone modifies EdgeLoop and hosts it on their own website, they are legally required to make their modified source code public under the same open license. Your contributions will always remain free and open.

---

## Project File Structure

The project uses modular, native JavaScript files without mandatory complex bundlers:

```text
edgeloop/
├── .github/
│   └── workflows/
│       └── test.yml            # GitHub Actions: node --check every module, then npm test on every push to main and every PR
├── CHANGELOG.md                # What changed since v1.0, by area, with forum credits
├── LICENSE                     # AGPL-3.0
├── README.md
├── icon.svg                    # App icon (manifest, PWA install)
├── index.html                  # Interface layout, cockpit panels, popup dialogs and the service-worker registration
├── manifest.json               # Web App manifest definitions (icons, standalone display)
├── package.json                # npm test / npm run smoke / npm start; no dependencies
├── sw.js                       # Service worker: network-first with cache fallback for offline use
├── wrangler.jsonc              # Cloudflare Workers static asset deployment configuration
├── tools/
│   └── smoke.js                # Headless-Chromium smoke test of the real UI (needs Playwright, see Development)
└── src/
    └── js/
        ├── app.js              # Main interface controller: connects on-screen controls to the engine, runs the 1-second clock loop, and manages menus
        ├── state.js            # Central memory store for settings, user preferences, and real-time session state
        ├── engine.js           # Biofeedback calculations: speed curves, recovery thresholds, and safety cutoffs
        ├── engine.test.js      # Node tests for every cockpit mode, stall/crawl, warmup, hysteresis, and Oracle/Survival
        ├── session-rules.js    # Pure session rules: effective ceiling, duration window, Oracle fate vs mystery min, Survival breach, stall timers
        ├── session-rules.test.js
        ├── funscript.js        # Pure funscript builder: turns the 4 Hz speed/zone timeline into .funscript stroke actions and .v0.funscript vibration levels
        ├── funscript.test.js
        ├── storage.js          # Robust localStorage helpers: corrupt-JSON-safe reads, quota-safe writes, oldest-first history trimming
        ├── storage.test.js
        ├── write-coalescer.js  # Pure write batcher: one settings write per window instead of one per keystroke, flushed on demand
        ├── write-coalescer.test.js
        ├── backup.js           # Pure backup file: what an export carries (settings, Handy role/cap, device maps, opt-in connection key), and every clamp an import puts a file through
        ├── backup.test.js
        ├── docs.test.js        # Documentation guard: README and CHANGELOG may not quote a test count that goes stale
        ├── hr-watchdog.js      # Pure heart-rate signal watchdog: ok / holding / stale verdicts, no-contact flag, one-shot trip and recovery
        ├── hr-watchdog.test.js
        ├── chart.js            # Telemetry graph: draws the 60-second real-time heart rate canvas line, sized from its box and the device pixel ratio
        ├── chart.test.js
        ├── webrtc.js           # Peer-to-peer networking for remote partner control (?partner=) and read-only viewers (?group_sub=)
        ├── peer-messages.js    # Pure validation of every message that crosses the WebRTC data channel, in both directions
        ├── peer-messages.test.js
        ├── alert-banner.js     # Ranked alert banner: an advisory can never overwrite or clear a safety report
        ├── voice.js            # Local text-to-speech prompts and optional microphone monitor (voice-band gate)
        ├── voice.test.js
        ├── voice-cues.js       # Editable cue templates and {hr}/{edges} interpolation
        ├── voice-cues.test.js
        ├── voice-speak.test.js
        ├── voice-queue.js      # Pure cue queue: dedupe, bounded backlog, safety cues jump the queue
        ├── voice-queue.test.js
        └── hardware/
            ├── ble.js          # Web Bluetooth driver for standard heart rate monitors: notifications, battery, automatic reconnect
            ├── ble-protocol.js # Pure GATT Heart Rate Measurement parser (BPM, sensor-contact bits, RR intervals), reconnect schedule, browser-support and error messages
            ├── ble-protocol.test.js
            ├── handy.js        # The Handy Wi-Fi API driver (HAMP mode, /slide travel range with the end-stop margin, verified replies, confirmed stop, offline detection)
            ├── handy.test.js
            ├── handy-protocol.js     # Pure Handy API v2 helpers: reply classification, velocity clamp, slide-range normalisation, end-stop margin, slide-result reading, battery parsing
            ├── handy-protocol.test.js
            ├── intiface.js     # Intiface / Buttplug.io WebSocket driver for multi-motor vibrators, strokers, and rotators; per-toy memory
            ├── intiface.test.js
            ├── buttplug-protocol.js  # Pure Buttplug v3 message builders / parsers (handshake, device attributes, errors)
            ├── buttplug-protocol.test.js
            ├── tcode.js        # Direct T-Code driver over Web Serial (OSR2 / SR6 / OSSM): identification, per-axis roles, caps, stop
            ├── tcode.test.js
            ├── tcode-protocol.js     # Pure T-Code v0.3 helpers: axis commands, D0/D1/D2 parsing, default roles, browser-support text
            ├── tcode-protocol.test.js
            ├── stroke-planner.js     # Pure per-axis stroke scheduler: one command per leg, rest move on stop
            └── stroke-planner.test.js
```

---

## Development

There is no build step and no dependency to install. Clone the repository, serve it (`npm start`) and edit; reload the page to see a change.

**Unit tests** (Node 22 or newer, no browser):

```bash
npm test
```

runs every `*.test.js` under `src/js/` with Node's built-in test runner, which prints the exact count on its last lines (`# tests` / `# pass`). No number is quoted here: the suite grows most weeks, and a number in a document nobody re-counts is simply wrong after the next change - `docs.test.js` fails if one creeps back in. The convention: anything with logic worth testing lives in a **pure module** with no DOM, timers or sockets (`engine.js`, `session-rules.js`, `hr-watchdog.js`, `funscript.js`, `storage.js`, `write-coalescer.js`, `backup.js`, `chart.js`, `peer-messages.js`, `voice-queue.js`, the `*-protocol.js` helpers and `stroke-planner.js`), with a `*.test.js` file next to it. The drivers (`handy.js`, `intiface.js`, `tcode.js`, `ble.js`) keep their browser API calls inside functions so they can be imported under Node and tested with fakes. If you add a feature, put its rules in a pure module and test them there; `app.js` should only wire the DOM to those modules.

**Browser smoke test** (needs Chromium through Playwright, which is deliberately not a project dependency):

```bash
npm install --no-save playwright
npx playwright install chromium     # once
npm run smoke                       # same as: node tools/smoke.js
```

`tools/smoke.js` serves the repository on a local port, drives the real UI in headless Chromium (age gate, wizard, every device modal, Session Setup including Apply, Guide / History / Share, a simulated heart-rate sweep, a full session on a mocked Handy API with START / PAUSE / RESUME / STOP / Reset and the API calls asserted, the History entry it leaves with its funscript buttons, the remote viewer and controller pages) and exits non-zero on any page error, `console.error`, failed request or broken assertion. Screenshots, `snapshot.json` and `report.json` land in `tools/smoke-out/`. Run it before opening a pull request that touches `index.html` or `app.js`.

**Continuous integration:** `.github/workflows/test.yml` runs `node --check` on every module and then `npm test` on every push to `main` and on every pull request. A syntax check of a single file is `node --check src/js/app.js`.

---

## How to Suggest Changes and Submit Code via GitHub

If you find a bug, want to add a device driver, or want to tweak the math, contributions are welcome through GitHub:

1. **Submit an Issue:** If you don't know how to code, click the **Issues** tab on GitHub and report a bug or request a toy integration.
2. **Submit a Pull Request (PR):** If you are a developer, fork the repository, make your changes on a branch, run `npm test` (and the smoke test if you touched the UI), and click **New Pull Request**.
3. **Review & Automatic Deployment:** Incoming PRs allow us to compare code line-by-line before approving them, and the test workflow runs on every PR. Once merged into the main branch, Cloudflare automatically compiles the update and deploys it live to `edgeloop.app` within ~30 seconds.

**Live Web App:** [https://edgeloop.app](https://edgeloop.app)

**Discord:** [https://discord.gg/ZFrkehxAC](https://discord.gg/ZFrkehxAC) — questions, device reports, and support.

**Private contact:** support@edgeloop.app, for security reports and anything that should not be posted in a public server. Product support goes to Discord.

**GitHub:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)
