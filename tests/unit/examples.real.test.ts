// Every shipped example must compile and produce records — a broken example is
// the first thing a visitor sees. Skipped unless ABIX_REAL_CLANG=1.
import { describe, it, expect, beforeAll } from 'vitest';
import { Analyzer } from '$compiler/Analyzer';
import { DEFAULT_OPTIONS, defaultStdFor } from '$core/options';
import { EXAMPLES } from '$core/targets';
import type { Compiler } from '$compiler/Compiler';

describe.skipIf(process.env['ABIX_REAL_CLANG'] !== '1')('shipped examples', () => {
  let analyzer: Analyzer;
  beforeAll(async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    analyzer = new Analyzer((await createNodeCompiler()) as Compiler);
  }, 300_000);

  for (const ex of EXAMPLES) {
    it(`compiles: ${ex.name}`, async () => {
      const a = await analyzer.analyze(ex.source, {
        ...DEFAULT_OPTIONS,
        lang: ex.lang,
        std: defaultStdFor(ex.lang),
      });
      expect(a.diagnosticsText, ex.name).not.toMatch(/error:/);
      expect(a.code, ex.name).toBe(0);
      expect(a.userRecords.length, ex.name).toBeGreaterThan(0);
      // Every member of the user's own records is measured, not estimated. The
      // libc++ example is the exception: a few of the library's internal
      // members are not spellable in a probe expression, so they fall back to
      // an estimate — which is what the ≈ marker in the UI is for.
      if (!ex.name.includes('libc++')) expect(a.unmeasured, ex.name).toEqual([]);
    }, 180_000);
  }
});
