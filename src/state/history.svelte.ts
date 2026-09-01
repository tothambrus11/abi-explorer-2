// Undo and redo over everything that decides the answer.
//
// The editor has an undo stack of its own, and it is the wrong one: it knows
// about text and nothing about the target you just switched, so a page where
// changing an option is one of the two ways to change the answer has half its
// history in the editor and half of it nowhere. This keeps one stack over the
// pair that actually forms a question — the source and the options — so that
// undo means "put back what I was looking at" rather than "put back the
// characters".
//
// The cost is that text undo is per pause rather than per keystroke: a burst
// of typing coalesces into one step. That is the trade for having the options
// in the same history, and it is why `COALESCE_MS` is short.
//
// Nothing here is persisted. A reload starts from the URL, which carries the
// state but not how it was arrived at, and an undo across a reload would put
// back something the user has no memory of doing.

import type { CompileOptions } from '$core/options';

/** A state worth being able to return to. */
export interface Snapshot {
  source: string;
  options: CompileOptions;
}

/** Two snapshots differ if either half does. */
function same(a: Snapshot, b: Snapshot): boolean {
  return a.source === b.source && JSON.stringify(a.options) === JSON.stringify(b.options);
}

const clone = (s: Snapshot): Snapshot => ({ source: s.source, options: { ...s.options } });

/** How long a run of edits stays one undo step. */
const COALESCE_MS = 600;

export class History {
  /** States before the present, oldest first. */
  private past: Snapshot[] = $state.raw([]);
  /** States undone out of, most recently undone first. */
  private future: Snapshot[] = $state.raw([]);
  private present: Snapshot;
  /** When the present was recorded, for coalescing a run of typing. */
  private recordedAt = 0;

  /**
   * Set while a snapshot is being put back, so the effect that watches the
   * store does not record the restoration as a new step.
   */
  applying = false;

  constructor(initial: Snapshot) {
    this.present = clone(initial);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Note that the state is now `next`.
   *
   * A change to the source alone within `COALESCE_MS` of the last one replaces
   * the present rather than pushing it, so that typing a word is one step. A
   * change to the options never coalesces: it is a deliberate act, and the
   * state before it is one a user will want back.
   */
  record(next: Snapshot, now = Date.now()): void {
    if (this.applying || same(next, this.present)) return;

    const optionsChanged = JSON.stringify(next.options) !== JSON.stringify(this.present.options);
    const coalesce = !optionsChanged && now - this.recordedAt < COALESCE_MS;
    if (!coalesce) this.past = [...this.past, this.present];
    // A new act abandons whatever was undone out of: the future it belonged to
    // is not reachable from here any more.
    this.future = [];
    this.present = clone(next);
    this.recordedAt = now;
  }

  /** The state before the present, or `null` if there is none. */
  undo(): Snapshot | null {
    const previous = this.past.at(-1);
    if (!previous) return null;
    this.past = this.past.slice(0, -1);
    this.future = [this.present, ...this.future];
    this.present = previous;
    // A restored state is not a run of typing to be appended to.
    this.recordedAt = 0;
    return clone(previous);
  }

  /** The state undone out of most recently, or `null` if there is none. */
  redo(): Snapshot | null {
    const next = this.future[0];
    if (!next) return null;
    this.future = this.future.slice(1);
    this.past = [...this.past, this.present];
    this.present = next;
    this.recordedAt = 0;
    return clone(next);
  }

  /**
   * Forget everything and start again from `s`.
   *
   * Used when the state arrives from outside rather than from an edit, such as
   * restoring a shared link: there is no history behind it to return to.
   */
  reset(s: Snapshot): void {
    this.past = [];
    this.future = [];
    this.present = clone(s);
    this.recordedAt = 0;
  }
}

/** Does this key event mean undo, redo, or neither? */
export function historyIntent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): 'undo' | 'redo' | null {
  // The platform modifier: ⌘ on a Mac, Ctrl elsewhere. Accepting either costs
  // nothing and spares a browser-sniff that would be wrong on a Mac with an
  // external PC keyboard.
  if (!e.ctrlKey && !e.metaKey) return null;
  const key = e.key.toLowerCase();
  // Ctrl+Y is redo on Windows, where Ctrl+Shift+Z is not universal.
  if (key === 'y' && !e.shiftKey) return 'redo';
  if (key !== 'z') return null;
  return e.shiftKey ? 'redo' : 'undo';
}
