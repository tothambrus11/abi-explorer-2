// "Reorder members by alignment": the code action behind the reorder note.
//
// It moves whole lines, so it is offered only where each member is one
// declaration on a line of its own and nothing between them would change
// meaning when they move (an access specifier, a preprocessor line).
// Everything else in the record (comments, functions, blank lines) stays put.

import type { Range, RecordView } from '@abi-explorer/shared/protocol';
import { formatSizeShort } from '@abi-explorer/shared/format';
import { tighterOrder } from '@abi-explorer/shared/layoutModel';

export interface ReorderAction {
  title: string;
  edits: { range: Range; newText: string }[];
}

/** The action for `record`, given the document's lines, or null where it would not be safe. */
export function reorderAction(record: RecordView, lines: readonly string[]): ReorderAction | null {
  const tighter = tighterOrder(record);
  if (!tighter) return null;
  const memberLines = record.members.map((member) => member.nameRange?.start.line);
  if (memberLines.some((line) => line === undefined)) return null;
  const slots = (memberLines as number[]).slice().sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) return null;

  for (const line of slots) {
    const code = withoutComment(lines[line] ?? '');
    if (
      !code.endsWith(';') ||
      hasTopLevelComma(code) ||
      /\b(struct|class|union|enum)\b[^;]*\{/.test(code)
    ) {
      return null;
    }
    // The line holds the whole declaration: the one before it ends another.
    const previous = withoutComment(lines[line - 1] ?? '');
    if (!(previous === '' || /[;{]$/.test(previous) || ACCESS.test(previous))) return null;
  }
  for (let line = slots[0]!; line <= slots.at(-1)!; line++) {
    const code = withoutComment(lines[line] ?? '');
    if (ACCESS.test(code) || code.startsWith('#')) return null;
  }

  const edits = slots.map((line, slot) => ({
    range: { start: { line, character: 0 }, end: { line, character: lines[line]!.length } },
    newText: lines[memberLines[tighter.order[slot]!]!]!,
  }));
  const saved = formatSizeShort(record.sizeBits - tighter.sizeBits);
  return {
    title: `Reorder ${record.name}'s members by alignment (${formatSizeShort(tighter.sizeBits)}, ${saved} less)`,
    edits,
  };
}

const ACCESS = /^(public|private|protected)\s*:$/;

/** The line's code, trimmed, without a trailing line comment, or empty for a whole-line block comment. */
function withoutComment(line: string): string {
  const code = line.replace(/\/\/.*$/, '').trim();
  return /^\/\*.*\*\/$/.test(code) ? '' : code;
}

/** `int x, y;` declares two members; `std::map<int, int> m;` declares one. */
function hasTopLevelComma(code: string): boolean {
  let depth = 0;
  for (const char of code) {
    if ('<([{'.includes(char)) depth++;
    else if ('>)]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return true;
  }
  return false;
}
