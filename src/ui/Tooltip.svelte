<script lang="ts">
  // The single floating tooltip, positioned near whatever is hovered.
  //
  // Mounted once, at the top of the app, and driven entirely by
  // `store.hover.tooltip`: anything that wants a tooltip sets that, rather than
  // rendering its own, so two hovers can never leave two tips on screen.
  // Clamped to the viewport, and flipped below the cursor when there is no room
  // above.
  import { store } from '$state/store.svelte';
  let el: HTMLDivElement | undefined = $state();
  const tip = $derived(store.hover.tooltip);
  const pos = $derived.by(() => {
    if (!tip || !el) return { x: 0, y: 0 };
    const tw = el.offsetWidth,
      th = el.offsetHeight;
    let x = tip.x - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    let y = tip.y - th - 8;
    if (y < 8) y = tip.y + 30;
    return { x, y };
  });
</script>

{#if tip}
  <div
    class="abix-tip rich"
    bind:this={el}
    style:left="{pos.x}px"
    style:top="{pos.y}px"
    role="tooltip"
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- built by memberTooltipHtml (escaped) -->
    {@html tip.html}
  </div>
{/if}

<style>
  .rich {
    max-width: 360px;
    padding: 8px 10px;
  }
</style>
