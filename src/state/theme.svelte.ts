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

/** Parsed JSON from storage, or `fallback` when it is absent, unreadable or malformed. */
function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
/** Stores `value` as JSON, or silently does not, where storage refuses. */
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

/**
 * The user's own themes, as this version understands them.
 *
 * Anything stored that is not a usable spec is dropped rather than repaired:
 * these come from an older build or a hand-edited value, and a half-valid
 * theme paints the app with undefined variables. What survives is migrated to
 * the current shape.
 */
function loadCustomSpecs(): ThemeSpec[] {
  const raw = loadJson<unknown>(CUSTOM_KEY, []);
  return (Array.isArray(raw) ? raw : []).filter(isUsableSpec).map(migrateSpec);
}
/** The remembered selection; empty when nothing usable is stored. */
function loadPersisted(): Persisted {
  const raw = loadJson<unknown>(KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/**
 * Which theme is showing, which are available, and which the reader last used
 * in each mode.
 *
 * A singleton, exported as `theme` below. Presets ship and cannot be changed;
 * everything else is the user's, stored in this browser. Nothing here touches
 * the document: `applyThemeTokens` does that, from an effect.
 */
/** Does this id name a theme the app ships? */
function isPresetId(id: string): boolean {
  return PRESET_SPECS.some((s) => s.id === id);
}

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
  /**
   * The reader put the picker back in the panel. Picking a colour opens the
   * picker in a window of its own, which is not what someone who has just
   * attached it wants to happen to their next press.
   */
  pickerAttachedByHand = $state(false);

  /** Moves the picker, and remembers that the move was asked for. */
  setPickerDetached(detached: boolean): void {
    this.pickerDetached = detached;
    this.pickerAttachedByHand = !detached;
  }

  /**
   * Starts picking a colour, and brings the picker to where it can be used:
   * its own window, unless the screen is too narrow for one or the reader has
   * put it back in the panel. Passing the same field again stops picking.
   */
  pick(group: ColorGroup, key: string, canDetach: boolean): void {
    const same = this.picking?.group === group && this.picking.key === key;
    this.picking = same ? null : { group, key };
    if (!same && canDetach && !this.pickerAttachedByHand) this.pickerDetached = true;
  }

  /** Compiled custom themes, memoized per spec object (update() replaces only the edited spec). */
  private compiled = new WeakMap<ThemeSpec, Theme>();
  private compile(spec: ThemeSpec, preset: boolean): Theme {
    let t = this.compiled.get(spec);
    if (!t) {
      t = compileTheme(spec, preset);
      this.compiled.set(spec, t);
    }
    return t;
  }
  /**
   * The specs in `custom` that stand for a shipped theme rather than a new
   * one: an edited preset is stored under the preset's own id, so it takes
   * the preset's place here rather than appearing beside it.
   */
  private edits: Map<string, ThemeSpec> = $derived(
    new Map(this.custom.filter((s) => isPresetId(s.id)).map((s) => [s.id, s])),
  );
  /** The themes the reader authored: everything in `custom` that is not an edit of a preset. */
  mine: ThemeSpec[] = $derived(this.custom.filter((s) => !isPresetId(s.id)));
  all: Theme[] = $derived([
    // A preset keeps its place in the list whether or not it has been edited:
    // it is the same theme, with the reader's colours in it.
    ...THEMES.map((t) => {
      const edit = this.edits.get(t.id);
      return edit ? this.compile(edit, true) : t;
    }),
    ...this.mine.map((s) => this.compile(s, false)),
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
  /**
   * A theme being tried rather than chosen: the pointer is resting on it in
   * the list. Nothing is remembered and nothing is persisted; it ends when
   * the pointer moves on.
   */
  previewing: string | null = $state(null);
  /**
   * The theme to draw in: the one being tried while there is one, else the
   * one chosen. What the page and the editor follow.
   */
  shown: Theme = $derived.by(() => {
    const t = this.previewing === null ? undefined : this.byId(this.previewing);
    return t ?? this.current;
  });
  /**
   * The mode of the *chosen* theme, not of the one being tried: it is what the
   * light/dark button flips, and a theme under the pointer must not change
   * what pressing it would do.
   */
  mode: ThemeMode = $derived(this.current.mode);

  /**
   * Restores the remembered selection, ignoring any part of it that no longer
   * names a theme of the right mode, and follows the OS's light/dark
   * preference from here on.
   */
  constructor() {
    const light = this.saved.light ? this.byId(this.saved.light) : undefined;
    const dark = this.saved.dark ? this.byId(this.saved.dark) : undefined;
    if (light?.mode === 'light') this.lastLight = light.id;
    if (dark?.mode === 'dark') this.lastDark = dark.id;
    if (this.saved.current && this.byId(this.saved.current)) this.chosen = this.saved.current;
    mql?.addEventListener('change', (e) => (this.osDark = e.matches));
  }

  /** The theme with this id, preset or custom, or `undefined` if there is none. */
  byId(id: string): Theme | undefined {
    return this.all.find((t) => t.id === id);
  }

  /**
   * Wears `id` without choosing it, or stops (null). An unknown id stops too:
   * there is nothing to show.
   */
  preview(id: string | null): void {
    this.previewing = id !== null && this.byId(id) ? id : null;
  }

  /**
   * Chooses a theme and remembers it, for this mode and across visits.
   *
   * An unknown id does nothing rather than clearing the choice. Selecting a
   * theme also makes it the "last" of its own mode, and releases it from the
   * other one: a theme edited from dark to light would otherwise still be what
   * the light/dark toggle flips *to*, so the toggle would flip to itself.
   */
  select(id: string): void {
    const t = this.byId(id);
    if (!t) return;
    this.previewing = null;
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

  /**
   * Flips to the last theme used in the other mode.
   *
   * Not to a fixed pair: a reader who picked one light and one dark theme gets
   * their own two back, which is what makes the toggle worth pressing twice.
   */
  toggleMode(): void {
    this.select(this.mode === 'dark' ? this.lastLight : this.lastDark);
  }

  // ------------------------------------------------------ custom themes --

  /**
   * Copies a theme into a new editable one and selects it, returning its id.
   *
   * Copies the current theme when `fromId` names none, since the alternative is
   * refusing to create anything. Presets are never modified; this is the only
   * way to base a theme on one.
   */
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

  /**
   * Edits a theme in place, through `patch`.
   *
   * `patch` mutates a private copy, so it may write freely; an unknown id does
   * nothing. A shipped theme is editable too: the first change makes a copy of
   * what shipped, stored under the same id, so the theme keeps its name and
   * its place and `reset` can throw the copy away. Re-selects when the theme
   * being edited is the one showing, since an edit can change its mode and
   * with it which theme the light/dark toggle should flip to.
   */
  update(id: string, patch: (spec: ThemeSpec) => void): void {
    const i = this.custom.findIndex((s) => s.id === id);
    const from = i >= 0 ? this.custom[i]! : PRESET_SPECS.find((s) => s.id === id);
    if (!from) return;
    const next = structuredClone($state.snapshot(from));
    patch(next);
    this.custom = i >= 0 ? this.custom.map((s, j) => (j === i ? next : s)) : [...this.custom, next];
    this.persistCustom();
    // keep last-light/dark consistent if the mode changed
    if (this.chosen === id) this.select(id);
  }

  /** Has this shipped theme been edited? False for anything else. */
  isEdited(id: string): boolean {
    return this.edits.has(id);
  }

  /**
   * Throws away the edits to a shipped theme, leaving what shipped.
   *
   * The theme itself stays: it keeps its id, so the selection, either mode's
   * last theme and the editor all go on naming something that exists. Does
   * nothing for a theme that ships unedited, or one the reader authored, which
   * has no original to go back to.
   */
  reset(id: string): void {
    if (!this.isEdited(id)) return;
    this.custom = this.custom.filter((s) => s.id !== id);
    this.persistCustom();
    if (this.chosen === id) this.select(id);
  }

  /**
   * Deletes a theme the reader authored, and moves anything pointing at it out
   * of the way.
   *
   * An unknown id does nothing, and so does a shipped one: a preset has no
   * deleting, only `reset`, since the app ships it either way. Whatever referred to it — the
   * selection, either mode's last theme, the editor — falls back to a default
   * of the same mode, so nothing is left naming a theme that no longer exists.
   */
  remove(id: string): void {
    if (isPresetId(id)) return;
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

  /** Does this id name a theme that ships? A shipped theme can be edited, but not deleted. */
  isPresetId(id: string): boolean {
    return isPresetId(id);
  }

  /**
   * A theme as JSON to share, or `null` for an unknown id.
   *
   * The id is deliberately left out: importing assigns a fresh one, so a shared
   * theme can never collide with or overwrite one the recipient already has.
   */
  exportSpec(id: string): string | null {
    const t = this.byId(id);
    if (!t) return null;
    const { page, syntax, editor, members, name, mode } = t;
    return JSON.stringify({ name, mode, page, syntax, editor, members }, null, 2);
  }

  /**
   * Adds a shared theme and selects it, returning its new id.
   *
   * Total: `null` for anything that is not a theme this app can compile —
   * malformed JSON, a missing group, an unparseable colour — and nothing is
   * stored in that case. Validation is by compiling, because a spec that is
   * shape-valid but wrong paints the app with undefined CSS variables rather
   * than failing.
   */
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

  /** Remembers the selection: what is showing, and the last of each mode. */
  private persist(): void {
    saveJson(KEY, {
      current: this.chosen,
      light: this.lastLight,
      dark: this.lastDark,
    } satisfies Persisted);
  }
  /** Stores the user's own themes. Call after every change to `custom`. */
  private persistCustom(): void {
    saveJson(CUSTOM_KEY, $state.snapshot(this.custom));
  }
}

export const theme = new ThemeStore();

/**
 * Paints a theme onto the document.
 *
 * Writes every token, the `data-theme` attribute and `color-scheme`, so the
 * page and the browser's own widgets agree about the mode. Call from an effect:
 * it touches the DOM and overwrites whatever was applied before.
 */
export function applyThemeTokens(t: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(k, v);
  root.dataset['theme'] = t.mode;
  root.style.colorScheme = t.mode;
  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', t.tokens['--page'] ?? '');
}
