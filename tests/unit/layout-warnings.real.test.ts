// The reorder warning, on what the real module answers: the language server's
// rules (`@abi-explorer/shared/reorder`, tested there on hand-built records)
// read off the app's own model, which is where a mistake here would be.
//
// Needs a built module; skipped otherwise (see `abi-module.ts`).

import { describe, it, expect, beforeAll } from 'vitest';
import { AbiAnalyzer } from '$compiler/AbiAnalyzer';
import { DEFAULT_OPTIONS, defaultStdFor, type CompileOptions } from '$core/options';
import { layoutWarnings, type LayoutFix } from '$state/layout-warnings';
import { abiModule, moduleAvailable } from './abi-module';

const c: CompileOptions = {
  ...DEFAULT_OPTIONS,
  lang: 'c',
  std: defaultStdFor('c'),
  triple: 'x86_64-unknown-linux-gnu',
};
const cxx: CompileOptions = { ...c, lang: 'c++', std: defaultStdFor('c++') };

/** The text with the fix's edits applied, as Monaco would (they never overlap). */
function apply(text: string, fix: LayoutFix): string {
  const lines = text.split('\n');
  const offset = (line: number, col: number) =>
    lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  const edits = fix.edits
    .map((e) => ({
      start: offset(e.span.line, e.span.col),
      end: offset(e.span.endLine, e.span.endCol),
      text: e.text,
    }))
    .sort((a, b) => b.start - a.start);
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

describe.skipIf(!moduleAvailable)('the reorder warning', () => {
  let abi: AbiAnalyzer;
  beforeAll(async () => {
    abi = new AbiAnalyzer(await abiModule());
  }, 300_000);

  const warnings = async (source: string, options = c) =>
    layoutWarnings(await abi.analyze(source, options));

  it('warns on the name of a record that wastes space, with both fixes', async () => {
    const source = 'struct Packet {\n  char a;\n  double b;\n  char c;\n};\n';
    const [w, ...rest] = await warnings(source);
    expect(rest).toEqual([]);
    expect(w!.message).toBe(
      'Packet would take 16 B instead of 24 B with its members ordered as b, a, c.',
    );
    expect(w!.span).toEqual({ line: 1, col: 8, endLine: 1, endCol: 14 });
    expect(w!.fixes.map((f) => [f.title, f.preferred])).toEqual([
      ['Reorder members by alignment (24 B → 16 B)', true],
      ['Keep this member order', false],
    ]);
    expect(apply(source, w!.fixes[0]!)).toBe(
      'struct Packet {\n  double b;\n  char a;\n  char c;\n};\n',
    );
    const kept = apply(source, w!.fixes[1]!);
    expect(kept).toBe('// abi-explorer: keep order\n' + source);
    expect(await warnings(kept)).toEqual([]);
  });

  it('puts the warning of a typedef-named struct on the typedef name', async () => {
    const [w] = await warnings('typedef struct {\n  char a;\n  double b;\n  char c;\n} Pair;\n');
    expect(w!.span).toEqual({ line: 5, col: 3, endLine: 5, endCol: 7 });
    expect(w!.fixes).toHaveLength(2);
  });

  it('says nothing where the order costs nothing or the model cannot reproduce it', async () => {
    expect(await warnings('struct S { double b; char a; char c; };\n')).toEqual([]);
    // An `alignas` on a member is not in its alignment as reported.
    expect(
      await warnings('struct S { char a; _Alignas(16) char b; double c; char d; };\n'),
    ).toEqual([]);
    expect(await warnings('struct S { char a; int x : 3; double b; char c; };\n')).toEqual([]);
    expect(
      await warnings('struct B { char x; };\nstruct D : B { double b; char c; };\n', cxx),
    ).toEqual([]);
  });

  it('splits a line declaring several members to reorder them', async () => {
    const source = 'struct S {\n  char a; double b; char c;\n};\n';
    const [w] = await warnings(source);
    expect(apply(source, w!.fixes[0]!)).toBe('struct S {\n  double b;\n  char a;\n  char c;\n};\n');
    const declarators = 'struct T {\n  char a;\n  double *b, d;\n  char c;\n};\n';
    const [x] = await warnings(declarators);
    expect(apply(declarators, x!.fixes[0]!)).toBe(
      'struct T {\n  double *b;\n  double d;\n  char a;\n  char c;\n};\n',
    );
    // Where it cannot be split, only the comment fixes it.
    const [v] = await warnings(
      'struct S {\n  char a; static int n; double b;\n  char c;\n};\n',
      cxx,
    );
    expect(v!.fixes.map((f) => f.title)).toEqual(['Keep this member order']);
  });
});
