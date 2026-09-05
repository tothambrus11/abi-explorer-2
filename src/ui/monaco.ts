// Monaco setup: worker wiring, the two custom themes (Glacier / Nocturne),
// and a small imperative facade the EditorPane component drives from state.

import * as monaco from './monaco-slim';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { Diagnostic } from '$core/types';
import type { Language } from '$core/options';
import { THEMES, type Theme } from '$core/themes';
import type { MemberDot } from '$state/editor-view';
import { widenToTemplateArgs } from '$state/type-hover';
import { HYLO_LANGUAGE_ID, HYLO_TOKENS, HYLO_CONFIGURATION } from './hylo-language';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const FONT = '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace';

// C and C++ come with the slim build; Hylo is ours, from the grammar Hylo's
// own editor support uses. Registered once, at module scope, because a language
// belongs to Monaco rather than to an editor: registering it per editor would
// stack a second tokenizer on the second one.
monaco.languages.register({ id: HYLO_LANGUAGE_ID, extensions: ['.hylo'], aliases: ['Hylo'] });
monaco.languages.setLanguageConfiguration(HYLO_LANGUAGE_ID, HYLO_CONFIGURATION);
monaco.languages.setMonarchTokensProvider(HYLO_LANGUAGE_ID, HYLO_TOKENS);

/** Monaco's name for a language of ours, and the extension a model is named for. */
const MONACO_LANGUAGE: Record<Language, { id: string; extension: string }> = {
  c: { id: 'c', extension: 'c' },
  'c++': { id: 'cpp', extension: 'cc' },
  hylo: { id: HYLO_LANGUAGE_ID, extension: 'hylo' },
};

for (const t of THEMES) monaco.editor.defineTheme(t.id, t.monaco);

/** The theme Monaco is on, and the data it was given for it. */
let applied: { id: string; data: string } | null = null;
/** When that was, and what is waiting: see `setEditorTheme`. */
let appliedAt = 0;
let pending: Theme | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * How close together two redefinitions of the *same* theme may be. Dragging a
 * colour reports one on every pointer move, and each is a stylesheet swap.
 */
const REDEFINE_GAP_MS = 70;

function defineNow(t: Theme, data: string): void {
  applied = { id: t.id, data };
  appliedAt = Date.now();
  monaco.editor.defineTheme(t.id, t.monaco);
  monaco.editor.setTheme(t.id);
}

/**
 * (Re)define and activate a compiled theme (called from the theme effect).
 *
 * Redefining a theme replaces the whole of Monaco's stylesheet and re-tokenises
 * every model, which shows as a flash of unstyled editor. So:
 *
 * - Data Monaco already has is not handed to it again. Most theme edits are
 *   page or member colours, which the editor's own theme knows nothing about,
 *   and the effect that calls this runs for all of them.
 * - Editing the editor's own colours *is* a change, and a drag reports one per
 *   pointer move; those are spaced out, with the last one always applied, so a
 *   drag flashes a few times rather than sixty.
 * - Changing to a different theme is not an edit and never waits: a theme
 *   tried on from the list has to appear at once.
 */
export function setEditorTheme(t: Theme): void {
  const data = JSON.stringify(t.monaco);
  if (applied?.id === t.id && applied.data === data) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
  const wait = applied?.id === t.id ? REDEFINE_GAP_MS - (Date.now() - appliedAt) : 0;
  if (wait <= 0) {
    defineNow(t, data);
    return;
  }
  pending = t;
  timer = setTimeout(() => {
    timer = null;
    const next = pending;
    pending = null;
    if (next) defineNow(next, JSON.stringify(next.monaco));
  }, wait);
}

// ----------------------------------------------------------------- facade --

/** Structurally `WordRange` in `$state/type-hover`, which is what widens it. */
export interface WordAt {
  word: string;
  startColumn: number;
  endColumn: number;
}

// The dot list is produced by `$state/editor-view`; this facade only applies it.
export type { MemberDot } from '$state/editor-view';

/**
 * What the app is allowed to ask of the editor.
 *
 * The whole of Monaco is behind this: the setters are idempotent, so a caller
 * may hand over the current state on every change without checking whether it
 * differs, and every `on*` registers one callback, replacing any earlier one.
 */
export interface EditorHandle {
  getValue(): string;
  /**
   * Replaces the buffer, unless it already holds `text`.
   *
   * Applied as an edit rather than a reset, so the editor's own undo still
   * reaches back past it, and reported to no `onChange` listener: the text came
   * from the state those listeners write to, and echoing it back would be a
   * loop.
   */
  setValue(text: string): void;
  /** Switches syntax highlighting; keeps the text. */
  setLanguage(lang: Language): void;
  /** Replaces the squiggles. An empty list clears them. */
  setDiagnostics(diags: Diagnostic[]): void;
  /** Replaces the member circles in the gutter. */
  setMemberDots(dots: MemberDot[]): void;
  /** Subtle whole-line tint plus, when given, a strong highlight on the member's name. */
  highlightLine(line: number | null, name?: { startCol: number; endCol: number } | null): void;
  /** The ghost text at the end of a line; `null` for either argument removes it. */
  setInlay(line: number | null, text: string | null): void;
  /** cb(line|null) as the pointer moves across lines (gutter or text). */
  onLineHover(cb: (pos: { line: number; col: number } | null) => void): void;
  /** cb(line, byKeyboard) when the text cursor moves. */
  onCursorLine(cb: (pos: { line: number; col: number }, byKeyboard: boolean) => void): void;
  /** Move the caret to a line and scroll it into view (an explicit navigation). */
  setCursor(line: number): void;
  /** cb() on any pointer movement over the editor. */
  onMouseActivity(cb: () => void): void;
  /** Re-emit the current hover (after the line map changed). */
  refreshHover(): void;
  /** cb() after every edit the user makes, undo included, but not after `setValue`. */
  onChange(cb: () => void): void;
  /** cb() on the explicit "compile now" key. */
  onSubmit(cb: () => void): void;
  focus(): void;
  /** Disposes the editor, its model and every listener. The handle is dead afterwards. */
  dispose(): void;
}

export interface CreateEditorOptions {
  value: string;
  theme: string;
  language: Language;
  /**
   * Documentation for the word under the pointer. `signal` aborts when the user
   * moves on: answering can cost a full compile, and the wasm clang runs one job
   * at a time, so an abandoned hover must not queue ahead of the next analysis.
   */
  typeHover: (line: number, word: WordAt, signal: AbortSignal) => Promise<string | null>;
}

/** How many editors this page has made, so each model has a name of its own. */
let editorSeq = 0;

/** Bridge Monaco's CancellationToken to the AbortSignal our async code takes. */
function signalFor(token: monaco.CancellationToken): AbortSignal {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  else {
    token.onCancellationRequested(() => {
      ac.abort();
    });
  }
  return ac.signal;
}

/**
 * Creates the editor in `container` and returns the handle to it.
 *
 * The caller owns the result and must `dispose` it before the container goes
 * away. One model per editor, named by the language so Monaco applies the right
 * syntax; `opts.typeHover` answers hovers over type names, and may be slow,
 * since it is cancelled when the pointer moves on.
 */
export function createEditor(container: HTMLElement, opts: CreateEditorOptions): EditorHandle {
  // Named per editor: there is one per source, and Monaco keeps one model
  // per name for the whole page.
  const model = monaco.editor.createModel(
    opts.value,
    MONACO_LANGUAGE[opts.language].id,
    monaco.Uri.parse(
      `inmemory://input-${String(++editorSeq)}.${MONACO_LANGUAGE[opts.language].extension}`,
    ),
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
  // Inlay: a content widget (overlay), since injected text would re-render the
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
  let hoverCb: ((pos: { line: number; col: number } | null) => void) | null = null;
  let cursorCb: ((pos: { line: number; col: number }, byKeyboard: boolean) => void) | null = null;
  let activityCb: (() => void) | null = null;
  editor.onDidChangeCursorPosition((e) =>
    cursorCb?.({ line: e.position.lineNumber, col: e.position.column }, e.source === 'keyboard'),
  );
  const changeCbs: (() => void)[] = [];
  const submitCbs: (() => void)[] = [];

  model.onDidChangeContent(() => {
    if (!suppress) for (const cb of changeCbs) cb();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    for (const cb of submitCbs) cb();
  });

  // Every language this editor is ever set to. A hover provider is registered
  // per language, and a model switched to one this list forgets would silently
  // stop answering hovers.
  const hoverDisposable = monaco.languages.registerHoverProvider(
    Object.values(MONACO_LANGUAGE).map((l) => l.id),
    {
      async provideHover(m, position, token) {
        if (m !== model) return null;
        const at = m.getWordAtPosition(position);
        if (!at) return null;
        // `Pair<char>`, not `Pair`: the two instantiations are different records
        // and a word that stops at `<` cannot say which one the pointer is on.
        const w = widenToTemplateArgs(m.getLineContent(position.lineNumber), at);
        const md = await opts.typeHover(position.lineNumber, w, signalFor(token));
        if (!md || token.isCancellationRequested) return null;
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
    },
  );

  let hoverAt: { line: number; col: number } | null = null;
  let hoverPos: string | null = null;
  editor.onMouseMove((e) => {
    activityCb?.();
    const pos = e.target.position;
    const key = pos ? `${pos.lineNumber}:${pos.column}` : null;
    if (key !== hoverPos) {
      hoverPos = key;
      hoverAt = pos ? { line: pos.lineNumber, col: pos.column } : null;
      hoverCb?.(hoverAt);
    }
  });
  editor.onMouseLeave(() => {
    if (hoverPos !== null) {
      hoverPos = null;
      hoverAt = null;
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
      monaco.editor.setModelLanguage(model, MONACO_LANGUAGE[lang].id);
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
      // The circle is drawn by the decoration on the first character of the
      // member's name: CSS gives that span left padding, so the circle sits
      // before the name and pushes the rest of the line along, and a line
      // declaring several members shows one circle per member. (Monaco's
      // injected-text option is internal to inlay hints and not usable here.)
      dots.set(
        list.map((d) => ({
          range: new monaco.Range(d.line, d.col, d.line, d.col + 1),
          options: {
            inlineClassName: 'member-dot member-' + d.colorClass,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      );
    },
    highlightLine(line, name) {
      if (!line) {
        lineDeco.set([]);
        return;
      }
      // Two layers: a subtle tint over the whole line for scannability, and a
      // strong highlight on the member's own name so a line declaring several
      // members still points at exactly one.
      const decos: monaco.editor.IModelDeltaDecoration[] = [
        {
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: 'member-line-hovered' },
        },
      ];
      if (name) {
        decos.push({
          range: new monaco.Range(line, name.startCol, line, name.endCol),
          options: { className: 'member-name-hovered' },
        });
      }
      lineDeco.set(decos);
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
    setCursor(line) {
      const max = model.getLineCount();
      const target = Math.min(Math.max(1, line), max);
      const column = model.getLineFirstNonWhitespaceColumn(target) || 1;
      editor.setPosition({ lineNumber: target, column });
      editor.revealLineInCenterIfOutsideViewport(target);
    },
    onCursorLine(cb) {
      cursorCb = cb;
      const p = editor.getPosition();
      cb({ line: p?.lineNumber ?? 1, col: p?.column ?? 1 }, false);
    },
    onMouseActivity(cb) {
      activityCb = cb;
    },
    refreshHover() {
      if (hoverAt) hoverCb?.({ ...hoverAt });
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
