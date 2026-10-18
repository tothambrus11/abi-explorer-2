// What every drawing of a layout shares: the text map, the SVG in hovers, and
// the panel in VS Code and CLion all draw from these, so they agree on which
// byte is whose, which letter and colour a member gets, and how the member
// table reads.

import type { RecordView } from '../protocol.ts';

export type ByteOwner = number | null;

/**
 * One cell per byte, holding the index of the first member that touches it, or
 * null for padding. A byte shared by bit-fields belongs to the first of them,
 * and in a union the first member covers the others; the table lists them all.
 */
export function byteOwners(record: RecordView): ByteOwner[] {
  const owners: ByteOwner[] = Array.from({ length: Math.ceil(record.sizeBits / 8) }, () => null);
  record.members.forEach((member, index) => {
    if (member.sizeBits === 0) return;
    const first = Math.floor(member.offsetBits / 8);
    const last = Math.ceil((member.offsetBits + member.sizeBits) / 8) - 1;
    for (let byte = first; byte <= last && byte < owners.length; byte++) {
      owners[byte] ??= index;
    }
  });
  return owners;
}

/** The letter a member is drawn with: a–z, then A–Z, then digits, then `#`. */
export function memberLetter(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return letters[index] ?? '#';
}

/** Bytes per row: 8 reads best in a hover; wide records get 16 so they stay short. */
export function bytesPerRow(sizeBytes: number): number {
  return sizeBytes > 128 ? 16 : 8;
}

/** Records past this size are listed but not mapped: hundreds of rows help nobody. */
export const MAX_MAPPED_BYTES = 512;

// Mid-tone colours, so a map reads on light and dark themes alike.
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#edc948', '#9c755f'];
export const PADDING_COLOR = '#8a8a8a';

/** The colour member `index` is drawn in; the hover image and the panel agree. */
export function memberColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

export type LayoutRow =
  | { kind: 'member'; memberIndex: number; offsetBits: number; sizeBits: number }
  | { kind: 'padding'; offsetBits: number; sizeBits: number };

/** The member table: members and the padding runs between them, in offset order. */
export function layoutRows(record: RecordView): LayoutRow[] {
  const rows: LayoutRow[] = record.members.map((member, memberIndex) => ({
    kind: 'member',
    memberIndex,
    offsetBits: member.offsetBits,
    sizeBits: member.sizeBits,
  }));
  const owners = byteOwners(record);
  for (let byte = 0; byte < owners.length; byte++) {
    if (owners[byte] !== null) continue;
    const start = byte;
    while (byte + 1 < owners.length && owners[byte + 1] === null) byte++;
    rows.push({ kind: 'padding', offsetBits: start * 8, sizeBits: (byte - start + 1) * 8 });
  }
  // Stable, so a padding run sorts after a zero-sized member at the same offset.
  return rows.sort((a, b) => a.offsetBits - b.offsetBits);
}
