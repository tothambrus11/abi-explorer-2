import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isProbeAllowed,
  looksLikeCompiler,
  parseClBanner,
  parseVerboseOutput,
  searchArguments,
  ToolchainProber,
  withArchitectureFlags,
  type Exec,
} from '../../src/compile/toolchain.ts';

const GCC_VERBOSE = `Using built-in specs.
Target: x86_64-linux-gnu
 /usr/libexec/gcc/x86_64-linux-gnu/13/cc1plus -E -quiet -v -
#include "..." search starts here:
#include <...> search starts here:
 /usr/include/c++/13
 /usr/include/x86_64-linux-gnu/c++/13
 /usr/lib/gcc/x86_64-linux-gnu/13/include
 /usr/local/include
 /usr/include
End of search list.`;

const APPLE_CLANG_VERBOSE = `Apple clang version 17.0.0
Target: arm64-apple-darwin24.1.0
#include <...> search starts here:
 /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1
 /Library/Developer/CommandLineTools/usr/lib/clang/17/include
 /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks (framework directory)
End of search list.`;

describe('parseVerboseOutput', () => {
  it('reads the target and the system include directories', () => {
    const { triple, includes } = parseVerboseOutput(GCC_VERBOSE);
    expect(triple).toBe('x86_64-linux-gnu');
    expect(includes.map((include) => include.path)).toEqual([
      '/usr/include/c++/13',
      '/usr/include/x86_64-linux-gnu/c++/13',
      '/usr/lib/gcc/x86_64-linux-gnu/13/include',
      '/usr/local/include',
      '/usr/include',
    ]);
  });

  it('marks framework directories', () => {
    const { includes } = parseVerboseOutput(APPLE_CLANG_VERBOSE);
    expect(includes.at(-1)).toEqual({
      path: '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks',
      kind: 'framework',
    });
  });
});

describe('ToolchainProber', () => {
  it('marks the compiler builtin directory, which the engine replaces with its own', async () => {
    const exec: Exec = async (_program, args) =>
      args.includes('-print-file-name=include')
        ? { stdout: '/usr/lib/gcc/x86_64-linux-gnu/13/include\n', stderr: '' }
        : { stdout: '', stderr: GCC_VERBOSE };
    const toolchain = await new ToolchainProber(exec, {}, 'linux').probe(
      { compiler: '/usr/bin/g++', driver: 'gnu', flags: ['-m32', '-O2'], language: null },
      'c++',
      { projectFolders: ['/p'], allowedCompilers: [] },
    );
    expect(toolchain.triple).toBe('i386-linux-gnu');
    expect(
      toolchain.systemIncludes
        .filter((include) => include.kind === 'builtin')
        .map((include) => include.path),
    ).toEqual(['/usr/lib/gcc/x86_64-linux-gnu/13/include']);
  });

  it('takes MSVC headers from INCLUDE and the version from the cl banner', async () => {
    const exec: Exec = async () => ({
      stdout: '',
      stderr: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.38.33133 for x86\n',
    });
    const toolchain = await new ToolchainProber(
      exec,
      { INCLUDE: 'C:\\VC\\include;C:\\Kits\\ucrt;' },
      'win32',
    ).probe({ compiler: 'C:\\VC\\bin\\cl.exe', driver: 'msvc', flags: [], language: null }, 'c++', {
      projectFolders: [],
      allowedCompilers: [],
    });
    expect(toolchain).toEqual({
      triple: 'i686-pc-windows-msvc',
      msvcVersion: '19.38',
      systemIncludes: [
        { path: 'C:\\VC\\include', kind: 'directory' },
        { path: 'C:\\Kits\\ucrt', kind: 'directory' },
      ],
    });
  });

  it('asks clang-cl in GNU mode, which finds Visual Studio by itself', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_program, args) => {
      calls.push([...args]);
      return args.includes('-print-file-name=include')
        ? { stdout: 'C:\\LLVM\\lib\\clang\\18\\include\n', stderr: '' }
        : {
            stdout: '',
            stderr:
              'Target: i686-pc-windows-msvc\n#include <...> search starts here:\n C:\\VS\\include\nEnd of search list.',
          };
    };
    const toolchain = await new ToolchainProber(exec, {}, 'win32').probe(
      {
        compiler: 'C:\\LLVM\\bin\\clang-cl.exe',
        driver: 'msvc',
        flags: ['--target=i686-pc-windows-msvc'],
        language: null,
      },
      'c++',
      { projectFolders: [], allowedCompilers: [] },
    );
    expect(calls[0]).toEqual([
      '--driver-mode=gcc',
      '-x',
      'c++',
      '--target=i686-pc-windows-msvc',
      '-E',
      '-v',
      '-',
    ]);
    expect(toolchain.triple).toBe('i686-pc-windows-msvc');
  });

  it('refuses a compiler inside the project unless allowed', async () => {
    const prober = new ToolchainProber(async () => ({ stdout: '', stderr: '' }), {}, 'linux');
    await expect(
      prober.probe({ compiler: '/p/tools/cc', driver: 'gnu', flags: [], language: null }, 'c', {
        projectFolders: ['/p'],
        allowedCompilers: [],
      }),
    ).rejects.toThrow(/allowedCompilers/);
  });
});

describe('parseClBanner', () => {
  it('reads version and architecture', () => {
    expect(
      parseClBanner('Microsoft (R) C/C++ Optimizing Compiler Version 19.40.33811 for ARM64'),
    ).toEqual({
      triple: 'aarch64-pc-windows-msvc',
      version: '19.40',
    });
    expect(parseClBanner('garbage')).toEqual({ triple: 'x86_64-pc-windows-msvc', version: null });
  });
});

describe('withArchitectureFlags', () => {
  it('follows the last -m32/-m64/-mx32 on x86 only', () => {
    expect(withArchitectureFlags('x86_64-linux-gnu', ['-m32'])).toBe('i386-linux-gnu');
    expect(withArchitectureFlags('x86_64-linux-gnu', ['-m32', '-m64'])).toBe('x86_64-linux-gnu');
    expect(withArchitectureFlags('x86_64-linux-gnu', ['-mx32'])).toBe('x86_64-linux-gnux32');
    expect(withArchitectureFlags('aarch64-linux-gnu', ['-m32'])).toBe('aarch64-linux-gnu');
  });
});

describe('searchArguments', () => {
  it('keeps only the flags that change where headers are found', () => {
    expect(
      searchArguments(
        ['-O2', '-stdlib=libc++', '-DX', '--sysroot', '/sr', '-target', 'arm64-apple-macos'],
        'c++',
      ),
    ).toEqual(['-x', 'c++', '-stdlib=libc++', '--sysroot', '/sr', '-target', 'arm64-apple-macos']);
  });
});

describe('isProbeAllowed', () => {
  const policy = { projectFolders: ['/p'], allowedCompilers: ['/p/toolchain/**'] };
  it('allows compilers outside the project and allow-listed ones inside', () => {
    expect(isProbeAllowed('/usr/bin/cc', policy, 'linux')).toBe(true);
    expect(isProbeAllowed('/p/toolchain/bin/cc', policy, 'linux')).toBe(true);
    expect(isProbeAllowed('/p/evil/cc', policy, 'linux')).toBe(false);
  });

  it('runs only programs named like compilers, so a project cannot pick an interpreter', () => {
    expect(isProbeAllowed('/usr/bin/python3', policy, 'linux')).toBe(false);
    expect(isProbeAllowed('/usr/bin/bash', policy, 'linux')).toBe(false);
    expect(
      isProbeAllowed(
        '/usr/bin/python3',
        { ...policy, allowedCompilers: ['/usr/bin/python3'] },
        'linux',
      ),
    ).toBe(true);
  });

  it('sees through symlinks out of the project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-probe-'));
    const link = path.join(root, 'gcc');
    fs.symlinkSync(process.execPath, link);
    try {
      // Named `gcc`, but really Node.js.
      expect(isProbeAllowed(link, { projectFolders: [], allowedCompilers: [] }, 'linux')).toBe(
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
});

describe('looksLikeCompiler', () => {
  it('knows driver names with targets and versions', () => {
    for (const name of [
      'cc',
      'c++',
      'g++-13',
      'clang++',
      'clang-18',
      'aarch64-linux-gnu-gcc',
      'x86_64-w64-mingw32-g++',
      'C:\\VC\\bin\\cl.exe',
      'clang-cl.exe',
      'icx',
    ]) {
      expect(looksLikeCompiler(name), name).toBe(true);
    }
    for (const name of ['python3', 'node', 'sh', 'make', 'ccache'])
      expect(looksLikeCompiler(name), name).toBe(false);
  });
});
