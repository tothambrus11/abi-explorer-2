<script lang="ts">
  // One record: its byte map above, its members below.
  //
  // `section` is what to show and `session` is the state the two halves share,
  // which is the whole reason they are mounted together — pointing at a byte
  // lights the row that owns it, and the reverse.
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
  /* The chip above already reads "struct Example 40 B". Two lines saying the
     same name is a luxury of a large screen. */
  @media (max-width: 760px), (max-height: 560px) {
    .title {
      display: none;
    }
  }
</style>
