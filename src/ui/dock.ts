// Panel management with dockview: the Code / Layout / Diagnostics panels are
// dockable, splittable and tabbable; the theme editor is a floating group.
// Panels render Svelte components; the layout is persisted in localStorage.

import {
  createDockview,
  registerModules,
  FloatingGroupModule,
  type DockviewApi,
  type IContentRenderer,
  type DockviewTheme,
  type ITabRenderer,
  type SerializedDockview,
  type AddPanelOptions,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { mount, unmount, type Component } from 'svelte';
import type { Session } from '$state/session.svelte';
import { theme } from '$state/theme.svelte';
import EditorPane from './EditorPane.svelte';
import ResultsPane from './ResultsPane.svelte';
import Diagnostics from './Diagnostics.svelte';
import ThemeEditorPanel from './ThemeEditorPanel.svelte';
import ColorPicker from './ColorPicker.svelte';
import PanelTab from './PanelTab.svelte';

// v2: the tab renderers below are recorded in the serialized layout, so a
// layout saved by v1 would keep plain tabs — and on a phone, keep Diagnostics
// as a panel of its own under a two-line editor. Both are the defaults this
// version exists to change, so the stored ones are retired rather than
// migrated. The cost is one reset of hand-arranged panels.
const LAYOUT_KEY_WIDE = 'abix-dock-layout-v2';
const LAYOUT_KEY_NARROW = 'abix-dock-layout-narrow-v2';
const LAYOUT_KEY_SHORT = 'abix-dock-layout-short-v2';
/** Tab renderers: `status` shows whether the code compiled, `count` how many diagnostics. */
const TAB_STATUS = 'tab-status';
const TAB_COUNT = 'tab-count';
export const PANEL_EDITOR = 'editor';
export const PANEL_LAYOUT = 'layout';
export const PANEL_DIAGNOSTICS = 'diagnostics';
export const PANEL_THEME = 'theme-editor';
export const PANEL_PICKER = 'color-picker';

/** The panels every layout has (in creation order; positions are relative to earlier ones). */
const CORE_PANELS: AddPanelOptions[] = [
  { id: PANEL_EDITOR, component: PANEL_EDITOR, title: 'Code', tabComponent: TAB_STATUS },
  {
    id: PANEL_LAYOUT,
    component: PANEL_LAYOUT,
    title: 'Layout',
    position: { referencePanel: PANEL_EDITOR, direction: 'right' },
  },
  {
    id: PANEL_DIAGNOSTICS,
    component: PANEL_DIAGNOSTICS,
    title: 'Diagnostics',
    tabComponent: TAB_COUNT,
    position: { referencePanel: PANEL_EDITOR, direction: 'below' },
  },
];

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

export interface Dock {
  api: DockviewApi;
  resetLayout(): void;
  openThemeEditor(): void;
  /** Show the colour picker in its own floating window (below the theme editor) or close it. */
  setPickerDetached(detached: boolean): void;
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;

export function mountDock(container: HTMLElement, session: Session): Dock {
  const components: Record<string, () => AnyComponent> = {
    [PANEL_EDITOR]: () => EditorPane,
    [PANEL_LAYOUT]: () => ResultsPane,
    [PANEL_DIAGNOSTICS]: () => Diagnostics,
    [PANEL_THEME]: () => ThemeEditorPanel,
    [PANEL_PICKER]: () => ColorPicker,
  };
  const panelProps: Record<string, Record<string, unknown>> = {
    [PANEL_PICKER]: { detached: true },
  };

  const api = createDockview(container, {
    theme: ABIX_THEME,
    // Only the two panels that ask for one; everything else keeps dockview's
    // own tab, which is what `undefined` means here.
    createTabComponent: (options): ITabRenderer | undefined => {
      const kind =
        options.name === TAB_STATUS ? 'status' : options.name === TAB_COUNT ? 'count' : null;
      if (!kind) return undefined;
      const element = document.createElement('div');
      element.className = 'dock-tab';
      let instance: Record<string, unknown> | null = null;
      return {
        element,
        init(params) {
          instance = mount(PanelTab, {
            target: element,
            props: {
              // `params.title`, not `params.api.title`: the api's is still
              // undefined while the tab is being built, which rendered a tab
              // with a close button and no name.
              title: params.title,
              kind,
              // A custom tab renders its own close button: dockview's lives in
              // the default tab, not in the frame around it.
              close: () => {
                params.api.close();
              },
            },
          });
        },
        dispose() {
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
      return {
        element,
        init() {
          const factory = components[options.name];
          if (!factory) {
            element.textContent = `Unknown panel: ${options.name}`;
            return;
          }
          instance = mount(factory(), {
            target: element,
            props: { session, ...panelProps[options.name] },
          });
        },
        dispose() {
          if (instance) void unmount(instance);
          instance = null;
        },
      };
    },
  });

  // Adds any core panel that is missing (all of them on a fresh layout).
  const ensureCorePanels = () => {
    for (const p of CORE_PANELS) if (!api.getPanel(p.id)) api.addPanel(p);
  };

  // Matches the CSS `@media (max-width: 760px)` breakpoint (inclusive) used
  // across the app so the dock arrangement and the components agree.
  const narrow = () => container.clientWidth <= 760;
  /**
   * Wide enough to put two panels side by side, but not tall enough to stack
   * anything — a phone held sideways. Diagnostics used to take a whole panel
   * under the code there, leaving the editor about one line tall to say
   * "Clang is proud of you" in a box of its own.
   */
  const short = () => !narrow() && container.clientHeight <= 560;
  const layoutKey = () =>
    narrow() ? LAYOUT_KEY_NARROW : short() ? LAYOUT_KEY_SHORT : LAYOUT_KEY_WIDE;

  const defaultLayout = () => {
    api.clear();
    if (narrow()) {
      // Phones: Code above Layout, Diagnostics as a tab next to Layout.
      api.addPanel(CORE_PANELS[0]!);
      api.addPanel({
        id: PANEL_LAYOUT,
        component: PANEL_LAYOUT,
        title: 'Layout',
        position: { referencePanel: PANEL_EDITOR, direction: 'below' },
      });
      api.addPanel({
        id: PANEL_DIAGNOSTICS,
        component: PANEL_DIAGNOSTICS,
        title: 'Diagnostics',
        tabComponent: TAB_COUNT,
        position: { referencePanel: PANEL_LAYOUT, direction: 'within' },
      });
      api.getPanel(PANEL_LAYOUT)?.api.setActive();
      api.layout(container.clientWidth, container.clientHeight);
      api
        .getPanel(PANEL_EDITOR)
        ?.group.api.setSize({ height: Math.round(container.clientHeight * 0.45) });
      return;
    }
    if (short()) {
      // Two full-height columns, and diagnostics as a tab rather than a panel:
      // there is no vertical room to spend on a box that is usually empty.
      api.addPanel(CORE_PANELS[0]!);
      api.addPanel(CORE_PANELS[1]!);
      api.addPanel({
        id: PANEL_DIAGNOSTICS,
        component: PANEL_DIAGNOSTICS,
        title: 'Diagnostics',
        tabComponent: TAB_COUNT,
        position: { referencePanel: PANEL_LAYOUT, direction: 'within' },
      });
      api.getPanel(PANEL_LAYOUT)?.api.setActive();
      api.layout(container.clientWidth, container.clientHeight);
      api
        .getPanel(PANEL_EDITOR)
        ?.group.api.setSize({ width: Math.round(container.clientWidth * 0.42) });
      return;
    }
    ensureCorePanels();
    // ~5:7 split; diagnostics as a small strip under the code
    api.layout(container.clientWidth, container.clientHeight);
    api
      .getPanel(PANEL_EDITOR)
      ?.group.api.setSize({ width: Math.round(container.clientWidth * 0.42) });
    api.getPanel(PANEL_DIAGNOSTICS)?.group.api.setSize({ height: 140 });
  };

  // Restore or build the layout.
  let restored = false;
  try {
    const raw = localStorage.getItem(layoutKey());
    if (raw) {
      api.fromJSON(JSON.parse(raw) as SerializedDockview);
      ensureCorePanels();
      restored = true;
    }
  } catch {
    restored = false;
  }
  if (!restored) defaultLayout();

  // Persist (debounced).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const layoutSub = api.onDidLayoutChange(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(layoutKey(), JSON.stringify(api.toJSON()));
      } catch {
        /* quota / private mode */
      }
    }, 300);
  });

  // Theme editor floating panel <-> theme.editorOpen
  const removeSub = api.onDidRemovePanel((p) => {
    if (p.id === PANEL_THEME) {
      theme.editorOpen = false;
      api.getPanel(PANEL_PICKER)?.api.close();
    }
    if (p.id === PANEL_PICKER) theme.pickerDetached = false;
  });
  const setPickerDetached = (detached: boolean) => {
    const existing = api.getPanel(PANEL_PICKER);
    if (!detached) {
      existing?.api.close();
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

  const ro = new ResizeObserver(() => {
    api.layout(container.clientWidth, container.clientHeight);
  });
  ro.observe(container);
  api.layout(container.clientWidth, container.clientHeight);

  return {
    api,
    resetLayout() {
      localStorage.removeItem(layoutKey());
      defaultLayout();
    },
    openThemeEditor,
    setPickerDetached,
    dispose() {
      ro.disconnect();
      layoutSub.dispose();
      removeSub.dispose();
      api.dispose();
    },
  };
}
