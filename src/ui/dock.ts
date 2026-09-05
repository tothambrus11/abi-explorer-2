// Panel management with dockview: every source has a Code, a Layout and a
// Diagnostics panel, all dockable, splittable and tabbable; the theme editor
// is a floating group. Panels render Svelte components; the layout is
// persisted in localStorage.
//
// Panels of one kind start out sharing a group, so a group is "the Layout
// group" and its tabs are the sources. Putting a source in focus brings its
// panel forward in every group that has one and leaves the others alone, so
// that clicking a source's Source tab shows its layout, and hovering a layout
// shows its code, wherever the reader has put either.

import {
  createDockview,
  registerModules,
  FloatingGroupModule,
  type DockviewApi,
  type DockviewGroupPanel,
  type IContentRenderer,
  type IDockviewPanel,
  type IHeaderActionsRenderer,
  type DockviewTheme,
  type ITabRenderer,
  type SerializedDockview,
  type AddPanelOptions,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { mount, unmount, type Component } from 'svelte';
import type { Session } from '$state/session.svelte';
import { store, type Source } from '$state/store.svelte';
import { isDockLayout } from '$core/url-state';
import { theme } from '$state/theme.svelte';
import EditorPane from './EditorPane.svelte';
import ResultsPane from './ResultsPane.svelte';
import Diagnostics from './Diagnostics.svelte';
import ThemeEditorPanel from './ThemeEditorPanel.svelte';
import ColorPicker from './ColorPicker.svelte';
import PanelTab from './PanelTab.svelte';
import GroupActions from './GroupActions.svelte';
import AddSource from './AddSource.svelte';
import { KINDS, KIND_TITLES, panelId, parsePanelId, type PanelKind } from './panels';

// v3: panels are per source and named after it, so a layout saved by v2 names
// panels that no longer exist. Retired rather than migrated; the cost is one
// reset of hand-arranged panels.
/**
 * The shapes a window comes in, each with an arrangement of its own: wide;
 * short (a phone held sideways: room beside, none below); and narrow, where
 * nothing sits beside anything and every group takes the full width.
 */
type Shape = 'wide' | 'short' | 'narrow';
const LAYOUT_KEYS: Record<Shape, string> = {
  wide: 'abix-dock-layout-v3',
  narrow: 'abix-dock-layout-narrow-v3',
  short: 'abix-dock-layout-short-v3',
};
/** Below this many pixels of dock, groups stack rather than share a row. */
const STACK_BELOW = 760;
/** Retired by the bumps above; nothing will ever read them again. */
const LEGACY_LAYOUT_KEYS = [
  'abix-dock-layout-v1',
  'abix-dock-layout-narrow-v1',
  'abix-dock-layout-short-v1',
  'abix-dock-layout-v2',
  'abix-dock-layout-narrow-v2',
  'abix-dock-layout-short-v2',
];
/** The one tab renderer: every source panel's tab carries its source's state. */
const TAB = 'source-tab';
export const PANEL_THEME = 'theme-editor';
export const PANEL_PICKER = 'color-picker';

/**
 * A stored layout names panels by the *position* of their source, since the
 * ids are the visit's own. `editor:12` is saved as `editor:#0` when source 12
 * is first in the list, and read back as whichever source is first now.
 */
const SAVED_ID = /"(editor|layout|diagnostics):#(\d+)"/g;
const LIVE_ID = /"(editor|layout|diagnostics):(\d+)"/g;
/** A stored panel id, with the kind it must be rendered as. */
const SAVED_PANEL = /^(editor|layout|diagnostics):#\d+$/;

/**
 * Whether a serialized arrangement names only panels this dock has: a
 * source's, saved by position, or the two floating windows, each rendered as
 * itself. A link is a stranger's input, and `isDockLayout` checks only its
 * shape; an arrangement with anything else in it is not put back at all,
 * since a half-known desk is worse than the reader's own.
 */
const knowsEveryPanel = (parsed: unknown): boolean => {
  const panels = (parsed as { panels?: unknown }).panels;
  if (typeof panels !== 'object' || panels === null) return false;
  return Object.entries(panels as Record<string, unknown>).every(([key, state]) => {
    if (typeof state !== 'object' || state === null) return false;
    const { id, contentComponent, tabComponent } = state as Record<string, unknown>;
    if (id !== key || typeof id !== 'string') return false;
    const m = SAVED_PANEL.exec(id);
    if (m) return contentComponent === m[1] && tabComponent === TAB;
    return (id === PANEL_THEME || id === PANEL_PICKER) && contentComponent === id;
  });
};

/** Our dockview theme: only a class name; the CSS variables live in app.css and follow the app tokens. */
const ABIX_THEME: DockviewTheme = {
  name: 'abix',
  className: 'dockview-theme-abix',
  gap: 10,
  dndOverlayMounting: 'absolute',
  dndPanelOverlay: 'group',
  dndTabIndicator: 'line',
  dndOverlayBorder: '2px solid var(--dv-active-sash-color)',
};

registerModules([FloatingGroupModule]);

/** A mounted dock: what the app is allowed to ask of its panel layout. */
export interface Dock {
  api: DockviewApi;
  /**
   * Give every new source its panels and take a gone source's away. Call
   * whenever the list of sources changes; panels the reader closed stay
   * closed.
   */
  sync(): void;
  /** Bring `sourceId`'s panel forward in every group that has one of the kind it is showing. */
  showSource(sourceId: number): void;
  /** Which of a source's panels are open. */
  panelsOf(sourceId: number): PanelKind[];
  /** Open a source's panel if it is closed, and close it if it is open. */
  togglePanel(kind: PanelKind, sourceId: number): void;
  /** Hear about any change to what is open and where. */
  onDidChange(listener: () => void): () => void;
  /** Recompute what the tabs and group headers say, after a source is renamed. */
  refresh(): void;
  /** Throw away the arrangement, stored one included, and rebuild the default. */
  resetLayout(): void;
  /** Bring up the theme editor, focusing it if it is already open. */
  openThemeEditor(): void;
  /** Show the colour picker in its own floating window (below the theme editor) or close it. */
  setPickerDetached(detached: boolean): void;
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;

/** What the dock keeps of a mounted tab: the one thing it tells it after mounting. */
interface TabInstance {
  setMixed(mixed: boolean): void;
}
interface ActionsInstance {
  refresh(): void;
}

/**
 * Fills `container` with the panels, and returns the handle to them.
 *
 * Restores the arrangement stored for this shape of window (wide, narrow or
 * short) and falls back to the default when there is none, or when what is
 * stored no longer describes the panels this version has. Each panel is
 * mounted with its source and that source's session.
 *
 * The caller owns the result: `dispose` unmounts the components and detaches
 * the listeners, and must be called before the container goes away.
 */
export function mountDock(container: HTMLElement, session: Session): Dock {
  const components: Record<string, () => AnyComponent> = {
    editor: () => EditorPane,
    layout: () => ResultsPane,
    diagnostics: () => Diagnostics,
    [PANEL_THEME]: () => ThemeEditorPanel,
    [PANEL_PICKER]: () => ColorPicker,
  };

  const sourceOf = (id: string): Source | null => {
    const parsed = parsePanelId(id);
    return parsed ? (store.sources.find((s) => s.id === parsed.sourceId) ?? null) : null;
  };
  const kindOf = (panel: IDockviewPanel): PanelKind | null => parsePanelId(panel.id)?.kind ?? null;

  const tabs = new Map<string, TabInstance>();
  const labels = new Map<string, HTMLElement>();
  /** Every header component with something to recompute, by group. */
  const actions = new Map<string, ActionsInstance[]>();
  const remember = (gid: string, instance: ActionsInstance): void => {
    actions.set(gid, [...(actions.get(gid) ?? []), instance]);
  };
  const forget = (gid: string, instance: ActionsInstance | null): void => {
    const kept = (actions.get(gid) ?? []).filter((x) => x !== instance);
    if (kept.length) actions.set(gid, kept);
    else actions.delete(gid);
  };
  const listeners = new Set<() => void>();
  /** Sources that have had their panels; a source not here gets them on `sync`. */
  const known = new Set<number>();
  /** Set while a stored layout is being put back, when panel activations are its and not the reader's. */
  let restoring = false;
  /** Set while panels are brought forward by this code, for the same reason. */
  let switching = false;
  /** Runs `fn` with panel activations counted as this code's, not the reader's. */
  const quietly = (fn: () => void): void => {
    const was = switching;
    switching = true;
    try {
      fn();
    } finally {
      switching = was;
    }
  };
  /** Set while an arrangement is torn down to be rebuilt, when a floating window going is not it closing. */
  let rebuilding = false;

  const api = createDockview(container, {
    theme: ABIX_THEME,
    // Only the source panels ask for one; everything else keeps dockview's
    // own tab, which is what `undefined` means here.
    createTabComponent: (options): ITabRenderer | undefined => {
      if (options.name !== TAB) return undefined;
      const source = sourceOf(options.id);
      const kind = parsePanelId(options.id)?.kind;
      // A stored layout naming a source this visit does not have: the
      // placeholder is removed the moment the layout is restored.
      if (!source || !kind) return undefined;
      const element = document.createElement('div');
      element.className = 'dock-tab';
      let instance: (Record<string, unknown> & TabInstance) | null = null;
      return {
        element,
        init(params) {
          instance = mount(PanelTab, {
            target: element,
            props: {
              source,
              kind,
              // A custom tab renders its own close button: dockview's lives in
              // the default tab, not in the frame around it.
              close: () => {
                params.api.close();
              },
            },
          }) as Record<string, unknown> & TabInstance;
          tabs.set(options.id, instance);
        },
        dispose() {
          tabs.delete(options.id);
          if (instance) void unmount(instance);
          instance = null;
        },
      };
    },
    disableFloatingGroups: false,
    floatingGroupBounds: 'boundedWithinViewport',
    createComponent: (options): IContentRenderer => {
      const element = document.createElement('div');
      element.className = 'dock-panel dock-panel-' + options.name;
      let instance: Record<string, unknown> | null = null;
      // A stored layout naming a source position this visit does not have:
      // nothing to draw, and it is removed the moment the layout is restored.
      if (options.id.includes(':#')) return { element, init() {}, dispose() {} };
      return {
        element,
        init() {
          const factory = components[options.name];
          const kind = parsePanelId(options.id)?.kind;
          if (!factory) {
            element.textContent = `Unknown panel: ${options.name}`;
            return;
          }
          if (!kind) {
            instance = mount(factory(), {
              target: element,
              props: { detached: options.name === PANEL_PICKER },
            });
            return;
          }
          const source = sourceOf(options.id);
          if (!source) return; // a placeholder from a stored layout; removed after restore
          instance = mount(factory(), {
            target: element,
            props: { source, session: session.for(source) },
          });
          // Pointing at a panel is looking at its source: its other panels
          // come forward wherever they are, for as long as the pointer stays,
          // and nothing is chosen by it. Pressing or typing inside chooses,
          // as pressing a tab does, so what is typed into never hides
          // mid-word. Focus alone does not: the panel a peek brings forward is
          // given the focus by dockview, and that is nobody's choice. The tab
          // itself does not peek; a tab is switched by pressing it.
          element.addEventListener('mouseenter', () => {
            peekAt(source.id);
          });
          element.addEventListener('mouseleave', () => {
            peekAt(null);
          });
          element.addEventListener('mousedown', () => {
            store.selectSourceById(source.id);
          });
          element.addEventListener('keydown', () => {
            store.selectSourceById(source.id);
          });
        },
        dispose() {
          if (instance) void unmount(instance);
          instance = null;
        },
      };
    },
    // Before the tabs: what the group holds, when its tabs are sources rather
    // than kinds. Filled in by `refresh`.
    createPrefixHeaderActionComponent: (group): IHeaderActionsRenderer => {
      const element = document.createElement('div');
      element.className = 'dock-group-label';
      element.hidden = true;
      labels.set(group.id, element);
      return {
        element,
        init() {},
        dispose() {
          labels.delete(group.id);
        },
      };
    },
    // Against the tabs, and outside the box they scroll in, so it is still
    // there when there are more tabs than fit: the new-source button.
    createLeftHeaderActionComponent: (group): IHeaderActionsRenderer => {
      const element = document.createElement('div');
      element.className = 'dock-group-add';
      let instance: (Record<string, unknown> & ActionsInstance) | null = null;
      return {
        element,
        init() {
          instance = mount(AddSource, {
            target: element,
            props: {
              group,
              addSource: () => {
                addSourceIn(group);
              },
            },
          }) as Record<string, unknown> & ActionsInstance;
          remember(group.id, instance);
        },
        dispose() {
          forget(group.id, instance);
          if (instance) void unmount(instance);
          instance = null;
        },
      };
    },
    // At the far end of the strip: the examples. The row above the editor used
    // to hold these.
    createRightHeaderActionComponent: (group): IHeaderActionsRenderer => {
      const element = document.createElement('div');
      element.className = 'dock-group-actions';
      let instance: (Record<string, unknown> & ActionsInstance) | null = null;
      return {
        element,
        init() {
          instance = mount(GroupActions, {
            target: element,
            props: { group },
          }) as Record<string, unknown> & ActionsInstance;
          remember(group.id, instance);
        },
        dispose() {
          forget(group.id, instance);
          if (instance) void unmount(instance);
          instance = null;
        },
      };
    },
    // Every panel closed: say so, and offer the way back.
    createWatermarkComponent: () => {
      const element = document.createElement('div');
      element.className = 'dock-watermark';
      const text = document.createElement('p');
      text.textContent = 'Every panel is closed. Open one from the sources menu, or';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.textContent = 'reset the layout';
      button.addEventListener('click', () => {
        resetLayout();
      });
      element.append(text, button);
      return { element, init() {}, dispose() {} };
    },
  });

  // After the current tick: `refresh` runs inside the app's effects, and a
  // listener that writes state the same tick would have those effects chase
  // their own tail.
  /**
   * Starts or ends a peek. Ending waits a moment: the pointer crossing a tab
   * bar or a gap on its way from a source's layout to its code must not put
   * the code back before it gets there.
   */
  let peekTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the keyboard was when the peek began, to give it back after. */
  let focusBefore: HTMLElement | null = null;
  const peekAt = (sourceId: number | null): void => {
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = null;
    if (sourceId !== null) {
      if (store.peek === sourceId) return;
      if (store.peek === null) {
        const active = document.activeElement;
        focusBefore = active instanceof HTMLElement && container.contains(active) ? active : null;
      }
      store.peek = sourceId;
      return;
    }
    peekTimer = setTimeout(() => {
      peekTimer = null;
      store.peek = null;
      // A peek that replaced the panel the reader was typing in took the
      // keyboard with it; the panel is back, so the keyboard goes back too.
      const back = focusBefore;
      focusBefore = null;
      if (back?.isConnected && document.activeElement === document.body) back.focus();
    }, 250);
  };

  const announce = () => {
    queueMicrotask(() => {
      for (const l of listeners) l();
    });
  };

  /**
   * Adds `kind`'s panel for `source`, beside the panels of its kind when there
   * are any, else where the default layout puts that kind. Inactive: what is
   * in focus decides what is shown, see `showSource`.
   */
  const addPanelFor = (kind: PanelKind, source: Source): void => {
    const id = panelId(kind, source.id);
    if (api.getPanel(id)) return;
    const first = (k: PanelKind) => api.panels.find((p) => kindOf(p) === k);
    const options: AddPanelOptions = {
      id,
      component: kind,
      tabComponent: TAB,
      title: KIND_TITLES[kind],
      inactive: true,
    };
    const sibling = first(kind);
    const editor = first('editor');
    const layout = first('layout');
    if (sibling) options.position = { referencePanel: sibling.id, direction: 'within' };
    else if (kind === 'layout' && editor) {
      options.position = { referencePanel: editor.id, direction: 'right' };
    } else if (kind === 'diagnostics' && editor) {
      options.position = { referencePanel: editor.id, direction: 'below' };
    } else if (kind === 'diagnostics' && layout) {
      options.position = { referencePanel: layout.id, direction: 'within' };
    } else if (kind === 'editor' && layout) {
      options.position = { referencePanel: layout.id, direction: 'left' };
    }
    api.addPanel(options);
  };

  /**
   * Opens a new source whose Source panel lands in `group`, the one whose "+"
   * was pressed. Its other panels join their kinds, as `sync` puts them; the
   * Source panel is placed here first, so that `sync` finds it and leaves it.
   */
  const addSourceIn = (group: DockviewGroupPanel): void => {
    const source = store.addSource();
    if (!source) return;
    claim();
    api.addPanel({
      id: panelId('editor', source.id),
      component: 'editor',
      tabComponent: TAB,
      title: KIND_TITLES.editor,
      position: { referenceGroup: group, direction: 'within' },
    });
  };

  /**
   * The arrangement as stored and shared: dockview's JSON with every panel
   * named by the position of its source, see `SAVED_ID`.
   */
  const serialize = (): string => {
    const index = new Map(store.sources.map((s, i) => [s.id, i]));
    return JSON.stringify(api.toJSON()).replace(LIVE_ID, (whole, kind: string, id: string) => {
      const i = index.get(Number(id));
      return i === undefined ? whole : `"${kind}:#${String(i)}"`;
    });
  };

  /**
   * Puts a serialized arrangement back, and says whether it could. Panels of
   * sources this visit does not have are dropped; sources the arrangement
   * does not know get their panels beside their kind.
   */
  const restore = (raw: string): boolean => {
    try {
      if (!knowsEveryPanel(JSON.parse(raw))) return false;
    } catch {
      return false;
    }
    const ids = store.sources.map((s) => s.id);
    const json = raw.replace(SAVED_ID, (whole, kind: string, index: string) => {
      const id = ids[Number(index)];
      return id === undefined ? whole : `"${kind}:${String(id)}"`;
    });
    restoring = true;
    try {
      api.fromJSON(JSON.parse(json) as SerializedDockview);
    } catch {
      return false;
    } finally {
      restoring = false;
    }
    quietly(() => {
      for (const p of [...api.panels]) if (p.id.includes(':#')) api.removePanel(p);
    });
    known.clear();
    for (const p of api.panels) {
      const parsed = parsePanelId(p.id);
      if (parsed) known.add(parsed.sourceId);
    }
    // The arrangement knows which tab was in front where, and which group
    // was being used: that group's front panel is the source in focus.
    const front = api.activePanel ? parsePanelId(api.activePanel.id) : null;
    if (front) store.selectSourceById(front.sourceId);
    sync();
    return true;
  };

  const showSource = (sourceId: number): void => {
    quietly(() => {
      for (const group of api.groups) bringForward(group, sourceId);
    });
  };
  /** One group's part of `showSource`: the panel of its kind for `sourceId`, if it has one. */
  const bringForward = (group: DockviewGroupPanel, sourceId: number): void => {
    const current = group.activePanel ? parsePanelId(group.activePanel.id) : null;
    if (!current || current.sourceId === sourceId) return;
    const target = group.panels.find((p) => {
      const q = parsePanelId(p.id);
      return q !== null && q.kind === current.kind && q.sourceId === sourceId;
    });
    // The group keeps its place: bringing a panel forward in a group the
    // reader is not in must not take the focus out of the one they are in.
    if (target) group.model.openPanel(target, { skipSetGroupActive: true });
  };

  /**
   * What the groups say about themselves, recomputed after any change: a
   * group of one kind is labelled with it and its tabs say which source; a
   * group of mixed kinds has its tabs say both. The examples and the
   * new-source button follow the Source panels.
   */
  const refresh = (): void => {
    const multi = store.sources.length > 1;
    for (const group of api.groups) {
      const kinds = new Set<PanelKind>();
      for (const p of group.panels) {
        const k = kindOf(p);
        if (k) kinds.add(k);
      }
      const label = labels.get(group.id);
      if (label) {
        const only = kinds.size === 1 ? [...kinds][0]! : null;
        label.textContent = multi && only ? KIND_TITLES[only] : '';
        label.hidden = !label.textContent;
      }
      for (const p of group.panels) {
        tabs.get(p.id)?.setMixed(kinds.size > 1);
        // The title is what the tab is called to a screen reader and in a
        // stored layout; the tab itself draws its own.
        const parsed = parsePanelId(p.id);
        const source = parsed && store.sources.find((s) => s.id === parsed.sourceId);
        if (parsed && source) {
          const title = multi
            ? `${KIND_TITLES[parsed.kind]} · ${source.name}`
            : KIND_TITLES[parsed.kind];
          if (p.title !== title) p.api.setTitle(title);
        }
      }
      for (const instance of actions.get(group.id) ?? []) instance.refresh();
    }
    announce();
  };

  const sync = (): void => {
    const live = new Set(store.sources.map((s) => s.id));
    // Quietly: taking away a group's front panel makes dockview open its
    // most recently used one, which is not the reader choosing that source.
    quietly(() => {
      for (const p of [...api.panels]) {
        const parsed = parsePanelId(p.id);
        if (parsed && !live.has(parsed.sourceId)) api.removePanel(p);
      }
    });
    for (const id of known) if (!live.has(id)) known.delete(id);
    for (const source of store.sources) {
      if (known.has(source.id)) continue;
      known.add(source.id);
      for (const kind of KINDS) addPanelFor(kind, source);
    }
    showSource(store.shown.id);
    refresh();
  };

  const panelsOf = (sourceId: number): PanelKind[] =>
    KINDS.filter((kind) => api.getPanel(panelId(kind, sourceId)) !== undefined);

  const togglePanel = (kind: PanelKind, sourceId: number): void => {
    const source = store.sources.find((s) => s.id === sourceId);
    if (!source) return;
    const existing = api.getPanel(panelId(kind, sourceId));
    claim();
    if (existing) {
      api.removePanel(existing);
      return;
    }
    addPanelFor(kind, source);
    // Opened on purpose, so it is what the reader wants to see now.
    api.getPanel(panelId(kind, sourceId))?.api.setActive();
    store.selectSourceById(sourceId);
  };

  // Matches the CSS `@media (max-width: 760px)` breakpoint (inclusive) used
  // across the app so the dock arrangement and the components agree.
  const narrow = () => container.clientWidth <= STACK_BELOW;
  /**
   * Wide enough to put two panels side by side, but not tall enough to stack
   * anything: a phone held sideways. Diagnostics used to take a whole panel
   * under the code there, leaving the editor about one line tall to say
   * "Clang is proud of you" in a box of its own.
   */
  const short = () => !narrow() && container.clientHeight <= 560;
  const shape = (): Shape => (narrow() ? 'narrow' : short() ? 'short' : 'wide');
  /** The shape the arrangement on screen is for; saved under its key. */
  let currentShape = shape();
  const load = (s: Shape): boolean => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEYS[s]);
      return raw !== null && restore(raw);
    } catch {
      return false;
    }
  };
  /**
   * Set while the arrangement on screen is a link's and not yet the reader's.
   * A link's arrangement is for this visit, as its view is (see
   * `store.setView`): it is not stored over the one the reader made for
   * themselves until they rearrange it, at which point it is theirs. What
   * counts is a gesture of theirs on the desk itself: a panel dragged, closed
   * or opened, a source added from a "+", the layout reset. Not a tab pressed
   * or a source closed, which are about what to look at, not where; and not
   * dockview's layout event, which is late and reports a peek and a window
   * changing shape alike.
   */
  let borrowed = false;
  const claim = (): void => {
    borrowed = false;
  };
  const save = (): void => {
    const json = serialize();
    if (!borrowed) {
      try {
        localStorage.setItem(LAYOUT_KEYS[currentShape], json);
      } catch {
        /* quota / private mode */
      }
    }
    // For a link, without the floating windows: a theme editor is the
    // sharer's, not part of the desk.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    delete parsed['floatingGroups'];
    store.dockLayout = isDockLayout(parsed) ? parsed : null;
  };

  /**
   * Every group at the full width, one above the other, column by column:
   * what a narrow screen makes of an arrangement built for a wide one. Column
   * by column rather than row by row, so the code comes with the diagnostics
   * under it and the layouts follow, as the eye reads the wide screen. Each
   * group keeps its tabs. A group of nothing but diagnostics is a strip, as it
   * is on a wide screen; the rest share the height.
   */
  const stack = (): void => {
    quietly(() => {
      stackNow();
    });
  };
  const stackNow = (): void => {
    const order = [...api.groups]
      .map((g) => ({ g, r: g.element.getBoundingClientRect() }))
      .sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top)
      .map(({ g }) =>
        g.panels.map((p) => ({ id: p.id, kind: kindOf(p), active: g.activePanel === p })),
      );
    api.clear();
    known.clear();
    let previous: string | null = null;
    const strips: string[] = [];
    for (const panels of order) {
      let first: string | null = null;
      for (const p of panels) {
        const parsed = parsePanelId(p.id);
        if (!parsed || !p.kind || !store.sources.some((s) => s.id === parsed.sourceId)) continue;
        const options: AddPanelOptions = {
          id: p.id,
          component: p.kind,
          tabComponent: TAB,
          title: KIND_TITLES[p.kind],
          inactive: !p.active,
        };
        if (first) options.position = { referencePanel: first, direction: 'within' };
        else if (previous) options.position = { referencePanel: previous, direction: 'below' };
        api.addPanel(options);
        known.add(parsed.sourceId);
        first ??= p.id;
      }
      if (!first) continue;
      previous = first;
      if (panels.every((p) => p.kind === 'diagnostics')) strips.push(first);
    }
    api.layout(container.clientWidth, container.clientHeight);
    for (const id of strips) api.getPanel(id)?.group.api.setSize({ height: 120 });
    sync();
  };

  const defaultLayout = (): void => {
    quietly(() => {
      defaultLayoutNow();
    });
  };
  const defaultLayoutNow = (): void => {
    api.clear();
    known.clear();
    const [first, ...rest] = store.sources;
    if (!first) return;
    const panel = (kind: PanelKind, position?: AddPanelOptions['position']): void => {
      const options: AddPanelOptions = {
        id: panelId(kind, first.id),
        component: kind,
        tabComponent: TAB,
        title: KIND_TITLES[kind],
      };
      if (position) options.position = position;
      api.addPanel(options);
    };
    const editorId = panelId('editor', first.id);
    const layoutId = panelId('layout', first.id);
    if (narrow()) {
      // Phones: Code above Layout, Diagnostics as a tab next to Layout.
      panel('editor');
      panel('layout', { referencePanel: editorId, direction: 'below' });
      panel('diagnostics', { referencePanel: layoutId, direction: 'within' });
    } else if (short()) {
      // Two full-height columns, and diagnostics as a tab rather than a panel:
      // there is no vertical room to spend on a box that is usually empty.
      panel('editor');
      panel('layout', { referencePanel: editorId, direction: 'right' });
      panel('diagnostics', { referencePanel: layoutId, direction: 'within' });
    } else {
      panel('editor');
      panel('layout', { referencePanel: editorId, direction: 'right' });
      panel('diagnostics', { referencePanel: editorId, direction: 'below' });
    }
    known.add(first.id);
    // The other sources' panels join the first's, kind by kind.
    for (const source of rest) {
      known.add(source.id);
      for (const kind of KINDS) addPanelFor(kind, source);
    }
    api.getPanel(layoutId)?.api.setActive();
    api.layout(container.clientWidth, container.clientHeight);
    if (narrow()) {
      api
        .getPanel(editorId)
        ?.group.api.setSize({ height: Math.round(container.clientHeight * 0.45) });
    } else {
      // ~5:7 split; diagnostics as a small strip under the code
      api
        .getPanel(editorId)
        ?.group.api.setSize({ width: Math.round(container.clientWidth * 0.42) });
      if (!short()) {
        api.getPanel(panelId('diagnostics', first.id))?.group.api.setSize({ height: 140 });
      }
    }
    showSource(store.shown.id);
    refresh();
  };

  for (const key of LEGACY_LAYOUT_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  }

  // The arrangement, in order of preference: the one a link brought, the one
  // this visitor stored for a window of this shape, the default. A link's was
  // built for whatever window the sharer had; on a narrow one it stacks.
  const fromLink = store.pendingLayout;
  store.pendingLayout = null;
  let restored = false;
  if (fromLink) {
    restored = restore(JSON.stringify(fromLink));
    if (restored && currentShape === 'narrow') stack();
    borrowed = restored;
  }
  if (!restored) restored = load(currentShape);
  if (!restored) defaultLayout();
  // Stored and published at once: a link asked for before anything is moved
  // must carry the arrangement as it is, and the change events start below.
  save();

  // Persist (debounced), and keep the group labels true.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const layoutSub = api.onDidLayoutChange(() => {
    refresh();
    // A peek moves panels forward, which dockview reports as a layout change.
    // It is not one: nothing about it is the reader's arrangement, and saving
    // it would put a hovered panel in the stored layout and in the link. The
    // peek ending is itself a change, and that one is saved.
    if (store.peek !== null) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  });

  const moveSub = api.onDidMovePanel(claim);

  // A tab pressed is a source put in focus; its panels elsewhere follow. Only
  // pressed: a panel this code brings forward, for a peek or to follow a
  // choice made elsewhere, is not a choice. (dockview calls both `user`.)
  const activeSub = api.onDidActivePanelChange((e) => {
    if (restoring || switching || !e.panel) return;
    const parsed = parsePanelId(e.panel.id);
    if (parsed) store.selectSourceById(parsed.sourceId);
  });

  // Theme editor floating panel <-> theme.editorOpen
  /** Set while this code closes the picker window: the editor going takes it along, and a narrow screen has no room for it. */
  let closingPicker = false;
  const closePicker = (): void => {
    closingPicker = true;
    try {
      api.getPanel(PANEL_PICKER)?.api.close();
    } finally {
      closingPicker = false;
    }
  };
  const removeSub = api.onDidRemovePanel((p) => {
    if (rebuilding) return;
    if (p.id === PANEL_THEME) {
      theme.editorOpen = false;
      closePicker();
    }
    if (p.id === PANEL_PICKER) {
      // Closing the picker's window is putting it back in the panel, the same
      // as pressing "attach" there; a window closed by this code says nothing.
      if (closingPicker) theme.pickerDetached = false;
      else theme.setPickerDetached(false);
    }
    // A panel closed while its source stays is the desk rearranged. A source
    // closed takes its panels with it, and that is not.
    if (sourceOf(p.id)) claim();
  });
  const setPickerDetached = (detached: boolean) => {
    const existing = api.getPanel(PANEL_PICKER);
    if (!detached) {
      closePicker();
      return;
    }
    if (existing) {
      existing.api.setActive();
      return;
    }
    // Default position: attached to the bottom of the theme editor window.
    const box = container.getBoundingClientRect();
    const te = api.getPanel(PANEL_THEME)?.group.element.getBoundingClientRect();
    const w = te ? Math.round(te.width) : Math.min(380, container.clientWidth - 16);
    const h = 300;
    let x = te ? Math.round(te.left - box.left) : Math.max(8, container.clientWidth - w - 24);
    let y = te ? Math.round(te.bottom - box.top + 8) : 16;
    if (te && y + h > container.clientHeight - 8) {
      // No room below: sit beside the theme editor, bottom-aligned.
      y = Math.max(8, Math.round(te.bottom - box.top) - h);
      x = Math.round(te.left - box.left) - w - 8;
      if (x < 8) x = Math.round(te.right - box.left) + 8;
    }
    if (x + w > container.clientWidth - 8) x = Math.max(8, container.clientWidth - w - 8);
    if (y + h > container.clientHeight - 8) y = Math.max(8, container.clientHeight - h - 8);
    api.addPanel({
      id: PANEL_PICKER,
      component: PANEL_PICKER,
      title: 'Colour picker',
      floating: { width: w, height: h, x, y },
    });
  };
  theme.pickerDetached = !!api.getPanel(PANEL_PICKER);
  const openThemeEditor = () => {
    const existing = api.getPanel(PANEL_THEME);
    if (existing) {
      existing.api.setActive();
      return;
    }
    // As tall as the available space (minus a small margin); on narrow
    // screens it takes the full width.
    const margin = 8;
    const w = Math.min(420, container.clientWidth - 2 * margin);
    const h = Math.max(320, container.clientHeight - 2 * margin);
    api.addPanel({
      id: PANEL_THEME,
      component: PANEL_THEME,
      title: 'Theme editor',
      floating: {
        width: w,
        height: h,
        x: Math.max(margin, container.clientWidth - w - margin),
        y: margin,
      },
    });
  };
  theme.editorOpen = !!api.getPanel(PANEL_THEME);

  /**
   * Rebuilds the arrangement with `fn`, keeping the floating windows: they
   * are the reader's, not part of the desk, and `api.clear` takes them too.
   */
  const rebuild = (fn: () => void): void => {
    const editorWasOpen = theme.editorOpen;
    const pickerWasOut = theme.pickerDetached;
    rebuilding = true;
    try {
      fn();
    } finally {
      rebuilding = false;
    }
    if (editorWasOpen && !api.getPanel(PANEL_THEME)) openThemeEditor();
    theme.editorOpen = !!api.getPanel(PANEL_THEME);
    if (pickerWasOut && theme.editorOpen && !api.getPanel(PANEL_PICKER)) setPickerDetached(true);
    theme.pickerDetached = !!api.getPanel(PANEL_PICKER);
  };

  // A window that changes shape gets the arrangement for its new shape: the
  // one stored for it, or, going narrow, this one stacked. The one being left
  // is saved first, so turning a phone back lands where it was.
  const ro = new ResizeObserver(() => {
    api.layout(container.clientWidth, container.clientHeight);
    const next = shape();
    if (next === currentShape) return;
    if (saveTimer) clearTimeout(saveTimer);
    save();
    currentShape = next;
    rebuild(() => {
      if (load(next)) return;
      if (next === 'narrow') stack();
      else defaultLayout();
    });
  });
  ro.observe(container);
  api.layout(container.clientWidth, container.clientHeight);

  function resetLayout() {
    claim();
    try {
      localStorage.removeItem(LAYOUT_KEYS[currentShape]);
    } catch {
      /* private mode */
    }
    rebuild(defaultLayout);
  }

  return {
    api,
    sync,
    showSource,
    panelsOf,
    togglePanel,
    onDidChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    resetLayout,
    openThemeEditor,
    setPickerDetached,
    dispose() {
      // A save or a peek still pending would run against a dock that is gone.
      if (saveTimer) clearTimeout(saveTimer);
      if (peekTimer) clearTimeout(peekTimer);
      ro.disconnect();
      layoutSub.dispose();
      activeSub.dispose();
      moveSub.dispose();
      removeSub.dispose();
      api.dispose();
    },
  };
}

export type { DockviewGroupPanel };
