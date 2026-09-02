<script lang="ts">
  // The shell: header, controls, and the dock the panels live in.
  //
  // `session` is the tab's state, threaded down rather than reached for, so a
  // second session would be a second `App` and nothing else. Everything here is
  // arrangement; the panels themselves are mounted by the dock.
  import { onMount } from 'svelte';
  import type { Session } from '$state/session.svelte';
  import { theme, applyThemeTokens } from '$state/theme.svelte';
  import { store } from '$state/store.svelte';
  import TopBar from '$ui/TopBar.svelte';
  import Controls from '$ui/Controls.svelte';
  import Tooltip from '$ui/Tooltip.svelte';
  import { mountDock, type Dock } from '$ui/dock';

  const { session }: { session: Session } = $props();
  $effect(() => {
    applyThemeTokens(theme.current);
  });

  let dockHost: HTMLElement;
  let dock: Dock | null = $state(null);
  onMount(() => {
    dock = mountDock(dockHost, session);
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
</script>

<div class="app">
  <TopBar {session} onResetLayout={() => dock?.resetLayout()} />
  <Controls />
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
