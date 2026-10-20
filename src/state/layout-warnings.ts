// The reorder warning in the editor: the editor plugins' warning and fixes,
// read off the app's own model.
//
// A record whose member order wastes space gets a warning on its name, with
// two quick fixes: reorder the members by alignment, or keep the order and say
// so in a comment. What decides all three is `@abi-explorer/shared/reorder`,
// which the language server uses too, so the web and the editors warn about
// the same records and fix them the same way. This file only translates: the
// app's render model into the few facts that module reads, and its 0-based
// UTF-16 ranges into Monaco's 1-based columns.

import type { Range } from '@abi-explorer/shared/protocol';
import type { ReorderMember, ReorderRecord } from '@abi-explorer/shared/layoutModel';
import { keepOrderEdit, reorderAction, reorderWarningAt } from '@abi-explorer/shared/reorder';
import type { AnalysedRecord, Analysis } from '$compiler/AbiAnalyzer';
import type { SourceLocation, SourceSpan, TreeNode } from '$core/types';

/** A span in the editor: 1-based lines and columns, the end exclusive. */
export interface EditorSpan {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface LayoutFix {
  title: string;
  edits: { span: EditorSpan; text: string }[];
  /** The fix Monaco applies on "auto fix": the reorder. */
  preferred: boolean;
}

export interface LayoutWarning {
  /** The record's name. */
  span: EditorSpan;
  /** The whole declaration: the fixes are offered with the caret anywhere in it. */
  extent: EditorSpan;
  message: string;
  fixes: LayoutFix[];
}

/**
 * The warnings for `analysis`, each with its fixes, in the coordinates of the
 * text that was analysed (`analysis.source`): the caller offers the fixes only
 * while the editor still holds that text.
 *
 * None for Hylo, which orders a struct's members itself.
 */
export function layoutWarnings(analysis: Analysis): LayoutWarning[] {
  if (analysis.options.lang === 'hylo') return [];
  const lines = analysis.source.split(/\r?\n/);
  const seen = new Set<string>();
  const out: LayoutWarning[] = [];
  for (const entry of analysis.records) {
    if (!entry.listed) continue;
    const record = reorderRecord(entry, lines);
    if (!record?.nameRange || !record.extent) continue;
    const message = reorderWarningAt(record, lines);
    if (!message) continue;
    // A template's instantiations share its name: one warning each, worded by their names.
    const key = `${JSON.stringify(record.nameRange)}${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fixes: LayoutFix[] = [];
    const reorder = reorderAction(record, lines);
    if (reorder) {
      fixes.push({
        title: reorder.title,
        edits: reorder.edits.map((e) => ({ span: editorSpan(e.range), text: e.newText })),
        preferred: true,
      });
    }
    const keep = keepOrderEdit(record, lines);
    if (keep) {
      fixes.push({
        title: 'Keep this member order',
        edits: [{ span: editorSpan(keep.range), text: keep.newText }],
        preferred: false,
      });
    }
    out.push({
      span: editorSpan(record.nameRange),
      extent: editorSpan(record.extent),
      message,
      fixes,
    });
  }
  return out;
}

/**
 * The record as the shared module reads it: its direct members as the
 * language server lists them (an anonymous aggregate's fields are the
 * record's own, a base is one member), with ranges in the analysed text.
 * Null for what the warning has nothing to say about (a Hylo enum).
 */
export function reorderRecord(
  entry: AnalysedRecord,
  lines: readonly string[],
): ReorderRecord | null {
  const { record, model } = entry;
  if (record.kind === 'enum') return null;
  const members: ReorderMember[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'leaf') {
        const leaf = model.leaves[node.ref]!;
        members.push({
          kind: leaf.kind,
          label: leaf.name || '(unnamed)',
          offsetBits: leaf.offsetBits,
          sizeBits: leaf.sizeBits,
          alignBits: (leaf.align ?? 0) * 8,
          nameRange: rangeOf(leaf.location, lines),
        });
        continue;
      }
      const group = model.groups[node.ref]!;
      if (group.kind === 'member' && (group.name === '' || group.name.startsWith('('))) {
        visit(node.children);
        continue;
      }
      members.push({
        kind: group.isBase ? 'base' : 'field',
        label: group.isBase ? group.type : group.name,
        offsetBits: group.offsetBits,
        sizeBits: group.sizeBits,
        alignBits: (group.align ?? 0) * 8,
        nameRange: rangeOf(group.location, lines),
      });
    }
  };
  visit(model.tree);

  const nameRange = nameRangeOf(entry, lines);
  let extent = record.location?.isMainFile ? rangeOf(record.range, lines) : null;
  // `typedef struct { … } Pair;` reaches to its name, so the name counts as inside.
  if (extent && nameRange && after(nameRange.end, extent.end)) {
    extent = { start: extent.start, end: nameRange.end };
  }
  return {
    kind: record.kind === '__interface' ? 'interface' : record.kind,
    // `Pair<struct P>` as it is written in C++.
    name: record.name.replace(/(^|[<,(]\s*)(?:struct|class|union|enum|__interface) /g, '$1'),
    sizeBits: record.sizeBytes * 8,
    alignBits: record.align * 8,
    paddingBytes: model.paddingBytes,
    nameRange,
    extent,
    members,
  };
}

/**
 * Where the record's name is: its tag, or for `typedef struct { … } Pair;` the
 * typedef name after the closing brace (clang points at `struct`).
 */
function nameRangeOf(entry: AnalysedRecord, lines: readonly string[]): Range | null {
  const { record } = entry;
  const tag = rangeOf(record.location, lines);
  if (!tag) return null;
  const written = (lines[tag.start.line] ?? '').slice(tag.start.character, tag.end.character);
  const extent = rangeOf(record.range, lines);
  if (!/^(struct|class|union)$/.test(written) || !extent) return tag;
  const typedefName = record.name.split('::').at(-1)!;
  const rest = (lines[extent.end.line] ?? '').slice(extent.end.character);
  const match = /^(\s*)(\w+)/.exec(rest);
  if (match?.[2] !== typedefName) return tag;
  const start = extent.end.character + match[1]!.length;
  return {
    start: { line: extent.end.line, character: start },
    end: { line: extent.end.line, character: start + typedefName.length },
  };
}

/** A location in the user's file, or a span (always in it), as a 0-based range. */
function rangeOf(loc: SourceLocation | SourceSpan | null, lines: readonly string[]): Range | null {
  if (!loc || ('isMainFile' in loc && !loc.isMainFile)) return null;
  const endLine = 'endLine' in loc ? loc.endLine : loc.line;
  return {
    start: { line: loc.line - 1, character: characterAt(lines[loc.line - 1] ?? '', loc.col) },
    end: { line: endLine - 1, character: characterAt(lines[endLine - 1] ?? '', loc.endCol) },
  };
}

const utf8 = new TextEncoder();

/** A 1-based UTF-8 byte column, as clang counts, as a 0-based UTF-16 offset. */
function characterAt(lineText: string, byteColumn: number): number {
  let bytes = 0;
  let characters = 0;
  for (const codePoint of lineText) {
    if (bytes >= byteColumn - 1) break;
    bytes += utf8.encode(codePoint).length;
    characters += codePoint.length;
  }
  return characters;
}

function after(a: Range['start'], b: Range['start']): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

function editorSpan(range: Range): EditorSpan {
  return {
    line: range.start.line + 1,
    col: range.start.character + 1,
    endLine: range.end.line + 1,
    endCol: range.end.character + 1,
  };
}
