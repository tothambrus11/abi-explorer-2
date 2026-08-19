// Which record the user is currently inspecting.
//
// Precedence, highest first:
//   1. an explicit pick (a tab click) that is still valid,
//   2. the innermost record whose source span contains the cursor,
//   3. the last record that was shown.
//
// Rule 2 is what makes the code drive the panels: put the caret inside a
// declaration and that record is inspected, with the *innermost* one winning so
// a nested record beats its enclosing one.

import { unqualifiedName, type DeclLocation } from '$core/ast-locations';
import type { RenderModel } from '$core/types';

export interface InspectionInputs {
  /** Explicit selection (tab click), or null. */
  selected: string | null;
  /** Effective editor line (pointer or caret), or null. */
  line: number | null;
  decls: DeclLocation[];
  models: Map<string, RenderModel>;
  /** What was inspected a moment ago; kept when the cursor is nowhere in particular. */
  previous: string | null;
}

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

/** Resolve the inspected record key, or null when there is nothing to show. */
export function inspectedRecord(i: InspectionInputs): string | null {
  // 1. An explicit pick wins for as long as it exists.
  if (i.selected !== null && i.models.has(i.selected)) return i.selected;
  // 2. The innermost record the cursor sits in. Several candidates share a span
  //    only for template instantiations: keep the one already shown if it is
  //    among them, so cursoring through the template body does not flip tabs.
  if (i.line !== null) {
    const here = recordsAtLine(i.line, i.decls, i.models);
    if (here.length > 0) {
      if (i.previous !== null && here.includes(i.previous)) return i.previous;
      return here[0]!;
    }
  }
  // 3. Nothing under the cursor: hold what was there (blank lines, file scope).
  if (i.previous !== null && i.models.has(i.previous)) return i.previous;
  const first = i.models.keys().next();
  return first.done ? null : first.value;
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
