// ABI Explorer for VS Code: the abi-explorer-lsp server for hovers and inlay
// hints, plus the Struct Layout view.

import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { layoutsChangedNotification } from 'abi-explorer-lsp/protocol';
import { followCMakeTools } from './cmakeTools.ts';
import { LayoutPanel, LAYOUT_VIEW_ID } from './layoutPanel.ts';
import { affectsServer, initializationOptions } from './settings.ts';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Shows the Struct Layout view, which stays hidden until a C or C++ file is opened.
  void vscode.commands.executeCommand('setContext', 'abiExplorer.active', true);
  const panel = new LayoutPanel(context.extensionUri, () => client);
  panel.register(context.subscriptions);

  const start = async () => {
    client = createClient(context);
    client.onNotification(layoutsChangedNotification, () => panel.refresh());
    await client.start();
    await followCMakeTools(client, context.subscriptions);
    panel.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('abiExplorer.showLayout', () =>
      vscode.commands.executeCommand(`${LAYOUT_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand('abiExplorer.restartServer', async () => {
      await client?.stop();
      await start();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!affectsServer(event)) return;
      await client?.stop();
      await start();
    }),
  );
  await start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

function createClient(context: vscode.ExtensionContext): LanguageClient {
  const module = vscode.Uri.joinPath(context.extensionUri, 'dist', 'server', 'server.js').fsPath;
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--inspect=6011'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'c' },
      { scheme: 'file', language: 'cpp' },
    ],
    initializationOptions: initializationOptions(context.globalStorageUri.fsPath),
  };
  return new LanguageClient('abiExplorer', 'ABI Explorer', serverOptions, clientOptions);
}
