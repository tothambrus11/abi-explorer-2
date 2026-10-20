// What clients and the server say to each other beyond standard LSP.
//
// Clients that only want hovers and code actions (Zed, a plain Neovim setup)
// need none of this. It is for the editors that draw a layout panel (VS Code,
// CLion, the Neovim side split) and for the IDEs that know compile commands
// better than any file on disk (CMake Tools, CLion's project model).
//
// Sizes and offsets are in bits, as the engine reports them: bit-fields make
// bytes too coarse. Positions are LSP positions in the document as analysed.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface InitializationOptions {
  /** Where the engine is downloaded to. Defaults to the user cache directory. */
  cacheDirectory?: string;
  /** A directory already holding the engine files; nothing is downloaded. */
  enginePath?: string;
  /** Draw hover byte maps as SVG images (VS Code and Zed render them). */
  hoverImages?: boolean;
  /** Read compile_commands.json from here instead of searching, like clangd's flag. */
  compileCommandsDir?: string | undefined;
  /** Globs of in-project compilers that may be run to learn their include paths. */
  allowedCompilers?: string[];
  /** Flags for files no compile command covers. */
  fallbackFlags?: string[];
  /**
   * A target triple to lay files out for instead of the project's own, such as
   * `armv7-none-eabi`, against the engine's bundled C and C++ headers. The
   * project's -I, -D and -std flags still apply.
   */
  target?: string | undefined;
  /** Whether the editor's theme is dark or light, for the colours of hover images. Dark by default. */
  colorMode?: ColorMode;
}

export type ColorMode = 'dark' | 'light';

/** Client → server: the editor's theme turned dark or light. */
export const colorModeNotification = 'abiExplorer/colorMode';
export interface ColorModeParams {
  mode: ColorMode;
}

/** One entry of a compilation database, `command` already split. */
export interface CompileCommand {
  directory: string;
  file: string;
  arguments: string[];
}

/** Client → server: commands the editor knows from its project model. Replaces earlier ones. */
export const compileCommandsNotification = 'abiExplorer/compileCommands';
export interface CompileCommandsParams {
  /** Shown to the user as where the flags came from, e.g. `CMake Tools`. */
  source: string;
  commands: CompileCommand[];
}

/** Client → server: the layouts of one document, and which one the position falls in. */
export const layoutRequest = 'abiExplorer/layout';
export interface LayoutParams {
  textDocument: { uri: string };
  position?: Position;
  /** Also lay each record out as text, for clients that draw no graphics (Neovim). */
  includeText?: boolean;
  /** The text's opened table rows, per record name (node ids, `g3`); everything else starts shut. */
  open?: Record<string, string[]>;
}

/** Server → client: a document's layouts changed; ask again if it is on screen. */
export const layoutsChangedNotification = 'abiExplorer/layoutsChanged';
export interface LayoutsChangedParams {
  uri: string;
}

export type LayoutState = 'ready' | 'analyzing' | 'unavailable';

export interface LayoutResult {
  state: LayoutState;
  /** Why there is nothing, or what to be careful about. */
  message: string | null;
  records: RecordView[];
  /** The record the position is in, and the member under it. */
  selection: { recordId: number; memberIndex: number | null } | null;
  context: AnalysisContext | null;
}

export interface AnalysisContext {
  triple: string;
  /** `itanium` or `microsoft`. */
  cxxAbi: string;
  clangVersion: string;
  /** Where the flags came from: `compile_commands.json`, `CMake Tools`, `fallback flags`. */
  commandSource: string;
  /** The flags were borrowed from another file (a header has no command of its own). */
  commandInferred: boolean;
  /** Errors in the document itself. */
  errorCount: number;
  /** Errors in its headers or its flags, which can hide declarations just as well. */
  otherErrorCount: number;
  /** The first of those errors, where it is and what it says: `line 3: unknown type name 'foo'`. */
  firstError: string | null;
  /** Something that makes these layouts less trustworthy, such as a compiler that could not be asked. */
  warning: string | null;
}

export interface RecordView {
  id: number;
  kind: 'struct' | 'class' | 'union' | 'interface';
  /** As written in code, template arguments included: `Pair<int, char>`. */
  name: string;
  sizeBits: number;
  alignBits: number;
  /** Whole bytes no member touches, nested records included. Null when too large to scan. */
  paddingBytes: number | null;
  /** The record's name in the declaration. */
  nameRange: Range | null;
  /** The whole declaration. */
  extent: Range | null;
  /** `dsize`, `nvsize`, `nvalign`, the preferred alignment: shown where they differ from size and alignment. */
  dataSizeBits: number;
  nonVirtualSizeBits: number;
  nonVirtualAlignBits: number;
  preferredAlignBits: number;
  members: MemberView[];
  bases: BaseView[];
  /** Everything the record holds, nested, as the web explorer draws it. */
  layout: LayoutView;
  /** The byte map and member table in monospace text, when `includeText` was asked for. */
  text?: string;
  /** Where `text` is coloured, for clients that colour it themselves (Neovim). */
  textColors?: TextColor[];
  /** The member table's rows in `text`: what each line is, to open it or go to its source. */
  textRows?: TextRow[];
}

/**
 * A run of `text` to colour: `[line, startByte, endByte, foreground, background, style]`,
 * 0-based, columns in UTF-8 bytes (as Neovim counts them). Colours are member
 * slots (`c-1`…`c-8`, `c-special`) or the web's neutrals (`text`, `muted`,
 * `grid`, `baseline`, `accent`); the style is `bold`, `lit` (the member at the
 * caret, outlined on the web), `lit-row` (its table row, tinted) or null.
 */
export type TextColor = [number, number, number, string | null, string | null, string | null];

export interface TextRow {
  /** 0-based line in `text`. */
  line: number;
  /** The node's id (`g3`, `l0`), to name in `LayoutParams.open`. */
  id: string;
  /** It holds rows that can be opened. */
  opens: boolean;
  /** Its name in the document. */
  range: Range | null;
}

/**
 * The engine's render model, as the web explorer reads it: the leaves (every
 * scalar, every bit-field), the compound members holding them, and the tree
 * of what is inside what.
 */
export interface LayoutView {
  leaves: LeafView[];
  groups: GroupView[];
  tree: NodeView[];
  markers: MarkerView[];
  paddings: { startBits: number; endBits: number }[];
}

/** A colour slot: `c-1`…`c-8` for members, `c-special` for vtable and vbtable pointers. */
export type ColorSlot = string;

export interface LeafView {
  kind: 'field' | 'bitfield' | 'special';
  name: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  /** 0 for a bit-field, which has no alignment of its own. */
  alignBits: number;
  /** The enclosing members' names, outermost first. */
  path: string[];
  /** An empty member sharing an address: it occupies no bytes. */
  sharesAddress: boolean;
  /** A member of this record, not of a member's record (`msg.hdr.kind` is not). */
  direct: boolean;
  color: ColorSlot;
  nameRange: Range | null;
}

export interface GroupView {
  kind: 'member' | 'base' | 'primary-base' | 'vbase' | 'primary-vbase';
  name: string;
  type: string;
  offsetBits: number;
  sizeBits: number;
  typeSizeBits: number;
  alignBits: number;
  path: string[];
  isBase: boolean;
  isUnion: boolean;
  leafIndexes: number[];
  direct: boolean;
  /** The one colour it stands for, or null (a base or anonymous member, whose fields have their own). */
  color: ColorSlot | null;
  nameRange: Range | null;
  /** The record it is an instance of, and where that is declared, to open it. */
  recordId: number | null;
  declaration: { uri: string; range: Range } | null;
}

export interface NodeView {
  kind: 'leaf' | 'group';
  /** Into `leaves` or `groups`. */
  ref: number;
  /** Its bytes intersect a sibling's: a union, a reused tail. */
  overlaps: boolean;
  children: NodeView[];
}

export interface MarkerView {
  kind: 'empty-base' | 'zero-bitfield';
  name: string;
  type: string;
  offsetBits: number;
  path: string[];
}

/**
 * A direct member, as the record's declaration lists it: a record-typed field
 * is one member (its insides are that record's own layout), a base is one
 * member, and the members of an anonymous struct or union count as the
 * enclosing record's own, as the language treats them.
 */
export interface MemberView {
  /** `special` is something the ABI adds: a vtable pointer, a virtual base pointer. */
  kind: 'field' | 'bitfield' | 'base' | 'special';
  /** The field's name, the base's type, or the ABI's label such as `Base vtable pointer`. */
  label: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  alignBits: number;
  /** The member's name in this document; null when declared elsewhere (a base in a header). */
  nameRange: Range | null;
  /** The leaves of `RecordView.layout` it covers, and the group it is, if it is one. */
  leaves: number[];
  group: number | null;
}

export interface BaseView {
  name: string;
  offsetBits: number;
  sizeBits: number;
  isVirtual: boolean;
}
