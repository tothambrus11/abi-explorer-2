// What the panel and its host say to each other. The host is the VS Code
// extension (through a webview) or the CLion plugin (through JCEF); both
// deliver their messages as `window` message events.

import type { LayoutResult, Range } from '@abi-explorer/shared/protocol';

/** Host to panel. */
export interface HostMessage {
  type: 'layout';
  result: LayoutResult;
}

/** Panel to host: loaded and listening (send the layout again), or a click on a name. */
export type PanelMessage = { type: 'ready' } | { type: 'reveal'; range: Range };
