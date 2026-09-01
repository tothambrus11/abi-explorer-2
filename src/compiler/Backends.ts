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
    home: 'https://hylo-lang.org/',
    module: { name: 'hylo-abi-wasm', url: 'https://github.com/tothambrus11/hylo-abi-wasm' },
    declarations: 'struct or enum declarations',
    headers: false,
  },
};

/** How to describe whichever compiler answers for `lang`. */
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

  /** The active backend's status; `idle` before it has been started. */
  get status(): ModuleStatus {
    return this.statuses.get(this.active) ?? IDLE;
  }

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

  /** Begin loading the active backend's module, if it is not already. */
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

  query(request: Parameters<AbiModule['query']>[0]): Promise<WireResponse> {
    return this.client(backendFor(request.lang ?? 'c')).query(request);
  }

  targets(): Promise<string[]> {
    return this.client(this.active).targets();
  }

  version(): Promise<string> {
    return this.client(this.active).version();
  }

  dispose(): void {
    for (const off of this.unsubscribes.values()) off();
    this.unsubscribes.clear();
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}
