// Prepares the built site's copy of the module for a static host: gzips the
// big files and names every one of them after its content.
//
// Compression, for two reasons, and the second is the one users feel:
//
//  - A ceiling. The wasm is 27.9 MiB and static hosts cap a single asset —
//    Cloudflare Pages, where this deploys, refuses anything over 25 MiB.
//  - The download. The header pack is 19.2 MiB of text that gzips 8.4x, and it
//    was shipping raw: two thirds of a first visit's cost, for nothing.
//
// Together those take a first visit from 47 MB to about 11 MB.
//
// Not `Content-Encoding: gzip`: that would need the host to serve a header we
// do not control from a static directory, and would silently serve garbage
// wherever it did not. The compression is part of the file, the manifest says
// so, and the loader acts on what the manifest says.
//
// Content-addressing, because the alternative does not work. This directory is
// cached `CacheFirst` by the service worker and served `immutable` by the host,
// so a *new* module published under an old name is one nobody will ever fetch
// again: every returning visitor keeps the copy they already have, forever.
// Under a content-addressed name an update is simply a URL nothing has cached.
// `manifest.json` is the one mutable file, and every loader resolves through it.
//
// Only in `dist/`. `public/vendor/abi/` keeps the plain names, because the
// package's own `load()` resolves siblings by name from a filesystem directory
// where there is no manifest to fetch — that is what the unit tests use.

/* eslint-disable no-console -- a build step: its output is the interface */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.join(new URL('..', import.meta.url).pathname, 'dist', 'vendor', 'abi');
const MANIFEST = path.join(DIST, 'manifest.json');

/** The glue is 310 kB and is fetched before there is a progress bar to show. */
const COMPRESS = new Set(['wasm', 'headers']);

if (!existsSync(MANIFEST)) {
  console.error(`no module in ${DIST} — run \`npm run abi:fetch\` before building`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const mb = (n) => (n / 1048576).toFixed(1);
let before = 0;
let after = 0;

for (const [key, entry] of Object.entries(manifest.files ?? {})) {
  const source = path.join(DIST, entry.path);
  if (!existsSync(source)) {
    console.error(`${entry.path} is in the manifest but not in ${DIST}`);
    process.exit(1);
  }

  const raw = await readFile(source);
  const body = COMPRESS.has(key) ? gzipSync(raw, { level: 9 }) : raw;
  // Named after what is served, so a re-compression that changes a byte gets a
  // new URL. The extension is kept: hosts pick a content type from it, and
  // `.gz` is what tells a host not to compress it a second time.
  const stamp = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const ext = path.extname(entry.path);
  const name = `${path.basename(entry.path, ext)}-${stamp}${ext}${COMPRESS.has(key) ? '.gz' : ''}`;

  await writeFile(path.join(DIST, name), body);
  await rm(source);

  // `bytes` stays the uncompressed length — that is what the file is once it
  // is here, and what has to be read back out of the cache. `transferBytes` is
  // what the connection spends, which is the number the progress bar counts
  // and the consent gate quotes.
  manifest.files[key] = {
    ...entry,
    path: name,
    ...(COMPRESS.has(key) ? { encoding: 'gzip' } : {}),
    bytes: raw.length,
    transferBytes: body.length,
  };

  if (COMPRESS.has(key)) {
    before += raw.length;
    after += body.length;
  }
  console.log(`  ${entry.path}  ->  ${name}  (${mb(body.length)} MiB)`);
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`first visit: ${mb(before)} MiB -> ${mb(after)} MiB`);
