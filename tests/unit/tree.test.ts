import { describe, it, expect } from 'vitest';
import { buildLayoutTree, flattenVisible, type TreeNode } from '$core/tree';
import type { Group, Leaf, RenderModel } from '$core/types';

// Minimal model builders — the tree only reads leaves[], groups[] (offset/size/
// leafIndexes/path/isBase/isUnion), so we fabricate those directly.
function leaf(name: string, offsetBits: number, sizeBits: number, extra: Partial<Leaf> = {}): Leaf {
  return {
    kind: 'field',
    row: {} as never,
    path: [],
    name,
    type: null,
    offsetBits,
    sizeBits,
    align: null,
    estimated: false,
    depth: 0,
    owner: 'S',
    ...extra,
  };
}
function group(
  name: string,
  offsetBits: number,
  sizeBits: number | null,
  leafIndexes: number[],
  extra: Partial<Group> = {},
): Group {
  return {
    kind: 'member',
    name,
    type: '',
    owner: 'S',
    path: [],
    offsetBits,
    sizeBits,
    align: null,
    leafIndexes,
    typeSizeBits: null,
    isBase: false,
    isUnion: false,
    ...extra,
  };
}
function model(leaves: Leaf[], groups: Group[]): RenderModel {
  return {
    record: {} as never,
    leaves,
    groups,
    markers: [],
    paddings: [],
    sizeBits: 0,
    paddingBytes: 0,
    unresolved: [],
  };
}

/** Compact shape for assertions: name(kind) with nested children. */
function shape(nodes: TreeNode[], m: RenderModel): unknown {
  return nodes.map((n) => {
    const label = n.kind === 'leaf' ? m.leaves[n.ref]!.name : m.groups[n.ref]!.name;
    return n.children.length ? { [label]: shape(n.children, m) } : label;
  });
}

describe('buildLayoutTree', () => {
  it('is a flat list when there are no groups', () => {
    const m = model([leaf('a', 0, 32), leaf('b', 32, 32)], []);
    const t = buildLayoutTree(m);
    expect(shape(t, m)).toEqual(['a', 'b']);
    expect(t.every((n) => n.kind === 'leaf')).toBe(true);
    expect(t[0]).toMatchObject({ offsetBits: 0, sizeBits: 32, leafIndexes: [0] });
  });

  it('nests a compound member and reports its subtree leaves and extent', () => {
    // struct Msg { u16 kind; u16 len; struct Header hdr { u16 a; u16 b } }
    const m = model(
      [
        leaf('kind', 0, 16),
        leaf('len', 16, 16),
        leaf('a', 32, 16, { path: ['hdr'] }),
        leaf('b', 48, 16, { path: ['hdr'] }),
      ],
      [group('hdr', 32, 32, [2, 3])],
    );
    const t = buildLayoutTree(m);
    expect(shape(t, m)).toEqual(['kind', 'len', { hdr: ['a', 'b'] }]);
    const hdr = t[2]!;
    expect(hdr.kind).toBe('group');
    expect(hdr.leafIndexes).toEqual([2, 3]); // for hover highlight
    expect(hdr).toMatchObject({ offsetBits: 32, sizeBits: 32 });
  });

  it('keeps declaration order and nests multiple levels', () => {
    // struct { a; struct m { struct n { x } y }; b }
    const m = model(
      [leaf('a', 0, 8), leaf('x', 8, 8, { path: ['m', 'n'] }), leaf('b', 16, 8)],
      [group('m', 8, 8, [1]), group('n', 8, 8, [1], { path: ['m'] })],
    );
    expect(shape(buildLayoutTree(m), m)).toEqual(['a', { m: [{ n: ['x'] }] }, 'b']);
  });

  it('does NOT merge two sibling anonymous members with the same label', () => {
    // struct { struct { p } ; struct { q } ; }  — both labelled "(anonymous)"
    const m = model(
      [leaf('p', 0, 8, { path: ['(anonymous)'] }), leaf('q', 8, 8, { path: ['(anonymous)'] })],
      [group('(anonymous)', 0, 8, [0]), group('(anonymous)', 8, 8, [1])],
    );
    const t = buildLayoutTree(m);
    expect(t).toHaveLength(2);
    expect(shape(t, m)).toEqual([{ '(anonymous)': ['p'] }, { '(anonymous)': ['q'] }]);
  });

  it('marks union members and overlapping siblings', () => {
    // union U { char raw[8]; int i; }  wrapped as a member
    const m = model(
      [leaf('raw', 0, 64, { path: ['u'] }), leaf('i', 0, 32, { path: ['u'] })],
      [group('u', 0, 64, [0, 1], { isUnion: true, type: 'union U' })],
    );
    const t = buildLayoutTree(m);
    const u = t[0]!;
    expect(u.isUnion).toBe(true);
    // the union's children overlap each other (share offset 0)
    expect(u.children.map((c) => c.overlaps)).toEqual([true, true]);
    // a lone top-level union member does not "overlap" a sibling (none)
    expect(u.overlaps).toBe(false);
  });

  it('flags overlap from tail-padding reuse (a sibling starts inside a base subobject)', () => {
    // struct Derived : Base { char d; } where Base nvsize < sizeof and d sits in the tail
    const m = model(
      [
        leaf('Base vptr', 0, 64, { path: ['Base'] }),
        leaf('x', 64, 32, { path: ['Base'] }),
        leaf('d', 96, 8),
      ],
      [group('Base', 0, 96 /* nvsize 12B */, [0, 1], { isBase: true })],
    );
    // no overlap: d at 96 is exactly after Base's nvsize extent (0..96)
    let t = buildLayoutTree(m);
    expect(t.find((n) => n.kind === 'leaf')!.overlaps).toBe(false);
    // now make d start inside Base's extent → overlap flagged on both
    const m2 = model(
      m.leaves.map((l) => (l.name === 'd' ? { ...l, offsetBits: 88 } : l)),
      m.groups,
    );
    t = buildLayoutTree(m2);
    const base = t.find((n) => n.kind === 'group')!;
    const d = t.find((n) => n.kind === 'leaf' && m2.leaves[n.ref]!.name === 'd')!;
    expect(base.overlaps).toBe(true);
    expect(d.overlaps).toBe(true);
  });

  it('handles empty groups (empty base: no leaves) as a zero-child node at its position', () => {
    const m = model([leaf('c', 0, 8)], [group('Empty', 0, 0, [], { isBase: true })]);
    const t = buildLayoutTree(m);
    // both are roots; the empty base keeps its own node
    expect(
      t
        .map((n) =>
          n.kind === 'group' ? 'g:' + m.groups[n.ref]!.name : 'l:' + m.leaves[n.ref]!.name,
        )
        .sort(),
    ).toEqual(['g:Empty', 'l:c']);
    expect(t.find((n) => n.kind === 'group')!.children).toEqual([]);
  });

  it('flattenVisible respects collapsed state', () => {
    const m = model(
      [
        leaf('kind', 0, 16),
        leaf('a', 32, 16, { path: ['hdr'] }),
        leaf('b', 48, 16, { path: ['hdr'] }),
      ],
      [group('hdr', 32, 32, [1, 2])],
    );
    const t = buildLayoutTree(m);
    const hdrId = t[1]!.id;
    // expanded: parent + both children visible
    expect(flattenVisible(t, new Set()).map((r) => r.node.kind)).toEqual([
      'leaf',
      'group',
      'leaf',
      'leaf',
    ]);
    // collapsed: children hidden
    expect(flattenVisible(t, new Set([hdrId])).map((r) => r.node.kind)).toEqual(['leaf', 'group']);
    expect(flattenVisible(t, new Set([hdrId]))[1]!.depth).toBe(0);
  });

  it('gives leafless groups one parent each', () => {
    // `struct E {}; struct W : E {}; struct S { W a; W b; int i; };`
    // Neither `a` nor `b` contains a single leaf, so leaf indices cannot say
    // which `E` belongs to which member — only the label path can. Deciding it
    // by nesting depth let both members adopt both bases, and the same node was
    // rendered twice under a key a keyed `{#each}` rejects.
    const m = model(
      [leaf('i', 32, 32)],
      [
        group('E', 0, 0, [], { path: ['a'], isBase: true, kind: 'base' }),
        group('a', 0, 0, []),
        group('E', 0, 0, [], { path: ['b'], isBase: true, kind: 'base' }),
        group('b', 0, 0, []),
      ],
    );
    const rows = flattenVisible(buildLayoutTree(m), new Set());
    const ids = rows.map((r) => r.node.id);
    expect(new Set(ids).size, 'a node is rendered twice').toBe(ids.length);
    // Each base sits under the member that declares it.
    const parentOf = (id: string) =>
      rows.find((r) => r.node.children.some((c) => c.id === id))?.node.id;
    expect(parentOf('g0')).toBe('g1');
    expect(parentOf('g2')).toBe('g3');
  });
});
