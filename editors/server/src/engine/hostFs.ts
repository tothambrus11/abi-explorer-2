// A read-only Emscripten filesystem backed by Node's `fs`.
//
// The released engine is linked with MEMFS only, but it exports `FS`, and
// Emscripten lets a filesystem type be mounted at runtime from JavaScript. This
// is that type: just enough of NODEFS for clang to stat, list and read the
// user's headers, with no way to write to them.
//
// Symlinks are followed on the host rather than shown to the engine. A link
// target like `/usr/lib/x` would otherwise be resolved inside the guest, where
// `/usr` is the engine's bundled sysroot.

import fs from 'node:fs';
import path from 'node:path';

/** The parts of Emscripten's FS object this file touches. */
export interface EmscriptenFs {
  ErrnoError: new (errno: number) => Error;
  createNode(parent: FsNode | null, name: string, mode: number): FsNode;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  mkdirTree(path: string): void;
  mount(type: FilesystemType, options: { root: string }, mountpoint: string): void;
}

export interface FsNode {
  id: number;
  name: string;
  mode: number;
  parent: FsNode;
  mount: { opts: { root: string } };
  node_ops: object;
  stream_ops: object;
}

interface FsStream {
  node: FsNode;
  position: number;
  hostFd?: number;
}

export interface FilesystemType {
  mount(mount: unknown): FsNode;
}

// Emscripten's errno numbering, not the host's.
const ERRNO: Readonly<Record<string, number>> = {
  EACCES: 2,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ELOOP: 32,
  ENOENT: 44,
  ENOTDIR: 54,
  EPERM: 63,
};
const DIRECTORY_MODE = 0o40755;
const FILE_MODE = 0o100644;

export function createHostFs(FS: EmscriptenFs): FilesystemType {
  const fail = (error: unknown): never => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new FS.ErrnoError((code !== undefined ? ERRNO[code] : undefined) ?? ERRNO.EIO!);
  };
  const readOnly = (): never => {
    throw new FS.ErrnoError(ERRNO.EPERM!);
  };

  const hostPath = (node: FsNode): string => {
    const names: string[] = [];
    while (node.parent !== node) {
      names.push(node.name);
      node = node.parent;
    }
    return path.join(node.mount.opts.root, ...names.reverse());
  };

  const stat = (file: string): fs.Stats => {
    try {
      return fs.statSync(file);
    } catch (error) {
      return fail(error);
    }
  };

  const createNode = (parent: FsNode | null, name: string, isDirectory: boolean): FsNode => {
    const node = FS.createNode(parent, name, isDirectory ? DIRECTORY_MODE : FILE_MODE);
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    return node;
  };

  const nodeOps = {
    getattr(node: FsNode) {
      const s = stat(hostPath(node));
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: s.size,
        atime: s.atime,
        mtime: s.mtime,
        ctime: s.ctime,
        blksize: 4096,
        blocks: Math.ceil(s.size / 4096),
      };
    },
    lookup(parent: FsNode, name: string) {
      return createNode(parent, name, stat(path.join(hostPath(parent), name)).isDirectory());
    },
    readdir(node: FsNode) {
      try {
        return ['.', '..', ...fs.readdirSync(hostPath(node))];
      } catch (error) {
        return fail(error);
      }
    },
    readlink(): never {
      throw new FS.ErrnoError(ERRNO.EINVAL!);
    },
    setattr: readOnly,
    mknod: readOnly,
    rename: readOnly,
    unlink: readOnly,
    rmdir: readOnly,
    symlink: readOnly,
  };

  const streamOps = {
    open(stream: FsStream) {
      if (FS.isDir(stream.node.mode)) return;
      try {
        stream.hostFd = fs.openSync(hostPath(stream.node), 'r');
      } catch (error) {
        fail(error);
      }
    },
    close(stream: FsStream) {
      if (stream.hostFd !== undefined) fs.closeSync(stream.hostFd);
    },
    read(stream: FsStream, buffer: Int8Array, offset: number, length: number, position: number) {
      if (length === 0 || stream.hostFd === undefined) return 0;
      try {
        return fs.readSync(stream.hostFd, buffer, offset, length, position);
      } catch (error) {
        return fail(error);
      }
    },
    llseek(stream: FsStream, offset: number, whence: number) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2 && FS.isFile(stream.node.mode)) {
        position += stat(hostPath(stream.node)).size;
      }
      if (position < 0) throw new FS.ErrnoError(ERRNO.EINVAL!);
      return position;
    },
    write: readOnly,
  };

  return { mount: () => createNode(null, '/', true) };
}
