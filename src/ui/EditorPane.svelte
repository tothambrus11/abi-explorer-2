<script lang="ts">
  // The source editor, and the code half of every cross-highlight.
  //
  // Owns the Monaco instance: it writes the buffer back to its source on every
  // keystroke, paints the decorations for whatever the reader is pointing at on
  // the right, and answers hovers over type names. `source` is what it edits
  // and `session` is that source's state it highlights against; there is one
  // editor per source.
  import { onMount } from 'svelte';
  import { store, type Source } from '$state/store.svelte';
  import type { SourceSession } from '$state/session.svelte';
  import { createEditor, setEditorTheme, type EditorHandle } from './monaco';
  import { theme } from '$state/theme.svelte';
  import { memberDots } from '$state/editor-view';
  import Controls from './Controls.svelte';

  const { source, session }: { source: Source; session: SourceSession } = $props();
  let host: HTMLDivElement;
  let editor: EditorHandle | null = null;

  onMount(() => {
    editor = createEditor(host, {
      value: source.text,
      theme: theme.current.id,
      language: source.options.lang,
      typeHover: (line, word, signal) => session.describeType(line, word, signal),
    });
    editor.onChange(() => (source.text = editor!.getValue()));
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
  const value = $derived(source.text);
  const language = $derived(source.options.lang);
  const diagnostics = $derived(source.analysis?.diagnostics ?? []);
  // Dots only for what is on screen: the active record in tabs mode, all when stacked.
  const dots = $derived(
    memberDots(session.lines.values(), new Set(source.sections.map((s) => s.key))),
  );
  const highlight = $derived(source.hover.line);
  const nameRange = $derived(source.hover.nameRange);
  const inlay = $derived(source.hover.inlay);

  // ...and one effect per sink that applies it. Monaco's decoration APIs are
  // set-diffing, so handing them a derived value is all the reconciliation needed.
  $effect(() => {
    setEditorTheme(theme.shown);
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
</script>

<section class="pane">
  <!-- Whether it compiled is on the Source tab, and the examples and the new-source
       button are on the group's header: nothing here but the editor, until a
       second source arrives and the options become this source's own. -->
  {#if store.sources.length > 1}
    <Controls {source} compact />
  {/if}
  <!-- Nothing under the editor: what the strip there used to say about the
       headers and about templates is in the details popover, beside the
       headers that actually answered. -->
  <div
    class="editor"
    data-source={source.id}
    bind:this={host}
    role="region"
    aria-label="Source code editor: {source.name}"
  ></div>
</section>

<style>
  .pane {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface-1);
    padding: 10px 12px;
    box-sizing: border-box;
    /* The settings row inside asks how wide the panel is, not the window. */
    container-type: inline-size;
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
</style>
