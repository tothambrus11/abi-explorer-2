// The server end to end: a real project on disk, its compile_commands.json,
// the system's own compiler probed for headers, and the real engine.
//
// Sizes are checked against what g++ itself says (`sizeof`/`offsetof` compiled
// and run by `expectedLayouts` below), not against numbers written down here.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCommandsNotification } from '@abi-explorer/shared/protocol';
import {
  copyFixtureProject,
  hasLocalEngine,
  LOCAL_ENGINE,
  REQUIRE_ALL,
  type FixtureProject,
} from './support/fixtureProject.ts';
import { LspSession } from './support/lspSession.ts';

const hasCompiler = (() => {
  try {
    execFileSync('c++', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const skipped = !REQUIRE_ALL && (!hasLocalEngine || !hasCompiler);

describe.skipIf(skipped)('abi-explorer-lsp against a real project', () => {
  let project: FixtureProject;
  let session: LspSession;
  let compiled: Record<string, number>;

  beforeAll(async () => {
    project = copyFixtureProject();
    compiled = expectedLayouts(project);
    session = await LspSession.start(project.uri(''), {
      enginePath: LOCAL_ENGINE,
    });
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
    const payload = records
      .find((record) => record.name === 'Packet')!
      .members.find((m) => m.label === 'payload')!;
    expect(payload.offsetBits / 8).toBe(compiled['offsetof(Packet, payload)']);
    expect(context).toMatchObject({
      commandSource: 'compile_commands.json',
      commandInferred: false,
      errorCount: 0,
      otherErrorCount: 0,
    });
  });

  it('reports only the records declared in the document', async () => {
    const { records } = await session.layout(project.uri('main.cpp'));
    expect(records.map((record) => record.name).sort()).toEqual([
      'Circle',
      'Packet',
      'Pair<double>',
      'Pair<short>',
    ]);
  });

  it('hovers a record name with its size, map and members', async () => {
    const hover = await session.hover(project.uri('main.cpp'), { line: 8, character: 9 });
    const markdown = (hover!.contents as { value: string }).value;
    expect(markdown).toContain('**struct Packet** · 40 B · align 8 · 9 B padding');
    expect(markdown).toMatch(/^ ■ {3}length +std::uint32_t +4 B +4 B +4 B$/m);
    expect(markdown).toContain('```text');
  });

  it('hovers a member with its offset and the padding around it', async () => {
    const hover = await session.hover(project.uri('main.cpp'), { line: 11, character: 18 });
    const markdown = (hover!.contents as { value: string }).value;
    expect(markdown).toContain('**Packet::checksum** `std::uint16_t` · offset 8 B · 2 B · align 2');
    expect(markdown).toContain('Bytes 8–9, followed by 6 B of padding.');
  });

  it('hovers a use of a record declared elsewhere, by its name or as written', async () => {
    const uri = project.uri('uses.cpp');
    fs.writeFileSync(
      project.path('uses.cpp'),
      '#include "shapes.h"\n#include <vector>\nShape make();\nstruct Holder { std::string name; std::vector<int> values; };\nstd::string_view view(std::wstring);\nstd::vector<Shape> shapes;\n',
    );
    await session.open(uri);
    const markdown = async (line: number, character: number) => {
      const hover = await session.hover(uri, { line, character });
      return (hover?.contents as { value: string } | undefined)?.value ?? '';
    };
    const shape = await markdown(2, 2);
    expect(shape).toContain(`**struct Shape** · ${compiled['sizeof(Shape)']} B`);
    expect(shape).toMatch(/^ ■ ▸ name +std::string +\d+ B +\d+ B/m);
    // clang calls it `std::basic_string<char>`; the field's type says `std::string`.
    expect(await markdown(3, 22)).toMatch(
      /^\*\*class std::(__cxx11::)?basic_string\\<char.*\*\* · 32 B/m,
    );
    expect(await markdown(3, 42)).toMatch(/^\*\*class std::vector\\<int.*\*\* · 24 B · align 8/m);
    expect(await markdown(3, 1)).toBe(''); // `struct` is not a name
    // No field says `std::string_view` or `std::wstring`: the standard aliases are known.
    expect(await markdown(4, 7)).toMatch(/^\*\*class std::basic_string_view\\<char\\>\*\* · 16 B/m);
    expect(await markdown(4, 28)).toMatch(/^\*\*class std::basic_string\\<wchar_t\\>\*\* · 32 B/m);
    // clang prints it `std::vector<struct Shape>`, the source says `std::vector<Shape>`.
    expect(await markdown(5, 6)).toMatch(/^\*\*class std::vector\\<Shape\\>\*\* · 24 B/m);
  });

  it('lays out a header with the flags of the source that includes it', async () => {
    await session.open(project.uri('include/shapes.h'));
    const { records, context } = await session.layout(project.uri('include/shapes.h'));
    expect(records.map((record) => [record.name, record.sizeBits / 8])).toEqual([
      ['Shape', compiled['sizeof(Shape)']],
    ]);
    expect(context?.commandInferred).toBe(true);
  });

  it('lays out C with bit-fields', async () => {
    await session.open(project.uri('sensor.c'));
    const { records } = await session.layout(project.uri('sensor.c'), undefined, true);
    expect(records[0]!.sizeBits / 8).toBe(12);
    // Byte 8 holds `flags` (3 bits) and `valid` (1 bit), then 4 bits of padding.
    expect(records[0]!.text).toContain(' 0  ████ ╱╱╱╱ ╱╱╱╱ ╱╱╱╱ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓');
    expect(records[0]!.text).toContain(' 8  █▌╱╱ ╱╱╱╱ ╱╱╱╱ ╱╱╱╱');
    expect(records[0]!.layout.leaves.map((leaf) => [leaf.name, leaf.kind, leaf.color])).toEqual([
      ['channel', 'field', 'c-1'],
      ['value', 'field', 'c-2'],
      ['flags', 'bitfield', 'c-3'],
      ['valid', 'bitfield', 'c-4'],
    ]);
  });

  it('keeps the records clang recovers past an error, and says what the error was', async () => {
    fs.writeFileSync(
      project.path('broken.cpp'),
      'struct A { int x; };\nstruct B { undeclared y; };\nstruct C { double d; };\n',
    );
    await session.open(project.uri('broken.cpp'));
    const { records, context } = await session.layout(project.uri('broken.cpp'));
    expect(records.map((record) => record.name)).toEqual(['A', 'C']);
    expect(context).toMatchObject({
      errorCount: 1,
      firstError: "line 2: unknown type name 'undeclared'",
    });
  });

  it('lays out a typedef of an anonymous struct under the typedef name', async () => {
    const uri = project.uri('typedef.c');
    const text =
      '#include <stddef.h>\ntypedef struct {\n  char type;\n  int length;\n} Packet;\nstruct Holder { Packet p; char c; };\n';
    fs.writeFileSync(project.path('typedef.c'), text);
    await session.open(uri);
    const { records } = await session.layout(uri);
    expect(records.map((record) => record.name)).toEqual(['Packet', 'Holder']);
    // A member of the typedef's type is one member, not the struct's fields inlined.
    expect(records[1]!.members.map((member) => member.label)).toEqual(['p', 'c']);
    expect(records[0]!.nameRange).toEqual({
      start: { line: 4, character: 2 },
      end: { line: 4, character: 8 },
    });
    const hover = await session.hover(uri, { line: 5, character: 17 });
    expect((hover!.contents as { value: string }).value).toContain('**struct Packet** · 8 B');

    const pin = (await session.codeActions(uri, { line: 2, character: 3 })).find((action) =>
      action.title.startsWith('Pin'),
    );
    const [edit] = pin!.edit!.changes![uri]!;
    const lines = text.split('\n');
    lines.splice(edit!.range.start.line, 0, edit!.newText.trimEnd());
    await session.change(uri, lines.join('\n'));
    expect((await session.layout(uri)).context?.errorCount, edit!.newText).toBe(0);
    expect(edit!.newText).toContain('_Static_assert(offsetof(Packet, length) == 4');
    // The typedef name is part of the definition: its actions are offered there too.
    const atName = await session.codeActions(uri, { line: 4, character: 4 });
    expect(atName.map((action) => action.title)).toContain('Pin layout with static_assert');
  });

  it('inlines anonymous members but keeps a named member of an unnamed type whole', async () => {
    const uri = project.uri('nested.cpp');
    fs.writeFileSync(
      project.path('nested.cpp'),
      'struct Outer {\n  struct { int x; char y; } inner;\n  union { int i; float f; };\n  char z;\n};\n',
    );
    await session.open(uri);
    const { records } = await session.layout(uri);
    expect(records.map((record) => record.name)).toEqual(['Outer']);
    const members = records[0]!.members;
    expect(members.map((member) => member.label)).toEqual(['inner', 'i', 'f', 'z']);
    expect(members[0]!.type).toBe('struct (unnamed)');
    // The unnamed type's own fields hover as the member's.
    const hover = await session.hover(uri, { line: 1, character: 15 });
    expect((hover?.contents as { value: string }).value).toMatch(
      /^\*\*Outer::inner::x\*\* `int` · offset 0 B · 4 B · align 4/,
    );
  });

  it('says a template needs a use before it has a layout', async () => {
    const uri = project.uri('box.cpp');
    fs.writeFileSync(project.path('box.cpp'), 'template <class T> struct Box { T t; char c; };\n');
    await session.open(uri);
    expect((await session.layout(uri)).message).toMatch(/^A template has no layout until/);
    await session.change(uri, 'template <class T> struct Box { T t; char c; };\nBox<int> box;\n');
    const { records, message } = await session.layout(uri);
    expect(message).toBeNull();
    expect(records.map((record) => record.name)).toEqual(['Box<int>']);
  });

  it('warns about a record whose order wastes space, with the reorder as its fix', async () => {
    const uri = project.uri('packet.cpp');
    const text = 'struct Packet {\n  char type;\n  int length;\n  short checksum;\n};\n';
    fs.writeFileSync(project.path('packet.cpp'), text);
    await session.open(uri);
    const [warning] = session.diagnostics(uri);
    expect(warning).toMatchObject({
      severity: 2,
      source: 'abi-explorer',
      code: 'reorder',
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } },
      message:
        'Packet would take 8 B instead of 12 B with its members ordered as length, checksum, type.',
    });
    const [action] = await session.codeActions(uri, { line: 2, character: 4 });
    expect(action?.title).toBe('Reorder members by alignment (12 B → 8 B)');
    expect(action?.kind).toBe('quickfix');
    expect(action?.isPreferred).toBe(true);
    expect(action?.diagnostics).toEqual([warning]);
    const edits = action!.edit!.changes![uri]!;
    const lines = text.split('\n');
    for (const edit of edits) lines[edit.range.start.line] = edit.newText;
    await session.change(uri, lines.join('\n'));
    expect((await session.layout(uri)).records[0]!.sizeBits / 8).toBe(8);
    const after = await session.codeActions(uri, { line: 2, character: 4 });
    expect(after.map((action) => action.title)).toEqual(['Pin layout with static_assert']);
    expect(session.diagnostics(uri)).toEqual([]);
  });

  it('keeps an order meant as it is, without the warning', async () => {
    const uri = project.uri('wire.cpp');
    const text =
      'namespace net {\ntemplate <typename T>\nstruct Wire {\n  char tag;\n  T value;\n  char end;\n};\nWire<int> wire;\n}\n';
    fs.writeFileSync(project.path('wire.cpp'), text);
    await session.open(uri);
    expect(session.diagnostics(uri)).toHaveLength(1);
    const actions = await session.codeActions(uri, { line: 3, character: 4 });
    const keep = actions.find((action) => action.title === 'Keep this member order')!;
    expect(keep.kind).toBe('quickfix');
    const [edit] = keep.edit!.changes![uri]!;
    expect(edit).toEqual({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: '// abi-explorer: keep order\n',
    });
    const lines = text.split('\n');
    lines.splice(1, 0, edit!.newText.trimEnd());
    await session.change(uri, lines.join('\n'));
    expect(session.diagnostics(uri)).toEqual([]);
    // The reorder stays on offer, as a refactoring rather than a fix.
    const after = await session.codeActions(uri, { line: 4, character: 4 });
    expect(after.map((action) => [action.title, action.kind])).toEqual([
      ['Reorder members by alignment (12 B → 8 B)', 'refactor.rewrite'],
    ]);
  });

  it('pins a layout with assertions that hold, in C and C++', async () => {
    for (const [file, text] of [
      ['pinned.cpp', '#include <cstddef>\nstruct S {\n  char c;\n  double d;\n};\n'],
      ['pinned.c', '#include <stddef.h>\nunion U {\n  char c;\n  double d;\n};\n'],
      // Defined outside its namespace: the asserts name it qualified.
      ['outside.cpp', 'namespace ns { struct S; }\nstruct ns::S {\n  char c;\n  double d;\n};\n'],
    ] as const) {
      const uri = project.uri(file);
      fs.writeFileSync(project.path(file), text);
      await session.open(uri);
      const pin = (await session.codeActions(uri, { line: 2, character: 3 })).find((action) =>
        action.title.startsWith('Pin'),
      );
      const [edit] = pin!.edit!.changes![uri]!;
      expect(edit!.range.start).toEqual({ line: 5, character: 0 });
      await session.change(uri, text + edit!.newText);
      const { context } = await session.layout(uri);
      expect(context?.errorCount, edit!.newText).toBe(0);
      // The assertions hold now; one that did not would be an error.
      await session.change(uri, text + edit!.newText.replace(/== \d+/, '== 99'));
      expect((await session.layout(uri)).context?.errorCount).toBe(1);
    }
  });

  it('re-analyses an edit, and a pushed command wins over the database', async () => {
    const uri = project.uri('sensor.c');
    await session.change(
      uri,
      fs
        .readFileSync(project.path('sensor.c'), 'utf8')
        .replace('uint32_t value;', 'uint64_t value;'),
    );
    expect((await session.layout(uri)).records[0]!.sizeBits / 8).toBe(24);

    const analyzed = session.nextAnalysis(uri);
    await session.notify(compileCommandsNotification, {
      source: 'CMake Tools',
      commands: [
        {
          directory: project.root,
          file: project.path('sensor.c'),
          arguments: ['cc', '-fpack-struct=1', '-c', 'sensor.c'],
        },
      ],
    });
    await analyzed;
    const { records, context } = await session.layout(uri);
    expect(context?.commandSource).toBe('CMake Tools');
    expect(records[0]!.alignBits).toBe(8);
  });
});

/** sizeof and offsetof as g++ computes them, for the fixture's records. */
describe.skipIf(skipped)('abi-explorer-lsp with a target set', () => {
  it('lays the project out for that target, with the project flags that still apply', async () => {
    const project = copyFixtureProject();
    const session = await LspSession.start(project.uri(''), {
      enginePath: LOCAL_ENGINE,
      target: 'armv7-unknown-linux-gnueabihf',
    });
    try {
      await session.open(project.uri('main.cpp'));
      const { records, context } = await session.layout(project.uri('main.cpp'));
      // A 32-bit target: 4-byte pointers, so a 12-byte std::vector and 4-byte alignment.
      const packet = records.find((record) => record.name === 'Packet')!;
      expect([packet.sizeBits / 8, packet.alignBits / 8]).toEqual([24, 4]);
      expect(context).toMatchObject({ triple: 'armv7-unknown-linux-gnueabihf', errorCount: 0 });
      expect(context?.commandSource).toContain('target set in settings');
    } finally {
      await session.stop();
      project.remove();
    }
  });

  it('says why nothing is laid out for a target clang does not know', async () => {
    const project = copyFixtureProject();
    const session = await LspSession.start(project.uri(''), {
      enginePath: LOCAL_ENGINE,
      target: 'not-a-target',
    });
    try {
      await session.open(project.uri('main.cpp'));
      expect((await session.layout(project.uri('main.cpp'))).message).toBe(
        "Nothing could be laid out: unknown target triple 'not-a-target'.",
      );
    } finally {
      await session.stop();
      project.remove();
    }
  });
});

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
  execFileSync('c++', [
    '-std=c++20',
    '-Wno-invalid-offsetof',
    `-I${project.path('include')}`,
    `-I${project.root}`,
    probe,
    '-o',
    binary,
  ]);
  return JSON.parse(execFileSync(binary, { encoding: 'utf8' })) as Record<string, number>;
}
