// Which compiler answers, and when its module is allowed to start downloading.
//
// There are two now, they are 11 MB and 20 MB, and they have nothing to say
// about each other's languages. Loading both to answer a question about one
// would cost a visitor 31 MB to use half of it, so a backend is started by the
// first query that needs it and not before. Selecting Hylo downloads Hylo;
// selecting C or C++ downloads clang; a session that never switches never pays
// for the other one.
//
// The router is an `AbiModule` itself, so the analyzer above it is unchanged:
// it asks the same three questions and does not know there is a choice.

import type { AbiModule } from './AbiAnalyzer';
import type { AbiClient, ModuleStatus } from './AbiClient';
import type { Language } from '$core/options';
import type { WireResponse } from '$core/render';

/** Which compiler a language is answered by. */
export type BackendId = 'clang' | 'hylo';

/** Which compiler answers for `lang`. Total: every language has exactly one. */
export function backendFor(lang: Language): BackendId {
  return lang === 'hylo' ? 'hylo' : 'clang';
}

/** How a backend is referred to on screen, and what it is. */
export interface BackendDescription {
  /** What to call the compiler in a sentence. */
  name: string;
  /** The compiler's own home. */
  home: string;
  /** The WebAssembly build of it that this app loads. */
  module: { name: string; url: string };
  /** What a record is called in this language, for the "nothing here" note. */
  declarations: string;
  /** Whether the language resolves standard headers, which only clang does. */
  headers: boolean;
}

const DESCRIPTIONS: Record<BackendId, BackendDescription> = {
  clang: {
    name: 'clang',
    home: 'https://llvm.org/',
    module: { name: 'clang-abi-wasm', url: 'https://github.com/tothambrus11/clang-abi-wasm' },
    declarations: 'struct/class/union definitions',
    headers: true,
  },
  hylo: {
    name: 'the Hylo compiler',
    home: 'https://github.com/hylo-lang/hylo-new',
    module: { name: 'hylo-abi-wasm', url: 'https://github.com/tothambrus11/hylo-abi-wasm' },
    declarations: 'struct or enum declarations',
    headers: false,
  },
};

/**
 * How to describe whichever compiler answers for `lang`.
 *
 * Total, and the single place a view asks: naming a compiler in a view is how
 * "Downloading clang" came to appear while Hylo was downloading.
 */
export function describeBackend(lang: Language): BackendDescription {
  return DESCRIPTIONS[backendFor(lang)];
}

/** Nothing has been chosen yet, so nothing is loading. */
const IDLE: ModuleStatus = { state: 'idle' };

export class Backends implements AbiModule {
  /** The one whose status the UI shows and whose module the queries go to. */
  private active: BackendId = 'clang';
  private readonly clients = new Map<BackendId, AbiClient>();
  private readonly unsubscribes = new Map<BackendId, () => void>();
  private readonly listeners = new Set<(s: ModuleStatus) => void>();
  /** The last status each backend reported, so a switch back is instant. */
  private readonly statuses = new Map<BackendId, ModuleStatus>();

  constructor(private readonly make: (id: BackendId) => AbiClient) {}

  /**
   * The active backend's status, which is `idle` until that backend is started.
   *
   * Never the other backend's: a module still loading in the background must
   * not report progress over the one being waited on.
   */
  get status(): ModuleStatus {
    return this.statuses.get(this.active) ?? IDLE;
  }

  /**
   * Subscribes to the *active* backend's status, calling `listener` at once
   * with it. Fires again when the active backend changes, so a switch reports
   * the new backend's state rather than leaving the old one's on screen.
   */
  onStatus(listener: (s: ModuleStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private announce(): void {
    for (const l of this.listeners) l(this.status);
  }

  /**
   * Route the questions that follow to `lang`'s backend.
   *
   * This does *not* start it. Downloading is the gate's decision (issue #1),
   * and on a metered connection the user has to opt in first; `start` is how
   * that opt-in arrives.
   */
  select(lang: Language): void {
    const id = backendFor(lang);
    if (id === this.active) return;
    this.active = id;
    this.announce();
  }

  /** Which backend the questions currently go to. */
  get selected(): BackendId {
    return this.active;
  }

  /**
   * Begins loading the active backend's module.
   *
   * Idempotent, and resolves when that module is ready. Starts nothing else:
   * the other language's module stays undownloaded until something asks it a
   * question.
   */
  start(): Promise<void> {
    return this.client(this.active).start();
  }

  private client(id: BackendId): AbiClient {
    let client = this.clients.get(id);
    if (!client) {
      client = this.make(id);
      this.clients.set(id, client);
      this.unsubscribes.set(
        id,
        client.onStatus((s) => {
          this.statuses.set(id, s);
          // A backend that is no longer selected still finishes loading; it
          // just does so quietly, so its progress cannot overwrite the bar of
          // the one being waited on.
          if (id === this.active) this.announce();
        }),
      );
    }
    return client;
  }

  // ------------------------------------------------------------ AbiModule --

  /**
   * Answers `request` with the backend for its language, starting that backend
   * if this is the first thing to need it. Routing is by `request.lang` alone,
   * not by what is selected, so a stale in-flight query cannot be answered by
   * the wrong compiler.
   */
  query(request: Parameters<AbiModule['query']>[0]): Promise<WireResponse> {
    return this.client(backendFor(request.lang ?? 'c')).query(request);
  }

  /** The active backend's targets, starting it if nothing has yet. */
  targets(): Promise<string[]> {
    return this.client(this.active).targets();
  }

  /** The active backend's version, starting it if nothing has yet. */
  version(): Promise<string> {
    return this.client(this.active).version();
  }

  /**
   * Disposes every backend that was started, and forgets them all.
   *
   * The remembered statuses go too: they describe workers that no longer
   * exist, and leaving them would have `status` report a module ready to
   * answer when there is nothing left to ask.
   */
  dispose(): void {
    for (const off of this.unsubscribes.values()) off();
    this.unsubscribes.clear();
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.statuses.clear();
    this.announce();
  }
}
