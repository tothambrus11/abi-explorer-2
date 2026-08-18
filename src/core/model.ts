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

export interface ModelInputs {
  scalars: ScalarTable;
  recordIndex: RecordIndex;
  memberSizes: MemberSizes;
  /**
   * Explicit member alignments (`_Alignas`/`alignas`) as evaluated by clang in
   * the AST, keyed `<unqualified owner> <field name>`; probes measure the
   * member's *type*, so these override when larger.
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
  const attrAlign = (owner: RecordLayout, name: string): number | undefined =>
    memberAligns?.get(unqualifiedName(owner.name) + ' ' + name);
  const leaves: Leaf[] = [];
  const groups: Group[] = [];
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
          // A base subobject occupies its non-virtual size (tail padding is
          // reused by the derived class), not its full sizeof.
          sizeBits: baseRec ? (baseRec.nvsize ?? baseRec.sizeBytes) * 8 : null,
          align: baseRec?.align ?? null,
          leafIndexes: range(first, leaves.length),
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
        const label = isAnon ? '(anonymous)' : name;
        const first = leaves.length;
        const own: Measure = isAnon
          ? { bits: memberRec ? memberRec.sizeBytes * 8 : null, align: memberRec?.align ?? null }
          : measure(scope, name);
        const ownBits = own.bits ?? (memberRec ? memberRec.sizeBytes * 8 : null);
        const childScope: ProbeScope = isAnon
          ? scope
          : { rec: scope.rec, prefix: scope.prefix + name + '.' };
        visit(
          row.children,
          [...path, label],
          ownBits !== null ? row.offsetBits + ownBits : parentEnd,
          inUnion || memberRec?.kind === 'union',
          memberRec ?? ownerRec,
          childScope,
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
          isBase: false,
          isUnion: memberRec?.kind === 'union' || /^union\b/.test(row.type ?? ''),
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
      leaves.push({
        kind: 'field',
        row,
        path,
        name: name || '(anonymous)',
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

  visit(record.rows, [], sizeBits, record.kind === 'union', record, { rec: record, prefix: '' });

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
  const name = (row.type ?? '').replace(/^(?:struct|class|union)\s+/, '');
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

/** Assign categorical color slots to leaves (specials get their own hatch style). */
export function assignColors(model: RenderModel, paletteSize = 8): void {
  let i = 0;
  for (const leaf of model.leaves) {
    leaf.colorClass = leaf.kind === 'special' ? 'c-special' : `c-${(i++ % paletteSize) + 1}`;
  }
}
