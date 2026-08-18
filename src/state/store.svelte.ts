// Application state (Svelte 5 runes). One source of truth for options,
// source, view, selection, the current analysis, and hover — every view
// derives from it; nothing is stored in the DOM.

import type { Analysis } from '$compiler/Analyzer';
import type { CompilerStatus } from '$compiler/Compiler';
import {
  DEFAULT_OPTIONS,
  defaultStdFor,
  standardsFor,
  type CompileOptions,
  type Language,
} from '$core/options';
import { EXAMPLES } from '$core/targets';
import { anonymousLocationFilter, isAnonymousRecord, recordKey } from '$core/layout-parser';
import { sourceExtension } from '$core/options';
import { assignColors, buildRenderModel } from '$core/model';
import type { RenderModel } from '$core/types';
import type { ViewMode } from '$core/url-state';

export type AnalysisStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; warnings: boolean }
  | { kind: 'error'; message: string };

/** A member of a record, addressable across records/sections. */
export interface MemberRef {
  record: string; // recordKey
  leaf: number;
}

export interface Section {
  key: string;
  model: RenderModel;
}

/** Hover state shared by grid, table and editor. */
export interface Hover {
  members: MemberRef[];
  /** Editor line to highlight. */
  line: number | null;
  /** Inlay text after that line. */
  inlay: string | null;
  /** Anchor for the tooltip (grid/table hover only). */
  tooltip: { html: string; x: number; y: number } | null;
}

const EMPTY_HOVER: Hover = { members: [], line: null, inlay: null, tooltip: null };

const VIEW_KEY = 'abix-view';

/** Shared media query for the narrow (phone) layout; one object, reused for the listener. */
const NARROW_MQ = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;

class Store {
  options: CompileOptions = $state({ ...DEFAULT_OPTIONS });
  source: string = $state(EXAMPLES[0]?.source ?? '');
  view: ViewMode = $state(readView());
  selectedRecord: string | null = $state(null);
  showInternal = $state(false);

  compiler: CompilerStatus = $state({ state: 'idle' });
  status: AnalysisStatus = $state({ kind: 'idle' });
  analysis: Analysis | null = $state.raw(null);
  hover: Hover = $state.raw(EMPTY_HOVER);
  /** `<unqualified owner> <field>` -> explicit alignment from the AST (filled in by the session). */
  memberAligns: Map<string, number> = $state.raw(new Map<string, number>());
  /** A service worker controls this page (assets are cached). */
  swControlled = $state(false);
  swVersionAvailable = $state(false);
  /** Narrow (phone) layout: driven by a media query. */
  narrow = $state(NARROW_MQ?.matches ?? false);
  /** Everything needed to work offline is local: cached assets + a loaded compiler. */
  offlineReady = $derived(this.swControlled && this.compiler.state === 'ready');

  // -------------------------------------------------------- derived ----

  /** Records worth showing (no compiler-internal or anonymous ones unless asked). */
  visibleRecords = $derived.by(() => {
    const a = this.analysis;
    if (!a) return [];
    const mainFile = 'input.' + sourceExtension(a.options.lang);
    return a.userRecords.filter(
      (r) =>
        this.showInternal ||
        (!r.name.startsWith('__') &&
          // Nested anonymous records are shown inline in their parent; top-level
          // ones from the user's file (`typedef struct { … } T;`) are records of their own.
          (!isAnonymousRecord(r) || anonymousLocationFilter(r, mainFile) !== null)),
    );
  });

  /** The record shown in tabs mode (falls back to the last one). */
  activeRecordKey = $derived.by(() => {
    const recs = this.visibleRecords;
    if (recs.length === 0) return null;
    const found = recs.find((r) => recordKey(r) === this.selectedRecord);
    return recordKey(found ?? recs[recs.length - 1]!);
  });

  /** Render models for every visible record (built once per analysis). */
  models = $derived.by(() => {
    const a = this.analysis;
    const out = new Map<string, RenderModel>();
    if (!a) return out;
    for (const rec of this.visibleRecords) {
      const model = buildRenderModel(rec, { ...a, memberAligns: this.memberAligns });
      assignColors(model);
      out.set(recordKey(rec), model);
    }
    return out;
  });

  /** Sections to render: one (tabs) or all (stack). */
  sections = $derived.by(() => {
    const keys =
      this.view === 'stack'
        ? [...this.models.keys()]
        : this.activeRecordKey
          ? [this.activeRecordKey]
          : [];
    return keys.flatMap((key) => {
      const model = this.models.get(key);
      return model ? [{ key, model } satisfies Section] : [];
    });
  });

  // -------------------------------------------------------- actions ----

  setLanguage(lang: Language): void {
    if (this.options.lang === lang) return;
    this.options.lang = lang;
    if (!standardsFor(lang).includes(this.options.std)) this.options.std = defaultStdFor(lang);
  }

  loadExample(index: number): void {
    const ex = EXAMPLES[index];
    if (!ex) return;
    this.setLanguage(ex.lang);
    this.source = ex.source;
    this.selectedRecord = null;
  }

  setView(view: ViewMode): void {
    this.view = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode */
    }
  }

  toggleView(): void {
    this.setView(this.view === 'stack' ? 'tabs' : 'stack');
  }

  setHover(h: Partial<Hover> | null): void {
    this.hover = h ? { ...EMPTY_HOVER, ...h } : EMPTY_HOVER;
  }
}

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'stack' ? 'stack' : 'tabs';
  } catch {
    return 'tabs';
  }
}

export const store = new Store();
NARROW_MQ?.addEventListener('change', (e) => {
  store.narrow = e.matches;
});
