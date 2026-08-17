// Module worker that owns the wasm-compiled clang instance.
//
// Asset loading: the YoWASP runtime fetches llvm.core*.wasm and
// llvm-resources.tar relative to vendor/clang/bundle.js. If those files are
// vendored locally (tools/vendor-clang.sh), they're used directly. Otherwise
// we download the @yowasp/clang npm tarball (~27 MB gzipped, CORS-enabled),
// cache it via the Cache API, un-gzip/un-tar it in memory, and intercept the
// runtime's fetches to serve the assets from memory.
//
// Protocol:
//   -> { type: 'init' }
//   <- { type: 'progress', done, total, phase }
//   <- { type: 'ready', version }
//   -> { type: 'compile', id, argv0, args, files }
//   <- { type: 'result', id, code, stdout, stderr }

const CLANG_VERSION = '22.0.0-git20542-10';
const NPM_TARBALL = `https://registry.npmjs.org/@yowasp/clang/-/clang-${CLANG_VERSION}.tgz`;
const CACHE_NAME = 'abix-clang-' + CLANG_VERSION;
const ASSETS = ['llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm',
  'llvm.core4.wasm', 'llvm-resources.tar'];

const decoder = new TextDecoder();
let clangModule = null;   // { runClang, Exit }
let assetMap = null;      // name -> Uint8Array (npm-tarball mode)

async function haveLocalAssets() {
  try {
    const res = await fetch(new URL('../vendor/clang/llvm.core.wasm', import.meta.url), { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchTarball(progress) {
  let response = null;
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    response = await cache.match(NPM_TARBALL);
  } catch { /* Cache API unavailable (e.g. private mode) */ }

  if (!response) {
    response = await fetch(NPM_TARBALL);
    if (!response.ok) throw new Error(`Failed to download clang from npm (${response.status})`);
    if (cache) {
      try { await cache.put(NPM_TARBALL, response.clone()); } catch { /* quota */ }
    }
  }

  const total = Number(response.headers.get('content-length')) || 27112311;
  const reader = response.body.getReader();
  const chunks = [];
  let done = 0;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    chunks.push(value);
    done += value.length;
    progress(done, total, 'download');
  }
  const gz = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) { gz.set(c, off); off += c.length; }
  return gz;
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ustar reader: returns Map path -> Uint8Array. */
function untar(bytes) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;
    const name = readStr(block, 0, 100);
    const prefix = readStr(block, 345, 155);
    const size = parseInt(readStr(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156]);
    const path = prefix ? prefix + '/' + name : name;
    off += 512;
    if (type === '0' || type === '' || type === '\0') {
      files.set(path, bytes.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

function readStr(block, start, len) {
  let end = start;
  while (end < start + len && block[end] !== 0) end++;
  return decoder.decode(block.subarray(start, end));
}

function installFetchInterceptor() {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const name = ASSETS.find(a => url.endsWith('/' + a));
    if (name && assetMap && assetMap.has(name)) {
      const type = name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      const body = assetMap.get(name);
      return Promise.resolve(new Response(body, {
        headers: { 'Content-Type': type, 'Content-Length': String(body.length) },
      }));
    }
    return realFetch(input, init);
  };
}

async function loadClang(progress) {
  if (!(await haveLocalAssets())) {
    const gz = await fetchTarball(progress);
    progress(0, 1, 'unpack');
    const tar = await gunzip(gz);
    const entries = untar(tar);
    assetMap = new Map();
    for (const name of ASSETS) {
      const data = entries.get('package/gen/' + name);
      if (!data) throw new Error(`npm tarball is missing gen/${name}`);
      assetMap.set(name, data);
    }
    installFetchInterceptor();
  }
  // Import the runtime only after the interceptor is (possibly) installed:
  // it captures globalThis.fetch at module evaluation time.
  clangModule = await import('../vendor/clang/bundle.js');
  // Prefetch + compile the wasm modules (progress covers instantiation).
  await clangModule.runClang(null, {}, {
    fetchProgress: ({ totalLength, doneLength }) => progress(doneLength, totalLength, 'compile'),
  });
}

async function compile(argv0, args, files) {
  let stdout = '', stderr = '', code = 0;
  try {
    await clangModule.runClang([argv0, ...args], files, {
      stdout: b => { if (b) stdout += decoder.decode(b, { stream: true }); },
      stderr: b => { if (b) stderr += decoder.decode(b, { stream: true }); },
    });
  } catch (e) {
    if (e instanceof clangModule.Exit) code = e.code;
    else throw e;
  }
  return { code, stdout, stderr };
}

// clang runs in a single wasm instance: serialize all requests.
let queue = Promise.resolve();
self.onmessage = (ev) => { queue = queue.then(() => handle(ev.data)).catch(() => {}); };

async function handle(msg) {
  try {
    if (msg.type === 'init') {
      await loadClang((done, total, phase) =>
        postMessage({ type: 'progress', done, total, phase }));
      const { stdout } = await compile('clang', ['--version'], {});
      postMessage({ type: 'ready', version: stdout.split('\n')[0] || 'clang (wasm)' });
    } else if (msg.type === 'compile') {
      const { code, stdout, stderr } = await compile(msg.argv0, msg.args, msg.files);
      postMessage({ type: 'result', id: msg.id, code, stdout, stderr });
    }
  } catch (e) {
    postMessage({ type: 'error', id: msg.id, message: String(e && e.stack || e) });
  }
}
