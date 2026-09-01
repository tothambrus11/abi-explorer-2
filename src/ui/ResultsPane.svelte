<script lang="ts">
  import { store } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { bundle } from '$state/download-gate';
  import { backendFor } from '$compiler/Backends';
  import RecordSection from './RecordSection.svelte';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import PanelTop from '@lucide/svelte/icons/panel-top';
  import { tooltip } from './tooltip';

  const { session }: { session: Session } = $props();
  // From the module's manifest, so this and the progress bar below it are the
  // same number rather than two guesses at it. 0 until it is known.
  let downloadMb = $state(0);
  $effect(() => {
    // The figure follows the language: the two modules are different sizes,
    // and quoting clang's while Hylo is downloading would be the same lie the
    // hard-coded "~11 MB" used to be.
    void bundle(backendFor(store.options.lang)).then((b) => {
      if (b) downloadMb = Math.round(b.bytes / 1048576);
    });
  });
  const loading = $derived(store.compiler.state !== 'ready');
  const stacked = $derived(store.view === 'stack');
  const empty = $derived(store.analysis !== null && store.visibleRecords.length === 0);
  const mb = (n: number) => (n / 1048576).toFixed(0);
  const loadText = $derived.by(() => {
    const c = store.compiler;
    switch (c.state) {
      case 'idle':
        return 'Starting…';
      case 'loading':
        if (c.phase === 'compile') return 'Preparing clang…';
        // No total means the worker could not read the manifest and let
        // Emscripten fetch the files itself. Say what is happening rather than
        // invent a percentage.
        return c.total
          ? `Downloading clang (wasm)… ${mb(c.done)} of ${mb(c.total)} MB`
          : 'Downloading clang (wasm)…';
      case 'ready':
        return '';
      case 'failed':
        return `Failed to load clang: ${c.message}`;
    }
  });
  /** Null when there is nothing honest to fill a bar with. */
  const loadPct = $derived.by(() => {
    const c = store.compiler;
    if (c.state !== 'loading' || !c.total) return null;
    return Math.min(100, Math.round((100 * c.done) / c.total));
  });
</script>

<section class="pane">
  {#if store.awaitingDownloadConsent}
    <!-- Metered connection: don't spend the user's data without asking (issue #1). -->
    <div class="loading consent">
      <p id="consent-text">
        You appear to be on a metered or slow connection. Analysing layouts needs a one-time
        {#if downloadMb}<strong>~{downloadMb} MB</strong>{/if} download of clang (cached afterwards, and
        the app then works offline).
      </p>
      <button
        id="allow-download"
        class="allow"
        onclick={() => {
          session.allowDownload();
        }}>Download clang{downloadMb ? ` (${String(downloadMb)} MB)` : ''}</button
      >
    </div>
  {:else if loading}
    <div class="loading" class:failed={store.compiler.state === 'failed'}>
      <div class="track">
        {#if loadPct === null}
          <div class="fill indeterminate"></div>
        {:else}
          <div class="fill" style:width="{loadPct}%"></div>
        {/if}
      </div>
      <p id="load-text">{loadText}</p>
      {#if downloadMb}
        <p class="note">~{downloadMb} MB on first visit, then served from browser cache.</p>
      {/if}
    </div>
  {:else if !store.analysis}
    <!-- No analysis yet: idle/running (first compile pending) or the first compile failed outright. -->
    {#if store.status.kind === 'error'}
      <p class="empty" id="empty-note">{store.status.message}</p>
    {:else}
      <div class="loading"><p>Compiling…</p></div>
    {/if}
  {:else if empty}
    <p class="empty" id="empty-note">
      {store.analysis?.code === 0
        ? 'No struct/class/union definitions found. Define one in the editor, and make sure templates are instantiated.'
        : 'Compilation failed. Fix the errors below.'}
    </p>
  {:else if store.analysis}
    <div id="results">
      <div class="bar">
        <div id="record-chips" class="chips" role="tablist" hidden={stacked}>
          {#each store.visibleRecords as entry (entry.key)}
            {@const key = entry.key}
            {@const rec = entry.record}
            <button
              class="chip"
              class:selected={key === store.activeRecordKey}
              role="tab"
              aria-selected={key === store.activeRecordKey}
              onclick={() => {
                session.selectRecord(key);
              }}
              ><span class="kind">{rec.kind}</span>
              {rec.name} <span class="size">{rec.sizeBytes} B</span></button
            >
          {/each}
        </div>
        <button
          id="view-toggle"
          class="icon-btn"
          type="button"
          aria-pressed={stacked}
          use:tooltip={stacked ? 'Show one record at a time (tabs)' : 'Show all records stacked'}
          aria-label="Toggle between tabs and stacked view"
          onclick={() => {
            store.toggleView();
          }}
        >
          {#if stacked}<PanelTop size={16} />{:else}<Rows3 size={16} />{/if}
        </button>
      </div>
      <div id="sections">
        {#each store.sections as section (section.key)}
          <RecordSection {section} {session} />
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .pane {
    height: 100%;
    overflow: auto;
    background: var(--surface-1);
    padding: 12px 14px;
    box-sizing: border-box;
  }
  .loading {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-secondary);
  }
  .loading.failed {
    color: var(--error);
  }
  .track {
    height: 8px;
    border-radius: 4px;
    background: var(--grid-line);
    overflow: hidden;
    max-width: 420px;
    margin: 0 auto 14px;
  }
  .fill {
    height: 100%;
    width: 0;
    background: var(--accent);
    transition: width 0.2s;
  }
  /* No size to count against: sweep rather than sit at zero. */
  .fill.indeterminate {
    width: 35%;
    transition: none;
    animation: sweep 1.1s ease-in-out infinite;
  }
  @keyframes sweep {
    0% {
      margin-left: -35%;
    }
    100% {
      margin-left: 100%;
    }
  }
  /* The bar is saying "something is happening", and so does the text beside
     it. A moving stripe is not worth overriding someone's stated preference. */
  @media (prefers-reduced-motion: reduce) {
    .fill.indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.35;
    }
  }
  .note {
    color: var(--text-muted);
    font-size: 12px;
  }
  .consent {
    max-width: 42ch;
    margin: 0 auto;
    text-align: center;
  }
  .consent p {
    color: var(--text-secondary);
  }
  .allow {
    font: inherit;
    font-weight: 600;
    color: var(--accent-ink, #fff);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 7px 14px;
    cursor: pointer;
  }
  .allow:hover {
    filter: brightness(1.08);
  }
  .allow:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .empty {
    color: var(--text-secondary);
    padding: 24px 8px;
  }
  .bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    flex: 1;
  }
  .chips[hidden] {
    display: none;
  }
  .chip {
    font: inherit;
    font-size: 12.5px;
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--page);
    color: var(--text-primary);
  }
  .chip .kind {
    color: var(--text-muted);
  }
  .chip .size {
    color: var(--text-secondary);
  }
  .chip.selected {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .chip.selected .kind {
    color: var(--accent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  #sections > :global(section + section) {
    margin-top: 28px;
    padding-top: 22px;
    border-top: 1px solid var(--grid-line);
  }
</style>
