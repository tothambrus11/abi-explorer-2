<script lang="ts">
  import ThemeMenu from './ThemeMenu.svelte';
  import { store } from '$state/store.svelte';
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
    {#if store.swVersionAvailable}
      <!-- A new build is cached and waiting. This was the footer's, and the
           footer is gone; it is the one thing there that asked to be acted on
           rather than read, so it cannot live inside a popover. -->
      <button
        class="btn small"
        onclick={() => {
          location.reload();
        }}>Update available: reload</button
      >
    {/if}
    <ThemeMenu />
    <a
      class="icon-btn"
      href="https://github.com/tothambrus11/abi-explorer-2"
      target="_blank"
      rel="noopener"
      aria-label="Source on GitHub"
      use:tooltip={'Source on GitHub'}
    >
      <!-- Lucide dropped brand marks, and this one is worth having by name. -->
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
        <path
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
             0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
             -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
             .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
             -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0
             1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82
             1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
             1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        />
      </svg>
    </a>
    <button
      class="btn share"
      onclick={share}
      use:tooltip={'Copy a link that encodes the code and all options'}
    >
      {copied === 'ok' ? 'Copied!' : copied === 'fail' ? 'Copy failed' : 'Share'}
    </button>
  </div>
</header>

<style>
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
    /* The anchor every popover in here hangs off. Its right edge is the bar's
       content edge, so a menu right-aligned to it can never start off-screen.
       Anchored to its own button, each menu could and did. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* One row, always. The brand and the actions are two flex items in a
     wrapping bar, so on a phone the actions dropped to a line of their own:
     44px of a 844px-tall screen spent on a second row that had room beside
     the title. The wordmark goes instead. The mark next to it says the same
     thing, and the page title says it in the tab. */
  @media (max-width: 760px) {
    .topbar {
      padding: 6px 10px;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .actions {
      gap: 6px;
    }
    h1 {
      font-size: 0;
    }
    h1::after {
      content: 'ABI';
      font-size: 15px;
      font-weight: 650;
    }
  }
  @media (max-width: 420px) {
    h1 {
      display: none;
    }
  }
</style>
