import { describe, expect, it } from 'vitest';
import { withoutRejectedFlags } from '../../src/compile/engineRequest.ts';
import type { Diagnostic, EngineRequest } from '../../src/engine/engineTypes.ts';

const request: EngineRequest = {
  source: '',
  filename: '/p/a.cpp',
  lang: 'c++',
  triple: 'x86_64-linux-gnu',
  flags: ['-DX', '-fno-canonical-system-headers', '-mabi=lp64', '-std=c++17'],
  resourceDir: '',
  sysroot: '',
  includeSystemRecords: true,
};

const driverError = (message: string): Diagnostic => ({
  severity: 'error',
  message,
  location: null,
});

describe('withoutRejectedFlags', () => {
  it('drops the options clang reported unknown or unsupported', () => {
    const retry = withoutRejectedFlags(request, [
      driverError("unknown argument: '-fno-canonical-system-headers'"),
      driverError("unsupported option '-mabi=' for target 'x86_64-linux-gnu'"),
    ]);
    expect(retry?.flags).toEqual(['-DX', '-std=c++17']);
  });

  it('asks nothing again for errors in the code', () => {
    const inCode: Diagnostic = {
      severity: 'error',
      message: "unknown argument: '-fno-canonical-system-headers'",
      location: { file: '/p/a.cpp', line: 1, col: 1, endCol: 2, isMainFile: true },
    };
    expect(withoutRejectedFlags(request, [inCode])).toBeNull();
    expect(withoutRejectedFlags(request, [driverError('no such file')])).toBeNull();
  });
});
