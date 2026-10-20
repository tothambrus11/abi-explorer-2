// The Struct Layout view: the shared panel in a webview, following the caret.

import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { layoutRequest, type LayoutResult, type Range } from '@abi-explorer/shared/protocol';
import { MEMBER_COLORS } from '@abi-explorer/shared/layoutModel';
import type { HostMessage, PanelMessage } from '@abi-explorer/layout-panel/messages';
import { colorMode } from './settings.ts';

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
  private readonly decorations = new Decorations();
  /** The last layouts, for marking the records the view shows. */
  private result: LayoutResult | undefined;

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
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.decorations.dispose();
        this.refresh();
      }),
      this.decorations,
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
      else if (message.type === 'mark') this.mark(message.ranges);
      else if (message.type === 'shown') this.showDots(message.recordIds);
      else void this.reveal(message);
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
    this.result = result;
    // Without the view, the record at the caret is the one on screen.
    if (!this.view?.visible) this.showDots(null);
    if (!this.view?.visible) return;
    const message: HostMessage = { type: 'layout', result };
    void this.view.webview.postMessage(message);
  }

  private async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('Copied the layout as text', 3_000);
  }

  /** Puts the caret on a name: in the document shown, or in another file (a record declared there). */
  private async reveal(message: Extract<PanelMessage, { type: 'reveal' }>): Promise<void> {
    const document = message.uri
      ? await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri))
      : this.editor?.document;
    if (!document || document.isClosed) return;
    const selection = toRange(message.range);
    await vscode.window.showTextDocument(document, {
      viewColumn: this.editor?.viewColumn ?? vscode.ViewColumn.Active,
      selection,
    });
  }

  /** Dots the members of these records, or of the one at the caret with none given. */
  private showDots(recordIds: number[] | null): void {
    const editor = this.editor;
    if (!editor || editor.document.isClosed || !this.result) return;
    const ids = recordIds ?? (this.result.selection ? [this.result.selection.recordId] : []);
    this.decorations.dots(
      editor,
      this.result.records.filter((record) => ids.includes(record.id)),
    );
  }

  private mark(ranges: Range[]): void {
    if (this.editor && !this.editor.document.isClosed) this.decorations.mark(this.editor, ranges);
  }
}

/**
 * What the web explorer draws in its editor: a dot in the member's colour
 * before each member's name, and, while a member is hovered in the panel, a
 * tint over its line and a stronger one over its name.
 */
class Decorations implements vscode.Disposable {
  private dotTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly line = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(57, 135, 229, 0.14)',
  });
  private readonly name = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(57, 135, 229, 0.30)',
    borderRadius: '3px',
  });

  dots(editor: vscode.TextEditor, records: LayoutResult['records']): void {
    const ranges = new Map<string, vscode.Range[]>();
    // One dot a name: a template's instantiations share their members' names.
    const seen = new Set<string>();
    for (const record of records) {
      for (const member of record.members) {
        if (!member.nameRange) continue;
        const key = `${member.nameRange.start.line}:${member.nameRange.start.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const color =
          member.group === null
            ? record.layout.leaves[member.leaves[0]!]?.color
            : (record.layout.groups[member.group]?.color ?? 'compound');
        if (!color) continue;
        const start = toRange(member.nameRange).start;
        ranges.set(color, [...(ranges.get(color) ?? []), new vscode.Range(start, start)]);
      }
    }
    for (const [color, type] of this.dotTypes) {
      if (!ranges.has(color)) editor.setDecorations(type, []);
    }
    for (const [color, at] of ranges) editor.setDecorations(this.dotType(color), at);
  }

  mark(editor: vscode.TextEditor, ranges: Range[]): void {
    editor.setDecorations(this.line, ranges.map(toRange));
    editor.setDecorations(this.name, ranges.map(toRange));
  }

  /** The dot for a colour slot; a compound member with no one colour gets a ring. */
  private dotType(color: string): vscode.TextEditorDecorationType {
    let type = this.dotTypes.get(color);
    if (!type) {
      const palette = MEMBER_COLORS[colorMode()];
      type = vscode.window.createTextEditorDecorationType({
        before:
          color === 'compound'
            ? {
                contentText: '○',
                color: new vscode.ThemeColor('descriptionForeground'),
                margin: '0 4px 0 0',
              }
            : {
                contentText: '●',
                color: palette[color] ?? palette['c-special']!,
                margin: '0 4px 0 0',
              },
      });
      this.dotTypes.set(color, type);
    }
    return type;
  }

  dispose(): void {
    for (const type of this.dotTypes.values()) type.dispose();
    this.dotTypes = new Map();
  }
}

function toRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
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
