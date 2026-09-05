// Orchestration for the visit as a whole: which compilers to load, the undo
// history over every source, the link in the address bar, and one
// `SourceSession` per source doing the compiling and the hovering.

import { AbiAnalyzer } from '$compiler/AbiAnalyzer';
import { backendFor, type BackendId, type Backends } from '$compiler/Backends';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { defaultBuffer, store, type Source } from './store.svelte';
import { SourceSession, type LineInfo } from './source-session.svelte';
import { grantConsent, shouldAskBeforeDownload } from './download-gate';
import {
  History,
  historyIntent,
  ownsUndo,
  type EditableTarget,
  type Snapshot,
} from './history.svelte';
import { describeItems, fmtOffset } from './hover';

export type { LineInfo, SourceSession };

const HASH_DEBOUNCE_MS = 400;

/**
 * What the app does, as opposed to what it shows.
 *
 * Owns the history, the link, and the decision of which compiler to download
 * and when; each source's own work happens in its `SourceSession`, which this
 * makes as the source appears and disposes as it goes. Nothing here touches
 * the DOM.
 *
 * `start` wires the reactive effects and returns their disposer; nothing runs
 * until it is called, which is what lets `restoreFromUrl` finish first.
 */
export class Session {
  /** The analyzer every query goes through; shared, since it memoizes by question. */
  readonly analyzer: AbiAnalyzer;
  private readonly sessions = new Map<Source, SourceSession>();
  private cleanup: (() => void) | null = null;
  /** Set for the whole of `start`, so a session made during it starts too. */
  private started = false;

  /**
   * Undo and redo over the sources and their options together. In memory only:
   * see `history.svelte`.
   */
  readonly history = new History(this.snapshot());

  /** Backends already asked about, so the gate is consulted once per module. */
  private readonly booted = new Set<BackendId>();
  /** Backends whose download waits for the user's opt-in. */
  private readonly pendingConsent = new Set<BackendId>();

  /**
   * A session answering through `backends`, which routes each query to the
   * compiler for its language and downloads only what is asked for.
   */
  constructor(private readonly backends: Backends) {
    this.analyzer = new AbiAnalyzer(backends);
  }

  /**
   * The session of `source`, made on first request.
   *
   * On request rather than only from the effect in `start`, because the dock
   * mounts a source's panels in the same tick the source appears, before any
   * effect has run.
   */
  for(source: Source): SourceSession {
    let s = this.sessions.get(source);
    if (!s) {
      s = new SourceSession(source, this.analyzer, this);
      if (this.started) s.start();
      this.sessions.set(source, s);
    }
    return s;
  }

  /** The session of the source in focus. */
  get active(): SourceSession {
    return this.for(store.active);
  }

  /**
   * Back to where a visit starts: one source holding the first example, on the
   * default options. The address bar starts over too: the fragment of the
   * session that was is taken off at once rather than left for the debounce,
   * and the sync then writes the new session's, as it does on any visit.
   *
   * The arrangement is the reader's rather than the link's, so it stays as
   * they have it; and the sources being replaced are recorded, so this is one
   * undo away like everything else.
   */
  reset(): void {
    store.replaceSources([defaultBuffer()], 0);
    store.active.selectedRecord = null;
    history.replaceState(null, '', location.pathname + location.search);
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
   * The store's undoable half, copied: every source with its options, and
   * which is in focus. What the history records and what an undo puts back.
   */
  private snapshot(): Snapshot {
    return { buffers: store.sources.map((s) => s.toBuffer()), active: store.activeIndex };
  }

  /**
   * Puts a snapshot back into the store, or does nothing for `null`, which is
   * what `undo`/`redo` return at the ends of the history.
   */
  private apply(s: Snapshot | null): void {
    if (!s) return;
    // Guarded, so the effect that watches the store does not record putting a
    // state back as a new state to come back to.
    this.history.applying = true;
    store.replaceSources(s.buffers, s.active);
    // Cleared after the effects that read them have run.
    queueMicrotask(() => (this.history.applying = false));
  }

  /**
   * Decide whether each needed module may start downloading, and start it if
   * so. Call this first and *only* through here: on a metered connection
   * (issue #1) the download waits for an explicit opt-in, so nothing else may
   * kick it off: starting it eagerly elsewhere would fetch the bundle behind
   * the consent prompt and make the gate decorative.
   *
   * Returns a promise for tests; callers may ignore it (the load is slow and
   * DOM-independent, so the app mounts while it runs).
   */
  async boot(): Promise<void> {
    // Each language in use decides a module about to be downloaded, and each
    // is asked about separately: they are different sizes and a visitor may
    // have one cached and not the other.
    await Promise.all([...store.languages].map((lang) => this.ensureBackend(backendFor(lang))));
  }

  private async ensureBackend(id: BackendId): Promise<void> {
    if (this.booted.has(id)) return;
    this.booted.add(id);
    // No usable hint (or the check threw): behave as on an unmetered link.
    const ask = await shouldAskBeforeDownload(id).catch(() => false);
    if (ask) {
      this.pendingConsent.add(id);
      store.awaitingDownloadConsent = true;
    } else {
      this.startBackend(id);
    }
  }

  /**
   * Starts a download. Failures are left to the module status rather than
   * thrown from here: this is reached from event handlers, and the banner
   * already says what happened.
   */
  private startBackend(id: BackendId): void {
    void this.backends.start(id).catch(() => {});
  }

  /**
   * The user accepted the download. Remembers the consent for later visits and
   * starts every module that was waiting on it; the prompt does not reappear
   * this session.
   */
  allowDownload(): void {
    grantConsent();
    store.awaitingDownloadConsent = false;
    const needed = new Set([...store.languages].map(backendFor));
    for (const id of this.pendingConsent) {
      // A module no source needs any more is not started on the strength
      // of a prompt that named another. If a source needs it again, the gate
      // is asked again, and the consent just given answers it.
      if (needed.has(id)) this.startBackend(id);
      else this.booted.delete(id);
    }
    this.pendingConsent.clear();
  }

  /** Wire reactive effects. Returns a disposer. */
  start(): () => void {
    const offStatus = this.backends.onAnyStatus((id, s) => {
      store.backends[id] = s;
    });

    // Captured, so it runs before the editor's own undo. Monaco has a stack of
    // its own and it knows only about text; letting it win would undo the
    // characters while leaving the option change that came after them.
    const onKey = (e: KeyboardEvent) => {
      const intent = historyIntent(e);
      if (!intent) return;
      // Except where the keystroke is already about something: a text field's
      // undo is the text field's.
      if (ownsUndo(e.target as EditableTarget | null)) return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'undo') this.undo();
      else this.redo();
    };
    window.addEventListener('keydown', onKey, { capture: true });

    // Sessions made before `start` were waiting for it.
    this.started = true;
    for (const s of this.sessions.values()) s.start();

    const stopRoot = $effect.root(() => {
      // A session per source, for exactly as long as the source exists.
      $effect(() => {
        const live = new Set(store.sources);
        for (const source of live) this.for(source);
        for (const [source, s] of this.sessions) {
          if (live.has(source)) continue;
          s.dispose();
          this.sessions.delete(source);
        }
      });
      // Every state the user arrives at, recorded so they can come back to it.
      $effect(() => {
        this.history.record(this.snapshot());
      });
      // Choosing a language chooses a compiler, and the second one is not
      // downloaded until something needs it (see `Backends`). The gate decides
      // again for it: it is a different download of a different size, and one
      // the visitor may not have cached. The selection is what the analyzer's
      // version and target list answer for.
      $effect(() => {
        this.backends.select(store.active.options.lang);
        for (const lang of store.languages) void this.ensureBackend(backendFor(lang));
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
        // Also on teardown, so a session that is disposed mid-debounce does
        // not write its address bar afterwards.
        return () => {
          if (hashTimer) clearTimeout(hashTimer);
        };
      });
    });

    this.cleanup = () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      offStatus();
      stopRoot();
      for (const s of this.sessions.values()) s.dispose();
      this.sessions.clear();
      this.started = false;
      this.cleanup = null;
    };
    return this.cleanup;
  }

  /**
   * Restores the state a shared link carries, and reports whether there was one.
   *
   * - Call before `start`, and before the modules are booted: the link says
   *   which languages are wanted, and booting first starts the wrong compiler.
   * - Leaves the store untouched when the fragment is absent or unreadable, so
   *   a corrupt link opens the app rather than half of someone else's session.
   * - Clears the history: a link is where a visit begins, not a state to undo
   *   back out of.
   */
  async restoreFromUrl(): Promise<boolean> {
    const s = await decodeShareState(location.hash);
    if (!s) return false;
    // In focus: the first, until the arrangement, if the link has one, says
    // which tab is in front where; the dock applies that when it mounts.
    store.replaceSources(s.buffers, 0);
    s.buffers.forEach((b, i) => {
      store.sources[i]!.selectedRecord = b.selectedRecord;
    });
    store.pendingLayout = s.layout ?? null;
    // A shared link's view mode applies to this visit only; it must not
    // overwrite the visitor's own persisted preference.
    store.view = s.view;
    this.history.reset(this.snapshot());
    return true;
  }

  /** Everything a link carries: what to compile, how, and what to be looking at. */
  private shareState(): ShareState {
    const state: ShareState = {
      buffers: store.sources.map((s) => ({ ...s.toBuffer(), selectedRecord: s.selectedRecord })),
      view: store.view,
    };
    // A link is what is on screen, and where the panels are is part of that:
    // a session comparing two layouts side by side is not the same session
    // with them stacked.
    if (store.dockLayout) state.layout = store.dockLayout;
    return state;
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
}

// The hover formatters live with the hover resolution they belong to; re-exported
// here because the UI has always imported them from the session.
export { describeItems, fmtOffset };
