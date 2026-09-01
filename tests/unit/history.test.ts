// Undo over a pair that forms one question: the source and the options.
//
// The rules worth pinning are the ones a user would notice: a run of typing is
// one step rather than one per keystroke, an option change is never swallowed
// into the run before it, and doing something new after undoing abandons what
// was undone.

import { describe, it, expect } from 'vitest';
import { History, historyIntent, type Snapshot } from '$state/history.svelte';
import { DEFAULT_OPTIONS } from '$core/options';

const at = (source: string, over: Partial<typeof DEFAULT_OPTIONS> = {}): Snapshot => ({
  source,
  options: { ...DEFAULT_OPTIONS, ...over },
});

describe('History', () => {
  it('has nothing to undo until something changes', () => {
    const h = new History(at('a'));
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it('ignores a change that changes nothing', () => {
    const h = new History(at('a'));
    h.record(at('a'), 1000);
    expect(h.canUndo).toBe(false);
  });

  it('makes a run of typing one step', () => {
    const h = new History(at(''));
    h.record(at('s'), 1000);
    h.record(at('st'), 1100);
    h.record(at('str'), 1200);
    expect(h.undo()?.source).toBe('');
    expect(h.canUndo, 'one step, not three').toBe(false);
  });

  it('starts a new step after a pause', () => {
    const h = new History(at(''));
    h.record(at('one'), 1000);
    h.record(at('one two'), 5000);
    expect(h.undo()?.source).toBe('one');
    expect(h.undo()?.source).toBe('');
  });

  it('never swallows an option change into the typing before it', () => {
    // Changing a target is deliberate, and the state before it is one to get
    // back to even if a key was pressed a moment earlier.
    const h = new History(at('x'));
    h.record(at('xy'), 1000);
    h.record(at('xy', { lang: 'c++' }), 1050);
    expect(h.undo()).toEqual(at('xy'));
    expect(h.undo()).toEqual(at('x'));
  });

  it('redoes what it undid, in order', () => {
    const h = new History(at('a'));
    h.record(at('b'), 1000);
    h.record(at('c'), 5000);
    h.undo();
    h.undo();
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.source).toBe('b');
    expect(h.redo()?.source).toBe('c');
    expect(h.canRedo).toBe(false);
  });

  it('abandons the future when something new is done', () => {
    const h = new History(at('a'));
    h.record(at('b'), 1000);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.record(at('c'), 5000);
    expect(h.canRedo, 'the undone branch is not reachable from here').toBe(false);
  });

  it('records nothing while a state is being put back', () => {
    // The store is written to during an undo, and the effect watching it would
    // otherwise record the restoration as a new state to come back to.
    const h = new History(at('a'));
    h.record(at('b'), 1000);
    h.applying = true;
    h.record(at('a'), 2000);
    h.applying = false;
    expect(h.undo()?.source).toBe('a');
    expect(h.canUndo).toBe(false);
  });

  it('forgets everything when the state arrives from outside', () => {
    const h = new History(at('a'));
    h.record(at('b'), 1000);
    h.reset(at('shared'));
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('historyIntent', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey', boolean>>) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });

  it('reads undo and redo on either platform', () => {
    expect(historyIntent(key('z', { ctrlKey: true }))).toBe('undo');
    expect(historyIntent(key('z', { metaKey: true }))).toBe('undo');
    expect(historyIntent(key('z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyIntent(key('z', { metaKey: true, shiftKey: true }))).toBe('redo');
    // Windows' other redo, where Ctrl+Shift+Z is not universal.
    expect(historyIntent(key('y', { ctrlKey: true }))).toBe('redo');
  });

  it('reads a capital Z, which is what shift produces', () => {
    expect(historyIntent(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
  });

  it('leaves everything else alone', () => {
    expect(historyIntent(key('z', {}))).toBeNull();
    expect(historyIntent(key('a', { ctrlKey: true }))).toBeNull();
    expect(historyIntent(key('s', { metaKey: true }))).toBeNull();
  });
});
