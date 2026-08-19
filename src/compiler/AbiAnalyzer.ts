// The analysis pipeline, when clang is a library rather than a driver.
//
// `Analyzer` runs a baseline compile, a layout pass, up to four probe rounds
// and one AST dump per record — six or more full re-parses of the user's
// translation unit, because each answer had to be recovered from something
// clang printed. This one asks once and reads fields:
//
//   analyze()        one query
//   locate()         the same response; locations arrive attached to fields
//   probeSpelling()  a query against a one-line source
//
// The two are interchangeable from `Session`'s point of view, which is what
// lets the app switch between them at runtime and compare.

import type { CompileOptions } from '$core/options';
import type { AstInfo } from '$core/ast-locations';
import type { ProbeResult } from '$core/types';
import { toAnalysis, toAstInfo, type AbiResponse } from './AbiAdapter';
import type { Analysis, LayoutAnalyzer } from './Analyzer';

/**
 * What this needs from clang-abi-wasm. Async because the production path is a
 * worker: the module is 28 MB and a query over libc++ takes hundreds of
 * milliseconds, neither of which belongs on the main thread. An in-process
 * module satisfies it too — see `fromSyncModule`.
 */
export interface AbiModule {
  query(request: {
    source: string;
    triple: string;
    lang?: 'c' | 'c++';
    std?: string;
    flags?: string[];
    includeSystemRecords?: boolean;
  }): Promise<AbiResponse>;
  targets(): Promise<string[]>;
  version(): Promise<string>;
}

/** Wrap a synchronous in-process module (tests, Node) as an async one. */
export function fromSyncModule(m: {
  query(request: unknown): AbiResponse;
  targets(): string[];
  version(): string;
}): AbiModule {
  return {
    query: (r) => Promise.resolve(m.query(r)),
    targets: () => Promise.resolve(m.targets()),
    version: () => Promise.resolve(m.version()),
  };
}

/** One analysis and the response it came from, so `locate` needs no second call. */
interface Entry {
  analysis: Analysis;
  ast: AstInfo;
}

export class AbiAnalyzer implements LayoutAnalyzer {
  private readonly cache = new Map<string, Promise<Entry>>();
  private readonly spellingCache = new Map<string, Promise<ProbeResult | null>>();

  constructor(private readonly module: AbiModule) {}

  /** The clang the module was built from, for the status bar. */
  version(): Promise<string> {
    return this.module.version();
  }

  /** Every triple this build can lay out — not a curated list. */
  targets(): Promise<string[]> {
    return this.module.targets();
  }

  async analyze(source: string, options: CompileOptions, signal?: AbortSignal): Promise<Analysis> {
    const entry = await this.entryFor(source, options);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return entry.analysis;
  }

  /**
   * Source locations for the given records. The owner set is ignored: the
   * response already carries every location, so there is nothing to narrow and
   * nothing to re-parse. The parameter stays for interface compatibility, and
   * because `Session` derives it from the models either way.
   */
  async locate(analysis: Analysis, _owners: Iterable<string>): Promise<AstInfo> {
    const pending = this.cache.get(this.key(analysis.source, analysis.options));
    if (!pending) return { fields: [], decls: [] };
    return (await pending).ast;
  }

  /** Size and alignment of an arbitrary type spelling, in the user's context. */
  probeSpelling(analysis: Analysis, spelling: string): Promise<ProbeResult | null> {
    const key = this.key(analysis.source, analysis.options) + '\0' + spelling;
    const hit = this.spellingCache.get(key);
    if (hit) return hit;

    // One probe struct, the same trick as before — but without the retry
    // rounds, because a failure is now an error in the response rather than
    // something to be inferred from an exit code.
    const probe = this.module
      .query({
        source: `${analysis.source}\n#pragma pack()\nstruct __abix_probe { __typeof__(${spelling}) v; };\n`,
        triple: analysis.options.triple,
        lang: analysis.options.lang === 'c++' ? 'c++' : 'c',
        ...(analysis.options.std ? { std: analysis.options.std } : {}),
      })
      .then((response) => {
        const field = response.records.find((r) => r.name === '__abix_probe')?.fields[0];
        return field && field.sizeBits > 0
          ? { bits: field.sizeBits, align: field.alignBits / 8 }
          : null;
      })
      .catch(() => null);

    if (this.spellingCache.size > 512) this.spellingCache.clear();
    this.spellingCache.set(key, probe);
    return probe;
  }

  /**
   * Cached by input, and cached as the *promise* — two edits that settle on the
   * same text must not both reach the module while the first is in flight.
   */
  private entryFor(source: string, options: CompileOptions): Promise<Entry> {
    const key = this.key(source, options);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const entry = this.module
      .query({
        source,
        triple: options.triple,
        lang: options.lang === 'c++' ? 'c++' : 'c',
        ...(options.std ? { std: options.std } : {}),
        ...(options.extraFlags ? { flags: options.extraFlags.split(/\s+/).filter(Boolean) } : {}),
      })
      .then((response) => ({
        analysis: toAnalysis(response, source, options),
        ast: toAstInfo(response),
      }));

    // A failed query must not poison the cache: the next attempt should retry.
    void entry.catch(() => this.cache.delete(key));
    // Bounded: one entry per debounced edit adds up over a session.
    if (this.cache.size > 32) this.cache.clear();
    this.cache.set(key, entry);
    return entry;
  }

  private key(source: string, o: CompileOptions): string {
    return [
      o.lang,
      o.std,
      o.triple,
      o.pack,
      +o.msBitfields,
      +o.shortEnums,
      +o.shortWchar,
      o.extraFlags,
      source,
    ].join('\0');
  }
}
