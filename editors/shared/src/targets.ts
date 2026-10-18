// The targets the editors offer when choosing one to lay structs out for.
// Neovim's `:AbiTarget` completes the same list (checked by its tests).

/** Targets whose layouts most often differ from a desktop's, by what people call them. */
export const TARGETS: { triple: string; description: string }[] = [
  { triple: 'x86_64-linux-gnu', description: 'x86-64 Linux' },
  { triple: 'x86_64-pc-windows-msvc', description: 'x86-64 Windows (MSVC)' },
  { triple: 'i686-linux-gnu', description: '32-bit x86 Linux' },
  { triple: 'aarch64-linux-gnu', description: 'AArch64 Linux' },
  { triple: 'arm64-apple-macosx', description: 'Apple silicon macOS' },
  { triple: 'armv7-unknown-linux-gnueabihf', description: '32-bit Arm Linux' },
  { triple: 'thumbv7em-none-eabi', description: 'Cortex-M4/M7, bare metal' },
  { triple: 'riscv32-unknown-elf', description: '32-bit RISC-V, bare metal' },
  { triple: 'riscv64-linux-gnu', description: '64-bit RISC-V Linux' },
  { triple: 'wasm32-wasi', description: 'WebAssembly' },
  { triple: 'avr-none', description: 'AVR (Arduino)' },
  { triple: 'powerpc-linux-gnu', description: '32-bit PowerPC, big-endian' },
];
