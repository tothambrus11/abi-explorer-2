// Theme selection and user themes. Tracks the current theme plus the last-used
// light and dark themes (so the light/dark switch flips between favourites),
// and stores custom theme specs. Persisted in localStorage; before any choice
// the OS colour scheme decides.

export type ColorGroup = 'page' | 'syntax' | 'editor' | 'members';

import {
  compileTheme,
  isUsableSpec,
  migrateSpec,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  PRESET_SPECS,
  THEMES,
  type Theme,
  type ThemeMode,
  type ThemeSpec,
} from '$core/themes';

const KEY = 'abix-theme';
const CUSTOM_KEY = 'abix-custom-themes';

interface Persisted {
  current?: string | null;
  light?: string;
  dark?: string;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

function loadCustomSpecs(): ThemeSpec[] {
  const raw = loadJson<unknown>(CUSTOM_KEY, []);
  return (Array.isArray(raw) ? raw : []).filter(isUsableSpec).map(migrateSpec);
}
function loadPersisted(): Persisted {
  const raw = loadJson<unknown>(KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

class ThemeStore {
  private saved = loadPersisted();
  /** User-authored theme specs. */
  custom: ThemeSpec[] = $state(loadCustomSpecs());
  /** Editor window state. */
  editorOpen = $state(false);
  editingId: string | null = $state(null);
  /** Colour currently being edited in the picker: which group/key of the editing theme. */
  picking: { group: ColorGroup; key: string } | null = $state(null);
  /** The picker lives at the bottom of the theme editor unless detached into its own window. */
  pickerDetached = $state(false);

  /** Compiled custom themes, memoized per spec object (update() replaces only the edited spec). */
  private compiled = new WeakMap<ThemeSpec, Theme>();
  all: Theme[] = $derived([
    ...THEMES,
    ...this.custom.map((s) => {
      let t = this.compiled.get(s);
      if (!t) {
        t = compileTheme(s, false);
        this.compiled.set(s, t);
      }
      return t;
    }),
  ]);
  lastLight = $state(DEFAULT_LIGHT);
  lastDark = $state(DEFAULT_DARK);
  /** Explicit choice; null = follow the OS. */
  chosen: string | null = $state(null);
  osDark = $state(mql?.matches ?? false);

  current: Theme = $derived.by(() => {
    const id = this.chosen ?? (this.osDark ? this.lastDark : this.lastLight);
    return this.byId(id) ?? THEMES[0]!;
  });
  mode: ThemeMode = $derived(this.current.mode);

  constructor() {
    const light = this.saved.light ? this.byId(this.saved.light) : undefined;
    const dark = this.saved.dark ? this.byId(this.saved.dark) : undefined;
    if (light?.mode === 'light') this.lastLight = light.id;
    if (dark?.mode === 'dark') this.lastDark = dark.id;
    if (this.saved.current && this.byId(this.saved.current)) this.chosen = this.saved.current;
    mql?.addEventListener('change', (e) => (this.osDark = e.matches));
  }

  byId(id: string): Theme | undefined {
    return this.all.find((t) => t.id === id);
  }

  select(id: string): void {
    const t = this.byId(id);
    if (!t) return;
    this.chosen = id;
    if (t.mode === 'light') {
      this.lastLight = id;
      // A theme whose mode changed must not stay the "last" of the other mode,
      // or the light/dark toggle would flip to itself.
      if (this.lastDark === id) this.lastDark = DEFAULT_DARK;
    } else {
      this.lastDark = id;
      if (this.lastLight === id) this.lastLight = DEFAULT_LIGHT;
    }
    this.persist();
  }

  /** Flip between the last-used light and dark themes. */
  toggleMode(): void {
    this.select(this.mode === 'dark' ? this.lastLight : this.lastDark);
  }

  // ------------------------------------------------------ custom themes --

  /** Create a new custom theme from an existing one; returns its id. */
  duplicate(fromId: string, name?: string): string {
    const src = this.byId(fromId) ?? this.current;
    const id = 'custom-' + Math.random().toString(36).slice(2, 8);
    const spec: ThemeSpec = {
      id,
      name: name ?? `${src.name} copy`,
      mode: src.mode,
      page: { ...src.page },
      syntax: { ...src.syntax },
      editor: { ...src.editor },
      members: { ...src.members },
    };
    this.custom = [...this.custom, spec];
    this.persistCustom();
    this.select(id);
    return id;
  }

  update(id: string, patch: (spec: ThemeSpec) => void): void {
    const i = this.custom.findIndex((s) => s.id === id);
    if (i < 0) return;
    const next = structuredClone($state.snapshot(this.custom[i]!));
    patch(next);
    this.custom = this.custom.map((s, j) => (j === i ? next : s));
    this.persistCustom();
    // keep last-light/dark consistent if the mode changed
    if (this.chosen === id) this.select(id);
  }

  remove(id: string): void {
    const spec = this.custom.find((s) => s.id === id);
    if (!spec) return;
    this.custom = this.custom.filter((s) => s.id !== id);
    this.persistCustom();
    const fallback = spec.mode === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK;
    if (this.lastLight === id) this.lastLight = DEFAULT_LIGHT;
    if (this.lastDark === id) this.lastDark = DEFAULT_DARK;
    if (this.chosen === id) this.select(fallback);
    if (this.editingId === id) this.editingId = null;
    this.persist();
  }

  isPresetId(id: string): boolean {
    return PRESET_SPECS.some((s) => s.id === id);
  }

  exportSpec(id: string): string | null {
    const t = this.byId(id);
    if (!t) return null;
    const { page, syntax, editor, members, name, mode } = t;
    return JSON.stringify({ name, mode, page, syntax, editor, members }, null, 2);
  }

  importSpec(json: string): string | null {
    try {
      const raw = JSON.parse(json) as Partial<ThemeSpec>;
      const id = 'custom-' + Math.random().toString(36).slice(2, 8);
      const spec0 = { ...raw, id, name: raw.name ?? 'Imported theme' } as ThemeSpec;
      if (!isUsableSpec(spec0)) return null; // validated (compiled) before it is persisted
      const spec = migrateSpec(spec0);
      this.custom = [...this.custom, spec];
      this.persistCustom();
      this.select(id);
      return id;
    } catch {
      return null;
    }
  }

  private persist(): void {
    saveJson(KEY, {
      current: this.chosen,
      light: this.lastLight,
      dark: this.lastDark,
    } satisfies Persisted);
  }
  private persistCustom(): void {
    saveJson(CUSTOM_KEY, $state.snapshot(this.custom));
  }
}

export const theme = new ThemeStore();

/** Apply the theme's tokens to :root (call from an effect). */
export function applyThemeTokens(t: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(k, v);
  root.dataset['theme'] = t.mode;
  root.style.colorScheme = t.mode;
  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', t.tokens['--page'] ?? '');
}
