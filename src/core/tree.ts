// Turns the flat render model (leaves + groups) into a containment tree for the
// grouped field table. Groups (compound members, base subobjects) span a
// contiguous, properly-nested interval of leaf indices, so the tree is built by
// interval nesting — never by matching path strings, which collide for sibling
// anonymous members.
//
// The tree encodes *containment*, not spatial layout: unions and tail-padding
// reuse mean siblings can share bytes. Such overlap is flagged per node
// (`overlaps`) and shown authoritatively in the byte grid; the tree stays a
// clean nesting.

import type { Group, Leaf, RenderModel } from './types';

export interface TreeNode {
  /** Stable id for collapse state and keys. */
  id: string;
  kind: 'leaf' | 'group';
  /** Index into model.leaves (kind 'leaf') or model.groups (kind 'group'). */
  ref: number;
  offsetBits: number;
  /** null when a group's size is unknown. */
  sizeBits: number | null;
  align: number | null;
  /** Leaf indices this subtree covers, for hover highlighting. */
  leafIndexes: number[];
  isBase: boolean;
  isUnion: boolean;
  /** This node's byte range intersects a sibling's (union / EBO / tail-padding reuse). */
  overlaps: boolean;
  depth: number;
  children: TreeNode[];
}

interface Interval {
  gi: number; // group index
  start: number; // first leaf index (inclusive)
  end: number; // one past the last leaf index; == start for empty groups (zero width)
  depth: number; // nesting depth (enclosing group count) — breaks ties when two groups cover the same leaves
}

/** Build the containment forest for a record's layout. */
export function buildLayoutTree(model: RenderModel): TreeNode[] {
  const { leaves, groups } = model;

  const intervals: Interval[] = groups.map((g, gi) => {
    if (g.leafIndexes.length === 0) {
      const pos = emptyGroupPosition(g, leaves);
      return { gi, start: pos, end: pos, depth: g.path.length };
    }
    return {
      gi,
      start: Math.min(...g.leafIndexes),
      end: Math.max(...g.leafIndexes) + 1,
      depth: g.path.length,
    };
  });

  const roots = buildForest(0, leaves.length, intervals);
  markOverlaps(roots);
  return roots;

  /**
   * Nodes contained in [lo, hi): the top-level intervals in `within` (those not
   * strictly inside another interval of `within`), interleaved with the leaves
   * they do not cover, in declaration (offset) order.
   */
  function buildForest(lo: number, hi: number, within: Interval[]): TreeNode[] {
    const top = within.filter((iv) => !within.some((o) => o !== iv && contains(o, iv)));
    // Order by start; at the same start, wider (outer) first, then empty groups.
    top.sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.depth - b.depth,
    );

    const out: TreeNode[] = [];
    let cursor = lo;
    // An interval belongs to exactly one parent. Containment can still be
    // ambiguous where the label path does not separate two candidates (sibling
    // anonymous members share a label), and a node claimed twice would be
    // rendered twice — with the same key, which a keyed `{#each}` rejects.
    const claimed = new Set<Interval>();
    for (const iv of top) {
      for (; cursor < iv.start; cursor++) out.push(leafNode(cursor));
      const inside = within.filter((o) => o !== iv && !claimed.has(o) && contains(iv, o));
      for (const o of inside) claimed.add(o);
      out.push(groupNode(iv, buildForest(iv.start, iv.end, inside)));
      cursor = Math.max(cursor, iv.end);
    }
    for (; cursor < hi; cursor++) out.push(leafNode(cursor));
    return out;
  }

  /** Does interval `a` strictly contain `b` (b nested one or more levels in a)? */
  function contains(a: Interval, b: Interval): boolean {
    // Identical spans — a group whose only content is one nested group, or
    // several groups that hold no leaves at all (a member whose type has nothing
    // but an empty base). Leaf indices cannot separate these, so ask the label
    // path, which records the actual nesting: comparing depth alone would let
    // *every* shallower group claim *every* deeper one, and two sibling members
    // would each adopt the other's subobjects.
    if (a.start === b.start && a.end === b.end) return enclosesByPath(a, b);
    // A group holding no leaves has only a point, and the point where one member
    // ends is the point where the next begins — an empty base declared last in
    // its own base lands exactly there, and used to be drawn inside the member
    // that follows it. Position still bounds the search (the interval has to
    // stay a valid range, or leaves get emitted twice), but the path decides
    // which of the two candidates actually declares it.
    if (b.end === b.start) return a.start <= b.start && b.start <= a.end && enclosesByPath(a, b);
    return a.start <= b.start && b.end <= a.end;
  }

  /** Is b's group written inside a's, per the label path the model recorded? */
  function enclosesByPath(a: Interval, b: Interval): boolean {
    const ga = groups[a.gi]!;
    const gb = groups[b.gi]!;
    const prefix = [...ga.path, ga.name];
    return prefix.length <= gb.path.length && prefix.every((label, i) => gb.path[i] === label);
  }

  function groupNode(iv: Interval, children: TreeNode[]): TreeNode {
    const g = groups[iv.gi]!;
    return {
      id: `g${iv.gi}`,
      kind: 'group',
      ref: iv.gi,
      offsetBits: g.offsetBits,
      sizeBits: g.sizeBits,
      align: g.align,
      leafIndexes: g.leafIndexes,
      isBase: g.isBase,
      isUnion: g.isUnion,
      overlaps: false,
      depth: 0,
      children,
    };
  }

  function leafNode(li: number): TreeNode {
    const l = leaves[li]!;
    return {
      id: `l${li}`,
      kind: 'leaf',
      ref: li,
      offsetBits: l.offsetBits,
      sizeBits: l.sizeBits,
      align: l.align,
      leafIndexes: [li],
      isBase: false,
      isUnion: false,
      overlaps: false,
      depth: 0,
      children: [],
    };
  }
}

/**
 * Where a group with no leaves is drawn: after every leaf that starts strictly
 * before it. A leaf at the *same* offset does not precede it — an empty base
 * shares its offset with whatever follows it, and is declared first.
 */
function emptyGroupPosition(g: Group, leaves: Leaf[]): number {
  let pos = 0;
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i]!.offsetBits < g.offsetBits) pos = i + 1;
  }
  return pos;
}

/** Set depth and the sibling-overlap flag throughout the forest. */
function markOverlaps(nodes: TreeNode[], depth = 0): void {
  for (const n of nodes) n.depth = depth;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const aEnd = a.offsetBits + (a.sizeBits ?? 0);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const bEnd = b.offsetBits + (b.sizeBits ?? 0);
      // Zero-size nodes (empty base) don't count as overlapping.
      if (
        (a.sizeBits ?? 0) > 0 &&
        (b.sizeBits ?? 0) > 0 &&
        a.offsetBits < bEnd &&
        b.offsetBits < aEnd
      ) {
        a.overlaps = true;
        b.overlaps = true;
      }
    }
  }
  for (const n of nodes) markOverlaps(n.children, depth + 1);
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

/** Depth-first list of nodes with collapsed subtrees hidden. */
export function flattenVisible(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): FlatRow[] {
  const out: FlatRow[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children.length && !collapsed.has(n.id)) {
      out.push(...flattenVisible(n.children, collapsed, depth + 1));
    }
  }
  return out;
}
