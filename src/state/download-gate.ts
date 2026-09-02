// Browser side of the metered-download gate (issue #1): reads the connection
// hint, the persisted consent and whether the module is already local, then
// asks `needsDownloadConsent`. Kept apart from the pure decision in
// $core/metered so the rules stay testable without a DOM.

import type { BackendId } from '$compiler/Backends';
import { needsDownloadConsent, type ConnectionHint } from '$core/metered';

const CONSENT_KEY = 'abix-download-consent';

/**
 * Each backend's module: where it is served from, which cache the worker
 * leaves it in, and which of its files are the ones worth asking about.
 *
 * The bases are built the way the workers build them, so the gate and the
 * worker always agree about which module they are talking about.
 */
const BACKENDS: Record<BackendId, { base: string; cache: string; big: string[] }> = {
  clang: {
    base: new URL(
      (import.meta.env['VITE_ABI_BASE'] as string | undefined) ?? 'vendor/abi/',
      new URL(import.meta.env.BASE_URL, location.origin),
    ).href,
    cache: 'abix-abi-module-v1',
    big: ['wasm', 'headers'],
  },
  hylo: {
    base: new URL(
      (import.meta.env['VITE_HYLO_BASE'] as string | undefined) ?? 'vendor/hylo/',
      new URL(import.meta.env.BASE_URL, location.origin),
    ).href,
    cache: 'abix-hylo-module-v1',
    big: ['wasm'],
  },
};

/** `navigator.connection` where implemented (Chromium); undefined elsewhere. */
function connection(): ConnectionHint | undefined {
  return (navigator as Navigator & { connection?: ConnectionHint }).connection;
}

export function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false; // private mode: ask each session rather than assuming consent
  }
}

export function grantConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* private mode: consent lasts for this session only */
  }
}

/** What the user is being asked to spend, and where a free copy would be. */
export interface Bundle {
  /**
   * What crosses the connection on a first visit. The build gzips the two big
   * files, so this is well under what lands on disk, and it is the same
   * number the progress bar counts up to, because both read it from here.
   */
  bytes: number;
  /**
   * The keys those files are cached under, which carry the content's digest:
   * see `cacheKey` in `module-assets`. Probing the plain URL would miss them,
   * and the gate would ask again for a module already on disk.
   */
  urls: string[];
}

/**
 * The bundle, from the module's own manifest.
 *
 * Not a constant: the sizes change with every release, and a figure quoted in
 * the consent prompt that disagrees with the progress bar behind it is worse
 * than no figure at all. That is exactly how "~11 MB" came to sit in front of
 * a bar counting to 47.
 *
 * Null when the manifest cannot be read, which on a first visit means the
 * download would fail anyway.
 */
async function readBundle(id: BackendId): Promise<Bundle | null> {
  const { base, cache, big: keys } = BACKENDS[id];
  try {
    const url = new URL('manifest.json', base).href;
    // Network first, then the copy the worker cached on an earlier visit,
    // the same order the worker uses, so the two agree about which module
    // they are talking about. Offline with everything cached is exactly when
    // this has to keep working: it is the case where the gate should *not*
    // ask.
    let response = await fetch(url, { cache: 'no-cache' }).catch(() => undefined);
    if (!response?.ok) {
      response = await caches.match(url, { cacheName: cache }).catch(() => undefined);
    }
    if (!response?.ok) return null;
    const manifest = (await response.json()) as {
      files?: Record<
        string,
        { path?: string; sha256?: string; bytes: number; transferBytes?: number }
      >;
    };
    // A file the manifest gives no path is one nothing can be looked for: the
    // worker resolves its own name for it, and probing a guess here would ask
    // about a URL that was never cached and re-prompt a visitor who already
    // has the module.
    const big = keys
      .map((key) => manifest.files?.[key])
      .flatMap((file) => (file?.path === undefined ? [] : [{ ...file, path: file.path }]));
    if (big.length === 0) return null;
    return {
      bytes: big.reduce((n, file) => n + (file.transferBytes ?? file.bytes), 0),
      urls: big.map((file) => {
        const url = new URL(file.path, base).href;
        return file.sha256 === undefined ? url : `${url}?sha256=${file.sha256}`;
      }),
    };
  } catch {
    return null; // offline, or no manifest to read
  }
}

const pending = new Map<BackendId, Promise<Bundle | null>>();

/** Memoised per backend: each manifest is read once per page, by whoever asks first. */
export function bundle(id: BackendId): Promise<Bundle | null> {
  let p = pending.get(id);
  if (!p) {
    p = readBundle(id);
    pending.set(id, p);
  }
  return p;
}

/**
 * Is the bundle available without a large download? That is, did an earlier
 * visit already put it in the Cache API?
 *
 * There is no same-origin probe. The module is served from this origin, so a
 * probe would always succeed and the gate would never ask, while the bytes
 * still cross the user's connection. Only a previous visit counts. The worker
 * puts each file in the cache as it finishes it, so even a visit abandoned
 * halfway leaves the first file there.
 */
async function availableLocally(id: BackendId, b: Bundle): Promise<boolean> {
  try {
    const found = await Promise.all(
      b.urls.map((url) => caches.match(url, { cacheName: BACKENDS[id].cache })),
    );
    return found.every(Boolean);
  } catch {
    return false; // Cache API unavailable
  }
}

/**
 * Should we ask the user before starting `id`'s download?
 *
 * Asked per backend, because the answer differs per backend: a visitor who
 * accepted clang's 11 MB on this connection has not thereby accepted Hylo's,
 * and one who has clang cached is still facing a fresh download the first time
 * they select Hylo. Consent, once given, covers both: it is an answer about
 * the connection rather than about a particular file.
 */
export async function shouldAskBeforeDownload(id: BackendId): Promise<boolean> {
  const b = await bundle(id);
  return needsDownloadConsent({
    connection: connection(),
    consented: hasConsent(),
    availableLocally: b !== null && (await availableLocally(id, b)),
  });
}
