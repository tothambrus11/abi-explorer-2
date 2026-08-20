/// <reference lib="webworker" />
// Service worker (built by vite-plugin-pwa in injectManifest mode).
//
// - The app shell (everything Vite emitted + public assets listed in the
//   manifest) is precached and served cache-first; a new build's SW takes over
//   on the next load (autoUpdate).
// - The wasm module under /vendor/abi/ is far too big to precache and is cached
//   on first successful fetch instead. That is what makes the *second* visit
//   work offline — a promise the shell cache alone does not keep.

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope;

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

// Caches of the pre-workbox service worker (workbox only prunes its own).
const LEGACY_CACHES = ['abix-shell-v1', 'abix-runtime-v1', 'abix-local-clang-v1'];
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all(LEGACY_CACHES.map((n) => caches.delete(n))));
});

const inModule = (url: URL) =>
  url.origin === self.location.origin && /\/vendor\/abi\/[^/]+$/.test(url.pathname);

// The module's manifest: the one file in that directory that changes, and the
// only route to a new version. Cached, so the app still boots offline, but
// never *preferred* over the network — served from cache it would pin every
// visitor to whichever module they first downloaded, forever.
registerRoute(
  ({ url }) => inModule(url) && url.pathname.endsWith('/manifest.json'),
  new NetworkFirst({ cacheName: 'abix-abi-manifest-v1', networkTimeoutSeconds: 5 }),
);

// The module itself: ~9 MB of gzipped wasm plus a ~2 MB header pack, named by
// content. Cache-first is safe precisely because of that — an update arrives
// under a name nothing has cached, and the worker drops what it replaced.
registerRoute(({ url }) => inModule(url), new CacheFirst({ cacheName: 'abix-abi-module-v1' }));
