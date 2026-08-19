// Builds the render model for one record: a flat list of leaf extents
// (fields, vtable pointers), compound groups, padding runs, and stats.
// All sizes come from clang (layout dump + field probes); when a probe failed
// the extent is estimated from neighbouring offsets and flagged.

import type {
  Group,
  Leaf,
  LayoutRow,
  Marker,
  PaddingRun,
  RecordLayout,
  RenderModel,
} from './types';
import {
  findRecord,
  isSpellableRecord,
  memberKey,
  type MemberSizes,
  type RecordIndex,
  type ScalarTable,
} from './probes';
import { unqualifiedName } from './ast-locations';
import { stripRecordKeyword } from './layout-parser';

/** How clang names a member with no name of its own, and how we label it. */
const ANON = '(anonymous)';

export interface ModelInputs {
  scalars: ScalarTable;
  recordIndex: RecordIndex;
  memberSizes: MemberSizes;
  /**
   * Explicit member alignments (`_Alignas`/`alignas`) as evaluated by clang in
   * the AST, keyed `<owner> <field name>` under both the qualified and the
   * unqualified owner name; probes measure the member's *type*, so these
   * override when larger.
   */
  memberAligns?: Map<string, number>;
}

interface Measure {
  bits: number | null;
  align: number | null;
}

/** Where a row's members are probed from: a spellable record + access-path prefix. */
interface ProbeScope {
  rec: RecordLayout;
  prefix: string;
}

export function buildRenderModel(record: RecordLayout, inputs: ModelInputs): RenderModel {
  const { scalars, recordIndex, memberSizes } = inputs;
  const memberAligns = inputs.memberAligns;
  // Prefer the qualified owner (the layout dump's own spelling of the record);
  // fall back to the unqualified name, which is ambiguous across namespaces.
  const attrAlign = (owner: RecordLayout, name: string): number | undefined =>
    memberAligns?.get(owner.name + ' ' + name) ??
    memberAligns?.get(unqualifiedName(owner.name) + ' ' + name);
  const leaves: Leaf[] = [];
  const groups: Group[] = [];
  /** Indices of leaves whose type is an empty class (clang's `(empty)` marker). */
  const emptyMembers: number[] = [];
  const markers: Marker[] = [];
  const unresolved = new Set<string>();
  const sizeBits = record.sizeBytes * 8;
  const ptr = scalars.get('ptr') ?? null;

  const measure = (scope: ProbeScope, name: string): Measure => {
    const m = memberSizes.get(memberKey(scope.rec, scope.prefix + name));
    return m ? { bits: m.bits, align: m.align } : { bits: null, align: null };
  };

  const visit = (
    rows: LayoutRow[],
    path: string[],
    parentEnd: number,
    inUnion: boolean,
    ownerRec: RecordLayout,
    scope: ProbeScope,
    /**
     * These rows are a union's own members, so they all share one address by
     * definition. Unlike `inUnion` this is not sticky: a struct nested in a
     * union lays its own members out side by side again.
     */
    unionHere = false,
  ): void => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;

      if (row.rowKind === 'special') {
        // vptr/vbptr/vfptr are pointers; the MS ABI vtordisp is a 4-byte int
        // (MicrosoftRecordLayoutBuilder: VtorDispSize = 4).
        const m = /^vtordisp\b/.test(row.label ?? '') ? (scalars.get('int') ?? null) : ptr;
        leaves.push({
          kind: 'special',
          row,
          path,
          name: row.label ?? '',
          type: null,
          offsetBits: row.offsetBits,
          sizeBits: m ? m.size * 8 : 0,
          align: m?.align ?? null,
          estimated: m === null,
          depth: path.length,
          owner: ownerRec.name,
        });
        continue;
      }

      if (row.rowKind !== 'field') {
        // Base subobject: rows come from the base's dump; probe through the
        // base itself when it can be spelled, else through the enclosing scope.
        const baseRec = row.type ? findRecord(row.type, recordIndex) : undefined;
        if (row.isEmpty) {
          markers.push({
            kind: 'empty-base',
            row,
            path,
            name: row.type ?? '',
            offsetBits: row.offsetBits,
          });
        }
        const first = leaves.length;
        const label = baseLabel(row);
        const childScope: ProbeScope =
          baseRec && isSpellableRecord(baseRec) ? { rec: baseRec, prefix: '' } : scope;
        visit(row.children, [...path, label], parentEnd, inUnion, baseRec ?? ownerRec, childScope);
        groups.push({
          kind: row.rowKind,
          name: label,
          type: row.type ?? '',
          owner: ownerRec.name,
          path,
          offsetBits: row.offsetBits,
          // An empty base occupies no storage at all (empty base optimization):
          // sizeof is 1 only because a *complete* object cannot be zero-sized.
          // Otherwise a base subobject occupies its non-virtual size, since the
          // derived class may reuse its tail padding — not its full sizeof.
          sizeBits: row.isEmpty ? 0 : baseRec ? (baseRec.nvsize ?? baseRec.sizeBytes) * 8 : null,
          align: baseRec?.align ?? null,
          leafIndexes: range(first, leaves.length),
          typeSizeBits: baseRec ? baseRec.sizeBytes * 8 : null,
          isBase: true,
          isUnion: false,
        });
        continue;
      }

      const name = row.name ?? '';

      if (row.isBitfield) {
        if (row.isZeroWidth) {
          markers.push({
            kind: 'zero-bitfield',
            row,
            path,
            name: name || ':0',
            type: row.type,
            offsetBits: row.offsetBits,
          });
        } else {
          leaves.push({
            kind: 'bitfield',
            row,
            path,
            name: name || '(pad bits)',
            type: row.type,
            offsetBits: row.offsetBits,
            sizeBits: row.bitWidth ?? 0,
            align: null,
            estimated: false,
            depth: path.length,
            owner: ownerRec.name,
          });
        }
        continue;
      }

      if (row.children.length > 0) {
        // Record-typed member (named type, or anonymous struct/union member).
        const memberRec = row.type ? findRecord(row.type, recordIndex) : undefined;
        const isAnon = name === '';
        const label = isAnon ? ANON : name;
        const first = leaves.length;
        const own: Measure = isAnon
          ? { bits: memberRec ? memberRec.sizeBytes * 8 : null, align: memberRec?.align ?? null }
          : measure(scope, name);
        const ownBits = own.bits ?? (memberRec ? memberRec.sizeBytes * 8 : null);
        const childScope: ProbeScope = isAnon
          ? scope
          : { rec: scope.rec, prefix: scope.prefix + name + '.' };
        const isUnionMember = memberRec?.kind === 'union' || /^union\b/.test(row.type ?? '');
        visit(
          row.children,
          [...path, label],
          ownBits !== null ? row.offsetBits + ownBits : parentEnd,
          inUnion || isUnionMember,
          memberRec ?? ownerRec,
          childScope,
          isUnionMember,
        );
        groups.push({
          kind: 'member',
          name: label,
          type: row.type ?? '',
          owner: ownerRec.name,
          path,
          offsetBits: row.offsetBits,
          sizeBits: ownBits,
          align: own.align ?? memberRec?.align ?? null,
          leafIndexes: range(first, leaves.length),
          typeSizeBits: memberRec ? memberRec.sizeBytes * 8 : null,
          isBase: false,
          isUnion: isUnionMember,
        });
        continue;
      }

      const m = name ? measure(scope, name) : { bits: null, align: null };
      const explicit = name ? attrAlign(ownerRec, name) : undefined;
      const align = explicit !== undefined ? Math.max(explicit, m.align ?? 0) : m.align;
      let bits = m.bits;
      let estimated = false;
      if (bits === null) {
        if (row.type) unresolved.add(row.type);
        bits = estimateBits(rows, i, row, parentEnd, inUnion);
        estimated = true;
      }
      // Inside a union every member shares the address, so "shares it with a
      // neighbour" says nothing about this one: leave it at its own sizeof.
      if (row.isEmpty && !unionHere) emptyMembers.push(leaves.length);
      leaves.push({
        kind: 'field',
        row,
        path,
        name: name || ANON,
        type: row.type,
        offsetBits: row.offsetBits,
        sizeBits: bits,
        align,
        estimated,
        depth: path.length,
        owner: ownerRec.name,
      });
    }
  };

  visit(
    record.rows,
    [],
    sizeBits,
    record.kind === 'union',
    record,
    { rec: record, prefix: '' },
    record.kind === 'union',
  );
  resolveEmptyMembers(leaves, emptyMembers);

  const paddings = computePadding(record.sizeBytes, leaves);
  const paddingBytes = paddings.reduce((n, p) => n + (p.end - p.start), 0);
  return {
    record,
    leaves,
    groups,
    markers,
    paddings,
    sizeBits,
    paddingBytes,
    unresolved: [...unresolved],
  };
}

/**
 * A member whose type is an empty class occupies one byte if it needs a unique
 * address, and none at all when it shares one — which is what
 * `[[no_unique_address]]` permits, and what libc++'s allocator members rely on.
 * Clang's layout says which: if another subobject already covers that byte, the
 * member is sharing it. Left at its type's `sizeof` it would be drawn as a
 * one-byte block overlapping its neighbour.
 */
function resolveEmptyMembers(leaves: Leaf[], indices: number[]): void {
  for (const i of indices) {
    const leaf = leaves[i]!;
    const shares = leaves.some(
      (other, j) =>
        j !== i &&
        other.sizeBits > 0 &&
        other.offsetBits <= leaf.offsetBits &&
        leaf.offsetBits < other.offsetBits + other.sizeBits,
    );
    if (shares) leaf.sizeBits = 0;
  }
}

function computePadding(sizeBytes: number, leaves: Leaf[]): PaddingRun[] {
  const covered = new Uint8Array(sizeBytes);
  for (const leaf of leaves) {
    const from = Math.floor(leaf.offsetBits / 8);
    const to = Math.min(sizeBytes, Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8));
    for (let b = from; b < to; b++) covered[b] = 1;
  }
  const paddings: PaddingRun[] = [];
  let run: PaddingRun | null = null;
  for (let b = 0; b < sizeBytes; b++) {
    if (covered[b]) continue;
    if (run !== null && run.end === b) run.end = b + 1;
    else {
      run = { start: b, end: b + 1 };
      paddings.push(run);
    }
  }
  return paddings;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

function baseLabel(row: LayoutRow): string {
  const name = stripRecordKeyword(row.type ?? '');
  return row.rowKind === 'vbase' || row.rowKind === 'primary-vbase' ? `virtual ${name}` : name;
}

function estimateBits(
  rows: LayoutRow[],
  i: number,
  row: LayoutRow,
  parentEnd: number,
  inUnion: boolean,
): number {
  if (!inUnion) {
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j]!;
      if (next.offsetBits > row.offsetBits) return next.offsetBits - row.offsetBits;
    }
  }
  return Math.max(8, parentEnd - row.offsetBits);
}

/**
 * Is a member with this path a member *of the record itself*? Direct fields are,
 * and so are fields injected by an anonymous aggregate (`msg.crc_lo`), but a
 * field of a named compound member is reached through it (`msg.hdr.kind`) and
 * belongs to that member's own record.
 */
export function isNameable(path: readonly string[]): boolean {
  return path.every((p) => p === ANON);
}

/** The members of a record: its own fields and its compound members, one level deep. */
export function directMembers(model: RenderModel): (Leaf | Group)[] {
  const covered = new Set<number>();
  const units: (Leaf | Group)[] = [];
  for (const g of model.groups) {
    if (!isNameable(g.path) || g.name === ANON) continue; // anonymous: transparent
    units.push(g);
    for (const li of g.leafIndexes) covered.add(li);
  }
  model.leaves.forEach((leaf, li) => {
    if (covered.has(li) || !isNameable(leaf.path)) return;
    units.push(leaf);
  });
  return units.sort((a, b) => a.offsetBits - b.offsetBits);
}

/**
 * The single colour a compound member stands for, or null when it spans several
 * — an anonymous aggregate, whose fields are members in their own right.
 */
export function groupColorClass(model: RenderModel, group: Group): string | null {
  const colours = new Set(group.leafIndexes.map((li) => model.leaves[li]?.colorClass));
  return colours.size === 1 ? ([...colours][0] ?? null) : null;
}

/**
 * Assign categorical colour slots one level deep: a colour identifies a *direct
 * member* of this record. A compound member (nested record, base, anonymous
 * aggregate) is one unit, so every leaf inside it shares its colour — the grid
 * then shows `hdr` as one block rather than a stripe per nested field, and no
 * colour means two different things at once. Look inside a member by inspecting
 * its own record. Specials (vptr and friends) keep their hatch style.
 */
export function assignColors(model: RenderModel, paletteSize = 8): void {
  const slot = (i: number) => `c-${(i % paletteSize) + 1}`;
  let next = 0;
  const assigned = new Set<number>();
  // Named compound members first: each claims one colour for all of its leaves.
  // An anonymous aggregate is transparent — its fields are nameable on the
  // record itself (`msg.crc_lo`), so they are members in their own right, and a
  // named member reached *through* one (`union { Header hdr; … };`) is still a
  // direct member of this record. `isNameable` is the same test the table and
  // the editor marks use, so all three agree on what one colour stands for.
  for (const g of model.groups) {
    if (!isNameable(g.path) || g.name === ANON) continue;
    const colour = slot(next++);
    for (const li of g.leafIndexes) {
      const leaf = model.leaves[li];
      if (!leaf || assigned.has(li)) continue;
      leaf.colorClass = leaf.kind === 'special' ? 'c-special' : colour;
      assigned.add(li);
    }
  }
  // Then the record's own direct fields, in declaration order.
  model.leaves.forEach((leaf, li) => {
    if (assigned.has(li)) return;
    leaf.colorClass = leaf.kind === 'special' ? 'c-special' : slot(next++);
  });
}
