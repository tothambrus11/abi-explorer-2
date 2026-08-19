import { describe, it, expect } from 'vitest';
import { memberDots, COMPOUND_DOT } from '$state/editor-view';
import type { LineInfo } from '$state/code-locations';
import type { Group, Leaf, RenderModel } from '$core/types';

const leaf = (name: string, colorClass: string): Leaf => ({
  kind: 'field',
  row: {} as never,
  path: [],
  name,
  type: null,
  offsetBits: 0,
  sizeBits: 32,
  align: 4,
  estimated: false,
  depth: 0,
  owner: 'S',
  colorClass,
});
const group = (name: string, leafIndexes: number[]): Group => ({
  kind: 'member',
  name,
  type: '',
  owner: 'S',
  path: [],
  offsetBits: 0,
  sizeBits: 64,
  align: 8,
  leafIndexes,
  isBase: false,
  isUnion: false,
});
const model = (leaves: Leaf[], groups: Group[] = []): RenderModel => ({
  record: {} as never,
  leaves,
  groups,
  markers: [],
  paddings: [],
  sizeBits: 0,
  paddingBytes: 0,
  unresolved: [],
});
const line = (n: number, over: Partial<LineInfo>): LineInfo => ({
  line: n,
  members: [],
  items: [],
  primary: 'S',
  colorClass: 'c-1',
  location: null,
  ...over,
});

describe('memberDots', () => {
  const m = model([leaf('a', 'c-1'), leaf('b', 'c-2')], [group('g', [0, 1])]);
  const models = new Map([['S', m]]);

  it('gives a single-field line that field’s colour', () => {
    const lines = [line(4, { members: [{ record: 'S', leaf: 1 }], items: [m.leaves[1]!] })];
    expect(memberDots(lines, models, new Set(['S']))).toEqual([{ line: 4, colorClass: 'c-2' }]);
  });

  it('gives a container line (a group) the neutral ring', () => {
    const lines = [
      line(7, {
        members: [
          { record: 'S', leaf: 0 },
          { record: 'S', leaf: 1 },
        ],
        items: [m.groups[0]!],
      }),
    ];
    expect(memberDots(lines, models, new Set(['S']))).toEqual([
      { line: 7, colorClass: COMPOUND_DOT },
    ]);
  });

  it('gives a line declaring several fields the neutral ring', () => {
    const lines = [
      line(9, {
        members: [
          { record: 'S', leaf: 0 },
          { record: 'S', leaf: 1 },
        ],
        items: [m.leaves[0]!, m.leaves[1]!],
      }),
    ];
    expect(memberDots(lines, models, new Set(['S']))[0]!.colorClass).toBe(COMPOUND_DOT);
  });

  it('skips lines whose records are not on screen', () => {
    const lines = [line(4, { members: [{ record: 'Other', leaf: 0 }], items: [m.leaves[0]!] })];
    expect(memberDots(lines, models, new Set(['S']))).toEqual([]);
  });

  // The stacked-view regression: one field nested in several records yields
  // several member refs, but it is still a single field on its own line.
  it('stays filled when a field recurs across records (stacked view)', () => {
    const lines = [
      line(4, {
        members: [
          { record: 'S', leaf: 0 },
          { record: 'Outer', leaf: 3 },
        ],
        items: [m.leaves[0]!],
      }),
    ];
    expect(memberDots(lines, models, new Set(['S', 'Outer']))).toEqual([
      { line: 4, colorClass: 'c-1' },
    ]);
  });
});
