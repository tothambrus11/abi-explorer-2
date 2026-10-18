import { describe, expect, it } from 'vitest';
import { typeNameAt } from '../../src/layout/typeNameAt.ts';

const spellingAt = (text: string, character: number) =>
  typeNameAt(text, 0, character)?.spelling ?? null;

describe('typeNameAt', () => {
  it('takes the qualifiers before a name and the template arguments after it', () => {
    expect(spellingAt('  std::vector<std::pair<int, char>> values;', 9)).toBe(
      'std::vector<std::pair<int, char>>',
    );
    expect(spellingAt('  std::vector<std::pair<int, char>> values;', 3)).toBe('std');
    expect(spellingAt('sizeof(::ns::Shape)', 14)).toBe('ns::Shape');
    expect(spellingAt('Pair <short> narrow;', 0)).toBe('Pair <short>');
  });

  it('gives the range of what it read', () => {
    expect(typeNameAt('Packet p;', 3, 6)?.range).toEqual({
      start: { line: 3, character: 0 },
      end: { line: 3, character: 6 },
    });
  });

  it('reads nothing off a name', () => {
    expect(spellingAt('a + b;', 2)).toBeNull();
    expect(spellingAt('x = 42;', 5)).toBeNull();
  });
});
