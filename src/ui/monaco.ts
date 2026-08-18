// Monaco setup: worker wiring, the two custom themes (Glacier / Nocturne),
// and a small imperative facade the EditorPane component drives from state.

import * as monaco from './monaco-slim';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { Diagnostic } from '$core/types';
import { THEMES, type Theme } from './themes';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const FONT = '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace';

for (const t of THEMES) monaco.editor.defineTheme(t.id, t.monaco);

/** (Re)define and activate a compiled theme (called from the theme effect). */
export function setEditorTheme(t: Theme): void {
  monaco.editor.defineTheme(t.id, t.monaco);
  monaco.editor.setTheme(t.id);
}

// ----------------------------------------------------------------- facade --

export interface WordAt {
  word: string;
  startColumn: number;
  endColumn: number;
}

export interface MemberDot {
  line: number;
  colorClass: string;
}

export interface EditorHandle {
  getValue(): string;
  setValue(text: string): void;
  setLanguage(lang: 'c' | 'c++'): void;
  setDiagnostics(diags: Diagnostic[]): void;
  setMemberDots(dots: MemberDot[]): void;
  highlightLine(line: number | null): void;
  setInlay(line: number | null, text: string | null): void;
  /** cb(line|null) as the pointer moves across lines (gutter or text). */
  onLineHover(cb: (line: number | null) => void): void;
  /** cb(line, byKeyboard) when the text cursor moves. */
  onCursorLine(cb: (line: number, byKeyboard: boolean) => void): void;
  /** cb() on any pointer movement over the editor. */
  onMouseActivity(cb: () => void): void;
  /** Re-emit the current hover (after the line map changed). */
  refreshHover(): void;
  onChange(cb: () => void): void;
  onSubmit(cb: () => void): void;
  focus(): void;
  dispose(): void;
}

export interface CreateEditorOptions {
  value: string;
  theme: string;
  language: 'c' | 'c++';
  typeHover: (line: number, word: WordAt) => Promise<string | null>;
}

export function createEditor(container: HTMLElement, opts: CreateEditorOptions): EditorHandle {
  const model = monaco.editor.createModel(
    opts.value,
    opts.language === 'c++' ? 'cpp' : 'c',
    monaco.Uri.parse('inmemory://input.' + (opts.language === 'c++' ? 'cc' : 'c')),
  );
  const editor = monaco.editor.create(container, {
    model,
    theme: opts.theme,
    fontFamily: FONT,
    fontSize: 13.5,
    fontLigatures: true,
    lineHeight: 21,
    tabSize: 2,
    insertSpaces: true,
    minimap: { enabled: false },
    glyphMargin: true,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderLineHighlight: 'line',
    padding: { top: 12, bottom: 12 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    overviewRulerBorder: false,
    overviewRulerLanes: 0, // no error/warning marks on the right edge
    hideCursorInOverviewRuler: true,
    fixedOverflowWidgets: true,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    occurrencesHighlight: 'singleFile',
    stickyScroll: { enabled: false },
  });

  const dots = editor.createDecorationsCollection([]);
  const lineDeco = editor.createDecorationsCollection([]);
  // Inlay: a content widget (overlay) — injected text would re-render the
  // hovered line's DOM under the pointer and swallow clicks.
  const inlayNode = document.createElement('span');
  inlayNode.className = 'member-inlay';
  let inlayPos: monaco.IPosition | null = null;
  const inlayWidget: monaco.editor.IContentWidget = {
    getId: () => 'abix.member-inlay',
    getDomNode: () => inlayNode,
    getPosition: () =>
      inlayPos
        ? { position: inlayPos, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }
        : null,
    allowEditorOverflow: false,
  };
  editor.addContentWidget(inlayWidget);
  let suppress = false;
  let hoverLine: number | null = null;
  let hoverCb: ((line: number | null) => void) | null = null;
  let cursorCb: ((line: number, byKeyboard: boolean) => void) | null = null;
  let activityCb: (() => void) | null = null;
  editor.onDidChangeCursorPosition((e) =>
    cursorCb?.(e.position.lineNumber, e.source === 'keyboard'),
  );
  const changeCbs: (() => void)[] = [];
  const submitCbs: (() => void)[] = [];

  model.onDidChangeContent(() => {
    if (!suppress) for (const cb of changeCbs) cb();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    for (const cb of submitCbs) cb();
  });

  const hoverDisposable = monaco.languages.registerHoverProvider(['c', 'cpp'], {
    async provideHover(m, position) {
      if (m !== model) return null;
      const w = m.getWordAtPosition(position);
      if (!w) return null;
      const md = await opts.typeHover(position.lineNumber, w);
      if (!md) return null;
      return {
        range: new monaco.Range(
          position.lineNumber,
          w.startColumn,
          position.lineNumber,
          w.endColumn,
        ),
        contents: [{ value: md, supportHtml: false }],
      };
    },
  });

  editor.onMouseMove((e) => {
    activityCb?.();
    const line = e.target.position?.lineNumber ?? null;
    if (line !== hoverLine) {
      hoverLine = line;
      hoverCb?.(line);
    }
  });
  editor.onMouseLeave(() => {
    if (hoverLine !== null) {
      hoverLine = null;
      hoverCb?.(null);
    }
  });

  const sevMap: Record<Diagnostic['severity'], monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    'fatal error': monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    note: monaco.MarkerSeverity.Info,
    remark: monaco.MarkerSeverity.Hint,
  };

  return {
    getValue: () => model.getValue(),
    setValue(text) {
      if (text === model.getValue()) return;
      suppress = true;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      editor.setScrollTop(0);
      suppress = false;
    },
    setLanguage(lang) {
      monaco.editor.setModelLanguage(model, lang === 'c++' ? 'cpp' : 'c');
    },
    setDiagnostics(diags) {
      const lineCount = model.getLineCount();
      const markers = diags
        .filter((d) => d.line >= 1 && d.line <= lineCount)
        .map((d) => {
          const col = Math.max(1, d.column);
          const wordAt = model.getWordAtPosition({ lineNumber: d.line, column: col });
          const endCol =
            d.endColumn ?? (wordAt ? wordAt.endColumn : model.getLineMaxColumn(d.line));
          return {
            severity: sevMap[d.severity],
            message: d.message,
            startLineNumber: d.line,
            startColumn: col,
            endLineNumber: d.line,
            endColumn: Math.max(col + 1, endCol),
            source: 'clang',
          };
        });
      monaco.editor.setModelMarkers(model, 'clang', markers);
    },
    setMemberDots(list) {
      dots.set(
        list.map((d) => ({
          range: new monaco.Range(d.line, 1, d.line, 1),
          options: {
            glyphMarginClassName: 'member-dot member-' + d.colorClass,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      );
    },
    highlightLine(line) {
      lineDeco.set(
        line
          ? [
              {
                range: new monaco.Range(line, 1, line, 1),
                options: { isWholeLine: true, className: 'member-line-hovered' },
              },
            ]
          : [],
      );
    },
    setInlay(line, text) {
      if (!line || !text || line > model.getLineCount()) {
        inlayPos = null;
        editor.layoutContentWidget(inlayWidget);
        return;
      }
      inlayNode.textContent = text;
      inlayPos = { lineNumber: line, column: model.getLineMaxColumn(line) };
      editor.layoutContentWidget(inlayWidget);
    },
    onLineHover(cb) {
      hoverCb = cb;
    },
    onCursorLine(cb) {
      cursorCb = cb;
      cb(editor.getPosition()?.lineNumber ?? 1, false);
    },
    onMouseActivity(cb) {
      activityCb = cb;
    },
    refreshHover() {
      if (hoverLine !== null) hoverCb?.(hoverLine);
    },
    onChange(cb) {
      changeCbs.push(cb);
    },
    onSubmit(cb) {
      submitCbs.push(cb);
    },
    focus: () => {
      editor.focus();
    },
    dispose() {
      editor.removeContentWidget(inlayWidget);
      hoverDisposable.dispose();
      editor.dispose();
      model.dispose();
    },
  };
}
