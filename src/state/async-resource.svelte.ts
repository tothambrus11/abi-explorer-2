// A reactive async resource: re-runs an async function when its input changes,
// with debounce, dedup-by-key, and cancellation of the superseded run. The
// tricky orchestration lives here (one tested unit) so callers only describe
// *what* to run and *from which inputs*; `value`/`status`/`error` are reactive.
//
// The runner itself is plain imperative logic (timers, AbortController, dedup)
// so it can be unit-tested without a reactive context; callers trigger it from
// an `$effect` over whatever inputs they track.

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

  /**
   * Request a run for `input`. Deduped by key, debounced, and cancelling.
   * `force` re-runs even when the input is unchanged and skips the debounce
   * (for an explicit "run now").
   */
  trigger(input: I, opts: { force?: boolean } = {}): void {
    const key = this.key(input);
    if (!opts.force && key === this.lastKey) return;
    const prev = this.lastInput;
    this.lastKey = key;
    this.lastInput = input;
    const d = this.opts.debounce ?? 0;
    const delay = opts.force ? 0 : typeof d === 'function' ? d(input, prev) : d;
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
