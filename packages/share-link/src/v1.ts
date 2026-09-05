// V1: one source and its options at the top level, in the plain envelope.
// What abiexplorer.org wrote where it could not compress, and what the app
// before it wrote always. That older app spelled a triple typed into the
// custom box as `t: '__custom__'` with the triple itself in `ct`.

import { defaultBufferName, type ShareState } from './state.ts';
import { optionsFromWire, optionsToWire, type WireOptions } from './options.ts';
import { asObject, asString } from './shape.ts';

/** A V1 wire. */
export interface WireV1 extends WireOptions {
  v: 1;
  /** The one source. */
  s: string;
  /** Its selected record. */
  r: string | null;
  vw: string;
  /** An older writer's custom triple, when `t` is `'__custom__'`. Read, never written. */
  ct?: string;
  /** An older writer's wasi-libc toggle. Ignored. */
  wl?: number;
}

/** The V1 wire for `state`. V1 carries one source: the first buffer; the others are not in it. */
export function toWireV1(state: ShareState): WireV1 {
  const b = state.buffers[0];
  if (!b) throw new Error('a state has at least one buffer');
  return { v: 1, s: b.source, ...optionsToWire(b.options), r: b.selectedRecord, vw: state.view };
}

/** The state a V1 wire describes, every field given the right shape. */
export function fromWireV1(value: unknown): ShareState {
  const w = asObject(value);
  const t = asString(w['t']);
  const options = optionsFromWire(t === '__custom__' ? { ...w, t: asString(w['ct']).trim() } : w);
  return {
    buffers: [
      {
        name: defaultBufferName(0),
        source: asString(w['s']),
        options,
        selectedRecord: typeof w['r'] === 'string' ? w['r'] : null,
      },
    ],
    view: w['vw'] === 'stack' ? 'stack' : 'tabs',
  };
}
