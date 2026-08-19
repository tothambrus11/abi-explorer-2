// Main-thread client for the clang-abi-wasm worker.
//
// It also owns the loading status the UI reports and the download gate hangs
// off, because the module *is* the compiler now: there is no driver to run, no
// argv to build and no output to parse — one request, one response.

import type { AbiModule } from './AbiAnalyzer';
import type { WireResponse } from '$core/render';

/** How far along the module's load is. The UI reports it; nothing else reads it. */
export type ModuleStatus =
  | { state: 'idle' }
  | { state: 'loading'; phase: 'download' | 'unpack' | 'compile'; done: number; total: number }
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

export class AbiClient implements AbiModule {
  status: ModuleStatus = { state: 'idle' };

  private worker: Worker | null = null;
  private readonly listeners = new Set<(s: ModuleStatus) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  constructor(private readonly opts: AbiClientOptions) {}

  onStatus(listener: (s: ModuleStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(s: ModuleStatus): void {
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
    const msg = data as {
      type?: string;
      id?: number;
      value?: unknown;
      message?: string;
      version?: string;
    };
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

  query(request: Parameters<AbiModule['query']>[0]): Promise<WireResponse> {
    return this.send<WireResponse>({ type: 'query', request });
  }

  targets(): Promise<string[]> {
    return this.send<string[]>({ type: 'targets' });
  }

  version(): Promise<string> {
    return this.send<string>({ type: 'version' });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error('module disposed'));
    }
  }
}
