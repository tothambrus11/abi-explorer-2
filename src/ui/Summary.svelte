<script lang="ts">
  import type { RenderModel } from '$core/types';
  import { tooltip } from './tooltip';
  import { store } from '$state/store.svelte';
  import { strideOf } from '$state/type-hover';
  const { model }: { model: RenderModel } = $props();
  // `sizeof` and `alignof` are C operators; a Hylo type has a size and an
  // alignment, and a stride, which C folds into `sizeof` and Hylo does not.
  const hylo = $derived(store.options.lang === 'hylo');
  const fmt = new Intl.NumberFormat('en-US');
  const rec = $derived(model.record);
  // Null means the record was too big to scan for padding, which is a
  // different claim
  // from "no padding", and the tile says so rather than showing a confident 0.
  const padding = $derived(model.paddingBytes);
  const padPct = $derived(
    padding !== null && rec.sizeBytes ? Math.round((100 * padding) / rec.sizeBytes) : 0,
  );
  const extras = $derived.by(() => {
    const out: string[] = [];
    if (rec.dsize !== undefined && rec.dsize !== rec.sizeBytes) out.push(`dsize ${rec.dsize} B`);
    if (rec.nvsize !== undefined && rec.nvsize !== rec.sizeBytes) {
      out.push(`nvsize ${rec.nvsize} B`);
    }
    if (rec.nvalign !== undefined && rec.nvalign !== rec.align) {
      out.push(`nvalign ${rec.nvalign} B`);
    }
    if (rec.preferredalign !== undefined && rec.preferredalign !== rec.align) {
      out.push(`preferred align ${rec.preferredalign} B`);
    }
    return out;
  });
</script>

<div class="summary">
  <div
    class="tile"
    use:tooltip={hylo
      ? 'size: the bytes one instance of this type needs. Not the spacing in an array, which is the stride.'
      : 'sizeof: the bytes one object of this type takes, including any trailing padding. An array element is spaced by exactly this much.'}
  >
    <div class="label">{hylo ? 'size' : 'sizeof'}</div>
    <div class="value">{fmt.format(rec.sizeBytes)}</div>
    <div class="unit">bytes</div>
  </div>
  <div
    class="tile"
    use:tooltip={hylo
      ? 'align: the address boundary an instance of this type must start on.'
      : 'alignof: the address boundary an object of this type must start on.'}
  >
    <div class="label">{hylo ? 'align' : 'alignof'}</div>
    <div class="value">{fmt.format(rec.align)}</div>
    <div class="unit">bytes</div>
  </div>
  {#if hylo}
    <!-- The number C has no separate word for: its `sizeof` is already rounded
         up to the alignment, and Hylo's size is not. -->
    <div
      class="tile"
      use:tooltip={'stride: the bytes from one element to the next in an array, which is the size rounded up to the alignment.'}
    >
      <div class="label">stride</div>
      <div class="value">{fmt.format(strideOf(rec.sizeBytes, rec.align))}</div>
      <div class="unit">bytes</div>
    </div>
  {/if}
  <div
    class="tile"
    class:warn={padding !== null && padding > 0}
    use:tooltip={padding === null
      ? 'Not measured: the record is too large to scan byte by byte.'
      : 'Bytes inside sizeof that no member occupies, inserted to keep members aligned.'}
  >
    <div class="label">padding</div>
    <div class="value">{padding === null ? '-' : fmt.format(padding)}</div>
    <div class="unit">
      {#if padding !== null}bytes{#if rec.sizeBytes}
          · {padPct}%{/if}
      {:else}not measured{/if}
    </div>
  </div>
  {#if extras.length}
    <div
      class="extras"
      use:tooltip={'dsize: size without trailing padding, i.e. how much a derived class may reuse. nvsize / nvalign: size and alignment excluding virtual bases. preferred align: the alignment the ABI would like, where it exceeds the required one.'}
    >
      {extras.join(' · ')}
    </div>
  {/if}
</div>

<style>
  .summary {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: stretch;
    margin-bottom: 14px;
  }
  .tile {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 14px;
    min-width: 96px;
    background: var(--page);
  }
  .label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .value {
    font-size: 24px;
    font-weight: 650;
    line-height: 1.2;
  }
  .unit {
    font-size: 11.5px;
    color: var(--text-secondary);
  }
  .warn .value {
    color: var(--c-2);
  }
  .extras {
    align-self: center;
    color: var(--text-secondary);
    font-size: 12.5px;
  }
  /* Three stacked cards cost 79px on a phone. The same three numbers laid on
     one line cost 30, and the label is what shrinks. A reader looking at a
     byte map already knows which number is the size. */
  @media (max-width: 760px), (max-height: 560px) {
    .summary {
      gap: 6px;
      margin-bottom: 8px;
    }
    .tile {
      display: flex;
      align-items: baseline;
      gap: 5px;
      padding: 3px 8px;
      min-width: 0;
      flex: 0 1 auto;
    }
    .label {
      font-size: 10px;
      letter-spacing: 0.04em;
    }
    .value {
      font-size: 15px;
    }
    .unit {
      font-size: 10.5px;
    }
    .extras {
      flex-basis: 100%;
      font-size: 11.5px;
    }
  }
</style>
