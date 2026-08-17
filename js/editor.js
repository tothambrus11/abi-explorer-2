// Monaco editor wrapper: creates the editor, defines the two custom themes
// ("Glacier" light / "Nocturne" dark), follows the page's color scheme, and
// maps clang diagnostics onto editor markers.

import { monaco } from '../vendor/monaco/monaco.js';

const FONT = '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace';

self.MonacoEnvironment = {
  getWorkerUrl: () => new URL('../vendor/monaco/editor.worker.js', import.meta.url).href,
};

// ---------------------------------------------------------------- themes --

monaco.editor.defineTheme('glacier', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '1f2933' },
    { token: 'comment', foreground: '8a94a6', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'keyword.directive', foreground: 'c2410c' },
    { token: 'keyword.directive.include', foreground: 'c2410c' },
    { token: 'string', foreground: '0f766e' },
    { token: 'string.include.identifier', foreground: '0f766e' },
    { token: 'number', foreground: 'b45309' },
    { token: 'number.hex', foreground: 'b45309' },
    { token: 'number.float', foreground: 'b45309' },
    { token: 'type', foreground: '0369a1' },
    { token: 'identifier', foreground: '1f2933' },
    { token: 'delimiter', foreground: '64748b' },
    { token: 'operator', foreground: '475569' },
    { token: 'annotation', foreground: '9333ea' },
  ],
  colors: {
    'editor.background': '#f7f9fc',
    'editor.foreground': '#1f2933',
    'editorLineNumber.foreground': '#b6c0cf',
    'editorLineNumber.activeForeground': '#5b6b82',
    'editorCursor.foreground': '#2a78d6',
    'editor.selectionBackground': '#cfe1fb',
    'editor.inactiveSelectionBackground': '#e3ecf9',
    'editor.lineHighlightBackground': '#eef3fa',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#e3e8f0',
    'editorIndentGuide.activeBackground1': '#c3cdda',
    'editorBracketMatch.background': '#d6e6fb',
    'editorBracketMatch.border': '#8ab4ea',
    'editorBracketHighlight.foreground1': '#2a78d6',
    'editorBracketHighlight.foreground2': '#c2410c',
    'editorBracketHighlight.foreground3': '#0f766e',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d5dce6',
    'editorSuggestWidget.background': '#ffffff',
    'editorHoverWidget.background': '#ffffff',
    'editorError.foreground': '#d03b3b',
    'editorWarning.foreground': '#c98500',
    'editorGutter.background': '#f7f9fc',
    'scrollbarSlider.background': '#c3cdda66',
    'scrollbarSlider.hoverBackground': '#a9b6c899',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#f7f9fc',
    'focusBorder': '#2a78d6',
  },
});

monaco.editor.defineTheme('nocturne', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'd6deeb' },
    { token: 'comment', foreground: '637777', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'keyword.directive', foreground: 'f78c6c' },
    { token: 'keyword.directive.include', foreground: 'f78c6c' },
    { token: 'string', foreground: 'ecc48d' },
    { token: 'string.include.identifier', foreground: 'ecc48d' },
    { token: 'number', foreground: 'f78c6c' },
    { token: 'number.hex', foreground: 'f78c6c' },
    { token: 'number.float', foreground: 'f78c6c' },
    { token: 'type', foreground: '82aaff' },
    { token: 'identifier', foreground: 'd6deeb' },
    { token: 'delimiter', foreground: '7fdbca' },
    { token: 'operator', foreground: '7fdbca' },
    { token: 'annotation', foreground: 'c792ea' },
  ],
  colors: {
    'editor.background': '#0f1420',
    'editor.foreground': '#d6deeb',
    'editorLineNumber.foreground': '#3b4763',
    'editorLineNumber.activeForeground': '#8b9bbd',
    'editorCursor.foreground': '#80a4ff',
    'editor.selectionBackground': '#1d3b6a',
    'editor.inactiveSelectionBackground': '#172a4a',
    'editor.lineHighlightBackground': '#161d2e',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#1e2739',
    'editorIndentGuide.activeBackground1': '#34425e',
    'editorBracketMatch.background': '#1d3b6a',
    'editorBracketMatch.border': '#4d7ecf',
    'editorBracketHighlight.foreground1': '#82aaff',
    'editorBracketHighlight.foreground2': '#f78c6c',
    'editorBracketHighlight.foreground3': '#7fdbca',
    'editorWidget.background': '#151b2b',
    'editorWidget.border': '#28324a',
    'editorSuggestWidget.background': '#151b2b',
    'editorHoverWidget.background': '#151b2b',
    'editorError.foreground': '#ef6b6b',
    'editorWarning.foreground': '#e0a63a',
    'editorGutter.background': '#0f1420',
    'scrollbarSlider.background': '#34425e66',
    'scrollbarSlider.hoverBackground': '#4a5b7d99',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#0f1420',
    'focusBorder': '#3987e5',
  },
});

// ---------------------------------------------------------- color scheme --

const mql = matchMedia('(prefers-color-scheme: dark)');
export function isDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return mql.matches;
}
function applyTheme() {
  monaco.editor.setTheme(isDark() ? 'nocturne' : 'glacier');
}
mql.addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme'],
});

// ---------------------------------------------------------------- editor --

/**
 * Create the editor. Returns a small facade the app uses.
 * @param container element to mount into
 * @param opts { value, language: 'c'|'cpp', onChange(): void }
 */
export function createEditor(container, opts) {
  const model = monaco.editor.createModel(opts.value ?? '', opts.language ?? 'c',
    monaco.Uri.parse('inmemory://input.' + (opts.language === 'cpp' ? 'cc' : 'c')));

  const editor = monaco.editor.create(container, {
    model,
    theme: isDark() ? 'nocturne' : 'glacier',
    fontFamily: FONT,
    fontSize: 13.5,
    fontLigatures: true,
    lineHeight: 21,
    tabSize: 4,
    insertSpaces: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderLineHighlight: 'line',
    padding: { top: 12, bottom: 12 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    wordWrap: 'off',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    fixedOverflowWidgets: true,
    'semanticHighlighting.enabled': false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    occurrencesHighlight: 'singleFile',
    stickyScroll: { enabled: false },
  });

  let suppress = false;
  model.onDidChangeContent(() => { if (!suppress) opts.onChange?.(); });

  return {
    monaco,
    editor,
    getValue: () => model.getValue(),
    setValue(text) {
      suppress = true;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      editor.setScrollTop(0);
      suppress = false;
    },
    setLanguage(lang) {
      monaco.editor.setModelLanguage(model, lang === 'c++' ? 'cpp' : 'c');
    },
    /**
     * Set markers from parsed clang diagnostics.
     * @param diags [{line, column, severity: 'error'|'warning'|'note', message}]
     */
    setDiagnostics(diags) {
      const sevMap = {
        error: monaco.MarkerSeverity.Error,
        'fatal error': monaco.MarkerSeverity.Error,
        warning: monaco.MarkerSeverity.Warning,
        note: monaco.MarkerSeverity.Info,
        remark: monaco.MarkerSeverity.Hint,
      };
      const lineCount = model.getLineCount();
      const markers = diags
        .filter(d => d.line >= 1 && d.line <= lineCount)
        .map(d => {
          const col = Math.max(1, d.column || 1);
          const wordAt = model.getWordAtPosition({ lineNumber: d.line, column: col });
          const endCol = d.endColumn ?? (wordAt ? wordAt.endColumn : model.getLineMaxColumn(d.line));
          return {
            severity: sevMap[d.severity] ?? monaco.MarkerSeverity.Info,
            message: d.message,
            startLineNumber: d.line, startColumn: col,
            endLineNumber: d.line, endColumn: Math.max(col + 1, endCol),
            source: 'clang',
          };
        });
      monaco.editor.setModelMarkers(model, 'clang', markers);
    },
    focus: () => editor.focus(),
  };
}

/**
 * Parse clang's textual diagnostics into structured entries for `fileName`.
 * Lines look like: `input.c:3:12: error: expected ';' after ...`
 * Multi-line notes with `~~~^~~~` ranges are used to extend the marker.
 */
export function parseDiagnostics(text, fileName) {
  const out = [];
  const re = new RegExp('^' + fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ':(\\d+):(\\d+):\\s+(fatal error|error|warning|note|remark):\\s+(.*)$');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const d = { line: Number(m[1]), column: Number(m[2]), severity: m[3], message: m[4].trim() };
    // Look ahead for a caret line ("    ~~~~^~~~") to derive an end column.
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const c = /^(\s*[~^ ]*\^[~ ]*)\s*$/.exec(lines[j]);
      if (c) {
        const caret = lines[j];
        const start = caret.search(/[~^]/);
        const end = caret.replace(/\s+$/, '').length;
        if (start >= 0 && end > start) {
          // Diagnostic column is 1-based; caret line is aligned with the
          // source line printed just above it (after "  N | " prefix).
          const srcLine = lines[j - 1] || '';
          const prefix = /^\s*\d+\s\|\s/.exec(srcLine);
          const shift = prefix ? prefix[0].length : 0;
          d.column = Math.max(1, start - shift + 1);
          d.endColumn = Math.max(d.column + 1, end - shift + 1);
        }
        break;
      }
    }
    out.push(d);
  }
  return out;
}
