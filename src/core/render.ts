// The render model, read rather than derived.
//
// This file used to be five: a parser for clang's textual layout dump, a probe
// generator that compiled one struct per member to measure it, a reader for
// clang's JSON AST, a model builder that reconstructed containment from leaf
// offsets, and a tree builder that recovered nesting from leaf-index intervals.
// About 2500 lines, all of it re-deriving things clang had computed and then
// printed away.
//
// clang-abi-wasm emits the model instead: extents, containment, overlap,
// padding and source locations, worked out where the facts are. What is left
// here is the mapping onto the shapes the views want, and the presentation
// decisions that are genuinely the viewer's — which colour a member gets, and
// what counts as one unit on screen.

import type { Group, Leaf, Marker, PaddingRun, RecordLayout, RenderModel, TreeNode } from './types';

// ------------------------------------------------------------- the wire --
//
// Only what this app reads is named here. The full contract is
// clang-abi-wasm's `index.d.ts`; these are the fields the views need, spelled
// the same way.

export interface WireLocation {
  file: string;
  line: number;
  col: number;
  endCol: number;
  isMainFile: boolean;
}

export interface WireRange {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** One drawable extent. */
export interface WireLeaf {
  kind: 'field' | 'bitfield' | 'special';
  name: string;
  type: string | null;
  offsetBits: number;
  sizeBits: number;
  alignBits: number;
  path: string[];
  ownerId: number | null;
  ownerName: string;
  /** Its type is empty and something else already covers the byte it starts on. */
  sharesAddress: boolean;
  location: WireLocation | null;
}

export interface WireGroup {
  kind: 'member' | 'base' | 'primary-base' | 'vbase' | 'primary-vbase';
  name: string;
  type: string;
  offsetBits: number;
  sizeBits: number;
  typeSizeBits: number;
  alignBits: number;
  path: string[];
  ownerId: number | null;
  ownerName: string;
  recordId: number | null;
  isBase: boolean;
  isUnion: boolean;
  leafIndexes: number[];
  location: WireLocation | WireRange | null;
}

export interface WireMarker {
  kind: 'empty-base' | 'zero-bitfield';
  name: string;
  type: string;
  offsetBits: number;
  path: string[];
}

export interface WireNode {
  kind: 'leaf' | 'group';
  ref: number;
  overlaps: boolean;
  children: WireNode[];
}

export interface WireRender {
  leaves: WireLeaf[];
  groups: WireGroup[];
  markers: WireMarker[];
  tree: WireNode[];
  paddingRuns: { startBits: number; endBits: number }[];
  paddingBits: number | null;
}

export interface WireField {
  name: string;
  typeSpelling: string;
  canonicalTypeSpelling: string;
  offsetBits: number;
  sizeBits: number;
  alignBits: number;
  explicitAlignBits: number | null;
  location: WireLocation | null;
}

export interface WireRecord {
  id: number;
  kind: RecordLayout['kind'];
  name: string;
  qualifiedName: string;
  printedName: string;
  isAnonymous: boolean;
  isEmpty: boolean;
  isUserCode: boolean;
  parentRecordId: number | null;
  location: WireLocation | null;
  range: WireRange | null;
  sizeBits: number;
  alignBits: number;
  dataSizeBits: number;
  nonVirtualSizeBits: number;
  nonVirtualAlignBits: number;
  preferredAlignBits: number;
  fields: WireField[];
  render: WireRender;
}

export interface WireTypedef {
  name: string;
  qualifiedName: string;
  location: WireLocation | null;
  typeSpelling: string;
  canonicalTypeSpelling: string;
  sizeBits: number;
  alignBits: number;
  recordId: number | null;
}

export interface WireDiagnostic {
  severity: 'note' | 'remark' | 'warning' | 'error' | 'fatal';
  message: string;
  location: WireLocation | null;
  ranges: WireRange[];
}

export interface WireResponse {
  ok: boolean;
  error: string | null;
  exitCode: number;
  clangVersion: string;
  target: { pointerSizeBits: number; normalizedTriple: string } | null;
  diagnostics: WireDiagnostic[];
  diagnosticsText: string;
  typedefs: WireTypedef[];
  records: WireRecord[];
}

// ------------------------------------------------------------ the model --

/**
 * Build the model the views read. A near-mechanical mapping: the shapes differ
 * only where the views want bytes and the wire speaks bits, or where a name is
 * more convenient than an id.
 */
export function fromWire(record: RecordLayout, wire: WireRender): RenderModel {
  const leaves: Leaf[] = wire.leaves.map((l) => ({
    kind: l.kind,
    name: l.name,
    type: l.type,
    offsetBits: l.offsetBits,
    sizeBits: l.sizeBits,
    // Alignment is shown in bytes; a bit-field has none of its own.
    align: l.alignBits > 0 ? l.alignBits / 8 : null,
    path: l.path,
    owner: l.ownerName,
    sharesAddress: l.sharesAddress,
    location: l.location,
  }));

  const groups: Group[] = wire.groups.map((g) => ({
    kind: g.kind,
    name: g.name,
    type: g.type,
    owner: g.ownerName,
    path: g.path,
    offsetBits: g.offsetBits,
    sizeBits: g.sizeBits,
    typeSizeBits: g.typeSizeBits,
    align: g.alignBits > 0 ? g.alignBits / 8 : null,
    leafIndexes: g.leafIndexes,
    isBase: g.isBase,
    isUnion: g.isUnion,
    recordId: g.recordId,
    location: g.location,
  }));

  const markers: Marker[] = wire.markers.map((m) => ({
    kind: m.kind,
    name: m.name,
    type: m.type,
    offsetBits: m.offsetBits,
    path: m.path,
  }));

  const paddings: PaddingRun[] = wire.paddingRuns.map((r) => ({
    start: r.startBits / 8,
    end: r.endBits / 8,
  }));

  const model: RenderModel = {
    record,
    leaves,
    groups,
    markers,
    tree: hydrate(wire.tree, leaves, groups, 0),
    paddings,
    sizeBits: record.sizeBytes * 8,
    // Null means the record was too large to scan; the views show nothing
    // rather than a confident zero.
    paddingBytes: wire.paddingBits === null ? null : wire.paddingBits / 8,
  };
  assignColors(model);
  return model;
}

/**
 * Give the emitted tree the fields the table reads off a node — an id for keys
 * and collapse state, a depth for indentation, and the extent of whatever it
 * refers to, so a row never has to look its own subject up.
 */
function hydrate(nodes: WireNode[], leaves: Leaf[], groups: Group[], depth: number): TreeNode[] {
  return nodes.map((n) => {
    const subject = n.kind === 'group' ? groups[n.ref] : leaves[n.ref];
    return {
      id: (n.kind === 'group' ? 'g' : 'l') + String(n.ref),
      kind: n.kind,
      ref: n.ref,
      offsetBits: subject?.offsetBits ?? 0,
      sizeBits: subject?.sizeBits ?? 0,
      align: subject?.align ?? null,
      leafIndexes: n.kind === 'group' ? (groups[n.ref]?.leafIndexes ?? []) : [n.ref],
      isBase: n.kind === 'group' ? (groups[n.ref]?.isBase ?? false) : false,
      isUnion: n.kind === 'group' ? (groups[n.ref]?.isUnion ?? false) : false,
      overlaps: n.overlaps,
      depth,
      children: hydrate(n.children, leaves, groups, depth + 1),
    };
  });
}

// -------------------------------------------------------- presentation --

/** How a member with no name of its own is labelled. */
const ANON = '(anonymous)';

/**
 * Is a member with this path a member *of the record itself*? Direct fields
 * are, and so are fields injected by an anonymous aggregate (`msg.crc_lo`), but
 * a field of a named compound member is reached through it (`msg.hdr.kind`) and
 * belongs to that member's own record.
 */
export function isNameable(path: readonly string[]): boolean {
  return path.every((p) => p === ANON);
}

/** The members of a record: its own fields and its compound members, one level deep. */
export function directMembers(model: RenderModel): (Leaf | Group)[] {
  const covered = new Set<number>();
  const units: (Leaf | Group)[] = [];
  for (const g of model.groups) {
    if (!isNameable(g.path) || g.name === ANON) continue; // anonymous: transparent
    units.push(g);
    for (const li of g.leafIndexes) covered.add(li);
  }
  model.leaves.forEach((leaf, li) => {
    if (covered.has(li) || !isNameable(leaf.path)) return;
    units.push(leaf);
  });
  return units.sort((a, b) => a.offsetBits - b.offsetBits);
}

/**
 * The single colour a compound member stands for, or null when it spans
 * several — an anonymous aggregate, whose fields are members in their own right.
 */
export function groupColorClass(model: RenderModel, group: Group): string | null {
  const colours = new Set(group.leafIndexes.map((li) => model.leaves[li]?.colorClass));
  return colours.size === 1 ? ([...colours][0] ?? null) : null;
}

/**
 * Assign categorical colour slots one level deep: a colour identifies a *direct
 * member* of this record. A compound member is one unit, so every leaf inside it
 * shares its colour — the grid then shows `hdr` as one block rather than a
 * stripe per nested field, and no colour means two different things at once.
 *
 * This stays in the viewer on purpose. Which member is which is a fact about
 * the record; which colour says so is a fact about the screen.
 */
export function assignColors(model: RenderModel, paletteSize = 8): void {
  const slot = (i: number) => `c-${(i % paletteSize) + 1}`;
  let next = 0;
  const assigned = new Set<number>();
  for (const g of model.groups) {
    if (!isNameable(g.path) || g.name === ANON) continue;
    const colour = slot(next++);
    for (const li of g.leafIndexes) {
      const leaf = model.leaves[li];
      if (!leaf || assigned.has(li)) continue;
      leaf.colorClass = leaf.kind === 'special' ? 'c-special' : colour;
      assigned.add(li);
    }
  }
  model.leaves.forEach((leaf, li) => {
    if (assigned.has(li)) return;
    leaf.colorClass = leaf.kind === 'special' ? 'c-special' : slot(next++);
  });
}

/** Depth-first list of nodes with collapsed subtrees hidden. */
export function flattenVisible(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  const walk = (ns: TreeNode[], depth: number) => {
    for (const n of ns) {
      out.push({ node: n, depth });
      if (n.children.length && !collapsed.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}
