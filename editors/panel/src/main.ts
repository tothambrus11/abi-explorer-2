// The panel's entry point: receives layouts from the host, sends clicks back.
//
// VS Code provides `acquireVsCodeApi`; the CLion plugin defines
// `window.abiExplorerHost` before loading this script.

import type { HostMessage, PanelMessage } from './messages.ts';
import type { LayoutResult } from '@abi-explorer/shared/protocol';
import { initialState, NARROW_QUERY, renderPanel } from './render.ts';

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
const state = initialState();

let latest: LayoutResult | null = null;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  // Other extensions' messages can reach a webview too.
  if ((event.data as HostMessage | undefined)?.type === 'layout') {
    latest = event.data.result;
    render(latest);
  }
});

// The grid has fewer columns in a narrow pane: draw it again when the pane crosses over.
window.matchMedia(NARROW_QUERY).addEventListener('change', () => {
  if (latest) render(latest);
});

function render(result: LayoutResult): void {
  document.documentElement.dataset.mode = isLight() ? 'light' : 'dark';
  renderPanel(root, result, state, {
    reveal: (range, uri) => {
      post({ type: 'reveal', range, ...(uri !== undefined && { uri }) });
    },
    mark: (ranges) => {
      post({ type: 'mark', ranges });
    },
    shown: (recordIds) => {
      post({ type: 'shown', recordIds });
    },
    copy: (text) => {
      post({ type: 'copy', text });
    },
  });
}

/** Is the panel's ground light? Then the member colours are the web's light set. */
function isLight(): boolean {
  if (document.body.classList.contains('vscode-light')) return true;
  if (document.body.classList.contains('vscode-dark')) return false;
  const [r = 0, g = 0, b = 0, a = 1] = (
    getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? []
  ).map(Number);
  return a > 0 && 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

// A host may have sent a layout before this page was listening.
post({ type: 'ready' });
