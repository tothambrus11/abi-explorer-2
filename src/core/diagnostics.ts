// Parses clang's textual diagnostics for one file into structured entries.
//
//   input.c:3:12: error: expected ';' after struct
//       3 |     int x
//         |          ^
//         |          ;

import type { Diagnostic, DiagnosticSeverity } from './types';

/** Escape a literal for use inside `new RegExp(...)`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEVERITIES: DiagnosticSeverity[] = ['fatal error', 'error', 'warning', 'note', 'remark'];

export function parseDiagnostics(text: string, fileName: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const esc = escapeRegExp(fileName);
  // With -fdiagnostics-print-source-range-info clang prints
  //   input.c:3:12:{3:12-3:15}: error: message
  // (ranges optional, comma-separated). We take the first range on the same line.
  const re = new RegExp(
    `^${esc}:(\\d+):(\\d+):(?:\\{([^}]*)\\}:)?\\s+(${SEVERITIES.join('|')}):\\s+(.*)$`,
  );
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const d: Diagnostic = {
      line: Number(m[1]),
      column: Number(m[2]),
      severity: m[4] as DiagnosticSeverity,
      message: m[5]!.trim(),
    };
    const ranges = m[3] ?? '';
    for (const r of ranges.split(',')) {
      const rm = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(r.trim());
      if (!rm) continue;
      const [l1, c1, l2, c2] = [Number(rm[1]), Number(rm[2]), Number(rm[3]), Number(rm[4])];
      if (l1 === d.line) {
        d.column = c1;
        if (l2 === l1) d.endColumn = Math.max(c2, c1 + 1);
        break;
      }
    }
    out.push(d);
  }
  return out;
}

/** Drop diagnostics that mention `fileName` (e.g. our probe TU) from raw stderr text. */
export function stripFileDiagnostics(stderr: string, fileName: string): string {
  return stderr
    .split('\n')
    .filter((l) => !l.includes(fileName))
    .join('\n')
    .trim();
}
