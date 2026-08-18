// Not a test: captures clang outputs for the unit-test fixtures using the real
// wasm clang. Run with `npm run fixtures` (ABIX_CAPTURE=1); skipped otherwise.
import { it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Analyzer } from '$compiler/Analyzer';
import type { Compiler, CompileJob, CompileOutput } from '$compiler/Compiler';
import { DEFAULT_OPTIONS, type Language } from '$core/options';
import { unqualifiedName } from '$core/ast-locations';
import { buildRenderModel } from '$core/model';
import { recordKey } from '$core/layout-parser';

const OUT = path.join(process.cwd(), 'tests', 'fixtures');

interface Case {
  name: string;
  lang: Language;
  triples: string[];
  source: string;
}

export const CASES: Case[] = [
  {
    name: 'padding-basics',
    lang: 'c',
    triples: [
      'x86_64-unknown-linux-gnu',
      'i386-unknown-linux-gnu',
      'avr-unknown-unknown',
      'x86_64-pc-windows-msvc',
    ],
    source: `#include <stdint.h>\nstruct Example { uint8_t flag; uint32_t count; uint8_t tag; uint64_t id; char name[5]; void *userdata; };\n`,
  },
  {
    name: 'bitfields',
    lang: 'c',
    triples: ['x86_64-unknown-linux-gnu', 'msp430-none-elf'],
    source: `struct Flags { unsigned kind : 3; unsigned visible : 1; unsigned dirty : 1; unsigned : 0; unsigned refcount : 20; short balance : 9; char suffix; };\n`,
  },
  {
    name: 'nested-union-anon',
    lang: 'c',
    triples: ['x86_64-unknown-linux-gnu', 'arm-none-eabi'],
    source: `#include <stdint.h>\nstruct Header { uint16_t kind; uint16_t len; };\nunion Payload { uint8_t raw[10]; uint32_t word; double number; };\ntypedef struct { uint16_t x; } Point;\nstruct Message { struct Header hdr; union Payload payload; struct { uint8_t crc_lo, crc_hi; }; Point pt; };\n`,
  },
  {
    name: 'cxx-bases',
    lang: 'c++',
    triples: ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'],
    source: `struct Base { virtual ~Base(); int x; };\nstruct Mixin { virtual void tick(); char tag; };\nstruct Derived : Base, Mixin { char extra; };\nstruct Diamond : virtual Base { double d; };\nclass Secret { class Inner { char c[3]; }; Inner priv; public: int pub; };\nstruct Empty {};\nstruct WithEbo : Empty { char c; };\ntemplate <typename T> struct Pair { T first; char second; };\nPair<double> pd; Pair<char> pc;\n`,
  },
];

export interface Fixture {
  name: string;
  lang: Language;
  triple: string;
  source: string;
  calls: { job: CompileJob; out: CompileOutput }[];
}

it.skipIf(process.env['ABIX_CAPTURE'] !== '1')(
  'captures fixtures with real clang',
  async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    const real = (await createNodeCompiler()) as Compiler;
    await mkdir(OUT, { recursive: true });
    const index: string[] = [];
    for (const c of CASES) {
      for (const triple of c.triples) {
        const opts = {
          ...DEFAULT_OPTIONS,
          lang: c.lang,
          std: c.lang === 'c++' ? 'gnu++20' : 'gnu17',
          triple,
        };
        const calls: Fixture['calls'] = [];
        const recording: Compiler = {
          ...real,
          async compile(job) {
            const out = await real.compile(job);
            calls.push({ job: { argv0: job.argv0, args: job.args, files: job.files }, out });
            return out;
          },
        };
        const analyzer = new Analyzer(recording);
        const analysis = await analyzer.analyze(c.source, opts);
        const owners = new Set(
          analysis.userRecords
            .flatMap((r) => [
              unqualifiedName(r.name),
              ...buildRenderModel(r, analysis).groups.map((g) =>
                unqualifiedName(g.type.replace(/^(?:struct|union|class)\s+/, '')),
              ),
            ])
            .filter(Boolean),
        );
        await analyzer.locate(analysis, owners);
        // Also record a couple of spelling probes used by the hover tests.
        for (const sp of ['uint64_t', 'long double', 'no_such_type'])
          {await analyzer.probeSpelling(analysis, sp);}
        const file = `${c.name}--${triple}.json`;
        const fx: Fixture = { name: c.name, lang: c.lang, triple, source: c.source, calls };
        await writeFile(path.join(OUT, file), JSON.stringify(fx, null, 1));
        index.push(file);
        void recordKey;
      }
    }
    await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  },
  600_000,
);
