// Orchestration: reacts to store changes, runs the analyzer with debounce and
// cancellation, resolves member source locations, and answers hover queries.
// The UI never talks to the compiler directly.

import { Analyzer, type Analysis } from '$compiler/Analyzer';
import { CompileCancelled, type Compiler } from '$compiler/Compiler';
import type { DeclLocation, FieldLocation } from '$core/ast-locations';
import { matchItemsToLocations, unqualifiedName } from '$core/ast-locations';
import { isAnonymousRecord, recordKey } from '$core/layout-parser';
import { buildRenderModel } from '$core/model';
import { findRecord } from '$core/probes';
import type { Group, Leaf, RecordLayout, RenderModel } from '$core/types';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { store, type MemberRef } from './store.svelte';

/** Everything the editor needs to know about one source line. */
export interface LineInfo {
  line: number;
  /** Members to highlight when this line is hovered (across all visible records). */
  members: MemberRef[];
  /** Items (leaves/groups) declared on this line, from the primary record. */
  items: (Leaf | Group)[];
  /** Record that "owns" the line (declares it as a direct member), for dot color and auto-select. */
  primary: string;
  colorClass: string;
  /** Location of the field declared here (for the type hover). */
  location: FieldLocation | null;
}

const SOURCE_DEBOUNCE_MS = 500;
const HASH_DEBOUNCE_MS = 400;

export class Session {
  readonly analyzer: Analyzer;
  private abort: AbortController | null = null;
  private locateAbort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastOptionsKey = '';
  /** options + source of the last scheduled compile (see the recompile effect). */
  private lastInputKey: string | null = null;
  private cleanup: (() => void) | null = null;

  /** line -> LineInfo across all visible records. */
  lines: Map<number, LineInfo> = $state.raw(new Map<number, LineInfo>());
  /** recordKey -> (leaf index -> location) */
  private leafLocations = new Map<string, Map<number, FieldLocation>>();
  /** Record/typedef name locations from the AST (for the type hover). */
  private decls: DeclLocation[] = [];
  /** Type spellings clang reported (field types, typedef/record names): the only bare words we probe on hover. */
  private knownSpellings = new Set<string>();
  /** Hover sources: pointer over the editor, the text cursor, pointer over grid/table. */
  private mouseLine: number | null = null;
  private cursorLine: number | null = null;
  /** ref === null: pointer over a padding cell (tooltip only, no member). */
  private memberHover: {
    ref: MemberRef | null;
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
    void this.compiler.start().catch(() => {});

    const stopRoot = $effect.root(() => {
      // Recompile on source/options changes.
      $effect(() => {
        const source = store.source;
        const optionsKey = JSON.stringify(store.options);
        const ready = store.compiler.state === 'ready';
        if (!ready) return;
        // Only *input* changes schedule a compile. The compiler flipping back
        // to 'ready' after a restart must not re-run the same input: a compile
        // that timed out would otherwise be retried until the restart budget
        // is exhausted and the compiler is marked failed for good.
        const inputKey = optionsKey + '\n' + source;
        if (inputKey === this.lastInputKey) return;
        const optionsChanged = optionsKey !== this.lastOptionsKey;
        this.lastOptionsKey = optionsKey;
        this.lastInputKey = inputKey;
        this.schedule(optionsChanged ? 0 : SOURCE_DEBOUNCE_MS);
      });
      // Resolve locations whenever the analysis / visible records change.
      $effect(() => {
        const models = store.models;
        const analysis = store.analysis;
        void this.resolveLocations(analysis, models);
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
      this.abort?.abort();
      this.locateAbort?.abort();
      if (this.timer) clearTimeout(this.timer);
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

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  /** Force a compile now (e.g. Ctrl+Enter). */
  compileNow(): void {
    this.schedule(0);
  }

  private async run(): Promise<void> {
    this.abort?.abort();
    this.locateAbort?.abort(); // stale location dumps must not queue ahead of this compile
    const ac = new AbortController();
    this.abort = ac;
    store.status = { kind: 'running' };
    const source = store.source;
    const options = { ...store.options };
    try {
      const analysis = await this.analyzer.analyze(source, options, ac.signal);
      if (ac.signal.aborted) return;
      store.analysis = analysis;
      // Anonymous records are not shown on their own, so they don't count as output.
      const nUser = store.visibleRecords.length; // same notion of 'shown' as the results pane
      if (analysis.code !== 0 && nUser === 0) {
        store.status = { kind: 'error', message: 'compilation failed — see diagnostics' };
      } else if (analysis.code !== 0) {
        store.status = {
          kind: 'error',
          message: 'compiled with errors — layouts may be incomplete',
        };
      }
      // Any stderr counts (driver warnings and header diagnostics have no main-file prefix).
      else store.status = { kind: 'ok', warnings: analysis.diagnosticsText.length > 0 };
    } catch (e) {
      if (e instanceof CompileCancelled || ac.signal.aborted) return;
      store.status = { kind: 'error', message: (e as Error).message || String(e) };
    }
  }

  // ------------------------------------------------------ locations ----

  private async resolveLocations(
    analysis: Analysis | null,
    models: Map<string, RenderModel>,
  ): Promise<void> {
    this.locateAbort?.abort();
    this.lines = new Map();
    this.leafLocations = new Map();
    // A grid/table hover refers to a leaf *index* of the previous models; it
    // would point at an arbitrary member now (the pointer gets a fresh
    // mouseenter as soon as it moves).
    this.memberHover = null;
    store.setHover(null);
    if (!analysis || models.size === 0) return;
    const ac = new AbortController();
    this.locateAbort = ac;
    // `-ast-dump-filter` is a substring match on qualified names and the dump
    // re-parses the whole TU per owner, so library records (std::string, its
    // implementation-namespace parts) are skipped: their fields are not in the
    // user's file anyway, and dumping e.g. every "string" in libc++ takes tens
    // of seconds — long enough to trip the compile timeout.
    // One filtered dump per *top-level* record name (a nested record's decls
    // are inside its enclosing record's dump), plus member type spellings so
    // typedef'd anonymous records are reached through their typedef.
    const owners = new Set<string>();
    const isLibrary = (name: string) => /^(?:std::|__)|::__/.test(name);
    const top = (name: string) => {
      if (isLibrary(name)) return '';
      return unqualifiedName(name.replace(/\(anonymous namespace\)::/g, '').split('::')[0] ?? '');
    };
    for (const model of models.values()) {
      owners.add(top(model.record.name));
      for (const l of model.leaves) owners.add(top(l.owner));
      for (const g of model.groups) {
        owners.add(top(g.owner));
        const typeName = g.type.replace(/^(?:struct|union|class)\s+/, '');
        const rec = findRecord(typeName, analysis.recordIndex);
        if ((!rec || isAnonymousRecord(rec)) && !isLibrary(typeName)) {
          owners.add(unqualifiedName(typeName));
        }
      }
    }
    owners.delete('');
    let locs: FieldLocation[];
    try {
      const info = await this.analyzer.locate(analysis, owners, ac.signal);
      locs = info.fields;
      this.decls = info.decls;
      this.knownSpellings = new Set(
        [
          ...info.decls.map((d) => d.name),
          ...info.fields.flatMap((f) => [f.qualType, f.desugaredType ?? '']),
        ].filter(Boolean),
      );
    } catch {
      return;
    }
    if (ac.signal.aborted) return;

    interface Cand {
      record: string;
      direct: boolean;
      items: (Leaf | Group)[];
      members: MemberRef[];
      loc: FieldLocation;
    }
    const byLine = new Map<number, Cand[]>();
    for (const [key, model] of models) {
      const leafLocs = matchItemsToLocations(model.leaves, locs);
      const groupLocs = matchItemsToLocations(model.groups, locs);
      this.leafLocations.set(key, leafLocs);
      const local = new Map<
        number,
        { items: (Leaf | Group)[]; members: Set<number>; loc: FieldLocation; direct: boolean }
      >();
      const at = (line: number, loc: FieldLocation) => {
        let e = local.get(line);
        if (!e) local.set(line, (e = { items: [], members: new Set(), loc, direct: false }));
        return e;
      };
      for (const [gi, loc] of groupLocs) {
        const g = model.groups[gi]!;
        const e = at(loc.line, loc);
        for (const li of g.leafIndexes) e.members.add(li);
        e.items.push(g);
        if (g.path.length === 0) e.direct = true;
      }
      for (const [li, loc] of leafLocs) {
        const leaf = model.leaves[li]!;
        const e = at(loc.line, loc);
        if (e.items.some((it) => 'leafIndexes' in it && it.leafIndexes.includes(li))) continue; // subsumed by a group
        e.members.add(li);
        e.items.push(leaf);
        if (leaf.depth === 0) e.direct = true;
      }
      for (const [line, e] of local) {
        const list = byLine.get(line) ?? [];
        list.push({
          record: key,
          direct: e.direct,
          items: e.items,
          members: [...e.members].map((leaf) => ({ record: key, leaf })),
          loc: e.loc,
        });
        byLine.set(line, list);
      }
    }

    const out = new Map<number, LineInfo>();
    for (const [line, cands] of byLine) {
      const primary = cands.find((c) => c.direct) ?? cands[0]!;
      const first = primary.members[0];
      const colorClass = first
        ? (models.get(first.record)?.leaves[first.leaf]?.colorClass ?? 'c-1')
        : 'c-1';
      out.set(line, {
        line,
        members: cands.flatMap((c) => c.members),
        items: primary.items,
        primary: primary.record,
        colorClass,
        location: primary.loc,
      });
    }
    this.lines = out;
    this.applyHover();
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
    this.memberHover = ref || tooltip ? { ref, tooltip } : null;
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
      const { ref, tooltip } = this.memberHover;
      if (!ref) {
        store.setHover({ tooltip });
        return;
      }
      const model = store.models.get(ref.record);
      const leaf = model?.leaves[ref.leaf];
      if (!model || !leaf) {
        store.setHover(null);
        return;
      }
      const loc = this.leafLocations.get(ref.record)?.get(ref.leaf);
      store.setHover({
        members: [ref],
        line: loc?.line ?? null,
        inlay: loc ? describeItems([leaf]) : null,
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
    const size = pr.bits % 8 ? `${pr.bits} bits` : `**${pr.bits / 8}** B`;
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
    return `offset ${fmtOffset(it.offsetBits)} · ${it.sizeBits} bit${it.sizeBits === 1 ? '' : 's'}`;
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
  if (one && it.align) parts.push(`align ${it.align}`);
  else if (!one) parts.unshift(`${items.length} members`);
  return parts.join(' · ');
}

export function fmtOffset(bits: number): string {
  return bits % 8 === 0 ? String(bits / 8) : `${Math.floor(bits / 8)} +${bits % 8}b`;
}
