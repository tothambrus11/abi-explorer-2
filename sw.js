// Service worker: makes the app shell available offline.
//
// - App shell (HTML, CSS, JS, Monaco, fonts, clang JS runtime) is precached
//   on install and served cache-first for immutable vendor assets, and
//   network-first (falling back to cache) for our own HTML/JS/CSS so updates
//   arrive on the next load without a version bump.
// - The ~27 MB clang tarball is *not* handled here: js/clang-worker.js
//   already stores it in the Cache API (cache "abix-clang-<version>") and
//   reads from there first, so once it has been downloaded once the compiler
//   works offline too. This worker deliberately never touches that cache.

const SHELL_CACHE = 'abix-shell-v1';
const RUNTIME_CACHE = 'abix-runtime-v1';
const CLANG_CACHE_PREFIX = 'abix-clang-';

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './css/fonts.css',
  './js/app.js',
  './js/clang-worker.js',
  './js/editor.js',
  './js/layout-parser.js',
  './js/model.js',
  './js/render.js',
  './js/size-resolver.js',
  './js/targets.js',
  './vendor/clang/bundle.js',
  './vendor/monaco/monaco.js',
  './vendor/monaco/monaco.css',
  './vendor/monaco/editor.worker.js',
  './vendor/monaco/codicon.ttf',
  './vendor/fonts/jetbrains-mono-latin-400-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-400-italic.woff2',
  './vendor/fonts/jetbrains-mono-latin-700-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-700-italic.woff2',
  './vendor/fonts/jetbrains-mono-latin-ext-400-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-ext-400-italic.woff2',
  './vendor/fonts/jetbrains-mono-latin-ext-700-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-ext-700-italic.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

// Optional local clang assets (only present if tools/vendor-clang.sh was run).
// Cached lazily on first successful fetch, never precached (they're huge).
const LARGE_LOCAL = /\/vendor\/clang\/(llvm\.core\d*\.wasm|llvm-resources\.tar)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails atomically; fetch individually so one 404 doesn't block install.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) await cache.put(url, res);
      } catch { /* offline during install; will retry on next fetch */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n !== SHELL_CACHE && n !== RUNTIME_CACHE && !n.startsWith(CLANG_CACHE_PREFIX))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // npm tarball etc. handled by the app

  const isVendor = url.pathname.includes('/vendor/');
  const isNav = req.mode === 'navigate';

  if (LARGE_LOCAL.test(url.pathname) || isVendor) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req, isNav));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req, isNav) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (isNav) {
      const shell = await caches.match('./index.html') || await caches.match('./');
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
