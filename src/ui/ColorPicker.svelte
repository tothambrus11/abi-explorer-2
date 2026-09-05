<script lang="ts">
  // The colour picker for the theme editor: edits theme.picking of the theme
  // being edited, live. Rendered at the bottom of the theme editor, or in its
  // own floating dockview window when detached.
  import 'vanilla-colorful/hex-color-picker.js';
  import PictureInPicture2 from '@lucide/svelte/icons/picture-in-picture-2';
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import { theme } from '$state/theme.svelte';
  import { store } from '$state/store.svelte';
  import {
    EDITOR_FIELDS,
    MEMBER_FIELDS,
    PAGE_FIELDS,
    SYNTAX_FIELDS,
    toHex6,
    type ThemeSpec,
  } from '$core/themes';
  import { tooltip } from './tooltip';

  const { detached = false }: { detached?: boolean } = $props();

  const editing = $derived(theme.editingId ? theme.byId(theme.editingId) : null);
  /** Nothing is being edited at all; a theme that ships is edited like any other. */
  const none = $derived(!editing);
  const value = $derived.by(() => {
    const pk = theme.picking;
    const ed = editing;
    if (!pk || !ed) return null;
    return (ed[pk.group] as unknown as Record<string, string>)[pk.key] ?? null;
  });
  const label = $derived.by(() => {
    const pk = theme.picking;
    if (!pk) return '';
    const fields = {
      page: PAGE_FIELDS,
      syntax: SYNTAX_FIELDS,
      editor: EDITOR_FIELDS,
      members: MEMBER_FIELDS,
    }[pk.group] as { key: string; label: string }[];
    return fields.find((f) => f.key === pk.key)?.label ?? pk.key;
  });

  function set(v: string) {
    const pk = theme.picking;
    if (!pk || !editing) return;
    theme.update(editing.id, (s: ThemeSpec) => {
      (s[pk.group] as unknown as Record<string, string>)[pk.key] = v;
    });
  }
  function onPickerInput(e: Event) {
    set((e as CustomEvent<{ value: string }>).detail.value);
  }
</script>

<div class="picker" class:detached>
  <div class="head">
    <span class="title">{value ? label : 'Colour picker'}</span>
    {#if !none && value}<span class="hex-preview mono">{value}</span>{/if}
    {#if !store.narrow}
      <button
        class="icon-btn small"
        type="button"
        onclick={() => {
          theme.setPickerDetached(!detached);
        }}
        aria-label={detached
          ? 'Attach picker to the theme editor'
          : 'Detach picker into its own window'}
        use:tooltip={detached ? 'Attach to the theme editor' : 'Detach into its own window'}
      >
        {#if detached}<ArrowDownToLine size={16} />{:else}<PictureInPicture2 size={16} />{/if}
      </button>
    {/if}
  </div>
  {#if value && !none}
    <hex-color-picker color={toHex6(value)} oncolor-changed={onPickerInput}></hex-color-picker>
    <div class="row">
      <span class="swatch" style:background={value}></span>
      <input
        class="hex mono"
        {value}
        spellcheck="false"
        aria-label="Hex colour"
        onchange={(e) => {
          const v = e.currentTarget.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) set(v);
        }}
      />
    </div>
  {:else}
    <p class="empty">
      {none ? 'No theme is being edited.' : 'Click a colour swatch above to edit it.'}
    </p>
  {/if}
</div>

<style>
  .picker {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
    flex: none;
  }
  .picker.detached {
    height: 100%;
    border-top: none;
    box-sizing: border-box;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .title {
    flex: 1;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .hex-preview {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .icon-btn.small {
    width: 26px;
    height: 26px;
  }
  .picker :global(hex-color-picker) {
    width: 100%;
    height: clamp(110px, 24vh, 190px);
  }
  .picker :global(hex-color-picker::part(saturation)) {
    border-radius: 8px;
    border-bottom: none;
  }
  .picker :global(hex-color-picker::part(hue)) {
    border-radius: 7px;
    margin-top: 10px;
    height: 14px;
  }
  .picker :global(hex-color-picker::part(saturation-pointer)),
  .picker :global(hex-color-picker::part(hue-pointer)) {
    width: 18px;
    height: 18px;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .swatch {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid var(--border);
    flex: none;
  }
  .hex {
    flex: 1;
    font-size: 12px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--page);
    color: var(--text-primary);
  }
  .empty {
    margin: 4px 0;
    color: var(--text-muted);
    font-size: 12.5px;
  }
</style>
