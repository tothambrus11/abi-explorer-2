import { describe, expect, it } from 'vitest';
import { mapPathOptions, prepareCommand, splitCommandLine, translateMsvcFlags } from '../../src/compile/commandLine.ts';

describe('prepareCommand', () => {
  it('drops wrappers, the input and outputs, and makes paths absolute', () => {
    const prepared = prepareCommand(
      {
        directory: '/p/build',
        file: '../src/a.cpp',
        arguments: ['ccache', 'g++', '-I../include', '-isystem', 'third_party', '-DX=1', '-MD', '-MF', 'a.d', '-o', 'a.o', '-c', '../src/a.cpp', '-Werror=shadow'],
      },
      'posix',
    );
    expect(prepared).toEqual({
      compiler: 'g++',
      driver: 'gnu',
      flags: ['-I/p/include', '-isystem', '/p/build/third_party', '-DX=1'],
      language: null,
    });
  });

  it('reads the language from -x', () => {
    const prepared = prepareCommand({ directory: '/p', file: 'a.h', arguments: ['clang', '-x', 'c++-header', 'a.h'] }, 'posix');
    expect(prepared.language).toBe('c++');
  });

  it('recognises cl.exe and clang-cl as MSVC drivers', () => {
    const cl = prepareCommand(
      { directory: 'C:\\p\\out', file: 'C:\\p\\a.cpp', arguments: ['C:\\VC\\bin\\cl.exe', '/nologo', '/I..\\inc', '/DWIN', '/TP', '/Fo:a.obj', 'C:\\p\\a.cpp'] },
      'win32',
    );
    expect(cl).toEqual({ compiler: 'C:\\VC\\bin\\cl.exe', driver: 'msvc', flags: ['-I', 'C:\\p\\inc', '-DWIN'], language: 'c++' });
    const clangCl = prepareCommand({ directory: 'C:\\p', file: 'a.c', arguments: ['clang-cl.exe', '/c', 'a.c'] }, 'win32');
    expect(clangCl.driver).toBe('msvc');
  });
});

describe('translateMsvcFlags', () => {
  it('keeps what changes a layout and drops the rest', () => {
    expect(
      translateMsvcFlags(['/std:c++latest', '/Zp4', '/vd2', '/vmg', '/J', '/external:I', 'C:\\ext', '/external:W0', '/FIpch.h', '/DA#1', '/O2', '/EHsc', '/MD']).flags,
    ).toEqual([
      '-std=c++2c',
      '-fpack-struct=4',
      '-Xclang',
      '-vtordisp-mode=2',
      '-Xclang',
      '-fms-memptr-rep=virtual',
      '-funsigned-char',
      '-isystem',
      'C:\\ext',
      '-include',
      'pch.h',
      '-DA=1',
    ]);
  });

  it('accepts dash spellings and reads /TC', () => {
    expect(translateMsvcFlags(['-Iinc', '-TC'])).toEqual({ flags: ['-I', 'inc'], language: 'c' });
  });
});

describe('mapPathOptions', () => {
  it('maps joined and separate spellings without confusing -isystem with -I', () => {
    const upper = (value: string) => value.toUpperCase();
    expect(mapPathOptions(['-Ia', '-I', 'b', '-isystemc', '--sysroot=d', '-iquote', 'e', '-DI=f'], upper)).toEqual([
      '-IA',
      '-I',
      'B',
      '-isystemC',
      '--sysroot=D',
      '-iquote',
      'E',
      '-DI=f',
    ]);
  });
});

describe('splitCommandLine', () => {
  it('follows POSIX shell quoting', () => {
    expect(splitCommandLine(`cc -DMSG="a b" -I'x y' -DQ=\\"q\\" a.c`, 'posix')).toEqual(['cc', '-DMSG=a b', '-Ix y', '-DQ="q"', 'a.c']);
  });

  it('follows Windows rules, where backslashes are separators', () => {
    expect(splitCommandLine('cl.exe /I"C:\\Program Files\\inc" /DQ=\\"q\\" C:\\src\\a.cpp', 'win32')).toEqual([
      'cl.exe',
      '/IC:\\Program Files\\inc',
      '/DQ="q"',
      'C:\\src\\a.cpp',
    ]);
  });
});
