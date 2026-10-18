// The language server: LSP in, analyses out.
//
// Everything editor-specific lives in the clients. What is here is the same
// for all of them: hovers, the reorder and pin code actions, and
// the `abiExplorer/layout` request that panels draw from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CodeAction,
  CodeActionKind,
  type Connection,
  type Hover,
  type InitializeResult,
  MarkupKind,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analyzer, type Analysis, type AnalyzedDocument } from './analysis.ts';
import { CompileCommandFinder } from './compile/compileCommandFinder.ts';
import { ToolchainProber } from './compile/toolchain.ts';
import { EngineClient } from './engine/engineClient.ts';
import { ensureEngineFiles } from './engine/engineFiles.ts';
import { createPathMap } from './engine/pathMap.ts';
import {
  DIAGNOSTIC_SOURCE,
  keepOrderEdit,
  layoutDiagnostics,
  REORDER_CODE,
} from './layout/diagnostics.ts';
import { memberHover, recordHover } from './layout/hover.ts';
import { typeNameAt } from './layout/typeNameAt.ts';
import { pinAction } from './layout/pinAction.ts';
import { reorderAction } from './layout/reorderAction.ts';
import { textLayout } from './layout/textLayout.ts';
import packageJson from '../package.json' with { type: 'json' };
import {
  colorModeNotification,
  compileCommandsNotification,
  layoutRequest,
  layoutsChangedNotification,
  type AnalysisContext,
  type ColorMode,
  type ColorModeParams,
  type CompileCommandsParams,
  type InitializationOptions,
  type LayoutParams,
  type LayoutResult,
  type Position,
  type Range,
  type RecordView,
} from '@abi-explorer/shared/protocol';

/** How long a hover or layout request waits for a document's first analysis before answering without it. */
const FIRST_ANALYSIS_WAIT_MS = 1_500;

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
  let colorMode: ColorMode = 'dark';

  connection.onInitialize((params): InitializeResult => {
    const settings = (params.initializationOptions ?? {}) as InitializationOptions;
    hoverImages = settings.hoverImages ?? false;
    colorMode = settings.colorMode ?? 'dark';
    const canShowProgress = params.capabilities.window?.workDoneProgress ?? false;

    const style = process.platform === 'win32' ? 'win32' : 'posix';
    const pathMap = createPathMap(process.platform, style === 'win32' ? windowsDrives() : []);
    commands = new CompileCommandFinder({ style, compileCommandsDir: settings.compileCommandsDir });
    engine = new EngineClient(
      options.engineWorker,
      () => downloadEngine(connection, settings, canShowProgress),
      pathMap.mounts,
    );
    // Older clients send only `rootUri`.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const rootUri = params.rootUri;
    const projectFolders = (params.workspaceFolders ?? (rootUri ? [{ uri: rootUri }] : []))
      .filter((folder) => folder.uri.startsWith('file:'))
      .map((folder) => fileURLToPath(folder.uri));
    analyzer = new Analyzer({
      engine,
      commands,
      toolchains: new ToolchainProber(),
      pathMap,
      settings: {
        style,
        fallbackFlags: settings.fallbackFlags ?? [],
        probePolicy: { projectFolders, allowedCompilers: settings.allowedCompilers ?? [] },
        target: settings.target?.trim() ? settings.target.trim() : null,
        debounceMs: 400,
      },
      onAnalyzed: (analysis) => {
        announce(analysis);
      },
    });

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        codeActionProvider: {
          codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor],
        },
      },
      serverInfo: { name: 'abi-explorer-lsp', version: packageJson.version },
    };
  });

  const announce = (analysis: Analysis) => {
    if (analysis.kind === 'failed') connection.console.warn(`${analysis.uri}: ${analysis.message}`);
    const uri = analysis.kind === 'analyzed' ? analysis.document.uri : analysis.uri;
    // A failed analysis keeps the last warnings, as it keeps the last layouts.
    if (analysis.kind === 'analyzed') {
      const { version, records, lines } = analysis.document;
      void connection.sendDiagnostics({
        uri,
        version,
        diagnostics: layoutDiagnostics(records, lines),
      });
    }
    void connection.sendNotification(layoutsChangedNotification, { uri });
  };

  documents.onDidOpen(({ document }) => void analyzer?.analyze(document));
  documents.onDidChangeContent(({ document }) => analyzer?.schedule(document));
  documents.onDidClose(({ document }) => {
    analyzer?.forget(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onHover(async ({ textDocument, position }): Promise<Hover | null> => {
    const document = documents.get(textDocument.uri);
    if (!document || !analyzer) return null;
    const analysis = await analyzer.waitForAnalysis(document, FIRST_ANALYSIS_WAIT_MS);
    if (analysis?.kind !== 'analyzed') return null;
    const analyzed = analysis.document;
    if (!lineUnchanged(analyzed, document, position.line)) return null;

    const hit =
      nameUnder(analyzed.records, position) ?? nameUnder(analyzed.nestedRecords, position);
    if (!hit) {
      const name = typeNameAt(lineText(document, position.line), position.line, position.character);
      const record = name && analyzed.recordNamed(name.spelling);
      if (!record) return null;
      const markdown = recordHover(record, analyzed.context, {
        images: hoverImages,
        mode: colorMode,
      });
      return { contents: { kind: MarkupKind.Markdown, value: markdown }, range: name.range };
    }
    const markdown =
      hit.memberIndex === null
        ? hit.records
            .map((record) =>
              recordHover(record, analyzed.context, { images: hoverImages, mode: colorMode }),
            )
            .join('\n\n---\n\n')
        : memberHover(hit.records[0]!, hit.memberIndex, analyzed.context, {
            images: hoverImages,
            mode: colorMode,
          });
    return { contents: { kind: MarkupKind.Markdown, value: markdown }, range: hit.range };
  });

  connection.onCodeAction(({ textDocument, range, context }): CodeAction[] => {
    const offered = (kind: string) =>
      !context.only || context.only.some((wanted) => kind.startsWith(wanted));
    if (!offered(CodeActionKind.QuickFix) && !offered(CodeActionKind.Refactor)) return [];
    const document = documents.get(textDocument.uri);
    const analysis = analyzer?.kept(textDocument.uri);
    // Edits by stale positions would land in the wrong place: only on the analysed text.
    if (
      !document ||
      analysis?.kind !== 'analyzed' ||
      analysis.document.version !== document.version
    ) {
      return [];
    }
    const { records, lines, language } = analysis.document;
    const hit = innermostRecordAt(records, range.start);
    if (!hit) return [];
    const actions: CodeAction[] = [];
    // The editor's copies of the record's warning, which the fixes name.
    const warnings = (record: RecordView) =>
      context.diagnostics.filter(
        (diagnostic) =>
          diagnostic.source === DIAGNOSTIC_SOURCE &&
          diagnostic.code === REORDER_CODE &&
          diagnostic.range.start.line === record.nameRange?.start.line,
      );
    // Whether the record has the warning: its order wastes space and is not kept on purpose.
    const warningAt = (record: RecordView) => layoutDiagnostics([record], lines).length > 0;
    // The fix for the record's warning.
    // A fix while the record has the warning; a plain refactoring once its order is kept.
    const warned = warningAt(hit.record);
    const reorderKind = warned ? CodeActionKind.QuickFix : CodeActionKind.RefactorRewrite;
    const reorder = offered(reorderKind) && reorderAction(hit.record, lines);
    if (reorder) {
      actions.push({
        title: reorder.title,
        kind: reorderKind,
        ...(warned && { diagnostics: warnings(hit.record), isPreferred: true }),
        edit: { changes: { [textDocument.uri]: reorder.edits } },
      });
    }
    // The warning's other fix: this order is meant.
    const keep = offered(CodeActionKind.QuickFix) && warned && keepOrderEdit(hit.record, lines);
    if (keep) {
      actions.push({
        title: 'Keep this member order',
        kind: CodeActionKind.QuickFix,
        diagnostics: warnings(hit.record),
        edit: { changes: { [textDocument.uri]: [keep] } },
      });
    }
    const pin = offered(CodeActionKind.Refactor) && pinAction(hit.record, lines, language);
    if (pin) {
      actions.push({
        title: pin.title,
        kind: CodeActionKind.Refactor,
        edit: { changes: { [textDocument.uri]: [pin.edit] } },
      });
    }
    return actions;
  });

  connection.onRequest(layoutRequest, async (params: LayoutParams): Promise<LayoutResult> => {
    const document = documents.get(params.textDocument.uri);
    if (!document || !analyzer) {
      return {
        state: 'unavailable',
        message: 'Open a C or C++ file to see its layouts.',
        records: [],
        selection: null,
        context: null,
      };
    }
    const analysis = await analyzer.waitForAnalysis(document, FIRST_ANALYSIS_WAIT_MS);
    if (!analysis) {
      return { state: 'analyzing', message: null, records: [], selection: null, context: null };
    }
    if (analysis.kind === 'failed') {
      return {
        state: 'unavailable',
        message: analysis.message,
        records: [],
        selection: null,
        context: null,
      };
    }
    const { records, context } = analysis.document;
    const hit = params.position ? innermostRecordAt(records, params.position) : null;
    const failure = analyzer.failure(document.uri, document.version);
    return {
      state: analysis.document.version === document.version || failure ? 'ready' : 'analyzing',
      message: failure
        ? `The latest edit could not be analysed (${failure}); these are the last layouts that worked.`
        : records.length === 0
          ? noRecordsMessage(analysis.document.lines, context)
          : null,
      records: records.map((record) => {
        if (!params.includeText) return record;
        const drawing = textLayout(
          record,
          record.id === hit?.record.id ? hit.memberIndex : null,
          // A client's empty list can arrive as `{}` (Lua tables encode either way).
          new Set(Array.isArray(params.open?.[record.name]) ? params.open[record.name] : []),
        );
        return {
          ...record,
          text: drawing.text,
          textColors: drawing.colors,
          textRows: drawing.rows,
        };
      }),
      selection: hit && { recordId: hit.record.id, memberIndex: hit.memberIndex },
      context,
    };
  });

  connection.onNotification(colorModeNotification, (params: ColorModeParams) => {
    colorMode = params.mode;
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
function nameUnder(
  records: readonly RecordView[],
  position: Position,
): { records: RecordView[]; memberIndex: number | null; range: Range } | null {
  const named = records.filter(
    (record) => record.nameRange && contains(record.nameRange, position),
  );
  if (named.length > 0) {
    return { records: named.slice(0, 3), memberIndex: null, range: named[0]!.nameRange! };
  }
  for (const record of records) {
    const memberIndex = record.members.findIndex(
      (member) => member.nameRange && contains(member.nameRange, position),
    );
    if (memberIndex >= 0) {
      return { records: [record], memberIndex, range: record.members[memberIndex]!.nameRange! };
    }
  }
  return null;
}

/** The innermost record whose declaration contains the position, and the member on its line. */
function innermostRecordAt(
  records: readonly RecordView[],
  position: Position,
): { record: RecordView; memberIndex: number | null } | null {
  const containing = records.filter((record) => record.extent && contains(record.extent, position));
  const innermost = containing.sort(
    (a, b) =>
      a.extent!.end.line - a.extent!.start.line - (b.extent!.end.line - b.extent!.start.line),
  )[0];
  if (!innermost) return null;
  const memberIndex = innermost.members.findIndex(
    (member) => member.nameRange?.start.line === position.line,
  );
  return { record: innermost, memberIndex: memberIndex >= 0 ? memberIndex : null };
}

function contains(range: Range, position: Position): boolean {
  const after =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const before =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return after && before;
}

/** Ranges from an older analysis still hold on a line whose text has not changed since. */
function lineUnchanged(analyzed: AnalyzedDocument, document: TextDocument, line: number): boolean {
  return analyzed.version === document.version || analyzed.lines[line] === lineText(document, line);
}

function lineText(document: TextDocument, line: number): string {
  return document
    .getText({ start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } })
    .replace(/\r?\n$/, '');
}

async function downloadEngine(
  connection: Connection,
  settings: InitializationOptions,
  canShowProgress: boolean,
) {
  const progress = canShowProgress ? await connection.window.createWorkDoneProgress() : null;
  let begun = false;
  try {
    return await ensureEngineFiles(
      {
        localDirectory: settings.enginePath,
        cacheDirectory: settings.cacheDirectory ?? defaultCacheDirectory(),
      },
      ({ doneBytes, totalBytes }) => {
        if (!begun) progress?.begin('Downloading the clang layout engine', 0, undefined, false);
        begun = true;
        const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
        progress?.report(
          Math.round((doneBytes / totalBytes) * 100),
          `${megabytes(doneBytes)} of ${megabytes(totalBytes)} MB`,
        );
      },
    );
  } finally {
    progress?.done();
  }
}

function defaultCacheDirectory(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'abi-explorer', 'cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'abi-explorer');
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'abi-explorer');
}

function windowsDrives(): string[] {
  return Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ').filter((letter) => fs.existsSync(`${letter}:\\`));
}

/**
 * Why a file shows nothing: an error that stopped everything (an unknown
 * target, a missing header), or a template, which has no layout of its own
 * until something uses it.
 */
function noRecordsMessage(lines: readonly string[], context: AnalysisContext): string {
  if (context.firstError && context.errorCount + context.otherErrorCount > 0) {
    return `Nothing could be laid out: ${context.firstError}.`;
  }
  return lines.some((line) => /\btemplate\s*</.test(line))
    ? 'A template has no layout until it is used with concrete types: declare one, such as Box<int> box;, to see its layout.'
    : 'No struct, class or union is defined in this file.';
}
