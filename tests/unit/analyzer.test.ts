import { describe, it, expect } from 'vitest';
import { Analyzer } from '$compiler/Analyzer';
import { buildRenderModel } from '$core/model';
import { matchItemsToLocations, unqualifiedName } from '$core/ast-locations';
import { loadFixture, fixtureCompiler, optionsFor } from './helpers';
import { DEFAULT_OPTIONS } from '$core/options';

const analyze = async (name: string, triple: string) => {
  const fx = loadFixture(name, triple);
  const analyzer = new Analyzer(fixtureCompiler(fx));
  const analysis = await analyzer.analyze(fx.source, { ...DEFAULT_OPTIONS, ...optionsFor(fx) });
  return { fx, analyzer, analysis };
};

describe('Analyzer (fixture-backed)', () => {
  it('measures every member with clang on x86-64', async () => {
    const { analysis } = await analyze('padding-basics', 'x86_64-unknown-linux-gnu');
    const ex = analysis.userRecords.find((r) => r.name === 'Example')!;
    expect(ex.sizeBytes).toBe(40);
    const m = buildRenderModel(ex, analysis);
    expect(m.leaves.map((l) => [l.name, l.offsetBits / 8, l.sizeBits / 8, l.align])).toEqual([
      ['flag', 0, 1, 1],
      ['count', 4, 4, 4],
      ['tag', 8, 1, 1],
      ['id', 16, 8, 8],
      ['name', 24, 5, 1],
      ['userdata', 32, 8, 8],
    ]);
    expect(m.paddingBytes).toBe(13);
    expect(m.paddings).toEqual([
      { start: 1, end: 4 },
      { start: 9, end: 16 },
      { start: 29, end: 32 },
    ]);
    expect(analysis.unmeasured).toEqual([]);
    expect(analysis.diagnostics).toEqual([]);
  });

  it('is target-faithful: i386 aligns uint64_t to 4, AVR to 1, MSVC like SysV here', async () => {
    const i386 = await analyze('padding-basics', 'i386-unknown-linux-gnu');
    const id = buildRenderModel(i386.analysis.userRecords[0]!, i386.analysis).leaves.find(
      (l) => l.name === 'id',
    )!;
    expect([id.offsetBits / 8, id.align]).toEqual([12, 4]);
    const avr = await analyze('padding-basics', 'avr-unknown-unknown');
    expect(avr.analysis.userRecords[0]!.sizeBytes).toBe(21);
    expect(buildRenderModel(avr.analysis.userRecords[0]!, avr.analysis).paddingBytes).toBe(0);
    const msvc = await analyze('padding-basics', 'x86_64-pc-windows-msvc');
    expect(msvc.analysis.userRecords[0]!.sizeBytes).toBe(40);
  });

  it('bit-fields: widths from the dump, no probes needed', async () => {
    const { analysis } = await analyze('bitfields', 'x86_64-unknown-linux-gnu');
    const m = buildRenderModel(analysis.userRecords[0]!, analysis);
    expect(
      m.leaves.filter((l) => l.kind === 'bitfield').map((l) => [l.name, l.offsetBits, l.sizeBits]),
    ).toEqual([
      ['kind', 0, 3],
      ['visible', 3, 1],
      ['dirty', 4, 1],
      ['refcount', 32, 20],
      ['balance', 52, 9],
    ]);
    expect(m.markers.map((k) => k.kind)).toEqual(['zero-bitfield']);
    // On MSP430 `unsigned` is 16 bits: `refcount : 20` is an error, reported as a parsed diagnostic (colors stripped)
    const msp = await analyze('bitfields', 'msp430-none-elf');
    expect(msp.analysis.code).not.toBe(0);
    expect(msp.analysis.userRecords).toEqual([]);
    expect(msp.analysis.diagnostics[0]).toMatchObject({ line: 1, severity: 'error' });
    expect(msp.analysis.diagnostics[0]!.message).toMatch(/exceeds the width/);
    expect(msp.analysis.diagnosticsText).not.toContain('\x1b');
    expect(msp.analysis.diagnosticsAnsi).toContain('\x1b[');
  });

  it('nested/union/anonymous/typedef-anonymous members are measured through access paths', async () => {
    const { analysis, analyzer } = await analyze('nested-union-anon', 'x86_64-unknown-linux-gnu');
    const msg = analysis.userRecords.find((r) => r.name === 'Message')!;
    const m = buildRenderModel(msg, analysis);
    expect(m.leaves.map((l) => l.name)).toEqual([
      'kind',
      'len',
      'raw',
      'word',
      'number',
      'crc_lo',
      'crc_hi',
      'x',
    ]);
    expect(m.leaves.every((l) => !l.estimated)).toBe(true);
    expect(m.groups.map((g) => [g.name, g.sizeBits! / 8, g.align])).toEqual([
      ['hdr', 4, 2],
      ['payload', 16, 8],
      ['(anonymous)', 2, 1],
      ['pt', 2, 2],
    ]);
    const owners = new Set(
      [
        ...analysis.userRecords.map((r) => unqualifiedName(r.name)),
        ...m.groups.map((g) => unqualifiedName(g.type.replace(/^(?:struct|union|class)\s+/, ''))),
      ].filter(Boolean),
    );
    const info = await analyzer.locate(analysis, owners);
    const locs = matchItemsToLocations(m.leaves, info.fields);
    expect([...locs.values()].map((l) => l.line)).toEqual([2, 2, 3, 3, 3, 5, 5, 4]);
    expect(info.fields.find((f) => f.name === 'raw')!.qualType).toBe('uint8_t[10]');
    expect(info.decls.filter((d) => d.kind === 'record').map((d) => d.name)).toContain('Message');
    expect(info.decls.find((d) => d.kind === 'typedef' && d.name === 'Point')?.qualType).toMatch(
      /struct/,
    );
    // The typedef'd anonymous struct is a record of its own and its member is
    // measured through the AST-reported field type (probe of `uint16_t`).
    const point = analysis.userRecords.find((r) => r.name.startsWith('(unnamed'))!;
    expect(point).toBeDefined();
    const pm = buildRenderModel(point, analysis);
    expect(pm.leaves.map((l) => [l.name, l.sizeBits, l.align, l.estimated])).toEqual([
      ['x', 16, 2, false],
    ]);
  });

  it('C++: private members via -fno-access-control, virtual bases on both ABIs, EBO, templates', async () => {
    const it_ = await analyze('cxx-bases', 'x86_64-unknown-linux-gnu');
    const secret = buildRenderModel(
      it_.analysis.userRecords.find((r) => r.name === 'Secret')!,
      it_.analysis,
    );
    expect(secret.leaves.map((l) => [l.name, l.estimated])).toEqual([
      ['c', false],
      ['pub', false],
    ]);
    const diamond = buildRenderModel(
      it_.analysis.userRecords.find((r) => r.name === 'Diamond')!,
      it_.analysis,
    );
    expect(diamond.leaves.map((l) => l.name)).toEqual([
      'Diamond vtable pointer',
      'd',
      'Base vtable pointer',
      'x',
    ]);
    expect(diamond.record.nvsize).toBe(16);
    const ebo = buildRenderModel(
      it_.analysis.userRecords.find((r) => r.name === 'WithEbo')!,
      it_.analysis,
    );
    expect(ebo.record.sizeBytes).toBe(1);
    expect(ebo.markers.map((k) => k.kind)).toEqual(['empty-base']);
    expect(it_.analysis.userRecords.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Pair<double>', 'Pair<char>']),
    );

    const ms = await analyze('cxx-bases', 'x86_64-pc-windows-msvc');
    const dm = buildRenderModel(
      ms.analysis.userRecords.find((r) => r.name === 'Diamond')!,
      ms.analysis,
    );
    expect(dm.leaves.map((l) => l.name)).toEqual([
      'Diamond vbtable pointer',
      'd',
      'Base vftable pointer',
      'x',
    ]);
    const derived = ms.analysis.userRecords.find((r) => r.name === 'Derived')!;
    expect(derived.sizeBytes).toBe(40); // MSVC does not reuse tail padding
  });

  it('spelling probes answer arbitrary type names (and null for non-types)', async () => {
    const { analysis, analyzer } = await analyze('padding-basics', 'i386-unknown-linux-gnu');
    expect(await analyzer.probeSpelling(analysis, 'uint64_t')).toEqual({ bits: 64, align: 4 });
    expect(await analyzer.probeSpelling(analysis, 'long double')).toEqual({ bits: 96, align: 4 });
    expect(await analyzer.probeSpelling(analysis, 'no_such_type')).toBeNull();
  });
});
