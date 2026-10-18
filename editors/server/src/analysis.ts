// Turning a document into layouts, once per version, off the request path.
//
// Every edit schedules an analysis after a quiet period; the engine works
// through them one at a time, and a result is kept only if it is newer than the
// one already held. Hovers, inlay hints and panels read the kept result at
// once, and wait a little for one only when the document has none at all.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  languageOfFile,
  prepareCommand,
  type Language,
  type PathStyle,
  type PreparedCommand,
} from './compile/commandLine.ts';
import type { CompileCommandFinder, FoundCommand } from './compile/compileCommandFinder.ts';
import { buildEngineRequest } from './compile/engineRequest.ts';
import {
  ProbeRefusedError,
  type ProbePolicy,
  type Toolchain,
  type ToolchainProber,
} from './compile/toolchain.ts';
import type { PathMap } from './engine/pathMap.ts';
import type { EngineRequest, EngineResponse } from './engine/engineTypes.ts';
import { recordsInDocument } from './layout/documentRecords.ts';
import type { AnalysisContext, RecordView } from '@abi-explorer/shared/protocol';

export interface AnalyzedDocument {
  uri: string;
  version: number;
  /** The lines of the text the ranges in `records` refer to. */
  lines: string[];
  records: RecordView[];
  context: AnalysisContext;
}

export type Analysis =
  | { kind: 'analyzed'; document: AnalyzedDocument }
  | { kind: 'failed'; uri: string; version: number; message: string };

export interface DocumentSnapshot {
  uri: string;
  version: number;
  getText(): string;
}

export interface AnalyzerSettings {
  style: PathStyle;
  fallbackFlags: readonly string[];
  probePolicy: ProbePolicy;
  debounceMs: number;
}

export interface AnalyzerDependencies {
  engine: { query(request: EngineRequest): Promise<EngineResponse> };
  commands: CompileCommandFinder;
  toolchains: ToolchainProber;
  pathMap: PathMap;
  settings: AnalyzerSettings;
  /** Called when a document's kept analysis changes, or a newer version fails. */
  onAnalyzed(analysis: Analysis): void;
}

export class Analyzer {
  private readonly latest = new Map<string, Analysis>();
  /** Failures newer than the kept analysis, which they did not replace. */
  private readonly failures = new Map<string, Analysis & { kind: 'failed' }>();
  private readonly running = new Map<string, { version: number; done: Promise<Analysis> }>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dependencies: AnalyzerDependencies;

  constructor(dependencies: AnalyzerDependencies) {
    this.dependencies = dependencies;
  }

  /** Analyse after the document has been quiet for a moment. */
  schedule(document: DocumentSnapshot): void {
    clearTimeout(this.timers.get(document.uri));
    this.timers.set(
      document.uri,
      setTimeout(() => {
        this.timers.delete(document.uri);
        void this.analyze(document);
      }, this.dependencies.settings.debounceMs),
    );
  }

  /**
   * The kept analysis, whatever its version: callers check that its ranges still
   * hold. Only a document with none yet waits, up to `waitMs`, for its first.
   */
  async waitForAnalysis(document: DocumentSnapshot, waitMs: number): Promise<Analysis | undefined> {
    const kept = this.latest.get(document.uri);
    if (kept) return kept;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
    await Promise.race([this.analyze(document), timeout]);
    // What was kept, rather than what ran: a superseded or failed run may have kept nothing new.
    return this.latest.get(document.uri);
  }

  /** The newest kept analysis, whatever its version. */
  kept(uri: string): Analysis | undefined {
    return this.latest.get(uri);
  }

  /** Why this version could not be analysed, when it failed after an earlier version worked. */
  failure(uri: string, version: number): string | null {
    const failed = this.failures.get(uri);
    return failed?.version === version ? failed.message : null;
  }

  forget(uri: string): void {
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    this.latest.delete(uri);
    this.failures.delete(uri);
    this.running.delete(uri);
  }

  /** Re-analyse every open document, e.g. after the editor pushed new compile commands. */
  reanalyzeAll(documents: Iterable<DocumentSnapshot>): void {
    for (const document of documents) {
      this.running.delete(document.uri);
      this.schedule(document);
    }
  }

  /** Analyses this version now, unless it already is being analysed. */
  analyze(document: DocumentSnapshot): Promise<Analysis> {
    const running = this.running.get(document.uri);
    if (running?.version === document.version) return running.done;
    clearTimeout(this.timers.get(document.uri));
    this.timers.delete(document.uri);

    const done = this.run(document).then((analysis) => {
      const isCurrent = this.running.get(document.uri)?.done === done;
      if (isCurrent) this.running.delete(document.uri);
      // A closed document, or one re-analysed with new commands meanwhile, keeps nothing from this run.
      if (!isCurrent) return analysis;
      const kept = this.latest.get(document.uri);
      // A failure does not replace layouts that worked: they are more use than nothing.
      const replaces =
        !kept ||
        (versionOf(kept) <= versionOf(analysis) &&
          (analysis.kind === 'analyzed' || kept.kind === 'failed'));
      if (replaces) {
        this.latest.set(document.uri, analysis);
        this.failures.delete(document.uri);
      } else if (analysis.kind === 'failed' && versionOf(kept) < analysis.version) {
        this.failures.set(document.uri, analysis);
      } else {
        return analysis;
      }
      this.dependencies.onAnalyzed(analysis);
      return analysis;
    });
    this.running.set(document.uri, { version: document.version, done });
    return done;
  }

  /** Whether a newer version of the document has been started since `version`. */
  private superseded(uri: string, version: number): boolean {
    return (this.running.get(uri)?.version ?? version) > version;
  }

  private async run(document: DocumentSnapshot): Promise<Analysis> {
    const { uri, version } = document;
    const text = document.getText();
    try {
      const file = fileURLToPath(uri);
      const found = this.findCommand(file);
      const command = prepareCommand(found.command, this.dependencies.settings.style);
      const language = languageFor(file, command, found);
      const toolchain = await this.probe(command, language, found);
      const request = buildEngineRequest({
        file,
        text,
        language,
        command,
        toolchain,
        pathMap: this.dependencies.pathMap,
      });
      // The engine takes one request at a time; one for an outdated version would only delay the next.
      if (this.superseded(uri, version))
        return { kind: 'failed', uri, version, message: 'superseded by a newer edit' };
      const response = await this.dependencies.engine.query(request);
      if (!response.ok)
        return {
          kind: 'failed',
          uri,
          version,
          message: response.error ?? 'the engine rejected the request',
        };

      return {
        kind: 'analyzed',
        document: {
          uri,
          version,
          lines: text.split(/\r?\n/),
          records: recordsInDocument(response.records, { guestPath: request.filename, text }),
          context: {
            triple: response.target?.triple ?? toolchain.triple,
            cxxAbi: response.target?.cxxAbi ?? 'unknown',
            clangVersion: response.clangVersion,
            commandSource: describeOrigin(found),
            commandInferred: found.borrowedFrom !== null,
            ...errorCounts(response.diagnostics),
            warning: toolchain.warning,
          },
        },
      };
    } catch (error) {
      return {
        kind: 'failed',
        uri,
        version,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The compiler's own headers and target. When it cannot be asked (not
   * installed here, or not allowed to run), the engine's bundled headers stand
   * in, and the context line says why.
   */
  private async probe(
    command: PreparedCommand,
    language: Language,
    found: FoundCommand,
  ): Promise<ProbedToolchain> {
    const { probePolicy } = this.dependencies.settings;
    // The directories a command came from are the project's too, wherever they are.
    const origin =
      found.origin.kind === 'pushed'
        ? []
        : [path.dirname(found.origin.path), path.dirname(path.dirname(found.origin.path))];
    const policy = {
      ...probePolicy,
      projectFolders: [...probePolicy.projectFolders, ...origin, path.dirname(found.command.file)],
    };
    try {
      return {
        ...(await this.dependencies.toolchains.probe(command, language, policy)),
        warning: null,
      };
    } catch (error) {
      const reason =
        error instanceof ProbeRefusedError
          ? error.message
          : `${command.compiler} could not be asked for its headers (${error instanceof Error ? error.message : String(error)})`;
      return {
        triple: hostTriple(command.driver),
        systemIncludes: [],
        msvcVersion: null,
        warning: `${reason}, so the bundled headers were used`,
      };
    }
  }

  private findCommand(file: string): FoundCommand {
    const found = this.dependencies.commands.find(file);
    if (found) return found;
    const { style, fallbackFlags } = this.dependencies.settings;
    const compiler =
      style === 'win32'
        ? process.env['INCLUDE']
          ? 'cl'
          : 'clang'
        : languageOfFile(file) === 'c'
          ? 'cc'
          : 'c++';
    return {
      command: {
        directory: path.dirname(file),
        file,
        arguments: [compiler, ...fallbackFlags, file],
      },
      origin: { kind: 'pushed', label: 'fallback flags' },
      borrowedFrom: null,
    };
  }
}

type ProbedToolchain = Toolchain & { warning: string | null };

/** The machine's own target, for when the compiler cannot say. */
function hostTriple(driver: PreparedCommand['driver']): string {
  const arch =
    { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch as string] ?? process.arch;
  if (driver === 'msvc' || process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch === 'aarch64' ? 'arm64' : arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

function languageFor(file: string, command: PreparedCommand, found: FoundCommand): Language {
  return (
    command.language ??
    languageOfFile(file) ??
    (found.borrowedFrom ? languageOfFile(found.borrowedFrom) : null) ??
    'c++'
  );
}

function describeOrigin(found: FoundCommand): string {
  return found.origin.kind === 'pushed' ? found.origin.label : found.origin.kind;
}

/** Errors in the document itself, and elsewhere: in its headers, or in the flags. */
function errorCounts(diagnostics: EngineResponse['diagnostics']): {
  errorCount: number;
  otherErrorCount: number;
} {
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  );
  const inFile = errors.filter((diagnostic) => diagnostic.location?.isMainFile).length;
  return { errorCount: inFile, otherErrorCount: errors.length - inFile };
}

function versionOf(analysis: Analysis): number {
  return analysis.kind === 'analyzed' ? analysis.document.version : analysis.version;
}
