<script lang="ts">
  // A dock tab that carries the panel's own state.
  //
  // Both panels had a second place saying the same thing: whether the code
  // compiled lived in a strip above the editor, and how many diagnostics there
  // are was only discoverable by opening the tab. On a phone, where Layout and
  // Diagnostics share a group, that meant switching tabs to find out there was
  // nothing to see. Put it where the tab already is.
  import { store } from '$state/store.svelte';
  import { tooltip } from './tooltip';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  const { title, kind, close }: { title: string; kind: 'status' | 'count'; close: () => void } =
    $props();

  const status = $derived(store.status.kind);
  const warn = $derived(store.status.kind === 'ok' && store.status.warnings);
  // The same wording the strip above the editor used: this is a live region,
  // and moving it must not cost a screen reader the sentence it was reading.
  const statusText = $derived.by(() => {
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
  // Notes are not findings. They are the second half of the finding above
  // them, and counting them makes one warning read as [3].
  const count = $derived(
    store.analysis?.diagnostics.filter((d) => d.severity !== 'note' && d.severity !== 'remark')
      .length ?? 0,
  );
</script>

<span class="tab">
  {#if kind === 'status'}
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
  <span class="title">{title}</span>
  {#if kind === 'count' && count > 0}
    <span class="count" class:bad={status === 'error'} class:warn={status === 'ok' && warn}
      >[{count}]</span
    >
  {/if}
  <button
    class="close"
    type="button"
    aria-label="Close {title}"
    onclick={(e) => {
      e.stopPropagation();
      close();
    }}><X size={13} /></button
  >
</span>

<style>
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    background: var(--surface-2);
  }
</style>
