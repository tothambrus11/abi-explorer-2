// Browser side of the metered-download gate (issue #1): reads the connection
// hint, the persisted consent and whether the module is already local, then
// asks `needsDownloadConsent`. Kept apart from the pure decision in
// $core/metered so the rules stay testable without a DOM.

import { needsDownloadConsent, type ConnectionHint } from '$core/metered';

const CONSENT_KEY = 'abix-download-consent';

/** Where the module is served from — the same construction the worker uses. */
const BASE = new URL(
  (import.meta.env['VITE_ABI_BASE'] as string | undefined) ?? 'vendor/abi/',
  new URL(import.meta.env.BASE_URL, location.origin),
).href;

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
    /* private mode — consent lasts for this session only */
  }
}

/** What the user is being asked to spend, and where a free copy would be. */
export interface Bundle {
  /**
   * What crosses the connection on a first visit. The build gzips the two big
   * files, so this is well under what lands on disk — and it is the same
   * number the progress bar counts up to, because both read it from here.
   */
  bytes: number;
  /** The files that have to arrive, by their content-addressed URLs. */
  urls: string[];
}

const CACHE_NAME = 'abix-abi-module-v1';

/**
 * The bundle, from the module's own manifest.
 *
 * Not a constant: the sizes change with every release, and a figure quoted in
 * the consent prompt that disagrees with the progress bar behind it is worse
 * than no figure at all — that is exactly how "~11 MB" came to sit in front of
 * a bar counting to 47.
 *
 * Null when the manifest cannot be read, which on a first visit means the
 * download would fail anyway.
 */
async function readBundle(): Promise<Bundle | null> {
  try {
    const url = new URL('manifest.json', BASE).href;
    // Network first, then the copy the worker cached on an earlier visit —
    // the same order the worker uses, so the two agree about which module
    // they are talking about. Offline with everything cached is exactly when
    // this has to keep working: it is the case where the gate should *not*
    // ask.
    let response = await fetch(url, { cache: 'no-cache' }).catch(() => undefined);
    if (!response?.ok) {
      response = await caches.match(url, { cacheName: CACHE_NAME }).catch(() => undefined);
    }
    if (!response?.ok) return null;
    const manifest = (await response.json()) as {
      files?: Record<string, { path?: string; bytes: number; transferBytes?: number }>;
    };
    const big = ['wasm', 'headers']
      .map((key) => manifest.files?.[key])
      .filter((file) => file !== undefined);
    if (big.length === 0) return null;
    return {
      bytes: big.reduce((n, file) => n + (file.transferBytes ?? file.bytes), 0),
      urls: big.map((file) => new URL(file.path ?? '', BASE).href),
    };
  } catch {
    return null; // offline, or no manifest to read
  }
}

let pending: Promise<Bundle | null> | null = null;

/** Memoised: the manifest is read once per page, by whoever asks first. */
export function bundle(): Promise<Bundle | null> {
  return (pending ??= readBundle());
}

/**
 * Is the bundle available without a large download — that is, did an earlier
 * visit already put it in the Cache API?
 *
 * There is no same-origin probe. The module is served from this origin, so a
 * probe would always succeed and the gate would never ask, while the bytes
 * still cross the user's connection. Only a previous visit counts — the worker
 * puts each file in the cache as it finishes it, so even a visit abandoned
 * halfway leaves the first file there.
 */
async function availableLocally(b: Bundle): Promise<boolean> {
  try {
    const found = await Promise.all(
      b.urls.map((url) => caches.match(url, { cacheName: CACHE_NAME })),
    );
    return found.every(Boolean);
  } catch {
    return false; // Cache API unavailable
  }
}

/** Should we ask the user before starting the download? */
export async function shouldAskBeforeDownload(): Promise<boolean> {
  const b = await bundle();
  return needsDownloadConsent({
    connection: connection(),
    consented: hasConsent(),
    availableLocally: b !== null && (await availableLocally(b)),
  });
}
