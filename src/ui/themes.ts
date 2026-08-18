// Theme catalogue. A theme is authored as a small *spec* of anchor colours
// (page, syntax, editor) and compiled into page tokens (CSS custom properties)
// plus a Monaco editor theme. Presets ship here; user themes are specs stored
// in localStorage (see $state/theme.svelte.ts). The categorical member palette
// is tied to the mode (validated light/dark sets), not to the individual theme.

import type * as monaco from 'monaco-editor';

export type ThemeMode = 'light' | 'dark';

export interface PageColors {
  surface: string;
  page: string;
  text: string;
  text2: string;
  muted: string;
  grid: string;
  baseline: string;
  border: string;
  accent: string;
  onAccent: string;
  error: string;
  warn: string;
  ok: string;
}
export interface SyntaxColors {
  fg: string;
  comment: string;
  keyword: string;
  directive: string;
  string: string;
  number: string;
  type: string;
  delimiter: string;
  operator: string;
  annotation: string;
}
export interface EditorColors {
  bg: string;
  fg: string;
  lineNo: string;
  cursor: string;
  selection: string;
  lineHighlight: string;
  widgetBg: string;
  widgetBorder: string;
}

/** Categorical colours for struct members (byte grid, table chips, gutter dots). */
export interface MemberColors {
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  c5: string;
  c6: string;
  c7: string;
  c8: string;
  /** vtable/vbtable pointer cells */
  special: string;
}

export interface ThemeSpec {
  id: string;
  name: string;
  mode: ThemeMode;
  page: PageColors;
  syntax: SyntaxColors;
  editor: EditorColors;
  members: MemberColors;
}

export interface Theme extends ThemeSpec {
  /** true for the built-in presets (read-only). */
  preset: boolean;
  /** CSS custom properties applied on :root. */
  tokens: Record<string, string>;
  monaco: monaco.editor.IStandaloneThemeData;
}

/** Field labels for the editor UI. */
export const PAGE_FIELDS: { key: keyof PageColors; label: string }[] = [
  { key: 'page', label: 'Page background' },
  { key: 'surface', label: 'Panel background' },
  { key: 'text', label: 'Text' },
  { key: 'text2', label: 'Secondary text' },
  { key: 'muted', label: 'Muted text' },
  { key: 'border', label: 'Borders' },
  { key: 'grid', label: 'Grid lines / padding' },
  { key: 'baseline', label: 'Baselines' },
  { key: 'accent', label: 'Accent' },
  { key: 'onAccent', label: 'Text on accent' },
  { key: 'ok', label: 'Success' },
  { key: 'warn', label: 'Warning' },
  { key: 'error', label: 'Error' },
];
export const SYNTAX_FIELDS: { key: keyof SyntaxColors; label: string }[] = [
  { key: 'fg', label: 'Code text' },
  { key: 'comment', label: 'Comments' },
  { key: 'keyword', label: 'Keywords' },
  { key: 'directive', label: 'Preprocessor' },
  { key: 'string', label: 'Strings' },
  { key: 'number', label: 'Numbers' },
  { key: 'type', label: 'Types' },
  { key: 'delimiter', label: 'Delimiters' },
  { key: 'operator', label: 'Operators' },
  { key: 'annotation', label: 'Annotations' },
];
export const MEMBER_FIELDS: { key: keyof MemberColors; label: string }[] = [
  { key: 'c1', label: 'Member 1' },
  { key: 'c2', label: 'Member 2' },
  { key: 'c3', label: 'Member 3' },
  { key: 'c4', label: 'Member 4' },
  { key: 'c5', label: 'Member 5' },
  { key: 'c6', label: 'Member 6' },
  { key: 'c7', label: 'Member 7' },
  { key: 'c8', label: 'Member 8' },
  { key: 'special', label: 'vtable pointers' },
];
export const EDITOR_FIELDS: { key: keyof EditorColors; label: string }[] = [
  { key: 'bg', label: 'Editor background' },
  { key: 'fg', label: 'Editor foreground' },
  { key: 'lineNo', label: 'Line numbers' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'selection', label: 'Selection' },
  { key: 'lineHighlight', label: 'Current line' },
  { key: 'widgetBg', label: 'Popup background' },
  { key: 'widgetBorder', label: 'Popup border' },
];

/** Fallback member palettes for specs that predate per-theme palettes. */
export const DEFAULT_MEMBERS: Record<ThemeMode, MemberColors> = {
  light: {
    c1: '#3b6fd4',
    c2: '#e0742b',
    c3: '#21a58a',
    c4: '#d9a400',
    c5: '#d65f9b',
    c6: '#4f9d2f',
    c7: '#6c4bc9',
    c8: '#d94a4a',
    special: '#9a9a94',
  },
  dark: {
    c1: '#82aaff',
    c2: '#f78c6c',
    c3: '#7fdbca',
    c4: '#ffcb6b',
    c5: '#ff869a',
    c6: '#addb67',
    c7: '#c792ea',
    c8: '#ef5350',
    special: '#5f6b8a',
  },
};

// ------------------------------------------------------------ colour math --

/** Parse #rgb/#rrggbb/#rrggbbaa (alpha ignored) to [r,g,b]. */
function rgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0');
/** Mix `a` toward `b` by t (0..1). Non-hex inputs (rgba()) fall back to `a`. */
export function mix(a: string, b: string, t: number): string {
  if (!a.startsWith('#') || !b.startsWith('#')) return a;
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return '#' + hex2(r1 + (r2 - r1) * t) + hex2(g1 + (g2 - g1) * t) + hex2(b1 + (b2 - b1) * t);
}
/** Append alpha (0..1) to a hex colour. */
export function alpha(hex: string, a: number): string {
  if (!hex.startsWith('#')) return hex;
  const [r, g, b] = rgb(hex);
  return '#' + hex2(r) + hex2(g) + hex2(b) + hex2(a * 255);
}
/** Normalize to #rrggbb for <input type=color> (drops alpha; rgba() → fallback). */
export function toHex6(c: string, fallback = '#888888'): string {
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return c.slice(0, 7).toLowerCase();
  if (/^#[0-9a-f]{3,4}$/i.test(c)) return '#' + rgb(c).map(hex2).join('');
  return fallback;
}

// ---------------------------------------------------------------- compile --

const strip = (c: string) => c.replace(/^#/, '');

/** Compile a spec into tokens + a Monaco theme. */
export function compileTheme(spec: ThemeSpec, preset = false): Theme {
  const { page: p, syntax: sx, editor: e, mode } = spec;
  const m: MemberColors = (spec as Partial<ThemeSpec>).members ?? DEFAULT_MEMBERS[mode];
  const tokens: Record<string, string> = {
    '--surface-1': p.surface,
    '--page': p.page,
    '--text-primary': p.text,
    '--text-secondary': p.text2,
    '--text-muted': p.muted,
    '--grid-line': p.grid,
    '--baseline': p.baseline,
    '--border': p.border,
    '--accent': p.accent,
    '--on-accent': p.onAccent,
    '--error': p.error,
    '--warn-ink': p.warn,
    '--ok-ink': p.ok,
    '--editor-bg': e.bg,
    '--diag-magenta': sx.keyword,
    '--c-1': m.c1,
    '--c-2': m.c2,
    '--c-3': m.c3,
    '--c-4': m.c4,
    '--c-5': m.c5,
    '--c-6': m.c6,
    '--c-7': m.c7,
    '--c-8': m.c8,
    '--c-special': m.special,
  };
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: '', foreground: strip(sx.fg) },
    { token: 'comment', foreground: strip(sx.comment), fontStyle: 'italic' },
    { token: 'keyword', foreground: strip(sx.keyword) },
    { token: 'keyword.directive', foreground: strip(sx.directive) },
    { token: 'keyword.directive.include', foreground: strip(sx.directive) },
    { token: 'string', foreground: strip(sx.string) },
    { token: 'string.include.identifier', foreground: strip(sx.string) },
    { token: 'number', foreground: strip(sx.number) },
    { token: 'number.hex', foreground: strip(sx.number) },
    { token: 'number.float', foreground: strip(sx.number) },
    { token: 'type', foreground: strip(sx.type) },
    { token: 'identifier', foreground: strip(sx.fg) },
    { token: 'delimiter', foreground: strip(sx.delimiter) },
    { token: 'operator', foreground: strip(sx.operator) },
    { token: 'annotation', foreground: strip(sx.annotation) },
  ];
  const colors: Record<string, string> = {
    'editor.background': e.bg,
    'editor.foreground': e.fg,
    'editorLineNumber.foreground': e.lineNo,
    'editorLineNumber.activeForeground': mix(e.lineNo, e.fg, 0.6),
    'editorCursor.foreground': e.cursor,
    'editor.selectionBackground': e.selection,
    'editor.inactiveSelectionBackground': mix(e.selection, e.bg, 0.5),
    'editor.lineHighlightBackground': e.lineHighlight,
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': mix(e.bg, e.lineNo, 0.35),
    'editorIndentGuide.activeBackground1': mix(e.bg, e.lineNo, 0.8),
    'editorBracketMatch.background': e.selection,
    'editorBracketMatch.border': mix(e.cursor, e.bg, 0.3),
    'editorBracketHighlight.foreground1': sx.type,
    'editorBracketHighlight.foreground2': sx.directive,
    'editorBracketHighlight.foreground3': sx.string,
    'editorWidget.background': e.widgetBg,
    'editorWidget.border': e.widgetBorder,
    'editorHoverWidget.background': e.widgetBg,
    'editorHoverWidget.border': e.widgetBorder,
    'editorHoverWidget.foreground': e.fg,
    'editorError.foreground': p.error,
    'editorWarning.foreground': p.warn,
    'editorGutter.background': e.bg,
    'scrollbarSlider.background': alpha(e.lineNo, 0.4),
    'scrollbarSlider.hoverBackground': alpha(e.lineNo, 0.6),
    'scrollbar.shadow': '#00000000',
    focusBorder: p.accent,
  };
  return {
    ...spec,
    preset,
    tokens,
    monaco: { base: mode === 'dark' ? 'vs-dark' : 'vs', inherit: true, rules, colors },
  };
}

// ---------------------------------------------------------------- presets --

const spec = (
  id: string,
  name: string,
  mode: ThemeMode,
  page: Omit<PageColors, 'onAccent'> & { onAccent?: string },
  syntax: SyntaxColors,
  editor: EditorColors,
  members: MemberColors,
): ThemeSpec => ({
  id,
  name,
  mode,
  page: { onAccent: '#ffffff', ...page },
  syntax,
  editor,
  members,
});

export const PRESET_SPECS: ThemeSpec[] = [
  spec(
    'glacier',
    'Glacier',
    'light',
    {
      surface: '#fcfcfb',
      page: '#f9f9f7',
      text: '#0b0b0b',
      text2: '#52514e',
      muted: '#898781',
      grid: '#e1e0d9',
      baseline: '#c3c2b7',
      border: '#e6e5df',
      accent: '#2a78d6',
      error: '#d03b3b',
      warn: '#8a5a00',
      ok: '#006300',
    },
    {
      fg: '#1f2933',
      comment: '#8a94a6',
      keyword: '#7c3aed',
      directive: '#c2410c',
      string: '#0f766e',
      number: '#b45309',
      type: '#0369a1',
      delimiter: '#64748b',
      operator: '#475569',
      annotation: '#9333ea',
    },
    {
      bg: '#f7f9fc',
      fg: '#1f2933',
      lineNo: '#b6c0cf',
      cursor: '#2a78d6',
      selection: '#cfe1fb',
      lineHighlight: '#eef3fa',
      widgetBg: '#ffffff',
      widgetBorder: '#d5dce6',
    },
    {
      c1: '#3b6fd4',
      c2: '#e0742b',
      c3: '#21a58a',
      c4: '#d9a400',
      c5: '#d65f9b',
      c6: '#4f9d2f',
      c7: '#6c4bc9',
      c8: '#d94a4a',
      special: '#9a9a94',
    },
  ),
  spec(
    'paper',
    'Paper',
    'light',
    {
      surface: '#fffdf7',
      page: '#f6f1e7',
      text: '#2b2520',
      text2: '#5f564d',
      muted: '#948a7c',
      grid: '#e8e0d2',
      baseline: '#cfc4b2',
      border: '#e4dccb',
      accent: '#b5562a',
      error: '#c0392b',
      warn: '#8a5a00',
      ok: '#3d7a2a',
    },
    {
      fg: '#2b2520',
      comment: '#9c9284',
      keyword: '#9d3d1e',
      directive: '#b5562a',
      string: '#3d7a2a',
      number: '#8a5a00',
      type: '#1f5f8b',
      delimiter: '#7a6f62',
      operator: '#5f564d',
      annotation: '#7a3e9d',
    },
    {
      bg: '#fbf7ee',
      fg: '#2b2520',
      lineNo: '#c8bda9',
      cursor: '#b5562a',
      selection: '#f0dcc4',
      lineHighlight: '#f4ecdd',
      widgetBg: '#fffdf7',
      widgetBorder: '#e2d8c6',
    },
    {
      c1: '#2f6fae',
      c2: '#c9622f',
      c3: '#2f8f74',
      c4: '#b8860b',
      c5: '#b95c8a',
      c6: '#5e8f2e',
      c7: '#7b4fa8',
      c8: '#b83b3b',
      special: '#a09383',
    },
  ),
  spec(
    'solar-light',
    'Solarized Light',
    'light',
    {
      surface: '#fdf6e3',
      page: '#eee8d5',
      text: '#073642',
      text2: '#586e75',
      muted: '#93a1a1',
      grid: '#e4dcc4',
      baseline: '#c9c1a8',
      border: '#ddd6c1',
      accent: '#268bd2',
      error: '#dc322f',
      warn: '#b58900',
      ok: '#859900',
    },
    {
      fg: '#657b83',
      comment: '#93a1a1',
      keyword: '#859900',
      directive: '#cb4b16',
      string: '#2aa198',
      number: '#d33682',
      type: '#b58900',
      delimiter: '#586e75',
      operator: '#586e75',
      annotation: '#6c71c4',
    },
    {
      bg: '#fdf6e3',
      fg: '#657b83',
      lineNo: '#c9c1a8',
      cursor: '#268bd2',
      selection: '#e4dcc4',
      lineHighlight: '#eee8d5',
      widgetBg: '#fdf6e3',
      widgetBorder: '#d3cbb7',
    },
    {
      c1: '#268bd2',
      c2: '#cb4b16',
      c3: '#2aa198',
      c4: '#b58900',
      c5: '#d33682',
      c6: '#859900',
      c7: '#6c71c4',
      c8: '#dc322f',
      special: '#93a1a1',
    },
  ),
  spec(
    'nocturne',
    'Nocturne',
    'dark',
    {
      surface: '#1a1a19',
      page: '#0d0d0d',
      text: '#ffffff',
      text2: '#c3c2b7',
      muted: '#898781',
      grid: '#2c2c2a',
      baseline: '#383835',
      border: '#2f2f2d',
      accent: '#3987e5',
      error: '#e66767',
      warn: '#fab219',
      ok: '#0ca30c',
    },
    {
      fg: '#d6deeb',
      comment: '#637777',
      keyword: '#c792ea',
      directive: '#f78c6c',
      string: '#ecc48d',
      number: '#f78c6c',
      type: '#82aaff',
      delimiter: '#7fdbca',
      operator: '#7fdbca',
      annotation: '#c792ea',
    },
    {
      bg: '#0f1420',
      fg: '#d6deeb',
      lineNo: '#3b4763',
      cursor: '#80a4ff',
      selection: '#1d3b6a',
      lineHighlight: '#161d2e',
      widgetBg: '#151b2b',
      widgetBorder: '#28324a',
    },
    {
      c1: '#82aaff',
      c2: '#f78c6c',
      c3: '#7fdbca',
      c4: '#ffcb6b',
      c5: '#ff869a',
      c6: '#addb67',
      c7: '#c792ea',
      c8: '#ef5350',
      special: '#5f6b8a',
    },
  ),
  spec(
    'nord',
    'Nord',
    'dark',
    {
      surface: '#2e3440',
      page: '#242933',
      text: '#eceff4',
      text2: '#c7cfdb',
      muted: '#8a93a5',
      grid: '#3b4252',
      baseline: '#4c566a',
      border: '#3f4757',
      accent: '#88c0d0',
      onAccent: '#2e3440',
      error: '#bf616a',
      warn: '#ebcb8b',
      ok: '#a3be8c',
    },
    {
      fg: '#d8dee9',
      comment: '#616e88',
      keyword: '#81a1c1',
      directive: '#5e81ac',
      string: '#a3be8c',
      number: '#b48ead',
      type: '#8fbcbb',
      delimiter: '#eceff4',
      operator: '#81a1c1',
      annotation: '#d08770',
    },
    {
      bg: '#2e3440',
      fg: '#d8dee9',
      lineNo: '#4c566a',
      cursor: '#d8dee9',
      selection: '#434c5e',
      lineHighlight: '#3b4252',
      widgetBg: '#3b4252',
      widgetBorder: '#4c566a',
    },
    {
      c1: '#81a1c1',
      c2: '#d08770',
      c3: '#8fbcbb',
      c4: '#ebcb8b',
      c5: '#b48ead',
      c6: '#a3be8c',
      c7: '#5e81ac',
      c8: '#bf616a',
      special: '#616e88',
    },
  ),
  spec(
    'solar-dark',
    'Solarized Dark',
    'dark',
    {
      surface: '#073642',
      page: '#002b36',
      text: '#eee8d5',
      text2: '#93a1a1',
      muted: '#657b83',
      grid: '#0d4452',
      baseline: '#26535f',
      border: '#144b58',
      accent: '#268bd2',
      error: '#dc322f',
      warn: '#b58900',
      ok: '#859900',
    },
    {
      fg: '#839496',
      comment: '#586e75',
      keyword: '#859900',
      directive: '#cb4b16',
      string: '#2aa198',
      number: '#d33682',
      type: '#b58900',
      delimiter: '#93a1a1',
      operator: '#93a1a1',
      annotation: '#6c71c4',
    },
    {
      bg: '#002b36',
      fg: '#839496',
      lineNo: '#405a63',
      cursor: '#93a1a1',
      selection: '#0f4a5a',
      lineHighlight: '#073642',
      widgetBg: '#073642',
      widgetBorder: '#26535f',
    },
    {
      c1: '#268bd2',
      c2: '#cb4b16',
      c3: '#2aa198',
      c4: '#b58900',
      c5: '#d33682',
      c6: '#859900',
      c7: '#6c71c4',
      c8: '#dc322f',
      special: '#586e75',
    },
  ),
];

export const THEMES: Theme[] = PRESET_SPECS.map((s) => compileTheme(s, true));
export const DEFAULT_LIGHT = 'glacier';
export const DEFAULT_DARK = 'nocturne';
