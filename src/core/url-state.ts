// Shareable state <-> URL fragment.
//
// v1 (legacy): base64url(JSON) with short keys.
// v2: "2." + base64url(deflate-raw(JSON)) — same keys, compressed, so long
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
  wl: number;
  wp: number;
  x: string;
  r: string | null;
  vw?: string;
}

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
    wl: +o.wasiLibc,
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
    wasiLibc: !!w.wl,
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

const b64url = {
  encode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  },
};

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode state to a fragment value (without the leading '#'). Falls back to
 * the uncompressed v1 wire format where CompressionStream is unavailable
 * (older WebViews) — every decoder understands both.
 */
export async function encodeShareState(state: ShareState): Promise<string> {
  const wire = toWire(state);
  if (typeof CompressionStream === 'undefined') {
    return b64url.encode(new TextEncoder().encode(JSON.stringify({ ...wire, v: 1 })));
  }
  const json = new TextEncoder().encode(JSON.stringify(wire));
  return '2.' + b64url.encode(await deflate(json));
}

/** Decode a fragment value; returns null when absent or unparseable. */
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

/** Is this triple one of the curated ones? (UI decides whether to show the custom box.) */
export function isKnownTriple(triple: string): boolean {
  return knownTriples().has(triple);
}
