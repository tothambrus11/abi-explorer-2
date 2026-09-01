// The analysis pipeline: one question, one answer.
//
// What this replaced ran a baseline compile to learn the target's scalar sizes,
// a layout pass, up to four rounds of probe translation units to measure each
// member, and one filtered AST dump per record for source locations: six or
// more full re-parses, because every answer had to be recovered from something
// clang had printed. Then about 2500 lines of JavaScript reconstructed the
// containment those prints had flattened.
//
// Now: one query. Layout, member sizes, source locations, containment, overlap
// and padding arrive together, because they were never separate questions.

import { buildFlags, HYLO_TRIPLE, type CompileOptions, type Language } from '$core/options';
import { fromWire, type WireHeaders, type WireRecord, type WireResponse } from '$core/render';
import type { Diagnostic, RecordLayout, RenderModel, SourceLocation } from '$core/types';

/**
 * What this needs from a backend. Async because the real ones are workers.
 *
 * `lang` is what decides which backend answers, so it is no longer only a
 * spelling of clang's `-x`: see `Backends`.
 */
export interface AbiModule {
  query(request: {
    source: string;
    triple: string;
    lang?: Language;
    std?: string;
    flags?: string[];
  }): Promise<WireResponse>;
  targets(): Promise<string[]>;
  version(): Promise<string>;
}

/** Wrap a synchronous in-process module (tests, Node) as an async one. */
export function fromSyncModule(m: {
  query(request: unknown): WireResponse;
  targets(): string[];
  version(): string;
}): AbiModule {
  return {
    query: (r) => Promise.resolve(m.query(r)),
    targets: () => Promise.resolve(m.targets()),
    version: () => Promise.resolve(m.version()),
  };
}

/** A record, with everything needed to draw it. */
export interface AnalysedRecord {
  key: string;
  record: RecordLayout;
  model: RenderModel;
  /**
   * Worth listing on its own. A nested anonymous record is drawn inside its
   * parent, so it is not; `typedef struct { … } T;` is anonymous too but is a
   * record in its own right, and clang tells the two apart by whether the
   * declaration's context is another record.
   */
  listed: boolean;
}

/** A name the user gave to a type, and what it names. */
export interface TypeName {
  name: string;
  location: SourceLocation | null;
  type: string;
  canonicalType: string;
  sizeBits: number;
  /** Bytes. */
  align: number;
  recordId: number | null;
}

export interface Analysis {
  source: string;
  options: CompileOptions;
  /** Non-zero if the translation unit had errors; records may still be present. */
  code: number;
  /** Records declared in the user's file, in source order. */
  records: AnalysedRecord[];
  /** Every record the response carried, by id, so a reference always resolves. */
  byId: Map<number, AnalysedRecord>;
  byKey: Map<string, AnalysedRecord>;
  /** Type spellings to records: `Foo`, `struct Foo`, `ns::Foo`. */
  byName: Map<string, AnalysedRecord>;
  typedefs: TypeName[];
  diagnostics: Diagnostic[];
  /** As clang would have printed them, ANSI escapes and all. */
  diagnosticsText: string;
  /**
   * Which standard headers answered this query. Worth showing: on a target
   * musl has no tree for, the C declarations are portable ones over this
   * target's own scalar types, and libc++'s locale layer is not available,
   * which is why `<iostream>` resolves on Linux and not on Darwin.
   */
  headers: WireHeaders | null;
}

/** Stable identity for a record within one analysis. */
export function recordKey(r: { kind: string; name: string; dup?: number }): string {
  return r.kind + ' ' + r.name + (r.dup ? `#${r.dup}` : '');
}

export class AbiAnalyzer {
  private readonly cache = new Map<string, Promise<Analysis>>();
  private readonly spellings = new Map<string, Promise<{ bits: number; align: number } | null>>();

  constructor(private readonly module: AbiModule) {}

  /** The clang the module was built from, for the status bar. */
  version(): Promise<string> {
    return this.module.version();
  }

  /** Every triple this build can lay out, not a curated list. */
  targets(): Promise<string[]> {
    return this.module.targets();
  }

  analyze(source: string, options: CompileOptions, signal?: AbortSignal): Promise<Analysis> {
    const key = this.key(source, options);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.module
        .query(this.request(source, options))
        .then((response) => toAnalysis(response, source, options));
      // A failure must not poison the cache; the next attempt should retry.
      void pending.catch(() => this.cache.delete(key));
      if (this.cache.size > 32) this.cache.clear();
      this.cache.set(key, pending);
    }
    return pending.then((analysis) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return analysis;
    });
  }

  /**
   * Size and alignment of an arbitrary type spelling in the user's context:
   * the one question the response cannot answer in advance, because the
   * spelling is whatever the pointer happens to be over.
   */
  probeSpelling(
    analysis: Analysis,
    spelling: string,
    signal?: AbortSignal,
  ): Promise<{ bits: number; align: number } | null> {
    // The probe is a C construct (`__typeof__` in a struct clang is asked to
    // lay out beside the user's). Hylo answers hover from the type its own
    // compiler assigned the cursor, so there is nothing to probe for.
    if (analysis.options.lang === 'hylo') return Promise.resolve(null);

    const key = this.key(analysis.source, analysis.options) + '\0' + spelling;
    const hit = this.spellings.get(key);
    if (hit) return hit;

    // One probe struct, and one round: a spelling that does not compile comes
    // back as a record with no fields, which is an answer. The pipeline this
    // replaces could only tell by re-running with fewer probes until clang
    // stopped complaining.
    const probe = this.module
      .query({
        ...this.request(
          `${analysis.source}\n#pragma pack()\nstruct __abix_probe { __typeof__(${spelling}) v; };\n`,
          analysis.options,
        ),
      })
      .then((response) => {
        const field = response.records.find((r) => r.name === '__abix_probe')?.fields[0];
        if (!field || field.sizeBits <= 0) return null;
        return { bits: field.sizeBits, align: field.alignBits / 8 };
      })
      .catch(() => null);

    if (this.spellings.size > 512) this.spellings.clear();
    this.spellings.set(key, probe);
    return probe.then((r) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return r;
    });
  }

  private request(source: string, o: CompileOptions) {
    return {
      source,
      // Hylo has one ABI, whatever triple a shared link or an earlier C
      // session left in the options.
      triple: o.lang === 'hylo' ? HYLO_TRIPLE : o.triple,
      lang: o.lang,
      ...(o.std ? { std: o.std } : {}),
      flags: buildFlags(o),
    };
  }

  /** Everything that changes the answer. */
  private key(source: string, o: CompileOptions): string {
    return [o.lang, o.std, o.triple, buildFlags(o).join(' '), source].join('\0');
  }
}

// ------------------------------------------------------------ the mapping --

function toRecordLayout(w: WireRecord, dup: number): RecordLayout {
  const out: RecordLayout = {
    kind: w.kind,
    // `printedName` is the name a reader would write: the typedef name for
    // `typedef struct { … } T;`, and clang's `(unnamed struct at f.c:3:9)` for
    // one that genuinely cannot be written.
    name: w.printedName.replace(/^(?:struct|class|union|__interface|enum)\s+/, ''),
    qualifiedName: w.qualifiedName,
    isEmpty: w.isEmpty,
    sizeBytes: w.sizeBits / 8,
    align: w.alignBits / 8,
    location: w.location,
    range: w.range,
  };
  if (dup > 0) out.dup = dup;
  // Only the ones that differ: the summary shows a row per surprise, and
  // `nvsize == sizeof` is not one.
  if (w.dataSizeBits !== w.sizeBits) out.dsize = w.dataSizeBits / 8;
  if (w.nonVirtualSizeBits !== w.sizeBits) out.nvsize = w.nonVirtualSizeBits / 8;
  if (w.nonVirtualAlignBits !== w.alignBits) out.nvalign = w.nonVirtualAlignBits / 8;
  if (w.preferredAlignBits !== w.alignBits) out.preferredalign = w.preferredAlignBits / 8;
  return out;
}

export function toAnalysis(
  response: WireResponse,
  source: string,
  options: CompileOptions,
): Analysis {
  const byId = new Map<number, AnalysedRecord>();
  const byKey = new Map<string, AnalysedRecord>();
  const byName = new Map<string, AnalysedRecord>();
  const records: AnalysedRecord[] = [];
  // Records sharing a kind and a name are numbered from the second on, so two
  // function-local `struct S`es still have identities of their own.
  const seen = new Map<string, number>();

  for (const w of response.records) {
    const nameKey = w.kind + ' ' + w.printedName;
    const dup = seen.get(nameKey) ?? 0;
    seen.set(nameKey, dup + 1);
    const record = toRecordLayout(w, dup);
    const entry: AnalysedRecord = {
      key: recordKey(record),
      record,
      model: fromWire(record, w.render),
      listed: w.isUserCode && (!w.isAnonymous || w.parentRecordId === null),
    };
    byId.set(w.id, entry);
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    // `record.name` carries the template arguments where the other three do
    // not: clang's `name` and `qualifiedName` for an instantiation are the bare
    // template's, so `Pair<double>` and `Pair<char>` both answered to `Pair`
    // and the first one registered won every lookup. They are different
    // records with different sizes; each needs a spelling of its own.
    for (const spelling of [w.printedName, w.qualifiedName, w.name, record.name]) {
      if (spelling && !byName.has(spelling)) byName.set(spelling, entry);
    }
    // Only what the user wrote is listed; the rest are here to be referenced.
    // One `#include <string>` lays out over a thousand library records.
    if (w.isUserCode) records.push(entry);
  }

  const typedefs: TypeName[] = response.typedefs.map((t) => ({
    name: t.name,
    location: t.location,
    type: t.typeSpelling,
    canonicalType: t.canonicalTypeSpelling,
    sizeBits: t.sizeBits,
    align: t.alignBits / 8,
    recordId: t.recordId,
  }));

  const diagnostics: Diagnostic[] = [];
  for (const d of response.diagnostics) {
    const loc = d.location;
    if (!loc?.isMainFile) continue;
    const entry: Diagnostic = {
      line: loc.line,
      column: loc.col,
      severity: d.severity === 'fatal' ? 'fatal error' : d.severity,
      message: d.message,
    };
    // Underline the highlighted range where clang gave one on this line;
    // otherwise the token the diagnostic points at.
    const sameLine = d.ranges.find((r) => r.line === loc.line && r.endLine === r.line);
    if (sameLine) {
      entry.column = sameLine.col;
      entry.endColumn = Math.max(sameLine.endCol, sameLine.col + 1);
    } else if (loc.endCol > loc.col) {
      entry.endColumn = loc.endCol;
    }
    diagnostics.push(entry);
  }

  return {
    source,
    options,
    code: response.exitCode,
    records,
    byId,
    byKey,
    byName,
    typedefs,
    diagnostics,
    diagnosticsText: response.diagnosticsText,
    headers: response.headers,
  };
}
