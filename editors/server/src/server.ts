// The language server: LSP in, analyses out.
//
// Everything editor-specific lives in the clients. What is here is the same
// for all of them: hovers, inlay hints, and the `abiExplorer/layout` request
// that panels draw from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Connection,
  type Hover,
  type InitializeResult,
  type InlayHint,
  MarkupKind,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analyzer, type Analysis, type AnalyzedDocument } from './analysis.ts';
import { CompileCommandFinder } from './compile/compilationDatabase.ts';
import { ToolchainProber } from './compile/toolchain.ts';
import { EngineClient } from './engine/engineClient.ts';
import { ensureEngineFiles } from './engine/engineFiles.ts';
import { createPathMap } from './engine/pathMap.ts';
import { memberHover, recordHover } from './layout/hover.ts';
import { layoutHints } from './layout/inlayHints.ts';
import { textLayout } from './layout/textMap.ts';
import {
  compileCommandsNotification,
  layoutRequest,
  layoutsChangedNotification,
  type CompileCommandsParams,
  type InitializationOptions,
  type LayoutParams,
  type LayoutResult,
  type Position,
  type Range,
  type RecordView,
} from './protocol.ts';

/** How long a hover waits for a document's first analysis before giving up for now. */
const HOVER_WAIT_MS = 1_500;

export interface ServerOptions {
  /** The engine worker's entry point: the bundled file, or the source in development. */
  engineWorker: URL;
}

export function startServer(connection: Connection, options: ServerOptions): void {
  const documents = new TextDocuments(TextDocument);
  let analyzer: Analyzer | null = null;
  let engine: EngineClient | null = null;
  let commands: CompileCommandFinder | null = null;
  let hoverImages = false;
  let inlayHintsMode: InitializationOptions['inlayHints'] = 'records';
  let canRefreshInlayHints = false;

  connection.onInitialize((params): InitializeResult => {
    const settings = (params.initializationOptions ?? {}) as InitializationOptions;
    hoverImages = settings.hoverImages ?? false;
    inlayHintsMode = settings.inlayHints ?? 'records';
    canRefreshInlayHints = params.capabilities.workspace?.inlayHint?.refreshSupport ?? false;
    const canShowProgress = params.capabilities.window?.workDoneProgress ?? false;

    const style = process.platform === 'win32' ? 'win32' : 'posix';
    const pathMap = createPathMap(process.platform, style === 'win32' ? windowsDrives() : []);
    commands = new CompileCommandFinder({ style, compileCommandsDir: settings.compileCommandsDir });
    engine = new EngineClient(
      options.engineWorker,
      () => downloadEngine(connection, settings, canShowProgress),
      pathMap.mounts,
    );
    const workspaceFolders = (params.workspaceFolders ?? []).map((folder) => uriToPath(folder.uri));
    analyzer = new Analyzer({
      engine,
      commands,
      toolchains: new ToolchainProber(),
      pathMap,
      settings: {
        style,
        fallbackFlags: settings.fallbackFlags ?? [],
        probePolicy: { workspaceFolders, allowedCompilers: settings.allowedCompilers ?? [] },
        debounceMs: 400,
      },
      onAnalyzed: (analysis) => announce(analysis),
    });

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        inlayHintProvider: true,
      },
      serverInfo: { name: 'abi-explorer-lsp', version: '0.1.0' },
    };
  });

  const announce = (analysis: Analysis) => {
    if (analysis.kind === 'failed') connection.console.warn(`${analysis.uri}: ${analysis.message}`);
    if (canRefreshInlayHints) void connection.languages.inlayHint.refresh();
    const uri = analysis.kind === 'analyzed' ? analysis.document.uri : analysis.uri;
    void connection.sendNotification(layoutsChangedNotification, { uri });
  };

  documents.onDidOpen(({ document }) => void analyzer?.analyze(document));
  documents.onDidChangeContent(({ document }) => analyzer?.schedule(document));
  documents.onDidClose(({ document }) => analyzer?.forget(document.uri));

  connection.onHover(async ({ textDocument, position }): Promise<Hover | null> => {
    const document = documents.get(textDocument.uri);
    if (!document || !analyzer) return null;
    const analysis = await analyzer.current(document, HOVER_WAIT_MS);
    if (analysis?.kind !== 'analyzed') return null;
    const analyzed = analysis.document;
    if (!lineUnchanged(analyzed, document, position.line)) return null;

    const hit = findAt(analyzed.records, position);
    if (!hit) return null;
    const markdown =
      hit.memberIndex === null
        ? hit.records.map((record) => recordHover(record, analyzed.context, { images: hoverImages })).join('\n\n---\n\n')
        : memberHover(hit.records[0]!, hit.memberIndex, analyzed.context, { images: hoverImages });
    return { contents: { kind: MarkupKind.Markdown, value: markdown }, range: hit.range };
  });

  connection.languages.inlayHint.on(({ textDocument, range }): InlayHint[] => {
    const document = documents.get(textDocument.uri);
    const analysis = analyzer?.kept(textDocument.uri);
    if (!document || analysis?.kind !== 'analyzed') return [];
    const analyzed = analysis.document;
    return layoutHints(analyzed.records, inlayHintsMode ?? 'records', (line) => lineText(document, line).length)
      .filter(
        (hint) =>
          hint.position.line >= range.start.line &&
          hint.position.line <= range.end.line &&
          lineUnchanged(analyzed, document, hint.position.line),
      )
      .map((hint) => ({ position: hint.position, label: hint.label, paddingLeft: true }));
  });

  connection.onRequest(layoutRequest, async (params: LayoutParams): Promise<LayoutResult> => {
    const document = documents.get(params.textDocument.uri);
    if (!document || !analyzer) {
      return { state: 'unavailable', message: 'Open a C or C++ file to see its layouts.', records: [], selection: null, context: null };
    }
    const analysis = await analyzer.current(document, HOVER_WAIT_MS);
    if (!analysis) return { state: 'analyzing', message: null, records: [], selection: null, context: null };
    if (analysis.kind === 'failed') {
      return { state: 'unavailable', message: analysis.message, records: [], selection: null, context: null };
    }
    const { records, context } = analysis.document;
    const hit = params.position ? findInside(records, params.position) : null;
    return {
      state: analysis.document.version === document.version ? 'ready' : 'analyzing',
      message: records.length === 0 ? 'No struct, class or union is defined in this file.' : null,
      records: params.includeText
        ? records.map((record) => ({ ...record, text: textLayout(record, record.id === hit?.record.id ? hit.memberIndex : null) }))
        : records,
      selection: hit && { recordId: hit.record.id, memberIndex: hit.memberIndex },
      context,
    };
  });

  connection.onNotification(compileCommandsNotification, (params: CompileCommandsParams) => {
    commands?.setPushedCommands(params.source, params.commands);
    analyzer?.reanalyzeAll(documents.all());
  });

  connection.onShutdown(() => engine?.dispose());
  documents.listen(connection);
  connection.listen();
}

/** The records whose name, or the member whose name, is under the position. */
function findAt(
  records: readonly RecordView[],
  position: Position,
): { records: RecordView[]; memberIndex: number | null; range: Range } | null {
  const named = records.filter((record) => record.nameRange && contains(record.nameRange, position));
  if (named.length > 0) return { records: named.slice(0, 3), memberIndex: null, range: named[0]!.nameRange! };
  for (const record of records) {
    const memberIndex = record.members.findIndex((member) => member.nameRange && contains(member.nameRange, position));
    if (memberIndex >= 0) return { records: [record], memberIndex, range: record.members[memberIndex]!.nameRange! };
  }
  return null;
}

/** The innermost record whose declaration contains the position, and the member on its line. */
function findInside(records: readonly RecordView[], position: Position): { record: RecordView; memberIndex: number | null } | null {
  const containing = records.filter((record) => record.extent && contains(record.extent, position));
  const innermost = containing.sort((a, b) => a.extent!.end.line - a.extent!.start.line - (b.extent!.end.line - b.extent!.start.line))[0];
  if (!innermost) return null;
  const memberIndex = innermost.members.findIndex((member) => member.nameRange?.start.line === position.line);
  return { record: innermost, memberIndex: memberIndex >= 0 ? memberIndex : null };
}

function contains(range: Range, position: Position): boolean {
  const after = position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
  const before = position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
  return after && before;
}

/** Ranges from an older analysis still hold on a line whose text has not changed since. */
function lineUnchanged(analyzed: AnalyzedDocument, document: TextDocument, line: number): boolean {
  return analyzed.version === document.version || analyzed.text.split(/\r?\n/)[line] === lineText(document, line);
}

function lineText(document: TextDocument, line: number): string {
  return document.getText({ start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } }).replace(/\r?\n$/, '');
}

async function downloadEngine(connection: Connection, settings: InitializationOptions, canShowProgress: boolean) {
  const progress = canShowProgress ? await connection.window.createWorkDoneProgress() : null;
  let begun = false;
  try {
    return await ensureEngineFiles(
      { localDirectory: settings.enginePath, cacheDirectory: settings.cacheDirectory ?? defaultCacheDirectory() },
      ({ doneBytes, totalBytes }) => {
        if (!begun) progress?.begin('Downloading the clang layout engine', 0, undefined, false);
        begun = true;
        const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
        progress?.report(Math.round((doneBytes / totalBytes) * 100), `${megabytes(doneBytes)} of ${megabytes(totalBytes)} MB`);
      },
    );
  } finally {
    progress?.done();
  }
}

function defaultCacheDirectory(): string {
  if (process.platform === 'win32') return path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'abi-explorer', 'cache');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'abi-explorer');
  return path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'abi-explorer');
}

function windowsDrives(): string[] {
  return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((letter) => fs.existsSync(`${letter}:\\`));
}

function uriToPath(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
}
