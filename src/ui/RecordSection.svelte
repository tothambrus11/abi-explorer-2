<script lang="ts">
  import type { Section } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { recordKey } from '$core/layout-parser';
  import Summary from './Summary.svelte';
  import ByteGrid from './ByteGrid.svelte';
  import FieldTable from './FieldTable.svelte';

  const { section, session }: { section: Section; session: Session } = $props();
  const rec = $derived(section.model.record);
  const estimated = $derived(section.model.leaves.some((l) => l.estimated));
</script>

<section class="record" data-record={recordKey(rec)}>
  <h2 class="title mono">{rec.kind} {rec.name}</h2>
  <Summary model={section.model} />
  {#if estimated}
    <p class="estimate-note">
      ≈ some member sizes could not be measured (the probe did not compile) and are estimated from
      neighbouring offsets.
    </p>
  {/if}
  <ByteGrid model={section.model} record={section.key} {session} />
  <FieldTable model={section.model} record={section.key} {session} />
</section>

<style>
  .title {
    margin: 2px 0 10px;
    font-size: 16px;
  }
  .estimate-note {
    color: var(--text-muted);
    font-size: 12px;
    margin: 0 0 10px;
  }
</style>
