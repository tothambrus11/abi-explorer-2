<script lang="ts">
  // What answered the current query, and what this thing is.
  //
  // A footer said all of it, and a footer is the first casualty of a phone:
  // three lines of prose across the bottom of a 390px screen is a quarter of
  // the viewport spent on text nobody is reading twice. This is the only place
  // that states it now, and it costs nothing until it is asked for.
  //
  // It sits at the end of the row it describes, and opens on hover rather than
  // on a press: it answers "what am I looking at", which is a question you have
  // while reading, not one you go and click for. Pressing opens it too, because
  // a touch screen has no hover.
  //
  // Pressing *opens*; it does not toggle. A pointer entering the icon has
  // already opened the panel by the time the press lands, so a toggle would
  // close what the user was reaching for. Escape and a press elsewhere are what
  // dismiss it.
  import Info from '@lucide/svelte/icons/info';
  import { store } from '$state/store.svelte';
  import { headerSummary, headerExplanation } from '$core/headers';
  import { describeBackend } from '$compiler/Backends';

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  /**
   * Closing is delayed so the pointer can cross the gap between the icon and
   * the panel it opened without the panel vanishing on the way.
   */
  let closing: ReturnType<typeof setTimeout> | null = null;

  const version = $derived(
    store.compiler.state === 'ready' ? store.compiler.version.replace(/\(.*?\)\s*/, '') : '',
  );
  const headers = $derived(store.analysis?.headers ?? null);
  const summary = $derived(headerSummary(headers));
  const explanation = $derived(headerExplanation(headers));
  const backend = $derived(describeBackend(store.options.lang));

  /** The icon, so the panel can be placed against it. */
  let mark: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  /**
   * Put the panel under the icon, on the screen.
   *
   * The icon sits at the end of a row that wraps and whose contents depend on
   * the language, so it can be anywhere across the width: anchoring the panel
   * to one of its edges puts it off the screen at the other. Measuring is what
   * makes both ends work, and it is why the panel is `fixed` rather than
   * absolutely placed inside a row that also scrolls sideways on a phone.
   */
  function place() {
    if (!mark || !panel) return;
    const icon = mark.getBoundingClientRect();
    const width = panel.offsetWidth;
    const margin = 8;
    // Preferred: left edge under the icon. Clamped: never past either edge,
    // and never negative on a screen narrower than the panel.
    const room = Math.max(margin, window.innerWidth - width - margin);
    panel.style.left = `${String(Math.min(Math.max(margin, icon.left), room))}px`;
    panel.style.top = `${String(icon.bottom + 6)}px`;
  }

  // Placed after it renders, because it has to be measured, and again whenever
  // the window changes shape under it.
  $effect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  });

  function show() {
    if (closing) clearTimeout(closing);
    closing = null;
    open = true;
  }
  function hide() {
    if (closing) clearTimeout(closing);
    closing = setTimeout(() => {
      open = false;
    }, 120);
  }

  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:document onclick={onDocClick} onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="info"
  bind:this={root}
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={show}
  onfocusout={hide}
>
  <button
    id="info-button"
    class="mark"
    bind:this={mark}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="About this page"
    onclick={show}
  >
    <Info size={15} />
  </button>
  {#if open}
    <div class="popover panel" id="info-panel" role="dialog" aria-label="Details" bind:this={panel}>
      <dl>
        <dt>Compiler</dt>
        <dd id="compiler-version" class="mono">{version || 'still loading…'}</dd>

        {#if backend.headers}
          <dt>Standard headers</dt>
          <dd id="header-config">
            {#if summary}
              <span class="mono">{summary}</span>
              {#if explanation}<p class="why">{explanation}</p>{/if}
            {:else}
              <span class="muted">nothing compiled yet</span>
            {/if}
          </dd>
        {/if}

        <dt>Target</dt>
        <dd class="mono">
          {store.options.lang === 'hylo' ? 'the one ABI Hylo describes' : store.options.triple}
        </dd>
      </dl>

      <p class="note">
        Layouts are computed by <a href={backend.home} rel="noopener">{backend.name}</a> itself,
        compiled to WebAssembly (<a href={backend.module.url} rel="noopener"
          >{backend.module.name}</a
        >). It runs in this tab: nothing you type leaves the page, and the whole thing works
        offline once the module has downloaded.
      </p>
      {#if store.offlineReady}<p id="offline-status" class="ok">✓ available offline</p>{/if}
    </div>
  {/if}
</div>

<style>
  .info {
    display: inline-flex;
    position: relative;
    align-items: center;
  }
  /* Not a button: it has no border, no background and no press state, because
     what it offers is reading rather than doing. It still *is* a button, so a
     keyboard and a touch screen can both reach it. */
  .mark {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: help;
  }
  .mark:hover,
  .mark:focus-visible {
    color: var(--text-secondary);
  }
  .mark:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  /* Fixed and placed by `place()`: see there for why measuring is the only
     thing that keeps it on the screen at both ends. `left`/`top` are set from
     script, so the shared `.popover` anchoring is overridden here. */
  .panel {
    position: fixed;
    right: auto;
    width: min(320px, calc(100vw - 16px));
    padding: 12px 14px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-secondary);
    text-align: left;
    cursor: default;
  }
  dl {
    margin: 0;
  }
  dt {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-top: 8px;
  }
  dt:first-child {
    margin-top: 0;
  }
  dd {
    margin: 2px 0 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .why {
    margin: 4px 0 0;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .muted {
    color: var(--text-muted);
  }
  .note {
    margin: 12px 0 0;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .ok {
    margin: 8px 0 0;
    color: var(--ok-ink);
    font-size: 11.5px;
  }
</style>
