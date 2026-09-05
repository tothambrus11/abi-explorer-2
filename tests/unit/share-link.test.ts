// The app's decoder against every version of the wire in every envelope.
//
// `packages/share-link` writes each wire version and each envelope and reads
// them all; the app's `decodeShareState` is that reader plus the meaning this
// build gives the values. All of it is pinned here: a fragment written by any
// writer in any envelope, and a handful written once and kept as literals,
// must open in this app forever.

import { describe, it, expect } from 'vitest';
import {
  encodeDeflate,
  encodePlain,
  toWireV1,
  toWireV2,
  toWireV3,
  type ShareState as WireState,
} from '@ambrus-toth/abi-explorer-share-link';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { DEFAULT_OPTIONS, HYLO_TRIPLE, type CompileOptions } from '$core/options';
import { DEFAULT_C_STD, DEFAULT_CXX_STD } from '$core/targets';

const OPTIONS: CompileOptions = {
  lang: 'c++',
  std: 'c++20',
  triple: 'aarch64-apple-darwin',
  pack: '2',
  msBitfields: true,
  shortEnums: false,
  shortWchar: true,
  warnPadded: false,
  extraFlags: '-funsigned-char -DX=1',
};
const HYLO: CompileOptions = { ...DEFAULT_OPTIONS, lang: 'hylo', std: '', triple: HYLO_TRIPLE };
const SOURCE = 'struct A { char c; int i; };';

/** One source: what wires V1 and V2 carry. */
const ONE: WireState & ShareState = {
  buffers: [{ name: 'Source 1', source: SOURCE, options: OPTIONS, selectedRecord: 'A' }],
  view: 'stack',
};
/** Two sources of two languages, and a desk: what wire V3 carries. */
const TWO: WireState & ShareState = {
  buffers: [
    { name: 'First', source: SOURCE, options: OPTIONS, selectedRecord: 'A' },
    { name: 'Hylo one', source: 'type P { var x: Int }', options: HYLO, selectedRecord: null },
  ],
  view: 'tabs',
  layout: {
    grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' },
    panels: {
      'editor:#0': {
        id: 'editor:#0',
        contentComponent: 'editor',
        tabComponent: 'source-tab',
        title: 'Source',
      },
    },
  },
};

/** JSON in envelope 1, to hand the decoder something no writer writes. */
const plain = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('the app decodes every wire in every envelope', () => {
  it('wire V2 in envelope 2, as abiexplorer.org wrote', async () => {
    expect(await decodeShareState(await encodeDeflate(toWireV2(ONE)))).toEqual(ONE);
  });
  it('wire V1 in envelope 1, as abiexplorer.org wrote where it could not compress', async () => {
    expect(await decodeShareState(encodePlain(toWireV1(ONE)))).toEqual(ONE);
  });
  it('wire V3 in envelope 2, as this app writes', async () => {
    expect(await decodeShareState(await encodeDeflate(toWireV3(TWO)))).toEqual(TWO);
    expect(await decodeShareState('#' + (await encodeDeflate(toWireV3(TWO))))).toEqual(TWO);
  });
  it('wire V3 in envelope 1, as this app writes where it cannot compress', async () => {
    expect(await decodeShareState(encodePlain(toWireV3(TWO)))).toEqual(TWO);
  });
  it('and every other pairing, since wires and envelopes are read apart', async () => {
    expect(await decodeShareState(encodePlain(toWireV2(ONE)))).toEqual(ONE);
    expect(await decodeShareState(await encodeDeflate(toWireV1(ONE)))).toEqual(ONE);
  });
  it('and writes wire V3 in envelope 2', async () => {
    const frag = await encodeShareState(TWO);
    expect(frag).toMatch(/^2\./);
    expect(await decodeShareState(frag)).toEqual(TWO);
  });
});

/**
 * Fragments kept as literals: a link shared under them must open now and
 * always. The first two are what abiexplorer.org wrote as of September 2026
 * (origin/main 088c2e0), the third what an older build wrote for a triple
 * typed into the custom box, the last two what this app writes (wire V3). Never change
 * one; add one when a version is added.
 */
const FOREVER: Record<string, { fragment: string; state: ShareState }> = {
  'wire V2 in envelope 2': {
    fragment:
      '2.JY6xCoMwFAB_JdzqC1gpHZ50EPoRXdNoq9QGSaIWxH8v2O1uuttY0EpIKCnH2WfTmM343kXjazOEbIba7DXCiOKLAiHl9s9ViZBRnIu-v5ytm6axs62L6xAQJpQK4fNAT0Lq0FJI62HrdNgXxT7nkIZX6Fp7lO3tfj0hRJQGYVmPPeff7D8',
    state: ONE,
  },
  'wire V1 in envelope 1': {
    fragment:
      'eyJ2IjoxLCJzIjoic3RydWN0IEEgeyBjaGFyIGM7IGludCBpOyB9OyIsImwiOiJjKysiLCJzdGQiOiJjKysyMCIsInQiOiJhYXJjaDY0LWFwcGxlLWRhcndpbiIsInAiOiIyIiwibWIiOjEsInNlIjowLCJzdyI6MSwid3AiOjAsIngiOiItZnVuc2lnbmVkLWNoYXIgLURYPTEiLCJyIjoiQSIsInZ3Ijoic3RhY2sifQ',
    state: ONE,
  },
  'an older link with a custom triple as __custom__ and ct': {
    fragment:
      'eyJ2IjoxLCJzIjoic3RydWN0IEEgeyBjaGFyIGM7IGludCBpOyB9OyIsImwiOiJjKysiLCJzdGQiOiJjKysyMCIsInQiOiJfX2N1c3RvbV9fIiwicCI6IjIiLCJtYiI6MSwic2UiOjAsInN3IjoxLCJ3bCI6MCwid3AiOjAsIngiOiItZnVuc2lnbmVkLWNoYXIgLURYPTEiLCJyIjpudWxsLCJ2dyI6InRhYnMiLCJjdCI6InJpc2N2NjQtdW5rbm93bi1lbGYifQ',
    state: {
      buffers: [
        {
          name: 'Source 1',
          source: SOURCE,
          options: { ...OPTIONS, triple: 'riscv64-unknown-elf' },
          selectedRecord: null,
        },
      ],
      view: 'tabs',
    },
  },
  'wire V3 in envelope 2': {
    fragment:
      '2.VY_BasMwEER_RUyPkcFJSw8KPYSW0kBpSttDaclBltVY4EhGWscxRv9e5JiQnHZndtl5O-AAcctRBIjfARYCz8YHAkeAQCDfKmIrNjBVSc_UkhlLzCxZXIKjhoCazdIylad-kYODICClV9X9XSabptZZKX1nLDgaCCzAsS8g5hxBQ-QcoRtV14zqCIHsr7XB7KwuszE5e_p-mIPDQ2CFyE-sL33tmLN6wqW-0eydDewgPTsKtrbE4sRZ9bU7g06Mk9ecnISUXyHlV0indNvWddxyHLoUKIuQ7vcQA3belKl65yjVRAOBwkurKnCUkiTE7zZydKakany50mZX0dg6b7QlScaNr20-1j-bt6_VKyJHI62uQ7qqS0POi5s8iRR44XAoZ0lbenT7xllt6TxOH8vi0g-u9UpnJIs0M1Qn2M_RRIwx_gM',
    state: TWO,
  },
  'wire V3 in envelope 1': {
    fragment:
      'eyJ2IjozLCJicyI6W3sibiI6IkZpcnN0IiwicyI6InN0cnVjdCBBIHsgY2hhciBjOyBpbnQgaTsgfTsiLCJsIjoiYysrIiwic3RkIjoiYysrMjAiLCJ0IjoiYWFyY2g2NC1hcHBsZS1kYXJ3aW4iLCJwIjoiMiIsIm1iIjoxLCJzZSI6MCwic3ciOjEsIndwIjowLCJ4IjoiLWZ1bnNpZ25lZC1jaGFyIC1EWD0xIiwiciI6IkEifSx7Im4iOiJIeWxvIG9uZSIsInMiOiJ0eXBlIFAgeyB2YXIgeDogSW50IH0iLCJsIjoiaHlsbyIsInN0ZCI6IiIsInQiOiJoeWxvIiwicCI6IiIsIm1iIjowLCJzZSI6MCwic3ciOjAsIndwIjowLCJ4IjoiIiwiciI6bnVsbH1dLCJ2dyI6InRhYnMiLCJseSI6eyJncmlkIjp7InJvb3QiOnsidHlwZSI6ImJyYW5jaCIsImRhdGEiOltdfSwid2lkdGgiOjEsImhlaWdodCI6MSwib3JpZW50YXRpb24iOiJIT1JJWk9OVEFMIn0sInBhbmVscyI6eyJlZGl0b3I6IzAiOnsiaWQiOiJlZGl0b3I6IzAiLCJjb250ZW50Q29tcG9uZW50IjoiZWRpdG9yIiwidGFiQ29tcG9uZW50Ijoic291cmNlLXRhYiIsInRpdGxlIjoiU291cmNlIn19fX0',
    state: TWO,
  },
};

describe('fragments written once open forever', () => {
  for (const [name, { fragment, state }] of Object.entries(FOREVER)) {
    it(name, async () => {
      expect(await decodeShareState(fragment)).toEqual(state);
    });
  }
});

describe('what this build makes of the values', () => {
  const first = async (wire: unknown) => {
    const s = await decodeShareState(plain(wire));
    if (!s) throw new Error('not a link');
    return s.buffers[0]!;
  };

  it("puts a Hylo buffer on Hylo's one ABI, whatever triple travelled", async () => {
    const b = await first({ v: 3, bs: [{ l: 'hylo', t: 'x86_64-unknown-linux-gnu' }] });
    expect(b.options.lang).toBe('hylo');
    expect(b.options.triple).toBe(HYLO_TRIPLE);
    expect(b.options.std).toBe('');
  });

  it('does not compile C for the Hylo ABI', async () => {
    const b = await first({ l: 'c', t: HYLO_TRIPLE });
    expect(b.options.triple).toBe(DEFAULT_OPTIONS.triple);
  });

  it("falls back to a language it has, and that language's newest standard", async () => {
    expect((await first({ l: 'rust', std: 'c++20' })).options).toMatchObject({
      lang: 'c',
      std: DEFAULT_C_STD,
    });
    expect((await first({ l: 'c++', std: 'c++98x' })).options).toMatchObject({
      lang: 'c++',
      std: DEFAULT_CXX_STD,
    });
    expect((await first({ l: 'c++', std: 'c++17' })).options.std).toBe('c++17');
  });

  it('falls back to the default triple when none came, or one that is not a token', async () => {
    expect((await first({})).options.triple).toBe(DEFAULT_OPTIONS.triple);
    expect((await first({ t: 'a b' })).options.triple).toBe(DEFAULT_OPTIONS.triple);
    expect((await first({ t: '__custom__' })).options.triple).toBe(DEFAULT_OPTIONS.triple);
  });

  it('keeps eight buffers at most, trims names, and drops a layout that is not one', async () => {
    const bs = Array.from({ length: 9 }, (_, i) => ({ n: ' x '.repeat(30) + String(i) }));
    const s = await decodeShareState(plain({ v: 3, bs, ly: { grid: {} } }));
    expect(s?.buffers).toHaveLength(8);
    expect(s?.buffers[0]?.name).toHaveLength(40);
    expect(s?.layout).toBeUndefined();
  });

  it('is null for what is not a link', async () => {
    expect(await decodeShareState('')).toBeNull();
    expect(await decodeShareState('#2.nope')).toBeNull();
    expect(await decodeShareState(plain(['v', 3]))).toBeNull();
  });
});
