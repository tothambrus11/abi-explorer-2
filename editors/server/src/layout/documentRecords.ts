// From the engine's response to what the editors are shown.
//
// The engine reports every record the translation unit laid out, in its own
// coordinates: guest paths, 1-based lines, byte columns. A document wants the
// records declared in it, with LSP ranges in UTF-16 code units, and each
// record's direct members rather than every scalar inside them. Everything
// past this file works with `RecordView`.

import type {
  GroupView,
  LayoutView,
  LeafView,
  MemberView,
  NodeView,
  Position,
  Range,
  RecordView,
} from '@abi-explorer/shared/protocol';
import type { Location, RecordLayout, RenderNode, SourceRange } from '../engine/engineTypes.ts';

export interface DocumentCoordinates {
  /** The document's path as the engine was given it. */
  guestPath: string;
  /** The text that was analysed, for turning byte columns into characters. */
  text: string;
  /** A guest path's file URI on this machine, or null where it has none (a bundled header). */
  uriOf?: (guestPath: string) => string | null;
}

export function recordsInDocument(
  records: readonly RecordLayout[],
  document: DocumentCoordinates,
): RecordView[] {
  const lines = document.text.split(/\r?\n/);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return records.flatMap((record): RecordView[] =>
    unnamed(record) || record.location?.file !== document.guestPath
      ? []
      : [recordView(record, recordsById, document.guestPath, lines, document.uriOf)],
  );
}

/**
 * The unnamed types of named members in the document (`struct { … } inner;`),
 * each named after its member (`Outer::inner`): not records of their own, but
 * their fields have hovers like any other.
 */
export function nestedRecordsInDocument(
  records: readonly RecordLayout[],
  document: DocumentCoordinates,
): RecordView[] {
  const lines = document.text.split(/\r?\n/);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return records.flatMap((parent): RecordView[] => {
    if (unnamed(parent) || parent.location?.file !== document.guestPath) return [];
    return parent.render.groups.flatMap((group): RecordView[] => {
      const nested = group.recordId === null ? undefined : recordsById.get(group.recordId);
      if (group.kind !== 'member' || !nested || !unnamed(nested) || !/^\w+$/.test(group.name)) {
        return [];
      }
      const view = recordView(nested, recordsById, document.guestPath, lines, document.uriOf);
      return [{ ...view, name: `${displayName(parent)}::${group.name}`, nameRange: null }];
    });
  });
}

/**
 * The records the translation unit laid out, by the names a document can
 * use for them: `Pair<double>`, `ns::Shape`, `Shape`, and each field's type
 * as written (`std::string`, which clang prints as `std::basic_string<char>`).
 * Spellings are compared without spaces; a name that means two records means
 * neither.
 */
export function typeIndex(
  records: readonly RecordLayout[],
): (spelling: string) => RecordView | null {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const byName = new Map<string, RecordLayout | null>();
  const add = (name: string, record: RecordLayout) => {
    const key = name.replace(/\s+/g, '');
    if (!key) return;
    const known = byName.get(key);
    byName.set(key, known === undefined || known === record ? record : null);
  };
  for (const record of records) {
    if (unnamed(record)) continue;
    const printed = withoutTags(record.printedName);
    add(printed, record);
    if (record.qualifiedName) add(record.qualifiedName, record);
    const parts = printed.split('::');
    for (let index = 1; index < parts.length; index++) add(parts.slice(index).join('::'), record);
  }
  for (const record of records) {
    for (const group of record.render.groups) {
      const target = group.recordId === null ? undefined : recordsById.get(group.recordId);
      if (target && !unnamed(target)) add(group.type.replace(/^const |^volatile /, ''), target);
    }
  }
  for (const [alias, name] of STANDARD_ALIASES) {
    const record = byName.get(name);
    if (record && !byName.has(alias)) byName.set(alias, record);
  }
  const views = new Map<RecordLayout, RecordView>();
  return (spelling) => {
    const key = spelling.replace(/\s+/g, '').replace(/^::/, '');
    const record = byName.get(key);
    if (!record) return null;
    let view = views.get(record);
    if (!view) {
      view = recordView(record, recordsById, null, []);
      views.set(record, view);
    }
    return view;
  };
}

/** The standard library's aliases for records, which no field may happen to spell out. */
const STANDARD_ALIASES: [string, string][] = [
  ['char', 'string'],
  ['wchar_t', 'wstring'],
  ['char8_t', 'u8string'],
  ['char16_t', 'u16string'],
  ['char32_t', 'u32string'],
].flatMap(([char, string]) => [
  [`std::${string}`, `std::basic_string<${char}>`],
  [`std::${string}_view`, `std::basic_string_view<${char}>`],
]);

/**
 * A record with no name to call it by: an anonymous struct or union member.
 * `typedef struct { … } Pair;` is anonymous too, but clang names it `Pair`.
 */
function unnamed(record: RecordLayout): boolean {
  return (
    record.isAnonymous && !/^[A-Za-z_]\w*$/.test(record.qualifiedName.split('::').at(-1) ?? '')
  );
}

/**
 * Where the record's name is: its tag, or for `typedef struct { … } Pair;` the
 * typedef name after the closing brace (the engine points at `struct`).
 */
function nameRangeOf(record: RecordLayout, lines: readonly string[]): Range {
  const tagRange = rangeOf(record.location!, lines);
  if (!record.isAnonymous || !record.range) return tagRange;
  const extent = extentOf(record.range, lines);
  const after = (lines[extent.end.line] ?? '').slice(extent.end.character);
  const typedefName = record.qualifiedName.split('::').at(-1)!;
  const match = /^(\s*)(\w+)/.exec(after);
  if (match?.[2] !== typedefName) return tagRange;
  const start = extent.end.character + match[1]!.length;
  return {
    start: { line: extent.end.line, character: start },
    end: { line: extent.end.line, character: start + typedefName.length },
  };
}

/** One record as a view; ranges only for locations in `guestPath`, the file `lines` are of. */
function recordView(
  record: RecordLayout,
  recordsById: ReadonlyMap<number, RecordLayout>,
  guestPath: string | null,
  lines: readonly string[],
  uriOf: (guestPath: string) => string | null = () => null,
): RecordView {
  const inDocument = (location: Location | null): location is Location =>
    location !== null && location.file === guestPath;
  const layout = layoutView(record, recordsById, guestPath, lines, uriOf);
  const members: MemberView[] = [];
  const visit = (nodes: readonly RenderNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'leaf') {
        const leaf = record.render.leaves[node.ref]!;
        members.push({
          kind: leaf.kind,
          label: leaf.name || '(unnamed)',
          type: leaf.type,
          offsetBits: leaf.offsetBits,
          sizeBits: leaf.sizeBits,
          alignBits: leaf.alignBits,
          nameRange: layout.leaves[node.ref]!.nameRange,
          leaves: [node.ref],
          group: null,
        });
        continue;
      }
      const group = record.render.groups[node.ref]!;
      const nested = group.recordId === null ? undefined : recordsById.get(group.recordId);
      // An anonymous member's fields are the record's own; a named member of an
      // unnamed type (`struct { … } inner;`) is one member like any other.
      const anonymousMember = group.name === '' || group.name.startsWith('(');
      if (group.kind === 'member' && nested && unnamed(nested) && anonymousMember) {
        visit(node.children);
        continue;
      }
      members.push({
        kind: group.kind === 'member' ? 'field' : 'base',
        label: group.kind === 'member' ? group.name : group.type,
        // `struct (unnamed at input.c:1:16)` as `struct (unnamed)`.
        type: group.type.replace(/ at [^()]*:\d+:\d+\)/, ')'),
        offsetBits: group.offsetBits,
        sizeBits: group.sizeBits,
        alignBits: group.alignBits,
        nameRange: layout.groups[node.ref]!.nameRange,
        leaves: group.leafIndexes,
        group: node.ref,
      });
    }
  };
  visit(record.render.tree);

  const here = inDocument(record.location);
  const nameRange = here ? nameRangeOf(record, lines) : null;
  let extent = here && record.range ? extentOf(record.range, lines) : null;
  // `typedef struct { … } Pair;` reaches to its name, so the name counts as inside.
  if (extent && nameRange && after(nameRange.end, extent.end)) {
    extent = { start: extent.start, end: nameRange.end };
  }
  return {
    id: record.id,
    kind: record.kind,
    name: displayName(record),
    sizeBits: record.sizeBits,
    alignBits: record.alignBits,
    paddingBytes: record.render.paddingBytes,
    nameRange,
    extent,
    dataSizeBits: record.dataSizeBits,
    nonVirtualSizeBits: record.nonVirtualSizeBits,
    nonVirtualAlignBits: record.nonVirtualAlignBits,
    preferredAlignBits: record.preferredAlignBits,
    layout,
    members,
    bases: record.bases.map((base) => ({
      name: base.typeSpelling,
      offsetBits: base.offsetBits,
      sizeBits: base.sizeBits,
      isVirtual: base.isVirtual,
    })),
  };
}

/**
 * The engine's render model with ranges in the document, and each member's
 * colour, assigned as the web explorer assigns them (its `src/core/render.ts`).
 */
function layoutView(
  record: RecordLayout,
  recordsById: ReadonlyMap<number, RecordLayout>,
  guestPath: string | null,
  lines: readonly string[],
  uriOf: (guestPath: string) => string | null,
): LayoutView {
  const render = record.render;
  // A base specifier's range has no file of its own: it is in the record's.
  const here = (location: Location | SourceRange | null): Range | null =>
    location === null
      ? null
      : 'file' in location
        ? location.file === guestPath
          ? rangeOf(location, lines)
          : null
        : guestPath === null
          ? null
          : extentOf(location, lines);
  const leaves: LeafView[] = render.leaves.map((leaf) => ({
    kind: leaf.kind,
    name: leaf.name,
    type: leaf.type,
    offsetBits: leaf.offsetBits,
    sizeBits: leaf.sizeBits,
    alignBits: leaf.alignBits,
    path: leaf.path,
    sharesAddress: leaf.sharesAddress,
    direct: false,
    color: SPECIAL_COLOR,
    nameRange: here(leaf.location),
  }));
  const groups: GroupView[] = render.groups.map((group) => {
    const target = group.recordId === null ? undefined : recordsById.get(group.recordId);
    const file = target?.location?.file;
    const uri = file === undefined ? null : uriOf(file);
    return {
      kind: group.kind,
      name: group.name,
      // `struct (unnamed at input.c:1:16)` as `struct (unnamed)`.
      type: group.type.replace(/ at [^()]*:\d+:\d+\)/, ')'),
      offsetBits: group.offsetBits,
      sizeBits: group.sizeBits,
      typeSizeBits: group.typeSizeBits,
      alignBits: group.alignBits,
      path: group.path,
      isBase: group.isBase,
      isUnion: group.isUnion,
      leafIndexes: group.leafIndexes,
      direct: false,
      color: null,
      nameRange: here(group.location),
      recordId: group.recordId,
      declaration:
        uri === null || !target?.location
          ? null
          : {
              uri,
              range:
                file === guestPath
                  ? rangeOf(target.location, lines)
                  : {
                      start: { line: target.location.line - 1, character: target.location.col - 1 },
                      end: {
                        line: target.location.line - 1,
                        character: target.location.endCol - 1,
                      },
                    },
            },
    };
  });
  const tree = nodes(render.tree);
  markDirect(tree, leaves, groups, false);
  assignColors(leaves, groups);
  return {
    leaves,
    groups,
    tree,
    markers: render.markers.map(({ kind, name, type, offsetBits, path }) => ({
      kind,
      name,
      type,
      offsetBits,
      path,
    })),
    paddings: render.paddingRuns.map(({ startBits, endBits }) => ({ startBits, endBits })),
  };
}

function nodes(tree: readonly RenderNode[]): NodeView[] {
  return tree.map((node) => ({
    kind: node.kind,
    ref: node.ref,
    overlaps: node.overlaps,
    children: nodes(node.children),
  }));
}

/**
 * Does naming what is inside this group skip it? An anonymous aggregate's
 * fields (`msg.crc_lo`) and a base's (`d.b`) are the record's own, so they
 * are coloured one by one; a named member (`msg.hdr`) is one unit, one colour.
 */
function transparent(group: GroupView): boolean {
  return group.isBase || group.name === '' || group.name.startsWith('(');
}

function markDirect(
  tree: readonly NodeView[],
  leaves: LeafView[],
  groups: GroupView[],
  throughMember: boolean,
): void {
  for (const node of tree) {
    const group = node.kind === 'group' ? groups[node.ref] : undefined;
    const subject = group ?? leaves[node.ref];
    if (subject) subject.direct = !throughMember;
    markDirect(node.children, leaves, groups, throughMember || (!!group && !transparent(group)));
  }
}

/** Every vtable and vbtable pointer's colour, whatever it belongs to. */
const SPECIAL_COLOR = 'c-special';
const PALETTE_SIZE = 8;

/**
 * One colour per direct member, in the web explorer's order: named compound
 * members first (all their leaves share it), then the remaining leaves.
 */
function assignColors(leaves: LeafView[], groups: GroupView[]): void {
  const slot = (index: number) => `c-${(index % PALETTE_SIZE) + 1}`;
  let next = 0;
  const assigned = new Set<number>();
  for (const group of groups) {
    if (!group.direct || transparent(group)) continue;
    const color = slot(next++);
    for (const index of group.leafIndexes) {
      const leaf = leaves[index];
      if (!leaf || assigned.has(index)) continue;
      leaf.color = leaf.kind === 'special' ? SPECIAL_COLOR : color;
      assigned.add(index);
    }
  }
  leaves.forEach((leaf, index) => {
    if (!assigned.has(index)) leaf.color = leaf.kind === 'special' ? SPECIAL_COLOR : slot(next++);
  });
  for (const group of groups) {
    if (transparent(group)) continue;
    // The one colour its leaves share, vtable pointers aside; none if they differ.
    const colors = new Set(
      group.leafIndexes.map((index) => leaves[index]!.color).filter((c) => c !== SPECIAL_COLOR),
    );
    group.color =
      colors.size === 1
        ? [...colors][0]!
        : colors.size === 0 && group.leafIndexes.length > 0
          ? SPECIAL_COLOR
          : null;
  }
}

/** `struct Pair<int, char>` → `Pair<int, char>`; a plain record keeps its qualified name. */
function displayName(record: RecordLayout): string {
  const printed = withoutTags(record.printedName);
  return printed.includes('<') ? printed : record.qualifiedName || printed;
}

function after(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

/** `class std::optional<struct P>` → `std::optional<P>`, as the type is written in C++. */
function withoutTags(printedName: string): string {
  return printedName.replace(/(^|[<,(]\s*)(?:struct|class|union|enum|__interface) /g, '$1');
}

function rangeOf(location: Location, lines: readonly string[]): Range {
  const line = location.line - 1;
  const text = lines[line] ?? '';
  return {
    start: { line, character: characterAt(text, location.col) },
    end: { line, character: characterAt(text, location.endCol) },
  };
}

function extentOf(range: SourceRange, lines: readonly string[]): Range {
  return {
    start: { line: range.line - 1, character: characterAt(lines[range.line - 1] ?? '', range.col) },
    end: {
      line: range.endLine - 1,
      character: characterAt(lines[range.endLine - 1] ?? '', range.endCol),
    },
  };
}

/** A 1-based UTF-8 byte column as a 0-based UTF-16 character offset. */
export function characterAt(lineText: string, byteColumn: number): number {
  let bytes = 0;
  let characters = 0;
  for (const codePoint of lineText) {
    if (bytes >= byteColumn - 1) break;
    bytes += Buffer.byteLength(codePoint, 'utf8');
    characters += codePoint.length;
  }
  return characters;
}
