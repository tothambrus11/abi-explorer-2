// Resolves the byte size of field types that appear in clang's record layout
// dumps. Three mechanisms, in order of preference:
//
//   1. A table of scalar sizes for the active target, obtained by compiling a
//      fixed set of probe structs (STATIC_PROBE_SOURCE) alongside the user's
//      code. sizeof(struct { T v; }) == sizeof(T) because a single-member
//      struct is padded to its own alignment.
//   2. The dumped layout of other records in the same TU (for record-typed
//      fields, matched by name).
//   3. A second compilation that appends `struct __abix_pN { <spelling> v; };`
//      probes for whatever is left (typedefs, enums, ...). Probes that fail to
//      compile (private nested types, etc.) are dropped and the field size is
//      estimated from neighbouring offsets.

export const STATIC_PROBE_SOURCE = `
struct __abix_s_char { char v; };
struct __abix_s_short { short v; };
struct __abix_s_int { int v; };
struct __abix_s_long { long v; };
struct __abix_s_llong { long long v; };
struct __abix_s_float { float v; };
struct __abix_s_double { double v; };
struct __abix_s_ldouble { long double v; };
struct __abix_s_ptr { void *v; };
struct __abix_s_fnptr { void (*v)(void); };
struct __abix_s_wchar { __WCHAR_TYPE__ v; };
struct __abix_s_size { __SIZE_TYPE__ v; };
struct __abix_s_ptrdiff { __PTRDIFF_TYPE__ v; };
#ifdef __cplusplus
struct __abix_s_bool { bool v; };
#else
struct __abix_s_bool { _Bool v; };
#endif
struct __abix_s_u8 { __UINT8_TYPE__ v; };
struct __abix_s_u16 { __UINT16_TYPE__ v; };
struct __abix_s_u32 { __UINT32_TYPE__ v; };
struct __abix_s_u64 { __UINT64_TYPE__ v; };
#ifdef __SIZEOF_INT128__
struct __abix_s_int128 { __int128 v; };
#endif
#ifdef __FLT16_MANT_DIG__
struct __abix_s_f16 { _Float16 v; };
#endif
`;

// Spelling -> probe key. Covers the canonical spellings clang emits plus
// common aliases. Fixed-width [u]intN_t types are handled separately.
const SCALAR_SPELLINGS = new Map();
{
  const add = (key, spellings) => { for (const s of spellings) SCALAR_SPELLINGS.set(s, key); };
  add('char', ['char', 'signed char', 'unsigned char', 'char8_t']);
  add('short', ['short', 'short int', 'signed short', 'signed short int',
    'unsigned short', 'unsigned short int']);
  add('int', ['int', 'signed', 'signed int', 'unsigned', 'unsigned int']);
  add('long', ['long', 'long int', 'signed long', 'signed long int',
    'unsigned long', 'unsigned long int']);
  add('llong', ['long long', 'long long int', 'signed long long',
    'signed long long int', 'unsigned long long', 'unsigned long long int']);
  add('float', ['float']);
  add('double', ['double']);
  add('ldouble', ['long double']);
  add('bool', ['_Bool', 'bool']);
  add('wchar', ['wchar_t', '__WCHAR_TYPE__']);
  add('size', ['size_t', 'std::size_t', '__SIZE_TYPE__', 'rsize_t']);
  add('ptrdiff', ['ptrdiff_t', 'std::ptrdiff_t', '__PTRDIFF_TYPE__', 'ssize_t']);
  add('int128', ['__int128', 'unsigned __int128', '__int128_t', '__uint128_t']);
  add('f16', ['_Float16', '__fp16', '__bf16', 'std::float16_t', 'std::bfloat16_t']);
  add('ptr', ['intptr_t', 'uintptr_t', 'std::intptr_t', 'std::uintptr_t',
    'nullptr_t', 'std::nullptr_t', 'decltype(nullptr)']);
}

/** Extract `{key: {size, align}}` from parsed __abix_s_* probe records. */
export function buildScalarTable(records) {
  const table = new Map();
  for (const rec of records) {
    const m = /^__abix_s_([a-z0-9]+)$/.exec(rec.name);
    if (m) table.set(m[1], { size: rec.sizeBytes, align: rec.align });
  }
  return table;
}

function stripQuals(t) {
  let s = t.trim();
  for (;;) {
    const next = s
      .replace(/^(?:const|volatile|restrict|__restrict|_Atomic)\s+/, '')
      .replace(/\s+(?:const|volatile|restrict|__restrict)$/, '');
    if (next === s) return s;
    s = next;
  }
}

const RECORD_KW_RE = /^(?:struct|class|union|__interface|enum)\s+/;

/** Normalize "(anonymous at f.c:1:2)" vs "(unnamed ... at f.c:1:2)" variants. */
function anonKey(name) {
  return name.replace(/\((?:anonymous|unnamed)(?: [a-z]+)? at ([^)]*)\)/g, '(anon at $1)');
}

/**
 * Try to resolve a field type's size in bits.
 * @param type    type string as printed in the dump
 * @param scalars Map from buildScalarTable
 * @param recordIndex Map: record-name variants -> record
 * @returns {bits} on success, {probe: spelling} if a pass-2 probe could
 *          resolve it, or {} if only estimation is possible.
 */
export function resolveTypeSize(type, scalars, recordIndex) {
  const bits = resolveInner(stripQuals(type), scalars, recordIndex, 0);
  return bits;
}

function scalarBits(scalars, key) {
  const e = scalars.get(key);
  return e ? e.size * 8 : null;
}
function scalarAlign(scalars, key) {
  const e = scalars.get(key);
  return e ? e.align : null;
}

function resolveInner(t, scalars, recordIndex, depth) {
  if (depth > 8 || t === '') return {};
  t = stripQuals(t);

  // References -> pointer size
  if (/&+$/.test(t)) {
    const b = scalarBits(scalars, 'ptr');
    return b ? { bits: b, align: scalarAlign(scalars, 'ptr') } : {};
  }

  // Function pointers, incl. arrays of them: "int (*[2])(void)", "void (*)(double)"
  const fp = /^[^(]*\((?:[A-Za-z_][A-Za-z0-9_:]*::)?\*+\s*((?:\[[0-9]+\])*)\)\s*\(/.exec(t);
  if (fp) {
    let count = 1;
    for (const d of fp[1].matchAll(/\[([0-9]+)\]/g)) count *= Number(d[1]);
    const key = /::\*/.test(t) ? null : 'fnptr'; // member pointers: probe instead
    if (key === null) return { probe: t };
    const b = scalarBits(scalars, key) ?? scalarBits(scalars, 'ptr');
    return b ? { bits: b * count, align: scalarAlign(scalars, key) ?? scalarAlign(scalars, 'ptr') } : {};
  }

  // Array suffixes: "char[3][5]", flexible "char[]"
  const arr = /^(.*?)((?:\[[0-9]*\])+)$/.exec(t);
  if (arr && !arr[1].includes('(')) {
    let count = 1, flexible = false;
    for (const d of arr[2].matchAll(/\[([0-9]*)\]/g)) {
      if (d[1] === '') flexible = true; else count *= Number(d[1]);
    }
    if (flexible) return { bits: 0 };
    const el = resolveInner(arr[1], scalars, recordIndex, depth + 1);
    if (el.bits !== undefined) return { bits: el.bits * count, align: el.align };
    if (el.probe) return { probe: el.probe, arrayCount: count };
    return {};
  }

  // Pointers
  if (/\*$/.test(t)) {
    const b = scalarBits(scalars, 'ptr');
    return b ? { bits: b, align: scalarAlign(scalars, 'ptr') } : {};
  }

  // _Complex
  const cx = /^_Complex\s+(.*)$/.exec(t) || /^(.*)\s+_Complex$/.exec(t);
  if (cx) {
    const el = resolveInner(cx[1], scalars, recordIndex, depth + 1);
    return el.bits !== undefined ? { bits: el.bits * 2, align: el.align } : { probe: t };
  }

  // Fixed-width integer typedefs (spec-mandated widths)
  const fixed = /^(?:std::)?u?int(8|16|32|64)_t$/.exec(t);
  if (fixed) return { bits: Number(fixed[1]), align: scalarAlign(scalars, 'u' + fixed[1]) ?? undefined };
  const fixedChar = /^(?:std::)?char(16|32)_t$/.exec(t);
  if (fixedChar) return { bits: Number(fixedChar[1]), align: scalarAlign(scalars, 'u' + fixedChar[1]) ?? undefined };

  // Scalar table
  const key = SCALAR_SPELLINGS.get(t);
  if (key) {
    const b = scalarBits(scalars, key);
    if (b !== null) return { bits: b, align: scalarAlign(scalars, key) };
  }

  // _BitInt: representation is target-dependent -> probe
  if (/_BitInt\s*\(/.test(t)) return { probe: t };

  // Record types dumped in this TU
  const bare = t.replace(RECORD_KW_RE, '');
  const rec = recordIndex.get(bare) || recordIndex.get(anonKey(bare)) || recordIndex.get(t);
  if (rec) return { bits: rec.sizeBytes * 8, align: rec.align, record: rec };

  // Anything containing an anonymous spelling can't be probed
  if (/\((?:anonymous|unnamed|lambda)/.test(t)) return {};

  // Enums default to probing (packed enums, fixed underlying types...)
  return { probe: t };
}

/** Build an index of record-name variants -> record object. */
export function buildRecordIndex(records) {
  const index = new Map();
  for (const rec of records) {
    index.set(rec.name, rec);
    index.set(anonKey(rec.name), rec);
    index.set(`${rec.kind} ${rec.name}`, rec);
  }
  return index;
}

/**
 * Generate the pass-2 source: user source plus one probe struct per line.
 * Returns { source, firstProbeLine, probes: [{index, spelling}] }.
 */
export function buildProbeSource(userSource, spellings) {
  const base = userSource.endsWith('\n') ? userSource : userSource + '\n';
  const baseLines = base.split('\n').length; // includes trailing '' after last \n
  const probes = spellings.map((spelling, index) => ({ index, spelling }));
  const lines = probes.map(p => `struct __abix_p${p.index} { ${declaratorFor(p.spelling)} };`);
  return {
    source: base + lines.join('\n') + '\n',
    firstProbeLine: baseLines, // 1-based line number of first probe
    probes,
  };
}

/** Turn a type spelling into a member declaration `T v;`. */
function declaratorFor(spelling) {
  // Function pointer spellings need the name inside: "void (*)(int)" -> "void (*v)(int)"
  const fp = /^(.*\()(\*+)((?:\[[0-9]+\])*\)\s*\(.*)$/.exec(spelling);
  if (fp) return `${fp[1]}${fp[2]}v${fp[3]};`;
  // Array spellings move the suffix after the name: "char[3]" -> "char v[3]"
  const arr = /^(.*?)((?:\[[0-9]*\])+)$/.exec(spelling);
  if (arr && !arr[1].includes('(')) return `${arr[1]} v${arr[2]};`;
  return `${spelling} v;`;
}

/**
 * Given pass-2 stderr and the probe layout, return the indices of probes whose
 * lines produced errors (so they can be dropped and the rest retried).
 */
export function failingProbeIndices(stderr, fileName, firstProbeLine, probes) {
  const bad = new Set();
  const re = new RegExp(`(?:^|\\n)(?:[^\\n]*?)${fileName.replace(/\./g, '\\.')}:([0-9]+):[0-9]+:\\s*(?:fatal )?error`, 'g');
  for (const m of stderr.matchAll(re)) {
    const line = Number(m[1]);
    const idx = line - firstProbeLine;
    if (idx >= 0 && idx < probes.length) bad.add(probes[idx].index);
  }
  return bad;
}

/** Extract probe results: Map spelling -> { bits, align }. */
export function readProbeResults(records, probes) {
  const bySuffix = new Map(probes.map(p => [`__abix_p${p.index}`, p]));
  const out = new Map();
  for (const rec of records) {
    const p = bySuffix.get(rec.name);
    if (p) out.set(p.spelling, { bits: rec.sizeBytes * 8, align: rec.align });
  }
  return out;
}
