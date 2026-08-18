// A reactive async resource: re-runs an async function when its input changes,
// with debounce, dedup-by-key, and cancellation of the superseded run. The
// tricky orchestration lives here (one tested unit) so callers only describe
// *what* to run and *from which inputs*; `value`/`status`/`error` are reactive.
//
// Split in two:
//   - `AsyncRunner`  — pure imperative logic (timers, AbortController, dedup),
//                      unit-tested without any reactive context.
//   - `bindResource` — the one-line reactive glue: re-trigger on input change.

export type ResourceStatus = 'idle' | 'running' | 'ok' | 'error';

export interface AsyncRunnerOptions<I> {
  /** Milliseconds to wait before running, or a per-input function of it. */
  debounce?: number | ((input: I, prev: I | undefined) => number);
  /** Identity of an input: identical keys never re-run (skips redundant work). */
  key?: (input: I) => string;
}

export class AsyncRunner<I, T> {
  /** Last successful result (kept across a later error). */
  value = $state.raw<T | null>(null);
  status = $state<ResourceStatus>('idle');
  error = $state.raw<unknown>(null);

  private lastKey: string | null = null;
  private lastInput: I | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ac: AbortController | null = null;
  private readonly key: (input: I) => string;

  constructor(
    private readonly run: (input: I, signal: AbortSignal) => Promise<T>,
    private readonly opts: AsyncRunnerOptions<I> = {},
  ) {
    this.key = opts.key ?? ((i) => JSON.stringify(i));
  }

  /** Request a run for `input`. Deduped by key, debounced, and cancelling. */
  trigger(input: I): void {
    const key = this.key(input);
    if (key === this.lastKey) return;
    const prev = this.lastInput;
    this.lastKey = key;
    this.lastInput = input;
    const d = this.opts.debounce ?? 0;
    const delay = typeof d === 'function' ? d(input, prev) : d;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.execute(input);
    }, delay);
  }

  private async execute(input: I): Promise<void> {
    this.ac?.abort();
    const ac = new AbortController();
    this.ac = ac;
    this.status = 'running';
    try {
      const v = await this.run(input, ac.signal);
      if (ac.signal.aborted) return;
      this.value = v;
      this.error = null;
      this.status = 'ok';
    } catch (e) {
      if (ac.signal.aborted) return;
      this.error = e;
      this.status = 'error';
    }
  }

  /** Cancel any pending or in-flight run. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ac?.abort();
  }
}

/**
 * Reactively drive a runner from `inputs()`: whenever the tracked reactive
 * reads inside `inputs` change, the runner is re-triggered. Must be called in a
 * reactive context (a component or an `$effect.root`). The runner owns its own
 * lifecycle; call `runner.dispose()` when tearing down the surrounding root.
 */
export function bindResource<I, T>(inputs: () => I, runner: AsyncRunner<I, T>): void {
  $effect(() => {
    runner.trigger(inputs());
  });
}
