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

  it('draws an enum as a union whose payloads overlap and whose tag does not', () => {
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
    expect(record.kind).toBe('union');
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
