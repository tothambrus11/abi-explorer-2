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
