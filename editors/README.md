# ABI Explorer in editors

Struct layouts (size, alignment, padding, each member's offset) in VS Code, CLion, Zed and Neovim,
computed by the same clang-in-WebAssembly engine as the web app, with each project's own compile
flags and target.

| Directory | What it is | Built with |
|:--|:--|:--|
| `shared/` | What the server and the panel both use: the [protocol](shared/src/protocol.ts), the [layout model](shared/src/layoutModel.ts), size formatting | (source only) |
| `server/` | `abi-explorer-lsp`, the language server every editor runs: hovers, the wasted-space warning, the reorder and pin code actions and the `abiExplorer/layout` request | npm, esbuild |
| `panel/` | The layout panel (byte map and member table) shown by VS Code's webview and CLion's tool window | npm, esbuild |
| `vscode/` | The VS Code extension: the server, the Struct Layout view, CMake Tools' compile commands | npm, vsce |
| `zed/` | The Zed extension: runs the server from the GitHub release with Zed's Node.js | cargo (`wasm32-wasip2`) |
| `clion/` | The CLion plugin: the server through the IntelliJ LSP API, the panel in JCEF, CLion's project model | Gradle |
| `neovim/` | `lsp/abi_explorer.lua` for `vim.lsp.enable`, and `:AbiLayout`, a text split | nothing to build |

What is shared, and why:

- **The server** does everything that is the same in every editor: finding compile commands,
  asking the compiler for its headers, running the engine, and drawing layouts as markdown, text
  and SVG. Editors only start it and pass on what they know better (CMake Tools' or CLion's
  compile commands).
- **The panel** is shared by the two editors that can show a web page. Zed has no panels for
  extensions and Neovim's is text, which the server draws (`includeText`).
- **`shared/`** is what every drawing agrees on, and with the web explorer: which byte and bit
  belong to which member, its colour (the web's, Nocturne's on dark themes), the member table's
  rows and the record summary. It is bundled into the server and
  the panel, never published on its own.

The engine (about 50 MB) is never bundled: the server downloads the pinned release once into the
user's cache, checking its SHA-256.

## Building and testing

You need Node.js 22.18 or newer (24 in CI: the tests run the server's TypeScript directly), and for
the parts you touch: a C++ compiler (the integration tests probe it for headers), Neovim 0.11+,
Java 21 for CLion, and Rust with the `wasm32-wasip2` target for Zed.

```sh
node ../tools/fetch-abi-module.mjs   # the engine the integration tests run (or set ABI_ENGINE_PATH)
npm install                 # in editors/
npm run build               # vscode/build.mjs builds server/, then panel/, then the extension
npm test                    # unit and integration tests (vitest), Neovim's included
npm run check               # type-check every package
npm run format:check        # prettier
```

Suites that need something missing (the engine, a compiler, Neovim, code-server, a build system)
skip themselves. CI sets `ABI_EXPLORER_REQUIRE_ALL=1`, which makes them fail instead.

| Editor | What tests it | Where it runs in CI |
|:--|:--|:--|
| all | `server/test`: unit tests, and the server end to end on a fixture project with the real engine and compiler | `npm test` |
| all | `server/test/build-systems`: real CMake, Meson, Bazel and Conan projects, built and laid out from their compile commands and from commands pushed as CLion pushes them (`npm run test:build-systems`) | smoke job |
| VS Code | `vscode/test/e2e`: the VSIX installed in code-server, driven by Playwright | smoke job |
| CLion | `clion/core` (`./gradlew -p core test`); `PluginSmokeTest` in the real IntelliJ Platform (`./gradlew test`); `verifyPlugin` | build and smoke jobs |
| Zed | `zed/test/smoke.mjs`: extension.wasm in real Zed under Xvfb | smoke job |
| Neovim | `neovim/test`: the plugin in headless Neovim | `npm test` and smoke job |

The smoke jobs in [`.github/workflows/editors-release.yml`](../.github/workflows/editors-release.yml)
test the packages a release ships (the server tarball, the VSIX, the CLion, Zed and Neovim zips)
rather than the source tree. `ABI_EXPLORER_SERVER` points the server tests and the Neovim
test at another build of the server, and `VSIX` the VS Code test at another package.

Locally:

```sh
npm run package -w vscode
CODE_SERVER_ENTRY=…/code-server/out/node/entry.js npx playwright test   # screenshots in screenshots/

(cd zed && cargo build --release --target wasm32-wasip2)
ZED=…/zed.app/bin/zed node zed/test/smoke.mjs                          # needs Xvfb and xdotool

npm run test:build-systems   # whichever of cmake, meson, bazel, conan are installed
```

Zed and Neovim screenshots come from `scripts/desktop-screenshots.sh` (Xvfb; see its header).

The CLion plugin needs `npm run build` first (it copies `server/dist` and `panel/dist`), then
`./gradlew buildPlugin` in `clion/`. Its IDE-free logic tests on its own: `./gradlew -p core test`.
The IntelliJ Platform comes from JetBrains' servers, so building the plugin needs them reachable.

## Releasing

All editors share one version. See [RELEASING.md](RELEASING.md) for cutting a release and for the
accounts and secrets publishing needs.
