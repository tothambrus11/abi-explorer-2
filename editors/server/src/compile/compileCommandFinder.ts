// Finding the compile command for a file, the way clangd finds it.
//
// Sources, first match wins:
//   1. commands the editor pushed (CMake Tools in VS Code, the project model in
//      CLion), which know about files no database lists yet;
//   2. the nearest compile_commands.json, looking in each ancestor directory and
//      its `build/` subdirectory, or in `compileCommandsDir` when configured;
//   3. the nearest compile_flags.txt, whose flags apply to every file below it.
//
// A file the database does not list (a header, usually) borrows the command of
// the listed file that looks most like it, as clangd's interpolation does: the
// same stem in the same directory first, then the longest shared path.

import fs from 'node:fs';
import path from 'node:path';
import { splitCommandLine } from '@abi-explorer/shared/splitCommandLine';
import { languageOfFile, type CompileCommand, type PathStyle } from './commandLine.ts';

export type CommandOrigin =
  | { kind: 'pushed'; label: string }
  | { kind: 'compile_commands.json'; path: string }
  | { kind: 'compile_flags.txt'; path: string };

export interface FoundCommand {
  /** Its `file` is always the file asked about, even when borrowed. */
  command: CompileCommand;
  origin: CommandOrigin;
  /** The file the command was written for, when it was borrowed from another. */
  borrowedFrom: string | null;
}

interface JsonEntry {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
}

class Database {
  readonly origin: CommandOrigin;
  private readonly style: PathStyle;
  private readonly byFile = new Map<string, CompileCommand>();

  constructor(origin: CommandOrigin, commands: readonly CompileCommand[], style: PathStyle) {
    this.origin = origin;
    this.style = style;
    for (const command of commands) {
      this.byFile.set(this.key(command.file, command.directory), command);
    }
  }

  lookup(file: string): FoundCommand | null {
    const exact = this.byFile.get(this.key(file));
    if (exact) return { command: exact, origin: this.origin, borrowedFrom: null };
    const nearest = this.nearest(file);
    return nearest
      ? { command: this.borrow(nearest, file), origin: this.origin, borrowedFrom: nearest.file }
      : null;
  }

  /** The other file's command, compiling `file` instead. */
  private borrow(command: CompileCommand, file: string): CompileCommand {
    const input = this.key(command.file, command.directory);
    const isInput = (arg: string) =>
      !arg.startsWith('-') && this.key(arg, command.directory) === input;
    return {
      directory: command.directory,
      file,
      arguments: command.arguments.map((arg, i) => (i > 0 && isInput(arg) ? file : arg)),
    };
  }

  private nearest(file: string): CompileCommand | null {
    const paths = this.paths();
    const wantsCxx = languageOfFile(file) === 'c++';
    let best: { command: CompileCommand; score: number } | null = null;
    for (const [listed, command] of this.byFile) {
      let score = sharedPrefixLength(listed, this.key(file));
      if (paths.dirname(listed) === paths.dirname(this.key(file))) score += 1_000;
      if (stem(listed, paths) === stem(file, paths)) score += 10_000;
      // A C++ header should not borrow a C file's command, and vice versa.
      if (wantsCxx && languageOfFile(listed) === 'c') score -= 100_000;
      if (!best || score > best.score) best = { command, score };
    }
    return best?.command ?? null;
  }

  private key(file: string, directory = ''): string {
    const resolved = this.paths().resolve(directory, file);
    return this.style === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private paths(): path.PlatformPath {
    return this.style === 'win32' ? path.win32 : path.posix;
  }
}

const RECHECK_INTERVAL_MS = 2_000;

export interface CompileCommandFinderOptions {
  style: PathStyle;
  /** Look here instead of searching ancestors, like clangd's `--compile-commands-dir`. */
  compileCommandsDir?: string | undefined;
}

export class CompileCommandFinder {
  private pushed: Database | null = null;
  /**
   * Keyed by the directory searched; a null database means nothing is there.
   * `stamp` holds the candidate files' modification times, so an edited or
   * newly generated database is picked up without the editor having to say so.
   */
  private readonly databases = new Map<
    string,
    { database: Database | null; stamp: string; checkedAt: number }
  >();

  private readonly options: CompileCommandFinderOptions;

  constructor(options: CompileCommandFinderOptions) {
    this.options = options;
  }

  setPushedCommands(label: string, commands: readonly CompileCommand[]): void {
    this.pushed =
      commands.length > 0
        ? new Database({ kind: 'pushed', label }, commands, this.options.style)
        : null;
  }

  find(file: string): FoundCommand | null {
    const pushed = this.pushed?.lookup(file);
    if (pushed && !pushed.borrowedFrom) return pushed;
    for (const directory of this.searchDirectories(file)) {
      const found = this.databaseIn(directory)?.lookup(file);
      if (found) return found;
    }
    return pushed ?? null;
  }

  private *searchDirectories(file: string): Generator<string> {
    if (this.options.compileCommandsDir) {
      yield this.options.compileCommandsDir;
      return;
    }
    const paths = this.options.style === 'win32' ? path.win32 : path.posix;
    let directory = paths.dirname(file);
    for (;;) {
      yield directory;
      const parent = paths.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }

  private databaseIn(directory: string): Database | null {
    const cached = this.databases.get(directory);
    const now = Date.now();
    if (cached && now - cached.checkedAt < RECHECK_INTERVAL_MS) return cached.database;
    const stamp = this.candidateFiles(directory)
      .map((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? '-')
      .join(',');
    if (cached?.stamp === stamp) {
      cached.checkedAt = now;
      return cached.database;
    }
    const database = this.load(directory);
    this.databases.set(directory, { database, stamp, checkedAt: now });
    return database;
  }

  private candidateFiles(directory: string): string[] {
    const paths = this.options.style === 'win32' ? path.win32 : path.posix;
    return [
      paths.join(directory, 'compile_commands.json'),
      paths.join(directory, 'build', 'compile_commands.json'),
      paths.join(directory, 'compile_flags.txt'),
    ];
  }

  private load(directory: string): Database | null {
    const [json, buildJson, flagsFile] = this.candidateFiles(directory) as [string, string, string];
    for (const file of [json, buildJson]) {
      const entries = readJson(file);
      if (entries) {
        return new Database(
          { kind: 'compile_commands.json', path: file },
          entries.map((entry) => ({
            directory: entry.directory,
            file: entry.file,
            arguments: entry.arguments ?? splitCommandLine(entry.command ?? '', this.options.style),
          })),
          this.options.style,
        );
      }
    }
    if (fs.existsSync(flagsFile)) {
      const flags = fs
        .readFileSync(flagsFile, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return new FlagsFileDatabase(flagsFile, directory, flags, this.options.style);
    }
    return null;
  }
}

/** compile_flags.txt: one command, for every file under its directory. */
class FlagsFileDatabase extends Database {
  private readonly directory: string;
  private readonly flags: readonly string[];

  constructor(flagsFile: string, directory: string, flags: readonly string[], style: PathStyle) {
    super({ kind: 'compile_flags.txt', path: flagsFile }, [], style);
    this.directory = directory;
    this.flags = flags;
  }

  override lookup(file: string): FoundCommand {
    const compiler = languageOfFile(file) === 'c' ? 'cc' : 'c++';
    return {
      command: { directory: this.directory, file, arguments: [compiler, ...this.flags, file] },
      origin: this.origin,
      borrowedFrom: null,
    };
  }
}

function readJson(file: string): JsonEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as JsonEntry[]) : null;
  } catch {
    return null;
  }
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function stem(file: string, paths: path.PlatformPath): string {
  return paths.basename(file, paths.extname(file)).toLowerCase();
}
