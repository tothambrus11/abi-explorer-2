// Fetching a wasm module's files, for whichever backend wants them.
//
// This was the clang worker's, and moved here when a second backend needed the
// same four things: a manifest that says where the content-addressed files
// are, gzip undone where the build applied it, progress counted on the near
// side of that, and a copy left in the Cache API so a second visit costs
// nothing. None of it is specific to clang; only the file names are.
//
// Each backend gets a cache of its own, so selecting one language never
// evicts the other's module.

/** One file the module needs, as the manifest and the loader each name it. */
export interface AssetSpec {
  /** The manifest's key for it. */
  key: string;
  /** What the loader will ask for. */
  name: string;
  /** Whether it is big enough to be worth a progress bar. */
  counted: boolean;
}

/** A file that arrived, with the sizes the manifest promised. */
export interface Asset {
  name: string;
  /** Content-addressed, so it changes on every release. */
  url: string;
  /** Uncompressed length: what the file is once it is here. */
  bytes: number;
  /** What crosses the network, which is less where the build gzipped it. */
  transferBytes: number;
}

interface ManifestFile {
  path?: string;
  bytes: number;
  transferBytes?: number;
}

/**
 * Where the files are, according to the manifest.
 *
 * This is not an optimisation: the build gzips the big files and names every
 * one of them after its content, so guessing a plain name finds nothing. The
 * manifest is the one mutable file in the directory and the only thing that
 * knows the current layout.
 *
 * Network first, our own cache second, deliberately and in that order. It is
 * the only file here that ever changes, so a cached copy preferred over a
 * fresh one would pin a visitor to whichever module they first downloaded,
 * forever; and it is the only file a second visit cannot do without, so a
 * cached copy is what makes the app work offline. The service worker has the
 * same policy, but cannot be relied on for it: a dedicated worker starts
 * alongside the registration, so its fetches on a first visit may go out
 * before anything is controlling them.
 */
export async function resolveAssets(
  base: string,
  specs: readonly AssetSpec[],
  cache: Cache | null,
): Promise<Asset[]> {
  const url = new URL('manifest.json', base).href;
  let response: Response | undefined;
  try {
    const fresh = await fetch(url, { cache: 'no-cache' });
    if (fresh.ok) {
      response = fresh;
      await cache?.put(url, fresh.clone()).catch(() => {});
    }
  } catch {
    // Offline. The copy from last time still describes a module that is here.
  }
  response ??= await cache?.match(url);
  if (!response) throw new Error(`${url} is unreachable and was never cached`);

  const manifest = (await response.json()) as { files?: Record<string, ManifestFile> };
  const assets: Asset[] = [];
  for (const spec of specs) {
    const file = manifest.files?.[spec.key];
    if (file === undefined) continue;
    assets.push({
      name: spec.name,
      url: new URL(file.path ?? spec.name, base).href,
      bytes: file.bytes,
      transferBytes: file.transferBytes ?? file.bytes,
    });
  }
  return assets;
}

/** The Cache API, where there is one. An insecure origin has none. */
export async function openCache(name: string): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  return caches.open(name).catch(() => null);
}

/**
 * A stream over what is left of `reader`, with the already-read `head` put
 * back at the front, counting bytes as they go past.
 *
 * The count happens here, on the near side of any decompression, because the
 * number on screen is meant to be the number the consent gate quoted: what the
 * connection actually spends, not what it expands to.
 */
function restream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array | undefined,
  ended: boolean,
  onBytes: (n: number) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head !== undefined) {
        onBytes(head.byteLength);
        controller.enqueue(head);
      }
      if (ended) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      onBytes(value.byteLength);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Does this start with a gzip member (1f 8b) rather than a wasm module? */
const isGzip = (head: Uint8Array | undefined): boolean =>
  head !== undefined && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

/**
 * Fetch the module's files: decompress what the build compressed, report
 * progress, and leave a copy in the Cache API.
 *
 * A module's own loader would fetch them itself, and clang's did, but from
 * inside that loader, where nothing can see how far along it is, and only
 * *after* a successful boot was there anything to cache. A first visit
 * interrupted halfway left nothing behind, and the loading screen claimed
 * "0% of 0 MB" for the ten seconds it took, because the client had no numbers
 * to report. It also cannot fetch them at all any more: the big files ship
 * gzipped under `.gz` names, and undoing that is this function's job.
 *
 * The cache is best-effort (an insecure origin has no Cache API, a full disk
 * fails the write) but the download is not, so caching failures cost the next
 * visit, not this one.
 */
export async function fetchAssets(
  base: string,
  assets: readonly Asset[],
  counted: (name: string) => boolean,
  cache: Cache | null,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, Blob>> {
  let total = assets.filter((a) => counted(a.name)).reduce((n, a) => n + a.transferBytes, 0);
  let done = 0;

  const bodies = new Map<string, Blob>();
  for (const asset of assets) {
    // Cached decompressed, under the content-addressed URL it came from: the
    // work of undoing gzip is done once, and a new release cannot collide with
    // an old one because no two versions share a name.
    let body = cache ? await cache.match(asset.url) : undefined;
    if (body) {
      if (counted(asset.name)) {
        done += asset.transferBytes;
        onProgress(done, total);
      }
    } else {
      const network = await fetch(asset.url);
      if (!network.ok || !network.body) {
        throw new Error(`${asset.url} -> ${String(network.status)} ${network.statusText}`);
      }
      const reader = network.body.getReader();

      // Whether the bytes arrive compressed is not ours to decide. A static
      // host that recognises `.gz` sets `Content-Encoding: gzip` and the
      // browser has already undone it by the time we see a byte, while one
      // that does not hands over the gzip stream; Vite's preview server does
      // the former and Cloudflare does the latter. So neither a header nor a
      // manifest flag is the authority. The first two bytes are.
      const first = await reader.read();
      const head = first.done ? undefined : first.value;
      const gzipped = isGzip(head);
      // Undone in transit: then what crosses the wire is not `transferBytes`,
      // and the total has to say so before the first tick is reported.
      if (counted(asset.name) && !gzipped) total += asset.bytes - asset.transferBytes;

      const wire = restream(reader, head, first.done, (n) => {
        if (!counted(asset.name)) return;
        done += n;
        onProgress(done, total);
      });
      // DecompressionStream is typed as taking BufferSource while a body
      // stream yields Uint8Array; the two are the same bytes and lib.dom does
      // not say so.
      const bytes = gzipped
        ? (wire as unknown as ReadableStream<BufferSource>).pipeThrough(
            new DecompressionStream('gzip'),
          )
        : wire;

      const chunks: Uint8Array[] = [];
      const out = bytes.getReader();
      for (;;) {
        const { done: finished, value } = await out.read();
        if (finished) break;
        chunks.push(value);
      }
      body = new Response(new Blob(chunks as BlobPart[]));
      await cache?.put(asset.url, body.clone()).catch(() => {});
    }
    bodies.set(asset.name, await body.blob());
  }

  // Nothing here is named after a version, so an upgrade would otherwise leave
  // the whole previous module cached forever.
  if (cache) {
    const keep = new Set([new URL('manifest.json', base).href, ...assets.map((a) => a.url)]);
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) await cache.delete(request);
    }
  }
  return bodies;
}
