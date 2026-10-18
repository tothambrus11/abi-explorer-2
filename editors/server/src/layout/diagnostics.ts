// The server's one warning: a record whose member order wastes space, on its
// name, with the reorder code action as its fix.

import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { RecordView } from '@abi-explorer/shared/protocol';
import { reorderWarning } from '@abi-explorer/shared/layoutModel';

export const DIAGNOSTIC_SOURCE = 'abi-explorer';
export const REORDER_CODE = 'reorder';

export function layoutDiagnostics(records: readonly RecordView[]): Diagnostic[] {
  const seen = new Set<string>();
  return records.flatMap((record): Diagnostic[] => {
    const message = record.nameRange && reorderWarning(record);
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
