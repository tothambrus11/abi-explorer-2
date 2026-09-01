import { describe, it, expect } from 'vitest';
import { toWireResponse, type HyloAnswer } from '$compiler/hylo-wire';
import { toAnalysis } from '$compiler/AbiAnalyzer';
import { DEFAULT_OPTIONS } from '$core/options';

const hylo = { ...DEFAULT_OPTIONS, lang: 'hylo' as const, std: '', triple: 'hylo' };

/** Hylo stores members by decreasing alignment, so `x` is declared first and stored last. */
const PAIR: HyloAnswer = {
  layouts: [
    {
      type: 'Pair',
      size: 9,
      alignment: 8,
      isEnum: false,
      site: { line: 1, column: 8, endLine: 4, endColumn: 2 },
      parts: [
        {
          name: 'x',
          type: 'i8',
          offset: 8,
          size: 1,
          alignment: 1,
          site: { line: 2, column: 7, endLine: 2, endColumn: 8 },
        },
        {
          name: 'y',
          type: 'i64',
          offset: 0,
          size: 8,
          alignment: 8,
          site: { line: 3, column: 7, endLine: 3, endColumn: 8 },
        },
      ],
    },
  ],
  diagnostics: [],
};

describe('toWireResponse', () => {
  it('reports a struct with its members at the offsets Hylo gave them', () => {
    const record = toWireResponse(PAIR, 'Hylo (wasm)').records[0]!;
    expect(record.kind).toBe('struct');
    expect(record.sizeBits).toBe(72);
    expect(record.alignBits).toBe(64);
    expect(record.render.leaves.map((l) => [l.name, l.offsetBits])).toEqual([
      ['x', 64],
      ['y', 0],
    ]);
  });

  it('reports the equal footprints Hylo has no separate notion of', () => {
    // A record whose data size differed from its size would be listed as a
    // surprise in the summary. Hylo has no bases, so there is no surprise.
    const record = toWireResponse(PAIR, 'v').records[0]!;
    expect(record.dataSizeBits).toBe(record.sizeBits);
    expect(record.nonVirtualSizeBits).toBe(record.sizeBits);
    expect(record.preferredAlignBits).toBe(record.alignBits);
  });

  it('carries each declaration site through, so the editor can be pointed at it', () => {
    const record = toWireResponse(PAIR, 'v').records[0]!;
    expect(record.location).toEqual({
      file: '',
      line: 1,
      col: 8,
      endCol: 2,
      isMainFile: true,
    });
    expect(record.render.leaves[0]!.location?.line).toBe(2);
  });

  it('treats a type with no site as one the user did not write', () => {
    // A cursor can reach a standard library type, which the queried source
    // does not declare and the editor cannot show.
    const answer: HyloAnswer = {
      layouts: [{ type: 'Int', size: 8, alignment: 8, isEnum: false, parts: [] }],
    };
    expect(toWireResponse(answer, 'v').records[0]!.isUserCode).toBe(false);
    expect(toWireResponse(PAIR, 'v').records[0]!.isUserCode).toBe(true);
  });

  it('finds the bytes no member covers', () => {
    // Pair is 9 bytes: i64 at 0, i8 at 8, and nothing in between. A record
    // with a hole has one; this one does not.
    expect(toWireResponse(PAIR, 'v').records[0]!.render.paddingRuns).toEqual([]);

    const holed: HyloAnswer = {
      layouts: [
        {
          type: 'Holed',
          size: 8,
          alignment: 4,
          isEnum: false,
          site: { line: 1, column: 1, endLine: 1, endColumn: 2 },
          parts: [
            { name: 'a', type: 'i32', offset: 0, size: 4, alignment: 4 },
            { name: 'b', type: 'i8', offset: 6, size: 1, alignment: 1 },
          ],
        },
      ],
    };
    const record = toWireResponse(holed, 'v').records[0]!;
    expect(record.render.paddingRuns).toEqual([
      { startBits: 32, endBits: 48 },
      { startBits: 56, endBits: 64 },
    ]);
    expect(record.render.paddingBytes).toBe(3);
  });

  it('names an enum an enum, and overlaps its payloads but not its tag', () => {
    const answer: HyloAnswer = {
      layouts: [
        {
          type: 'Choice',
          size: 3,
          alignment: 2,
          isEnum: true,
          site: { line: 1, column: 6, endLine: 4, endColumn: 2 },
          parts: [
            { name: 'some', type: '{i16}', offset: 0, size: 2, alignment: 2 },
            { name: 'none', type: 'Void', offset: 0, size: 0, alignment: 1 },
            { name: 'discriminator', type: 'i8', offset: 2, size: 1, alignment: 1 },
          ],
        },
      ],
    };
    const record = toWireResponse(answer, 'v').records[0]!;
    // Drawn like a union, called what Hylo calls it.
    expect(record.kind).toBe('enum');
    expect(record.render.tree.map((n) => n.overlaps)).toEqual([true, true, false]);
    // A `Void` payload occupies nothing, so nothing is drawn for it.
    expect(record.render.leaves[1]!.sharesAddress).toBe(true);
  });

  it('reports diagnostics where the source has them', () => {
    const answer: HyloAnswer = {
      layouts: [],
      diagnostics: [
        {
          level: 'error',
          message: "undefined symbol 'Nonexistent'",
          site: { line: 2, column: 10, endLine: 2, endColumn: 21 },
        },
      ],
    };
    const response = toWireResponse(answer, 'v');
    expect(response.exitCode).toBe(1);
    expect(response.diagnostics[0]!.severity).toBe('error');
    expect(response.diagnostics[0]!.location?.line).toBe(2);

    // And the analyzer turns them into what the editor underlines.
    const analysis = toAnalysis(response, 'x', hylo);
    expect(analysis.diagnostics).toEqual([
      {
        line: 2,
        column: 10,
        endColumn: 21,
        severity: 'error',
        message: "undefined symbol 'Nonexistent'",
      },
    ]);
  });

  it('passes a module-level failure through as an unsuccessful response', () => {
    const response = toWireResponse({ error: 'the standard library has not been loaded' }, 'v');
    expect(response.ok).toBe(false);
    expect(response.exitCode).toBe(1);
    expect(response.records).toEqual([]);
  });

  it('draws a record-typed member as one member holding its own', () => {
    // The divergence this fixes: a flat list of offsets cannot say what
    // contains what, so a nested member was drawn as members side by side.
    const answer: HyloAnswer = {
      layouts: [
        {
          type: 'Outer',
          size: 16,
          alignment: 4,
          isEnum: false,
          site: { line: 1, column: 8, endLine: 4, endColumn: 2 },
          parts: [
            {
              name: 'x',
              type: 'Inner',
              offset: 0,
              size: 8,
              alignment: 4,
              parts: [
                { name: 'a', type: 'i32', offset: 0, size: 4, alignment: 4 },
                { name: 'b', type: 'i32', offset: 4, size: 4, alignment: 4 },
              ],
            },
            {
              name: 'y',
              type: 'Inner',
              offset: 8,
              size: 8,
              alignment: 4,
              parts: [
                { name: 'a', type: 'i32', offset: 8, size: 4, alignment: 4 },
                { name: 'b', type: 'i32', offset: 12, size: 4, alignment: 4 },
              ],
            },
          ],
        },
      ],
    };

    const record = toWireResponse(answer, 'v').records[0]!;
    // Two groups, one per member, each holding the two leaves of its type.
    expect(record.render.groups.map((g) => [g.name, g.type])).toEqual([
      ['x', 'Inner'],
      ['y', 'Inner'],
    ]);
    expect(record.render.tree.map((n) => n.kind)).toEqual(['group', 'group']);
    expect(record.render.tree[0]!.children.map((n) => n.kind)).toEqual(['leaf', 'leaf']);
    expect(record.render.groups[0]!.leafIndexes).toEqual([0, 1]);
    expect(record.render.groups[1]!.leafIndexes).toEqual([2, 3]);

    // A leaf's path names what encloses it, not itself: the table indents by
    // it, and a member listed under its own name is indented under itself.
    expect(record.render.leaves.map((l) => l.path.join('.'))).toEqual(['x', 'x', 'y', 'y']);
    expect(record.render.groups.map((g) => g.path)).toEqual([[], []]);
    expect(record.render.leaves.map((l) => l.offsetBits)).toEqual([0, 32, 64, 96]);
    // Every byte is covered by a leaf, so nothing reads as padding.
    expect(record.render.paddingRuns).toEqual([]);
  });

  it('marks a nested enum as the union it is drawn like', () => {
    const answer: HyloAnswer = {
      layouts: [
        {
          type: 'Holder',
          size: 3,
          alignment: 2,
          isEnum: false,
          site: { line: 1, column: 8, endLine: 3, endColumn: 2 },
          parts: [
            {
              name: 'c',
              type: 'Choice',
              offset: 0,
              size: 3,
              alignment: 2,
              isEnum: true,
              parts: [
                { name: 'some', type: '{i16}', offset: 0, size: 2, alignment: 2 },
                { name: 'none', type: 'Void', offset: 0, size: 0, alignment: 1 },
                { name: 'discriminator', type: 'i8', offset: 2, size: 1, alignment: 1 },
              ],
            },
          ],
        },
      ],
    };

    const record = toWireResponse(answer, 'v').records[0]!;
    expect(record.render.groups[0]!.isUnion).toBe(true);
    // The cases overlap; the discriminator after them does not.
    expect(record.render.tree[0]!.children.map((n) => n.overlaps)).toEqual([true, true, false]);
  });

  it('produces an analysis the views can draw', () => {
    const analysis = toAnalysis(toWireResponse(PAIR, 'Hylo (wasm)'), 'source', hylo);
    expect(analysis.records).toHaveLength(1);
    const [entry] = analysis.records;
    expect(entry!.listed).toBe(true);
    expect(entry!.record.sizeBytes).toBe(9);
    expect(entry!.model.leaves.map((l) => l.name)).toEqual(['x', 'y']);
    // Colours are assigned by the model builder; a member without one would
    // be drawn as a hole in the grid.
    expect(entry!.model.leaves.map((l) => l.colorClass)).toEqual(['c-1', 'c-2']);
  });
});
