# ABI Explorer for Zed

Hovers on struct and member names, and on any use of a struct (`std::string` too), show the byte
map and member table, with the struct's size, alignment and padding. A struct whose member order wastes space gets a warning saying how
small another order would make it; `// abi-explorer: keep order` above a struct, which the
warning's other code action writes, says the order is meant. On a struct, the code actions menu (`Ctrl+.`) offers to pin its
layout with `static_assert`, and, on one with that warning, to reorder its members by alignment. Zed has no extension panels, so there
is no side view.

The extension installs `abi-explorer-lsp` from npm with Zed's own Node.js. To run a local build:

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
target).
