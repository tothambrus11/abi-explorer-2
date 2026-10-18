// Host paths as the engine sees them.
//
// The engine is clang built for a POSIX-pathed wasm runtime, so to it
// `C:\src\a.h` is a relative path and `/usr/include` is a directory inside its
// own bundled sysroot. Every host directory it may read is therefore mounted
// under one guest root, and paths cross the boundary only through `toGuest`
// (flags and file names, on the way in) and `toHost` (locations, on the way out).

import path from 'node:path';

export const GUEST_ROOT = '/host';

/** One host directory and where the engine sees it. */
export interface Mount {
  host: string;
  guest: string;
}

export interface PathMap {
  readonly mounts: readonly Mount[];
  /** An absolute host path, as the engine must be told it. */
  toGuest(hostPath: string): string;
  /** The host path behind a guest path, or null for the engine's own files. */
  toHost(guestPath: string): string | null;
}

/**
 * `drives` lists the Windows drive letters to mount (`['C', 'D']`); it is
 * ignored elsewhere, where the whole filesystem is one mount.
 */
export function createPathMap(platform: NodeJS.Platform, drives: readonly string[] = []): PathMap {
  return platform === 'win32' ? windowsPathMap(drives) : posixPathMap();
}

function posixPathMap(): PathMap {
  return {
    mounts: [{ host: '/', guest: GUEST_ROOT }],
    toGuest: (hostPath) => GUEST_ROOT + path.posix.normalize(hostPath),
    toHost: (guestPath) =>
      guestPath.startsWith(GUEST_ROOT + '/') ? guestPath.slice(GUEST_ROOT.length) : null,
  };
}

function windowsPathMap(drives: readonly string[]): PathMap {
  return {
    mounts: drives.map((letter) => ({
      host: `${letter.toUpperCase()}:\\`,
      guest: `${GUEST_ROOT}/${letter.toLowerCase()}`,
    })),
    toGuest(hostPath) {
      const normalized = path.win32.normalize(hostPath);
      const drive = /^([a-zA-Z]):\\/.exec(normalized);
      if (!drive) throw new Error(`not a drive-letter path: ${hostPath}`);
      const rest = normalized.slice(3).split('\\').filter(Boolean).join('/');
      return `${GUEST_ROOT}/${drive[1]!.toLowerCase()}${rest ? '/' + rest : ''}`;
    },
    toHost(guestPath) {
      const match = /^\/host\/([a-z])(\/.*)?$/.exec(guestPath);
      if (!match) return null;
      return `${match[1]!.toUpperCase()}:\\${(match[2] ?? '').slice(1).split('/').join('\\')}`;
    },
  };
}
