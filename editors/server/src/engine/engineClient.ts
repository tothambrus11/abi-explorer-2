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
import type { EngineRequest, EngineResponse } from './wire.ts';

interface Pending {
  resolve(response: EngineResponse): void;
  reject(error: Error): void;
}

export class EngineClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, request } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = null;
    this.ready = null;
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
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          pending.reject(new Error('the engine stopped while answering'));
        }
        reject(new Error('the engine stopped while loading'));
      });
    });
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    return pending;
  }
}
