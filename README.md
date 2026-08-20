# ABI Explorer

See how C and C++ compilers lay out your structs: where each field lands, how
big it is, what it is aligned to, and where the padding goes. For any target
LLVM supports, computed by clang itself, compiled to WebAssembly and running in
your browser. No server, works offline. Live at <https://abiexplorer.org>.

![screenshot](docs/screenshot.png)

## What it does

Paste a struct, class or union, pick a target triple, and you get the layout
clang would use there. Offsets, sizes, `sizeof` and alignment, the C++ details
(`dsize`, `nvsize`, vtable pointers, base subobjects), and every byte of
padding, drawn as a byte grid with bit-level cells where there are bit-fields.

About 40 targets are in the dropdown: x86-64 SysV and MSVC, AArch64 including
Apple and Windows, Arm32, RISC-V, wasm32/64, PowerPC including AIX, MIPS,
s390x, SPARC, LoongArch, AVR, MSP430, m68k, Hexagon, Xtensa, BPF, NVPTX,
AMDGCN. You can also type any triple you like. The ABI quirks are real because
clang's own frontend works them out.

The layout options that matter are there too: C or C++ with a standard version,
`-fpack-struct`, `-mms-bitfields`, `-fshort-enums`, `-fshort-wchar`, `-Wpadded`,
plus a box for extra flags.

**The C++ standard library is on board, for every target.** `#include <string>`
resolves against bundled libc++ and musl headers, so `sizeof(std::string)` is
answered for the target you picked rather than for the machine you are sitting
at. Windows, Darwin, WASI and bare metal included. The footer tells you which
headers answered. Off Linux the C declarations are musl's portable ones over
that target's own scalar types, and `<locale>`, `<iostream>` and `<sys/*.h>`
are absent rather than answered with some other platform's numbers.

The editor is Monaco. Each member gets a coloured dot in the gutter, hovering a
line lights up its bytes in the grid and its row in the table (and the other
way round), there is an inline `offset · size · align` hint, and any type name
has a popup with its size and alignment. Clang's diagnostics come through in
colour, with squiggles where the errors are.

Panels (Code, Layout, Diagnostics) dock and resize. Six themes ship, and there
is an editor if you want your own. Share copies a link with your source and
options in it, and the whole thing installs as a PWA.

## How it works

The app asks one question and reads the answer.

[clang-abi-wasm](https://github.com/tothambrus11/clang-abi-wasm) is clang's
frontend, meaning the parser, semantic analysis and every target's ABI
knowledge, with none of the LLVM backends. It is compiled to WebAssembly behind
a single entry point:

```js
const response = abi.query({ source, triple: 'aarch64-apple-macosx', lang: 'c++' });
```

What comes back is everything the views need, as data. Record sizes and
alignments, each member's offset, size and alignment, base subobjects with
their source ranges, vtable and vbtable pointers, padding runs, source
locations, type names, clang's diagnostics both structured and rendered. And
the drawing itself: which extents exist, what contains what, what overlaps
what.

That last part matters more than it sounds. Containment is not recoverable from
a list of offsets. Working out which byte belongs to which field of which base
means guessing, and the guess fails exactly where layout gets interesting: an
empty base sharing an address with the first member, a virtual base that moves,
a member whose tail padding the derived class reuses. Clang knows all of it
while it is laying the record out, so it reports it instead of printing it
away.

The version this replaced ran six or more compiles of your file per keystroke.
A baseline pass for scalar sizes, a layout dump, up to four rounds of probe
translation units to measure each member, an AST dump per record for source
locations. Then about 2500 lines of JavaScript to put back the structure those
dumps had flattened.

A plain struct went from 33 ms to under 2 ms, and one that includes `<string>`
from 948 ms to 440 ms. The second improved less because what is left is clang
parsing libc++, which no amount of pipeline shape makes cheaper. The JavaScript
is gone either way.

What stayed here is what is genuinely a viewer's business: which colour a
member gets, what counts as one unit on screen, and what to do when you point
at something.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test suites and how
deployment works.
