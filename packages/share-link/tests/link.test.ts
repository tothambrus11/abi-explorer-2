import { describe, it, expect } from 'vitest';
import { decode, encode, encodeDeflate, encodePlain, toWireV1, toWireV2 } from '../src/index.ts';
import { ONE, TWO } from './fixtures.ts';

describe('encode and decode: the two halves together', () => {
  it('a link opens on what was shared', async () => {
    const frag = await encode(TWO);
    expect(frag).toMatch(/^2\./);
    expect(await decode(frag)).toEqual(TWO);
    expect(await decode('#' + frag)).toEqual(TWO);
  });
  it('opens every wire in every envelope', async () => {
    expect(await decode(encodePlain(toWireV1(ONE)))).toEqual(ONE);
    expect(await decode(await encodeDeflate(toWireV2(ONE)))).toEqual(ONE);
    expect(await decode(await encodeDeflate(toWireV1(ONE)))).toEqual(ONE);
    expect(await decode(encodePlain(toWireV2(ONE)))).toEqual(ONE);
  });
  it('is null for what is not a link', async () => {
    expect(await decode('')).toBeNull();
    expect(await decode('#2.nope')).toBeNull();
    expect(await decode(encodePlain([1, 2]))).toBeNull();
  });
});
