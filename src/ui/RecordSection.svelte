<script lang="ts">
  import type { Section } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import Summary from './Summary.svelte';
  import ByteGrid from './ByteGrid.svelte';
  import FieldTable from './FieldTable.svelte';

  const { section, session }: { section: Section; session: Session } = $props();
  const rec = $derived(section.model.record);
</script>

<section class="record" data-record={section.key}>
  <h2 class="title mono">{rec.kind} {rec.name}</h2>
  <Summary model={section.model} />
  <ByteGrid model={section.model} record={section.key} {session} />
  <FieldTable model={section.model} record={section.key} {session} />
</section>

<style>
  .title {
    margin: 2px 0 10px;
    font-size: 16px;
  }
</style>
