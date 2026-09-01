<script lang="ts">
  import type { RenderModel } from '$core/types';
  import { flattenVisible, groupColorClass } from '$core/render';
  import { store } from '$state/store.svelte';
  import { fmtOffset, type Session } from '$state/session.svelte';
  import { fmtSize, fmtGroupSize, memberTooltipHtml, groupTooltipHtml } from './format';
  import { tooltip } from './tooltip';

  const HEAD = {
    offset: 'Bytes from the start of this record to where the member begins.',
    size:
      'Bytes the member occupies inside this record. Not always sizeof(its type): a base ' +
      'can have its tail padding reused, an empty member sharing an address occupies none, ' +
      'and a bit-field is measured in bits.',
    align: 'The address boundary this member must start on.',
    pad: 'Bytes between the end of this member and the start of the next one.',
  };

  /** One nesting level in pixels, and also the width of the twisty column, so a
      guide line runs down the middle of it. Mirrored by `--indent` in the CSS. */
  const INDENT = 16;

  const { model, record, session }: { model: RenderModel; record: string; session: Session } =
    $props();

  // Collapsed node ids (default: everything expanded). Reassigned on toggle so
  // the derived flat list recomputes.
  let collapsed = $state(new Set<string>());
  const rows = $derived(flattenVisible(model.tree, collapsed));

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
  /** Drill into a compound member: inspect the record it is an instance of. */
  function openGroup(gi: number) {
    session.inspectGroup(record, gi);
  }
  const leave = () => {
    session.hoverMember(null, null);
  };
</script>

<div class="table-box">
  <table class="field-table">
    <thead
      ><tr
        ><th></th><th>Field</th><th>Type</th><th><span use:tooltip={HEAD.offset}>Offset</span></th
        ><th><span use:tooltip={HEAD.size}>Size</span></th><th
          ><span use:tooltip={HEAD.align}>Align</span></th
        ><th><span use:tooltip={HEAD.pad}>Padding after</span></th></tr
      ></thead
    >
    <tbody onmouseleave={leave}>
      {#each rows as { node, depth } (node.id)}
        {@const indent = 8 + depth * INDENT}
        {#if node.kind === 'leaf'}
          {@const leaf = model.leaves[node.ref]!}
          <tr
            class:hovered={hovered.has(node.ref)}
            onmouseenter={(e) => {
              enterLeaf(node.ref, e);
            }}
          >
            <td class="chip-col">
              <!-- A chip marks a member of *this* record: its own fields, and
                   the ones it inherits. What lives inside a named compound
                   member is coloured by the unit above it instead. -->
              {#if leaf.direct}<span class="chip {leaf.colorClass}"></span>{/if}
            </td>
            <td class="name" style:padding-left="{indent}px" style:--depth={depth}>
              <div class="nest">
                <span class="twist-gap"></span><span class="fname">{leaf.name}</span>
              </div>
            </td>
            <td class="type">{leaf.kind === 'special' ? '-' : leaf.type}</td>
            <td class="num">{fmtOffset(leaf.offsetBits)}</td>
            <td
              class="num"
              class:noted={leaf.sharesAddress}
              use:tooltip={leaf.sharesAddress
                ? 'Its type is empty and it shares an address with another member, so it occupies no bytes, though sizeof(its type) is still 1.'
                : null}>{fmtSize(leaf)}</td
            >
            <td class="num">{leaf.align ? `${leaf.align} B` : ''}</td>
            <td class="num pad">{padAfter.has(node.ref) ? `+${padAfter.get(node.ref)} B` : ''}</td>
          </tr>
        {:else}
          {@const group = model.groups[node.ref]!}
          {@const canCollapse = node.children.length > 0}
          {@const unitColour = group.direct ? groupColorClass(model, group) : null}
          {@const full = group.typeSizeBits}
          {@const short = node.sizeBits < full}
          <!-- Why it is short: an empty base is elided entirely (empty base
               optimization); anything else lost its tail padding to what follows. -->
          {@const shortWhy = short
            ? node.sizeBits === 0
              ? `Occupies no bytes here: it is empty, so it shares its address with the rest of the object, and sizeof(${group.type || group.name}) is ${full / 8} B only because a complete object cannot be zero-sized.`
              : `Occupies ${node.sizeBits / 8} B here, though sizeof(${group.type || group.name}) is ${full / 8} B, because the bytes after it are reused.`
            : null}
          <tr
            class="group"
            class:hovered={isHovered(node.leafIndexes)}
            onmouseenter={(e) => {
              enterGroup(node.ref, e);
            }}
            ondblclick={() => {
              openGroup(node.ref);
            }}
          >
            <td class="chip-col">
              {#if unitColour}<span class="chip {unitColour}"></span>{/if}
            </td>
            <td class="name" style:padding-left="{indent}px" style:--depth={depth}>
              <div class="nest">
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
                <button
                  type="button"
                  class="fname gname open"
                  title="Inspect {group.type || group.name}"
                  onclick={(e) => {
                    e.stopPropagation();
                    openGroup(node.ref);
                  }}>{group.name}</button
                >
                {#if group.isBase}<span class="tag">base</span>{/if}
                {#if group.isUnion}<span class="tag union">union</span>{/if}
                {#if node.overlaps}<span class="tag overlap" title="shares bytes with a sibling"
                    >overlaps</span
                  >{/if}
              </div>
            </td>
            <td class="type">{group.type}</td>
            <td class="num">{fmtOffset(node.offsetBits)}</td>
            <td class="num" class:noted={short} use:tooltip={shortWhy}
              >{fmtGroupSize(node.sizeBits)}{short ? ' *' : ''}</td
            >
            <td class="num">{node.align ? `${node.align} B` : ''}</td>
            <td class="num"></td>
          </tr>
        {/if}
      {/each}
      {#each model.markers as m, i (i)}
        {#if m.kind === 'zero-bitfield'}
          <tr class="marker">
            <td class="chip-col"></td>
            <td
              class="name"
              style:padding-left="{8 + m.path.length * INDENT}px"
              style:--depth={m.path.length}
            >
              <div class="nest">
                <span class="twist-gap"></span><span class="fname muted"
                  >{m.type ?? ''} :0 (unit break)</span
                >
              </div>
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
    /* Kept in step with `INDENT` above. */
    --indent: 16px;
    --guide-ink: color-mix(in srgb, var(--text-primary) 16%, transparent);
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
  /* The colour only: the name cell also carries the guide lines as a
     background image, and a hovered row must keep them. */
  tr.hovered td {
    background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  tr.group .gname {
    font-weight: 600;
  }
  /* A compound member opens its own record. */
  .open {
    font: inherit;
    font-weight: 600;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline dotted color-mix(in srgb, currentColor 45%, transparent);
    text-underline-offset: 3px;
  }
  .open:hover {
    color: var(--accent);
  }
  .open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
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
  /* Guides: `--depth` vertical lines, one per ancestor, each running down the
     middle of that ancestor's twisty, so the line under an arrow is visibly
     the arrow's. Indentation alone leaves a leaf beside a collapsible sibling
     looking like its child, which is how `__padding1_917_` came to read as a
     member of the union above it. They are painted on the cell, which spans
     the row however tall the type beside it wraps; the hover colour is a
     background-color, so the two layers compose. */
  .name {
    white-space: nowrap;
    background-image: repeating-linear-gradient(
      to right,
      var(--guide-ink) 0 1px,
      transparent 1px var(--indent)
    );
    background-position: var(--indent) 0;
    background-size: calc(var(--depth) * var(--indent)) 100%;
    background-repeat: no-repeat;
  }
  /* A flex row inside the cell, not an inline one, and not the cell itself.
     Whitespace: a group writes `{#if}…{/if} <button class="fname">` and a leaf
     writes them adjacent, so the group's name sat one collapsed space further
     right than its own children's, so siblings at one depth did not line up, in
     a column whose only job is to say what is nested in what. Flex items ignore
     the whitespace between them.
     Not the cell: a `td` that is `display: flex` stops being a table cell and
     takes only its content's height, so when the type column wraps the hover
     colour and the guides stopped one line short and the page showed through
     below the name. */
  .nest {
    display: flex;
    align-items: center;
  }
  .twist,
  .twist-gap {
    flex: none;
    display: inline-block;
    width: var(--indent);
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
  /* A size that is not simply sizeof(the type). */
  .num.noted {
    text-decoration: underline dotted color-mix(in srgb, currentColor 50%, transparent);
    text-underline-offset: 3px;
    cursor: help;
  }
  th span {
    cursor: help;
    text-decoration: underline dotted color-mix(in srgb, currentColor 45%, transparent);
    text-underline-offset: 3px;
  }
  .pad {
    color: var(--c-2);
  }
  .muted {
    color: var(--text-muted);
  }
</style>
