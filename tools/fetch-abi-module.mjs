// Fetches a clang-abi-wasm release into public/vendor/abi/, which is what the
// deployed site serves. `npm run build` runs it first, because a build without
// the module produces a site that loads and then cannot answer anything.
//
//   node tools/fetch-abi-module.mjs            # the pinned version
//   node tools/fetch-abi-module.mjs v0.1.0     # a specific release
//
// Development uses a symlink instead (clang-abi-wasm's scripts/dev-link.sh), so
// a rebuild over there shows up here on reload; this leaves the link alone.
//
// Idempotent: the manifest records a sha256 per file, so a second run verifies
// what is already on disk and downloads nothing.

/* eslint-disable no-console -- a CLI: its output is the interface */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEST = path.join(ROOT, 'public', 'vendor', 'abi');
const REPO = process.env['ABI_MODULE_REPO'] ?? 'tothambrus11/clang-abi-wasm';

/** Pinned here rather than floating: the site's layouts must not change on a whim. */
const DEFAULT_VERSION = 'v0.1.0';

const version = process.argv[2] ?? process.env['ABI_MODULE_VERSION'] ?? DEFAULT_VERSION;
const base =
  process.env['ABI_MODULE_BASE'] ?? `https://github.com/${REPO}/releases/download/${version}/`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// A symlink means someone ran clang-abi-wasm's dev-link.sh and is iterating on
// a local build. Overwriting that with a release would replace their working
// copy with the last published one, silently, in the middle of a change.
if (existsSync(DEST) && (await lstat(DEST)).isSymbolicLink()) {
  console.log(`public/vendor/abi is a symlink to a local build — leaving it alone.`);
  console.log('Remove the link to fetch a release instead.');
  process.exit(0);
}

async function get(name) {
  const url = new URL(name, base).href;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `${url} -> ${res.status} ${res.statusText}\n` +
        (res.status === 404
          ? `  Is ${version} released, and is ${REPO} reachable without a token?\n` +
            '  A private repo needs `gh release download` with credentials instead.'
          : ''),
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

async function upToDate(file, expected) {
  const target = path.join(DEST, file);
  if (!existsSync(target)) return false;
  return sha256(await readFile(target)) === expected;
}

// A build must not fail because the network is down when the module is already
// here — but it must fail when it is not, rather than deploy a site that cannot
// answer anything.
let manifestBody;
try {
  manifestBody = await get('manifest.json');
} catch (e) {
  if (existsSync(path.join(DEST, 'abi_query.wasm'))) {
    console.warn(`could not reach ${base} — keeping the module already in ${DEST}`);
    console.warn(`  ${e.message.split('\n')[0]}`);
    process.exit(0);
  }
  throw e;
}
const manifest = JSON.parse(manifestBody.toString());
console.log(`clang-abi-wasm ${manifest.version} (clang ${manifest.clang})`);

await mkdir(DEST, { recursive: true });

// The module's own loader resolves its siblings by plain name, so the
// content-addressed files are written back under the names it expects. The
// hashes still did their job: they are how the download is verified, and how a
// release that changed nothing costs nothing to re-fetch.
const LOCAL_NAME = { wasm: 'abi_query.wasm', glue: 'abi_query.mjs', headers: 'abi_query.data' };

let fetched = 0;
for (const [key, entry] of Object.entries(manifest.files)) {
  const name = LOCAL_NAME[key];
  if (!name) continue;
  if (await upToDate(name, entry.sha256)) {
    console.log(`  ok        ${name}`);
    continue;
  }
  const body = await get(entry.path);
  const got = sha256(body);
  if (got !== entry.sha256) {
    throw new Error(
      `${entry.path}: sha256 mismatch\n  expected ${entry.sha256}\n  got      ${got}`,
    );
  }
  await writeFile(path.join(DEST, name), body);
  console.log(`  fetched   ${name}  (${(body.length / 1048576).toFixed(1)} MB)`);
  fetched++;
}

for (const file of ['index.mjs', 'index.d.ts']) {
  await writeFile(path.join(DEST, file), await get(file));
}

// The manifest is written with the paths *this* directory uses, not the ones
// the release used. `load()` resolves the files through it, so a manifest still
// naming `wasm-9ec58989c571.wasm` next to a file called `abi_query.wasm` is a
// 404 with a plausible-looking cause. The hashes stay: they are how a re-run
// knows it has nothing to do.
const local = { ...manifest, files: { ...manifest.files } };
for (const [key, entry] of Object.entries(local.files)) {
  if (LOCAL_NAME[key]) local.files[key] = { ...entry, path: LOCAL_NAME[key] };
}
await writeFile(path.join(DEST, 'manifest.json'), JSON.stringify(local, null, 2));

console.log(
  fetched ? `\n${fetched} file(s) downloaded into public/vendor/abi/` : '\nalready current',
);
