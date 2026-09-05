<script lang="ts">
  // The shell: header, controls, and the dock the panels live in.
  //
  // `session` is the visit's state, threaded down rather than reached for, so a
  // second session would be a second `App` and nothing else. Everything here is
  // arrangement; the panels themselves are mounted by the dock.
  import { onMount, untrack } from 'svelte';
  import type { Session } from '$state/session.svelte';
  import { theme, applyThemeTokens } from '$state/theme.svelte';
  import { store } from '$state/store.svelte';
  import TopBar from '$ui/TopBar.svelte';
  import Controls from '$ui/Controls.svelte';
  import Tooltip from '$ui/Tooltip.svelte';
  import { mountDock, type Dock } from '$ui/dock';

  const { session }: { session: Session } = $props();
  $effect(() => {
    applyThemeTokens(theme.shown);
  });

  let dockHost: HTMLElement;
  let dock: Dock | null = $state(null);
  onMount(() => {
    dock = mountDock(dockHost, session);
    // For e2e tests and debugging, beside the store and the session.
    if (window.__abix) window.__abix.dock = dock;
    return () => dock?.dispose();
  });
  // theme.editorOpen -> floating panel; pickerDetached -> its own window
  $effect(() => {
    if (theme.editorOpen && dock) dock.openThemeEditor();
  });
  $effect(() => {
    // Phones never get a second window; the picker stays inline in the theme editor.
    if (dock) dock.setPickerDetached(theme.pickerDetached && !store.narrow);
  });
  // Sources come and go: their panels follow. Read as ids, so an edit inside
  // a source does not count as the list changing.
  $effect(() => {
    const ids = store.sources.map((s) => s.id);
    void ids;
    // Untracked: the sync reads what is shown and in focus, which have
    // effects of their own below, and must not re-run the whole pass for them.
    untrack(() => dock?.sync());
  });
  // The source in focus is brought forward wherever it has a panel; while
  // the pointer rests on a source's panel, that one is, without being chosen.
  $effect(() => {
    const id = store.shown.id;
    dock?.showSource(id);
  });
  // A renamed source is renamed on its tabs' titles too.
  $effect(() => {
    const names = store.sources.map((s) => s.name).join('\0');
    void names;
    dock?.refresh();
  });
</script>

<div class="app">
  <TopBar {session} {dock} />
  <!-- One source: its options are the visit's, in the row they have always
       been in. Several: each Source panel carries its own. -->
  {#if store.sources.length === 1}
    <Controls source={store.active} />
  {/if}
  <main class="dock" bind:this={dockHost}></main>
</div>
<Tooltip />

<style>
  .app {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  @media (max-width: 760px) {
    .dock {
      padding: 6px 8px;
    }
  }
  .dock {
    flex: 1;
    min-height: 0;
    padding: 10px 12px;
  }
</style>
