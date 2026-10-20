// The server over stdio, driven the way an editor drives it.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { CodeAction, Diagnostic, Hover } from 'vscode-languageserver-protocol';
import {
  layoutRequest,
  layoutsChangedNotification,
  type InitializationOptions,
  type LayoutResult,
  type Position,
} from '@abi-explorer/shared/protocol';

// ABI_EXPLORER_SERVER runs another build of the server instead, such as the npm
// package as it will be published (the release's smoke tests do).
const SERVER_SOURCE =
  process.env.ABI_EXPLORER_SERVER ?? path.join(import.meta.dirname, '..', '..', 'src', 'main.ts');

export class LspSession {
  private readonly process: ChildProcess;
  private readonly connection: MessageConnection;
  private readonly versions = new Map<string, number>();
  private readonly analyzed = new Map<string, () => void>();
  private readonly published = new Map<string, Diagnostic[]>();

  private constructor(process: ChildProcess) {
    this.process = process;
    this.connection = createMessageConnection(
      new StreamMessageReader(process.stdout!),
      new StreamMessageWriter(process.stdin!),
    );
    this.connection.onNotification(layoutsChangedNotification, ({ uri }: { uri: string }) => {
      this.analyzed.get(uri)?.();
    });
    this.connection.onNotification(
      'textDocument/publishDiagnostics',
      ({ uri, diagnostics }: { uri: string; diagnostics: Diagnostic[] }) => {
        this.published.set(uri, diagnostics);
      },
    );
    this.connection.onRequest('window/workDoneProgress/create', () => null);
    this.connection.listen();
  }

  static async start(rootUri: string, options: InitializationOptions): Promise<LspSession> {
    const child = spawn(process.execPath, [SERVER_SOURCE, '--stdio'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const session = new LspSession(child);
    await session.connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'project' }],
      capabilities: {
        window: { workDoneProgress: true },
      },
      initializationOptions: options,
    });
    await session.connection.sendNotification('initialized', {});
    return session;
  }

  /** The diagnostics last published for a file; the server sends them before announcing new layouts. */
  diagnostics(uri: string): Diagnostic[] {
    return this.published.get(uri) ?? [];
  }

  /** Opens a file and resolves once its first analysis is in. */
  async open(uri: string): Promise<void> {
    const analyzed = this.nextAnalysis(uri);
    this.versions.set(uri, 1);
    await this.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: uri.endsWith('.c') ? 'c' : 'cpp',
        version: 1,
        text: fs.readFileSync(new URL(uri), 'utf8'),
      },
    });
    await analyzed;
  }

  /** Replaces the whole text and resolves once it has been analysed. */
  async change(uri: string, text: string): Promise<void> {
    const analyzed = this.nextAnalysis(uri);
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    await this.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    await analyzed;
  }

  hover(uri: string, position: Position): Promise<Hover | null> {
    return this.connection.sendRequest('textDocument/hover', { textDocument: { uri }, position });
  }

  codeActions(uri: string, position: Position): Promise<CodeAction[]> {
    return this.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: position, end: position },
      // As an editor sends them: the file's warnings, which the server matches to its fixes.
      context: { diagnostics: this.diagnostics(uri) },
    });
  }

  layout(uri: string, position?: Position, includeText = false): Promise<LayoutResult> {
    return this.connection.sendRequest(layoutRequest, {
      textDocument: { uri },
      position,
      includeText,
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  nextAnalysis(uri: string): Promise<void> {
    return new Promise((resolve) => this.analyzed.set(uri, resolve));
  }

  async stop(): Promise<void> {
    await this.connection.sendRequest('shutdown');
    await this.connection.sendNotification('exit');
    this.connection.dispose();
    this.process.kill();
  }
}
