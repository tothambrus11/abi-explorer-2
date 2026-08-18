<script lang="ts">
  import ThemeMenu from './ThemeMenu.svelte';
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import type { Session } from '$state/session.svelte';
  const { session, onResetLayout }: { session: Session; onResetLayout: () => void } = $props();
  import { tooltip } from './tooltip';
  let copied = $state<'idle' | 'ok' | 'fail'>('idle');
  async function share() {
    try {
      // Encode the current state now: the address bar lags behind (debounced).
      await navigator.clipboard.writeText(await session.shareUrl());
      copied = 'ok';
    } catch {
      copied = 'fail';
    }
    setTimeout(() => (copied = 'idle'), 1500);
  }
</script>

<header class="topbar">
  <div class="brand">
    <img class="brand-mark" src="/icons/icon.svg" alt="" width="20" height="20" />
    <h1>ABI Explorer</h1>
  </div>
  <div class="actions">
    <button
      class="icon-btn"
      onclick={onResetLayout}
      aria-label="Reset panel layout"
      use:tooltip={'Reset panel layout'}><LayoutTemplate size={16} /></button
    >
    <ThemeMenu />
    <button
      class="btn"
      onclick={share}
      use:tooltip={'Copy a link that encodes the code and all options'}
    >
      {copied === 'ok' ? 'Copied!' : copied === 'fail' ? 'Copy failed' : 'Share'}
    </button>
  </div>
</header>

<style>
  @media (max-width: 760px) {
    .topbar {
      padding: 8px 12px;
    }
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 10px 20px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 {
    font-size: 17px;
    margin: 0;
    font-weight: 650;
  }
  .brand-mark {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    image-rendering: -webkit-optimize-contrast;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
</style>
