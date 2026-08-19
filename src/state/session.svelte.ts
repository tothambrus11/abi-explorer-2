// Orchestration: reacts to store changes, runs the analyzer with debounce and
// cancellation, resolves member source locations, and answers hover queries.
// The UI never talks to the compiler directly.

import { Analyzer, type Analysis } from '$compiler/Analyzer';
import type { Compiler } from '$compiler/Compiler';
import type { CompileOptions } from '$core/options';
import type { AstInfo, DeclLocation, FieldLocation } from '$core/ast-locations';
import { recordKey } from '$core/layout-parser';
import { buildRenderModel } from '$core/model';
import { findRecord } from '$core/probes';
import type { Group, Leaf, RecordLayout } from '$core/types';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { store, type MemberRef } from './store.svelte';
import { AsyncRunner } from './async-resource.svelte';
import { computeAnalysisStatus } from './status';
import { grantConsent, shouldAskBeforeDownload } from './download-gate';
import {
  buildLineIndex,
  collectLocateOwners,
  collectMemberAligns,
  type LineIndex,
  type LineInfo,
} from './code-locations';

export type { LineInfo };

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
  private get leafLocations(): Map<string, Map<number, FieldLocation>> {
    return this.index.leafLocations;
  }
  private get groupLocations(): Map<string, Map<number, FieldLocation>> {
    return this.index.groupLocations;
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
  private mouseLine: number | null = null;
  private cursorLine: number | null = null;
  /**
   * A resolved grid/table hover: the members to highlight, the editor line
   * their declaration sits on, and the items to summarise in the inlay. An
   * empty `members` with a tooltip is a padding cell (tooltip only).
   */
  private memberHover: {
    members: MemberRef[];
    line: number | null;
    items: (Leaf | Group)[];
    tooltip: { html: string; x: number; y: number } | null;
  } | null = null;
  /** Last input wins: after keyboard cursor movement the cursor beats the (still) hovered line until the mouse moves again. */
  private preferCursor = false;

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
      // A new analysis invalidates any cached grid/table hover (its leaf indices
      // refer to the previous models). The pointer re-hovers as soon as it moves.
      $effect(() => {
        void store.analysis; // track
        this.memberHover = null;
        this.applyHover();
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

  /** Force a compile now (e.g. Ctrl+Enter), even if the input is unchanged. */
  compileNow(): void {
    this.compile.trigger({ source: store.source, options: { ...store.options } }, { force: true });
  }

  // ---------------------------------------------------------- hover ----

  /** Pointer moved over an editor line (null = left the editor). */
  hoverLine(line: number | null): void {
    this.mouseLine = line;
    this.applyHover();
  }

  /** The text cursor moved. Keyboard moves take precedence over a stale hover. */
  setCursorLine(line: number | null, byKeyboard = false): void {
    this.cursorLine = line;
    if (byKeyboard) this.preferCursor = true;
    this.applyHover();
  }

  /** Any pointer movement over the editor hands control back to the mouse. */
  noteMouseActivity(): void {
    if (this.preferCursor) {
      this.preferCursor = false;
      this.applyHover();
    }
  }

  /**
   * Grid/table hover: highlight one member and its source line. A tooltip
   * without a member (padding cell) shows just the tooltip; null/null ends
   * the hover.
   */
  hoverMember(ref: MemberRef | null, tooltip: { html: string; x: number; y: number } | null): void {
    if (!ref) {
      this.memberHover = tooltip ? { members: [], line: null, items: [], tooltip } : null;
      this.applyHover();
      return;
    }
    const leaf = store.models.get(ref.record)?.leaves[ref.leaf];
    if (!leaf) {
      this.memberHover = null;
    } else {
      const loc = this.leafLocations.get(ref.record)?.get(ref.leaf);
      this.memberHover = { members: [ref], line: loc?.line ?? null, items: [leaf], tooltip };
    }
    this.applyHover();
  }

  /**
   * Table hover on a parent (group) row: highlight all the group's leaves and
   * point to the group's own declaration line. The group summarises its extent
   * (offset/size/align) in the inlay.
   */
  hoverGroup(
    record: string,
    groupIndex: number,
    tooltip: { html: string; x: number; y: number } | null,
  ): void {
    const group = store.models.get(record)?.groups[groupIndex];
    if (!group) {
      this.memberHover = null;
    } else {
      const loc = this.groupLocations.get(record)?.get(groupIndex);
      this.memberHover = {
        members: group.leafIndexes.map((leaf) => ({ record, leaf })),
        line: loc?.line ?? null,
        items: [group],
        tooltip,
      };
    }
    this.applyHover();
  }

  /**
   * Resolve the effective hover: pointer over grid/table wins, then the pointer
   * over the editor, then the text cursor. In tabs mode the record owning the
   * hovered line becomes the selected one, so what is shown always corresponds
   * to the cursor.
   */
  private applyHover(): void {
    if (this.memberHover) {
      const { members, line, items, tooltip } = this.memberHover;
      store.setHover({
        members,
        line,
        inlay: items.length ? describeItems(items) : null,
        tooltip,
      });
      return;
    }
    const line = this.preferCursor
      ? (this.cursorLine ?? this.mouseLine)
      : (this.mouseLine ?? this.cursorLine);
    const info = line !== null ? this.lines.get(line) : undefined;
    if (!info) {
      store.setHover(null);
      return;
    }
    if (
      store.view === 'tabs' &&
      store.activeRecordKey !== info.primary &&
      store.models.has(info.primary)
    ) {
      store.selectedRecord = info.primary;
    }
    store.setHover({ members: info.members, line, inlay: describeItems(info.items) });
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
  const n = model.leaves.filter((l) => l.kind !== 'special').length;
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

/** "offset 16 · 8 B · align 8" for the items declared on a line. */
export function describeItems(items: (Leaf | Group)[]): string {
  const one = items.length === 1;
  const it = items[0];
  if (!it) return '';
  if (one && 'kind' in it && it.kind === 'bitfield') {
    return `offset ${fmtOffset(it.offsetBits)} · ${it.sizeBits} b`;
  }
  const start = Math.min(...items.map((i) => i.offsetBits));
  const end = Math.max(...items.map((i) => i.offsetBits + (i.sizeBits ?? 0)));
  const sizeBytes = (end - start) / 8;
  const parts = [`offset ${fmtOffset(start)}`];
  if (one && it.sizeBits === null) parts.push('size ?');
  else {
    parts.push(
      `${one && 'estimated' in it && it.estimated ? '≈' : ''}${Number.isInteger(sizeBytes) ? sizeBytes : sizeBytes.toFixed(1)} B`,
    );
  }
  if (one && it.align) parts.push(`align ${it.align} B`);
  else if (!one) parts.unshift(`${items.length} members`);
  return parts.join(' · ');
}

/** Byte offset with an explicit unit: "12 B", or "12 B + 3 b" inside a bit-field storage unit. */
export function fmtOffset(bits: number): string {
  return bits % 8 === 0 ? `${bits / 8} B` : `${Math.floor(bits / 8)} B + ${bits % 8} b`;
}
