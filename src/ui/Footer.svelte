<script lang="ts">
  import { store } from '$state/store.svelte';
  const version = $derived(
    store.compiler.state === 'ready' ? store.compiler.version.replace(/\(.*?\)\s*/, '') : '',
  );
</script>

<footer class="footer">
  <span id="clang-version" class="mono">{version}</span>
  <span class="wide"
    >· layouts computed by <a href="https://llvm.org/" rel="noopener">clang</a> compiled to
    WebAssembly (<a href="https://yowasp.org/" rel="noopener">YoWASP</a> build, Apache-2.0 w/ LLVM exception)</span
  >
  <span class="wide">· nothing you type leaves this page</span>
  {#if store.offlineReady}<span id="offline-status" class="ok">· ✓ available offline</span>{/if}
  {#if store.swVersionAvailable}
    <button
      class="btn small"
      onclick={() => {
        location.reload();
      }}>Update available — reload</button
    >
  {/if}
</footer>

<style>
  @media (max-width: 760px) {
    .footer {
      padding: 6px 12px 10px;
    }
    .wide {
      display: none;
    }
  }
  .footer {
    padding: 14px 20px 22px;
    color: var(--text-muted);
    font-size: 12px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .ok {
    color: var(--ok-ink);
  }
  .btn.small {
    padding: 2px 8px;
    font-size: 12px;
  }
</style>
