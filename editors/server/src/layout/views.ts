// From the engine's response to what the editors are shown.
//
// The engine reports every record the translation unit laid out, in its own
// coordinates: guest paths, 1-based lines, byte columns. A document wants the
// records declared in it, with LSP ranges in UTF-16 code units, and each
// record's direct members rather than every scalar inside them. Everything
// past this file works with `RecordView`.

import type { MemberView, Range, RecordView } from '../protocol.ts';
import type { Location, RecordLayout, RenderNode, SourceRange } from '../engine/wire.ts';

export interface DocumentCoordinates {
  /** The document's path as the engine was given it. */
  guestPath: string;
  /** The text that was analysed, for turning byte columns into characters. */
  text: string;
}

export function recordViewsFor(records: readonly RecordLayout[], document: DocumentCoordinates): RecordView[] {
  const lines = document.text.split(/\r?\n/);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const inDocument = (location: Location | null): location is Location =>
    location !== null && location.file === document.guestPath;

  return records.flatMap((record): RecordView[] => {
    if (record.isAnonymous || !inDocument(record.location)) return [];
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
        if (group.kind === 'member' && nested?.isAnonymous) {
          visit(node.children);
          continue;
        }
        const location = group.location;
        members.push({
          kind: group.kind === 'member' ? 'field' : 'base',
          label: group.kind === 'member' ? group.name : group.type,
          type: group.type,
          offsetBits: group.offsetBits,
          sizeBits: group.sizeBits,
          alignBits: group.alignBits,
          // A base specifier's range has no file of its own: it is in the record's.
          nameRange:
            location === null ? null : 'file' in location ? (inDocument(location) ? rangeOf(location, lines) : null) : extentOf(location, lines),
        });
      }
    };
    visit(record.render.tree);

    return [
      {
        id: record.id,
        kind: record.kind,
        name: displayName(record),
        sizeBits: record.sizeBits,
        alignBits: record.alignBits,
        paddingBytes: record.render.paddingBytes,
        nameRange: rangeOf(record.location, lines),
        extent: record.range ? extentOf(record.range, lines) : null,
        members,
        paddingRuns: record.render.paddingRuns,
        bases: record.bases.map((base) => ({
          name: base.typeSpelling,
          offsetBits: base.offsetBits,
          sizeBits: base.sizeBits,
          isVirtual: base.isVirtual,
        })),
      },
    ];
  });
}

/** `struct Pair<int, char>` → `Pair<int, char>`; a plain record keeps its qualified name. */
function displayName(record: RecordLayout): string {
  const printed = record.printedName.replace(/^(struct|class|union|__interface) /, '');
  return printed.includes('<') ? printed : record.qualifiedName || printed;
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
    end: { line: range.endLine - 1, character: characterAt(lines[range.endLine - 1] ?? '', range.endCol) },
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
