// One reader for every version of the wire: `v` says which, and that
// version's own reader reads it. A new version is a line here.

import type { ShareState } from './state.ts';
import { fromWireV1 } from './v1.ts';
import { fromWireV2 } from './v2.ts';
import { fromWireV3 } from './v3.ts';

/**
 * The state a wire of any version describes, every field given the right
 * shape; `null` for a value that is not a wire at all (not an object).
 *
 * - Total: never throws, whatever `value` is.
 * - Goes by `v`. A wire without one, or with one this reader does not know,
 *   is read as V1, the oldest and the most lenient: a value that is not a
 *   link this reader knows still yields a state a stranger could have sent.
 * - What the values mean is for the caller to decide, with the compilers it
 *   has: an unknown language or standard comes through as written.
 */
export function fromWire(value: unknown): ShareState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = (value as { v?: unknown }).v;
  if (v === 3) return fromWireV3(value);
  if (v === 2) return fromWireV2(value);
  return fromWireV1(value);
}
