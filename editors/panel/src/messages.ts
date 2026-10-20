// What the panel and its host say to each other. The host is the VS Code
// extension (through a webview) or the CLion plugin (through JCEF); both
// deliver their messages as `window` message events.

import type { LayoutResult, Range } from '@abi-explorer/shared/protocol';

/** Host to panel. */
export interface HostMessage {
  type: 'layout';
  result: LayoutResult;
}

/**
 * Panel to host: loaded and listening (send the layout again), a click on a
 * name (in this document, or in the file `uri` names), what to mark in the
 * document while a member is hovered, or text to copy.
 */
export type PanelMessage =
  | { type: 'ready' }
  | { type: 'reveal'; range: Range; uri?: string }
  | { type: 'mark'; ranges: Range[] }
  | { type: 'shown'; recordIds: number[] }
  | { type: 'copy'; text: string };
