import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncRunner } from '$state/async-resource.svelte';

/** A promise whose resolution we control from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs after the debounce and exposes the value + ok status', async () => {
    const run = vi.fn((n: number) => Promise.resolve(`v${n}`));
    const r = new AsyncRunner(run, { debounce: 100, key: (n: number) => String(n) });

    r.trigger(1);
    expect(run).not.toHaveBeenCalled();
    expect(r.status).toBe('idle');

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.value).toBe('v1');
    expect(r.status).toBe('ok');
  });

  it('sets running while in flight', async () => {
    const d = deferred<string>();
    const run = vi.fn(() => d.promise);
    const r = new AsyncRunner(run, { debounce: 0, key: (n: number) => String(n) });

    r.trigger(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.status).toBe('running');
    d.resolve('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.status).toBe('ok');
    expect(r.value).toBe('done');
  });

  it('dedups identical keys: the same input never re-runs', async () => {
    const run = vi.fn((n: number) => Promise.resolve(n));
    const r = new AsyncRunner(run, { debounce: 10, key: (n: number) => String(n) });

    r.trigger(1);
    await vi.advanceTimersByTimeAsync(10);
    r.trigger(1); // same key
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid triggers within the debounce window', async () => {
    const run = vi.fn((n: number) => Promise.resolve(n));
    const r = new AsyncRunner(run, { debounce: 100, key: (n: number) => String(n) });

    r.trigger(1);
    await vi.advanceTimersByTimeAsync(40);
    r.trigger(2);
    await vi.advanceTimersByTimeAsync(40);
    r.trigger(3);
    await vi.advanceTimersByTimeAsync(100);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(3, expect.anything());
    expect(r.value).toBe(3);
  });

  it('cancels an in-flight run when a newer input arrives; the stale result is dropped', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const run = vi
      .fn<(n: number, s: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);
    const r = new AsyncRunner(run, { debounce: 0, key: (n: number) => String(n) });

    r.trigger(1);
    await vi.advanceTimersByTimeAsync(0); // run(1) in flight
    r.trigger(2);
    await vi.advanceTimersByTimeAsync(0); // run(1) aborted, run(2) in flight

    // The first signal is aborted.
    expect(run.mock.calls[0]![1].aborted).toBe(true);

    d1.resolve('one'); // late resolution of the aborted run
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeNull(); // dropped

    d2.resolve('two');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe('two');
  });

  it('reports errors without clobbering the last good value', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const run = vi
      .fn<(n: number) => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);
    const r = new AsyncRunner(run, { debounce: 0, key: (n: number) => String(n) });

    r.trigger(1);
    await vi.advanceTimersByTimeAsync(0);
    d1.resolve('good');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe('good');

    r.trigger(2);
    await vi.advanceTimersByTimeAsync(0);
    d2.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.status).toBe('error');
    expect((r.error as Error).message).toBe('boom');
    expect(r.value).toBe('good'); // preserved
  });

  it('supports a per-input debounce function (immediate vs delayed)', async () => {
    const run = vi.fn((i: { a: number; slow: boolean }) => Promise.resolve(i.a));
    const r = new AsyncRunner(run, {
      debounce: (i: { a: number; slow: boolean }) => (i.slow ? 500 : 0),
      key: (i: { a: number; slow: boolean }) => `${i.a}`,
    });

    r.trigger({ a: 1, slow: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1); // immediate

    r.trigger({ a: 2, slow: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1); // still waiting
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('dispose() cancels a pending run and aborts an in-flight one', async () => {
    const d = deferred<string>();
    const run = vi.fn<(n: number, s: AbortSignal) => Promise<string>>(() => d.promise);
    const r = new AsyncRunner(run, { debounce: 100, key: (n: number) => String(n) });

    r.trigger(1);
    r.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled(); // pending timer cleared

    // In-flight abort:
    const r2 = new AsyncRunner(run, { debounce: 0, key: (n: number) => String(n) });
    r2.trigger(9);
    await vi.advanceTimersByTimeAsync(0);
    r2.dispose();
    expect(run.mock.calls.at(-1)![1].aborted).toBe(true);
  });
});
