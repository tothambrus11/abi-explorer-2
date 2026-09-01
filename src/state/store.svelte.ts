// Application state (Svelte 5 runes). One source of truth for options,
// source, view, selection, the current analysis, and hover. Every view
// derives from it; nothing is stored in the DOM.

import type { AnalysedRecord, Analysis } from '$compiler/AbiAnalyzer';
import type { ModuleStatus } from '$compiler/AbiClient';
import {
  DEFAULT_OPTIONS,
  defaultStdFor,
  HYLO_TRIPLE,
  standardsFor,
  type CompileOptions,
  type Language,
} from '$core/options';
import { EXAMPLES } from '$core/targets';
import type { RenderModel } from '$core/types';
import type { ViewMode } from '$core/url-state';
import { EMPTY_HOVER } from './hover';

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

/** A stretch of bytes belonging to one hovered thing. */
export interface ByteRange {
  record: string;
  /** Byte offsets, half-open. */
  start: number;
  end: number;
}

/** Hover state shared by grid, table and editor. */
export interface Hover {
  members: MemberRef[];
  /**
   * The extent of what is hovered, so the byte map can light the bytes *inside*
   * a member that no member of its own occupies, its internal padding. A
   * member's row says it takes eight bytes; pointing at it has to show which
   * eight, and the five that happen to hold a field are not an answer.
   */
  ranges: ByteRange[];
  /** Editor line to highlight. */
  line: number | null;
  /** The member's own name, for the strong highlight on a shared line. */
  nameRange: { line: number; startCol: number; endCol: number } | null;
  /** Inlay text after that line. */
  inlay: string | null;
  /** Anchor for the tooltip (grid/table hover only). */
  tooltip: { html: string; x: number; y: number } | null;
}

const VIEW_KEY = 'abix-view';

/** Shared media query for the narrow (phone) layout; one object, reused for the listener. */
const NARROW_MQ = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;

class Store {
  options: CompileOptions = $state({ ...DEFAULT_OPTIONS });
  source: string = $state(EXAMPLES[0]?.source ?? '');
  view: ViewMode = $state(readView());
  selectedRecord: string | null = $state(null);
  showInternal = $state(false);

  compiler: ModuleStatus = $state({ state: 'idle' });
  status: AnalysisStatus = $state({ kind: 'idle' });
  analysis: Analysis | null = $state.raw(null);
  hover: Hover = $state.raw(EMPTY_HOVER);
  /**
   * The clang download is waiting for the user to opt in (metered connection,
   * nothing cached yet). Set by the session; cleared once they accept.
   */
  awaitingDownloadConsent = $state(false);
  /** A service worker controls this page (assets are cached). */
  swControlled = $state(false);
  swVersionAvailable = $state(false);
  /** Narrow (phone) layout: driven by a media query. */
  narrow = $state(NARROW_MQ?.matches ?? false);
  /** Everything needed to work offline is local: cached assets + a loaded compiler. */
  offlineReady = $derived(this.swControlled && this.compiler.state === 'ready');

  // -------------------------------------------------------- derived ----

  /**
   * Records worth showing. The response only carries what the user's file
   * declares (a library record reaches the app solely as the type of a
   * member), so what is left to decide is the nested anonymous ones, which are
   * drawn inside their parent rather than listed beside it.
   */
  visibleRecords: AnalysedRecord[] = $derived(
    this.analysis?.records.filter((r) => this.showInternal || r.listed) ?? [],
  );

  /** The record shown in tabs mode (falls back to the last one). */
  activeRecordKey = $derived.by(() => {
    const recs = this.modelRecords;
    if (recs.length === 0) return null;
    return (recs.find((r) => r.key === this.selectedRecord) ?? recs[recs.length - 1]!).key;
  });

  /**
   * Records to build models for: the visible ones, plus whichever record was
   * explicitly selected. Drilling into a nested anonymous member should show
   * it even though it is not listed on its own.
   */
  modelRecords: AnalysedRecord[] = $derived.by(() => {
    const recs = [...this.visibleRecords];
    const sel = this.selectedRecord;
    if (sel !== null && !recs.some((r) => r.key === sel)) {
      const extra = this.analysis?.byKey.get(sel);
      if (extra) recs.push(extra);
    }
    return recs;
  });

  /** Render models by record key. The analysis already built them. */
  models = $derived(new Map<string, RenderModel>(this.modelRecords.map((r) => [r.key, r.model])));

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

  /**
   * The triple to go back to when a C or C++ language is chosen again.
   *
   * Hylo has one ABI and no triple to pick, so selecting it replaces whatever
   * target was chosen. Losing that choice on the way back would be a silent
   * change of answer for a user who only wanted to look at Hylo for a moment.
   */
  private lastClangTriple = DEFAULT_OPTIONS.triple;

  setLanguage(lang: Language): void {
    if (this.options.lang === lang) return;
    if (this.options.lang !== 'hylo') this.lastClangTriple = this.options.triple;
    this.options.lang = lang;
    this.options.triple = lang === 'hylo' ? HYLO_TRIPLE : this.lastClangTriple;
    if (!standardsFor(lang).includes(this.options.std)) this.options.std = defaultStdFor(lang);
  }

  /**
   * Loads an example, and the language it is written in if that is not the one
   * selected.
   *
   * The language is only ever changed *towards* an example, never the other
   * way: switching language leaves the buffer alone, because the text is the
   * user's and replacing it is not something a radio button should do.
   */
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
