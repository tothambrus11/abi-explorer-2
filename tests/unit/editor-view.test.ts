import { describe, it, expect } from 'vitest';
import { memberDots } from '$state/editor-view';
import type { LineInfo, MemberMark } from '$state/code-locations';

const mark = (
  col: number,
  colorClass: string,
  records: string[],
  directRecords = records,
): MemberMark => ({
  col,
  endCol: col + 3,
  members: records.map((record, i) => ({ record, leaf: i })),
  items: [],
  colorClass,
  colorByRecord: Object.fromEntries(directRecords.map((r) => [r, colorClass])),
  directRecords,
});
const line = (n: number, marks: MemberMark[]): LineInfo => ({
  line: n,
  members: marks.flatMap((m) => m.members),
  items: [],
  primary: 'S',
  colorClass: marks.length === 1 ? marks[0]!.colorClass : 'c-compound',
  anchor: { line: n, col: marks[0]?.col ?? 1, endCol: (marks[0]?.col ?? 1) + 1 },
  marks,
});

// The colours themselves are decided in buildLineIndex (see code-locations
// tests); memberDots only picks the marks that belong to what is on screen.
describe('memberDots', () => {
  it('emits one circle per declarator, at its column', () => {
    const lines = [line(5, [mark(11, 'c-1', ['S']), mark(15, 'c-7', ['S'])])];
    expect(memberDots(lines, new Set(['S']))).toEqual([
      { line: 5, col: 11, colorClass: 'c-1' },
      { line: 5, col: 15, colorClass: 'c-7' },
    ]);
  });

  it('carries the neutral ring a compound member was given', () => {
    const lines = [line(7, [mark(17, 'c-compound', ['S'])])];
    expect(memberDots(lines, new Set(['S']))).toEqual([
      { line: 7, col: 17, colorClass: 'c-compound' },
    ]);
  });

  it('skips marks whose records are not on screen', () => {
    const lines = [line(4, [mark(3, 'c-1', ['Other'])])];
    expect(memberDots(lines, new Set(['S']))).toEqual([]);
  });

  it('skips a mark that is only nested in the shown record', () => {
    // `kind` is declared in Header but merely lives inside Message's `hdr`.
    const lines = [line(4, [mark(12, 'c-1', ['Header', 'Message'], ['Header'])])];
    expect(memberDots(lines, new Set(['Message']))).toEqual([]);
    expect(memberDots(lines, new Set(['Header']))).toEqual([
      { line: 4, col: 12, colorClass: 'c-1' },
    ]);
  });

  it('keeps a mark shared by several records (stacked view)', () => {
    const lines = [line(4, [mark(12, 'c-1', ['S', 'Outer'])])];
    expect(memberDots(lines, new Set(['S', 'Outer']))).toEqual([
      { line: 4, col: 12, colorClass: 'c-1' },
    ]);
  });
});
