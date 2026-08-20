// Shared domain types.

export type RecordKind = 'struct' | 'union' | 'class' | '__interface' | 'interface';

/**
 * What a compound member is. `member` is a record-typed field or an anonymous
 * aggregate; the rest are base subobjects, with the ABI's own distinctions —
 * the primary base shares the derived object's address, and a virtual one is
 * placed by the most derived object rather than by the class that names it.
 */
export type GroupKind = 'member' | 'base' | 'primary-base' | 'vbase' | 'primary-vbase';

/** A record's own facts, as clang computed them. Sizes in bytes. */
export interface RecordLayout {
  kind: RecordKind;
  name: string;
  qualifiedName: string;
  isEmpty: boolean;
  sizeBytes: number;
  align: number;
  dsize?: number;
  nvsize?: number;
  nvalign?: number;
  preferredalign?: number;
  /** Ordinal among records sharing a kind+name (function-local duplicates). */
  dup?: number;
  /** Where its name is written, when that is in the user's file. */
  location: SourceLocation | null;
  /**
   * The whole declaration's extent. A caret anywhere inside it belongs to this
   * record — including on a blank line or the closing brace, where no member
   * location would match.
   */
  range: SourceSpan | null;
}

export interface SourceLocation {
  file: string;
  line: number;
  col: number;
  endCol: number;
  isMainFile: boolean;
}

/** A span that may cross lines — a base specifier, a diagnostic highlight. */
export interface SourceSpan {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** Where to underline something in the editor: one line, one column range. */
export interface Anchor {
  line: number;
  col: number;
  endCol: number;
}

/**
 * The anchor of a location or a span. A base specifier is a span (`public
 * Base`) and may cross lines; its first line is what gets marked.
 */
export function anchorOf(loc: SourceLocation | SourceSpan | null): Anchor | null {
  if (!loc) return null;
  if ('isMainFile' in loc) {
    return loc.isMainFile ? { line: loc.line, col: loc.col, endCol: loc.endCol } : null;
  }
  return {
    line: loc.line,
    col: loc.col,
    endCol: loc.endLine === loc.line ? loc.endCol : loc.col + 1,
  };
}

export type LeafKind = 'field' | 'bitfield' | 'special';

/** A drawable extent: something that occupies bytes and can be pointed at. */
export interface Leaf {
  kind: LeafKind;
  /** Labels of enclosing members/bases (outermost first). */
  path: string[];
  name: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  /** Alignment in bytes; null for a bit-field, which has none of its own. */
  align: number | null;
  /** Record that declares this member, as clang names it. */
  owner: string;
  /**
   * It occupies nothing: an empty type allowed to share an address, which is
   * what `[[no_unique_address]]` permits. It still has an offset, and the byte
   * map draws nothing there — the bytes belong to whatever else is present, or
   * to padding when nothing is.
   */
  sharesAddress: boolean;
  location: SourceLocation | null;
  colorClass?: string;
  /**
   * Nameable on the record being shown, without naming another member first.
   * Its own fields are, and so are the ones an anonymous aggregate injects
   * (`msg.crc_lo`) and the ones it inherits (`d.b`) — but a field of a named
   * compound member is reached through it (`msg.hdr.kind`) and is a member of
   * that member's record, not of this one.
   *
   * Computed from the tree, not from `path`: only the tree knows whether the
   * thing a path names is a base or a member.
   */
  direct: boolean;
}

/** A compound member: a base subobject, a record-typed field, or an anonymous aggregate. */
export interface Group {
  kind: GroupKind;
  name: string;
  type: string;
  owner: string;
  path: string[];
  offsetBits: number;
  sizeBits: number;
  /**
   * `sizeof` of the member's own type. The bytes it occupies here (`sizeBits`)
   * can be smaller: a base may have its tail padding reused.
   */
  typeSizeBits: number;
  align: number | null;
  leafIndexes: number[];
  isBase: boolean;
  /** The member is a union: its fields share storage. */
  isUnion: boolean;
  /** The record this is an instance of, by index into the analysis's records. */
  recordId: number | null;
  /** A base carries the span of its specifier; a member, its name's position. */
  location: SourceLocation | SourceSpan | null;
  /** Nameable on the record being shown — see `Leaf.direct`. */
  direct: boolean;
}

/** A zero-size thing worth marking even though it draws no bytes. */
export interface Marker {
  kind: 'empty-base' | 'zero-bitfield';
  path: string[];
  name: string;
  type?: string | null;
  offsetBits: number;
}

export interface PaddingRun {
  start: number;
  end: number;
}

/** One node of the containment tree the field table renders. */
export interface TreeNode {
  /** Stable within a model; used for keys and collapse state. */
  id: string;
  kind: 'leaf' | 'group';
  /** Index into `leaves` or `groups`. */
  ref: number;
  offsetBits: number;
  sizeBits: number;
  align: number | null;
  /** Leaf indices this subtree covers, for hover highlighting. */
  leafIndexes: number[];
  isBase: boolean;
  isUnion: boolean;
  /** This node's bytes intersect a sibling's (union, EBO, tail-padding reuse). */
  overlaps: boolean;
  depth: number;
  children: TreeNode[];
}

export interface RenderModel {
  record: RecordLayout;
  leaves: Leaf[];
  groups: Group[];
  markers: Marker[];
  tree: TreeNode[];
  paddings: PaddingRun[];
  sizeBits: number;
  /** Null when the record was too large to scan for padding. */
  paddingBytes: number | null;
}

export type DiagnosticSeverity = 'error' | 'fatal error' | 'warning' | 'note' | 'remark';

export interface Diagnostic {
  line: number;
  column: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
}
