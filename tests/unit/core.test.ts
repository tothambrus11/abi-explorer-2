import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseDiagnostics, stripFileDiagnostics } from '$core/diagnostics';
import { parseAnsi, stripAnsi } from '$core/ansi';
import { buildArgv, DEFAULT_OPTIONS, isAllowedFlag, splitExtraFlags } from '$core/options';
import { encodeShareState, decodeShareState } from '$core/url-state';
import {
  buildProbeSource,
  buildSpellingProbe,
  failingProbeIndices,
  nextProbeRound,
  readProbeResults,
  buildFieldProbes,
  buildRecordIndex,
} from '$core/probes';
import {
  hasAnonymousSpelling,
  isLibraryRecord,
  parseRecordLayouts,
  stripAnonymousNamespace,
} from '$core/layout-parser';
import { splitJsonDocuments, unqualifiedName } from '$core/ast-locations';

describe('diagnostics', () => {
  it('parses clang diagnostics with caret ranges', () => {
    // -fdiagnostics-print-source-range-info: "file:line:col:{l:c-l:c}: severity: msg"
    const text = [
      "input.c:3:12:{3:12-3:17}: error: expected ';' after struct",
      '    3 | struct A { int x }',
      '      |            ~~~~~^',
      'input.c:5:1: warning: padding struct [-Wpadded]',
      '1 error generated.',
    ].join('\n');
    const d = parseDiagnostics(text, 'input.c');
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ line: 3, severity: 'error', column: 12, endColumn: 17 });
    expect(d[1]).toMatchObject({ line: 5, column: 1, severity: 'warning' });
    expect(d[1]!.endColumn).toBeUndefined();
    expect(parseDiagnostics(text, 'other.c')).toEqual([]);
    expect(stripFileDiagnostics('a\nprobe.c:1:1: error: x\nb', 'probe.c')).toBe('a\nb');
  });
});

describe('ansi', () => {
  it('parses SGR bold/colors and strips', () => {
    const s = '\x1b[1mbold\x1b[0m plain \x1b[0;1;31merr\x1b[0m \x1b[92mgreen\x1b[39m';
    expect(parseAnsi(s)).toEqual([
      { text: 'bold', bold: true, color: null },
      { text: ' plain ', bold: false, color: null },
      { text: 'err', bold: true, color: 1 },
      { text: ' ', bold: false, color: null },
      { text: 'green', bold: false, color: 10 },
    ]);
    expect(stripAnsi(s)).toBe('bold plain err green');
    fc.assert(
      fc.property(
        fc.string(),
        (t) =>
          stripAnsi(t) ===
          parseAnsi(t)
            .map((x) => x.text)
            .join(''),
      ),
    );
  });
});

describe('options / argv', () => {
  it('builds layout and ast argv from the same spec', () => {
    const o = {
      ...DEFAULT_OPTIONS,
      lang: 'c++' as const,
      std: 'c++20',
      pack: '2' as const,
      msBitfields: true,
      extraFlags: '-funsigned-char -o evil -### -DX=1',
    };
    const layout = buildArgv(o, { kind: 'layout', files: ['a.cc'], measure: true });
    expect(layout).toEqual(
      expect.arrayContaining([
        '--target=' + o.triple,
        '-xc++',
        '-std=c++20',
        '-fsyntax-only',
        '-Xclang',
        '-fdump-record-layouts-complete',
        '-fpack-struct=2',
        '-mms-bitfields',
        '-funsigned-char',
        '-DX=1',
        '-fno-access-control',
        'a.cc',
      ]),
    );
    expect(layout).not.toContain('-o');
    expect(layout).not.toContain('-###');
    const ast = buildArgv(o, { kind: 'ast-json', files: ['a.cc'], astFilter: 'Foo' });
    expect(ast).toContain('-ast-dump=json');
    expect(ast).toContain('-ast-dump-filter=Foo');
    expect(ast).not.toContain('-fdump-record-layouts-complete');
    expect(splitExtraFlags(' -Wall -x c ')).toEqual([['-Wall'], ['-x', 'c']]);
    expect(isAllowedFlag('-fsyntax-only')).toBe(false);
  });

  it('C++ always gets libc++ *and* the C headers it includes, in that order', () => {
    const cxx = buildArgv(
      { ...DEFAULT_OPTIONS, lang: 'c++', std: 'gnu++20', wasiLibc: false },
      { kind: 'layout', files: ['a.cc'] },
    );
    // libc++ reaches the C library via #include_next, so c++/v1 must come first.
    const libcxx = cxx.indexOf('-isystem/usr/include/c++/v1');
    const libc = cxx.indexOf('-isystem/usr/include/wasm32-wasip1');
    expect(libcxx).toBeGreaterThanOrEqual(0);
    expect(libc).toBeGreaterThan(libcxx);
    // …and only once when the wasi-libc toggle is also on.
    const both = buildArgv(
      { ...DEFAULT_OPTIONS, lang: 'c++', std: 'gnu++20', wasiLibc: true },
      { kind: 'layout', files: ['a.cc'] },
    );
    expect(both.filter((a) => a === '-isystem/usr/include/wasm32-wasip1')).toHaveLength(1);
    // C is unaffected: no libc++, and wasi-libc only when asked for.
    const c = buildArgv(
      { ...DEFAULT_OPTIONS, lang: 'c', wasiLibc: false },
      { kind: 'layout', files: ['a.c'] },
    );
    expect(c).not.toContain('-isystem/usr/include/c++/v1');
    expect(c).not.toContain('-isystem/usr/include/wasm32-wasip1');
  });
});

describe('url state', () => {
  it('round-trips and rejects garbage', async () => {
    const st = {
      source: 'struct A { int x; };\n// ünïcödé',
      options: { ...DEFAULT_OPTIONS, triple: 'avr-unknown-unknown', pack: '4' as const },
      selectedRecord: 'struct A',
      view: 'stack' as const,
    };
    const frag = await encodeShareState(st);
    expect(frag.startsWith('2.')).toBe(true);
    expect(await decodeShareState('#' + frag)).toEqual(st);
    expect(await decodeShareState('#not-base64!!')).toBeNull();
    expect(await decodeShareState('')).toBeNull();
    // v1 legacy
    const v1 = btoa(
      JSON.stringify({
        v: 1,
        s: 'x',
        l: 'c++',
        std: 'gnu++17',
        t: '__custom__',
        ct: 'thumbv7-none-eabi',
        p: '99',
        x: '',
      }),
    );
    const dec = await decodeShareState('#' + v1);
    expect(dec?.options).toMatchObject({
      lang: 'c++',
      std: 'gnu++17',
      triple: 'thumbv7-none-eabi',
      pack: '',
    });
  });
  it('round-trips arbitrary sources (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (src) => {
        const st = {
          source: src,
          options: { ...DEFAULT_OPTIONS },
          selectedRecord: null,
          view: 'tabs' as const,
        };
        const back = await decodeShareState(await encodeShareState(st));
        return back?.source === src;
      }),
      { numRuns: 40 },
    );
  });
});

describe('probes', () => {
  const dump = `*** Dumping AST Record Layout\n  0 | struct S\n  0 |   int a\n  4 |   struct T t\n  4 |     char c\n  8 |   union U u\n  8 |     int i\n  8 |     struct S::(anonymous at f.c:1:1) \n  8 |       short s\n  | [sizeof=12, align=4]\n*** Dumping AST Record Layout\n  0 | struct T\n  0 |   char c\n  | [sizeof=1, align=1]\n`;
  it('generates access-path probes and appends them line by line', () => {
    const recs = parseRecordLayouts(dump);
    const probes = buildFieldProbes(recs, buildRecordIndex(recs));
    expect(probes.map((p) => p.key)).toEqual([
      'struct S a',
      'struct S t',
      'struct S t.c',
      'struct S u',
      'struct S u.i',
      'struct S u.s',
      'struct T c',
    ]);
    expect(probes[2]!.decls[0]).toBe('__typeof__(((struct S*)0)->t.c) v;');
    const src = buildProbeSource('int x;', probes);
    expect(src.firstProbeLine).toBe(3);
    expect(src.source.split('\n')[1]).toBe('#pragma pack()');
    expect(src.source.split('\n')[2]).toBe(
      'struct __abix_p0 { __typeof__(((struct S*)0)->a) v; };',
    );
    const bad = failingProbeIndices('input.c:4:20: error: no member named t', 'input.c', 3, probes);
    expect(bad).toEqual(new Set([1]));
    // Uses the shared diagnostic parser: source-range info and a fatal
    // "too many errors" line are handled, warnings/notes are ignored.
    const multi = [
      'input.c:3:20:{3:20-3:23}: error: a',
      'input.c:5:1: warning: w',
      'input.c:6:1: note: n',
      'input.c:7:9: fatal error: too many errors emitted, stopping now',
    ].join('\n');
    const ps2 = buildProbeSource('int x;', probes); // firstProbeLine 2
    expect(failingProbeIndices(multi, 'input.c', 2, ps2.probes)).toEqual(new Set([1, 5]));
    const next = nextProbeRound(probes, bad, new Map([['struct S a', { bits: 32, align: 4 }]]));
    expect(next.map((p) => [p.key, p.attempt])).toEqual([
      ['struct S t', 1],
      ['struct S t.c', 0],
      ['struct S u', 0],
      ['struct S u.i', 0],
      ['struct S u.s', 0],
      ['struct T c', 0],
    ]);
    expect(next.every((p, i) => p.index === i)).toBe(true);
    const sp = buildSpellingProbe('int (*)(void)');
    expect(sp.decls).toEqual(['__typeof__(int (*)(void)) v;']);
    const res = readProbeResults(
      parseRecordLayouts(
        '*** Dumping AST Record Layout\n  0 | struct __abix_p0\n  0 |   int v\n  | [sizeof=8, align=8]\n',
      ),
      [{ ...sp, index: 0 }],
    );
    expect(res.get('int (*)(void)')).toEqual({ bits: 64, align: 8 });
  });
});

describe('ast helpers', () => {
  it('splits concatenated JSON documents and unqualifies names', () => {
    expect(splitJsonDocuments('Dumping A:\n{"a":1}\nDumping B:\n{"b":"}{"}')).toEqual([
      '{"a":1}',
      '{"b":"}{"}',
    ]);
    expect(unqualifiedName('ns::Outer::Inner<int, std::pair<a,b>>')).toBe('Inner');
    expect(unqualifiedName('X::(unnamed at f.c:1:1)')).toBe('');
  });

  it('treats an anonymous namespace as a scope, not an unnamed type', () => {
    // The qualifier is unwritable but the record it qualifies has a real name,
    // so it must survive `unqualifiedName` — unlike a genuinely unnamed type.
    expect(unqualifiedName('(anonymous namespace)::Config')).toBe('Config');
    expect(stripAnonymousNamespace('(anonymous namespace)::ns::S')).toBe('ns::S');
    expect(hasAnonymousSpelling('(anonymous namespace)::Config')).toBe(true);
    expect(hasAnonymousSpelling(stripAnonymousNamespace('(anonymous namespace)::Config'))).toBe(
      false,
    );
    for (const spelling of [
      '(unnamed struct at input.c:3:1)',
      '(anonymous union at input.c:3:1)',
      '(lambda at input.cc:9:5)',
    ]) {
      expect(hasAnonymousSpelling(spelling), spelling).toBe(true);
    }
    expect(hasAnonymousSpelling('Box<int>')).toBe(false);
  });
});

describe('library records', () => {
  it('recognises the standard library and reserved names at any scope', () => {
    for (const name of [
      'std::__1::basic_string<char>',
      'std::__itoa::__traits<unsigned long long>',
      '__va_list_tag',
      'ns::__detail::Impl',
    ]) {
      expect(isLibraryRecord(name), name).toBe(true);
    }
  });

  it('leaves the user\'s own records alone', () => {
    for (const name of ['Probe', 'ns::Message', 'Packet', 'Outer::Inner']) {
      expect(isLibraryRecord(name), name).toBe(false);
    }
  });
});
