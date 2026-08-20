// The same laws as `properties.test.ts`, over programs nobody wrote.
//
// The corpus covers the shapes real ABIs produce; this covers the ones nobody
// thought to write down. A generator emits record declarations — bit-fields
// straddling storage units, empty bases, virtual inheritance, anonymous
// aggregates, over-aligned members, packed structs — the module compiles them
// for real, and every law in `model-laws.ts` runs on the answer.
//
// It generates *source*, not layouts. A generator that invented layouts could
// only produce what its author already believed clang does; a generator that
// produces programs finds out.
//
// Needs a built module:
//   cd ~/clang-abi-wasm && scripts/build.sh wasm
// Skipped otherwise.

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { AbiAnalyzer } from '$compiler/AbiAnalyzer';
import { DEFAULT_OPTIONS, defaultStdFor, type CompileOptions } from '$core/options';
import { modelLaws, type Subject } from './model-laws';
import { abiModule, moduleAvailable } from './abi-module';

// ------------------------------------------------------------- generator --

const SCALARS = [
  'char',
  'signed char',
  'unsigned char',
  'short',
  'unsigned short',
  'int',
  'unsigned int',
  'long',
  'unsigned long',
  'long long',
  'float',
  'double',
  'long double',
  // `bool` is a keyword in C++ and a <stdbool.h> macro in C before C23; the
  // prelude gives both languages the same spelling.
  'boolean',
  'void *',
  // Spelled through a typedef: `void (*)() name;` is not how a declarator
  // works, and the generator writes `<type> <name>;`.
  'fnptr',
];

interface Member {
  render: (name: string) => string;
}

/** A record already declared above, spelled the way this language needs. */
interface Available {
  /** How to write the type: `R0` in C++, `struct R0` in C. */
  spelling: string;
  name: string;
  /** A union cannot be a base class. */
  isUnion: boolean;
}

/** One member declaration, given the records already available above it. */
function memberArb(available: Available[], cxx: boolean): fc.Arbitrary<Member> {
  const scalar = fc.constantFrom(...SCALARS);
  const options: fc.Arbitrary<Member>[] = [
    // A plain field.
    scalar.map((t) => ({ render: (n: string) => `  ${t} ${n};` })),
    // An array, which pushes alignment and size apart.
    fc
      .tuple(scalar, fc.integer({ min: 1, max: 6 }))
      .map(([t, k]) => ({ render: (n: string) => `  ${t} ${n}[${k}];` })),
    // A bit-field, including the widths that straddle a storage unit.
    fc
      .tuple(
        fc.constantFrom('unsigned int', 'int', 'unsigned char', 'unsigned long long'),
        fc.integer({ min: 1, max: 33 }),
      )
      .map(([t, w]) => ({
        // Clamp to something the type can actually hold, or clang rejects it.
        render: (n: string) => {
          const cap = t.includes('char') ? 8 : t.includes('long long') ? 64 : 32;
          return `  ${t} ${n} : ${Math.min(w, cap)};`;
        },
      })),
    // A zero-width bit-field: a unit break with no storage of its own.
    fc.constant({ render: () => `  unsigned int : 0;` }),
    // An explicitly over-aligned member. The GNU attribute rather than
    // `alignas`, which C spells differently before C23.
    fc.tuple(scalar, fc.constantFrom(2, 4, 8, 16)).map(([t, a]) => ({
      render: (n: string) => `  ${t} ${n} __attribute__((aligned(${a})));`,
    })),
    // An anonymous aggregate, whose fields become members of the enclosing
    // record — the case where a path cannot name what it passes through.
    fc
      .tuple(fc.constantFrom('struct', 'union'), fc.array(scalar, { minLength: 1, maxLength: 3 }))
      .map(([kind, ts]) => ({
        render: (n: string) => `  ${kind} { ${ts.map((t, i) => `${t} ${n}_${i};`).join(' ')} };`,
      })),
  ];
  if (available.length) {
    // A record-typed member: the containment the whole model is about.
    options.push(
      fc
        .constantFrom(...available)
        .map((t) => ({ render: (n: string) => `  ${t.spelling} ${n};` })),
    );
    // An array of one, which puts a record's tail padding in the middle of
    // another record rather than at its end.
    options.push(
      fc
        .tuple(fc.constantFrom(...available), fc.integer({ min: 1, max: 3 }))
        .map(([t, k]) => ({ render: (n: string) => `  ${t.spelling} ${n}[${k}];` })),
    );
    // An over-aligned record member: the alignment comes from the declaration
    // and the size from the type, and they disagree on purpose.
    options.push(
      fc.tuple(fc.constantFrom(...available), fc.constantFrom(16, 32)).map(([t, a]) => ({
        render: (n: string) => `  ${t.spelling} ${n} __attribute__((aligned(${a})));`,
      })),
    );
  }
  if (cxx) {
    options.push(fc.constant({ render: (n: string) => `  [[no_unique_address]] Empty ${n};` }));
  }
  return fc.oneof(...options);
}

interface Decl extends Available {
  text: string;
}

/** One record: optional bases, then members. */
function declArb(index: number, available: Available[], cxx: boolean): fc.Arbitrary<Decl> {
  const name = `R${index}`;
  // Only a class can be a base, and only in C++.
  const baseArb = cxx
    ? fc.array(
        fc.tuple(
          fc.constantFrom(
            'Empty',
            'Poly',
            ...available.filter((a) => !a.isUnion).map((a) => a.name),
          ),
          fc.boolean(),
        ),
        { maxLength: 3 },
      )
    : fc.constant<[string, boolean][]>([]);
  return fc
    .tuple(
      fc.constantFrom('struct', 'union'),
      baseArb,
      fc.array(memberArb(available, cxx), { minLength: 1, maxLength: 5 }),
      fc.constantFrom('', '', '', '#pragma pack(1)\n', '#pragma pack(2)\n'),
    )
    .map(([kind, bases, members, pack]) => {
      // A union has no bases, no bit-field unit breaks worth generating, and
      // every member at offset zero — still worth generating, just simpler.
      const isUnion = kind === 'union';
      const seen = new Set<string>();
      const uniqueBases = isUnion
        ? []
        : bases.filter(([b]) => (seen.has(b) ? false : (seen.add(b), true)));
      const inherit = uniqueBases.length
        ? ' : ' + uniqueBases.map(([b, virt]) => `${virt ? 'virtual ' : ''}public ${b}`).join(', ')
        : '';
      const body = members.map((m, i) => m.render(`m${i}`)).join('\n');
      const tail = pack ? '#pragma pack()\n' : '';
      return {
        name,
        // C has no implicit typedef for a tag, so a later member referring to
        // this record must spell the keyword out.
        spelling: cxx ? name : `${kind} ${name}`,
        isUnion,
        text: `${pack}${kind} ${name}${inherit} {\n${body}\n};\n${tail}`,
      };
    });
}

// `Poly` is polymorphic but trivially destructible on purpose: a virtual
// destructor would make every record reaching it non-trivial, and a union
// member with a non-trivial destructor does not compile — which the generator
// would then hit at random.
const PRELUDE_CXX = 'struct Empty {};\nstruct Poly { virtual void f(); int p; };\n';
/** Names the generator uses in both languages. */
const PRELUDE_C = 'typedef void (*fnptr)();\ntypedef _Bool boolean;\n';
const PRELUDE_CPP = 'typedef void (*fnptr)();\ntypedef bool boolean;\n';

/** A whole translation unit: a few records, each able to contain the last. */
function sourceArb(cxx: boolean): fc.Arbitrary<string> {
  return fc.integer({ min: 1, max: 5 }).chain((count) => {
    const build = (i: number, available: Available[], acc: string[]): fc.Arbitrary<string> => {
      if (i === count) {
        return fc.constant((cxx ? PRELUDE_CPP + PRELUDE_CXX : PRELUDE_C) + acc.join('\n'));
      }
      return declArb(i, available, cxx).chain((d) =>
        build(
          i + 1,
          [...available, { name: d.name, spelling: d.spelling, isUnion: d.isUnion }],
          [...acc, d.text],
        ),
      );
    };
    return build(0, [], []);
  });
}

// ------------------------------------------------------------------ runs --

// Enough ABI variety that a law can fail on one and hold on the others:
// Itanium and Microsoft, 64-bit and 32-bit, hosted and freestanding.
const TRIPLES = [
  'x86_64-unknown-linux-gnu',
  'i386-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-apple-macosx',
  'armv7-none-eabi',
];

/**
 * Sources drawn once, up front, so the laws below all run on the same batch —
 * a failure names a source every law can be re-run against, rather than a
 * different sample per law.
 */
const BATCH = Number(process.env['ABIX_PROPERTY_RUNS'] ?? 60);

const subjects: Subject[] = [];
const generated: { source: string; triple: string }[] = [];

describe.skipIf(!moduleAvailable)('generated sources', () => {
  beforeAll(async () => {
    const analyzer = new AbiAnalyzer(await abiModule());
    const sources = fc.sample(
      fc
        .tuple(fc.boolean(), fc.constantFrom(...TRIPLES))
        .chain(([cxx, triple]) => sourceArb(cxx).map((source) => ({ source, triple, cxx }))),
      BATCH,
    );

    for (const { source, triple, cxx } of sources) {
      const options: CompileOptions = {
        ...DEFAULT_OPTIONS,
        lang: cxx ? 'c++' : 'c',
        std: defaultStdFor(cxx ? 'c++' : 'c'),
        triple,
      };
      const analysis = await analyzer.analyze(source, options);
      // A generated source that does not compile is a generator bug, not a
      // finding — assert it here so it is reported as one.
      if (analysis.code !== 0) {
        throw new Error(
          `generated source did not compile (${triple}):\n${source}\n${analysis.diagnosticsText}`,
        );
      }
      generated.push({ source, triple });
      for (const r of analysis.records) {
        subjects.push({ label: `${triple} ${r.key}\n${source}`, model: r.model });
      }
    }
  }, 300_000);

  it('produced records worth checking', () => {
    expect(subjects.length).toBeGreaterThan(BATCH);
    // The generator actually reaches the shapes it was written for.
    const leaves = subjects.flatMap((s) => s.model.leaves);
    const groups = subjects.flatMap((s) => s.model.groups);
    expect(leaves.some((l) => l.kind === 'bitfield')).toBe(true);
    expect(leaves.some((l) => l.kind === 'special')).toBe(true);
    expect(groups.some((g) => g.isBase)).toBe(true);
    expect(groups.some((g) => g.isUnion)).toBe(true);
    expect(subjects.some((s) => s.model.paddings.length > 0)).toBe(true);
  });

  it('covers every triple it was asked to', () => {
    for (const t of TRIPLES) {
      expect(
        generated.some((g) => g.triple === t),
        t,
      ).toBe(true);
    }
  });

  modelLaws('generated', () => subjects);
});
