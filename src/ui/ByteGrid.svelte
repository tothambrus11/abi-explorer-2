<script lang="ts">
  // Byte-grid memory map: one cell per byte (bit sub-cells where bit-fields
  // live, stripes where union members overlap, hatching for padding). Above
  // GRID_LIMIT bytes a proportional bar is drawn instead. Hover state comes
  // from the store; identity is also carried by the table, never color alone.
  import type { Leaf, RenderModel } from '$core/types';
  import { store, type MemberRef } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { memberTooltipHtml } from './format';

  const { model, record, session }: { model: RenderModel; record: string; session: Session } =
    $props();
  const GRID_LIMIT = 2048;
  const size = $derived(model.record.sizeBytes);
  const bpr = $derived(size <= 64 ? 8 : 16);
  const rows = $derived(Math.ceil(size / bpr));

  interface Cell {
    byte: number;
    leaves: number[]; // leaf indexes covering this byte
    bits: (number | null)[] | null; // per-bit owner when bit-fields touch this byte
    start: boolean;
    end: boolean;
    estimated: boolean;
  }

  const cells = $derived.by((): Cell[] => {
    const byByte = new Map<number, number[]>();
    const bitBytes = new Set<number>();
    model.leaves.forEach((leaf, li) => {
      if (leaf.sizeBits === 0) return;
      const from = Math.floor(leaf.offsetBits / 8);
      const to = Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8);
      for (let b = from; b < to; b++) {
        const list = byByte.get(b) ?? [];
        list.push(li);
        byByte.set(b, list);
        if (leaf.kind === 'bitfield') bitBytes.add(b);
      }
    });
    const out: Cell[] = [];
    for (let b = 0; b < size; b++) {
      const leaves = byByte.get(b) ?? [];
      let bits: (number | null)[] | null = null;
      if (bitBytes.has(b)) {
        bits = [];
        for (let bit = 0; bit < 8; bit++) {
          const idx = b * 8 + bit;
          const owner = leaves.find(
            (li) =>
              idx >= model.leaves[li]!.offsetBits &&
              idx < model.leaves[li]!.offsetBits + model.leaves[li]!.sizeBits,
          );
          bits.push(owner ?? null);
        }
      }
      const one = leaves.length === 1 ? model.leaves[leaves[0]!]! : null;
      out.push({
        byte: b,
        leaves,
        bits,
        start: leaves.some((li) => Math.floor(model.leaves[li]!.offsetBits / 8) === b),
        end: one ? Math.ceil((one.offsetBits + one.sizeBits) / 8) === b + 1 : false,
        estimated: one?.estimated ?? false,
      });
    }
    return out;
  });

  const hovered = $derived(
    new Set(store.hover.members.filter((m) => m.record === record).map((m) => m.leaf)),
  );

  function stripe(leaves: number[]): string {
    const colors = leaves.slice(0, 3).map((li) => `var(--${model.leaves[li]!.colorClass})`);
    return `repeating-linear-gradient(45deg, ${colors.map((c, i) => `${c} ${i * 4}px, ${c} ${(i + 1) * 4}px`).join(', ')})`;
  }

  function tooltipFor(
    leaf: Leaf,
    byte: number | null,
    el: Element,
  ): { html: string; x: number; y: number } {
    const r = el.getBoundingClientRect();
    const html = memberTooltipHtml(leaf, byte !== null ? `byte ${byte}` : undefined);
    return { html, x: r.left + r.width / 2, y: r.top };
  }

  function enter(li: number | null, byte: number | null, e: Event) {
    const el = e.currentTarget as Element;
    if (li === null) {
      const r = el.getBoundingClientRect();
      session.hoverMember(null, {
        html: `<strong>padding</strong><br>${byte !== null ? `byte ${byte}` : 'unused bytes'}`,
        x: r.left + r.width / 2,
        y: r.top,
      });
      return;
    }
    const ref: MemberRef = { record, leaf: li };
    session.hoverMember(ref, tooltipFor(model.leaves[li]!, byte, el));
  }
  const leave = () => {
    session.hoverMember(null, null);
  };
</script>

{#if size === 0}
  <div class="note">Zero-size record.</div>
{:else if size > GRID_LIMIT}
  <div class="note">
    Struct is {size.toLocaleString()} bytes — showing a proportional map instead of a byte grid.
  </div>
  <div class="bar" role="img" aria-label="proportional layout" onmouseleave={leave}>
    {#each [...model.leaves.map( (l, li) => ({ off: l.offsetBits, len: l.sizeBits, li }) ), ...model.paddings.map( (p) => ({ off: p.start * 8, len: (p.end - p.start) * 8, li: null }) )]
      .filter((s) => s.len > 0)
      .sort((a, b) => a.off - b.off) as seg (`${seg.off}:${seg.li ?? 'pad'}`)}
      <div
        class="seg {seg.li === null ? 'pad' : model.leaves[seg.li]!.colorClass}"
        class:hovered={seg.li !== null && hovered.has(seg.li)}
        style:flex-grow={Math.max(seg.len / model.sizeBits, 0.002) * 1000}
        role="presentation"
        onmouseenter={(e) => {
          enter(seg.li, null, e);
        }}
      ></div>
    {/each}
  </div>
{:else}
  <div class="grid-box">
    <div class="grid" style:--bpr={bpr} role="img" aria-label="byte grid" onmouseleave={leave}>
      <div class="corner"></div>
      {#each { length: bpr } as _, c (c)}<div class="col">+{c}</div>{/each}
      {#each { length: rows } as _, r (r)}
        <div class="row">{r * bpr}</div>
        {#each { length: bpr } as _, c (c)}
          {@const b = r * bpr + c}
          {#if b >= size}
            <div class="cell void"></div>
          {:else}
            {@const cell = cells[b]!}
            {#if cell.bits}
              <div class="cell bits" role="presentation">
                {#each cell.bits as owner, bit (bit)}
                  <div
                    class="bit {owner === null ? 'pad' : model.leaves[owner]!.colorClass}"
                    class:hovered={owner !== null && hovered.has(owner)}
                    class:start={owner !== null && b * 8 + bit === model.leaves[owner]!.offsetBits}
                    role="presentation"
                    onmouseenter={(e) => {
                      enter(owner, b, e);
                    }}
                  ></div>
                {/each}
              </div>
            {:else if cell.leaves.length === 0}
              <div
                class="cell pad"
                role="presentation"
                onmouseenter={(e) => {
                  enter(null, b, e);
                }}
              ></div>
            {:else if cell.leaves.length === 1}
              <div
                class="cell {model.leaves[cell.leaves[0]!]!.colorClass}"
                class:start={cell.start}
                class:end={cell.end}
                class:estimated={cell.estimated}
                class:hovered={hovered.has(cell.leaves[0]!)}
                role="presentation"
                onmouseenter={(e) => {
                  enter(cell.leaves[0]!, b, e);
                }}
              ></div>
            {:else}
              <div
                class="cell multi"
                class:start={cell.start}
                class:hovered={cell.leaves.some((li) => hovered.has(li))}
                style:background={stripe(cell.leaves)}
                role="presentation"
                onmouseenter={(e) => {
                  enter(cell.leaves[0]!, b, e);
                }}
              ></div>
            {/if}
          {/if}
        {/each}
      {/each}
    </div>
  </div>
{/if}

<style>
  .note {
    color: var(--text-secondary);
    font-size: 12.5px;
    margin-bottom: 8px;
  }
  .grid-box {
    overflow-x: auto;
    margin-bottom: 16px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(40px, auto) repeat(var(--bpr, 8), minmax(26px, 44px));
    width: max-content;
    font-size: 11px;
  }
  .corner,
  .col {
    height: 18px;
  }
  .col {
    color: var(--text-muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .row {
    color: var(--text-muted);
    text-align: right;
    padding-right: 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    font-variant-numeric: tabular-nums;
  }
  .cell {
    height: 30px;
    border: 1px solid var(--surface-1);
    border-radius: 3px;
    position: relative;
    cursor: default;
  }
  .cell.start {
    border-left: 2px solid var(--surface-1);
  }
  .void {
    visibility: hidden;
  }
  .pad {
    background:
      repeating-linear-gradient(45deg, transparent 0 4px, var(--baseline) 4px 6px), var(--grid-line);
    background-clip: padding-box;
  }
  .bits {
    display: flex;
    padding: 0;
    background: var(--grid-line);
  }
  .bit {
    flex: 1;
    border-right: 1px solid var(--surface-1);
  }
  .bit:last-child {
    border-right: none;
  }
  .bit.start {
    border-left: 2px solid var(--surface-1);
  }
  .bit.pad {
    background:
      repeating-linear-gradient(45deg, transparent 0 3px, var(--baseline) 3px 4px), var(--grid-line);
  }
  .estimated {
    outline: 2px dashed var(--baseline);
    outline-offset: -3px;
  }
  .hovered {
    box-shadow: inset 0 0 0 2px var(--text-primary);
    z-index: 1;
  }
  .bar {
    display: flex;
    width: 100%;
    height: 34px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .seg {
    min-width: 2px;
    border-right: 1px solid var(--surface-1);
  }
</style>
