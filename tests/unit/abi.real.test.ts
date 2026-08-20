// End to end through the artifact that ships.
//
// Every other suite either runs on recorded answers or on hand-built models.
// This one asks the real module real questions and checks the numbers against
// what the ABIs say — the evidence that the recording and the reality still
// agree, and the only test that would notice a module rebuilt from a different
// clang answering differently.
//
// Needs a built module:
//   cd ~/clang-abi-wasm && scripts/build.sh wasm
// Skipped otherwise.

import { describe, it, expect, beforeAll } from 'vitest';
import { AbiAnalyzer } from '$compiler/AbiAnalyzer';
import { buildLineIndex } from '$state/code-locations';
import { directMembers } from '$core/render';
import { DEFAULT_OPTIONS, defaultStdFor, type CompileOptions } from '$core/options';
import { EXAMPLES, TARGET_GROUPS } from '$core/targets';
import { abiModule, moduleAvailable } from './abi-module';

const opts = (over: Partial<CompileOptions> = {}): CompileOptions => ({
  ...DEFAULT_OPTIONS,
  lang: 'c',
  std: defaultStdFor('c'),
  triple: 'x86_64-unknown-linux-gnu',
  ...over,
});
const cxx = (over: Partial<CompileOptions> = {}) =>
  opts({ lang: 'c++', std: defaultStdFor('c++'), ...over });

describe.skipIf(!moduleAvailable)('the real module', () => {
  let abi: AbiAnalyzer;
  beforeAll(async () => {
    abi = new AbiAnalyzer(await abiModule());
  }, 300_000);

  it('reports the clang it was built from', async () => {
    expect(await abi.version()).toMatch(/clang version \d+/);
  });

  it('enumerates far more targets than any curated list', async () => {
    const targets = await abi.targets();
    // The app ships ~40 curated triples; the build knows every architecture
    // clang has a TargetInfo for, which is the list no flag exposes.
    expect(targets.length).toBeGreaterThan(20);
    for (const arch of ['x86_64', 'aarch64', 'riscv64', 'wasm32']) {
      expect(targets, arch).toContain(arch);
    }
  });

  it('lays out a plain struct the way the ABI does', async () => {
    const a = await abi.analyze('struct S { char c; int i; double d; };\n', opts());
    expect(a.code).toBe(0);
    const s = a.records[0]!;
    expect(s.key).toBe('struct S');
    expect(s.record.sizeBytes).toBe(16);
    expect(s.record.align).toBe(8);
    expect(s.model.paddingBytes).toBe(3);
    expect(s.model.leaves.map((l) => [l.name, l.offsetBits / 8, l.sizeBits / 8])).toEqual([
      ['c', 0, 1],
      ['i', 4, 4],
      ['d', 8, 8],
    ]);
  });

  it('answers for the target it is asked about, not the host', async () => {
    const source = 'struct S { void *p; long l; };\n';
    const sizes: Record<string, number> = {};
    for (const triple of [
      'x86_64-unknown-linux-gnu',
      'i386-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
      'avr-unknown-unknown',
    ]) {
      const a = await abi.analyze(source, opts({ triple }));
      sizes[triple] = a.records[0]!.record.sizeBytes;
    }
    // LP64, ILP32, LLP64 and an 8-bit target: four data models, four answers.
    expect(sizes).toEqual({
      'x86_64-unknown-linux-gnu': 16,
      'i386-unknown-linux-gnu': 8,
      'x86_64-pc-windows-msvc': 16,
      'avr-unknown-unknown': 6,
    });
  });

  it('places a virtual base where the ABI puts it, and says so', async () => {
    const a = await abi.analyze(
      'struct Base { int a; };\nstruct Mixin { char m; };\n' +
        'struct Derived : virtual Base, Mixin { double d; };\n',
      cxx(),
    );
    expect(a.code).toBe(0);
    const d = a.records.find((r) => r.key === 'struct Derived')!;
    const vbase = d.model.groups.find((g) => g.kind === 'vbase' || g.kind === 'primary-vbase');
    expect(vbase, 'the virtual base is a group of its own').toBeDefined();
    expect(vbase!.name).toBe('virtual Base');
    // Itanium puts a virtual base last, after the fields declared before it.
    const dField = d.model.leaves.find((l) => l.name === 'd')!;
    expect(vbase!.offsetBits).toBeGreaterThan(dField.offsetBits);
    // And it covers bytes, so hovering it lights the diagram.
    expect(vbase!.leafIndexes.length).toBeGreaterThan(0);
  });

  it('carries the source range of a base specifier — which no clang dump emits', async () => {
    const a = await abi.analyze('struct B { int b; };\nstruct D : public B { int d; };\n', cxx());
    const base = a.records.find((r) => r.key === 'struct D')!.model.groups.find((g) => g.isBase)!;
    expect(base.location, 'a base has a written position').not.toBeNull();
    expect(base.location).toMatchObject({ line: 2, endLine: 2 });
  });

  it('measures a member of a library type without a probe compile', async () => {
    const a = await abi.analyze('#include <string>\nstruct S { std::string s; int i; };\n', cxx());
    expect(a.code, a.diagnosticsText).toBe(0);
    const s = a.records.find((r) => r.key === 'struct S')!;
    // Only the user's record is listed; libc++'s thousand are reachable by id.
    expect(a.records.map((r) => r.key)).toEqual(['struct S']);
    const str = s.model.groups.find((g) => g.name === 's')!;
    expect(str.sizeBits / 8).toBe(24); // libc++'s three-pointer std::string on LP64
    expect(str.recordId, 'drilling in resolves by id, not by name').not.toBeNull();
    expect(a.byId.get(str.recordId!)!.record.qualifiedName).toMatch(/basic_string/);
  });

  it('reports errors as structure and as the text clang would have printed', async () => {
    const a = await abi.analyze('struct S { int x; };\nint bad = ;\n', opts());
    expect(a.code).not.toBe(0);
    expect(a.diagnostics).toEqual([
      { line: 2, column: 11, endColumn: 12, severity: 'error', message: 'expected expression' },
    ]);
    // The rendered form keeps the caret and the colour, so nothing re-renders it.
    expect(a.diagnosticsText).toMatch(/input\.c:2:11/);
    expect(a.diagnosticsText).toMatch(/\^/);
    expect(a.diagnosticsText).toContain('\x1b[');
    // A partial answer is still an answer: the record before the error is there.
    expect(a.records.map((r) => r.key)).toContain('struct S');
  });

  it('names types the user declared, with what they resolve to', async () => {
    const a = await abi.analyze(
      'typedef struct { int a; long b; } Pair;\nusing u32 = unsigned int;\n',
      cxx(),
    );
    const pair = a.typedefs.find((t) => t.name === 'Pair')!;
    expect(pair.recordId, 'a typedef of a record points at it').not.toBeNull();
    expect(a.byId.get(pair.recordId!)!.record.name).toBe('Pair');
    const u32 = a.typedefs.find((t) => t.name === 'u32')!;
    expect([u32.sizeBits, u32.align, u32.canonicalType]).toEqual([32, 4, 'unsigned int']);
  });

  it('measures an arbitrary type spelling on demand', async () => {
    const a = await abi.analyze('struct S { int x; };\ntypedef S *Handle;\n', cxx());
    expect(await abi.probeSpelling(a, 'Handle')).toEqual({ bits: 64, align: 8 });
    expect(await abi.probeSpelling(a, 'double[3]')).toEqual({ bits: 192, align: 8 });
    expect(await abi.probeSpelling(a, 'not_a_type')).toBeNull();
  });

  it('honours the layout-affecting options', async () => {
    const source = 'struct S { char c; int i; };\n';
    const plain = await abi.analyze(source, opts());
    const packed = await abi.analyze(source, opts({ pack: '1' }));
    expect(plain.records[0]!.record.sizeBytes).toBe(8);
    expect(packed.records[0]!.record.sizeBytes).toBe(5);
    // An enum's size follows -fshort-enums, which is an option, not a flag the
    // user typed — so it has to survive the request.
    const short_ = await abi.analyze(
      'enum E { A = 1 };\nstruct S { enum E e; };\n',
      opts({ shortEnums: true }),
    );
    expect(short_.records.find((r) => r.key === 'struct S')!.record.sizeBytes).toBe(1);
  });

  it('lays out every triple the app offers', async () => {
    // The dropdown is a curated list and the module is not — a triple in the
    // list that this build cannot construct a target for is a menu entry that
    // fails when picked, and nothing else would notice.
    // Not checked against `targets()`: that lists canonical architecture names
    // (`x86`, `arm`), while a triple may spell one as `i686` or `armv7a`. What
    // matters is whether the query works, so the check is to run it.
    const triples = TARGET_GROUPS.flatMap((g) => g.targets.map((t) => t.triple));
    expect(triples.length).toBeGreaterThan(30);
    const broken: string[] = [];
    for (const triple of triples) {
      const a = await abi.analyze('struct S { char c; int i; void *p; };\n', opts({ triple }));
      if (a.code !== 0 || a.records[0]?.record.sizeBytes === undefined) {
        const said = a.diagnosticsText.split('\n').filter((l) => l.trim() !== '');
        broken.push(`${triple}: ${said[0] ?? 'no record'}`);
      }
    }
    expect(broken).toEqual([]);
  }, 120_000);

  // The whole app, over everything the site ships: analyse, model, index. Not
  // an assertion about any one layout — an assertion that nothing in the chain
  // from wasm to the editor's gutter throws or comes back empty.
  for (const ex of EXAMPLES) {
    it(`drives the app end to end: ${ex.name}`, async () => {
      const options = opts({ lang: ex.lang, std: defaultStdFor(ex.lang) });
      const a = await abi.analyze(ex.source, options);
      expect(a.code, a.diagnosticsText).toBe(0);

      const listed = a.records.filter((r) => r.listed);
      expect(listed.length, 'the example shows something').toBeGreaterThan(0);

      for (const r of listed) {
        expect(r.model.record.sizeBytes, r.key).toBeGreaterThanOrEqual(0);
        // Every record the user sees has members it can show.
        if (r.record.sizeBytes > 0 && !r.record.isEmpty) {
          expect(directMembers(r.model).length, `${r.key}: has members`).toBeGreaterThan(0);
        }
      }

      const index = buildLineIndex(new Map(listed.map((r) => [r.key, r.model])));
      expect(index.size, 'the editor has something to mark').toBeGreaterThan(0);
    }, 60_000);
  }
});
