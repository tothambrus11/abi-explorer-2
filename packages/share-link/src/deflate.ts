// Raw deflate, each way. A fragment holds source code, which compresses to a
// fraction of itself.

/** Whether this runtime can compress at all; older WebViews cannot. */
export function canDeflate(): boolean {
  return typeof CompressionStream !== 'undefined';
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The inverse of `deflate`. Rejects on anything that is not a deflate stream. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
