// EdgeLoop service worker: offline fallback without stale updates.
//
// Strategy: network first for everything, falling back to the cache when the
// network is unavailable. That way a deployed update is picked up on the next
// load (the app is a live-updating single page), while the cockpit still opens
// offline once it has been visited. Bump CACHE_VERSION when the precache list
// changes; old caches are removed on activate.

const CACHE_VERSION = 'edgeloop-v12';
const PRECACHE = [
    './',
    './index.html',
    './CHANGELOG.md',
    './src/js/version.js',
    './manifest.json',
    './manifest-dev.json',
    './icon.svg',
    './icon-dev.svg',
    './icon-dev-180.png',
    './icon-dev-192.png',
    './icon-dev-512.png',
    './icon-dev-maskable-512.png',
    './icon-dev-maskable.svg',
    './icon-180.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './icon-maskable.svg',
    './src/js/app.js',
    './src/js/state.js',
    './src/js/engine.js',
    './src/js/patterns.js',
    './src/js/player/script-governor.js',
    './src/js/player/script-feed.js',
    './src/js/player/media-clock.js',
    './src/js/player/script-shaper.js',
    './src/js/player/script-track.js',
    './src/js/player/script-rhythm.js',
    './src/js/player/player.js',
    './src/js/player/player-rules.js',
    './src/js/player/funscript-parse.js',
    './src/js/player/script-pairing.js',
    './src/js/hardware/handy-hsp.js',
    './src/js/hardware/handy-hsp-protocol.js',
    './src/js/hardware/script-planner.js',
    './src/js/keybinds.js',
    './src/js/nnn.js',
    './src/js/session-rules.js',
    './src/js/hr-watchdog.js',
    './src/js/funscript.js',
    './src/js/session-telemetry.js',
    './src/js/storage.js',
    './src/js/chart.js',
    './src/js/voice.js',
    './src/js/voice-queue.js',
    './src/js/webrtc.js',
    './src/js/peer-messages.js',
    './src/js/hardware/ble.js',
    './src/js/hardware/ble-protocol.js',
    './src/js/hardware/handy.js',
    './src/js/hardware/handy-protocol.js',
    './src/js/hardware/intiface.js',
    './src/js/hardware/vibe-pulse.js',
    './src/js/hardware/vacuglide.js',
    './src/js/hardware/vacuglide-protocol.js',
    './src/js/hardware/buttplug-protocol.js',
    './src/js/hardware/stroke-planner.js',
    './src/js/hardware/tcode.js',
    './src/js/hardware/tcode-protocol.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            // addAll rejects on the first failure; cache what we can instead.
            .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    // Never intercept device APIs or signalling: the Handy cloud API, Intiface
    // websockets and PeerJS must always go to the network.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname.endsWith('handyfeeling.com') || url.hostname.endsWith('peerjs.com')) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                // Same-origin and CORS replies are cached when ok; opaque replies (the CDN script tags) have no
                // readable status, so they are cached as-is to keep the cockpit styled offline.
                if (response && (response.ok || response.type === 'opaque')) {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: url.origin === self.location.origin })
                .then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined))
                .then((cached) => cached || Response.error()))
    );
});
