// The panel's entry point: receives layouts from the host, sends clicks back.
//
// VS Code provides `acquireVsCodeApi`; the CLion plugin defines
// `window.abiExplorerHost` before loading this script.

import type { HostMessage, ViewMessage } from './messages.ts';
import { renderPanel, type PanelState } from './render.ts';

declare global {
  interface Window {
    abiExplorerHost?: { postMessage(message: string): void };
  }
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}

const post: (message: ViewMessage) => void =
  typeof acquireVsCodeApi === 'function'
    ? ((api) => (message) => api.postMessage(message))(acquireVsCodeApi())
    : (message) => window.abiExplorerHost?.postMessage(JSON.stringify(message));

const root = document.getElementById('root')!;
const state: PanelState = { openRecordId: null };

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data?.type === 'layout') {
    renderPanel(root, event.data.result, state, { reveal: (range) => post({ type: 'reveal', range }) });
  }
});
