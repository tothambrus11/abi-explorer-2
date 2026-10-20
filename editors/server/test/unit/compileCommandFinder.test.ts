import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompileCommandFinder } from '../../src/compile/compileCommandFinder.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-db-'));
  fs.mkdirSync(path.join(root, 'src', 'net'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(
    path.join(root, 'build', 'compile_commands.json'),
    JSON.stringify([
      {
        directory: path.join(root, 'build'),
        file: '../src/main.cpp',
        command: 'c++ -DMAIN -c ../src/main.cpp',
      },
      {
        directory: path.join(root, 'build'),
        file: '../src/net/socket.cpp',
        arguments: ['c++', '-DNET', '-c', '../src/net/socket.cpp'],
      },
      {
        directory: path.join(root, 'build'),
        file: '../src/net/socket_c.c',
        arguments: ['cc', '-DC', '-c', '../src/net/socket_c.c'],
      },
    ]),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (relative: string) => path.join(root, relative);

describe('CompileCommandFinder', () => {
  it('finds a listed file in build/compile_commands.json', () => {
    const found = new CompileCommandFinder({ style: 'posix' }).find(file('src/main.cpp'));
    expect(found).toMatchObject({ origin: { kind: 'compile_commands.json' }, borrowedFrom: null });
    expect(found!.command.arguments).toEqual(['c++', '-DMAIN', '-c', '../src/main.cpp']);
  });

  it('lends a header the command of the source with its stem, compiling the header instead', () => {
    const found = new CompileCommandFinder({ style: 'posix' }).find(file('src/net/socket.hpp'));
    expect(found!.borrowedFrom).toBe('../src/net/socket.cpp');
    expect(found!.command).toMatchObject({ file: file('src/net/socket.hpp') });
    expect(found!.command.arguments).toEqual(['c++', '-DNET', '-c', file('src/net/socket.hpp')]);
  });

  it('does not lend a C command to a C++ header', () => {
    const found = new CompileCommandFinder({ style: 'posix' }).find(file('src/net/socket_c.hpp'));
    expect(found!.command.arguments[1]).toBe('-DNET');
  });

  it('prefers an exact pushed command, and the database over a borrowed pushed one', () => {
    const finder = new CompileCommandFinder({ style: 'posix' });
    finder.setPushedCommands('CMake Tools', [
      { directory: root, file: 'src/main.cpp', arguments: ['c++', '-DPUSHED', 'src/main.cpp'] },
    ]);
    expect(finder.find(file('src/main.cpp'))!.origin).toEqual({
      kind: 'pushed',
      label: 'CMake Tools',
    });
    expect(finder.find(file('src/net/socket.cpp'))!.origin.kind).toBe('compile_commands.json');
  });

  it('applies compile_flags.txt to every file below it', () => {
    fs.rmSync(path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'compile_flags.txt'), '-std=c++17\n-Iinclude\n');
    const found = new CompileCommandFinder({ style: 'posix' }).find(file('src/net/x.cpp'));
    expect(found!.command.arguments).toEqual([
      'c++',
      '-std=c++17',
      '-Iinclude',
      file('src/net/x.cpp'),
    ]);
  });

  it('notices a regenerated database', () => {
    const finder = new CompileCommandFinder({ style: 'posix' });
    expect(finder.find(file('src/new.cpp'))!.borrowedFrom).not.toBeNull();
    fs.writeFileSync(
      path.join(root, 'build', 'compile_commands.json'),
      JSON.stringify([{ directory: root, file: 'src/new.cpp', arguments: ['c++', 'src/new.cpp'] }]),
    );
    const later = Date.now() + 2_100;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      expect(finder.find(file('src/new.cpp'))!.borrowedFrom).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
