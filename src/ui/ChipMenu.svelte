<script lang="ts">
  // One field of the query: a chip that says the value, and a menu that filters
  // as you type.
  //
  // A select would do for six standards; it would not for forty targets, where
  // the reader knows the word they are after ("apple", "riscv") and not the
  // position of the option. `custom` is what makes the target field able to
  // take a triple that is not on the list at all, which is the contract
  // Compiler Explorer's link into this app relies on.
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import { anchored } from './anchored';
  import { tooltip } from './tooltip';
  import type { MenuItem } from './menu';

  const {
    id,
    value,
    label,
    items,
    onPick,
    placeholder,
    title,
    ariaLabel,
    mono = false,
    custom = false,
    foot,
  }: {
    id?: string | undefined;
    /** The value now, which the menu marks. */
    value: string;
    /** What the chip says. */
    label: string;
    items: MenuItem[];
    onPick: (value: string) => void;
    placeholder: string;
    /** Tooltip for the chip. */
    title?: string;
    ariaLabel: string;
    mono?: boolean;
    /** Accept anything that could be a target triple, not only what is listed. */
    custom?: boolean;
    foot?: string;
  } = $props();

  /** The listbox's id, for the field to point at: one no label can make invalid. */
  const uid = $props.id();

  /** What the app will pass to `--target=`: a plain token, nothing else. */
  const TRIPLE = /^[A-Za-z0-9_.-]{1,64}$/;

  let open = $state(false);
  let query = $state('');
  let cursor = $state(0);
  let chip: HTMLButtonElement | undefined = $state();
  let listBox: HTMLDivElement | undefined = $state();
  let field: HTMLInputElement | undefined = $state();

  // Opened to be typed into: the caret goes in the box, so the first
  // keystroke filters rather than falling on the page behind it. `autofocus`
  // will not do, since the panel is moved into the document after it renders.
  $effect(() => {
    if (open) field?.focus();
  });

  const q = $derived(query.trim().toLowerCase());
  const matches = $derived(
    items.filter(
      (it) =>
        !q ||
        it.label.toLowerCase().includes(q) ||
        it.value.toLowerCase().includes(q) ||
        (it.note ?? '').toLowerCase().includes(q),
    ),
  );
  /**
   * What is on the list, plus the typed text itself where that could be a
   * triple this build has not listed. A triple has dashes in it, so a word
   * that merely matches a label ("apple") is not also offered as one; a word
   * that matches nothing is, since the list is not the limit.
   */
  const rows = $derived.by(() => {
    const typed = query.trim();
    if (!custom || !typed || items.some((it) => it.value === typed)) return matches;
    if (!TRIPLE.test(typed)) return matches;
    if (!typed.includes('-') && matches.length > 0) return matches;
    return [...matches, { value: typed, label: `Use “${typed}”`, note: 'custom triple' }];
  });
  /** Headings are for reading a whole list; a filtered one is already the answer. */
  const grouped = $derived(q === '' && items.some((it) => it.group));

  $effect(() => {
    void rows;
    if (cursor > rows.length - 1) cursor = Math.max(0, rows.length - 1);
  });

  function show() {
    query = '';
    cursor = Math.max(
      0,
      items.findIndex((it) => it.value === value),
    );
    open = true;
  }
  function hide() {
    open = false;
  }
  function pick(v: string) {
    hide();
    chip?.focus();
    if (v !== value) onPick(v);
  }
  function move(by: number) {
    if (!rows.length) return;
    cursor = (cursor + by + rows.length) % rows.length;
    // The row the keyboard is on has to be the row on screen.
    queueMicrotask(() => {
      listBox?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) pick(row.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
      chip?.focus();
    } else if (e.key === 'Tab') {
      hide();
    }
  }
  // The menu is in the document rather than in this row, so "outside" is
  // decided by asking both boxes.
  function onDocPointer(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (chip?.contains(t) || listBox?.closest('.field-menu')?.contains(t)) return;
    hide();
  }
</script>

<svelte:document onmousedown={onDocPointer} />

<button
  {id}
  class="chip"
  class:mono
  class:open
  type="button"
  bind:this={chip}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-label={ariaLabel}
  use:tooltip={open ? null : title}
  onclick={() => {
    if (open) hide();
    else show();
  }}
>
  <span class="t">{label}</span>
  <ChevronDown size={12} class="caret" />
</button>

{#if open && chip}
  <div class="field-menu" role="dialog" aria-label={ariaLabel} use:anchored={chip}>
    <div class="filter">
      <input
        class="input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        bind:this={field}
        bind:value={query}
        {placeholder}
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-label={placeholder}
        onkeydown={onKey}
        oninput={() => (cursor = 0)}
      />
    </div>
    <div class="list" id="{uid}-list" role="listbox" bind:this={listBox}>
      {#each rows as row, i (row.value)}
        {#if grouped && row.group && row.group !== rows[i - 1]?.group}
          <div class="head">{row.group}</div>
        {/if}
        <button
          class="row"
          class:here={row.value === value}
          class:cursor={i === cursor}
          data-cursor={i === cursor}
          type="button"
          role="option"
          aria-selected={row.value === value}
          onmousemove={() => (cursor = i)}
          onclick={() => {
            pick(row.value);
          }}
        >
          <span class="name">{row.label}</span>
          {#if row.note}<span class="note">{row.note}</span>{/if}
          {#if row.value === value}<Check size={13} class="tick" />{/if}
        </button>
      {:else}
        <p class="none">
          {custom ? 'No target matches, and that is not a triple.' : 'Nothing matches.'}
        </p>
      {/each}
    </div>
    {#if foot}<p class="foot">{foot}</p>{/if}
  </div>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    /* The row sets one height for every control on it; this is the fallback
       for a chip used anywhere else. */
    height: var(--field-h, 28px);
    box-sizing: border-box;
    padding: 0 5px 0 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-1);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--accent);
  }
  .chip.open {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .chip .t {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip.mono .t {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .chip :global(.caret) {
    color: var(--text-muted);
    flex: none;
  }

  /* The menu is moved to the document by `anchored`, so it is styled globally
     rather than through this component's scope. */
  :global(.field-menu) {
    display: flex;
    flex-direction: column;
    min-width: 230px;
    max-width: min(420px, calc(100vw - 16px));
    max-height: min(360px, calc(100vh - 24px));
    overflow: hidden;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.24);
    font-size: 12.5px;
  }
  .filter {
    padding: 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .filter .input {
    width: 100%;
    max-width: none;
  }
  .list {
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .head {
    font-size: 10.5px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 6px 7px 3px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    text-align: left;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    padding: 4px 7px;
    cursor: pointer;
  }
  .row .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .note {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .row.cursor {
    background: var(--hover);
  }
  .row.here {
    color: var(--accent);
  }
  .row :global(.tick) {
    flex: none;
    color: var(--accent);
  }
  .none,
  .foot {
    margin: 0;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .none {
    padding: 8px;
  }
  .foot {
    padding: 6px 8px 7px;
    border-top: 1px solid var(--border);
    flex: none;
  }
</style>
