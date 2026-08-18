# Reactive architecture migration

Goal: separate three layers that are currently tangled in `session.svelte.ts` —
**raw inputs** (`$state`), **derived model** (`$derived`, side-effect free), and
**effects** (`$effect`, thin syncs to imperative sinks). Remove the manual
`applyHover()` recompute, the hand-rolled async debounce/cancel, and the
derivation-inside-effects in `EditorPane`.

Each phase is independently green (svelte-check, eslint, unit, e2e). Phase 0
preserves behavior; the existing suite is the guardrail.

## Phase 0 — reactive foundation (behavior-preserving)

- [ ] **0.1 `asyncResource`** — an `AsyncRunner` (debounce + dedup-by-key +
      AbortController cancel, reactive `value`/`status`/`error`) plus a
      `bindResource(inputs, runner)` reactive binding. New files, unit-tested in
      isolation with fake timers. _No wiring yet._
- [ ] **0.2 Port compile** onto the resource; `store.status` becomes `$derived`
      of `(resource.status, resource.value, visibleRecords)` instead of being set
      imperatively in `run()`.
- [ ] **0.3 Port AST-locate** onto a second resource; drop `locateAbort` and the
      manual result-map resets.
- [ ] **0.4 Derived hover** — setters record _intent_ only
      (`{kind:'leaf'|'group'|'tooltip', …}`); `hover` becomes `$derived` over
      current models/locations (fixes stale snapshots). Record-follows-hover moves
      out of derivation into a dedicated command `$effect`.
- [ ] **0.5 Declarative `editorView`** — one `$derived`
      `{value, language, diagnostics, circles, highlight, inlay}` and a single
      effect diffing it into Monaco. Color logic leaves the effect.

## Phase 1 — inspected-record model (feature)

- [ ] **1.1** `inspectedRecord` as `$derived`: tree-hover ?? deepest record whose
      AST source span contains the cursor ?? selected tab. Tiebreaks: template
      dups keep current; cursor in no record retains last.
- [ ] **1.2** per-inspected-record colour/level model (compound members —
      named, base, anonymous — as single units).
- [ ] **1.3** member-range index `(line,col) → member` for precise hover/cursor.

## Phase 2 — editor decorations

- [ ] **2.1** inline circles as injected-text `before` decorations (multi/line).
- [ ] **2.2** two-layer highlight (line tint + name token) + hover info inlay.

## Phase 3 — grid + tree

- [ ] **3.1** base bands in the byte grid (vptr / inherited fields / base padding).
- [ ] **3.2** tree ↔ inspection drill (hover previews, click commits).

## Non-goals

`monaco.ts` and `dock.ts` stay imperative library wrappers (the sink layer).
No generic reactive framework — just the resource abstraction plus derived
hover/inspection.
