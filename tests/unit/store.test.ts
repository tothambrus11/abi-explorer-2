import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '$state/store.svelte';
import { EXAMPLES } from '$core/targets';
import { DEFAULT_OPTIONS, type Language } from '$core/options';
import { HYLO_TRIPLE } from '$compiler/hylo-wire';

/** The first example written in `lang`, which is what a switch loads. */
const firstOf = (lang: Language) => EXAMPLES.find((e) => e.lang === lang)!;

/** One fresh buffer, as a new visit starts. */
const reset = () => {
  store.options = { ...DEFAULT_OPTIONS };
  store.buffers = [
    { name: 'Source 1', lang: DEFAULT_OPTIONS.lang, source: firstOf(DEFAULT_OPTIONS.lang).source },
  ];
  store.activeBuffer = 0;
  store.selectedRecord = null;
};

describe('choosing a language', () => {
  beforeEach(reset);

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

  it('changes only the buffer on screen', () => {
    store.addBuffer();
    store.setLanguage('c++');
    expect(store.buffers[1]).toMatchObject({ lang: 'c++' });
    expect(store.buffers[0]).toMatchObject({
      lang: 'c',
      source: firstOf(DEFAULT_OPTIONS.lang).source,
    });
  });
});

describe('several buffers', () => {
  beforeEach(reset);

  it('opens a fresh empty buffer in the selected language, and switches to it', () => {
    store.setLanguage('c++');
    store.addBuffer();
    expect(store.buffers).toHaveLength(2);
    expect(store.activeBuffer).toBe(1);
    expect(store.buffers[1]).toEqual({ name: 'Source 2', lang: 'c++', source: '' });
    expect(store.source).toBe('');
  });

  it('edits land in the active buffer and nowhere else', () => {
    store.addBuffer();
    store.source = 'struct Mine { int x; };';
    expect(store.buffers[1]!.source).toBe('struct Mine { int x; };');
    expect(store.buffers[0]!.source).toBe(firstOf('c').source);
    store.selectBuffer(0);
    expect(store.source).toBe(firstOf('c').source);
  });

  it('switching buffers brings the language, standard and target along', () => {
    store.options.triple = 'aarch64-apple-darwin';
    store.addBuffer();
    store.setLanguage('hylo');
    expect(store.options.triple).toBe(HYLO_TRIPLE);

    store.selectBuffer(0);
    expect(store.options.lang).toBe('c');
    expect(store.options.triple, 'the clang triple survives the trip through Hylo').toBe(
      'aarch64-apple-darwin',
    );
    expect(store.options.std).not.toBe('');

    store.selectBuffer(1);
    expect(store.options.lang).toBe('hylo');
    expect(store.options.triple).toBe(HYLO_TRIPLE);
  });

  it('drops the selected record on a switch, which named the old buffer’s', () => {
    store.addBuffer();
    store.selectedRecord = 'struct Example';
    store.selectBuffer(0);
    expect(store.selectedRecord).toBeNull();
  });

  it('closes a buffer and lands on a neighbour; the last one stays', () => {
    store.addBuffer();
    store.addBuffer();
    expect(store.buffers.map((b) => b.name)).toEqual(['Source 1', 'Source 2', 'Source 3']);

    // Closing an earlier buffer keeps the active one active.
    store.closeBuffer(0);
    expect(store.activeBuffer).toBe(1);
    expect(store.source).toBe('');

    // Closing the active one lands on what is now in its place.
    store.selectBuffer(0);
    store.closeBuffer(0);
    expect(store.activeBuffer).toBe(0);
    expect(store.buffers).toHaveLength(1);

    store.closeBuffer(0);
    expect(store.buffers, 'the last buffer cannot be closed').toHaveLength(1);
  });

  it('never reuses a name that is still on a tab', () => {
    store.addBuffer(); // Source 2
    store.addBuffer(); // Source 3
    store.closeBuffer(1);
    store.addBuffer();
    expect(store.buffers.map((b) => b.name)).toEqual(['Source 1', 'Source 3', 'Source 2']);
  });
});
