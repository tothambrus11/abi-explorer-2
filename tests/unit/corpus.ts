// A corpus of *real* clang record layouts, for tests that want the shapes the
// compiler actually emits rather than the ones a generator thinks to build.
//
// Generated records cover breadth — every combination of bit-field, base and
// nesting the arbitraries can reach. They do not cover the shapes that only
// arise from real ABI rules: libc++'s short-string union, MSVC vbtable
// pointers, a primary base absorbed at offset zero. This corpus supplies those,
// and the two feed the same property tests side by side.
//
// Sources are the examples shipped on the site (imported from $core/targets, so
// adding one to the site adds it here) plus regression sources kept because
// they once broke something. Their dumps are captured by
// `tests/unit/corpus.capture.test.ts` (`npm run fixtures`) into
// tests/fixtures/layouts/, so the suite itself never needs clang.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES } from '$core/targets';
import type { Language } from '$core/options';
import { parseRecordLayouts } from '$core/layout-parser';
import type { RecordLayout } from '$core/types';

export const LAYOUTS_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'layouts');
const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures');

/** One translation unit to capture layouts for. */
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
  return name
    .toLowerCase()
    // Keep the language visible: stripping punctuation alone would turn
    // "C++ virtual bases" into "c-virtual-bases".
    .replace(/\+\+/g, 'pp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function layoutFile(name: string, triple: string): string {
  return path.join(LAYOUTS_DIR, `${name}--${triple}.txt`);
}

/** A captured dump, parsed. */
export interface CorpusEntry {
  /** "<source>--<triple>", used in assertion messages. */
  name: string;
  records: RecordLayout[];
}

/** Captured dumps that are missing from disk (someone added a source and did not capture). */
export function missingCaptures(): string[] {
  const missing: string[] = [];
  for (const src of corpusSources()) {
    for (const triple of src.triples) {
      if (!existsSync(layoutFile(src.name, triple))) missing.push(`${src.name}--${triple}`);
    }
  }
  return missing;
}

let cached: CorpusEntry[] | null = null;

/**
 * Every real layout available to the tests: the captured example dumps, plus
 * the layout passes already recorded inside the analyzer fixtures. Parsed once.
 */
export function corpus(): CorpusEntry[] {
  if (cached) return cached;
  const out: CorpusEntry[] = [];

  if (existsSync(LAYOUTS_DIR)) {
    for (const file of readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith('.txt')).sort()) {
      const records = parseRecordLayouts(readFileSync(path.join(LAYOUTS_DIR, file), 'utf8'));
      if (records.length) out.push({ name: file.replace(/\.txt$/, ''), records });
    }
  }

  // The analyzer fixtures already hold real layout passes; no reason to capture
  // those shapes twice.
  for (const file of readdirSync(FIXTURES_DIR).filter(
    (f) => f.endsWith('.json') && f !== 'index.json',
  )) {
    const fx = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf8')) as {
      calls: { out: { stdout: string } }[];
    };
    fx.calls.forEach((call, i) => {
      const records = parseRecordLayouts(call.out.stdout);
      if (records.length) out.push({ name: `${file}#${i}`, records });
    });
  }

  cached = out;
  return out;
}

/** Every record in the corpus, flattened, with the entry it came from. */
export function corpusRecords(): { from: string; record: RecordLayout }[] {
  return corpus().flatMap((e) => e.records.map((record) => ({ from: e.name, record })));
}
