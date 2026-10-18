# ABI Explorer for VS Code

See how your C and C++ structs are laid out, with your project's own compile flags and target:

- **Hover** a struct's name for its size, alignment, padding and a byte map; hover a member for its offset. Uses of a type hover the same way, library types included: `std::string`, `std::vector<int>`.
- A **warning** on a struct whose member order wastes space, saying how small another order would make it. A struct laid out on purpose (a wire format, say) keeps its order with `// abi-explorer: keep order` above it, which the warning's other fix, **Keep this member order**, writes.
- **Refactorings** on a struct (the light bulb, or `Ctrl+.`): **Reorder members by alignment**, the quick fix for that warning, moves the member lines into the order that packs tightest (positional initializers such as `{'a', 1.5}` elsewhere then need the new order too); **Pin layout with static_assert** adds assertions of its size, alignment and (where the file includes `<cstddef>`) member offsets, so a change that moves them stops the build.
- **Struct Layout** view in the Explorer, drawn as the web explorer draws a layout: a tab per struct, its size tiles, a byte grid (bit by bit for bit-fields, striped where union members share a byte) and the nested member table. It follows the caret; click a member to jump to it, a compound member's name to open its struct (in its header, if that is where it is declared), or hover a byte to light up its member here and in the editor. Members of the struct on screen get a dot in their colour, as on the web.

Flags come from, in order: CMake Tools, `compile_commands.json` (searched like clangd does, or the directory clangd or the C/C++ extension is told to use), `compile_flags.txt`, then `abiExplorer.fallbackFlags`. System headers are found by asking the project's compiler, the way clangd's `--query-driver` does; MSVC (`cl.exe`, `clang-cl`) projects are supported.

The layout engine (clang compiled to WebAssembly, about 50 MB) is downloaded once on first use and shared by every editor that uses it.

## Settings

| Setting | Default | |
|:--|:--|:--|
| `abiExplorer.compileCommandsDir` | | Where `compile_commands.json` is, when it is not found by searching |
| `abiExplorer.allowedCompilers` | `[]` | Globs of compilers inside the workspace that may be run |
| `abiExplorer.fallbackFlags` | `[]` | Flags for files no compile command covers |
| `abiExplorer.target` | | Lay structs out for another target, such as `armv7-unknown-linux-gnueabihf`, with the engine's bundled headers; **ABI Explorer: Choose Target…** picks one |
