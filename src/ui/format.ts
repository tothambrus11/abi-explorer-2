// Small formatting helpers shared by the grid, the table and the editor inlay.

import type { Leaf } from '$core/types';
import { fmtOffset } from '$state/session.svelte';

const fmt = new Intl.NumberFormat('en-US');

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** "3 bits" for bit-fields, "≈ 4 B" for estimated members, "8 B" otherwise. */
export function fmtSize(leaf: Leaf): string {
  if (leaf.kind === 'bitfield') return `${leaf.sizeBits} bit${leaf.sizeBits === 1 ? '' : 's'}`;
  return `${leaf.estimated ? '≈ ' : ''}${fmt.format(leaf.sizeBits / 8)} B`;
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
