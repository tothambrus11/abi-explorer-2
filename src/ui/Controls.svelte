<script lang="ts">
  import { store } from '$state/store.svelte';
  import { TARGET_GROUPS } from '$core/targets';
  import { standardsFor, splitExtraFlags, type Language } from '$core/options';
  import { isKnownTriple } from '$core/url-state';
  import { tooltip } from './tooltip';

  const CUSTOM = '__custom__';
  // `soon` marks a language with no backend yet: selectable would silently
  // compile the source as C and label the result Hylo.
  const LANGS: { id: Language; label: string; tip: string; soon?: boolean }[] = [
    { id: 'c', label: 'C', tip: 'Compile as C' },
    { id: 'c++', label: 'C++', tip: 'Compile as C++' },
    { id: 'hylo', label: 'Hylo', tip: 'Hylo — not supported yet', soon: true },
  ];
  let selectValue = $state(isKnownTriple(store.options.triple) ? store.options.triple : CUSTOM);
  let customTriple = $state(isKnownTriple(store.options.triple) ? '' : store.options.triple);
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

  <div class="group">
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

  <details class="more">
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
        use:tooltip={'Also list library records (std::…, reserved __ names), clang-internal ones (e.g. __va_list_tag) and anonymous ones'}
        ><input type="checkbox" id="show-internal" bind:checked={store.showInternal} /><span
          >Show library, compiler-internal &amp; anonymous records</span
        ></label
      >
    </div>
  </details>
</section>

<style>
  @media (max-width: 760px) {
    .controls {
      padding: 8px 12px;
      gap: 8px 12px;
    }
    .group {
      flex: 1 1 100%;
      min-width: 0;
    }
    .group .input {
      min-width: 0;
      max-width: 100%;
    }
    .group > select#target {
      flex: 1;
    }
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 22px;
    flex-wrap: wrap;
    padding: 10px 20px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
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
</style>
