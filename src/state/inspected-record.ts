// Resolving the cursor to a record, from the declaration extents clang reports.
//
// This is what makes the code drive the panels: put the caret anywhere inside a
// declaration and that record is inspected, with the *innermost* one winning so
// a nested record beats its enclosing one. `hover.ts` applies it; the explicit
// pick that outranks it lives in `session`.
//
// It used to match record keys against names pulled from a separate AST dump.
// A record now carries its own extent, so a key is compared to a key.

import type { AnalysedRecord } from '$compiler/AbiAnalyzer';

/**
 * Record keys whose declaration extent contains `line`, innermost first.
 * Template instantiations share the extent of their pattern, so this can
 * legitimately return several.
 */
export function recordsAtLine(line: number, records: Iterable<AnalysedRecord>): string[] {
  const hits: { key: string; height: number }[] = [];
  for (const r of records) {
    const span = r.record.range;
    // Inclusive on both ends: the caret touches both sides of a boundary line.
    if (!span || line < span.line || line > span.endLine) continue;
    hits.push({ key: r.key, height: span.endLine - span.line });
  }
  // Innermost = shortest extent. A stable sort keeps declaration order within
  // one height, so instantiations sharing an extent stay predictably ordered.
  hits.sort((a, b) => a.height - b.height);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    out.push(h.key);
  }
  return out;
}

/** The line a record's name is written on, for navigating to it. */
export function declLineFor(key: string, records: Iterable<AnalysedRecord>): number | null {
  for (const r of records) {
    if (r.key === key) return r.record.location?.line ?? r.record.range?.line ?? null;
  }
  return null;
}
