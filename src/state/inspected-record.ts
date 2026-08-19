// Resolving the cursor to a record, from the declaration spans clang reports.
//
// This is what makes the code drive the panels: put the caret anywhere inside a
// declaration and that record is inspected, with the *innermost* one winning so
// a nested record beats its enclosing one. `hover.ts` applies it; the explicit
// pick that outranks it lives in `session`.

import { unqualifiedName, type DeclLocation } from '$core/ast-locations';
import type { RenderModel } from '$core/types';

/**
 * Record keys whose declaration span contains `line`, innermost first.
 * Templates share one span, so this can legitimately return several.
 */
export function recordsAtLine(
  line: number,
  decls: DeclLocation[],
  models: Map<string, RenderModel>,
): string[] {
  const byName = new Map<string, string[]>();
  for (const key of models.keys()) {
    const model = models.get(key)!;
    const name = unqualifiedName(model.record.name);
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(key);
    byName.set(name, list);
  }
  const hits: { key: string; width: number }[] = [];
  for (const d of decls) {
    if (d.kind !== 'record' || !d.span) continue;
    // Inclusive on both ends: the caret touches both sides of a boundary line.
    if (line < d.span.begin || line > d.span.end) continue;
    const width = d.span.end - d.span.begin;
    for (const key of byName.get(unqualifiedName(d.name)) ?? []) hits.push({ key, width });
  }
  // Innermost = narrowest span. A stable sort keeps declaration order within a
  // width, so same-span template instantiations stay in a predictable order.
  hits.sort((a, b) => a.width - b.width);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    out.push(h.key);
  }
  return out;
}

/**
 * The line a record is declared on, for navigating to it. Matches the record
 * key's unqualified name against the AST's record declarations.
 */
export function declLineFor(
  key: string,
  decls: DeclLocation[],
  models: Map<string, RenderModel>,
): number | null {
  const model = models.get(key);
  if (!model) return null;
  const want = unqualifiedName(model.record.name);
  if (!want) return null;
  let best: DeclLocation | null = null;
  for (const d of decls) {
    if (d.kind !== 'record' || unqualifiedName(d.name) !== want) continue;
    // Prefer the widest span: that is the definition, not a forward declaration.
    const width = (s: DeclLocation) => (s.span ? s.span.end - s.span.begin : -1);
    if (!best || width(d) > width(best)) best = d;
  }
  return best?.line ?? null;
}
