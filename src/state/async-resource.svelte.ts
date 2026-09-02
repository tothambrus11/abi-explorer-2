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

/**
 * One in-flight asynchronous computation, driven by inputs that keep changing.
 *
 * Holds the last successful value across a later failure, so the views keep
 * showing the last good answer instead of blanking while a broken source is
 * being typed. At most one run is in flight: a newer input aborts the older,
 * and identical inputs share the one already running.
 */
export class AsyncRunner<I, T> {
  /** Last successful result (kept across a later error). */
  value = $state.raw<T | null>(null);
  /** Where the latest run got to. `value` may hold an older success meanwhile. */
  status = $state<ResourceStatus>('idle');
  /** Why the latest run failed, if it did. Cleared by the next success. */
  error = $state.raw<unknown>(null);

  private lastKey: string | null = null;
  private lastInput: I | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ac: AbortController | null = null;
  private readonly key: (input: I) => string;

  /**
   * A resource computed by `run`, which is given an `AbortSignal` and should
   * stop when it fires.
   *
   * `opts.key` decides what counts as the same input, and defaults to its JSON,
   * so an input carrying anything JSON cannot see needs its own key.
   */
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

  /**
   * Runs for `input`, after aborting whatever was running.
   *
   * A run that was aborted writes nothing: the state belongs to the newest run,
   * so a slow answer overtaken by a fast one cannot land on top of it. Never
   * throws; a failure becomes `status` and `error`.
   */
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
  /**
   * Cancels anything pending or in flight and stops the runner.
   *
   * Idempotent, and safe to call from a component teardown: no callback fires
   * afterwards, so a run cannot write to state a destroyed view still holds.
   */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ac?.abort();
  }
}
