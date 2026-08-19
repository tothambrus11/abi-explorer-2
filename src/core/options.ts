// Compile options as chosen in the UI, and the clang flags they mean.
//
// This used to build a full argv per pass — a layout dump, a probe TU, an AST
// dump — each needing the same target, standard and header paths spelled
// consistently or the answers would not line up. A query takes the target and
// the language as fields, and header search is the module's own business, so
// what is left here is the handful of flags that change layout.

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
  warnPadded: false,
  extraFlags: '',
};

// Hylo is a placeholder for now: no standards, no compiler backend yet.
export function standardsFor(lang: Language): readonly string[] {
  return lang === 'c++' ? CXX_STANDARDS : lang === 'hylo' ? [] : C_STANDARDS;
}

export function defaultStdFor(lang: Language): string {
  return lang === 'c++' ? DEFAULT_CXX_STD : lang === 'hylo' ? '' : DEFAULT_C_STD;
}

// Flags that make sense for a layout query. Anything else typed into "extra
// flags" (or restored from a URL) is dropped: -o / -### / -x would wedge the
// query, and driver modes like -E produce no layouts.
//
// The target is not among them, deliberately. It is a field of the request and
// the UI shows which one is selected; a `-target` in the flag box would change
// what is actually being laid out while the selector went on claiming
// otherwise — and a shared link can put anything in that box.
const ALLOWED_FLAG_RE =
  /^(?:-f(?!syntax-only$)[A-Za-z0-9=+_.-]+|-m[A-Za-z0-9=+_.-]+|-W[A-Za-z0-9=+_.-]*|-std=[A-Za-z0-9+.:]+|-D[A-Za-z_][A-Za-z0-9_]*(?:=.*)?|-U[A-Za-z_][A-Za-z0-9_]*|-isystem\/[A-Za-z0-9_.+/-]+|-I\/[A-Za-z0-9_.+/-]+|-O[0-3sz]?|-w|-pedantic(?:-errors)?|-ansi|-nostdinc(?:\+\+)?)$/;
/**
 * Flags that take their value as the next token. The value must never itself
 * look like a flag: `-target -o` would otherwise be accepted as a pair and put
 * a bare `-o` into argv, where reasoning about which tokens are flags breaks
 * down. Every value pattern below therefore pins its first character.
 */
const TAKES_ARG = new Set(['-Xclang', '-include', '-D', '-U', '-I', '-isystem']);
/**
 * `-Xclang` hands the next token straight to the frontend, where the flags that
 * select an *action* live — `-ast-dump`, `-ast-print`, `-ast-list`,
 * `-dump-tokens`, `-emit-obj`, `-E`, `-S`, `-analyze`… Any one of them replaces
 * the record-layout dump this whole app reads, so a shared link carrying one
 * would silently produce no layouts at all.
 *
 * Frontend *feature* flags all begin with `-f`, so that is the rule: an
 * allowlist, like every other entry here, rather than a list of the actions we
 * happened to think of. It still admits the layout-related cc1 flags worth
 * reaching for — `-fdump-record-layouts-simple`, `-fdump-record-layouts-canonical`,
 * `-fdump-vtable-layouts`, `-fno-access-control`, `-fms-layout-compatibility=…`.
 */
const XCLANG_ARG_RE = /^-f[A-Za-z0-9=+_.-]*$/;
const PATH_ARG_RE = /^[A-Za-z0-9_./+][A-Za-z0-9_.+/-]*$/;

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
          ? XCLANG_ARG_RE.test(next)
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

/**
 * The clang flags these options mean. Target, language and standard are fields
 * of the request, not flags, so they are not here.
 */
export function buildFlags(opts: CompileOptions): string[] {
  const flags: string[] = ['-Wno-unused'];
  if (opts.pack) flags.push('-fpack-struct=' + opts.pack);
  if (opts.msBitfields) flags.push('-mms-bitfields');
  if (opts.shortEnums) flags.push('-fshort-enums');
  if (opts.shortWchar) flags.push('-fshort-wchar');
  if (opts.warnPadded) flags.push('-Wpadded');
  flags.push(...splitExtraFlags(opts.extraFlags)[0]);
  return flags;
}
