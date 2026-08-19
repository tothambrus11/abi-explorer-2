<script lang="ts">
  import { store } from '$state/store.svelte';
  import { parseAnsi } from '$core/ansi';
  const ansi = $derived(store.analysis?.diagnosticsText ?? '');
  const spans = $derived(parseAnsi(ansi));
</script>

<div class="diagnostics">
  {#if ansi}
    <pre class="mono">{#each spans as s, i (i)}<span
          class:b={s.bold}
          class={s.color === null ? '' : `c${s.color}`}>{s.text}</span
        >{/each}</pre>
  {:else}
    <p class="empty">Clang is proud of you.</p>
  {/if}
</div>

<style>
  .diagnostics {
    height: 100%;
    overflow: auto;
    background: var(--surface-1);
    box-sizing: border-box;
  }
  .empty {
    margin: 0;
    padding: 10px 12px;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  pre {
    margin: 0;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }
  .b {
    font-weight: 700;
    color: var(--text-primary);
  }
  .c1,
  .c9 {
    color: var(--error);
  }
  .c2,
  .c10 {
    color: var(--ok-ink);
  }
  .c3,
  .c11 {
    color: var(--warn-ink);
  }
  .c4,
  .c12,
  .c6,
  .c14 {
    color: var(--accent);
  }
  .c5,
  .c13 {
    color: var(--diag-magenta, #b23fbf);
  }
  .c0,
  .c8 {
    color: var(--text-primary);
  }
  .c7,
  .c15 {
    color: var(--text-secondary);
  }
</style>
