<script lang="ts">
  // A dock tab that carries its panel's own state.
  //
  // Both panels had a second place saying the same thing: whether the code
  // compiled lived in a strip above the editor, and how many diagnostics there
  // are was only discoverable by opening the tab. On a phone, where Layout and
  // Diagnostics share a group, that meant switching tabs to find out there was
  // nothing to see. Put it where the tab already is.
  //
  // With one source the tab says what it is: Code, Layout, Diagnostics. With
  // several, the group says that and the tab says which source, unless the
  // group holds panels of more than one kind, when the tab has to say both.
  //
  // The tab is also where a source is renamed, since its name is what the tab
  // shows: a double click turns the name into a field. A double click is a
  // mouse's, so the same is offered by a menu, reached by a right click, by a
  // long press on a touch screen, and by F2 or the menu key with the tab
  // focused; the menu also closes the panel and removes the source, for
  // whoever has no pointer to hover the close button with.
  import { onMount } from 'svelte';
  import { store, type Source } from '$state/store.svelte';
  import { LANGUAGE_NAMES } from '$core/options';
  import { MAX_BUFFER_NAME } from '$core/url-state';
  import { KIND_TITLES, type PanelKind } from './panels';
  import { tooltip } from './tooltip';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const { source, kind, close }: { source: Source; kind: PanelKind; close: () => void } = $props();

  /** Whether the group holds other kinds too; the dock says, after every change. */
  let mixed = $state(false);
  export function setMixed(value: boolean): void {
    mixed = value;
  }

  const multi = $derived(store.sources.length > 1);
  const title = $derived(multi ? source.name : KIND_TITLES[kind]);
  const status = $derived(source.status.kind);
  const warn = $derived(source.status.kind === 'ok' && source.status.warnings);
  // The same wording the strip above the editor used: this is a live region,
  // and moving it must not cost a screen reader the sentence it was reading.
  const statusText = $derived.by(() => {
    switch (source.status.kind) {
      case 'idle':
        return '';
      case 'running':
        return 'compiling…';
      case 'ok':
        return source.status.warnings ? 'compiled with warnings' : 'compiled';
      case 'error':
        return source.status.message;
    }
  });
  // Notes are not findings. They are the second half of the finding above
  // them, and counting them makes one warning read as [3].
  const count = $derived(
    source.analysis?.diagnostics.filter((d) => d.severity !== 'note' && d.severity !== 'remark')
      .length ?? 0,
  );

  // ------------------------------------------------------------ rename ----

  let root: HTMLSpanElement | undefined = $state();
  let editing = $state(false);
  let draft = $state('');
  let field: HTMLInputElement | undefined = $state();

  /** The tab dockview drew around this, which owns the focus and the drag. */
  const host = () => root?.closest<HTMLElement>('.dv-tab') ?? null;

  function startRename(): void {
    // With one source the tab does not show the name; the sources menu has
    // the field, and a field here would rename something the tab never says.
    if (!multi) return;
    menu = null;
    draft = source.name;
    editing = true;
  }
  function commit(): void {
    if (!editing) return;
    const name = draft.replace(/\s+/g, ' ').trim().slice(0, MAX_BUFFER_NAME);
    if (name) source.name = name;
    editing = false;
  }
  // Focused and selected once it exists; and the tab is not draggable while
  // the field is, or selecting the text would drag the tab instead.
  $effect(() => {
    const h = host();
    if (!editing || !field) return undefined;
    field.focus();
    field.select();
    if (h) h.draggable = false;
    return () => {
      if (h) h.draggable = true;
    };
  });

  // -------------------------------------------------------------- menu ----

  let menu: { x: number; y: number } | null = $state(null);
  /** When the menu opened, so the tap that opened it does not also close it. */
  let openedAt = 0;
  const index = $derived(store.sources.indexOf(source));

  function openMenu(x: number, y: number): void {
    editing = false;
    menu = { x, y };
    openedAt = Date.now();
  }
  function onDocClick(): void {
    if (menu && Date.now() - openedAt > 300) menu = null;
  }
  function onDocKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') menu = null;
  }

  // A long press on a touch screen is the right click it has no button for.
  let press: ReturnType<typeof setTimeout> | null = null;
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    endPress();
    press = setTimeout(() => {
      press = null;
      openMenu(e.clientX, e.clientY);
    }, 500);
  }
  function endPress(): void {
    if (press) clearTimeout(press);
    press = null;
  }

  onMount(() => {
    const h = host();
    if (!h) return;
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === 'F2') {
        e.preventDefault();
        startRename();
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = h.getBoundingClientRect();
        openMenu(r.left, r.bottom);
      }
    };
    h.addEventListener('keydown', onKey);
    return () => {
      h.removeEventListener('keydown', onKey);
      endPress();
    };
  });

  /** Moves the menu to the body, out of the tab bar's clipping. */
  function portal(node: HTMLElement) {
    document.body.append(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
  /** Inside the screen, whichever corner it was asked for. */
  function place(node: HTMLElement, at: { x: number; y: number }) {
    const fit = (p: { x: number; y: number }) => {
      node.style.left = `${String(Math.max(4, Math.min(p.x, window.innerWidth - node.offsetWidth - 4)))}px`;
      node.style.top = `${String(Math.max(4, Math.min(p.y, window.innerHeight - node.offsetHeight - 4)))}px`;
    };
    fit(at);
    return { update: fit };
  }
</script>

<svelte:document onclick={onDocClick} onkeydown={onDocKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tab"
  bind:this={root}
  use:tooltip={multi && !editing
    ? `${KIND_TITLES[kind]} · ${source.name} (${LANGUAGE_NAMES[source.options.lang]})`
    : null}
  ondblclick={(e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename();
  }}
  oncontextmenu={(e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  }}
  onpointerdown={onPointerDown}
  onpointerup={endPress}
  onpointercancel={endPress}
  onpointermove={endPress}
>
  {#if kind === 'editor'}
    <span
      class="status {status}"
      class:warn
      role="status"
      aria-live="polite"
      aria-label={statusText}
      use:tooltip={statusText}
    >
      {#if status === 'running'}<LoaderCircle size={13} class="spin" />
      {:else if status === 'ok'}<Check size={13} />
      {:else if status === 'error'}<X size={13} />{/if}
    </span>
  {/if}
  {#if multi && mixed}<span class="kind">{KIND_TITLES[kind]}</span>{/if}
  {#if editing}
    <input
      class="rename"
      type="text"
      bind:this={field}
      bind:value={draft}
      maxlength={MAX_BUFFER_NAME}
      aria-label="Rename {source.name}"
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') editing = false;
      }}
      onblur={commit}
      onmousedown={(e) => {
        e.stopPropagation();
      }}
      onpointerdown={(e) => {
        e.stopPropagation();
      }}
      onclick={(e) => {
        e.stopPropagation();
      }}
      ondblclick={(e) => {
        e.stopPropagation();
      }}
    />
  {:else}
    <span class="title">{title}</span>
  {/if}
  {#if kind === 'diagnostics' && count > 0}
    <span class="count" class:bad={status === 'error'} class:warn={status === 'ok' && warn}
      >[{count}]</span
    >
  {/if}
  <button
    class="close"
    type="button"
    aria-label="Close the {KIND_TITLES[kind]} panel of {source.name}"
    onclick={(e) => {
      e.stopPropagation();
      close();
    }}><X size={13} /></button
  >
</span>

{#if menu}
  <div
    class="tabmenu"
    role="menu"
    aria-label="{KIND_TITLES[kind]} panel of {source.name}"
    use:portal
    use:place={menu}
  >
    {#if multi}
      <button type="button" role="menuitem" onclick={startRename}>Rename source…</button>
    {/if}
    <button
      type="button"
      role="menuitem"
      onclick={() => {
        menu = null;
        close();
      }}>Close this panel</button
    >
    <button
      type="button"
      role="menuitem"
      disabled={store.sources.length <= 1}
      onclick={() => {
        menu = null;
        store.closeSource(index);
      }}>Remove {source.name}</button
    >
  </div>
{/if}

<style>
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    /* A double click renames; it must not select the text on the way. */
    user-select: none;
    -webkit-user-select: none;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 14em;
  }
  .rename {
    font: inherit;
    font-size: 12px;
    width: 10em;
    padding: 0 4px;
    margin: -2px 0;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--surface-1);
    color: var(--text-primary);
    user-select: text;
    -webkit-user-select: text;
  }
  .rename:focus-visible {
    outline: none;
  }
  .kind {
    color: var(--text-muted);
    font-weight: 400;
  }
  .kind::after {
    content: '·';
    margin-left: 5px;
  }
  .status {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }
  /* Same colours the strip above the editor used, so the icon means the same
     thing wherever it has moved to. */
  .status.ok {
    color: var(--ok-ink);
  }
  .status.ok.warn,
  .count.warn {
    color: var(--warn-ink);
  }
  .status.error,
  .count.bad {
    color: var(--error);
  }
  .count {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 1px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: inherit;
    opacity: 0.55;
    cursor: pointer;
  }
  .close:hover {
    opacity: 1;
    background: var(--hover);
  }

  /* The tab's menu: fixed, since it is moved out to the body. */
  .tabmenu {
    position: fixed;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-1);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    font-family: var(--font-ui);
    font-size: 12.5px;
  }
  .tabmenu button {
    font: inherit;
    text-align: left;
    padding: 6px 10px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    white-space: nowrap;
  }
  .tabmenu button:hover,
  .tabmenu button:focus-visible {
    background: var(--hover);
    outline: none;
  }
  .tabmenu button:disabled {
    color: var(--text-muted);
    cursor: default;
    background: none;
  }
</style>
