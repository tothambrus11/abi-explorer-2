<script lang="ts">
  // The examples, grouped by the language they are written in.
  //
  // Drawn in two places, never both: the tab strip of any group that holds a
  // Source panel, and, on a phone where the strip has no width to spare, the
  // view panel. What an example replaces is the code of whichever source the
  // caller names, which is why loading is the caller's to do.
  //
  // Grouped rather than filtered to the selected language: an example is an
  // explicit act, and one written in a language you are not in is still one
  // you might want. Filtering hid every C++ example from someone in C, which
  // is where most visitors start. Loading one switches to its language,
  // because that is the language it is an example of.
  import { EXAMPLES } from '$core/targets';
  import { LANGUAGE_NAMES, type Language } from '$core/options';
  import { tooltip } from './tooltip';

  const { pick }: { pick: (index: number) => void } = $props();

  const grouped = (['c', 'c++', 'hylo'] as const satisfies readonly Language[])
    .map((lang) => ({
      lang,
      label: LANGUAGE_NAMES[lang],
      items: EXAMPLES.map((ex, i) => ({ ex, i })).filter((e) => e.ex.lang === lang),
    }))
    .filter((g) => g.items.length > 0);

  function onChange(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    if (sel.value !== '') pick(Number(sel.value));
    // Back to its own name: the select says what it is for, not what was last
    // loaded through it, and the same example can be wanted twice.
    sel.value = '';
  }
</script>

<select
  class="input small example"
  aria-label="Load an example"
  onchange={onChange}
  use:tooltip={'Load an example (replaces the code)'}
>
  <option value="">Examples…</option>
  {#each grouped as g (g.lang)}
    <optgroup label={g.label}>
      {#each g.items as e (e.ex.name)}<option value={e.i}>{e.ex.name}</option>{/each}
    </optgroup>
  {/each}
</select>
