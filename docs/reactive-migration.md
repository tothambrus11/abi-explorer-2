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
- [x] **0.5 Declarative `editorView`** — EditorPane holds one `$derived`
      `{value, language, diagnostics, dots, highlight, inlay}`; each effect only
      hands a slice of it to Monaco. The dot-colour logic left the effect for the
      pure `memberDots` (`editor-view.ts`, 5 tests) — including the stacked-view
      case where one field recurs across records.

## Phase 1 — inspected-record model (feature)

- [x] **1.1** Record source spans come from clang's `range` (implicit
      injected-class-names skipped), and `inspected-record.ts` resolves them:
      `recordsAtLine` (innermost first, inclusive ends) and `inspectedRecord`
      (explicit pick > cursor > previous), 11 tests + a real-clang span test.
      Picking a record from the tabs now moves the caret to its declaration, so
      the explicit choice _is_ the cursor's choice — closes issue #3.
- [x] **1.2** One-level colour model: a colour identifies a _directly nameable
      member_ of the record. A named compound member (or base) is one unit whose
      leaves share its colour; an anonymous aggregate is transparent, since its
      fields are nameable on the record itself. Circles are drawn only for marks
      that a record on screen declares directly.
- [x] **1.3** Per-declarator marks: `LineInfo.marks` carries one entry per
      member written on a line (column, members, colour), and `markAtColumn`
      resolves a column to one of them — a lone declarator keeps the whole line
      as a forgiving hit area.

## Phase 2 — editor decorations

- [x] **2.1** Inline circles: a decoration on the first character of each
      member's name, padded left so the circle sits before the name and pushes
      the rest of the line — one per declarator, so `struct { uint8_t crc_lo,
crc_hi; };` shows a ring for the anonymous member and a colour for each
      field. (Monaco's injected-text option is internal to inlay hints.)
- [x] **2.2** Hover and cursor carry a column, so `markAtColumn` picks the exact
      member on a shared line; the editor shows a subtle line tint plus a strong
      highlight on that member's own name. Positions compare by value, since the
      editor's own refresh would otherwise feed the derived hover in a loop.

## Phase 3 — grid + tree

- [ ] **3.1** base bands in the byte grid (vptr / inherited fields / base padding).
- [x] **3.2** Drilling: clicking a compound member's name in the tree inspects
      the record it is an instance of (hover still only previews). An explicitly
      selected record is always shown, so a nested anonymous member — which is
      not listed as a record of its own — can be opened too.

## Non-goals

`monaco.ts` and `dock.ts` stay imperative library wrappers (the sink layer).
No generic reactive framework — just the resource abstraction plus derived
hover/inspection.
