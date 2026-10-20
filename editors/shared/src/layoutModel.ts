// What every drawing of a layout shares: the text map, the SVG in hovers, and
// the panel in VS Code and CLion all draw from these, so they agree with each
// other and with the web explorer on which byte (and bit) is whose, which
// colour a member gets, and how the member table reads.

import type {
  AnalysisContext,
  LayoutView,
  LeafView,
  MemberView,
  NodeView,
  RecordView,
} from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from './format.ts';

// The member colours of the web explorer's themes (its `src/core/themes.ts`):
// Nocturne's on dark backgrounds, the light themes' default on light ones.
// Slots are `c-1`…`c-8`, and `c-special` for vtable pointers.
export const MEMBER_COLORS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    'c-1': '#82aaff',
    'c-2': '#f78c6c',
    'c-3': '#7fdbca',
    'c-4': '#ffcb6b',
    'c-5': '#ff869a',
    'c-6': '#addb67',
    'c-7': '#c792ea',
    'c-8': '#ef5350',
    'c-special': '#5f6b8a',
  },
  light: {
    'c-1': '#3b6fd4',
    'c-2': '#e0742b',
    'c-3': '#21a58a',
    'c-4': '#d9a400',
    'c-5': '#d65f9b',
    'c-6': '#4f9d2f',
    'c-7': '#6c4bc9',
    'c-8': '#d94a4a',
    'c-special': '#9a9a94',
  },
};

/**
 * The web's neutrals, for what draws its own colours (hover images): the
 * grid's ground and hatching, the hover outline, the labels. Nocturne's on
 * dark themes, the light default's on light ones.
 */
export const NEUTRALS = {
  dark: {
    surface: '#1a1a19',
    gridLine: '#2c2c2a',
    baseline: '#383835',
    text: '#ffffff',
    muted: '#898781',
    accent: '#3987e5',
  },
  light: {
    surface: '#fcfcfb',
    gridLine: '#e1e0d9',
    baseline: '#c3c2b7',
    text: '#0b0b0b',
    muted: '#898781',
    accent: '#2a78d6',
  },
};

export const NOCTURNE = NEUTRALS.dark;

/** A slot's colour on a dark or light background. */
export function slotColor(slot: string, mode: 'dark' | 'light' = 'dark'): string {
  return MEMBER_COLORS[mode][slot] ?? MEMBER_COLORS[mode]['c-special']!;
}

/** Bytes per row, as the web explorer's grid: 8, or 16 past 64 bytes. */
export function bytesPerRow(sizeBytes: number): number {
  return sizeBytes <= 64 ? 8 : 16;
}

/** Past this many bytes the panel draws a proportional bar instead of a grid, as the web does. */
export const GRID_LIMIT = 2048;

/** Past this many bytes a hover draws no map: hundreds of rows help nobody there. */
export const MAX_MAPPED_BYTES = 512;

/** One byte of the grid. */
export interface GridCell {
  byte: number;
  /** The leaves with bits in it; none is padding, several a union or a shared bit-field unit. */
  leaves: number[];
  /** Each bit's leaf, where a bit-field touches the byte. */
  bits: (number | null)[] | null;
  /** A leaf starts here, so the cell's left edge is a boundary. */
  start: boolean;
  /** Inside a base subobject: the band that brackets what the base contributes. */
  band: { first: boolean; last: boolean } | null;
}

/** The grid's cells, worked out as the web explorer's ByteGrid does. */
export function gridCells(record: RecordView): GridCell[] {
  const { layout } = record;
  const size = Math.ceil(record.sizeBits / 8);
  const byByte = new Map<number, number[]>();
  const bitBytes = new Set<number>();
  layout.leaves.forEach((leaf, index) => {
    if (leaf.sizeBits === 0) return;
    const from = Math.floor(leaf.offsetBits / 8);
    const to = Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8);
    for (let byte = from; byte < to; byte++) {
      byByte.set(byte, [...(byByte.get(byte) ?? []), index]);
      if (leaf.kind === 'bitfield') bitBytes.add(byte);
    }
  });
  const bands = new Map<number, { first: boolean; last: boolean }>();
  for (const group of layout.groups) {
    if (!group.isBase || group.path.length > 0 || !group.sizeBits) continue;
    const from = Math.floor(group.offsetBits / 8);
    const to = Math.ceil((group.offsetBits + group.sizeBits) / 8);
    for (let byte = from; byte < to; byte++) {
      bands.set(byte, { first: byte === from, last: byte === to - 1 });
    }
  }
  return Array.from({ length: size }, (_, byte): GridCell => {
    const leaves = byByte.get(byte) ?? [];
    const bits = bitBytes.has(byte)
      ? Array.from({ length: 8 }, (_, bit) => {
          const at = byte * 8 + bit;
          const owner = leaves.find((index) => {
            const leaf = layout.leaves[index]!;
            return at >= leaf.offsetBits && at < leaf.offsetBits + leaf.sizeBits;
          });
          return owner ?? null;
        })
      : null;
    return {
      byte,
      leaves,
      bits,
      start: leaves.some((index) => Math.floor(layout.leaves[index]!.offsetBits / 8) === byte),
      band: bands.get(byte) ?? null,
    };
  });
}

/** The cells to draw in a hover, or null when there are none or too many to be of use. */
export function mappedCells(record: RecordView): GridCell[] | null {
  const size = Math.ceil(record.sizeBits / 8);
  return size === 0 || size > MAX_MAPPED_BYTES ? null : gridCells(record);
}

/** Bytes of padding after each leaf: each run goes to the leaf ending closest before it. */
export function paddingAfter(layout: LayoutView): Map<number, number> {
  const out = new Map<number, number>();
  for (const run of layout.paddings) {
    let best = -1;
    let bestEnd = -1;
    layout.leaves.forEach((leaf, index) => {
      const end = leaf.offsetBits + leaf.sizeBits;
      if (end <= run.startBits && end > bestEnd) {
        bestEnd = end;
        best = index;
      }
    });
    if (best >= 0) out.set(best, (out.get(best) ?? 0) + (run.endBits - run.startBits) / 8);
  }
  return out;
}

/** A node's id, stable within one layout: `g3`, `l0`. */
export function nodeId(node: NodeView): string {
  return (node.kind === 'group' ? 'g' : 'l') + String(node.ref);
}

/** The table's rows, depth-first; a node not in `open` shows, but not what it holds. */
export function visibleRows(
  tree: readonly NodeView[],
  open: ReadonlySet<string>,
): { node: NodeView; depth: number }[] {
  const out: { node: NodeView; depth: number }[] = [];
  const walk = (nodes: readonly NodeView[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.children.length && open.has(nodeId(node))) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** `ready` / `Flags::ready`: a leaf's name, with the members it is inside. */
export function leafName(leaf: LeafView): string {
  return [...leaf.path, leaf.name].join(' :: ');
}

/** "3 b" for a bit-field, "8 B" otherwise: the web's size column. */
export function leafSize(leaf: LeafView): string {
  return leaf.kind === 'bitfield' ? `${leaf.sizeBits} b` : formatSizeShort(leaf.sizeBits);
}

/** `40 B · align 8 · 9 B padding`: the hover's and the panel's line for a record. */
export function recordSummary(record: RecordView): string {
  const parts = [formatSizeShort(record.sizeBits), `align ${record.alignBits / 8}`];
  if (record.paddingBytes) parts.push(`${record.paddingBytes} B padding`);
  return parts.join(' · ');
}

/** What the reorder warning and its fixes read of a member. */
export type ReorderMember = Pick<
  MemberView,
  'kind' | 'label' | 'offsetBits' | 'sizeBits' | 'alignBits' | 'nameRange'
>;

/**
 * What they read of a record: as little as the web explorer, which has no
 * `RecordView`, can build from its own model.
 */
export type ReorderRecord = Pick<
  RecordView,
  'kind' | 'name' | 'sizeBits' | 'alignBits' | 'paddingBytes' | 'nameRange' | 'extent'
> & { members: readonly ReorderMember[] };

/**
 * The members (as indices) in the order that packs them tightest, and the
 * size that order would give; null when the order already costs nothing, or
 * the record is not a plain list of fields (bases, a vtable pointer,
 * bit-fields and unions are laid out by rules a reorder does not simply
 * change).
 */
export function tighterOrder(record: ReorderRecord): { order: number[]; sizeBits: number } | null {
  if (record.kind === 'union' || record.paddingBytes === 0 || record.members.length < 2) {
    return null;
  }
  const fields = record.members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => a.member.offsetBits - b.member.offsetBits);
  let end = 0;
  for (const { member } of fields) {
    // A flexible array member (size 0) has to stay last.
    const whole =
      member.offsetBits % 8 === 0 &&
      member.sizeBits % 8 === 0 &&
      member.sizeBits > 0 &&
      member.alignBits > 0;
    // Members sharing bytes are an anonymous union's.
    if (member.kind !== 'field' || !whole || member.offsetBits < end) return null;
    end = member.offsetBits + member.sizeBits;
  }
  // `#pragma pack` lowers the record's alignment, and each member's with it.
  const alignOf = (member: ReorderMember) => Math.min(member.alignBits, record.alignBits);
  const place = (order: readonly { member: ReorderMember }[]) => {
    let end = 0;
    const offsets = order.map(({ member }) => {
      const offset = roundUp(end, alignOf(member));
      end = offset + member.sizeBits;
      return offset;
    });
    return { offsets, size: roundUp(end, record.alignBits) };
  };
  // Only where these rules reproduce the layout as it is: an `alignas` on a
  // member, for one, is not in its alignment here.
  const current = place(fields);
  const reproduced =
    current.size === record.sizeBits &&
    current.offsets.every((offset, index) => offset === fields[index]!.member.offsetBits);
  if (!reproduced) return null;
  const order = [...fields].sort((a, b) => alignOf(b.member) - alignOf(a.member));
  const { size } = place(order);
  if (size >= record.sizeBits) return null;
  return { order: order.map(({ index }) => index), sizeBits: size };
}

/**
 * The server's warning on a record whose member order wastes space:
 * `Packet would take 32 B instead of 40 B with its members ordered as b, a, c.`,
 * or null (see `tighterOrder`).
 */
export function reorderWarning(record: ReorderRecord): string | null {
  const tighter = tighterOrder(record);
  if (!tighter) return null;
  // The order itself while it is short enough to read in one line.
  const how =
    tighter.order.length <= 6
      ? `ordered as ${tighter.order.map((index) => record.members[index]!.label).join(', ')}`
      : 'ordered by alignment';
  return `${record.name} would take ${formatSizeShort(tighter.sizeBits)} instead of ${formatSizeShort(record.sizeBits)} with its members ${how}.`;
}

function roundUp(bits: number, alignBits: number): number {
  return Math.ceil(bits / alignBits) * alignBits;
}

/** `Shape at 0, Base at 8 (virtual)`, or null without bases. */
export function baseList(record: RecordView): string | null {
  if (record.bases.length === 0) return null;
  return record.bases
    .map(
      (base) =>
        `${base.name} at ${formatOffset(base.offsetBits)}${base.isVirtual ? ' (virtual)' : ''}`,
    )
    .join(', ');
}

/** Where the layouts come from, and anything that makes them less certain. */
export function contextNotes(context: AnalysisContext): string[] {
  const notes = [context.triple, context.commandSource];
  if (context.commandInferred) notes.push('flags borrowed from a neighbouring file');
  const errors = (count: number) => (count === 1 ? '1 error' : `${count} errors`);
  if (context.errorCount > 0) {
    notes.push(`${errors(context.errorCount)} in this file, so layouts may be incomplete`);
  }
  if (context.otherErrorCount > 0) {
    notes.push(`${errors(context.otherErrorCount)} in its headers or flags`);
  }
  if (context.firstError) notes.push(context.firstError);
  if (context.warning) notes.push(context.warning);
  return notes;
}
