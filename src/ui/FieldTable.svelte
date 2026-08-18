<script lang="ts">
  import type { RenderModel } from '$core/types';
  import { buildLayoutTree, flattenVisible } from '$core/tree';
  import { store } from '$state/store.svelte';
  import { fmtOffset, type Session } from '$state/session.svelte';
  import { fmtSize, fmtGroupSize, memberTooltipHtml, groupTooltipHtml } from './format';

  const { model, record, session }: { model: RenderModel; record: string; session: Session } =
    $props();

  const tree = $derived(buildLayoutTree(model));
  // Collapsed node ids (default: everything expanded). Reassigned on toggle so
  // the derived flat list recomputes.
  let collapsed = $state(new Set<string>());
  const rows = $derived(flattenVisible(tree, collapsed));

  const hovered = $derived(
    new Set(store.hover.members.filter((m) => m.record === record).map((m) => m.leaf)),
  );
  /** A node is highlighted when all the leaves it covers are hovered. */
  function isHovered(indexes: number[]): boolean {
    return indexes.length > 0 && indexes.every((li) => hovered.has(li));
  }

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

  function toggle(id: string) {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    collapsed = next;
  }

  function anchor(e: Event): { x: number; y: number } {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }
  function enterLeaf(li: number, e: Event) {
    const { x, y } = anchor(e);
    session.hoverMember({ record, leaf: li }, { html: memberTooltipHtml(model.leaves[li]!), x, y });
  }
  function enterGroup(gi: number, e: Event) {
    const { x, y } = anchor(e);
    session.hoverGroup(record, gi, { html: groupTooltipHtml(model.groups[gi]!), x, y });
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
      {#each rows as { node, depth } (node.id)}
        {@const indent = 8 + depth * 16}
        {#if node.kind === 'leaf'}
          {@const leaf = model.leaves[node.ref]!}
          <tr
            class:hovered={hovered.has(node.ref)}
            onmouseenter={(e) => {
              enterLeaf(node.ref, e);
            }}
          >
            <td class="chip-col"><span class="chip {leaf.colorClass}"></span></td>
            <td class="name" style:padding-left="{indent}px">
              <span class="twist-gap"></span><span class="fname">{leaf.name}</span>
            </td>
            <td class="type">{leaf.kind === 'special' ? '—' : leaf.type}</td>
            <td class="num">{fmtOffset(leaf.offsetBits)}</td>
            <td class="num" class:est={leaf.estimated}>{fmtSize(leaf)}</td>
            <td class="num">{leaf.align ? `${leaf.align} B` : ''}</td>
            <td class="num pad">{padAfter.has(node.ref) ? `+${padAfter.get(node.ref)} B` : ''}</td>
          </tr>
        {:else}
          {@const group = model.groups[node.ref]!}
          {@const canCollapse = node.children.length > 0}
          <tr
            class="group"
            class:hovered={isHovered(node.leafIndexes)}
            onmouseenter={(e) => {
              enterGroup(node.ref, e);
            }}
          >
            <td class="chip-col"></td>
            <td class="name" style:padding-left="{indent}px">
              {#if canCollapse}
                <button
                  type="button"
                  class="twist"
                  aria-expanded={!collapsed.has(node.id)}
                  onclick={(e) => {
                    e.stopPropagation();
                    toggle(node.id);
                  }}>{collapsed.has(node.id) ? '▸' : '▾'}</button
                >
              {:else}
                <span class="twist-gap"></span>
              {/if}
              <span class="fname gname">{group.name}</span>
              {#if group.isBase}<span class="tag">base</span>{/if}
              {#if group.isUnion}<span class="tag union">union</span>{/if}
              {#if node.overlaps}<span class="tag overlap" title="shares bytes with a sibling"
                  >overlaps</span
                >{/if}
            </td>
            <td class="type">{group.type}</td>
            <td class="num">{fmtOffset(node.offsetBits)}</td>
            <td class="num">{fmtGroupSize(node.sizeBits)}</td>
            <td class="num">{node.align ? `${node.align} B` : ''}</td>
            <td class="num"></td>
          </tr>
        {/if}
      {/each}
      {#each model.markers as m, i (i)}
        {#if m.kind === 'zero-bitfield'}
          <tr class="marker">
            <td class="chip-col"></td>
            <td class="name" style:padding-left="{8 + m.path.length * 16}px">
              <span class="twist-gap"></span><span class="fname muted"
                >{m.type ?? ''} :0 (unit break)</span
              >
            </td>
            <td class="type"></td><td class="num">{fmtOffset(m.offsetBits)}</td><td class="num"
              >0 b</td
            ><td class="num"></td><td class="num"></td>
          </tr>
        {/if}
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
  tr.group .gname {
    font-weight: 600;
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
  .name {
    white-space: nowrap;
  }
  .twist,
  .twist-gap {
    display: inline-block;
    width: 14px;
    text-align: center;
    color: var(--text-muted);
  }
  .twist {
    border: none;
    background: none;
    padding: 0;
    font-size: 10px;
    cursor: pointer;
    font-family: inherit;
  }
  .twist:hover {
    color: var(--text);
  }
  .fname {
    font-family: var(--font-mono);
  }
  .tag {
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--text-muted) 16%, transparent);
    vertical-align: 1px;
  }
  .tag.union {
    color: var(--c-3);
    background: color-mix(in srgb, var(--c-3) 18%, transparent);
  }
  .tag.overlap {
    color: var(--c-2);
    background: color-mix(in srgb, var(--c-2) 18%, transparent);
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
