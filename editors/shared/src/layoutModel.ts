// What every drawing of a layout shares: the text map, the SVG in hovers, and
// the panel in VS Code and CLion all draw from these, so they agree on which
// byte is whose, which letter and colour a member gets, and how the member
// table reads.

import type { AnalysisContext, RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from './format.ts';

export type ByteOwner = number | null;

/** Every member touching each byte, in declaration order: several in a union, or bit-fields sharing a byte. */
export function byteMembers(record: RecordView): number[][] {
  const members: number[][] = Array.from({ length: Math.ceil(record.sizeBits / 8) }, () => []);
  record.members.forEach((member, index) => {
    if (member.sizeBits === 0) return;
    const first = Math.floor(member.offsetBits / 8);
    const last = Math.ceil((member.offsetBits + member.sizeBits) / 8) - 1;
    for (let byte = first; byte <= last && byte < members.length; byte++) {
      members[byte]!.push(index);
    }
  });
  return members;
}

/**
 * One cell per byte, holding the member it is drawn as, or null for padding.
 * Where members overlap (a union, bit-fields sharing a byte) that is the
 * `preferred` member when it is one of them, so a highlighted member shows
 * all of its bytes; otherwise the first. The table lists them all.
 */
export function byteOwners(record: RecordView, preferred: number | null = null): ByteOwner[] {
  return byteMembers(record).map((members) =>
    preferred !== null && members.includes(preferred) ? preferred : (members[0] ?? null),
  );
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
const PALETTE = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#b07aa1',
  '#e15759',
  '#76b7b2',
  '#edc948',
  '#9c755f',
];
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

/** The bytes to draw, or null when there are none or too many to be of use. */
export function mappedBytes(
  record: RecordView,
  preferred: number | null = null,
): ByteOwner[] | null {
  const owners = byteOwners(record, preferred);
  return owners.length === 0 || owners.length > MAX_MAPPED_BYTES ? null : owners;
}

/** `40 B · align 8 · 9 B padding`: the inlay hint, and the panel's line for a record. */
export function recordSummary(record: RecordView): string {
  const parts = [formatSizeShort(record.sizeBits), `align ${record.alignBits / 8}`];
  if (record.paddingBytes) parts.push(`${record.paddingBytes} B padding`);
  return parts.join(' · ');
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
