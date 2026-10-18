// The Struct Layout view: the shared panel in a webview, following the caret.

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { layoutRequest, type LayoutResult } from 'abi-explorer-lsp/protocol';

type ViewMessage = { type: 'reveal'; range: { start: vscode.Position; end: vscode.Position } };

export const LAYOUT_VIEW_ID = 'abiExplorer.layout';
const CARET_DEBOUNCE_MS = 150;

export class LayoutPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private editor: vscode.TextEditor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly client: () => LanguageClient | undefined;

  constructor(extensionUri: vscode.Uri, client: () => LanguageClient | undefined) {
    this.extensionUri = extensionUri;
    this.client = client;
  }

  register(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(LAYOUT_VIEW_ID, this),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.follow(event.textEditor)),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist', 'view');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = html(view.webview, dist);
    view.webview.onDidReceiveMessage((message: ViewMessage) => this.reveal(message));
    view.onDidChangeVisibility(() => this.refresh());
    this.follow(vscode.window.activeTextEditor);
  }

  /** The server has new layouts: redraw for the current caret. */
  refresh(): void {
    this.follow(this.editor);
  }

  private follow(editor: vscode.TextEditor | undefined): void {
    if (editor && !['c', 'cpp'].includes(editor.document.languageId)) return;
    this.editor = editor ?? this.editor;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), CARET_DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    const client = this.client();
    if (!this.view?.visible || !this.editor || !client) return;
    const { document, selection } = this.editor;
    const result: LayoutResult = await client.sendRequest(layoutRequest, {
      textDocument: { uri: document.uri.toString() },
      position: selection.active,
    });
    void this.view.webview.postMessage({ type: 'layout', result });
  }

  private reveal(message: ViewMessage): void {
    if (message.type !== 'reveal' || !this.editor) return;
    const { start, end } = message.range;
    const range = new vscode.Range(start.line, start.character, end.line, end.character);
    void vscode.window.showTextDocument(this.editor.document, { viewColumn: this.editor.viewColumn ?? vscode.ViewColumn.Active, selection: range });
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('view.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
