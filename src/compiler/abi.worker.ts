// Worker host for clang-abi-wasm.
//
// The module is ~28 MB and a query over libc++ takes a few hundred
// milliseconds; neither belongs on the thread that also has to keep the editor
// responsive. The protocol is deliberately thin — one request kind, one
// response kind — because the interesting structure is in the response body,
// which this file never looks at.

import type { AbiResponse } from './AbiAdapter';

interface AbiWasmModule {
  query(request: unknown): AbiResponse;
  targets(): string[];
  version(): string;
}

type Request =
  | { type: 'query'; id: number; request: unknown }
  | { type: 'targets'; id: number }
  | { type: 'version'; id: number };

type Response =
  | { type: 'ready'; version: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id?: number; message: string };

const post = (msg: Response) => {
  self.postMessage(msg);
};

/**
 * Where the module was served from. Vite rewrites `import.meta.env.BASE_URL`,
 * so a sub-path deployment finds its own copy; `VITE_ABI_BASE` overrides it for
 * a local build linked in by clang-abi-wasm's dev-link.sh.
 */
const BASE = new URL(
  (import.meta.env['VITE_ABI_BASE'] as string | undefined) ?? 'vendor/abi/',
  new URL(import.meta.env.BASE_URL, self.location.origin),
).href;

let module: AbiWasmModule | null = null;

type EmscriptenFactory = (options: {
  locateFile: (p: string) => string;
  print: () => void;
  printErr: () => void;
}) => Promise<{
  cwrap: (name: string, ret: string, args: string[]) => (...a: unknown[]) => string;
}>;

async function boot(): Promise<AbiWasmModule> {
  if (module) return module;

  // The glue is fetched and evaluated from a blob rather than imported by URL.
  // A dedicated worker's `import()` does not go through the service worker in
  // Chromium, so an imported module is simply unavailable offline however well
  // it was cached — while `fetch` is served normally. Going through fetch is
  // what makes the second visit work with no network.
  const glueUrl = new URL('abi_query.mjs', BASE).href;
  const source = await (await fetch(glueUrl)).text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let factory: EmscriptenFactory;
  try {
    factory = ((await import(/* @vite-ignore */ blobUrl)) as { default: EmscriptenFactory }).default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const instance = await factory({
    // The blob has no directory of its own, so every sibling is named outright.
    locateFile: (p) => new URL(p, BASE).href,
    print: () => {},
    printErr: () => {},
  });
  const rawQuery = instance.cwrap('abi_query', 'string', ['string']);
  const rawVersion = instance.cwrap('abi_version', 'string', []);

  module = {
    query: (request) => JSON.parse(rawQuery(JSON.stringify(request))) as AbiResponse,
    targets: () =>
      (JSON.parse(rawQuery(JSON.stringify({ listTargets: true }))) as { targets?: string[] })
        .targets ?? [],
    version: () => rawVersion(),
  };
  return module;
}

self.onmessage = (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  void (async () => {
    try {
      const m = await boot();
      switch (msg.type) {
        case 'query':
          post({ type: 'result', id: msg.id, value: m.query(msg.request) });
          break;
        case 'targets':
          post({ type: 'result', id: msg.id, value: m.targets() });
          break;
        case 'version':
          post({ type: 'result', id: msg.id, value: m.version() });
          break;
      }
    } catch (e) {
      post({
        type: 'error',
        id: msg.id,
        message: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    }
  })();
};

/**
 * Put the module's files in the Cache API so the next visit works offline.
 *
 * The service worker cannot do this on its own here: a dedicated worker starts
 * alongside the registration, so its fetches on a first visit may go out before
 * anything is controlling them, and a cache-first route that never sees the
 * request never fills. Warming explicitly is what makes "works offline after
 * the first visit" true rather than merely likely — the service worker's route
 * then serves what this put there.
 *
 * Deliberately after `ready`: the user is reading their first layout while this
 * runs, and it must not delay that.
 */
const CACHE = 'abix-abi-module-v1';
async function warmCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE);
  for (const file of ['abi_query.mjs', 'abi_query.wasm', 'abi_query.data']) {
    const url = new URL(file, BASE).href;
    if (await cache.match(url)) continue;
    try {
      // Served from the HTTP cache in practice: these were just fetched.
      const response = await fetch(url);
      if (response.ok) await cache.put(url, response);
    } catch {
      // Offline already, or the file is not there — the next visit retries.
    }
  }
}

// Start loading immediately: the first query should not also pay for the
// module, and nothing else in the worker competes for the time.
void boot()
  .then((m) => {
    post({ type: 'ready', version: m.version() });
    void warmCache();
  })
  .catch((e: unknown) => {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  });
