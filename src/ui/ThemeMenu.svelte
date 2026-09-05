<script lang="ts">
  // One control with two halves: the left flips between the last-used light
  // and dark themes, the caret opens the list. Two buttons side by side read
  // as one button whose halves do the same thing; a rule between them says
  // they do not.
  //
  // Resting on a row in the list wears that theme for as long as the pointer
  // is there, which is the only way to answer "what does Paper look like"
  // without choosing it. Leaving puts back the one that is chosen; pressing
  // chooses.
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import Palette from '@lucide/svelte/icons/palette';
  import { theme } from '$state/theme.svelte';
  import { tooltip } from './tooltip';

  let open = $state(false);
  let menu: HTMLDivElement | undefined = $state();
  const light = $derived(theme.all.filter((t) => t.mode === 'light'));
  const dark = $derived(theme.all.filter((t) => t.mode === 'dark'));
  function openEditor() {
    theme.editingId = theme.current.id;
    theme.editorOpen = true;
    close();
  }

  /** Shuts the list, and with it whatever was being tried on. */
  function close() {
    open = false;
    theme.preview(null);
  }
  function onDocClick(e: MouseEvent) {
    if (open && menu && !menu.contains(e.target as Node)) close();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
  function pick(id: string) {
    theme.select(id);
    open = false;
  }
  // A menu that goes away with the component takes its preview with it.
  $effect(() => () => {
    theme.preview(null);
  });
</script>

<svelte:document onclick={onDocClick} onkeydown={onKey} />

<div class="theme" bind:this={menu}>
  <div class="split">
    <button
      class="half"
      type="button"
      onclick={() => {
        theme.toggleMode();
      }}
      use:tooltip={theme.mode === 'dark'
        ? `Switch to light (${theme.all.find((t) => t.id === theme.lastLight)?.name})`
        : `Switch to dark (${theme.all.find((t) => t.id === theme.lastDark)?.name})`}
      aria-label="Toggle light/dark theme"
      data-mode={theme.mode}
    >
      {#if theme.mode === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
    </button>
    <button
      class="half caret"
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label="Choose theme"
      use:tooltip={'Choose theme'}
      onclick={() => {
        if (open) close();
        else open = true;
      }}
    >
      <ChevronDown size={14} />
    </button>
  </div>
  {#if open}
    <div class="popover menu" role="listbox" aria-label="Themes">
      {#each [['Light', light], ['Dark', dark]] as const as [label, list] (label)}
        <div class="group">{label}</div>
        {#each list as t (t.id)}
          <button
            class="item"
            role="option"
            aria-selected={t.id === theme.current.id}
            onclick={() => {
              pick(t.id);
            }}
            onmouseenter={() => {
              theme.preview(t.id);
            }}
            onmouseleave={() => {
              theme.preview(null);
            }}
            onfocus={() => {
              theme.preview(t.id);
            }}
            onblur={() => {
              theme.preview(null);
            }}
          >
            <span
              class="swatch"
              style:background={t.tokens['--page']}
              style:border-color={t.tokens['--border']}
            >
              <i style:background={t.tokens['--accent']}></i>
            </span>
            <span class="name">{t.name}</span>
            {#if t.id === theme.current.id}<Check size={16} class="check" />{/if}
          </button>
        {/each}
      {/each}
      <div class="sep"></div>
      <button class="item" onclick={openEditor}
        ><Palette size={16} /><span class="name">Customize themes…</span></button
      >
    </div>
  {/if}
</div>

<style>
  .theme {
    /* Deliberately not positioned: the menu anchors to `.actions` in the top
       bar instead, whose right edge is the bar's own. Anchored here it hung
       off the chevron and ran off the left of a phone screen. */
    display: inline-flex;
  }
  /* One control, two halves: the same box the other header buttons have, with
     a rule where its behaviour changes. */
  .split {
    display: inline-flex;
    align-items: stretch;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--page);
    overflow: hidden;
  }
  .half {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .half.caret {
    width: 22px;
    border-left: 1px solid var(--border);
  }
  .half:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .half:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* Positioning, clamping and the frame come from `.popover` in app.css. */
  .menu {
    min-width: 200px;
  }
  .group {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 6px 8px 2px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .item:hover,
  .item:focus-visible {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    outline: none;
  }
  .item[aria-selected='true'] .name {
    font-weight: 600;
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 6px 4px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1px solid;
    display: inline-flex;
    align-items: flex-end;
    justify-content: flex-end;
    overflow: hidden;
  }
  .swatch i {
    width: 9px;
    height: 9px;
    border-radius: 3px 0 0 0;
  }
  .name {
    flex: 1;
  }
  .item :global(.check) {
    color: var(--accent);
  }
</style>
