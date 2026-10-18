// The server's one warning: a record whose member order wastes space, on its
// name, with the reorder code action as its fix. A record whose order is kept
// on purpose (a wire format, a layout shared with C) says so in a comment above
// it, `// abi-explorer: keep order`, which the other fix writes.

import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { Range, RecordView } from '@abi-explorer/shared/protocol';
import { reorderWarning } from '@abi-explorer/shared/layoutModel';

export const DIAGNOSTIC_SOURCE = 'abi-explorer';
export const REORDER_CODE = 'reorder';

const KEEP_ORDER = /abi-explorer:\s*keep[- ]order/i;
const KEEP_ORDER_COMMENT = '// abi-explorer: keep order';

export function layoutDiagnostics(
  records: readonly RecordView[],
  lines: readonly string[],
): Diagnostic[] {
  const seen = new Set<string>();
  return records.flatMap((record): Diagnostic[] => {
    const message = record.nameRange && !keepsOrder(record, lines) && reorderWarning(record);
    if (!message) return [];
    // A template's instantiations share its name: one warning each, worded by their names.
    const key = `${JSON.stringify(record.nameRange)}${message}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        range: record.nameRange!,
        severity: DiagnosticSeverity.Warning,
        source: DIAGNOSTIC_SOURCE,
        code: REORDER_CODE,
        message,
      },
    ];
  });
}

/** Whether the comments right above the record (or its first line) ask to keep its order. */
export function keepsOrder(record: RecordView, lines: readonly string[]): boolean {
  if (!record.extent) return false;
  const start = record.extent.start.line;
  if (KEEP_ORDER.test(lines[start] ?? '')) return true;
  for (let line = start - 1; line >= 0; line--) {
    const text = lines[line]!.trim();
    if (KEEP_ORDER.test(text)) return true;
    if (!isCommentOrTemplateHead(text)) return false;
  }
  return false;
}

/** The warning's other fix: the comment that keeps the order, above the declaration. */
export function keepOrderEdit(
  record: RecordView,
  lines: readonly string[],
): { range: Range; newText: string } | null {
  if (!record.extent || keepsOrder(record, lines)) return null;
  let line = record.extent.start.line;
  // Above `template <…>` when that is a line of its own.
  while (line > 0 && /^template\s*</.test(lines[line - 1]!.trim())) line--;
  const indent = /^\s*/.exec(lines[line] ?? '')![0];
  const at = { line, character: 0 };
  return { range: { start: at, end: at }, newText: `${indent}${KEEP_ORDER_COMMENT}\n` };
}

function isCommentOrTemplateHead(text: string): boolean {
  return /^(\/\/|\/\*|\*)/.test(text) || /^template\s*</.test(text);
}
