import { describe, expect, it } from 'vitest';
import { EngineClient } from '../../src/engine/engineClient.ts';
import type { EngineFiles } from '../../src/engine/engineFiles.ts';
import type { EngineRequest } from '../../src/engine/engineTypes.ts';

/** Answers each request with its own thread id, and the memory its first flag names. */
const FAKE_WORKER = `
import { parentPort, threadId } from 'node:worker_threads';
parentPort.postMessage({ kind: 'ready', clangVersion: 'fake' });
parentPort.on('message', ({ id, request }) => {
  const response = { ok: true, clangVersion: String(threadId) };
  parentPort.postMessage({ kind: 'response', id, response, memoryBytes: Number(request.flags[0]) });
});`;
const fakeWorker = new URL(`data:text/javascript,${encodeURIComponent(FAKE_WORKER)}`);

/** Which worker answered a query reporting `memoryBytes` afterwards. */
async function workerFor(client: EngineClient, memoryBytes: number): Promise<string> {
  const request = { flags: [String(memoryBytes)] } as unknown as EngineRequest;
  return (await client.query(request)).clangVersion;
}

describe('EngineClient', () => {
  it('replaces a worker whose memory has grown too large, once it is idle', async () => {
    const client = new EngineClient(fakeWorker, async () => ({}) as EngineFiles, []);
    try {
      const first = await workerFor(client, 0);
      expect(await workerFor(client, 2 ** 30 + 1)).toBe(first);
      const second = await workerFor(client, 0);
      expect(second).not.toBe(first);
      expect(await workerFor(client, 0)).toBe(second);
    } finally {
      client.dispose();
    }
  });
});
