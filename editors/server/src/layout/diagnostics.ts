// The server's one warning: a record whose member order wastes space, on its
// name, with the reorder code action as its fix (`@abi-explorer/shared/reorder`,
// which the web explorer shares).

import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { RecordView } from '@abi-explorer/shared/protocol';
import { reorderWarningAt } from '@abi-explorer/shared/reorder';

export const DIAGNOSTIC_SOURCE = 'abi-explorer';
export const REORDER_CODE = 'reorder';

export function layoutDiagnostics(
  records: readonly RecordView[],
  lines: readonly string[],
): Diagnostic[] {
  const seen = new Set<string>();
  return records.flatMap((record): Diagnostic[] => {
    const message = reorderWarningAt(record, lines);
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
