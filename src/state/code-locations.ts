// Pure helpers that turn AST field locations + render models into the editor's
// per-line index. Kept free of runes and store access so the mapping is unit
// tested directly; `session` owns the reactive wiring and the async dump.

import type { FieldLocation } from '$core/ast-locations';
import { matchItemsToLocations, unqualifiedName } from '$core/ast-locations';
import { isAnonymousRecord } from '$core/layout-parser';
import { findRecord, type RecordIndex } from '$core/probes';
import type { Group, Leaf, RenderModel } from '$core/types';
import type { MemberRef } from './store.svelte';

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

  interface Cand {
    record: string;
    direct: boolean;
    items: (Leaf | Group)[];
    members: MemberRef[];
    loc: FieldLocation;
  }
  const leafLocations = new Map<string, Map<number, FieldLocation>>();
  const groupLocations = new Map<string, Map<number, FieldLocation>>();
  const byLine = new Map<number, Cand[]>();

  for (const [key, model] of models) {
    const leafLocs = matchItemsToLocations(model.leaves, fields);
    const groupLocs = matchItemsToLocations(model.groups, fields);
    leafLocations.set(key, leafLocs);
    groupLocations.set(key, groupLocs);
    const local = new Map<
      number,
      { items: (Leaf | Group)[]; members: Set<number>; loc: FieldLocation; direct: boolean }
    >();
    const at = (line: number, loc: FieldLocation) => {
      let e = local.get(line);
      if (!e) local.set(line, (e = { items: [], members: new Set(), loc, direct: false }));
      return e;
    };
    for (const [gi, loc] of groupLocs) {
      const g = model.groups[gi]!;
      const e = at(loc.line, loc);
      for (const li of g.leafIndexes) e.members.add(li);
      e.items.push(g);
      if (g.path.length === 0) e.direct = true;
    }
    for (const [li, loc] of leafLocs) {
      const leaf = model.leaves[li]!;
      const e = at(loc.line, loc);
      if (e.items.some((it) => 'leafIndexes' in it && it.leafIndexes.includes(li))) continue; // subsumed by a group
      e.members.add(li);
      e.items.push(leaf);
      if (leaf.depth === 0) e.direct = true;
    }
    for (const [line, e] of local) {
      const list = byLine.get(line) ?? [];
      list.push({
        record: key,
        direct: e.direct,
        items: e.items,
        members: [...e.members].map((leaf) => ({ record: key, leaf })),
        loc: e.loc,
      });
      byLine.set(line, list);
    }
  }

  const lines = new Map<number, LineInfo>();
  for (const [line, cands] of byLine) {
    const primary = cands.find((c) => c.direct) ?? cands[0]!;
    // One field declared on the line → its colour; a container (a group) or
    // several fields → a neutral ring, since no single colour represents it.
    // Based on the declaring record's items (source-truth), not on member
    // count across records (the same field recurs in every record it nests in).
    const item = primary.items.length === 1 ? primary.items[0]! : null;
    const colorClass =
      item && !('leafIndexes' in item) ? (item.colorClass ?? 'c-compound') : 'c-compound';
    lines.set(line, {
      line,
      members: cands.flatMap((c) => c.members),
      items: primary.items,
      primary: primary.record,
      colorClass,
      location: primary.loc,
    });
  }
  return { lines, leafLocations, groupLocations };
}
