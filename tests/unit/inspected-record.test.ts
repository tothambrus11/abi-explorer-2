import { describe, it, expect } from 'vitest';
import { recordsAtLine } from '$state/inspected-record';
import type { DeclLocation } from '$core/ast-locations';
import type { RenderModel } from '$core/types';

const model = (name: string): RenderModel =>
  ({
    record: { name },
    leaves: [],
    groups: [],
    markers: [],
    paddings: [],
    sizeBits: 0,
    paddingBytes: 0,
    unresolved: [],
  }) as unknown as RenderModel;

const models = (...names: [key: string, recordName: string][]) =>
  new Map(names.map(([k, n]) => [k, model(n)]));

const rec = (name: string, begin: number, end: number): DeclLocation => ({
  kind: 'record',
  name,
  line: begin,
  col: 8,
  span: { begin, end },
});

// struct Outer {            // 2
//   struct Inner { … };     // 3..5
//   int x;                  // 6
// };                        // 7
const nested = [rec('Outer', 2, 7), rec('Inner', 3, 5)];
const nestedModels = models(['struct Outer', 'Outer'], ['struct Inner', 'Outer::Inner']);

describe('recordsAtLine', () => {
  it('is empty outside every declaration', () => {
    expect(recordsAtLine(1, nested, nestedModels)).toEqual([]);
    expect(recordsAtLine(9, nested, nestedModels)).toEqual([]);
  });

  it('resolves the innermost record first', () => {
    expect(recordsAtLine(4, nested, nestedModels)).toEqual(['struct Inner', 'struct Outer']);
    expect(recordsAtLine(6, nested, nestedModels)).toEqual(['struct Outer']);
  });

  it('includes both boundary lines (the caret touches either side)', () => {
    expect(recordsAtLine(3, nested, nestedModels)[0]).toBe('struct Inner');
    expect(recordsAtLine(5, nested, nestedModels)[0]).toBe('struct Inner');
    expect(recordsAtLine(2, nested, nestedModels)).toEqual(['struct Outer']);
    expect(recordsAtLine(7, nested, nestedModels)).toEqual(['struct Outer']);
  });

  it('returns every instantiation of a template that shares one span', () => {
    const decls = [rec('Pair', 1, 3)];
    const m = models(['struct Pair<int>', 'Pair<int>'], ['struct Pair<char>', 'Pair<char>']);
    expect(recordsAtLine(2, decls, m).sort()).toEqual(['struct Pair<char>', 'struct Pair<int>']);
  });
});
