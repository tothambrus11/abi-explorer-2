// The worker the engine runs in, so the language server keeps answering hovers
// from its cache while a translation unit is being parsed.
//
// Protocol: one `start` message carrying `EngineWorkerData` via `workerData`,
// then `{id, request}` in and `{id, response}` or `{id, error}` out. After an
// engine trap the module's state is undefined, so the worker exits and the
// client starts a fresh one.

import { parentPort, workerData } from 'node:worker_threads';
import { loadEngine } from './engine.ts';
import type { EngineFiles } from './engineFiles.ts';
import type { Mount } from './pathMap.ts';
import type { EngineRequest, EngineResponse } from './wire.ts';

export interface EngineWorkerData {
  files: EngineFiles;
  mounts: Mount[];
}

export type WorkerRequest = { id: number; request: EngineRequest };
export type WorkerReply =
  | { kind: 'ready'; clangVersion: string }
  | { kind: 'response'; id: number; response: EngineResponse }
  | { kind: 'error'; id: number | null; message: string };

const port = parentPort!;
const { files, mounts } = workerData as EngineWorkerData;
const post = (reply: WorkerReply) => port.postMessage(reply);

try {
  const engine = await loadEngine(files, mounts);
  post({ kind: 'ready', clangVersion: engine.clangVersion });
  port.on('message', ({ id, request }: WorkerRequest) => {
    try {
      post({ kind: 'response', id, response: engine.query(request) });
    } catch (error) {
      post({ kind: 'error', id, message: String(error) });
      process.exit(1);
    }
  });
} catch (error) {
  post({ kind: 'error', id: null, message: `the engine did not load: ${String(error)}` });
  process.exit(1);
}
