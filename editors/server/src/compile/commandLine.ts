// From a build system's compile command to flags the engine can take.
//
// A compile command is written for a real compiler: it names outputs, makes
// dependency files, may be MSVC's `cl.exe` syntax, and uses paths relative to
// its own directory. The engine wants GNU-style clang flags with absolute paths
// and nothing about outputs. clangd does the same cleanup in its
// `CommandMangler`; this is the subset that matters for parsing declarations.

import path from 'node:path';
import type { CompileCommand } from '@abi-explorer/shared/protocol';
import type { PathStyle } from '@abi-explorer/shared/splitCommandLine';

export type { CompileCommand, PathStyle };

export type Language = 'c' | 'c++';
export type DriverKind = 'gnu' | 'msvc';

export interface PreparedCommand {
  /** The compiler as the command names it: a path, or a name to find on PATH. */
  compiler: string;
  driver: DriverKind;
  /** GNU-style, absolute paths, no inputs or outputs. */
  flags: string[];
  /** Set when the command says (`-x`, `/TP`); otherwise the caller decides from the file. */
  language: Language | null;
}

const WRAPPERS = new Set(['ccache', 'sccache', 'distcc', 'icecc', 'buildcache']);

/** Options whose value is a path: `-I dir` and `-Idir` alike. */
const PATH_OPTIONS = [
  '-I',
  '-isystem',
  '-iquote',
  '-idirafter',
  '-include',
  '-imacros',
  '-isysroot',
  '-iframework',
  '-F',
  '--sysroot',
] as const;

/** GNU options that name outputs or side files; each takes one value. */
const DROPPED_WITH_VALUE = new Set([
  '-o',
  '-MF',
  '-MT',
  '-MQ',
  '-MJ',
  '--serialize-diagnostics',
  '-include-pch',
]);

const DROPPED = new Set(['-c', '-S', '-E', '-M', '-MM', '-MD', '-MMD', '-MP', '-MG', '-pipe']);
const DROPPED_PREFIXES = ['-Werror', '-save-temps', '-fcolor-diagnostics', '-fdiagnostics-color'];

export function prepareCommand(command: CompileCommand, style: PathStyle): PreparedCommand {
  const paths = style === 'win32' ? path.win32 : path.posix;
  const args = [...command.arguments];
  while (args.length > 1 && WRAPPERS.has(programName(args[0]!))) args.shift();
  const compiler = args[0] ?? 'cc';
  const rest = args.slice(1);
  const driver: DriverKind =
    isMsvcDriver(compiler) || rest.includes('--driver-mode=cl') ? 'msvc' : 'gnu';

  const inputFile = paths.resolve(command.directory, command.file);
  const isInput = (arg: string) =>
    !arg.startsWith('-') &&
    !(driver === 'msvc' && arg.startsWith('/')) &&
    paths.resolve(command.directory, arg) === inputFile;

  const translated =
    driver === 'msvc'
      ? translateMsvcFlags(rest.filter((arg) => !isInput(arg)))
      : { flags: stripGnuFlags(rest.filter((arg) => !isInput(arg))), language: null };

  const flags = mapPathOptions(translated.flags, (value) =>
    paths.resolve(command.directory, value),
  );
  return {
    compiler,
    driver,
    flags,
    language: translated.language ?? languageFromXFlag(flags),
  };
}

/** `cl.exe`, `clang-cl`, and versioned names such as Debian's `clang-cl-18`. */
export function isMsvcDriver(program: string): boolean {
  return /^(cl|clang-cl(-[\d.]+)?)$/.test(programName(program));
}

/** `cc`, `g++-13` and `C:\VC\bin\cl.exe` as `cc`, `g++-13` and `cl`. */
export function programName(program: string): string {
  return path.win32
    .basename(program)
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/** The language a file is compiled as when nothing in the command says. */
export function languageOfFile(file: string): Language | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.c') return 'c';
  if (
    [
      '.cc',
      '.cpp',
      '.cxx',
      '.c++',
      '.cp',
      '.hpp',
      '.hh',
      '.hxx',
      '.h++',
      '.ipp',
      '.tpp',
      '.cu',
    ].includes(extension)
  ) {
    return 'c++';
  }
  return null;
}

/**
 * Rewrites the value of every path-taking option, in both its spellings.
 * Used twice: once to make paths absolute, once to move them into the engine's view.
 */
export function mapPathOptions(flags: readonly string[], map: (value: string) => string): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if ((PATH_OPTIONS as readonly string[]).includes(flag) && i + 1 < flags.length) {
      out.push(flag, map(flags[++i]!));
      continue;
    }
    if (flag.startsWith('--sysroot=')) {
      out.push('--sysroot=' + map(flag.slice('--sysroot='.length)));
      continue;
    }
    // Longest first: `-isystem/x` must not be read as `-I` + `system/x`.
    const joined = [...PATH_OPTIONS]
      .sort((a, b) => b.length - a.length)
      .find(
        (option) =>
          option !== '--sysroot' && flag.startsWith(option) && flag.length > option.length,
      );
    out.push(joined ? joined + map(flag.slice(joined.length)) : flag);
  }
  return out;
}

function stripGnuFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (DROPPED_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (DROPPED.has(arg)) continue;
    if (DROPPED_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
    if (arg.startsWith('-o') && arg.length > 2) continue;
    if (arg.startsWith('-MF') || arg.startsWith('-MT') || arg.startsWith('-MQ')) continue;
    out.push(arg);
  }
  return out;
}

function languageFromXFlag(flags: readonly string[]): Language | null {
  let language: Language | null = null;
  for (let i = 0; i < flags.length; i++) {
    const value =
      flags[i] === '-x'
        ? flags[i + 1]
        : flags[i]!.startsWith('-x')
          ? flags[i]!.slice(2)
          : undefined;
    if (value === 'c' || value === 'c-header') language = 'c';
    else if (value === 'c++' || value === 'c++-header') language = 'c++';
  }
  return language;
}

/**
 * MSVC options that change what a declaration means, as GNU-style clang flags.
 *
 * Everything not listed is dropped rather than passed through: an unknown
 * option is an error to clang's GNU driver, and none of the rest (codegen,
 * runtime library, warnings, outputs) changes a record's layout.
 */
export function translateMsvcFlags(args: readonly string[]): {
  flags: string[];
  language: Language | null;
} {
  const flags: string[] = [];
  let language: Language | null = null;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (!raw.startsWith('/') && !raw.startsWith('-')) continue;
    const option = raw.slice(1);
    const valueOf = (prefix: string): string | undefined => {
      if (!option.startsWith(prefix)) return undefined;
      const joined = option.slice(prefix.length);
      return joined !== '' ? joined : args[++i];
    };

    let value: string | undefined;
    if ((value = valueOf('external:I')) !== undefined) flags.push('-isystem', value);
    else if (option.startsWith('external:')) continue;
    else if ((value = valueOf('imsvc')) !== undefined) flags.push('-isystem', value);
    else if ((value = valueOf('FI')) !== undefined) flags.push('-include', value);
    else if (option.startsWith('std:')) {
      const standard = msvcStandard(option.slice(4));
      if (standard) flags.push(`-std=${standard}`);
    } else if (/^Zp\d*$/.test(option)) flags.push(`-fpack-struct=${option.slice(2) || '1'}`);
    else if (/^vd[012]$/.test(option)) flags.push('-Xclang', `-vtordisp-mode=${option.slice(2)}`);
    else if (option === 'vms') flags.push('-Xclang', '-fms-memptr-rep=single');
    else if (option === 'vmm') flags.push('-Xclang', '-fms-memptr-rep=multiple');
    else if (option === 'vmv' || option === 'vmg') flags.push('-Xclang', '-fms-memptr-rep=virtual');
    else if (option === 'J') flags.push('-funsigned-char');
    else if (option === 'Zc:wchar_t-') flags.push('-fno-wchar');
    // clang-cl takes these GNU spellings for the target; they change every layout.
    else if (raw.startsWith('--target=') || raw === '-m32' || raw === '-m64') flags.push(raw);
    else if (option === 'TC') language = 'c';
    else if (option === 'TP') language = 'c++';
    else if ((value = valueOf('I')) !== undefined) flags.push('-I', value);
    else if ((value = valueOf('D')) !== undefined) flags.push('-D' + value.replace('#', '='));
    else if ((value = valueOf('U')) !== undefined) flags.push('-U' + value);
  }
  return { flags, language };
}

/** `/std:` values as `-std=` takes them: `c++latest` is `c++2c`, `c++23preview` is `c++23`. */
function msvcStandard(value: string): string | null {
  const standard = value
    .replace(/preview$/, '')
    .replace(/^c\+\+latest$/, 'c++2c')
    .replace(/^clatest$/, 'c2y');
  return /^(c\+\+|c)\d\w$/.test(standard) ? standard : null;
}
