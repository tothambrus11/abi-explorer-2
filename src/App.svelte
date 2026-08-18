<script lang="ts">
  import { onMount } from 'svelte';
  import type { Session } from '$state/session.svelte';
  import { theme, applyThemeTokens } from '$state/theme.svelte';
  import TopBar from '$ui/TopBar.svelte';
  import Controls from '$ui/Controls.svelte';
  import Tooltip from '$ui/Tooltip.svelte';
  import Footer from '$ui/Footer.svelte';
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
    if (dock) dock.setPickerDetached(theme.pickerDetached);
  });
</script>

<div class="app">
  <TopBar {session} onResetLayout={() => dock?.resetLayout()} />
  <Controls />
  <main class="dock" bind:this={dockHost}></main>
  <Footer />
</div>
<Tooltip />

<style>
  .app {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  .dock {
    flex: 1;
    min-height: 0;
    padding: 10px 12px;
  }
</style>
