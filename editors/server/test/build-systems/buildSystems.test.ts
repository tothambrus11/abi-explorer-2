// The server on projects built by real build systems: CMake, Meson, Bazel and
// Conan (with CMake) each generate their own compile commands for the same
// small program, and build and run it. The layout the server reports must match
// the `sizeof` the built program prints, and it only can if the build's own
// define (RECORD_WIDE_ID) and include paths reached the engine.
//
// Each project is checked twice: with the compile_commands.json the build wrote,
// found the way VS Code, Zed and Neovim find it; and with the commands pushed
// the way the CLion plugin sends CLion's project model (compiler, working
// directory and switches per source file, `abiExplorer/compileCommands`).
//
// Slow (a Bazel build among them), so not part of `npm test`:
//   npm run test:build-systems
// A build system that is not installed is skipped, unless ABI_EXPLORER_REQUIRE_ALL
// is set, as CI sets it. BAZEL_REGISTRY replaces the Bazel Central Registry,
// for networks that cannot reach it.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCommandsNotification, type CompileCommand } from '@abi-explorer/shared/protocol';
import { splitCommandLine } from '@abi-explorer/shared/splitCommandLine';
import { hasLocalEngine, LOCAL_ENGINE, REQUIRE_ALL } from '../support/fixtureProject.ts';
import { LspSession } from '../support/lspSession.ts';

const PROJECTS = path.join(import.meta.dirname, 'projects');

interface BuiltProject {
  root: string;
  /** What the built program printed: sizeof(Record). */
  size: number;
  /** The compile commands the build wrote, with absolute files. */
  commands: CompileCommand[];
  /** The directory CLion would report as each file's compiler working directory. */
  clionWorkingDirectory?: string;
  /** Whether `include/record.h` is in the project (Conan's is in its package cache). */
  hasHeader: boolean;
}

interface BuildSystem {
  name: string;
  tools: string[];
  build(root: string, home: string): BuiltProject;
}

const BUILD_SYSTEMS: BuildSystem[] = [
  {
    name: 'CMake',
    tools: ['cmake'],
    build(root) {
      run('cmake', [
        '-S',
        root,
        '-B',
        path.join(root, 'build'),
        ...ninja(),
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
      ]);
      run('cmake', ['--build', path.join(root, 'build')]);
      return {
        root,
        size: Number(run(path.join(root, 'build', 'record'), [])),
        commands: readCompileCommands(path.join(root, 'build', 'compile_commands.json')),
        hasHeader: true,
      };
    },
  },
  {
    name: 'Meson',
    tools: ['meson', 'ninja'],
    build(root) {
      run('meson', ['setup', 'build'], { cwd: root });
      run('meson', ['compile', '-C', 'build'], { cwd: root });
      return {
        root,
        size: Number(run(path.join(root, 'build', 'record'), [])),
        commands: readCompileCommands(path.join(root, 'build', 'compile_commands.json')),
        hasHeader: true,
      };
    },
  },
  {
    name: 'Bazel',
    tools: ['bazel'],
    build(root, home) {
      const startup = [`--output_user_root=${path.join(home, 'bazel')}`];
      const registry = process.env.BAZEL_REGISTRY
        ? [`--registry=${process.env.BAZEL_REGISTRY}`]
        : [];
      const bazel = (args: string[]) =>
        run('bazel', [...startup, ...args, ...registry], { cwd: root });
      try {
        bazel(['build', '//:record']);
        const execroot = bazel(['info', 'execution_root']);
        const query = JSON.parse(
          bazel(['aquery', '--output=jsonproto', 'mnemonic("CppCompile", //:record)']),
        ) as { actions: { arguments: string[] }[] };
        // Written the way hedronvision/bazel-compile-commands-extractor writes
        // it: run from the workspace, whose bazel-out link reaches the outputs.
        const commands = query.actions.map((action) => {
          const source = action.arguments[action.arguments.indexOf('-c') + 1]!;
          return { directory: root, file: path.join(root, source), arguments: action.arguments };
        });
        fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(commands));
        return {
          root,
          size: Number(run(path.join(root, 'bazel-bin', 'record'), [])),
          commands,
          // The Bazel plugin compiles in the execution root, where the
          // switches' relative paths point, and maps sources to the workspace.
          clionWorkingDirectory: execroot,
          hasHeader: true,
        };
      } finally {
        bazel(['shutdown']);
      }
    },
  },
  {
    name: 'Conan',
    tools: ['conan', 'cmake'],
    build(root, home) {
      // The package comes from this repository, not a remote: `-nr`.
      const env = { ...process.env, CONAN_HOME: path.join(home, 'conan') };
      run('conan', ['profile', 'detect', '--exist-ok'], { env });
      run('conan', ['create', 'recordlib', '-nr'], { cwd: root, env });
      run('conan', ['install', '.', '--output-folder=build', '--build=missing', '-nr'], {
        cwd: root,
        env,
      });
      const build = path.join(root, 'build');
      run('cmake', [
        '-S',
        root,
        '-B',
        build,
        ...ninja(),
        `-DCMAKE_TOOLCHAIN_FILE=${path.join(build, 'conan_toolchain.cmake')}`,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
      ]);
      run('cmake', ['--build', build]);
      return {
        root,
        size: Number(run(path.join(build, 'record'), [])),
        commands: readCompileCommands(path.join(build, 'compile_commands.json')),
        hasHeader: false,
      };
    },
  },
];

for (const system of BUILD_SYSTEMS) {
  const missing = system.tools.filter((tool) => !onPath(tool));
  const skip = !REQUIRE_ALL && (!hasLocalEngine || missing.length > 0);

  describe.skipIf(skip)(`a ${system.name} project`, () => {
    let home: string;
    let project: BuiltProject;

    beforeAll(() => {
      if (missing.length > 0) throw new Error(`${missing.join(', ')} not on PATH`);
      home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abi-build-system-')));
      const root = path.join(home, 'project');
      fs.cpSync(path.join(PROJECTS, system.name.toLowerCase()), root, { recursive: true });
      project = system.build(root, home);
    }, 600_000);

    afterAll(() => {
      if (home) fs.rmSync(home, { recursive: true, force: true });
    });

    it('builds a program whose Record has the wide id', () => {
      // 24 on every 64-bit target with an 8-byte-aligned uint64_t; 12 without the define.
      expect(project.size).toBeGreaterThan(12);
    });

    it("is laid out from its compile_commands.json as the built program's", async () => {
      const session = await LspSession.start(uri(project.root), { enginePath: LOCAL_ENGINE });
      try {
        await expectRecordLayout(session, project, 'compile_commands.json');
      } finally {
        await session.stop();
      }
    });

    it('is laid out from commands pushed the way the CLion plugin pushes them', async () => {
      // Out of the way, so the pushed commands are the only ones there are.
      for (const file of findCompileCommandsFiles(project.root)) {
        fs.renameSync(file, `${file}.hidden`);
      }
      const session = await LspSession.start(uri(project.root), { enginePath: LOCAL_ENGINE });
      try {
        await session.notify(compileCommandsNotification, {
          source: 'CLion',
          commands: project.commands.map((command) => asClionPushes(command, project)),
        });
        await expectRecordLayout(session, project, 'CLion');
      } finally {
        await session.stop();
      }
    });
  });
}

async function expectRecordLayout(session: LspSession, project: BuiltProject, source: string) {
  const main = path.join(project.root, 'src', 'main.cpp');
  await session.open(uri(main));
  // A use of the type, in the file the command was written for.
  const line = fs
    .readFileSync(main, 'utf8')
    .split('\n')
    .findIndex((text) => text.includes('sizeof(Record)'));
  const character = fs.readFileSync(main, 'utf8').split('\n')[line]!.indexOf('Record)');
  const hover = await session.hover(uri(main), { line, character });
  const markdown = (hover?.contents as { value: string } | undefined)?.value ?? '';
  expect(markdown).toContain(`**struct Record** · ${project.size} B`);
  const { context } = await session.layout(uri(main));
  expect(context).toMatchObject({ commandSource: source, errorCount: 0, otherErrorCount: 0 });

  if (project.hasHeader) {
    // A header no command lists borrows the command of the source including it.
    const header = path.join(project.root, 'include', 'record.h');
    await session.open(uri(header));
    const { records, context: headerContext } = await session.layout(uri(header));
    expect(records.find((record) => record.name === 'Record')?.sizeBits).toBe(project.size * 8);
    expect(headerContext).toMatchObject({ commandSource: source, commandInferred: true });
  }
}

/**
 * What CLion's project model gives the plugin for a file (compiler, working
 * directory, switches without the file itself or its output), turned into a
 * command as `compileCommand` in clion/core does: compiler, switches, file.
 */
function asClionPushes(command: CompileCommand, project: BuiltProject): CompileCommand {
  const [compiler, ...rest] = command.arguments;
  const directory = project.clionWorkingDirectory ?? command.directory;
  const switches: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '-o') {
      i++;
      continue;
    }
    if (arg === '-c' || path.resolve(command.directory, arg) === command.file) continue;
    switches.push(arg);
  }
  return { directory, file: command.file, arguments: [compiler!, ...switches, command.file] };
}

function readCompileCommands(file: string): CompileCommand[] {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    directory: string;
    file: string;
    command?: string;
    arguments?: string[];
  }[];
  return entries.map((entry) => ({
    directory: entry.directory,
    file: path.resolve(entry.directory, entry.file),
    // CMake and Meson write `command`.
    arguments: entry.arguments ?? splitCommandLine(entry.command!, 'posix'),
  }));
}

function findCompileCommandsFiles(root: string): string[] {
  return [
    path.join(root, 'compile_commands.json'),
    path.join(root, 'build', 'compile_commands.json'),
  ].filter((file) => fs.existsSync(file));
}

function ninja(): string[] {
  return onPath('ninja') ? ['-G', 'Ninja'] : [];
}

function run(program: string, args: string[], options: ExecFileSyncOptions = {}): string {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: 'pipe', ...options })
      .toString()
      .trim();
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error(
      `${program} ${args.join(' ')} failed:\n${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`,
      { cause: error },
    );
  }
}

function onPath(tool: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((directory) => directory && fs.existsSync(path.join(directory, tool)));
}

function uri(file: string): string {
  return new URL(`file://${file}`).href;
}
