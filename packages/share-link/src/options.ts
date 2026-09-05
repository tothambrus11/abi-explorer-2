// The options a source is compiled with, as every version of the wire spells
// them: the vocabulary V1 and V2 share, in short keys, since every byte of a
// wire is a character of the link.

import { MAX_EXTRA_FLAGS, type ShareOptions } from './state.ts';
import { asString } from './shape.ts';

/** One set of options in wire form. */
export interface WireOptions {
  l: string;
  std: string;
  t: string;
  p: string;
  mb: number;
  se: number;
  sw: number;
  wp: number;
  x: string;
}

const PACKS: readonly string[] = ['', '1', '2', '4', '8', '16'];
/** What a triple may look like: a plain token, nothing a shell or a compiler would read twice. */
const TRIPLE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `o` in wire form. */
export function optionsToWire(o: ShareOptions): WireOptions {
  return {
    l: o.lang,
    std: o.std,
    t: o.triple,
    p: o.pack,
    mb: +o.msBitfields,
    se: +o.shortEnums,
    sw: +o.shortWchar,
    wp: +o.warnPadded,
    x: o.extraFlags,
  };
}

/**
 * The options `w` spells, given the right shape whatever it holds.
 *
 * Shape only: a string where a string goes, a known pack, a triple that is a
 * plain token, booleans for the toggles. A value that is not there, or is the
 * wrong type, is `''` or `false`; deciding what an empty language or standard
 * means is the reader's, who knows which compilers it has.
 */
export function optionsFromWire(w: Record<string, unknown>): ShareOptions {
  const triple = asString(w['t']);
  const p = w['p'];
  return {
    lang: asString(w['l']),
    std: asString(w['std']),
    triple: TRIPLE.test(triple) ? triple : '',
    pack: (typeof p === 'string' && PACKS.includes(p) ? p : '') as ShareOptions['pack'],
    msBitfields: !!w['mb'],
    shortEnums: !!w['se'],
    shortWchar: !!w['sw'],
    warnPadded: !!w['wp'],
    extraFlags: asString(w['x']).slice(0, MAX_EXTRA_FLAGS),
  };
}
