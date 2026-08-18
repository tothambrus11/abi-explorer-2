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

const LAYOUT_KEY = 'abix-dock-layout-v1';
export const PANEL_EDITOR = 'editor';
export const PANEL_LAYOUT = 'layout';
export const PANEL_DIAGNOSTICS = 'diagnostics';
export const PANEL_THEME = 'theme-editor';

/** The panels every layout has (in creation order; positions are relative to earlier ones). */
const CORE_PANELS: AddPanelOptions[] = [
  { id: PANEL_EDITOR, component: PANEL_EDITOR, title: 'Code' },
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
  };

  const api = createDockview(container, {
    theme: ABIX_THEME,
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
          instance = mount(factory(), { target: element, props: { session } });
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

  const defaultLayout = () => {
    api.clear();
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
    const raw = localStorage.getItem(LAYOUT_KEY);
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
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
      } catch {
        /* quota / private mode */
      }
    }, 300);
  });

  // Theme editor floating panel <-> theme.editorOpen
  const removeSub = api.onDidRemovePanel((p) => {
    if (p.id === PANEL_THEME) theme.editorOpen = false;
  });
  const openThemeEditor = () => {
    const existing = api.getPanel(PANEL_THEME);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const w = 400;
    const h = Math.min(640, Math.max(360, container.clientHeight - 40));
    api.addPanel({
      id: PANEL_THEME,
      component: PANEL_THEME,
      title: 'Theme editor',
      floating: { width: w, height: h, x: Math.max(8, container.clientWidth - w - 24), y: 16 },
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
      localStorage.removeItem(LAYOUT_KEY);
      defaultLayout();
    },
    openThemeEditor,
    dispose() {
      ro.disconnect();
      layoutSub.dispose();
      removeSub.dispose();
      api.dispose();
    },
  };
}
