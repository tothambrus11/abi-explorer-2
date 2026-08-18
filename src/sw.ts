/// <reference lib="webworker" />
// Service worker (built by vite-plugin-pwa in injectManifest mode).
//
// - The app shell (everything Vite emitted + public assets listed in the
//   manifest) is precached and served cache-first; a new build's SW takes over
//   on the next load (autoUpdate).
// - The ~27 MB clang tarball is *not* handled here: the compile worker stores it
//   in the Cache API (cache "abix-clang-<version>") and reads it first, so once
//   downloaded the compiler works offline. This SW never touches that cache.
// - Optional locally vendored clang assets under /vendor/clang/llvm* are cached
//   lazily on first successful fetch (they are too big to precache).

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope;

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Caches of the pre-Vite service worker (hand-written sw.js): evict them once.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n === 'abix-shell-v1' || n === 'abix-runtime-v1')
            .map((n) => caches.delete(n)),
        ),
      ),
  );
});
precacheAndRoute(self.__WB_MANIFEST);

// Caches of the pre-workbox service worker (workbox only prunes its own).
const LEGACY_CACHES = ['abix-shell-v1', 'abix-runtime-v1'];
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all(LEGACY_CACHES.map((n) => caches.delete(n))));
});

registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    /\/vendor\/clang\/(llvm\.core\d*\.wasm|llvm-resources\.tar)$/.test(url.pathname),
  new CacheFirst({ cacheName: 'abix-local-clang-v1' }),
);
