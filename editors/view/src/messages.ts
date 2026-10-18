// What the panel and its host say to each other. The host is the VS Code
// extension (through a webview) or the CLion plugin (through JCEF); both
// deliver their messages as `window` message events.

import type { LayoutResult, Range } from 'abi-explorer-lsp/protocol';

/** Host to panel. */
export type HostMessage = { type: 'layout'; result: LayoutResult };

/** Panel to host. */
export type ViewMessage = { type: 'reveal'; range: Range };
