<script lang="ts">
  // The flags that are neither the language nor the target, behind one mark.
  //
  // These used to be a disclosure that pushed the row it was in open, which
  // worked while there was one row above the whole dock. A source's own row
  // lives inside its Source panel, where there is no height to give away and
  // several rows may be on screen at once, so they are a panel a mark opens,
  // like every other field on the row.
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import { store, type Source } from '$state/store.svelte';
  import { splitExtraFlags } from '$core/options';
  import { anchored } from './anchored';
  import { tooltip } from './tooltip';

  const { source, id }: { source: Source; id?: string | undefined } = $props();
  const options = $derived(source.options);
  const rejected = $derived(splitExtraFlags(options.extraFlags)[1]);
  /** How far from the defaults this source is: what the mark counts. */
  const count = $derived(
    (options.pack ? 1 : 0) +
      (options.msBitfields ? 1 : 0) +
      (options.shortEnums ? 1 : 0) +
      (options.shortWchar ? 1 : 0) +
      (options.warnPadded ? 1 : 0) +
      (options.extraFlags.trim() ? 1 : 0),
  );

  let open = $state(false);
  let mark: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  function onDocPointer(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (mark?.contains(t) || panel?.contains(t)) return;
    open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      mark?.focus();
    }
  }

  // Typing is answered on a pause: every keystroke is not a new question.
  let flagsTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = '';
  function commitFlags() {
    flagsTimer = null;
    options.extraFlags = pending;
  }
  function onFlags(e: Event) {
    pending = (e.currentTarget as HTMLInputElement).value;
    if (flagsTimer) clearTimeout(flagsTimer);
    flagsTimer = setTimeout(commitFlags, 800);
  }
  // What was typed a moment before the row went away still lands: this row is
  // remounted when a second source arrives and it moves into the Source panel.
  $effect(() => () => {
    if (flagsTimer) {
      clearTimeout(flagsTimer);
      commitFlags();
    }
  });
</script>

<svelte:document onmousedown={onDocPointer} onkeydown={onKey} />

<button
  {id}
  class="mark"
  class:open
  class:some={count > 0}
  type="button"
  bind:this={mark}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label={count ? `More options, ${String(count)} away from the default` : 'More options'}
  use:tooltip={open ? null : 'More options'}
  onclick={() => (open = !open)}
>
  <Ellipsis size={15} />
  {#if count}<span class="count">{count}</span>{/if}
</button>

{#if open && mark}
  <div
    class="options"
    role="dialog"
    aria-label="More options"
    bind:this={panel}
    use:anchored={mark}
  >
    <label
      class="opt"
      use:tooltip={'Cap the alignment of every member, like #pragma pack(N) for the whole file'}
    >
      <span>Max field alignment <code>-fpack-struct</code></span>
      <select id="pack" class="input" bind:value={options.pack}>
        <option value="">default</option><option value="1">1</option><option value="2">2</option>
        <option value="4">4</option><option value="8">8</option><option value="16">16</option>
      </select>
    </label>
    <label
      class="opt check"
      use:tooltip={'Lay out bit-fields the way MSVC does (each storage unit sized by its declared type)'}
      ><input type="checkbox" id="ms-bitfields" bind:checked={options.msBitfields} /><span
        >MS bit-field layout <code>-mms-bitfields</code></span
      ></label
    >
    <label
      class="opt check"
      use:tooltip={'Give enums the smallest integer type that fits their values'}
      ><input type="checkbox" id="short-enums" bind:checked={options.shortEnums} /><span
        >Smallest-fit enums <code>-fshort-enums</code></span
      ></label
    >
    <label class="opt check" use:tooltip={'Make wchar_t 2 bytes (unsigned short)'}
      ><input type="checkbox" id="short-wchar" bind:checked={options.shortWchar} /><span
        >2-byte wchar_t <code>-fshort-wchar</code></span
      ></label
    >
    <label
      class="opt check"
      use:tooltip={'Ask clang to report every padding insertion in the diagnostics'}
      ><input type="checkbox" id="warn-padded" bind:checked={options.warnPadded} /><span
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
        value={options.extraFlags}
        oninput={onFlags}
      />
    </label>
    {#if rejected.length}
      <p class="rejected" role="status">
        Ignored (not a layout-relevant flag): {rejected.join(' ')}
      </p>
    {/if}
    <!-- A way of reading every source's answer rather than one source's
         question, which is why it sits under a rule of its own. -->
    <label
      class="opt check apart"
      use:tooltip={'Also list the anonymous records declared inside another one. They are normally drawn in their parent rather than listed beside it. A library type is not listed either way; open it by clicking the member that uses it.'}
      ><input type="checkbox" id="show-internal" bind:checked={store.showInternal} /><span
        >List nested anonymous records</span
      ></label
    >
  </div>
{/if}

<style>
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: var(--field-h, 28px);
    box-sizing: border-box;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-1);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .mark:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .mark.open {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--text-primary);
  }
  .mark:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .mark .count {
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--warn-ink);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 11px 13px;
    width: 330px;
    max-width: calc(100vw - 16px);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.24);
    font-size: 13px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
  }
  .opt > span {
    flex: 1;
  }
  .opt code {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .opt.check {
    flex-direction: row-reverse;
    justify-content: flex-end;
  }
  .opt.check input {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
    flex: none;
  }
  .opt.wide {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .opt.wide .input {
    max-width: none;
  }
  .opt.apart {
    border-top: 1px solid var(--border);
    padding-top: 9px;
  }
  .rejected {
    margin: 0;
    color: var(--warn-ink);
    font-size: 12px;
  }
</style>
