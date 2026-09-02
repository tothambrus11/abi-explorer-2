// Resolving the effective hover, as a pure function of the inputs (pointer,
// cursor, grid/table intent) and the current models/locations.
//
// Intent, not a snapshot: a grid or table hover records *what* is hovered
// (record + leaf/group index), never a pre-resolved member list. Resolution
// happens against whatever the models are now, so a hover cannot survive into a
// later analysis pointing at some unrelated member.

import type { AnalysedRecord } from '$compiler/AbiAnalyzer';
import { recordsAtLine } from './inspected-record';
import { anchorOf, type Anchor, type Group, type Leaf, type RenderModel } from '$core/types';
import { markAtColumn, type LineInfo } from './code-locations';
import type { ByteRange, Hover, MemberRef } from './store.svelte';

export interface TooltipAnchor {
  html: string;
  x: number;
  y: number;
}

/** What the pointer is over in the grid or the field table. */
export type HoverIntent =
  | { kind: 'leaf'; record: string; leaf: number; tooltip: TooltipAnchor | null }
  | { kind: 'group'; record: string; group: number; tooltip: TooltipAnchor | null }
  /**
   * A region of the byte map: a cell, or one bit of it. What is meant is
   * whoever has bits there *now*, so members that overlap (a union, a reused
   * tail) are all meant at once.
   */
  | { kind: 'area'; record: string; fromBit: number; toBit: number; tooltip: TooltipAnchor | null }
  /** A padding cell: a tooltip with no member behind it. */
  | { kind: 'tooltip'; tooltip: TooltipAnchor };

/** A position in the editor. */
export interface EditorPos {
  line: number;
  col: number;
}

export interface HoverInputs {
  /** Grid/table intent, which wins over the editor when present. */
  intent: HoverIntent | null;
  /** Pointer position in the editor. */
  mouse: EditorPos | null;
  /** Text cursor position. */
  cursor: EditorPos | null;
  /** After a keyboard move the cursor beats a stale pointer until the mouse moves. */
  preferCursor: boolean;
  models: Map<string, RenderModel>;
  lines: Map<number, LineInfo>;
  /** Records with their extents, for a cursor that is on no member's line. */
  records: AnalysedRecord[];
  /** The record on screen, to break ties between instantiations sharing an extent. */
  current: string | null;
}

export const EMPTY_HOVER: Hover = {
  members: [],
  ranges: [],
  line: null,
  nameRange: null,
  inlay: null,
  tooltip: null,
};

/** The bytes an item covers, as the grid draws them. */
function extentOf(record: string, items: { offsetBits: number; sizeBits: number }[]): ByteRange[] {
  return items
    .filter((it) => it.sizeBits > 0)
    .map((it) => ({
      record,
      start: Math.floor(it.offsetBits / 8),
      end: Math.ceil((it.offsetBits + it.sizeBits) / 8),
    }));
}

/**
 * Which position the hover should read: the pointer's or the caret's.
 *
 * Last input wins — after a keyboard move the caret outranks a pointer that
 * has not moved since — and each falls back to the other, so a reader who has
 * only ever used one of them still gets a hover.
 */
export function effectivePos(
  i: Pick<HoverInputs, 'mouse' | 'cursor' | 'preferCursor'>,
): EditorPos | null {
  return i.preferCursor ? (i.cursor ?? i.mouse) : (i.mouse ?? i.cursor);
}

/**
 * The record a line-driven hover belongs to (its declaring record), or null.
 * Used to make the tab follow the cursor.
 */
export function hoveredPrimary(i: HoverInputs): string | null {
  if (i.intent) return null; // grid/table hovers never switch the tab
  const pos = effectivePos(i);
  if (!pos) return null;
  // A line that declares a member points at that member's record…
  const declaring = i.lines.get(pos.line)?.primary;
  if (declaring !== undefined) return declaring;
  // …and anywhere else inside a declaration (its first line, a blank line, the
  // closing brace), the innermost record containing the cursor.
  const here = recordsAtLine(pos.line, i.records);
  if (here.length === 0) return null;
  // Instantiations of one template share a span; stay on the one already shown.
  return i.current !== null && here.includes(i.current) ? i.current : (here[0] ?? null);
}

/**
 * What is hovered, from everything that could be pointing at something.
 *
 * A grid or table intent wins outright, since it names a member directly;
 * otherwise the editor position decides. Always returns a hover — the empty
 * one when nothing is pointed at — so no view has to handle absence.
 *
 * An intent naming a member of a superseded analysis resolves to the empty
 * hover rather than to whatever now sits at that index.
 */
export function resolveHover(i: HoverInputs): Hover {
  if (i.intent) return resolveIntent(i.intent, i);
  const pos = effectivePos(i);
  const info = pos ? i.lines.get(pos.line) : undefined;
  if (!info || !pos) return EMPTY_HOVER;
  // Which declarator on the line the caret/pointer is in. Falls back to the
  // whole line when the AST gave us no columns to split it by.
  const mark = markAtColumn(info, pos.col);
  if (!mark) {
    return {
      members: info.members,
      ranges: extentOf(info.primary, info.items),
      line: pos.line,
      nameRange: null,
      inlay: describeItems(info.items),
      tooltip: null,
    };
  }
  return {
    members: mark.members,
    ranges: extentOf(info.primary, mark.items),
    line: pos.line,
    nameRange: { line: pos.line, startCol: mark.col, endCol: mark.endCol },
    inlay: describeItems(mark.items),
    tooltip: null,
  };
}

/**
 * The whole hover state for one intent: which leaves light up, which line is
 * tinted, what the inlay says and where the tooltip goes.
 *
 * Pure. An intent naming a record that is not on screen resolves to nothing
 * rather than to a partial hover, since the model it refers to is what every
 * other field is read out of.
 */
function resolveIntent(intent: HoverIntent, i: HoverInputs): Hover {
  if (intent.kind === 'tooltip') return { ...EMPTY_HOVER, tooltip: intent.tooltip };
  const model = i.models.get(intent.record);
  if (!model) return EMPTY_HOVER;

  if (intent.kind === 'leaf') return leafHover(model, intent.record, intent.leaf, intent.tooltip);

  if (intent.kind === 'area') {
    // Everyone with bits in the region. Overlap is the point: a union byte
    // belongs to each of the union's members, and the table can only show
    // that if the hover names them all.
    const covering = leavesCovering(model, intent.fromBit, intent.toBit);
    // Padding under the pointer: a tooltip with no member behind it.
    if (covering.length === 0) return { ...EMPTY_HOVER, tooltip: intent.tooltip };
    // A single occupant makes this that member's own hover, declaration line
    // and all, so an unshared cell behaves exactly like the member's row.
    if (covering.length === 1) return leafHover(model, intent.record, covering[0]!, intent.tooltip);
    const items = covering.map((li) => model.leaves[li]!);
    return {
      members: covering.map((leaf) => ({ record: intent.record, leaf })),
      ranges: extentOf(intent.record, items),
      // Several declarations are meant at once, so no single one is.
      line: null,
      nameRange: null,
      inlay: describeItems(items),
      tooltip: intent.tooltip,
    };
  }

  const group = model.groups[intent.group];
  if (!group) return EMPTY_HOVER;
  const at = anchorOf(group.location);
  const members: MemberRef[] = group.leafIndexes.map((leaf) => ({ record: intent.record, leaf }));
  return {
    members,
    ranges: extentOf(intent.record, [group]),
    line: at?.line ?? null,
    nameRange: nameRangeOf(at),
    inlay: describeItems([group]),
    tooltip: intent.tooltip,
  };
}

/**
 * The members with bits in `[fromBit, toBit)`, in declaration order. A member
 * that occupies nothing (an empty member sharing an address) is drawn nowhere
 * and so is never under the pointer, whatever its offset says.
 */
export function leavesCovering(model: RenderModel, fromBit: number, toBit: number): number[] {
  const out: number[] = [];
  model.leaves.forEach((leaf, li) => {
    if (leaf.sizeBits > 0 && leaf.offsetBits < toBit && fromBit < leaf.offsetBits + leaf.sizeBits) {
      out.push(li);
    }
  });
  return out;
}

/** The hover a single member produces, whichever way it was pointed at. */
function leafHover(
  model: RenderModel,
  record: string,
  li: number,
  tooltip: TooltipAnchor | null,
): Hover {
  const leaf = model.leaves[li];
  if (!leaf) return EMPTY_HOVER;
  const at = anchorOf(leaf.location);
  return {
    members: [{ record, leaf: li }],
    ranges: extentOf(record, [leaf]),
    line: at?.line ?? null,
    nameRange: nameRangeOf(at),
    inlay: describeItems([leaf]),
    tooltip,
  };
}

/**
 * The range to highlight for an anchor, or `null` for none.
 *
 * Always at least one column wide: a zero-width range paints nothing, and a
 * member whose name the backend gave no extent for would silently fail to
 * highlight.
 */
function nameRangeOf(at: Anchor | null): Hover['nameRange'] {
  if (!at) return null;
  return { line: at.line, startCol: at.col, endCol: Math.max(at.endCol, at.col + 1) };
}

/**
 * The inlay for what a line declares: `offset 16 B · 8 B · align 8 B`.
 *
 * Empty for no items. Several items on one line are summarised by their span
 * and counted rather than listed, since the line has room for one phrase; a
 * bit-field is measured in bits, which is the only unit that describes it.
 */
export function describeItems(items: (Leaf | Group)[]): string {
  const one = items.length === 1;
  const it = items[0];
  if (!it) return '';
  if (one && 'kind' in it && it.kind === 'bitfield') {
    return `offset ${fmtOffset(it.offsetBits)} · ${it.sizeBits} b`;
  }
  const start = Math.min(...items.map((i) => i.offsetBits));
  const end = Math.max(...items.map((i) => i.offsetBits + i.sizeBits));
  const sizeBytes = (end - start) / 8;
  const parts = [`offset ${fmtOffset(start)}`];
  parts.push(`${Number.isInteger(sizeBytes) ? sizeBytes : sizeBytes.toFixed(1)} B`);
  if (one && it.align) parts.push(`align ${it.align} B`);
  else if (!one) parts.unshift(`${items.length} members`);
  return parts.join(' · ');
}

/**
 * A bit offset in the units a reader thinks in: `12 B`, or `12 B + 3 b` when it
 * falls inside a storage unit. Total over any non-negative offset.
 */
export function fmtOffset(bits: number): string {
  return bits % 8 === 0 ? `${bits / 8} B` : `${Math.floor(bits / 8)} B + ${bits % 8} b`;
}
