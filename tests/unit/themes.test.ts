// The theme model compiles user-authored specs into the CSS variables the whole
// app is painted with, and into Monaco's theme. It runs on data from
// localStorage and from imported files, so a spec that compiles to nonsense (
// or throws) takes the UI with it: `state/theme.svelte.ts` validates a stored
// spec precisely by compiling it.
import { describe, it, expect } from 'vitest';
import {
  alpha,
  compileTheme,
  isThemeSpec,
  isUsableSpec,
  migrateSpec,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  DEFAULT_MEMBERS,
  EDITOR_FIELDS,
  MEMBER_FIELDS,
  mix,
  PAGE_FIELDS,
  PRESET_SPECS,
  SYNTAX_FIELDS,
  THEMES,
  toHex6,
  type ThemeSpec,
} from '$core/themes';

const spec = (over: Partial<ThemeSpec> = {}): ThemeSpec => ({
  ...PRESET_SPECS[0]!,
  id: 'test',
  name: 'Test',
  ...over,
});

describe('colour helpers', () => {
  it('mixes two hex colours, and passes non-hex through untouched', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('rgb(0 0 0)', '#ffffff', 0.5)).toBe('rgb(0 0 0)');
  });

  it('appends alpha as a hex pair', () => {
    expect(alpha('#112233', 1)).toBe('#112233ff');
    expect(alpha('#112233', 0)).toBe('#11223300');
    expect(alpha('var(--x)', 0.5)).toBe('var(--x)');
  });

  it('normalises to #rrggbb for the colour input, falling back when it cannot', () => {
    expect(toHex6('#AABBCC')).toBe('#aabbcc');
    expect(toHex6('#aabbccdd')).toBe('#aabbcc'); // alpha dropped
    expect(toHex6('#abc')).toBe('#aabbcc'); // short form expanded
    expect(toHex6('rgb(1 2 3)')).toBe('#888888');
    expect(toHex6('nonsense', '#ff0000')).toBe('#ff0000');
  });
});

describe('compileTheme', () => {
  it('produces the CSS variables the stylesheet expects', () => {
    const t = compileTheme(spec());
    // A representative sample across the groups the editor exposes.
    for (const v of ['--page', '--surface-1', '--text-primary', '--accent', '--editor-bg']) {
      expect(t.tokens[v], v).toMatch(/^#|^rgb|^color-mix|^var\(/);
    }
    // Every member colour slot is defined, since the grid indexes them by name.
    for (let i = 1; i <= 8; i++) expect(t.tokens[`--c-${i}`], `--c-${i}`).toBeTruthy();
    expect(t.tokens['--c-special']).toBeTruthy();
  });

  it('produces a Monaco theme whose base follows the mode', () => {
    expect(compileTheme(spec({ mode: 'dark' })).monaco.base).toBe('vs-dark');
    expect(compileTheme(spec({ mode: 'light' })).monaco.base).toBe('vs');
    const t = compileTheme(spec());
    expect(t.monaco.rules.length).toBeGreaterThan(0);
    // Monaco wants bare hex without the leading '#'.
    for (const r of t.monaco.rules) {
      if (r.foreground !== undefined) expect(r.foreground, r.token).not.toMatch(/^#/);
    }
  });

  it('marks presets read-only and user themes editable', () => {
    expect(compileTheme(spec(), true).preset).toBe(true);
    expect(compileTheme(spec()).preset).toBe(false);
  });

  it('fills in member colours a spec saved before they existed', () => {
    const old = spec();
    delete (old as Partial<ThemeSpec>).members;
    const t = compileTheme(old);
    expect(t.tokens['--c-1']).toBe(DEFAULT_MEMBERS[old.mode].c1);
  });

  it('carries the spec’s own colours through, not the preset’s', () => {
    const t = compileTheme(spec({ page: { ...PRESET_SPECS[0]!.page, accent: '#ff00ff' } }));
    expect(t.tokens['--accent']).toBe('#ff00ff');
  });
});

describe('presets', () => {
  it('every preset compiles: they are what a broken custom theme falls back to', () => {
    expect(PRESET_SPECS.length).toBeGreaterThan(0);
    for (const s of PRESET_SPECS) expect(() => compileTheme(s, true), s.id).not.toThrow();
    expect(THEMES).toHaveLength(PRESET_SPECS.length);
    expect(THEMES.every((t) => t.preset)).toBe(true);
  });

  it('has unique ids, and the named light/dark defaults exist in the right mode', () => {
    const ids = PRESET_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(THEMES.find((t) => t.id === DEFAULT_LIGHT)?.mode).toBe('light');
    expect(THEMES.find((t) => t.id === DEFAULT_DARK)?.mode).toBe('dark');
  });

  it('the editor’s field lists match the colours a spec actually has', () => {
    const s = PRESET_SPECS[0]!;
    for (const f of PAGE_FIELDS) expect(s.page[f.key], `page.${f.key}`).toBeTruthy();
    for (const f of SYNTAX_FIELDS) expect(s.syntax[f.key], `syntax.${f.key}`).toBeTruthy();
    for (const f of EDITOR_FIELDS) expect(s.editor[f.key], `editor.${f.key}`).toBeTruthy();
    for (const f of MEMBER_FIELDS) expect(s.members[f.key], `members.${f.key}`).toBeTruthy();
  });
});

describe('specs from outside the app', () => {
  it('accepts a well-formed spec and rejects malformed ones', () => {
    expect(isThemeSpec(spec())).toBe(true);
    expect(isThemeSpec(null)).toBe(false);
    expect(isThemeSpec('a string')).toBe(false);
    expect(isThemeSpec({})).toBe(false);
    expect(isThemeSpec({ ...spec(), mode: 'sepia' })).toBe(false);
    expect(isThemeSpec({ ...spec(), id: 7 })).toBe(false);
    const noPage: Record<string, unknown> = { ...spec() };
    delete noPage['page'];
    expect(isThemeSpec(noPage)).toBe(false);
  });

  it('migration fills missing member colours without touching the ones given', () => {
    const old: Record<string, unknown> = { ...spec() };
    delete old['members'];
    const filled = migrateSpec(old as unknown as ThemeSpec);
    expect(filled.members).toEqual(DEFAULT_MEMBERS[spec().mode]);

    const partial = migrateSpec({ ...spec(), members: { c1: '#123456' } as never });
    expect(partial.members.c1).toBe('#123456');
    expect(partial.members.c2).toBe(DEFAULT_MEMBERS[spec().mode].c2);
  });

  it('a spec is usable only if it compiles, which is what guards startup', () => {
    expect(isUsableSpec(spec())).toBe(true);
    expect(isUsableSpec({ ...spec(), mode: 'nope' })).toBe(false);
    // Shape-valid but compiles to nothing usable: page is not a colour map.
    expect(isUsableSpec({ ...spec(), page: 'red' })).toBe(false);
  });
});
