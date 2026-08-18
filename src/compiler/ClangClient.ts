// Main-thread client for the clang worker: typed RPC, request ids, per-job
// timeout, cancellation (late results are dropped), and respawning of the
// worker when a job times out or the worker crashes (a wasm trap or runaway
// compile).

import { parseResponse } from './protocol';
import {
  CompileCancelled,
  CompileTimeout,
  type CompileJob,
  type CompileOutput,
  type Compiler,
  type CompilerStatus,
} from './Compiler';

export interface ClangClientOptions {
  /** Creates a fresh worker; injected so tests can supply a fake. */
  createWorker: () => Worker;
  /** Per-compile timeout (ms). */
  timeoutMs?: number;
  /** How many times to respawn after a crash/timeout before giving up. */
  maxRestarts?: number;
}

interface Pending {
  resolve: (r: CompileOutput) => void;
  reject: (e: Error) => void;
  /** Per-job timeout; (re)armed whenever the job is posted to a live worker. */
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  job: CompileJob;
}

export class ClangClient implements Compiler {
  status: CompilerStatus = { state: 'idle' };

  private worker: Worker | null = null;
  private listeners = new Set<(s: CompilerStatus) => void>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private restarts = 0;
  /** Set once the first worker reported ready; distinguishes load failures from crashes. */
  private everReady = false;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;

  constructor(private readonly opts: ClangClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRestarts = opts.maxRestarts ?? 2;
  }

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
    this.spawn();
    return this.readyPromise;
  }

  private spawn(): void {
    this.worker?.terminate();
    this.worker = this.opts.createWorker();
    this.worker.onmessage = (ev: MessageEvent<unknown>) => {
      this.onMessage(ev.data);
    };
    this.worker.onerror = (ev) => {
      this.onCrash(`worker error: ${ev.message || 'unknown'}`);
    };
    if (this.status.state !== 'restarting') {
      this.setStatus({ state: 'loading', phase: 'download', done: 0, total: 0 });
    }
    this.worker.postMessage({ type: 'init' });
  }

  private onMessage(data: unknown): void {
    const msg = parseResponse(data);
    if (!msg) return;
    switch (msg.type) {
      case 'progress':
        // While restarting, stay 'restarting' (a reload is not an initial load).
        if (this.status.state === 'idle' || this.status.state === 'loading') {
          this.setStatus({ state: 'loading', phase: msg.phase, done: msg.done, total: msg.total });
        }
        break;
      case 'ready':
        this.everReady = true;
        this.setStatus({ state: 'ready', version: msg.version });
        this.readyResolve?.();
        // (Re-)submit jobs queued while no worker was ready.
        for (const [id, p] of this.pending) this.post(id, p);
        break;
      case 'result':
        this.restarts = 0; // a completed compile proves the worker is healthy again
        this.settle(msg.id, (p) => {
          p.resolve({ code: msg.code, stdout: msg.stdout, stderr: msg.stderr });
        });
        break;
      case 'error':
        if (msg.id !== undefined) {
          this.settle(msg.id, (p) => {
            p.reject(new Error(msg.message));
          });
        } else {
          this.onCrash(msg.message);
        }
        break;
    }
  }

  /** Take a job out of `pending` (detaching its timer and abort listener) and hand it to `fn`. */
  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return; // cancelled or timed out earlier
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (p.onAbort) p.job.signal?.removeEventListener('abort', p.onAbort);
    fn(p);
  }

  private rejectAll(err: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, (p) => {
        p.reject(err);
      });
    }
  }

  private onCrash(reason: string): void {
    if (this.disposed) return;
    if (!this.everReady) {
      // Failed during initial load: nothing to retry against.
      this.setStatus({ state: 'failed', message: reason });
      this.readyReject?.(new Error(reason));
      this.rejectAll(new Error(reason));
      return;
    }
    if (this.restarts >= this.maxRestarts) {
      this.setStatus({ state: 'failed', message: `compiler crashed repeatedly (${reason})` });
      this.rejectAll(new Error(reason));
      return;
    }
    this.restarts++;
    this.setStatus({ state: 'restarting', reason });
    // Pending jobs are re-posted (and their timeouts re-armed) on 'ready';
    // stop their clocks while the worker reloads.
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
    }
    this.spawn();
  }

  private post(id: number, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.settle(id, (q) => {
        q.reject(new CompileTimeout(this.timeoutMs));
      });
      // The wasm instance is stuck in this job: restart it.
      this.onCrash('compile timeout');
    }, this.timeoutMs);
    this.worker?.postMessage({
      type: 'compile',
      id,
      argv0: p.job.argv0,
      args: p.job.args,
      files: p.job.files,
    });
  }

  compile(job: CompileJob): Promise<CompileOutput> {
    if (this.disposed) return Promise.reject(new Error('compiler disposed'));
    if (job.signal?.aborted) return Promise.reject(new CompileCancelled());
    return this.start().then(
      () =>
        new Promise<CompileOutput>((resolve, reject) => {
          if (job.signal?.aborted) {
            reject(new CompileCancelled());
            return;
          }
          if (this.status.state === 'failed') {
            reject(new Error(this.status.message));
            return;
          }
          const id = this.nextId++;
          const p: Pending = { resolve, reject, timer: null, onAbort: null, job };
          this.pending.set(id, p);
          if (job.signal) {
            p.onAbort = () => {
              this.worker?.postMessage({ type: 'cancel', id }); // skip it if still queued in the worker
              this.settle(id, (q) => {
                q.reject(new CompileCancelled());
              });
            };
            job.signal.addEventListener('abort', p.onAbort, { once: true });
          }
          if (this.status.state === 'ready') this.post(id, p);
          // else: posted (with the timeout armed) when the worker reports ready
        }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.rejectAll(new Error('compiler disposed'));
  }
}
