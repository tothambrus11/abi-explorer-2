# ABI Explorer for VS Code

See how your C and C++ structs are laid out, with your project's own compile flags and target:

- **Hover** a struct's name for its size, alignment, padding and a byte map; hover a member for its offset.
- **Inlay hints** after each struct name: `40 B · align 8 · 9 B padding`.
- **Struct Layout** view in the Explorer, following the caret, with a member table you can click to jump, and a button that copies the layout as text.

Flags come from, in order: CMake Tools, `compile_commands.json` (searched like clangd does, or the directory clangd or the C/C++ extension is told to use), `compile_flags.txt`, then `abiExplorer.fallbackFlags`. System headers are found by asking the project's compiler, the way clangd's `--query-driver` does; MSVC (`cl.exe`, `clang-cl`) projects are supported.

The layout engine (clang compiled to WebAssembly, about 50 MB) is downloaded once on first use and shared by every editor that uses it.

## Settings

| Setting | Default | |
|:--|:--|:--|
| `abiExplorer.inlayHints` | `records` | `records`, `members` (also each member's offset), or `off` |
| `abiExplorer.compileCommandsDir` | | Where `compile_commands.json` is, when it is not found by searching |
| `abiExplorer.allowedCompilers` | `[]` | Globs of compilers inside the workspace that may be run |
| `abiExplorer.fallbackFlags` | `[]` | Flags for files no compile command covers |
