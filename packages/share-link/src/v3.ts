// V3: one shape for any number of sources. `bs` holds every buffer with its
// own options and its own selected record, and the top level carries only
// what is no buffer's: the view, and the arrangement when the sharer includes
// it. Nothing is repeated, so a link with one source and a link with eight
// are the same thing at different lengths. Which source is in focus is not in
// it: the arrangement says which tab is in front in each group, and a link
// without one opens on its first source.

import {
  defaultBufferName,
  isDockLayout,
  MAX_BUFFER_NAME,
  MAX_BUFFERS,
  type DockLayout,
  type ShareBuffer,
  type ShareState,
} from './state.ts';
import { optionsFromWire, optionsToWire, type WireOptions } from './options.ts';
import { asObject, asString } from './shape.ts';

/** One buffer as it travels: its name, its source, its options, its selected record. */
export interface WireBufferV3 extends WireOptions {
  n: string;
  s: string;
  r: string | null;
}

/** A V3 wire. */
export interface WireV3 {
  v: 3;
  /** Every buffer, in tab order. */
  bs: WireBufferV3[];
  vw: string;
  /** The panel arrangement, when the sharer included it. */
  ly?: DockLayout;
}

/** The V3 wire for `state`. */
export function toWireV3(state: ShareState): WireV3 {
  const wire: WireV3 = {
    v: 3,
    bs: state.buffers.map((b) => ({
      n: b.name,
      s: b.source,
      ...optionsToWire(b.options),
      r: b.selectedRecord,
    })),
    vw: state.view,
  };
  if (state.layout) wire.ly = state.layout;
  return wire;
}

/** One wire buffer given the right shape, whatever the link put there. */
function bufferFromWire(value: unknown, index: number): ShareBuffer {
  const b = asObject(value);
  const name = asString(b['n']).replace(/\s+/g, ' ').trim().slice(0, MAX_BUFFER_NAME);
  return {
    name: name || defaultBufferName(index),
    source: asString(b['s']),
    options: optionsFromWire(b),
    selectedRecord: typeof b['r'] === 'string' ? b['r'] : null,
  };
}

/**
 * The state a V3 wire describes, every field given the right shape: at most
 * `MAX_BUFFERS` buffers (and one, named by default, when `bs` is missing or
 * empty), a layout only when it has the shape of one. A layout that is not
 * one is dropped, not repaired: a link is the last place to be lenient about
 * structure.
 */
export function fromWireV3(value: unknown): ShareState {
  const w = asObject(value);
  const bs = Array.isArray(w['bs']) ? (w['bs'] as unknown[]) : [];
  const buffers =
    bs.length > 0 ? bs.slice(0, MAX_BUFFERS).map(bufferFromWire) : [bufferFromWire({}, 0)];
  const state: ShareState = { buffers, view: w['vw'] === 'stack' ? 'stack' : 'tabs' };
  if (isDockLayout(w['ly'])) state.layout = w['ly'];
  return state;
}
