// What the user's compiler would search and target, asked of the compiler.
//
// The engine is not the user's compiler, so it cannot know where GCC keeps
// libstdc++, which SDK Xcode selected, or which Visual Studio is installed.
// This asks the real compiler, the way clangd's `--query-driver` does:
// `cc -E -v -x c++ -` prints the target and the include search list. One
// directory in that list is the compiler's own builtin headers (`stddef.h`,
// intrinsics); it is marked, because those must come from the engine's clang.
//
// MSVC prints nothing of the sort, so for `cl.exe` the version and architecture
// come from its banner and the include list from `INCLUDE` (a developer prompt
// sets it) or from the Visual Studio and Windows SDK folders next to it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Language, PreparedCommand } from './commandLine.ts';

export interface SystemInclude {
  path: string;
  /**
   * `framework` is a macOS framework directory, searched with `-iframework`.
   * `builtin` marks where the compiler's own builtin headers were: the engine
   * substitutes its clang's there.
   */
  kind: 'directory' | 'framework' | 'builtin';
}

export interface Toolchain {
  triple: string;
  systemIncludes: SystemInclude[];
  /** `19.44` for cl.exe, which sets `_MSC_VER`; null otherwise. */
  msvcVersion: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type Exec = (program: string, args: readonly string[]) => Promise<ExecResult>;

export interface ProbePolicy {
  /**
   * Folders whose contents the project controls: the workspace, and the
   * directories its compile commands came from. Compilers in them are not run
   * unless allowed.
   */
  projectFolders: readonly string[];
  /** Globs of compilers that may be run anyway, like clangd's `--query-driver`. */
  allowedCompilers: readonly string[];
}

export class ProbeRefusedError extends Error {}

/** Options that change where a GNU-style compiler searches, or for what. */
const SEARCH_AFFECTING = [
  /^--target=/,
  /^-target$/,
  /^--sysroot/,
  /^-isysroot/,
  /^-stdlib=/,
  /^-m(32|64|x32)$/,
  /^-nostdinc/,
  /^--gcc-toolchain=/,
  /^--gcc-install-dir=/,
];
const TAKES_VALUE = new Set(['-target', '-isysroot', '--sysroot']);

export class ToolchainProber {
  private readonly cache = new Map<string, Promise<Toolchain>>();
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(
    exec: Exec = runProgram,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.exec = exec;
    this.env = env;
    this.platform = platform;
  }

  probe(command: PreparedCommand, language: Language, policy: ProbePolicy): Promise<Toolchain> {
    const compiler = this.resolveCompiler(command.compiler);
    if (!isProbeAllowed(compiler, policy, this.platform)) {
      return Promise.reject(
        new ProbeRefusedError(
          `${compiler} is not run to find its headers unless allowed in the allowedCompilers setting ` +
            '(it is inside the project, or is not named like a compiler)',
        ),
      );
    }
    // clang-cl in GNU mode still targets MSVC, and finds Visual Studio's headers itself.
    const isCl = command.driver === 'msvc' && !/clang/i.test(path.win32.basename(compiler));
    const args = isCl
      ? []
      : [
          ...(command.driver === 'msvc' ? ['--driver-mode=gcc'] : []),
          ...searchArguments(command.flags, language),
        ];
    const key = JSON.stringify([compiler, args]);
    let probe = this.cache.get(key);
    if (!probe) {
      probe = isCl ? this.probeCl(compiler) : this.probeGnu(compiler, args);
      // A failed probe is not remembered: the compiler may be installed later.
      probe.catch(() => this.cache.delete(key));
      this.cache.set(key, probe);
    }
    return probe;
  }

  private async probeGnu(compiler: string, args: string[]): Promise<Toolchain> {
    const [verbose, builtin] = await Promise.all([
      this.exec(compiler, [...args, '-E', '-v', '-']),
      this.exec(compiler, [...args, '-print-file-name=include']),
    ]);
    const parsed = parseVerboseOutput(verbose.stderr);
    if (!parsed.triple) throw new Error(`${compiler} -v printed no target`);
    const builtinDirectory = path.resolve(builtin.stdout.trim());
    return {
      triple: withArchitectureFlags(parsed.triple, args),
      systemIncludes: parsed.includes.map((include) =>
        path.resolve(include.path) === builtinDirectory
          ? { ...include, kind: 'builtin' as const }
          : include,
      ),
      msvcVersion: null,
    };
  }

  /** cl.exe: its version and target from the banner, its headers from INCLUDE or the Visual Studio around it. */
  private async probeCl(compiler: string): Promise<Toolchain> {
    const banner = await this.exec(compiler, []);
    const { triple, version } = parseClBanner(banner.stderr + banner.stdout);
    const includes = this.env.INCLUDE
      ? this.env.INCLUDE.split(';').filter(Boolean)
      : await this.visualStudioIncludes(compiler);
    return {
      triple,
      systemIncludes: includes.map((include) => ({ path: include, kind: 'directory' as const })),
      msvcVersion: version,
    };
  }

  /** `…\VC\Tools\MSVC\<ver>\bin\Hostx64\x64\cl.exe` → its include folders and the newest Windows SDK's. */
  private async visualStudioIncludes(cl: string): Promise<string[]> {
    const tools = path.win32.resolve(path.win32.dirname(cl), '..', '..', '..');
    const includes = [
      path.win32.join(tools, 'include'),
      path.win32.join(tools, 'atlmfc', 'include'),
    ];
    const sdkRoot = await this.windowsSdkRoot();
    if (sdkRoot) {
      const includeRoot = path.win32.join(sdkRoot, 'Include');
      const version = newestVersion(safeReaddir(includeRoot));
      if (version) {
        for (const part of ['ucrt', 'shared', 'um', 'winrt', 'cppwinrt']) {
          includes.push(path.win32.join(includeRoot, version, part));
        }
      }
    }
    return includes.filter((directory) => fs.existsSync(directory));
  }

  private async windowsSdkRoot(): Promise<string | null> {
    for (const key of [
      'HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots',
    ]) {
      const result = await this.exec('reg', ['query', key, '/v', 'KitsRoot10']).catch(() => null);
      const root = result && /KitsRoot10\s+REG_SZ\s+(.+)/.exec(result.stdout)?.[1]?.trim();
      if (root) return root;
    }
    return null;
  }

  /** A bare `g++` as the program PATH would run, so the policy can see where it lives. */
  private resolveCompiler(compiler: string): string {
    if (compiler.includes('/') || compiler.includes('\\')) return compiler;
    const extensions = this.platform === 'win32' ? ['.exe', ''] : [''];
    const separator = this.platform === 'win32' ? ';' : ':';
    for (const directory of (this.env.PATH ?? '').split(separator).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = path.join(directory, compiler + extension);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return compiler;
  }
}

export function parseVerboseOutput(stderr: string): {
  triple: string | null;
  includes: SystemInclude[];
} {
  const lines = stderr.split(/\r?\n/);
  const triple = lines.map((line) => /^Target:\s*(\S+)/.exec(line)?.[1]).find(Boolean) ?? null;
  const start = lines.findIndex((line) => line.startsWith('#include <...> search starts here:'));
  const end = lines.findIndex((line, i) => i > start && line.startsWith('End of search list.'));
  const includes =
    start < 0 || end < 0
      ? []
      : lines.slice(start + 1, end).map((line) => {
          const text = line.trim();
          return text.endsWith(' (framework directory)')
            ? { path: text.slice(0, -' (framework directory)'.length), kind: 'framework' as const }
            : { path: text, kind: 'directory' as const };
        });
  return { triple, includes };
}

const CL_ARCHITECTURES: Readonly<Record<string, string>> = {
  x64: 'x86_64-pc-windows-msvc',
  x86: 'i686-pc-windows-msvc',
  ARM64: 'aarch64-pc-windows-msvc',
  ARM: 'thumbv7-pc-windows-msvc',
};

/** "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207.1 for x64" */
export function parseClBanner(banner: string): { triple: string; version: string | null } {
  const match = /Version (\d+)\.(\d+)\.\S* for (\S+)/.exec(banner);
  return {
    triple: (match && CL_ARCHITECTURES[match[3]!]) ?? 'x86_64-pc-windows-msvc',
    version: match ? `${match[1]}.${match[2]}` : null,
  };
}

/**
 * GCC reports its configured target even under `-m32`, so the triple is
 * adjusted the way clang's driver would adjust it.
 */
export function withArchitectureFlags(triple: string, args: readonly string[]): string {
  const [arch = '', ...rest] = triple.split('-');
  const last = [...args].reverse().find((arg) => ['-m32', '-m64', '-mx32'].includes(arg));
  const is86 = /^(x86_64|i[3-6]86)$/.test(arch);
  if (!last || !is86) return triple;
  if (last === '-m32') return ['i386', ...rest].join('-');
  if (last === '-m64') return ['x86_64', ...rest].join('-');
  const environment = rest.at(-1) === 'gnu' ? [...rest.slice(0, -1), 'gnux32'] : rest;
  return ['x86_64', ...environment].join('-');
}

export function searchArguments(flags: readonly string[], language: Language): string[] {
  const args = ['-x', language];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (!SEARCH_AFFECTING.some((pattern) => pattern.test(flag))) continue;
    args.push(flag);
    if (TAKES_VALUE.has(flag) && i + 1 < flags.length) args.push(flags[++i]!);
  }
  return args;
}

/**
 * A compile command comes from the project, which may be hostile, so whatever
 * it names is not simply run. A program is probed only when it is named like a
 * compiler (so `python3` with `-x c++` cannot run a script from the project)
 * and lies outside the project, both as written and with symlinks resolved;
 * `allowedCompilers` overrides both checks.
 */
export function isProbeAllowed(
  compiler: string,
  policy: ProbePolicy,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const real = realPath(compiler);
  if (
    policy.allowedCompilers.some((glob) =>
      [compiler, real].some((candidate) => globToRegExp(glob).test(candidate)),
    )
  ) {
    return true;
  }
  const folders = policy.projectFolders.flatMap((folder) => [folder, realPath(folder)]);
  const insideProject = [compiler, real].some((candidate) =>
    folders.some((folder) => {
      const relative = paths.relative(folder, candidate);
      return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
    }),
  );
  return !insideProject && looksLikeCompiler(compiler) && looksLikeCompiler(real);
}

/**
 * `cc`, `g++-13`, `clang++`, `aarch64-linux-gnu-gcc`, `clang-cl.exe`, `cl`:
 * a compiler driver's name, with any target prefix and version suffix.
 */
export function looksLikeCompiler(program: string): boolean {
  const name = path.win32
    .basename(program)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return /^([\w.]+-)*(cc|c\+\+|gcc|g\+\+|clang|clang\+\+|clang-cl|cl|icx|icpx|icx-cl|icc|icpc)(-[\d.]+)?$/.test(
    name,
  );
}

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') source += '[^/\\\\]*';
    else if (c === '?') source += '[^/\\\\]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function newestVersion(names: readonly string[]): string | undefined {
  const parse = (name: string) => name.split('.').map(Number);
  return names
    .filter((name) => /^\d+(\.\d+)*$/.test(name))
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      }
      return 0;
    })[0];
}

function safeReaddir(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

/** Runs a program with empty stdin and a timeout, collecting both streams. */
export function runProgram(program: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => {
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}
