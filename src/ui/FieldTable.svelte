<script lang="ts">
  import type { RenderModel } from '$core/types';
  import { store } from '$state/store.svelte';
  import { fmtOffset, type Session } from '$state/session.svelte';
  import { fmtSize, memberTooltipHtml } from './format';

  const { model, record, session }: { model: RenderModel; record: string; session: Session } =
    $props();
  const hovered = $derived(
    new Set(store.hover.members.filter((m) => m.record === record).map((m) => m.leaf)),
  );

  /** Padding run attributed to the leaf ending closest before it. */
  const padAfter = $derived.by(() => {
    const out = new Map<number, number>();
    for (const p of model.paddings) {
      let best = -1,
        bestEnd = -1;
      model.leaves.forEach((leaf, i) => {
        const end = leaf.offsetBits + leaf.sizeBits;
        if (end <= p.start * 8 && end > bestEnd) {
          bestEnd = end;
          best = i;
        }
      });
      if (best >= 0) out.set(best, (out.get(best) ?? 0) + (p.end - p.start));
    }
    return out;
  });

  function enter(li: number, e: Event) {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const html = memberTooltipHtml(model.leaves[li]!);
    session.hoverMember({ record, leaf: li }, { html, x: r.left + r.width / 2, y: r.top });
  }
  const leave = () => {
    session.hoverMember(null, null);
  };
</script>

<div class="table-box">
  <table class="field-table">
    <thead
      ><tr
        ><th></th><th>Field</th><th>Type</th><th>Offset</th><th>Size</th><th>Align</th><th
          >Padding after</th
        ></tr
      ></thead
    >
    <tbody onmouseleave={leave}>
      {#each model.leaves as leaf, li (li)}
        <tr
          class:hovered={hovered.has(li)}
          onmouseenter={(e) => {
            enter(li, e);
          }}
        >
          <td class="chip-col"><span class="chip {leaf.colorClass}"></span></td>
          <td class="name" style:padding-left="{8 + leaf.depth * 16}px">
            {#if leaf.path.length}<span class="crumb">{leaf.path.join(' » ')} » </span>{/if}<span
              class="fname">{leaf.name}</span
            >
          </td>
          <td class="type">{leaf.kind === 'special' ? '—' : leaf.type}</td>
          <td class="num">{fmtOffset(leaf.offsetBits)}</td>
          <td class="num" class:est={leaf.estimated}>{fmtSize(leaf)}</td>
          <td class="num">{leaf.align ?? ''}</td>
          <td class="num pad">{padAfter.has(li) ? `+${padAfter.get(li)} B` : ''}</td>
        </tr>
      {/each}
      {#each model.markers as m, i (i)}
        <tr class="marker">
          <td class="chip-col"></td>
          <td class="name" style:padding-left="{8 + m.path.length * 16}px">
            <span class="fname muted"
              >{m.kind === 'empty-base'
                ? `${m.name} (empty base)`
                : `${m.type ?? ''} :0 (unit break)`}</span
            >
          </td>
          <td class="type"></td><td class="num">{fmtOffset(m.offsetBits)}</td><td class="num">0</td
          ><td class="num"></td><td class="num"></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-box {
    overflow-x: auto;
  }
  .field-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  th {
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px 10px;
    border-bottom: 1px solid var(--baseline);
  }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--grid-line);
  }
  tr.hovered td {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .chip-col {
    width: 20px;
  }
  .chip {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .crumb {
    color: var(--text-muted);
    font-size: 12px;
  }
  .fname {
    font-family: var(--font-mono);
  }
  .type {
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .num.est {
    color: var(--text-muted);
  }
  .pad {
    color: var(--c-2);
  }
  .muted {
    color: var(--text-muted);
  }
</style>
