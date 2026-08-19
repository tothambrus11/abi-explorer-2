// Integration test against the real wasm clang (Node). Skipped unless
// ABIX_REAL_CLANG=1 (downloads ~27 MB once into .cache/).
import { describe, it, expect, beforeAll } from 'vitest';
import { Analyzer } from '$compiler/Analyzer';
import { DEFAULT_OPTIONS } from '$core/options';
import { buildRenderModel } from '$core/model';
import { buildLayoutTree } from '$core/tree';
import { matchItemsToLocations, unqualifiedName } from '$core/ast-locations';
import type { Compiler } from '$compiler/Compiler';

const enabled = process.env['ABIX_REAL_CLANG'] === '1';

describe.skipIf(!enabled)('Analyzer with real clang', () => {
  let analyzer: Analyzer;
  beforeAll(async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    analyzer = new Analyzer((await createNodeCompiler()) as Compiler);
  }, 300_000);

  it('probes are immune to packing state left open at the end of the TU', async () => {
    const src = `#pragma pack(1)\nstruct S { char c; int i; long l; };`;
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      triple: 'x86_64-unknown-linux-gnu',
    });
    const m = buildRenderModel(
      a.userRecords.find((r) => r.name === 'S')!,
      a,
    );
    expect(m.leaves.map((l) => [l.name, l.sizeBits, l.align])).toEqual([
      ['c', 8, 1],
      ['i', 32, 4],
      ['l', 64, 8],
    ]);
  }, 120_000);

  it('measures members of records in anonymous namespaces (C++)', async () => {
    const src = `namespace { struct S { char c; int i; }; }\nS s;`;
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-unknown-linux-gnu',
    });
    const rec = a.userRecords.find((r) => r.name.endsWith('S'))!;
    const m = buildRenderModel(rec, a);
    expect(m.leaves.map((l) => [l.name, l.sizeBits, l.align, l.estimated])).toEqual([
      ['c', 8, 1, false],
      ['i', 32, 4, false],
    ]);
    expect(a.unmeasured).toEqual([]);
  }, 120_000);

  it('measures every field of a C struct on x86-64 and AVR', async () => {
    const src = `#include <stdint.h>
typedef void (*Cb)(int);
enum Color { RED };
typedef struct { uint16_t x; } Point;
struct Widget { uint8_t tag; enum Color color; Cb callback; Point pt; uint32_t big; char name[5]; };`;
    for (const [triple, expectSize] of [
      ['x86_64-unknown-linux-gnu', 32],
      ['avr-unknown-unknown', 16],
    ] as const) {
      const a = await analyzer.analyze(src, { ...DEFAULT_OPTIONS, triple });
      const w = a.userRecords.find((r) => r.name === 'Widget')!;
      expect(w.sizeBytes).toBe(expectSize);
      const m = buildRenderModel(w, a);
      expect(m.leaves.map((l) => l.name)).toEqual(['tag', 'color', 'callback', 'x', 'big', 'name']);
      expect(m.leaves.every((l) => !l.estimated)).toBe(true);
      expect(a.unmeasured).toEqual([]);
      const cb = m.leaves.find((l) => l.name === 'callback')!;
      expect(cb.sizeBits).toBe(triple.startsWith('avr') ? 16 : 64);
      expect(cb.align).toBe(triple.startsWith('avr') ? 1 : 8);
    }
  }, 120_000);

  it('handles C++ private members, bases, unions, anonymous members', async () => {
    const src = `class Secret { class Inner { char c[3]; }; Inner priv; public: int pub; };
struct Base { virtual ~Base(); int x; };
struct D : virtual Base { double d; };
union Mix { char raw[13]; struct { short a; int b; } s; };
struct Msg { struct { unsigned char lo, hi; }; Mix m; };`;
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-pc-windows-msvc',
    });
    expect(a.code).toBe(0);
    const secret = buildRenderModel(
      a.userRecords.find((r) => r.name === 'Secret')!,
      a,
    );
    expect(secret.leaves.find((l) => l.name === 'c')!.estimated).toBe(false); // private, via -Dprivate=public
    const d = buildRenderModel(
      a.userRecords.find((r) => r.name === 'D')!,
      a,
    );
    expect(d.leaves.map((l) => l.name)).toEqual([
      'D vbtable pointer',
      'd',
      'Base vftable pointer',
      'x',
    ]);
    expect(d.paddingBytes).toBe(4);
    const msg = buildRenderModel(
      a.userRecords.find((r) => r.name === 'Msg')!,
      a,
    );
    expect(msg.leaves.map((l) => l.name)).toEqual(['lo', 'hi', 'raw', 'a', 'b']);
    expect(msg.groups.map((g) => g.name)).toEqual(['(anonymous)', 's', 'm']);
    expect(msg.groups.find((g) => g.name === 'm')!.sizeBits).toBe(16 * 8);
    expect(a.unmeasured).toEqual([]);

    const locs = (await analyzer.locate(a, ['Msg', 'Mix'])).fields;
    const lines = matchItemsToLocations(msg.leaves, locs);
    expect([...lines.values()].map((l) => l.line)).toEqual([5, 5, 4, 4, 4]);
    expect(locs.find((l) => l.name === 'raw')!.qualType).toBe('char[13]');
    expect(unqualifiedName('ns::Tpl<int>')).toBe('Tpl');
  }, 120_000);

  it('measures function-local and typedef-anonymous records through AST field types', async () => {
    const src = `#include <stdint.h>\ntypedef struct { char c; int i; } T;\nvoid f(void) { struct L { char c; uint64_t u; } l; (void)l; }\n`;
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      triple: 'x86_64-unknown-linux-gnu',
    });
    const t = a.userRecords.find((r) => r.name.startsWith('(unnamed'))!;
    const l = a.userRecords.find((r) => r.name === 'L')!;
    expect(
      buildRenderModel(t, a).leaves.map((x) => [x.name, x.sizeBits, x.align, x.estimated]),
    ).toEqual([
      ['c', 8, 1, false],
      ['i', 32, 4, false],
    ]);
    expect(buildRenderModel(t, a).paddingBytes).toBe(3);
    expect(
      buildRenderModel(l, a).leaves.map((x) => [x.name, x.sizeBits, x.align, x.estimated]),
    ).toEqual([
      ['c', 8, 1, false],
      ['u', 64, 8, false],
    ]);
    expect(a.unmeasured).toEqual([]);
  }, 120_000);

  it('reports per-member alignment from _Alignas / alignas, not just the type', async () => {
    const src = `#include <stdint.h>\nstruct Aligned { _Alignas(16) uint8_t buf[10]; uint32_t n; };\n`;
    // Probes measure the member's type; the explicit alignment comes from the AST (AlignedAttr).
    const alignsOf = async (an: Awaited<ReturnType<typeof analyzer.analyze>>, owners: string[]) => {
      const info = await analyzer.locate(an, owners);
      const m = new Map<string, number>();
      for (const f of info.fields) {
        if (f.alignAttr !== undefined) m.set(f.owner + ' ' + f.name, f.alignAttr);
      }
      return m;
    };
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      triple: 'x86_64-unknown-linux-gnu',
    });
    const rec = a.userRecords.find((r) => r.name === 'Aligned')!;
    expect(buildRenderModel(rec, a).leaves.map((l) => l.align)).toEqual([1, 4]); // type alignment only
    const m = buildRenderModel(rec, { ...a, memberAligns: await alignsOf(a, ['Aligned']) });
    expect(m.leaves.map((l) => [l.name, l.sizeBits / 8, l.align])).toEqual([
      ['buf', 10, 16],
      ['n', 4, 4],
    ]);
    const cxx = await analyzer.analyze('struct S { alignas(32) char c; int i; };\n', {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-unknown-linux-gnu',
    });
    const cm = buildRenderModel(cxx.userRecords[0]!, {
      ...cxx,
      memberAligns: await alignsOf(cxx, ['S']),
    });
    expect(cm.leaves.map((l) => [l.name, l.align])).toEqual([
      ['c', 32],
      ['i', 4],
    ]);
  }, 120_000);

  it('shows user structs regardless of name, hides only compiler builtins', async () => {
    // `__`-prefixed names are common in embedded/kernel code and must not be hidden.
    const a = await analyzer.analyze(
      'struct __packet { int hdr; char body[8]; };\nstruct tm_like { int a, b; };\n',
      { ...DEFAULT_OPTIONS, triple: 'x86_64-unknown-linux-gnu' },
    );
    const names = a.userRecords.map((r) => r.name);
    expect(names).toContain('__packet');
    expect(names).toContain('tm_like');
    expect(names).not.toContain('__va_list_tag'); // a compiler builtin
    expect(a.builtinRecords.has('__va_list_tag')).toBe(true);
    const m = buildRenderModel(
      a.userRecords.find((r) => r.name === '__packet')!,
      a,
    );
    expect(m.leaves.map((l) => [l.name, l.align])).toEqual([
      ['hdr', 4],
      ['body', 1],
    ]);
  }, 120_000);

  it('resolves records in anonymous namespaces (C++) to their real names', async () => {
    const src = 'namespace { struct N { char c; double d; }; }\nN n;\n';
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-unknown-linux-gnu',
    });
    const rec = a.userRecords.find((r) =>
      /(^|::)N$/.test(r.name.replace(/\(anonymous namespace\)::/g, '')),
    )!;
    expect(rec).toBeDefined();
    const m = buildRenderModel(rec, a);
    expect(m.leaves.map((l) => [l.name, l.sizeBits / 8, l.align, l.estimated])).toEqual([
      ['c', 1, 1, false],
      ['d', 8, 8, false],
    ]);
    expect(a.unmeasured).toEqual([]);
  }, 120_000);

  it('maps members to the right source line for same-named records in different scopes', async () => {
    const src = `struct A { struct S { int x; } s; };
struct B { struct S { double y; } s; };
A a; B b;
`;
    const an = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-unknown-linux-gnu',
    });
    const info = await analyzer.locate(an, ['A', 'B']);
    const modelA = buildRenderModel(
      an.userRecords.find((r) => r.name === 'A')!,
      an,
    );
    const modelB = buildRenderModel(
      an.userRecords.find((r) => r.name === 'B')!,
      an,
    );
    const lineOf = (m: ReturnType<typeof buildRenderModel>, field: string) =>
      matchItemsToLocations(m.leaves, info.fields).get(m.leaves.findIndex((l) => l.name === field))
        ?.line;
    expect(lineOf(modelA, 'x')).toBe(1); // A::S::x on line 1
    expect(lineOf(modelB, 'y')).toBe(2); // B::S::y on line 2 (not A's line)
  }, 120_000);

  // Issue #2: libc++ headers include the C library, which this toolchain ships
  // only under wasm32-wasip1 — without mapping it in, <string>/<vector> failed
  // with "bits/alltypes.h file not found" on every non-WASI target.
  it('C++ standard library headers resolve and their types are measured', async () => {
    const src = `#include <string>
#include <vector>
#include <cstdint>
struct S { std::string s; std::vector<int> v; uint32_t n; };`;
    const a = await analyzer.analyze(src, {
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'gnu++20',
      triple: 'x86_64-unknown-linux-gnu',
    });
    expect(a.diagnosticsText).not.toMatch(/file not found/);
    expect(a.code).toBe(0);
    const m = buildRenderModel(
      a.userRecords.find((r) => r.name === 'S')!,
      a,
    );
    expect(m.record.sizeBytes).toBe(56);
    // libc++ on Itanium/x86-64: string and vector are 24 B each, aligned 8 —
    // measured through their own records, not estimated.
    const g = (name: string) => m.groups.find((x) => x.name === name && x.path.length === 0)!;
    expect([g('s').sizeBits! / 8, g('s').align]).toEqual([24, 8]);
    expect([g('v').sizeBits! / 8, g('v').align]).toEqual([24, 8]);
    expect(m.leaves.find((l) => l.name === 'n')!.offsetBits / 8).toBe(48);
    // The declared members are the tree's top level; every libc++ internal
    // (string's SSO union, vector's pointers) nests underneath.
    const top = buildLayoutTree(m).map((n) =>
      n.kind === 'group' ? m.groups[n.ref]!.name : m.leaves[n.ref]!.name,
    );
    expect(top).toEqual(['s', 'v', 'n']);
    expect(m.leaves.every((l) => !l.estimated)).toBe(true);
  }, 120_000);

  it('probes arbitrary spellings', async () => {
    const a = await analyzer.analyze('typedef unsigned long long ull;', {
      ...DEFAULT_OPTIONS,
      triple: 'i386-unknown-linux-gnu',
    });
    expect(await analyzer.probeSpelling(a, 'ull')).toEqual({ bits: 64, align: 4 });
    expect(await analyzer.probeSpelling(a, 'long double')).toEqual({ bits: 96, align: 4 });
    expect(await analyzer.probeSpelling(a, 'no_such_type')).toBeNull();
  }, 120_000);
});
