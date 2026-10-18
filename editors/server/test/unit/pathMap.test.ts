import { describe, expect, it } from 'vitest';
import { createPathMap } from '../../src/engine/pathMap.ts';

describe('createPathMap', () => {
  it('mounts the POSIX root under /host', () => {
    const map = createPathMap('linux');
    expect(map.mounts).toEqual([{ host: '/', guest: '/host' }]);
    expect(map.toGuest('/usr/include/../include/stdio.h')).toBe('/host/usr/include/stdio.h');
    expect(map.toHost('/host/home/a.h')).toBe('/home/a.h');
    expect(map.toHost('/usr/lib/clang/22/include/stddef.h')).toBeNull();
  });

  it('mounts each Windows drive as its own directory', () => {
    const map = createPathMap('win32', ['C', 'd']);
    expect(map.mounts).toEqual([
      { host: 'C:\\', guest: '/host/c' },
      { host: 'D:\\', guest: '/host/d' },
    ]);
    expect(map.toGuest('c:\\Src\\a.h')).toBe('/host/c/Src/a.h');
    expect(map.toGuest('D:\\')).toBe('/host/d');
    expect(map.toHost('/host/c/Src/a.h')).toBe('C:\\Src\\a.h');
    expect(() => map.toGuest('\\\\server\\share\\a.h')).toThrow(/drive-letter/);
  });
});
