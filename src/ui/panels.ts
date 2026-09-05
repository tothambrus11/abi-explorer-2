// What the dock's panels are named, shared by the dock and the components it
// mounts into headers and tabs.
//
// A panel is one kind of view of one source: `editor:7` is the Source panel of
// the source whose id is 7. The id is the source's for the visit, which is
// what lets the dock find every panel of a source and every source of a
// group without a table of its own.

/** The three views a source has. */
export type PanelKind = 'editor' | 'layout' | 'diagnostics';
export const KINDS: readonly PanelKind[] = ['editor', 'layout', 'diagnostics'];

/** What each kind is called on its tab when there is one source, and on its group when there are several. */
export const KIND_TITLES: Record<PanelKind, string> = {
  editor: 'Source',
  layout: 'Layout',
  diagnostics: 'Diagnostics',
};

/** The dock id of `kind`'s panel for the source with `sourceId`. */
export function panelId(kind: PanelKind, sourceId: number): string {
  return `${kind}:${String(sourceId)}`;
}

const PANEL_ID = /^(editor|layout|diagnostics):(\d+)$/;

/** The inverse of `panelId`, or null for a panel that is not a source's (the theme editor, say). */
export function parsePanelId(id: string): { kind: PanelKind; sourceId: number } | null {
  const m = PANEL_ID.exec(id);
  return m ? { kind: m[1] as PanelKind, sourceId: Number(m[2]) } : null;
}
