// What the pointer is over, decided against real analyses.
//
// Four rules in order — a record's own name, a type name declared here, the
// type part of a member declaration, a bare name clang reported somewhere —
// and the last resort is a probe, which costs a full re-parse of the user's
// file. So "this is nothing" has to be a real answer, and each rule has to fire
// on the thing it is for.

import { describe, it, expect } from 'vitest';
import {
  subjectAt,
  describeRecord,
  widenToTemplateArgs,
  type HoverContext,
} from '$state/type-hover';
import { buildLineIndex } from '$state/code-locations';
import { corpus, type CorpusEntry } from './corpus';
import type { Analysis } from '$compiler/AbiAnalyzer';

/** The corpus entry whose source declares the names this suite is about. */
function entry(name: string): CorpusEntry {
  const found = corpus().find((e) => e.name.startsWith(name));
  expect(found, `corpus entry ${name}`).toBeDefined();
  return found!;
}

/** Everything `subjectAt` reads, wired the way the session wires it. */
function contextFor(analysis: Analysis): HoverContext {
  const models = new Map(
    analysis.records.filter((r) => r.listed).map((r) => [r.key, r.model] as const),
  );
  const knownSpellings = new Set<string>();
  for (const t of analysis.typedefs) knownSpellings.add(t.name);
  for (const n of analysis.byName.keys()) knownSpellings.add(n);
  for (const r of analysis.records) {
    for (const leaf of r.model.leaves) if (leaf.type) knownSpellings.add(leaf.type);
  }
  return { analysis, lines: buildLineIndex(models), knownSpellings };
}

/** Column of `needle` on `line` (1-based), from the source the response carries. */
function columnOf(analysis: Analysis, line: number, needle: string): number {
  const text = analysis.source.split('\n')[line - 1];
  expect(text, `line ${line}`).toBeDefined();
  const col = text!.indexOf(needle);
  expect(col, `"${needle}" on line ${line}: ${text}`).toBeGreaterThanOrEqual(0);
  return col + 1;
}

const at = (analysis: Analysis, line: number, word: string) => ({
  word,
  startColumn: columnOf(analysis, line, word),
});

describe('subjectAt', () => {
  // typedef struct { int a; long b; } Pair;   1
  // using u32 = unsigned int;                 2
  // typedef Pair PairAlias;                   3
  // struct S { Pair p; u32 n; };              4
  const names = entry('regression-type-names--x86_64-unknown-linux-gnu');
  const a = names.analysis;
  const ctx = contextFor(a);

  it('resolves a record written under the pointer', () => {
    const s = subjectAt(4, at(a, 4, 'S'), ctx);
    expect(s?.kind).toBe('records');
    expect(s?.kind === 'records' && s.records.map((r) => r.key)).toEqual(['struct S']);
  });

  it('resolves a type name to the record it names, not to a probe', () => {
    // `Pair` names an anonymous struct; the hover should land on the record
    // itself rather than measure the spelling.
    const s = subjectAt(1, at(a, 1, 'Pair'), ctx);
    expect(s?.kind).toBe('records');
    expect(s?.kind === 'records' && s.records[0]!.record.name).toBe('Pair');
  });

  it('resolves an alias of a record the same way', () => {
    const s = subjectAt(3, at(a, 3, 'PairAlias'), ctx);
    expect(s?.kind === 'records' && s.records[0]!.record.name).toBe('Pair');
  });

  it('measures a type name that names no record', () => {
    const s = subjectAt(2, at(a, 2, 'u32'), ctx);
    expect(s).toEqual({ kind: 'spelling', spelling: 'u32', alias: 'unsigned int' });
  });

  it('resolves the type part of a member declaration', () => {
    // `Pair p;` — the pointer is on `Pair`, left of the member's name.
    const s = subjectAt(4, at(a, 4, 'Pair p'), ctx);
    expect(s?.kind === 'records' && s.records[0]!.record.name).toBe('Pair');
  });

  it('is nothing for a member name, so hovering one costs no query', () => {
    // `p` is the member's own name, at its own column: rule 3 requires the
    // pointer to be left of it, and `p` is not a spelling clang reported.
    const info = ctx.lines.get(4);
    expect(info, 'line 4 declares members').toBeDefined();
    expect(subjectAt(4, { word: 'p', startColumn: info!.anchor.col }, ctx)).toBeNull();
  });

  it('is nothing for a word that names no type anywhere in the file', () => {
    // Line 2 declares no member, so no rule reaches for a type there.
    expect(subjectAt(2, { word: 'zzz', startColumn: 40 }, ctx)).toBeNull();
    expect(subjectAt(2, { word: 'using', startColumn: 1 }, ctx)).toBeNull();
  });

  it('describes a known type name wherever it is written', () => {
    // Rule 4 is deliberately position-independent: a name clang reported as a
    // type is that type in a comment, in a cast, or on a line of its own. The
    // position rules above exist to catch the cases where a *bare* name would
    // be wrong, not to confine this one.
    const s = subjectAt(99, { word: 'Pair', startColumn: 1 }, ctx);
    expect(s?.kind === 'records' && s.records[0]!.record.name).toBe('Pair');
  });

  it('names a library type through the member that uses it', () => {
    // `std::string s;` — a record no rule could find by name, reached because
    // the member carries its spelling and the analysis indexes it.
    const lib = entry('cpp-standard-library-libcpp--x86_64-unknown-linux-gnu').analysis;
    const c = contextFor(lib);
    const line = lib.source.split('\n').findIndex((l) => l.includes('std::string s;')) + 1;
    const s = subjectAt(line, at(lib, line, 'std::string'), c);
    expect(s?.kind === 'records' && s.records[0]!.record.name).toBe('std::string');
  });
});

describe('describeRecord', () => {
  const a = entry('padding-basics--x86_64-unknown-linux-gnu').analysis;

  it('counts the record’s own members and quotes its numbers', () => {
    const example = a.records.find((r) => r.key === 'struct Example')!;
    const md = describeRecord(example);
    expect(md).toContain('`struct Example`');
    expect(md).toContain('6 members');
    expect(md).toContain(`| sizeof | **${example.record.sizeBytes}** B |`);
    expect(md).toContain(`| padding | ${example.model.paddingBytes} B`);
  });

  it('says "1 member" rather than "1 members"', () => {
    const one = corpus()
      .flatMap((e) => e.analysis.records)
      .find((r) => r.model.leaves.length === 1 && r.model.groups.length === 0);
    expect(one, 'a one-member record somewhere in the corpus').toBeDefined();
    expect(describeRecord(one!)).toContain('1 member\n');
  });
});

describe('widenToTemplateArgs', () => {
  const at = (text: string, word: string) => {
    const startColumn = text.indexOf(word) + 1;
    return widenToTemplateArgs(text, {
      word,
      startColumn,
      endColumn: startColumn + word.length,
    });
  };

  it('takes in the arguments written after the name', () => {
    expect(at('Pair<char>   pc;', 'Pair').word).toBe('Pair<char>');
    expect(at('Pair<double> pd;', 'Pair').word).toBe('Pair<double>');
  });

  it('counts depth, so a nested closing `>>` is two brackets', () => {
    expect(at('Pair<Pair<int>> p;', 'Pair').word).toBe('Pair<Pair<int>>');
    expect(at('std::map<int, std::vector<char>> m;', 'map').word).toBe(
      'map<int, std::vector<char>>',
    );
  });

  it('covers exactly what it widened to', () => {
    const w = at('  Pair<char> pc;', 'Pair');
    expect('  Pair<char> pc;'.slice(w.startColumn - 1, w.endColumn - 1)).toBe('Pair<char>');
  });

  it('leaves a word alone when nothing follows it', () => {
    expect(at('int x;', 'int').word).toBe('int');
    expect(at('Pair p;', 'Pair').word).toBe('Pair');
  });

  it('is not fooled by a comparison', () => {
    // Written without spaces, so the `<` really is the next character and the
    // guard is what has to reject it: `a<b` is a comparison, unclosed by the
    // end of the statement, and there are no arguments here to take in.
    expect(at('bool ok = a<b;', 'a').word).toBe('a');
    expect(at('if (a<b) { c(); }', 'a').word).toBe('a');
    // Nor by one that never closes at all.
    expect(at('x = a<b', 'a').word).toBe('a');
  });
});
