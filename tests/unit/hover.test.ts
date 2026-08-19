import { describe, it, expect } from 'vitest';
import { effectivePos, hoveredPrimary, resolveHover, type HoverInputs } from '$state/hover';
import type { FieldLocation } from '$core/ast-locations';
import type { Group, Leaf, RenderModel } from '$core/types';
import type { LineInfo } from '$state/code-locations';

const leaf = (
  name: string,
  offsetBits: number,
  sizeBits: number,
  extra: Partial<Leaf> = {},
): Leaf => ({
  kind: 'field',
  row: {} as never,
  path: [],
  name,
  type: null,
  offsetBits,
  sizeBits,
  align: 4,
  estimated: false,
  depth: 0,
  owner: 'S',
  ...extra,
});
const group = (name: string, leafIndexes: number[], extra: Partial<Group> = {}): Group => ({
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
  ...extra,
});
const model = (leaves: Leaf[], groups: Group[] = []): RenderModel => ({
  record: { name: 'S' } as never,
  leaves,
  groups,
  markers: [],
  paddings: [],
  sizeBits: 0,
  paddingBytes: 0,
  unresolved: [],
});
const loc = (line: number): FieldLocation => ({
  owner: 'S',
  qualifiedOwner: 'S',
  name: 'x',
  line,
  col: 3,
  qualType: '',
});

function inputs(over: Partial<HoverInputs> = {}): HoverInputs {
  const m = model([leaf('a', 0, 32), leaf('b', 32, 32)], [group('g', [0, 1])]);
  const lines = new Map<number, LineInfo>([
    [
      7,
      {
        line: 7,
        members: [{ record: 'S', leaf: 0 }],
        items: [m.leaves[0]!],
        primary: 'S',
        colorClass: 'c-1',
        location: loc(7),
        marks: [],
      },
    ],
  ]);
  return {
    intent: null,
    mouse: null,
    cursor: null,
    preferCursor: false,
    models: new Map([['S', m]]),
    lines,
    leafLocations: new Map([
      [
        'S',
        new Map([
          [0, loc(7)],
          [1, loc(8)],
        ]),
      ],
    ]),
    groupLocations: new Map([['S', new Map([[0, loc(5)]])]]),
    ...over,
  };
}

const at = (line: number, col = 1) => ({ line, col });

describe('effectivePos', () => {
  it('prefers the mouse, falling back to the cursor', () => {
    expect(effectivePos({ mouse: at(3), cursor: at(9), preferCursor: false })).toEqual(at(3));
    expect(effectivePos({ mouse: null, cursor: at(9), preferCursor: false })).toEqual(at(9));
  });
  it('prefers the cursor after a keyboard move, falling back to the mouse', () => {
    expect(effectivePos({ mouse: at(3), cursor: at(9), preferCursor: true })).toEqual(at(9));
    expect(effectivePos({ mouse: at(3), cursor: null, preferCursor: true })).toEqual(at(3));
  });
});

describe('resolveHover', () => {
  it('is empty with no pointer, cursor or intent', () => {
    expect(resolveHover(inputs())).toEqual({
      members: [],
      line: null,
      nameRange: null,
      inlay: null,
      tooltip: null,
    });
  });

  it('resolves an editor line to its members and inlay', () => {
    const h = resolveHover(inputs({ mouse: at(7) }));
    expect(h.members).toEqual([{ record: 'S', leaf: 0 }]);
    expect(h.line).toBe(7);
    expect(h.inlay).toBe('offset 0 B · 4 B · align 4 B');
    expect(h.tooltip).toBeNull();
  });

  it('a leaf intent wins over the editor and carries its tooltip', () => {
    const tooltip = { html: 'x', x: 1, y: 2 };
    const h = resolveHover(
      inputs({ mouse: at(7), intent: { kind: 'leaf', record: 'S', leaf: 1, tooltip } }),
    );
    expect(h.members).toEqual([{ record: 'S', leaf: 1 }]);
    expect(h.line).toBe(8); // leaf 1's own declaration, not the hovered line
    expect(h.tooltip).toBe(tooltip);
  });

  it('a group intent highlights every leaf it covers and points at its own line', () => {
    const h = resolveHover(
      inputs({ intent: { kind: 'group', record: 'S', group: 0, tooltip: null } }),
    );
    expect(h.members).toEqual([
      { record: 'S', leaf: 0 },
      { record: 'S', leaf: 1 },
    ]);
    expect(h.line).toBe(5);
    expect(h.inlay).toBe('offset 0 B · 8 B · align 8 B');
  });

  it('a padding-cell intent shows only the tooltip', () => {
    const tooltip = { html: 'pad', x: 0, y: 0 };
    const h = resolveHover(inputs({ intent: { kind: 'tooltip', tooltip } }));
    expect(h.members).toEqual([]);
    expect(h.line).toBeNull();
    expect(h.tooltip).toBe(tooltip);
  });

  // The bug the intent model exists to prevent: an intent captured against an
  // older analysis must not resolve to an arbitrary member of the new one.
  it('a stale intent resolves to nothing rather than the wrong member', () => {
    const smaller = model([leaf('only', 0, 8)]);
    const h = resolveHover(
      inputs({
        models: new Map([['S', smaller]]),
        intent: { kind: 'leaf', record: 'S', leaf: 5, tooltip: null },
      }),
    );
    expect(h).toEqual({ members: [], line: null, nameRange: null, inlay: null, tooltip: null });
  });

  it('an intent for a record that no longer exists resolves to nothing', () => {
    const h = resolveHover(
      inputs({ intent: { kind: 'leaf', record: 'Gone', leaf: 0, tooltip: null } }),
    );
    expect(h.members).toEqual([]);
  });
});

describe('resolveHover with several declarators on a line', () => {
  // `uint8_t lo, hi;` — the column decides which one is meant.
  const twoMarks = () => {
    const m = model([leaf('lo', 0, 8), leaf('hi', 8, 8)]);
    const lines = new Map<number, LineInfo>([
      [
        5,
        {
          line: 5,
          members: [
            { record: 'S', leaf: 0 },
            { record: 'S', leaf: 1 },
          ],
          items: m.leaves,
          primary: 'S',
          colorClass: 'c-compound',
          location: loc(5),
          marks: [
            {
              col: 11,
              endCol: 13,
              members: [{ record: 'S', leaf: 0 }],
              items: [m.leaves[0]!],
              colorClass: 'c-1',
            },
            {
              col: 15,
              endCol: 17,
              members: [{ record: 'S', leaf: 1 }],
              items: [m.leaves[1]!],
              colorClass: 'c-2',
            },
          ],
        },
      ],
    ]);
    return inputs({ models: new Map([['S', m]]), lines });
  };

  it('picks the member the column falls in, and highlights its name', () => {
    const first = resolveHover({ ...twoMarks(), mouse: { line: 5, col: 12 } });
    expect(first.members).toEqual([{ record: 'S', leaf: 0 }]);
    expect(first.nameRange).toEqual({ line: 5, startCol: 11, endCol: 13 });

    const second = resolveHover({ ...twoMarks(), mouse: { line: 5, col: 16 } });
    expect(second.members).toEqual([{ record: 'S', leaf: 1 }]);
    expect(second.nameRange).toEqual({ line: 5, startCol: 15, endCol: 17 });
    // Each summarises only its own member.
    expect(first.inlay).not.toBe(second.inlay);
  });

  it('the caret between them belongs to the one it is past', () => {
    expect(resolveHover({ ...twoMarks(), mouse: { line: 5, col: 14 } }).members).toEqual([
      { record: 'S', leaf: 0 },
    ]);
  });
});

describe('hoveredPrimary', () => {
  it('is the declaring record of the hovered line', () => {
    expect(hoveredPrimary(inputs({ mouse: at(7) }))).toBe('S');
  });
  it('is null for grid/table hovers (they never switch the tab)', () => {
    expect(
      hoveredPrimary(
        inputs({ mouse: at(7), intent: { kind: 'leaf', record: 'S', leaf: 0, tooltip: null } }),
      ),
    ).toBeNull();
  });
  it('is null off any known line', () => {
    expect(hoveredPrimary(inputs({ mouse: at(99) }))).toBeNull();
  });
});
