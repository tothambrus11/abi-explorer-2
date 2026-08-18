import { describe, it, expect, vi } from 'vitest';
import { ClangClient } from '$compiler/ClangClient';
import { CompileCancelled, CompileTimeout } from '$compiler/Compiler';

/** A fake worker with a scriptable behaviour. */
class FakeWorker implements Worker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onmessageerror = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  static behaviour: (w: FakeWorker, msg: { type: string; id?: number }) => void = () => {};
  postMessage(msg: { type: string; id?: number }) {
    queueMicrotask(() => {
      FakeWorker.behaviour(this, msg);
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

const spawnCounting = () => {
  const workers: FakeWorker[] = [];
  const createWorker = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  return { workers, createWorker };
};

describe('ClangClient', () => {
  it('starts, compiles, cancels', async () => {
    const { createWorker } = spawnCounting();
    FakeWorker.behaviour = (w, msg) => {
      if (msg.type === 'init') w.reply({ type: 'ready', version: 'clang test' });
      if (msg.type === 'compile') {
        setTimeout(() => {
          w.reply({ type: 'result', id: msg.id, code: 0, stdout: 'ok', stderr: '' });
        }, 5);
      }
    };
    const c = new ClangClient({ createWorker, timeoutMs: 1000 });
    const out = await c.compile({ argv0: 'clang', args: [], files: {} });
    expect(out.stdout).toBe('ok');
    expect(c.status).toEqual({ state: 'ready', version: 'clang test' });
    const ac = new AbortController();
    const p = c.compile({ argv0: 'clang', args: [], files: {}, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CompileCancelled);
    c.dispose();
  });

  it('times out a stuck compile, respawns the worker and re-posts pending jobs', async () => {
    vi.useFakeTimers();
    const { workers, createWorker } = spawnCounting();
    let hang = true;
    FakeWorker.behaviour = (w, msg) => {
      if (msg.type === 'init') w.reply({ type: 'ready', version: 'v' });
      if (msg.type === 'compile' && !hang) {
        w.reply({ type: 'result', id: msg.id, code: 0, stdout: 'later', stderr: '' });
      }
    };
    const c = new ClangClient({ createWorker, timeoutMs: 100, maxRestarts: 2 });
    const statuses: string[] = [];
    c.onStatus((s) => statuses.push(s.state));
    const stuck = c.compile({ argv0: 'clang', args: ['a'], files: {} });
    const stuckRejects = expect(stuck).rejects.toBeInstanceOf(CompileTimeout);
    await vi.advanceTimersByTimeAsync(50);
    hang = false; // the *next* worker will answer
    const second = c.compile({ argv0: 'clang', args: ['b'], files: {} });
    await vi.advanceTimersByTimeAsync(100);
    await stuckRejects;
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect((await second).stdout).toBe('later');
    expect(statuses).toContain('restarting');
    c.dispose();
    vi.useRealTimers();
  });

  it('rejects new compiles immediately once the compiler has failed', async () => {
    const { createWorker } = spawnCounting();
    FakeWorker.behaviour = (w, msg) => {
      if (msg.type === 'init') w.reply({ type: 'ready', version: 'v' });
      if (msg.type === 'compile') w.reply({ type: 'error', message: 'boom' });
    };
    const c = new ClangClient({ createWorker, timeoutMs: 1000, maxRestarts: 0 });
    await expect(c.compile({ argv0: 'clang', args: [], files: {} })).rejects.toThrow(/boom/);
    expect(c.status.state).toBe('failed');
    await expect(c.compile({ argv0: 'clang', args: [], files: {} })).rejects.toThrow(/boom/);
    c.dispose();
  });

  it('gives up after maxRestarts crashes', async () => {
    const { createWorker } = spawnCounting();
    FakeWorker.behaviour = (w, msg) => {
      if (msg.type === 'init') w.reply({ type: 'ready', version: 'v' });
      if (msg.type === 'compile') w.reply({ type: 'error', message: 'boom' }); // crash without id
    };
    const c = new ClangClient({ createWorker, timeoutMs: 1000, maxRestarts: 1 });
    await expect(c.compile({ argv0: 'clang', args: [], files: {} })).rejects.toThrow(/boom/);
    expect(c.status.state).toBe('failed');
    c.dispose();
  });
});
