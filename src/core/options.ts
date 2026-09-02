// Compile options as chosen in the UI, and the clang flags they mean.
//
// This used to build a full argv per pass (a layout dump, a probe TU, an AST
// dump), each needing the same target, standard and header paths spelled
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

/**
 * The ABI Hylo lays types out for.
 *
 * The compiler describes exactly one so far, so this is a name rather than a
 * choice: there is no triple to pick and the selector is hidden for Hylo.
 */
export const HYLO_TRIPLE = 'hylo';

/**
 * Was a Hylo module built into this site?
 *
 * `vite.config.ts` defines this from whether `npm run hylo:fetch` found a
 * release to serve. Offering the language without one is a button that fails
 * when pressed, so the UI shows it as having no compiler here instead.
 */
export const HYLO_AVAILABLE: boolean =
  typeof __HYLO_AVAILABLE__ === 'boolean' ? __HYLO_AVAILABLE__ : false;

/** Hylo has no standards to choose between; its compiler has had one release. */
export function standardsFor(lang: Language): readonly string[] {
  return lang === 'c++' ? CXX_STANDARDS : lang === 'hylo' ? [] : C_STANDARDS;
}

/** The standard a language starts on: the newest of each, and none for Hylo. */
export function defaultStdFor(lang: Language): string {
  return lang === 'c++' ? DEFAULT_CXX_STD : lang === 'hylo' ? '' : DEFAULT_C_STD;
}

// Flags that make sense for a layout query. Anything else typed into "extra
// flags" (or restored from a URL) is dropped: -o, -###, -E and -x change what
// the compiler is being asked to do rather than how it lays records out.
//
// The target is not among them, deliberately. It is a field of the request and
// the UI shows which one is selected; a `-target` in the flag box would change
// what is actually being laid out while the selector went on claiming
// otherwise, and a shared link can put anything in that box.
const ALLOWED_FLAG_RE =
  /^(?:-f(?!syntax-only$)[A-Za-z0-9=+_.-]+|-m[A-Za-z0-9=+_.-]+|-W[A-Za-z0-9=+_.-]*|-std=[A-Za-z0-9+.:]+|-D[A-Za-z_][A-Za-z0-9_]*(?:=.*)?|-U[A-Za-z_][A-Za-z0-9_]*|-isystem\/[A-Za-z0-9_.+/-]+|-I\/[A-Za-z0-9_.+/-]+|-O[0-3sz]?|-w|-pedantic(?:-errors)?|-ansi|-nostdinc(?:\+\+)?)$/;
/**
 * Flags that take their value as the next token. The value must never itself
 * look like a flag: `-include -o` would otherwise be accepted as a pair and
 * put a bare `-o` through, where reasoning about which tokens are flags breaks
 * down. Every value pattern below therefore pins its first character.
 */
const TAKES_ARG = new Set(['-Xclang', '-include', '-D', '-U', '-I', '-isystem']);
/**
 * `-Xclang` hands the next token straight to the frontend, where the flags that
 * select an *action* live: `-ast-dump`, `-emit-obj`, `-E`, `-analyze`… The
 * module runs its own action and ignores those, but "harmless today" is not a
 * reason to pass a shared link's arbitrary token to a compiler.
 *
 * Frontend *feature* flags all begin with `-f`, so that is the rule: an
 * allowlist, like every other entry here, rather than a list of the actions we
 * happened to think of. It still admits the ones worth reaching for:
 * `-fms-layout-compatibility=…`, `-fnew-alignment=…`.
 */
const XCLANG_ARG_RE = /^-f[A-Za-z0-9=+_.-]*$/;
const PATH_ARG_RE = /^[A-Za-z0-9_./+][A-Za-z0-9_.+/-]*$/;

/**
 * May this flag be passed to the compiler?
 *
 * An allowlist, not a denylist: a shared link can put anything in the flag box,
 * and the ones worth refusing are the ones nobody thought to list. A flag that
 * takes its value as a separate token is not decided here — see
 * `splitExtraFlags`, which is the only thing that can see the pair.
 */
export function isAllowedFlag(flag: string): boolean {
  return ALLOWED_FLAG_RE.test(flag);
}

/**
 * Splits free-form flag text into the accepted tokens and the refused ones.
 *
 * - Total: any text splits, including the empty string (two empty lists).
 * - Every token appears in exactly one of the two lists, in the order written,
 *   so the caller can show a reader precisely what was dropped.
 * - A flag whose value is the next token is judged as a pair and lands whole in
 *   one list or the other: a value that itself looks like a flag is refused
 *   with it, since `-include -o` would otherwise put a bare `-o` through.
 */
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
 *
 * Hylo takes none of them: they name clang's own knobs, and a `-fpack-struct`
 * left over from a C session must not follow the user into a language where it
 * means nothing.
 */
export function buildFlags(opts: CompileOptions): string[] {
  if (opts.lang === 'hylo') return [];
  const flags: string[] = ['-Wno-unused'];
  if (opts.pack) flags.push('-fpack-struct=' + opts.pack);
  if (opts.msBitfields) flags.push('-mms-bitfields');
  if (opts.shortEnums) flags.push('-fshort-enums');
  if (opts.shortWchar) flags.push('-fshort-wchar');
  if (opts.warnPadded) flags.push('-Wpadded');
  flags.push(...splitExtraFlags(opts.extraFlags)[0]);
  return flags;
}
