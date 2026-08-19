// Browser side of the metered-download gate (issue #1): reads the connection
// hint, the persisted consent and whether the clang bundle is already local,
// then asks `needsDownloadConsent`. Kept apart from the pure decision in
// $core/metered so the rules stay testable without a DOM.

import { needsDownloadConsent, type ConnectionHint } from '$core/metered';
import { CLANG_CACHE_NAME, CLANG_TARBALL_URL } from '$compiler/clang-assets';

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
 * Is the bundle available without a large download? Either vendored next to the
 * app, or already unpacked into the Cache API by an earlier visit.
 */
async function availableLocally(): Promise<boolean> {
  try {
    if (await caches.match(CLANG_TARBALL_URL, { cacheName: CLANG_CACHE_NAME })) return true;
  } catch {
    /* Cache API unavailable */
  }
  try {
    const res = await fetch(new URL('vendor/clang/llvm.core.wasm', document.baseURI), {
      method: 'GET',
    });
    const ok = res.ok && /wasm|octet-stream/.test(res.headers.get('content-type') ?? '');
    void res.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

/** Should we ask the user before starting the download? */
export async function shouldAskBeforeDownload(): Promise<boolean> {
  return needsDownloadConsent({
    connection: connection(),
    consented: hasConsent(),
    availableLocally: await availableLocally(),
  });
}
