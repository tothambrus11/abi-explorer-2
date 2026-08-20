// Worker host for clang-abi-wasm.
//
// The module is ~11 MB over the wire and a query over libc++ takes a few hundred
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

/**
 * Emscripten's name for each file the manifest lists. A release names them by
 * content — `wasm-9ec58989c571.wasm` — so these names exist only inside the
 * module's own loader, and the manifest is what maps one to the other.
 */
const ASSET_NAMES: Record<string, string> = {
  wasm: 'abi_query.wasm',
  headers: 'abi_query.data',
  glue: 'abi_query.mjs',
};

/** The two worth a progress bar. The glue is 300 kB and arrives first. */
const BIG_ASSETS: readonly string[] = ['abi_query.wasm', 'abi_query.data'];

const CACHE = 'abix-abi-module-v1';

/** What Emscripten will ask for, and how to get it. */
interface Asset {
  /** The name Emscripten uses; what `locateFile` is called with. */
  name: string;
  /** Where it actually is. Content-addressed, so it changes on every release. */
  url: string;
  /** Uncompressed length — what the file is once it is here. */
  bytes: number;
  /** What crosses the network, which is less where the build gzipped it. */
  transferBytes: number;
}

interface ManifestFile {
  path?: string;
  bytes: number;
  transferBytes?: number;
}

/**
 * Where the files are, according to the manifest.
 *
 * This is not an optimisation: the build gzips the big files and names every
 * one of them after its content, so guessing `abi_query.wasm` finds nothing.
 * The manifest is the one mutable file in the directory and the only thing
 * that knows the current layout.
 *
 * Network first, our own cache second — deliberately, and in that order. It is
 * the only file here that ever changes, so a cached copy preferred over a
 * fresh one would pin a visitor to whichever module they first downloaded,
 * forever; and it is the only file a second visit cannot do without, so a
 * cached copy is what makes the app work offline. The service worker has the
 * same policy, but cannot be relied on for it: a dedicated worker starts
 * alongside the registration, so its fetches on a first visit may go out
 * before anything is controlling them.
 */
async function resolveAssets(cache: Cache | null): Promise<Asset[]> {
  const url = new URL('manifest.json', BASE).href;
  // `globalThis.`: `Response` in type position is this file's own protocol
  // type, a few lines up.
  let response: globalThis.Response | undefined;
  try {
    const fresh = await fetch(url, { cache: 'no-cache' });
    if (fresh.ok) {
      response = fresh;
      await cache?.put(url, fresh.clone()).catch(() => {});
    }
  } catch {
    // Offline. The copy from last time still describes a module that is here.
  }
  response ??= await cache?.match(url);
  if (!response) throw new Error(`${url} is unreachable and was never cached`);

  const manifest = (await response.json()) as { files?: Record<string, ManifestFile> };
  const assets: Asset[] = [];
  for (const [key, file] of Object.entries(manifest.files ?? {})) {
    const name = ASSET_NAMES[key];
    if (name === undefined) continue;
    assets.push({
      name,
      url: new URL(file.path ?? name, BASE).href,
      bytes: file.bytes,
      transferBytes: file.transferBytes ?? file.bytes,
    });
  }
  return assets;
}

/** The Cache API, where there is one — an insecure origin has none. */
async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  return caches.open(CACHE).catch(() => null);
}

/**
 * A stream over what is left of `reader`, with the already-read `head` put
 * back at the front, counting bytes as they go past.
 *
 * The count happens here, on the near side of any decompression, because the
 * number on screen is meant to be the number the consent gate quoted: what the
 * connection actually spends, not what it expands to.
 */
function restream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array | undefined,
  ended: boolean,
  onBytes: (n: number) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head !== undefined) {
        onBytes(head.byteLength);
        controller.enqueue(head);
      }
      if (ended) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      onBytes(value.byteLength);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Does this start with a gzip member (1f 8b) rather than a wasm module? */
const isGzip = (head: Uint8Array | undefined): boolean =>
  head !== undefined && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

/**
 * Fetch the module's files ourselves: decompress what the build compressed,
 * report progress, and leave a copy in the Cache API.
 *
 * Emscripten would fetch them itself, and did — but from inside its own loader,
 * where nothing can see how far along it is, and only *after* a successful boot
 * was there anything to cache. A first visit interrupted halfway left nothing
 * behind, and the loading screen claimed "0% of 0 MB" for the ten seconds it
 * took, because the client had no numbers to report. It also cannot fetch them
 * at all any more: the two big files ship gzipped under `.gz` names, and
 * undoing that is this function's job.
 *
 * The cache is best-effort — an insecure origin has no Cache API and a full
 * disk fails the write — but the download is not, so caching failures cost the
 * next visit, not this one.
 */
async function fetchAssets(assets: Asset[], cache: Cache | null): Promise<Map<string, string>> {
  const counted = (a: Asset) => BIG_ASSETS.includes(a.name);

  let total = assets.filter(counted).reduce((n, a) => n + a.transferBytes, 0);
  let done = 0;
  const progress = () => {
    post({ type: 'progress', phase: 'download', done, total });
  };

  const urls = new Map<string, string>();
  for (const asset of assets) {
    // Cached decompressed, under the content-addressed URL it came from: the
    // work of undoing gzip is done once, and a new release cannot collide with
    // an old one because no two versions share a name.
    let body = cache ? await cache.match(asset.url) : undefined;
    if (body) {
      if (counted(asset)) {
        done += asset.transferBytes;
        progress();
      }
    } else {
      const network = await fetch(asset.url);
      if (!network.ok || !network.body) {
        throw new Error(`${asset.url} -> ${String(network.status)} ${network.statusText}`);
      }
      const reader = network.body.getReader();

      // Whether the bytes arrive compressed is not ours to decide. A static
      // host that recognises `.gz` sets `Content-Encoding: gzip` and the
      // browser has already undone it by the time we see a byte, while one
      // that does not hands over the gzip stream; Vite's preview server does
      // the former and Cloudflare does the latter. So neither a header nor a
      // manifest flag is the authority — the first two bytes are.
      const first = await reader.read();
      const head = first.done ? undefined : first.value;
      const gzipped = isGzip(head);
      // Undone in transit: then what crosses the wire is not `transferBytes`,
      // and the total has to say so before the first tick is reported.
      if (counted(asset) && !gzipped) total += asset.bytes - asset.transferBytes;

      const wire = restream(reader, head, first.done, (n) => {
        if (!counted(asset)) return;
        done += n;
        progress();
      });
      // DecompressionStream is typed as taking BufferSource while a body
      // stream yields Uint8Array; the two are the same bytes and lib.dom does
      // not say so.
      const bytes = gzipped
        ? (wire as unknown as ReadableStream<BufferSource>).pipeThrough(
            new DecompressionStream('gzip'),
          )
        : wire;

      const chunks: Uint8Array[] = [];
      const out = bytes.getReader();
      for (;;) {
        const { done: finished, value } = await out.read();
        if (finished) break;
        chunks.push(value);
      }
      body = new Response(new Blob(chunks as BlobPart[]));
      await cache?.put(asset.url, body.clone()).catch(() => {});
    }
    // `import()` refuses a blob URL that does not claim to be JavaScript, and
    // a body read back out of the Cache API claims nothing.
    const type = asset.name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
    urls.set(asset.name, URL.createObjectURL(new Blob([await body.blob()], { type })));
  }

  // Nothing here is named after a version, so an upgrade would otherwise leave
  // the whole previous module — some 47 MB of it — cached forever.
  if (cache) {
    const keep = new Set([new URL('manifest.json', BASE).href, ...assets.map((a) => a.url)]);
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) await cache.delete(request);
    }
  }
  return urls;
}

async function boot(): Promise<AbiWasmModule> {
  if (module) return module;

  const cache = await openCache();
  const assets = await resolveAssets(cache);
  const local = await fetchAssets(assets, cache);
  post({ type: 'progress', phase: 'compile', done: 0, total: 0 });

  // The glue is evaluated from a blob rather than imported by URL. A dedicated
  // worker's `import()` does not go through the service worker in Chromium, so
  // an imported module is simply unavailable offline however well it was
  // cached — while `fetch` is served normally. Going through what we already
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
      // outright — from what we already hold, where we have it.
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
