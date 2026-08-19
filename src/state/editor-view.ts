// The editor's decorations as a value: what Monaco should be showing, derived
// from the store rather than computed inside effects. Pure so it can be tested
// without a DOM; `EditorPane` only syncs the result into Monaco.

import type { RenderModel } from '$core/types';
import type { LineInfo } from './code-locations';

export interface MemberDot {
  line: number;
  colorClass: string;
}

/** Colour used when no single field owns the line (a container, or several fields). */
export const COMPOUND_DOT = 'c-compound';

/**
 * Gutter dots for the records currently on screen (the active one in tabs mode,
 * all of them when stacked).
 *
 * A filled dot means the line declares exactly one byte-occupying field, in
 * that record's palette. A container line — a compound member, or several
 * fields sharing the line — has no single colour, so it gets the neutral ring.
 * The single-field test reads `items` (what the declaring record has on that
 * line), never `members`: the same field recurs in every record it nests in, so
 * counting members would make every line look compound in stacked view.
 */
export function memberDots(
  lines: Iterable<LineInfo>,
  models: Map<string, RenderModel>,
  shown: ReadonlySet<string>,
): MemberDot[] {
  const dots: MemberDot[] = [];
  for (const l of lines) {
    const here = l.members.find((m) => shown.has(m.record));
    if (!here) continue;
    const item = l.items.length === 1 ? l.items[0]! : null;
    const singleField = item !== null && !('leafIndexes' in item);
    const colorClass = singleField
      ? (models.get(here.record)?.leaves[here.leaf]?.colorClass ?? COMPOUND_DOT)
      : COMPOUND_DOT;
    dots.push({ line: l.line, colorClass });
  }
  return dots;
}
