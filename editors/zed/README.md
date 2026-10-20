# ABI Explorer for Zed

Hovers on struct and member names, and on any use of a struct (`std::string` too), show the byte
map and member table, with the struct's size, alignment and padding. A struct whose member order wastes space gets a warning saying how
small another order would make it; `// abi-explorer: keep order` above a struct, which the
warning's other code action writes, says the order is meant. On a struct, the code actions menu (`Ctrl+.`) offers to pin its
layout with `static_assert`, and, on one with that warning, to reorder its members by alignment. Zed has no extension panels, so there
is no side view.

To install it, unzip `abi-explorer-zed-<version>.zip` from an [editors release](https://github.com/tothambrus11/abi-explorer-2/releases) into
Zed's installed extensions directory and restart Zed ([details](../RELEASING.md#installing-a-build-by-hand));
it is not in Zed's extension registry yet.

The extension downloads the language server from the GitHub release of its own version (or uses an `abi-explorer-lsp` on PATH) and runs it with Zed's own Node.js. To run a local build:

```json
{
  "lsp": {
    "abi-explorer-lsp": {
      "binary": { "path": "node", "arguments": ["…/editors/server/dist/server.js", "--stdio"] }
    }
  }
}
```

To see layouts for another target than the project's, with the engine's bundled headers, set
`"initialization_options": { "target": "armv7-unknown-linux-gnueabihf" }` under
`lsp.abi-explorer-lsp` in Zed's settings.

Develop with `zed: install dev extension` on this directory (needs the `wasm32-wasip2` Rust
target). `test/smoke.mjs` runs the built extension in Zed under Xvfb and checks what Zed asks the
server and is told (see [../README.md](../README.md#building-and-testing)).
