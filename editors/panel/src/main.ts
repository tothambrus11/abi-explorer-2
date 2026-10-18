// The panel's entry point: receives layouts from the host, sends clicks back.
//
// VS Code provides `acquireVsCodeApi`; the CLion plugin defines
// `window.abiExplorerHost` before loading this script.

import type { HostMessage, PanelMessage } from './messages.ts';
import { renderPanel, type PanelState } from './render.ts';

declare global {
  interface Window {
    abiExplorerHost?: { postMessage(message: string): void };
  }
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}

const post: (message: PanelMessage) => void =
  typeof acquireVsCodeApi === 'function'
    ? ((api) => (message) => {
        api.postMessage(message);
      })(acquireVsCodeApi())
    : (message) => window.abiExplorerHost?.postMessage(JSON.stringify(message));

const root = document.getElementById('root')!;
const state: PanelState = { choice: null };

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  // Other extensions' messages can reach a webview too.
  if ((event.data as HostMessage | undefined)?.type === 'layout') {
    renderPanel(root, event.data.result, state, {
      reveal: (range) => {
        post({ type: 'reveal', range });
      },
    });
  }
});

// A host may have sent a layout before this page was listening.
post({ type: 'ready' });
