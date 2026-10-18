// Getting the engine onto disk.
//
// The engine is three files from one clang-abi-wasm release, about 11 MB
// compressed and 48 MB on disk. They are not bundled with any editor plugin:
// the first analysis downloads them into a cache shared by every editor on the
// machine, verified against hashes pinned here rather than against a manifest
// fetched from the same place as the files.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type EngineFileName = 'abi_query.mjs' | 'abi_query.wasm' | 'abi_query.data';

interface PinnedFile {
  name: EngineFileName;
  sha256: string;
  bytes: number;
}

/** The release this server was tested against. */
export const ENGINE_RELEASE = {
  tag: 'v0.1.0',
  clangMajor: 22,
  baseUrl: 'https://github.com/tothambrus11/clang-abi-wasm/releases/download/v0.1.0/',
  files: [
    {
      name: 'abi_query.mjs',
      sha256: '2459f7a193786bf07d173ecda9400e345a359f84b7d4233fb6f3847e52af7976',
      bytes: 317_681,
    },
    {
      name: 'abi_query.wasm',
      sha256: '1766b05acad6a8a26ecb4c48120692ca1f8fb6b6935063a29822020ab8773c59',
      bytes: 29_224_771,
    },
    {
      name: 'abi_query.data',
      sha256: '95122c0f5c56d7c61efad5782a481c5100b9d18e31a4d206b760d8d34d8f3407',
      bytes: 20_119_812,
    },
  ] satisfies PinnedFile[],
} as const;

/** Absolute paths of the three files, ready to load. */
export type EngineFiles = Readonly<Record<EngineFileName, string>>;

export interface DownloadProgress {
  doneBytes: number;
  totalBytes: number;
}

export interface EngineLocation {
  /** A directory holding the three files under their plain names, used as is. */
  localDirectory?: string | undefined;
  /** Where downloads go. The release tag is appended. */
  cacheDirectory: string;
}

/**
 * The engine files, downloading whatever is missing or does not match its hash.
 *
 * `fetchImpl` exists for tests; production uses the global `fetch`, which
 * honours no proxy settings on its own but is what Node offers without
 * dependencies.
 */
export async function ensureEngineFiles(
  location: EngineLocation,
  onProgress: (progress: DownloadProgress) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<EngineFiles> {
  if (location.localDirectory) {
    return filesIn(location.localDirectory);
  }
  const directory = path.join(location.cacheDirectory, `clang-abi-wasm-${ENGINE_RELEASE.tag}`);
  fs.mkdirSync(directory, { recursive: true });

  const missing = ENGINE_RELEASE.files.filter(
    (file) => !hasExpectedHash(path.join(directory, file.name), file.sha256),
  );
  const totalBytes = missing.reduce((sum, file) => sum + file.bytes, 0);
  let doneBytes = 0;
  for (const file of missing) {
    const body = await download(new URL(file.name, ENGINE_RELEASE.baseUrl), fetchImpl, (n) => {
      onProgress({ doneBytes: doneBytes + n, totalBytes });
    });
    if (sha256(body) !== file.sha256) {
      throw new Error(`${file.name} from ${ENGINE_RELEASE.baseUrl} does not match its pinned hash`);
    }
    // Written beside the target and renamed, so a cancelled download never
    // leaves a truncated file that a later check would have to hash to reject.
    const target = path.join(directory, file.name);
    fs.writeFileSync(target + '.partial', body);
    fs.renameSync(target + '.partial', target);
    doneBytes += file.bytes;
  }
  return filesIn(directory);
}

function filesIn(directory: string): EngineFiles {
  return {
    'abi_query.mjs': path.join(directory, 'abi_query.mjs'),
    'abi_query.wasm': path.join(directory, 'abi_query.wasm'),
    'abi_query.data': path.join(directory, 'abi_query.data'),
  };
}

function hasExpectedHash(file: string, expected: string): boolean {
  return fs.existsSync(file) && sha256(fs.readFileSync(file)) === expected;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function download(
  url: URL,
  fetchImpl: typeof fetch,
  onBytes: (received: number) => void,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`could not download ${url.href}: ${response.status} ${response.statusText}`);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.byteLength;
    onBytes(received);
  }
  return Buffer.concat(chunks);
}
