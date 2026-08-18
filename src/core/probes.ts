// Everything we need to know about sizes and alignments is asked from clang by
// compiling tiny probe structs and reading their layout dump:
//
//   struct __abix_s_ptr { void *v; };                          // scalar table
//   struct __abix_pN { __typeof__(((struct S*)0)->f) v; };     // one per field
//   struct __abix_h  { <spelling> v; };                        // on-demand (hover)
//
// sizeof(struct { T v; }) == sizeof(T) and its alignment is alignof(T), so no
// type-string interpretation happens on our side.

import type { ProbeResult, RecordLayout } from './types';
import { isAnonymousRecord, isInternalRecord } from './layout-parser';
import { escapeRegExp } from './diagnostics';

/** Static probes compiled as a second TU next to the user's code. */
export const STATIC_PROBE_SOURCE = `
struct __abix_s_ptr { void *v; };
struct __abix_s_fnptr { void (*v)(void); };
struct __abix_s_char { char v; };
struct __abix_s_int { int v; };
struct __abix_s_long { long v; };
`;

export interface ScalarInfo {
  size: number;
  align: number;
}
export type ScalarTable = Map<string, ScalarInfo>;

/** Extract the scalar table from parsed `__abix_s_*` probe records. */
export function buildScalarTable(records: RecordLayout[]): ScalarTable {
  const table: ScalarTable = new Map();
  for (const rec of records) {
    const m = /^__abix_s_([a-z0-9]+)$/.exec(rec.name);
    if (m) table.set(m[1]!, { size: rec.sizeBytes, align: rec.align });
  }
  return table;
}

// ---------------------------------------------------------------- index --

/** Record-name variants -> record (so `struct Foo`, `Foo`, `ns::Foo` all resolve). */
export type RecordIndex = Map<string, RecordLayout>;

const RECORD_KW_RE = /^(?:struct|class|union|__interface|enum)\s+/;

function anonKey(name: string): string {
  return name.replace(/\((?:anonymous|unnamed)(?: [a-z]+)? at ([^)]*)\)/g, '(anon at $1)');
}

export function buildRecordIndex(records: RecordLayout[]): RecordIndex {
  const index: RecordIndex = new Map();
  for (const rec of records) {
    index.set(rec.name, rec);
    index.set(anonKey(rec.name), rec);
    index.set(`${rec.kind} ${rec.name}`, rec);
  }
  return index;
}

/** Look a type spelling (as printed in a layout dump) up in the record index. */
export function findRecord(type: string, index: RecordIndex): RecordLayout | undefined {
  const t = type.trim().replace(/^(?:const|volatile)\s+/, '');
  const bare = t.replace(RECORD_KW_RE, '');
  return index.get(bare) ?? index.get(anonKey(bare)) ?? index.get(t);
}

// --------------------------------------------------------- field probes --

/**
 * Identity of a member measurement: the spellable record it is reached from and
 * the access path inside it (e.g. "pt.x" for a field of a nested member).
 */
export function memberKey(record: RecordLayout, accessPath: string): string {
  return record.kind + ' ' + record.name + ' ' + accessPath;
}

/** Measured member size/align by memberKey. */
export type MemberSizes = Map<string, ProbeResult>;

export interface ProbeSpec {
  index: number;
  /** memberKey (field probes) or the raw type spelling (spelling probes). */
  key: string;
  /**
   * Candidate member declarations for `struct __abix_pN { <decl> };`, tried in
   * order (e.g. `struct X` first, then plain `X` for C typedef'd anonymous
   * structs / C++ names).
   */
  decls: string[];
  /** Which candidate is currently in use. */
  attempt: number;
}

/**
 * How clang prints a record living in an anonymous namespace; such a record
 * is spellable in its own TU by dropping that (unnameable) prefix.
 */
const ANON_NAMESPACE_RE = /\(anonymous namespace\)::/g;

/** Can this record be named in an expression cast like `((struct X*)0)`? */
export function isSpellableRecord(rec: RecordLayout): boolean {
  return (
    !isInternalRecord(rec) &&
    !isAnonymousRecord(rec) &&
    !/\((?:anonymous|unnamed|lambda)/.test(rec.name.replace(ANON_NAMESPACE_RE, ''))
  );
}

/** Spellings that may name the record in an expression, most specific first. */
function recordSpellings(rec: RecordLayout): string[] {
  const name = rec.name.replace(ANON_NAMESPACE_RE, '');
  return [...new Set([`${rec.kind} ${name}`, name])];
}

/**
 * Field probes for every member reachable from every spellable record, by
 * access path: direct fields, fields of nested record-typed members
 * (`pt.x`), fields injected by anonymous struct/union members, and members
 * of bases whose own record cannot be spelled. Bases that can be spelled are
 * measured through their own record (see model.ts).
 */
export function buildFieldProbes(records: RecordLayout[], recordIndex: RecordIndex): ProbeSpec[] {
  const specs: ProbeSpec[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (isInternalRecord(rec)) continue;
    // Records that cannot be named at file scope (typedef'd anonymous structs,
    // function-local structs) get only the type-spelling probes below.
    const spellings = isSpellableRecord(rec) ? recordSpellings(rec) : [];
    const visit = (rows: RecordLayout['rows'], prefix: string) => {
      for (const row of rows) {
        if (row.rowKind === 'special') continue;
        if (row.rowKind !== 'field') {
          const baseRec = row.type ? findRecord(row.type, recordIndex) : undefined;
          if (!baseRec || !isSpellableRecord(baseRec)) visit(row.children, prefix);
          continue;
        }
        if (!row.name) {
          visit(row.children, prefix); // anonymous member: fields injected into this scope
          continue;
        }
        const path = prefix + row.name;
        if (row.isBitfield) continue; // width comes from the dump
        const key = memberKey(rec, path);
        if (seen.has(key)) {
          if (row.children.length) visit(row.children, path + '.');
          continue;
        }
        seen.add(key);
        // Candidate ways to name the record; clang accepts whichever is valid
        // (elaborated `struct X`, or a bare typedef/C++ name). `__typeof__` of
        // a member access yields the *referent* type of a reference member, so
        // references are measured through their address (a pointer) instead.
        const isRef = /&&?\s*$/.test(row.type ?? '');
        // `__typeof__` gives the member's *type*; a per-member `_Alignas`/`alignas`
        // lives on the declaration and is read from the AST (AlignedAttr) instead.
        const decls = spellings.map((sp) =>
          isRef ? `__typeof__(&((${sp}*)0)->${path}) v;` : `__typeof__(((${sp}*)0)->${path}) v;`,
        );
        // Last resort for records that cannot be named at file scope (local
        // classes, an unclosed namespace while typing): the type spelling as
        // printed in the dump, which is valid for builtins/pointers/arrays.
        if (row.type && !isRef && !/\((?:anonymous|unnamed|lambda)/.test(row.type)) {
          decls.push(`__typeof__(${row.type}) v;`);
        }
        specs.push({ index: specs.length, key, decls, attempt: 0 });
        if (row.children.length) visit(row.children, path + '.');
      }
    };
    visit(rec.rows, '');
  }
  return specs;
}

/**
 * A single on-demand probe for an arbitrary type spelling. `__typeof__` accepts
 * a type-name, so clang does the declarator work (arrays, function pointers…).
 */
export function buildSpellingProbe(spelling: string): ProbeSpec {
  return { index: 0, key: spelling, decls: [`__typeof__(${spelling}) v;`], attempt: 0 };
}

export interface ProbeSource {
  source: string;
  /** 1-based line number of the first probe struct. */
  firstProbeLine: number;
  probes: ProbeSpec[];
}

/**
 * Append one probe struct per line to the user's source. Packing state left
 * open at the end of the user's TU (an unclosed `#pragma pack(1)`) must not
 * leak into the probes, or every measured alignment would be wrong; `#pragma
 * pack()` restores the default while keeping `-fpack-struct` in effect.
 */
export function buildProbeSource(userSource: string, probes: ProbeSpec[]): ProbeSource {
  const base = (userSource.endsWith('\n') ? userSource : userSource + '\n') + '#pragma pack()\n';
  const firstProbeLine = base.split('\n').length; // '' after the final \n counts as the next line
  const lines = probes.map(
    (p) => `struct __abix_p${p.index} { ${p.decls[p.attempt] ?? p.decls[0]} };`,
  );
  return { source: base + lines.join('\n') + '\n', firstProbeLine, probes };
}

/** Probes whose line produced an error (dropped, the rest retried). */
export function failingProbeIndices(
  stderr: string,
  fileName: string,
  firstProbeLine: number,
  probes: ProbeSpec[],
): Set<number> {
  const bad = new Set<number>();
  const esc = escapeRegExp(fileName);
  const re = new RegExp(
    `(?:^|\\n)(?:[^\\n]*?)${esc}:([0-9]+):[0-9]+:(?:\\{[^}]*\\}:)?\\s*(?:fatal )?error`,
    'g',
  );
  for (const m of stderr.matchAll(re)) {
    const idx = Number(m[1]) - firstProbeLine;
    const p = probes[idx];
    if (p) bad.add(p.index);
  }
  return bad;
}

/**
 * Next round of probes after a failed pass: failed probes advance to their next
 * candidate spelling; probes with no candidates left are dropped. Indices are
 * renumbered.
 */
export function nextProbeRound(
  probes: ProbeSpec[],
  failed: Set<number>,
  measured: Map<string, unknown>,
): ProbeSpec[] {
  const next: ProbeSpec[] = [];
  for (const p of probes) {
    if (measured.has(p.key)) continue;
    const attempt = failed.has(p.index) ? p.attempt + 1 : p.attempt;
    if (attempt >= p.decls.length) continue;
    next.push({ ...p, attempt, index: next.length });
  }
  return next;
}

/** Read `__abix_pN` records back into key -> { bits, align }. */
export function readProbeResults(
  records: RecordLayout[],
  probes: ProbeSpec[],
): Map<string, ProbeResult> {
  const byName = new Map(probes.map((p) => [`__abix_p${p.index}`, p]));
  const out = new Map<string, ProbeResult>();
  for (const rec of records) {
    const p = byName.get(rec.name);
    if (p) out.set(p.key, { bits: rec.sizeBytes * 8, align: rec.align });
  }
  return out;
}
