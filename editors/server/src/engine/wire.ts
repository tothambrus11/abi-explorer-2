// The engine's request and response, as far as this server reads them.
//
// The full contract is clang-abi-wasm's `js/index.d.ts`; the names and units
// here are copied from it unchanged (sizes and offsets in bits, cross-references
// by id). Nothing outside `src/engine` and `src/layout/views.ts` should need
// this file: the rest of the server works with the view types built from it.

export interface EngineRequest {
  source: string;
  filename: string;
  lang: 'c' | 'c++';
  triple: string;
  flags: string[];
  /** '' turns off the engine's own `-resource-dir`/`-nostdinc` handling. */
  resourceDir: string;
  /** '' turns off the engine's bundled libc++ and musl. */
  sysroot: string;
  includeSystemRecords: boolean;
}

export interface Location {
  file: string;
  line: number;
  /** 1-based, in bytes. */
  col: number;
  /** 1-based, exclusive. */
  endCol: number;
  isMainFile: boolean;
}

export interface SourceRange {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface Diagnostic {
  severity: 'note' | 'remark' | 'warning' | 'error' | 'fatal';
  message: string;
  location: Location | null;
}

export interface Base {
  recordId: number;
  typeSpelling: string;
  offsetBits: number;
  sizeBits: number;
  isVirtual: boolean;
  isEmpty: boolean;
}

export interface Field {
  id: number;
  name: string;
  offsetBits: number;
  typeSpelling: string;
  sizeBits: number;
  alignBits: number;
  isBitField: boolean;
  location: Location | null;
}

export interface PaddingRun {
  startBits: number;
  endBits: number;
}

export interface RenderLeaf {
  kind: 'field' | 'bitfield' | 'special';
  name: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  alignBits: number;
  path: string[];
  sharesAddress: boolean;
  location: Location | null;
}

/** A compound member: a base, a record-typed field, an anonymous aggregate. */
export interface RenderGroup {
  kind: 'member' | 'base' | 'primary-base' | 'vbase' | 'primary-vbase';
  name: string;
  type: string;
  offsetBits: number;
  sizeBits: number;
  alignBits: number;
  /** The record it is an instance of. */
  recordId: number | null;
  /** A base carries its specifier's span (no file: it is the record's); a member, its name's location. */
  location: Location | SourceRange | null;
}

/** Containment: what is inside what, as indexes into `leaves` and `groups`. */
export interface RenderNode {
  kind: 'leaf' | 'group';
  ref: number;
  children: RenderNode[];
}

export interface Render {
  leaves: RenderLeaf[];
  groups: RenderGroup[];
  tree: RenderNode[];
  paddingRuns: PaddingRun[];
  paddingBytes: number | null;
}

export interface RecordLayout {
  id: number;
  kind: 'struct' | 'class' | 'union' | 'interface';
  name: string;
  qualifiedName: string;
  printedName: string;
  isAnonymous: boolean;
  location: Location | null;
  range: SourceRange | null;
  sizeBits: number;
  alignBits: number;
  bases: Base[];
  fields: Field[];
  parentRecordId: number | null;
  render: Render;
}

export interface TargetInfo {
  triple: string;
  normalizedTriple: string;
  cxxAbi: string;
}

export interface EngineResponse {
  ok: boolean;
  error: string | null;
  clangVersion: string;
  exitCode: number;
  target: TargetInfo | null;
  diagnostics: Diagnostic[];
  records: RecordLayout[];
}
