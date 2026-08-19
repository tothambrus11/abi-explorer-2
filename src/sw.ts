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
import { CacheFirst } from 'workbox-strategies';
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

// The clang-abi-wasm module: ~28 MB of wasm plus a ~20 MB header pack.
registerRoute(
  ({ url }) => url.origin === self.location.origin && /\/vendor\/abi\/[^/]+$/.test(url.pathname),
  new CacheFirst({ cacheName: 'abix-abi-module-v1' }),
);
