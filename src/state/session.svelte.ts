// Orchestration: reacts to store changes, runs the analyzer with debounce and
// cancellation, and answers hover queries. The UI never talks to the compiler
// directly.
//
// There used to be two async resources here, and a feedback loop between them:
// the compile produced models, the models decided which records to request an
// AST dump for, and the dump produced alignments that the models were rebuilt
// from. Keeping that from oscillating took dedup-by-key on both resources and a
// guarded equality check on the alignment map. All of it existed because
// locations and alignments arrived separately from the layout they described.
// They arrive together now, so one resource is left and the loop is gone.

import { AbiAnalyzer, type AnalysedRecord, type Analysis } from '$compiler/AbiAnalyzer';
import { backendFor, type Backends } from '$compiler/Backends';
import type { CompileOptions } from '$core/options';
import { describeRecord, describeSpelling, subjectAt } from './type-hover';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { store, type Hover, type MemberRef } from './store.svelte';
import {
  describeItems,
  effectivePos,
  fmtOffset,
  hoveredPrimary,
  resolveHover,
  type EditorPos,
  type HoverInputs,
  type HoverIntent,
  type TooltipAnchor,
} from './hover';
import { AsyncRunner } from './async-resource.svelte';
import { computeAnalysisStatus } from './status';
import { declLineFor } from './inspected-record';
import { grantConsent, shouldAskBeforeDownload } from './download-gate';
import { buildLineIndex, type LineIndex, type LineInfo } from './code-locations';
import { History, historyIntent } from './history.svelte';

export type { LineInfo };

const samePos = (a: EditorPos | null, b: EditorPos | null): boolean =>
  a === b || (a !== null && b !== null && a.line === b.line && a.col === b.col);

interface CompileInput {
  source: string;
  options: CompileOptions;
}

const SOURCE_DEBOUNCE_MS = 500;
const HASH_DEBOUNCE_MS = 400;

/**
 * What the app does, as opposed to what it shows.
 *
 * Owns the query, the history, and every hover input, and is the only thing
 * that writes the store's derived state. Nothing here touches the DOM: a view
 * calls a method and reads the store, so the orchestration can be driven from
 * a test without a browser.
 *
 * `start` wires the reactive effects and returns their disposer; nothing runs
 * until it is called, which is what lets `restoreFromUrl` finish first.
 */
export class Session {
  /** The analyzer these queries go through; exposed for tests and hovers. */
  readonly analyzer: AbiAnalyzer;
  private cleanup: (() => void) | null = null;

  /**
   * The query as a reactive resource: debounced (source edits) or immediate
   * (option changes / first run), deduped by input, and cancelling. `value` is
   * the latest Analysis; `store.analysis`/`store.status` mirror it (see start()).
   */
  private readonly compile = new AsyncRunner<CompileInput, Analysis>(
    (input, signal) => this.analyzer.analyze(input.source, input.options, signal),
    {
      key: (i) => JSON.stringify(i.options) + '\n' + i.source,
      // Option changes (and the very first compile) apply immediately; source
      // edits debounce so we don't re-query on every keystroke.
      debounce: (i, prev) =>
        !prev || JSON.stringify(prev.options) !== JSON.stringify(i.options)
          ? 0
          : SOURCE_DEBOUNCE_MS,
    },
  );

  /** The per-line index derived from the models currently on screen. */
  private readonly index: LineIndex = $derived(buildLineIndex(store.models));
  /** line -> LineInfo across all visible records. */
  get lines(): Map<number, LineInfo> {
    return this.index;
  }

  /** Records with their declaration extents, for resolving the caret. */
  private records: AnalysedRecord[] = $derived(store.modelRecords);

  /**
   * Type spellings clang reported somewhere in this TU: the only bare words
   * worth probing when the pointer stops on one.
   */
  private knownSpellings: Set<string> = $derived.by(() => {
    const out = new Set<string>();
    const a = store.analysis;
    if (!a) return out;
    for (const t of a.typedefs) out.add(t.name);
    for (const name of a.byName.keys()) out.add(name);
    for (const r of a.records) {
      for (const leaf of r.model.leaves) if (leaf.type) out.add(leaf.type);
    }
    return out;
  });

  /** Hover sources: pointer over the editor, the text cursor, pointer over grid/table. */
  private mouse: EditorPos | null = $state.raw(null);
  private cursor: EditorPos | null = $state.raw(null);
  /**
   * What the pointer is over in the grid/table: an *intent* (record + index),
   * resolved against the current models by `resolveHover`, so it can never
   * point at a member of a superseded analysis.
   */
  private hoverIntent: HoverIntent | null = $state.raw(null);
  /** Last input wins: after keyboard cursor movement the cursor beats the (still) hovered line until the mouse moves again. */
  private preferCursor = $state(false);

  /**
   * A one-shot request for the editor to move its caret (issue #3): picking a
   * record from the tab bar navigates to its declaration, so the cursor, which
   * decides the record when nothing is hovered, agrees with the tab.
   */
  revealRequest: { line: number; seq: number } | null = $state.raw(null);
  private revealSeq = 0;
  /**
   * Cursor position when a record was picked explicitly. While the cursor is
   * still there, the pick outranks the cursor rule. Otherwise a pick made
   * before the analysis lands is undone the moment it arrives.
   */
  private pickedAt: EditorPos | null = $state.raw(null);

  /** The effective hover: grid/table intent first, then the pointer, then the cursor. */
  readonly hover: Hover = $derived(resolveHover(this.hoverInputs));
  /** Record owning the hovered line, for record-follows-cursor in tabs mode. */
  private readonly hoverPrimary: string | null = $derived(hoveredPrimary(this.hoverInputs));

  /**
   * Undo and redo over the source and the options together. In memory only:
   * see `history.svelte`.
   */
  readonly history = new History({ source: store.source, options: { ...store.options } });

  /**
   * A session answering through `backends`, which routes each query to the
   * compiler for its language and downloads only what is asked for.
   */
  constructor(private readonly backends: Backends) {
    this.analyzer = new AbiAnalyzer(backends);
  }

  /** Puts back the previous state, if there is one. */
  undo(): void {
    this.apply(this.history.undo());
  }

  /** Puts back the state undone out of most recently, if there is one. */
  redo(): void {
    this.apply(this.history.redo());
  }

  /**
   * Puts a snapshot back into the store, or does nothing for `null`, which is
   * what `undo`/`redo` return at the ends of the history.
   *
   * Clears the selected record: it names a record of the layout being replaced,
   * and may not exist in the one that is coming.
   */
  private apply(s: { source: string; options: CompileOptions } | null): void {
    if (!s) return;
    // Guarded, so the effect that watches the store does not record putting a
    // state back as a new state to come back to.
    this.history.applying = true;
    store.source = s.source;
    store.options = { ...s.options };
    store.selectedRecord = null;
    // Cleared after the effects that read them have run.
    queueMicrotask(() => (this.history.applying = false));
  }

  /**
   * Decide whether the module may start downloading, and start it if so. Call
   * this first and *only* through here: on a metered connection (issue #1) the
   * download waits for an explicit opt-in, so nothing else may kick it off:
   * starting it eagerly elsewhere would fetch the bundle behind the consent
   * prompt and make the gate decorative.
   *
   * Returns a promise for tests; callers may ignore it (the load is slow and
   * DOM-independent, so the app mounts while it runs).
   */
  async boot(): Promise<void> {
    // The selected language decides which module is about to be downloaded,
    // and each is asked about separately: they are different sizes and a
    // visitor may have one cached and not the other.
    this.backends.select(store.options.lang);
    // No usable hint (or the check threw): behave as on an unmetered link.
    const ask = await shouldAskBeforeDownload(this.backends.selected).catch(() => false);
    if (ask) store.awaitingDownloadConsent = true;
    else this.startModule();
  }

  /** Wire reactive effects. Returns a disposer. */
  start(): () => void {
    const offStatus = this.backends.onStatus((s) => {
      store.compiler = s;
    });

    // Captured, so it runs before the editor's own undo. Monaco has a stack of
    // its own and it knows only about text; letting it win would undo the
    // characters while leaving the option change that came after them.
    const onKey = (e: KeyboardEvent) => {
      const intent = historyIntent(e);
      if (!intent) return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'undo') this.undo();
      else this.redo();
    };
    window.addEventListener('keydown', onKey, { capture: true });

    const stopRoot = $effect.root(() => {
      // Every state the user arrives at, recorded so they can come back to it.
      // Reading both halves is what subscribes to both.
      $effect(() => {
        const snapshot = { source: store.source, options: { ...store.options } };
        this.history.record(snapshot);
      });
      // Drive the query from source/options. This effect also tracks the
      // module's status, which changes on every progress tick during the
      // download. Dedup-by-input is what keeps that from turning into a
      // hundred identical queries the moment it becomes ready.
      // Choosing a language chooses a compiler, and the second one is not
      // downloaded until something needs it (see `Backends`). The gate decides
      // again for it: it is a different download of a different size, and one
      // the visitor may not have cached.
      $effect(() => {
        const lang = store.options.lang;
        if (backendFor(lang) === this.backends.selected) return;
        this.backends.select(lang);
        void this.boot();
      });
      $effect(() => {
        const input: CompileInput = { source: store.source, options: { ...store.options } };
        if (store.compiler.state === 'ready') this.compile.trigger(input);
      });
      // Mirror the resource into the store; status is derived from both.
      $effect(() => {
        store.analysis = this.compile.value;
      });
      $effect(() => {
        store.status = computeAnalysisStatus(
          this.compile,
          store.analysis,
          store.visibleRecords.length,
        );
      });
      // A new analysis drops the grid/table hover: the pointer will re-enter a
      // row and produce a fresh intent. (Resolution is index-safe either way.)
      $effect(() => {
        void store.analysis; // track
        this.hoverIntent = null;
      });
      // The resolved hover is derived; this is the only place it reaches the store.
      $effect(() => {
        store.hover = this.hover;
      });
      // Command (deliberately *not* part of the derivation): in tabs mode,
      // *moving* the cursor onto a record selects it.
      //
      // The trigger is the cursor position changing, not the record we derive
      // from it. Those differ twice over: the position is unchanged while an
      // explicit tab pick is in force (so the pick must not be reverted), and
      // it is also unchanged when an analysis merely finishes, at which point
      // resolving the caret's record for the first time would otherwise pull
      // the panel off the record it opened on.
      let lastPos: EditorPos | null = null;
      let started = false;
      $effect(() => {
        const pos = effectivePos(this.hoverInputs);
        const primary = this.hoverPrimary;
        if (this.pickedAt !== null && samePos(this.pickedAt, this.cursor)) return;
        this.pickedAt = null;
        if (started && samePos(pos, lastPos)) return;
        lastPos = pos;
        const first = !started;
        started = true;
        if (first || store.view !== 'tabs' || primary === null) return;
        if (store.activeRecordKey !== primary && store.models.has(primary)) {
          store.selectedRecord = primary;
        }
      });

      // Keep the URL fragment in sync.
      let hashTimer: ReturnType<typeof setTimeout> | null = null;
      $effect(() => {
        const state = this.shareState();
        if (hashTimer) clearTimeout(hashTimer);
        hashTimer = setTimeout(() => {
          void encodeShareState(state)
            .then((frag) => {
              history.replaceState(null, '', '#' + frag);
            })
            .catch(() => {});
        }, HASH_DEBOUNCE_MS);
      });
    });

    this.cleanup = () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      offStatus();
      stopRoot();
      this.compile.dispose();
    };
    return this.cleanup;
  }

  /**
   * Restores the state a shared link carries, and reports whether there was one.
   *
   * - Call before `start`, and before the module is booted: the link says which
   *   language is wanted, and booting first starts the wrong compiler.
   * - Leaves the store untouched when the fragment is absent or unreadable, so
   *   a corrupt link opens the app rather than half of someone else's session.
   * - Clears the history: a link is where a visit begins, not a state to undo
   *   back out of.
   */
  async restoreFromUrl(): Promise<boolean> {
    const s = await decodeShareState(location.hash);
    if (!s) return false;
    store.source = s.source;
    store.options = { ...s.options };
    store.selectedRecord = s.selectedRecord;
    // A shared link's view mode applies to this visit only; it must not
    // overwrite the visitor's own persisted preference.
    store.view = s.view;
    this.history.reset({ source: store.source, options: { ...store.options } });
    return true;
  }

  /** Everything a link carries: what to compile, how, and what to be looking at. */
  private shareState(): ShareState {
    return {
      source: store.source,
      options: { ...store.options },
      selectedRecord: store.selectedRecord,
      view: store.view,
    };
  }

  /**
   * A link to exactly what is on screen now.
   *
   * Encodes the current state rather than reading the address bar, which lags
   * behind by a debounce: a reader who edits and immediately presses Share
   * would otherwise copy the state before their edit. Also updates the address
   * bar, so the two agree afterwards.
   */
  async shareUrl(): Promise<string> {
    const frag = await encodeShareState(this.shareState());
    history.replaceState(null, '', '#' + frag);
    return location.href;
  }

  /**
   * Takes down the prompt and starts the download.
   *
   * Failures are left to the module status rather than thrown from here: this
   * is called from event handlers, and the banner already says what happened.
   */
  private startModule(): void {
    store.awaitingDownloadConsent = false;
    void this.backends.start().catch(() => {});
  }

  /**
   * The user accepted the download. Remembers the consent for later visits and
   * starts the module at once; the prompt does not reappear this session.
   */
  allowDownload(): void {
    grantConsent();
    this.startModule();
  }

  /**
   * Explicitly pick a record (tab bar). The caret jumps to its declaration so
   * this choice also survives as the cursor-driven default.
   */
  selectRecord(key: string): void {
    store.selectedRecord = key;
    this.pickedAt = this.cursor;
    const line = declLineFor(key, this.records);
    if (line !== null) this.revealRequest = { line, seq: ++this.revealSeq };
  }

  /**
   * Drill into a compound member: inspect the record it is an instance of.
   * Returns false when the member has no record to open: a plain field, or a
   * type this analysis did not lay out.
   *
   * This used to strip the record keyword off the member's printed type and
   * search an index by name. The group carries the record's id.
   */
  inspectGroup(record: string, groupIndex: number): boolean {
    const recordId = store.models.get(record)?.groups[groupIndex]?.recordId ?? null;
    const analysis = store.analysis;
    if (recordId === null || !analysis) return false;
    const target = analysis.byId.get(recordId);
    // Already there: drilling into a member of your own type is a no-op.
    if (!target || target.key === record) return false;
    this.selectRecord(target.key);
    return true;
  }

  /**
   * Runs the query now, unchanged input and pending debounce notwithstanding.
   *
   * What Ctrl+Enter is for: the answer to an unchanged question is already on
   * screen, so this exists for the reader who wants to see it recomputed.
   */
  compileNow(): void {
    this.compile.trigger({ source: store.source, options: { ...store.options } }, { force: true });
  }

  // ---------------------------------------------------------- hover ----

  /**
   * Pointer moved in the editor (null = left it). Positions are compared by
   * value: re-reporting the same one must not invalidate the derived hover, or
   * the editor's own refresh would feed itself in a loop.
   */
  hoverLine(pos: EditorPos | null): void {
    if (samePos(this.mouse, pos)) return;
    this.mouse = pos;
  }

  /** The text cursor moved. Keyboard moves take precedence over a stale hover. */
  setCursorLine(pos: EditorPos | null, byKeyboard = false): void {
    if (byKeyboard) this.preferCursor = true;
    if (samePos(this.cursor, pos)) return;
    this.cursor = pos;
  }

  /** Any pointer movement over the editor hands control back to the mouse. */
  noteMouseActivity(): void {
    this.preferCursor = false;
  }

  /**
   * Grid/table hover: highlight one member and its source line. A tooltip
   * without a member (padding cell) shows just the tooltip; null/null ends
   * the hover.
   */
  hoverMember(ref: MemberRef | null, tooltip: TooltipAnchor | null): void {
    this.hoverIntent = ref
      ? { kind: 'leaf', record: ref.record, leaf: ref.leaf, tooltip }
      : tooltip
        ? { kind: 'tooltip', tooltip }
        : null;
  }

  /**
   * Byte-map hover on a region: a cell, or one bit of it. Every member with
   * bits in the region is meant at once, which is how a union's overlap stays
   * visible in the table.
   */
  hoverArea(record: string, fromBit: number, toBit: number, tooltip: TooltipAnchor | null): void {
    this.hoverIntent = { kind: 'area', record, fromBit, toBit, tooltip };
  }

  /**
   * Table hover on a parent (group) row: highlights all the group's leaves and
   * points to the group's own declaration line.
   */
  hoverGroup(record: string, groupIndex: number, tooltip: TooltipAnchor | null): void {
    this.hoverIntent = { kind: 'group', record, group: groupIndex, tooltip };
  }

  /** Everything `resolveHover` needs, tracked reactively. */
  private get hoverInputs(): HoverInputs {
    return {
      intent: this.hoverIntent,
      mouse: this.mouse,
      cursor: this.cursor,
      preferCursor: this.preferCursor,
      models: store.models,
      lines: this.index,
      records: this.records,
      current: store.activeRecordKey,
    };
  }

  /**
   * Documentation hover at (line, word). What the word *is* is decided by the
   * pure `subjectAt`; what is left here is the one thing it cannot do, measure
   * a spelling the analysis has no record for, which costs a query.
   */
  async describeType(
    line: number,
    word: { word: string; startColumn: number; endColumn: number },
    signal?: AbortSignal,
  ): Promise<string | null> {
    const analysis = store.analysis;
    if (!analysis) return null;
    const subject = subjectAt(line, word, {
      analysis,
      lines: this.index,
      knownSpellings: this.knownSpellings,
    });
    if (subject?.kind === 'records') {
      return subject.records
        .map((r) => describeRecord(r, analysis.options.lang))
        .join('\n\n---\n\n');
    }

    // Hylo answers about the cursor rather than about a spelling, which is what
    // lets it describe a type this source does not declare: `Int` belongs to
    // another module, so it is in no spelling here and no record this query
    // returned, but the compiler assigned it to the tree under the cursor.
    if (analysis.options.lang === 'hylo') {
      const at = await this.analyzer
        .probeTypeAt(analysis, line - 1, word.startColumn - 1, signal)
        .catch(() => null);
      if (!at) return null;
      // The same card a record declared here gets. There is nothing a Hylo
      // cursor knows less about than a declaration does, so there is no reason
      // for two cards.
      return describeRecord(at, analysis.options.lang);
    }

    if (!subject) return null; // member names, keywords, numbers…: no query for these
    // A spelling probe is a full re-parse of the user's TU; pass the hover's
    // cancellation on so an abandoned hover does not hold the single wasm clang.
    const measured = await this.analyzer
      .probeSpelling(analysis, subject.spelling, signal)
      .catch(() => null);
    if (!measured || measured.bits <= 0) return null;
    return describeSpelling(subject.spelling, subject.alias, measured, analysis.options.lang);
  }
}

// The hover formatters live with the hover resolution they belong to; re-exported
// here because the UI has always imported them from the session.
export { describeItems, fmtOffset };
