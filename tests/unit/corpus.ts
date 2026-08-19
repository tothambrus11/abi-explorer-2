// A corpus of *real* clang answers, for tests that want the shapes the compiler
// actually produces rather than the ones a generator thinks to build.
//
// Generated records cover breadth — every combination of bit-field, base and
// nesting the arbitraries can reach. They do not cover the shapes that only
// arise from real ABI rules: libc++'s short-string union, MSVC vbtable
// pointers, a primary base absorbed at offset zero. This corpus supplies those,
// and the two feed the same property tests side by side.
//
// What is stored is one query response per (source, triple) — the compiler's
// own answer, verbatim. The corpus this replaces stored the text of a layout
// dump, which only had meaning once a parser had interpreted it; these files
// are the interface itself, so a test reading one is exercising the same data
// the app receives.
//
// Sources are the examples shipped on the site (imported from $core/targets, so
// adding one to the site adds it here) plus regression sources kept because
// they once broke something. Capture with `npm run fixtures`.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES } from '$core/targets';
import { DEFAULT_OPTIONS, defaultStdFor, type CompileOptions, type Language } from '$core/options';
import { toAnalysis, type Analysis } from '$compiler/AbiAnalyzer';
import type { WireResponse } from '$core/render';

export const RESPONSES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'responses');

/** One translation unit to capture answers for. */
export interface CorpusSource {
  name: string;
  lang: Language;
  source: string;
  /** Targets to capture it for; ABIs differ enough that one is not enough. */
  triples: string[];
}

const DEFAULT_TRIPLES = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'];

/**
 * Sources kept because they once produced a wrong answer. A corpus entry is
 * cheaper than a hand-built model and stays honest: it is whatever clang says
 * today, not what someone believed clang said when the bug was fixed.
 */
export const REGRESSION_SOURCES: CorpusSource[] = [
  {
    // Two members that contain no byte-occupying member at all, so their groups
    // hold no leaf indices — the one case where leaf ranges cannot say what is
    // nested in what, and both members used to adopt both bases.
    name: 'regression-leafless-members',
    lang: 'c++',
    source: 'struct E {};\nstruct W : E {};\nstruct S { W a; W b; int i; };\n',
    triples: DEFAULT_TRIPLES,
  },
  {
    // An empty member sharing an address, next to one that cannot.
    name: 'regression-no-unique-address',
    lang: 'c++',
    source:
      'struct E {};\nstruct Shared { [[no_unique_address]] E e; int i; };\nstruct Own { E e; int i; };\n',
    triples: DEFAULT_TRIPLES,
  },
  {
    // Anonymous aggregates nested in each other, whose labels all collide.
    name: 'regression-nested-anonymous',
    lang: 'c',
    source:
      'struct S {\n  struct { int a; struct { char b, c; }; };\n  union { long d; struct { short e, f; }; };\n};\n',
    triples: DEFAULT_TRIPLES,
  },
  {
    // A virtual base reached through two paths, plus a member declared before
    // it that the ABI places after it. Hovering the base must still light up
    // the bytes it occupies.
    name: 'regression-virtual-diamond',
    lang: 'c++',
    source:
      'struct Base { int a; };\nstruct Mixin { char m; };\n' +
      'struct Derived : virtual Base, Mixin { double d; };\n' +
      'struct Diamond : Derived, virtual Base { short s; };\n',
    triples: DEFAULT_TRIPLES,
  },
  {
    // Bit-fields that straddle storage units, with a zero-width break between.
    name: 'regression-bitfield-units',
    lang: 'c',
    source:
      'struct S {\n  unsigned a : 3;\n  unsigned b : 30;\n  unsigned : 0;\n  unsigned c : 5;\n  char tail;\n};\n',
    triples: DEFAULT_TRIPLES,
  },
];

/** Every source the corpus covers: the shipped examples, plus the regressions. */
export function corpusSources(): CorpusSource[] {
  const examples = EXAMPLES.map((ex) => ({
    name: slug(ex.name),
    lang: ex.lang,
    source: ex.source,
    triples: DEFAULT_TRIPLES,
  }));
  return [...examples, ...REGRESSION_SOURCES];
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      // Keep the language visible: stripping punctuation alone would turn
      // "C++ virtual bases" into "c-virtual-bases".
      .replace(/\+\+/g, 'pp')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

export function responseFile(name: string, triple: string): string {
  return path.join(RESPONSES_DIR, `${name}--${triple}.json`);
}

export function optionsFor(src: CorpusSource, triple: string): CompileOptions {
  return { ...DEFAULT_OPTIONS, lang: src.lang, std: defaultStdFor(src.lang), triple };
}

/** Captured responses that are missing from disk (a source was added, not captured). */
export function missingCaptures(): string[] {
  const missing: string[] = [];
  for (const src of corpusSources()) {
    for (const triple of src.triples) {
      if (!existsSync(responseFile(src.name, triple))) missing.push(`${src.name}--${triple}`);
    }
  }
  return missing;
}

/** A captured response, as the app would have received it. */
export interface CorpusEntry {
  /** "<source>--<triple>", used in assertion messages. */
  name: string;
  analysis: Analysis;
}

let cached: CorpusEntry[] | null = null;

/** Every captured answer, run through the same projection the app uses. */
export function corpus(): CorpusEntry[] {
  if (cached) return cached;
  const out: CorpusEntry[] = [];
  if (existsSync(RESPONSES_DIR)) {
    for (const file of readdirSync(RESPONSES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const stored = JSON.parse(readFileSync(path.join(RESPONSES_DIR, file), 'utf8')) as {
        source: string;
        options: CompileOptions;
        response: WireResponse;
      };
      out.push({
        name: file.replace(/\.json$/, ''),
        analysis: toAnalysis(stored.response, stored.source, stored.options),
      });
    }
  }
  cached = out;
  return out;
}

/** Every record the corpus lists, flattened, with the entry it came from. */
export function corpusRecords(): {
  from: string;
  entry: CorpusEntry['analysis']['records'][number];
}[] {
  return corpus().flatMap((e) => e.analysis.records.map((entry) => ({ from: e.name, entry })));
}
