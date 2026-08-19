// The editor's decorations as a value: what Monaco should be showing, derived
// from the store rather than computed inside effects. Pure so it can be tested
// without a DOM; `EditorPane` only syncs the result into Monaco.

import type { LineInfo } from './code-locations';

export interface MemberDot {
  line: number;
  /** 1-based column of the member's name. */
  col: number;
  colorClass: string;
}

/**
 * One circle per member declarator, for the records currently on screen (the
 * active one in tabs mode, all of them when stacked).
 *
 * A filled circle carries the field's own colour; a compound member — a nested
 * record or base, whose bytes belong to several differently-coloured leaves —
 * gets the neutral ring instead, since no single colour represents it. Each
 * mark already knows which, computed from the *declaring* record's items.
 */
export function memberDots(lines: Iterable<LineInfo>, shown: ReadonlySet<string>): MemberDot[] {
  const dots: MemberDot[] = [];
  for (const l of lines) {
    for (const mark of l.marks) {
      // A circle marks a member of a record on screen — not a field that merely
      // lives inside one of its compound members.
      if (!mark.directRecords.some((r) => shown.has(r))) continue;
      dots.push({ line: l.line, col: mark.col, colorClass: mark.colorClass });
    }
  }
  return dots;
}
