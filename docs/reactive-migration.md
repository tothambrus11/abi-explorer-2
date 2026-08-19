# Reactive architecture migration

Goal: separate three layers that are currently tangled in `session.svelte.ts` —
**raw inputs** (`$state`), **derived model** (`$derived`, side-effect free), and
**effects** (`$effect`, thin syncs to imperative sinks). Remove the manual
`applyHover()` recompute, the hand-rolled async debounce/cancel, and the
derivation-inside-effects in `EditorPane`.

Each phase is independently green (svelte-check, eslint, unit, e2e). Phase 0
preserves behavior; the existing suite is the guardrail.

## Phase 0 — reactive foundation (behavior-preserving)

- [x] **0.1 `asyncResource`** — an `AsyncRunner` (debounce + dedup-by-key +
      AbortController cancel + `force`, reactive `value`/`status`/`error`) plus a
      `bindResource(inputs, runner)` reactive binding. New files, unit-tested in
      isolation with fake timers (9 tests). _No wiring yet._
- [x] **0.2 Port compile** onto the resource; `run()`/`schedule()` and the
      manual abort/timer/lastInputKey bookkeeping are gone. `store.status` is
      pushed from the pure `computeAnalysisStatus(resource, analysis, visibleCount)`
      (6 tests); `store.analysis` mirrors `resource.value`.
- [x] **0.3 Port AST-locate** onto a second resource; `locateAbort` and the
      manual result-map resets are gone. The pure mapping moved to
      `code-locations.ts` (`buildLineIndex`, `collectLocateOwners`,
      `collectMemberAligns`, 6 tests); `lines`/leaf+group locations are now a
      `$derived` index over `(models, dump)`. Dedup-by-key breaks the
      memberAligns→models→owners feedback loop.
- [x] **0.4 Derived hover** — setters record _intent_ only
      (`{kind:'leaf'|'group'|'tooltip', …}`); `hover` is `$derived` over current
      models/locations via the pure `resolveHover` (`hover.ts`, 12 tests), so a
      stale intent resolves to nothing instead of the wrong member. All six
      manual `applyHover()` calls are gone; record-follows-hover is its own
      command `$effect`.
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
