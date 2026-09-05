<script lang="ts">
  // What is on screen: every source, which of its panels are open, and the way
  // back to the default arrangement.
  //
  // A tab's close button closes that panel and nothing else: the source keeps
  // its code, its settings and its answer, and this is where it comes back
  // from. It is also where a source is named, added, or removed, and the one
  // place that offers a new source when every Source panel has been closed,
  // since the button beside the Source tabs goes with them.
  //
  // One icon rather than two: resetting the arrangement is a thing to do to
  // the view, and a bar of icons that each open one small thing is a bar
  // nobody reads. It is a button in here, beside what it undoes.
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import X from '@lucide/svelte/icons/x';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { store } from '$state/store.svelte';
  import { LANGUAGE_NAMES } from '$core/options';
  import { MAX_BUFFERS, MAX_BUFFER_NAME } from '$core/url-state';
  import { KINDS, KIND_TITLES, type PanelKind } from './panels';
  import type { Dock } from './dock';
  import { tooltip } from './tooltip';

  const { dock }: { dock: Dock | null } = $props();

  let open = $state(false);
  let menu: HTMLDivElement | undefined = $state();
  /**
   * Bumped whenever the dock changes, so the checkboxes re-read what is open.
   * The dock is not reactive state; this is the one thing here that reads it.
   */
  let version = $state(0);
  $effect(() => {
    if (!open || !dock) return;
    return dock.onDidChange(() => {
      version += 1;
    });
  });
  const isOpen = (kind: PanelKind, id: number): boolean => {
    void version;
    return dock?.panelsOf(id).includes(kind) ?? false;
  };

  function onDocClick(e: MouseEvent) {
    if (!open || !menu) return;
    // The path the press travelled, not where its target is now: removing a
    // source takes the button that was pressed out of the document before this
    // runs, and asking whether the menu still contains it would answer no and
    // shut the menu the reader is working in.
    if (e.composedPath().includes(menu)) return;
    open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
  function rename(index: number, e: Event) {
    const value = (e.currentTarget as HTMLInputElement).value.replace(/\s+/g, ' ').trim();
    const source = store.sources[index];
    if (source && value) source.name = value.slice(0, MAX_BUFFER_NAME);
    else if (source) (e.currentTarget as HTMLInputElement).value = source.name;
  }
</script>

<svelte:document onclick={onDocClick} onkeydown={onKey} />

<div class="view" bind:this={menu}>
  <button
    id="view-button"
    class="icon-btn"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="View: sources, panels and layout"
    use:tooltip={'View'}
    onclick={() => (open = !open)}
  >
    <LayoutTemplate size={16} />
  </button>
  {#if open}
    <div class="popover panel" id="view-panel" role="dialog" aria-label="View">
      <table>
        <thead>
          <tr>
            <th class="name-col">Source</th>
            {#each KINDS as kind (kind)}<th>{KIND_TITLES[kind]}</th>{/each}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each store.sources as source, i (source.id)}
            <tr class:active={i === store.activeIndex}>
              <td class="name-col">
                <input
                  class="input small name"
                  type="text"
                  value={source.name}
                  maxlength={MAX_BUFFER_NAME}
                  aria-label="Name of source {i + 1}"
                  onchange={(e) => {
                    rename(i, e);
                  }}
                  onfocus={() => {
                    store.selectSource(i);
                  }}
                />
                <span class="lang">{LANGUAGE_NAMES[source.options.lang]}</span>
              </td>
              {#each KINDS as kind (kind)}
                <td class="check">
                  <input
                    type="checkbox"
                    checked={isOpen(kind, source.id)}
                    aria-label="{KIND_TITLES[kind]} of {source.name}"
                    onchange={() => {
                      dock?.togglePanel(kind, source.id);
                    }}
                  />
                </td>
              {/each}
              <td>
                <button
                  class="remove"
                  type="button"
                  disabled={store.sources.length <= 1}
                  aria-label="Remove {source.name}"
                  use:tooltip={store.sources.length <= 1
                    ? 'The last source stays'
                    : 'Remove this source (undo brings it back)'}
                  onclick={() => {
                    store.closeSource(i);
                  }}><X size={13} /></button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="foot">
        <div class="doing">
          <button
            class="btn small add"
            type="button"
            disabled={store.sources.length >= MAX_BUFFERS}
            onclick={() => {
              store.addSource();
            }}><Plus size={13} /> New source</button
          >
          <button
            id="reset-layout"
            class="btn small add"
            type="button"
            use:tooltip={'Put every panel back where it started'}
            onclick={() => {
              dock?.resetLayout();
              open = false;
            }}><RotateCcw size={13} /> Reset layout</button
          >
        </div>
        <span class="note"
          >A closed panel is only hidden; its source keeps its code and settings.</span
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .view {
    display: flex;
    align-items: center;
  }
  /* Positioning, clamping and the frame come from `.popover` in app.css. */
  .panel {
    padding: 10px 12px 12px;
    min-width: min(340px, calc(100vw - 16px));
    max-width: min(520px, calc(100vw - 16px));
    font-size: 12.5px;
    /* The table has a column per panel kind; on a phone it scrolls rather than
       runs off the screen. */
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th {
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
    text-align: center;
    padding: 2px 6px 6px;
  }
  th.name-col {
    text-align: left;
  }
  td {
    padding: 3px 6px;
    vertical-align: middle;
  }
  tr.active td.name-col {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  td.name-col {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    flex: 1;
    min-width: 8em;
    font-weight: 500;
  }
  .lang {
    font-size: 11px;
    color: var(--text-muted);
  }
  td.check {
    text-align: center;
  }
  td.check input {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
    margin: 0;
    vertical-align: middle;
  }
  .remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .remove:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--hover);
  }
  .remove:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .foot {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .doing {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .note {
    color: var(--text-muted);
    font-size: 11.5px;
  }
</style>
