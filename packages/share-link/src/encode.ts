// A link for a state: the newest wire, in the smallest envelope this runtime
// can write. Importing only this carries no reader.

import { canDeflate, encodeDeflate, encodePlain } from './envelope.ts';
import type { ShareState } from './state.ts';
import { toWireV3 } from './v3.ts';

/**
 * The fragment (without the leading `#`) that carries `state`: wire V3, in
 * envelope 2 where `CompressionStream` exists and envelope 1 where it does
 * not (older WebViews). Every reader understands both.
 */
export async function encode(state: ShareState): Promise<string> {
  const wire = toWireV3(state);
  return canDeflate() ? encodeDeflate(wire) : encodePlain(wire);
}
