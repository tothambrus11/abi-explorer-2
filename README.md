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
- The C++ standard library is on board, for every target: `#include <string>`
  resolves against bundled libc++ and musl headers, so `sizeof(std::string)` is
  answered for the target you picked rather than for the machine you are on —
  Windows, Darwin, WASI and bare-metal included. The footer says which headers
  answered; off Linux the C declarations are portable ones over that target's
  own scalar types, and `<locale>`, `<iostream>` and `<sys/*.h>` are not there
  rather than being answered with something else's numbers.
- Editor (Monaco, JetBrains Mono): colored gutter dots per member, hovering a
  line highlights its members in the grid/table (and vice versa), an inline
  `offset · size · align` hint, a documentation popup for any type name,
  clang's colored diagnostics, and squiggles for errors.
- Panels (Code / Layout / Diagnostics) are dockable and resizable (dockview);
  themes: six presets plus a theme editor for your own (light/dark switch
  flips between your last-used ones).
- Share button encodes source + options in the URL; installable PWA that keeps
  working offline once the module has been downloaded.

## How it works

The app asks one question and reads the answer.

[**clang-abi-wasm**](https://github.com/tothambrus11/clang-abi-wasm) is clang's
frontend — parser, semantic analysis and every target's ABI knowledge, with no
LLVM backends — compiled to WebAssembly behind a single entry point:

```js
const response = abi.query({ source, triple: 'aarch64-apple-macosx', lang: 'c++' });
```

Back comes everything the views need, as data: record sizes and alignments,
each member's offset, size and alignment, base subobjects with their source
ranges, vtable and vbtable pointers, padding runs, source locations, type
names, clang's diagnostics both structured and rendered — and the drawing
itself: which extents exist, what contains what, what overlaps what.

That last part matters more than it sounds. Containment is not recoverable from
a list of offsets: working out which byte belongs to which field of which base
means guessing, and the guess fails exactly where layout gets interesting — an
empty base sharing an address with the first member, a virtual base that moves,
a member whose tail padding the derived class reuses. Clang knows all of it
while it is laying the record out, so it reports it rather than printing it
away.

What this replaced ran six or more compiles of the user's file per keystroke —
a baseline pass for scalar sizes, a layout dump, up to four rounds of probe
translation units to measure each member, an AST dump per record for source
locations — and then about 2500 lines of JavaScript to put back the structure
those dumps had flattened.

A plain struct went from 33 ms to under 2 ms, and one that includes `<string>`
from 948 ms to 440 ms — the second is smaller because what remains is clang
parsing libc++, which no amount of pipeline shape makes cheaper. The
JavaScript is gone either way.

What is left here is what is genuinely a viewer's business: which colour a
member gets, what counts as one unit on screen, and what to do when you point
at something.

## Development

```sh
npm install
npm run abi:fetch    # the layout module (a pinned clang-abi-wasm release)
npm run dev          # Vite dev server
npm test             # unit tests — recorded answers, plus the real module when present
npm run e2e          # Playwright against the production build
npm run check        # svelte-check + tsc (strict)
npm run lint         # eslint (strict, type-checked)
npm run fixtures     # re-record the corpus (tests/fixtures/responses)
```

To iterate on the module itself, point the app at a local build instead — a
rebuild there shows up here on reload:

```sh
cd ../clang-abi-wasm && scripts/build.sh wasm && scripts/dev-link.sh ../abi-explorer-2
```

`npm run abi:fetch` leaves that symlink alone.

### Tests

- **Recorded** — `tests/fixtures/responses/` holds one real query response per
  (example, target). Every model, tree, padding and line-index test runs off
  those, so the suite needs no compiler and still checks real answers.
- **Laws** — `tests/unit/model-laws.ts` states what must be true of any render
  model: padding is exactly the uncovered bytes, the tree partitions the leaves,
  a table row lights the byte map iff it claims bytes, and so on. They run
  twice — over the corpus, exhaustively, and over generated programs.
- **Generated** — `properties.real.test.ts` emits random record declarations
  (bit-fields straddling storage units, virtual bases, anonymous aggregates,
  over-aligned members, packed structs), compiles them for real on three
  targets, and checks the same laws. It generates _source_, not layouts: a
  generator that invented layouts could only produce what its author already
  believed clang does.
- **Real** — `abi.real.test.ts` drives the shipped module end to end.

The `.real.` suites skip themselves when no module is present.

## Repository layout

```
src/core/          pure, unit-tested: render (wire -> model, colours), types,
                   options, url-state, targets, themes, ansi
src/compiler/      abi.worker (the module in a Worker), AbiClient (protocol),
                   AbiAnalyzer (query -> Analysis, caching, spelling probes)
src/state/         store (Svelte 5 runes), session (orchestration, hover, type
                   docs), code-locations (the editor's per-line index), theme
src/ui/            Svelte components, Monaco setup, dockview integration, themes
tests/unit/        vitest; tests/fixtures/responses holds the recorded corpus
tests/e2e/         Playwright against the production build
tools/             fetch-abi-module.mjs (pull a pinned module release)
public/vendor/abi  the layout module the site serves
```

## Deployment

Cloudflare Pages via Git integration: build command `npm run build`, output
directory `dist`. The build fetches the pinned module first — a site built
without it loads and then cannot answer anything — and keeps going on a network
failure only when the module is already there. CI (`.github/workflows/ci.yml`) fetches the pinned
clang-abi-wasm release and then runs lint, type-check, the unit suites
(including the ones that drive the real module), the build, and Playwright — all
against the same copy of the module the site serves.
