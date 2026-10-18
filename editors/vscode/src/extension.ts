// ABI Explorer for VS Code: the abi-explorer-lsp server for hovers and inlay
// hints, plus the Struct Layout view.

import * as vscode from 'vscode';
import {
  LanguageClient,
  State,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { layoutsChangedNotification } from '@abi-explorer/shared/protocol';
import { followCMakeTools } from './cmakeTools.ts';
import { LayoutPanel, LAYOUT_VIEW_ID } from './layoutPanel.ts';
import { affectsServer, initializationOptions } from './settings.ts';

/** The running client and what was set up for it; replaced as a whole on restart. */
let session: { client: LanguageClient; disposables: vscode.Disposable[] } | undefined;
/** Restarts run one after another, so two at once never leave two servers. */
let restarts: Promise<void> = Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Shows the Struct Layout view, which stays hidden until a C or C++ file is opened.
  void vscode.commands.executeCommand('setContext', 'abiExplorer.active', true);
  const output = vscode.window.createOutputChannel('ABI Explorer', { log: true });
  const panel = new LayoutPanel(context.extensionUri, () => session?.client);
  panel.register(context.subscriptions);

  const restart = () => {
    restarts = restarts.then(async () => {
      await stopSession();
      const client = createClient(context, output);
      const disposables = [
        client.onNotification(layoutsChangedNotification, () => panel.refresh()),
        // Also after the client restarts a crashed server on its own.
        client.onDidChangeState(({ newState }) => {
          if (newState === State.Running) panel.refresh();
        }),
        await followCMakeTools(client, output),
      ];
      session = { client, disposables };
      try {
        await client.start();
      } catch (error) {
        output.error(`The server did not start: ${String(error)}`);
      }
    });
    return restarts;
  };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('abiExplorer.showLayout', () =>
      vscode.commands.executeCommand(`${LAYOUT_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand('abiExplorer.restartServer', restart),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsServer(event)) void restart();
    }),
  );
  await restart();
}

export async function deactivate(): Promise<void> {
  await restarts;
  await stopSession();
}

async function stopSession(): Promise<void> {
  if (!session) return;
  const { client, disposables } = session;
  session = undefined;
  for (const disposable of disposables) disposable.dispose();
  // `stop` throws for a client that never got running; dispose either way.
  await client.dispose().catch(() => {});
}

function createClient(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): LanguageClient {
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
    outputChannel: output,
    initializationOptions: initializationOptions(context.globalStorageUri.fsPath),
  };
  return new LanguageClient('abiExplorer', 'ABI Explorer', serverOptions, clientOptions);
}
