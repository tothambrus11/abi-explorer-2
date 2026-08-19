// Parity: does the structured library, projected through AbiAdapter, produce
// the same layouts as the text-parsing pipeline it replaces?
//
// Both sides run real clang. The old one drives the wasm driver and parses what
// it prints; the new one calls clang-abi-wasm and reads fields. Agreement on
// every record size, field offset, field size and padding total is the evidence
// that the projection is faithful — and the disagreements, where they are
// deliberate, are asserted too.
//
// Needs the native harness built:
//   cd ~/clang-abi-wasm && scripts/build.sh native
// Skipped otherwise, so a checkout without it still runs the suite.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Analyzer } from '$compiler/Analyzer';
import { toAnalysis, type AbiResponse } from '$compiler/AbiAdapter';
import { DEFAULT_OPTIONS, type CompileOptions } from '$core/options';
import { buildRenderModel } from '$core/model';
import { recordKey } from '$core/layout-parser';
import type { Compiler } from '$compiler/Compiler';
import type { RenderModel } from '$core/types';

const HARNESS =
  process.env['ABI_QUERY_BIN'] ??
  path.join(os.homedir(), 'clang-abi-wasm', 'build', 'native', 'abi_query_test');

const enabled = existsSync(HARNESS) && process.env['ABIX_REAL_CLANG'] === '1';

/** Every layout fact the UI draws, reduced to something comparable. */
interface Shape {
  sizeBytes: number;
  align: number;
  paddingBytes: number;
  members: [name: string, offsetBits: number, sizeBits: number, align: number | null][];
}

function shapeOf(model: RenderModel): Shape {
  return {
    sizeBytes: model.record.sizeBytes,
    align: model.record.align,
    paddingBytes: model.paddingBytes,
    members: model.leaves
      .filter((l) => l.kind !== 'special')
      // Alignment included deliberately: it is reported in bytes here and bits
      // by the library, and comparing only sizes let a factor-of-eight slip
      // through to the alignment column.
      .map((l) => [l.name, l.offsetBits, l.sizeBits, l.align] as [string, number, number, number | null])
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])),
  };
}

describe.skipIf(!enabled)('AbiAdapter parity with the text pipeline', () => {
  let analyzer: Analyzer;
  beforeAll(async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    analyzer = new Analyzer((await createNodeCompiler()) as Compiler);
  }, 300_000);

  const viaLibrary = (source: string, options: CompileOptions) => {
    const request = {
      source,
      triple: options.triple,
      lang: options.lang,
      ...(options.std ? { std: options.std } : {}),
    };
    const out = execFileSync(HARNESS, {
      input: JSON.stringify(request),
      maxBuffer: 1 << 28,
    }).toString();
    return toAnalysis(JSON.parse(out) as AbiResponse, source, options);
  };

  const CASES: { name: string; lang: 'c' | 'c++'; source: string; triples: string[] }[] = [
    {
      name: 'padding and alignment',
      lang: 'c',
      source: 'struct S { char a; int b; char c; double d; short e; };\n',
      triples: ['x86_64-unknown-linux-gnu', 'i386-unknown-linux-gnu', 'avr-unknown-unknown'],
    },
    {
      name: 'bit-fields',
      lang: 'c',
      source:
        'struct Flags { unsigned kind : 3; unsigned visible : 1; unsigned : 0; unsigned refcount : 20; char suffix; };\n',
      triples: ['x86_64-unknown-linux-gnu', 'msp430-none-elf'],
    },
    {
      name: 'nested and anonymous members',
      lang: 'c',
      source:
        'struct Header { unsigned short kind; unsigned short len; };\n' +
        'struct Message { struct Header hdr; struct { unsigned char lo, hi; }; long tail; };\n',
      triples: ['x86_64-unknown-linux-gnu', 'arm-none-eabi'],
    },
    {
      name: 'bases, virtual bases and empty base optimization',
      lang: 'c++',
      source:
        'struct Base { virtual ~Base(); int x; };\n' +
        'struct Mixin { virtual void tick(); char tag; };\n' +
        'struct Derived : Base, Mixin { char extra; };\n' +
        'struct Diamond : virtual Base { double d; };\n' +
        'struct Empty {};\nstruct WithEbo : Empty { char c; };\n',
      triples: ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'],
    },
  ];

  for (const c of CASES) {
    for (const triple of c.triples) {
      it(
        `${c.name} — ${triple}`,
        async () => {
          const options: CompileOptions = {
            ...DEFAULT_OPTIONS,
            lang: c.lang,
            std: c.lang === 'c++' ? 'gnu++20' : 'gnu17',
            triple,
          };
          const oldA = await analyzer.analyze(c.source, options);
          const newA = viaLibrary(c.source, options);

          // Both must agree on which records the user wrote.
          const oldNames = oldA.userRecords.map(recordKey).sort();
          const newNames = newA.userRecords.map(recordKey).sort();
          expect(newNames, 'user records').toEqual(oldNames);

          for (const rec of oldA.userRecords) {
            const key = recordKey(rec);
            const mine = newA.userRecords.find((r) => recordKey(r) === key);
            expect(mine, `${key} present`).toBeDefined();
            expect(shapeOf(buildRenderModel(mine!, newA)), key).toEqual(
              shapeOf(buildRenderModel(rec, oldA)),
            );
          }
        },
        180_000,
      );
    }
  }

  it('reports no estimated members, where the old pipeline had to guess', () => {
    // A flexible array member cannot be measured by a probe, so the text
    // pipeline estimated a byte for it and the byte grid then drew nothing.
    const source = 'struct Packet { unsigned len; char data[]; };\n';
    const options: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'c', std: 'gnu17' };
    const newA = viaLibrary(source, options);
    expect(newA.unmeasured).toEqual([]);

    const model = buildRenderModel(newA.userRecords[0]!, newA);
    const data = model.leaves.find((l) => l.name === 'data');
    expect(data, 'the flexible array member is present').toBeDefined();
    expect(data!.estimated, 'nothing is estimated any more').toBe(false);
    expect(data!.sizeBits, 'and it occupies nothing').toBe(0);
  });

  it('needs one compile where the old pipeline needed several', () => {
    // The point of the exercise: the text pipeline ran a baseline, a layout
    // pass, up to four probe rounds and an AST dump per record. Counting the
    // library's compiles is not possible from here, but the absence of probe
    // machinery is — no member key is ever missing.
    const source =
      'struct Inner { int a; char b; };\nstruct Outer { struct Inner i; double d; char tail; };\n';
    const options: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'c', std: 'gnu17' };
    const newA = viaLibrary(source, options);
    expect(newA.memberSizes.size).toBeGreaterThan(0);
    for (const [, v] of newA.memberSizes) expect(v.bits).toBeGreaterThan(0);
  });
});
