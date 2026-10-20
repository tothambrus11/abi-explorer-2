# @hylo-lang/abi-explorer

A language server that shows how clang lays out C and C++ records, with your project's own
compiler, flags and target: sizes, offsets, alignment and padding in hovers, a warning on structs
whose member order wastes space (with reordering as the fix), and a code action that pins a
layout with `static_assert`.

Each [editors release](https://github.com/tothambrus11/abi-explorer-2/releases) has it as
`hylo-lang-abi-explorer-<version>.tgz`; it is not on the npm registry.

```sh
npm install -g https://github.com/tothambrus11/abi-explorer-2/releases/download/editors-v<v>/hylo-lang-abi-explorer-<v>.tgz
abi-explorer-lsp --stdio
```

Node.js 20 or newer. The layout engine (clang compiled to WebAssembly, about 50 MB) is not in this
package: the server downloads its pinned release once, checks its SHA-256, and keeps it in the
user's cache directory.

Compile flags come from `compile_commands.json` (searched the way clangd searches) or
`compile_flags.txt`, or from the editor through the `abiExplorer/compileCommands` notification.
System headers are found by asking the project's compiler, as clangd's `--query-driver` does.

Editors that use it: [VS Code, CLion, Zed and Neovim](https://github.com/tothambrus11/abi-explorer-2/tree/main/editors).
The initialization options and custom messages are in
[`shared/src/protocol.ts`](https://github.com/tothambrus11/abi-explorer-2/blob/main/editors/shared/src/protocol.ts).
