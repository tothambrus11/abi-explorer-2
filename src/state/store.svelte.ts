// Application state (Svelte 5 runes). One source of truth for the sources,
// each with its options, its analysis, its selection and its hover, plus what
// is shared between them: the view, the compilers, the window. Every view
// derives from it; nothing is stored in the DOM.

import type { AnalysedRecord, Analysis } from '$compiler/AbiAnalyzer';
import type { ModuleStatus } from '$compiler/AbiClient';
import { backendFor, type BackendId } from '$compiler/Backends';
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
import {
  defaultBufferName,
  MAX_BUFFERS,
  type DockLayout,
  type SourceBuffer,
  type ViewMode,
} from '$core/url-state';
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

let nextSourceId = 1;

/**
 * One source: its text, how it is compiled, and what came back.
 *
 * Each has options of its own. A session comparing a struct on two targets
 * is two sources with the same text and different triples, and a session
 * comparing C with Hylo is two sources in different languages; both are
 * questions asked side by side, and neither is served by options that follow
 * whichever editor was last clicked.
 *
 * `id` is stable for the visit and unique among the sources that have existed
 * in it, which is what the dock names its panels by; it is not in a link,
 * where position is identity.
 */
export class Source {
  readonly id: number = nextSourceId++;
  name: string = $state('');
  text: string = $state('');
  options: CompileOptions = $state({ ...DEFAULT_OPTIONS });
  selectedRecord: string | null = $state(null);
  status: AnalysisStatus = $state({ kind: 'idle' });
  analysis: Analysis | null = $state.raw(null);
  hover: Hover = $state.raw(EMPTY_HOVER);

  /**
   * The triple to go back to when a C or C++ language is chosen again.
   *
   * Hylo has one ABI and no triple to pick, so selecting it replaces whatever
   * target was chosen. Losing that choice on the way back would be a silent
   * change of answer for a user who only wanted to look at Hylo for a moment.
   */
  private lastClangTriple: string;

  constructor(buffer: SourceBuffer) {
    this.name = buffer.name;
    this.text = buffer.source;
    this.options = { ...buffer.options };
    this.lastClangTriple =
      buffer.options.lang === 'hylo' ? DEFAULT_OPTIONS.triple : buffer.options.triple;
  }

  /** The undoable, shareable half: what a link and a history step hold. */
  toBuffer(): SourceBuffer {
    return { name: this.name, source: this.text, options: { ...this.options } };
  }

  /**
   * Puts a buffer back into this source, as an undo does.
   *
   * Only what differs is written: an undo of a keystroke elsewhere must not
   * touch this source at all. Where the text or the options change, the
   * selected record goes with them: it names a record of the layout being
   * replaced, and may not exist in the one that is coming.
   */
  assign(buffer: SourceBuffer): void {
    if (this.name !== buffer.name) this.name = buffer.name;
    const sameText = this.text === buffer.source;
    const sameOptions = JSON.stringify(this.options) === JSON.stringify(buffer.options);
    if (!sameText) this.text = buffer.source;
    if (!sameOptions) this.options = { ...buffer.options };
    if (!sameText || !sameOptions) this.selectedRecord = null;
  }

  // -------------------------------------------------------- derived ----

  /**
   * Records worth showing. The response only carries what the user's file
   * declares (a library record reaches the app solely as the type of a
   * member), so what is left to decide is the nested anonymous ones, which are
   * drawn inside their parent rather than listed beside it.
   */
  visibleRecords: AnalysedRecord[] = $derived(
    this.analysis?.records.filter((r) => store.showInternal || r.listed) ?? [],
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
      store.view === 'stack'
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
   * Selects a language, and brings everything that depends on it along.
   *
   * That includes the text: it becomes the language's first example. C source
   * left in front of a Hylo compiler is a screen of diagnostics about a
   * question nobody asked, and the reader who wanted to see Hylo has to clear
   * it before anything can be laid out. What they wrote is one undo away, and
   * the two halves change together, so a single undo puts both back.
   *
   * A standard the new language does not have becomes its default, and the
   * target follows the language, with the last clang triple kept for the way
   * back. A language with no example keeps the text, having nothing to put
   * in its place.
   */
  setLanguage(lang: Language): void {
    if (this.options.lang === lang) return;
    this.retarget(lang);
    const example = EXAMPLES.find((e) => e.lang === lang);
    if (example) {
      this.text = example.source;
      this.selectedRecord = null;
    }
  }

  /**
   * Points the options at `lang`: the language itself, a standard it has, and
   * the target — Hylo's single ABI, or the last clang triple on the way back.
   */
  private retarget(lang: Language): void {
    if (this.options.lang !== 'hylo') this.lastClangTriple = this.options.triple;
    this.options.lang = lang;
    this.options.triple = lang === 'hylo' ? HYLO_TRIPLE : this.lastClangTriple;
    if (!standardsFor(lang).includes(this.options.std)) this.options.std = defaultStdFor(lang);
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
    this.text = ex.source;
    this.selectedRecord = null;
  }
}

/** The buffer a fresh visit opens on: the first example, in the default language. */
export function defaultBuffer(): SourceBuffer {
  return {
    name: defaultBufferName(0),
    source: EXAMPLES[0]?.source ?? '',
    options: { ...DEFAULT_OPTIONS },
  };
}

/**
 * The one place the app's state lives: the sources, and what they share.
 *
 * A singleton, exported as `store` below. Fields are written directly; the
 * methods exist where a change has consequences beyond the field it names.
 */
class Store {
  /** The sources, in tab order; never empty. Each is compiled on its own. */
  sources: Source[] = $state([new Source(defaultBuffer())]);
  /**
   * Which source is in focus: the one the top strip's settings describe when
   * there is only one, and the one every panel group brings forward when
   * there are several.
   */
  activeIndex: number = $state(0);
  view: ViewMode = $state(readView());
  showInternal = $state(false);

  /**
   * The arrangement as the dock last serialized it, panels named by source
   * position. Written by the dock, and carried by every link: where the
   * panels are is part of what is on screen.
   */
  dockLayout: DockLayout | null = $state.raw(null);
  /** An arrangement a link brought, waiting for the dock to mount and take it. */
  pendingLayout: DockLayout | null = $state.raw(null);

  /** The source in focus. Total: the list is never empty. */
  get active(): Source {
    return this.sources[this.activeIndex] ?? this.sources[0]!;
  }

  /**
   * A source being looked at without being chosen: the pointer is over one of
   * its panels, and its other panels come forward for as long as it is. Not
   * the selection, so not in a link, not in the history, and gone when the
   * pointer goes.
   */
  peek: number | null = $state(null);
  /** The source whose panels are forward: the peeked one while there is one, else the one in focus. */
  get shown(): Source {
    const peeked = this.peek === null ? undefined : this.sources.find((s) => s.id === this.peek);
    return peeked ?? this.active;
  }

  /**
   * Each compiler's status. Two, because a session can hold a C source and
   * a Hylo source at once, and each is answered by its own module.
   */
  backends: Record<BackendId, ModuleStatus> = $state({
    clang: { state: 'idle' },
    hylo: { state: 'idle' },
  });
  /**
   * A download is waiting for the user to opt in (metered connection,
   * nothing cached yet). Set by the session; cleared once they accept.
   */
  awaitingDownloadConsent = $state(false);
  /** A service worker controls this page (assets are cached). */
  swControlled = $state(false);
  swVersionAvailable = $state(false);
  /** Narrow (phone) layout: driven by a media query. */
  narrow = $state(NARROW_MQ?.matches ?? false);
  /** The languages the sources are in, so the session knows which compilers to load. */
  languages: Set<Language> = $derived(new Set(this.sources.map((s) => s.options.lang)));
  /** Everything needed to work offline is local: cached assets + the loaded compilers. */
  offlineReady = $derived(
    this.swControlled && [...this.languages].every((l) => this.compilerFor(l).state === 'ready'),
  );

  /** The status of the compiler that answers for `lang`. */
  compilerFor(lang: Language): ModuleStatus {
    return this.backends[backendFor(lang)];
  }

  // -------------------------------------------------------- actions ----

  /** Puts a source in focus. Nothing else changes: each source keeps its own options. */
  selectSource(index: number): void {
    if (!this.sources[index] || index === this.activeIndex) return;
    this.activeIndex = index;
  }

  /** `selectSource` by identity, which is what a panel knows its source by. A choice ends a peek. */
  selectSourceById(id: number): void {
    this.peek = null;
    const index = this.sources.findIndex((s) => s.id === id);
    if (index >= 0) this.selectSource(index);
  }

  /**
   * Opens a fresh source beside the others and puts it in focus.
   *
   * Empty, with the options of the source in focus: a new source is for the
   * reader's own code, on the target they are already looking at, and an
   * example would be something to delete first. Refuses quietly at the cap,
   * which is also as many as a link can carry.
   */
  addSource(): Source | null {
    if (this.sources.length >= MAX_BUFFERS) return null;
    const taken = new Set(this.sources.map((s) => s.name));
    let name = defaultBufferName(this.sources.length);
    for (let i = 0; taken.has(name); i++) name = defaultBufferName(i);
    const source = new Source({ name, source: '', options: { ...this.active.options } });
    this.sources.push(source);
    this.selectSource(this.sources.length - 1);
    return source;
  }

  /**
   * Closes a source; the last one stays, there being nothing to show without
   * it. Closing the one in focus lands on its right-hand neighbour (or the new
   * last). The closed source remains one undo away, like everything else.
   */
  closeSource(index: number): void {
    if (this.sources.length <= 1 || !this.sources[index]) return;
    const wasActive = index === this.activeIndex;
    this.sources.splice(index, 1);
    if (this.activeIndex > index) this.activeIndex -= 1;
    else if (wasActive) this.activeIndex = Math.min(index, this.sources.length - 1);
    this.endPeekIfGone();
  }

  /**
   * Ends a peek at a source that is no longer here. Its panel went with it,
   * and a panel taken from under the pointer never says the pointer left.
   */
  private endPeekIfGone(): void {
    if (this.peek !== null && !this.sources.some((s) => s.id === this.peek)) this.peek = null;
  }

  /**
   * Replaces the sources with `buffers`, keeping the identity of every source
   * that has a counterpart by position.
   *
   * An undo or a link arriving is a new list of buffers, but the panels on
   * screen are named after the sources they show, and rebuilding every source
   * would rebuild every panel to put back one word. Position is identity here,
   * as it is in a link.
   */
  replaceSources(buffers: SourceBuffer[], active: number): void {
    const kept = Math.min(buffers.length, this.sources.length);
    for (let i = 0; i < kept; i++) this.sources[i]!.assign(buffers[i]!);
    for (let i = kept; i < buffers.length; i++) this.sources.push(new Source(buffers[i]!));
    if (this.sources.length > buffers.length) this.sources.splice(buffers.length);
    this.activeIndex = Math.min(Math.max(active, 0), this.sources.length - 1);
    this.endPeekIfGone();
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
