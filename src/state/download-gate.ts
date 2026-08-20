// Browser side of the metered-download gate (issue #1): reads the connection
// hint, the persisted consent and whether the module is already local, then
// asks `needsDownloadConsent`. Kept apart from the pure decision in
// $core/metered so the rules stay testable without a DOM.

import { needsDownloadConsent, type ConnectionHint } from '$core/metered';

const CONSENT_KEY = 'abix-download-consent';

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

/**
 * What the user is being asked to spend, and where to look for a copy that
 * costs nothing.
 *
 * The gate has to describe the thing actually being fetched — about 8.4 MB of
 * wasm plus 2.3 MB of headers, gzipped.
 *
 * There is no same-origin probe. The module is served from this origin, so a
 * probe would always succeed and the gate would never ask, while the bytes
 * still cross the user's connection. Only a previous visit having cached it
 * counts as "already here" — the worker puts the files in the Cache API as it
 * streams them, so even a visit abandoned mid-download leaves this true.
 */
interface Bundle {
  bytes: number;
  cache: { url: string; name: string };
}

export function activeBundle(): Bundle {
  return {
    bytes: 11_300_000,
    cache: {
      // The header pack, not the wasm: the build gzips the wasm and gives it
      // a different name, while this one is called the same everywhere.
      url: new URL('vendor/abi/abi_query.data', document.baseURI).href,
      name: 'abix-abi-module-v1',
    },
  };
}

/**
 * Is the bundle available without a large download — that is, did an earlier
 * visit already put it in the Cache API?
 */
async function availableLocally(bundle: Bundle): Promise<boolean> {
  try {
    return Boolean(await caches.match(bundle.cache.url, { cacheName: bundle.cache.name }));
  } catch {
    return false; // Cache API unavailable
  }
}

/** Should we ask the user before starting the download? */
export async function shouldAskBeforeDownload(): Promise<boolean> {
  return needsDownloadConsent({
    connection: connection(),
    consented: hasConsent(),
    availableLocally: await availableLocally(activeBundle()),
  });
}
