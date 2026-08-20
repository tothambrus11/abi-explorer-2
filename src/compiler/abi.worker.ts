// Worker host for clang-abi-wasm.
//
// The module is ~28 MB and a query over libc++ takes a few hundred
// milliseconds; neither belongs on the thread that also has to keep the editor
// responsive. The protocol is deliberately thin — one request kind, one
// response kind — because the interesting structure is in the response body,
// which this file never looks at.

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

/** The two files worth a progress bar. The glue is 300 kB and arrives first. */
const BIG_ASSETS = ['abi_query.wasm', 'abi_query.data'] as const;
const CACHE = 'abix-abi-module-v1';

/**
 * Undo gzip, if and only if the bytes are gzipped.
 *
 * The build ships the wasm compressed, because a 28 MB single asset is over the
 * limit of the host this deploys to. Whether it arrives compressed is not ours
 * to decide: a static host that recognises `.gz` sets `Content-Encoding: gzip`
 * and the browser has already undone it by the time we see a byte, while one
 * that does not hands over the gzip stream. Vite's preview server does the
 * former and Cloudflare may do either.
 *
 * So neither a header nor a manifest flag is the authority — the bytes are. A
 * gzip member starts with 1f 8b and a wasm module starts with 00 61 73 6d;
 * peek at the first chunk and put it back.
 */
async function maybeGunzip(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const first = await reader.read();
  const head = first.value;
  const gzipped =
    !first.done && head !== undefined && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head !== undefined) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
  if (!gzipped) return source;
  // DecompressionStream is typed as taking BufferSource while a body stream
  // yields Uint8Array; the two are the same bytes and lib.dom does not say so.
  return (source as unknown as ReadableStream<BufferSource>).pipeThrough(
    new DecompressionStream('gzip'),
  );
}

/**
 * Fetch the big files ourselves, so the download has a number attached to it
 * and lands in the Cache API before the module needs it.
 *
 * Emscripten would fetch them itself, and did — but from inside its own loader,
 * where nothing can see how far along it is, and only *after* a successful boot
 * was there anything to cache. A first visit interrupted halfway left nothing
 * behind, and the loading screen claimed "0% of 0 MB" for the ten seconds it
 * took, because the client had no numbers to report.
 *
 * Sizes come from the release manifest, which records the uncompressed length
 * of every file. `Content-Length` cannot: the transport is gzipped and the
 * reader yields decompressed bytes, so the fraction would run past 100%.
 *
 * Every failure here falls back to letting Emscripten do what it always did.
 */
async function prefetch(): Promise<Map<string, string> | null> {
  if (typeof caches === 'undefined') return null;
  try {
    /** What Emscripten will ask for, and how to get it. */
    interface Asset {
      /** The name Emscripten uses; what `locateFile` is called with. */
      name: string;
      /** Where it actually is, which a build step may have changed. */
      url: string;
      /** Uncompressed length, for the progress bar. 0 when unknown. */
      bytes: number;
    }
    const assets: Asset[] = BIG_ASSETS.map((name) => ({
      name,
      url: new URL(name, BASE).href,
      bytes: 0,
    }));
    try {
      const manifest = (await (await fetch(new URL('manifest.json', BASE))).json()) as {
        files?: Record<string, { path: string; bytes: number; encoding?: string }>;
      };
      const byKey: Record<string, string> = {
        wasm: 'abi_query.wasm',
        headers: 'abi_query.data',
      };
      for (const [key, file] of Object.entries(manifest.files ?? {})) {
        const asset = assets.find((a) => a.name === byKey[key]);
        if (!asset) continue;
        asset.bytes = file.bytes;
        // The build may have gzipped it and renamed it — a 28 MB single asset
        // is over the limit of the host this deploys to. `bytes` stays the
        // uncompressed length, which is what the progress bar counts against
        // because that is what comes out of the reader either way.
        if (file.path) asset.url = new URL(file.path, BASE).href;
      }
    } catch {
      // No manifest: the plain names, and an indeterminate bar.
    }

    const cache = await caches.open(CACHE);
    const total = assets.reduce((a, b) => a + b.bytes, 0);
    let done = 0;
    const urls = new Map<string, string>();

    for (const asset of assets) {
      // Cached decompressed, under the name Emscripten asks for: the work of
      // undoing gzip is done once, not on every visit.
      const key = new URL(asset.name, BASE).href;
      let response = await cache.match(key);
      if (response) {
        // Already local: no download, and no pretending there was one.
        done += asset.bytes;
        post({ type: 'progress', phase: 'download', done, total });
      } else {
        const network = await fetch(asset.url);
        if (!network.ok || !network.body) return null;
        const reader = network.body.getReader();
        const body = await maybeGunzip(reader);
        const out = body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done: finished, value } = await out.read();
          if (finished) break;
          chunks.push(value);
          // Decompressed bytes against the uncompressed total, which is what
          // the manifest records for exactly this reason.
          done += value.byteLength;
          post({ type: 'progress', phase: 'download', done, total });
        }
        response = new Response(new Blob(chunks as BlobPart[]));
        await cache.put(key, response.clone());
      }
      urls.set(asset.name, URL.createObjectURL(await response.blob()));
    }
    return urls;
  } catch (e) {
    // Offline, no Cache API, a partial read — Emscripten's problem now. Say so:
    // a silent fall back to a path that may not exist is a stuck loading screen
    // with nothing to go on.
    console.warn('[abi] prefetch failed, letting the module fetch its own files', e);
    return null;
  }
}

async function boot(): Promise<AbiWasmModule> {
  if (module) return module;

  const local = await prefetch();
  post({ type: 'progress', phase: 'compile', done: 0, total: 0 });

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
    factory = ((await import(/* @vite-ignore */ blobUrl)) as { default: EmscriptenFactory })
      .default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  try {
    const instance = await factory({
      // The blob has no directory of its own, so every sibling is named
      // outright — from what we already hold, where we have it.
      locateFile: (p) => local?.get(p) ?? new URL(p, BASE).href,
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
    for (const url of local?.values() ?? []) URL.revokeObjectURL(url);
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

/**
 * The glue, into the Cache API so the next visit works offline.
 *
 * The service worker cannot do this on its own here: a dedicated worker starts
 * alongside the registration, so its fetches on a first visit may go out before
 * anything is controlling them, and a cache-first route that never sees the
 * request never fills. The two big files are cached as they stream in; this is
 * the small one that is fetched by URL.
 *
 * Deliberately after `ready`: the user is reading their first layout while this
 * runs, and it must not delay that.
 */
async function warmCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE);
  const url = new URL('abi_query.mjs', BASE).href;
  if (await cache.match(url)) return;
  try {
    // Served from the HTTP cache in practice: it was just fetched.
    const response = await fetch(url);
    if (response.ok) await cache.put(url, response);
  } catch {
    // Offline already — the next visit retries.
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
