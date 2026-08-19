<script lang="ts">
  import { onMount } from 'svelte';
  import { store } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { EXAMPLES } from '$core/targets';
  import { createEditor, setEditorTheme, type EditorHandle } from './monaco';
  import { theme } from '$state/theme.svelte';
  import { memberDots } from '$state/editor-view';
  import StatusIcon from './StatusIcon.svelte';
  import { tooltip } from './tooltip';

  const { session }: { session: Session } = $props();
  let host: HTMLDivElement;
  let editor: EditorHandle | null = null;

  onMount(() => {
    editor = createEditor(host, {
      value: store.source,
      theme: theme.current.id,
      language: store.options.lang,
      typeHover: (line, word) => session.describeType(line, word),
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
  // value to keep in sync — the seq makes re-picking the same record fire again.
  $effect(() => {
    const req = session.revealRequest;
    if (req) editor?.setCursor(req.line);
  });

  function loadExample(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    if (sel.value !== '') store.loadExample(Number(sel.value));
    sel.value = '';
  }
</script>

<section class="pane">
  <div class="head">
    <StatusIcon />
    <select
      id="example"
      class="input small"
      aria-label="Load an example"
      onchange={loadExample}
      use:tooltip={'Load an example (replaces the code)'}
    >
      <option value="">Examples…</option>
      {#each EXAMPLES as ex, i (ex.name)}<option value={i}>{ex.name}</option>{/each}
    </select>
  </div>
  <div
    id="editor"
    class="editor"
    bind:this={host}
    role="region"
    aria-label="C or C++ source code editor"
  ></div>
  <p class="hint">
    Freestanding headers (<code>&lt;stdint.h&gt;</code>, <code>&lt;stddef.h&gt;</code>, …) work for
    every target; libc++ headers are available in C++ mode. Templates must be instantiated to
    appear.
  </p>
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
  .hint :global(kbd) {
    font: inherit;
    font-size: 11px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
</style>
