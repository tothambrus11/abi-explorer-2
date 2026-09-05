// The envelopes a wire travels in, as the fragment of a URL: plain base64url
// (envelope 1), and deflate behind a `2.` prefix (envelope 2), which is
// smaller for anything long. The prefix is what tells a reader to inflate;
// nothing plain can begin with it, since `.` is not base64url.
//
// The envelope's number is not the wire's: a wire of any version travels in
// either. (V1 and V2 wires carried the envelope's number in `v` as well,
// which is why they exist as two versions; see `./v2.ts`.)

import { fromBase64url, toBase64url } from './base64url.ts';
import { deflate, inflate } from './deflate.ts';
import { fromJsonBytes, toJsonBytes } from './json.ts';

export { canDeflate } from './deflate.ts';

/** What envelope 2 begins with. */
export const DEFLATE_PREFIX = '2.';

/** `value` in envelope 1 (a fragment, without the leading `#`). Synchronous: nothing is compressed. */
export function encodePlain(value: unknown): string {
  return toBase64url(toJsonBytes(value));
}

/** `value` in envelope 2 (a fragment, without the leading `#`). Needs `CompressionStream`; see `canDeflate`. */
export async function encodeDeflate(value: unknown): Promise<string> {
  return DEFLATE_PREFIX + toBase64url(await deflate(toJsonBytes(value)));
}

/** What a fragment held: the JSON value, and which envelope it came in. */
export interface Decoded {
  envelope: 1 | 2;
  /** The JSON value, as `JSON.parse` gives it; nothing about it is checked here. */
  value: unknown;
}

/**
 * Reads a fragment in either envelope back into its JSON value.
 *
 * - Total: never throws. An absent, truncated, foreign or corrupt fragment is
 *   `null`, which a caller treats as "no link", because a shared URL is input
 *   from a stranger and half-reading one is worse than ignoring it.
 * - A leading `#` is allowed, so `location.hash` can be passed as it is.
 * - The value is whatever the JSON said; `fromWire` says what it means.
 */
export async function decodeFragment(fragment: string): Promise<Decoded | null> {
  const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!text) return null;
  try {
    if (text.startsWith(DEFLATE_PREFIX)) {
      const bytes = await inflate(fromBase64url(text.slice(DEFLATE_PREFIX.length)));
      return { envelope: 2, value: fromJsonBytes(bytes) };
    }
    return { envelope: 1, value: fromJsonBytes(fromBase64url(text)) };
  } catch {
    return null;
  }
}
