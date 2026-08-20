import { describe, it, expect } from 'vitest';
import { assignColors, directMembers, groupColorClass } from '$core/render';
import { group, leaf, model } from './factories';

describe('assignColors (one level deep)', () => {
  it('gives each direct field its own colour', () => {
    const m = model([leaf('a'), leaf('b'), leaf('c')]);
    assignColors(m);
    expect(m.leaves.map((l) => l.colorClass)).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('a compound member is one colour shared by everything inside it', () => {
    // struct Message { Header hdr; int n; }: hdr covers leaves 0,1
    const m = model(
      [leaf('kind', { path: ['hdr'] }), leaf('len', { path: ['hdr'] }), leaf('n')],
      [group('hdr', [0, 1])],
    );
    assignColors(m);
    const [kind, len, n] = m.leaves.map((l) => l.colorClass);
    expect(kind).toBe(len); // one unit, one colour
    expect(n).not.toBe(kind); // a sibling field is a different unit
  });

  it('nested groups do not claim a colour of their own', () => {
    // outer covers both leaves; inner is nested inside it.
    const m = model(
      [leaf('x', { path: ['outer', 'inner'] }), leaf('y', { path: ['outer'] })],
      [group('inner', [0], { path: ['outer'] }), group('outer', [0, 1])],
    );
    assignColors(m);
    expect(m.leaves[0]!.colorClass).toBe(m.leaves[1]!.colorClass);
    expect(m.leaves[0]!.colorClass).toBe('c-1');
  });

  it('a compound member reached through an anonymous aggregate is still one unit', () => {
    // struct S { union { Header hdr; int raw; }; int tail; }
    // The anonymous union is transparent, so `hdr` is a direct member of S and
    // must claim a single colour; the same test `directMembers` and the table
    // chips apply.
    const m = model(
      [
        leaf('kind', { path: ['(anonymous)', 'hdr'] }),
        leaf('len', { path: ['(anonymous)', 'hdr'] }),
        leaf('raw', { path: ['(anonymous)'] }),
        leaf('tail'),
      ],
      [group('hdr', [0, 1], { path: ['(anonymous)'] }), group('(anonymous)', [0, 1, 2])],
    );
    assignColors(m);
    const [kind, len, raw, tail] = m.leaves.map((l) => l.colorClass);
    expect(kind).toBe(len); // hdr is one unit
    expect(groupColorClass(m, m.groups[0]!)).toBe(kind); // so the table shows its chip
    expect(new Set([kind, raw, tail]).size).toBe(3); // three distinct members
  });

  it('specials keep their hatch style wherever they sit', () => {
    const m = model(
      [leaf('vptr', { kind: 'special', path: ['Base'] }), leaf('x', { path: ['Base'] })],
      [group('Base', [0, 1])],
    );
    assignColors(m);
    expect(m.leaves[0]!.colorClass).toBe('c-special');
    expect(m.leaves[1]!.colorClass).toBe('c-1');
  });

  it('an anonymous aggregate is transparent: its fields are members of their own', () => {
    // struct S { int tag; struct { char lo, hi; }; };: `s.lo` is nameable, so
    // lo and hi are members in their own right, not one shared unit.
    const m = model(
      [leaf('tag'), leaf('lo', { path: ['(anonymous)'] }), leaf('hi', { path: ['(anonymous)'] })],
      [group('(anonymous)', [1, 2])],
    );
    assignColors(m);
    const [tag, lo, hi] = m.leaves.map((l) => l.colorClass);
    expect(new Set([tag, lo, hi]).size).toBe(3);
  });

  it('wraps around the palette', () => {
    const m = model(Array.from({ length: 10 }, (_, i) => leaf(`f${i}`)));
    assignColors(m, 8);
    expect(m.leaves.map((l) => l.colorClass).slice(8)).toEqual(['c-1', 'c-2']);
  });
});

describe('directMembers', () => {
  it('is the record’s own fields plus its compound members, one level deep', () => {
    // struct K { Pair<double> s; }: one member, not two.
    const m = model(
      [leaf('first', { path: ['s'] }), leaf('second', { path: ['s'] })],
      [group('s', [0, 1])],
    );
    expect(directMembers(m).map((u) => u.name)).toEqual(['s']);
  });

  it('counts anonymous-injected fields individually, not the aggregate', () => {
    const m = model(
      [
        leaf('tag'),
        leaf('lo', { path: ['(anonymous)'] }),
        leaf('hi', { path: ['(anonymous)'], offsetBits: 8 }),
      ],
      [group('(anonymous)', [1, 2])],
    );
    expect(directMembers(m).map((u) => u.name)).toEqual(['tag', 'lo', 'hi']);
  });

  it('orders members by offset', () => {
    const m = model([leaf('b', { offsetBits: 32 }), leaf('a', { offsetBits: 0 })]);
    expect(directMembers(m).map((u) => u.name)).toEqual(['a', 'b']);
  });
});

describe('groupColorClass', () => {
  it('is the colour a named unit’s leaves share', () => {
    const m = model(
      [leaf('first', { path: ['s'] }), leaf('second', { path: ['s'] })],
      [group('s', [0, 1])],
    );
    assignColors(m);
    expect(groupColorClass(m, m.groups[0]!)).toBe('c-1');
  });

  it('is null for an aggregate spanning several members', () => {
    const m = model(
      [leaf('lo', { path: ['(anonymous)'] }), leaf('hi', { path: ['(anonymous)'] })],
      [group('(anonymous)', [0, 1])],
    );
    assignColors(m);
    expect(groupColorClass(m, m.groups[0]!)).toBeNull();
  });
});
