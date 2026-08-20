// The worker protocol, without a worker.
//
// `AbiClient` is the only thing between the app and a 28 MB module living in
// another thread. What it has to get right is not layout; it is the boring
// part: request/response correlation, the load status the UI reports, and
// failing every outstanding call when the worker dies rather than leaving a
// promise that never settles.

import { describe, it, expect } from 'vitest';
import { AbiClient, type ModuleStatus } from '$compiler/AbiClient';

/** A worker whose replies are scripted per test. */
class FakeWorker implements Worker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onmessageerror = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly sent: { type: string; id?: number; request?: unknown }[] = [];
  behaviour: (w: FakeWorker, msg: { type: string; id?: number }) => void = () => {};

  postMessage(msg: { type: string; id?: number }) {
    this.sent.push(msg);
    queueMicrotask(() => {
      this.behaviour(this, msg);
    });
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
}

/** A client wired to a fake worker that is ready as soon as it is created. */
function ready(behaviour: FakeWorker['behaviour'] = () => {}) {
  const worker = new FakeWorker();
  worker.behaviour = behaviour;
  const client = new AbiClient({ createWorker: () => worker });
  const start = client.start();
  worker.reply({ type: 'ready', version: 'clang version 22.1.8' });
  return { worker, client, start };
}

describe('AbiClient', () => {
  it('reports idle, then loading, then ready', async () => {
    const seen: ModuleStatus['state'][] = [];
    const worker = new FakeWorker();
    const client = new AbiClient({ createWorker: () => worker });
    client.onStatus((s) => seen.push(s.state));
    const started = client.start();
    worker.reply({ type: 'ready', version: 'clang version 22.1.8' });
    await started;
    expect(seen).toEqual(['idle', 'loading', 'ready']);
    expect(client.status).toEqual({ state: 'ready', version: 'clang version 22.1.8' });
  });

  it('starts the worker once, however many callers ask', async () => {
    let made = 0;
    const worker = new FakeWorker();
    const client = new AbiClient({
      createWorker: () => {
        made++;
        return worker;
      },
    });
    const all = Promise.all([client.start(), client.start(), client.start()]);
    worker.reply({ type: 'ready', version: 'v' });
    await all;
    expect(made).toBe(1);
  });

  it('turns worker progress into a status the UI can show', async () => {
    const seen: ModuleStatus[] = [];
    const worker = new FakeWorker();
    const client = new AbiClient({ createWorker: () => worker });
    client.onStatus((s) => seen.push(s));
    const started = client.start();
    worker.reply({ type: 'progress', phase: 'download', done: 1_000, total: 49_000 });
    worker.reply({ type: 'progress', phase: 'download', done: 49_000, total: 49_000 });
    worker.reply({ type: 'progress', phase: 'compile', done: 0, total: 0 });
    worker.reply({ type: 'ready', version: 'v' });
    await started;
    expect(
      seen.map((s) => (s.state === 'loading' ? `${s.phase} ${s.done}/${s.total}` : s.state)),
    ).toEqual([
      'idle',
      'download 0/0', // the client's own guess, until the worker says otherwise
      'download 1000/49000',
      'download 49000/49000',
      'compile 0/0',
      'ready',
    ]);
  });

  it('answers each request with its own reply, out of order', async () => {
    // Two queries in flight: the second answers first. Correlating by id is the
    // whole reason the protocol has one.
    const pending: number[] = [];
    const { worker, client } = ready((w, msg) => {
      if (msg.type === 'query') pending.push(msg.id!);
      if (pending.length === 2) {
        w.reply({ type: 'result', id: pending[1], value: { exitCode: 2 } });
        w.reply({ type: 'result', id: pending[0], value: { exitCode: 1 } });
      }
    });
    const first = client.query({ source: 'a', triple: 't' });
    const second = client.query({ source: 'b', triple: 't' });
    expect((await first).exitCode).toBe(1);
    expect((await second).exitCode).toBe(2);
    expect(worker.sent.filter((m) => m.type === 'query')).toHaveLength(2);
  });

  it('rejects one call without disturbing the others', async () => {
    const ids: number[] = [];
    const { client } = ready((w, msg) => {
      if (msg.type !== 'query') return;
      ids.push(msg.id!);
      if (ids.length === 1) w.reply({ type: 'error', id: msg.id, message: 'out of memory' });
      else w.reply({ type: 'result', id: msg.id, value: { exitCode: 0 } });
    });
    await expect(client.query({ source: 'a', triple: 't' })).rejects.toThrow('out of memory');
    expect((await client.query({ source: 'b', triple: 't' })).exitCode).toBe(0);
  });

  it('fails every outstanding call when the worker dies', async () => {
    const { worker, client } = ready();
    const inFlight = client.query({ source: 'a', triple: 't' });
    // Give the request a microtask to reach the worker before it dies.
    await Promise.resolve();
    worker.onerror?.({ message: 'RuntimeError: memory access out of bounds' } as ErrorEvent);
    await expect(inFlight).rejects.toThrow(/memory access out of bounds/);
    expect(client.status.state).toBe('failed');
  });

  it('reports a load failure to whoever is waiting on start()', async () => {
    const worker = new FakeWorker();
    const client = new AbiClient({ createWorker: () => worker });
    const started = client.start();
    worker.reply({ type: 'error', message: 'failed to fetch abi_query.wasm' });
    await expect(started).rejects.toThrow('failed to fetch abi_query.wasm');
    expect(client.status).toEqual({
      state: 'failed',
      message: 'failed to fetch abi_query.wasm',
    });
  });

  it('drops replies to requests it does not have', async () => {
    const { worker, client } = ready((w, msg) => {
      // An id nobody is waiting for, then the real answer.
      w.reply({ type: 'result', id: 999, value: null });
      w.reply({ type: 'result', id: msg.id, value: { exitCode: 0 } });
    });
    await expect(client.query({ source: 'a', triple: 't' })).resolves.toEqual({ exitCode: 0 });
    expect(worker.terminated).toBe(false);
  });

  it('terminates the worker and fails what was in flight on dispose', async () => {
    const { worker, client } = ready();
    const inFlight = client.query({ source: 'a', triple: 't' });
    await Promise.resolve();
    client.dispose();
    await expect(inFlight).rejects.toThrow('module disposed');
    expect(worker.terminated).toBe(true);
  });
});
