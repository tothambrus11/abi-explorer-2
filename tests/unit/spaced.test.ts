// The rule `spaced` exists for, with a clock the test owns.
//
// This is the scheduling behind `setEditorTheme`: it used to live in
// `src/ui/monaco.ts`, where nothing could reach it without Monaco and a worker,
// and it was wrong in a way only a test like this one shows.

import { describe, it, expect } from 'vitest';
import { spaced, type Timers } from '$core/spaced';

/** A clock that only moves when the test says so, and timers that fire by hand. */
function fakeTimers(): Timers & { tick(ms: number): void; armed(): number } {
  let clock = 1000;
  let seq = 0;
  const waiting = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    set(fn, ms) {
      const id = ++seq;
      waiting.set(id, { at: clock + ms, fn });
      return id;
    },
    clear(handle) {
      waiting.delete(handle as number);
    },
    tick(ms) {
      clock += ms;
      for (const [id, t] of [...waiting]) {
        if (t.at <= clock) {
          waiting.delete(id);
          t.fn();
        }
      }
    },
    armed: () => waiting.size,
  };
}

function harness(gap = 70) {
  const timers = fakeTimers();
  const applied: string[] = [];
  const s = spaced<string>(gap, (v) => applied.push(v), timers);
  return { s, timers, applied };
}

describe('spaced', () => {
  it('applies the first ask at once', () => {
    const { s, applied } = harness();
    s.want('theme', 'a', 'a');
    expect(applied).toEqual(['a']);
  });

  it('applies a different key at once, however recent the last one', () => {
    const { s, timers, applied } = harness();
    s.want('one', 'a', 'a');
    timers.tick(1);
    s.want('two', 'b', 'b');
    expect(applied).toEqual(['a', 'b']);
  });

  it('makes the same key wait out the gap, and applies the last value only', () => {
    const { s, timers, applied } = harness();
    s.want('theme', 'a', 'a');
    timers.tick(10);
    s.want('theme', 'b', 'b');
    timers.tick(10);
    s.want('theme', 'c', 'c');
    // Still only the first: the run has not waited out the gap.
    expect(applied).toEqual(['a']);
    timers.tick(60);
    // And the value that lands is the last one asked for, never 'b'.
    expect(applied).toEqual(['a', 'c']);
  });

  it('does nothing for data already applied', () => {
    const { s, timers, applied } = harness();
    s.want('theme', 'a', 'a');
    timers.tick(500);
    s.want('theme', 'a', 'a');
    expect(applied).toEqual(['a']);
  });

  /**
   * The regression. A drag that moves off a colour and back onto it inside the
   * gap has an intermediate value armed when the ask for the *applied* value
   * arrives. Returning early without dropping it let it fire, painting a colour
   * the pointer had already left, and leaving `applied` on that stale value so
   * nothing corrected it until the next change.
   */
  it('drops what is waiting even when there is nothing to apply', () => {
    const { s, timers, applied } = harness();
    s.want('theme', 'a', 'a');
    timers.tick(10);
    s.want('theme', 'b', 'b'); // armed, not yet applied
    s.want('theme', 'a', 'a'); // back where we started: nothing to do
    expect(timers.armed()).toBe(0);
    timers.tick(500);
    expect(applied).toEqual(['a']);
  });

  it('drops what is waiting when a different key arrives', () => {
    const { s, timers, applied } = harness();
    s.want('one', 'a', 'a');
    timers.tick(10);
    s.want('one', 'b', 'b'); // armed
    s.want('two', 'c', 'c'); // a different thing, applied at once
    expect(timers.armed()).toBe(0);
    timers.tick(500);
    expect(applied).toEqual(['a', 'c']);
  });

  it('forgets what was applied on reset, and drops what waits', () => {
    const { s, timers, applied } = harness();
    s.want('theme', 'a', 'a');
    timers.tick(10);
    s.want('theme', 'b', 'b');
    s.reset();
    expect(timers.armed()).toBe(0);
    timers.tick(500);
    expect(applied).toEqual(['a']);
    // Reset forgot 'a', so asking for it again applies rather than skips.
    s.want('theme', 'a', 'a');
    expect(applied).toEqual(['a', 'a']);
  });
});
