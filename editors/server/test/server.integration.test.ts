// The server end to end: a real project on disk, its compile_commands.json,
// the system's own compiler probed for headers, and the real engine.
//
// Sizes are checked against what g++ itself says (`sizeof`/`offsetof` compiled
// and run by `expectedLayouts` below), not against numbers written down here.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCommandsNotification } from '../src/protocol.ts';
import { copyFixtureProject, hasLocalEngine, LOCAL_ENGINE, type FixtureProject } from './support/fixtureProject.ts';
import { LspSession } from './support/lspSession.ts';

const hasCompiler = (() => {
  try {
    execFileSync('c++', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasLocalEngine || !hasCompiler)('abi-explorer-lsp against a real project', () => {
  let project: FixtureProject;
  let session: LspSession;
  let compiled: Record<string, number>;

  beforeAll(async () => {
    project = copyFixtureProject();
    compiled = expectedLayouts(project);
    session = await LspSession.start(project.uri(''), { enginePath: LOCAL_ENGINE, inlayHints: 'records' });
    await session.open(project.uri('main.cpp'));
  }, 120_000);

  afterAll(async () => {
    await session.stop();
    project.remove();
  });

  it('lays records out as the project compiler does', async () => {
    const { records, context } = await session.layout(project.uri('main.cpp'));
    const size = (name: string) => records.find((record) => record.name === name)!.sizeBits / 8;
    expect(size('Circle')).toBe(compiled['sizeof(Circle)']);
    expect(size('Packet')).toBe(compiled['sizeof(Packet)']);
    expect(size('Pair<double>')).toBe(compiled['sizeof(Pair<double>)']);
    expect(size('Pair<short>')).toBe(compiled['sizeof(Pair<short>)']);
    const payload = records.find((record) => record.name === 'Packet')!.members.find((m) => m.label === 'payload')!;
    expect(payload.offsetBits / 8).toBe(compiled['offsetof(Packet, payload)']);
    expect(context).toMatchObject({ commandSource: 'compile_commands.json', commandInferred: false, errorCount: 0 });
  });

  it('reports only the records declared in the document', async () => {
    const { records } = await session.layout(project.uri('main.cpp'));
    expect(records.map((record) => record.name).sort()).toEqual(['Circle', 'Packet', 'Pair<double>', 'Pair<short>']);
  });

  it('hovers a record name with its size, map and members', async () => {
    const hover = await session.hover(project.uri('main.cpp'), { line: 8, character: 9 });
    const markdown = (hover!.contents as { value: string }).value;
    expect(markdown).toContain('**struct Packet** · 40 bytes · align 8 · 9 bytes padding');
    expect(markdown).toMatch(/^ b {2}length +4 +4 B {2}std::uint32_t$/m);
    expect(markdown).toContain('```text');
  });

  it('hovers a member with its offset and the padding before it', async () => {
    const hover = await session.hover(project.uri('main.cpp'), { line: 11, character: 18 });
    const markdown = (hover!.contents as { value: string }).value;
    expect(markdown).toContain('**Packet::checksum** · offset 8 · 2 bytes · align 2');
    expect(markdown).not.toContain('padding before');
  });

  it('shows one inlay hint per record declaration', async () => {
    const hints = await session.inlayHints(project.uri('main.cpp'));
    expect(hints.map((hint) => [hint.position.line, hint.label])).toEqual([
      [3, '64 B · align 8 · 10 B padding'],
      [8, '40 B · align 8 · 9 B padding'],
      [15, '16 B · align 8 · 7 B padding'],
    ]);
  });

  it('lays out a header with the flags of the source that includes it', async () => {
    await session.open(project.uri('include/shapes.h'));
    const { records, context } = await session.layout(project.uri('include/shapes.h'));
    expect(records.map((record) => [record.name, record.sizeBits / 8])).toEqual([['Shape', compiled['sizeof(Shape)']]]);
    expect(context?.commandInferred).toBe(true);
  });

  it('lays out C with bit-fields', async () => {
    await session.open(project.uri('sensor.c'));
    const { records } = await session.layout(project.uri('sensor.c'), undefined, true);
    expect(records[0]!.sizeBits / 8).toBe(12);
    expect(records[0]!.text).toContain('0  a · · · b b b b');
  });

  it('re-analyses an edit, and a pushed command wins over the database', async () => {
    const uri = project.uri('sensor.c');
    await session.change(uri, fs.readFileSync(project.path('sensor.c'), 'utf8').replace('uint32_t value;', 'uint64_t value;'));
    expect((await session.layout(uri)).records[0]!.sizeBits / 8).toBe(24);

    const analyzed = session.nextAnalysis(uri);
    await session.notify(compileCommandsNotification, {
      source: 'CMake Tools',
      commands: [{ directory: project.root, file: project.path('sensor.c'), arguments: ['cc', '-fpack-struct=1', '-c', 'sensor.c'] }],
    });
    await analyzed;
    const { records, context } = await session.layout(uri);
    expect(context?.commandSource).toBe('CMake Tools');
    expect(records[0]!.alignBits).toBe(8);
  });
});

/** sizeof and offsetof as g++ computes them, for the fixture's records. */
function expectedLayouts(project: FixtureProject): Record<string, number> {
  const probe = path.join(project.root, 'probe.cpp');
  fs.writeFileSync(
    probe,
    `#include "main.cpp"
#include <cstddef>
#include <cstdio>
Shape::~Shape() {}
int main() {
  std::printf("{\\"sizeof(Shape)\\": %zu, \\"sizeof(Circle)\\": %zu, \\"sizeof(Packet)\\": %zu, \\"offsetof(Packet, payload)\\": %zu, \\"sizeof(Pair<double>)\\": %zu, \\"sizeof(Pair<short>)\\": %zu}",
    sizeof(Shape), sizeof(Circle), sizeof(Packet), offsetof(Packet, payload), sizeof(Pair<double>), sizeof(Pair<short>));
}`,
  );
  const binary = path.join(project.root, 'probe');
  execFileSync('c++', ['-std=c++20', '-Wno-invalid-offsetof', `-I${project.path('include')}`, `-I${project.root}`, probe, '-o', binary]);
  return JSON.parse(execFileSync(binary, { encoding: 'utf8' })) as Record<string, number>;
}
