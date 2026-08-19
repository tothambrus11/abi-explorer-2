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
import type { Analysis } from './Analyzer';

/** What this needs from clang-abi-wasm; the module supplies it. */
export interface AbiModule {
  query(request: {
    source: string;
    triple: string;
    lang?: 'c' | 'c++';
    std?: string;
    flags?: string[];
    includeSystemRecords?: boolean;
  }): AbiResponse;
  targets(): string[];
  version(): string;
}

/** One analysis and the response it came from, so `locate` needs no second call. */
interface Entry {
  analysis: Analysis;
  ast: AstInfo;
}

export class AbiAnalyzer {
  private readonly cache = new Map<string, Entry>();
  private readonly spellingCache = new Map<string, ProbeResult | null>();

  constructor(private readonly module: AbiModule) {}

  /** The clang the module was built from, for the status bar. */
  version(): string {
    return this.module.version();
  }

  /** Every triple this build can lay out — not a curated list. */
  targets(): string[] {
    return this.module.targets();
  }

  analyze(source: string, options: CompileOptions, signal?: AbortSignal): Promise<Analysis> {
    // The call is synchronous, but the interface is async so a worker-backed
    // implementation can slot in without changing any caller.
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      try {
        resolve(this.entryFor(source, options).analysis);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Source locations for the given records. The owner set is ignored: the
   * response already carries every location, so there is nothing to narrow and
   * nothing to re-parse. The parameter stays for interface compatibility.
   */
  locate(analysis: Analysis, _owners: Iterable<string>, _signal?: AbortSignal): Promise<AstInfo> {
    const entry = this.cache.get(this.key(analysis.source, analysis.options));
    return Promise.resolve(entry ? entry.ast : { fields: [], decls: [] });
  }

  /** Size and alignment of an arbitrary type spelling, in the user's context. */
  probeSpelling(
    analysis: Analysis,
    spelling: string,
    _signal?: AbortSignal,
  ): Promise<ProbeResult | null> {
    const key = this.key(analysis.source, analysis.options) + '\0' + spelling;
    const hit = this.spellingCache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);

    // One probe struct, the same trick as before — but against the user's own
    // source so the spelling resolves in its context, and without the retry
    // rounds, because a failure is now just an error in the response.
    const probeSource = `${analysis.source}\n#pragma pack()\nstruct __abix_probe { __typeof__(${spelling}) v; };\n`;
    let result: ProbeResult | null = null;
    try {
      const response = this.module.query({
        source: probeSource,
        triple: analysis.options.triple,
        lang: analysis.options.lang === 'c++' ? 'c++' : 'c',
        ...(analysis.options.std ? { std: analysis.options.std } : {}),
      });
      const probe = response.records.find((r) => r.name === '__abix_probe');
      const field = probe?.fields[0];
      if (field && field.sizeBits > 0) {
        result = { bits: field.sizeBits, align: field.alignBits / 8 };
      }
    } catch {
      result = null;
    }
    if (this.spellingCache.size > 512) this.spellingCache.clear();
    this.spellingCache.set(key, result);
    return Promise.resolve(result);
  }

  private entryFor(source: string, options: CompileOptions): Entry {
    const key = this.key(source, options);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const response = this.module.query({
      source,
      triple: options.triple,
      lang: options.lang === 'c++' ? 'c++' : 'c',
      ...(options.std ? { std: options.std } : {}),
      ...(options.extraFlags ? { flags: options.extraFlags.split(/\s+/).filter(Boolean) } : {}),
    });
    const entry: Entry = {
      analysis: toAnalysis(response, source, options),
      ast: toAstInfo(response),
    };
    // Bounded: one entry per keystroke-debounced edit adds up over a session.
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
