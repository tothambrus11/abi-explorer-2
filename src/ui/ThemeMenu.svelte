<script lang="ts">
  // Light/dark switch (flips between the last-used light and dark themes) plus
  // a chevron opening the full theme list.
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
    open = false;
  }

  function onDocClick(e: MouseEvent) {
    if (open && menu && !menu.contains(e.target as Node)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
  function pick(id: string) {
    theme.select(id);
    open = false;
  }
</script>

<svelte:document onclick={onDocClick} onkeydown={onKey} />

<div class="theme" bind:this={menu}>
  <button
    class="icon-btn"
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
    class="icon-btn chevron"
    type="button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="Choose theme"
    use:tooltip={'Choose theme'}
    onclick={() => (open = !open)}
  >
    <ChevronDown size={16} />
  </button>
  {#if open}
    <div class="menu" role="listbox" aria-label="Themes">
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
    position: relative;
    display: inline-flex;
    gap: 4px;
  }
  .chevron {
    width: 24px;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    min-width: 200px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 6px;
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
