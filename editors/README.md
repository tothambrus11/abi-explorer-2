# ABI Explorer in editors

Struct layouts (size, alignment, padding, each member's offset) in VS Code, CLion, Zed and Neovim,
computed by the same clang-in-WebAssembly engine as the web app, with each project's own compile
flags and target.

| Directory | What it is | Built with |
|:--|:--|:--|
| `shared/` | What the server and the panel both use: the [protocol](shared/src/protocol.ts), the [layout model](shared/src/layoutModel.ts), size formatting | (source only) |
| `server/` | `abi-explorer-lsp`, the language server every editor runs: hovers, inlay hints, the reorder and pin code actions and the `abiExplorer/layout` request | npm, esbuild |
| `panel/` | The layout panel (byte map and member table) shown by VS Code's webview and CLion's tool window | npm, esbuild |
| `vscode/` | The VS Code extension: the server, the Struct Layout view, CMake Tools' compile commands | npm, vsce |
| `zed/` | The Zed extension: runs the server from npm with Zed's Node.js | cargo (`wasm32-wasip2`) |
| `clion/` | The CLion plugin: the server through the IntelliJ LSP API, the panel in JCEF, CLion's project model | Gradle |
| `neovim/` | `lsp/abi_explorer.lua` for `vim.lsp.enable`, and `:AbiLayout`, a text split | nothing to build |

What is shared, and why:

- **The server** does everything that is the same in every editor: finding compile commands,
  asking the compiler for its headers, running the engine, and drawing layouts as markdown, text
  and SVG. Editors only start it and pass on what they know better (CMake Tools' or CLion's
  compile commands).
- **The panel** is shared by the two editors that can show a web page. Zed has no panels for
  extensions and Neovim's is text, which the server draws (`includeText`).
- **`shared/`** is what every drawing agrees on: which byte belongs to which member, its letter
  and colour, the member table's rows and the record summary. It is bundled into the server and
  the panel, never published on its own.

The engine (about 50 MB) is never bundled: the server downloads the pinned release once into the
user's cache, checking its SHA-256.

## Building and testing

```sh
npm install                 # in editors/
npm run build               # vscode/build.mjs builds server/, then panel/, then the extension
npm run package -w vscode   # the VSIX, in vscode/dist/
npm test                    # unit and integration tests (vitest)
npm run check               # type-check every package
npm run format:check        # prettier
```

The integration tests run the real engine. They use the web app's copy
(`npm run abi:fetch` at the repository root) or `ABI_ENGINE_PATH`, and skip without one.

End to end, VS Code (in code-server, driven by Playwright) writes screenshots to `screenshots/`:

```sh
npm run package -w vscode
CODE_SERVER_ENTRY=…/code-server/out/node/entry.js npx playwright test
```

Zed and Neovim screenshots come from `scripts/desktop-screenshots.sh` (Xvfb; see its header).

The CLion plugin needs `npm run build` first (it copies `server/dist` and `panel/dist`), then
`./gradlew buildPlugin` in `clion/`. Its IDE-free logic tests on its own: `./gradlew -p core test`.
