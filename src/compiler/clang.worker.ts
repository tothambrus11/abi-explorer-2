// Module worker that owns the wasm-compiled clang instance (YoWASP build).
//
// Asset loading: the YoWASP runtime (public/vendor/clang/bundle.js) fetches
// llvm.core*.wasm and llvm-resources.tar relative to its own URL. If those
// files are vendored locally (tools/vendor-clang.sh) they are used directly.
// Otherwise we download the @yowasp/clang npm tarball (~27 MB gzipped,
// CORS-enabled), keep it in the Cache API (cache "abix-clang-<version>"),
// un-gzip/un-tar it in memory and intercept the runtime's fetches.
//
// clang runs in a single wasm instance, so requests are serialized.

import { parseRequest, type Response as WorkerResponse } from './protocol';

const CLANG_VERSION = '22.0.0-git20542-10';
const NPM_TARBALL = `https://registry.npmjs.org/@yowasp/clang/-/clang-${CLANG_VERSION}.tgz`;
export const CLANG_CACHE_NAME = 'abix-clang-' + CLANG_VERSION;
const ASSETS = [
  'llvm.core.wasm',
  'llvm.core2.wasm',
  'llvm.core3.wasm',
  'llvm.core4.wasm',
  'llvm-resources.tar',
];
// Resolved against Vite's base so a sub-path deployment finds the vendored files.
const VENDOR_BASE = new URL(import.meta.env.BASE_URL, self.location.origin);
const RUNTIME_URL = new URL('vendor/clang/bundle.js', VENDOR_BASE).href;

interface YoWaspRuntime {
  runClang(
    args: string[] | null,
    files: Record<string, string>,
    options: {
      stdout?: (b: Uint8Array | null) => void;
      stderr?: (b: Uint8Array | null) => void;
      fetchProgress?: (e: { totalLength: number; doneLength: number }) => void;
    },
  ): Promise<unknown>;
  Exit: new (...a: unknown[]) => Error & { code: number };
}

const decoder = new TextDecoder();
let runtime: YoWaspRuntime | null = null;
let assetMap: Map<string, Uint8Array> | null = null;

const post = (msg: WorkerResponse) => {
  self.postMessage(msg);
};

async function haveLocalAssets(): Promise<boolean> {
  try {
    // GET (not HEAD): the service worker's cache-first route only serves GET,
    // so a HEAD probe would fail offline even with the assets cached.
    const res = await fetch(new URL('vendor/clang/llvm.core.wasm', VENDOR_BASE));
    // Dev servers answer unknown paths with the SPA fallback (200 text/html).
    const ok = res.ok && /wasm|octet-stream/.test(res.headers.get('content-type') ?? '');
    void res.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

async function fetchTarball(progress: (done: number, total: number) => void): Promise<Uint8Array> {
  let response: Response | undefined;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CLANG_CACHE_NAME);
    response = await cache.match(NPM_TARBALL);
  } catch {
    /* Cache API unavailable (private mode, quota) — run from memory */
  }
  if (!response) {
    response = await fetch(NPM_TARBALL);
    if (!response.ok) throw new Error(`Failed to download clang from npm (${response.status})`);
    if (cache) {
      try {
        await cache.put(NPM_TARBALL, response.clone());
      } catch {
        /* quota */
      }
    }
  }
  const total = Number(response.headers.get('content-length')) || 27_112_311;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    chunks.push(value);
    done += value.length;
    progress(done, total);
  }
  const gz = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    gz.set(c, off);
    off += c.length;
  }
  return gz;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ustar reader: path -> bytes. */
function untar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let off = 0;
  const readStr = (block: Uint8Array, start: number, len: number) => {
    let end = start;
    while (end < start + len && block[end] !== 0) end++;
    return decoder.decode(block.subarray(start, end));
  };
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = readStr(block, 0, 100);
    const prefix = readStr(block, 345, 155);
    const size = parseInt(readStr(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156]!);
    const path = prefix ? prefix + '/' + name : name;
    off += 512;
    if (type === '0' || type === '' || type === '\0') {
      files.set(path, bytes.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

function installFetchInterceptor(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const name = ASSETS.find((a) => url.endsWith('/' + a));
    if (name && assetMap?.has(name)) {
      const body = assetMap.get(name)!;
      const type = name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return Promise.resolve(
        new Response(body as BodyInit, {
          headers: { 'Content-Type': type, 'Content-Length': String(body.length) },
        }),
      );
    }
    return realFetch(input, init);
  };
}

async function loadClang(): Promise<void> {
  if (!(await haveLocalAssets())) {
    const gz = await fetchTarball((done, total) => {
      post({ type: 'progress', phase: 'download', done, total });
    });
    post({ type: 'progress', phase: 'unpack', done: 0, total: 1 });
    const entries = untar(await gunzip(gz));
    assetMap = new Map();
    for (const name of ASSETS) {
      const data = entries.get('package/gen/' + name);
      if (!data) throw new Error(`npm tarball is missing gen/${name}`);
      assetMap.set(name, data);
    }
    installFetchInterceptor();
  }
  // Import the runtime only after the interceptor is (possibly) installed: it
  // captures globalThis.fetch at module evaluation time. Loaded from /public
  // (not bundled) so its relative asset URLs stay stable.
  runtime = (await import(/* @vite-ignore */ RUNTIME_URL)) as YoWaspRuntime;
  await runtime.runClang(
    null,
    {},
    {
      fetchProgress: ({ totalLength, doneLength }) => {
        post({ type: 'progress', phase: 'compile', done: doneLength, total: totalLength });
      },
    },
  );
}

async function compile(argv0: string, args: string[], files: Record<string, string>) {
  // One streaming decoder per stream so a multi-byte sequence split across
  // chunks is reassembled within its own stream (and flushed at the end).
  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    await runtime!.runClang([argv0, ...args], files, {
      stdout: (b) => {
        if (b) stdout += outDec.decode(b, { stream: true });
      },
      stderr: (b) => {
        if (b) stderr += errDec.decode(b, { stream: true });
      },
    });
  } catch (e) {
    if (e instanceof runtime!.Exit) code = e.code;
    else throw e;
  }
  stdout += outDec.decode();
  stderr += errDec.decode();
  return { code, stdout, stderr };
}

let queue: Promise<void> = Promise.resolve();
/** Ids of queued compiles the client no longer wants; skipped when their turn comes. */
const cancelled = new Set<number>();

self.onmessage = (ev: MessageEvent<unknown>) => {
  const msg = parseRequest(ev.data);
  if (!msg) {
    post({ type: 'error', message: 'malformed request' });
    return;
  }
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  queue = queue.then(() => handle(msg)).catch(() => {});
};

async function handle(msg: Exclude<ReturnType<typeof parseRequest>, null>): Promise<void> {
  try {
    if (msg.type === 'init') {
      await loadClang();
      const { stdout } = await compile('clang', ['--version'], {});
      const first = stdout.split('\n')[0]?.trim();
      post({
        type: 'ready',
        version: first !== undefined && first !== '' ? first : 'clang (wasm)',
      });
    } else if (msg.type === 'compile') {
      if (cancelled.delete(msg.id)) return; // client gave up while this was queued
      const r = await compile(msg.argv0, msg.args, msg.files);
      post({ type: 'result', id: msg.id, ...r });
    }
  } catch (e) {
    post({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
