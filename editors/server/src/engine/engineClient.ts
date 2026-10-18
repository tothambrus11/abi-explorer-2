// The server's handle on the engine worker.
//
// Requests are answered in order, one at a time; the analysis layer decides
// which ones are worth sending. A worker that dies (an engine trap, or a
// translation unit that exhausted the wasm heap) fails the request it was on
// and is replaced on the next one.

import { Worker } from 'node:worker_threads';
import type { EngineFiles } from './engineFiles.ts';
import type { EngineWorkerData, WorkerReply, WorkerRequest } from './engineWorker.ts';
import type { Mount } from './pathMap.ts';
import type { EngineRequest, EngineResponse } from './engineTypes.ts';

/**
 * Longer than any real translation unit takes. The clock runs from the last
 * reply, so only the query being answered counts against it, not those queued
 * behind it; past it the engine is stuck, and is restarted.
 */
const QUERY_TIMEOUT_MS = 120_000;

interface Pending {
  resolve(response: EngineResponse): void;
  reject(error: Error): void;
}

export class EngineClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private watchdog: NodeJS.Timeout | undefined;
  private readonly workerUrl: URL;
  private readonly files: () => Promise<EngineFiles>;
  private readonly mounts: readonly Mount[];

  constructor(workerUrl: URL, files: () => Promise<EngineFiles>, mounts: readonly Mount[]) {
    this.workerUrl = workerUrl;
    this.files = files;
    this.mounts = mounts;
  }

  async query(request: EngineRequest): Promise<EngineResponse> {
    await (this.ready ??= this.start());
    const id = this.nextId++;
    const worker = this.worker!;
    return new Promise<EngineResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.pending.size === 1) this.rearmWatchdog();
      worker.postMessage({ id, request } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.failPending('the server is shutting down');
    void worker?.terminate();
  }

  private async start(): Promise<void> {
    const files = await this.files().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    const data: EngineWorkerData = { files, mounts: [...this.mounts] };
    const worker = new Worker(this.workerUrl, { workerData: data });
    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (reply: WorkerReply) => {
        if (reply.kind === 'ready') resolve();
        else if (reply.kind === 'response') this.settle(reply.id)?.resolve(reply.response);
        else if (reply.id === null) reject(new Error(reply.message));
        else this.settle(reply.id)?.reject(new Error(reply.message));
      });
      worker.on('error', reject);
      worker.on('exit', () => {
        if (this.worker !== worker) return;
        this.worker = null;
        this.ready = null;
        this.failPending('the engine stopped while answering');
        reject(new Error('the engine stopped while loading'));
      });
    });
  }

  /** Restarts the clock for the query now being answered, or stops it when none is left. */
  private rearmWatchdog(): void {
    clearTimeout(this.watchdog);
    if (this.pending.size === 0) return;
    const worker = this.worker;
    // The exit handler fails the stuck query and every one queued behind it.
    this.watchdog = setTimeout(() => void worker?.terminate(), QUERY_TIMEOUT_MS).unref();
  }

  private failPending(message: string): void {
    clearTimeout(this.watchdog);
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    this.rearmWatchdog();
    return pending;
  }
}
