<script lang="ts">
  // The right end of a group's tab bar: the examples, in any group that holds
  // a Source panel. The "+" is at the other end of the strip, against the tabs,
  // where what it adds is not read as an example.
  //
  // These used to sit in a row of their own above the editor, which on a
  // phone was a fifth of the editor's height spent on a select that is
  // pressed once a visit. The tab bar has the room, and it is where the
  // reader is already looking when they think about what to open.
  //
  // Except on a phone, where the strip's room is the tabs' and a select
  // beside them crowded out the source they name. There the examples are in
  // the view panel instead; see `ViewMenu`.
  import type { DockviewGroupPanel } from 'dockview';
  import { store, type Source } from '$state/store.svelte';
  import { parsePanelId } from './panels';
  import Examples from './Examples.svelte';

  const { group }: { group: DockviewGroupPanel } = $props();

  /** Whether the group holds a Source panel; the dock says, after every change. */
  let visible = $state(false);
  export function refresh(): void {
    visible = group.panels.some((p) => parsePanelId(p.id)?.kind === 'editor');
  }

  /**
   * The source an example loads into: the group's Source panel, the one on
   * screen if there are several.
   */
  function target(): Source | null {
    const active = group.activePanel;
    const panel =
      active && parsePanelId(active.id)?.kind === 'editor'
        ? active
        : group.panels.find((p) => parsePanelId(p.id)?.kind === 'editor');
    const id = panel ? parsePanelId(panel.id)?.sourceId : undefined;
    return id === undefined ? null : (store.sources.find((s) => s.id === id) ?? null);
  }
</script>

{#if visible && !store.narrow}
  <div class="actions">
    <Examples
      pick={(i: number) => {
        target()?.loadExample(i);
      }}
    />
  </div>
{/if}

<style>
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 100%;
    padding: 0 6px 0 4px;
  }
  /* Never more of the screen than this: the strip is for the tabs, and a
     select that grows with the longest example's name pushed them out. */
  .actions :global(.example) {
    max-width: min(9em, 40vw);
  }
</style>
