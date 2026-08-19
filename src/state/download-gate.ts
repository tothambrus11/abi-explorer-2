// Browser side of the metered-download gate (issue #1): reads the connection
// hint, the persisted consent and whether the clang bundle is already local,
// then asks `needsDownloadConsent`. Kept apart from the pure decision in
// $core/metered so the rules stay testable without a DOM.

import { CLANG_DOWNLOAD_BYTES, needsDownloadConsent, type ConnectionHint } from '$core/metered';
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
 * Which bundle this build downloads, and where to look for a local copy.
 *
 * The gate has to describe the thing actually being fetched. Asking about
 * 27 MB of clang driver while the page is about to pull an 11 MB layout module
 * is not a rounding error — it is the wrong question, and it probes a path that
 * is not there, which shows up as a failed request on every offline load.
 */
interface Bundle {
  /** Roughly what the user is being asked to spend, compressed. */
  bytes: number;
  /**
   * A file whose presence means the bundle ships *with* the app and costs no
   * separate download. Absent where the bundle is served from our own origin
   * but still fetched — being same-origin makes it no cheaper on a metered
   * link, and treating it as "already here" would silence the gate entirely.
   */
  probe?: string;
  /** Cached entry that means the same, checked first because it needs no fetch. */
  cache?: { url: string; name: string };
}

const CLANG_DRIVER_BUNDLE: Bundle = {
  bytes: CLANG_DOWNLOAD_BYTES,
  probe: 'vendor/clang/llvm.core.wasm',
  cache: { url: CLANG_TARBALL_URL, name: CLANG_CACHE_NAME },
};

/**
 * clang-abi-wasm: ~8.4 MB of wasm plus ~2.3 MB of headers, gzipped.
 *
 * No probe. The module is served from this origin, so a probe would always
 * succeed and the gate would never ask — but the bytes still cross the user's
 * connection. Only a previous visit having cached it counts as "already here",
 * which is what the worker's cache warm records.
 */
const ABI_MODULE_BUNDLE: Bundle = {
  bytes: 11_300_000,
  cache: {
    url: new URL('vendor/abi/abi_query.wasm', document.baseURI).href,
    name: 'abix-abi-module-v1',
  },
};

export function activeBundle(): Bundle {
  return import.meta.env['VITE_ABI'] === '1' ? ABI_MODULE_BUNDLE : CLANG_DRIVER_BUNDLE;
}

/**
 * Is the bundle available without a large download? Either vendored next to the
 * app, or already cached by an earlier visit.
 */
async function availableLocally(bundle: Bundle): Promise<boolean> {
  if (bundle.cache) {
    try {
      if (await caches.match(bundle.cache.url, { cacheName: bundle.cache.name })) return true;
    } catch {
      /* Cache API unavailable */
    }
  }
  if (!bundle.probe) return false;
  try {
    const res = await fetch(new URL(bundle.probe, document.baseURI), { method: 'GET' });
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
    availableLocally: await availableLocally(activeBundle()),
  });
}
