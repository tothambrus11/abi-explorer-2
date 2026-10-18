// Repeated work on one thing, spaced out.
//
// Some work is cheap to ask for and expensive to do, and a drag asks for it on
// every pointer move: redefining Monaco's theme replaces the whole stylesheet
// and re-tokenises every model, which shows as a flash. Doing sixty of those
// for one drag of a colour slider is the difference between a flicker and a
// strobe.
//
// So: work on a thing different from the last one is done at once, because a
// theme tried on from a list has to appear immediately; work on the *same*
// thing waits out a gap, so a drag applies a few times rather than sixty, the
// last value always among them; and work that would produce what is already
// there is not done at all.
//
// Whatever is waiting is dropped the moment anything new is asked for -- the
// case that is easy to get wrong being the third one, where nothing is to be
// done: an armed application of a value the drag has already left is still
// stale, and letting it fire paints a colour the pointer is no longer on.

/** The clock and timers, so a test can drive them. */
export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface Spaced<T> {
  /**
   * Ask for `value` to be applied.
   *
   * `key` is the thing being worked on and `data` the state of it: two asks
   * with the same pair want the same outcome, however different the values
   * are to look at.
   */
  want(key: string, data: string, value: T): void;
  /** Drop anything waiting, and forget what was last applied. */
  reset(): void;
}

/**
 * A `want` that applies at most once per `gapMs` for as long as it is asked
 * about one key, and at once when the key changes.
 */
export function spaced<T>(
  gapMs: number,
  apply: (value: T) => void,
  timers: Timers = REAL_TIMERS,
): Spaced<T> {
  let applied: { key: string; data: string } | null = null;
  let appliedAt = 0;
  let handle: unknown = null;
  let pending: { key: string; data: string; value: T } | null = null;

  const applyNow = (key: string, data: string, value: T): void => {
    applied = { key, data };
    appliedAt = timers.now();
    apply(value);
  };

  const drop = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    pending = null;
  };

  return {
    want(key, data, value) {
      // Before the early return below, not after it: see the note at the top.
      drop();
      if (applied?.key === key && applied.data === data) return;
      const wait = applied?.key === key ? gapMs - (timers.now() - appliedAt) : 0;
      if (wait <= 0) {
        applyNow(key, data, value);
        return;
      }
      pending = { key, data, value };
      handle = timers.set(() => {
        handle = null;
        const next = pending;
        pending = null;
        if (next) applyNow(next.key, next.data, next.value);
      }, wait);
    },
    reset() {
      drop();
      applied = null;
      appliedAt = 0;
    },
  };
}
