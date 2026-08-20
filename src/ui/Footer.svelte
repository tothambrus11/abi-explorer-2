<script lang="ts">
  import { store } from '$state/store.svelte';
  import { tooltip } from './tooltip';
  const version = $derived(
    store.compiler.state === 'ready' ? store.compiler.version.replace(/\(.*?\)\s*/, '') : '',
  );

  // Which standard headers answered the current query. Shown because it
  // changes what resolves: a target musl has no tree for gets portable C
  // declarations over this target's own scalar types, and no locale layer —
  // so <iostream> compiles on Linux and not on Darwin, and the reason should
  // not have to be guessed from the error.
  const headers = $derived(store.analysis?.headers ?? null);
  const headerNote = $derived.by(() => {
    const h = headers;
    if (!h?.cLibrary) return '';
    const tree = h.cLibraryArch === 'generic' ? 'portable' : (h.cLibraryArch ?? '');
    const cxx = h.cxxLibrary ? `${h.cxxLibrary} · ` : '';
    return `${cxx}${h.cLibrary}${tree ? ` (${tree})` : ''}`;
  });
  const headerWhy = $derived.by(() => {
    const h = headers;
    if (!h?.cLibrary) return null;
    if (h.cLibraryArch !== 'generic') {
      return `Standard headers for this target: ${h.cxxLibrary ?? 'none'} over musl's own ${h.cLibraryArch} tree — complete, including operating-system structures like struct stat.`;
    }
    const missing = [
      'operating-system headers such as <sys/stat.h>',
      ...(h.localization
        ? []
        : ["<locale> and <iostream>, whose implementation needs this platform's own locale API"]),
      ...(h.threads ? [] : ['<thread> and <mutex>: this target has no operating system']),
    ];
    return (
      `musl has no header tree for this target, so the C declarations are its portable ones over ` +
      `this target's own scalar types — every size and alignment is right for it. Not available here: ` +
      missing.join('; ') +
      '.'
    );
  });
</script>

<footer class="footer">
  <span id="clang-version" class="mono">{version}</span>
  {#if headerNote}<span id="header-config" class="mono wide" use:tooltip={headerWhy}
      >· {headerNote}</span
    >{/if}
  <span class="wide"
    >· layouts computed by <a href="https://llvm.org/" rel="noopener">clang</a> compiled to
    WebAssembly (<a href="https://github.com/tothambrus11/clang-abi-wasm" rel="noopener"
      >clang-abi-wasm</a
    >, Apache-2.0 w/ LLVM exception)</span
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

  /* Two different problems, two different rules.

     Short: a phone held sideways is 844 wide and 390 tall, so the width rule
     never fired and the full three-line footer took a quarter of the screen.
     It only needs to be flatter — there is width to spare.

     Narrow: a portrait phone has no width, so the prose goes. Which headers
     answered stays as long as it fits, because on a phone there is no tooltip
     to explain why `<iostream>` did not resolve. */
  @media (max-height: 560px) {
    .footer {
      padding: 4px 12px 6px;
      gap: 5px;
      font-size: 11.5px;
      flex-wrap: nowrap;
      overflow: hidden;
      white-space: nowrap;
    }
  }

  @media (max-width: 760px) {
    .footer {
      padding: 5px 12px 8px;
      gap: 6px;
      font-size: 11.5px;
    }
    .wide {
      display: none;
    }
  }
</style>
