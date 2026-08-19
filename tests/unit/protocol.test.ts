// The messages crossing the worker boundary. Both sides validate at runtime, so
// a malformed or hostile message is dropped rather than half-applied — these
// pin the rejection paths, which are the ones that never run in practice.
import { describe, it, expect } from 'vitest';
import { parseRequest, parseResponse } from '$compiler/protocol';

describe('parseRequest', () => {
  it('accepts the three request shapes', () => {
    expect(parseRequest({ type: 'init' })).toEqual({ type: 'init' });
    expect(parseRequest({ type: 'cancel', id: 3 })).toEqual({ type: 'cancel', id: 3 });
    const compile = {
      type: 'compile',
      id: 1,
      argv0: 'clang++',
      args: ['-x', 'c++'],
      files: { 'input.cc': 'struct S {};' },
    };
    expect(parseRequest(compile)).toEqual(compile);
  });

  it('rejects anything that is not a request', () => {
    const bad: [label: string, value: unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['a number', 0],
      ['a bare string', 'init'],
      ['an array', []],
      ['an empty object', {}],
      ['an unknown type', { type: 'nope' }],
    ];
    for (const [label, value] of bad) expect(parseRequest(value), label).toBeNull();
  });

  it('rejects a compile with the wrong field types', () => {
    const base = { type: 'compile', id: 1, argv0: 'clang', args: [], files: {} };
    expect(parseRequest({ ...base, id: '1' })).toBeNull();
    expect(parseRequest({ ...base, args: 'x' })).toBeNull();
    expect(parseRequest({ ...base, args: [1] })).toBeNull();
    expect(parseRequest({ ...base, files: { a: 1 } })).toBeNull();
    expect(parseRequest({ ...base, files: null })).toBeNull();
  });

  it('only lets the two clang drivers through, never an arbitrary executable', () => {
    const base = { type: 'compile', id: 1, args: [], files: {} };
    expect(parseRequest({ ...base, argv0: 'clang' })).not.toBeNull();
    expect(parseRequest({ ...base, argv0: 'clang++' })).not.toBeNull();
    expect(parseRequest({ ...base, argv0: 'sh' })).toBeNull();
    expect(parseRequest({ ...base, argv0: 'llvm-ar' })).toBeNull();
  });

  it('drops fields it does not know rather than passing them along', () => {
    const parsed = parseRequest({ type: 'cancel', id: 2, extra: 'ignored' });
    expect(parsed).toEqual({ type: 'cancel', id: 2 });
  });
});

describe('parseResponse', () => {
  it('accepts each response shape, with error’s optional id', () => {
    expect(parseResponse({ type: 'ready', version: 'clang 22' })).not.toBeNull();
    expect(
      parseResponse({ type: 'progress', phase: 'download', done: 1, total: 2 }),
    ).not.toBeNull();
    expect(
      parseResponse({ type: 'result', id: 1, code: 0, stdout: '', stderr: '' }),
    ).not.toBeNull();
    expect(parseResponse({ type: 'error', message: 'boom' })).not.toBeNull();
    expect(parseResponse({ type: 'error', id: 4, message: 'boom' })).not.toBeNull();
  });

  it('rejects an unknown progress phase or a missing field', () => {
    expect(parseResponse({ type: 'progress', phase: 'thinking', done: 1, total: 2 })).toBeNull();
    expect(parseResponse({ type: 'result', id: 1, code: 0, stdout: '' })).toBeNull();
    expect(parseResponse({ type: 'ready' })).toBeNull();
    expect(parseResponse({ type: 'error' })).toBeNull();
  });
});
