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
import { defaultBufferName, MAX_BUFFERS, type SourceBuffer, type ViewMode } from '$core/url-state';
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

/**
 * The one place the app's state lives: the query, the answer, and what the
 * reader is pointing at.
 *
 * A singleton, exported as `store` below. Fields are written directly; the
 * methods exist where a change has consequences beyond the field it names.
 */
class Store {
  options: CompileOptions = $state({ ...DEFAULT_OPTIONS });
  /**
   * The sources, one per editor tab; never empty. Only the active one is
   * compiled: the others wait their turn, which is what lets one link carry a
   * Compiler Explorer session with several editors.
   */
  buffers: SourceBuffer[] = $state([
    { name: defaultBufferName(0), lang: DEFAULT_OPTIONS.lang, source: EXAMPLES[0]?.source ?? '' },
  ]);
  /** Which buffer is on screen. `options.lang` always describes this one. */
  activeBuffer: number = $state(0);
  view: ViewMode = $state(readView());
  selectedRecord: string | null = $state(null);
  showInternal = $state(false);

  /**
   * The active buffer's text, under the name the rest of the app has always
   * read it by. An accessor rather than a field so there is one copy: the
   * editor writes here, and whichever buffer is active is what changes.
   */
  get source(): string {
    return this.buffers[this.activeBuffer]?.source ?? '';
  }
  set source(text: string) {
    const buffer = this.buffers[this.activeBuffer];
    if (buffer) buffer.source = text;
  }

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

  /**
   * Selects a language, and brings everything that depends on it along.
   *
   * That includes the buffer: it becomes the language's first example. C source
   * left in front of a Hylo compiler is a screen of diagnostics about a
   * question nobody asked, and the reader who wanted to see Hylo has to clear
   * it before anything can be laid out. What they wrote is one undo away, and
   * the two halves change together, so a single undo puts both back.
   *
   * A standard the new language does not have becomes its default, and the
   * target follows the language, with the last clang triple kept for the way
   * back. A language with no example keeps the buffer, having nothing to put
   * in it.
   */
  setLanguage(lang: Language): void {
    if (this.options.lang === lang) return;
    this.retarget(lang);
    const buffer = this.buffers[this.activeBuffer];
    if (buffer) buffer.lang = lang;
    const example = EXAMPLES.find((e) => e.lang === lang);
    if (example) {
      this.source = example.source;
      this.selectedRecord = null;
    }
  }

  /**
   * Points the options at `lang`: the language itself, a standard it has, and
   * the target — Hylo's single ABI, or the last clang triple on the way back.
   *
   * The half of a language change that is about the *question* rather than the
   * buffer, shared between choosing a language and switching to a buffer that
   * is already in one.
   */
  private retarget(lang: Language): void {
    if (this.options.lang !== 'hylo') this.lastClangTriple = this.options.triple;
    this.options.lang = lang;
    this.options.triple = lang === 'hylo' ? HYLO_TRIPLE : this.lastClangTriple;
    if (!standardsFor(lang).includes(this.options.std)) this.options.std = defaultStdFor(lang);
  }

  /**
   * Puts a buffer on screen. The options follow its language — target and
   * standard included, exactly as if the language selector had been used — and
   * the selected record is dropped, since it names a record of the buffer
   * going off screen.
   */
  selectBuffer(index: number): void {
    const buffer = this.buffers[index];
    if (!buffer || index === this.activeBuffer) return;
    this.activeBuffer = index;
    this.retarget(buffer.lang);
    this.selectedRecord = null;
  }

  /**
   * Opens a fresh buffer beside the others and switches to it.
   *
   * Empty, in the language already selected: a new tab is for the reader's own
   * code, and an example would be something to delete first. Refuses quietly at
   * the cap, which is also as many as a link can carry.
   */
  addBuffer(): void {
    if (this.buffers.length >= MAX_BUFFERS) return;
    const taken = new Set(this.buffers.map((b) => b.name));
    let name = defaultBufferName(this.buffers.length);
    for (let i = 0; taken.has(name); i++) name = defaultBufferName(i);
    this.buffers.push({ name, lang: this.options.lang, source: '' });
    this.selectBuffer(this.buffers.length - 1);
  }

  /**
   * Closes a buffer; the last one stays, there being nothing to show without
   * it. Closing the active one lands on its right-hand neighbour (or the new
   * last), whose language the options then follow. The closed source remains
   * one undo away, like everything else.
   */
  closeBuffer(index: number): void {
    if (this.buffers.length <= 1 || !this.buffers[index]) return;
    const wasActive = index === this.activeBuffer;
    this.buffers.splice(index, 1);
    if (this.activeBuffer > index) {
      this.activeBuffer -= 1;
    } else if (wasActive) {
      this.activeBuffer = Math.min(index, this.buffers.length - 1);
      this.retarget(this.buffers[this.activeBuffer]!.lang);
      this.selectedRecord = null;
    }
  }

  /**
   * Loads an example, and the language it is written in if that is not the one
   * selected.
   *
   * Written after `setLanguage` rather than instead of it: switching language
   * loads that language's *first* example, and this one is whichever was asked
   * for.
   */
  loadExample(index: number): void {
    const ex = EXAMPLES[index];
    if (!ex) return;
    this.setLanguage(ex.lang);
    this.source = ex.source;
    this.selectedRecord = null;
  }

  /**
   * Switches between the stacked and tabbed layouts, and remembers the choice.
   *
   * Persisted per visitor rather than per link: a shared link's view applies to
   * that visit only, and must not overwrite what the reader prefers.
   */
  setView(view: ViewMode): void {
    this.view = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode */
    }
  }

  /** Switches to whichever layout is not showing, and remembers it. */
  toggleView(): void {
    this.setView(this.view === 'stack' ? 'tabs' : 'stack');
  }
}

/** The remembered layout, defaulting to tabs where storage cannot be read. */
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
