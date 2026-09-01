// The Hylo backend, held to the same laws as clang's.
//
// This file exists because of a divergence that nothing caught: Hylo answered
// with a flat list of parts, so a member whose type was a record was drawn as
// two members side by side, while clang drew one holding two. Both answers
// passed every test, because the laws about containment only ever ran over
// clang's.
//
// They run over both now. A Hylo answer becomes a `RenderModel` by the same
// path a clang answer does, and `modelLaws` states what must be true of any
// model whatever produced it: padding accounts for every byte, extents nest,
// the table and the grid agree, the tree contains each leaf once. A future
// backend that reports less than it should fails here rather than on screen.

import { toWireResponse, type HyloAnswer, type HyloLayout } from '$compiler/hylo-wire';
import { toAnalysis } from '$compiler/AbiAnalyzer';
import { DEFAULT_OPTIONS } from '$core/options';
import { modelLaws, type Subject } from './model-laws';

const hylo = { ...DEFAULT_OPTIONS, lang: 'hylo' as const, std: '', triple: 'hylo' };
const here = { line: 1, column: 1, endLine: 1, endColumn: 2 };

/** A record's worth of Hylo layout, as the module reports one. */
const layouts: HyloLayout[] = [
  // Reordered storage: the i8 declared first is stored last, and the trailing
  // byte of the record is padding.
  {
    type: 'Header',
    size: 13,
    alignment: 8,
    isEnum: false,
    site: here,
    parts: [
      { name: 'flag', type: 'i8', offset: 12, size: 1, alignment: 1, site: here },
      { name: 'count', type: 'i32', offset: 8, size: 4, alignment: 4, site: here },
      { name: 'id', type: 'Int', offset: 0, size: 8, alignment: 8, site: here },
    ],
  },
  // A sum type: the cases overlap and the discriminator follows them.
  {
    type: 'Message',
    size: 9,
    alignment: 8,
    isEnum: true,
    site: here,
    parts: [
      { name: 'ping', type: 'Void', offset: 0, size: 0, alignment: 1, site: here },
      { name: 'data', type: '{i64}', offset: 0, size: 8, alignment: 8, site: here },
      { name: 'code', type: '{i16}', offset: 0, size: 2, alignment: 2, site: here },
      { name: 'discriminator', type: 'i8', offset: 8, size: 1, alignment: 1 },
    ],
  },
  // A record holding two records, which is the shape that diverged.
  {
    type: 'L',
    size: 25,
    alignment: 8,
    isEnum: false,
    site: here,
    parts: [
      {
        name: 'c',
        type: 'Header',
        offset: 0,
        size: 13,
        alignment: 8,
        site: here,
        parts: [
          { name: 'flag', type: 'i8', offset: 12, size: 1, alignment: 1, site: here },
          { name: 'count', type: 'i32', offset: 8, size: 4, alignment: 4, site: here },
          { name: 'id', type: 'Int', offset: 0, size: 8, alignment: 8, site: here },
        ],
      },
      {
        name: 'rrr',
        type: 'Message',
        offset: 16,
        size: 9,
        alignment: 8,
        site: here,
        isEnum: true,
        parts: [
          { name: 'ping', type: 'Void', offset: 16, size: 0, alignment: 1, site: here },
          { name: 'data', type: '{i64}', offset: 16, size: 8, alignment: 8, site: here },
          { name: 'code', type: '{i16}', offset: 16, size: 2, alignment: 2, site: here },
          { name: 'discriminator', type: 'i8', offset: 24, size: 1, alignment: 1 },
        ],
      },
    ],
  },
];

const subjects = (): Subject[] => {
  const answer: HyloAnswer = { layouts, diagnostics: [] };
  const analysis = toAnalysis(toWireResponse(answer, 'Hylo (wasm)'), 'source', hylo);
  return analysis.records.map((r) => ({
    label: `hylo ${r.key}`,
    model: r.model,
    // Hylo stores members by decreasing alignment, and the table stays in
    // source order so that the reordering is visible rather than hidden.
    declarationIsStorageOrder: false,
  }));
};

modelLaws('hylo', subjects);
