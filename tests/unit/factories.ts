// Hand-built models, for the pure functions whose inputs are easier to state
// than to compile.
//
// Anything about *layout* is tested against the corpus instead — real answers
// from the real compiler. These factories exist for the presentation code
// (colours, marks, dots), where the interesting input is a shape a source file
// would take several records to produce.

import type { Group, Leaf, RecordLayout, RenderModel, SourceLocation } from '$core/types';
import type { AnalysedRecord } from '$compiler/AbiAnalyzer';

export function loc(line: number, col = 3, endCol = col + 1): SourceLocation {
  return { file: 'input.c', line, col, endCol, isMainFile: true };
}

export function leaf(name: string, extra: Partial<Leaf> = {}): Leaf {
  return {
    kind: 'field',
    path: [],
    name,
    type: null,
    offsetBits: 0,
    sizeBits: 8,
    align: 1,
    owner: 'S',
    sharesAddress: false,
    location: null,
    // A hand-built leaf is a member of the record it is built for; a test that
    // needs one nested inside a compound member says so.
    direct: true,
    ...extra,
  };
}

export function group(name: string, leafIndexes: number[], extra: Partial<Group> = {}): Group {
  return {
    kind: 'member',
    name,
    type: '',
    owner: 'S',
    path: [],
    offsetBits: 0,
    sizeBits: 8,
    typeSizeBits: 8,
    align: 1,
    leafIndexes,
    isBase: false,
    isUnion: false,
    recordId: null,
    location: null,
    direct: true,
    ...extra,
  };
}

export function record(name: string, extra: Partial<RecordLayout> = {}): RecordLayout {
  return {
    kind: 'struct',
    name,
    qualifiedName: name,
    isEmpty: false,
    sizeBytes: 0,
    align: 1,
    location: null,
    range: null,
    ...extra,
  };
}

export function model(leaves: Leaf[], groups: Group[] = [], rec = record('S')): RenderModel {
  // `direct` is derived from the tree in the real thing (only the tree knows
  // whether a path element was a base or a member). These models have no tree,
  // so it is derived from the path instead, by looking each element up by
  // name: anonymous aggregates and bases are transparent, everything else is
  // a member you have to name first. Same rule, cruder lookup.
  const byName = new Map(groups.map((g) => [g.name, g]));
  const transparent = (label: string) => label === '(anonymous)' || byName.get(label)?.isBase;
  const isDirect = (path: readonly string[]) => path.every((p) => transparent(p) === true);
  for (const l of leaves) l.direct = isDirect(l.path);
  for (const g of groups) g.direct = isDirect(g.path);
  return {
    record: rec,
    leaves,
    groups,
    markers: [],
    tree: [],
    paddings: [],
    sizeBits: rec.sizeBytes * 8,
    paddingBytes: 0,
  };
}

export function analysed(key: string, rec: RecordLayout, m?: RenderModel): AnalysedRecord {
  return { key, record: rec, model: m ?? model([], [], rec), listed: true };
}
