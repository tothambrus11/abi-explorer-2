import { describe, it, expect } from 'vitest';
import { buildLineIndex, collectMemberAligns } from '$state/code-locations';
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

  it('a line with several fields gets the neutral ring', () => {
    const models = new Map([model('S', [leaf('lo', 'S', 0), leaf('hi', 'S', 8)])]);
    // both declared on line 5 (e.g. `uint8_t lo, hi;`)
    const fields = [fieldLoc('S', 'lo', 5), fieldLoc('S', 'hi', 5)];
    const idx = buildLineIndex(models, fields);
    const l = idx.lines.get(5)!;
    expect(l.colorClass).toBe('c-compound');
    expect(l.members).toHaveLength(2);
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
    expect(l15.colorClass).toBe('c-compound');
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
