// Main-thread client for the clang-abi-wasm worker.
//
// Also a `Compiler`, because that is what owns the download gate and the status
// the UI reports — the app should show "loading clang" for this module just as
// it did for the driver. The `compile` method is not implemented: nothing
// compiles a translation unit through this path any more, and a caller reaching
// for it is a bug worth surfacing rather than a case to emulate.

import type { AbiModule } from './AbiAnalyzer';
import type { AbiResponse } from './AbiAdapter';
import type { Compiler, CompileOutput, CompilerStatus } from './Compiler';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface AbiClientOptions {
  /** Creates the worker; injected so tests can supply a fake. */
  createWorker: () => Worker;
}

export class AbiClient implements Compiler, AbiModule {
  status: CompilerStatus = { state: 'idle' };

  private worker: Worker | null = null;
  private readonly listeners = new Set<(s: CompilerStatus) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  constructor(private readonly opts: AbiClientOptions) {}

  onStatus(listener: (s: CompilerStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(s: CompilerStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

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

  private onMessage(data: unknown): void {
    const msg = data as { type?: string; id?: number; value?: unknown; message?: string; version?: string };
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

  private fail(message: string): void {
    this.setStatus({ state: 'failed', message });
    this.readyReject?.(new Error(message));
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error(message));
    }
  }

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

  query(request: Parameters<AbiModule['query']>[0]): Promise<AbiResponse> {
    return this.send<AbiResponse>({ type: 'query', request });
  }

  targets(): Promise<string[]> {
    return this.send<string[]>({ type: 'targets' });
  }

  version(): Promise<string> {
    return this.send<string>({ type: 'version' });
  }

  // ------------------------------------------------------------- Compiler --

  compile(): Promise<CompileOutput> {
    return Promise.reject(
      new Error('AbiClient answers layout queries; it does not run the clang driver'),
    );
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error('compiler disposed'));
    }
  }
}
