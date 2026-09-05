<script lang="ts">
  // The query: language, standard, target and flags, plus the info icon.
  //
  // Everything here writes to one source's options, and nothing here reads a
  // result — the compile is downstream of this, driven by whoever watches the
  // options. Which controls apply depends on the language, since Hylo
  // describes one ABI and takes none of clang's flags.
  //
  // Two homes. With one source the row sits above the dock, as it always has,
  // and the language keeps the segmented control it has always had, there
  // being room for three words. With several, each Source panel carries its own
  // row: the options are that source's, and a strip at the top would have to
  // say which source it was talking about. There the language is a chip like
  // the others, since a row inside a panel has no room for a control that is
  // three buttons wide.
  //
  // Standard and target are chips that open a menu you can type into: forty
  // targets is too many to find by position, and the reader knows the word
  // ("apple", "riscv") rather than the place. The target menu also takes a
  // triple that is not on the list, which is the contract Compiler Explorer's
  // link into this app relies on.
  import { type Source } from '$state/store.svelte';
  import { TARGET_GROUPS } from '$core/targets';
  import { HYLO_AVAILABLE, LANGUAGE_NAMES, standardsFor, type Language } from '$core/options';
  import { isKnownTriple } from '$core/url-state';
  import { tooltip } from './tooltip';
  import ChipMenu from './ChipMenu.svelte';
  import type { MenuItem } from './menu';
  import MoreOptions from './MoreOptions.svelte';
  import InfoMenu from './InfoMenu.svelte';

  const { source, compact = false }: { source: Source; compact?: boolean } = $props();
  const options = $derived(source.options);

  // `soon` marks a language with no backend in this build: selectable would
  // silently compile the source as C and label the result Hylo. Hylo's module
  // is optional (see `HYLO_AVAILABLE`), so which it is depends on the build.
  const LANGS: { id: Language; label: string; tip: string; soon?: boolean }[] = [
    { id: 'c', label: 'C', tip: 'Compile as C' },
    { id: 'c++', label: 'C++', tip: 'Compile as C++' },
    HYLO_AVAILABLE
      ? { id: 'hylo', label: 'Hylo', tip: 'Lay out Hylo types (downloads the Hylo compiler)' }
      : { id: 'hylo', label: 'Hylo', tip: 'Hylo: not supported by this build', soon: true },
  ];
  // Hylo describes one ABI and takes none of clang's flags, so the target
  // chip and the options beside it have nothing to say about it.
  const clangOptions = $derived(options.lang !== 'hylo');
  const stds = $derived(standardsFor(options.lang));

  const langItems: MenuItem[] = LANGS.filter((l) => !l.soon).map((l) => ({
    value: l.id,
    label: l.label,
  }));
  const stdItems = $derived(stds.map((s) => ({ value: s, label: s })));
  // Grouped as the selector's optgroups were: an architecture family is how a
  // reader scanning the whole list finds their way down it.
  const targetItems: MenuItem[] = TARGET_GROUPS.flatMap((g) =>
    g.targets.map((t) => ({ value: t.triple, label: t.label, note: t.triple, group: g.label })),
  );
  /** What the target chip says: the label of a listed triple, else the triple. */
  const targetLabel = $derived(
    targetItems.find((t) => t.value === options.triple)?.label ?? options.triple,
  );
</script>

<section class="controls" class:compact>
  <!-- The scrolling part. `display: contents` on a wide screen, so the groups
       are flex children of `.controls` exactly as before; a real scroll box on
       a phone, where the row does not wrap. -->
  <div class="lanes">
    <div class="group">
      {#if compact}
        <ChipMenu
          value={options.lang}
          label={LANGUAGE_NAMES[options.lang]}
          items={langItems}
          ariaLabel="Language"
          placeholder="Filter languages…"
          title="The language this source is compiled as"
          onPick={(id: string) => {
            source.setLanguage(id as Language);
          }}
        />
      {:else}
        <div class="segmented" role="radiogroup" aria-label="Language">
          {#each LANGS as l (l.id)}
            <label use:tooltip={l.tip} class:soon={l.soon}
              ><input
                type="radio"
                name="lang"
                value={l.id}
                checked={options.lang === l.id}
                disabled={l.soon}
                onchange={() => {
                  source.setLanguage(l.id);
                }}
              /><span>{l.label}</span></label
            >
          {/each}
        </div>
      {/if}
      {#if stds.length}
        <ChipMenu
          id={compact ? undefined : 'std'}
          value={options.std}
          label={options.std}
          items={stdItems}
          mono
          ariaLabel="Language standard"
          placeholder="Filter standards…"
          title="Language standard (-std=)"
          onPick={(std: string) => {
            options.std = std;
          }}
        />
      {/if}
    </div>

    <div class="group" class:hidden={!clangOptions}>
      <ChipMenu
        id={compact ? undefined : 'target'}
        value={options.triple}
        label={targetLabel}
        items={targetItems}
        custom
        mono={!isKnownTriple(options.triple)}
        ariaLabel="Target"
        placeholder="Filter targets, or type a triple…"
        title={`Target triple: ${options.triple}`}
        foot="Any triple clang accepts can be typed."
        onPick={(triple: string) => {
          options.triple = triple;
        }}
      />
      <MoreOptions id={compact ? undefined : 'more-options'} {source} />
    </div>
  </div>

  <!-- Last in the row, after whichever fields the language has: it describes
       what answered the query the row configures. -->
  <InfoMenu {source} />
</section>

<style>
  .controls {
    /* One height for every control on the row: the language selector, the two
       chips and the options mark. A row of boxes that nearly line up reads as
       a mistake, and this is the row a reader looks along. */
    --field-h: 32px;
    /* One gap as well as one height: the language, the standard, the target
       and the options mark are four fields of one query, and a wider space
       between two of them reads as a boundary that is not there. */
    --field-gap: 8px;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--field-gap);
    flex-wrap: wrap;
    padding: 10px 20px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
  /* Inside a Source panel: the same row, at the panel's scale. */
  .controls.compact {
    --field-h: 26px;
    --field-gap: 6px;
    padding: 0 0 8px;
    border-bottom: 0;
  }
  /* No box of its own on a wide screen: the groups inside are the flex
     children, which is what the rules below expect. */
  .lanes {
    display: contents;
  }
  /* A group is what the language hides or shows together, not a space: it
     takes the row's own gap. */
  .group {
    display: flex;
    align-items: center;
    gap: var(--field-gap);
  }
  /* Controls that mean nothing in the selected language. Hidden rather than
     disabled: a greyed-out list of LLVM triples beside a Hylo source reads as
     something that could be chosen, and none of them can. */
  .hidden {
    display: none;
  }

  .segmented {
    display: inline-flex;
    align-items: stretch;
    height: var(--field-h);
    box-sizing: border-box;
    gap: 2px;
    padding: 3px;
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .segmented label {
    display: contents;
  }
  .segmented input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .segmented span {
    display: inline-flex;
    align-items: center;
    padding: 0 12px;
    border-radius: 5px;
    cursor: pointer;
    color: var(--text-muted);
  }
  .segmented span:hover {
    color: var(--text-secondary);
  }
  .segmented input:checked + span {
    background: var(--baseline);
    color: var(--text-primary);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  }
  .segmented input:focus-visible + span {
    outline: 2px solid var(--accent);
  }
  /* A language with no backend yet: visibly present, not choosable. */
  .segmented input:disabled + span {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .segmented input:disabled + span:hover {
    color: var(--text-muted);
  }

  /* A narrow Source panel: the row wraps rather than squeezing the target chip
     down to a word and a chevron. The panel's width is the question, not the
     window's, so this is a container query. */
  @media (min-width: 0px) {
    .controls.compact {
      container-type: inline-size;
    }
  }
  @container (max-width: 430px) {
    .controls.compact .group {
      flex: 1 1 100%;
      min-width: 0;
    }
  }

  /* One row, not three. Each group used to take `flex: 1 1 100%`, so a phone
     spent a fifth of the screen on three controls. Everything stays on one
     line and scrolls sideways instead; the target chip, the only part with
     room to give, ellipsises first. */
  @media (max-width: 760px), (max-height: 560px) {
    .controls:not(.compact) {
      --field-h: 28px;
      --field-gap: 6px;
      padding: 5px 10px;
      flex-wrap: nowrap;
    }
    .controls:not(.compact) .lanes {
      display: flex;
      align-items: center;
      gap: var(--field-gap);
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .controls:not(.compact) .lanes::-webkit-scrollbar {
      display: none;
    }
    .controls:not(.compact) .group {
      flex: 0 0 auto;
    }
    /* A placeholder for a language with no compiler yet is not worth the width. */
    .segmented label.soon {
      display: none;
    }
    .segmented span {
      padding: 0 8px;
    }
  }
</style>
