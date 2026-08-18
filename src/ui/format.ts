// Small formatting helpers shared by the grid, the table and the editor inlay.

import type { Group, Leaf } from '$core/types';
import { fmtOffset } from '$state/session.svelte';

const fmt = new Intl.NumberFormat('en-US');

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** "3 b" for bit-fields, "≈ 4 B" for estimated members, "8 B" otherwise. */
export function fmtSize(leaf: Leaf): string {
  if (leaf.kind === 'bitfield') return `${leaf.sizeBits} b`;
  return `${leaf.estimated ? '≈ ' : ''}${fmt.format(leaf.sizeBits / 8)} B`;
}

/** Byte extent of a group; "size ?" when a probe could not measure it. */
export function fmtGroupSize(sizeBits: number | null): string {
  return sizeBits === null ? 'size ?' : `${fmt.format(sizeBits / 8)} B`;
}

/** Tooltip body for a compound member (record-typed field or base subobject). */
export function groupTooltipHtml(g: Group): string {
  const tags = [g.isBase ? 'base' : '', g.isUnion ? 'union' : ''].filter(Boolean).join(' · ');
  const lines = [
    `<strong>${escapeHtml([...g.path, g.name].join(' :: '))}</strong>`,
    g.type ? escapeHtml(g.type) : '',
    `offset ${fmtOffset(g.offsetBits)} · ${fmtGroupSize(g.sizeBits)}`,
    tags,
  ];
  return lines.filter(Boolean).join('<br>');
}

/** Tooltip body for a member: qualified name, type, offset and size (+ optional extra line). */
export function memberTooltipHtml(leaf: Leaf, extra?: string): string {
  const lines = [
    `<strong>${escapeHtml([...leaf.path, leaf.name].join(' :: '))}</strong>`,
    leaf.type ? escapeHtml(leaf.type) : '',
    `offset ${fmtOffset(leaf.offsetBits)} · ${fmtSize(leaf)}`,
    extra ?? '',
  ];
  return lines.filter(Boolean).join('<br>');
}
