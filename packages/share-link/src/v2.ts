// V2: the V1 shape, numbered for the compressed envelope it began travelling
// in. What abiexplorer.org wrote as of September 2026 (origin/main 088c2e0).
// The number was the whole link's, envelope and JSON together; the JSON keys
// did not change, and `ct` was no longer written.

import type { ShareState } from './state.ts';
import { fromWireV1, toWireV1, type WireV1 } from './v1.ts';

/** A V2 wire. */
export interface WireV2 extends Omit<WireV1, 'v' | 'ct'> {
  v: 2;
}

/** The V2 wire for `state`. V2 carries one source: the first buffer; the others are not in it. */
export function toWireV2(state: ShareState): WireV2 {
  const { ct: _ct, ...w } = toWireV1(state);
  return { ...w, v: 2 };
}

/** The state a V2 wire describes, every field given the right shape. */
export function fromWireV2(value: unknown): ShareState {
  return fromWireV1(value);
}
