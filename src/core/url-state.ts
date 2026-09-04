// Shareable state <-> URL fragment.
//
// v1 (legacy): base64url(JSON) with short keys.
// v2: "2." + base64url(deflate-raw(JSON)), same keys but compressed, so long
// sources still fit comfortably in a URL.
//
// A session with several sources adds `bs` (every buffer, the active one
// included) and `bi` (which of them is active), while `s` and `l` go on
// carrying the active buffer's source and language. The repetition is
// deliberate: a decoder from before `bs` existed reads `s`/`l` and opens on
// the buffer that was on screen, and deflate reduces the repeated source to a
// back-reference, so the link pays almost nothing for it.

import {
  DEFAULT_OPTIONS,
  type CompileOptions,
  type Language,
  standardsFor,
  defaultStdFor,
} from './options';
import { knownTriples } from './targets';

export type ViewMode = 'tabs' | 'stack';

/** One source among several: what an editor tab holds. */
export interface SourceBuffer {
  name: string;
  lang: Language;
  source: string;
}

/**
 * As many buffers as a link may carry (and the app may hold): enough for any
 * session anyone shares, few enough to draw as a row of tabs.
 */
export const MAX_BUFFERS = 8;
/** Buffer names are labels on tabs; longer than this is a paragraph, not a name. */
const MAX_BUFFER_NAME = 40;

/** What a buffer is called when nobody named it: "Source 1", "Source 2", … */
export function defaultBufferName(index: number): string {
  return `Source ${String(index + 1)}`;
}

export interface ShareState {
  /** The sources, in tab order; never empty. */
  buffers: SourceBuffer[];
  /** Which buffer is on screen and compiled; `options.lang` is its language. */
  active: number;
  options: CompileOptions;
  selectedRecord: string | null;
  view: ViewMode;
}

interface Wire {
  v: number;
  s: string;
  l: string;
  std: string;
  t: string;
  ct?: string;
  p: string;
  mb: number;
  se: number;
  sw: number;
  /** v2 only: the wasi-libc header toggle, which no longer exists. */
  wl?: number;
  wp: number;
  x: string;
  r: string | null;
  vw?: string;
  /** v2 only, multi-buffer: every buffer, active included; `s`/`l` repeat the active one. */
  bs?: { n?: string; l?: string; s?: string }[];
  /** v2 only: which of `bs` is on screen. */
  bi?: number;
}

/**
 * The share state in its compact wire form, at the current version.
 *
 * Short keys because the result is compressed and base64'd into a fragment,
 * where every byte is a character of the link. Reading is version-aware; this
 * only ever writes the newest.
 */
function toWire(state: ShareState): Wire {
  const o = state.options;
  const active = state.buffers[state.active] ?? state.buffers[0];
  const wire: Wire = {
    v: 2,
    s: active?.source ?? '',
    l: active?.lang ?? o.lang,
    std: o.std,
    t: o.triple,
    p: o.pack,
    mb: +o.msBitfields,
    se: +o.shortEnums,
    sw: +o.shortWchar,
    wp: +o.warnPadded,
    x: o.extraFlags,
    r: state.selectedRecord,
    vw: state.view,
  };
  // A single unnamed buffer is what every link used to carry, and it still
  // travels as bare `s`/`l`: the fields exist either way, and a link that says
  // no more than it has to reads the same everywhere.
  if (state.buffers.length > 1) {
    wire.bs = state.buffers.map((b) => ({ n: b.name, l: b.lang, s: b.source }));
    wire.bi = Math.min(Math.max(state.active, 0), state.buffers.length - 1);
  }
  return wire;
}

/** One wire buffer made trustworthy, whatever the link put there. */
function toBuffer(raw: unknown, index: number): SourceBuffer {
  const b = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const name =
    typeof b['n'] === 'string' ? b['n'].replace(/\s+/g, ' ').trim().slice(0, MAX_BUFFER_NAME) : '';
  return {
    name: name || defaultBufferName(index),
    lang: b['l'] === 'c++' || b['l'] === 'hylo' ? b['l'] : 'c',
    source: typeof b['s'] === 'string' ? b['s'] : '',
  };
}

/** Coerce untrusted wire data into a valid ShareState (unknown values fall back to defaults). */
function fromWire(w: Partial<Wire>): ShareState {
  // The buffers: `bs` where the link carries several, else the single `s`/`l`
  // pair every link has carried since v1. `bs` wins where both exist — `s`/`l`
  // are its own active entry repeated for decoders older than it.
  let buffers: SourceBuffer[];
  let active: number;
  if (Array.isArray(w.bs) && w.bs.length > 0) {
    buffers = w.bs.slice(0, MAX_BUFFERS).map(toBuffer);
    active =
      typeof w.bi === 'number' && Number.isInteger(w.bi) && w.bi >= 0 && w.bi < buffers.length
        ? w.bi
        : 0;
  } else {
    buffers = [
      {
        name: defaultBufferName(0),
        lang: w.l === 'c++' || w.l === 'hylo' ? w.l : 'c',
        source: typeof w.s === 'string' ? w.s : '',
      },
    ];
    active = 0;
  }
  // The active buffer's language is *the* language: the standard is validated
  // against it, and the restored options must describe the buffer on screen.
  const lang = buffers[active]!.lang;
  const stds = standardsFor(lang);
  const std = typeof w.std === 'string' && stds.includes(w.std) ? w.std : defaultStdFor(lang);
  // Legacy v1 stored '__custom__' + ct for custom triples; v2 stores the triple itself.
  let triple = typeof w.t === 'string' ? w.t : DEFAULT_OPTIONS.triple;
  if (triple === '__custom__') {
    triple = typeof w.ct === 'string' && w.ct.trim() ? w.ct.trim() : DEFAULT_OPTIONS.triple;
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(triple)) triple = DEFAULT_OPTIONS.triple;
  const packs = new Set(['', '1', '2', '4', '8', '16']);
  const options: CompileOptions = {
    lang,
    std,
    triple,
    pack: (typeof w.p === 'string' && packs.has(w.p) ? w.p : '') as CompileOptions['pack'],
    msBitfields: !!w.mb,
    shortEnums: !!w.se,
    shortWchar: !!w.sw,
    warnPadded: !!w.wp,
    extraFlags: typeof w.x === 'string' ? w.x.slice(0, 500) : '',
  };
  return {
    buffers,
    active,
    options,
    selectedRecord: typeof w.r === 'string' ? w.r : null,
    view: w.vw === 'stack' ? 'stack' : 'tabs',
  };
}

/** base64url: base64 with the URL-safe alphabet and no padding, so a link stays a link. */
const b64url = {
  /** Chunked, because spreading a megabyte into `fromCharCode` overflows the stack. */
  encode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  /** Throws on text that is not base64url; callers treat that as a link they cannot read. */
  decode(text: string): Uint8Array {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  },
};

/** Raw deflate; the fragment holds the source, which compresses to a fraction of itself. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The inverse of `deflate`. Rejects on anything that is not a deflate stream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode state to a fragment value (without the leading '#'). Falls back to
 * the uncompressed v1 wire format where CompressionStream is unavailable
 * (older WebViews). Every decoder understands both.
 */
export async function encodeShareState(state: ShareState): Promise<string> {
  const wire = toWire(state);
  if (typeof CompressionStream === 'undefined') {
    return b64url.encode(new TextEncoder().encode(JSON.stringify({ ...wire, v: 1 })));
  }
  const json = new TextEncoder().encode(JSON.stringify(wire));
  return '2.' + b64url.encode(await deflate(json));
}

/**
 * Reads a shared link's fragment back into state.
 *
 * - Total: never throws. An absent, truncated, foreign or corrupt fragment is
 *   `null`, which the caller treats as "no link", because a shared URL is
 *   input from a stranger and half-restoring one is worse than ignoring it.
 * - Accepts both encodings: `2.`-prefixed deflate, and the earlier plain
 *   base64, so links shared before compression still open.
 * - Every field is validated on the way in; see `fromWire`. A restored state is
 *   one this app could itself have produced.
 */
export async function decodeShareState(fragment: string): Promise<ShareState | null> {
  const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!text) return null;
  try {
    let jsonBytes: Uint8Array;
    if (text.startsWith('2.')) jsonBytes = await inflate(b64url.decode(text.slice(2)));
    else jsonBytes = b64url.decode(text); // v1
    const data = JSON.parse(new TextDecoder().decode(jsonBytes)) as Partial<Wire>;
    return fromWire(data);
  } catch {
    return null;
  }
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
