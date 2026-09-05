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

/** A single-buffer state. */
const oneBuffer = (
  source: string,
  over: Partial<typeof DEFAULT_OPTIONS> = {},
  selectedRecord: string | null = null,
) => ({
  buffers: [{ name: 'Source 1', source, options: { ...DEFAULT_OPTIONS, ...over }, selectedRecord }],
});

describe('url state', () => {
  it('round-trips and rejects garbage', async () => {
    const st = {
      ...oneBuffer(
        'struct A { int x; };\n// ünïcödé',
        { triple: 'avr-unknown-unknown', pack: '4' as const },
        'struct A',
      ),
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
    expect(dec?.buffers).toHaveLength(1);
    expect(dec?.buffers[0]).toMatchObject({ name: 'Source 1', source: 'x', selectedRecord: null });
    expect(dec?.buffers[0]?.options).toMatchObject({
      lang: 'c++',
      std: 'gnu++17',
      triple: 'thumbv7-none-eabi',
      pack: '',
    });
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
        ...oneBuffer('struct A { int x; };', { triple }),
        view: 'tabs' as const,
      };
      expect((await decodeShareState(await encodeShareState(st)))?.buffers[0]?.options.triple).toBe(
        triple,
      );
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

  it('round-trips several buffers, in the one shape every link has', async () => {
    const st = {
      buffers: [
        {
          name: 'Source 1',
          source: 'struct A { int x; };',
          options: { ...DEFAULT_OPTIONS, triple: 'avr-unknown-unknown' },
          selectedRecord: 'struct A',
        },
        {
          name: 'Helpers',
          source: 'struct B { char c; };',
          options: { ...DEFAULT_OPTIONS, lang: 'c++' as const, std: 'c++20', pack: '2' as const },
          selectedRecord: null,
        },
        {
          name: 'Reordered',
          source: 'public struct S {}',
          options: { ...DEFAULT_OPTIONS, lang: 'hylo' as const, std: '', triple: 'hylo' },
          selectedRecord: 'S',
        },
      ],
      view: 'tabs' as const,
    };
    const frag = await encodeShareState(st);
    expect(await decodeShareState('#' + frag)).toEqual(st);
    // Nothing is repeated at the top level: the buffers are `bs`, whatever
    // their number, each with its own selected record; which is in focus is
    // the arrangement's to say.
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
    ) as {
      v: number;
      s?: string;
      l?: string;
      r?: unknown;
      bi?: unknown;
      bs: { s: string; l: string; p: string; r: string | null }[];
    };
    expect(wire.v).toBe(3);
    expect(wire.s).toBeUndefined();
    expect(wire.l).toBeUndefined();
    expect(wire.r).toBeUndefined();
    expect(wire.bi).toBeUndefined();
    expect(wire.bs.map((b) => b.l)).toEqual(['c', 'c++', 'hylo']);
    expect(wire.bs[1]).toMatchObject({ s: 'struct B { char c; };', p: '2', r: null });
    expect(wire.bs[2]?.r).toBe('S');
    // A lone buffer travels the same way, its name included.
    const one = { ...oneBuffer('int x;'), view: 'tabs' as const };
    one.buffers[0]!.name = 'main.c';
    expect(await decodeShareState(await encodeShareState(one))).toEqual(one);
  });

  it('carries the panel layout only when given one, and only a real one', async () => {
    const layout = { grid: { root: { type: 'branch' } }, panels: { 'editor:#0': {} } };
    const st = { ...oneBuffer('int x;'), view: 'tabs' as const, layout };
    expect(await decodeShareState(await encodeShareState(st))).toEqual(st);
    // Absent stays absent: no `layout` key, so a comparison with a state that
    // never had one holds.
    const bare = { ...oneBuffer('int x;'), view: 'tabs' as const };
    expect(await decodeShareState(await encodeShareState(bare))).toEqual(bare);
    // Something that is not a layout is not carried in as one.
    const frag = (wire: unknown) =>
      btoa(JSON.stringify({ v: 3, ...(wire as object) }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    for (const ly of ['x', 42, [], { grid: 1 }, { panels: {} }, { grid: {}, panels: null }, null]) {
      expect((await decodeShareState(frag({ s: 'a', ly })))?.layout).toBeUndefined();
    }
  });

  it('coerces hostile buffer lists into something the app could hold', async () => {
    const frag = (wire: unknown) =>
      btoa(JSON.stringify({ v: 3, ...(wire as object) }))
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
    const plain = { ...DEFAULT_OPTIONS };
    expect(dec?.buffers).toEqual([
      { name: 'a name', source: 'int x;', options: plain, selectedRecord: null },
      { name: 'Source 2', source: '', options: plain, selectedRecord: null },
      { name: 'Source 3', source: '', options: plain, selectedRecord: null },
    ]);
    // An empty list is one empty buffer: the version says where the sources
    // are, and V3 keeps nothing at the top level.
    expect((await decodeShareState(frag({ s: 'solo', bs: [] })))?.buffers).toEqual([
      { name: 'Source 1', source: '', options: plain, selectedRecord: null },
    ]);
    // Whereas a V1 wire is read at the top level, whatever else it carries.
    expect((await decodeShareState(frag({ v: 1, s: 'solo', bs: [{ s: 'no' }] })))?.buffers).toEqual(
      [{ name: 'Source 1', source: 'solo', options: plain, selectedRecord: null }],
    );
  });
});
