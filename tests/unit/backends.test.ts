// Which compiler answers, and which one is left undownloaded.
//
// The whole point of the router is that selecting a language does not cost a
// visitor the other language's module: clang is 11 MB and Hylo is 20 MB, and
// loading both to use one is the bug this exists to prevent. So the tests are
// mostly about what does *not* happen.

import { describe, it, expect, vi } from 'vitest';
import { Backends, backendFor, type BackendId } from '$compiler/Backends';
import type { AbiClient, ModuleStatus } from '$compiler/AbiClient';

/** A client that records whether it was ever started, and nothing else. */
class FakeClient {
  started = 0;
  disposed = false;
  status: ModuleStatus = { state: 'idle' };
  private readonly listeners = new Set<(s: ModuleStatus) => void>();

  onStatus(listener: (s: ModuleStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  announce(s: ModuleStatus) {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
  start() {
    this.started++;
    return Promise.resolve();
  }
  query = vi.fn(() => Promise.resolve({ records: [] } as never));
  targets = vi.fn(() => Promise.resolve(['x86_64-unknown-linux-gnu']));
  version = vi.fn(() => Promise.resolve('v'));
  dispose() {
    this.disposed = true;
  }
}

function setup() {
  const made = new Map<BackendId, FakeClient>();
  const backends = new Backends((id) => {
    const client = new FakeClient();
    made.set(id, client);
    return client as unknown as AbiClient;
  });
  return { backends, made };
}

describe('backendFor', () => {
  it('sends Hylo to Hylo and everything else to clang', () => {
    expect(backendFor('hylo')).toBe('hylo');
    expect(backendFor('c')).toBe('clang');
    expect(backendFor('c++')).toBe('clang');
  });
});

describe('Backends', () => {
  it('creates no client until one is needed', () => {
    const { made } = setup();
    expect(made.size).toBe(0);
  });

  it('starts only the selected backend', async () => {
    const { backends, made } = setup();
    await backends.start();
    expect(made.get('clang')?.started).toBe(1);
    expect(made.has('hylo')).toBe(false);
  });

  it('does not download the other module when the language changes', async () => {
    const { backends, made } = setup();
    await backends.start();
    backends.select('hylo');
    // Selecting is not starting: the gate decides whether the download may
    // begin, and on a metered connection it has to ask first.
    expect(made.has('hylo')).toBe(false);
    await backends.start();
    expect(made.get('hylo')?.started).toBe(1);
    // clang was not started a second time, and was not disposed either: going
    // back to C must not re-download it.
    expect(made.get('clang')?.started).toBe(1);
    expect(made.get('clang')?.disposed).toBe(false);
  });

  it('routes a query by the language it asks about', async () => {
    const { backends, made } = setup();
    await backends.query({ source: 'struct S {};', triple: 'x86_64-unknown-linux-gnu', lang: 'c' });
    expect(made.get('clang')?.query).toHaveBeenCalledOnce();
    expect(made.has('hylo')).toBe(false);

    await backends.query({ source: 'public struct S {}', triple: 'hylo', lang: 'hylo' });
    expect(made.get('hylo')?.query).toHaveBeenCalledOnce();
    expect(made.get('clang')?.query).toHaveBeenCalledOnce();
  });

  it('reports the selected backend’s status, and switches with it', async () => {
    const { backends, made } = setup();
    const seen: ModuleStatus[] = [];
    backends.onStatus((s) => seen.push(s));
    expect(seen).toEqual([{ state: 'idle' }]);

    await backends.start();
    made.get('clang')!.announce({ state: 'ready', version: 'clang' });
    expect(backends.status).toEqual({ state: 'ready', version: 'clang' });

    // Selecting a backend that has not loaded reports idle rather than the
    // other one's readiness, which is what stops the app querying too early.
    backends.select('hylo');
    expect(backends.status).toEqual({ state: 'idle' });
    await backends.start();
    made.get('hylo')!.announce({ state: 'loading', phase: 'download', done: 1, total: 2 });
    expect(backends.status).toEqual({ state: 'loading', phase: 'download', done: 1, total: 2 });

    // Going back finds clang exactly as it was left, with no reload.
    backends.select('c');
    expect(backends.status).toEqual({ state: 'ready', version: 'clang' });
    expect(made.get('clang')?.started).toBe(1);
  });

  it('does not let a background backend’s progress overwrite the bar', async () => {
    const { backends, made } = setup();
    await backends.start();
    backends.select('hylo');
    await backends.start();

    const seen: ModuleStatus[] = [];
    backends.onStatus((s) => seen.push(s));
    seen.length = 0;

    // clang finishes loading while Hylo is the one being waited on.
    made.get('clang')!.announce({ state: 'ready', version: 'clang' });
    expect(seen).toEqual([]);
  });

  it('reports every backend by name, and starts one by name', async () => {
    // A session holding a C source and a Hylo source waits on both modules and
    // shows each source its own; the active backend's status is not enough.
    const { backends, made } = setup();
    const seen: string[] = [];
    backends.onAnyStatus((id, s) => seen.push(`${id}:${s.state}`));
    await backends.start('hylo');
    expect(made.get('hylo')?.started).toBe(1);
    expect(made.has('clang'), 'clang stays undownloaded').toBe(false);
    made.get('hylo')!.announce({ state: 'ready', version: 'hc' });
    expect(seen).toEqual(['hylo:idle', 'hylo:ready']);
    // Hylo was never selected, so the bar it would report to is clang's.
    expect(backends.status).toEqual({ state: 'idle' });
  });

  it('disposes every client it made', async () => {
    const { backends, made } = setup();
    await backends.start();
    backends.select('hylo');
    await backends.start();
    backends.dispose();
    expect([...made.values()].every((c) => c.disposed)).toBe(true);
  });
});
