// How a module's files are found again, and when they are not.
//
// The bug this pins: a build names every file after its content, so an update
// is a URL nothing has cached. A checkout does not — `npm run abi:fetch` writes
// `abi_query.wasm`, and a rebuilt module replaces the bytes at a URL that never
// changes. Cached under the URL alone, the first module a developer loaded was
// the one they kept, through every release and rebuild after it: the manifest
// said the module had changed and the cache went on answering with the old one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAssets, resolveAssets, type Asset, type AssetSpec } from '$compiler/module-assets';

const BASE = 'https://example.test/vendor/abi/';
const SPECS: AssetSpec[] = [{ key: 'wasm', name: 'abi_query.wasm', counted: true }];

/** Enough of the Cache API to say what was stored and what was found. */
class FakeCache {
  readonly entries = new Map<string, string>();

  match(key: string): Promise<Response | undefined> {
    const body = this.entries.get(key);
    return Promise.resolve(body === undefined ? undefined : new Response(body));
  }
  async put(key: string, response: Response): Promise<void> {
    this.entries.set(key, await response.text());
  }
  keys(): Promise<{ url: string }[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => ({ url })));
  }
  // The real one is handed the Request that `keys()` returned, not a string.
  delete(request: { url: string } | string): Promise<boolean> {
    return Promise.resolve(
      this.entries.delete(typeof request === 'string' ? request : request.url),
    );
  }
}

const cacheOf = (c: FakeCache) => c as unknown as Cache;

/** A manifest naming one file, with the digest a release records for it. */
const manifest = (sha256: string, path = 'abi_query.wasm') => ({
  files: { wasm: { path, sha256, bytes: 4, transferBytes: 4 } },
});

function serve(bodies: Record<string, string>, seen: string[]) {
  return vi.fn((input: string) => {
    const url = input;
    seen.push(url);
    const body = bodies[url];
    if (body === undefined) return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

beforeEach(() => {
  vi.stubGlobal('DecompressionStream', undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAssets', () => {
  it('carries the digest the manifest records', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      serve({ [`${BASE}manifest.json`]: JSON.stringify(manifest('abc123')) }, seen),
    );
    const [asset] = await resolveAssets(BASE, SPECS, null);
    expect(asset?.url).toBe(`${BASE}abi_query.wasm`);
    expect(asset?.sha256).toBe('abc123');
  });
});

describe('fetchAssets', () => {
  const asset = (sha256?: string): Asset => ({
    name: 'abi_query.wasm',
    url: `${BASE}abi_query.wasm`,
    ...(sha256 === undefined ? {} : { sha256 }),
    bytes: 4,
    transferBytes: 4,
  });

  it('reuses what it has when the content has not changed', async () => {
    const cache = new FakeCache();
    const seen: string[] = [];
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'old!' }, seen));

    await fetchAssets(BASE, [asset('old-digest')], () => true, cacheOf(cache), () => {});
    expect(seen).toHaveLength(1);

    // A second visit to the same module asks for nothing.
    await fetchAssets(BASE, [asset('old-digest')], () => true, cacheOf(cache), () => {});
    expect(seen, 'the second visit is free').toHaveLength(1);
  });

  it('fetches again when the content changed under an unchanged name', async () => {
    const cache = new FakeCache();
    const seen: string[] = [];
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'old!' }, seen));
    await fetchAssets(BASE, [asset('old-digest')], () => true, cacheOf(cache), () => {});

    // The rebuild: same URL, different bytes, which the manifest reports as a
    // different digest. Under a URL-only key this served `old!` forever.
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'new!' }, seen));
    const files = await fetchAssets(
      BASE,
      [asset('new-digest')],
      () => true,
      cacheOf(cache),
      () => {},
    );
    expect(seen, 'it went and got the new one').toHaveLength(2);
    expect(await files.get('abi_query.wasm')!.text()).toBe('new!');
  });

  it('lets go of the copy it replaced', async () => {
    const cache = new FakeCache();
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'old!' }, []));
    await fetchAssets(BASE, [asset('old-digest')], () => true, cacheOf(cache), () => {});
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'new!' }, []));
    await fetchAssets(BASE, [asset('new-digest')], () => true, cacheOf(cache), () => {});

    // Otherwise every rebuild leaves another copy in the storage quota.
    expect([...cache.entries.keys()]).toEqual([`${BASE}abi_query.wasm?sha256=new-digest`]);
  });

  it('still works for a manifest that records no digest', async () => {
    const cache = new FakeCache();
    const seen: string[] = [];
    vi.stubGlobal('fetch', serve({ [`${BASE}abi_query.wasm`]: 'bytes' }, seen));
    const files = await fetchAssets(BASE, [asset()], () => true, cacheOf(cache), () => {});
    expect(await files.get('abi_query.wasm')!.text()).toBe('bytes');
    expect([...cache.entries.keys()]).toEqual([`${BASE}abi_query.wasm`]);
  });
});
