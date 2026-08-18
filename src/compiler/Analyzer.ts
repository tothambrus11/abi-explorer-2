// The analysis pipeline, expressed against the Compiler interface:
//
//   0. scalar table  — static probe TU, once per option set → pointer size etc.
//   1. layout pass   — user TU → records, diagnostics
//   2. field probes  — one struct per field, measured by clang (`__typeof__`)
//                      → exact size/align of every member
//   3. locations     — filtered `-ast-dump=json` per owner record → source lines,
//                      declared types (lazy; only for what the UI shows)
//   4. spelling probe — on demand (type hover) → size/align of any type spelling
//
// Everything type-related is answered by clang; we only read its outputs.

import type { CompileOptions } from '$core/options';
import { buildArgv, driverFor, sourceExtension } from '$core/options';
import { isInternalRecord, parseRecordLayouts } from '$core/layout-parser';
import {
  buildFieldProbes,
  buildProbeSource,
  buildRecordIndex,
  buildScalarTable,
  buildSpellingProbe,
  failingProbeIndices,
  nextProbeRound,
  readProbeResults,
  STATIC_PROBE_SOURCE,
  type MemberSizes,
  type RecordIndex,
  type ScalarTable,
} from '$core/probes';
import { parseDiagnostics } from '$core/diagnostics';
import { stripAnsi } from '$core/ansi';
import { extractAstInfo, type AstInfo } from '$core/ast-locations';
import type { Diagnostic, ProbeResult, RecordLayout } from '$core/types';
import type { Compiler } from './Compiler';

export interface Analysis {
  source: string;
  options: CompileOptions;
  /** clang exit code of the layout pass. */
  code: number;
  records: RecordLayout[];
  userRecords: RecordLayout[];
  scalars: ScalarTable;
  recordIndex: RecordIndex;
  memberSizes: MemberSizes;
  /** Members whose probe failed (memberKey), for UI hints. */
  unmeasured: string[];
  diagnostics: Diagnostic[];
  /** Plain diagnostics text (escapes stripped). */
  diagnosticsText: string;
  /** As emitted by clang, with ANSI colors. */
  diagnosticsAnsi: string;
}

const MAIN_FILE = (o: CompileOptions) => 'input.' + sourceExtension(o.lang);
const PROBE_TU = (o: CompileOptions) => 'abix_scalars.' + sourceExtension(o.lang);
const FIELD_PROBE_FILE = (o: CompileOptions) => 'input_probe.' + sourceExtension(o.lang);

export class Analyzer {
  private locationCache = new Map<string, AstInfo>();
  private spellingCache = new Map<string, ProbeResult | null>();
  private scalarCache = new Map<string, ScalarTable>();

  constructor(private readonly compiler: Compiler) {}

  /**
   * Scalar sizes for the target (pointer, function pointer, …). They depend on
   * the options only, so they are measured in their own TU once per option
   * set — never alongside the user's code, whose errors would abort clang
   * before it reaches a second TU.
   */
  private async scalarTable(options: CompileOptions, signal?: AbortSignal): Promise<ScalarTable> {
    const key = cacheKey('', options);
    const cached = this.scalarCache.get(key);
    if (cached) return cached;
    const probeTu = PROBE_TU(options);
    const r = await this.compiler.compile({
      argv0: driverFor(options.lang),
      args: buildArgv(options, { kind: 'layout', files: [probeTu] }),
      files: { [probeTu]: STATIC_PROBE_SOURCE },
      signal,
    });
    const table = buildScalarTable(parseRecordLayouts(r.stdout));
    if (this.scalarCache.size > 64) this.scalarCache.clear();
    if (table.size > 0) this.scalarCache.set(key, table);
    return table;
  }

  async analyze(source: string, options: CompileOptions, signal?: AbortSignal): Promise<Analysis> {
    const argv0 = driverFor(options.lang);
    const mainFile = MAIN_FILE(options);

    // 0. scalar table (cached per option set)
    const scalars = await this.scalarTable(options, signal);

    // 1. layout pass
    const r1 = await this.compiler.compile({
      argv0,
      args: buildArgv(options, { kind: 'layout', files: [mainFile] }),
      files: { [mainFile]: source },
      signal,
    });
    const records = parseRecordLayouts(r1.stdout);
    const recordIndex = buildRecordIndex(records);
    const userRecords = records.filter((r) => !isInternalRecord(r));
    const diagnosticsAnsi = r1.stderr;
    const diagnosticsText = stripAnsi(diagnosticsAnsi);
    const diagnostics = parseDiagnostics(diagnosticsText, mainFile);

    // 2. field probes (retry up to 3 times, dropping probes that fail)
    const memberSizes: MemberSizes = new Map();
    let probes = buildFieldProbes(userRecords, recordIndex);
    const wanted = new Set(probes.map((p) => p.key));
    for (let attempt = 0; attempt < 4 && probes.length > 0; attempt++) {
      const file = FIELD_PROBE_FILE(options);
      const ps = buildProbeSource(source, probes);
      const r2 = await this.compiler.compile({
        argv0,
        args: buildArgv(options, { kind: 'layout', files: [file], measure: true }),
        files: { [file]: ps.source },
        signal,
      });
      for (const [k, v] of readProbeResults(parseRecordLayouts(r2.stdout), ps.probes)) {
        memberSizes.set(k, v);
      }
      if (r2.code === 0) break;
      const bad = failingProbeIndices(stripAnsi(r2.stderr), file, ps.firstProbeLine, ps.probes);
      if (bad.size === 0) break; // errors elsewhere (user code) — nothing more to gain
      probes = nextProbeRound(ps.probes, bad, memberSizes);
    }
    const unmeasured = [...wanted].filter((k) => !memberSizes.has(k));

    return {
      source,
      options,
      code: r1.code,
      records,
      userRecords,
      scalars,
      recordIndex,
      memberSizes,
      unmeasured,
      diagnostics,
      diagnosticsText,
      diagnosticsAnsi,
    };
  }

  /** One filtered `-ast-dump=json` (cached per source/options/filter). */
  private async astDump(
    source: string,
    options: CompileOptions,
    filter: string,
    signal?: AbortSignal,
  ): Promise<AstInfo> {
    const key = cacheKey(source, options) + '\0' + filter;
    const cached = this.locationCache.get(key);
    if (cached) return cached;
    const mainFile = MAIN_FILE(options);
    const r = await this.compiler.compile({
      argv0: driverFor(options.lang),
      args: buildArgv(options, { kind: 'ast-json', files: [mainFile], astFilter: filter }),
      files: { [mainFile]: source },
      signal,
    });
    const info = extractAstInfo(r.stdout, mainFile);
    if (this.locationCache.size > 256) this.locationCache.clear();
    this.locationCache.set(key, info);
    return info;
  }

  /**
   * Source locations + declared types of the fields of the given owner
   * records (unqualified names as used by `-ast-dump-filter`). Cached per
   * (source, options, owner).
   */
  async locate(
    analysis: Analysis,
    owners: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<AstInfo> {
    const { source, options } = analysis;
    const out: AstInfo = { fields: [], decls: [] };
    for (const owner of new Set(owners)) {
      if (!owner) continue;
      if (signal?.aborted) break;
      const locs = await this.astDump(source, options, owner, signal);
      out.fields.push(...locs.fields);
      out.decls.push(...locs.decls);
    }
    return out;
  }

  /** Size/alignment of an arbitrary type spelling in the context of the user's TU (null if it doesn't compile). */
  async probeSpelling(
    analysis: Analysis,
    spelling: string,
    signal?: AbortSignal,
  ): Promise<ProbeResult | null> {
    const { source, options } = analysis;
    const key = cacheKey(source, options) + '\0' + spelling;
    if (this.spellingCache.has(key)) return this.spellingCache.get(key)!;
    const file = FIELD_PROBE_FILE(options);
    const ps = buildProbeSource(source, [buildSpellingProbe(spelling)]);
    const r = await this.compiler.compile({
      argv0: driverFor(options.lang),
      args: buildArgv(options, { kind: 'layout', files: [file], measure: true }),
      files: { [file]: ps.source },
      signal,
    });
    const res = readProbeResults(parseRecordLayouts(r.stdout), ps.probes).get(spelling) ?? null;
    if (this.spellingCache.size > 512) this.spellingCache.clear();
    this.spellingCache.set(key, res);
    return res;
  }
}

/** Cheap content key: length + FNV-1a hash of source, plus the options that affect clang. */
function cacheKey(source: string, o: CompileOptions): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [
    source.length,
    h.toString(16),
    o.lang,
    o.std,
    o.triple,
    o.pack,
    +o.msBitfields,
    +o.shortEnums,
    +o.shortWchar,
    +o.wasiLibc,
    o.extraFlags,
  ].join('|');
}
