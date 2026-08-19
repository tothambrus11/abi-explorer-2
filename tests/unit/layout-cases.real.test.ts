// Tricky layout constructs, checked against the real wasm clang: each case
// pins an ABI fact the UI would otherwise silently get wrong. Skipped unless
// ABIX_REAL_CLANG=1.
import { describe, it, expect, beforeAll } from 'vitest';
import { Analyzer, type Analysis } from '$compiler/Analyzer';
import { DEFAULT_OPTIONS } from '$core/options';
import { buildRenderModel } from '$core/model';
import { buildLayoutTree, flattenVisible, type TreeNode } from '$core/tree';
import type { RenderModel } from '$core/types';
import type { Compiler } from '$compiler/Compiler';

const enabled = process.env['ABIX_REAL_CLANG'] === '1';

describe.skipIf(!enabled)('layout cases (real clang)', () => {
  let analyzer: Analyzer;
  beforeAll(async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    analyzer = new Analyzer((await createNodeCompiler()) as Compiler);
  }, 300_000);

  const analyze = (src: string, lang: 'c' | 'c++', triple: string) =>
    analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang,
      std: lang === 'c++' ? 'gnu++20' : 'gnu17',
      triple,
    });

  const modelOf = (a: Analysis, name: string): RenderModel =>
    buildRenderModel(
      a.userRecords.find((r) => r.name === name)!,
      a,
    );

  /** "name @offset size" per visible tree row, indented by depth. */
  const outline = (m: RenderModel): string[] =>
    flattenVisible(buildLayoutTree(m), new Set()).map(({ node, depth }) => {
      const label =
        node.kind === 'leaf' ? m.leaves[node.ref]!.name : '[' + m.groups[node.ref]!.name + ']';
      const size = node.sizeBits === null ? '?' : `${node.sizeBits / 8}B`;
      return `${'  '.repeat(depth)}${label} @${node.offsetBits / 8} ${size}`;
    });

  const anyOverlap = (nodes: TreeNode[]): boolean =>
    nodes.some((n) => n.overlaps || anyOverlap(n.children));

  it('virtual inheritance: the shared base appears once, after the derived fields', async () => {
    const a = await analyze(
      `struct A { virtual ~A(); int a; };
struct B : virtual A { int b; };
struct C : virtual A { int c; };
struct D : B, C { int d; };`,
      'c++',
      'x86_64-unknown-linux-gnu',
    );
    const d = modelOf(a, 'D');
    expect(d.record.sizeBytes).toBe(48);
    expect(outline(d)).toEqual([
      '[B] @0 12B',
      '  B vtable pointer @0 8B',
      '  b @8 4B',
      '[C] @16 12B',
      '  C vtable pointer @16 8B',
      '  c @24 4B',
      'd @28 4B',
      '[virtual A] @32 12B',
      '  A vtable pointer @32 8B',
      '  a @40 4B',
    ]);
    // Bases occupy their non-virtual size, so nothing collides.
    expect(anyOverlap(buildLayoutTree(d))).toBe(false);
  }, 180_000);

  it('the same hierarchy on MSVC: vbtable/vftable pointers and no tail-padding reuse', async () => {
    const a = await analyze(
      `struct A { virtual ~A(); int a; };
struct B : virtual A { int b; };
struct C : virtual A { int c; };
struct D : B, C { int d; };`,
      'c++',
      'x86_64-pc-windows-msvc',
    );
    const d = modelOf(a, 'D');
    expect(d.record.sizeBytes).toBe(56); // vs 48 on Itanium
    expect(d.leaves.map((l) => l.name)).toEqual([
      'B vbtable pointer',
      'b',
      'C vbtable pointer',
      'c',
      'd',
      'A vftable pointer',
      'a',
    ]);
  }, 180_000);

  it('empty bases take no storage and do not overlap the first member', async () => {
    const a = await analyze(
      `struct E1 {}; struct E2 {};
struct Both : E1, E2 { char c; };`,
      'c++',
      'x86_64-unknown-linux-gnu',
    );
    const both = modelOf(a, 'Both');
    expect(both.record.sizeBytes).toBe(1);
    // sizeof(E1) is 1, but as a base it occupies nothing.
    expect(both.groups.filter((g) => g.isBase).map((g) => g.sizeBits)).toEqual([0, 0]);
    expect(anyOverlap(buildLayoutTree(both))).toBe(false);
    expect(both.markers.map((k) => k.kind)).toEqual(['empty-base', 'empty-base']);
  }, 180_000);

  it('unions: every alternative starts at the same offset and is flagged as overlapping', async () => {
    const a = await analyze(
      `union U { struct { char a; int b; } s; struct { double d; } t; long long l; };`,
      'c',
      'x86_64-unknown-linux-gnu',
    );
    const u = modelOf(a, 'U');
    expect(u.record.sizeBytes).toBe(8);
    const top = buildLayoutTree(u);
    expect(top.every((n) => n.offsetBits === 0)).toBe(true);
    expect(top.every((n) => n.overlaps)).toBe(true);
  }, 180_000);

  it('an anonymous union member nests as one unit whose alternatives overlap', async () => {
    const a = await analyze(
      `struct S { int tag; union { int i; float f; char s[8]; }; };`,
      'c',
      'x86_64-unknown-linux-gnu',
    );
    const s = modelOf(a, 'S');
    expect(s.record.sizeBytes).toBe(12);
    expect(outline(s)).toEqual([
      'tag @0 4B',
      '[(anonymous)] @4 8B',
      '  i @4 4B',
      '  f @4 4B',
      '  s @4 8B',
    ]);
    const anon = buildLayoutTree(s).find((n) => n.kind === 'group')!;
    expect(anon.isUnion).toBe(true);
    expect(anon.overlaps).toBe(false); // it does not overlap `tag`…
    expect(anon.children.every((c) => c.overlaps)).toBe(true); // …but its members share bytes
  }, 180_000);

  it('bit-fields: widths, a :0 unit break, and the straddling member', async () => {
    const a = await analyze(
      `struct S { unsigned a : 3; unsigned : 0; unsigned b : 30; unsigned c : 5; };`,
      'c',
      'x86_64-unknown-linux-gnu',
    );
    const s = modelOf(a, 'S');
    expect(s.record.sizeBytes).toBe(12);
    expect(s.leaves.map((l) => [l.name, l.offsetBits, l.sizeBits])).toEqual([
      ['a', 0, 3],
      ['b', 32, 30],
      ['c', 64, 5],
    ]);
    expect(s.markers.map((k) => [k.kind, k.offsetBits])).toEqual([['zero-bitfield', 32]]);
  }, 180_000);

  it('#pragma pack applies through a nested member', async () => {
    const a = await analyze(
      `#pragma pack(1)
struct Inner { int i; char c; };
struct Outer { char a; struct Inner in; double d; };
#pragma pack()`,
      'c',
      'x86_64-unknown-linux-gnu',
    );
    const o = modelOf(a, 'Outer');
    expect([o.record.sizeBytes, o.record.align, o.paddingBytes]).toEqual([14, 1, 0]);
    expect(outline(o)).toEqual(['a @0 1B', '[in] @1 5B', '  i @1 4B', '  c @5 1B', 'd @6 8B']);
  }, 180_000);

  it('a flexible array member is a zero-size trailing field', async () => {
    const a = await analyze(`struct S { int n; char data[]; };`, 'c', 'x86_64-unknown-linux-gnu');
    const s = modelOf(a, 'S');
    expect(s.record.sizeBytes).toBe(4);
    expect(s.leaves.map((l) => [l.name, l.offsetBits / 8, l.sizeBits])).toEqual([
      ['n', 0, 32],
      ['data', 4, 0],
    ]);
    expect(s.leaves.every((l) => !l.estimated)).toBe(true);
  }, 180_000);

  it('over-alignment (alignas) propagates into the enclosing record', async () => {
    const a = await analyze(
      `struct alignas(64) Cache { int x; };
struct Holder { char c; Cache line; char d; };`,
      'c++',
      'x86_64-unknown-linux-gnu',
    );
    const h = modelOf(a, 'Holder');
    expect([h.record.sizeBytes, h.record.align]).toEqual([192, 64]);
    expect(h.groups.find((g) => g.name === 'line')!.align).toBe(64);
  }, 180_000);

  it('references and pointers-to-members are measured, not guessed', async () => {
    const a = await analyze(
      `struct S { int& r; const double& cr; char c; };`,
      'c++',
      'x86_64-unknown-linux-gnu',
    );
    const s = modelOf(a, 'S');
    expect(s.leaves.map((l) => [l.name, l.sizeBits / 8, l.estimated])).toEqual([
      ['r', 8, false],
      ['cr', 8, false],
      ['c', 1, false],
    ]);
    // MSVC's most-general pointer-to-member representations.
    const ms = await analyze(
      `struct Host; struct S { int Host::*pm; void (Host::*pmf)(); };`,
      'c++',
      'x86_64-pc-windows-msvc',
    );
    const m = modelOf(ms, 'S');
    expect(m.leaves.map((l) => [l.name, l.sizeBits / 8, l.estimated])).toEqual([
      ['pm', 12, false],
      ['pmf', 24, false],
    ]);
  }, 180_000);

  it('each template instantiation is its own record', async () => {
    const a = await analyze(
      `template <class T> struct Pair { T a; T b; };
Pair<char> pc; Pair<double> pd;`,
      'c++',
      'x86_64-unknown-linux-gnu',
    );
    expect(modelOf(a, 'Pair<char>').record.sizeBytes).toBe(2);
    expect(modelOf(a, 'Pair<double>').record.sizeBytes).toBe(16);
  }, 180_000);
});
