import { describe, it, expect, beforeEach } from 'vitest';
import { store, Source, defaultBuffer } from '$state/store.svelte';
import { EXAMPLES } from '$core/targets';
import { DEFAULT_OPTIONS, type Language } from '$core/options';
import { HYLO_TRIPLE } from '$compiler/hylo-wire';

/** The first example written in `lang`, which is what a switch loads. */
const firstOf = (lang: Language) => EXAMPLES.find((e) => e.lang === lang)!;

/** One fresh source, as a new visit starts. */
const reset = () => {
  store.sources = [new Source(defaultBuffer())];
  store.activeIndex = 0;
};

describe('choosing a language', () => {
  beforeEach(reset);

  it('puts that language in the source', () => {
    store.active.setLanguage('hylo');
    expect(store.active.text).toBe(firstOf('hylo').source);

    store.active.setLanguage('c++');
    expect(store.active.text).toBe(firstOf('c++').source);
  });

  it('leaves the text alone when the language is already selected', () => {
    store.active.setLanguage('c++');
    store.active.text = 'struct Mine { int x; };';
    store.active.setLanguage('c++');
    expect(store.active.text).toBe('struct Mine { int x; };');
  });

  it('drops the selected record, which named one of the old text’s', () => {
    store.active.selectedRecord = 'Example';
    store.active.setLanguage('hylo');
    expect(store.active.selectedRecord).toBeNull();
  });

  it('takes the standard and the target with it, and gives the target back', () => {
    store.active.options.triple = 'aarch64-apple-darwin';
    store.active.setLanguage('hylo');
    // Hylo describes one ABI and has no standards to choose between.
    expect(store.active.options.triple).toBe(HYLO_TRIPLE);
    expect(store.active.options.std).toBe('');

    store.active.setLanguage('c');
    expect(store.active.options.triple).toBe('aarch64-apple-darwin');
    expect(store.active.options.std).not.toBe('');
  });

  it('loads the example that was asked for, not the language’s first', () => {
    // Picking an example switches language too, and the example picked is the
    // one that must end up in the source.
    const index = EXAMPLES.findIndex(
      (e, i) => e.lang === 'c++' && i !== EXAMPLES.indexOf(firstOf('c++')),
    );
    expect(index, 'a second C++ example to tell the two apart').toBeGreaterThan(-1);
    store.active.loadExample(index);
    expect(store.active.options.lang).toBe('c++');
    expect(store.active.text).toBe(EXAMPLES[index]!.source);
  });

  it('changes only the source it was asked of', () => {
    store.addSource();
    store.active.setLanguage('c++');
    expect(store.sources[1]!.options.lang).toBe('c++');
    expect(store.sources[0]!.options.lang).toBe('c');
    expect(store.sources[0]!.text).toBe(firstOf(DEFAULT_OPTIONS.lang).source);
  });
});

describe('several sources', () => {
  beforeEach(reset);

  it('ends a peek at a source that closes, and keeps one at a source that stays', () => {
    const first = store.sources[0]!;
    const second = store.addSource()!;
    store.peek = second.id;
    store.closeSource(1);
    expect(store.peek).toBeNull();
    expect(store.shown).toBe(first);

    const third = store.addSource()!;
    store.peek = first.id;
    // An undo keeps identity by position: the first source survives.
    store.replaceSources([first.toBuffer()], 0);
    expect(store.peek).toBe(first.id);
    expect(store.sources.some((s) => s.id === third.id)).toBe(false);
  });

  it('opens a fresh empty source with the options of the one in focus, and switches to it', () => {
    store.active.setLanguage('c++');
    store.active.options.triple = 'aarch64-apple-darwin';
    store.addSource();
    expect(store.sources).toHaveLength(2);
    expect(store.activeIndex).toBe(1);
    expect(store.active.name).toBe('Source 2');
    expect(store.active.text).toBe('');
    expect(store.active.options).toEqual(store.sources[0]!.options);
    expect(store.active.options, 'a copy, not the same object').not.toBe(store.sources[0]!.options);
  });

  it('gives every source its own options', () => {
    store.addSource();
    store.active.setLanguage('hylo');
    expect(store.sources[1]!.options.triple).toBe(HYLO_TRIPLE);
    expect(store.sources[0]!.options.lang).toBe('c');
    expect(store.sources[0]!.options.triple).toBe(DEFAULT_OPTIONS.triple);

    // Putting another source in focus changes nothing but the focus.
    store.selectSource(0);
    expect(store.active.options.lang).toBe('c');
    expect(store.sources[1]!.options.lang).toBe('hylo');
    expect(store.sources[1]!.selectedRecord).toBeNull();
  });

  it('closes a source and lands on a neighbour; the last one stays', () => {
    store.addSource();
    store.addSource();
    expect(store.sources.map((s) => s.name)).toEqual(['Source 1', 'Source 2', 'Source 3']);

    // Closing an earlier source keeps the one in focus in focus.
    store.closeSource(0);
    expect(store.activeIndex).toBe(1);
    expect(store.active.name).toBe('Source 3');

    // Closing the one in focus lands on what is now in its place.
    store.selectSource(0);
    store.closeSource(0);
    expect(store.activeIndex).toBe(0);
    expect(store.sources).toHaveLength(1);

    store.closeSource(0);
    expect(store.sources, 'the last source cannot be closed').toHaveLength(1);
  });

  it('never reuses a name that is still on a tab', () => {
    store.addSource(); // Source 2
    store.addSource(); // Source 3
    store.closeSource(1);
    store.addSource();
    expect(store.sources.map((s) => s.name)).toEqual(['Source 1', 'Source 3', 'Source 2']);
  });

  it('keeps a source’s identity across a state put back, by position', () => {
    // The dock names panels after sources; an undo that rebuilt every source
    // would rebuild every panel to put back one word.
    store.addSource();
    const [first, second] = store.sources.map((s) => s.id);
    store.replaceSources(
      [
        { name: 'Renamed', source: 'int a;', options: { ...DEFAULT_OPTIONS } },
        { name: 'Source 2', source: 'x', options: { ...DEFAULT_OPTIONS, lang: 'c++' } },
        { name: 'Source 3', source: '', options: { ...DEFAULT_OPTIONS } },
      ],
      2,
    );
    expect(store.sources.map((s) => s.id).slice(0, 2)).toEqual([first, second]);
    expect(store.sources[0]).toMatchObject({ name: 'Renamed', text: 'int a;' });
    expect(store.sources[1]!.options.lang).toBe('c++');
    expect(store.activeIndex).toBe(2);

    store.replaceSources([{ name: 'Only', source: '', options: { ...DEFAULT_OPTIONS } }], 5);
    expect(store.sources).toHaveLength(1);
    expect(store.sources[0]!.id).toBe(first);
    expect(store.activeIndex, 'clamped to what exists').toBe(0);
  });

  it('leaves a source alone when the state put back is the one it has', () => {
    // An undo of a keystroke in another source must not drop this one's
    // selected record, nor hand it a fresh options object to recompile for.
    store.addSource();
    const first = store.sources[0]!;
    first.selectedRecord = 'struct Example';
    const options = first.options;
    store.replaceSources(
      [first.toBuffer(), { ...store.sources[1]!.toBuffer(), source: 'changed' }],
      1,
    );
    expect(first.selectedRecord).toBe('struct Example');
    expect(first.options).toBe(options);
    // Whereas a source whose text or options change does start afresh.
    store.sources[1]!.selectedRecord = 'struct B';
    store.replaceSources(
      [first.toBuffer(), { ...store.sources[1]!.toBuffer(), source: 'changed again' }],
      1,
    );
    expect(store.sources[1]!.selectedRecord).toBeNull();
  });

  it('knows which compilers the sources need', () => {
    expect([...store.languages]).toEqual(['c']);
    store.addSource();
    store.active.setLanguage('hylo');
    expect([...store.languages].sort()).toEqual(['c', 'hylo']);
    expect(store.compilerFor('hylo')).toEqual({ state: 'idle' });
  });
});
