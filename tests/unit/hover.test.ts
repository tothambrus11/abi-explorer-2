import { describe, it, expect } from 'vitest';
import {
  EMPTY_HOVER,
  effectivePos,
  hoveredPrimary,
  resolveHover,
  type HoverInputs,
} from '$state/hover';
import type { LineInfo } from '$state/code-locations';
import { analysed, group, leaf as mkLeaf, loc, model, record } from './factories';

const leaf = (name: string, offsetBits: number, sizeBits: number, extra = {}) =>
  mkLeaf(name, { offsetBits, sizeBits, align: 4, ...extra });

function inputs(over: Partial<HoverInputs> = {}): HoverInputs {
  const m = model(
    [leaf('a', 0, 32, { location: loc(7) }), leaf('b', 32, 32, { location: loc(8) })],
    [group('g', [0, 1], { sizeBits: 64, align: 8, location: loc(5) })],
  );
  const lines = new Map<number, LineInfo>([
    [
      7,
      {
        line: 7,
        members: [{ record: 'S', leaf: 0 }],
        items: [m.leaves[0]!],
        primary: 'S',
        colorClass: 'c-1',
        anchor: { line: 7, col: 3, endCol: 4 },
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
    records: [],
    current: null,
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
    expect(resolveHover(inputs())).toEqual(EMPTY_HOVER);
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

  it('carries the hovered extent, so the grid can light bytes no member covers', () => {
    // The group spans eight bytes; whether a field happens to occupy each one
    // is not the question the pointer is asking.
    const h = resolveHover(
      inputs({ intent: { kind: 'group', record: 'S', group: 0, tooltip: null } }),
    );
    expect(h.ranges).toEqual([{ record: 'S', start: 0, end: 8 }]);
    // A leaf carries its own bytes, and nothing that occupies none carries any.
    expect(
      resolveHover(inputs({ intent: { kind: 'leaf', record: 'S', leaf: 1, tooltip: null } }))
        .ranges,
    ).toEqual([{ record: 'S', start: 4, end: 8 }]);
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
    expect(h).toEqual(EMPTY_HOVER);
  });

  it('an intent for a record that no longer exists resolves to nothing', () => {
    const h = resolveHover(
      inputs({ intent: { kind: 'leaf', record: 'Gone', leaf: 0, tooltip: null } }),
    );
    expect(h.members).toEqual([]);
  });
});

describe('resolveHover with an area intent', () => {
  // The byte map hovers regions, not members: a whole cell, or one bit of it.
  // Who is meant is whoever has bits there, which is several at once wherever
  // members overlap.
  const shared = () =>
    inputs({ models: new Map([['S', model([leaf('a', 0, 32), leaf('b', 0, 16)])]]) });

  it('names every member with bits in the area, so an overlap shows whole', () => {
    const h = resolveHover({
      ...shared(),
      intent: { kind: 'area', record: 'S', fromBit: 0, toBit: 8, tooltip: null },
    });
    expect(h.members).toEqual([
      { record: 'S', leaf: 0 },
      { record: 'S', leaf: 1 },
    ]);
    // Each member's whole extent lights, not just the hovered byte…
    expect(h.ranges).toEqual([
      { record: 'S', start: 0, end: 4 },
      { record: 'S', start: 0, end: 2 },
    ]);
    // …and several declarations are meant at once, so no single line is.
    expect(h.line).toBeNull();
    expect(h.nameRange).toBeNull();
  });

  it("an area one member occupies is that member's own hover", () => {
    // Bytes 2..3 are a's alone; hovering there is hovering a.
    const viaArea = resolveHover({
      ...shared(),
      intent: { kind: 'area', record: 'S', fromBit: 16, toBit: 24, tooltip: null },
    });
    const viaLeaf = resolveHover({
      ...shared(),
      intent: { kind: 'leaf', record: 'S', leaf: 0, tooltip: null },
    });
    expect(viaArea).toEqual(viaLeaf);
  });

  it('never names a member that occupies nothing', () => {
    // An empty member sharing the address ([[no_unique_address]]) has an
    // offset in the area but no bits anywhere.
    const m = model([leaf('e', 0, 0, { sharesAddress: true }), leaf('a', 0, 32)]);
    const h = resolveHover({
      ...inputs({ models: new Map([['S', m]]) }),
      intent: { kind: 'area', record: 'S', fromBit: 0, toBit: 8, tooltip: null },
    });
    expect(h.members).toEqual([{ record: 'S', leaf: 1 }]);
  });

  it('an area nothing occupies keeps its tooltip and nothing else', () => {
    const gap = model([leaf('a', 0, 8), leaf('b', 32, 8)]); // padding at bytes 1..3
    const tooltip = { html: 'pad', x: 0, y: 0 };
    const h = resolveHover({
      ...inputs({ models: new Map([['S', gap]]) }),
      intent: { kind: 'area', record: 'S', fromBit: 8, toBit: 16, tooltip },
    });
    expect(h.members).toEqual([]);
    expect(h.ranges).toEqual([]);
    expect(h.tooltip).toBe(tooltip);
  });
});

describe('resolveHover with several declarators on a line', () => {
  // `uint8_t lo, hi;`: the column decides which one is meant.
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
          anchor: { line: 5, col: 11, endCol: 13 },
          marks: [
            {
              col: 11,
              endCol: 13,
              members: [{ record: 'S', leaf: 0 }],
              items: [m.leaves[0]!],
              colorClass: 'c-1',
              colorByRecord: { S: 'c-1' },
              directRecords: ['S'],
            },
            {
              col: 15,
              endCol: 17,
              members: [{ record: 'S', leaf: 1 }],
              items: [m.leaves[1]!],
              colorClass: 'c-2',
              colorByRecord: { S: 'c-2' },
              directRecords: ['S'],
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
  const spanning = (key: string, line: number, endLine: number) =>
    analysed(key, record(key, { range: { line, col: 1, endLine, endCol: 2 } }));

  it('falls back to the record whose declaration contains the cursor', () => {
    // Line 6 declares nothing, but it is inside `struct S { … }` (lines 4..9).
    const i = inputs({ mouse: { line: 6, col: 1 }, records: [spanning('S', 4, 9)] });
    expect(hoveredPrimary(i)).toBe('S');
  });

  it('prefers the record declaring a member on that line', () => {
    // Line 7 declares S's own member, and is inside another record's extent.
    const i = inputs({ mouse: at(7), records: [spanning('Outer', 1, 20)] });
    expect(hoveredPrimary(i)).toBe('S');
  });

  it('stays on the instantiation already shown when an extent is shared', () => {
    const i = inputs({
      mouse: { line: 6, col: 1 },
      records: [spanning('S', 4, 9), spanning('S<int>', 4, 9)],
      current: 'S<int>',
    });
    expect(hoveredPrimary(i)).toBe('S<int>');
  });

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
