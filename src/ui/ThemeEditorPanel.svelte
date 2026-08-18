<script lang="ts">
  // Theme editor panel content (hosted in a floating dockview group). Presets
  // are read-only (duplicate to edit); custom themes are edited live and persisted.
  import Copy from '@lucide/svelte/icons/copy';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Plus from '@lucide/svelte/icons/plus';
  import Download from '@lucide/svelte/icons/download';
  import Upload from '@lucide/svelte/icons/upload';
  import { theme, type ColorGroup } from '$state/theme.svelte';
  import {
    EDITOR_FIELDS,
    MEMBER_FIELDS,
    PAGE_FIELDS,
    SYNTAX_FIELDS,
    type ThemeSpec,
  } from './themes';
  import { tooltip } from './tooltip';
  import ColorPicker from './ColorPicker.svelte';

  const editing = $derived(theme.editingId ? theme.byId(theme.editingId) : null);
  const readOnly = $derived(!editing || editing.preset);

  // Default to the current theme when opened.
  $effect(() => {
    theme.editingId ??= theme.current.id;
  });

  // ---- edits
  function setColor(group: ColorGroup, key: string, value: string) {
    if (!editing || editing.preset) return;
    theme.update(editing.id, (s: ThemeSpec) => {
      (s[group] as unknown as Record<string, string>)[key] = value;
    });
  }
  function rename(e: Event) {
    if (!editing || editing.preset) return;
    const name = (e.currentTarget as HTMLInputElement).value;
    theme.update(editing.id, (s) => {
      s.name = name;
    });
  }
  function setMode(mode: 'light' | 'dark') {
    if (!editing || editing.preset) return;
    theme.update(editing.id, (s) => {
      s.mode = mode;
    });
  }
  function duplicate() {
    const id = theme.duplicate(editing?.id ?? theme.current.id);
    theme.editingId = id;
  }
  function createBlank() {
    // A new theme starts from the current one so it is immediately usable.
    const id = theme.duplicate(theme.current.id, 'New theme');
    theme.editingId = id;
  }
  function remove() {
    if (!editing || editing.preset) return;
    if (!confirm(`Delete theme "${editing.name}"?`)) return;
    theme.remove(editing.id);
    theme.editingId = theme.current.id;
  }
  function exportTheme() {
    if (!editing) return;
    const json = theme.exportSpec(editing.id);
    if (!json) return;
    void navigator.clipboard.writeText(json).then(
      () => {
        flash('Copied theme JSON to clipboard');
      },
      () => {
        flash('Copy failed');
      },
    );
  }
  async function importTheme() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* fallthrough */
    }
    if (!text) text = prompt('Paste theme JSON') ?? '';
    const id = text ? theme.importSpec(text) : null;
    if (id) theme.editingId = id;
    else flash('Not a valid theme JSON');
  }
  // ---- colour picking: swatches select theme.picking; the picker itself lives
  // at the bottom of this panel (ColorPicker) or in its own window when detached.
  function openPicker(group: ColorGroup, key: string) {
    if (readOnly) return;
    theme.picking =
      theme.picking?.key === key && theme.picking.group === group ? null : { group, key };
  }
  // Editing another theme: the previous selection may not exist there.
  $effect(() => {
    void theme.editingId;
    theme.picking = null;
  });

  let note = $state('');
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  function flash(msg: string) {
    note = msg;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note = ''), 2000);
  }
  function onSelect(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    theme.editingId = id;
    theme.select(id); // preview what you edit
  }
</script>

<div class="panel">
  <div class="row">
    <select
      class="input"
      value={theme.editingId ?? ''}
      onchange={onSelect}
      aria-label="Theme to edit"
    >
      <optgroup label="Presets">
        {#each theme.all.filter((t) => t.preset) as t (t.id)}<option value={t.id}>{t.name}</option
          >{/each}
      </optgroup>
      {#if theme.custom.length}
        <optgroup label="My themes">
          {#each theme.all.filter((t) => !t.preset) as t (t.id)}<option value={t.id}
              >{t.name}</option
            >{/each}
        </optgroup>
      {/if}
    </select>
    <button
      class="icon-btn"
      onclick={createBlank}
      aria-label="New theme"
      use:tooltip={'New theme (from the current one)'}><Plus size={16} /></button
    >
    <button
      class="icon-btn"
      onclick={duplicate}
      aria-label="Duplicate theme"
      use:tooltip={'Duplicate this theme'}><Copy size={16} /></button
    >
    <button
      class="icon-btn"
      onclick={remove}
      disabled={readOnly}
      aria-label="Delete theme"
      use:tooltip={readOnly ? 'Presets cannot be deleted' : 'Delete this theme'}
      ><Trash2 size={16} /></button
    >
    <button
      class="icon-btn"
      onclick={exportTheme}
      aria-label="Export theme"
      use:tooltip={'Copy theme JSON to clipboard'}><Download size={16} /></button
    >
    <button
      class="icon-btn"
      onclick={importTheme}
      aria-label="Import theme"
      use:tooltip={'Import theme JSON from clipboard'}><Upload size={16} /></button
    >
  </div>

  {#if editing}
    <div class="row">
      <input
        class="input name"
        value={editing.name}
        oninput={rename}
        disabled={readOnly}
        aria-label="Theme name"
        placeholder="Theme name"
      />
      <div class="segmented" role="radiogroup" aria-label="Mode">
        <label
          ><input
            type="radio"
            name="theme-mode"
            value="light"
            checked={editing.mode === 'light'}
            disabled={readOnly}
            onchange={() => {
              setMode('light');
            }}
          /><span>Light</span></label
        >
        <label
          ><input
            type="radio"
            name="theme-mode"
            value="dark"
            checked={editing.mode === 'dark'}
            disabled={readOnly}
            onchange={() => {
              setMode('dark');
            }}
          /><span>Dark</span></label
        >
      </div>
    </div>
    {#if readOnly}
      <p class="hint">
        Presets are read-only — <button class="link" onclick={duplicate}>duplicate</button> to customize.
      </p>
    {/if}
    <div class="fields">
      {#each [['Page', 'page', PAGE_FIELDS], ['Members', 'members', MEMBER_FIELDS], ['Code', 'syntax', SYNTAX_FIELDS], ['Editor', 'editor', EDITOR_FIELDS]] as const as [label, group, fields] (group)}
        <h3>{label}</h3>
        {#each fields as f (f.key)}
          {@const value = (editing[group] as unknown as Record<string, string>)[f.key] ?? ''}
          <label class="field">
            <span>{f.label}</span>
            <button
              type="button"
              class="swatch"
              style:background={value}
              disabled={readOnly}
              aria-label="Pick {f.label} colour"
              aria-expanded={theme.picking?.group === group && theme.picking.key === f.key}
              onclick={() => {
                openPicker(group, f.key);
              }}
            ></button>
            <input
              class="hex mono"
              {value}
              disabled={readOnly}
              spellcheck="false"
              onchange={(e) => {
                const v = e.currentTarget.value.trim();
                if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) setColor(group, f.key, v);
              }}
            />
          </label>
        {/each}
      {/each}
    </div>
  {/if}
  {#if note}<div class="note" role="status">{note}</div>{/if}
  {#if !theme.pickerDetached}<ColorPicker />{/if}
</div>

<style>
  .panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface-1);
    color: var(--text-primary);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px 0;
  }
  .row .input {
    flex: 1;
    min-width: 0;
    max-width: none;
  }
  .name {
    font-weight: 600;
  }
  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 7px;
    overflow: hidden;
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
    padding: 5px 10px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12.5px;
    border-right: 1px solid var(--border);
  }
  .segmented label:last-child span {
    border-right: none;
  }
  .segmented input:checked + span {
    background: var(--accent);
    color: var(--on-accent);
  }
  .segmented input:disabled + span {
    cursor: default;
    opacity: 0.7;
  }
  .hint {
    margin: 6px 12px 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .fields {
    overflow: auto;
    padding: 4px 12px 12px;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 12px 0 4px;
  }
  .field {
    display: grid;
    grid-template-columns: 1fr 34px 88px;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .swatch {
    width: 34px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
  }
  .swatch:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .swatch[aria-expanded='true'],
  .swatch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .hex {
    font-size: 12px;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--page);
    color: var(--text-primary);
  }
  .note {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--ok-ink);
    border-top: 1px solid var(--border);
  }
  .icon-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
