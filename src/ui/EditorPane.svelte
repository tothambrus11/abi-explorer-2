<script lang="ts">
  import { onMount } from 'svelte';
  import { store } from '$state/store.svelte';
  import type { Session } from '$state/session.svelte';
  import { EXAMPLES } from '$core/targets';
  import { createEditor, setEditorTheme, type EditorHandle } from './monaco';
  import { theme } from '$state/theme.svelte';
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
    editor.onLineHover((line) => {
      session.hoverLine(line);
    });
    editor.onCursorLine((line, byKeyboard) => {
      session.setCursorLine(line, byKeyboard);
    });
    editor.onMouseActivity(() => {
      session.noteMouseActivity();
    });
    return () => editor?.dispose();
  });

  // state -> editor
  $effect(() => {
    setEditorTheme(theme.current);
  });
  $effect(() => {
    editor?.setValue(store.source);
  });
  $effect(() => {
    editor?.setLanguage(store.options.lang);
  });
  $effect(() => {
    editor?.setDiagnostics(store.analysis?.diagnostics ?? []);
  });
  $effect(() => {
    // Gutter dots only for what is shown: the active record in tabs mode, everything when stacked.
    const shown = new Set(store.sections.map((s) => s.key));
    const dots = [...session.lines.values()]
      .filter((l) => l.members.some((m) => shown.has(m.record)))
      .map((l) => {
        // A filled dot only when this line holds exactly one field in the shown
        // record(s); a container line (several leaves) gets the neutral ring.
        const here = l.members.filter((m) => shown.has(m.record));
        const one = here.length === 1 ? here[0]! : null;
        const colorClass = one
          ? (store.models.get(one.record)?.leaves[one.leaf]?.colorClass ?? 'c-compound')
          : 'c-compound';
        return { line: l.line, colorClass };
      });
    editor?.setMemberDots(dots);
    editor?.refreshHover();
  });
  $effect(() => {
    editor?.highlightLine(store.hover.line);
    editor?.setInlay(store.hover.line, store.hover.inlay);
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
