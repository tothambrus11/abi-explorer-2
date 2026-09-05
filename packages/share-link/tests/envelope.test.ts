import { describe, it, expect } from 'vitest';
import {
  canDeflate,
  decodeFragment,
  DEFLATE_PREFIX,
  encodeDeflate,
  encodePlain,
} from '../src/index.ts';
import { fromBase64url, toBase64url } from '../src/base64url.ts';

const VALUES: unknown[] = [
  { v: 3, bs: [{ n: 'First', s: 'struct A { char c; int i; };' }], vw: 'tabs' },
  { s: 'x'.repeat(100_000) },
  [],
  [1, 'two', null],
  'text with spaces and ünïcödé',
  0,
  null,
  { nested: { deep: { deeper: [{}, { a: 'b' }] } } },
];

describe('each envelope reads back what it wrote, for any JSON value', () => {
  it('1: plain base64url, and nothing a URL would touch', async () => {
    for (const value of VALUES) {
      const frag = encodePlain(value);
      expect(frag).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(await decodeFragment(frag)).toEqual({ envelope: 1, value });
    }
  });
  it('2: deflate behind the prefix, smaller for anything long', async () => {
    expect(canDeflate()).toBe(true);
    for (const value of VALUES) {
      const frag = await encodeDeflate(value);
      expect(frag.startsWith(DEFLATE_PREFIX)).toBe(true);
      expect(frag.slice(DEFLATE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(await decodeFragment(frag)).toEqual({ envelope: 2, value });
    }
    expect((await encodeDeflate(VALUES[1])).length).toBeLessThan(
      encodePlain(VALUES[1]).length / 10,
    );
  });
  it('accepts the leading # of location.hash', async () => {
    expect(await decodeFragment('#' + encodePlain({ a: 1 }))).toEqual({
      envelope: 1,
      value: { a: 1 },
    });
    expect(await decodeFragment('#' + (await encodeDeflate({ a: 1 })))).toEqual({
      envelope: 2,
      value: { a: 1 },
    });
  });
});

/** The JSON abiexplorer.org put in its links as of September 2026. */
const DEPLOYED = {
  v: 2,
  s: 'struct A { char c; int i; };',
  l: 'c++',
  std: 'c++20',
  t: 'aarch64-apple-darwin',
  p: '2',
  mb: 1,
  se: 0,
  sw: 1,
  wp: 0,
  x: '-funsigned-char -DX=1',
  r: 'A',
  vw: 'stack',
};

describe('fragments written once, readable forever', () => {
  it('envelope 1, as abiexplorer.org wrote where it could not compress', async () => {
    expect(
      await decodeFragment(
        'eyJ2IjoxLCJzIjoic3RydWN0IEEgeyBjaGFyIGM7IGludCBpOyB9OyIsImwiOiJjKysiLCJzdGQiOiJjKysyMCIsInQiOiJhYXJjaDY0LWFwcGxlLWRhcndpbiIsInAiOiIyIiwibWIiOjEsInNlIjowLCJzdyI6MSwid3AiOjAsIngiOiItZnVuc2lnbmVkLWNoYXIgLURYPTEiLCJyIjoiQSIsInZ3Ijoic3RhY2sifQ',
      ),
    ).toEqual({ envelope: 1, value: { ...DEPLOYED, v: 1 } });
  });
  it('envelope 2, as abiexplorer.org wrote', async () => {
    expect(
      await decodeFragment(
        '2.JY6xCoMwFAB_JdzqC1gpHZ50EPoRXdNoq9QGSaIWxH8v2O1uuttY0EpIKCnH2WfTmM343kXjazOEbIba7DXCiOKLAiHl9s9ViZBRnIu-v5ytm6axs62L6xAQJpQK4fNAT0Lq0FJI62HrdNgXxT7nkIZX6Fp7lO3tfj0hRJQGYVmPPeff7D8',
      ),
    ).toEqual({ envelope: 2, value: DEPLOYED });
  });
});

describe("a fragment is a stranger's input", () => {
  it('is null when absent, foreign or corrupt', async () => {
    for (const frag of [
      '',
      '#',
      'not base64!!',
      '2.',
      '2.not-deflate',
      'eyJ2Ijo',
      '2.' + encodePlain({}),
    ]) {
      expect(await decodeFragment(frag)).toBeNull();
    }
  });
  it('base64url survives a megabyte', () => {
    const bytes = new Uint8Array(1_500_000).map((_, i) => i % 251);
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
  });
});
