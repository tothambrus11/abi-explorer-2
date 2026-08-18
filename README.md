# ABI Explorer

Visualize how C and C++ compilers lay out structs — field offsets, sizes,
alignment, and padding — for **any target LLVM supports**, computed by the
real thing: **clang compiled to WebAssembly**, running entirely in your
browser. Static site, works offline (PWA), no server. Live at
<https://abiexplorer.org>.

![screenshot](docs/screenshot.png)

## Features

- Paste a struct/class/union (C or C++), pick a target triple, get the exact
  layout clang uses on that target: offsets, sizes, `sizeof`/alignment,
  C++ details (`dsize`, `nvsize`, vtable pointers, base subobjects), and every
  byte of padding — drawn as a byte grid with bit-level cells for bit-fields.
- ~40 curated targets (x86-64 SysV & MSVC, AArch64 incl. Apple & Windows,
  Arm32, RISC-V, wasm32/64, PowerPC incl. AIX, MIPS, s390x, SPARC, LoongArch,
  AVR, MSP430, m68k, Hexagon, Xtensa, BPF, NVPTX, AMDGCN, …) plus a custom
  triple. Every ABI quirk is authentic because clang's own frontend computes it.
- Options: C/C++ (each with a standard version), `-fpack-struct`,
  `-mms-bitfields`, `-fshort-enums`, `-fshort-wchar`, `-Wpadded`, extra flags.
- Editor (Monaco, JetBrains Mono): colored gutter dots per member, hovering a
  line highlights its members in the grid/table (and vice versa), an inline
  `offset · size · align` hint, a documentation popup for any type name,
  clang's colored diagnostics, and squiggles for errors.
- Panels (Code / Layout / Diagnostics) are dockable and resizable (dockview);
  themes: six presets plus a theme editor for your own (light/dark switch
  flips between your last-used ones).
- Share button encodes source + options in the URL; installable PWA that keeps
  working offline once clang has been downloaded.

## How it works

Everything type-related is answered by clang; the app only reads its outputs.

1. [`@yowasp/clang`](https://github.com/YoWASP/clang) provides clang 22 as
   WebAssembly/WASI. A Web Worker downloads its npm tarball (~27 MB) straight
   from the registry once (Cache API), unpacks it in memory, and runs clang as
   a library. `tools/vendor-clang.sh` can vendor the assets into
   `public/vendor/clang/` instead for fully self-hosted deployments.
2. **Layout pass** — the user's TU compiled with
   `-fsyntax-only -Xclang -fdump-record-layouts-complete` for the chosen
   `--target`, plus a tiny probe TU for pointer size.
3. **Field probes** — one `struct __abix_pN { __typeof__(((struct S*)0)->f) v; };`
   per member (by access path, so nested/anonymous/typedef'd members work);
   clang reports each member's exact size and alignment. C++ private members
   are reachable through `-Xclang -fno-access-control` in this
   measurement-only pass.
4. **Locations** — a filtered `-ast-dump=json` per record gives member source
   lines and declared types (for gutter dots, hover linking, and the type
   popup, which probes any spelling with `__typeof__(<spelling>)`).

## Development

```sh
npm install
npm run dev          # Vite dev server
npm test             # unit tests (fixture-backed; no clang download)
npm run e2e          # Playwright against the production build (downloads clang once)
npm run check        # svelte-check + tsc (strict)
npm run lint         # eslint (strict, type-checked)
npm run fixtures     # re-capture clang output fixtures with the real wasm clang
ABIX_REAL_CLANG=1 npx vitest run tests/unit/analyzer.real.test.ts   # integration
```

## Repository layout

```
src/core/         pure, unit-tested: layout-parser, probes, model, ast-locations,
                  diagnostics, ansi, options (argv), url-state, targets
src/compiler/     typed worker protocol, clang.worker (wasm host), ClangClient
                  (queue, cancel, timeout, watchdog/respawn), Analyzer (pipeline),
                  Compiler interface + FixtureCompiler for tests
src/state/        store (Svelte 5 runes), session (orchestration, hover, type docs), theme
src/ui/           Svelte components, Monaco setup, dockview integration, themes
tests/unit/       vitest (fixtures in tests/fixtures), tests/e2e/ Playwright
tools/            node-clang.mjs (clang in Node), vendor-clang.sh
public/vendor/    YoWASP JS runtime for clang (see NOTICE.md)
```

## Deployment

Cloudflare Pages via Git integration: build command `npm run build`, output
directory `dist`. CI (`.github/workflows/ci.yml`) runs lint, type-check, unit
tests, build, the real-clang integration test and the Playwright suite.
