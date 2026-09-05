// What a link carries, in the shape every version of the wire agrees on.
//
// A link is a stranger's input, so what comes out of `fromWire` is a state
// whose every field has the right shape; what the values mean (which
// standards a language has, which triple stands for which ABI) is the
// reader's business, and changes with the compilers it ships.

/**
 * How a source's records are shown in its Layout panel: one at a time, the
 * rest as tabs (`'tabs'`), or all of them, one under another (`'stack'`).
 * Not where the panels are; that is `DockLayout`.
 */
export type ViewMode = 'tabs' | 'stack';

/** The options a source is compiled with, as a link carries them. */
export interface ShareOptions {
  /** The language: `'c'`, `'c++'` or `'hylo'` as of V3; any string on the wire. */
  lang: string;
  /** The language standard, in the compiler's own spelling (`'c++20'`, `'gnu23'`). */
  std: string;
  /** The target triple, or the name of an ABI for a language with one. */
  triple: string;
  /** `-fpack-struct=N`; `''` for the default. */
  pack: '' | '1' | '2' | '4' | '8' | '16';
  /** `-mms-bitfields`: lay bit-fields out as MSVC does. */
  msBitfields: boolean;
  /** `-fshort-enums`: an enum is as small as its values allow. */
  shortEnums: boolean;
  /** `-fshort-wchar`: `wchar_t` is 16 bits. */
  shortWchar: boolean;
  /** `-Wpadded`: report every byte of padding as a diagnostic. */
  warnPadded: boolean;
  /** Further compiler flags, space separated, as typed. */
  extraFlags: string;
}

/** One source among several: what an editor tab holds, and how it is compiled. */
export interface SourceBuffer {
  /** The label on its tab; see `MAX_BUFFER_NAME` and `defaultBufferName`. */
  name: string;
  /** The code itself. */
  source: string;
  /** How it is compiled; each buffer has its own. */
  options: ShareOptions;
}

/** A buffer as a link carries it: with the record the reader had picked in it. */
export interface ShareBuffer extends SourceBuffer {
  /** The record shown in the Layout panel in `'tabs'` view, by name; `null` for the last one. */
  selectedRecord: string | null;
}

/**
 * The panel arrangement as the app's dock serializes it. Opaque here: what is
 * in it is the dock's business, and a link only carries it and checks that it
 * has the shape of one.
 */
export type DockLayout = Record<string, unknown>;

/** Everything a link carries: any number of sources, the view, and perhaps the desk. */
export interface ShareState {
  /** The sources, in tab order, each with its own options; never empty. */
  buffers: ShareBuffer[];
  /** How every Layout panel shows its records. One setting, not one per buffer. */
  view: ViewMode;
  /** Where the panels are, when the sharer chose to include it. */
  layout?: DockLayout;
}

/**
 * As many buffers as a link may carry: enough for any session anyone shares,
 * few enough to draw as a row of tabs. `fromWire` keeps the first this many.
 */
export const MAX_BUFFERS = 8;
/** Buffer names are labels on tabs; longer than this is a paragraph, not a name. */
export const MAX_BUFFER_NAME = 40;
/** Extra flags longer than this are not flags; `fromWire` cuts them here. */
export const MAX_EXTRA_FLAGS = 500;

/** What a buffer is called when nobody named it: "Source 1", "Source 2", ... */
export function defaultBufferName(index: number): string {
  return `Source ${String(index + 1)}`;
}

/** Does `value` have the shape of a dock layout, whatever else it holds? */
export function isDockLayout(value: unknown): value is DockLayout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const object = (x: unknown) => typeof x === 'object' && x !== null;
  return object(v['grid']) && object(v['panels']);
}
