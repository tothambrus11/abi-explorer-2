// The URL fragment an ABI Explorer link shares a session in: the session
// state, every version of the wire format it travels as, the envelopes a
// wire travels in, and one reader for all of it.
//
// `encode` and `decode` are what most programs want. The rest is the pieces
// they are made of, for a program that writes an older version, or reads a
// wire it got some other way. Each piece is its own module, and nothing here
// runs on import, so a program that only writes links carries no reader, and
// one that only reads carries no writer; `./encode` and `./decode` are the
// two halves as subpaths.

export type {
  DockLayout,
  ShareBuffer,
  ShareOptions,
  ShareState,
  SourceBuffer,
  ViewMode,
} from './state.ts';
export {
  MAX_BUFFERS,
  MAX_BUFFER_NAME,
  MAX_EXTRA_FLAGS,
  defaultBufferName,
  isDockLayout,
} from './state.ts';
export { encode } from './encode.ts';
export { decode } from './decode.ts';
export type { WireOptions } from './options.ts';
export type { Wire } from './wire.ts';
export { toWireV1, fromWireV1, type WireV1 } from './v1.ts';
export { toWireV2, fromWireV2, type WireV2 } from './v2.ts';
export { toWireV3, fromWireV3, type WireBufferV3, type WireV3 } from './v3.ts';
export { fromWire } from './from-wire.ts';
export {
  encodePlain,
  encodeDeflate,
  decodeFragment,
  canDeflate,
  DEFLATE_PREFIX,
  type Decoded,
} from './envelope.ts';
