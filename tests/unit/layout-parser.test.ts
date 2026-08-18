import { describe, it, expect } from 'vitest';
import {
  parseRecordLayouts,
  flattenRows,
  isInternalRecord,
  isAnonymousRecord,
} from '$core/layout-parser';
import { loadFixture } from './helpers';

const DUMP = `
*** Dumping AST Record Layout
         0 | struct Derived
         0 |   struct Base (primary base)
         0 |     (Base vtable pointer)
         8 |     int x
        16 |   struct Base2 (base)
        16 |     (Base2 vtable pointer)
        24 |     char y
     25:0-2 |   unsigned int bits
       28:- |   unsigned int 
        29 |   char z
           | [sizeof=32, dsize=30, align=8,
           |  nvsize=30, nvalign=8]

*** Dumping AST Record Layout
         0 | struct WithAnon
         0 |   struct WithAnon::(anonymous at t.cc:9:19) 
         0 |     int ax
         4 |     char ay
         8 |   union WithAnon::(unnamed at t.cc:9:48) named
         8 |     short u1
           | [sizeof=12, align=4]
`;

describe('parseRecordLayouts', () => {
  it('parses bases, specials, bit-fields, zero-width and unnamed fields', () => {
    const [d, w] = parseRecordLayouts(DUMP);
    expect(d).toMatchObject({
      kind: 'struct',
      name: 'Derived',
      sizeBytes: 32,
      dsize: 30,
      align: 8,
      nvsize: 30,
    });
    const rows = flattenRows(d!);
    expect(rows.map((r) => r.rowKind)).toEqual([
      'primary-base',
      'special',
      'field',
      'base',
      'special',
      'field',
      'field',
      'field',
      'field',
    ]);
    expect(rows[1]).toMatchObject({ label: 'Base vtable pointer', offsetBits: 0, depth: 2 });
    expect(rows[6]).toMatchObject({
      name: 'bits',
      type: 'unsigned int',
      offsetBits: 200,
      bitWidth: 3,
      isBitfield: true,
    });
    expect(rows[7]).toMatchObject({ name: '', isZeroWidth: true, offsetBits: 224 });
    expect(rows[8]).toMatchObject({ name: 'z', type: 'char', offsetBits: 232 });
    // anonymous member: trailing space => empty name; nested rows attach to it
    expect(w!.rows[0]).toMatchObject({
      name: '',
      type: 'struct WithAnon::(anonymous at t.cc:9:19)',
    });
    expect(w!.rows[0]!.children.map((c) => c.name)).toEqual(['ax', 'ay']);
    expect(w!.rows[1]).toMatchObject({ name: 'named' });
  });

  it('skips malformed blocks and classifies internal/anonymous records', () => {
    const recs = parseRecordLayouts('*** Dumping AST Record Layout\n  0 | struct Broken\n');
    expect(recs).toEqual([]);
    const [d, w] = parseRecordLayouts(DUMP);
    expect(isInternalRecord(d!)).toBe(false);
    expect(isAnonymousRecord({ ...w!, name: 'X::(unnamed at t.c:1:1)' })).toBe(true);
    expect(isInternalRecord({ ...d!, name: '__va_list_tag' })).toBe(true);
    expect(isInternalRecord({ ...d!, name: '__abix_p3' })).toBe(true);
  });

  it('parses real clang dumps for every fixture', () => {
    for (const [name, triple] of [
      ['padding-basics', 'x86_64-unknown-linux-gnu'],
      ['cxx-bases', 'x86_64-pc-windows-msvc'],
      ['bitfields', 'msp430-none-elf'],
    ]) {
      const fx = loadFixture(name!, triple!);
      const layoutOut = fx.calls[0]!.out.stdout;
      const recs = parseRecordLayouts(layoutOut);
      expect(recs.length).toBeGreaterThan(0);
      for (const r of recs) {
        expect(r.sizeBytes).toBeGreaterThanOrEqual(0);
        expect(r.align).toBeGreaterThanOrEqual(1);
        for (const row of flattenRows(r)) expect(Number.isFinite(row.offsetBits)).toBe(true);
      }
    }
  });
});
