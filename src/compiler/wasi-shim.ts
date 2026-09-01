// Just enough WASI for a module that never touches a file.
//
// The Hylo reactor is built for `wasm32-unknown-wasip1`, so wasi-libc's
// imports have to be satisfied for it to instantiate at all. Almost none of
// them are reached: the standard library arrives through `hylo_init` rather
// than off a disk, and nothing in a layout query opens, reads or writes a
// file. What is left is the clock the allocator's bookkeeping consults, the
// randomness the hash seeds want, and a `fd_write` that carries the runtime's
// own complaints to the console.
//
// A full shim (`@bjorn3/browser_wasi_shim` and friends) would work too, and
// bring a virtual file system nothing would put a file in. The failing
// implementations below are the interesting part: they are what makes an
// accidental file access show up as a Hylo diagnostic rather than as a wrong
// answer.

/** WASI's "function not supported". */
const ENOSYS = 52;
/** WASI's "bad file descriptor". */
const EBADF = 8;

/** How the guest's linear memory is reached, once it has one. */
export interface MemorySource {
  memory: WebAssembly.Memory | null;
}

/**
 * The `wasi_snapshot_preview1` imports, over the memory `source` will point at
 * once the module is instantiated.
 *
 * `onText` receives whatever the guest writes to its output descriptors, which
 * is the runtime's own diagnostics: a fatal error prints there before the
 * instance traps, and losing it makes the trap unreadable.
 */
export function wasiImports(
  source: MemorySource,
  onText: (fd: number, text: string) => void,
): WebAssembly.ModuleImports {
  const view = () => new DataView(source.memory!.buffer);
  const bytes = () => new Uint8Array(source.memory!.buffer);
  const decoder = new TextDecoder();

  /** Writes 0 to each of `pointers`, which is what "there are none" looks like. */
  const none = (...pointers: number[]) => {
    const v = view();
    for (const p of pointers) v.setUint32(p, 0, true);
    return 0;
  };

  return {
    // Neither arguments nor environment: the module is called through its
    // exports, so there is no command line to describe.
    args_sizes_get: (count: number, size: number) => none(count, size),
    args_get: () => 0,
    environ_sizes_get: (count: number, size: number) => none(count, size),
    environ_get: () => 0,

    clock_res_get: (_id: number, out: number) => {
      // A millisecond, in nanoseconds: `performance.now()` is what the times
      // below come from, and claiming better than it delivers would be a lie.
      view().setBigUint64(out, 1_000_000n, true);
      return 0;
    },
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      // 0 is the realtime clock; anything else is monotonic, and a page's
      // monotonic clock starts when the page did.
      const ms = id === 0 ? Date.now() : performance.now();
      view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
      return 0;
    },

    random_get: (p: number, n: number) => {
      crypto.getRandomValues(bytes().subarray(p, p + n));
      return 0;
    },

    /** Standard output and standard error, gathered as text; anything else fails. */
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const v = view();
      const parts: Uint8Array[] = [];
      let n = 0;
      for (let i = 0; i < count; i++) {
        const p = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        parts.push(bytes().slice(p, p + len));
        n += len;
      }
      const joined = new Uint8Array(n);
      let at = 0;
      for (const part of parts) {
        joined.set(part, at);
        at += part.length;
      }
      onText(fd, decoder.decode(joined));
      v.setUint32(written, n, true);
      return 0;
    },

    /**
     * A trap the guest asked for. Thrown rather than returned: the instance is
     * unusable afterwards, and a status code would let the caller carry on
     * against a half-destroyed heap.
     */
    proc_exit: (code: number) => {
      throw new Error(`the Hylo module exited with status ${String(code)}`);
    },

    // There is no file system. `fd_prestat_get` answering EBADF is how
    // wasi-libc learns that, which it asks once and then stops asking.
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_close: () => EBADF,
    fd_fdstat_get: () => EBADF,
    fd_fdstat_set_flags: () => EBADF,
    fd_filestat_get: () => EBADF,
    fd_filestat_set_size: () => EBADF,
    fd_filestat_set_times: () => EBADF,
    fd_pread: () => EBADF,
    fd_read: () => EBADF,
    fd_readdir: () => EBADF,
    fd_seek: () => EBADF,
    fd_sync: () => EBADF,
    fd_tell: () => EBADF,
    path_create_directory: () => ENOSYS,
    path_filestat_get: () => ENOSYS,
    path_filestat_set_times: () => ENOSYS,
    path_link: () => ENOSYS,
    path_open: () => ENOSYS,
    path_readlink: () => ENOSYS,
    path_remove_directory: () => ENOSYS,
    path_rename: () => ENOSYS,
    path_symlink: () => ENOSYS,
    path_unlink_file: () => ENOSYS,
    poll_oneoff: () => ENOSYS,
  };
}
