import { describe, it, expect } from 'vitest';
import { effectiveLine, hoveredPrimary, resolveHover, type HoverInputs } from '$state/hover';
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
    mouseLine: null,
    cursorLine: null,
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

describe('effectiveLine', () => {
  it('prefers the mouse, falling back to the cursor', () => {
    expect(effectiveLine({ mouseLine: 3, cursorLine: 9, preferCursor: false })).toBe(3);
    expect(effectiveLine({ mouseLine: null, cursorLine: 9, preferCursor: false })).toBe(9);
  });
  it('prefers the cursor after a keyboard move, falling back to the mouse', () => {
    expect(effectiveLine({ mouseLine: 3, cursorLine: 9, preferCursor: true })).toBe(9);
    expect(effectiveLine({ mouseLine: 3, cursorLine: null, preferCursor: true })).toBe(3);
  });
});

describe('resolveHover', () => {
  it('is empty with no pointer, cursor or intent', () => {
    expect(resolveHover(inputs())).toEqual({
      members: [],
      line: null,
      inlay: null,
      tooltip: null,
    });
  });

  it('resolves an editor line to its members and inlay', () => {
    const h = resolveHover(inputs({ mouseLine: 7 }));
    expect(h.members).toEqual([{ record: 'S', leaf: 0 }]);
    expect(h.line).toBe(7);
    expect(h.inlay).toBe('offset 0 B · 4 B · align 4 B');
    expect(h.tooltip).toBeNull();
  });

  it('a leaf intent wins over the editor and carries its tooltip', () => {
    const tooltip = { html: 'x', x: 1, y: 2 };
    const h = resolveHover(
      inputs({ mouseLine: 7, intent: { kind: 'leaf', record: 'S', leaf: 1, tooltip } }),
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
    expect(h).toEqual({ members: [], line: null, inlay: null, tooltip: null });
  });

  it('an intent for a record that no longer exists resolves to nothing', () => {
    const h = resolveHover(
      inputs({ intent: { kind: 'leaf', record: 'Gone', leaf: 0, tooltip: null } }),
    );
    expect(h.members).toEqual([]);
  });
});

describe('hoveredPrimary', () => {
  it('is the declaring record of the hovered line', () => {
    expect(hoveredPrimary(inputs({ mouseLine: 7 }))).toBe('S');
  });
  it('is null for grid/table hovers (they never switch the tab)', () => {
    expect(
      hoveredPrimary(
        inputs({ mouseLine: 7, intent: { kind: 'leaf', record: 'S', leaf: 0, tooltip: null } }),
      ),
    ).toBeNull();
  });
  it('is null off any known line', () => {
    expect(hoveredPrimary(inputs({ mouseLine: 99 }))).toBeNull();
  });
});
