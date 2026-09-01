<script lang="ts">
  import { store } from '$state/store.svelte';
  import { TARGET_GROUPS } from '$core/targets';
  import { HYLO_AVAILABLE, standardsFor, splitExtraFlags, type Language } from '$core/options';
  import { isKnownTriple } from '$core/url-state';
  import { tooltip } from './tooltip';
  import InfoMenu from './InfoMenu.svelte';

  const CUSTOM = '__custom__';
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
  // selector and the options below it have nothing to say about it.
  const clangOptions = $derived(store.options.lang !== 'hylo');
  const asSelected = (t: string) => (isKnownTriple(t) ? t : CUSTOM);
  let selectValue = $state(asSelected(store.options.triple));
  let customTriple = $state(isKnownTriple(store.options.triple) ? '' : store.options.triple);
  // Selecting Hylo replaces the triple with its one ABI and going back restores
  // the previous one, neither of which this selector was told about. Without
  // this it would come back showing "Custom triple…" over an empty box while
  // the options held a perfectly ordinary target.
  $effect(() => {
    if (clangOptions) selectValue = asSelected(store.options.triple);
  });
  const stds = $derived(standardsFor(store.options.lang));
  const rejectedFlags = $derived(splitExtraFlags(store.options.extraFlags)[1]);

  function onTarget(e: Event) {
    selectValue = (e.currentTarget as HTMLSelectElement).value;
    if (selectValue !== CUSTOM) store.options.triple = selectValue;
    else if (customTriple.trim()) store.options.triple = customTriple.trim();
  }
  let customTimer: ReturnType<typeof setTimeout> | null = null;
  function onCustom(e: Event) {
    customTriple = (e.currentTarget as HTMLInputElement).value;
    if (customTimer) clearTimeout(customTimer);
    customTimer = setTimeout(() => {
      const t = customTriple.trim();
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(t)) store.options.triple = t;
    }, 700);
  }
  let flagsTimer: ReturnType<typeof setTimeout> | null = null;
  function onFlags(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (flagsTimer) clearTimeout(flagsTimer);
    flagsTimer = setTimeout(() => (store.options.extraFlags = v), 800);
  }
</script>

<section class="controls">
  <!-- The scrolling part. `display: contents` on a wide screen, so the groups
       are flex children of `.controls` exactly as before; a real scroll box on
       a phone, where the row does not wrap. It exists so that the box that
       scrolls is not also the box the options panel has to escape. -->
  <div class="lanes">
    <div class="group">
      <div class="segmented" role="radiogroup" aria-label="Language">
        {#each LANGS as l (l.id)}
          <label use:tooltip={l.tip} class:soon={l.soon}
            ><input
              type="radio"
              name="lang"
              value={l.id}
              checked={store.options.lang === l.id}
              disabled={l.soon}
              onchange={() => {
                store.setLanguage(l.id);
              }}
            /><span>{l.label}</span></label
          >
        {/each}
      </div>
      {#if stds.length}
        <select
          id="std"
          class="input"
          aria-label="Language standard"
          bind:value={store.options.std}
          use:tooltip={'Language standard (-std=)'}
        >
          {#each stds as s (s)}<option value={s}>{s}</option>{/each}
        </select>
      {/if}
    </div>

    <div class="group" class:hidden={!clangOptions}>
      <select
        id="target"
        class="input"
        aria-label="Target"
        value={selectValue}
        onchange={onTarget}
        use:tooltip={`Target triple (--target=${store.options.triple}). Layout is computed for this ABI.`}
      >
        {#each TARGET_GROUPS as g (g.label)}
          <optgroup label={g.label}>
            {#each g.targets as t (t.triple)}
              <option value={t.triple}>{t.label} · {t.triple}</option>
            {/each}
          </optgroup>
        {/each}
        <option value={CUSTOM}>Custom triple…</option>
      </select>
      {#if selectValue === CUSTOM}
        <input
          id="custom-triple"
          class="input mono"
          placeholder="e.g. thumbv7em-none-eabihf"
          spellcheck="false"
          value={customTriple}
          oninput={onCustom}
          aria-label="Custom target triple"
          use:tooltip={'Any LLVM target triple, e.g. thumbv7em-none-eabihf'}
        />
      {/if}
    </div>
  </div>

  <details class="more" class:hidden={!clangOptions}>
    <summary>More options</summary>
    <div class="grid">
      <label
        class="opt"
        use:tooltip={'Cap the alignment of every member, like #pragma pack(N) for the whole file'}
      >
        <span>Max field alignment <code>-fpack-struct</code></span>
        <select id="pack" class="input" bind:value={store.options.pack}>
          <option value="">default</option><option value="1">1</option><option value="2">2</option>
          <option value="4">4</option><option value="8">8</option><option value="16">16</option>
        </select>
      </label>
      <label
        class="opt check"
        use:tooltip={'Lay out bit-fields the way MSVC does (each storage unit sized by its declared type)'}
        ><input type="checkbox" id="ms-bitfields" bind:checked={store.options.msBitfields} /><span
          >MS bit-field layout <code>-mms-bitfields</code></span
        ></label
      >
      <label
        class="opt check"
        use:tooltip={'Give enums the smallest integer type that fits their values'}
        ><input type="checkbox" id="short-enums" bind:checked={store.options.shortEnums} /><span
          >Smallest-fit enums <code>-fshort-enums</code></span
        ></label
      >
      <label class="opt check" use:tooltip={'Make wchar_t 2 bytes (unsigned short)'}
        ><input type="checkbox" id="short-wchar" bind:checked={store.options.shortWchar} /><span
          >2-byte wchar_t <code>-fshort-wchar</code></span
        ></label
      >
      <label
        class="opt check"
        use:tooltip={'Ask clang to report every padding insertion in the diagnostics'}
        ><input type="checkbox" id="warn-padded" bind:checked={store.options.warnPadded} /><span
          >Report padding <code>-Wpadded</code></span
        ></label
      >
      <label
        class="opt wide"
        use:tooltip={'Additional clang flags (-f…, -m…, -W…, -D…, -std=…); anything else is ignored'}
      >
        <span>Extra flags</span>
        <input
          id="extra-flags"
          class="input mono"
          placeholder="-funsigned-char -malign-double …"
          spellcheck="false"
          value={store.options.extraFlags}
          oninput={onFlags}
        />
      </label>
      {#if rejectedFlags.length}
        <span class="rejected" role="status"
          >Ignored (not a layout-relevant flag): {rejectedFlags.join(' ')}</span
        >
      {/if}
      <label
        class="opt check"
        use:tooltip={'Also list the anonymous records declared inside another one. They are normally drawn in their parent rather than listed beside it. A library type is not listed either way; open it by clicking the member that uses it.'}
        ><input type="checkbox" id="show-internal" bind:checked={store.showInternal} /><span
          >List nested anonymous records</span
        ></label
      >
    </div>
  </details>

  <!-- Last in the row, after whichever dropdowns the language has: it describes
       what answered the query the row configures. -->
  <InfoMenu />
</section>

<style>
  .controls {
    position: relative;
    display: flex;
    align-items: center;
    gap: 22px;
    flex-wrap: wrap;
    padding: 10px 20px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
  /* No box of its own on a wide screen: the groups inside are the flex
     children, which is what the rules below expect. */
  .lanes {
    display: contents;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Controls that mean nothing in the selected language. Hidden rather than
     disabled: a greyed-out list of LLVM triples beside a Hylo source reads as
     something that could be chosen, and none of them can. */
  .hidden {
    display: none;
  }

  .segmented {
    display: inline-flex;
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
    padding: 4px 12px;
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
  .more summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12.5px;
  }
  .more[open] {
    flex-basis: 100%;
  }
  .grid {
    display: flex;
    gap: 10px 26px;
    flex-wrap: wrap;
    align-items: center;
    padding: 12px 2px 4px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .opt code {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .opt.wide {
    flex: 1 1 340px;
  }
  .opt.wide .input {
    flex: 1;
    max-width: none;
  }
  .opt.check input {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }
  .rejected {
    color: var(--warn-ink);
    font-size: 12px;
  }

  /* One row, not three. Each group used to take `flex: 1 1 100%`, so a phone
     spent 152px, a fifth of the screen, on three select widgets. Everything
     stays on one line and the target, the only part with room to give, shrinks
     and ellipsises. */
  @media (max-width: 760px), (max-height: 560px) {
    .controls {
      padding: 5px 10px;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .lanes {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .lanes::-webkit-scrollbar {
      display: none;
    }
    /* Only one group has anything to give. Letting them all shrink squeezed
       the standard down to "gn": the select kept its min-width and its parent
       did not, so it simply overflowed under the next control. */
    .group {
      flex: 0 0 auto;
      gap: 6px;
    }
    .group:nth-of-type(2) {
      flex: 1 1 auto;
      min-width: 0;
    }
    .group .input {
      min-width: 0;
    }
    /* Everything may shrink except the standard: `gnu17` versus `gnu++20`
       changes the answer, and a select squeezed to its chevron says neither. */
    .group > select#std {
      flex: 0 0 auto;
      min-width: 5.6em;
    }
    /* The one element that can lose characters without losing its meaning:
       the option text starts with the label a reader is scanning for. */
    .group > select#target {
      flex: 1 1 6em;
      min-width: 6em;
    }
    /* A placeholder for a language with no compiler yet is not worth the width. */
    .segmented label.soon {
      display: none;
    }
    .segmented span {
      padding: 4px 8px;
    }
    /* The words cost more room than the row has. The control itself must not
       disappear with them. Zeroing the font size took the disclosure marker
       too and left nothing to press, so it becomes a glyph, with the label
       still in the accessibility tree for anyone listening rather than looking. */
    .more > summary {
      font-size: 0;
      padding: 2px 6px;
      list-style: none;
    }
    .more > summary::-webkit-details-marker {
      display: none;
    }
    .more > summary::after {
      content: '⋯';
      font-size: 19px;
      line-height: 1;
      color: var(--text-secondary);
    }
    .more[open] > summary::after {
      content: '⋯';
      color: var(--text-primary);
    }
    /* A panel, not a row. `.more[open] { flex-basis: 100% }` works in a bar
       that wraps; in one that does not, opening it pushed a column of
       checkboxes out to the right of the row, over the controls and off the
       screen, cutting off half of "List nested anonymous records" and every flag name
       cut off. Anchored to `.controls` rather than to the summary so it spans
       the width and cannot start off-screen, and outside `.lanes` so the
       horizontal scroll does not clip it. */
    .more[open] {
      flex-basis: auto;
      position: static;
    }
    .more[open] > .grid {
      position: absolute;
      left: 8px;
      right: 8px;
      top: calc(100% + 4px);
      z-index: 30;
      box-sizing: border-box;
      display: grid;
      /* One column on a portrait phone, three on a phone held sideways,
         where the panel has width to spare and no height at all. */
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px 20px;
      align-items: start;
      max-height: min(70vh, 460px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 12px 14px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
    }
    /* One per line, label first: at this width the two-column flow put a
       select under the label it belonged to. */
    .more[open] > .grid .opt {
      flex-wrap: wrap;
      gap: 6px 8px;
    }
    .more[open] > .grid .opt.wide {
      flex: 1 1 auto;
      grid-column: 1 / -1;
    }
    .more[open] > .grid .opt.wide .input {
      flex-basis: 100%;
    }
  }
</style>
