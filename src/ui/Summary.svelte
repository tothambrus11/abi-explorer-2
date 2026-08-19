<script lang="ts">
  import type { RenderModel } from '$core/types';
  import { tooltip } from './tooltip';
  const { model }: { model: RenderModel } = $props();
  const fmt = new Intl.NumberFormat('en-US');
  const rec = $derived(model.record);
  const padPct = $derived(
    rec.sizeBytes ? Math.round((100 * model.paddingBytes) / rec.sizeBytes) : 0,
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
    use:tooltip={'sizeof — the bytes one object of this type takes, including any trailing padding. An array element is spaced by exactly this much.'}
  >
    <div class="label">sizeof</div>
    <div class="value">{fmt.format(rec.sizeBytes)}</div>
    <div class="unit">bytes</div>
  </div>
  <div
    class="tile"
    use:tooltip={'alignof — the address boundary an object of this type must start on.'}
  >
    <div class="label">alignof</div>
    <div class="value">{fmt.format(rec.align)}</div>
    <div class="unit">bytes</div>
  </div>
  <div
    class="tile"
    class:warn={model.paddingBytes > 0}
    use:tooltip={'Bytes inside sizeof that no member occupies — inserted to keep members aligned.'}
  >
    <div class="label">padding</div>
    <div class="value">{fmt.format(model.paddingBytes)}</div>
    <div class="unit">
      bytes{#if rec.sizeBytes}
        · {padPct}%{/if}
    </div>
  </div>
  {#if extras.length}
    <div
      class="extras"
      use:tooltip={'dsize — size without trailing padding, i.e. how much a derived class may reuse. nvsize / nvalign — size and alignment excluding virtual bases. preferred align — the alignment the ABI would like, where it exceeds the required one.'}
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
</style>
