// What each source line declares, for the editor's gutter dots, line highlight
// and inlay hints.
//
// This used to be a matching problem. Member locations arrived from a separate
// `-ast-dump=json` run, keyed by printed owner and field name, and had to be
// joined back to the layout by comparing those names through elaborated
// specifiers, anonymous-namespace qualifiers and template arguments. Every
// item now carries its own location, so the join is gone and what is left is
// the grouping: which records share a declarator, and which declarator a
// column falls in.

import { anchorOf, type Anchor, type Group, type Leaf, type RenderModel } from '$core/types';
import { groupColorClass, sharedColorClass } from '$core/render';
import type { MemberRef } from './store.svelte';

/** No single colour stands for this mark. */
export const COMPOUND = 'c-compound';

/**
 * One declarator written on a line: `uint8_t lo, hi;` has two marks, a nested
 * `struct Header hdr;` has one (covering all of hdr's leaves).
 */
export interface MemberMark {
  /** 1-based column of the member's name. */
  col: number;
  /** 1-based column just past the name, for the strong highlight. */
  endCol: number;
  /** Members to highlight for this mark (across records). */
  members: MemberRef[];
  /** Items from the declaring record (a group, or one leaf). */
  items: (Leaf | Group)[];
  /** The colour of the direct member this declarator introduces, per record. */
  colorClass: string;
  /**
   * The colour each record in `directRecords` gives this declarator.
   *
   * One line, several answers: `int b;` inside `struct B` is a member of `B`
   * and of everything that inherits it, and each of them colours its own
   * members independently. A gutter dot has to say what the *picture on
   * screen* says, so it picks the colour of the record being shown. Otherwise
   * a field the grid paints gold gets a blue dot, which is what happened as
   * soon as inherited members stopped sharing their base's colour.
   */
  colorByRecord: Record<string, string>;
  /**
   * Records for which this declarator is a *directly nameable* member: a field
   * of the record itself, or one injected by an anonymous aggregate. Only these
   * earn a circle: what lives inside a compound member is seen by inspecting
   * that member's own record.
   */
  directRecords: string[];
}

/** Everything the editor needs to know about one source line. */
export interface LineInfo {
  line: number;
  /** Members to highlight when this line is hovered (across all visible records). */
  members: MemberRef[];
  /** Items (leaves/groups) declared on this line, from the primary record. */
  items: (Leaf | Group)[];
  /** Record that declares the line as a direct member, for dot colour and auto-select. */
  primary: string;
  /**
   * Gutter-dot colour: a single leaf's colour when the line carries exactly one
   * byte-occupying field, else `c-compound` (a neutral ring), since a line holding a
   * container (nested record / base) has no colour of its own.
   */
  colorClass: string;
  /** Where the primary declarator's name is written, for the type hover. */
  anchor: Anchor;
  /** Per-declarator marks, left to right; several when a line declares several members. */
  marks: MemberMark[];
}

/** The mark a column falls in: each mark owns from its own column to the next one. */
export function markAtColumn(info: LineInfo, col: number): MemberMark | null {
  const marks = info.marks;
  if (marks.length === 0) return null;
  if (marks.length === 1) return marks[0]!; // the whole line is one forgiving hit area
  let found = marks[0]!;
  for (const m of marks) {
    if (m.col <= col) found = m;
    else break;
  }
  return found;
}

export type LineIndex = Map<number, LineInfo>;

/**
 * The colour standing for a declarator: a field's own colour, or the colour a
 * compound member's leaves share. A unit spanning several colours, such as an
 * anonymous aggregate whose fields are members in their own right, has none
 * and shows the neutral ring instead.
 */
function markColour(model: RenderModel, items: (Leaf | Group)[], leaves: Set<number>): string {
  const first = items[0];
  if (!first) return COMPOUND;
  if (!('leafIndexes' in first)) return first.colorClass ?? COMPOUND;
  // One definition of "the colour this member stands for", shared with the
  // field table, including the parts where a vtable pointer does not count as
  // a second colour, and where a base has no colour of its own because its
  // members have their own. Two copies of this rule is how the grid, the table
  // and the gutter came to disagree about every polymorphic base.
  if (items.length === 1) return groupColorClass(model, first) ?? COMPOUND;
  return sharedColorClass(model, leaves) ?? COMPOUND;
}

/** Map the visible render models to a per-line index for the editor. */
export function buildLineIndex(models: Map<string, RenderModel>): LineIndex {
  /** One declarator of one record, keyed by (line, column). */
  interface Cell {
    record: string;
    /** The declarator names a member of `record`: its own, or one it inherits. */
    direct: boolean;
    /**
     * `record` is where the declarator is *written*. A base's field is a direct
     * member of every record that inherits it, so several records claim the
     * line; the one that declares it owns it, and keeps the line pointing at
     * the record a reader is looking at when the caret lands there.
     */
    own: boolean;
    items: (Leaf | Group)[];
    leaves: Set<number>;
    anchor: Anchor;
  }
  /** line -> "col\0record" -> cell */
  const byLine = new Map<number, Map<string, Cell>>();

  for (const [key, model] of models) {
    const cellAt = (anchor: Anchor): Cell => {
      let line = byLine.get(anchor.line);
      if (!line) byLine.set(anchor.line, (line = new Map<string, Cell>()));
      const ck = `${anchor.col}\0${key}`;
      let cell = line.get(ck);
      if (!cell) {
        line.set(
          ck,
          (cell = { record: key, direct: false, own: false, items: [], leaves: new Set(), anchor }),
        );
      }
      return cell;
    };

    for (const g of model.groups) {
      const anchor = anchorOf(g.location);
      if (!anchor) continue;
      const cell = cellAt(anchor);
      for (const li of g.leafIndexes) cell.leaves.add(li);
      cell.items.push(g);
      if (g.direct) cell.direct = true;
      if (g.path.length === 0) cell.own = true;
    }

    model.leaves.forEach((leaf, li) => {
      const anchor = anchorOf(leaf.location);
      if (!anchor) return;
      // A group already covering this leaf *at this declarator* subsumes it, so
      // `struct Header hdr;` is one mark rather than one per nested field. The
      // leaf still marks its own declaration elsewhere (inside Header's own
      // definition), which is how one field highlights in several records.
      const existing = byLine.get(anchor.line)?.get(`${anchor.col}\0${key}`);
      if (existing?.items.some((it) => 'leafIndexes' in it && it.leafIndexes.includes(li))) return;
      const cell = cellAt(anchor);
      cell.leaves.add(li);
      cell.items.push(leaf);
      if (leaf.direct) cell.direct = true;
      if (leaf.path.length === 0) cell.own = true;
    });
  }

  const lines: LineIndex = new Map();
  for (const [line, cells] of byLine) {
    const all = [...cells.values()];
    const primary = all.find((c) => c.direct && c.own) ?? all.find((c) => c.direct) ?? all[0]!;

    // Marks: one per column, merging the records that share that declarator.
    const byCol = new Map<number, Cell[]>();
    for (const c of all) {
      const list = byCol.get(c.anchor.col) ?? [];
      list.push(c);
      byCol.set(c.anchor.col, list);
    }
    const marks: MemberMark[] = [...byCol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, group]) => {
        // Colour comes from a record that declares this member directly; every
        // leaf of a unit shares one colour, so a compound member has one too.
        const owner =
          group.find((c) => c.direct && c.own) ?? group.find((c) => c.direct) ?? group[0]!;
        const model = models.get(owner.record);
        const colorByRecord: Record<string, string> = {};
        for (const c of group) {
          if (!c.direct) continue;
          const m = models.get(c.record);
          if (m) colorByRecord[c.record] = markColour(m, c.items, c.leaves);
        }
        return {
          col,
          endCol: Math.max(owner.anchor.endCol, col + 1),
          members: group.flatMap((c) => [...c.leaves].map((leaf) => ({ record: c.record, leaf }))),
          items: owner.items,
          colorClass: model ? markColour(model, owner.items, owner.leaves) : COMPOUND,
          colorByRecord,
          directRecords: group.filter((c) => c.direct).map((c) => c.record),
        };
      });

    lines.set(line, {
      line,
      members: marks.flatMap((m) => m.members),
      items: primary.items,
      primary: primary.record,
      // The line as a whole: one mark keeps its colour, several never do.
      colorClass: marks.length === 1 ? marks[0]!.colorClass : COMPOUND,
      anchor: primary.anchor,
      marks,
    });
  }
  return lines;
}
