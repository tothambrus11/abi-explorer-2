// Shareable state <-> URL fragment.
//
// `packages/share-link` does the work: it knows every version of the wire
// format and every envelope, and gives what it reads the right *shape*. What
// the values *mean* is decided here, with the compilers this build has: a
// standard the language does not have becomes its default, a Hylo buffer is
// on Hylo's one ABI whatever triple travelled with it, and so on. A restored
// state is one this app could itself have produced.

import {
  decode,
  encode,
  type ShareOptions,
  type ShareState as WireShareState,
} from '@ambrus-toth/abi-explorer-share-link';
import {
  DEFAULT_OPTIONS,
  HYLO_TRIPLE,
  type CompileOptions,
  type Language,
  standardsFor,
  defaultStdFor,
} from './options';
import { knownTriples } from './targets';

export {
  MAX_BUFFERS,
  MAX_BUFFER_NAME,
  defaultBufferName,
  isDockLayout,
  type DockLayout,
  type ViewMode,
} from '@ambrus-toth/abi-explorer-share-link';

/** One source among several: what an editor tab holds, and how it is compiled. */
export interface SourceBuffer {
  name: string;
  source: string;
  options: CompileOptions;
}

/** A buffer as a link carries it: with the record the reader had picked in it. */
export interface ShareBuffer extends SourceBuffer {
  selectedRecord: string | null;
}

/** What a link carries, with every buffer's options being ones this build can compile for. */
export interface ShareState extends Omit<WireShareState, 'buffers'> {
  /** The sources, in tab order, each with its own options; never empty. */
  buffers: ShareBuffer[];
}

/**
 * One set of options made trustworthy, whatever the link put there.
 *
 * The language is decided first and the rest validated against it: a standard
 * the language does not have becomes its default, and a Hylo buffer is on
 * Hylo's one ABI whatever triple travelled with it.
 */
function toOptions(w: ShareOptions): CompileOptions {
  const lang: Language = w.lang === 'c++' || w.lang === 'hylo' ? w.lang : 'c';
  const stds = standardsFor(lang);
  const std = stds.includes(w.std) ? w.std : defaultStdFor(lang);
  let triple = w.triple || DEFAULT_OPTIONS.triple;
  // Hylo's one ABI is a name, not a triple clang takes: a link saved while a
  // Hylo buffer was active carries it at the top level, and a C buffer
  // falling back to that top level must not be compiled for it.
  if (lang === 'hylo') triple = HYLO_TRIPLE;
  else if (triple === HYLO_TRIPLE) triple = DEFAULT_OPTIONS.triple;
  return {
    lang,
    std,
    triple,
    pack: w.pack,
    msBitfields: w.msBitfields,
    shortEnums: w.shortEnums,
    shortWchar: w.shortWchar,
    warnPadded: w.warnPadded,
    extraFlags: w.extraFlags,
  };
}

/**
 * Encode state to a fragment value (without the leading '#'): the newest wire
 * in the smallest envelope this runtime can write. Every reader understands
 * both envelopes.
 */
export async function encodeShareState(state: ShareState): Promise<string> {
  return encode(state);
}

/**
 * Reads a shared link's fragment back into state.
 *
 * - Total: never throws. An absent, truncated, foreign or corrupt fragment is
 *   `null`, which the caller treats as "no link", because a shared URL is
 *   input from a stranger and half-restoring one is worse than ignoring it.
 * - Reads every envelope and every wire there has been; see the package.
 * - Every buffer's options are ones this build can compile for; see
 *   `toOptions`. A restored state is one this app could itself have produced.
 */
export async function decodeShareState(fragment: string): Promise<ShareState | null> {
  const wire = await decode(fragment);
  if (!wire) return null;
  return { ...wire, buffers: wire.buffers.map((b) => ({ ...b, options: toOptions(b.options) })) };
}

/**
 * Is this one of the triples the selector lists?
 *
 * False does not mean invalid: any triple clang accepts can be typed, and this
 * only decides whether the selector shows it or shows the custom box.
 */
export function isKnownTriple(triple: string): boolean {
  return knownTriples().has(triple);
}
