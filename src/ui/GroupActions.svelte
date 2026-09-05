<script lang="ts">
  // The right end of a group's tab bar: the examples, in any group that holds
  // a Source panel. The "+" is at the other end of the strip, against the tabs,
  // where what it adds is not read as an example.
  //
  // These used to sit in a row of their own above the editor, which on a
  // phone was a fifth of the editor's height spent on a select that is
  // pressed once a visit. The tab bar has the room, and it is where the
  // reader is already looking when they think about what to open.
  import type { DockviewGroupPanel } from 'dockview';
  import { store, type Source } from '$state/store.svelte';
  import { EXAMPLES } from '$core/targets';
  import { LANGUAGE_NAMES, type Language } from '$core/options';
  import { parsePanelId } from './panels';
  import { tooltip } from './tooltip';

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

  /**
   * The examples, grouped by the language they are written in.
   *
   * Grouped rather than filtered to the selected language: an example is an
   * explicit act, and one written in a language you are not in is still one you
   * might want. Filtering hid every C++ example from someone in C, which is
   * where most visitors start. Loading one switches to its language, because
   * that is the language it is an example of.
   */
  const grouped = (['c', 'c++', 'hylo'] as const satisfies readonly Language[])
    .map((lang) => ({
      lang,
      label: LANGUAGE_NAMES[lang],
      items: EXAMPLES.map((ex, i) => ({ ex, i })).filter((e) => e.ex.lang === lang),
    }))
    .filter((g) => g.items.length > 0);

  function loadExample(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    const source = target();
    if (sel.value !== '' && source) source.loadExample(Number(sel.value));
    sel.value = '';
  }
</script>

{#if visible}
  <div class="actions">
    <select
      class="input small example"
      aria-label="Load an example"
      onchange={loadExample}
      use:tooltip={'Load an example (replaces the code)'}
    >
      <option value="">Examples…</option>
      {#each grouped as g (g.lang)}
        <optgroup label={g.label}>
          {#each g.items as e (e.ex.name)}<option value={e.i}>{e.ex.name}</option>{/each}
        </optgroup>
      {/each}
    </select>
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
  .example {
    max-width: 9em;
  }
</style>
