import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '$state/store.svelte';
import { EXAMPLES } from '$core/targets';
import { DEFAULT_OPTIONS, type Language } from '$core/options';
import { HYLO_TRIPLE } from '$compiler/hylo-wire';

/** The first example written in `lang`, which is what a switch loads. */
const firstOf = (lang: Language) => EXAMPLES.find((e) => e.lang === lang)!;

describe('choosing a language', () => {
  beforeEach(() => {
    store.options = { ...DEFAULT_OPTIONS };
    store.source = firstOf(DEFAULT_OPTIONS.lang).source;
    store.selectedRecord = null;
  });

  it('puts that language in the buffer', () => {
    store.setLanguage('hylo');
    expect(store.source).toBe(firstOf('hylo').source);

    store.setLanguage('c++');
    expect(store.source).toBe(firstOf('c++').source);
  });

  it('leaves the buffer alone when the language is already selected', () => {
    store.setLanguage('c++');
    store.source = 'struct Mine { int x; };';
    store.setLanguage('c++');
    expect(store.source).toBe('struct Mine { int x; };');
  });

  it('drops the selected record, which named one of the old buffer’s', () => {
    store.selectedRecord = 'Example';
    store.setLanguage('hylo');
    expect(store.selectedRecord).toBeNull();
  });

  it('takes the standard and the target with it, and gives the target back', () => {
    store.options.triple = 'aarch64-apple-darwin';
    store.setLanguage('hylo');
    // Hylo describes one ABI and has no standards to choose between.
    expect(store.options.triple).toBe(HYLO_TRIPLE);
    expect(store.options.std).toBe('');

    store.setLanguage('c');
    expect(store.options.triple).toBe('aarch64-apple-darwin');
    expect(store.options.std).not.toBe('');
  });

  it('loads the example that was asked for, not the language’s first', () => {
    // Picking an example switches language too, and the example picked is the
    // one that must end up in the buffer.
    const index = EXAMPLES.findIndex(
      (e, i) => e.lang === 'c++' && i !== EXAMPLES.indexOf(firstOf('c++')),
    );
    expect(index, 'a second C++ example to tell the two apart').toBeGreaterThan(-1);
    store.loadExample(index);
    expect(store.options.lang).toBe('c++');
    expect(store.source).toBe(EXAMPLES[index]!.source);
  });
});
