// End to end through the actual wasm module: every shipped example, driven the
// way the app drives it — analyze, locate, build render models, build the line
// index — and compared against the text pipeline it replaces.
//
// This is the integration evidence. `abi-adapter.real.test.ts` checks the
// projection against a native binary; this one checks the artifact that ships,
// through the same code paths the UI uses.
//
// Needs a built module:
//   cd ~/clang-abi-wasm && scripts/build.sh wasm
// Skipped otherwise.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Analyzer } from '$compiler/Analyzer';
import { AbiAnalyzer, fromSyncModule } from '$compiler/AbiAnalyzer';
import { DEFAULT_OPTIONS, defaultStdFor, type CompileOptions } from '$core/options';
import { EXAMPLES } from '$core/targets';
import { assignColors, buildRenderModel, directMembers } from '$core/model';
import { buildLayoutTree, flattenVisible } from '$core/tree';
import { buildLineIndex } from '$state/code-locations';
import { isLibraryRecord, recordKey } from '$core/layout-parser';
import type { Compiler } from '$compiler/Compiler';
import type { RecordLayout, RenderModel } from '$core/types';

const DIST = process.env['ABI_WASM_DIST'] ?? path.join(os.homedir(), 'clang-abi-wasm', 'dist');
const enabled = existsSync(path.join(DIST, 'abi_query.mjs'));

/**
 * What the record itself declares — the top level of the field table. Compared
 * for every example.
 */
function membersOf(model: RenderModel) {
  return directMembers(model)
    .filter((u) => !('kind' in u && u.kind === 'special'))
    .map((u) => [u.name, u.offsetBits, u.sizeBits, u.align] as const)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
}

/**
 * Every drawn extent, including what lives inside compound members. Compared
 * only where the members are the user's own types.
 *
 * Inside a library type the two pipelines legitimately disagree: clang's dump
 * nests what it chose to print, while the library expands each record-typed
 * field through its id, and libc++'s short-string union with its
 * `[[no_unique_address]]` padding members comes out with a different number of
 * leaves either way. `Probe` itself still agrees on size, alignment and its own
 * three members — which is what the app draws for it.
 */
function leavesOf(model: RenderModel) {
  return model.leaves
    .filter((l) => l.kind !== 'special')
    .map((l) => [l.name, l.offsetBits, l.sizeBits, l.align] as const)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
}

function shapeOf(model: RenderModel, deep: boolean) {
  return {
    sizeBytes: model.record.sizeBytes,
    align: model.record.align,
    paddingBytes: model.paddingBytes,
    members: deep ? leavesOf(model) : membersOf(model),
  };
}

/** The app shows user records that are not library types; mirror that here. */
const shown = (records: RecordLayout[]): RecordLayout[] =>
  records.filter((r) => !isLibraryRecord(r.name));

describe.skipIf(!enabled)('clang-abi-wasm end to end', () => {
  let abi: AbiAnalyzer;
  let old: Analyzer;

  beforeAll(async () => {
    const { load } = (await import(/* @vite-ignore */ path.join(DIST, 'index.mjs'))) as {
      load: (o: { baseUrl: string }) => Promise<Parameters<typeof fromSyncModule>[0]>;
    };
    abi = new AbiAnalyzer(fromSyncModule(await load({ baseUrl: DIST })));
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    old = new Analyzer((await createNodeCompiler()) as Compiler);
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

  for (const ex of EXAMPLES) {
    it(
      `matches the text pipeline: ${ex.name}`,
      async () => {
        const options: CompileOptions = {
          ...DEFAULT_OPTIONS,
          lang: ex.lang,
          std: defaultStdFor(ex.lang),
        };
        const mine = await abi.analyze(ex.source, options);
        const theirs = await old.analyze(ex.source, options);

        expect(mine.code, 'compiles').toBe(0);

        const mineShown = shown(mine.userRecords);
        const theirsShown = shown(theirs.userRecords);
        const mineByKey = new Map(mineShown.map((r) => [recordKey(r), r]));

        // The two deliberately disagree about *which* records to list, and the
        // new one is the stricter: it asks clang whether a record was declared
        // in the submitted file, where the old one matches `std::` and `__`
        // against printed names and therefore keeps `struct tm`, `struct
        // timeval` and everything else a C header dragged in. So the new list
        // must be a subset — never inventing a record — and must still contain
        // everything the example itself declares.
        for (const key of mineByKey.keys()) {
          expect(
            theirsShown.some((r) => recordKey(r) === key),
            `${key} is not invented`,
          ).toBe(true);
        }
        for (const declared of ex.source.matchAll(/^\s*(?:struct|class|union)\s+(\w+)\s*[:{]/gm)) {
          const name = declared[1]!;
          expect(
            // A template pattern is never laid out — it has no layout until it
            // is instantiated — so `Pair` is reported as `Pair<double>`.
            [...mineByKey.keys()].some((k) => k.endsWith(' ' + name) || k.includes(' ' + name + '<')),
            `${name} is reported`,
          ).toBe(true);
        }

        // Where both list a record, every number the UI draws must agree.
        const deep = !/#include\s*</.test(ex.source);
        for (const rec of theirsShown) {
          const found = mineByKey.get(recordKey(rec));
          if (!found) continue;
          expect(shapeOf(buildRenderModel(found, mine), deep), recordKey(rec)).toEqual(
            shapeOf(buildRenderModel(rec, theirs), deep),
          );
        }
      },
      300_000,
    );
  }

  it('drives the editor index without a second compile', async () => {
    const source =
      'struct Header { unsigned short kind; unsigned short len; };\n' +
      'struct Message {\n  struct Header hdr;\n  unsigned char crc_lo, crc_hi;\n};\n';
    const options: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'c', std: 'gnu17' };
    const analysis = await abi.analyze(source, options);

    const models = new Map<string, RenderModel>();
    for (const rec of shown(analysis.userRecords)) {
      const model = buildRenderModel(rec, analysis);
      assignColors(model);
      models.set(recordKey(rec), model);
    }

    // `locate` reads the response it already has; the old pipeline ran one
    // `-ast-dump=json` per record here.
    const ast = await abi.locate(analysis, []);
    expect(ast.fields.length, 'field locations').toBeGreaterThan(0);
    expect(ast.decls.some((d) => d.name === 'Message'), 'record declarations').toBe(true);
    // A record's span is what lets the caret resolve to it on a blank line.
    expect(ast.decls.find((d) => d.name === 'Message')?.span).toBeDefined();

    const index = buildLineIndex(models, ast.fields);
    // Every member line the user wrote is addressable.
    expect(index.lines.get(3), 'the hdr line').toBeDefined();
    expect(index.lines.get(4), 'the crc line').toBeDefined();
    // `unsigned char crc_lo, crc_hi;` is two declarators on one line.
    expect(index.lines.get(4)!.marks.length, 'two marks on the crc line').toBe(2);
  });

  it('builds a containment tree the table can render', async () => {
    const options: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'c++', std: 'gnu++20' };
    const analysis = await abi.analyze(
      'struct Base { virtual ~Base(); int x; };\nstruct Derived : Base { char c; };\n',
      options,
    );
    const derived = analysis.userRecords.find((r) => r.name === 'Derived')!;
    const model = buildRenderModel(derived, analysis);
    assignColors(model);
    const rows = flattenVisible(buildLayoutTree(model), new Set());
    const ids = rows.map((r) => r.node.id);
    expect(new Set(ids).size, 'no node is rendered twice').toBe(ids.length);
    // The base is a group with the vptr and x inside it.
    const group = rows.find((r) => r.node.kind === 'group');
    expect(group, 'the base subobject is a group').toBeDefined();
    expect(group!.node.leafIndexes.length).toBeGreaterThan(1);
  });

  it('answers a type hover without the probe machinery', async () => {
    const options: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'c', std: 'gnu17' };
    const analysis = await abi.analyze('#include <stdint.h>\nstruct S { uint64_t v; };\n', options);
    expect(await abi.probeSpelling(analysis, 'uint64_t')).toEqual({ bits: 64, align: 8 });
    expect(await abi.probeSpelling(analysis, 'struct S')).toEqual({ bits: 64, align: 8 });
    expect(await abi.probeSpelling(analysis, 'no_such_type_at_all')).toBeNull();
  });
});
