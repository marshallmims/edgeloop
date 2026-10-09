# EdgeLoop desktop

This is the app, not the website. `dev.edgeloop.app` and `edgeloop.app` are unchanged: they never load this shell. Open it with:

```bash
npm run desktop
```

That serves the repository on `http://127.0.0.1:17321/?shell=1#/loop` and prints the address. The same files, without `?shell=1`, are the website layout.

## What you see

Four pages, and the devices in a bar on all of them.

| Page | What it is |
| --- | --- |
| Loop | The cockpit: heart rate, both channels, stroke, goal, start and stop. |
| Video | The player only. Script, offset, stroke model, heatmap. No mode list, no session tabs. |
| Session | Duration, guards, voice, and backup. The popup, as a page. |
| Library | A folder or a network share. Each video is paired with a stroker script and a secondary script. |

The heart-rate monitor, The Handy, Intiface, VacuGlide, and TCode stay in the bar. Clicking one still opens that device.

## What already works

* **Folder pairing.** Choose a folder. `Movie.mp4` finds `Movie.funscript` (stroker) and `Movie.v0.funscript` or `Movie.vib.funscript` (secondary), including files in a `scripts` folder next to the video. A resolution or a codec in the video name (`2160p`, `HEVC`) still matches a script that left those off. One stray script is not given to every video in the folder.
* **Open in Video.** A folder on this computer hands the video and both scripts to the player. A share copies the video onto this machine first (the share is not streamed yet) and then does the same.
* **Network share.** `smb://nas/videos` or `\\nas\videos`. The password stays in this process. It is not written into the address you see, and it is not put on the command line. Listing uses `smbclient` (the Samba client). Linux can install that. Windows can too, if Samba's client is installed. Android cannot, yet.
* **Headset clock, reading.** HereSphere and DeoVR *host* the timestamp server (port 23554). ScriptPlayer connects to them. Follow headset does that: the bar shows the headset's file, time, and play or pause. The protocol is the DeoVR remote packet: 4 byte length, then JSON with `path`, `duration`, `currentTime`, `playbackSpeed`, and `playerState` (0 play, 1 pause, 2 finished).
* **Headset clock, hosting.** Host a clock listens in that same format, so a tool that already follows DeoVR can follow a video playing here. While a video is open, this app publishes its playhead once a second.
* **Television address.** Serve turns a file on this computer into `http://<this-machine>:17322/media/<token>/<file>.mp4`. A television that can open a link can play it. The toys follow the video in this app, not the television.

## What this is not, yet

The pieces below are the rest of the app. They are not started, on purpose: each one needs the piece above it to be real first.

1. **Toys follow the headset.** The clock is read. It is not yet the clock the scripts run on. The player still uses its own video element. The next change is to feed that clock (`media-clock.js`) from the headset packet, and to seek when the headset seeks.
2. **One-tap casting.** The television address is a link. Chromecast and DLNA, where the TV and the toys share one playhead, are not built. The file has to be a format the TV will play (MP4 / H.264 is the safe one).
3. **Streaming a share.** Play from a share copies the whole video into a temp file, then serves that. A multi-gigabyte file is a long copy. Streaming the share, with seeking, replaces that.
4. **Windows, Linux, and Android as an installed app.** This host is Node. It runs on Windows and Linux wherever Node runs. Android needs a real shell. [Tauri 2](https://v2.tauri.app/) is the one that covers all three and can wrap this page. It is the packaging step, after the clock drives the toys. The page itself does not change for that.

`dev` is not the place for this. The site deploy is still the static page. This host is a program you run. Merging the branch does not turn the website into the shell, because the shell script loads only for `?shell=1`.

## Layout

```text
desktop/
  host.mjs         the local server: pages, share, clock, television address
  deo-link.mjs     TCP follow and TCP host for the timestamp packet
  smb-client.mjs   smbclient, password in a file not on the command line
src/js/desktop/
  pages.js         which page a hash is
  library.js       folder pairing, primary and secondary
  deo-remote.js    the packet bytes
  smb-path.js      smb:// and \\server\share
  smb-list.js      smbclient's ls text
  cast.js          the television URL
  shell.js         the pages, loaded only for ?shell=1
```

The rules are pure modules with tests beside them, the same as the rest of EdgeLoop. `npm test` runs them.
