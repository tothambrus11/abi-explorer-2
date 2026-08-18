// Compile options as chosen in the UI, and their translation to clang argv.
// Building argv from a spec (instead of editing arrays) keeps every pass —
// layout dump, field probes, AST locations — consistent.

import {
  C_STANDARDS,
  CXX_STANDARDS,
  DEFAULT_C_STD,
  DEFAULT_CXX_STD,
  DEFAULT_TRIPLE,
} from './targets';

export type Language = 'c' | 'c++' | 'hylo';

export interface CompileOptions {
  lang: Language;
  std: string;
  triple: string;
  /** -fpack-struct=N ('' = default) */
  pack: '' | '1' | '2' | '4' | '8' | '16';
  msBitfields: boolean;
  shortEnums: boolean;
  shortWchar: boolean;
  /** Map wasi-libc headers in for non-WASI targets. */
  wasiLibc: boolean;
  warnPadded: boolean;
  /** Free-form extra flags (validated by isAllowedFlag). */
  extraFlags: string;
}

export const DEFAULT_OPTIONS: CompileOptions = {
  lang: 'c',
  std: DEFAULT_C_STD,
  triple: DEFAULT_TRIPLE,
  pack: '',
  msBitfields: false,
  shortEnums: false,
  shortWchar: false,
  wasiLibc: false,
  warnPadded: false,
  extraFlags: '',
};

/** Which frontend action a pass wants. */
export type PassKind = 'layout' | 'ast-json';

export interface PassSpec {
  kind: PassKind;
  files: string[];
  /** For 'ast-json': `-ast-dump-filter` value. */
  astFilter?: string;
  /** Measurement-only pass: may look at private/protected members (-fno-access-control). */
  measure?: boolean;
}

// Hylo is a placeholder for now: no standards, no compiler backend yet.
export function standardsFor(lang: Language): readonly string[] {
  return lang === 'c++' ? CXX_STANDARDS : lang === 'hylo' ? [] : C_STANDARDS;
}

export function defaultStdFor(lang: Language): string {
  return lang === 'c++' ? DEFAULT_CXX_STD : lang === 'hylo' ? '' : DEFAULT_C_STD;
}

export function sourceExtension(lang: Language): string {
  return lang === 'c++' ? 'cc' : lang === 'hylo' ? 'hylo' : 'c';
}

export function driverFor(lang: Language): 'clang' | 'clang++' {
  return lang === 'c++' ? 'clang++' : 'clang';
}

// Flags that make sense for a layout query. Anything else typed into "extra
// flags" (or restored from a URL) is dropped: e.g. -o / -### / -x could wedge
// the pipeline, and driver modes like -E produce no layouts.
const ALLOWED_FLAG_RE =
  /^(?:-f(?!syntax-only$)[A-Za-z0-9=+_.-]+|-m[A-Za-z0-9=+_.-]+|-W[A-Za-z0-9=+_.-]*|-std=[A-Za-z0-9+.:]+|-D[A-Za-z_][A-Za-z0-9_]*(?:=.*)?|-U[A-Za-z_][A-Za-z0-9_]*|-isystem\/[A-Za-z0-9_.+/-]+|-I\/[A-Za-z0-9_.+/-]+|-O[0-3sz]?|--?target=[A-Za-z0-9_.-]+|-w|-pedantic(?:-errors)?|-ansi|-nostdinc(?:\+\+)?)$/;
/** Flags that take their value as the next token. */
const TAKES_ARG = new Set(['-Xclang', '-include', '-D', '-U', '-I', '-isystem', '-target']);
const XCLANG_ARG_RE = /^-[A-Za-z][A-Za-z0-9=+_.-]*$/; // a cc1 flag, not a file/-o
const PATH_ARG_RE = /^[A-Za-z0-9_.+/-]+$/;

export function isAllowedFlag(flag: string): boolean {
  return ALLOWED_FLAG_RE.test(flag);
}

/** Split and filter free-form extra flags. Returns [accepted, rejected]. */
export function splitExtraFlags(text: string): [string[], string[]] {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const toks = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const f = toks[i]!;
    const next = toks[i + 1];
    if (TAKES_ARG.has(f) && next !== undefined) {
      const ok =
        f === '-Xclang'
          ? XCLANG_ARG_RE.test(next) && !/^-(?:o|ast-print|E|S|emit)/.test(next)
          : f === '-target'
            ? /^[A-Za-z0-9_.-]+$/.test(next)
            : f === '-D' || f === '-U'
              ? /^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(next)
              : PATH_ARG_RE.test(next);
      (ok ? accepted : rejected).push(f, next);
      i++;
      continue;
    }
    (isAllowedFlag(f) ? accepted : rejected).push(f);
  }
  return [accepted, rejected];
}

/** Translate options + pass into clang argv (without argv0). */
export function buildArgv(opts: CompileOptions, pass: PassSpec): string[] {
  const isCxx = opts.lang === 'c++';
  const args = [
    '--target=' + opts.triple,
    '-x' + (isCxx ? 'c++' : 'c'),
    ...(opts.std ? ['-std=' + opts.std] : []),
    '-fsyntax-only',
  ];
  if (pass.kind === 'layout') args.push('-Xclang', '-fdump-record-layouts-complete');
  else {
    args.push('-Xclang', '-ast-dump=json', '-Xclang', '-ast-dump-filter=' + (pass.astFilter ?? ''));
  }
  // Colored diagnostics from clang itself (parsers strip the escapes) and
  // machine-readable source ranges: `file:line:col:{l:c-l:c}: error: …`.
  args.push(
    '-Wno-unused',
    '-fcolor-diagnostics',
    '-fansi-escape-codes',
    '-fdiagnostics-print-source-range-info',
  );
  if (isCxx) args.push('-isystem/usr/include/c++/v1');
  if (opts.wasiLibc) args.push('-isystem/usr/include/wasm32-wasip1');
  if (opts.pack) args.push('-fpack-struct=' + opts.pack);
  if (opts.msBitfields) args.push('-mms-bitfields');
  if (opts.shortEnums) args.push('-fshort-enums');
  if (opts.shortWchar) args.push('-fshort-wchar');
  if (opts.warnPadded) args.push('-Wpadded');
  args.push(...splitExtraFlags(opts.extraFlags)[0]);
  if (pass.measure) {
    // Probe TUs deliberately contain failing lines; clang's default error limit
    // (~20) would stop parsing and skip both the errors *and* the layout dumps
    // for later probes, leaving those members unmeasured. Report them all.
    args.push('-Xclang', '-fno-access-control', '-ferror-limit=0');
  }
  args.push(...pass.files);
  return args;
}
