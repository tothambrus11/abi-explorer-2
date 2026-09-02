// Worker host for the Hylo layout module.
//
// The shape of the thing is different from clang's. That module is a command
// Emscripten boots and then answers `cwrap` calls; this one is a WebAssembly
// *reactor*: the standard library has to be type checked before any query can
// be answered, which takes about five seconds, and the resulting program has to
// survive between queries or every one of them would pay for it again. So the
// module is instantiated once, handed the standard library, and then called
// through its exports.
//
// The standard library arrives as a separate file rather than baked into the
// binary because a browser has no file system for the compiler to read it from,
// and because 75 kB of Hylo source next to a 20 MB module is not worth
// rebuilding the module to change.

import { toWireResponse, HYLO_TRIPLE, type HyloAnswer } from './hylo-wire';
import { fetchAssets, openCache, resolveAssets, type AssetSpec } from './module-assets';
import { wasiImports, type MemorySource } from './wasi-shim';
import type { WireResponse } from '$core/render';

interface HyloModule {
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
 * so a sub-path deployment finds its own copy; `VITE_HYLO_BASE` overrides it
 * for a locally built module.
 */
const BASE = new URL(
  (import.meta.env['VITE_HYLO_BASE'] as string | undefined) ?? 'vendor/hylo/',
  new URL(import.meta.env.BASE_URL, self.location.origin),
).href;

/** A cache of its own, so choosing a language never evicts the other module. */
const CACHE = 'abix-hylo-module-v1';

const ASSETS: AssetSpec[] = [
  { key: 'wasm', name: 'hylo_layout.wasm', counted: true },
  // 75 kB against the module's 20 MB: counting it would only make the bar
  // jump by a pixel it does not have.
  { key: 'stdlib', name: 'hylo_stdlib.json', counted: false },
];

/** What the reactor exports. Strings cross as UTF-8 in `memory`. */
interface Reactor {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  hylo_alloc: (n: number) => number;
  hylo_free: (p: number) => void;
  hylo_init: (p: number, n: number) => number;
  hylo_query: (p: number, n: number) => number;
}

/**
 * Calls `fn` with `value` as JSON and parses what comes back.
 *
 * The buffer the module returns is its length as a little-endian `UInt32`
 * followed by the bytes, and freeing it is the caller's job. `memory.buffer`
 * is read afresh after every call into the guest: allocating can grow the
 * memory, which detaches the old `ArrayBuffer` and turns any view over it into
 * a source of zeroes.
 */
function call(m: Reactor, fn: (p: number, n: number) => number, value: unknown): unknown {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const argument = m.hylo_alloc(bytes.length);
  new Uint8Array(m.memory.buffer).set(bytes, argument);

  let answer: number;
  try {
    answer = fn(argument, bytes.length);
  } finally {
    // Freeing may itself trap when the call did, and the trap worth reporting
    // is the first one: a leaked buffer in an instance about to be thrown away
    // costs nothing, while losing what went wrong costs the diagnosis.
    release(m, argument);
  }

  try {
    const length = new DataView(m.memory.buffer).getUint32(answer, true);
    const text = new TextDecoder().decode(
      new Uint8Array(m.memory.buffer, answer + 4, length).slice(),
    );
    return JSON.parse(text);
  } finally {
    release(m, answer);
  }
}

/** Frees a buffer, ignoring a failure to: see the call sites. */
function release(m: Reactor, p: number): void {
  try {
    m.hylo_free(p);
  } catch {
    /* the instance is already lost; `discard` below is what answers for it */
  }
}

/**
 * One boot, whoever asks.
 *
 * The promise is what is shared, not its result: a second message arriving
 * before instantiation finished would otherwise start a second download and a
 * second instance of a 20 MB module.
 */
let booting: Promise<HyloModule> | null = null;
const boot = (): Promise<HyloModule> => (booting ??= instantiate());

/** The instance `booting` resolved to, while it is still fit to be asked. */
let live: HyloModule | null = null;

/**
 * Throws `m` away, so that the next question builds a fresh instance.
 *
 * Called when a call into the guest trapped. The module reports its own
 * failures as an `error` field in the answer, so anything that reaches the host
 * as a thrown value is the instance dying: its heap, and the type checked
 * standard library sitting in it, are no longer worth trusting. Rebuilding
 * costs the five seconds `hylo_init` takes, which is the right price for not
 * answering the next query out of a corrupt program.
 *
 * Does nothing if `m` is not the current instance, so two queries failing
 * together discard one instance rather than two.
 */
function discard(m: HyloModule): void {
  if (live !== m) return;
  live = null;
  booting = null;
}

/**
 * Downloads, caches and instantiates the reactor, then loads the standard
 * library into it.
 *
 * Call through `boot`, never directly. Rejects if a file is missing or the
 * standard library does not type check, quoting whatever the module printed on
 * its way down, since a trap leaves nothing else to go on. Type checking the
 * library is what makes this expensive and is why the result is kept for the
 * life of the worker.
 */
async function instantiate(): Promise<HyloModule> {
  const cache = await openCache(CACHE);
  const assets = await resolveAssets(BASE, ASSETS, cache);
  const counted = (name: string) => ASSETS.find((a) => a.name === name)?.counted ?? false;
  const files = await fetchAssets(BASE, assets, counted, cache, (done, total) => {
    post({ type: 'progress', phase: 'download', done, total });
  });

  const wasm = files.get('hylo_layout.wasm');
  const stdlib = files.get('hylo_stdlib.json');
  if (!wasm || !stdlib) throw new Error('the manifest is missing a file this module needs');

  // Compiling 57 MB of WebAssembly and then type checking the standard library
  // are both slow and neither reports progress, so the phase changes once and
  // stays there.
  post({ type: 'progress', phase: 'compile', done: 0, total: 0 });

  const source: MemorySource = { memory: null };
  let output = '';
  const imports = {
    wasi_snapshot_preview1: wasiImports(source, (_fd, text) => (output += text)),
  };
  const { instance } = await WebAssembly.instantiate(await wasm.arrayBuffer(), imports);
  const m = instance.exports as unknown as Reactor;
  source.memory = m.memory;
  m._initialize();

  const loaded = call(m, m.hylo_init, JSON.parse(await stdlib.text())) as {
    ok?: boolean;
    error?: string;
  };
  if (loaded.ok !== true) {
    // `output` is whatever the runtime printed on its way down, which is the
    // only explanation there is when the module trapped rather than answered.
    const why = loaded.error ?? output.trim();
    throw new Error(why === '' ? 'the standard library could not be loaded' : why);
  }

  const module: HyloModule = {
    query: (request) => {
      try {
        return toWireResponse(call(m, m.hylo_query, request) as HyloAnswer, version());
      } catch (e) {
        discard(module);
        throw e;
      }
    },
    // Hylo describes one ABI so far. It is still reported as a target so that
    // the selector has something true to show rather than clang's list, which
    // this module cannot lay anything out for.
    targets: () => [HYLO_TRIPLE],
    version,
  };
  live = module;
  return module;
}

/**
 * What to call the module in the status bar.
 *
 * The compiler has no release to name yet, so the honest answer is what it is
 * rather than which one it is.
 */
const version = () => 'Hylo (wasm)';

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
