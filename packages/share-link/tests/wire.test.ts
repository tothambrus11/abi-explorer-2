import { describe, it, expect } from 'vitest';
import {
  fromWire,
  fromWireV1,
  fromWireV2,
  fromWireV3,
  MAX_BUFFERS,
  MAX_BUFFER_NAME,
  MAX_EXTRA_FLAGS,
  toWireV1,
  toWireV2,
  toWireV3,
  type Wire,
  type WireV1,
  type WireV2,
  type WireV3,
} from '../src/index.ts';
import { ONE, OPTIONS, SOURCE, TWO } from './fixtures.ts';

/** What abiexplorer.org wrote for `ONE` as of September 2026 (origin/main 088c2e0). */
const DEPLOYED: WireV2 = {
  v: 2,
  s: SOURCE,
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

describe('V1 and V2: one source at the top level', () => {
  it('V2 writes what abiexplorer.org wrote, key for key', () => {
    expect(toWireV2(ONE)).toEqual(DEPLOYED);
  });
  it('V1 is the same shape under 1, as abiexplorer.org wrote where it could not compress', () => {
    const w: WireV1 = toWireV1(ONE);
    expect(w).toEqual({ ...DEPLOYED, v: 1 });
  });
  it('carry the first buffer of a state with several', () => {
    expect(toWireV1(TWO)).toEqual({ ...DEPLOYED, v: 1, vw: 'tabs' });
    expect(toWireV2(TWO)).toEqual({ ...DEPLOYED, vw: 'tabs' });
  });
  it('read back what they wrote', () => {
    expect(fromWireV1(toWireV1(ONE))).toEqual(ONE);
    expect(fromWireV2(toWireV2(ONE))).toEqual(ONE);
  });
  it('read what abiexplorer.org read: a stray wl, and an older __custom__ triple', () => {
    expect(fromWireV2({ ...DEPLOYED, wl: 1 })).toEqual(ONE);
    expect(fromWireV1({ ...DEPLOYED, v: 1, t: '__custom__', ct: ' riscv64-unknown-elf ' })).toEqual(
      {
        ...ONE,
        buffers: [{ ...ONE.buffers[0]!, options: { ...OPTIONS, triple: 'riscv64-unknown-elf' } }],
      },
    );
    expect(fromWireV1({ ...DEPLOYED, v: 1, t: '__custom__' }).buffers[0]?.options.triple).toBe('');
  });
});

describe('V3: every source in bs', () => {
  it('writes each buffer with its options, and the view and the layout at the top', () => {
    const w: WireV3 = toWireV3(TWO);
    expect(w).toEqual({
      v: 3,
      bs: [
        {
          n: 'First',
          s: SOURCE,
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
        },
        {
          n: 'Hylo one',
          s: 'type P { var x: Int }',
          l: 'hylo',
          std: '',
          t: 'hylo',
          p: '',
          mb: 0,
          se: 0,
          sw: 0,
          wp: 0,
          x: '',
          r: null,
        },
      ],
      vw: 'tabs',
      ly: TWO.layout,
    });
    const { layout: _layout, ...bare } = TWO;
    expect('ly' in toWireV3(bare)).toBe(false);
  });
  it('reads back what it wrote', () => {
    expect(fromWireV3(toWireV3(TWO))).toEqual(TWO);
    expect(fromWireV3(toWireV3(ONE))).toEqual(ONE);
  });
});

describe('one reader for every version', () => {
  it('goes by v', () => {
    expect(fromWire(toWireV1(ONE))).toEqual(ONE);
    expect(fromWire(toWireV2(ONE))).toEqual(ONE);
    expect(fromWire(toWireV3(TWO))).toEqual(TWO);
  });
  it('reads a wire without a v, or with one it does not know, as V1', () => {
    const { v: _v, ...bare } = toWireV1(ONE);
    expect(fromWire(bare)).toEqual(ONE);
    expect(fromWire({ ...toWireV1(ONE), v: 99 })).toEqual(ONE);
    expect(fromWire({ ...toWireV3(TWO), v: 1 })?.buffers[0]?.source).toBe('');
  });
  it('Wire is the union of the versions', () => {
    const wires: Wire[] = [toWireV1(ONE), toWireV2(ONE), toWireV3(TWO)];
    expect(wires.map((w) => w.v)).toEqual([1, 2, 3]);
  });
  it('is null for what is not a wire', () => {
    for (const value of [null, undefined, 1, 'x', [1], [toWireV3(TWO)]]) {
      expect(fromWire(value)).toBeNull();
    }
    expect(fromWire({})).not.toBeNull();
  });
  it('gives every field the right shape and nothing else', () => {
    expect(fromWire({ v: 3, bs: [{ n: 7, s: 7, l: 7, std: 7, t: 7, p: '3', x: 7 }] })).toEqual({
      buffers: [
        {
          name: 'Source 1',
          source: '',
          options: {
            ...OPTIONS,
            lang: '',
            std: '',
            triple: '',
            pack: '',
            msBitfields: false,
            shortWchar: false,
            extraFlags: '',
          },
          selectedRecord: null,
        },
      ],
      view: 'tabs',
    });
  });
  it('keeps the first eight buffers, and trims what is too long', () => {
    const bs = Array.from({ length: 12 }, (_, i) => ({
      n: '  a  very ' + 'long '.repeat(20) + String(i),
      x: 'x'.repeat(MAX_EXTRA_FLAGS + 50),
    }));
    const s = fromWire({ v: 3, bs });
    expect(s?.buffers).toHaveLength(MAX_BUFFERS);
    for (const b of s!.buffers) {
      expect(b.name.length).toBeLessThanOrEqual(MAX_BUFFER_NAME);
      expect(b.name.startsWith('a very long')).toBe(true);
      expect(b.options.extraFlags).toHaveLength(MAX_EXTRA_FLAGS);
    }
  });
  it('names an unnamed buffer by its position, and an empty bs is one buffer', () => {
    expect(fromWire({ v: 3, bs: [{}, { n: '   ' }] })?.buffers.map((b) => b.name)).toEqual([
      'Source 1',
      'Source 2',
    ]);
    expect(fromWire({ v: 3, bs: [] })?.buffers).toHaveLength(1);
    expect(fromWire({ v: 3 })?.buffers).toHaveLength(1);
  });
  it('refuses a triple that is not a plain token', () => {
    for (const t of ['x86_64 linux', 'a;b', 'x'.repeat(65), '']) {
      expect(fromWire({ v: 1, t })?.buffers[0]?.options.triple).toBe('');
      expect(fromWire({ v: 3, bs: [{ t }] })?.buffers[0]?.options.triple).toBe('');
    }
    // `__custom__` is V1's word for "see ct"; the versions after have no such word.
    expect(fromWire({ v: 1, t: '__custom__' })?.buffers[0]?.options.triple).toBe('');
    expect(fromWire({ v: 2, t: '__custom__' })?.buffers[0]?.options.triple).toBe('');
    expect(fromWire({ v: 3, bs: [{ t: '__custom__' }] })?.buffers[0]?.options.triple).toBe(
      '__custom__',
    );
  });
  it('drops a layout that is not one', () => {
    expect(fromWire({ v: 3, bs: [{}], ly: TWO.layout })?.layout).toEqual(TWO.layout);
    for (const ly of [null, 1, [], {}, { grid: {} }, { panels: {} }, { grid: 1, panels: {} }]) {
      expect(fromWire({ v: 3, bs: [{}], ly })?.layout).toBeUndefined();
    }
  });
  it('reads the view, and defaults it', () => {
    expect(fromWire({ v: 2, vw: 'stack' })?.view).toBe('stack');
    expect(fromWire({ v: 2, vw: 'sideways' })?.view).toBe('tabs');
  });
});
