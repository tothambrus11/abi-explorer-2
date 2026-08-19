import { describe, it, expect } from 'vitest';
import { declLineFor, recordsAtLine } from '$state/inspected-record';
import { analysed, record } from './factories';

const at = (key: string, name: string, line: number, endLine: number) =>
  analysed(
    key,
    record(name, {
      location: { file: 'input.cc', line, col: 8, endCol: 8 + name.length, isMainFile: true },
      range: { line, col: 1, endLine, endCol: 2 },
    }),
  );

// struct Outer {            // 2
//   struct Inner { … };     // 3..5
//   int x;                  // 6
// };                        // 7
const nested = [at('struct Outer', 'Outer', 2, 7), at('struct Inner', 'Outer::Inner', 3, 5)];

describe('recordsAtLine', () => {
  it('is empty outside every declaration', () => {
    expect(recordsAtLine(1, nested)).toEqual([]);
    expect(recordsAtLine(9, nested)).toEqual([]);
  });

  it('resolves the innermost record first', () => {
    expect(recordsAtLine(4, nested)).toEqual(['struct Inner', 'struct Outer']);
    expect(recordsAtLine(6, nested)).toEqual(['struct Outer']);
  });

  it('includes both boundary lines (the caret touches either side)', () => {
    expect(recordsAtLine(3, nested)[0]).toBe('struct Inner');
    expect(recordsAtLine(5, nested)[0]).toBe('struct Inner');
    expect(recordsAtLine(2, nested)).toEqual(['struct Outer']);
    expect(recordsAtLine(7, nested)).toEqual(['struct Outer']);
  });

  it('returns every instantiation of a template that shares one extent', () => {
    const both = [
      at('struct Pair<int>', 'Pair<int>', 1, 3),
      at('struct Pair<char>', 'Pair<char>', 1, 3),
    ];
    expect(recordsAtLine(2, both).sort()).toEqual(['struct Pair<char>', 'struct Pair<int>']);
  });

  it('ignores a record clang gave no extent for', () => {
    expect(recordsAtLine(2, [analysed('struct X', record('X'))])).toEqual([]);
  });
});

describe('declLineFor', () => {
  it('finds the line a record’s name is written on', () => {
    expect(declLineFor('struct Inner', nested)).toBe(3);
    expect(declLineFor('struct Outer', nested)).toBe(2);
  });

  it('is null for a record this analysis does not have', () => {
    expect(declLineFor('struct Gone', nested)).toBeNull();
    expect(declLineFor('struct Outer', [])).toBeNull();
  });
});
