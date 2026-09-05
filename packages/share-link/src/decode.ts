// A state from a link: whichever envelope, whichever wire. Importing only
// this carries no writer.

import { decodeFragment } from './envelope.ts';
import { fromWire } from './from-wire.ts';
import type { ShareState } from './state.ts';

/**
 * The state a fragment carries, or `null` for anything that is not a link
 * this reader can open. Never throws; a leading `#` is allowed. Every field
 * of the result has the right shape (see `fromWire`); what the values mean
 * is the caller's to decide, with the compilers it has.
 */
export async function decode(fragment: string): Promise<ShareState | null> {
  const read = await decodeFragment(fragment);
  return read ? fromWire(read.value) : null;
}
