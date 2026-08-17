# Vendored Clang/LLVM (WebAssembly build)

The files in this directory come verbatim from the npm package
[`@yowasp/clang`](https://www.npmjs.com/package/@yowasp/clang)
version `22.0.0-git20542-10` (`gen/` directory) — the
[YoWASP project](https://yowasp.org/)'s build of the LLVM/Clang/LLD
toolchain compiled *to* WebAssembly/WASI.

| File | Contents |
|---|---|
| `llvm.core*.wasm` | clang/LLD compiled to WebAssembly |
| `llvm-resources.tar` | clang builtin headers, libc++ headers, wasi-libc sysroot |
| `bundle.js` | the YoWASP JavaScript runtime + jco-generated bindings |

Licensing:

- LLVM/Clang and its headers: **Apache License 2.0 with LLVM exceptions**
  (see <https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT>).
- wasi-libc (inside `llvm-resources.tar`): Apache-2.0 WITH LLVM-exception /
  Apache-2.0 / MIT (see <https://github.com/WebAssembly/wasi-libc>).
- YoWASP runtime/packaging (`bundle.js`): ISC, © Catherine (whitequark)
  (see <https://github.com/YoWASP/clang>).

This project is not affiliated with the LLVM project or YoWASP.
