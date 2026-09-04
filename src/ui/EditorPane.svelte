<script lang="ts">
  // The source editor, and the code half of every cross-highlight.
  //
  // Owns the Monaco instance: it writes the buffer back to the store on every
  // keystroke, paints the decorations for whatever the reader is pointing at on
  // the right, and answers hovers over type names. `session` is the per-tab
  // state it highlights against; there is one editor per session.
  import { onMount } from 'svelte';
  import { store } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { EXAMPLES } from '$core/targets';
  import type { Language } from '$core/options';
  import { createEditor, setEditorTheme, type EditorHandle } from './monaco';
  import { theme } from '$state/theme.svelte';
  import { memberDots } from '$state/editor-view';
  import { tooltip } from './tooltip';
  import { MAX_BUFFERS } from '$core/url-state';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';

  const { session }: { session: Session } = $props();
  let host: HTMLDivElement;
  let editor: EditorHandle | null = null;

  onMount(() => {
    editor = createEditor(host, {
      value: store.source,
      theme: theme.current.id,
      language: store.options.lang,
      typeHover: (line, word, signal) => session.describeType(line, word, signal),
    });
    editor.onChange(() => (store.source = editor!.getValue()));
    editor.onSubmit(() => {
      session.compileNow();
    });
    editor.onLineHover((pos) => {
      session.hoverLine(pos);
    });
    editor.onCursorLine((pos, byKeyboard) => {
      session.setCursorLine(pos, byKeyboard);
    });
    editor.onMouseActivity(() => {
      session.noteMouseActivity();
    });
    return () => editor?.dispose();
  });

  // state -> editor: a derived description of what Monaco should show, one
  // value per sink. Deliberately *not* a single object: the hover changes on
  // every pointer column, and one object would invalidate as a whole, re-running
  // the text/marker/decoration syncs (and `model.getValue()` over the whole
  // document) on every mouse move.
  const value = $derived(store.source);
  const language = $derived(store.options.lang);
  const diagnostics = $derived(store.analysis?.diagnostics ?? []);
  // Dots only for what is on screen: the active record in tabs mode, all when stacked.
  const dots = $derived(
    memberDots(session.lines.values(), new Set(store.sections.map((s) => s.key))),
  );
  const highlight = $derived(store.hover.line);
  const nameRange = $derived(store.hover.nameRange);
  const inlay = $derived(store.hover.inlay);

  // ...and one effect per sink that applies it. Monaco's decoration APIs are
  // set-diffing, so handing them a derived value is all the reconciliation needed.
  $effect(() => {
    setEditorTheme(theme.current);
  });
  $effect(() => {
    editor?.setValue(value);
  });
  $effect(() => {
    editor?.setLanguage(language);
  });
  $effect(() => {
    editor?.setDiagnostics(diagnostics);
  });
  $effect(() => {
    editor?.setMemberDots(dots);
    editor?.refreshHover();
  });
  $effect(() => {
    editor?.highlightLine(highlight, nameRange);
    editor?.setInlay(highlight, inlay);
  });
  // A one-shot navigation command (picking a record from the tab bar), not a
  // value to keep in sync; the seq makes re-picking the same record fire again.
  $effect(() => {
    const req = session.revealRequest;
    if (req) editor?.setCursor(req.line);
  });

  /**
   * The examples, grouped by the language they are written in.
   *
   * Grouped rather than filtered to the selected language: an example is an
   * explicit act, and one written in a language you are not in is still one you
   * might want. Filtering hid every C++ example from someone in C, which is
   * where most visitors start. Loading one switches to its language, because
   * that is the language it is an example of.
   */
  const LANGUAGE_NAMES: Record<Language, string> = { c: 'C', 'c++': 'C++', hylo: 'Hylo' };
  const grouped = $derived(
    (['c', 'c++', 'hylo'] as const)
      .map((lang) => ({
        lang,
        label: LANGUAGE_NAMES[lang],
        items: EXAMPLES.map((ex, i) => ({ ex, i })).filter((e) => e.ex.lang === lang),
      }))
      .filter((g) => g.items.length > 0),
  );

  function loadExample(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    if (sel.value !== '') store.loadExample(Number(sel.value));
    sel.value = '';
  }
</script>

<section class="pane">
  <!-- Whether it compiled is on the Code tab now: it was one line above the
       editor, where a phone has no line to spare and the tab is already there. -->
  <div class="head">
    <!-- Tabs only from the second buffer on: one source needs no tab bar, and
         the lone "+" is the whole affordance for getting a second. -->
    {#if store.buffers.length > 1}
      <div class="tabs" role="tablist" aria-label="Sources">
        {#each store.buffers as buf, i (buf)}
          <span class="tab" class:active={i === store.activeBuffer}>
            <button
              type="button"
              class="tab-name"
              role="tab"
              aria-selected={i === store.activeBuffer}
              onclick={() => {
                store.selectBuffer(i);
              }}
              use:tooltip={`${buf.name} (${buf.lang === 'c' ? 'C' : buf.lang === 'c++' ? 'C++' : 'Hylo'})`}
              >{buf.name}</button
            >
            <button
              type="button"
              class="tab-close"
              aria-label={`Close ${buf.name}`}
              onclick={() => {
                store.closeBuffer(i);
              }}><X size={12} /></button
            >
          </span>
        {/each}
      </div>
    {/if}
    {#if store.buffers.length < MAX_BUFFERS}
      <button
        type="button"
        class="add"
        aria-label="New source"
        onclick={() => {
          store.addBuffer();
        }}
        use:tooltip={'New source (each tab is laid out on its own)'}><Plus size={14} /></button
      >
    {/if}
    <select
      id="example"
      class="input small"
      aria-label="Load an example"
      onchange={loadExample}
      use:tooltip={'Load an example (replaces the code)'}
    >
      <option value="">Examples…</option>
      {#each grouped as g (g.lang)}
        <optgroup label={g.label}>
          {#each g.items as e (e.ex.name)}<option value={e.i}>{e.ex.name}</option>{/each}
        </optgroup>
      {/each}
    </select>
  </div>
  <div
    id="editor"
    class="editor"
    bind:this={host}
    role="region"
    aria-label="Source code editor"
  ></div>
  <!-- What the language actually offers. Hylo has one standard library and no
       templates to instantiate, so none of the C++ note applies to it. -->
  {#if store.options.lang !== 'hylo'}
    <p class="hint">
      The C library (musl) and libc++ resolve for every target. The details beside the language say
      which headers answered. Templates must be instantiated to appear.
    </p>
  {/if}
</section>

<style>
  .pane {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface-1);
    padding: 10px 12px;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 8px;
    gap: 8px;
    flex: none;
  }
  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
  }
  .tab.active {
    background: var(--surface-2);
    border-color: var(--accent);
    color: inherit;
  }
  .tab-name {
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 2px 2px 8px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .tab-close,
  .add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .tab-close {
    width: 18px;
    height: 18px;
    margin-right: 2px;
    border-radius: 4px;
    opacity: 0.55;
  }
  .tab-close:hover {
    opacity: 1;
    background: var(--surface-2);
  }
  .add {
    flex: none;
    width: 22px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
  }
  .add:hover {
    color: inherit;
    border-color: var(--accent);
  }
  .editor {
    flex: 1;
    min-height: 120px;
    width: 100%;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--editor-bg);
  }
  .editor:focus-within {
    border-color: var(--accent);
  }
  .editor :global(.monaco-editor),
  .editor :global(.monaco-editor .overflow-guard) {
    border-radius: 8px;
  }
  .hint {
    color: var(--text-muted);
    font-size: 12px;
    margin: 8px 0 0;
    flex: none;
  }
  /* 52px of explanation on a 844px-tall phone, and the same sentence again in
     the footer. The footer wins: it says which headers actually answered. */
  @media (max-width: 760px), (max-height: 560px) {
    .hint {
      display: none;
    }
  }
  .hint :global(kbd) {
    font: inherit;
    font-size: 11px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
</style>
