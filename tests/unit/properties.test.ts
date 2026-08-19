// Property-based tests for the places where a wrong answer is both easy to
// produce and expensive: the URL decoder that eats untrusted input, the flag
// allowlist that decides what clang is asked to do, and the geometry the views
// draw — padding, containment, the byte map — whose invariants are hard to
// state in examples but easy to state as laws.
//
// Breadth comes from two directions. Random search covers the untrusted-input
// surface, where the interesting cases are the ones nobody thought of. The
// geometry laws run over the corpus instead: it is finite, so it is exhausted
// rather than sampled — with hundreds of real records a sampled property
// touches a fraction of them, and the record worth checking is precisely the
// rare one. Generated *sources*, compiled for real, are in
// `properties.real.test.ts`; nothing here needs clang.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildFlags, DEFAULT_OPTIONS, isAllowedFlag, splitExtraFlags } from '$core/options';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { C_STANDARDS, CXX_STANDARDS, TARGET_GROUPS } from '$core/targets';
import { corpus, corpusRecords, missingCaptures } from './corpus';
import { modelLaws } from './model-laws';

// ---------------------------------------------------------- url state -----

const KNOWN_TRIPLES = TARGET_GROUPS.flatMap((g) => g.targets.map((t) => t.triple));

const optionsArb = fc
  .record({
    cxx: fc.boolean(),
    triple: fc.constantFrom(...KNOWN_TRIPLES),
    pack: fc.constantFrom('' as const, '1' as const, '4' as const, '16' as const),
    msBitfields: fc.boolean(),
    shortEnums: fc.boolean(),
    shortWchar: fc.boolean(),
    warnPadded: fc.boolean(),
    extraFlags: fc.constantFrom('', '-Wpadded', '-O2 -DFOO=1', '-fshort-enums'),
    stdPick: fc.nat(),
  })
  .map(({ cxx, stdPick, ...rest }) => {
    const stds = cxx ? CXX_STANDARDS : C_STANDARDS;
    return {
      ...rest,
      lang: cxx ? ('c++' as const) : ('c' as const),
      std: stds[stdPick % stds.length]!,
    };
  });

describe('share URL (property)', () => {
  it('round-trips source and every option', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 400 }),
        optionsArb,
        fc.option(fc.constantFrom('struct Example', 'union U'), { nil: null }),
        fc.constantFrom('tabs' as const, 'stack' as const),
        async (source, options, selectedRecord, view) => {
          const state = { source, options, selectedRecord, view };
          const back = await decodeShareState(await encodeShareState(state));
          expect(back).toEqual(state);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('survives arbitrary fragments without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (fragment) => {
        const decoded = await decodeShareState(fragment);
        if (decoded !== null) expectValidState(decoded);
      }),
      { numRuns: 200 },
    );
  });

  it('coerces hostile wire data into a usable state', async () => {
    // The fragment is attacker-controlled: a link can carry any JSON at all.
    // Whatever comes back must still be something we can hand to clang.
    await fc.assert(
      fc.asyncProperty(fc.object({ maxDepth: 2 }), async (payload) => {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);
        const fragment = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const decoded = await decodeShareState(fragment);
        if (decoded !== null) expectValidState(decoded);
      }),
      { numRuns: 200 },
    );
  });
});

function expectValidState(s: ShareState): void {
  const o = s.options;
  expect(typeof s.source).toBe('string');
  expect(['c', 'c++', 'hylo']).toContain(o.lang);
  expect(['', '1', '2', '4', '8', '16']).toContain(o.pack);
  // A triple goes straight into `--target=`; it must stay a plain token.
  expect(o.triple).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  expect(o.extraFlags.length).toBeLessThanOrEqual(500);
  expect(['tabs', 'stack']).toContain(s.view);
  const stds = o.lang === 'c++' ? CXX_STANDARDS : o.lang === 'hylo' ? [] : C_STANDARDS;
  if (stds.length) expect(stds).toContain(o.std);
}

// ------------------------------------------------------ flag allowlist ----

/**
 * Flags that would change what clang *does* rather than how it lays records
 * out: pick a different frontend action, or write a file. `buildFlags` never
 * emits any of these, so seeing one means the user's free-form flag box got it
 * through — and a URL can put anything in that box.
 */
function isDangerous(token: string): boolean {
  return (
    /^-(?:o|c|S|E|M[MDFGPQT]?|###)$/.test(token) ||
    /^--?(?:output|analyze|save-temps|emit)/.test(token) ||
    token.startsWith('-emit-') ||
    token.startsWith('-dump')
  );
}

describe('extra-flag allowlist (property)', () => {
  const flagText = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc
      .array(
        fc.constantFrom(
          '-o',
          'out.o',
          '-E',
          '-S',
          '-###',
          '-emit-llvm',
          '-Xclang',
          '-ast-print',
          '-Xclang',
          '-fdump-record-layouts',
          '-O2',
          '-DFOO=1',
          '-I/tmp',
          '-target',
          'x86_64-linux',
          'evil.c',
          '--output=x',
          '-save-temps',
          '-w',
        ),
        { maxLength: 8 },
      )
      .map((t) => t.join(' ')),
  );

  it('classifies every token exactly once', () => {
    fc.assert(
      fc.property(flagText, (text) => {
        const [accepted, rejected] = splitExtraFlags(text);
        const tokens = text.trim().split(/\s+/).filter(Boolean);
        // Nothing invented, nothing silently dropped — the UI shows `rejected`
        // to explain why a flag had no effect.
        expect([...accepted, ...rejected].sort()).toEqual([...tokens].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('lets no output- or action-changing flag reach clang', () => {
    fc.assert(
      fc.property(flagText, fc.boolean(), (extraFlags, cxx) => {
        const flags = buildFlags({
          ...DEFAULT_OPTIONS,
          lang: cxx ? ('c++' as const) : ('c' as const),
          extraFlags,
        });
        expect(flags.filter(isDangerous)).toEqual([]);
        // The request decides the language and the target; a flag must never
        // get a second opinion in, or the answer stops describing what the UI
        // says it describes.
        expect(flags.filter((f) => f.startsWith('-x'))).toEqual([]);
        expect(flags.filter((f) => f.startsWith('--target=') || f === '-target')).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('accepts only what the allowlist admits, for single tokens', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (token) => {
        if (/\s/.test(token) || token === '') return;
        const [accepted] = splitExtraFlags(token);
        expect(accepted).toEqual(isAllowedFlag(token) ? [token] : []);
      }),
      { numRuns: 300 },
    );
  });
});

// -------------------------------------------------- the model, for real ---

describe('corpus', () => {
  it('covers every shipped example and regression source', () => {
    // A source added to the site (or to REGRESSION_SOURCES) without a captured
    // response would silently stop being checked.
    expect(missingCaptures(), 'run `npm run fixtures` to capture these').toEqual([]);
  });

  it('holds a broad body of real records', () => {
    expect(corpus().length).toBeGreaterThan(20);
    const records = corpusRecords();
    expect(records.length).toBeGreaterThan(40);

    // The shapes only real ABIs produce are actually present — otherwise the
    // laws below are being checked against a corpus of plain C structs.
    const models = records.map((r) => r.entry.model);
    const groups = models.flatMap((m) => m.groups);
    const leaves = models.flatMap((m) => m.leaves);
    expect(groups.some((g) => g.kind === 'primary-base')).toBe(true);
    expect(groups.some((g) => g.kind === 'vbase' || g.kind === 'primary-vbase')).toBe(true);
    expect(groups.some((g) => g.isUnion)).toBe(true);
    expect(leaves.some((l) => l.kind === 'bitfield')).toBe(true);
    expect(leaves.some((l) => l.kind === 'special')).toBe(true);
    expect(leaves.some((l) => l.sharesAddress)).toBe(true);
    expect(models.some((m) => m.markers.some((k) => k.kind === 'empty-base'))).toBe(true);
    expect(models.some((m) => m.markers.some((k) => k.kind === 'zero-bitfield'))).toBe(true);
    // A member whose tail padding the enclosing record reuses.
    expect(groups.some((g) => g.sizeBits < g.typeSizeBits)).toBe(true);
  });
});

// The laws themselves are shared with the real-clang suite, which runs them
// over generated sources; here they are exhausted over the corpus.
modelLaws('the corpus', () =>
  corpusRecords().map(({ from, entry }) => ({
    label: `${from}: ${entry.key}`,
    model: entry.model,
  })),
);
