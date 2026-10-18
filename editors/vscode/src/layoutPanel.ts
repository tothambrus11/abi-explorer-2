// The Struct Layout view: the shared panel in a webview, following the caret.

import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { layoutRequest, type LayoutResult, type Range } from '@abi-explorer/shared/protocol';
import type { HostMessage, PanelMessage } from '@abi-explorer/layout-panel/messages';

export const LAYOUT_VIEW_ID = 'abiExplorer.layout';
const CARET_DEBOUNCE_MS = 150;

export class LayoutPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private editor: vscode.TextEditor | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Only the newest request's answer is shown; a slow older one is dropped. */
  private requestNumber = 0;
  private readonly extensionUri: vscode.Uri;
  private readonly client: () => LanguageClient | undefined;

  constructor(extensionUri: vscode.Uri, client: () => LanguageClient | undefined) {
    this.extensionUri = extensionUri;
    this.client = client;
  }

  register(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(LAYOUT_VIEW_ID, this),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.follow(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.follow(event.textEditor);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist', 'panel');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = html(view.webview, dist);
    view.webview.onDidReceiveMessage((message: PanelMessage) => {
      if (message.type === 'ready') this.refresh();
      else if (message.type === 'copy') void this.copy(message.text);
      else if (message.type === 'reorder') void this.reorder(message.range);
      else this.reveal(message);
    });
    view.onDidChangeVisibility(() => {
      this.refresh();
    });
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
    if (!this.view?.visible) return;
    const number = ++this.requestNumber;
    const client = this.client();
    const editor = this.editor?.document.isClosed ? undefined : this.editor;
    let result: LayoutResult;
    if (!editor) {
      result = placeholder('Open a C or C++ file to see the layouts of its structs.');
    } else if (client?.state === State.Starting) {
      result = placeholder('Starting…', 'analyzing');
    } else if (client?.state !== State.Running) {
      result = placeholder(
        "ABI Explorer's server is not running; the ABI Explorer output says why.",
      );
    } else {
      try {
        result = await client.sendRequest(layoutRequest, {
          textDocument: { uri: editor.document.uri.toString() },
          position: editor.selection.active,
          includeText: true,
        });
      } catch (error) {
        // A server that is stopping says when it has layouts again; anything else is worth showing.
        // (`state` is read again: it can change while the request is out.)
        if ((client.state as State) !== State.Running) return;
        result = placeholder(
          `The layout request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (number !== this.requestNumber) return;
    const message: HostMessage = { type: 'layout', result, canReorder: true };
    void this.view.webview.postMessage(message);
  }

  private async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('Copied the layout as text', 3_000);
  }

  /** Applies the server's reorder action for the record named at `range`. */
  private async reorder(range: Range): Promise<void> {
    if (!this.editor || this.editor.document.isClosed) return;
    const at = new vscode.Position(range.start.line, range.start.character);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      this.editor.document.uri,
      new vscode.Range(at, at),
      vscode.CodeActionKind.RefactorRewrite.value,
    );
    const action = actions.find((candidate) => candidate.title.startsWith('Reorder members'));
    if (action?.edit) await vscode.workspace.applyEdit(action.edit);
    else vscode.window.showWarningMessage('These members cannot be reordered automatically.');
  }

  private reveal(message: Extract<PanelMessage, { type: 'reveal' }>): void {
    if (!this.editor || this.editor.document.isClosed) return;
    const { start, end } = message.range;
    const range = new vscode.Range(start.line, start.character, end.line, end.character);
    void vscode.window.showTextDocument(this.editor.document, {
      viewColumn: this.editor.viewColumn ?? vscode.ViewColumn.Active,
      selection: range,
    });
  }
}

function placeholder(message: string, state: LayoutResult['state'] = 'unavailable'): LayoutResult {
  return { state, message, records: [], selection: null, context: null };
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join(
    '',
  );
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('panel.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
}
