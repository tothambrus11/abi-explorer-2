// Gzips the wasm in the built site, and tells the manifest it did.
//
// The module is 27.9 MiB and static hosts put a ceiling on a single asset —
// Cloudflare Pages, where this deploys, refuses anything over 25 MiB. The file
// compresses to 8.5 MiB, so the fix is to ship it compressed and decompress it
// in the worker, which already fetches it by hand to report progress.
//
// Not `Content-Encoding: gzip`: that would need the host to serve a header we
// do not control from a static directory, and would silently serve garbage
// wherever it did not. The compression is part of the file, the manifest says
// so, and the loader acts on what the manifest says.
//
// Only the wasm. The header pack is 19.2 MiB, under every limit worth naming,
// and leaving it alone keeps the change to the one file that needs it.

/* eslint-disable no-console -- a build step: its output is the interface */
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.join(new URL('..', import.meta.url).pathname, 'dist', 'vendor', 'abi');
const WASM = path.join(DIST, 'abi_query.wasm');
const MANIFEST = path.join(DIST, 'manifest.json');

if (!existsSync(WASM)) {
  console.error(`no module in ${DIST} — run \`npm run abi:fetch\` before building`);
  process.exit(1);
}

const raw = await readFile(WASM);
const gz = gzipSync(raw, { level: 9 });
await writeFile(WASM + '.gz', gz);
await rm(WASM);

// The manifest is how the worker finds the file and knows what it is. Its
// `bytes` stays the uncompressed length: that is what the progress bar counts
// against, because that is what comes out of the decompressor.
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
manifest.files.wasm = {
  ...manifest.files.wasm,
  path: 'abi_query.wasm.gz',
  encoding: 'gzip',
  bytes: raw.length,
  transferBytes: gz.length,
};
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`abi_query.wasm  ${mb(raw.length)} MiB -> abi_query.wasm.gz  ${mb(gz.length)} MiB`);
