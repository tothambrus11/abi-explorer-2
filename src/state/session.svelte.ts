// Orchestration: reacts to store changes, runs the analyzer with debounce and
// cancellation, resolves member source locations, and answers hover queries.
// The UI never talks to the compiler directly.

import { Analyzer, type Analysis } from '$compiler/Analyzer';
import type { Compiler } from '$compiler/Compiler';
import type { CompileOptions } from '$core/options';
import type { AstInfo, DeclLocation } from '$core/ast-locations';
import { recordKey } from '$core/layout-parser';
import { buildRenderModel, directMembers } from '$core/model';
import { findRecord } from '$core/probes';
import type { RecordLayout } from '$core/types';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { store, type Hover, type MemberRef } from './store.svelte';
import {
  describeItems,
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
import {
  buildLineIndex,
  collectLocateOwners,
  collectMemberAligns,
  type LineIndex,
  type LineInfo,
} from './code-locations';

export type { LineInfo };

const samePos = (a: EditorPos | null, b: EditorPos | null): boolean =>
  a === b || (a !== null && b !== null && a.line === b.line && a.col === b.col);

interface CompileInput {
  source: string;
  options: CompileOptions;
}

/** Input to the AST-locate resource: an analysis plus the owner names to dump. */
interface LocateInput {
  analysis: Analysis;
  owners: string[];
}

const EMPTY_INDEX: LineIndex = {
  lines: new Map(),
  leafLocations: new Map(),
  groupLocations: new Map(),
};

const SOURCE_DEBOUNCE_MS = 500;
const HASH_DEBOUNCE_MS = 400;

export class Session {
  readonly analyzer: Analyzer;
  private cleanup: (() => void) | null = null;

  /**
   * The compile as a reactive resource: debounced (source edits) or immediate
   * (option changes / first run), deduped by input, and cancelling. `value` is
   * the latest Analysis; `store.analysis`/`store.status` mirror it (see start()).
   */
  private readonly compile = new AsyncRunner<CompileInput, Analysis>(
    (input, signal) => this.analyzer.analyze(input.source, input.options, signal),
    {
      key: (i) => JSON.stringify(i.options) + '\n' + i.source,
      // Option changes (and the very first compile) apply immediately; source
      // edits debounce so we don't recompile on every keystroke.
      debounce: (i, prev) =>
        !prev || JSON.stringify(prev.options) !== JSON.stringify(i.options)
          ? 0
          : SOURCE_DEBOUNCE_MS,
    },
  );

  /**
   * AST source-location dump as a reactive resource, keyed by (source, options,
   * owner set). Dedup-by-key breaks the memberAligns→models→owners feedback
   * loop: once alignments settle, the owner set is stable and no re-dump runs.
   */
  private readonly locate = new AsyncRunner<LocateInput, AstInfo>(
    (input, signal) => this.analyzer.locate(input.analysis, new Set(input.owners), signal),
    {
      key: (i) =>
        i.analysis.source + '\0' + JSON.stringify(i.analysis.options) + '\0' + i.owners.join(','),
    },
  );

  /** The per-line index derived from the current models + the latest AST dump. */
  private readonly index: LineIndex = $derived(
    this.locate.value ? buildLineIndex(store.models, this.locate.value.fields) : EMPTY_INDEX,
  );
  /** line -> LineInfo across all visible records. */
  get lines(): Map<number, LineInfo> {
    return this.index.lines;
  }
  /** Record/typedef name locations from the AST (for the type hover). */
  private decls: DeclLocation[] = $derived(this.locate.value?.decls ?? []);
  /** Type spellings clang reported (field types, typedef/record names): the only bare words we probe on hover. */
  private knownSpellings: Set<string> = $derived(
    new Set(
      [
        ...(this.locate.value?.decls.map((d) => d.name) ?? []),
        ...(this.locate.value?.fields.flatMap((f) => [f.qualType, f.desugaredType ?? '']) ?? []),
      ].filter(Boolean),
    ),
  );
  /** Hover sources: pointer over the editor, the text cursor, pointer over grid/table. */
  private mouse: EditorPos | null = $state.raw(null);
  private cursor: EditorPos | null = $state.raw(null);
  /**
   * What the pointer is over in the grid/table — an *intent* (record + index),
   * resolved against the current models by `resolveHover`, so it can never
   * point at a member of a superseded analysis.
   */
  private hoverIntent: HoverIntent | null = $state.raw(null);
  /** Last input wins: after keyboard cursor movement the cursor beats the (still) hovered line until the mouse moves again. */
  private preferCursor = $state(false);

  /**
   * A one-shot request for the editor to move its caret (issue #3): picking a
   * record from the tab bar navigates to its declaration, so the cursor — which
   * decides the record when nothing is hovered — agrees with the tab.
   */
  revealRequest: { line: number; seq: number } | null = $state.raw(null);
  private revealSeq = 0;

  /** The effective hover: grid/table intent first, then the pointer, then the cursor. */
  readonly hover: Hover = $derived(resolveHover(this.hoverInputs));
  /** Record owning the hovered line, for record-follows-cursor in tabs mode. */
  private readonly hoverPrimary: string | null = $derived(hoveredPrimary(this.hoverInputs));

  constructor(private readonly compiler: Compiler) {
    this.analyzer = new Analyzer(compiler);
  }

  /** Wire reactive effects. Returns a disposer. */
  start(): () => void {
    const offStatus = this.compiler.onStatus((s) => {
      store.compiler = s;
    });
    // On a metered connection (issue #1) the ~27 MB download waits for an
    // explicit opt-in; anywhere else — or once the bundle is cached — it starts
    // straight away.
    void shouldAskBeforeDownload()
      .then((ask) => {
        if (ask) store.awaitingDownloadConsent = true;
        else this.startCompiler();
      })
      .catch(() => {
        this.startCompiler();
      });

    const stopRoot = $effect.root(() => {
      // Drive the compile resource from source/options. Dedup-by-input means the
      // compiler flipping back to 'ready' after a restart does not re-run the
      // same input (a timed-out compile would otherwise retry to exhaustion).
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
      // Drive the AST-locate resource from the analysis + owner set. Owners are
      // derived from the models (which depend on memberAligns, set below); the
      // resource's dedup-by-key stops that feedback from re-dumping.
      $effect(() => {
        const analysis = store.analysis;
        if (!analysis || store.models.size === 0) return;
        const owners = [...collectLocateOwners(store.models, analysis.recordIndex)].sort();
        this.locate.trigger({ analysis, owners });
      });
      // Feed explicit member alignments (AlignedAttr) back to the store; models
      // re-derive. Guarded so an unchanged map doesn't loop.
      $effect(() => {
        const aligns = this.locate.value
          ? collectMemberAligns(this.locate.value.fields)
          : new Map<string, number>();
        const prev = store.memberAligns;
        const same = prev.size === aligns.size && [...aligns].every(([k, v]) => prev.get(k) === v);
        if (!same) store.memberAligns = aligns;
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
      // Command (deliberately *not* part of the derivation): in tabs mode the
      // record under the cursor becomes the selected one.
      $effect(() => {
        const primary = this.hoverPrimary;
        if (store.view !== 'tabs' || primary === null) return;
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
      offStatus();
      stopRoot();
      this.compile.dispose();
      this.locate.dispose();
    };
    return this.cleanup;
  }

  /** Restore state from the URL fragment (call before start()). */
  async restoreFromUrl(): Promise<boolean> {
    const s = await decodeShareState(location.hash);
    if (!s) return false;
    store.source = s.source;
    store.options = { ...s.options };
    store.selectedRecord = s.selectedRecord;
    // A shared link's view mode applies to this visit only; it must not
    // overwrite the visitor's own persisted preference.
    store.view = s.view;
    return true;
  }

  private shareState(): ShareState {
    return {
      source: store.source,
      options: { ...store.options },
      selectedRecord: store.selectedRecord,
      view: store.view,
    };
  }

  /** A link encoding the *current* state (not the debounced fragment in the address bar). */
  async shareUrl(): Promise<string> {
    const frag = await encodeShareState(this.shareState());
    history.replaceState(null, '', '#' + frag);
    return location.href;
  }

  private startCompiler(): void {
    store.awaitingDownloadConsent = false;
    void this.compiler.start().catch(() => {});
  }

  /** The user opted into the download on a metered connection; remember and go. */
  allowDownload(): void {
    grantConsent();
    this.startCompiler();
  }

  /**
   * Explicitly pick a record (tab bar). The caret jumps to its declaration so
   * this choice also survives as the cursor-driven default.
   */
  selectRecord(key: string): void {
    store.selectedRecord = key;
    const line = declLineFor(key, this.decls, store.models);
    if (line !== null) this.revealRequest = { line, seq: ++this.revealSeq };
  }

  /**
   * Drill into a compound member: inspect the record it is an instance of.
   * Returns false when the member has no record to open (a plain field, or a
   * type this analysis did not lay out).
   */
  inspectGroup(record: string, groupIndex: number): boolean {
    const group = store.models.get(record)?.groups[groupIndex];
    const analysis = store.analysis;
    if (!group || !analysis) return false;
    const type = group.type.replace(/^(?:struct|union|class|__interface)\s+/, '');
    const target = findRecord(type, analysis.recordIndex);
    if (!target || !analysis.userRecords.includes(target)) return false;
    const key = recordKey(target);
    if (key === record) return false; // already there
    this.selectRecord(key);
    return true;
  }

  /** Force a compile now (e.g. Ctrl+Enter), even if the input is unchanged. */
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
      lines: this.index.lines,
      leafLocations: this.index.leafLocations,
      groupLocations: this.index.groupLocations,
    };
  }

  /**
   * Documentation hover at (line, word). What the word *is* comes from clang's
   * AST (record/typedef name at that position, or the declared type of the
   * field on that line); its size comes from the record's dump or a spelling
   * probe. Anything else is probed as-is — clang decides whether it is a type.
   */
  async describeType(
    line: number,
    word: { word: string; startColumn: number; endColumn: number },
  ): Promise<string | null> {
    const analysis = store.analysis;
    if (!analysis) return null;

    // 1. A record or typedef whose name is written exactly here.
    const decl = this.decls.find(
      (d) =>
        d.line === line && word.startColumn >= d.col && word.startColumn < d.col + d.name.length,
    );
    if (decl?.kind === 'record') {
      const recs = analysis.records.filter(
        (r) =>
          r.name === decl.name ||
          r.name.endsWith('::' + decl.name) ||
          r.name.startsWith(decl.name + '<'),
      );
      if (recs.length) {
        return recs
          .slice(0, 4)
          .map((r) => describeRecord(r, analysis))
          .join('\n\n---\n\n');
      }
    }
    let spelling: string;
    let alias: string | null = null;
    if (decl?.kind === 'typedef' && decl.qualType) {
      spelling = decl.name;
      alias = decl.qualType;
    } else {
      // 2. The type part of a member declaration: the field's declared type.
      const info = this.lines.get(line);
      if (info?.location && word.startColumn < info.location.col && info.location.qualType) {
        spelling = info.location.qualType;
        alias = info.location.desugaredType ?? null;
      } else if (this.knownSpellings.has(word.word)) {
        spelling = word.word; // 3. a name clang reported as a type/typedef somewhere in the TU
      } else {
        return null; // member names, keywords, numbers…: no compile for these
      }
    }
    const rec = findRecord(spelling, analysis.recordIndex);
    if (rec) return describeRecord(rec, analysis);
    const pr = await this.analyzer.probeSpelling(analysis, spelling).catch(() => null);
    if (!pr || pr.bits <= 0) return null;
    const size = pr.bits % 8 ? `${pr.bits} b` : `**${pr.bits / 8}** B`;
    const canon = alias && alias !== spelling ? `\n\n\`= ${alias}\`` : '';
    return `**\`${spelling}\`**${canon}\n\n| | |\n|---|---|\n| sizeof | ${size} |\n| alignof | **${pr.align}** B |`;
  }
}

function describeRecord(r: RecordLayout, analysis: Analysis): string {
  const model = buildRenderModel(r, analysis);
  // Members of the record itself — a compound member counts once, not once per
  // field inside it.
  const n = directMembers(model).filter((u) => !('kind' in u && u.kind === 'special')).length;
  const rows = [
    `| sizeof | **${r.sizeBytes}** B |`,
    `| alignof | **${r.align}** B |`,
    `| padding | ${model.paddingBytes} B${r.sizeBytes ? ` (${Math.round((100 * model.paddingBytes) / r.sizeBytes)}%)` : ''} |`,
  ];
  if (r.dsize !== undefined && r.dsize !== r.sizeBytes) rows.push(`| dsize | ${r.dsize} B |`);
  if (r.nvsize !== undefined && r.nvsize !== r.sizeBytes) rows.push(`| nvsize | ${r.nvsize} B |`);
  if (r.nvalign !== undefined && r.nvalign !== r.align) rows.push(`| nvalign | ${r.nvalign} B |`);
  return `**\`${recordKey(r)}\`** — ${n} member${n === 1 ? '' : 's'}\n\n| | |\n|---|---|\n${rows.join('\n')}`;
}

// The hover formatters live with the hover resolution they belong to; re-exported
// here because the UI has always imported them from the session.
export { describeItems, fmtOffset };
