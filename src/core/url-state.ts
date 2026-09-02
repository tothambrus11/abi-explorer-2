// Shareable state <-> URL fragment.
//
// v1 (legacy): base64url(JSON) with short keys.
// v2: "2." + base64url(deflate-raw(JSON)), same keys but compressed, so long
// sources still fit comfortably in a URL.

import { DEFAULT_OPTIONS, type CompileOptions, standardsFor, defaultStdFor } from './options';
import { knownTriples } from './targets';

export type ViewMode = 'tabs' | 'stack';

export interface ShareState {
  source: string;
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
  return {
    v: 2,
    s: state.source,
    l: o.lang,
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
}

/** Coerce untrusted wire data into a valid ShareState (unknown values fall back to defaults). */
function fromWire(w: Partial<Wire>): ShareState {
  const lang = w.l === 'c++' || w.l === 'hylo' ? w.l : 'c';
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
    source: typeof w.s === 'string' ? w.s : '',
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
