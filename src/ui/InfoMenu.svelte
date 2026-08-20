<script lang="ts">
  // What answered the current query, and what this thing is.
  //
  // The footer said all of it, and the footer is the first casualty of a phone:
  // three lines of prose across the bottom of a 390px screen is a quarter of
  // the viewport spent on text nobody is reading twice. It says the short
  // version on a wide screen and nothing on a narrow one; this says the long
  // version wherever it is asked for.
  import Info from '@lucide/svelte/icons/info';
  import { store } from '$state/store.svelte';
  import { headerSummary, headerExplanation } from '$core/headers';
  import { tooltip } from './tooltip';

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const version = $derived(
    store.compiler.state === 'ready' ? store.compiler.version.replace(/\(.*?\)\s*/, '') : '',
  );
  const headers = $derived(store.analysis?.headers ?? null);
  const summary = $derived(headerSummary(headers));
  const explanation = $derived(headerExplanation(headers));

  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:document onclick={onDocClick} onkeydown={onKey} />

<div class="info" bind:this={root}>
  <button
    id="info-button"
    class="icon-btn"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="About this page"
    use:tooltip={'clang version, which headers answered, and what this is'}
    onclick={() => (open = !open)}
  >
    <Info size={16} />
  </button>
  {#if open}
    <div class="popover panel" id="info-panel" role="dialog" aria-label="Details">
      <dl>
        <dt>Compiler</dt>
        <dd class="mono">{version || 'still loading…'}</dd>

        <dt>Standard headers</dt>
        <dd>
          {#if summary}
            <span class="mono">{summary}</span>
            {#if explanation}<p class="why">{explanation}</p>{/if}
          {:else}
            <span class="muted">nothing compiled yet</span>
          {/if}
        </dd>

        <dt>Target</dt>
        <dd class="mono">{store.options.triple}</dd>
      </dl>

      <p class="note">
        Layouts are computed by <a href="https://llvm.org/" rel="noopener">clang</a> itself,
        compiled to WebAssembly (<a
          href="https://github.com/tothambrus11/clang-abi-wasm"
          rel="noopener">clang-abi-wasm</a
        >, Apache-2.0 with LLVM exception). It runs in this tab: nothing you type leaves the page,
        and the whole thing works offline once the module has downloaded.
      </p>
      {#if store.offlineReady}<p class="ok">✓ available offline</p>{/if}
    </div>
  {/if}
</div>

<style>
  .info {
    display: inline-flex;
  }
  .panel {
    width: 320px;
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
