# ABI Explorer for Zed

Hovers on struct and member names, and on any use of a struct (`std::string` too), show the byte
map and member table; inlay hints show each struct's size, alignment and padding (turn on
`inlay_hints` in Zed's settings). On a struct whose member order wastes space, the code actions
menu (`Ctrl+.`) offers to reorder its members by alignment. Zed has no extension panels, so there
is no side view.

The extension installs `abi-explorer-lsp` from npm with Zed's own Node.js. To run a local build:

```json
{
  "lsp": {
    "abi-explorer-lsp": {
      "binary": { "path": "node", "arguments": ["…/editors/server/dist/server.js", "--stdio"] },
      "initialization_options": { "inlayHints": "members" }
    }
  }
}
```

Develop with `zed: install dev extension` on this directory (needs the `wasm32-wasip2` Rust
target).
