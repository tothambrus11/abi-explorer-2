<script lang="ts">
  import { store } from '$state/store.svelte';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { tooltip } from './tooltip';

  const kind = $derived(store.status.kind);
  const title = $derived.by(() => {
    switch (store.status.kind) {
      case 'idle':
        return '';
      case 'running':
        return 'compiling…';
      case 'ok':
        return store.status.warnings ? 'compiled with warnings' : 'compiled';
      case 'error':
        return store.status.message;
    }
  });
  const warn = $derived(store.status.kind === 'ok' && store.status.warnings);
</script>

<span
  class="status {kind}"
  class:warn
  role="status"
  aria-live="polite"
  aria-label={title}
  use:tooltip={title}
  tabindex="-1"
>
  {#if kind === 'running'}
    <LoaderCircle size={16} class="spin" />
  {:else if kind === 'ok'}
    <Check size={16} />
  {:else if kind === 'error'}
    <X size={16} />
  {/if}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    margin-right: 6px;
    min-height: 20px;
    color: var(--text-muted);
  }
  .status.running {
    color: var(--accent);
  }
  .status.ok {
    color: #33d17a;
  }
  .status.ok.warn {
    color: var(--warn-ink);
  }
  .status.error {
    color: #e01b24;
  }
  .status :global(.spin) {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status :global(.spin) {
      animation-duration: 2s;
    }
  }
</style>
