// Resolving the effective hover, as a pure function of the inputs (pointer,
// cursor, grid/table intent) and the current models/locations.
//
// Intent, not a snapshot: a grid or table hover records *what* is hovered
// (record + leaf/group index), never a pre-resolved member list. Resolution
// happens against whatever the models are now, so a hover cannot survive into a
// later analysis pointing at some unrelated member.

import type { FieldLocation } from '$core/ast-locations';
import type { Group, Leaf, RenderModel } from '$core/types';
import { markAtColumn, type LineInfo } from './code-locations';
import type { Hover, MemberRef } from './store.svelte';

export interface TooltipAnchor {
  html: string;
  x: number;
  y: number;
}

/** What the pointer is over in the grid or the field table. */
export type HoverIntent =
  | { kind: 'leaf'; record: string; leaf: number; tooltip: TooltipAnchor | null }
  | { kind: 'group'; record: string; group: number; tooltip: TooltipAnchor | null }
  /** A padding cell: a tooltip with no member behind it. */
  | { kind: 'tooltip'; tooltip: TooltipAnchor };

/** A position in the editor. */
export interface EditorPos {
  line: number;
  col: number;
}

export interface HoverInputs {
  /** Grid/table intent — wins over the editor when present. */
  intent: HoverIntent | null;
  /** Pointer position in the editor. */
  mouse: EditorPos | null;
  /** Text cursor position. */
  cursor: EditorPos | null;
  /** After a keyboard move the cursor beats a stale pointer until the mouse moves. */
  preferCursor: boolean;
  models: Map<string, RenderModel>;
  lines: Map<number, LineInfo>;
  leafLocations: Map<string, Map<number, FieldLocation>>;
  groupLocations: Map<string, Map<number, FieldLocation>>;
}

export const EMPTY_HOVER: Hover = {
  members: [],
  line: null,
  nameRange: null,
  inlay: null,
  tooltip: null,
};

/** The editor position the hover comes from, honouring the keyboard/mouse preference. */
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
  return (pos ? i.lines.get(pos.line)?.primary : undefined) ?? null;
}

/** Resolve the effective hover. */
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
      line: pos.line,
      nameRange: null,
      inlay: describeItems(info.items),
      tooltip: null,
    };
  }
  return {
    members: mark.members,
    line: pos.line,
    nameRange: { line: pos.line, startCol: mark.col, endCol: mark.endCol },
    inlay: describeItems(mark.items),
    tooltip: null,
  };
}

function resolveIntent(intent: HoverIntent, i: HoverInputs): Hover {
  if (intent.kind === 'tooltip') return { ...EMPTY_HOVER, tooltip: intent.tooltip };
  const model = i.models.get(intent.record);
  if (!model) return EMPTY_HOVER;

  if (intent.kind === 'leaf') {
    const leaf = model.leaves[intent.leaf];
    if (!leaf) return EMPTY_HOVER;
    const loc = i.leafLocations.get(intent.record)?.get(intent.leaf);
    return {
      members: [{ record: intent.record, leaf: intent.leaf }],
      line: loc?.line ?? null,
      nameRange: nameRangeOf(loc),
      inlay: describeItems([leaf]),
      tooltip: intent.tooltip,
    };
  }

  const group = model.groups[intent.group];
  if (!group) return EMPTY_HOVER;
  const loc = i.groupLocations.get(intent.record)?.get(intent.group);
  const members: MemberRef[] = group.leafIndexes.map((leaf) => ({ record: intent.record, leaf }));
  return {
    members,
    line: loc?.line ?? null,
    nameRange: nameRangeOf(loc),
    inlay: describeItems([group]),
    tooltip: intent.tooltip,
  };
}

function nameRangeOf(loc: FieldLocation | undefined): Hover['nameRange'] {
  if (!loc) return null;
  return { line: loc.line, startCol: loc.col, endCol: loc.col + Math.max(1, loc.name.length) };
}

/** "offset 16 B · 8 B · align 8 B" for the items declared on a line. */
export function describeItems(items: (Leaf | Group)[]): string {
  const one = items.length === 1;
  const it = items[0];
  if (!it) return '';
  if (one && 'kind' in it && it.kind === 'bitfield') {
    return `offset ${fmtOffset(it.offsetBits)} · ${it.sizeBits} b`;
  }
  const start = Math.min(...items.map((i) => i.offsetBits));
  const end = Math.max(...items.map((i) => i.offsetBits + (i.sizeBits ?? 0)));
  const sizeBytes = (end - start) / 8;
  const parts = [`offset ${fmtOffset(start)}`];
  if (one && it.sizeBits === null) parts.push('size ?');
  else {
    parts.push(
      `${one && 'estimated' in it && it.estimated ? '≈' : ''}${Number.isInteger(sizeBytes) ? sizeBytes : sizeBytes.toFixed(1)} B`,
    );
  }
  if (one && it.align) parts.push(`align ${it.align} B`);
  else if (!one) parts.unshift(`${items.length} members`);
  return parts.join(' · ');
}

/** Byte offset with an explicit unit: "12 B", or "12 B + 3 b" inside a bit-field storage unit. */
export function fmtOffset(bits: number): string {
  return bits % 8 === 0 ? `${bits / 8} B` : `${Math.floor(bits / 8)} B + ${bits % 8} b`;
}
