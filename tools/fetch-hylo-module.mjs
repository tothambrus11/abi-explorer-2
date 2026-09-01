// Fetches a hylo-abi-wasm release into public/vendor/hylo/, which is what the
// deployed site serves for the Hylo language.
//
//   node tools/fetch-hylo-module.mjs            # the pinned version
//   node tools/fetch-hylo-module.mjs v0.1.0     # a specific release
//
// Unlike the clang module, this one is optional: a site with no Hylo module
// still answers every C and C++ question, and offers Hylo as a language that
// has no compiler here rather than one that fails when selected. So a missing
// release is a warning, not a failed build. `vite.config.ts` reads the
// manifest this leaves behind to decide which of the two the UI should show.
//
// Development uses a symlink instead, so a rebuild of the module shows up here
// on reload; this leaves the link alone.
//
// Idempotent: the manifest records a sha256 per file, so a second run verifies
// what is already on disk and downloads nothing.

/* eslint-disable no-console -- a CLI: its output is the interface */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEST = path.join(ROOT, 'public', 'vendor', 'hylo');
const REPO = process.env['HYLO_MODULE_REPO'] ?? 'tothambrus11/hylo-abi-wasm';

/** Pinned here rather than floating: the site's layouts must not change on a whim. */
const DEFAULT_VERSION = 'v0.1.0';

const version = process.argv[2] ?? process.env['HYLO_MODULE_VERSION'] ?? DEFAULT_VERSION;
const base =
  process.env['HYLO_MODULE_BASE'] ?? `https://github.com/${REPO}/releases/download/${version}/`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(DEST) && (await lstat(DEST)).isSymbolicLink()) {
  console.log('public/vendor/hylo is a symlink to a local build, so leaving it alone.');
  process.exit(0);
}

async function get(name) {
  const url = new URL(name, base).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${String(res.status)} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upToDate(file, expected) {
  const target = path.join(DEST, file);
  if (!existsSync(target)) return false;
  return sha256(await readFile(target)) === expected;
}

let manifestBody;
try {
  manifestBody = await get('manifest.json');
} catch (e) {
  if (existsSync(path.join(DEST, 'hylo_layout.wasm'))) {
    console.warn(`could not reach ${base}, keeping the module already in ${DEST}`);
    process.exit(0);
  }
  console.warn(`no Hylo module: ${e.message.split('\n')[0]}`);
  console.warn(`  The site will build without it and offer Hylo as unsupported.`);
  console.warn(`  Publish a hylo-abi-wasm release, or point HYLO_MODULE_BASE at a local one.`);
  process.exit(0);
}
const manifest = JSON.parse(manifestBody.toString());
console.log(`hylo-abi-wasm ${manifest.version}`);

await mkdir(DEST, { recursive: true });

// The worker resolves these through the manifest, but under the plain names
// the fetch writes here, so a local directory and a release differ only in how
// the files are named.
const LOCAL_NAME = { wasm: 'hylo_layout.wasm', stdlib: 'hylo_stdlib.json' };

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
    throw new Error(`${entry.path}: sha256 mismatch\n  expected ${entry.sha256}\n  got      ${got}`);
  }
  await writeFile(path.join(DEST, name), body);
  console.log(`  fetched   ${name}  (${(body.length / 1048576).toFixed(1)} MB)`);
  fetched++;
}

// The manifest is written with the paths *this* directory uses, not the ones
// the release used: `load()` resolves the files through it, so a manifest still
// naming `hylo_layout-ffae9dcb1d28.wasm` next to a file called
// `hylo_layout.wasm` is a 404 with a plausible-looking cause.
const local = { ...manifest, files: { ...manifest.files } };
for (const [key, entry] of Object.entries(local.files)) {
  if (LOCAL_NAME[key]) local.files[key] = { ...entry, path: LOCAL_NAME[key] };
}
await writeFile(path.join(DEST, 'manifest.json'), JSON.stringify(local, null, 2));

console.log(fetched ? `\n${fetched} file(s) downloaded into public/vendor/hylo/` : '\nalready current');
