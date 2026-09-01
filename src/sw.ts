/// <reference lib="webworker" />
// Service worker (built by vite-plugin-pwa in injectManifest mode).
//
// - The app shell (everything Vite emitted + public assets listed in the
//   manifest) is precached and served cache-first; a new build's SW takes over
//   on the next load (autoUpdate).
// - The compiler modules under /vendor/ are far too big to precache and are
//   cached on first successful fetch instead. That is what makes the *second*
//   visit work offline, a promise the shell cache alone does not keep. There
//   are two of them, one per language, and each has a cache of its own so that
//   using one language never evicts the other.

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

const inModule = (url: URL, dir: string) =>
  url.origin === self.location.origin &&
  new RegExp(`/vendor/${dir}/[^/]+$`).test(url.pathname);

/**
 * The names the worker fetching each module uses, so the two agree about where
 * a file went. A response cached under a different name than the one the
 * worker looks in is a download paid for twice.
 */
const MODULES = [
  { dir: 'abi', manifest: 'abix-abi-manifest-v1', files: 'abix-abi-module-v1' },
  { dir: 'hylo', manifest: 'abix-hylo-manifest-v1', files: 'abix-hylo-module-v1' },
];

for (const { dir, manifest, files } of MODULES) {
  // The module's manifest: the one file in that directory that changes, and
  // the only route to a new version. Cached, so the app still boots offline,
  // but never *preferred* over the network. Served from cache it would pin
  // every visitor to whichever module they first downloaded, forever.
  registerRoute(
    ({ url }) => inModule(url, dir) && url.pathname.endsWith('/manifest.json'),
    new NetworkFirst({ cacheName: manifest, networkTimeoutSeconds: 5 }),
  );

  // The module itself: tens of megabytes, named by content. Cache-first is
  // safe precisely because of that: an update arrives under a name nothing has
  // cached, and the worker drops what it replaced.
  registerRoute(({ url }) => inModule(url, dir), new CacheFirst({ cacheName: files }));
}
