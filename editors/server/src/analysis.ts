// Turning a document into layouts, once per version, off the request path.
//
// Every edit schedules an analysis after a quiet period; the engine works
// through them one at a time, and a result is kept only if it is newer than the
// one already held. Hovers and inlay hints read the kept result, and wait a
// little for a fresh one only when the document has none at all.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageOfFile, prepareCommand, type Language, type PathStyle, type PreparedCommand } from './compile/commandLine.ts';
import type { CompileCommandFinder, FoundCommand } from './compile/compilationDatabase.ts';
import { buildEngineRequest } from './compile/engineRequest.ts';
import type { ProbePolicy, ToolchainProber } from './compile/toolchain.ts';
import type { PathMap } from './engine/pathMap.ts';
import type { EngineRequest, EngineResponse } from './engine/wire.ts';
import { recordViewsFor } from './layout/views.ts';
import type { AnalysisContext, RecordView } from './protocol.ts';

export interface AnalyzedDocument {
  uri: string;
  version: number;
  /** The text the ranges in `records` refer to. */
  text: string;
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
  /** Called whenever a document's kept analysis changes. */
  onAnalyzed(analysis: Analysis): void;
}

export class Analyzer {
  private readonly latest = new Map<string, Analysis>();
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

  /** The newest analysis, waiting up to `waitMs` for one when there is none for this version. */
  async current(document: DocumentSnapshot, waitMs: number): Promise<Analysis | undefined> {
    const kept = this.latest.get(document.uri);
    if (kept && versionOf(kept) === document.version) return kept;
    const running = this.running.get(document.uri);
    const pending = running?.version === document.version ? running.done : this.analyze(document);
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs).unref());
    return (await Promise.race([pending, timeout])) ?? this.latest.get(document.uri);
  }

  /** The newest kept analysis, whatever its version. */
  kept(uri: string): Analysis | undefined {
    return this.latest.get(uri);
  }

  forget(uri: string): void {
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    this.latest.delete(uri);
  }

  /** Re-analyse every open document, e.g. after the editor pushed new compile commands. */
  reanalyzeAll(documents: Iterable<DocumentSnapshot>): void {
    for (const document of documents) this.schedule(document);
  }

  analyze(document: DocumentSnapshot): Promise<Analysis> {
    const done = this.run(document).then((analysis) => {
      const kept = this.latest.get(document.uri);
      if (!kept || versionOf(kept) <= versionOf(analysis)) {
        this.latest.set(document.uri, analysis);
        this.dependencies.onAnalyzed(analysis);
      }
      if (this.running.get(document.uri)?.done === done) this.running.delete(document.uri);
      return analysis;
    });
    this.running.set(document.uri, { version: document.version, done });
    return done;
  }

  private async run(document: DocumentSnapshot): Promise<Analysis> {
    const { uri, version } = document;
    const text = document.getText();
    try {
      const file = fileURLToPath(uri);
      const found = this.findCommand(file);
      const command = prepareCommand(found.command, this.dependencies.settings.style);
      const language = languageFor(file, command, found);
      const toolchain = await this.dependencies.toolchains.probe(command, language, this.dependencies.settings.probePolicy);
      const request = buildEngineRequest({ file, text, language, command, toolchain, pathMap: this.dependencies.pathMap });
      const response = await this.dependencies.engine.query(request);
      if (!response.ok) return { kind: 'failed', uri, version, message: response.error ?? 'the engine rejected the request' };

      return {
        kind: 'analyzed',
        document: {
          uri,
          version,
          text,
          records: recordViewsFor(response.records, { guestPath: request.filename, text }),
          context: {
            triple: response.target?.triple ?? toolchain.triple,
            cxxAbi: response.target?.cxxAbi ?? 'unknown',
            clangVersion: response.clangVersion,
            commandSource: describeOrigin(found),
            commandInferred: found.borrowedFrom !== null,
            errorCount: response.diagnostics.filter(
              (diagnostic) => (diagnostic.severity === 'error' || diagnostic.severity === 'fatal') && diagnostic.location,
            ).length,
          },
        },
      };
    } catch (error) {
      return { kind: 'failed', uri, version, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private findCommand(file: string): FoundCommand {
    const found = this.dependencies.commands.find(file);
    if (found) return found;
    const { style, fallbackFlags } = this.dependencies.settings;
    const compiler = style === 'win32' ? (process.env['INCLUDE'] ? 'cl' : 'clang') : languageOfFile(file) === 'c' ? 'cc' : 'c++';
    return {
      command: { directory: path.dirname(file), file, arguments: [compiler, ...fallbackFlags, file] },
      origin: { kind: 'pushed', label: 'fallback flags' },
      borrowedFrom: null,
    };
  }
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

function versionOf(analysis: Analysis): number {
  return analysis.kind === 'analyzed' ? analysis.document.version : analysis.version;
}
