// Shared domain types.

export type RecordKind = 'struct' | 'union' | 'class' | '__interface' | 'interface';

export type RowKind = 'field' | 'special' | 'base' | 'primary-base' | 'vbase' | 'primary-vbase';

/** One line of a `-fdump-record-layouts` block, with nested rows. */
export interface LayoutRow {
  rowKind: RowKind;
  /** Type spelling for fields/bases; null for special rows. */
  type: string | null;
  /** Field name ('' when unnamed/anonymous); null for bases/specials. */
  name: string | null;
  /** Text inside the parentheses for special rows, e.g. "Base vtable pointer". */
  label: string | null;
  offsetBits: number;
  /** Bit width for bit-fields (0 for zero-width), null otherwise. */
  bitWidth: number | null;
  isBitfield: boolean;
  isZeroWidth: boolean;
  isEmpty: boolean;
  depth: number;
  children: LayoutRow[];
}

/** A complete record layout as dumped by clang. */
export interface RecordLayout {
  kind: RecordKind;
  name: string;
  isEmpty: boolean;
  sizeBytes: number;
  align: number;
  dsize?: number;
  nvsize?: number;
  nvalign?: number;
  preferredalign?: number;
  /** Ordinal among records dumped with the same kind+name (function-local duplicates). */
  dup?: number;
  rows: LayoutRow[];
}

export interface ProbeResult {
  bits: number;
  align: number;
}

export type LeafKind = 'field' | 'bitfield' | 'special';

/** A drawable member extent. */
export interface Leaf {
  kind: LeafKind;
  row: LayoutRow;
  /** Labels of enclosing members/bases (outermost first). */
  path: string[];
  name: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  /** Alignment in bytes if known. */
  align: number | null;
  estimated: boolean;
  depth: number;
  /** Unqualified-ish record name that declares this member (as printed by clang). */
  owner: string;
  colorClass?: string;
}

/** A compound member (record-typed field or base) with the leaves it contains. */
export interface Group {
  kind: 'member' | RowKind;
  name: string;
  type: string;
  owner: string;
  path: string[];
  offsetBits: number;
  sizeBits: number | null;
  align: number | null;
  leafIndexes: number[];
  isBase: boolean;
  /** The member is a union (its fields share storage / overlap). */
  isUnion: boolean;
}

export interface Marker {
  kind: 'empty-base' | 'zero-bitfield';
  row: LayoutRow;
  path: string[];
  name: string;
  type?: string | null;
  offsetBits: number;
}

export interface PaddingRun {
  start: number;
  end: number;
}

export interface RenderModel {
  record: RecordLayout;
  leaves: Leaf[];
  groups: Group[];
  markers: Marker[];
  paddings: PaddingRun[];
  sizeBits: number;
  paddingBytes: number;
  unresolved: string[];
}

export type DiagnosticSeverity = 'error' | 'fatal error' | 'warning' | 'note' | 'remark';

export interface Diagnostic {
  line: number;
  column: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
}
