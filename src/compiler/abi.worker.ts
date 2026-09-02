// Worker host for clang-abi-wasm.
//
// The module is ~11 MB over the wire and a query over libc++ takes a few hundred
// milliseconds; neither belongs on the thread that also has to keep the editor
// responsive. The protocol is deliberately thin (one request kind, one
// response kind) because the interesting structure is in the response body,
// which this file never looks at.

import { fetchAssets, openCache, resolveAssets, type AssetSpec } from './module-assets';
import type { WireResponse } from '$core/render';

interface AbiWasmModule {
  query(request: unknown): WireResponse;
  targets(): string[];
  version(): string;
}

type Request =
  | { type: 'query'; id: number; request: unknown }
  | { type: 'targets'; id: number }
  | { type: 'version'; id: number };

type Response =
  | { type: 'ready'; version: string }
  | { type: 'progress'; phase: 'download' | 'compile'; done: number; total: number }
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

/**
 * What Emscripten will ask for, and the manifest's key for each.
 *
 * A release names the files by content, as in `wasm-9ec58989c571.wasm`, so
 * these names exist only inside the module's own loader; the manifest is what
 * maps one to the other. The glue is 310 kB and arrives before there is a
 * progress bar to show, so only the other two are counted.
 */
const ASSETS: AssetSpec[] = [
  { key: 'wasm', name: 'abi_query.wasm', counted: true },
  { key: 'headers', name: 'abi_query.data', counted: true },
  { key: 'glue', name: 'abi_query.mjs', counted: false },
];

const CACHE = 'abix-abi-module-v1';

/**
 * One boot, whoever asks.
 *
 * `module` is only assigned once instantiation finishes, so a second message
 * arriving before then used to start a second download and a second wasm
 * instance: 11 MB and a few hundred megabytes of address space, for a copy
 * that would immediately be thrown away. The promise is the thing to share,
 * not its result. Nothing sends a request before `ready` today, which is why
 * it never showed.
 */
let booting: Promise<AbiWasmModule> | null = null;
const boot = (): Promise<AbiWasmModule> => (booting ??= instantiate());

/**
 * Downloads, caches and instantiates the module, reporting progress as it goes.
 *
 * Call through `boot`, never directly: this is what must happen exactly once.
 * Rejects if any file or the glue cannot be loaded, and revokes every blob URL
 * it made on the way out, success or not.
 */
async function instantiate(): Promise<AbiWasmModule> {
  if (module) return module;

  const cache = await openCache(CACHE);
  const assets = await resolveAssets(BASE, ASSETS, cache);
  const counted = (name: string) => ASSETS.find((a) => a.name === name)?.counted ?? false;
  const files = await fetchAssets(BASE, assets, counted, cache, (done, total) => {
    post({ type: 'progress', phase: 'download', done, total });
  });

  // `import()` refuses a blob URL that does not claim to be JavaScript, and a
  // body read back out of the Cache API claims nothing. Only the glue is
  // re-wrapped: doing it to all three copied 47 MB to set a header that
  // Emscripten, which fetches the other two itself, never looks at.
  const local = new Map<string, string>();
  for (const [name, blob] of files) {
    local.set(
      name,
      URL.createObjectURL(
        name.endsWith('.mjs') ? new Blob([blob], { type: 'text/javascript' }) : blob,
      ),
    );
  }
  post({ type: 'progress', phase: 'compile', done: 0, total: 0 });

  // The glue is evaluated from a blob rather than imported by URL. A dedicated
  // worker's `import()` does not go through the service worker in Chromium, so
  // an imported module is simply unavailable offline however well it was
  // cached, while `fetch` is served normally. Going through what we already
  // hold is what makes the second visit work with no network.
  const glue = local.get('abi_query.mjs');
  if (glue === undefined) throw new Error('the manifest names no glue for this module');
  let factory: EmscriptenFactory;
  try {
    factory = ((await import(/* @vite-ignore */ glue)) as { default: EmscriptenFactory }).default;
  } catch (e) {
    for (const url of local.values()) URL.revokeObjectURL(url);
    throw e;
  }

  try {
    const instance = await factory({
      // The blob has no directory of its own, so every sibling is named
      // outright, from what we already hold, where we have it.
      locateFile: (p) => local.get(p) ?? new URL(p, BASE).href,
      print: () => {},
      printErr: () => {},
    });
    const rawQuery = instance.cwrap('abi_query', 'string', ['string']);
    const rawVersion = instance.cwrap('abi_version', 'string', []);

    module = {
      query: (request) => JSON.parse(rawQuery(JSON.stringify(request))) as WireResponse,
      targets: () =>
        (JSON.parse(rawQuery(JSON.stringify({ listTargets: true }))) as { targets?: string[] })
          .targets ?? [],
      version: () => rawVersion(),
    };
    return module;
  } finally {
    for (const url of local.values()) URL.revokeObjectURL(url);
  }
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

// Start loading immediately: the first query should not also pay for the
// module, and nothing else in the worker competes for the time.
void boot()
  .then((m) => {
    post({ type: 'ready', version: m.version() });
  })
  .catch((e: unknown) => {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  });
