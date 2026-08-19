// Pure helpers that turn AST field locations + render models into the editor's
// per-line index. Kept free of runes and store access so the mapping is unit
// tested directly; `session` owns the reactive wiring and the async dump.

import type { FieldLocation } from '$core/ast-locations';
import { matchItemsToLocations, unqualifiedName } from '$core/ast-locations';
import { isAnonymousRecord } from '$core/layout-parser';
import { findRecord, type RecordIndex } from '$core/probes';
import type { Group, Leaf, RenderModel } from '$core/types';
import type { MemberRef } from './store.svelte';

/** No single field owns this mark (a compound member, or several declarators). */
export const COMPOUND = 'c-compound';

/**
 * One declarator written on a line: `uint8_t lo, hi;` has two marks, a nested
 * `struct Header hdr;` has one (covering all of hdr's leaves).
 */
export interface MemberMark {
  /** 1-based column of the member's name. */
  col: number;
  /** Members to highlight for this mark (across records). */
  members: MemberRef[];
  /** Items from the declaring record (a group, or one leaf). */
  items: (Leaf | Group)[];
  /**
   * Marker colour: a single byte-occupying field's own colour, else
   * `c-compound` — a compound member has no single colour of its own.
   */
  colorClass: string;
}

/** Everything the editor needs to know about one source line. */
export interface LineInfo {
  line: number;
  /** Members to highlight when this line is hovered (across all visible records). */
  members: MemberRef[];
  /** Items (leaves/groups) declared on this line, from the primary record. */
  items: (Leaf | Group)[];
  /** Record that "owns" the line (declares it as a direct member), for dot color and auto-select. */
  primary: string;
  /**
   * Gutter-dot colour: a single leaf's colour when the line carries exactly one
   * byte-occupying field, else `c-compound` (a neutral ring) — a line holding a
   * container (nested record / base) has no colour of its own.
   */
  colorClass: string;
  /** Location of the field declared here (for the type hover). */
  location: FieldLocation | null;
  /** Per-declarator marks, left to right — several when a line declares several members. */
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

export interface LineIndex {
  lines: Map<number, LineInfo>;
  /** recordKey -> (leaf index -> location) */
  leafLocations: Map<string, Map<number, FieldLocation>>;
  /** recordKey -> (group index -> location) */
  groupLocations: Map<string, Map<number, FieldLocation>>;
}

const EMPTY_INDEX: LineIndex = {
  lines: new Map(),
  leafLocations: new Map(),
  groupLocations: new Map(),
};

/**
 * Top-level record names to request AST dumps for. `-ast-dump-filter` is a
 * substring match that re-parses the whole TU per owner, so we ask only for
 * top-level names (a nested record's decls live inside its parent's dump) and
 * skip library records (std::…, __…) whose fields are never in the user's file
 * and whose dumps are huge.
 */
export function collectLocateOwners(
  models: Map<string, RenderModel>,
  recordIndex: RecordIndex,
): Set<string> {
  const isLibrary = (name: string) => /^(?:std::|__)|::__/.test(name);
  const top = (name: string) => {
    if (isLibrary(name)) return '';
    return unqualifiedName(name.replace(/\(anonymous namespace\)::/g, '').split('::')[0] ?? '');
  };
  const owners = new Set<string>();
  for (const model of models.values()) {
    owners.add(top(model.record.name));
    for (const l of model.leaves) owners.add(top(l.owner));
    for (const g of model.groups) {
      owners.add(top(g.owner));
      const typeName = g.type.replace(/^(?:struct|union|class)\s+/, '');
      const rec = findRecord(typeName, recordIndex);
      if ((!rec || isAnonymousRecord(rec)) && !isLibrary(typeName)) {
        owners.add(unqualifiedName(typeName));
      }
    }
  }
  owners.delete('');
  return owners;
}

/** Explicit member alignments (AlignedAttr) keyed `<unqualified owner> <field>`. */
export function collectMemberAligns(fields: FieldLocation[]): Map<string, number> {
  const aligns = new Map<string, number>();
  for (const f of fields) {
    if (f.alignAttr !== undefined) aligns.set(f.owner + ' ' + f.name, f.alignAttr);
  }
  return aligns;
}

/** Map render models + AST field locations to a per-line index for the editor. */
export function buildLineIndex(
  models: Map<string, RenderModel>,
  fields: FieldLocation[],
): LineIndex {
  if (models.size === 0) return EMPTY_INDEX;

  /** One declarator of one record, keyed by (line, column). */
  interface Cell {
    record: string;
    direct: boolean;
    items: (Leaf | Group)[];
    leaves: Set<number>;
    loc: FieldLocation;
  }
  const leafLocations = new Map<string, Map<number, FieldLocation>>();
  const groupLocations = new Map<string, Map<number, FieldLocation>>();
  /** line -> "col\0record" -> cell */
  const byLine = new Map<number, Map<string, Cell>>();

  for (const [key, model] of models) {
    const leafLocs = matchItemsToLocations(model.leaves, fields);
    const groupLocs = matchItemsToLocations(model.groups, fields);
    leafLocations.set(key, leafLocs);
    groupLocations.set(key, groupLocs);

    const cellKey = (loc: FieldLocation) => `${loc.col}\0${key}`;
    const cellAt = (loc: FieldLocation): Cell => {
      let line = byLine.get(loc.line);
      if (!line) {
        line = new Map<string, Cell>();
        byLine.set(loc.line, line);
      }
      const ck = cellKey(loc);
      let cell = line.get(ck);
      if (!cell) {
        line.set(ck, (cell = { record: key, direct: false, items: [], leaves: new Set(), loc }));
      }
      return cell;
    };
    for (const [gi, loc] of groupLocs) {
      const g = model.groups[gi]!;
      const cell = cellAt(loc);
      for (const li of g.leafIndexes) cell.leaves.add(li);
      cell.items.push(g);
      if (g.path.length === 0) cell.direct = true;
    }
    for (const [li, loc] of leafLocs) {
      // A group already covering this leaf *at this declarator* subsumes it, so
      // `struct Header hdr;` is one mark rather than one per nested field. The
      // leaf still marks its own declaration elsewhere (inside Header's own
      // definition), which is how one field highlights in several records.
      const existing = byLine.get(loc.line)?.get(cellKey(loc));
      if (existing?.items.some((it) => 'leafIndexes' in it && it.leafIndexes.includes(li))) {
        continue;
      }
      const leaf = model.leaves[li]!;
      const cell = cellAt(loc);
      cell.leaves.add(li);
      cell.items.push(leaf);
      if (leaf.depth === 0) cell.direct = true;
    }
  }

  const lines = new Map<number, LineInfo>();
  for (const [line, cells] of byLine) {
    const all = [...cells.values()];
    const primary = all.find((c) => c.direct) ?? all[0]!;

    // Marks: one per column, merging the records that share that declarator.
    const byCol = new Map<number, Cell[]>();
    for (const c of all) {
      const list = byCol.get(c.loc.col) ?? [];
      list.push(c);
      byCol.set(c.loc.col, list);
    }
    const marks: MemberMark[] = [...byCol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, group]) => {
        // Colour from the declaring record's own items: a lone leaf keeps its
        // colour, a compound member (or several items) has none.
        const owner = group.find((c) => c.direct) ?? group[0]!;
        const item = owner.items.length === 1 ? owner.items[0]! : null;
        return {
          col,
          members: group.flatMap((c) => [...c.leaves].map((leaf) => ({ record: c.record, leaf }))),
          items: owner.items,
          colorClass: item && !('leafIndexes' in item) ? (item.colorClass ?? COMPOUND) : COMPOUND,
        };
      });

    lines.set(line, {
      line,
      members: marks.flatMap((m) => m.members),
      items: primary.items,
      primary: primary.record,
      // The line as a whole: one mark keeps its colour, several never do.
      colorClass: marks.length === 1 ? marks[0]!.colorClass : COMPOUND,
      location: primary.loc,
      marks,
    });
  }
  return { lines, leafLocations, groupLocations };
}
