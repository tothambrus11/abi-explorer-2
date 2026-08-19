// Fetches a clang-abi-wasm release into public/vendor/abi/, which is what the
// deployed site serves.
//
//   node tools/fetch-abi-module.mjs            # the version in package.json
//   node tools/fetch-abi-module.mjs v0.1.0     # a specific release
//
// Development uses a symlink instead (clang-abi-wasm's scripts/dev-link.sh), so
// a rebuild over there shows up here on reload. This script is for CI and for
// anyone who just wants the site to build.
//
// Idempotent: the manifest records a sha256 per file, so a second run verifies
// what is already on disk and downloads nothing.

/* eslint-disable no-console -- a CLI: its output is the interface */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEST = path.join(ROOT, 'public', 'vendor', 'abi');
const REPO = process.env['ABI_MODULE_REPO'] ?? 'tothambrus11/clang-abi-wasm';

/** Pinned here rather than floating: the site's layouts must not change on a whim. */
const DEFAULT_VERSION = 'v0.1.0';

const version = process.argv[2] ?? process.env['ABI_MODULE_VERSION'] ?? DEFAULT_VERSION;
const base =
  process.env['ABI_MODULE_BASE'] ??
  `https://github.com/${REPO}/releases/download/${version}/`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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

const manifest = JSON.parse((await get('manifest.json')).toString());
console.log(`clang-abi-wasm ${manifest.version} (clang ${manifest.clang})`);

await mkdir(DEST, { recursive: true });

// The module's own loader resolves its siblings by plain name, so the
// content-addressed files are written back under the names it expects. The
// hashes still did their job: they are how the download is verified, and how a
// release that changed nothing costs nothing to re-fetch.
const LOCAL_NAME = { wasm: 'abi_query.wasm', glue: 'abi_query.mjs', headers: 'abi_query.data' };

let fetched = 0;
for (const [key, entry] of Object.entries(manifest.files)) {
  const local = LOCAL_NAME[key];
  if (!local) continue;
  if (await upToDate(local, entry.sha256)) {
    console.log(`  ok        ${local}`);
    continue;
  }
  const body = await get(entry.path);
  const got = sha256(body);
  if (got !== entry.sha256) {
    throw new Error(`${entry.path}: sha256 mismatch\n  expected ${entry.sha256}\n  got      ${got}`);
  }
  await writeFile(path.join(DEST, local), body);
  console.log(`  fetched   ${local}  (${(body.length / 1048576).toFixed(1)} MB)`);
  fetched++;
}

for (const file of ['index.mjs', 'index.d.ts']) {
  await writeFile(path.join(DEST, file), await get(file));
}
await writeFile(path.join(DEST, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(fetched ? `\n${fetched} file(s) downloaded into public/vendor/abi/` : '\nalready current');
