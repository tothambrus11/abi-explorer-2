// Adapter: clang-abi-wasm's structured response -> the Analysis this app's
// model layer already consumes.
//
// This is a seam, not a destination. The render model, the containment tree and
// every panel are written against `RecordLayout` + `LayoutRow` — a shape that
// mirrors clang's *textual* dump, because that is what the app used to parse.
// Rebuilding all of that against the new schema at once would be a rewrite with
// nothing working in between, so instead the new library's output is projected
// into the old shape and everything downstream keeps working unchanged.
//
// What that buys immediately, even through the projection:
//
//   * member sizes come from `getTypeInfo`, so the probe passes disappear —
//     one compile per analysis instead of up to six
//   * records carry `isUserCode`, so library records are filtered by what clang
//     knows rather than by matching `std::` against their printed names
//   * a flexible array member reports zero, not an estimated byte
//   * base subobjects carry a source range, which no dump format provides
//
// What it does not buy yet: the id-based references are flattened back into
// name-keyed lookups here, because that is what `memberKey` and `findRecord`
// expect. Removing that is the next step, and the reason to keep this file
// small and obviously mechanical.

import type { Analysis } from './Analyzer';
import type { CompileOptions } from '$core/options';
import type { Diagnostic, LayoutRow, RecordKind, RecordLayout, RowKind } from '$core/types';
import type { AstInfo, DeclLocation, FieldLocation } from '$core/ast-locations';
import { buildRecordIndex, memberKey, type MemberSizes, type ScalarTable } from '$core/probes';

// The subset of clang-abi-wasm's schema this adapter reads. Declared here
// rather than imported so the app still type-checks without the module
// installed; `js/index.d.ts` in that repo is the authority.
export interface AbiLocation {
  file: string;
  line: number;
  col: number;
  endCol: number;
  isMainFile: boolean;
}
export interface AbiRange {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}
export interface AbiField {
  id: number;
  name: string;
  offsetBits: number;
  typeSpelling: string;
  canonicalTypeSpelling: string;
  sizeBits: number;
  alignBits: number;
  explicitAlignBits: number | null;
  isBitField: boolean;
  bitWidth: number | null;
  isZeroWidthBitField: boolean;
  isFlexibleArrayMember: boolean;
  isAnonymousMember: boolean;
  recordId: number | null;
  isNoUniqueAddress: boolean;
  location: AbiLocation | null;
}
export interface AbiBase {
  recordId: number;
  typeSpelling: string;
  offsetBits: number;
  sizeBits: number;
  typeSizeBits: number;
  isVirtual: boolean;
  isPrimary: boolean;
  isEmpty: boolean;
  location: AbiRange | null;
}
export interface AbiVTableSlot {
  kind: 'vptr' | 'vbptr' | 'vtordisp';
  label: string;
  offsetBits: number;
  sizeBits: number;
}
export interface AbiRecord {
  id: number;
  kind: RecordKind | 'interface';
  name: string;
  qualifiedName: string;
  printedName: string;
  isAnonymous: boolean;
  isEmpty: boolean;
  isUserCode: boolean;
  location: AbiLocation | null;
  range: AbiRange | null;
  sizeBits: number;
  alignBits: number;
  dataSizeBits: number;
  nonVirtualSizeBits: number;
  nonVirtualAlignBits: number;
  preferredAlignBits: number;
  bases: AbiBase[];
  fields: AbiField[];
  vtableSlots: AbiVTableSlot[];
  paddingBits: number;
}
export interface AbiTarget {
  pointerSizeBits: number;
  pointerAlignBits: number;
  intSizeBits: number;
  charSizeBits: number;
}
export interface AbiDiagnostic {
  severity: 'note' | 'remark' | 'warning' | 'error' | 'fatal';
  message: string;
  location: AbiLocation | null;
  ranges: AbiRange[];
  option: string | null;
}
export interface AbiResponse {
  ok: boolean;
  error: string | null;
  exitCode: number;
  target: AbiTarget | null;
  diagnostics: AbiDiagnostic[];
  records: AbiRecord[];
}

const BASE_KIND = (b: AbiBase): RowKind =>
  b.isVirtual ? (b.isPrimary ? 'primary-vbase' : 'vbase') : b.isPrimary ? 'primary-base' : 'base';

/**
 * The record's own name as the old model spells it — this ends up in
 * `recordKey`, which is a map key across the store and travels in shared URLs,
 * so it has to stay stable across the migration.
 *
 * Both spellings come from clang: the layout dump prints an unnamed record as
 * `(unnamed at f.c:2:37)` while the type printer says `(anonymous at …)`. The
 * dump's spelling wins here, so a link saved before the switch still selects
 * the same record after it.
 */
function recordName(r: AbiRecord): string {
  return r.printedName
    .replace(/^(?:struct|class|union|__interface|enum)\s+/, '')
    .replace(/\(anonymous at /g, '(unnamed at ');
}

/**
 * Rows for one record, in offset order. Bases and vtable slots become the same
 * row kinds the dump parser produced, and a record-typed member is expanded
 * inline from the record its `recordId` points at — which is how the old shape
 * represented nesting.
 */
function rowsFor(
  rec: AbiRecord,
  byId: Map<number, AbiRecord>,
  depth: number,
  /** Guards against a record reaching itself through a member. */
  open: Set<number>,
  /**
   * These rows are a base subobject's, expanded inside a derived class. A
   * virtual base belongs to the *most derived* object and is laid out once, at
   * that level — expanding it again under each intermediate base would show one
   * `A` inside `B`, another inside `C`, and a third at the bottom.
   */
  asBaseSubobject = false,
): LayoutRow[] {
  const rows: LayoutRow[] = [];

  for (const slot of rec.vtableSlots) {
    rows.push({
      rowKind: 'special',
      type: null,
      name: null,
      label: slot.label,
      offsetBits: slot.offsetBits,
      bitWidth: null,
      isBitfield: false,
      isZeroWidth: false,
      isEmpty: false,
      depth,
      children: [],
    });
  }

  for (const base of rec.bases) {
    if (asBaseSubobject && base.isVirtual) continue;
    const target = byId.get(base.recordId);
    rows.push({
      rowKind: BASE_KIND(base),
      type: base.typeSpelling,
      name: null,
      label: null,
      offsetBits: base.offsetBits,
      bitWidth: null,
      isBitfield: false,
      isZeroWidth: false,
      isEmpty: base.isEmpty,
      depth,
      children:
        target && !base.isEmpty && !open.has(target.id)
          ? shift(
              rowsFor(target, byId, depth + 1, new Set(open).add(target.id), true),
              base.offsetBits,
            )
          : [],
    });
  }

  for (const f of rec.fields) {
    const target = f.recordId === null ? undefined : byId.get(f.recordId);
    rows.push({
      rowKind: 'field',
      type: f.typeSpelling,
      name: f.name,
      label: null,
      offsetBits: f.offsetBits,
      bitWidth: f.isBitField ? f.bitWidth : null,
      isBitfield: f.isBitField,
      isZeroWidth: f.isZeroWidthBitField,
      // A member whose type is empty; the model decides whether it occupies a
      // byte by looking at what else covers it.
      isEmpty: target ? target.isEmpty : false,
      depth,
      children:
        target && !open.has(target.id)
          ? shift(rowsFor(target, byId, depth + 1, new Set(open).add(target.id)), f.offsetBits)
          : [],
    });
  }

  return rows.sort((a, b) => a.offsetBits - b.offsetBits);
}

/** Nested rows carry offsets relative to their own record; the old shape is absolute. */
function shift(rows: LayoutRow[], by: number): LayoutRow[] {
  return rows.map((r) => ({
    ...r,
    offsetBits: r.offsetBits + by,
    children: shift(r.children, by),
  }));
}

function toRecordLayout(rec: AbiRecord, byId: Map<number, AbiRecord>): RecordLayout {
  const out: RecordLayout = {
    kind: rec.kind === 'interface' ? '__interface' : rec.kind,
    name: recordName(rec),
    isEmpty: rec.isEmpty,
    sizeBytes: rec.sizeBits / 8,
    align: rec.alignBits / 8,
    rows: rowsFor(rec, byId, 1, new Set([rec.id])),
  };
  if (rec.dataSizeBits !== rec.sizeBits) out.dsize = rec.dataSizeBits / 8;
  if (rec.nonVirtualSizeBits !== rec.sizeBits) out.nvsize = rec.nonVirtualSizeBits / 8;
  if (rec.nonVirtualAlignBits !== rec.alignBits) out.nvalign = rec.nonVirtualAlignBits / 8;
  if (rec.preferredAlignBits !== rec.alignBits) out.preferredalign = rec.preferredAlignBits / 8;
  return out;
}

/** Member sizes keyed the way `model.ts` looks them up, by access path. */
function collectMemberSizes(
  rec: AbiRecord,
  layout: RecordLayout,
  byId: Map<number, AbiRecord>,
  sizes: MemberSizes,
  prefix = '',
  open = new Set<number>([rec.id]),
): void {
  for (const f of rec.fields) {
    if (f.isBitField) continue; // width comes from the row
    const path = prefix + f.name;
    if (f.name) {
      sizes.set(memberKey(layout, path), {
        bits: f.sizeBits,
        align: Math.max(f.alignBits, f.explicitAlignBits ?? 0),
      });
    }
    const target = f.recordId === null ? undefined : byId.get(f.recordId);
    if (target && !open.has(target.id)) {
      // An anonymous member injects its fields into this scope; a named one is
      // reached through it.
      const next = f.name ? path + '.' : prefix;
      collectMemberSizes(target, layout, byId, sizes, next, new Set(open).add(target.id));
    }
  }
}

function toDiagnostic(d: AbiDiagnostic): Diagnostic | null {
  if (!d.location?.isMainFile) return null;
  if (d.severity === 'remark' || d.severity === 'note') {
    return {
      line: d.location.line,
      column: d.location.col,
      severity: d.severity,
      message: d.message,
    };
  }
  const out: Diagnostic = {
    line: d.location.line,
    column: d.location.col,
    severity: d.severity === 'fatal' ? 'fatal error' : d.severity,
    message: d.message,
  };
  const sameLine = d.ranges.find((r) => r.line === d.location!.line && r.endLine === r.line);
  if (sameLine) {
    out.column = sameLine.col;
    out.endColumn = Math.max(sameLine.endCol, sameLine.col + 1);
  } else if (d.location.endCol > d.location.col) {
    out.endColumn = d.location.endCol;
  }
  return out;
}

/**
 * The source locations the editor needs, from the same response.
 *
 * The text pipeline fetched these with a separate `-ast-dump=json` per record —
 * one full re-parse each — and then matched them back to layout rows by name.
 * Here they arrive attached to the fields they belong to.
 */
export function toAstInfo(response: AbiResponse): AstInfo {
  const fields: FieldLocation[] = [];
  const decls: DeclLocation[] = [];

  for (const rec of response.records) {
    if (rec.location?.isMainFile && rec.name) {
      const d: DeclLocation = {
        kind: 'record',
        name: rec.name,
        line: rec.location.line,
        col: rec.location.col,
      };
      if (rec.range) d.span = { begin: rec.range.line, end: rec.range.endLine };
      decls.push(d);
    }
    for (const f of rec.fields) {
      if (!f.location?.isMainFile) continue;
      const loc: FieldLocation = {
        owner: rec.name,
        qualifiedOwner: rec.qualifiedName,
        name: f.name,
        line: f.location.line,
        col: f.location.col,
        qualType: f.typeSpelling,
      };
      if (f.canonicalTypeSpelling !== f.typeSpelling) {
        loc.desugaredType = f.canonicalTypeSpelling;
      }
      if (f.explicitAlignBits !== null) loc.alignAttr = f.explicitAlignBits / 8;
      fields.push(loc);
    }
  }
  return { fields, decls };
}

/** Project one response into the Analysis the model layer consumes. */
export function toAnalysis(
  response: AbiResponse,
  source: string,
  options: CompileOptions,
): Analysis {
  const byId = new Map(response.records.map((r) => [r.id, r]));
  const layouts = response.records.map((r) => toRecordLayout(r, byId));

  const memberSizes: MemberSizes = new Map();
  response.records.forEach((rec, i) => {
    collectMemberSizes(rec, layouts[i]!, byId, memberSizes);
  });

  // `isUserCode` replaces the old two-part heuristic: a baseline compile to
  // learn clang's implicit records, plus a name test for library ones.
  const userRecords = layouts.filter((_, i) => response.records[i]!.isUserCode);
  const builtinRecords = new Set(
    layouts.filter((_, i) => !response.records[i]!.isUserCode).map((r) => r.name),
  );

  const scalars: ScalarTable = new Map();
  if (response.target) {
    scalars.set('ptr', {
      size: response.target.pointerSizeBits / 8,
      align: response.target.pointerAlignBits / 8,
    });
    scalars.set('int', {
      size: response.target.intSizeBits / 8,
      align: response.target.intSizeBits / 8,
    });
  }

  const diagnostics = response.diagnostics
    .map(toDiagnostic)
    .filter((d): d is Diagnostic => d !== null);
  const diagnosticsText = response.diagnostics
    .filter((d) => d.location?.isMainFile)
    .map((d) => `input:${d.location!.line}:${d.location!.col}: ${d.severity}: ${d.message}`)
    .join('\n');

  return {
    source,
    options,
    code: response.exitCode,
    records: layouts,
    userRecords,
    builtinRecords,
    scalars,
    recordIndex: buildRecordIndex(layouts),
    memberSizes,
    // Nothing is estimated any more: every size came from the target's type
    // info rather than from a probe that might have failed to compile.
    unmeasured: [],
    diagnostics,
    diagnosticsText,
    // The library reports diagnostics as data; there are no escapes to strip.
    diagnosticsAnsi: diagnosticsText,
  };
}
