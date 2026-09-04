import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseAnsi, stripAnsi } from '$core/ansi';
import { buildFlags, DEFAULT_OPTIONS, isAllowedFlag, splitExtraFlags } from '$core/options';
import { encodeShareState, decodeShareState } from '$core/url-state';

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

describe('options / flags', () => {
  it('turns the layout-affecting options into flags, dropping anything unsafe', () => {
    const flags = buildFlags({
      ...DEFAULT_OPTIONS,
      lang: 'c++',
      std: 'c++20',
      pack: '2',
      msBitfields: true,
      shortEnums: true,
      extraFlags: '-funsigned-char -o evil -### -DX=1',
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        '-fpack-struct=2',
        '-mms-bitfields',
        '-fshort-enums',
        '-funsigned-char',
        '-DX=1',
      ]),
    );
    // Target, language and standard are fields of the request, not flags.
    expect(flags.some((f) => f.startsWith('--target='))).toBe(false);
    expect(flags).not.toContain('-std=c++20');
    // …and the driver flags that could replace the query outright never survive.
    expect(flags).not.toContain('-o');
    expect(flags).not.toContain('-###');
  });

  it('splits free-form flags into accepted and rejected', () => {
    expect(splitExtraFlags(' -Wall -x c ')).toEqual([['-Wall'], ['-x', 'c']]);
    expect(isAllowedFlag('-fsyntax-only')).toBe(false);
  });
});

/** A single-buffer state, which is what every link used to be. */
const oneBuffer = (source: string, lang: 'c' | 'c++' | 'hylo' = 'c') => ({
  buffers: [{ name: 'Source 1', lang, source }],
  active: 0,
});

describe('url state', () => {
  it('round-trips and rejects garbage', async () => {
    const st = {
      ...oneBuffer('struct A { int x; };\n// ünïcödé'),
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
    expect(dec?.buffers).toEqual([{ name: 'Source 1', lang: 'c++', source: 'x' }]);
  });

  it('carries any triple clang would take, not just the listed ones', async () => {
    // The contract Compiler Explorer's "Open in ABI Explorer" button relies
    // on: a triple is validated as a token, never against the selector's list.
    for (const triple of [
      'thumbv7em-none-eabihf',
      'x86_64-linux-gnu',
      'mips64el-unknown-linux-gnuabi64',
      'sparc64-sun-solaris2.11',
    ]) {
      const st = {
        ...oneBuffer('struct A { int x; };'),
        options: { ...DEFAULT_OPTIONS, triple },
        selectedRecord: null,
        view: 'tabs' as const,
      };
      expect((await decodeShareState(await encodeShareState(st)))?.options.triple).toBe(triple);
    }
  });

  it('round-trips arbitrary sources (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (src) => {
        const st = {
          ...oneBuffer(src),
          options: { ...DEFAULT_OPTIONS },
          selectedRecord: null,
          view: 'tabs' as const,
        };
        const back = await decodeShareState(await encodeShareState(st));
        return back?.buffers[0]?.source === src;
      }),
      { numRuns: 40 },
    );
  });

  it('round-trips several buffers, and opens the active one for old decoders', async () => {
    const st = {
      buffers: [
        { name: 'Source 1', lang: 'c' as const, source: 'struct A { int x; };' },
        { name: 'Helpers', lang: 'c++' as const, source: 'struct B { char c; };' },
        { name: 'Reordered', lang: 'hylo' as const, source: 'public struct S {}' },
      ],
      active: 1,
      options: { ...DEFAULT_OPTIONS, lang: 'c++' as const, std: 'c++20' },
      selectedRecord: null,
      view: 'tabs' as const,
    };
    const frag = await encodeShareState(st);
    expect(await decodeShareState('#' + frag)).toEqual(st);
    // The legacy `s`/`l` pair repeats the active buffer, so a decoder from
    // before `bs` existed opens on what was on screen.
    const wire = JSON.parse(
      new TextDecoder().decode(
        await new Response(
          new Blob([
            Uint8Array.from(atob(frag.slice(2).replace(/-/g, '+').replace(/_/g, '/')), (c) =>
              c.charCodeAt(0),
            ),
          ])
            .stream()
            .pipeThrough(new DecompressionStream('deflate-raw')),
        ).arrayBuffer(),
      ),
    ) as { s: string; l: string };
    expect(wire.s).toBe('struct B { char c; };');
    expect(wire.l).toBe('c++');
  });

  it('coerces hostile buffer lists into something the app could hold', async () => {
    const frag = (wire: unknown) =>
      btoa(JSON.stringify({ v: 1, ...(wire as object) }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    // Junk entries become empty C buffers; the index is clamped; a name is cut
    // down to a label.
    const dec = await decodeShareState(
      frag({
        s: 'ignored: bs wins',
        bs: [{ n: '  a\n\nname  ', l: 'fortran', s: 'int x;' }, 42, { s: 7 }],
        bi: 99,
      }),
    );
    expect(dec?.buffers).toEqual([
      { name: 'a name', lang: 'c', source: 'int x;' },
      { name: 'Source 2', lang: 'c', source: '' },
      { name: 'Source 3', lang: 'c', source: '' },
    ]);
    expect(dec?.active).toBe(0);
    // An empty list is no list: the single-buffer reading applies.
    expect((await decodeShareState(frag({ s: 'solo', bs: [] })))?.buffers).toEqual([
      { name: 'Source 1', lang: 'c', source: 'solo' },
    ]);
  });
});
