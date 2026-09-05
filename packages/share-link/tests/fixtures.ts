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
