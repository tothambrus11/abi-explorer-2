import { describe, it, expect } from 'vitest';
import { buildLineIndex, collectMemberAligns, markAtColumn } from '$state/code-locations';
import type { FieldLocation } from '$core/ast-locations';
import type { Group, Leaf, RenderModel } from '$core/types';

function leaf(name: string, owner: string, offsetBits: number, extra: Partial<Leaf> = {}): Leaf {
  return {
    kind: 'field',
    row: {} as never,
    path: [],
    name,
    type: null,
    offsetBits,
    sizeBits: 32,
    align: 4,
    estimated: false,
    depth: 0,
    owner,
    colorClass: 'c-1',
    ...extra,
  };
}
function group(
  name: string,
  owner: string,
  leafIndexes: number[],
  extra: Partial<Group> = {},
): Group {
  return {
    kind: 'member',
    name,
    type: '',
    owner,
    path: [],
    offsetBits: 0,
    sizeBits: 64,
    align: 8,
    leafIndexes,
    typeSizeBits: null,
    isBase: false,
    isUnion: false,
    ...extra,
  };
}
function model(key: string, leaves: Leaf[], groups: Group[] = []): [string, RenderModel] {
  return [
    key,
    {
      record: { name: key } as never,
      leaves,
      groups,
      markers: [],
      paddings: [],
      sizeBits: 0,
      paddingBytes: 0,
      unresolved: [],
    },
  ];
}
function fieldLoc(
  owner: string,
  name: string,
  line: number,
  over: Partial<FieldLocation> = {},
): FieldLocation {
  return { owner, qualifiedOwner: owner, name, line, col: 3, qualType: '', ...over };
}

describe('buildLineIndex', () => {
  it('is empty for no models', () => {
    const idx = buildLineIndex(new Map(), []);
    expect(idx.lines.size).toBe(0);
    expect(idx.leafLocations.size).toBe(0);
  });

  it('maps each leaf to its declaration line and colours single-field lines', () => {
    const models = new Map([
      model('S', [leaf('a', 'S', 0), leaf('b', 'S', 32, { colorClass: 'c-2' })]),
    ]);
    const fields = [fieldLoc('S', 'a', 2), fieldLoc('S', 'b', 3)];
    const idx = buildLineIndex(models, fields);

    expect([...idx.lines.keys()].sort((x, y) => x - y)).toEqual([2, 3]);
    // A single field on its own line gets that leaf's colour.
    expect(idx.lines.get(2)!.colorClass).toBe('c-1');
    expect(idx.lines.get(3)!.colorClass).toBe('c-2');
    expect(idx.lines.get(2)!.members).toEqual([{ record: 'S', leaf: 0 }]);
    expect(idx.leafLocations.get('S')!.get(0)!.line).toBe(2);
  });

  it('a line declaring several fields marks each of them', () => {
    const models = new Map([
      model('S', [leaf('lo', 'S', 0), leaf('hi', 'S', 8, { colorClass: 'c-2' })]),
    ]);
    // `uint8_t lo, hi;` — two declarators, at their own columns.
    const fields = [fieldLoc('S', 'lo', 5, { col: 11 }), fieldLoc('S', 'hi', 5, { col: 15 })];
    const idx = buildLineIndex(models, fields);
    const l = idx.lines.get(5)!;
    expect(l.members).toHaveLength(2);
    expect(l.marks.map((m) => m.colorClass)).toEqual(['c-1', 'c-2']);
    // The line as a whole has no single colour.
    expect(l.colorClass).toBe('c-compound');
  });

  it('a group on a line yields the ring and subsumes its leaves', () => {
    const leaves = [leaf('kind', 'Header', 0), leaf('len', 'Header', 16)];
    const groups = [group('hdr', 'Message', [0, 1])];
    const models = new Map([model('Message', leaves, groups)]);
    // hdr declared on line 15; kind/len are in Header's own dump (lines 4/5) but
    // here they resolve into Message via the group.
    const fields = [
      fieldLoc('Message', 'hdr', 15),
      fieldLoc('Header', 'kind', 4),
      fieldLoc('Header', 'len', 5),
    ];
    const idx = buildLineIndex(models, fields);
    const l15 = idx.lines.get(15)!;
    // A compound member is one unit, so it carries the colour its leaves share.
    expect(l15.colorClass).toBe('c-1');
    // The group highlights both of its leaves.
    expect(l15.members.map((m) => m.leaf).sort()).toEqual([0, 1]);
    expect(idx.groupLocations.get('Message')!.get(0)!.line).toBe(15);
  });

  it('the same field across two record models highlights in both', () => {
    // `kind` appears both in Header (as a top-level field) and nested in Message.
    const header = model('Header', [leaf('kind', 'Header', 0)]);
    const message = model('Message', [leaf('kind', 'Header', 0)], [group('hdr', 'Message', [0])]);
    const models = new Map([header, message]);
    const fields = [fieldLoc('Header', 'kind', 4), fieldLoc('Message', 'hdr', 15)];
    const idx = buildLineIndex(models, fields);
    // Line 4 (kind's declaration) highlights the member in *both* records.
    const l4 = idx.lines.get(4)!;
    expect(l4.members.map((m) => m.record).sort()).toEqual(['Header', 'Message']);
    // …but the colour reflects Header's single-field line, not a ring.
    expect(l4.colorClass).toBe('c-1');
  });
});

describe('marks (several declarators on one line)', () => {
  // `uint8_t lo, hi;` — two members, two marks, distinct colours.
  const models = new Map([
    model('S', [leaf('lo', 'S', 0), leaf('hi', 'S', 8, { colorClass: 'c-7' })]),
  ]);
  const fields = [fieldLoc('S', 'lo', 5, { col: 11 }), fieldLoc('S', 'hi', 5, { col: 15 })];
  const idx = buildLineIndex(models, fields);
  const l5 = idx.lines.get(5)!;

  it('gives each declarator its own mark, left to right, keeping its colour', () => {
    expect(l5.marks.map((m) => [m.col, m.colorClass])).toEqual([
      [11, 'c-1'],
      [15, 'c-7'],
    ]);
    expect(l5.marks.map((m) => m.members)).toEqual([
      [{ record: 'S', leaf: 0 }],
      [{ record: 'S', leaf: 1 }],
    ]);
  });

  it('the line as a whole still has no single colour', () => {
    expect(l5.colorClass).toBe('c-compound');
  });

  it('a column resolves to the declarator it falls in', () => {
    expect(markAtColumn(l5, 11)!.col).toBe(11);
    expect(markAtColumn(l5, 14)!.col).toBe(11); // inside `lo`, before `hi`
    expect(markAtColumn(l5, 15)!.col).toBe(15);
    expect(markAtColumn(l5, 99)!.col).toBe(15); // past the last one
    expect(markAtColumn(l5, 1)!.col).toBe(11); // before the first: the leading one
  });

  it('a single-declarator line is one forgiving hit area', () => {
    const one = buildLineIndex(new Map([model('S', [leaf('a', 'S', 0)])]), [
      fieldLoc('S', 'a', 2, { col: 12 }),
    ]);
    const info = one.lines.get(2)!;
    expect(info.marks).toHaveLength(1);
    expect(markAtColumn(info, 1)!.col).toBe(12); // anywhere on the line hits it
    expect(markAtColumn(info, 80)!.col).toBe(12);
  });

  it('a compound member is one mark covering all of its leaves', () => {
    const leaves = [leaf('kind', 'Header', 0), leaf('len', 'Header', 16)];
    const groups = [group('hdr', 'Message', [0, 1])];
    const m = new Map([model('Message', leaves, groups)]);
    const idx2 = buildLineIndex(m, [fieldLoc('Message', 'hdr', 15, { col: 17 })]);
    const marks = idx2.lines.get(15)!.marks;
    expect(marks).toHaveLength(1);
    // One unit, one colour — shared with everything inside it.
    expect(marks[0]!.colorClass).toBe('c-1');
    expect(marks[0]!.members.map((x) => x.leaf).sort()).toEqual([0, 1]);
  });
});

describe('collectMemberAligns', () => {
  it('keys explicit alignments by "<owner> <field>"', () => {
    const fields = [
      fieldLoc('S', 'a', 1, { alignAttr: 16 }),
      fieldLoc('S', 'b', 2), // no attr
    ];
    const aligns = collectMemberAligns(fields);
    expect(aligns.get('S a')).toBe(16);
    expect(aligns.has('S b')).toBe(false);
  });
});
