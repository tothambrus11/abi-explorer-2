// From the engine's response to what the editors are shown.
//
// The engine reports every record the translation unit laid out, in its own
// coordinates: guest paths, 1-based lines, byte columns. A document wants the
// records declared in it, with LSP ranges in UTF-16 code units, and each
// record's direct members rather than every scalar inside them. Everything
// past this file works with `RecordView`.

import type { MemberView, Position, Range, RecordView } from '@abi-explorer/shared/protocol';
import type { Location, RecordLayout, RenderNode, SourceRange } from '../engine/engineTypes.ts';

export interface DocumentCoordinates {
  /** The document's path as the engine was given it. */
  guestPath: string;
  /** The text that was analysed, for turning byte columns into characters. */
  text: string;
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
      : [recordView(record, recordsById, document.guestPath, lines)],
  );
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
): RecordView {
  const inDocument = (location: Location | null): location is Location =>
    location !== null && location.file === guestPath;
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
          nameRange: inDocument(leaf.location) ? rangeOf(leaf.location, lines) : null,
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
      const location = group.location;
      members.push({
        kind: group.kind === 'member' ? 'field' : 'base',
        label: group.kind === 'member' ? group.name : group.type,
        // `struct (unnamed at input.c:1:16)` as `struct (unnamed)`.
        type: group.type.replace(/ at [^()]*:\d+:\d+\)/, ')'),
        offsetBits: group.offsetBits,
        sizeBits: group.sizeBits,
        alignBits: group.alignBits,
        // A base specifier's range has no file of its own: it is in the record's.
        nameRange:
          location === null
            ? null
            : 'file' in location
              ? inDocument(location)
                ? rangeOf(location, lines)
                : null
              : extentOf(location, lines),
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
    members,
    bases: record.bases.map((base) => ({
      name: base.typeSpelling,
      offsetBits: base.offsetBits,
      sizeBits: base.sizeBits,
      isVirtual: base.isVirtual,
    })),
  };
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
