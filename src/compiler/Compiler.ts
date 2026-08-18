// The compiler abstraction the analyzer works against. The real one drives the
// wasm worker (ClangClient); tests use a FixtureCompiler that replays recorded
// outputs, so the whole pipeline is testable without WebAssembly.

export interface CompileOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CompileJob {
  argv0: 'clang' | 'clang++';
  args: string[];
  files: Record<string, string>;
  /** Cancels the job on the client side (results are dropped). */
  signal?: AbortSignal | undefined;
}

export type CompilerStatus =
  | { state: 'idle' }
  | { state: 'loading'; phase: 'download' | 'unpack' | 'compile'; done: number; total: number }
  | { state: 'ready'; version: string }
  | { state: 'restarting'; reason: string }
  | { state: 'failed'; message: string };

export interface Compiler {
  readonly status: CompilerStatus;
  onStatus(listener: (status: CompilerStatus) => void): () => void;
  /** Start loading; resolves when ready (or rejects when it can never become ready). */
  start(): Promise<void>;
  compile(job: CompileJob): Promise<CompileOutput>;
  dispose(): void;
}

export class CompileCancelled extends Error {
  constructor() {
    super('compile cancelled');
    this.name = 'CompileCancelled';
  }
}

export class CompileTimeout extends Error {
  constructor(ms: number) {
    super(`compile timed out after ${ms} ms`);
    this.name = 'CompileTimeout';
  }
}

/** Replays recorded outputs; a lookup function maps a job to its output. */
export class FixtureCompiler implements Compiler {
  status: CompilerStatus = { state: 'ready', version: 'fixture clang' };
  readonly calls: CompileJob[] = [];
  constructor(
    private readonly lookup: (job: CompileJob) => CompileOutput | Promise<CompileOutput>,
  ) {}
  onStatus(listener: (status: CompilerStatus) => void): () => void {
    listener(this.status);
    return () => {};
  }
  async start(): Promise<void> {}
  async compile(job: CompileJob): Promise<CompileOutput> {
    if (job.signal?.aborted) throw new CompileCancelled();
    this.calls.push(job);
    return this.lookup(job);
  }
  dispose(): void {}
}
