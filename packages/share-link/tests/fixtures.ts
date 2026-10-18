// The states the tests write, and what each version's wire of them reads back as.

import type { ShareOptions, ShareState } from '../src/index.ts';

export const OPTIONS: ShareOptions = {
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

export const HYLO_OPTIONS: ShareOptions = {
  lang: 'hylo',
  std: '',
  triple: 'hylo',
  pack: '',
  msBitfields: false,
  shortEnums: false,
  shortWchar: false,
  warnPadded: false,
  extraFlags: '',
};

export const SOURCE = 'struct A { char c; int i; };';

/** One source: what V1 and V2 can carry. */
export const ONE: ShareState = {
  buffers: [{ name: 'Source 1', source: SOURCE, options: OPTIONS, selectedRecord: 'A' }],
  view: 'stack',
};

/** Two sources of two languages, and a desk. */
export const TWO: ShareState = {
  buffers: [
    { name: 'First', source: SOURCE, options: OPTIONS, selectedRecord: 'A' },
    {
      name: 'Hylo one',
      source: 'type P { var x: Int }',
      options: HYLO_OPTIONS,
      selectedRecord: null,
    },
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

/**
 * Fragments written once, kept as literals, readable forever.
 *
 * Each was written by a real build of abiexplorer.org and is what someone's
 * shared link actually holds: the first two by the single-source site as of
 * September 2026, the third by an older build for a triple typed into the
 * custom box, the last two by the multi-source site (wire V3) in each
 * envelope. `wire.test.ts` pins the key names and `envelope.test.ts` the two
 * older envelopes, so most of this is belt and braces; what is new here is a
 * whole V3 fragment read end to end, wire and envelope together, as a
 * stranger's link actually arrives. Never change one; add one when a version
 * is added.
 */
export const FOREVER: Record<string, { fragment: string; state: ShareState }> = {
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
