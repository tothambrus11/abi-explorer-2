<script lang="ts">
  // The "+" that opens another source, at the right-hand end of the tabs.
  //
  // Beside the tabs rather than beside the examples select: next to a control
  // that loads an example it read as "add an example", and what it adds is a
  // source. Dockview's left action slot sits immediately after the tab strip
  // and outside the box the tabs scroll in, so it stays on screen when there
  // are more tabs than fit.
  import type { DockviewGroupPanel } from 'dockview';
  import { store } from '$state/store.svelte';
  import { MAX_BUFFERS } from '$core/url-state';
  import { parsePanelId } from './panels';
  import { tooltip } from './tooltip';
  import Plus from '@lucide/svelte/icons/plus';

  /** `addSource` opens a source whose Source panel lands in this group. */
  const { group, addSource }: { group: DockviewGroupPanel; addSource: () => void } = $props();

  /** Whether the group holds a Source panel; the dock says, after every change. */
  let visible = $state(false);
  export function refresh(): void {
    visible = group.panels.some((p) => parsePanelId(p.id)?.kind === 'editor');
  }
</script>

{#if visible && store.sources.length < MAX_BUFFERS}
  <button
    type="button"
    class="add"
    aria-label="Add source"
    onclick={addSource}
    use:tooltip={'Add source'}
  >
    <Plus size={14} />
  </button>
{/if}

<style>
  .add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin: 0 2px 0 4px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .add:hover {
    color: var(--text-primary);
    background: var(--hover);
    border-color: var(--accent);
  }
</style>
