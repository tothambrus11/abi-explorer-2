// Curated target triples, language standards, and example sources.

export const TARGET_GROUPS = [
  {
    label: 'x86',
    targets: [
      { triple: 'x86_64-unknown-linux-gnu', label: 'x86-64 · Linux (System V)' },
      { triple: 'x86_64-pc-windows-msvc', label: 'x86-64 · Windows (MSVC)' },
      { triple: 'x86_64-pc-windows-gnu', label: 'x86-64 · Windows (MinGW)' },
      { triple: 'x86_64-apple-macosx', label: 'x86-64 · macOS' },
      { triple: 'x86_64-unknown-linux-gnux32', label: 'x86-64 · Linux x32 ABI' },
      { triple: 'i386-unknown-linux-gnu', label: 'i386 · Linux' },
      { triple: 'i686-pc-windows-msvc', label: 'i686 · Windows (MSVC)' },
    ],
  },
  {
    label: 'Arm',
    targets: [
      { triple: 'aarch64-unknown-linux-gnu', label: 'AArch64 · Linux' },
      { triple: 'aarch64-apple-macosx', label: 'AArch64 · macOS (Apple)' },
      { triple: 'aarch64-apple-ios', label: 'AArch64 · iOS (Apple)' },
      { triple: 'aarch64-pc-windows-msvc', label: 'AArch64 · Windows (MSVC)' },
      { triple: 'aarch64-linux-android', label: 'AArch64 · Android' },
      { triple: 'aarch64_be-unknown-linux-gnu', label: 'AArch64 · big-endian Linux' },
      { triple: 'arm64_32-apple-watchos', label: 'arm64_32 · watchOS (ILP32)' },
      { triple: 'arm-unknown-linux-gnueabihf', label: 'Arm32 · Linux (hard-float)' },
      { triple: 'armv7a-linux-androideabi', label: 'Arm32 · Android' },
      { triple: 'armv7-apple-ios', label: 'Arm32 · iOS (legacy)' },
      { triple: 'arm-none-eabi', label: 'Arm32 · bare metal (AAPCS)' },
    ],
  },
  {
    label: 'RISC-V',
    targets: [
      { triple: 'riscv64-unknown-linux-gnu', label: 'RV64 · Linux' },
      { triple: 'riscv32-unknown-elf', label: 'RV32 · bare metal' },
    ],
  },
  {
    label: 'WebAssembly',
    targets: [
      { triple: 'wasm32-unknown-unknown', label: 'wasm32' },
      { triple: 'wasm32-wasip1', label: 'wasm32 · WASI' },
      { triple: 'wasm64-unknown-unknown', label: 'wasm64' },
    ],
  },
  {
    label: 'PowerPC',
    targets: [
      { triple: 'powerpc64le-unknown-linux-gnu', label: 'PPC64 LE · Linux' },
      { triple: 'powerpc64-unknown-linux-gnu', label: 'PPC64 BE · Linux' },
      { triple: 'powerpc-unknown-linux-gnu', label: 'PPC32 · Linux' },
      { triple: 'powerpc-ibm-aix', label: 'PPC32 · AIX' },
    ],
  },
  {
    label: 'MIPS',
    targets: [
      { triple: 'mips-unknown-linux-gnu', label: 'MIPS32 BE · Linux' },
      { triple: 'mipsel-unknown-linux-gnu', label: 'MIPS32 LE · Linux' },
      { triple: 'mips64-unknown-linux-gnuabi64', label: 'MIPS64 BE · Linux' },
    ],
  },
  {
    label: 'Other 64-bit',
    targets: [
      { triple: 's390x-unknown-linux-gnu', label: 's390x · Linux' },
      { triple: 'loongarch64-unknown-linux-gnu', label: 'LoongArch64 · Linux' },
      { triple: 'sparcv9-unknown-linux-gnu', label: 'SPARC V9 · Linux' },
      { triple: 've-unknown-linux-gnu', label: 'NEC VE · Linux' },
      { triple: 'bpfel-unknown-none', label: 'BPF (little-endian)' },
      { triple: 'nvptx64-nvidia-cuda', label: 'NVPTX64 · CUDA' },
      { triple: 'amdgcn-amd-amdhsa', label: 'AMDGCN · ROCm' },
    ],
  },
  {
    label: 'Embedded & 8/16-bit',
    targets: [
      { triple: 'avr-unknown-unknown', label: 'AVR (8-bit)' },
      { triple: 'msp430-none-elf', label: 'MSP430 (16-bit)' },
      { triple: 'm68k-unknown-linux-gnu', label: 'M68k · Linux' },
      { triple: 'sparc-unknown-linux-gnu', label: 'SPARC32 · Linux' },
      { triple: 'hexagon-unknown-elf', label: 'Hexagon' },
      { triple: 'xtensa-none-elf', label: 'Xtensa' },
      { triple: 'csky-unknown-linux-gnu', label: 'C-SKY · Linux' },
    ],
  },
];

export const DEFAULT_TRIPLE = 'x86_64-unknown-linux-gnu';

export const C_STANDARDS = ['c89', 'gnu89', 'c99', 'gnu99', 'c11', 'gnu11', 'c17', 'gnu17', 'c23', 'gnu23'];
export const CXX_STANDARDS = ['c++03', 'gnu++03', 'c++11', 'gnu++11', 'c++14', 'gnu++14',
  'c++17', 'gnu++17', 'c++20', 'gnu++20', 'c++23', 'gnu++23', 'c++26', 'gnu++26'];
export const DEFAULT_C_STD = 'gnu17';
export const DEFAULT_CXX_STD = 'gnu++20';

export const EXAMPLES = [
  {
    name: 'Padding basics',
    lang: 'c',
    source: `#include <stdint.h>

struct Example {
    uint8_t  flag;      /* 1 byte, then padding  */
    uint32_t count;     /* wants 4-byte alignment */
    uint8_t  tag;
    uint64_t id;        /* wants 8-byte alignment */
    char     name[5];
    void    *userdata;  /* pointer size varies!   */
};
`,
  },
  {
    name: 'Bit-fields',
    lang: 'c',
    source: `struct Flags {
    unsigned kind      : 3;
    unsigned visible   : 1;
    unsigned dirty     : 1;
    unsigned           : 0;  /* force new unit */
    unsigned refcount  : 20;
    short    balance   : 9;  /* straddles units on some ABIs */
    char     suffix;
};
`,
  },
  {
    name: 'Union + nested',
    lang: 'c',
    source: `#include <stdint.h>

struct Header {
    uint16_t kind;
    uint16_t len;
};

union Payload {
    uint8_t  raw[10];
    uint32_t word;
    double   number;
};

struct Message {
    struct Header hdr;
    union Payload payload;
    struct { uint8_t crc_lo, crc_hi; };  /* anonymous */
};
`,
  },
  {
    name: 'Packed & aligned',
    lang: 'c',
    source: `#include <stdint.h>

#pragma pack(push, 1)
struct WireFormat {         /* no padding at all */
    uint8_t  version;
    uint32_t length;
    uint64_t timestamp;
};
#pragma pack(pop)

struct Aligned {
    _Alignas(16) uint8_t buf[10];
    uint32_t n;
};
`,
  },
  {
    name: 'C++ virtual & bases',
    lang: 'c++',
    source: `struct Base {
    virtual ~Base();
    int x;
};

struct Mixin {
    virtual void tick();
    char tag;
};

struct Derived : Base, Mixin {
    char extra;             /* reuses Mixin tail padding? */
};

struct Diamond : virtual Base {
    double d;
};
`,
  },
  {
    name: 'C++ EBO & templates',
    lang: 'c++',
    source: `struct Empty {};

struct WithEbo : Empty {    /* empty base optimization */
    char c;
};

template <typename T>
struct Pair {
    T first;
    char second;
};

Pair<double> pd;            /* instantiate to see layout */
Pair<char>   pc;
`,
  },
];
