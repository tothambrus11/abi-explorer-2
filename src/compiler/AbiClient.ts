// Main-thread client for the clang-abi-wasm worker.
//
// It also owns the loading status the UI reports and the download gate hangs
// off, because the module *is* the compiler now: there is no driver to run, no
// argv to build and no output to parse. One request, one response.

import type { AbiModule } from './AbiAnalyzer';
import type { WireResponse } from '$core/render';

/** How far along the module's load is. The UI reports it; nothing else reads it. */
export type ModuleStatus =
  | { state: 'idle' }
  /** `total` is 0 when the size is not known, so show an indeterminate bar. */
  | { state: 'loading'; phase: 'download' | 'compile'; done: number; total: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; message: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface AbiClientOptions {
  /** Creates the worker; injected so tests can supply a fake. */
  createWorker: () => Worker;
}

/**
 * One module, in a worker, behind the `AbiModule` interface.
 *
 * Owns the load: the worker is created on the first `start` and never
 * recreated, so every caller shares one download and one wasm instance. A
 * failure is terminal for this client — the status stays `failed` and every
 * call rejects — because a module that could not be loaded will not load by
 * being asked again.
 */
export class AbiClient implements AbiModule {
  /** How far along the load is; `idle` until `start`. */
  status: ModuleStatus = { state: 'idle' };

  private worker: Worker | null = null;
  private readonly listeners = new Set<(s: ModuleStatus) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  /** A client for the worker `opts.createWorker` makes; nothing starts until `start`. */
  constructor(private readonly opts: AbiClientOptions) {}

  /**
   * Subscribes to the load status, calling `listener` at once with the current
   * one so a caller never has to read it separately. Returns the unsubscribe.
   */
  onStatus(listener: (s: ModuleStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /** Records the status and tells every listener, in subscription order. */
  private setStatus(s: ModuleStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  /**
   * Begins loading, and resolves when the module can answer.
   *
   * Idempotent: repeated calls share one promise and one worker. Rejects if the
   * worker fails to load, and stays rejected, since the same promise is handed
   * to everyone who asks afterwards.
   */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.setStatus({ state: 'loading', phase: 'download', done: 0, total: 0 });

    const worker = this.opts.createWorker();
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<unknown>) => {
      this.onMessage(ev.data);
    };
    worker.onerror = (ev) => {
      this.fail(`worker error: ${ev.message || 'unknown'}`);
    };
    return this.readyPromise;
  }

  /**
   * Handles one message from the worker.
   *
   * Parses defensively: the worker is a separate build, so a message with a
   * shape this version does not know is ignored rather than trusted. An error
   * without an id is the module itself failing and fails everything; an error
   * with one rejects only that request.
   */
  private onMessage(data: unknown): void {
    const msg = data as {
      type?: string;
      id?: number;
      value?: unknown;
      message?: string;
      version?: string;
      phase?: 'download' | 'compile';
      done?: number;
      total?: number;
    };
    if (msg.type === 'progress') {
      this.setStatus({
        state: 'loading',
        phase: msg.phase ?? 'download',
        done: msg.done ?? 0,
        total: msg.total ?? 0,
      });
      return;
    }
    if (msg.type === 'ready') {
      this.setStatus({ state: 'ready', version: msg.version ?? 'clang (wasm)' });
      this.readyResolve?.();
      return;
    }
    if (msg.type === 'error' && msg.id === undefined) {
      this.fail(msg.message ?? 'unknown error');
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message ?? 'unknown error'));
    else p.resolve(msg.value);
  }

  /**
   * Declares the module unusable: the status goes to failed, `start` rejects,
   * and every outstanding request rejects rather than hanging on a worker that
   * will never answer.
   */
  private fail(message: string): void {
    this.setStatus({ state: 'failed', message });
    this.readyReject?.(new Error(message));
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error(message));
    }
  }

  /**
   * Sends one request and resolves with its answer.
   *
   * Starts the module first, so a caller never has to; rejects if it fails to
   * load, or if the worker answers this request with an error. The id is added
   * here and is what pairs the answer with this promise.
   */
  private send<T>(payload: Record<string, unknown>): Promise<T> {
    return this.start().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
          this.worker?.postMessage({ ...payload, id });
        }),
    );
  }

  // ------------------------------------------------------------ AbiModule --

  query(request: Parameters<AbiModule['query']>[0]): Promise<WireResponse> {
    return this.send<WireResponse>({ type: 'query', request });
  }

  targets(): Promise<string[]> {
    return this.send<string[]>({ type: 'targets' });
  }

  version(): Promise<string> {
    return this.send<string>({ type: 'version' });
  }

  /**
   * Terminates the worker and rejects everything outstanding.
   *
   * A disposed client is not reusable: `start` would hand back the settled
   * promise it already holds. Nothing rejects silently, so no caller is left
   * waiting on a worker that no longer exists.
   */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error('module disposed'));
    }
  }
}
